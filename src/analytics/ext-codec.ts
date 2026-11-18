/**
 * tt-ext-1: the extended recording's packed chunks (plans/36; layout in SCHEMA.md "tt-ext-1"). Little-endian. A chunk
 * is a 4-byte header and records; every record is `u8 tag, u16 dt, u16 length` and `length` payload bytes, so a reader
 * skips tags it doesn't know. Segments (from one Keyframe record to the next) own the string table: a reader can start
 * at any chunk whose header flag bit 1 is set.
 *
 * Pure: no imports and no services (numbers in, buffer out), so it also runs offline under Lune
 * (scripts/test-analytics.luau). The client's extended recorder (ext-recorder.ts) feeds it.
 */

export const EXT_VERSION = 1;
export const EXT_HEADER_BYTES = 4;
/** Bytes before a record's payload: tag, dt, length. */
export const EXT_RECORD_HEAD = 5;
/** "No string" / "no parent" in u16 id fields. */
export const EXT_NONE = 65535;
/** Bytes of a string kept (cut at a UTF-8 boundary). */
export const EXT_STRING_MAX = 1000;
/** Strings per segment before the recorder must start a new one (a Keyframe). */
export const EXT_STRINGS_SOFT_MAX = 60000;

/** Record tags. */
export const enum ExtTag {
	Wait = 0,
	String = 1,
	Keyframe = 2,
	View = 3,
	Afk = 4,
	Anchor = 5,
	Rig = 6,
	Pose = 7,
	Spawn = 8,
	Look = 9,
	Move = 10,
	Gone = 11,
	AnimPlay = 12,
	AnimStop = 13,
	AnimAdjust = 14,
	UiNode = 20,
	UiProps = 21,
	UiGone = 22,
}

/** UI field mask bits (UiNode / UiProps). */
export const enum UiField {
	Rect = 1,
	Rotation = 2,
	Order = 4,
	Background = 8,
	Text = 16,
	TextStyle = 32,
	Image = 64,
	ImageStyle = 128,
	ImageRect = 256,
	Stroke = 512,
	Corner = 1024,
	Parent = 2048,
	Clip = 4096,
	Gradient = 8192,
	/** UIGradient Transparency keypoints + Offset (0.7.3). */
	GradientAlpha = 16384,
	/** Wire only: a `u16` second mask follows (its bits are UiField values ÷ 65536: Group, TextScale). */
	More = 32768,
	/** CanvasGroup GroupTransparency + GroupColor3 (second mask bit 0, 0.7.3). */
	Group = 65536,
	/** Cumulative UIScale on a text node (second mask bit 1, 0.7.3). */
	TextScale = 131072,
}

/** The fields carried by the second mask (UiField.More). */
export const UI_FIELDS_MORE = UiField.Group | UiField.TextScale;
/** UIGradient keypoints recorded at most (colour and transparency each). */
export const UI_GRADIENT_KEYS = 20;

/** UI classes (UiNode `class`). */
export const enum UiClass {
	ScreenGui = 0,
	Frame = 1,
	TextLabel = 2,
	TextButton = 3,
	TextBox = 4,
	ImageLabel = 5,
	ImageButton = 6,
	ScrollingFrame = 7,
	ViewportFrame = 8,
	CanvasGroup = 9,
	VideoFrame = 10,
}

/** Rig kinds (Rig `rig`). */
export const enum RigKind {
	None = 0,
	R6 = 1,
	R15 = 2,
	Other = 3,
}

/** Look slots. */
export const enum LookSlot {
	Shirt = 1,
	Pants = 2,
	ShirtGraphic = 3,
	Face = 4,
}

/**
 * One UI node's field values, already quantized (what the recorder diffs and the writer writes). Strings are raw (the
 * writer turns them into segment string ids).
 */
export interface UiValues {
	x: number;
	y: number;
	w: number;
	h: number;
	/** AbsoluteRotation × 10. */
	rot: number;
	order: number;
	bgR: number;
	bgG: number;
	bgB: number;
	/** Transparency × 255. */
	bgT: number;
	text: string;
	tR: number;
	tG: number;
	tB: number;
	tT: number;
	tSize: number;
	family: string;
	weight: number;
	xAlign: number;
	yAlign: number;
	/** bit 0 scaled, bit 1 wrapped, bit 2 rich text. */
	tFlags: number;
	sT: number;
	sR: number;
	sG: number;
	sB: number;
	image: string;
	iR: number;
	iG: number;
	iB: number;
	iT: number;
	scaleType: number;
	ioX: number;
	ioY: number;
	isX: number;
	isY: number;
	sx0: number;
	sy0: number;
	sx1: number;
	sy1: number;
	kR: number;
	kG: number;
	kB: number;
	kT: number;
	/** Thickness × 4 (0 = no stroke). */
	kW: number;
	corner: number;
	parent: number;
	clip: number;
	/** Keypoints: 4 numbers each (time × 255, r, g, b); gradN of them. */
	grad: number[];
	gradN: number;
	/** Rotation in whole degrees. */
	gradRot: number;
	/** Transparency keypoints: 2 numbers each (time × 255, transparency × 255); gaN of them (0 = all opaque). */
	ga: number[];
	gaN: number;
	/** UIGradient.Offset × 1000. */
	gOffX: number;
	gOffY: number;
	/** CanvasGroup GroupTransparency × 255 and GroupColor3 (defaults 0 and white). */
	grT: number;
	grR: number;
	grG: number;
	grB: number;
	/** The product of every UIScale on the node and its GuiObject ancestors × 1000 (text nodes; default 1000). */
	tScale: number;
}

/** A UiValues with every field at its default (rotation 0, no stroke, corner or gradient). */
export function newUiValues(): UiValues {
	return {
		x: 0,
		y: 0,
		w: 0,
		h: 0,
		rot: 0,
		order: 0,
		bgR: 0,
		bgG: 0,
		bgB: 0,
		bgT: 255,
		text: "",
		tR: 0,
		tG: 0,
		tB: 0,
		tT: 0,
		tSize: 0,
		family: "",
		weight: 400,
		xAlign: 1,
		yAlign: 1,
		tFlags: 0,
		sT: 255,
		sR: 0,
		sG: 0,
		sB: 0,
		image: "",
		iR: 255,
		iG: 255,
		iB: 255,
		iT: 0,
		scaleType: 0,
		ioX: 0,
		ioY: 0,
		isX: 0,
		isY: 0,
		sx0: 0,
		sy0: 0,
		sx1: 0,
		sy1: 0,
		kR: 0,
		kG: 0,
		kB: 0,
		kT: 0,
		kW: 0,
		corner: 0,
		parent: EXT_NONE,
		clip: 0,
		grad: [],
		gradN: 0,
		gradRot: 0,
		ga: [],
		gaN: 0,
		gOffX: 0,
		gOffY: 0,
		grT: 0,
		grR: 255,
		grG: 255,
		grB: 255,
		tScale: 1000,
	};
}

const I16_MAX = 32767;
const TAU = math.pi * 2;
/** Move / Anchor positions: 1/8 stud. */
export const EXT_POSITION_SCALE = 8;
/** The farthest a Move position may be from the Anchor (studs). */
export const EXT_ANCHOR_RANGE = 4095;
const SQRT_HALF = 0.70710678;

function u8(value: number): number {
	return math.clamp(math.floor(value + 0.5), 0, 255);
}
function u16(value: number): number {
	return math.clamp(math.floor(value + 0.5), 0, 65535);
}
function i16(value: number): number {
	return math.clamp(math.floor(value + 0.5), -I16_MAX, I16_MAX);
}

/** Yaw (radians) as a byte, the tt-rec-1 way: `b / 256 * 2π - π`. */
export function yawByte(radians: number): number {
	return math.floor(((radians + math.pi) / TAU) * 256 + 0.5) % 256;
}

/** `text` cut to `max` bytes at a UTF-8 character boundary. */
export function cutUtf8(text: string, max: number): string {
	if (text.size() <= max) return text;
	let cut = max;
	// Back off continuation bytes (0x80-0xBF) so a character is never split.
	while (cut > 0) {
		const byte = string.byte(text, cut + 1)[0];
		if (byte === undefined || byte < 0x80 || byte >= 0xc0) break;
		cut -= 1;
	}
	return text.sub(1, cut);
}

/**
 * A rotation matrix (CFrame:GetComponents() R00..R22, row-major) as a unit quaternion x, y, z, w (any sign).
 */
export function quatOf(
	r00: number,
	r01: number,
	r02: number,
	r10: number,
	r11: number,
	r12: number,
	r20: number,
	r21: number,
	r22: number,
): LuaTuple<[number, number, number, number]> {
	const trace = r00 + r11 + r22;
	let x: number;
	let y: number;
	let z: number;
	let w: number;
	if (trace > 0) {
		const s = 0.5 / math.sqrt(trace + 1);
		w = 0.25 / s;
		x = (r21 - r12) * s;
		y = (r02 - r20) * s;
		z = (r10 - r01) * s;
	} else if (r00 > r11 && r00 > r22) {
		const s = 2 * math.sqrt(math.max(1 + r00 - r11 - r22, 1e-12));
		w = (r21 - r12) / s;
		x = 0.25 * s;
		y = (r01 + r10) / s;
		z = (r02 + r20) / s;
	} else if (r11 > r22) {
		const s = 2 * math.sqrt(math.max(1 + r11 - r00 - r22, 1e-12));
		w = (r02 - r20) / s;
		x = (r01 + r10) / s;
		y = 0.25 * s;
		z = (r12 + r21) / s;
	} else {
		const s = 2 * math.sqrt(math.max(1 + r22 - r00 - r11, 1e-12));
		w = (r10 - r01) / s;
		x = (r02 + r20) / s;
		y = (r12 + r21) / s;
		z = 0.25 * s;
	}
	const length = math.sqrt(x * x + y * y + z * z + w * w);
	if (length < 1e-9) return $tuple(0, 0, 0, 1);
	return $tuple(x / length, y / length, z / length, w / length);
}

function component(value: number): number {
	return math.clamp(math.floor(((value / SQRT_HALF + 1) / 2) * 1023 + 0.5), 0, 1023);
}

/**
 * Smallest-three: `idx | a << 2 | b << 12 | c << 22`, `idx` the dropped largest-magnitude component of (x, y, z, w)
 * (the quaternion's sign flipped so it is positive), `a, b, c` the other three in order, 10 bits each.
 */
export function packQuat(x: number, y: number, z: number, w: number): number {
	const ax = math.abs(x);
	const ay = math.abs(y);
	const az = math.abs(z);
	const aw = math.abs(w);
	let idx = 0;
	let largest = ax;
	if (ay > largest) {
		idx = 1;
		largest = ay;
	}
	if (az > largest) {
		idx = 2;
		largest = az;
	}
	if (aw > largest) idx = 3;
	const dropped = idx === 0 ? x : idx === 1 ? y : idx === 2 ? z : w;
	const sign = dropped < 0 ? -1 : 1;
	let a: number;
	let b: number;
	let c: number;
	if (idx === 0) {
		a = y;
		b = z;
		c = w;
	} else if (idx === 1) {
		a = x;
		b = z;
		c = w;
	} else if (idx === 2) {
		a = x;
		b = y;
		c = w;
	} else {
		a = x;
		b = y;
		c = z;
	}
	return idx + component(a * sign) * 4 + component(b * sign) * 4096 + component(c * sign) * 4194304;
}

/** The quaternion x, y, z, w of a packed smallest-three value (the dropped component positive). */
export function unpackQuat(packed: number): LuaTuple<[number, number, number, number]> {
	const idx = packed % 4;
	const read = (bits: number) => ((bits / 1023) * 2 - 1) * SQRT_HALF;
	const a = read(math.floor(packed / 4) % 1024);
	const b = read(math.floor(packed / 4096) % 1024);
	const c = read(math.floor(packed / 4194304) % 1024);
	const d = math.sqrt(math.max(0, 1 - a * a - b * b - c * c));
	if (idx === 0) return $tuple(d, a, b, c);
	if (idx === 1) return $tuple(a, d, b, c);
	if (idx === 2) return $tuple(a, b, d, c);
	return $tuple(a, b, c, d);
}

/** The u16 mask on the wire for an internal mask (bit 15 set when any second-mask field is in it). */
export function uiWireMask(mask: number): number {
	return (mask % UiField.More) + ((mask & UI_FIELDS_MORE) !== 0 ? UiField.More : 0);
}

/** Payload bytes of the UI fields in `mask` for these values. */
export function uiFieldsSize(mask: number, v: UiValues): number {
	let size = 0;
	if ((mask & UiField.Rect) !== 0) size += 8;
	if ((mask & UiField.Rotation) !== 0) size += 2;
	if ((mask & UiField.Order) !== 0) size += 2;
	if ((mask & UiField.Background) !== 0) size += 4;
	if ((mask & UiField.Text) !== 0) size += 2;
	if ((mask & UiField.TextStyle) !== 0) size += 16;
	if ((mask & UiField.Image) !== 0) size += 2;
	if ((mask & UiField.ImageStyle) !== 0) size += 5;
	if ((mask & UiField.ImageRect) !== 0) size += 16;
	if ((mask & UiField.Stroke) !== 0) size += 5;
	if ((mask & UiField.Corner) !== 0) size += 1;
	if ((mask & UiField.Parent) !== 0) size += 2;
	if ((mask & UiField.Clip) !== 0) size += 1;
	if ((mask & UiField.Gradient) !== 0) size += 3 + v.gradN * 4;
	if ((mask & UiField.GradientAlpha) !== 0) size += 5 + v.gaN * 2;
	if ((mask & UI_FIELDS_MORE) !== 0) {
		size += 2;
		if ((mask & UiField.Group) !== 0) size += 4;
		if ((mask & UiField.TextScale) !== 0) size += 2;
	}
	return size;
}

/**
 * Packs tt-ext-1 chunks. One writer serves a whole recording: `take()` returns the finished chunk and starts the next
 * one in the same buffer (no allocation but the returned copy); the string table belongs to the segment, so it
 * survives `take()` and is cleared by `keyframe()`. Times are ms since the chunk started and never go backwards.
 */
export class ExtWriter {
	private data: buffer;
	private used = EXT_HEADER_BYTES;
	private lastMs = 0;
	private readonly strings = new Map<string, number>();
	private stringCount = 0;
	/** String ids of the record being built (Rig names, Look slots). */
	private readonly scratch = new Array<number>();
	/** The chunk's first record is a Keyframe (header flag bit 1). */
	private startsWithKeyframe = false;
	/** The Anchor this segment's Move positions are relative to (what f32 kept), undefined before the first. */
	anchorX = 0;
	anchorY = 0;
	anchorZ = 0;
	hasAnchor = false;
	/** Records in the current chunk (the row's `n`). */
	records = 0;

	constructor(capacity = 32768) {
		this.data = buffer.create(capacity);
	}

	/** Bytes in the current chunk, header included. */
	size(): number {
		return this.used;
	}

	/** Strings defined in this segment. */
	segmentStrings(): number {
		return this.stringCount;
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

	/** Writes a record head (Wait records first for a gap over 65535 ms) and makes room for the payload. */
	begin(tag: ExtTag, atMs: number, length: number) {
		let delta = math.max(0, math.floor(atMs) - this.lastMs);
		while (delta > 65535) {
			this.ensure(EXT_RECORD_HEAD);
			buffer.writeu8(this.data, this.used, ExtTag.Wait);
			buffer.writeu16(this.data, this.used + 1, 65535);
			buffer.writeu16(this.data, this.used + 3, 0);
			this.used += EXT_RECORD_HEAD;
			this.lastMs += 65535;
			this.records += 1;
			delta -= 65535;
		}
		this.ensure(EXT_RECORD_HEAD + length);
		if (this.records === 0 && tag === ExtTag.Keyframe) this.startsWithKeyframe = true;
		buffer.writeu8(this.data, this.used, tag);
		buffer.writeu16(this.data, this.used + 1, delta);
		buffer.writeu16(this.data, this.used + 3, length);
		this.used += EXT_RECORD_HEAD;
		this.lastMs += delta;
		this.records += 1;
	}

	u8(value: number) {
		buffer.writeu8(this.data, this.used, u8(value));
		this.used += 1;
	}
	u16(value: number) {
		buffer.writeu16(this.data, this.used, u16(value));
		this.used += 2;
	}
	i16(value: number) {
		buffer.writei16(this.data, this.used, i16(value));
		this.used += 2;
	}
	u32(value: number) {
		buffer.writeu32(this.data, this.used, math.clamp(math.floor(value), 0, 4294967295));
		this.used += 4;
	}
	f32(value: number) {
		buffer.writef32(this.data, this.used, value);
		this.used += 4;
	}

	/** The segment id of `text` (cut to EXT_STRING_MAX bytes), defining it first if new. EXT_NONE when the table is full. */
	stringId(atMs: number, text: string): number {
		const value = cutUtf8(text, EXT_STRING_MAX);
		const known = this.strings.get(value);
		if (known !== undefined) return known;
		const id = this.stringCount;
		if (id >= EXT_NONE) return EXT_NONE;
		this.begin(ExtTag.String, atMs, 2 + value.size());
		buffer.writeu16(this.data, this.used, id);
		buffer.writestring(this.data, this.used + 2, value);
		this.used += 2 + value.size();
		this.strings.set(value, id);
		this.stringCount += 1;
		return id;
	}

	/** A Keyframe: a new segment (string table and anchor cleared). The full state must follow. */
	keyframe(atMs: number) {
		this.strings.clear();
		this.stringCount = 0;
		this.hasAnchor = false;
		this.begin(ExtTag.Keyframe, atMs, 2);
		this.u16(0);
	}

	view(atMs: number, w: number, h: number, inset: number, fov: number, fps: number) {
		this.begin(ExtTag.View, atMs, 8);
		this.u16(w);
		this.u16(h);
		this.u16(inset);
		this.u8(fov);
		this.u8(fps);
	}

	afk(atMs: number, afk: boolean) {
		this.begin(ExtTag.Afk, atMs, 1);
		this.u8(afk ? 1 : 0);
	}

	anchor(atMs: number, x: number, y: number, z: number) {
		this.begin(ExtTag.Anchor, atMs, 12);
		const at = this.used;
		this.f32(x);
		this.f32(y);
		this.f32(z);
		// What f32 kept, so offsets match what a reader decodes.
		this.anchorX = buffer.readf32(this.data, at);
		this.anchorY = buffer.readf32(this.data, at + 4);
		this.anchorZ = buffer.readf32(this.data, at + 8);
		this.hasAnchor = true;
	}

	/** Whether (x, y, z) can be written relative to the current Anchor. */
	fits(x: number, y: number, z: number): boolean {
		return (
			this.hasAnchor &&
			math.abs(x - this.anchorX) <= EXT_ANCHOR_RANGE &&
			math.abs(y - this.anchorY) <= EXT_ANCHOR_RANGE &&
			math.abs(z - this.anchorZ) <= EXT_ANCHOR_RANGE
		);
	}

	/** `names` are the Motor6D names in the order Pose bits use (at most 32). */
	rig(atMs: number, entity: number, kind: RigKind, names: string[], count: number) {
		const n = math.min(count, 32);
		// Strings first: a record's string ids are defined before it.
		const ids = this.scratch;
		for (let index = 0; index < n; index++) ids[index] = this.stringId(atMs, names[index]);
		this.begin(ExtTag.Rig, atMs, 3 + n * 2);
		this.u8(entity);
		this.u8(kind);
		this.u8(n);
		for (let index = 0; index < n; index++) this.u16(ids[index]);
	}

	/** `packed[i]` for every set bit of `mask`, in bit order (`count` of them). */
	pose(atMs: number, entity: number, mask: number, packed: number[], count: number) {
		this.begin(ExtTag.Pose, atMs, 5 + count * 4);
		this.u8(entity);
		this.u32(mask);
		for (let index = 0; index < count; index++) this.u32(packed[index]);
	}

	/** `flags`: bit 0 has a Humanoid, bit 1 another player's character. Size in studs (written at 1/8 stud). */
	spawn(atMs: number, entity: number, kind: string, flags: number, x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number) {
		const kindId = this.stringId(atMs, kind);
		this.begin(ExtTag.Spawn, atMs, 23);
		this.u8(entity);
		this.u16(kindId);
		this.u8(flags);
		this.f32(x);
		this.f32(y);
		this.f32(z);
		this.u8(yawByte(yaw));
		this.u16(sx * EXT_POSITION_SCALE);
		this.u16(sy * EXT_POSITION_SCALE);
		this.u16(sz * EXT_POSITION_SCALE);
	}

	/**
	 * `colors`: 18 bytes (RGB of head, torso, left arm, right arm, left leg, right leg) or undefined; `slots` / `texts`:
	 * `count` pairs (LookSlot, string).
	 */
	look(atMs: number, entity: number, colors: number[] | undefined, slots: number[], texts: string[], count: number) {
		const ids = this.scratch;
		for (let index = 0; index < count; index++) ids[index] = this.stringId(atMs, texts[index]);
		this.begin(ExtTag.Look, atMs, 3 + (colors ? 18 : 0) + count * 3);
		this.u8(entity);
		this.u8(colors ? 1 : 0);
		if (colors) for (let index = 0; index < 18; index++) this.u8(colors[index]);
		this.u8(count);
		for (let index = 0; index < count; index++) {
			this.u8(slots[index]);
			this.u16(ids[index]);
		}
	}

	/** Starts a Move record of `count` entries (then `moveEntry` × count). Positions must `fits()` the Anchor. */
	moveBegin(atMs: number, count: number) {
		this.begin(ExtTag.Move, atMs, 1 + count * 8);
		this.u8(count);
	}

	moveEntry(entity: number, x: number, y: number, z: number, yaw: number) {
		this.u8(entity);
		this.i16((x - this.anchorX) * EXT_POSITION_SCALE);
		this.i16((y - this.anchorY) * EXT_POSITION_SCALE);
		this.i16((z - this.anchorZ) * EXT_POSITION_SCALE);
		this.u8(yawByte(yaw));
	}

	gone(atMs: number, entity: number) {
		this.begin(ExtTag.Gone, atMs, 1);
		this.u8(entity);
	}

	animPlay(atMs: number, entity: number, track: number, animation: string, speed: number, weight: number, looped: boolean, timePosition: number) {
		const id = this.stringId(atMs, animation);
		this.begin(ExtTag.AnimPlay, atMs, 11);
		this.u8(entity);
		this.u16(track);
		this.u16(id);
		this.i16(speed * 100);
		this.u8(math.clamp(weight, 0, 1) * 255);
		this.u8(looped ? 1 : 0);
		this.u16(timePosition * 100);
	}

	animStop(atMs: number, entity: number, track: number) {
		this.begin(ExtTag.AnimStop, atMs, 3);
		this.u8(entity);
		this.u16(track);
	}

	animAdjust(atMs: number, entity: number, track: number, speed: number, weight: number) {
		this.begin(ExtTag.AnimAdjust, atMs, 6);
		this.u8(entity);
		this.u16(track);
		this.i16(speed * 100);
		this.u8(math.clamp(weight, 0, 1) * 255);
	}

	/** The UI fields of `mask` in bit order (string ids already resolved into `ids`: text, family, image). */
	private uiFields(mask: number, v: UiValues, textId: number, familyId: number, imageId: number) {
		if ((mask & UiField.Rect) !== 0) {
			this.i16(v.x);
			this.i16(v.y);
			this.u16(v.w);
			this.u16(v.h);
		}
		if ((mask & UiField.Rotation) !== 0) this.i16(v.rot);
		if ((mask & UiField.Order) !== 0) this.u16(v.order);
		if ((mask & UiField.Background) !== 0) {
			this.u8(v.bgR);
			this.u8(v.bgG);
			this.u8(v.bgB);
			this.u8(v.bgT);
		}
		if ((mask & UiField.Text) !== 0) this.u16(textId);
		if ((mask & UiField.TextStyle) !== 0) {
			this.u8(v.tR);
			this.u8(v.tG);
			this.u8(v.tB);
			this.u8(v.tT);
			this.u8(v.tSize);
			this.u16(familyId);
			this.u16(v.weight);
			this.u8(v.xAlign);
			this.u8(v.yAlign);
			this.u8(v.tFlags);
			this.u8(v.sT);
			this.u8(v.sR);
			this.u8(v.sG);
			this.u8(v.sB);
		}
		if ((mask & UiField.Image) !== 0) this.u16(imageId);
		if ((mask & UiField.ImageStyle) !== 0) {
			this.u8(v.iR);
			this.u8(v.iG);
			this.u8(v.iB);
			this.u8(v.iT);
			this.u8(v.scaleType);
		}
		if ((mask & UiField.ImageRect) !== 0) {
			this.u16(v.ioX);
			this.u16(v.ioY);
			this.u16(v.isX);
			this.u16(v.isY);
			this.u16(v.sx0);
			this.u16(v.sy0);
			this.u16(v.sx1);
			this.u16(v.sy1);
		}
		if ((mask & UiField.Stroke) !== 0) {
			this.u8(v.kR);
			this.u8(v.kG);
			this.u8(v.kB);
			this.u8(v.kT);
			this.u8(v.kW);
		}
		if ((mask & UiField.Corner) !== 0) this.u8(v.corner);
		if ((mask & UiField.Parent) !== 0) this.u16(v.parent);
		if ((mask & UiField.Clip) !== 0) this.u8(v.clip);
		if ((mask & UiField.Gradient) !== 0) {
			this.u8(v.gradN);
			const grad = v.grad;
			for (let index = 0; index < v.gradN * 4; index++) this.u8(grad[index]);
			this.i16(v.gradRot);
		}
		if ((mask & UiField.GradientAlpha) !== 0) {
			this.u8(v.gaN);
			const ga = v.ga;
			for (let index = 0; index < v.gaN * 2; index++) this.u8(ga[index]);
			this.i16(v.gOffX);
			this.i16(v.gOffY);
		}
		if ((mask & UI_FIELDS_MORE) !== 0) {
			this.u16(math.floor(mask / 65536));
			if ((mask & UiField.Group) !== 0) {
				this.u8(v.grT);
				this.u8(v.grR);
				this.u8(v.grG);
				this.u8(v.grB);
			}
			if ((mask & UiField.TextScale) !== 0) this.u16(v.tScale);
		}
	}

	private uiStrings(atMs: number, mask: number, v: UiValues): LuaTuple<[number, number, number]> {
		const textId = (mask & UiField.Text) !== 0 ? this.stringId(atMs, v.text) : EXT_NONE;
		const familyId = (mask & UiField.TextStyle) !== 0 ? this.stringId(atMs, v.family) : EXT_NONE;
		const imageId = (mask & UiField.Image) !== 0 ? this.stringId(atMs, v.image) : EXT_NONE;
		return $tuple(textId, familyId, imageId);
	}

	/** A node becomes visible (or is re-sent after a Keyframe). `parent` EXT_NONE for a ScreenGui. Parent bit is ignored. */
	uiNode(atMs: number, id: number, parent: number, cls: number, mask: number, v: UiValues) {
		const fields = mask - (mask & UiField.Parent);
		const [textId, familyId, imageId] = this.uiStrings(atMs, fields, v);
		this.begin(ExtTag.UiNode, atMs, 7 + uiFieldsSize(fields, v));
		this.u16(id);
		this.u16(parent);
		this.u8(cls);
		this.u16(uiWireMask(fields));
		this.uiFields(fields, v, textId, familyId, imageId);
	}

	uiProps(atMs: number, id: number, mask: number, v: UiValues) {
		const [textId, familyId, imageId] = this.uiStrings(atMs, mask, v);
		this.begin(ExtTag.UiProps, atMs, 4 + uiFieldsSize(mask, v));
		this.u16(id);
		this.u16(uiWireMask(mask));
		this.uiFields(mask, v, textId, familyId, imageId);
	}

	uiGone(atMs: number, id: number) {
		this.begin(ExtTag.UiGone, atMs, 2);
		this.u16(id);
	}

	/**
	 * The finished chunk (a copy of its bytes, header flags set) and a fresh chunk in the same buffer. `last`: the
	 * recording ends with this chunk (flag bit 0). The string table and Anchor carry on (same segment).
	 */
	take(last: boolean): buffer {
		buffer.writeu8(this.data, 0, EXT_VERSION);
		buffer.writeu8(this.data, 1, (last ? 1 : 0) + (this.startsWithKeyframe ? 2 : 0));
		buffer.writeu16(this.data, 2, 0);
		const out = buffer.create(this.used);
		buffer.copy(out, 0, this.data, 0, this.used);
		this.used = EXT_HEADER_BYTES;
		this.lastMs = 0;
		this.records = 0;
		this.startsWithKeyframe = false;
		return out;
	}
}

// Decoding (tests, and the reference for readers in other languages) ---------------------------------------------------

/** One decoded record: `tag`, `at` (ms since the chunk start) and the fields of its tag (names as in SCHEMA.md). */
export type DecodedExtRecord = { tag: number; at: number; length: number } & Record<string, unknown>;

export interface DecodedExtChunk {
	version: number;
	last: boolean;
	keyframe: boolean;
	records: DecodedExtRecord[];
}

/** What a reader carries from chunk to chunk within a segment: the string table and the Anchor. */
export interface ExtDecodeState {
	strings: Map<number, string>;
	anchor: [number, number, number];
}

export function newExtDecodeState(): ExtDecodeState {
	return { strings: new Map(), anchor: [0, 0, 0] };
}

function unwrapYaw(byte: number): number {
	return (byte / 256) * TAU - math.pi;
}

/**
 * Reads the UI fields of a wire `mask`. Returns where they end, or -1 when the mask names fields this decoder doesn't
 * know (a newer recorder's trailing bits): the caller skips the rest of the record by its length.
 */
function readUiFields(data: buffer, start: number, mask: number, strings: Map<number, string>, out: Record<string, unknown>): number {
	let at = start;
	const r8 = () => {
		const value = buffer.readu8(data, at);
		at += 1;
		return value;
	};
	const r16 = () => {
		const value = buffer.readu16(data, at);
		at += 2;
		return value;
	};
	const ri16 = () => {
		const value = buffer.readi16(data, at);
		at += 2;
		return value;
	};
	const str = (id: number) => (id === EXT_NONE ? undefined : strings.get(id));
	if ((mask & UiField.Rect) !== 0) out.rect = [ri16(), ri16(), r16(), r16()];
	if ((mask & UiField.Rotation) !== 0) out.rotation = ri16() / 10;
	if ((mask & UiField.Order) !== 0) out.order = r16();
	if ((mask & UiField.Background) !== 0) out.background = [r8(), r8(), r8(), r8()];
	if ((mask & UiField.Text) !== 0) out.text = str(r16());
	if ((mask & UiField.TextStyle) !== 0) {
		out.textColor = [r8(), r8(), r8(), r8()];
		out.textSize = r8();
		out.family = str(r16());
		out.weight = r16();
		out.xAlign = r8();
		out.yAlign = r8();
		out.textFlags = r8();
		out.stroke = [r8(), r8(), r8(), r8()];
	}
	if ((mask & UiField.Image) !== 0) out.image = str(r16());
	if ((mask & UiField.ImageStyle) !== 0) {
		out.imageColor = [r8(), r8(), r8(), r8()];
		out.scaleType = r8();
	}
	if ((mask & UiField.ImageRect) !== 0) {
		out.imageRect = [r16(), r16(), r16(), r16()];
		out.slice = [r16(), r16(), r16(), r16()];
	}
	if ((mask & UiField.Stroke) !== 0) out.border = [r8(), r8(), r8(), r8(), r8() / 4];
	if ((mask & UiField.Corner) !== 0) out.corner = r8();
	if ((mask & UiField.Parent) !== 0) out.parent = r16();
	if ((mask & UiField.Clip) !== 0) out.clip = r8();
	if ((mask & UiField.Gradient) !== 0) {
		const n = r8();
		const keys = new Array<number[]>();
		for (let index = 0; index < n; index++) keys.push([r8() / 255, r8(), r8(), r8()]);
		out.gradient = keys;
		out.gradientRotation = ri16();
	}
	if ((mask & UiField.GradientAlpha) !== 0) {
		const n = r8();
		const keys = new Array<number[]>();
		for (let index = 0; index < n; index++) keys.push([r8() / 255, r8() / 255]);
		out.gradientAlpha = keys;
		out.gradientOffset = [ri16() / 1000, ri16() / 1000];
	}
	if ((mask & UiField.More) !== 0) {
		const more = r16();
		out.more = more;
		if ((more & 1) !== 0) out.group = [r8(), r8(), r8(), r8()];
		if ((more & 2) !== 0) out.textScale = r16() / 1000;
		// Second-mask bits this decoder doesn't know: newer fields at the end, skipped by the record's length.
		if (more >= 4) return -1;
	}
	return at;
}

/**
 * Decodes one tt-ext-1 chunk with the segment state carried from the previous chunk (a Keyframe clears it). Positions
 * come back absolute (studs), angles in radians, strings resolved. Throws on a malformed chunk or a record whose
 * payload doesn't match its length.
 */
export function decodeExtChunk(data: buffer, state: ExtDecodeState = newExtDecodeState()): DecodedExtChunk {
	const size = buffer.len(data);
	assert(size >= EXT_HEADER_BYTES, "chunk too short");
	const version = buffer.readu8(data, 0);
	assert(version === EXT_VERSION, `unknown tt-ext version ${version}`);
	const flags = buffer.readu8(data, 1);
	const result: DecodedExtChunk = { version, last: (flags & 1) === 1, keyframe: (flags & 2) === 2, records: [] };
	const strings = state.strings;
	let at = 0;
	let offset = EXT_HEADER_BYTES;
	while (offset < size) {
		assert(offset + EXT_RECORD_HEAD <= size, "record head runs past the end");
		const tag = buffer.readu8(data, offset);
		at += buffer.readu16(data, offset + 1);
		const length = buffer.readu16(data, offset + 3);
		const start = offset + EXT_RECORD_HEAD;
		const finish = start + length;
		assert(finish <= size, "record runs past the end of the chunk");
		const record: DecodedExtRecord = { tag, at, length };
		let p = start;
		const r8 = () => {
			const value = buffer.readu8(data, p);
			p += 1;
			return value;
		};
		const r16 = () => {
			const value = buffer.readu16(data, p);
			p += 2;
			return value;
		};
		const ri16 = () => {
			const value = buffer.readi16(data, p);
			p += 2;
			return value;
		};
		const r32 = () => {
			const value = buffer.readu32(data, p);
			p += 4;
			return value;
		};
		const rf32 = () => {
			const value = buffer.readf32(data, p);
			p += 4;
			return value;
		};
		const str = (id: number) => (id === EXT_NONE ? undefined : strings.get(id));
		if (tag === ExtTag.Wait) {
			// time only
		} else if (tag === ExtTag.String) {
			const id = r16();
			const text = buffer.readstring(data, p, finish - p);
			p = finish;
			strings.set(id, text);
			record.id = id;
			record.text = text;
		} else if (tag === ExtTag.Keyframe) {
			strings.clear();
			state.anchor = [0, 0, 0];
			record.reserved = r16();
		} else if (tag === ExtTag.View) {
			record.w = r16();
			record.h = r16();
			record.inset = r16();
			record.fov = r8();
			record.fps = r8();
		} else if (tag === ExtTag.Afk) {
			record.afk = r8() === 1;
		} else if (tag === ExtTag.Anchor) {
			state.anchor = [rf32(), rf32(), rf32()];
			record.position = [...state.anchor];
		} else if (tag === ExtTag.Rig) {
			record.entity = r8();
			record.rig = r8();
			const n = r8();
			const names = new Array<string>();
			for (let index = 0; index < n; index++) names.push(str(r16()) ?? "?");
			record.names = names;
		} else if (tag === ExtTag.Pose) {
			record.entity = r8();
			const mask = r32();
			record.mask = mask;
			const joints = new Array<[number, number, number, number, number]>();
			for (let bit = 0; bit < 32; bit++) {
				if (bit32.btest(mask, bit32.lshift(1, bit))) {
					const [x, y, z, w] = unpackQuat(r32());
					joints.push([bit, x, y, z, w]);
				}
			}
			record.joints = joints;
		} else if (tag === ExtTag.Spawn) {
			record.entity = r8();
			record.kind = str(r16());
			record.flags = r8();
			record.position = [rf32(), rf32(), rf32()];
			record.yaw = unwrapYaw(r8());
			record.size = [r16() / EXT_POSITION_SCALE, r16() / EXT_POSITION_SCALE, r16() / EXT_POSITION_SCALE];
		} else if (tag === ExtTag.Look) {
			record.entity = r8();
			const lookFlags = r8();
			if ((lookFlags & 1) === 1) {
				const colors = new Array<number>();
				for (let index = 0; index < 18; index++) colors.push(r8());
				record.colors = colors;
			}
			const n = r8();
			const slots = new Array<[number, string | undefined]>();
			for (let index = 0; index < n; index++) {
				const slot = r8();
				slots.push([slot, str(r16())]);
			}
			record.slots = slots;
		} else if (tag === ExtTag.Move) {
			const count = r8();
			const moves = new Array<[number, number, number, number, number]>();
			const [ax, ay, az] = state.anchor;
			for (let index = 0; index < count; index++) {
				const entity = r8();
				moves.push([entity, ax + ri16() / EXT_POSITION_SCALE, ay + ri16() / EXT_POSITION_SCALE, az + ri16() / EXT_POSITION_SCALE, unwrapYaw(r8())]);
			}
			record.moves = moves;
		} else if (tag === ExtTag.Gone) {
			record.entity = r8();
		} else if (tag === ExtTag.AnimPlay) {
			record.entity = r8();
			record.track = r16();
			record.animation = str(r16());
			record.speed = ri16() / 100;
			record.weight = r8() / 255;
			record.looped = (r8() & 1) === 1;
			record.time = r16() / 100;
		} else if (tag === ExtTag.AnimStop) {
			record.entity = r8();
			record.track = r16();
		} else if (tag === ExtTag.AnimAdjust) {
			record.entity = r8();
			record.track = r16();
			record.speed = ri16() / 100;
			record.weight = r8() / 255;
		} else if (tag === ExtTag.UiNode) {
			record.id = r16();
			record.parent = r16();
			record.class = r8();
			const mask = r16();
			record.mask = mask;
			p = readUiFields(data, p, mask, strings, record);
			if (p < 0) p = finish;
		} else if (tag === ExtTag.UiProps) {
			record.id = r16();
			const mask = r16();
			record.mask = mask;
			p = readUiFields(data, p, mask, strings, record);
			if (p < 0) p = finish;
		} else if (tag === ExtTag.UiGone) {
			record.id = r16();
		} else {
			// Unknown tag: skipped by its length.
			p = finish;
			record.unknown = true;
		}
		assert(p === finish, `record tag ${tag} at byte ${offset}: payload ${p - start} bytes, length says ${length}`);
		offset = finish;
		result.records.push(record);
	}
	return result;
}
