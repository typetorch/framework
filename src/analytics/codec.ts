/**
 * tt-rec-1: the packed binary chunks of a first-ever-session recording (plans/16 section 3; layout in SCHEMA.md).
 * Little-endian. A chunk is a 4-byte header and records; every record is `u8 tag, u16 dt` (ms since the previous
 * record, the first since the chunk start) and a payload by tag. Each chunk decodes on its own (its own anchor and
 * string table).
 *
 * Pure: no imports and no services (numbers in, buffer out), so it also runs offline under Lune
 * (scripts/test-analytics.luau). The client recorder (client.ts) feeds it.
 */

export const REC_VERSION = 1;
export const REC_HEADER_BYTES = 4;

/** Record tags. */
export const enum RecTag {
	/** Only advances time (a gap longer than 65535 ms). */
	Wait = 0,
	/** f32 x, y, z: the origin of the positions that follow. */
	Anchor = 1,
	/** Character and camera: i16 x, y, z (1/8 stud from the anchor), u8 yaw, i16 x, y, z (camera minus character, 1/16 stud), u8 yaw, i8 pitch. */
	Sample = 2,
	/** Camera only (no character): i16 x, y, z (1/8 stud from the anchor), u8 yaw, i8 pitch. */
	Camera = 3,
	/** u8 kind (bit 7: the game processed it, e.g. a click on UI), u16 code. */
	Key = 4,
	/** u8 kind (bit 7 as Key), u16 code, u16 x, u16 y (0..65535 across the viewport). */
	Pointer = 5,
	/** u16 id, u8 length, UTF-8 bytes: defines string `id` for the rest of the chunk. */
	String = 6,
	/** u8 kind, u16 string id (65535: none). */
	Event = 7,
}

/** `kind` of Key and Pointer records (low 7 bits). */
export const enum InputKind {
	KeyDown = 1,
	KeyUp = 2,
	MouseDown = 3,
	MouseUp = 4,
	TouchStart = 5,
	TouchEnd = 6,
	PadDown = 7,
	PadUp = 8,
	StickStart = 9,
	StickStop = 10,
	Scroll = 11,
}

/** `kind` of Event records. */
export const enum EventKindCode {
	Button = 1,
	Hover = 2,
	ScreenOpen = 3,
	ScreenClose = 4,
	PromptShown = 5,
	PromptHidden = 6,
	PromptTriggered = 7,
	Died = 8,
	Spawned = 9,
	TextBox = 10,
	Custom = 11,
}

const NO_STRING = 65535;
const POSITION_SCALE = 8;
const CAMERA_SCALE = 16;
const I16_MAX = 32767;
const TAU = math.pi * 2;

function wrapYaw(radians: number): number {
	return math.floor(((radians + math.pi) / TAU) * 256 + 0.5) % 256;
}

function quantizePitch(radians: number): number {
	return math.clamp(math.floor((radians / (math.pi / 2)) * 127 + 0.5), -127, 127);
}

function i16(value: number): number {
	return math.clamp(math.floor(value + 0.5), -I16_MAX, I16_MAX);
}

/** Yaw (radians, 0 = facing -Z, counter-clockwise from above) of a look vector. */
export function yawOf(lookX: number, lookZ: number): number {
	return math.atan2(-lookX, -lookZ);
}

/** Pitch (radians, up is positive) of a unit look vector. */
export function pitchOf(lookY: number): number {
	return math.asin(math.clamp(lookY, -1, 1));
}

/** Packs one chunk. Times are ms since the chunk started and never go backwards. */
export class RecWriter {
	private data: buffer;
	private used = REC_HEADER_BYTES;
	private lastMs = 0;
	private readonly strings = new Map<string, number>();
	private anchor: [number, number, number] | undefined;
	/** Position samples (Sample + Camera records): the row's `n`. */
	samples = 0;
	records = 0;

	constructor(readonly intervalMs = 100) {
		this.data = buffer.create(1024);
		buffer.writeu8(this.data, 0, REC_VERSION);
		buffer.writeu8(this.data, 1, 0);
		buffer.writeu16(this.data, 2, math.clamp(intervalMs, 0, 65535));
	}

	/** Bytes written so far. */
	size(): number {
		return this.used;
	}

	private ensure(extra: number) {
		const capacity = buffer.len(this.data);
		if (this.used + extra <= capacity) return;
		let size = capacity * 2;
		while (size < this.used + extra) size *= 2;
		const grown = buffer.create(size);
		buffer.copy(grown, 0, this.data, 0, this.used);
		this.data = grown;
	}

	/** Writes `tag` and the time since the previous record (Wait records first if the gap is over 65535 ms). */
	private head(tag: RecTag, atMs: number, payload: number) {
		let delta = math.max(0, math.floor(atMs) - this.lastMs);
		while (delta > 65535) {
			this.ensure(3);
			buffer.writeu8(this.data, this.used, RecTag.Wait);
			buffer.writeu16(this.data, this.used + 1, 65535);
			this.used += 3;
			this.lastMs += 65535;
			this.records += 1;
			delta -= 65535;
		}
		this.ensure(3 + payload);
		buffer.writeu8(this.data, this.used, tag);
		buffer.writeu16(this.data, this.used + 1, delta);
		this.used += 3;
		this.lastMs += delta;
		this.records += 1;
	}

	private writeAnchor(atMs: number, x: number, y: number, z: number) {
		this.head(RecTag.Anchor, atMs, 12);
		buffer.writef32(this.data, this.used, x);
		buffer.writef32(this.data, this.used + 4, y);
		buffer.writef32(this.data, this.used + 8, z);
		this.used += 12;
		// Store what f32 kept, so offsets match what the reader decodes.
		this.anchor = [
			buffer.readf32(this.data, this.used - 12),
			buffer.readf32(this.data, this.used - 8),
			buffer.readf32(this.data, this.used - 4),
		];
	}

	/** Offsets from the anchor at 1/8 stud, re-anchoring at (x, y, z) when out of the i16 range. */
	private offsets(atMs: number, x: number, y: number, z: number): [number, number, number] {
		let anchor = this.anchor;
		const fits = (value: number, origin: number) => math.abs((value - origin) * POSITION_SCALE) <= I16_MAX;
		if (!anchor || !fits(x, anchor[0]) || !fits(y, anchor[1]) || !fits(z, anchor[2])) {
			this.writeAnchor(atMs, x, y, z);
			anchor = this.anchor!;
		}
		return [
			i16((x - anchor[0]) * POSITION_SCALE),
			i16((y - anchor[1]) * POSITION_SCALE),
			i16((z - anchor[2]) * POSITION_SCALE),
		];
	}

	/** Character position and facing yaw, camera position, yaw and pitch (radians). */
	sample(atMs: number, cx: number, cy: number, cz: number, cyaw: number, kx: number, ky: number, kz: number, kyaw: number, kpitch: number) {
		const [ox, oy, oz] = this.offsets(atMs, cx, cy, cz);
		this.head(RecTag.Sample, atMs, 15);
		const data = this.data;
		const at = this.used;
		buffer.writei16(data, at, ox);
		buffer.writei16(data, at + 2, oy);
		buffer.writei16(data, at + 4, oz);
		buffer.writeu8(data, at + 6, wrapYaw(cyaw));
		buffer.writei16(data, at + 7, i16((kx - cx) * CAMERA_SCALE));
		buffer.writei16(data, at + 9, i16((ky - cy) * CAMERA_SCALE));
		buffer.writei16(data, at + 11, i16((kz - cz) * CAMERA_SCALE));
		buffer.writeu8(data, at + 13, wrapYaw(kyaw));
		buffer.writei8(data, at + 14, quantizePitch(kpitch));
		this.used += 15;
		this.samples += 1;
	}

	/** Camera only (no character): position, yaw and pitch (radians). */
	camera(atMs: number, kx: number, ky: number, kz: number, kyaw: number, kpitch: number) {
		const [ox, oy, oz] = this.offsets(atMs, kx, ky, kz);
		this.head(RecTag.Camera, atMs, 8);
		const data = this.data;
		const at = this.used;
		buffer.writei16(data, at, ox);
		buffer.writei16(data, at + 2, oy);
		buffer.writei16(data, at + 4, oz);
		buffer.writeu8(data, at + 6, wrapYaw(kyaw));
		buffer.writei8(data, at + 7, quantizePitch(kpitch));
		this.used += 8;
		this.samples += 1;
	}

	key(atMs: number, kind: InputKind, code: number, processed: boolean) {
		this.head(RecTag.Key, atMs, 3);
		buffer.writeu8(this.data, this.used, (kind & 0x7f) + (processed ? 0x80 : 0));
		buffer.writeu16(this.data, this.used + 1, math.clamp(code, 0, 65535));
		this.used += 3;
	}

	/** `x` and `y` are 0..1 across the viewport. */
	pointer(atMs: number, kind: InputKind, code: number, x: number, y: number, processed: boolean) {
		this.head(RecTag.Pointer, atMs, 7);
		const data = this.data;
		const at = this.used;
		buffer.writeu8(data, at, (kind & 0x7f) + (processed ? 0x80 : 0));
		buffer.writeu16(data, at + 1, math.clamp(code, 0, 65535));
		buffer.writeu16(data, at + 3, math.clamp(math.floor(x * 65535 + 0.5), 0, 65535));
		buffer.writeu16(data, at + 5, math.clamp(math.floor(y * 65535 + 0.5), 0, 65535));
		this.used += 7;
	}

	/** The chunk-local id of `text` (at most 255 bytes kept), defining it first if new. */
	private stringId(atMs: number, text: string): number {
		const value = text.size() > 255 ? text.sub(1, 255) : text;
		const known = this.strings.get(value);
		if (known !== undefined) return known;
		const id = this.strings.size();
		if (id >= NO_STRING) return NO_STRING;
		this.head(RecTag.String, atMs, 3 + value.size());
		buffer.writeu16(this.data, this.used, id);
		buffer.writeu8(this.data, this.used + 2, value.size());
		buffer.writestring(this.data, this.used + 3, value);
		this.used += 3 + value.size();
		this.strings.set(value, id);
		return id;
	}

	event(atMs: number, kind: EventKindCode, text?: string) {
		const id = text !== undefined ? this.stringId(atMs, text) : NO_STRING;
		this.head(RecTag.Event, atMs, 3);
		buffer.writeu8(this.data, this.used, kind);
		buffer.writeu16(this.data, this.used + 1, id);
		this.used += 3;
	}

	/** The packed chunk (a copy of the used bytes). `last`: the recording ends with this chunk (flags bit 0). */
	finish(last: boolean): buffer {
		const out = buffer.create(this.used);
		buffer.copy(out, 0, this.data, 0, this.used);
		buffer.writeu8(out, 1, last ? 1 : 0);
		return out;
	}
}

// Decoding (tests, and the reference for readers in other languages) ---------------------------------------------------

export interface DecodedRecord {
	tag: number;
	/** ms since the chunk start. */
	at: number;
	/** Anchor: x, y, z. Sample: character x, y, z, yaw, camera x, y, z, yaw, pitch. Camera: x, y, z, yaw, pitch. */
	values?: number[];
	/** Key / Pointer / Event kind (Key/Pointer: low 7 bits). */
	kind?: number;
	processed?: boolean;
	code?: number;
	x?: number;
	y?: number;
	/** String / Event: the text. */
	text?: string;
	id?: number;
}

export interface DecodedChunk {
	version: number;
	last: boolean;
	intervalMs: number;
	records: DecodedRecord[];
}

function unwrapYaw(byte: number): number {
	return (byte / 256) * TAU - math.pi;
}

/** Decodes a tt-rec-1 chunk. Positions come back absolute (studs), angles in radians. Throws on a malformed chunk. */
export function decodeChunk(data: buffer): DecodedChunk {
	const size = buffer.len(data);
	assert(size >= REC_HEADER_BYTES, "chunk too short");
	const version = buffer.readu8(data, 0);
	assert(version === REC_VERSION, `unknown tt-rec version ${version}`);
	const result: DecodedChunk = {
		version,
		last: (buffer.readu8(data, 1) & 1) === 1,
		intervalMs: buffer.readu16(data, 2),
		records: [],
	};
	const strings = new Map<number, string>();
	let anchor: [number, number, number] = [0, 0, 0];
	let at = 0;
	let offset = REC_HEADER_BYTES;
	while (offset < size) {
		const tag = buffer.readu8(data, offset);
		at += buffer.readu16(data, offset + 1);
		offset += 3;
		const record: DecodedRecord = { tag, at };
		if (tag === RecTag.Wait) {
			// time only
		} else if (tag === RecTag.Anchor) {
			anchor = [buffer.readf32(data, offset), buffer.readf32(data, offset + 4), buffer.readf32(data, offset + 8)];
			record.values = [...anchor];
			offset += 12;
		} else if (tag === RecTag.Sample) {
			const cx = anchor[0] + buffer.readi16(data, offset) / POSITION_SCALE;
			const cy = anchor[1] + buffer.readi16(data, offset + 2) / POSITION_SCALE;
			const cz = anchor[2] + buffer.readi16(data, offset + 4) / POSITION_SCALE;
			record.values = [
				cx,
				cy,
				cz,
				unwrapYaw(buffer.readu8(data, offset + 6)),
				cx + buffer.readi16(data, offset + 7) / CAMERA_SCALE,
				cy + buffer.readi16(data, offset + 9) / CAMERA_SCALE,
				cz + buffer.readi16(data, offset + 11) / CAMERA_SCALE,
				unwrapYaw(buffer.readu8(data, offset + 13)),
				(buffer.readi8(data, offset + 14) / 127) * (math.pi / 2),
			];
			offset += 15;
		} else if (tag === RecTag.Camera) {
			record.values = [
				anchor[0] + buffer.readi16(data, offset) / POSITION_SCALE,
				anchor[1] + buffer.readi16(data, offset + 2) / POSITION_SCALE,
				anchor[2] + buffer.readi16(data, offset + 4) / POSITION_SCALE,
				unwrapYaw(buffer.readu8(data, offset + 6)),
				(buffer.readi8(data, offset + 7) / 127) * (math.pi / 2),
			];
			offset += 8;
		} else if (tag === RecTag.Key || tag === RecTag.Pointer) {
			const kind = buffer.readu8(data, offset);
			record.kind = kind & 0x7f;
			record.processed = kind >= 0x80;
			record.code = buffer.readu16(data, offset + 1);
			offset += 3;
			if (tag === RecTag.Pointer) {
				record.x = buffer.readu16(data, offset) / 65535;
				record.y = buffer.readu16(data, offset + 2) / 65535;
				offset += 4;
			}
		} else if (tag === RecTag.String) {
			const id = buffer.readu16(data, offset);
			const length = buffer.readu8(data, offset + 2);
			const text = buffer.readstring(data, offset + 3, length);
			strings.set(id, text);
			record.id = id;
			record.text = text;
			offset += 3 + length;
		} else if (tag === RecTag.Event) {
			record.kind = buffer.readu8(data, offset);
			const id = buffer.readu16(data, offset + 1);
			record.id = id;
			record.text = id === NO_STRING ? undefined : strings.get(id);
			offset += 3;
		} else {
			error(`unknown tt-rec record tag ${tag} at byte ${offset - 3}`);
		}
		assert(offset <= size, "record runs past the end of the chunk");
		result.records.push(record);
	}
	return result;
}

// Base64 (standard alphabet, padded) --------------------------------------------------------------------------------------

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 of a buffer (the recordings table's `data` column). */
export function toBase64(data: buffer): string {
	const size = buffer.len(data);
	const out = buffer.create(math.ceil(size / 3) * 4);
	let write = 0;
	for (let index = 0; index < size; index += 3) {
		const a = buffer.readu8(data, index);
		const b = index + 1 < size ? buffer.readu8(data, index + 1) : 0;
		const c = index + 2 < size ? buffer.readu8(data, index + 2) : 0;
		const triple = a * 65536 + b * 256 + c;
		buffer.writeu8(out, write, string.byte(ALPHABET, math.floor(triple / 262144) + 1)[0]);
		buffer.writeu8(out, write + 1, string.byte(ALPHABET, (math.floor(triple / 4096) % 64) + 1)[0]);
		buffer.writeu8(out, write + 2, index + 1 < size ? string.byte(ALPHABET, (math.floor(triple / 64) % 64) + 1)[0] : 61);
		buffer.writeu8(out, write + 3, index + 2 < size ? string.byte(ALPHABET, (triple % 64) + 1)[0] : 61);
		write += 4;
	}
	return buffer.tostring(out);
}

/** Decodes standard padded base64 (tests and tools). Throws on bad input. */
export function fromBase64(text: string): buffer {
	const lookup = new Map<number, number>();
	for (let index = 1; index <= 64; index++) lookup.set(string.byte(ALPHABET, index)[0], index - 1);
	assert(text.size() % 4 === 0, "base64 length must be a multiple of 4");
	let padding = 0;
	if (text.sub(-1) === "=") padding += 1;
	if (text.sub(-2, -2) === "=") padding += 1;
	const out = buffer.create((text.size() / 4) * 3 - padding);
	let write = 0;
	for (let index = 1; index <= text.size(); index += 4) {
		let triple = 0;
		for (let offset = 0; offset < 4; offset++) {
			const byte = string.byte(text, index + offset)[0];
			const value = byte === 61 ? 0 : lookup.get(byte);
			assert(value !== undefined, "bad base64 character");
			triple = triple * 64 + value;
		}
		const bytes = [math.floor(triple / 65536), math.floor(triple / 256) % 256, triple % 256];
		for (const byte of bytes) {
			if (write < buffer.len(out)) {
				buffer.writeu8(out, write, byte);
				write += 1;
			}
		}
	}
	return out;
}
