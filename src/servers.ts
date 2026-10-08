import { HttpService, MessagingService, Players } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { isJobId, ROLL_CALL_TOPIC, RollCall, type RollCallRow } from "./devtools/roll-call";
import type { Channel, ServerKernel, ServerType } from "./kernel";
import { countBudget } from "./budget";
import { isCloudTest, jsonProblem } from "./messaging";
import { Relay } from "./runtime/relay";

/**
 * The universe's live servers for game code: `TypeTorch.servers()` and `TypeTorch.setServerInfo()` (server only;
 * plans/19 item 19). Built on the framework's roll call (devtools/roll-call.ts; the same one Manage > Servers uses): no
 * MemoryStore, no heartbeat writes.
 *
 * - One roll call per generation, owned here and shared with the dev menu. Every server answers asks with its row: the
 *   kernel's fleet status plus `pv` (place version) and `i` (the game's public fields). Kernel 0.3.8 holds the ask topic
 *   (`TypeTorch/rollcall`) for the running generation, so a swap doesn't subscribe again; older kernels: the generation
 *   subscribes itself, as before. Same protocol either way, so mixed fleets list each other.
 * - `servers()` caches: a server asks again at most every clamp(3 s x servers, 30 s, 10 min), so the universe asks
 *   about 20 roll calls a minute at most whatever its size (each ask reaches every server: Roblox's per-topic limit is
 *   40 + 80 x servers receives a minute). Fine for fleets up to a few hundred servers; bigger games want a MemoryStore
 *   registry. Concurrent callers share one roll call (it yields up to ~3 s when the cache is stale).
 * - Rows hold public data only: JobId, place version, players, server type, branch, channel, uptime and the game's
 *   `setServerInfo` fields. Never a reserved server's access code or an error text (the dev menu's rows have those).
 * - The cloud test and Studio don't ask anyone: the list is this server alone.
 */

/** `setServerInfo` fields, as JSON, at most this many bytes (they ride every roll call reply, 1 KiB in all). */
export const SERVER_INFO_MAX_BYTES = 400;
export const LIST_MIN_SECONDS = 30;
export const LIST_MAX_SECONDS = 600;
export const LIST_SECONDS_PER_SERVER = 3;
const INFO_KEY = "__typetorch/serverInfo";

export interface GameServer {
	readonly jobId: string;
	readonly placeVersion?: number;
	readonly players: number;
	readonly maxPlayers: number;
	readonly serverType: ServerType | "unknown";
	readonly branch?: string;
	/** Effective channel; undefined while nothing runs there. */
	readonly channel?: Channel;
	/** Seconds since that server started. */
	readonly uptime?: number;
	/** This server. */
	readonly here: boolean;
	/** Its `TypeTorch.setServerInfo` fields. */
	readonly info?: Readonly<Record<string, unknown>>;
}

export interface ServerListOptions {
	/**
	 * Every dev-channel server too. Default false: prod-channel servers and servers on this server's branch (on a prod
	 * server that is the prod fleet; on a dev server, prod plus its own branch).
	 */
	includeDev?: boolean;
	/** This server in the list (`here`). Default true. */
	includeSelf?: boolean;
}

interface Binding {
	kernel: ServerKernel;
	branch: string;
	test: boolean;
	rollCall: RollCall;
	/** The dev menu's row (it stays silent while the server shuts down or migrates). */
	entry?: () => Record<string, unknown> | undefined;
	list?: { at: number; rows: RollCallRow[] };
}

let binding: Binding | undefined;
/** Edit mode (no kernel). */
let localInfo: Record<string, unknown> | undefined;

function hasMethod(kernel: object, name: string): boolean {
	return typeIs((kernel as Record<string, unknown>)[name], "function");
}

function num(value: unknown): number | undefined {
	return typeIs(value, "number") && value === value ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeIs(value, "string") && value.size() > 0 && value.size() <= 100 ? value : undefined;
}

/** The game's public fields (kept across swaps in the kernel's persist store). */
function serverInfo(): Record<string, unknown> | undefined {
	const current = binding;
	if (current === undefined) return localInfo;
	return current.kernel.persist<{ value?: Record<string, unknown> }>(INFO_KEY, () => ({})).value;
}

/** This server's row before `pv` and `i`: the kernel's fleet status (0.3.2+), else the framework's own fields. */
function baseRow(kernel: ServerKernel): Record<string, unknown> {
	if (hasMethod(kernel, "fleetStatus")) {
		const [ok, status] = pcall(() => kernel.fleetStatus!());
		if (ok && typeIs(status, "table")) return { ...(status as unknown as Record<string, unknown>) };
	}
	const [ok, status] = pcall(() => kernel.status());
	return {
		t: kernel.serverType,
		s: ok && typeIs(status, "table") ? status.startedAt : undefined,
		b: kernel.branch,
		c: kernel.channel,
		a: kernel.artifact.id,
		n: Players.GetPlayers().size(),
		m: Players.MaxPlayers,
		u: os.time(),
		p: game.PlaceId,
		v: kernel.kernelVersion,
	};
}

/** This server's roll call row (undefined: stay silent). */
export function serverRow(): Record<string, unknown> | undefined {
	const current = binding;
	if (current === undefined) return undefined;
	const base = current.entry !== undefined ? current.entry() : baseRow(current.kernel);
	if (base === undefined) return undefined;
	const row: Record<string, unknown> = { ...base, pv: game.PlaceVersion };
	const info = serverInfo();
	if (info !== undefined) row.i = info;
	return row;
}

/** A roll call row as a public `GameServer` (never `k` or `e`). */
export function toGameServer(jobId: string, value: Record<string, unknown>, now: number, here: boolean): GameServer {
	const started = num(value.s);
	const kind = text(value.t);
	return {
		jobId,
		placeVersion: num(value.pv),
		players: num(value.n) ?? 0,
		maxPlayers: num(value.m) ?? 0,
		serverType: kind === "public" || kind === "private" || kind === "reserved" || kind === "studio" ? kind : "unknown",
		branch: text(value.b),
		channel: value.c === "prod" || value.c === "dev" ? value.c : undefined,
		uptime: started !== undefined ? math.max(0, now - started) : undefined,
		here,
		info: typeIs(value.i, "table") ? (value.i as Record<string, unknown>) : undefined,
	};
}

/** The default filter: prod-channel servers and servers on `branch`. */
export function listedByDefault(server: GameServer, branch: string): boolean {
	return server.channel === "prod" || (server.channel !== undefined && server.branch === branch);
}

/** How long a server keeps its list: clamp(3 s x servers, 30 s, 10 min). */
export function listSeconds(servers: number): number {
	return math.clamp(LIST_SECONDS_PER_SERVER * servers, LIST_MIN_SECONDS, LIST_MAX_SECONDS);
}

/** `TypeTorch.servers()`. Yields up to ~3 s when the cached list is stale. */
export function listServers(options?: ServerListOptions): GameServer[] {
	const current = binding;
	const result = new Array<GameServer>();
	if (current === undefined) return result;
	const now = os.time();
	if (!current.test && current.kernel.serverType !== "studio" && isJobId(game.JobId)) {
		const cached = current.list;
		if (cached === undefined || os.clock() - cached.at >= listSeconds(cached.rows.size() + 1)) {
			const list = current.rollCall.ask();
			if (list.error !== undefined) $warn(`TypeTorch.servers(): the roll call failed (${list.error}); showing the last list`);
			if (list.error === undefined || cached === undefined) current.list = { at: os.clock(), rows: list.rows };
			else cached.at = os.clock() - listSeconds(cached.rows.size() + 1) + 5; // try again in 5 s
		}
		for (const row of current.list?.rows ?? []) {
			if (row.key === game.JobId) continue;
			const server = toGameServer(row.key, row.value, now, false);
			if (options?.includeDev === true || listedByDefault(server, current.branch)) result.push(server);
		}
	}
	if (options?.includeSelf !== false) {
		const own = serverRow();
		if (own !== undefined) result.push(toGameServer(game.JobId, own, now, true));
	}
	result.sort((a, b) => (a.here !== b.here ? a.here : a.players > b.players));
	return result;
}

/** `TypeTorch.setServerInfo()`: public fields every server's `servers()` sees for this one. */
export function setServerInfo(info: Record<string, unknown> | undefined) {
	let copy: Record<string, unknown> | undefined;
	if (info !== undefined) {
		if (!typeIs(info, "table")) error("TypeTorch.setServerInfo: pass a table of public fields (or undefined to clear)", 3);
		for (const [key] of pairs(info)) {
			if (!typeIs(key, "string")) error("TypeTorch.setServerInfo: field names must be strings", 3);
		}
		const problem = jsonProblem(info);
		if (problem !== undefined) error(`TypeTorch.setServerInfo: the fields can't travel as JSON: ${problem}`, 3);
		const encoded = HttpService.JSONEncode(info);
		if (encoded.size() > SERVER_INFO_MAX_BYTES) {
			error(
				`TypeTorch.setServerInfo: ${encoded.size()} bytes of JSON, over the ${SERVER_INFO_MAX_BYTES}-byte cap (the fields ride every roll call reply): keep a few short public fields`,
				3,
			);
		}
		copy = HttpService.JSONDecode(encoded) as Record<string, unknown>;
	}
	const current = binding;
	if (current === undefined) localInfo = copy;
	else current.kernel.persist<{ value?: Record<string, unknown> }>(INFO_KEY, () => ({})).value = copy;
}

/** The generation's roll call, shared with Manage > Servers (undefined outside a running server generation). */
export function sharedRollCall(): RollCall | undefined {
	return binding?.rollCall;
}

/** Manage > Servers' own row for the roll call (silent while shutting down or migrating). Returns a reset function. */
export function setRollCallEntry(entry: () => Record<string, unknown> | undefined): () => void {
	const current = binding;
	if (current === undefined) return () => {};
	current.entry = entry;
	return () => {
		if (current.entry === entry) current.entry = undefined;
	};
}

/** Called by bindTypeTorch on the server: this generation's roll call (answering others; Studio and the cloud test don't). */
export function bindServers(kernel: ServerKernel, trove: Trove, branch: string) {
	const relay = new Relay(trove);
	const test = isCloudTest(kernel);
	const rollCall = new RollCall({
		jobId: game.JobId,
		subscribe: (topic, handler) => {
			// Kernel 0.3.8 holds the ask topic for the running generation (no new subscription on a swap); its calls come on
			// kernel threads and move onto this generation's. The kernel drops the handler when this generation stops.
			if (topic === ROLL_CALL_TOPIC && hasMethod(kernel, "onRollCall")) {
				kernel.onRollCall!((data) => relay.run(() => handler(data)));
				return { Disconnect() {} };
			}
			countBudget(kernel, "framework", "messaging", "subscribe");
			return MessagingService.SubscribeAsync(topic, (message) => handler(message.Data));
		},
		publish: (topic, data) => {
			countBudget(kernel, "framework", "messaging", "publish");
			return MessagingService.PublishAsync(topic, data);
		},
		entry: () => serverRow(),
		encode: (value) => HttpService.JSONEncode(value),
		decode: (value) => HttpService.JSONDecode(value),
		clock: () => os.clock(),
		unixMs: () => DateTime.now().UnixTimestampMillis,
		wait: (seconds) => task.wait(seconds),
		spawn: (callback) => {
			trove.add(task.spawn(callback));
		},
		random: () => math.random(),
		warn: (message) => $warn(message),
	});
	binding = { kernel, branch, test, rollCall };
	if (kernel.serverType !== "studio" && !test) rollCall.listen();
	trove.add(() => rollCall.stop());
}

/** Called by unbindTypeTorch. */
export function unbindServers() {
	binding = undefined;
}
