/**
 * Remote-claude's pairing-code fingerprint (dev-server pairing.ts) over the shared SHA-256 / HMAC in util/sha256.ts
 * (moved there for the notification tokens; re-exported here so devtools imports stay the same).
 */
import { hmacSha256Raw } from "../util/sha256";

export { hmacSha256Raw, sha256, sha256Raw, toHex } from "../util/sha256";

/** The pairing code alphabet: 32 symbols without 0/O and 1/I (dev-server pairing.ts CODE_ALPHABET). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_SECRET_LENGTH = 20;
export const CODE_LENGTH = 24;

/**
 * The 4 check symbols of a pairing code: the first 20 bits of HMAC-SHA256(key = the 20-symbol secret, message = the
 * tunnel hostname in lowercase), in CODE_ALPHABET. Must match dev-server pairing.ts `fingerprint`.
 */
export function codeFingerprint(secret: string, host: string): string {
	const mac = hmacSha256Raw(secret, host.lower());
	const [b0, b1, b2] = string.byte(mac, 1, 3);
	const v = b0 * 65536 + b1 * 256 + b2;
	let out = "";
	for (const shift of [19, 14, 9, 4]) {
		const index = bit32.band(bit32.rshift(v, shift), 31);
		out += CODE_ALPHABET.sub(index + 1, index + 1);
	}
	return out;
}
