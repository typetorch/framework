/**
 * SHA-256 and HMAC-SHA256 in plain Luau (bit32), for remote-claude: the pairing code's tunnel fingerprint
 * (dev-server pairing.ts) and the run_luau audit hash. Byte strings in, lowercase hex or raw bytes out. No other
 * imports, so the compiled module also runs under Lune for tests.
 */

const K = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** The 32-byte digest of `message` (a byte string), as a byte string. */
export function sha256Raw(message: string): string {
	const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
	const length = message.size();
	// Padding: 0x80, zeros to 56 mod 64, then the bit length as 64 bits big-endian.
	const zeros = (55 - length) % 64;
	const bits = length * 8;
	const high = math.floor(bits / 0x100000000);
	// string.char, not "\x80" literals: a TS string literal would be emitted as UTF-8 (two bytes).
	const padded = message + string.char(0x80) + string.rep(string.char(0), zeros < 0 ? zeros + 64 : zeros) + string.pack(">I4I4", high, bits % 0x100000000);
	const w = new Array<number>();
	for (let chunk = 0; chunk < padded.size(); chunk += 64) {
		for (let t = 0; t < 16; t++) {
			const at = chunk + t * 4 + 1;
			const [a, b, c, d] = string.byte(padded, at, at + 3);
			w[t] = bit32.bor(bit32.lshift(a, 24), bit32.lshift(b, 16), bit32.lshift(c, 8), d);
		}
		for (let t = 16; t < 64; t++) {
			const x = w[t - 15];
			const y = w[t - 2];
			const s0 = bit32.bxor(bit32.rrotate(x, 7), bit32.rrotate(x, 18), bit32.rshift(x, 3));
			const s1 = bit32.bxor(bit32.rrotate(y, 17), bit32.rrotate(y, 19), bit32.rshift(y, 10));
			w[t] = (w[t - 16] + s0 + w[t - 7] + s1) % 0x100000000;
		}
		let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
		for (let t = 0; t < 64; t++) {
			const s1 = bit32.bxor(bit32.rrotate(e, 6), bit32.rrotate(e, 11), bit32.rrotate(e, 25));
			const ch = bit32.bxor(bit32.band(e, f), bit32.band(bit32.bnot(e), g));
			const t1 = (hh + s1 + ch + K[t] + w[t]) % 0x100000000;
			const s0 = bit32.bxor(bit32.rrotate(a, 2), bit32.rrotate(a, 13), bit32.rrotate(a, 22));
			const maj = bit32.bxor(bit32.band(a, b), bit32.band(a, c), bit32.band(b, c));
			const t2 = (s0 + maj) % 0x100000000;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) % 0x100000000;
			d = c;
			c = b;
			b = a;
			a = (t1 + t2) % 0x100000000;
		}
		h[0] = (h[0] + a) % 0x100000000;
		h[1] = (h[1] + b) % 0x100000000;
		h[2] = (h[2] + c) % 0x100000000;
		h[3] = (h[3] + d) % 0x100000000;
		h[4] = (h[4] + e) % 0x100000000;
		h[5] = (h[5] + f) % 0x100000000;
		h[6] = (h[6] + g) % 0x100000000;
		h[7] = (h[7] + hh) % 0x100000000;
	}
	return string.pack(">I4I4I4I4I4I4I4I4", h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
}

/** Lowercase hex of a byte string. */
export function toHex(bytes: string): string {
	return bytes.gsub(".", (character) => "%02x".format(string.byte(character)[0]))[0];
}

/** SHA-256 of `message` as 64 lowercase hex characters. */
export function sha256(message: string): string {
	return toHex(sha256Raw(message));
}

/** HMAC-SHA256(key, message) as a 32-byte string. */
export function hmacSha256Raw(key: string, message: string): string {
	let block = key.size() > 64 ? sha256Raw(key) : key;
	block = block + string.rep(string.char(0), 64 - block.size());
	const inner = block.gsub(".", (character) => string.char(bit32.bxor(string.byte(character)[0], 0x36)))[0];
	const outer = block.gsub(".", (character) => string.char(bit32.bxor(string.byte(character)[0], 0x5c)))[0];
	return sha256Raw(outer + sha256Raw(inner + message));
}

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
