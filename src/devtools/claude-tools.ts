import { HttpService, Players } from "@rbxts/services";
import { encode, luaPath, propsOf } from "./explorer/core";

/**
 * The game tools Claude calls through the dev machine (plans/11, dev-server game-tools.ts), on the DataModel of the
 * realm that runs them. Shared by both realms: the server runs every tool for the requesting dev (claude.ts); the
 * dev's own client answers the realm "client" variants of inspect / find (CLAUDE_TOOL_REQUEST). run_luau is server
 * only. Results are plain data; the dev machine caps them and labels them as untrusted game data for Claude.
 */

// Luau globals roblox-ts has no types for.
declare function loadstring(source: string, chunkName?: string): LuaTuple<[Callback | undefined, string | undefined]>;
declare function setfenv<T extends Callback>(fn: T, env: object): T;

/** Server → the requesting dev's client: (requestId, tool, args). */
export const CLAUDE_TOOL_REQUEST = "__tt/claude-tool-req";
/** Client → server: (requestId, ok, result). Accepted only from the asked player for a pending id. */
export const CLAUDE_TOOL_RESPONSE = "__tt/claude-tool-res";

const MAX_DATA = 60_000;
const MAX_CHILDREN = 100;
const MAX_PROPS = 200;
const FIND_VISITS = 30_000;
const OUTPUT_LINES = 200;
const LINE_CHARS = 1000;
const RETURNED_CHARS = 8000;

/** JSON for the dev machine, cut to fit the result body. */
export function toJson(value: unknown): string {
	const [ok, text] = pcall(() => HttpService.JSONEncode(value));
	const json = ok ? text : `"unserializable: ${tostring(text)}"`;
	return json.size() > MAX_DATA ? `${json.sub(1, MAX_DATA)}… (cut)` : json;
}

/** A readable, depth- and size-capped description of any Luau value (run_luau's returned values). */
export function describe(value: unknown, depth = 0, seen = new Set<unknown>()): string {
	const kind = typeOf(value);
	if (value === undefined) return "nil";
	if (kind === "string") return "%q".format(value as string).sub(1, 2000);
	if (kind === "number" || kind === "boolean") return tostring(value);
	if (kind === "Instance") {
		const [ok, path] = pcall(() => (value as Instance).GetFullName());
		return ok ? `${(value as Instance).ClassName} ${path}` : "Instance";
	}
	if (kind === "table") {
		if (seen.has(value) || depth >= 3) return "{…}";
		seen.add(value);
		const parts = new Array<string>();
		let count = 0;
		for (const [key, inner] of pairs(value as object)) {
			count += 1;
			if (count > 50) {
				parts.push("…");
				break;
			}
			const name = typeIs(key, "string") && key.match("^[%a_][%w_]*$")[0] !== undefined ? key : `[${describe(key, depth + 1, seen)}]`;
			parts.push(`${name} = ${describe(inner, depth + 1, seen)}`);
		}
		return `{${parts.join(", ")}}`;
	}
	return `${kind}(${tostring(value)})`;
}

/**
 * An instance from a path: "game.Workspace.Map", "Workspace/Map/Part", "Workspace.Map[\"Spawn point\"]" or
 * "ServerStorage". Names with dots need the slash form or brackets.
 */
export function resolveGamePath(path: string): Instance | undefined {
	let text = path.match("^%s*(.-)%s*$")[0] as string;
	const names = new Array<string>();
	if (text.find("/", 1, true)[0] !== undefined) {
		for (const part of text.split("/")) if (part !== "") names.push(part);
	} else {
		// Dotted form with optional ["..."] segments.
		while (text.size() > 0) {
			const [quoted, rest] = text.match('^%[%s*"(.-)"%s*%]%.?(.*)$') as LuaTuple<[string?, string?]>;
			if (quoted !== undefined && rest !== undefined) {
				names.push(quoted);
				text = rest;
				continue;
			}
			const [plain, after] = text.match("^([^%.%[]+)%.?(.*)$") as LuaTuple<[string?, string?]>;
			if (plain === undefined || after === undefined) break;
			names.push(plain);
			text = after;
		}
	}
	if (names[0] === "game") names.shift();
	let current: Instance = game;
	for (const [index, name] of ipairs(names)) {
		let child = current.FindFirstChild(name);
		if (!child && index === 1) {
			const [ok, service] = pcall(() => game.GetService(name as keyof Services));
			if (ok && typeIs(service, "Instance")) child = service;
		}
		if (!child) return undefined;
		current = child;
	}
	return current;
}

interface InspectNode {
	name: string;
	className: string;
	children: number;
	list?: InspectNode[];
	more?: number;
}

function childrenNode(instance: Instance, depth: number): InspectNode {
	const [, children] = pcall(() => instance.GetChildren());
	const list = (children as Instance[] | undefined) ?? [];
	const node: InspectNode = { name: instance.Name, className: instance.ClassName, children: list.size() };
	if (depth > 0 && list.size() > 0) {
		node.list = [];
		for (let index = 0; index < math.min(list.size(), MAX_CHILDREN); index++) node.list.push(childrenNode(list[index], depth - 1));
		if (list.size() > MAX_CHILDREN) node.more = list.size() - MAX_CHILDREN;
	}
	return node;
}

/** inspect {path, depth, properties}: class, path, properties, attributes, tags and children. */
export function inspectTool(args: Record<string, unknown>): string {
	const path = typeIs(args.path, "string") ? args.path : "";
	const instance = resolveGamePath(path);
	if (!instance) error(`no instance at ${path.sub(1, 200)}`, 0);
	const depth = typeIs(args.depth, "number") ? math.clamp(math.floor(args.depth), 0, 3) : 1;
	const reply: Record<string, unknown> = { path: instance.GetFullName(), className: instance.ClassName };
	if (args.properties !== false) {
		const props: Record<string, string> = {};
		let count = 0;
		for (const meta of propsOf(instance.ClassName)) {
			if (meta.deprecated || count >= MAX_PROPS) continue;
			const [ok, value] = pcall(() => (instance as unknown as Record<string, unknown>)[meta.name]);
			if (!ok) continue;
			props[meta.name] = encode(value).sub(1, 300);
			count += 1;
		}
		reply.properties = props;
		const attrs: Record<string, string> = {};
		for (const [name, value] of instance.GetAttributes()) attrs[name] = encode(value).sub(1, 300);
		reply.attributes = attrs;
		reply.tags = instance.GetTags();
	}
	reply.tree = childrenNode(instance, depth);
	return toJson(reply);
}

/** find {query, under?, limit}: instances whose Name or ClassName contains the query (case-insensitive). */
export function findTool(args: Record<string, unknown>): string {
	const query = (typeIs(args.query, "string") ? args.query : "").lower();
	if (query === "") error("empty query", 0);
	const root = typeIs(args.under, "string") ? resolveGamePath(args.under) : game;
	if (!root) error(`no instance at ${tostring(args.under).sub(1, 200)}`, 0);
	const limit = typeIs(args.limit, "number") ? math.clamp(math.floor(args.limit), 1, 200) : 50;
	const hits = new Array<{ path: string; className: string }>();
	const queue: Instance[] = [root];
	let head = 0;
	let visits = 0;
	while (head < queue.size() && hits.size() < limit && visits < FIND_VISITS) {
		const instance = queue[head];
		head += 1;
		visits += 1;
		if (visits % 1000 === 0) task.wait();
		const [ok, matched] = pcall(() => instance.Name.lower().find(query, 1, true)[0] !== undefined || instance.ClassName.lower().find(query, 1, true)[0] !== undefined);
		if (ok && matched && instance !== root) {
			const names = new Array<string>();
			for (let at: Instance | undefined = instance; at && at !== game; at = at.Parent) names.unshift(at.Name);
			hits.push({ path: luaPath(names), className: instance.ClassName });
		}
		const [childrenOk, children] = pcall(() => instance.GetChildren());
		if (childrenOk) for (const child of children) queue.push(child);
	}
	return toJson({ hits, capped: hits.size() >= limit || visits >= FIND_VISITS, visited: visits });
}

/** Players with their character positions (game_status). */
export function playerList(): unknown[] {
	return Players.GetPlayers().map((player) => {
		const root = player.Character?.FindFirstChild("HumanoidRootPart");
		const position = root && root.IsA("BasePart") ? root.Position : undefined;
		return {
			name: player.Name,
			displayName: player.DisplayName,
			userId: player.UserId,
			position: position ? [math.floor(position.X), math.floor(position.Y), math.floor(position.Z)] : undefined,
		};
	});
}

/** "My logs" / "Server logs" attachments: about 64 KB each, newest lines kept. */
export const LOG_ATTACH_BYTES = 64 * 1024;

/**
 * Log entries as text, one `[HH:MM:SS] kind text` line each (UTC), oldest first, keeping the newest lines that fit in
 * `maxBytes`; a first line says how many older lines were dropped.
 */
export function formatLogHistory(entries: ReadonlyArray<{ t: number; kind: string; text: string }>, maxBytes = LOG_ATTACH_BYTES): string {
	const lines = new Array<string>();
	let bytes = 0;
	let dropped = 0;
	for (let index = entries.size() - 1; index >= 0; index--) {
		const entry = entries[index];
		const line = `[${os.date("!%H:%M:%S", entry.t)}] ${entry.kind} ${entry.text.gsub("[\r\n]+", " ")[0]}`;
		if (bytes + line.size() + 1 > maxBytes - 64) {
			dropped = index + 1;
			break;
		}
		lines.push(line);
		bytes += line.size() + 1;
	}
	const ordered = new Array<string>();
	if (dropped > 0) ordered.push(`(${dropped} older lines dropped)`);
	for (let index = lines.size() - 1; index >= 0; index--) ordered.push(lines[index]);
	return ordered.join("\n");
}

/** A log text from a client, capped to its newest `maxBytes` (cut at a line start, with a note). */
export function capLogText(text: string, maxBytes = LOG_ATTACH_BYTES): string {
	const clean = text.gsub(string.char(0), "")[0];
	if (clean.size() <= maxBytes) return clean;
	let tail = clean.sub(clean.size() - maxBytes + 64);
	const [newline] = tail.find("\n", 1, true);
	if (newline !== undefined) tail = tail.sub(newline + 1);
	// No line break: don't start in the middle of a UTF-8 character (continuation bytes are 0x80..0xBF).
	while (tail.size() > 0 && string.byte(tail, 1)[0] >= 0x80 && string.byte(tail, 1)[0] < 0xc0) tail = tail.sub(2);
	return `(older lines dropped)\n${tail}`;
}

/** True when this server may compile code (ServerScriptService.LoadStringEnabled). */
export function loadstringAvailable(): boolean {
	const [ok, fn] = pcall(() => loadstring("return 1")[0]);
	return ok && fn !== undefined;
}

export interface LuauResult {
	ok: boolean;
	output: string[];
	returned?: string;
	error?: string;
	ms: number;
}

/** Services a run_luau snippet can't get through `game` (security audit M4). */
export const BLOCKED_SERVICES = new ReadonlySet<string>(["MessagingService", "DataStoreService", "MemoryStoreService", "HttpService"]);

function blockedService(value: unknown): string | undefined {
	return typeIs(value, "Instance") && BLOCKED_SERVICES.has(value.ClassName) ? value.ClassName : undefined;
}

function refuse(what: string): never {
	error(`run_luau: ${what} is not available to snippets`, 3);
}

/** A method result with blocked services refused (one value) or filtered out (an array of instances). */
function screened(value: unknown): unknown {
	const blocked = blockedService(value);
	if (blocked !== undefined) refuse(blocked);
	if (typeIs(value, "table")) {
		const list = value as defined[];
		if (list.size() > 0 && typeIs(list[0], "Instance")) return list.filter((item) => blockedService(item) === undefined);
	}
	return value;
}

/**
 * The `game` a snippet sees: every member of the real DataModel, except that GetService / FindService / service,
 * direct indexing (game.HttpService) and child lookups never hand out MessagingService, DataStoreService,
 * MemoryStoreService or HttpService (GetChildren-style lists leave them out). The real `game` is passed to every
 * method. Defense in depth, not a sandbox: `workspace.Parent`, getfenv and other globals still reach the real game.
 */
export function guardedGame(): unknown {
	const real = game as unknown as Record<string, unknown>;
	const proxy = {};
	const unwrap = (value: unknown) => (value === proxy ? game : value);
	setmetatable(proxy, {
		__index: (_: unknown, key: unknown) => {
			if (typeIs(key, "string") && BLOCKED_SERVICES.has(key)) refuse(key);
			const value = real[key as string];
			if (typeIs(value, "function")) {
				const method = value as (...args: unknown[]) => unknown;
				return (_self: unknown, ...args: defined[]) => {
					if ((key === "GetService" || key === "FindService" || key === "service" || key === "getService") && typeIs(args[0], "string")) {
						if (BLOCKED_SERVICES.has(args[0])) refuse(args[0]);
					}
					// The proxy passed as an argument (game:IsAncestorOf(x) style) becomes the real game.
					for (let index = 0; index < args.size(); index++) if (args[index] === proxy) args[index] = game;
					return screened(method(game, ...args));
				};
			}
			return screened(value);
		},
		__newindex: (_: unknown, key: unknown, value: unknown) => {
			real[key as string] = unwrap(value);
		},
		__tostring: () => game.Name,
	} as unknown as LuaMetatable<object>);
	return proxy;
}

/** Folders whose ModuleScripts a snippet may not require: the kernel and the running generations. */
function guardedRequire(): (module: unknown) => unknown {
	const roots = (): Instance[] => {
		const list = new Array<Instance>();
		for (const [service, name] of [
			["ServerScriptService", "TypeTorchKernel"],
			["ServerStorage", "TypeTorch"],
			["ReplicatedStorage", "TypeTorch"],
			["ReplicatedStorage", "TypeTorchKernelShared"],
		] as const) {
			const folder = game.GetService(service).FindFirstChild(name);
			if (folder) list.push(folder);
		}
		return list;
	};
	return (module: unknown) => {
		if (typeIs(module, "Instance") && roots().some((root) => module === root || module.IsDescendantOf(root))) refuse("the TypeTorch kernel and its modules");
		return (require as (module: unknown) => unknown)(module);
	};
}

/**
 * Runs `code` in a minimal environment (security audit M4): `player`, a `print` / `warn` that also capture their
 * output (each line still goes to the server log with a "[claude]" prefix), a guarded `game`/`Game` (guardedGame) and
 * `require` (no kernel or generation modules), and the other globals through __index. No `kernel` or `persist`.
 * This is defense in depth, not a sandbox: loadstring code can still reach the real game (workspace.Parent, getfenv,
 * shared modules) and from there everything; a real sandbox (a Luau-in-Luau VM) is planned (plans/12 batch D).
 * Gives up waiting after `timeoutSeconds` (a non-yielding infinite loop is only stopped by Roblox's script timeout).
 */
export function runLuau(code: string, globals: Record<string, unknown>, timeoutSeconds: number): LuauResult {
	const started = os.clock();
	const [fn, compileError] = loadstring(code, "=claude");
	if (!fn) return { ok: false, output: [], error: `compile: ${compileError ?? "error"}`, ms: 0 };
	const output = new Array<string>();
	const capture = (kind: string, ...args: unknown[]) => {
		const parts = new Array<string>();
		for (const arg of args) parts.push(typeIs(arg, "string") ? arg : describe(arg));
		const line = parts.join(" ");
		if (output.size() < OUTPUT_LINES) output.push((kind === "warn" ? `warn: ${line}` : line).sub(1, LINE_CHARS));
		if (kind === "warn") warn(`[claude] ${line}`);
		else print(`[claude] ${line}`);
	};
	const sandboxGame = guardedGame();
	const env = setmetatable(
		{
			...globals,
			game: sandboxGame,
			Game: sandboxGame,
			require: guardedRequire(),
			print: (...args: unknown[]) => capture("print", ...args),
			warn: (...args: unknown[]) => capture("warn", ...args),
		} as Record<string, unknown>,
		{ __index: getfenv(0) } as unknown as LuaMetatable<Record<string, unknown>>,
	);
	setfenv(fn, env);
	let done = false;
	let result: LuauResult | undefined;
	const thread = task.spawn(() => {
		let values = new Array<unknown>();
		const [ok, err] = xpcall(
			() => {
				values = [...(fn() as unknown as LuaTuple<unknown[]>)];
			},
			(problem: unknown) => debug.traceback(tostring(problem), 2),
		);
		const ms = math.floor((os.clock() - started) * 1000);
		if (ok) {
			const shown = new Array<string>();
			for (const value of values) shown.push(describe(value));
			result = { ok: true, output, returned: shown.size() > 0 ? shown.join(", ").sub(1, RETURNED_CHARS) : undefined, ms };
		} else {
			result = { ok: false, output, error: tostring(err).sub(1, RETURNED_CHARS), ms };
		}
		done = true;
	});
	const deadline = os.clock() + timeoutSeconds;
	while (!done && os.clock() < deadline) task.wait(0.05);
	if (!done) {
		if (coroutine.status(thread) === "suspended") pcall(() => task.cancel(thread));
		return { ok: false, output, error: `timeout after ${timeoutSeconds} s (stopped if it was waiting; a busy loop may still run)`, ms: math.floor((os.clock() - started) * 1000) };
	}
	return result!;
}
