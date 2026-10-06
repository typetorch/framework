import { DataStoreService, HttpService, InsertService, MarketplaceService, Players } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import { normalRole } from "../kernel";
import type { ServerDispatcher } from "../net/runtime";
import { runningModules } from "../runtime/registry";
import { registerRemoteClaude } from "./claude";
import { registerExplorerOps } from "./explorer-server";
import { registerNetworkOps } from "./network-server";
import { registerAdminOps } from "./admin-server";
import {
	DEV_REQUEST,
	DEV_RESPONSE,
	DEVLOGS_MAX_BYTES,
	DEVLOGS_MAX_ENTRIES,
	DEVLOGS_REQUEST,
	DEVLOGS_RESPONSE,
	DevOp,
	ModuleSummary,
	NetStat,
} from "./protocol";
import type { LogEntry } from "../kernel";
import { describeState, stateRoots } from "./state";
import { inspectState, parseStateRequest } from "./state-inspect";
import type { ServerFacts } from "./health";
import { ArtifactNotes, notesFromAttribute, parseArtifactNotes } from "./artifact-notes";
import { loadstringAvailable } from "./claude-tools";
import { kernelHasExperiments, NEEDS_KERNEL_AB } from "./ab";
import { assetFacts, assetReport } from "../assets/sync";

function isAssetId(value: unknown): value is number {
	return typeIs(value, "number") && value > 0 && value % 1 === 0 && value < 2 ** 53;
}

function isBranchName(value: unknown): value is string {
	return typeIs(value, "string") && value.size() > 0 && value.size() <= 64;
}

/** Kernel 0.2+ adds artifacts/pinArtifact (and newServer's assetId); kernel 0.1.0 has neither. */
export function kernelHasArtifacts(kernel: ServerKernel): boolean {
	const api = kernel as unknown as Record<string, unknown>;
	return typeIs(api.artifacts, "function") && typeIs(api.pinArtifact, "function");
}

/** The error the dev menu shows on kernel 0.1.0 (the client matches it to show a short note). */
export const NEEDS_KERNEL_02 = "kernel 0.2 needed for artifacts";

let loadstringWorks: boolean | undefined;

/** Place settings the Status page warns about (health.ts). loadstring is probed once per generation. */
function serverFacts(kernel: ServerKernel): ServerFacts {
	if (loadstringWorks === undefined) {
		loadstringWorks = loadstringAvailable();
	}
	return { loadstring: loadstringWorks, http: HttpService.HttpEnabled, experiments: kernelHasExperiments(kernel), assets: assetFacts() };
}

const LOG_KINDS = new Set(["output", "info", "warning", "error"]);
/** Seconds a dev waits between "logs.player" requests, and for the target client's answer. */
const PLAYER_LOGS_INTERVAL = 2;
const PLAYER_LOGS_TIMEOUT = 5;

/** A client's log reply, checked field by field (it comes from an untrusted client). */
function cleanLogs(value: unknown): LogEntry[] | undefined {
	if (!typeIs(value, "table")) return undefined;
	const entries = new Array<LogEntry>();
	let bytes = 0;
	for (const [, raw] of pairs(value as object)) {
		if (entries.size() >= DEVLOGS_MAX_ENTRIES || !typeIs(raw, "table")) break;
		const entry = raw as Partial<LogEntry>;
		if (!typeIs(entry.i, "number") || !typeIs(entry.t, "number") || !typeIs(entry.text, "string")) continue;
		const kind = typeIs(entry.kind, "string") && LOG_KINDS.has(entry.kind) ? entry.kind : "output";
		const text = entry.text.sub(1, 600);
		bytes += text.size() + 32;
		if (bytes > DEVLOGS_MAX_BYTES) break;
		entries.push({ i: entry.i, t: entry.t, kind, text });
	}
	entries.sort((a, b) => a.i < b.i);
	return entries;
}

/** Modules > State queries per dev: a burst, then this many per second (a refresh sends one per open node). */
const INSPECT_BURST = 36;
const INSPECT_RATE = 12;

/** Seconds between two swaps (reload, switch, rollback, pin) of one server through the dev menu. */
const SWAP_INTERVAL = 2;
/** The kernel registry DataStore (kernel Constants.DATASTORE), read for a reserved server's creator. */
const REGISTRY_STORE = "TypeTorch";

/** Survives swaps: the last swap time (os.clock) and a reserved server's creator once known. */
interface SwapGuard {
	lastSwap?: number;
	/** User id from the registry record private/<PrivateServerId> (setBy), first read in this server. */
	reservedCreator?: number;
}

/**
 * Server half of the dev menu (plans/10). Every request is checked here: the player must be a dev (Studio, registry
 * member or dev badge, not revoked), and anything that changes the server needs the "dev" effective channel.
 * Prod-channel servers are read-only.
 */
export function startDevtoolsServer(kernel: ServerKernel, dispatcher: ServerDispatcher, trove: Trove) {
	const ops = new Map<string, DevOp>();
	const guard = kernel.persist<SwapGuard>("typetorch/devtools-swaps", () => ({}));

	/** An owner (kernel 0.3.4 roles; an older kernel's "admin" is a dev). */
	const isOwner = (player: Player) => {
		const info = kernel.devInfo(player);
		return info.dev && normalRole(info.role) === "owner";
	};
	/**
	 * The reserved server's creator: setBy of the kernel's registry record private/<PrivateServerId>, written by
	 * newServer. Read once and kept (later switches rewrite setBy, but only the creator or an owner can switch).
	 */
	const reservedCreator = (): number | undefined => {
		if (guard.reservedCreator !== undefined) return guard.reservedCreator;
		const [ok, record] = pcall(() => DataStoreService.GetDataStore(REGISTRY_STORE).GetAsync(`private/${game.PrivateServerId}`)[0]);
		if (!ok || !typeIs(record, "table")) return undefined;
		const setBy = (record as { setBy?: unknown }).setBy;
		if (typeIs(setBy, "number") && setBy > 0) guard.reservedCreator = setBy;
		return guard.reservedCreator;
	};
	/**
	 * Reload and switch (security audit L3): Studio, the private server's owner, the dev who created this reserved
	 * server, or an owner of the game. Everyone else (any other dev, any dev on a public server) is refused.
	 */
	const mayRetarget = (player: Player): boolean => {
		if (isOwner(player)) return true;
		const kind = kernel.serverType;
		if (kind === "studio") return true;
		if (kind === "private") return game.PrivateServerOwnerId === player.UserId;
		if (kind === "reserved") return reservedCreator() === player.UserId;
		return false;
	};
	/** At most one swap per server every 2 s, counted before the kernel call (a swap stops this generation). */
	const takeSwap = () => {
		const now = os.clock();
		const last = guard.lastSwap;
		if (last !== undefined && now - last < SWAP_INTERVAL) {
			error(`one swap per ${SWAP_INTERVAL} s on this server: try again in ${math.ceil(SWAP_INTERVAL - (now - last))} s`, 0);
		}
		guard.lastSwap = now;
	};
	const NOT_YOURS = "only this server's owner (or a game owner) can reload it or switch its branch";

	ops.set("status", (player) => {
		const modules = runningModules.map(
			(running): ModuleSummary => ({
				name: running.name,
				dependencies: running.dependencies,
				loadOrder: running.loadOrder,
				initMs: running.initSeconds !== undefined ? math.floor(running.initSeconds * 1000) : undefined,
			}),
		);
		return { server: kernel.status(), artifact: kernel.artifact, modules, you: kernel.devInfo(player), facts: serverFacts(kernel) };
	});
	ops.set("logs", (_, payload) => kernel.logs(typeIs(payload, "number") ? payload : undefined, 200));
	ops.set("branches", () => kernel.branches());
	ops.set("reload", (player) => {
		if (!mayRetarget(player)) error(NOT_YOURS, 0);
		takeSwap();
		return kernel.reload(player);
	});
	ops.set("rollback", (player) => {
		takeSwap();
		return kernel.rollback(player);
	});
	ops.set("switch", (player, payload) => {
		assert(isBranchName(payload), "bad branch");
		if (!mayRetarget(player)) error(NOT_YOURS, 0);
		takeSwap();
		return kernel.switchBranch(player, payload);
	});
	// payload: "branch" or { branch, assetId? } (assetId = boot pinned to that artifact; kernel 0.2+).
	ops.set("newServer", (player, payload) => {
		let branch: unknown = payload;
		let assetId: unknown;
		if (typeIs(payload, "table")) {
			const request = payload as { branch?: unknown; assetId?: unknown };
			branch = request.branch;
			assetId = request.assetId;
		}
		assert(isBranchName(branch), "bad branch");
		if (assetId === undefined) return kernel.newServer(player, branch);
		assert(isAssetId(assetId), "bad asset id");
		// Kernel 0.1.0 would ignore the asset id and open the branch head instead.
		if (!kernelHasArtifacts(kernel)) error(NEEDS_KERNEL_02, 0);
		return kernel.newServer(player, branch, assetId);
	});
	// Artifact picker (kernel 0.2+). On kernel 0.1.0: { supported: false } and the menu shows branches only.
	ops.set("artifacts", () => {
		if (!kernelHasArtifacts(kernel)) return { supported: false };
		return { supported: true, list: kernel.artifacts!() };
	});
	// Artifact > Signing (kernel 0.3+): the trust state (public keys aren't secret; devs only like every op here).
	ops.set("keys", () => {
		const api = kernel as unknown as Record<string, unknown>;
		if (!typeIs(api.keys, "function")) return { supported: false };
		return { supported: true, keys: kernel.keys!() };
	});
	// What changed in an artifact (Branch tab, tap a row): its payload asset's description (artifact-notes.ts).
	// Descriptions don't change, so each asset is read once per generation.
	const notesCache = new Map<number, ArtifactNotes>();
	// The payload's own Notes attribute first (loaded on demand: the asset description can be text-filtered to '#'),
	// then the description (older builds). Only real notes are cached.
	const notesFromPayload = (assetId: number): ArtifactNotes | undefined => {
		const [ok, container] = pcall(() => InsertService.LoadAsset(assetId));
		if (!ok) return undefined;
		let found: ArtifactNotes | undefined;
		for (const instance of [container, ...container.GetDescendants()]) {
			const raw = instance.GetAttribute("Notes");
			if (typeIs(raw, "string")) {
				found = notesFromAttribute(raw, (text) => HttpService.JSONDecode(text));
				break;
			}
		}
		container.Destroy();
		return found;
	};
	ops.set("artifact.info", (_, payload) => {
		assert(isAssetId(payload), "bad asset id");
		const cached = notesCache.get(payload);
		if (cached) return cached;
		let notes = notesFromPayload(payload);
		if (!notes) {
			const [ok, info] = pcall(() => MarketplaceService.GetProductInfo(payload, Enum.InfoType.Asset));
			const description = ok && typeIs(info, "table") ? (info as { Description?: unknown }).Description : undefined;
			notes = parseArtifactNotes(typeIs(description, "string") ? description : "");
		}
		const useful = notes.changes.size() > 0 || next(notes.identity)[0] !== undefined;
		if (useful && notesCache.size() < 200) notesCache.set(payload, notes);
		return notes;
	});
	// Pin this server to a known artifact. The kernel re-checks everything (dev, server type, owner, channel).
	// payload: assetId, or { assetId, experiment: true } (kernel 0.2.3+: an A/B experiment, owner only; any channel on
	// public servers, which stay prod).
	ops.set("pin", (player, payload) => {
		let assetId: unknown = payload;
		let experiment = false;
		if (typeIs(payload, "table")) {
			const request = payload as { assetId?: unknown; experiment?: unknown };
			assetId = request.assetId;
			assert(request.experiment === undefined || typeIs(request.experiment, "boolean"), "bad request");
			experiment = request.experiment === true;
		}
		assert(isAssetId(assetId), "bad asset id");
		if (!kernelHasArtifacts(kernel)) error(NEEDS_KERNEL_02, 0);
		// Older kernels would ignore the option and refuse dev-channel artifacts (or pin a prod one for good).
		if (experiment && !kernelHasExperiments(kernel)) error(NEEDS_KERNEL_AB, 0);
		takeSwap();
		return experiment ? kernel.pinArtifact!(player, assetId, { experiment: true }) : kernel.pinArtifact!(player, assetId);
	});
	ops.set("net", () => {
		const stats = new Array<NetStat>();
		for (const [path, stat] of dispatcher.stats) stats.push({ path, ...stat });
		stats.sort((a, b) => a.inbound + a.outbound > b.inbound + b.outbound);
		return stats;
	});
	// The legacy dex.children/props/set/destroy ops are gone: the explorer (explorer.* ops) replaced them.
	ops.set("state", () => describeState());
	// Modules > State (state-inspect.ts): the live state of this generation's services and the persist store, read-only
	// (no function is ever called). Server state can hold player data, so devs on dev-channel servers and owners only on
	// prod-effective ones. One query or {queries} (at most 12); every query costs one token of a per-dev bucket.
	const inspectBudget = new Map<Player, { tokens: number; at: number }>();
	trove.connect(Players.PlayerRemoving, (player) => inspectBudget.delete(player));
	const takeInspect = (player: Player, cost: number): boolean => {
		const now = os.clock();
		const budget = inspectBudget.get(player) ?? { tokens: INSPECT_BURST, at: now };
		budget.tokens = math.min(INSPECT_BURST, budget.tokens + (now - budget.at) * INSPECT_RATE);
		budget.at = now;
		inspectBudget.set(player, budget);
		if (budget.tokens < cost) return false;
		budget.tokens -= cost;
		return true;
	};
	ops.set("state.inspect", (player, payload) => {
		if (kernel.channel !== "dev" && !isOwner(player)) error("owners_only", 0);
		const queries = parseStateRequest(payload);
		if (typeIs(queries, "string")) error(queries, 0);
		for (const query of queries) if (query.side !== "server") error("bad_side", 0);
		if (!takeInspect(player, queries.size())) error("rate_limited", 0);
		const roots = stateRoots();
		return queries.map((query) => inspectState(roots, query));
	});
	// Modules > Assets: the last AssetSync of this generation (hot assets, plans/13), read-only.
	ops.set("assets", () => assetReport());

	// Another player's client logs (Logs > Others). Dev only (checked for every op), the target must be in this
	// server, one request per dev every 2 s; the target's framework answers on DEVLOGS_RESPONSE within 5 s.
	let nextLogRequest = math.random(1, 2 ** 30);
	const pendingLogs = new Map<number, { target: Player; thread: thread; timeout: thread }>();
	const lastLogRequest = new Map<Player, number>();
	trove.connect(Players.PlayerRemoving, (player) => lastLogRequest.delete(player));
	const finishLogs = (id: number, ok: boolean, result: unknown) => {
		const pending = pendingLogs.get(id);
		if (!pending) return;
		pendingLogs.delete(id);
		if (coroutine.status(pending.timeout) === "suspended") task.cancel(pending.timeout);
		if (coroutine.status(pending.thread) === "suspended") task.spawn(pending.thread, ok, result);
	};
	/** Asks `target`'s client for its logs since `since`; yields until it answers (or 5 s pass). */
	const askClientLogs = (target: Player, since: number): [ok: boolean, result: unknown] => {
		nextLogRequest += 1;
		const id = nextLogRequest;
		const thread = coroutine.running();
		const timeout = task.delay(PLAYER_LOGS_TIMEOUT, () => finishLogs(id, false, "no_reply"));
		pendingLogs.set(id, { target, thread, timeout });
		kernel.send(target, DEVLOGS_REQUEST, id, since);
		// coroutine.yield returns the resumed values as a tuple, not a table: pack them (indexing the tuple failed live).
		const [ok, result] = coroutine.yield() as LuaTuple<[boolean, unknown]>;
		return [ok, result];
	};
	ops.set("logs.player", (player, payload) => {
		const request = (typeIs(payload, "table") ? payload : {}) as { userId?: unknown; since?: unknown };
		assert(typeIs(request.userId, "number"), "bad request");
		const target = Players.GetPlayerByUserId(request.userId);
		if (!target) error("not_in_server", 0);
		const now = os.clock();
		const last = lastLogRequest.get(player);
		if (last !== undefined && now - last < PLAYER_LOGS_INTERVAL) error("rate_limited", 0);
		lastLogRequest.set(player, now);
		const [ok, result] = askClientLogs(target, typeIs(request.since, "number") ? request.since : 0);
		if (!ok) error(result, 0);
		return result;
	});
	dispatcher.setRaw(DEVLOGS_RESPONSE, (player, id, entries) => {
		if (!typeIs(id, "number")) return;
		const pending = pendingLogs.get(id);
		// Only the asked player may answer, and only once.
		if (!pending || pending.target !== player) return;
		const logs = cleanLogs(entries);
		finishLogs(id, logs !== undefined, logs ?? "bad_reply");
	});
	trove.add(() => {
		dispatcher.removeRaw(DEVLOGS_RESPONSE);
		for (const [id] of pendingLogs) finishLogs(id, false, "no_reply");
	});
	// Claude prompt (plans/11): claude.session / claude.prompt / claude.status / claude.cancel.
	registerRemoteClaude(kernel, trove, ops, { dispatcher, clientLogs: askClientLogs });
	// Explorer ops (explorer.children/props/set/attr/rename/destroy/find/ancestry/instance).
	trove.add(
		registerExplorerOps((op, handler) => {
			ops.set(op, handler);
		}, kernel),
	);
	// Network inspector ops (net.packets/packet/stop): packet capture while a dev watches.
	registerNetworkOps(kernel, dispatcher, trove, ops);
	// Manage ops, owners only (admin.players/tp/bring/respawn/kick/ban/unban/history/servers/join/newServer/shutdown/ab/
	// migrate).
	registerAdminOps((op, handler) => {
		ops.set(op, handler);
	}, kernel, trove);

	const reply = (player: Player, id: unknown, ok: boolean, result: unknown) => kernel.send(player, DEV_RESPONSE, id, ok, result);

	dispatcher.setRaw(DEV_REQUEST, (player, id, op, payload) => {
		if (!typeIs(id, "number") || !typeIs(op, "string")) return;
		if (!kernel.isDev(player)) {
			reply(player, id, false, "not a dev");
			return;
		}
		const handler = ops.get(op);
		if (!handler) {
			reply(player, id, false, `unknown op ${op}`);
			return;
		}
		const [ok, result] = pcall(handler, player, payload);
		if (!ok) $warn(`[devtools] ${op} by ${player.Name}: ${result}`);
		reply(player, id, ok, result);
	});
	trove.add(() => dispatcher.removeRaw(DEV_REQUEST));
}
