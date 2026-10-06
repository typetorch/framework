/**
 * Modules > State: the live-state inspector core (plans/10). Shared by the server op "state.inspect" and the client's
 * own view, and tested under Lune (scripts/test-state-inspect.luau), so it imports nothing.
 *
 * What it browses: roots (the live modules of the running generation, and the persist store), then tables, arrays,
 * Maps and Sets inside them, one container and one page (STATE_PAGE entries) per query.
 *
 * Read-only and side-effect free: tables are read with pairs/rawget/rawequal only (never __index, __iter, __len, __eq
 * or __tostring), and a function or thread it finds is never called, only named. `tostring` runs on numbers, Roblox
 * datatypes (engine code) and tables without a metatable (their address), nothing else.
 *
 * Paths: a node is its root token plus one segment per step. A segment names a key: "s<string>", "n<number>",
 * "b1"/"b0", or "r<n>:<preview>" for any other key (an Instance, a table, a long string): the n-th key with that
 * preview in table order. A value that is one of its own ancestors is shown as a cycle (with the ancestor's path) and
 * can't be expanded, so a path never loops.
 */

/** Entries per page. */
export const STATE_PAGE = 100;
/** Steps below a root at most (deeper values are shown, not expandable). */
export const STATE_MAX_DEPTH = 24;
/** Queries per "state.inspect" call. */
export const STATE_MAX_QUERIES = 12;
/** The root token of the persist store (module names can't start with "~"). */
export const PERSIST_ROOT = "~persist";

/** Keys counted per container before giving up ("100000+"). */
const COUNT_CAP = 100_000;
/** Keys sorted per container: a bigger one lists its first SORT_CAP keys in table order ("truncated"). */
const SORT_CAP = 20_000;
/** Entries a preview of a nested table looks at. */
const PREVIEW_SCAN = 200;
const KEY_CHARS = 60;
const PREVIEW_CHARS = 100;
const STRING_CHARS = 80;
/** Longer string keys get a reference segment instead of the whole key. */
const SEGMENT_CHARS = 400;
const FILTER_CHARS = 64;
const KEEP_MAX = 50;
const ROOT_CHARS = 120;

export interface StateRoot {
	/** What a query names in `root`: a module's name (with "#2" for a second module of that name) or PERSIST_ROOT. */
	readonly token: string;
	readonly label: string;
	readonly kind: "module" | "persist";
	readonly value: object;
}

export interface StateQuery {
	side: "server" | "client";
	/** "" = the list of roots. */
	root: string;
	/** Segments below the root. */
	path: string[];
	/** 0-based. */
	page: number;
	/** Case-insensitive substring of the key text. */
	filter?: string;
	/** Segments listed even when the filter doesn't match them (the open nodes, so they stay visible). */
	keep?: string[];
}

export interface StateEntry {
	/** The key as shown. */
	key: string;
	/** The path segment that opens it. */
	seg: string;
	type: string;
	preview: string;
	expandable: boolean;
	/** The value is one of its own ancestors (the preview names it). */
	cycle?: boolean;
}

export interface StateReply {
	/** The node's own type and preview ("nil" when the path no longer leads anywhere). */
	type: string;
	preview: string;
	/** Entries in the node (before the filter). */
	size: number;
	/** `size` stopped counting at the cap. */
	capped?: boolean;
	/** Only the first SORT_CAP keys (in table order) are listed. */
	truncated?: boolean;
	/** Entries that passed the filter (every entry without one). */
	matched: number;
	entries: StateEntry[];
	page: number;
	pages: number;
	hasMore: boolean;
	/** The root or a step of the path doesn't exist (any more). */
	missing?: boolean;
	/** The path is deeper than STATE_MAX_DEPTH. */
	tooDeep?: boolean;
}

// Text --------------------------------------------------------------------------------------------------------------

const ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t", '"': '\\"', "\\": "\\\\" };

function escapeChar(char: string): string {
	return ESCAPES[char] ?? "\\x%02x".format(char.byte()[0]);
}

function isUtf8(text: string): boolean {
	// Luau returns nil (typed as false) plus the bad position for invalid UTF-8.
	const [length] = utf8.len(text);
	return typeIs(length, "number");
}

/** The first `max` bytes, without splitting a UTF-8 character. */
function cut(text: string, max: number): string {
	if (text.size() <= max) return text;
	let body = text.sub(1, max);
	for (let index = 0; index < 3 && !isUtf8(body); index++) body = body.sub(1, body.size() - 1);
	return body;
}

/** Control characters, quotes and backslashes escaped; invalid UTF-8 as \xNN bytes. */
function escapeText(text: string, quotes: boolean): string {
	const pattern = quotes ? '[%c"\\]' : "[%c]";
	if (isUtf8(text)) return text.gsub(pattern, escapeChar)[0];
	const parts = new Array<string>();
	for (let index = 1; index <= text.size(); index++) {
		const char = text.sub(index, index);
		const [code] = char.byte();
		parts.push(code < 32 || code >= 127 || (quotes && (char === '"' || char === "\\")) ? escapeChar(char) : char);
	}
	return parts.join("");
}

/** A string value: quoted, escaped, cut at `max` bytes with the rest counted. */
function quote(text: string, max: number): string {
	const body = cut(text, max);
	const rest = text.size() - body.size();
	return rest > 0 ? `"${escapeText(body, true)}..." (+${rest})` : `"${escapeText(body, true)}"`;
}

function numberText(value: number): string {
	if (value !== value) return "nan";
	if (value === math.huge) return "inf";
	if (value === -math.huge) return "-inf";
	if (value % 1 === 0 && math.abs(value) < 2 ** 53) return "%d".format(value);
	return tostring(value);
}

/** A number key as a segment that decodes to exactly the same number. */
function numberSegment(value: number): string {
	if (value === math.huge) return "ninf";
	if (value === -math.huge) return "n-inf";
	if (value % 1 === 0 && math.abs(value) < 2 ** 53) return "n%d".format(value);
	return "n%.17g".format(value);
}

function decodeNumber(text: string): number | undefined {
	if (text === "inf") return math.huge;
	if (text === "-inf") return -math.huge;
	return tonumber(text);
}

// Values ------------------------------------------------------------------------------------------------------------

/** An Instance's full path (a Player: its name); "?" when the engine refuses to tell (locked instances). */
function instanceText(instance: Instance): string {
	const [ok, text] = pcall(() => (instance.IsA("Player") ? instance.Name : instance.GetFullName()));
	return ok && typeIs(text, "string") ? cut(text, PREVIEW_CHARS) : "?";
}

function instanceClass(instance: Instance): string {
	const [ok, name] = pcall(() => instance.ClassName);
	return ok && typeIs(name, "string") ? name : "Instance";
}

/** A roblox-ts class instance: its metatable is a table whose own __index is itself. */
function isObject(value: object): boolean {
	const meta = getmetatable(value);
	return typeIs(meta, "table") && rawequal(rawget(meta, "__index"), meta);
}

/** Everything but tables: one short line. */
function scalarPreview(value: unknown): string {
	const kind = typeOf(value);
	switch (kind) {
		case "nil":
			return "nil";
		case "boolean":
			return value === true ? "true" : "false";
		case "number":
			return numberText(value as number);
		case "string":
			return quote(value as string, STRING_CHARS);
		case "function":
			return "function";
		case "thread":
			return "thread";
		case "buffer":
			return `buffer(${buffer.len(value as buffer)} bytes)`;
		case "userdata":
			// newproxy values can carry any __tostring: never called.
			return "userdata";
		case "Instance":
			return instanceText(value as Instance);
		default: {
			// Roblox datatypes (Vector3, CFrame, Color3, UDim2, EnumItem, ...): the engine's own tostring.
			const [ok, text] = pcall(() => tostring(value));
			return ok && typeIs(text, "string") ? cut(escapeText(text, false), PREVIEW_CHARS) : kind;
		}
	}
}

function scalarType(value: unknown): string {
	const kind = typeOf(value);
	return kind === "Instance" ? instanceClass(value as Instance) : kind;
}

interface Shape {
	kind: "table" | "array" | "map" | "set" | "object";
	count: number;
	/** Counting stopped at the scan limit. */
	more: boolean;
}

/** What a table is, from at most `limit` entries: array (keys 1..n), set (every value true), map (a key isn't a string). */
function shapeOf(value: object, limit: number): Shape {
	let count = 0;
	let more = false;
	let sequential = true;
	let maxIndex = 0;
	let allTrue = true;
	let plainKeys = true;
	for (const [key, inner] of pairs(value)) {
		if (count >= limit) {
			more = true;
			break;
		}
		count += 1;
		if (typeIs(key, "number") && key >= 1 && key % 1 === 0) {
			if (key > maxIndex) maxIndex = key;
		} else sequential = false;
		if (inner !== true) allTrue = false;
		if (!typeIs(key, "string")) plainKeys = false;
	}
	let kind: Shape["kind"] = "table";
	if (isObject(value)) kind = "object";
	else if (count === 0) kind = "table";
	// Luau visits the array part first, so keys 1..n up to the scan limit mean an array (a preview's guess past it).
	else if (sequential && maxIndex === count) kind = "array";
	else if (allTrue) kind = "set";
	else if (!plainKeys) kind = "map";
	return { kind, count, more };
}

/** A nested value in a preview: scalars short, tables as {...}. */
function innerText(value: unknown): string {
	if (typeIs(value, "table")) return "{...}";
	if (typeIs(value, "string")) return quote(value, 24);
	return scalarPreview(value);
}

/** One line for a table: a few entries and the count, e.g. `{coins = 5, name = "Bo", ...} (12)`. */
function tablePreview(value: object, shape: Shape): string {
	const count = `${shape.count}${shape.more ? "+" : ""}`;
	if (shape.count === 0) return "{}";
	const parts = new Array<string>();
	let length = 0;
	const add = (text: string): boolean => {
		if (length + text.size() > PREVIEW_CHARS - 12) return false;
		parts.push(text);
		length += text.size() + 2;
		return true;
	};
	let shown = 0;
	if (shape.kind === "array") {
		for (let index = 1; index <= shape.count && shown < 4; index++) {
			if (!add(innerText(rawget(value, index)))) break;
			shown += 1;
		}
	} else {
		for (const [key, inner] of pairs(value)) {
			if (shown >= 4) break;
			const keyText = typeIs(key, "string") ? cut(escapeText(key, false), 20) : `[${innerText(key)}]`;
			if (!add(shape.kind === "set" ? keyText : `${keyText} = ${innerText(inner)}`)) break;
			shown += 1;
		}
	}
	const [open, close] = shape.kind === "array" ? ["[", "]"] : ["{", "}"];
	const ellipsis = shown < shape.count || shape.more ? ", ..." : "";
	return `${open}${parts.join(", ")}${ellipsis}${close} (${count})`;
}

// Keys ----------------------------------------------------------------------------------------------------------------

/** Keys with a direct segment ("s", "n", "b"); everything else gets a reference segment. */
function isPlainKey(key: unknown): boolean {
	if (typeIs(key, "string")) return key.size() <= SEGMENT_CHARS;
	return typeIs(key, "number") || typeIs(key, "boolean");
}

/** The text a reference segment matches on: stable for the same key while the table doesn't change. */
function refPreview(key: unknown): string {
	if (typeIs(key, "string")) return quote(key, 40);
	if (typeIs(key, "table")) {
		// Tables without a metatable: their address (tostring can't run a metamethod there); others are just "object".
		return getmetatable(key) === undefined ? tostring(key) : "object";
	}
	if (typeIs(key, "function") || typeIs(key, "thread")) return tostring(key);
	return scalarPreview(key);
}

function keyText(key: unknown): string {
	if (typeIs(key, "string")) {
		const body = cut(key, KEY_CHARS);
		return escapeText(body, false) + (body.size() < key.size() ? "..." : "");
	}
	if (typeIs(key, "number")) return numberText(key);
	if (typeIs(key, "boolean")) return key ? "true" : "false";
	return `[${cut(refPreview(key), KEY_CHARS)}]`;
}

/** Segment of a plain key. */
function plainSegment(key: unknown): string {
	if (typeIs(key, "string")) return `s${key}`;
	if (typeIs(key, "number")) return numberSegment(key);
	return key === true ? "b1" : "b0";
}

/** The value a segment names in `container`: [found, value]. */
function step(container: object, segment: string): [found: boolean, value: unknown] {
	const kind = segment.sub(1, 1);
	const rest = segment.sub(2);
	let key: unknown;
	if (kind === "s") key = rest;
	else if (kind === "n") key = decodeNumber(rest);
	else if (kind === "b") key = rest === "1";
	else if (kind === "r") {
		const [nText, preview] = rest.match("^(%d+):(.*)$") as LuaTuple<[string | undefined, string | undefined]>;
		const wanted = nText !== undefined ? tonumber(nText) : undefined;
		if (wanted === undefined || preview === undefined) return [false, undefined];
		let seen = 0;
		for (const [candidate, inner] of pairs(container)) {
			if (isPlainKey(candidate) || refPreview(candidate) !== preview) continue;
			seen += 1;
			if (seen === wanted) return [true, inner];
		}
		return [false, undefined];
	} else return [false, undefined];
	if (key === undefined) return [false, undefined];
	const value = rawget(container, key);
	return [value !== undefined, value];
}

/** A segment as text in a path label: .name, [3], [true], [Alice]. */
function segmentLabel(segment: string): string {
	const kind = segment.sub(1, 1);
	const rest = segment.sub(2);
	if (kind === "s") return rest.match("^[%a_][%w_]*$")[0] !== undefined ? `.${cut(rest, 40)}` : `[${quote(rest, 30)}]`;
	if (kind === "n") return `[${rest}]`;
	if (kind === "b") return rest === "1" ? "[true]" : "[false]";
	const [, preview] = rest.match("^(%d+):(.*)$") as LuaTuple<[string | undefined, string | undefined]>;
	return `[${cut(preview ?? "?", 40)}]`;
}

/** A node's id for maps and stores: the segments, each length-prefixed, so no two paths share an id. */
export function stateNodeId(path: ReadonlyArray<string>): string {
	const parts = new Array<string>();
	for (const segment of path) parts.push(`${segment.size()}:${segment}`);
	return parts.join("");
}

// Queries ---------------------------------------------------------------------------------------------------------

function cleanString(value: unknown, max: number): string | undefined {
	return typeIs(value, "string") && value.size() <= max ? value : undefined;
}

function stringList(value: unknown, maxItems: number, maxChars: number): string[] | undefined {
	if (!typeIs(value, "table")) return undefined;
	const list = new Array<string>();
	let count = 0;
	for (const [index, item] of pairs(value as object)) {
		count += 1;
		if (count > maxItems || !typeIs(index, "number") || !typeIs(item, "string") || item.size() > maxChars) return undefined;
	}
	for (let index = 1; index <= count; index++) {
		const item = rawget(value, index);
		if (!typeIs(item, "string")) return undefined;
		list.push(item);
	}
	return list;
}

/** One query from untrusted input, or why not. */
export function parseStateQuery(raw: unknown): StateQuery | string {
	if (!typeIs(raw, "table")) return "bad_query";
	const query = raw as Record<string, unknown>;
	const side = query.side;
	if (side !== "server" && side !== "client") return "bad_side";
	const root = cleanString(query.root ?? "", ROOT_CHARS);
	if (root === undefined) return "bad_root";
	const path = query.path === undefined ? [] : stringList(query.path, STATE_MAX_DEPTH + 1, SEGMENT_CHARS + 64);
	if (path === undefined) return "bad_path";
	const page = query.page ?? 0;
	if (!typeIs(page, "number") || page < 0 || page % 1 !== 0 || page > COUNT_CAP) return "bad_page";
	let filter: string | undefined;
	if (query.filter !== undefined) {
		if (!typeIs(query.filter, "string")) return "bad_filter";
		filter = query.filter.sub(1, FILTER_CHARS);
		if (filter === "") filter = undefined;
	}
	const keep = query.keep === undefined ? undefined : stringList(query.keep, KEEP_MAX, SEGMENT_CHARS + 64);
	if (query.keep !== undefined && keep === undefined) return "bad_keep";
	return { side, root, path, page, filter, keep };
}

/** A "state.inspect" payload: one query, or `{queries: [...]}` (at most STATE_MAX_QUERIES). */
export function parseStateRequest(raw: unknown): StateQuery[] | string {
	if (!typeIs(raw, "table")) return "bad_query";
	const batch = (raw as { queries?: unknown }).queries;
	if (batch === undefined) {
		const single = parseStateQuery(raw);
		return typeIs(single, "string") ? single : [single];
	}
	if (!typeIs(batch, "table")) return "bad_query";
	const queries = new Array<StateQuery>();
	let count = 0;
	for (const [index] of pairs(batch as object)) {
		count += 1;
		if (!typeIs(index, "number") || count > STATE_MAX_QUERIES) return count > STATE_MAX_QUERIES ? "too_many" : "bad_query";
	}
	for (let index = 1; index <= count; index++) {
		const query = parseStateQuery(rawget(batch, index));
		if (typeIs(query, "string")) return query;
		queries.push(query);
	}
	return queries;
}

// Inspect ---------------------------------------------------------------------------------------------------------

interface Item {
	key: unknown;
	value: unknown;
	/** Reference segments are fixed while scanning (they count earlier keys with the same preview). */
	seg?: string;
}

function itemSegment(item: Item): string {
	return item.seg ?? plainSegment(item.key);
}

function rank(key: unknown): number {
	if (typeIs(key, "number")) return 0;
	if (typeIs(key, "string")) return 1;
	if (typeIs(key, "boolean")) return 2;
	return 3;
}

function sortItems(items: Item[]) {
	const texts = new Map<Item, string>();
	const textOf = (item: Item): string => {
		let text = texts.get(item);
		if (text === undefined) {
			text = typeIs(item.key, "string") ? item.key.lower() : item.seg ?? "";
			texts.set(item, text);
		}
		return text;
	};
	items.sort((a, b) => {
		const [left, right] = [rank(a.key), rank(b.key)];
		if (left !== right) return left < right;
		if (left === 0) return (a.key as number) < (b.key as number);
		if (left === 2) return a.key === false && b.key === true;
		const [x, y] = [textOf(a), textOf(b)];
		if (x !== y) return x < y;
		if (left === 1) return (a.key as string) < (b.key as string);
		return false;
	});
}

/** One entry (`depth` = the length of its own path): type, preview, whether it opens, cycles against `ancestors`. */
function entryOf(item: Item, ancestors: object[], labels: string[], depth: number): StateEntry {
	const value = item.value;
	const entry: StateEntry = { key: keyText(item.key), seg: itemSegment(item), type: "nil", preview: "nil", expandable: false };
	if (!typeIs(value, "table")) {
		entry.type = scalarType(value);
		entry.preview = scalarPreview(value);
		return entry;
	}
	for (let index = 0; index < ancestors.size(); index++) {
		if (rawequal(ancestors[index], value)) {
			entry.type = isObject(value) ? "object" : "table";
			entry.preview = `cycle: ${labels[index]}`;
			entry.cycle = true;
			return entry;
		}
	}
	const shape = shapeOf(value, PREVIEW_SCAN);
	entry.type = shape.kind;
	entry.preview = tablePreview(value, shape);
	entry.expandable = shape.count > 0 && depth <= STATE_MAX_DEPTH;
	return entry;
}

function emptyReply(kind: string, preview: string): StateReply {
	return { type: kind, preview, size: 0, matched: 0, entries: [], page: 0, pages: 1, hasMore: false };
}

function pageBounds(total: number, page: number): [page: number, pages: number, from: number, to: number] {
	const pages = math.max(1, math.ceil(total / STATE_PAGE));
	const clamped = math.clamp(page, 0, pages - 1);
	const from = clamped * STATE_PAGE;
	return [clamped, pages, from, math.min(total, from + STATE_PAGE)];
}

function matches(text: string, needle: string | undefined): boolean {
	return needle === undefined || text.lower().find(needle, 1, true)[0] !== undefined;
}

/** The list of roots: each module (a class instance) and the persist store. */
function listRoots(roots: ReadonlyArray<StateRoot>, query: StateQuery): StateReply {
	const needle = query.filter?.lower();
	const keep = new Set(query.keep ?? []);
	const listed = roots.filter((root) => keep.has(root.token) || matches(root.label, needle));
	const [page, pages, from, to] = pageBounds(listed.size(), query.page);
	const entries = new Array<StateEntry>();
	for (let index = from; index < to; index++) {
		const root = listed[index];
		const shape = shapeOf(root.value, PREVIEW_SCAN);
		entries.push({
			key: cut(root.label, KEY_CHARS),
			seg: root.token,
			type: root.kind,
			preview: root.kind === "persist" ? `${shape.count} key${shape.count === 1 ? "" : "s"}` : tablePreview(root.value, shape),
			expandable: shape.count > 0,
		});
	}
	return { type: "roots", preview: `${roots.size()}`, size: roots.size(), matched: listed.size(), entries, page, pages, hasMore: to < listed.size() };
}

/**
 * Answers one query against `roots`: the node at root + path, and one page of its entries (sorted: numbers, strings,
 * booleans, other keys; arrays by index), filtered by key text when the query has a filter.
 */
export function inspectState(roots: ReadonlyArray<StateRoot>, query: StateQuery): StateReply {
	if (query.root === "") return listRoots(roots, query);
	const root = roots.find((candidate) => candidate.token === query.root);
	if (!root) {
		const reply = emptyReply("nil", "nil");
		reply.missing = true;
		return reply;
	}
	if (query.path.size() > STATE_MAX_DEPTH) {
		const reply = emptyReply("nil", "too deep");
		reply.tooDeep = true;
		return reply;
	}
	// Walk the path; every table on the way is an ancestor (cycle check) with its label.
	const ancestors: object[] = [root.value];
	const labels: string[] = [root.label];
	let node: unknown = root.value;
	let label = root.label;
	for (const segment of query.path) {
		if (!typeIs(node, "table")) {
			node = undefined;
			break;
		}
		const [found, value] = step(node as object, segment);
		if (!found) {
			const reply = emptyReply("nil", "nil");
			reply.missing = true;
			return reply;
		}
		node = value;
		label += segmentLabel(segment);
		if (typeIs(node, "table")) {
			ancestors.push(node as object);
			labels.push(label);
		}
	}
	if (!typeIs(node, "table")) return emptyReply(scalarType(node), scalarPreview(node));
	const container = node as object;
	const depth = query.path.size() + 1;

	// Scan: count (to the cap), keep up to SORT_CAP items, and fix reference segments in table order.
	let count = 0;
	let capped = false;
	let truncated = false;
	let sequential = true;
	let maxIndex = 0;
	const items = new Array<Item>();
	const refCounts = new Map<string, number>();
	for (const [key, value] of pairs(container)) {
		if (count >= COUNT_CAP) {
			capped = true;
			break;
		}
		count += 1;
		if (typeIs(key, "number") && key >= 1 && key % 1 === 0) {
			if (key > maxIndex) maxIndex = key;
		} else sequential = false;
		if (items.size() >= SORT_CAP) {
			truncated = true;
			continue;
		}
		const item: Item = { key, value };
		if (!isPlainKey(key)) {
			const preview = refPreview(key);
			const n = (refCounts.get(preview) ?? 0) + 1;
			refCounts.set(preview, n);
			item.seg = `r${n}:${preview}`;
		}
		items.push(item);
	}
	const isArray = !capped && !truncated && count > 0 && sequential && maxIndex === count;
	const shape = shapeOf(container, PREVIEW_SCAN);
	const atRoot = query.path.size() === 0;
	const kind = atRoot && root.kind === "persist" ? "persist" : atRoot && root.kind === "module" ? "module" : shape.kind;
	const preview = tablePreview(container, shape);

	const needle = query.filter?.lower();
	const keep = new Set(query.keep ?? []);
	let listed: Item[];
	if (isArray) {
		// Arrays page by index, no sort; items already hold 1..n in some order.
		listed = new Array<Item>(count);
		for (let index = 1; index <= count; index++) {
			const item: Item = { key: index, value: rawget(container, index) };
			if (needle === undefined || keep.has(itemSegment(item)) || matches(tostring(index), needle)) listed.push(item);
		}
	} else {
		listed = needle === undefined ? items : items.filter((item) => keep.has(itemSegment(item)) || matches(keyText(item.key), needle));
		sortItems(listed);
	}
	const [page, pages, from, to] = pageBounds(listed.size(), query.page);
	const entries = new Array<StateEntry>();
	for (let index = from; index < to; index++) entries.push(entryOf(listed[index], ancestors, labels, depth));
	return {
		type: kind,
		preview,
		size: count,
		capped: capped ? true : undefined,
		truncated: truncated ? true : undefined,
		matched: listed.size(),
		entries,
		page,
		pages,
		hasMore: to < listed.size(),
	};
}
