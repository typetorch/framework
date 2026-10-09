/**
 * Client <-> server messages of the analytics engine, on one raw channel of the kernel's stable remote (no generated
 * guards in the framework itself, so the server checks every field here). Clients never talk to the internet.
 *
 *   client -> server  "hello", HelloInfo                       the client engine runs (device, input, load time)
 *                     "ev", ClientEvent[]                       a batch of events (at most CLIENT_BATCH_MAX)
 *                     "exp", name, variants                     the client evaluated an experiment
 *                     "rec", chunk, ageMs, n, data, last, why   one tt-rec-1 chunk of the first-session recording
 *   server -> client  "hi", ServerHello                         pid, recording on/off, tech interval, experiments
 *
 * Event times travel as ages (ms before the send) and the server subtracts them from its own clock, so client clocks
 * never matter.
 */

import type { DeviceKind, ExperimentOverride } from "./schema";

export const CHANNEL = "__tt/an";

/** Events per "ev" message, and the most bytes a client batch should carry. */
export const CLIENT_BATCH_MAX = 50;
export const CLIENT_BATCH_BYTES = 12000;
/** A recording chunk is sent at about this size or every CHUNK_SECONDS. */
export const CHUNK_TARGET_BYTES = 6000;
export const CHUNK_MAX_BYTES = 16384;
export const CHUNK_SECONDS = 10;

export interface HelloInfo {
	dev: DeviceKind;
	/** "kbm" | "touch" | "gamepad" | "vr" | "unknown": the last input type. */
	input: string;
	/** Viewport size (points). */
	w: number;
	h: number;
	touch: boolean;
	kb: boolean;
	mouse: boolean;
	pad: boolean;
	vr: boolean;
	/** Seconds from the client starting to the engine starting (first client generation only). */
	load?: number;
}

/** What the client knows about its device when it says hello (UserInputService, VRService, GuiService, the camera). */
export interface DeviceFacts {
	vr: boolean;
	/** GuiService:IsTenFootInterface(): a console (Xbox, PlayStation). */
	tenFoot: boolean;
	touch: boolean;
	keyboard: boolean;
	mouse: boolean;
	/** Viewport size in points (0 when the camera has none yet). */
	w: number;
	h: number;
}

/** A touch-only device whose viewport's short side is at least this many points is a tablet, else a phone. */
export const TABLET_MIN_SHORT_SIDE = 600;

/**
 * The session's device class (the `dev` column), in this order: VR headset; console (ten-foot interface); touch without
 * a keyboard: tablet when the viewport's short side is 600 points or more, else phone (also when the viewport isn't
 * known); a keyboard or mouse: desktop (a touch laptop or a tablet with a keyboard counts here); else unknown. Roblox
 * gives game scripts no OS, so this is the closest a game gets.
 */
export function deviceClass(f: DeviceFacts): DeviceKind {
	if (f.vr) return "vr";
	if (f.tenFoot) return "console";
	if (f.touch && !f.keyboard) return math.min(f.w, f.h) >= TABLET_MIN_SHORT_SIDE ? "tablet" : "phone";
	if (f.keyboard || f.mouse) return "desktop";
	return "unknown";
}

/** [ageMs, kind, name, propsJson] */
export type ClientEvent = [age: number, kind: string, name: string, props: string];

export interface ServerHello {
	pid: string;
	newp: boolean;
	/** Record this session now (first-ever session, in the share, recordings configured). */
	rec: boolean;
	/** Seconds between tech samples. */
	tech: number;
	/** Live experiment overrides by name. */
	exps: Record<string, ExperimentOverride>;
}

const DEVICES = new Set<string>(["desktop", "phone", "tablet", "console", "vr", "unknown"]);
const INPUTS = new Set<string>(["kbm", "touch", "gamepad", "vr", "unknown"]);
/**
 * Kinds a client may send in "ev". Never `purchase` or `currency`: revenue and the economy are server-authoritative
 * (a client could otherwise add fake payers and Robux), so the server refuses them from clients.
 */
export const CLIENT_KINDS = new Set<string>(["custom", "funnel", "state", "tech"]);

function finite(value: unknown, low: number, high: number): value is number {
	return typeIs(value, "number") && value === value && value >= low && value <= high;
}

/** A client's hello, checked field by field (it comes from an untrusted client). */
export function cleanHello(value: unknown): HelloInfo | undefined {
	if (!typeIs(value, "table")) return undefined;
	const raw = value as Record<string, unknown>;
	const dev = typeIs(raw.dev, "string") && DEVICES.has(raw.dev) ? (raw.dev as DeviceKind) : "unknown";
	const input = typeIs(raw.input, "string") && INPUTS.has(raw.input) ? raw.input : "unknown";
	return {
		dev,
		input,
		w: finite(raw.w, 0, 16384) ? math.floor(raw.w) : 0,
		h: finite(raw.h, 0, 16384) ? math.floor(raw.h) : 0,
		touch: raw.touch === true,
		kb: raw.kb === true,
		mouse: raw.mouse === true,
		pad: raw.pad === true,
		vr: raw.vr === true,
		load: finite(raw.load, 0, 3600) ? math.floor(raw.load * 10) / 10 : undefined,
	};
}

/** A valid event or state name: 1-64 chars, no control characters. */
export function isEventName(value: unknown): value is string {
	return typeIs(value, "string") && value.size() >= 1 && value.size() <= 64 && value.find("%c")[0] === undefined;
}

/** One client event, or undefined when any field is off. `props` must still be decoded by the caller. */
export function cleanClientEvent(value: unknown): ClientEvent | undefined {
	if (!typeIs(value, "table")) return undefined;
	const [age, kind, name, props] = value as [unknown, unknown, unknown, unknown];
	if (!finite(age, 0, 600000)) return undefined;
	if (!typeIs(kind, "string") || !CLIENT_KINDS.has(kind)) return undefined;
	if (!isEventName(name)) return undefined;
	if (!typeIs(props, "string") || props.size() < 2 || props.size() > 4096 || props.sub(1, 1) !== "{") return undefined;
	return [math.floor(age), kind, name, props];
}
