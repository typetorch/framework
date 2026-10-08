import { DataStoreService, HttpService, MessagingService, Players, TeleportService, TextService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { branchChannelOf, normalRole, type Channel, type NewServerReport, type Role, type ServerKernel, type ServerType } from "../kernel";
import { countBudget } from "../budget";
import { RateLimiter } from "../net/limits";
import { AB_KERNEL, AbReply, kernelHasExperiments, NEEDS_KERNEL_AB, PIN_JOBS_PER_MESSAGE, PIN_TOPIC, PinMessage } from "./ab";
import { versionLess } from "./health";
import { setRollCallEntry, sharedRollCall } from "../servers";

/**
 * Server half of the dev menu's Manage group (plans/10; "Admin" before framework 0.3.2): players (teleport to, bring,
 * respawn, kick, ban), bans (unban, history) and the live servers of this universe (list, join, new server, shut down,
 * A/B). The op names keep their "admin." prefix (internal).
 *
 * Every op is checked here, never on the client:
 *  - framework 0.3.2: two roles, owner and dev (no admins; an older kernel's "admin" is a dev). Every Manage op needs an
 *    owner; Migrate needs an owner on public servers and any dev elsewhere;
 *  - nobody can kick or ban someone with an equal or higher role (so never an owner); bring and respawn can't target
 *    a higher role;
 *  - payloads are validated (user ids are positive integers, reasons are short valid UTF-8, job ids are short ids);
 *  - per-dev token buckets: moderation 3 then 1 per 6 s, movement 4 then 1/s, reads 8 then 2/s, ban history 3 then
 *    1 per 5 s.
 * Moderation actions go to the server log (`print`, so prod builds keep it) and, best effort, to the DataStore
 * "TypeTorch" under `mod/<yyyy-mm-dd>/<job>/<n>` (unique keys, SetAsync, no contention; `<job>` is the JobId without
 * dashes cut to 24 characters, because DataStore keys max out at 50).
 *
 * Server list (0.3.0, user decision: no MemoryStore): a MessagingService roll call (devtools/roll-call.ts). When a dev
 * opens the list, this server asks every server on `TypeTorch/rollcall` and collects their rows for 3 s on its own reply
 * topic; the list is cached 15 s. Each server answers with the kernel's `fleetStatus()` (kernel 0.3.2+; t, b, c, a,
 * n, m, s, u, p, k?, x?, v, q, g, h, e?, sv) or the framework's own fields on older kernels, and stays silent while it shuts down or
 * migrates. Nothing is written anywhere: the list is live, and servers on frameworks before 0.3.0 don't show up.
 *
 * Migrate (`admin.migrate`, see the Migrate section): everyone moves to one new reserved server on this branch (and
 * pin), which starts on the newest place version, so a server on an old kernel gets the new one. Owners on public
 * servers, any dev elsewhere; one migration per server.
 *
 * A/B (`admin.ab`, owners, 2 then 1 per 10 s; kernel 0.2.3): publishes TypeTorch/pin messages (devtools/ab.ts)
 * that pin the chosen servers (by JobId, grouped by branch, 15 per message) or a random percent of one branch's servers
 * to a known artifact as an experiment, or unpin them. Each heartbeat carries `x` (experiment) and `v` (kernel
 * version), so the list shows which servers run what and which kernels can take a pin.
 */

/** Framework 0.3.2: the kernel's roles, owner and dev (`normalRole`). */
export type AdminRole = Role;

/** What the acting dev may do to one player (the server re-checks on every op). */
export interface AdminCan {
	tp: boolean;
	bring: boolean;
	respawn: boolean;
	kick: boolean;
	ban: boolean;
}

export interface AdminYou {
	role?: AdminRole;
	/** An owner: the Manage group is for owners only. */
	owner: boolean;
	channel: Channel;
	serverType: ServerType;
}

export interface AdminPlayer {
	userId: number;
	name: string;
	displayName: string;
	role?: AdminRole;
	pingMs?: number;
	you: boolean;
	can: AdminCan;
}

export interface AdminPlayersReply {
	you: AdminYou;
	players: AdminPlayer[];
}

export interface AdminServer {
	jobId: string;
	type: string;
	branch?: string;
	channel?: string;
	artifact?: string;
	players: number;
	maxPlayers: number;
	/** Seconds since the server started. */
	uptime?: number;
	/** Seconds since its last heartbeat. */
	age: number;
	/** This server. */
	here: boolean;
	joinable: boolean;
	/** Why it can't be joined: here | reserved | private | studio | unknown. */
	why?: string;
	/** It runs an A/B experiment pin. */
	experiment: boolean;
	/** Its kernel version (frameworks before A/B don't report it). */
	kernel?: string;
	/** Its kernel takes pin messages (0.2.3+); undefined when unknown. */
	ab?: boolean;
	/**
	 * Kernel 0.3.2+: "ok" | "failed" (nothing runs) | "unverified" | "degraded" (a deploy failed or rolled back there);
	 * 0.3.6: "backup" (the backup build baked into the place runs).
	 */
	health?: string;
	/** Kernel 0.3.2+: its applied deploy seq. */
	seq?: number;
}

export interface AdminServersReply {
	you: AdminYou;
	servers: AdminServer[];
	/** The list hit the 200-entry read cap. */
	truncated: boolean;
	error?: string;
	/** This server's kernel has A/B experiments (0.2.3+), so the A/B controls work here. */
	ab: boolean;
}

export interface AdminBanEntry {
	ban: boolean;
	start?: string;
	/** Seconds; -1 = permanent. */
	duration?: number;
	displayReason?: string;
	privateReason?: string;
}

/** Ban presets the client may ask for (seconds; -1 = permanent). */
const BAN_PRESETS = new Map<string, number>([
	["1h", 3600],
	["1d", 86400],
	["7d", 7 * 86400],
	["perm", -1],
]);

const MOD_STORE = "TypeTorch";
const REASON_MAX = 200;
const PERSIST_KEY = "typetorch/admin";
const SHUTDOWN_MESSAGE = "This server is shutting down. Please rejoin.";
const MOVED_MESSAGE = "This server moved. Please rejoin.";
/** Seconds a player gets to leave for the new server before they are kicked. */
const MIGRATE_DEADLINE = 30;
/** Players per TeleportAsync call (Roblox allows 50). */
const MIGRATE_BATCH = 25;
/** Seconds a started teleport may take before it is tried again. */
const MIGRATE_IN_FLIGHT = 10;
const MIGRATE_MAX_BACKOFF = 8;

const BUCKETS: Record<"mod" | "move" | "read" | "history" | "ab", [number, number]> = {
	mod: [3, 1 / 6],
	move: [4, 1],
	read: [8, 2],
	history: [3, 1 / 5],
	ab: [2, 1 / 10],
};
/** Most JobIds one admin.ab request may name. */
const AB_MAX_JOBS = 200;
/** Seconds after an A/B request before the roll is called again (the pinned servers swap meanwhile). */
const AB_REFRESH = 10;

/** Survives swaps (kernel persist store): plain data only. */
interface AdminPersist {
	/** Durable record counter for this server (unique `mod/...` keys across generations). */
	modSeq: number;
	/** Set once this server started migrating (one migration per server); the next generation finishes it. */
	migration?: MigrationState;
	/** A reserved server's own access code from its `private/<id>` record ("" = looked, none). Server memory only. */
	ownCode?: string;
}

/** "Migrate this server": everyone moves to one new reserved server on the same branch (and pin). */
interface MigrationState {
	/** The reserved server's access code: server memory only, never sent to a client. */
	code: string;
	privateServerId: string;
	/** os.time() */
	startedAt: number;
	by: number;
}

/** One server's row (short keys: one MessagingService message each). `k` never leaves the server. */
interface StoredServer {
	/** server type */
	t?: unknown;
	/** branch */
	b?: unknown;
	/** channel */
	c?: unknown;
	/** artifact id */
	a?: unknown;
	/** players */
	n?: unknown;
	/** max players */
	m?: unknown;
	/** started at (unix) */
	s?: unknown;
	/** updated at (unix) */
	u?: unknown;
	/** place id */
	p?: unknown;
	/** reserved server access code (only with a kernel that exposes it) */
	k?: unknown;
	/** 1 while it runs an A/B experiment pin */
	x?: unknown;
	/** kernel version */
	v?: unknown;
	/** Kernel 0.3.2+ (`fleetStatus()`): applied seq, generation number, health, last error, schema 2. */
	q?: unknown;
	g?: unknown;
	h?: unknown;
	e?: unknown;
	sv?: unknown;
}

/** Kernel 0.3.2+: `fleetStatus()` is this server's row (the roll call answers with it). */
export function kernelHasFleetStatus(kernel: ServerKernel): boolean {
	return typeIs((kernel as unknown as Record<string, unknown>).fleetStatus, "function");
}

interface ListCache {
	at: number;
	rows: Array<{ key: string; value: StoredServer }>;
	truncated: boolean;
	error?: string;
}

interface Actor {
	player: Player;
	role?: AdminRole;
	rank: number;
	owner: boolean;
}

function rank(role: AdminRole | undefined): number {
	if (role === "owner") return 2;
	if (role === "dev") return 1;
	return 0;
}

function isUserId(value: unknown): value is number {
	return typeIs(value, "number") && value > 0 && value % 1 === 0 && value < 2 ** 53;
}

function field(payload: unknown, key: string): unknown {
	return typeIs(payload, "table") ? (payload as Record<string, unknown>)[key] : undefined;
}

/** An optional reason: a string of valid UTF-8, control characters flattened, at most REASON_MAX characters. */
function reasonOf(value: unknown): string {
	if (value === undefined) return "";
	if (!typeIs(value, "string") || value.size() > REASON_MAX * 4) error("bad_request", 0);
	const [length] = utf8.len(value);
	if (length === false || length > REASON_MAX) error("bad_request", 0);
	const flat = value.gsub("%c", " ")[0];
	return (flat.match("^%s*(.-)%s*$")[0] as string | undefined) ?? "";
}

function text(value: unknown): string | undefined {
	return typeIs(value, "string") && value !== "" ? value.sub(1, 80) : undefined;
}

function num(value: unknown): number | undefined {
	return typeIs(value, "number") && value === value ? value : undefined;
}

/** A character that can be moved (in the world, alive). */
function liveCharacter(player: Player): Model | undefined {
	const character = player.Character;
	if (!character || !character.IsDescendantOf(game)) return undefined;
	const humanoid = character.FindFirstChildOfClass("Humanoid");
	if (!humanoid || humanoid.Health <= 0) return undefined;
	return character;
}

function moveCharacter(character: Model, to: CFrame) {
	const humanoid = character.FindFirstChildOfClass("Humanoid");
	if (humanoid && humanoid.SeatPart) {
		humanoid.Sit = false;
		task.wait();
	}
	character.PivotTo(to);
}

/**
 * Registers the "admin.*" dev ops and starts this server's heartbeat in the server list. Everything it connects or
 * spawns lives in `trove` (the devtools trove, cleaned on swap).
 */
export function registerAdminOps(
	register: (op: string, handler: (player: Player, payload: unknown) => unknown) => void,
	kernel: ServerKernel,
	trove: Trove,
) {
	const saved = kernel.persist<AdminPersist>(PERSIST_KEY, () => ({ modSeq: 0 }));
	const limiter = new RateLimiter();
	trove.connect(Players.PlayerRemoving, (player) => limiter.forget(player));

	const jobLabel = game.JobId !== "" ? game.JobId : "studio";
	const jobKey = game.JobId !== "" ? game.JobId.gsub("-", "")[0].sub(1, 24) : "studio";

	const roleOf = (player: Player): AdminRole | undefined => {
		const [ok, info] = pcall(() => kernel.devInfo(player));
		if (!ok || !typeIs(info, "table") || info.dev !== true) return undefined;
		return normalRole(info.role);
	};

	const actorOf = (player: Player): Actor => {
		// The dispatcher checks this too; re-checked so these ops stay dev-only wherever they are registered.
		if (player.Parent === undefined || !kernel.isDev(player)) error("not a dev", 0);
		const role = roleOf(player);
		return { player, role, rank: rank(role), owner: role === "owner" };
	};

	/** Framework 0.3.2: every Manage op is for owners only. */
	const ownerOf = (player: Player): Actor => {
		const actor = actorOf(player);
		if (!actor.owner) error("owners_only", 0);
		return actor;
	};

	const limit = (actor: Actor, bucket: keyof typeof BUCKETS) => {
		if (!limiter.allow(actor.player, bucket, BUCKETS[bucket])) error("rate_limited", 0);
	};

	const youOf = (actor: Actor): AdminYou => ({
		role: actor.role,
		owner: actor.owner,
		channel: kernel.channel,
		serverType: kernel.serverType,
	});

	const permissions = (actor: Actor, target: Player, targetRole = roleOf(target)): AdminCan => {
		const isSelf = target === actor.player;
		const targetRank = rank(targetRole);
		return {
			tp: !isSelf,
			bring: !isSelf && actor.owner && actor.rank >= targetRank,
			respawn: isSelf ? kernel.channel === "dev" || actor.owner : actor.owner && actor.rank >= targetRank,
			kick: !isSelf && actor.owner && actor.rank > targetRank,
			ban: !isSelf && actor.owner && actor.rank > targetRank,
		};
	};

	/** The error code for a refused player action. */
	const refusal = (actor: Actor, target: Player, action: keyof AdminCan): string => {
		if (target === actor.player) return action === "respawn" ? "owners_only" : "self";
		return actor.owner ? "protected" : "owners_only";
	};

	const targetOf = (payload: unknown): Player => {
		const userId = field(payload, "userId");
		if (!isUserId(userId)) error("bad_request", 0);
		const target = Players.GetPlayerByUserId(userId);
		if (!target) error("not_in_server", 0);
		return target;
	};

	/** Text another player will read (kick message, ban message): filtered as the actor's. undefined = filter failed. */
	const filtered = (actor: Actor, value: string): string | undefined => {
		if (value === "") return "";
		const [ok, result] = pcall(() =>
			TextService.FilterStringAsync(value, actor.player.UserId, Enum.TextFilterContext.PublicChat).GetNonChatStringForBroadcastAsync(),
		);
		return ok && typeIs(result, "string") ? result : undefined;
	};

	/** Server log line plus a durable record (DataStore, best effort, never blocks the op). */
	const record = (actor: Actor, action: string, targetId?: number, targetName?: string, reason = "", extra?: Record<string, unknown>) => {
		const who = `@${actor.player.Name} (${actor.player.UserId}, ${actor.role ?? "?"})`;
		const whom = targetId !== undefined ? ` @${targetName ?? "?"} (${targetId})` : "";
		const why = reason !== "" ? `, reason: ${reason}` : "";
		print(`[TypeTorch manage] ${who} ${action}${whom}${why} on ${jobLabel}`);
		saved.modSeq += 1;
		const now = DateTime.now();
		const key = `mod/${now.FormatUniversalTime("YYYY-MM-DD", "en-us")}/${jobKey}/${saved.modSeq}`;
		const entry: Record<string, unknown> = {
			at: now.ToIsoDate(),
			action,
			by: actor.player.UserId,
			byName: actor.player.Name,
			byRole: actor.role,
			target: targetId,
			targetName,
			reason,
			job: jobLabel,
			branch: kernel.branch,
			artifact: kernel.artifact.id,
		};
		if (extra) for (const [name, value] of pairs(extra)) entry[name] = value;
		task.spawn(() => {
			countBudget(kernel, "devtools", "datastore", "write");
			const [ok, err] = pcall(() => DataStoreService.GetDataStore(MOD_STORE).SetAsync(key, entry));
			if (!ok) $warn(`[manage] durable record ${key} failed: ${err}`);
		});
	};

	// Players -------------------------------------------------------------------------------------------------------

	register("admin.players", (player) => {
		const actor = ownerOf(player);
		limit(actor, "read");
		const players = Players.GetPlayers().map((target): AdminPlayer => {
			const [pingOk, ping] = pcall(() => target.GetNetworkPing());
			const role = roleOf(target);
			return {
				userId: target.UserId,
				name: target.Name,
				displayName: target.DisplayName,
				role,
				pingMs: pingOk && typeIs(ping, "number") ? math.floor(ping * 1000) : undefined,
				you: target === player,
				can: permissions(actor, target, role),
			};
		});
		const reply: AdminPlayersReply = { you: youOf(actor), players };
		return reply;
	});

	register("admin.tp", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "move");
		const target = targetOf(payload);
		if (!permissions(actor, target).tp) error(refusal(actor, target, "tp"), 0);
		const mine = liveCharacter(player);
		const theirs = liveCharacter(target);
		if (!mine || !theirs) error("no_character", 0);
		moveCharacter(mine, theirs.GetPivot().mul(new CFrame(0, 0, 4)));
		print(`[TypeTorch manage] @${player.Name} (${player.UserId}) teleported to @${target.Name} (${target.UserId})`);
		return { ok: true };
	});

	register("admin.bring", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "move");
		const target = targetOf(payload);
		if (!permissions(actor, target).bring) error(refusal(actor, target, "bring"), 0);
		const mine = liveCharacter(player);
		const theirs = liveCharacter(target);
		if (!mine || !theirs) error("no_character", 0);
		moveCharacter(theirs, mine.GetPivot().mul(new CFrame(0, 0, -4)));
		record(actor, "bring", target.UserId, target.Name);
		return { ok: true };
	});

	register("admin.respawn", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "move");
		const target = targetOf(payload);
		if (!permissions(actor, target).respawn) error(refusal(actor, target, "respawn"), 0);
		const [ok, err] = pcall(() => target.LoadCharacter());
		if (!ok) error(`respawn failed: ${err}`, 0);
		if (target !== player) record(actor, "respawn", target.UserId, target.Name);
		return { ok: true };
	});

	register("admin.kick", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "mod");
		const target = targetOf(payload);
		if (!permissions(actor, target).kick) error(refusal(actor, target, "kick"), 0);
		const reason = reasonOf(field(payload, "reason"));
		const shown = filtered(actor, reason);
		record(actor, "kick", target.UserId, target.Name, reason);
		target.Kick(shown !== undefined && shown !== "" ? `Kicked: ${shown}` : "Kicked by a moderator");
		return { ok: true };
	});

	register("admin.ban", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "mod");
		const target = targetOf(payload);
		if (!permissions(actor, target).ban) error(refusal(actor, target, "ban"), 0);
		const preset = field(payload, "preset");
		const duration = typeIs(preset, "string") ? BAN_PRESETS.get(preset) : undefined;
		if (duration === undefined) error("bad_request", 0);
		const banAlts = field(payload, "banAlts");
		if (banAlts !== undefined && !typeIs(banAlts, "boolean")) error("bad_request", 0);
		const reason = reasonOf(field(payload, "reason"));
		const shown = filtered(actor, reason);
		const display = (shown !== undefined && shown !== "" ? shown : "Banned by a moderator").sub(1, 400);
		const privateReason = `by @${player.Name} (${player.UserId}, ${actor.role ?? "?"}) on ${jobLabel}: ${reason !== "" ? reason : "no reason"}`;
		const userId = target.UserId;
		const name = target.Name;
		const [ok, err] = pcall(() =>
			Players.BanAsync({
				UserIds: [userId],
				Duration: duration,
				DisplayReason: display,
				PrivateReason: privateReason.sub(1, 1000),
				ExcludeAltAccounts: banAlts === false,
				ApplyToUniverse: true,
			}),
		);
		if (!ok) error(`ban failed: ${err}`, 0);
		record(actor, "ban", userId, name, reason, { duration, excludeAlts: banAlts === false });
		// BanAsync removes players who are in the experience; make sure this one goes.
		task.delay(1, () => {
			if (target.Parent) target.Kick(display);
		});
		return { ok: true };
	});

	// Bans ------------------------------------------------------------------------------------------------------------

	register("admin.unban", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "mod");
		const userId = field(payload, "userId");
		if (!isUserId(userId)) error("bad_request", 0);
		const [ok, err] = pcall(() => Players.UnbanAsync({ UserIds: [userId], ApplyToUniverse: true }));
		if (!ok) error(`unban failed: ${err}`, 0);
		record(actor, "unban", userId);
		return { ok: true };
	});

	register("admin.history", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "history");
		const userId = field(payload, "userId");
		if (!isUserId(userId)) error("bad_request", 0);
		// @rbxts/types types the parameter as `User`; the engine takes the user id.
		const [ok, pages] = pcall(() => Players.GetBanHistoryAsync(userId as unknown as User));
		if (!ok || !typeIs(pages, "Instance")) error(`history failed: ${pages}`, 0);
		const entries = new Array<AdminBanEntry>();
		// At most 3 pages / 50 entries: one dev's lookup stays cheap.
		for (let page = 0; page < 3 && entries.size() < 50; page++) {
			for (const raw of pages.GetCurrentPage() as unknown[]) {
				if (!typeIs(raw, "table") || entries.size() >= 50) continue;
				const item = raw as Record<string, unknown>;
				entries.push({
					ban: item.Ban !== false,
					start: typeIs(item.StartTime, "string") ? item.StartTime : undefined,
					duration: num(item.Duration),
					displayReason: typeIs(item.DisplayReason, "string") ? item.DisplayReason.sub(1, 400) : undefined,
					privateReason: typeIs(item.PrivateReason, "string") ? item.PrivateReason.sub(1, 1000) : undefined,
				});
			}
			if (pages.IsFinished) break;
			const [advanced] = pcall(() => pages.AdvanceToNextPageAsync());
			if (!advanced) break;
		}
		return entries;
	});

	// Servers ---------------------------------------------------------------------------------------------------------

	let startedAt = os.time();
	{
		const [ok, status] = pcall(() => kernel.status());
		if (ok && typeIs(status, "table") && typeIs(status.startedAt, "number")) startedAt = status.startedAt;
	}
	let shuttingDown = false;

	/** A reserved server's own access code, when the kernel exposes it (kernel need: see plans/10, Manage). */
	const accessCode = (): string | undefined => {
		const api = kernel as unknown as { accessCode?: unknown };
		if (typeIs(api.accessCode, "function")) {
			const [ok, code] = pcall(() => (kernel as unknown as { accessCode(): unknown }).accessCode());
			if (ok && typeIs(code, "string") && code !== "") return code;
		}
		// Servers made by "Migrate" carry their code in their private/<id> record (read once below).
		return saved.ownCode !== undefined && saved.ownCode !== "" ? saved.ownCode : undefined;
	};
	// A reserved server reads its own private/<id> record once per server (one DataStore read) for that code.
	if (kernel.serverType === "reserved" && game.PrivateServerId !== "" && saved.ownCode === undefined) {
		trove.add(
			task.spawn(() => {
				countBudget(kernel, "devtools", "datastore", "read");
				const [ok, value] = pcall(() => DataStoreService.GetDataStore(MOD_STORE).GetAsync(`private/${game.PrivateServerId}`)[0]);
				if (!ok) return; // tried again by the next generation
				const code = typeIs(value, "table") ? (value as { code?: unknown }).code : undefined;
				saved.ownCode = typeIs(code, "string") ? code : "";
			}),
		);
	}

	/** Whether this server runs an experiment pin (kernel 0.2.3+). */
	const experimentNow = (): boolean => {
		if (!kernelHasExperiments(kernel)) return false;
		const [ok, info] = pcall(() => kernel.experiment!());
		return ok && info !== undefined;
	};

	/** Kernel 0.3.2+: this server's health and applied seq, for its own row (status() is cheap). */
	const healthNow = (): { h?: string; q?: number } => {
		const [ok, status] = pcall(() => kernel.status());
		if (!ok || !typeIs(status, "table")) return {};
		return { h: status.health?.state, q: status.appliedSeq };
	};

	const ownEntry = (): StoredServer => {
		// Kernel 0.3.2+: the kernel's own row (it also has q, g, h, e).
		if (kernelHasFleetStatus(kernel)) {
			const [ok, status] = pcall(() => (kernel as unknown as { fleetStatus(): StoredServer }).fleetStatus());
			if (ok && typeIs(status, "table")) return { ...status };
		}
		const health = healthNow();
		return {
			t: kernel.serverType,
			b: kernel.branch,
			c: branchChannelOf(kernel),
			a: kernel.artifact.id,
			n: Players.GetPlayers().size(),
			m: Players.MaxPlayers,
			s: startedAt,
			u: os.time(),
			p: game.PlaceId,
			k: kernel.serverType === "reserved" ? accessCode() : undefined,
			x: experimentNow() ? 1 : undefined,
			v: kernel.kernelVersion,
			h: health.h,
			q: health.q,
		};
	};

	// The roll call (framework 0.3.5: the generation's one, servers.ts, shared with TypeTorch.servers(); kernel 0.3.8
	// holds its ask topic): this server answers others with its own row (silent while it shuts down or migrates) and asks
	// when a dev opens the list. Studio (no JobId) lists only itself.
	const rollCall = sharedRollCall();
	trove.add(setRollCallEntry(() => (shuttingDown || saved.migration ? undefined : (ownEntry() as Record<string, unknown>))));

	/** The universe's servers (not this one): a roll call, cached 15 s (errors 5 s), one at a time. */
	const readServers = (): ListCache => {
		const list = rollCall?.ask() ?? { at: os.clock(), rows: [], truncated: false };
		return {
			at: list.at,
			rows: list.rows.map((row) => ({ key: row.key, value: row.value as StoredServer })),
			truncated: list.truncated,
			error: list.error,
		};
	};

	const rowOf = (jobId: string, value: StoredServer, now: number, here: boolean): AdminServer => {
		const kind = text(value.t) ?? "unknown";
		const started = num(value.s);
		const updated = num(value.u);
		let joinable = false;
		let why: string | undefined;
		if (here) why = "here";
		else if (kind === "public") joinable = true;
		else if (kind === "reserved" && typeIs(value.k, "string")) joinable = true;
		else why = kind === "reserved" || kind === "private" || kind === "studio" ? kind : "unknown";
		const version = text(value.v);
		return {
			jobId,
			type: kind,
			branch: text(value.b),
			channel: text(value.c),
			artifact: text(value.a),
			players: num(value.n) ?? 0,
			maxPlayers: num(value.m) ?? 0,
			uptime: started !== undefined ? math.max(0, now - started) : undefined,
			age: updated !== undefined ? math.max(0, now - updated) : 0,
			here,
			joinable,
			why,
			experiment: value.x === 1,
			kernel: version,
			ab: version !== undefined ? !versionLess(version, AB_KERNEL) : undefined,
			health: text(value.h),
			seq: num(value.q),
		};
	};

	register("admin.servers", (player) => {
		const actor = ownerOf(player);
		limit(actor, "read");
		const list = readServers();
		const now = os.time();
		const servers = new Array<AdminServer>();
		for (const { key, value } of list.rows) {
			if (key !== game.JobId) servers.push(rowOf(key, value, now, false));
		}
		// This server from live data (it may not have written yet, or it is a Studio session).
		servers.push(rowOf(jobLabel, ownEntry(), now, true));
		servers.sort((a, b) => (a.here !== b.here ? a.here : a.players > b.players));
		const reply: AdminServersReply = {
			you: youOf(actor),
			servers,
			truncated: list.truncated,
			error: list.error,
			ab: kernelHasExperiments(kernel),
		};
		return reply;
	});

	// A/B ---------------------------------------------------------------------------------------------------------------
	// Pins (or unpins) servers through the kernel topic TypeTorch/pin. The servers re-check everything themselves
	// (branch, target, owner `by`, known deployment); this op checks the request, the role and the rate.

	const isJobId = (value: unknown): value is string =>
		typeIs(value, "string") && value.size() > 0 && value.size() <= 64 && value.match("^[%w%-]+$")[0] !== undefined;

	register("admin.ab", (player, payload): AbReply => {
		const actor = ownerOf(player);
		limit(actor, "ab");
		if (!kernelHasExperiments(kernel)) error(NEEDS_KERNEL_AB, 0);
		if (kernel.serverType === "studio" || game.JobId === "") error("studio", 0);
		const unpin = field(payload, "unpin");
		if (unpin !== undefined && !typeIs(unpin, "boolean")) error("bad_request", 0);
		const jobIds = field(payload, "jobIds");
		const pct = field(payload, "pct");
		if ((jobIds === undefined) === (pct === undefined)) error("bad_request", 0);
		const assetId = field(payload, "assetId");
		let artifact: string | undefined;
		if (assetId !== undefined || unpin !== true) {
			if (!isUserId(assetId)) error("bad_request", 0);
			// Only known deployments (the receiving kernels refuse anything else too).
			const known = kernel.artifacts?.().find((entry) => entry.assetId === assetId);
			if (!known) error("unknown_artifact", 0);
			artifact = known.artifactId ?? `asset-${assetId}`;
		}

		// Targets: branch -> JobIds (a pct request: one branch, no JobIds).
		const groups = new Map<string, string[]>();
		let skipped = 0;
		let servers: number | undefined;
		if (jobIds !== undefined) {
			if (!typeIs(jobIds, "table")) error("bad_request", 0);
			const list = jobIds as unknown[];
			if (list.size() === 0 || list.size() > AB_MAX_JOBS) error("bad_request", 0);
			const rows = readServers().rows;
			const seen = new Set<string>();
			for (const jobId of list) {
				if (!isJobId(jobId)) error("bad_request", 0);
				if (seen.has(jobId)) continue;
				seen.add(jobId);
				// This server: its own branch, even before its first list write.
				const branch = jobId === game.JobId ? kernel.branch : text(rows.find((row) => row.key === jobId)?.value.b);
				if (branch === undefined) {
					skipped += 1;
					continue;
				}
				const group = groups.get(branch) ?? [];
				group.push(jobId);
				groups.set(branch, group);
			}
			servers = seen.size() - skipped;
			if (servers === 0) error("gone", 0);
		} else {
			if (!typeIs(pct, "number") || pct % 1 !== 0 || pct < 1 || pct > 100) error("bad_request", 0);
			const branch = field(payload, "branch");
			if (!typeIs(branch, "string") || branch.size() === 0 || branch.size() > 64) error("bad_request", 0);
			groups.set(branch, []);
		}

		let messages = 0;
		let failed = 0;
		const publish = (message: PinMessage) => {
			messages += 1;
			countBudget(kernel, "devtools", "messaging", "publish");
			const [ok, err] = pcall(() => MessagingService.PublishAsync(PIN_TOPIC, HttpService.JSONEncode(message)));
			if (!ok) {
				failed += 1;
				$warn(`[manage] A/B publish failed: ${err}`);
			}
		};
		for (const [branch, group] of groups) {
			const a = assetId as number | undefined;
			const flag = unpin === true ? true : undefined;
			if (pct !== undefined) {
				publish({ pct: pct as number, a, b: branch, by: player.UserId, t: DateTime.now().UnixTimestampMillis, unpin: flag });
				continue;
			}
			for (let first = 0; first < group.size(); first += PIN_JOBS_PER_MESSAGE) {
				const chunk = new Array<string>();
				for (let index = first; index < math.min(first + PIN_JOBS_PER_MESSAGE, group.size()); index++) chunk.push(group[index]);
				publish({ j: chunk, a, b: branch, by: player.UserId, t: DateTime.now().UnixTimestampMillis, unpin: flag });
			}
		}
		const branches = new Array<string>();
		for (const [branch] of groups) branches.push(branch);
		record(actor, unpin === true ? "ab_unpin" : "ab_pin", undefined, undefined, "", {
			assetId,
			artifactId: artifact,
			servers,
			pct,
			branches: branches.join(","),
			messages,
			failed,
		});
		// The pinned servers swap within seconds: call the roll again then.
		trove.add(
			task.delay(AB_REFRESH, () => {
				rollCall?.invalidate();
			}),
		);
		if (failed === messages) error("publish_failed", 0);
		return { ok: true, servers, skipped, messages, failed };
	});

	register("admin.join", (player, payload) => {
		const actor = ownerOf(player);
		limit(actor, "move");
		const jobId = field(payload, "jobId");
		if (!typeIs(jobId, "string") || jobId.size() > 64 || jobId.match("^[%w%-]+$")[0] === undefined) error("bad_request", 0);
		if (jobId === game.JobId) error("here", 0);
		if (kernel.serverType === "studio") error("studio", 0);
		const entry = readServers().rows.find((row) => row.key === jobId);
		if (!entry) error("gone", 0);
		const value = entry.value;
		const options = new Instance("TeleportOptions");
		if (value.t === "public") options.ServerInstanceId = jobId;
		else if (value.t === "reserved" && typeIs(value.k, "string")) options.ReservedServerAccessCode = value.k;
		else {
			options.Destroy();
			error("not_joinable", 0);
		}
		const placeId = isUserId(value.p) ? value.p : game.PlaceId;
		print(`[TypeTorch manage] @${player.Name} (${player.UserId}) joins server ${jobId}`);
		const [ok, err] = pcall(() => TeleportService.TeleportAsync(placeId, [player], options));
		if (!ok) error(`teleport failed: ${err}`, 0);
		return { ok: true };
	});

	// A new reserved server on this server's branch (the kernel checks dev status and the branch).
	register("admin.newServer", (player): NewServerReport => {
		const actor = ownerOf(player);
		limit(actor, "move");
		return kernel.newServer(player, kernel.branch);
	});

	trove.connect(Players.PlayerAdded, (joined) => {
		if (shuttingDown) joined.Kick(SHUTDOWN_MESSAGE);
	});

	register("admin.shutdown", (player) => {
		const actor = ownerOf(player);
		limit(actor, "mod");
		if (shuttingDown) return { ok: true };
		shuttingDown = true;
		const count = Players.GetPlayers().size();
		record(actor, "shutdown", undefined, undefined, "", { players: count });
		// A moment for the reply to reach the dev, then everyone goes (the server closes once empty).
		task.delay(1, () => {
			for (const other of Players.GetPlayers()) other.Kick(SHUTDOWN_MESSAGE);
		});
		return { ok: true, players: count };
	});

	// Migrate ----------------------------------------------------------------------------------------------------------
	// Moves everyone to one fresh reserved server on this server's branch (and pin). A new server starts on the newest
	// place version, so this is how a server on an old kernel gets the new one without waiting for it to empty. Works
	// on kernels 0.2.0+: it reserves the server and writes the kernel's own private/<PrivateServerId> record
	// ({branch, setBy, setAt, pin?}, plus `code` for Manage > Servers) itself. One migration per server.

	/** This server's pin in the kernel's `private/<id>` pin shape, if it is pinned. */
	const currentPin = (): Record<string, unknown> | undefined => {
		const [ok, status] = pcall(() => kernel.status());
		if (!ok || !typeIs(status, "table") || status.pinned !== true) return undefined;
		const artifact = kernel.artifact;
		if (!typeIs(artifact.assetId, "number")) return undefined;
		return {
			assetId: artifact.assetId,
			artifactId: artifact.id,
			seq: artifact.seq,
			commit: artifact.commit,
			channel: artifact.channel ?? kernel.channel,
			branch: artifact.branch ?? kernel.branch,
			// The pin holds until the branch gets a deploy newer than what this server applied.
			headSeq: typeIs(status.appliedSeq, "number") ? status.appliedSeq : 0,
		};
	};

	interface Attempt {
		/** When the player was first asked to move (their deadline starts here). */
		since: number;
		attempts: number;
		nextAt: number;
		/** A teleport started at this time and hasn't failed yet. */
		sentAt?: number;
		kicked?: boolean;
	}
	const attempts = new Map<Player, Attempt>();
	const backoff = (entry: Attempt) => {
		entry.sentAt = undefined;
		entry.attempts += 1;
		entry.nextAt = os.clock() + math.min(MIGRATE_MAX_BACKOFF, 2 ** entry.attempts);
	};
	trove.connect(TeleportService.TeleportInitFailed, (target, result, message) => {
		const entry = attempts.get(target);
		if (!entry) return;
		backoff(entry);
		$warn(`[manage] migrate: ${target.Name} failed (${result.Name}): ${message}`);
	});
	trove.connect(Players.PlayerRemoving, (leaving) => attempts.delete(leaving));

	let moving = false;
	let reserving = false;
	/** Teleports everyone (joiners too) in batches until the server is empty; kicks anyone still here after 30 s. */
	const moveEveryone = () => {
		const migration = saved.migration;
		if (moving || !migration) return;
		moving = true;
		trove.add(
			task.spawn(() => {
				const options = new Instance("TeleportOptions");
				options.ReservedServerAccessCode = migration.code;
				while (Players.GetPlayers().size() > 0) {
					const now = os.clock();
					const due = new Array<Player>();
					for (const target of Players.GetPlayers()) {
						let entry = attempts.get(target);
						if (!entry) {
							entry = { since: now, attempts: 0, nextAt: now };
							attempts.set(target, entry);
						}
						if (now - entry.since > MIGRATE_DEADLINE) {
							if (!entry.kicked) target.Kick(MOVED_MESSAGE);
							entry.kicked = true;
						} else if ((entry.sentAt === undefined || now - entry.sentAt > MIGRATE_IN_FLIGHT) && now >= entry.nextAt) {
							due.push(target);
						}
					}
					for (let first = 0; first < due.size(); first += MIGRATE_BATCH) {
						const batch = new Array<Player>();
						for (let index = first; index < math.min(first + MIGRATE_BATCH, due.size()); index++) {
							if (due[index].Parent) batch.push(due[index]);
						}
						if (batch.size() === 0) continue;
						for (const target of batch) attempts.get(target)!.sentAt = os.clock();
						const [ok, err] = pcall(() => TeleportService.TeleportAsync(game.PlaceId, batch, options));
						if (!ok) {
							$warn(`[manage] migrate: teleport of ${batch.size()} failed: ${err}`);
							for (const target of batch) {
								const entry = attempts.get(target);
								if (entry) backoff(entry);
							}
						}
					}
					task.wait(1);
				}
				options.Destroy();
				moving = false;
			}),
		);
	};
	// A swap mid-migration: this generation finishes it. Joiners move too (public matchmaking may still send some).
	if (saved.migration) trove.add(task.delay(1, moveEveryone));
	trove.connect(Players.PlayerAdded, () => {
		if (saved.migration) moveEveryone();
	});

	register("admin.migrate", (player) => {
		const actor = actorOf(player);
		limit(actor, "mod");
		if (kernel.serverType === "studio" || game.JobId === "") error("studio", 0);
		// Public servers: players leave public matchmaking for a reserved server, so only owners.
		if (kernel.serverType === "public" && !actor.owner) error("owners_only", 0);
		if (saved.migration || reserving || shuttingDown) error("already_migrating", 0);
		reserving = true;
		const branch = kernel.branch;
		let code = "";
		let privateServerId = "";
		const [reserved, reserveError] = pcall(() => {
			const [newCode, newId] = TeleportService.ReserveServer(game.PlaceId);
			code = newCode;
			privateServerId = newId;
		});
		if (!reserved || code === "" || privateServerId === "") {
			reserving = false;
			error(`reserve failed: ${reserveError}`, 0);
		}
		// The kernel reads this record at boot (chooseBranch): without it the new server would boot the default branch.
		const override: Record<string, unknown> = { branch, setBy: player.UserId, setAt: DateTime.now().ToIsoDate(), code };
		const pin = currentPin();
		if (pin) override.pin = pin;
		let written = false;
		let writeError: unknown;
		for (let attempt = 1; attempt <= 3 && !written; attempt++) {
			countBudget(kernel, "devtools", "datastore", "write");
			const [ok, err] = pcall(() => DataStoreService.GetDataStore(MOD_STORE).SetAsync(`private/${privateServerId}`, override));
			if (ok) written = true;
			else {
				writeError = err;
				task.wait(attempt);
			}
		}
		if (!written) {
			reserving = false;
			error(`could not save the branch: ${writeError}`, 0);
		}
		saved.migration = { code, privateServerId, startedAt: os.time(), by: player.UserId };
		reserving = false;
		const count = Players.GetPlayers().size();
		record(actor, "migrate", undefined, undefined, "", { to: privateServerId, branch, pinned: pin !== undefined, players: count });
		// A moment for the reply to reach the dev first.
		trove.add(task.delay(1, moveEveryone));
		return { ok: true, players: count };
	});
}
