import { Players } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import type { ServerDispatcher } from "../net/runtime";
import { runningModules } from "../runtime/registry";
import { registerRemoteClaude } from "./claude";
import { registerExplorerOps } from "./explorer-server";
import { listChildren, listProperties, resolvePath, setProperty } from "./dex";
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
import { describeState } from "./state";

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

function isStringArray(value: unknown): value is string[] {
	if (!typeIs(value, "table")) return false;
	let count = 0;
	for (const [key, item] of pairs(value as object)) {
		count += 1;
		if (!typeIs(key, "number") || !typeIs(item, "string") || (item as string).size() > 100) return false;
	}
	return count <= 40;
}

/**
 * Server half of the dev menu (plans/10). Every request is checked here: the player must be a dev (Studio, registry
 * member or dev badge, not revoked), and anything that changes the server needs the "dev" effective channel.
 * Prod-channel servers are read-only.
 */
export function startDevtoolsServer(kernel: ServerKernel, dispatcher: ServerDispatcher, trove: Trove) {
	const ops = new Map<string, DevOp>();
	const requireDevChannel = () => {
		if (kernel.channel !== "dev") error("read-only on prod-channel servers", 0);
	};
	const pathOf = (payload: unknown) => {
		assert(isStringArray(payload), "bad path");
		const instance = resolvePath(payload);
		assert(instance, "not found");
		return instance;
	};

	ops.set("status", (player) => {
		const modules = runningModules.map(
			(running): ModuleSummary => ({
				name: running.name,
				dependencies: running.dependencies,
				loadOrder: running.loadOrder,
				initMs: running.initSeconds !== undefined ? math.floor(running.initSeconds * 1000) : undefined,
			}),
		);
		return { server: kernel.status(), artifact: kernel.artifact, modules, you: kernel.devInfo(player) };
	});
	ops.set("logs", (_, payload) => kernel.logs(typeIs(payload, "number") ? payload : undefined, 200));
	ops.set("branches", () => kernel.branches());
	ops.set("reload", (player) => kernel.reload(player));
	ops.set("rollback", (player) => kernel.rollback(player));
	ops.set("switch", (player, payload) => {
		assert(isBranchName(payload), "bad branch");
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
	// Pin this server to a known artifact. The kernel re-checks everything (dev, server type, admin, channel).
	ops.set("pin", (player, payload) => {
		assert(isAssetId(payload), "bad asset id");
		if (!kernelHasArtifacts(kernel)) error(NEEDS_KERNEL_02, 0);
		return kernel.pinArtifact!(player, payload);
	});
	ops.set("net", () => {
		const stats = new Array<NetStat>();
		for (const [path, stat] of dispatcher.stats) stats.push({ path, ...stat });
		stats.sort((a, b) => a.inbound + a.outbound > b.inbound + b.outbound);
		return stats;
	});
	ops.set("dex.children", (_, payload) => listChildren(pathOf(payload)));
	ops.set("dex.props", (_, payload) => listProperties(pathOf(payload)));
	ops.set("dex.set", (_, payload) => {
		requireDevChannel();
		const request = payload as { path: unknown; name: unknown; value: unknown };
		assert(typeIs(request, "table") && typeIs(request.name, "string") && typeIs(request.value, "string"), "bad edit");
		assert((request.value as string).size() <= 1000, "value too long");
		const [ok, err] = setProperty(pathOf(request.path), request.name as string, request.value as string);
		if (!ok) error(err ?? "edit failed", 0);
		return true;
	});
	ops.set("dex.destroy", (_, payload) => {
		requireDevChannel();
		const instance = pathOf(payload);
		assert(instance.Parent !== game, "can't destroy a service");
		instance.Destroy();
		return true;
	});
	ops.set("state", () => describeState());

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
	ops.set("logs.player", (player, payload) => {
		const request = (typeIs(payload, "table") ? payload : {}) as { userId?: unknown; since?: unknown };
		assert(typeIs(request.userId, "number"), "bad request");
		const target = Players.GetPlayerByUserId(request.userId);
		if (!target) error("not_in_server", 0);
		const now = os.clock();
		const last = lastLogRequest.get(player);
		if (last !== undefined && now - last < PLAYER_LOGS_INTERVAL) error("rate_limited", 0);
		lastLogRequest.set(player, now);
		nextLogRequest += 1;
		const id = nextLogRequest;
		const thread = coroutine.running();
		const timeout = task.delay(PLAYER_LOGS_TIMEOUT, () => finishLogs(id, false, "no_reply"));
		pendingLogs.set(id, { target, thread, timeout });
		kernel.send(target, DEVLOGS_REQUEST, id, typeIs(request.since, "number") ? request.since : 0);
		const [ok, result] = coroutine.yield() as LuaTuple<[boolean, unknown]>;
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
	registerRemoteClaude(kernel, trove, ops);
	// Explorer ops (explorer.children/props/set/attr/rename/destroy/find/ancestry/instance).
	trove.add(
		registerExplorerOps((op, handler) => {
			ops.set(op, handler);
		}, kernel),
	);

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
