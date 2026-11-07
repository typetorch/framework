/**
 * The signed launch data of a TypeTorch notification (plans/29, plans/29-contract.md "The signed launch data token"):
 *
 *   tt1n.<nid>.<k>.<uid36>.<t36>.<data>.<sig>
 *
 * nid: 10 chars [0-9a-z]; k: the kind name; uid36 / t36: UserId and send time (unix s), lowercase base36; data: the
 * intent's data as base64url without padding ("" when none); sig: base64url (no padding) of the first 16 bytes of
 * HMAC-SHA256(key = the ASCII bytes of the key string, message = everything before the "." in front of sig). The backend
 * signs (backend/src/notify), the game server verifies here. Whole token at most 200 bytes.
 *
 * Pure: only util/sha256 (no services), so it runs under Lune (scripts/test-notifications.luau).
 */
import { hmacSha256Raw, sha256 } from "../util/sha256";

export const TOKEN_PREFIX = "tt1n.";
export const TOKEN_MAX_BYTES = 200;
/** A token older than this (by its send time) is refused as `old`. */
export const TOKEN_MAX_AGE = 14 * 86400;
/** The previous key verifies for this long after a rotation (`keys.since`): the token lifetime, so no live token dies. */
export const PREVIOUS_KEY_GRACE = 14 * 86400;
/** Raw `data` bytes at most (before base64url). */
export const DATA_MAX_BYTES = 64;

/** `settings.backend.notify.keys` (server only, never replicated). Strings are used as ASCII bytes, never decoded. */
export interface NotifyKeys {
	current?: string;
	previous?: string;
	/** Unix seconds of the last rotation. */
	since?: number;
}

export type BadTokenWhy = "format" | "sig" | "user" | "old";

/** A token that verified. */
export interface GoodToken {
	readonly ok: true;
	readonly nid: string;
	readonly kind: string;
	readonly userId: number;
	/** The send time, unix seconds. */
	readonly sentAt: number;
	readonly data: string;
	/** Seconds since the send (never negative). */
	readonly ageSeconds: number;
}

export interface BadToken {
	readonly ok: false;
	readonly why: BadTokenWhy;
}

export type TokenVerdict = GoodToken | BadToken;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** base64url without padding of a byte string. */
export function base64url(bytes: string): string {
	const out = new Array<string>();
	const size = bytes.size();
	for (let index = 1; index <= size; index += 3) {
		const [a, b, c] = string.byte(bytes, index, index + 2);
		const n = a * 65536 + (b ?? 0) * 256 + (c ?? 0);
		const count = math.min(3, size - index + 1);
		for (let k = 0; k <= count; k++) {
			const value = bit32.band(bit32.rshift(n, 18 - k * 6), 63);
			out.push(B64.sub(value + 1, value + 1));
		}
	}
	return out.join("");
}

/** Decodes base64url without padding; undefined when it isn't (bad characters, an impossible length, stray bits). */
export function fromBase64url(text: string): string | undefined {
	const size = text.size();
	if (size % 4 === 1) return undefined;
	const out = new Array<string>();
	for (let index = 1; index <= size; index += 4) {
		const chunk = text.sub(index, index + 3);
		let n = 0;
		for (let k = 1; k <= 4; k++) {
			const character = chunk.sub(k, k);
			let value = 0;
			if (character !== "") {
				const [at] = B64.find(character, 1, true);
				if (at === undefined) return undefined;
				value = at - 1;
			}
			n = n * 64 + value;
		}
		const bytes = chunk.size() - 1;
		const all = [bit32.band(bit32.rshift(n, 16), 255), bit32.band(bit32.rshift(n, 8), 255), bit32.band(n, 255)];
		// Leftover bits of a short chunk must be zero (one encoding per value).
		if (bytes === 1 && all[1] !== 0) return undefined;
		if (bytes === 2 && all[2] !== 0) return undefined;
		for (let k = 0; k < bytes; k++) out.push(string.char(all[k]));
	}
	return out.join("");
}

/** A whole number >= 0 in lowercase base36. */
export function toBase36(value: number): string {
	let n = math.floor(value);
	if (n <= 0) return "0";
	let out = "";
	while (n > 0) {
		const digit = n % 36;
		out = B36.sub(digit + 1, digit + 1) + out;
		n = math.floor(n / 36);
	}
	return out;
}

/** Lowercase base36 to a number; undefined unless it is 1..11 base36 digits without a leading zero. */
export function fromBase36(text: string): number | undefined {
	if (text.size() < 1 || text.size() > 11 || text.match("^[0-9a-z]+$")[0] === undefined) return undefined;
	if (text.size() > 1 && text.sub(1, 1) === "0") return undefined;
	let n = 0;
	for (let index = 1; index <= text.size(); index++) {
		const [at] = B36.find(text.sub(index, index), 1, true);
		n = n * 36 + (at! - 1);
	}
	return n;
}

/** The key's hash in rows (never the key itself): the first 12 hex chars of SHA-256. "" for the default key. */
export function keyHash(key: string | undefined): string {
	if (key === undefined || key === "") return "";
	return sha256(key).sub(1, 12);
}

/** The sig part for a message (everything before the "." in front of sig). */
export function signMessage(key: string, message: string): string {
	return base64url(hmacSha256Raw(key, message).sub(1, 16));
}

/** Builds a token (the backend's job; here for tests and parity). */
export function signToken(key: string, nid: string, kind: string, userId: number, sentAt: number, data: string): string {
	const message = `tt1n.${nid}.${kind}.${toBase36(userId)}.${toBase36(sentAt)}.${base64url(data)}`;
	return `${message}.${signMessage(key, message)}`;
}

/** Whether launch data claims to be a TypeTorch notification token (anything else is the game's own). */
export function isToken(launch: unknown): launch is string {
	return typeIs(launch, "string") && launch.sub(1, TOKEN_PREFIX.size()) === TOKEN_PREFIX;
}

/** Compares two strings without stopping at the first difference. */
function sameText(a: string, b: string): boolean {
	if (a.size() !== b.size()) return false;
	let diff = 0;
	for (let index = 1; index <= a.size(); index++) diff = bit32.bor(diff, bit32.bxor(string.byte(a, index)[0], string.byte(b, index)[0]));
	return diff === 0;
}

function usableKey(key: unknown): key is string {
	return typeIs(key, "string") && key.size() >= 16 && key.size() <= 256;
}

/** Reads `settings.backend.notify` (a table) into keys; undefined without a usable current key. */
export function readKeys(notify: unknown): NotifyKeys | undefined {
	if (!typeIs(notify, "table")) return undefined;
	const keys = (notify as { keys?: unknown }).keys;
	if (!typeIs(keys, "table")) return undefined;
	const entry = keys as Record<string, unknown>;
	if (!usableKey(entry.current)) return undefined;
	return {
		current: entry.current,
		previous: usableKey(entry.previous) ? entry.previous : undefined,
		since: typeIs(entry.since, "number") ? entry.since : undefined,
	};
}

/**
 * Verifies launch data for the joining player (contract order): not `tt1n.` → undefined (not ours); not 7 parts (or a
 * part malformed, or over 200 bytes) → format; the sig against `current`, then `previous` while `now - since < 14 d` →
 * else sig; uid not the player → user; older than 14 days → old. `now` is unix seconds. No keys: every token is `sig`.
 */
export function verifyToken(launch: unknown, userId: number, keys: NotifyKeys | undefined, now: number): TokenVerdict | undefined {
	if (!isToken(launch)) return undefined;
	const bad = (why: BadTokenWhy): BadToken => ({ ok: false, why });
	if (launch.size() > TOKEN_MAX_BYTES) return bad("format");
	const parts = launch.split(".");
	if (parts.size() !== 7) return bad("format");
	const [, nid, kind, uid36, t36, data64, sig] = parts as unknown as [string, string, string, string, string, string, string];
	if (nid.match("^[0-9a-z]+$")[0] === undefined || nid.size() !== 10) return bad("format");
	if (kind.size() < 1 || kind.size() > 24 || kind.match("^[a-z0-9_]+$")[0] === undefined) return bad("format");
	const uid = fromBase36(uid36);
	const sentAt = fromBase36(t36);
	if (uid === undefined || sentAt === undefined) return bad("format");
	if (sig.size() !== 22 || sig.match("^[A-Za-z0-9_-]+$")[0] === undefined) return bad("format");
	const data = fromBase64url(data64);
	if (data === undefined || data.size() > DATA_MAX_BYTES) return bad("format");

	const message = launch.sub(1, launch.size() - sig.size() - 1);
	let signed = false;
	if (keys !== undefined && keys.current !== undefined && sameText(signMessage(keys.current, message), sig)) signed = true;
	if (
		!signed &&
		keys !== undefined &&
		keys.previous !== undefined &&
		keys.since !== undefined &&
		now - keys.since < PREVIOUS_KEY_GRACE &&
		sameText(signMessage(keys.previous, message), sig)
	) {
		signed = true;
	}
	if (!signed) return bad("sig");
	if (uid !== userId) return bad("user");
	if (now - sentAt > TOKEN_MAX_AGE) return bad("old");
	return { ok: true, nid, kind, userId: uid, sentAt, data, ageSeconds: math.max(0, now - sentAt) };
}
