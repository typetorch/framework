/**
 * The pure half of `TypeTorch.feedback()` (plans/32): the config check, text sanitising, rating normalisation, the rate
 * window and the row's props. No services, so scripts/test-feedback.luau runs it under Lune as is.
 */
import type { FeedbackInput, FeedbackRefusal, FeedbackScale, FeedbackScaleType } from "./api";

/** Most UTF-8 bytes of `text` on a row (the props cap is 4096). */
export const TEXT_MAX_BYTES = 2000;
/** Raw text past this many bytes is not looked at (only its length counts for `len`). */
export const TEXT_SCAN_BYTES = 16384;
/** Most keys of `ctx`. */
export const CTX_MAX_KEYS = 8;
/** Most characters of a `ctx` string value. */
export const CTX_TEXT_MAX = 64;
const DAY_SECONDS = 86400;
const MINUTE_SECONDS = 60;
/** Most remembered submits per player (bounds the per-day window's memory). */
const RATE_LIMIT_MAX = 1000;

/** A checked config: every field set. */
export interface ResolvedFeedbackConfig {
	readonly enabled: boolean;
	readonly scale: Required<Pick<FeedbackScale, "id" | "type" | "steps">> & { readonly labels?: ReadonlyArray<string> };
	readonly maxText: number;
	readonly perMinute: number;
	readonly perDay: number;
}

export const FEEDBACK_DEFAULTS: ResolvedFeedbackConfig = {
	enabled: true,
	scale: { id: "stars5", type: "stars", steps: 5 },
	maxText: 1000,
	perMinute: 2,
	perDay: 20,
};

const SCALE_TYPES = new Set<string>(["thumbs", "stars", "scale"]);

function isInteger(value: unknown): value is number {
	return typeIs(value, "number") && value === value && value % 1 === 0 && value > -math.huge && value < math.huge;
}

function isName(value: unknown, maxLength: number): value is string {
	return typeIs(value, "string") && value.size() >= 1 && value.size() <= maxLength && value.match("^[a-z0-9_]+$")[0] !== undefined;
}

function intIn(raw: unknown, name: string, low: number, high: number, fallback: number): number {
	if (raw === undefined) return fallback;
	if (!isInteger(raw) || raw < low || raw > high) error(`${name} must be an integer ${low}..${high}`, 0);
	return raw;
}

/**
 * The config with the defaults applied, or an error message (thrown by `configure`, warned for the settings record).
 * `false` (or `{ enabled: false }`) switches feedback off.
 */
export function resolveFeedbackConfig(raw: unknown): ResolvedFeedbackConfig {
	if (raw === undefined) return FEEDBACK_DEFAULTS;
	if (raw === false) return { ...FEEDBACK_DEFAULTS, enabled: false };
	if (!typeIs(raw, "table")) error("feedback config must be an object", 0);
	const config = raw as Record<string, unknown>;
	if (config.enabled !== undefined && !typeIs(config.enabled, "boolean")) error("feedback.enabled must be a boolean", 0);
	const maxText = intIn(config.maxText, "feedback.maxText", 1, TEXT_MAX_BYTES, FEEDBACK_DEFAULTS.maxText);
	let perMinute = FEEDBACK_DEFAULTS.perMinute;
	let perDay = FEEDBACK_DEFAULTS.perDay;
	if (config.rate !== undefined) {
		if (!typeIs(config.rate, "table")) error("feedback.rate must be { perMinute?, perDay? }", 0);
		const rate = config.rate as Record<string, unknown>;
		perMinute = intIn(rate.perMinute, "feedback.rate.perMinute", 1, RATE_LIMIT_MAX, perMinute);
		perDay = intIn(rate.perDay, "feedback.rate.perDay", 1, RATE_LIMIT_MAX, perDay);
	}
	return { enabled: config.enabled !== false, scale: resolveScale(config.scale), maxText, perMinute, perDay };
}

function resolveScale(raw: unknown): ResolvedFeedbackConfig["scale"] {
	if (raw === undefined) return FEEDBACK_DEFAULTS.scale;
	if (!typeIs(raw, "table")) error("feedback.scale must be { id, type, steps?, labels? }", 0);
	const scale = raw as Record<string, unknown>;
	if (!isName(scale.id, 32)) error("feedback.scale.id must be 1-32 characters of [a-z0-9_]", 0);
	if (!typeIs(scale.type, "string") || !SCALE_TYPES.has(scale.type)) error("feedback.scale.type must be thumbs, stars or scale", 0);
	const scaleType = scale.type as FeedbackScaleType;
	let steps = 2;
	if (scaleType !== "thumbs") {
		if (!isInteger(scale.steps) || scale.steps < 2 || scale.steps > 10) error("feedback.scale.steps must be an integer 2..10", 0);
		steps = scale.steps;
	}
	if (scale.labels === undefined) return { id: scale.id, type: scaleType, steps };
	if (!typeIs(scale.labels, "table")) error("feedback.scale.labels must be an array of strings", 0);
	const labels = scale.labels as unknown[];
	let count = 0;
	for (const [, label] of pairs(labels as unknown as Record<string, unknown>)) {
		count += 1;
		if (!typeIs(label, "string") || label.size() < 1 || label.size() > 32) error("feedback.scale.labels: each label is 1-32 characters", 0);
	}
	if (count !== steps || labels.size() !== steps) {
		error(`feedback.scale.labels must have one label per step (${steps}${scaleType === "thumbs" ? ": thumbs is always 2" : ""})`, 0);
	}
	return { id: scale.id, type: scaleType, steps, labels: [...(labels as string[])] };
}

// Text -----------------------------------------------------------------------------------------------------------------

/** Code points of valid UTF-8 in `text`; invalid bytes (and overlong forms, surrogates) are skipped. */
export function decodeUtf8(text: string): number[] {
	const points: number[] = [];
	const size = text.size();
	let index = 1;
	while (index <= size) {
		const [lead] = text.byte(index);
		let need = 0;
		let point = 0;
		let low = 0x80;
		let high = 0xbf;
		if (lead < 0x80) {
			points.push(lead);
			index += 1;
			continue;
		} else if (lead >= 0xc2 && lead <= 0xdf) {
			need = 1;
			point = lead - 0xc0;
		} else if (lead >= 0xe0 && lead <= 0xef) {
			need = 2;
			point = lead - 0xe0;
			if (lead === 0xe0) low = 0xa0;
			if (lead === 0xed) high = 0x9f;
		} else if (lead >= 0xf0 && lead <= 0xf4) {
			need = 3;
			point = lead - 0xf0;
			if (lead === 0xf0) low = 0x90;
			if (lead === 0xf4) high = 0x8f;
		} else {
			index += 1;
			continue;
		}
		let valid = index + need <= size;
		for (let offset = 1; valid && offset <= need; offset++) {
			const [byte] = text.byte(index + offset);
			const lowest = offset === 1 ? low : 0x80;
			const highest = offset === 1 ? high : 0xbf;
			if (byte < lowest || byte > highest) valid = false;
			else point = point * 64 + (byte - 0x80);
		}
		if (valid) {
			points.push(point);
			index += need + 1;
		} else {
			index += 1;
		}
	}
	return points;
}

/** UTF-8 bytes of one code point. */
export function utf8Size(point: number): number {
	return point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
}

function isSpace(point: number): boolean {
	return (
		(point >= 9 && point <= 13) ||
		point === 32 ||
		point === 0x85 ||
		point === 0xa0 ||
		point === 0x1680 ||
		(point >= 0x2000 && point <= 0x200a) ||
		point === 0x2028 ||
		point === 0x2029 ||
		point === 0x202f ||
		point === 0x205f ||
		point === 0x3000
	);
}

/** Control and invisible format characters: C0, DEL, C1, zero-width, bidi overrides, BOM, specials. */
function isStripped(point: number): boolean {
	return (
		point < 32 ||
		(point >= 0x7f && point <= 0x9f) ||
		point === 0xad ||
		(point >= 0x200b && point <= 0x200f) ||
		(point >= 0x202a && point <= 0x202e) ||
		(point >= 0x2060 && point <= 0x206f) ||
		point === 0xfeff ||
		(point >= 0xfff9 && point <= 0xfffb) ||
		point === 0xfffe ||
		point === 0xffff
	);
}

/** Sanitised code points: whitespace runs become one space, control / format characters go, trimmed. */
export function cleanPoints(text: string): number[] {
	const out: number[] = [];
	let space = false;
	for (const point of decodeUtf8(text.size() > TEXT_SCAN_BYTES ? text.sub(1, TEXT_SCAN_BYTES) : text)) {
		if (isSpace(point)) {
			space = out.size() > 0;
			continue;
		}
		if (isStripped(point)) continue;
		if (space) out.push(32);
		space = false;
		out.push(point);
	}
	return out;
}

/** At most `maxChars` code points and `maxBytes` UTF-8 bytes (never half a code point), trailing space trimmed. */
export function capPoints(points: number[], maxChars: number, maxBytes: number): number[] {
	const out: number[] = [];
	let bytes = 0;
	for (const point of points) {
		if (out.size() >= maxChars) break;
		const size = utf8Size(point);
		if (bytes + size > maxBytes) break;
		bytes += size;
		out.push(point);
	}
	while (out.size() > 0 && out[out.size() - 1] === 32) out.pop();
	return out;
}

export function encodePoints(points: number[]): string {
	const parts: string[] = [];
	for (const point of points) parts.push(utf8.char(point));
	return parts.join("");
}

/** Characters of the raw text (code points; bytes when it isn't valid UTF-8). */
export function rawLength(text: string): number {
	const [count] = utf8.len(text);
	return typeIs(count, "number") ? count : text.size();
}

/** `sanitiseText(raw, max)`: the row's text ("" = none) and `len`, the raw length (0 when nothing is left). */
export function sanitiseText(raw: unknown, maxChars: number): { text: string; len: number } {
	if (!typeIs(raw, "string") || raw.size() === 0) return { text: "", len: 0 };
	const points = cleanPoints(raw);
	if (points.size() === 0) return { text: "", len: 0 };
	return { text: encodePoints(capPoints(points, maxChars, TEXT_MAX_BYTES)), len: rawLength(raw) };
}

// Rating ---------------------------------------------------------------------------------------------------------------

/** 4 decimals. */
function round4(value: number): number {
	return math.floor(value * 10000 + 0.5) / 10000;
}

/** `{ r, norm, label? }` for a rating in the scale, or undefined (bad_rating). */
export function normaliseRating(scale: ResolvedFeedbackConfig["scale"], rating: unknown): { r: number; norm: number; label?: string } | undefined {
	if (!isInteger(rating)) return undefined;
	if (scale.type === "thumbs") {
		if (rating !== 0 && rating !== 1) return undefined;
		return { r: rating, norm: rating, label: scale.labels?.[rating] };
	}
	if (rating < 1 || rating > scale.steps) return undefined;
	return { r: rating, norm: round4((rating - 1) / (scale.steps - 1)), label: scale.labels?.[rating - 1] };
}

// Topic and ctx --------------------------------------------------------------------------------------------------------

export function cleanTopic(raw: unknown): string | undefined {
	return isName(raw, 32) ? raw : undefined;
}

/** The valid entries of `ctx` (sorted keys, the first CTX_MAX_KEYS), or undefined when none are. */
export function cleanContext(raw: unknown): Record<string, string | number | boolean> | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const keys: string[] = [];
	for (const [key, value] of pairs(raw as Record<string, unknown>)) {
		if (!isName(key, 24)) continue;
		if (typeIs(value, "boolean") || typeIs(value, "string") || (typeIs(value, "number") && value === value && math.abs(value) < math.huge)) {
			keys.push(key);
		}
	}
	if (keys.size() === 0) return undefined;
	keys.sort();
	const out: Record<string, string | number | boolean> = {};
	for (let index = 0; index < math.min(keys.size(), CTX_MAX_KEYS); index++) {
		const key = keys[index];
		const value = (raw as Record<string, unknown>)[key];
		out[key] = typeIs(value, "string") ? encodePoints(capPoints(cleanPoints(value), CTX_TEXT_MAX, CTX_TEXT_MAX * 4)) : (value as number | boolean);
	}
	return out;
}

// Rate -----------------------------------------------------------------------------------------------------------------

/** One player's accepted submits (seconds on the given clock, oldest first). Plain data for playerState. */
export interface RateState {
	times: number[];
}

/** Drops times older than a day; true when one more submit at `now` fits both windows. */
export function rateAllows(state: RateState, now: number, perMinute: number, perDay: number): boolean {
	if (state.times.size() > 0 && now - state.times[0] >= DAY_SECONDS) state.times = state.times.filter((at) => now - at < DAY_SECONDS);
	if (state.times.size() >= perDay) return false;
	let lastMinute = 0;
	for (const at of state.times) if (now - at < MINUTE_SECONDS) lastMinute += 1;
	return lastMinute < perMinute;
}

export function rateRecord(state: RateState, now: number) {
	state.times.push(now);
	while (state.times.size() > RATE_LIMIT_MAX) state.times.remove(0);
}

// The row --------------------------------------------------------------------------------------------------------------

export type FeedbackProps = Record<string, unknown>;

/**
 * The `submit` row's props (SCHEMA.md), or the refusal. `encode` gives the props JSON's byte size: the text is
 * shortened further (rare: escapes) so the row stays under `maxBytes` instead of becoming `{"_trunc":...}`.
 */
export function buildFeedbackProps(
	config: ResolvedFeedbackConfig,
	input: FeedbackInput,
	playSeconds: number,
	encodedSize: (props: FeedbackProps) => number,
	maxBytes: number,
): { props: FeedbackProps } | { reason: FeedbackRefusal } {
	const scale = config.scale;
	const hasRating = input.rating !== undefined;
	const rating = hasRating ? normaliseRating(scale, input.rating) : undefined;
	if (hasRating && !rating) return { reason: "bad_rating" };
	const { text, len } = sanitiseText(input.text, config.maxText);
	if (!rating && text === "") return { reason: "empty" };
	const props: FeedbackProps = { scale: scale.id, type: scale.type, steps: scale.steps, len, play_s: math.max(0, math.floor(playSeconds)) };
	if (rating) {
		props.r = rating.r;
		props.norm = rating.norm;
		if (rating.label !== undefined) props.label = rating.label;
	}
	if (text !== "") props.text = text;
	const topic = cleanTopic(input.topic);
	if (topic !== undefined) props.topic = topic;
	const ctx = cleanContext(input.ctx);
	if (ctx !== undefined) props.ctx = ctx;
	// JSON escapes can grow the text past the props cap: cut it until the row fits.
	let size = encodedSize(props);
	let points: number[] | undefined;
	while (size > maxBytes && props.text !== undefined) {
		points = points ?? decodeUtf8(props.text as string);
		const cut = math.max(1, math.ceil((size - maxBytes) / 12));
		points = capPoints(points, math.max(0, points.size() - cut), TEXT_MAX_BYTES);
		if (points.size() === 0) props.text = undefined;
		else props.text = encodePoints(points);
		size = encodedSize(props);
	}
	if (size > maxBytes) props.ctx = undefined;
	return { props };
}
