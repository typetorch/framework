import { DataStoreService, MemoryStoreService, Players, TeleportService, TextService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { Channel, NewServerReport, ServerKernel, ServerType } from "../kernel";
import { RateLimiter } from "../net/limits";

/**
 * Server half of the dev menu's Admin tab (plans/10, "Admin"): players (teleport to, bring, respawn, kick, ban),
 * bans (unban, history) and the live servers of this universe (list, join, new server, shut down).
 *
 * Every op is checked here, never on the client:
 *  - the actor must be a dev (the devtools dispatcher checks it, re-checked here);
 *  - kick, ban, unban, bring, respawning others and shut down need owner/admin; respawning yourself needs admin on
 *    prod-channel servers;
 *  - nobody can kick or ban someone with an equal or higher role (so never the owner); bring and respawn can't target
 *    a higher role;
 *  - payloads are validated (user ids are positive integers, reasons are short valid UTF-8, job ids are short ids);
 *  - per-dev token buckets: moderation 3 then 1 per 6 s, movement 4 then 1/s, reads 8 then 2/s, ban history 3 then
 *    1 per 5 s.
 * Moderation actions go to the server log (`print`, so prod builds keep it) and, best effort, to the DataStore
 * "TypeTorch" under `mod/<yyyy-mm-dd>/<job>/<n>` (unique keys, SetAsync, no contention; `<job>` is the JobId without
 * dashes cut to 24 characters, because DataStore keys max out at 50).
 *
 * Server list: a MemoryStore SortedMap "TypeTorchServers" (key = JobId, a ~200-byte value, TTL 150 s). Every server
 * writes its own entry about every 60 s plus up to 10 s of jitter while it has players, removes it when the last
 * player leaves, on shut down, and on BindToClose (bound once per server). A swap leaves it alone: the next generation
 * rewrites it within seconds. Reads happen only when a dev opens the list: one GetRangeAsync (up to 200 servers),
 * cached 15 s, single-flight. Quota use stays around 1 write per server per minute plus a few reads.
 */

export type AdminRole = "owner" | "admin" | "dev";

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
	admin: boolean;
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
}

export interface AdminServersReply {
	you: AdminYou;
	servers: AdminServer[];
	/** The list hit the 200-entry read cap. */
	truncated: boolean;
	error?: string;
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

const SERVER_MAP = "TypeTorchServers";
const SERVER_TTL = 150;
const HEARTBEAT = 60;
const HEARTBEAT_JITTER = 10;
const LIST_CACHE = 15;
const LIST_ERROR_CACHE = 5;
const LIST_MAX = 200;
const MOD_STORE = "TypeTorch";
const REASON_MAX = 200;
const PERSIST_KEY = "typetorch/admin";
const SHUTDOWN_MESSAGE = "This server is shutting down. Please rejoin.";

const BUCKETS: Record<"mod" | "move" | "read" | "history", [number, number]> = {
	mod: [3, 1 / 6],
	move: [4, 1],
	read: [8, 2],
	history: [3, 1 / 5],
};

/** Survives swaps (kernel persist store): plain data only. */
interface AdminPersist {
	/** Durable record counter for this server (unique `mod/...` keys across generations). */
	modSeq: number;
	/** BindToClose is bound once per server, not once per generation. */
	closeBound: boolean;
}

/** The MemoryStore value (short keys: it is read by every dev who opens the list). `k` never leaves the server. */
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
	admin: boolean;
}

function rank(role: AdminRole | undefined): number {
	if (role === "owner") return 3;
	if (role === "admin") return 2;
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
	const saved = kernel.persist<AdminPersist>(PERSIST_KEY, () => ({ modSeq: 0, closeBound: false }));
	const limiter = new RateLimiter();
	trove.connect(Players.PlayerRemoving, (player) => limiter.forget(player));

	const jobLabel = game.JobId !== "" ? game.JobId : "studio";
	const jobKey = game.JobId !== "" ? game.JobId.gsub("-", "")[0].sub(1, 24) : "studio";

	const roleOf = (player: Player): AdminRole | undefined => {
		const [ok, info] = pcall(() => kernel.devInfo(player));
		if (!ok || !typeIs(info, "table") || info.dev !== true) return undefined;
		return info.role;
	};

	const actorOf = (player: Player): Actor => {
		// The dispatcher checks this too; re-checked so these ops stay dev-only wherever they are registered.
		if (player.Parent === undefined || !kernel.isDev(player)) error("not a dev", 0);
		const role = roleOf(player);
		return { player, role, rank: rank(role), admin: role === "owner" || role === "admin" };
	};

	const limit = (actor: Actor, bucket: keyof typeof BUCKETS) => {
		if (!limiter.allow(actor.player, bucket, BUCKETS[bucket])) error("rate_limited", 0);
	};

	const youOf = (actor: Actor): AdminYou => ({
		role: actor.role,
		admin: actor.admin,
		channel: kernel.channel,
		serverType: kernel.serverType,
	});

	const permissions = (actor: Actor, target: Player, targetRole = roleOf(target)): AdminCan => {
		const isSelf = target === actor.player;
		const targetRank = rank(targetRole);
		return {
			tp: !isSelf,
			bring: !isSelf && actor.admin && actor.rank >= targetRank,
			respawn: isSelf ? kernel.channel === "dev" || actor.admin : actor.admin && actor.rank >= targetRank,
			kick: !isSelf && actor.admin && actor.rank > targetRank,
			ban: !isSelf && actor.admin && actor.rank > targetRank,
		};
	};

	/** The error code for a refused player action. */
	const refusal = (actor: Actor, target: Player, action: keyof AdminCan): string => {
		if (target === actor.player) return action === "respawn" ? "prod_admin_only" : "self";
		return actor.admin ? "protected" : "admins_only";
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
		print(`[TypeTorch admin] ${who} ${action}${whom}${why} on ${jobLabel}`);
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
			const [ok, err] = pcall(() => DataStoreService.GetDataStore(MOD_STORE).SetAsync(key, entry));
			if (!ok) $warn(`[admin] durable record ${key} failed: ${err}`);
		});
	};

	// Players -------------------------------------------------------------------------------------------------------

	register("admin.players", (player) => {
		const actor = actorOf(player);
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
		const actor = actorOf(player);
		limit(actor, "move");
		const target = targetOf(payload);
		if (!permissions(actor, target).tp) error(refusal(actor, target, "tp"), 0);
		const mine = liveCharacter(player);
		const theirs = liveCharacter(target);
		if (!mine || !theirs) error("no_character", 0);
		moveCharacter(mine, theirs.GetPivot().mul(new CFrame(0, 0, 4)));
		print(`[TypeTorch admin] @${player.Name} (${player.UserId}) teleported to @${target.Name} (${target.UserId})`);
		return { ok: true };
	});

	register("admin.bring", (player, payload) => {
		const actor = actorOf(player);
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
		const actor = actorOf(player);
		limit(actor, "move");
		const target = targetOf(payload);
		if (!permissions(actor, target).respawn) error(refusal(actor, target, "respawn"), 0);
		const [ok, err] = pcall(() => target.LoadCharacter());
		if (!ok) error(`respawn failed: ${err}`, 0);
		if (target !== player) record(actor, "respawn", target.UserId, target.Name);
		return { ok: true };
	});

	register("admin.kick", (player, payload) => {
		const actor = actorOf(player);
		limit(actor, "mod");
		if (!actor.admin) error("admins_only", 0);
		const target = targetOf(payload);
		if (!permissions(actor, target).kick) error(refusal(actor, target, "kick"), 0);
		const reason = reasonOf(field(payload, "reason"));
		const shown = filtered(actor, reason);
		record(actor, "kick", target.UserId, target.Name, reason);
		target.Kick(shown !== undefined && shown !== "" ? `Kicked: ${shown}` : "Kicked by a moderator");
		return { ok: true };
	});

	register("admin.ban", (player, payload) => {
		const actor = actorOf(player);
		limit(actor, "mod");
		if (!actor.admin) error("admins_only", 0);
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
		const actor = actorOf(player);
		limit(actor, "mod");
		if (!actor.admin) error("admins_only", 0);
		const userId = field(payload, "userId");
		if (!isUserId(userId)) error("bad_request", 0);
		const [ok, err] = pcall(() => Players.UnbanAsync({ UserIds: [userId], ApplyToUniverse: true }));
		if (!ok) error(`unban failed: ${err}`, 0);
		record(actor, "unban", userId);
		return { ok: true };
	});

	register("admin.history", (player, payload) => {
		const actor = actorOf(player);
		limit(actor, "history");
		if (!actor.admin) error("admins_only", 0);
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

	const map = MemoryStoreService.GetSortedMap(SERVER_MAP);
	const canPublish = game.JobId !== "" && kernel.serverType !== "studio";
	let startedAt = os.time();
	{
		const [ok, status] = pcall(() => kernel.status());
		if (ok && typeIs(status, "table") && typeIs(status.startedAt, "number")) startedAt = status.startedAt;
	}
	let shuttingDown = false;
	let lastWrite = -math.huge;

	/** A reserved server's own access code, when the kernel exposes it (kernel need: see plans/10, Admin). */
	const accessCode = (): string | undefined => {
		const api = kernel as unknown as { accessCode?: unknown };
		if (!typeIs(api.accessCode, "function")) return undefined;
		const [ok, code] = pcall(() => (kernel as unknown as { accessCode(): unknown }).accessCode());
		return ok && typeIs(code, "string") && code !== "" ? code : undefined;
	};

	const ownEntry = (): StoredServer => ({
		t: kernel.serverType,
		b: kernel.branch,
		c: kernel.channel,
		a: kernel.artifact.id,
		n: Players.GetPlayers().size(),
		m: Players.MaxPlayers,
		s: startedAt,
		u: os.time(),
		p: game.PlaceId,
		k: kernel.serverType === "reserved" ? accessCode() : undefined,
	});

	const publish = () => {
		if (!canPublish || shuttingDown || Players.GetPlayers().size() === 0) return;
		lastWrite = os.clock();
		const [ok, err] = pcall(() => map.SetAsync(game.JobId, ownEntry(), SERVER_TTL));
		if (!ok) $warn(`[admin] server list write failed: ${err}`);
	};
	const unpublish = () => {
		if (!canPublish) return;
		// The next player to join publishes right away.
		lastWrite = -math.huge;
		const [ok, err] = pcall(() => map.RemoveAsync(game.JobId));
		if (!ok) $warn(`[admin] server list remove failed: ${err}`);
	};

	if (canPublish) {
		trove.add(
			task.spawn(() => {
				task.wait(2 + math.random() * 6);
				while (true) {
					publish();
					task.wait(HEARTBEAT + math.random() * HEARTBEAT_JITTER);
				}
			}),
		);
		// First player after an empty stretch: show up now, not at the next heartbeat.
		trove.connect(Players.PlayerAdded, () => {
			if (os.clock() - lastWrite > HEARTBEAT) trove.add(task.spawn(publish));
		});
		// The last player leaving: the server is about to close (an empty server writes nothing).
		trove.connect(Players.PlayerRemoving, (leaving) => {
			if (Players.GetPlayers().filter((other) => other !== leaving).size() === 0) task.spawn(unpublish);
		});
		// Real shutdown. Bound once per server (BindToClose can't be unbound, so not once per generation); the
		// closure holds only the map name and the JobId. If it never runs, the 150 s TTL removes the entry.
		if (!saved.closeBound) {
			saved.closeBound = true;
			const jobId = game.JobId;
			game.BindToClose(() => {
				pcall(() => MemoryStoreService.GetSortedMap(SERVER_MAP).RemoveAsync(jobId));
			});
		}
	}

	let cache: ListCache | undefined;
	let waiting: thread[] | undefined;
	/** The universe's server list: cached 15 s (errors 5 s), one MemoryStore read at a time (single-flight). */
	const readServers = (): ListCache => {
		if (cache && os.clock() - cache.at < (cache.error !== undefined ? LIST_ERROR_CACHE : LIST_CACHE)) return cache;
		if (waiting) {
			waiting.push(coroutine.running());
			coroutine.yield();
			return cache ?? { at: os.clock(), rows: [], truncated: false, error: "no_reply" };
		}
		const mine = new Array<thread>();
		waiting = mine;
		const [ok, result] = pcall(() => map.GetRangeAsync(Enum.SortDirection.Ascending, LIST_MAX));
		if (ok) {
			const rows = new Array<{ key: string; value: StoredServer }>();
			for (const item of result) {
				if (typeIs(item.key, "string") && typeIs(item.value, "table")) rows.push({ key: item.key, value: item.value as StoredServer });
			}
			cache = { at: os.clock(), rows, truncated: result.size() >= LIST_MAX };
		} else {
			cache = { at: os.clock(), rows: [], truncated: false, error: tostring(result) };
		}
		waiting = undefined;
		for (const thread of mine) if (coroutine.status(thread) === "suspended") task.spawn(thread);
		return cache;
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
		};
	};

	register("admin.servers", (player) => {
		const actor = actorOf(player);
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
		const reply: AdminServersReply = { you: youOf(actor), servers, truncated: list.truncated, error: list.error };
		return reply;
	});

	register("admin.join", (player, payload) => {
		const actor = actorOf(player);
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
		print(`[TypeTorch admin] @${player.Name} (${player.UserId}) joins server ${jobId}`);
		const [ok, err] = pcall(() => TeleportService.TeleportAsync(placeId, [player], options));
		if (!ok) error(`teleport failed: ${err}`, 0);
		return { ok: true };
	});

	// A new reserved server on this server's branch (the kernel checks dev status and the branch).
	register("admin.newServer", (player): NewServerReport => {
		const actor = actorOf(player);
		limit(actor, "move");
		return kernel.newServer(player, kernel.branch);
	});

	trove.connect(Players.PlayerAdded, (joined) => {
		if (shuttingDown) joined.Kick(SHUTDOWN_MESSAGE);
	});

	register("admin.shutdown", (player) => {
		const actor = actorOf(player);
		limit(actor, "mod");
		if (!actor.admin) error("admins_only", 0);
		if (shuttingDown) return { ok: true };
		shuttingDown = true;
		const count = Players.GetPlayers().size();
		record(actor, "shutdown", undefined, undefined, "", { players: count });
		task.spawn(unpublish);
		// A moment for the reply to reach the dev, then everyone goes (the server closes once empty).
		task.delay(1, () => {
			for (const other of Players.GetPlayers()) other.Kick(SHUTDOWN_MESSAGE);
		});
		return { ok: true, players: count };
	});
}
