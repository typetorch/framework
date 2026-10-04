import { HttpService } from "@rbxts/services";

/**
 * Packet capture for the dev menu's network inspector (plans/10, Network > Packets). A dispatcher records into a
 * PacketTap only while one is attached (`dispatcher.tap`), so with nobody inspecting every message costs one nil check.
 *
 * Captured: typed leaves (fire, invoke, response, unreliable sends) with their decoded arguments, both directions, and
 * the server's guard verdict. Not captured: raw channels (dev menu internals; they can carry pairing codes) and the
 * kernel's own traffic (notices, dev status, resync), which never reaches the framework dispatcher.
 */

export type PacketDirection = "in" | "out";
/** Inbound events are always "fire": the kernel hands the framework reliable and unreliable messages the same way. */
export type PacketKind = "fire" | "invoke" | "response" | "unreliable";
/** ok = accepted (or sent); rejected = guard or shape; limited = rate limit; error = handler threw; blocked = dev block. */
export type PacketStatus = "ok" | "rejected" | "limited" | "error" | "blocked";

export interface PacketSummary {
	/** Sequence number in its tap (the `since` cursor). */
	i: number;
	/** Unix time in milliseconds. */
	t: number;
	dir: PacketDirection;
	kind: PacketKind;
	/** namespace.method (for unknown channels: the raw channel name). */
	path: string;
	/** Server side: the player's Name, or "all" for broadcasts. */
	player?: string;
	userId?: number;
	/** Estimated wire size in bytes. */
	bytes: number;
	/** The estimate stopped early (huge payload): the real size is larger. */
	approx?: boolean;
	status: PacketStatus;
	reason?: string;
	/** The arguments on one line, cut short. */
	preview: string;
}

export interface PacketRecord extends PacketSummary {
	/** The arguments pretty-printed (indented, capped by depth, entries and length). */
	args: string;
}

/** One page of the server ring (dev op "net.packets"). */
export interface PacketPage {
	/** Changes with every new server tap (a new generation): a client resets its cursor when it does. */
	session: string;
	packets: PacketSummary[];
	/** Pass as `since` next time. */
	next: number;
	/** Packets the caller missed (the ring wrapped, or more matched than one page holds). */
	skipped: number;
	/** Packets not recorded at all because of the per-second cap. */
	dropped: number;
	/** The server's effective channel ("prod" = read-only). */
	channel?: string;
}

/** Packets kept per tap. */
export const PACKET_CAPACITY = 500;
/** Records per second at most; the rest are counted as dropped, so a busy server never pays for every message. */
const MAX_PER_SECOND = 400;

// Serialization caps.
const MAX_DEPTH = 6;
const MAX_ENTRIES = 40;
/** Keys counted per table before giving up (the count shows as "+N more"). */
const COUNT_CAP = 10_000;
const PRETTY_BUDGET = 4000;
const PRETTY_STRING = 300;
const PREVIEW_BUDGET = 140;
const PREVIEW_STRING = 40;
const HEX_BYTES = 24;
/** Nodes the size estimate visits before it stops (and marks the size approximate). */
const SIZE_BUDGET = 3000;
/** The kernel prefixes every message with the artifact id; plus the channel prefix ("e:", "r:"). */
const WIRE_OVERHEAD = 20;

// Formatting -----------------------------------------------------------------------------------------------------------

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

function escapeString(text: string): string {
	if (isUtf8(text)) return text.gsub('[%c"\\]', escapeChar)[0];
	// Binary data: escape every byte outside printable ASCII.
	const parts = new Array<string>();
	for (let index = 1; index <= text.size(); index++) {
		const char = text.sub(index, index);
		const [code] = char.byte();
		parts.push(code < 32 || code >= 127 || char === '"' || char === "\\" ? escapeChar(char) : char);
	}
	return parts.join("");
}

function quote(text: string, max: number): string {
	const body = cut(text, max);
	const rest = text.size() - body.size();
	return rest > 0 ? `"${escapeString(body)}" (+${rest})` : `"${escapeString(body)}"`;
}

function num(value: number): string {
	if (value !== value) return "nan";
	if (value === math.huge) return "inf";
	if (value === -math.huge) return "-inf";
	if (value % 1 === 0 && math.abs(value) < 1e15) return "%d".format(value);
	return "%.6g".format(value);
}

/** Vector components: at most two decimals. */
function short(value: number): string {
	if (value !== value || value === math.huge || value === -math.huge) return num(value);
	if (value % 1 === 0 && math.abs(value) < 1e15) return "%d".format(value);
	const text = "%.2f".format(value).gsub("0+$", "")[0].gsub("%.$", "")[0];
	return text === "-0" ? "0" : text;
}

function degrees(radians: number): string {
	return short(math.deg(radians));
}

function hexPreview(value: buffer): string {
	const length = buffer.len(value);
	const bytes = new Array<string>();
	for (let index = 0; index < math.min(length, HEX_BYTES); index++) bytes.push("%02x".format(buffer.readu8(value, index)));
	return `buffer(${length})${bytes.size() > 0 ? ` ${bytes.join(" ")}` : ""}${length > HEX_BYTES ? " ..." : ""}`;
}

/** Everything but tables, as one short line. */
function scalar(value: unknown, maxString: number): string {
	const kind = typeOf(value);
	switch (kind) {
		case "nil":
			return "nil";
		case "boolean":
			return tostring(value);
		case "number":
			return num(value as number);
		case "string":
			return quote(value as string, maxString);
		case "Instance": {
			const instance = value as Instance;
			return `${instance.ClassName}(${instance.GetFullName()})`;
		}
		case "Vector3": {
			const vector = value as Vector3;
			return `Vector3(${short(vector.X)}, ${short(vector.Y)}, ${short(vector.Z)})`;
		}
		case "Vector2": {
			const vector = value as Vector2;
			return `Vector2(${short(vector.X)}, ${short(vector.Y)})`;
		}
		case "CFrame": {
			const frame = value as CFrame;
			const position = frame.Position;
			const [rx, ry, rz] = frame.ToOrientation();
			const rotation = rx === 0 && ry === 0 && rz === 0 ? "" : `, rot ${degrees(rx)}, ${degrees(ry)}, ${degrees(rz)}`;
			return `CFrame(${short(position.X)}, ${short(position.Y)}, ${short(position.Z)}${rotation})`;
		}
		case "Color3": {
			const color = value as Color3;
			return `Color3(${math.round(color.R * 255)}, ${math.round(color.G * 255)}, ${math.round(color.B * 255)})`;
		}
		case "UDim2": {
			const udim = value as UDim2;
			return `UDim2(${short(udim.X.Scale)}, ${udim.X.Offset}, ${short(udim.Y.Scale)}, ${udim.Y.Offset})`;
		}
		case "UDim": {
			const udim = value as UDim;
			return `UDim(${short(udim.Scale)}, ${udim.Offset})`;
		}
		case "EnumItem":
			return tostring(value);
		case "BrickColor":
			return `BrickColor(${(value as BrickColor).Name})`;
		case "DateTime":
			return `DateTime(${(value as DateTime).ToIsoDate()})`;
		case "buffer":
			return hexPreview(value as buffer);
		case "function":
		case "thread":
			return `<${kind}>`;
		default:
			return `${kind}(${cut(tostring(value), 80)})`;
	}
}

/** Text that stops growing at its budget (and says so). */
class Out {
	private readonly parts = new Array<string>();
	private length = 0;
	full = false;

	constructor(private readonly budget: number) {}

	add(text: string) {
		if (this.full) return;
		const room = this.budget - this.length;
		if (text.size() > room) {
			this.parts.push(cut(text, room));
			this.parts.push(" ...");
			this.full = true;
			return;
		}
		this.parts.push(text);
		this.length += text.size();
	}

	result(): string {
		return this.parts.join("");
	}
}

function keyText(key: unknown, maxString: number): string {
	if (typeIs(key, "string")) return key.match("^[%a_][%w_]*$")[0] !== undefined ? key : quote(key, maxString);
	if (typeIs(key, "table")) return "[<table>]";
	return `[${scalar(key, maxString)}]`;
}

function keyOrder(a: [unknown, unknown], b: [unknown, unknown]): boolean {
	const [left, right] = [a[0], b[0]];
	const leftNumber = typeIs(left, "number");
	const rightNumber = typeIs(right, "number");
	if (leftNumber && rightNumber) return (left as number) < (right as number);
	if (leftNumber !== rightNumber) return leftNumber;
	return tostring(left) < tostring(right);
}

/** Writes `value` as JSON-like text: indented when `pretty`, one line otherwise. Cycles, depth and size are capped. */
function write(value: unknown, out: Out, pretty: boolean, depth: number, stack: Set<object>) {
	if (out.full) return;
	const maxString = pretty ? PRETTY_STRING : PREVIEW_STRING;
	if (!typeIs(value, "table")) {
		out.add(scalar(value, maxString));
		return;
	}
	const tbl = value as object;
	if (stack.has(tbl)) {
		out.add("<cycle>");
		return;
	}
	const list = tbl as unknown[];
	const length = list.size();
	const entries = new Array<[unknown, unknown]>();
	let count = 0;
	let isArray = true;
	for (const [key, inner] of pairs(tbl)) {
		count += 1;
		if (isArray && !(typeIs(key, "number") && key >= 1 && key <= length && key % 1 === 0)) isArray = false;
		if (entries.size() < MAX_ENTRIES) entries.push([key, inner]);
		if (count >= COUNT_CAP) break;
	}
	isArray = isArray && count === length;
	const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
	if (count === 0) {
		// An empty table could be either; the argument list itself reads best as [].
		out.add(depth === 0 ? "[]" : "{}");
		return;
	}
	if (depth >= MAX_DEPTH) {
		out.add(`${open}...${count}${close}`);
		return;
	}
	stack.add(tbl);
	out.add(open);
	const indent = pretty ? `\n${"  ".rep(depth + 1)}` : "";
	const separator = pretty ? "," : ", ";
	let shown = 0;
	if (isArray) {
		for (let index = 0; index < math.min(length, MAX_ENTRIES); index++) {
			if (shown > 0) out.add(separator);
			out.add(indent);
			write(list[index], out, pretty, depth + 1, stack);
			shown += 1;
		}
	} else {
		entries.sort(keyOrder);
		for (const [key, inner] of entries) {
			if (shown > 0) out.add(separator);
			out.add(indent);
			out.add(`${keyText(key, maxString)}: `);
			write(inner, out, pretty, depth + 1, stack);
			shown += 1;
		}
	}
	if (count > shown) out.add(`${separator}${indent}+${count >= COUNT_CAP ? `${count}+` : count - shown} more`);
	stack.delete(tbl);
	out.add(`${pretty ? `\n${"  ".rep(depth)}` : ""}${close}`);
}

/** `args` as indented, capped text (the inspector's detail view). */
export function prettyArgs(args: unknown[]): string {
	const out = new Out(PRETTY_BUDGET);
	write(args, out, true, 0, new Set());
	return out.result();
}

/** `args` on one line, cut short (the inspector's list rows). */
export function previewArgs(args: unknown[]): string {
	const out = new Out(PREVIEW_BUDGET);
	write(args, out, false, 0, new Set());
	return out.result();
}

/** A rough wire size: the real encoding is Roblox's own, so this is for spotting big payloads, not accounting. */
function estimate(value: unknown, budget: { left: number }): number {
	budget.left -= 1;
	if (budget.left < 0) return 0;
	switch (typeOf(value)) {
		case "nil":
		case "boolean":
			return 1;
		case "number":
			return 9;
		case "string":
			return (value as string).size() + 2;
		case "Vector2":
			return 9;
		case "Vector3":
		case "Color3":
			return 13;
		case "CFrame":
			return 25;
		case "UDim2":
			return 17;
		case "EnumItem":
			return 5;
		case "buffer":
			return buffer.len(value as buffer) + 3;
		case "table": {
			// Array indices aren't sent per element; other keys are.
			const length = (value as unknown[]).size();
			let size = 2;
			for (const [key, inner] of pairs(value as object)) {
				const index = typeIs(key, "number") && key >= 1 && key <= length && key % 1 === 0;
				size += (index ? 0 : estimate(key, budget)) + estimate(inner, budget);
				if (budget.left < 0) break;
			}
			return size;
		}
		default:
			return 9;
	}
}

export function estimateSize(args: unknown[]): [bytes: number, approx: boolean] {
	const budget = { left: SIZE_BUDGET };
	const bytes = estimate(args, budget);
	return [bytes, budget.left < 0];
}

/** A record without its full arguments (what list replies carry). */
export function summarize(record: PacketRecord): PacketSummary {
	return {
		i: record.i,
		t: record.t,
		dir: record.dir,
		kind: record.kind,
		path: record.path,
		player: record.player,
		userId: record.userId,
		bytes: record.bytes,
		approx: record.approx,
		status: record.status,
		reason: record.reason,
		preview: record.preview,
	};
}

// The tap --------------------------------------------------------------------------------------------------------------

/**
 * A ring of the last PACKET_CAPACITY packets. Attach it to a dispatcher (`dispatcher.tap = tap`) to capture, detach it
 * to stop; `record` never throws, so capture can't break a message.
 */
export class PacketTap {
	/** False = paused: nothing is recorded (blocks still apply). */
	recording = true;
	/** Client only: paths this client drops while the inspector is open (dev testing). */
	readonly blocked = new Set<string>();
	readonly session = HttpService.GenerateGUID(false).sub(1, 8);
	/** Packets not recorded because of the per-second cap (since the last clear). */
	dropped = 0;
	private readonly ring = new Map<number, PacketRecord>();
	private next = 1;
	/** The oldest sequence number still meant to be readable (moves on clear). */
	private first = 1;
	private windowStart = 0;
	private windowCount = 0;

	/**
	 * Records one packet. `player` is the other end on the server (or "all" for broadcasts); `extra` adds bytes the
	 * arguments don't show (request ids). Returns the record, so the caller can fill in the outcome (a handler error).
	 */
	record(
		dir: PacketDirection,
		kind: PacketKind,
		path: string,
		args: unknown[],
		status: PacketStatus = "ok",
		reason?: string,
		player?: Player | "all",
		extra = 0,
	): PacketRecord | undefined {
		if (!this.recording) return undefined;
		const now = os.clock();
		if (now - this.windowStart >= 1) {
			this.windowStart = now;
			this.windowCount = 0;
		}
		this.windowCount += 1;
		if (this.windowCount > MAX_PER_SECOND) {
			this.dropped += 1;
			return undefined;
		}
		const [ok, built] = pcall(() => {
			const [bytes, approx] = estimateSize(args);
			const record: PacketRecord = {
				i: 0,
				t: DateTime.now().UnixTimestampMillis,
				dir,
				kind,
				path,
				bytes: bytes + path.size() + WIRE_OVERHEAD + extra,
				approx: approx ? true : undefined,
				status,
				reason: reason !== undefined ? cut(reason, 200) : undefined,
				preview: previewArgs(args),
				args: prettyArgs(args),
			};
			if (player === "all") record.player = "all";
			else if (player !== undefined) {
				record.player = player.Name;
				record.userId = player.UserId;
			}
			return record;
		});
		if (!ok) return undefined;
		const record = built as PacketRecord;
		record.i = this.next;
		this.ring.set(this.next % PACKET_CAPACITY, record);
		this.next += 1;
		return record;
	}

	/** Records the outcome of a recorded packet (a listener or handler threw, nobody listened, ...). */
	static outcome(record: PacketRecord, status: PacketStatus, reason?: unknown) {
		record.status = status;
		record.reason = reason !== undefined ? cut(tostring(reason), 200) : undefined;
	}

	get(i: number): PacketRecord | undefined {
		const record = this.ring.get(i % PACKET_CAPACITY);
		return record !== undefined && record.i === i && i >= this.first ? record : undefined;
	}

	/**
	 * Records after `cursor`, oldest first: at most `limit` (the newest ones; older matches count as skipped).
	 * Returns them, the next cursor and how many the caller missed.
	 */
	since(
		cursor: number,
		limit: number,
		filter?: (record: PacketRecord) => boolean,
	): [records: PacketRecord[], next: number, skipped: number] {
		const last = this.next - 1;
		const wrapped = this.next - PACKET_CAPACITY;
		const from = math.max(cursor + 1, this.first, wrapped);
		let skipped = math.max(0, wrapped - math.max(cursor + 1, this.first));
		const matches = new Array<PacketRecord>();
		for (let index = from; index <= last; index++) {
			const record = this.ring.get(index % PACKET_CAPACITY);
			if (record !== undefined && record.i === index && (filter === undefined || filter(record))) matches.push(record);
		}
		if (matches.size() <= limit) return [matches, last, skipped];
		skipped += matches.size() - limit;
		const newest = new Array<PacketRecord>();
		for (let index = matches.size() - limit; index < matches.size(); index++) newest.push(matches[index]);
		return [newest, last, skipped];
	}

	/** Forgets every packet (sequence numbers keep counting, so cursors stay valid). */
	clear() {
		this.ring.clear();
		this.first = this.next;
		this.dropped = 0;
	}
}
