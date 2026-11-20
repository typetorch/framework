import type { Trove } from "@rbxts/trove";
import type { DebugDeclarations, RemoteDebugCaller, ServerKernel } from "./kernel";
import { FRAMEWORK_VERSION } from "./version";

/**
 * Framework 0.7.1 (plans/34): LIVE DEBUG, the game's half. A game declares, for the backend explorer's server page and
 * its Fleet page:
 *
 *   remoteDebug.command("round_state", (args, caller) => ({ kind: "kv", items: { round: 3 } }), { label: "Round" });
 *   remoteDebug.stream("loot", () => ({ points: chests.map((c) => ({ x: c.X, y: c.Y, z: c.Z })) }), { hz: 1, kind: "points" });
 *   fleet.column("current_map", () => currentMap, { label: "Map", type: "string" });
 *   fleet.columnsChanged(); // after currentMap changed: a heartbeat soon (the kernel sends at most one per 10 s)
 *
 * - COMMANDS (op `game.<name>`) run when an owner presses the button on /servers/<JobId>, through the kernel's remote
 *   debug checks (owners only, 30 a minute, a 10 s deadline, args at most 2 KB, the answer at most 200 KB and scrubbed of
 *   secrets). They MUST be read-only: the kernel can't check what a handler does, and the explorer labels them
 *   "game-defined". Answer shapes the explorer renders: `{ kind: "table", columns, rows }`, `{ kind: "kv", items }`,
 *   anything else as JSON.
 * - STREAMS are sampled at `hz` (0.2..4) only while someone watches the server page, and posted with the kernel's
 *   built-in `positions` every second; a sample at most 16 KB of JSON. `kind: "points"` values
 *   (`{ points: [{ x, y, z, label?, color? }] }`) draw as markers on the live map.
 * - COLUMNS ride every fleet heartbeat (a string of at most 64 characters, a number, a boolean, or nothing). They are
 *   game state stored with the server row: NEVER put player names, UserIds or other personal data in a column.
 * - Getters and samplers run on kernel threads under pcall with a short deadline: keep them cheap and don't yield.
 *
 * Framework 0.7.4: every server also declares the built-in column `tt_framework` ("Framework", this framework's version),
 * first, so the Fleet page shows which framework each server runs. It takes one of the kernel's 16 column slots: a game
 * declares at most 15, and names starting with `tt_` are reserved.
 *
 * Names: `^[a-z][a-z0-9_]{0,31}$`; at most 15 game columns, 32 commands and 8 streams; labels at most 40 characters,
 * descriptions 200. A bad name or option, a duplicate or one past a limit throws at once. Each call returns a function
 * that removes the entry (for a trove). Server only (a client throws). Needs kernel 0.5.7 (`api:debugDeclare`); on older
 * kernels and in edit mode everything is accepted and checked, and nothing reaches the backend.
 */

/** The first kernel with `api:debugDeclare`. */
export const LIVE_DEBUG_KERNEL = "0.5.7";
/** Framework 0.7.4: the built-in Fleet column with this framework's version (declared first, before the game's). */
export const FRAMEWORK_COLUMN = "tt_framework";
/** Column names a game can't use (the framework's own). */
export const RESERVED_COLUMN_PREFIX = "tt_";
/** `columns` counts the game's; the kernel's limit is one more (the built-in column). */
export const LIVE_DEBUG_LIMITS = { columns: 15, commands: 32, streams: 8, label: 40, description: 200, hzMin: 0.2, hzMax: 4 };

export interface DebugCommandOptions {
	/** The button's text (at most 40 characters; default: the name). */
	label?: string;
	/** What it shows (at most 200 characters). */
	description?: string;
}
export interface DebugStreamOptions {
	/** Samples per second, 0.2..4. */
	hz: number;
	/** "points" (`{ points: [{ x, y, z, label?, color? }] }`, drawn on the live map) or "json" (default). */
	kind?: "points" | "json";
	label?: string;
}
export interface FleetColumnOptions {
	/** The column header (at most 40 characters; default: the name). */
	label?: string;
	/** A display hint for the Fleet page. */
	type?: "string" | "number" | "bool";
}
export type FleetColumnValue = string | number | boolean | undefined;
/** A command's args: the explorer's optional JSON object. */
export type DebugCommandArgs = Record<string, unknown>;

export interface RemoteDebugApi {
	/**
	 * A read-only command on the explorer's server page (op `game.<name>`). `fn(args, caller)` runs on a kernel thread
	 * for an owner; its return value is the answer. Returns a function that removes it.
	 */
	command(name: string, fn: (args: DebugCommandArgs, caller: RemoteDebugCaller) => unknown, options?: DebugCommandOptions): () => void;
	/** A stream sampled at `options.hz` while the server page is open (`game.<name>`). Returns a function that removes it. */
	stream(name: string, fn: () => unknown, options: DebugStreamOptions): () => void;
	/** Whether the declarations reach the backend (a server on kernel 0.5.7+ whose place maps LiveDebug.luau). */
	supported(): boolean;
}
export interface FleetApi {
	/**
	 * A custom Fleet page column: `getter()` is read whenever a heartbeat is built. No player names or ids. Returns a
	 * function that removes it.
	 */
	column(name: string, getter: () => FleetColumnValue, options?: FleetColumnOptions): () => void;
	/** The values changed: the kernel sends a heartbeat soon (coalesced, at most one per 10 s). */
	columnsChanged(): void;
}

interface Command {
	fn: (args: DebugCommandArgs, caller: RemoteDebugCaller) => unknown;
	label?: string;
	description?: string;
}
interface Stream {
	fn: () => unknown;
	hz: number;
	kind: "points" | "json";
	label?: string;
}
interface Column {
	getter: () => FleetColumnValue;
	label?: string;
	type?: "string" | "number" | "bool";
}

// This framework copy belongs to one generation, so these lists are that generation's.
const commands = new Map<string, Command>();
const streams = new Map<string, Stream>();
const columns = new Map<string, Column>();
// Declaration order (the explorer shows them in it).
const order = { commands: new Array<string>(), streams: new Array<string>(), columns: new Array<string>() };

interface Binding {
	realm: "server" | "client";
	kernel?: ServerKernel;
}
let binding: Binding | undefined;
let flushQueued = false;

/** `^[a-z][a-z0-9_]{0,31}$` */
export function validDebugName(name: unknown): boolean {
	return typeIs(name, "string") && name.size() >= 1 && name.size() <= 32 && string.match(name, "^[a-z][a-z0-9_]*$")[0] !== undefined;
}

function checkName(what: string, name: unknown) {
	if (!validDebugName(name)) error(`${what}: the name must match ^[a-z][a-z0-9_]{0,31}$ (got ${tostring(name)})`, 3);
}
function checkText(what: string, field: string, value: unknown, max: number): string | undefined {
	if (value === undefined) return undefined;
	if (!typeIs(value, "string")) error(`${what}: ${field} must be a string`, 3);
	const length = utf8.len(value)[0];
	if (!typeIs(length, "number") || length > max) error(`${what}: ${field} must be valid text of at most ${max} characters`, 3);
	return value;
}
function checkServer(what: string) {
	if (binding?.realm === "client") error(`${what} is server-only`, 3);
}
function remove<T>(map: Map<string, T>, list: string[], name: string, entry: T) {
	return () => {
		if (map.get(name) !== entry) return;
		map.delete(name);
		const index = list.indexOf(name);
		if (index >= 0) list.remove(index);
		queueFlush();
	};
}

/** The kernel's view of the current declarations. */
export function debugDeclarations(): DebugDeclarations {
	return {
		columns: [
			{ name: FRAMEWORK_COLUMN, label: "Framework", type: "string" as const },
			...order.columns.map((name) => {
				const column = columns.get(name)!;
				return { name, label: column.label, type: column.type };
			}),
		],
		commands: order.commands.map((name) => {
			const command = commands.get(name)!;
			return { name, label: command.label, description: command.description };
		}),
		streams: order.streams.map((name) => {
			const stream = streams.get(name)!;
			return { name, hz: stream.hz, kind: stream.kind, label: stream.label };
		}),
	};
}

function kernelWithLiveDebug(): ServerKernel | undefined {
	const kernel = binding?.kernel;
	if (kernel === undefined || !typeIs((kernel as unknown as Record<string, unknown>).debugDeclare, "function")) return undefined;
	return kernel;
}

/** Sends the declarations to the kernel now (framework-internal; tests call it). */
export function flushLiveDebug() {
	flushQueued = false;
	const kernel = kernelWithLiveDebug();
	if (kernel === undefined) return;
	pcall(() => kernel.debugDeclare!(debugDeclarations()));
}

function queueFlush() {
	if (flushQueued || kernelWithLiveDebug() === undefined) return;
	flushQueued = true;
	// One declaration for every registration made in the same frame (a module's onInit registers several).
	task.defer(() => {
		if (flushQueued) flushLiveDebug(); // columnsChanged may have sent it already
	});
}

export const remoteDebug: RemoteDebugApi = {
	command(name, fn, options) {
		const what = "remoteDebug.command";
		checkServer(what);
		checkName(what, name);
		if (!typeIs(fn, "function")) error(`${what}: pass a function`, 2);
		if (options !== undefined && !typeIs(options, "table")) error(`${what}: options must be a table`, 2);
		const label = checkText(what, "label", options?.label, LIVE_DEBUG_LIMITS.label);
		const description = checkText(what, "description", options?.description, LIVE_DEBUG_LIMITS.description);
		if (commands.has(name)) error(`${what}: "${name}" is already registered`, 2);
		if (commands.size() >= LIVE_DEBUG_LIMITS.commands) error(`${what}: at most ${LIVE_DEBUG_LIMITS.commands} commands`, 2);
		const entry: Command = { fn, label, description };
		commands.set(name, entry);
		order.commands.push(name);
		queueFlush();
		return remove(commands, order.commands, name, entry);
	},
	stream(name, fn, options) {
		const what = "remoteDebug.stream";
		checkServer(what);
		checkName(what, name);
		if (!typeIs(fn, "function")) error(`${what}: pass a function`, 2);
		if (!typeIs(options, "table")) error(`${what}: pass options with hz`, 2);
		const hz = options.hz;
		if (!typeIs(hz, "number") || hz !== hz || hz < LIVE_DEBUG_LIMITS.hzMin || hz > LIVE_DEBUG_LIMITS.hzMax) {
			error(`${what}: hz must be a number from ${LIVE_DEBUG_LIMITS.hzMin} to ${LIVE_DEBUG_LIMITS.hzMax}`, 2);
		}
		const kind = options.kind ?? "json";
		if (kind !== "points" && kind !== "json") error(`${what}: kind must be "points" or "json"`, 2);
		const label = checkText(what, "label", options.label, LIVE_DEBUG_LIMITS.label);
		if (streams.has(name)) error(`${what}: "${name}" is already registered`, 2);
		if (streams.size() >= LIVE_DEBUG_LIMITS.streams) error(`${what}: at most ${LIVE_DEBUG_LIMITS.streams} streams`, 2);
		const entry: Stream = { fn, hz, kind, label };
		streams.set(name, entry);
		order.streams.push(name);
		queueFlush();
		return remove(streams, order.streams, name, entry);
	},
	supported() {
		return kernelWithLiveDebug() !== undefined;
	},
};

export const fleet: FleetApi = {
	column(name, getter, options) {
		const what = "fleet.column";
		checkServer(what);
		checkName(what, name);
		if (name.sub(1, RESERVED_COLUMN_PREFIX.size()) === RESERVED_COLUMN_PREFIX) error(`${what}: names starting with ${RESERVED_COLUMN_PREFIX} are reserved (got ${name})`, 2);
		if (!typeIs(getter, "function")) error(`${what}: pass a getter function`, 2);
		if (options !== undefined && !typeIs(options, "table")) error(`${what}: options must be a table`, 2);
		const label = checkText(what, "label", options?.label, LIVE_DEBUG_LIMITS.label);
		const columnType = options?.type;
		if (columnType !== undefined && columnType !== "string" && columnType !== "number" && columnType !== "bool") {
			error(`${what}: type must be "string", "number" or "bool"`, 2);
		}
		if (columns.has(name)) error(`${what}: "${name}" is already registered`, 2);
		if (columns.size() >= LIVE_DEBUG_LIMITS.columns) error(`${what}: at most ${LIVE_DEBUG_LIMITS.columns} columns`, 2);
		const entry: Column = { getter, label, type: columnType };
		columns.set(name, entry);
		order.columns.push(name);
		queueFlush();
		return remove(columns, order.columns, name, entry);
	},
	columnsChanged() {
		checkServer("fleet.columnsChanged");
		const kernel = kernelWithLiveDebug();
		if (kernel === undefined || !typeIs((kernel as unknown as Record<string, unknown>).debugColumnsChanged, "function")) return;
		// Declarations not sent yet go first, so the heartbeat carries the new columns too.
		if (flushQueued) flushLiveDebug();
		pcall(() => kernel.debugColumnsChanged!());
	},
};

/** Called by bindTypeTorch: installs the handlers on kernels that have them and sends what was registered so far. */
export function bindLiveDebug(realm: "server" | "client", kernel: unknown, _trove?: Trove) {
	const server = realm === "server" ? (kernel as ServerKernel) : undefined;
	binding = { realm, kernel: server };
	const api = kernelWithLiveDebug();
	if (api === undefined) return;
	const methods = api as unknown as Record<string, unknown>;
	if (typeIs(methods.onDebugCommand, "function")) {
		api.onDebugCommand!((name, args, caller) => {
			const command = commands.get(name);
			if (!command) error(`unknown command ${name}`, 0);
			return command.fn(typeIs(args, "table") ? (args as DebugCommandArgs) : {}, caller);
		});
	}
	if (typeIs(methods.onDebugColumn, "function")) {
		api.onDebugColumn!((name) => {
			if (name === FRAMEWORK_COLUMN) return FRAMEWORK_VERSION;
			const column = columns.get(name);
			return column ? column.getter() : undefined;
		});
	}
	if (typeIs(methods.onDebugStream, "function")) {
		api.onDebugStream!((name) => {
			const stream = streams.get(name);
			return stream ? stream.fn() : undefined;
		});
	}
	flushLiveDebug();
}

/** Called by unbindTypeTorch. */
export function unbindLiveDebug() {
	binding = undefined;
	flushQueued = false;
}

/** Tests: forget every registration. */
export function resetLiveDebug() {
	commands.clear();
	streams.clear();
	columns.clear();
	order.commands.clear();
	order.streams.clear();
	order.columns.clear();
	binding = undefined;
	flushQueued = false;
}
