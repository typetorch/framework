import type { LeafLimits } from "./types";

/**
 * What a type can't say about client input (ported from hopeful-river's remote-guard.ts): finite numbers, short strings,
 * small and shallow tables. Runs before the generated type guard.
 */
export const DEFAULT_LIMITS: Required<LeafLimits> = {
	rate: [20, 10],
	maxString: 1000,
	maxEntries: 300,
	maxDepth: 4,
	timeout: 15,
};

/** Seconds a request may wait for its answer: `invokeWithTimeout` and a leaf's `timeout` stay inside these. */
export const MIN_TIMEOUT = 0.5;
export const MAX_TIMEOUT = 120;

/**
 * A request timeout inside [MIN_TIMEOUT, MAX_TIMEOUT]; anything that isn't a number (or is NaN) is the default.
 * Returns the seconds and whether the wanted value had to change.
 */
export function boundedTimeout(wanted: unknown): [seconds: number, changed: boolean] {
	if (!typeIs(wanted, "number") || wanted !== wanted) return [DEFAULT_LIMITS.timeout, true];
	const seconds = math.clamp(wanted, MIN_TIMEOUT, MAX_TIMEOUT);
	return [seconds, seconds !== wanted];
}

export function withinShape(value: unknown, limits: Required<LeafLimits>, depth = 0): boolean {
	const kind = typeOf(value);
	if (kind === "number") {
		const n = value as number;
		return n === n && n !== math.huge && n !== -math.huge;
	}
	if (kind === "string") return (value as string).size() <= limits.maxString;
	if (kind === "table") {
		if (depth >= limits.maxDepth) return false;
		let entries = 0;
		for (const [key, inner] of pairs(value as object)) {
			entries += 1;
			if (entries > limits.maxEntries) return false;
			if (!withinShape(key, limits, depth + 1) || !withinShape(inner, limits, depth + 1)) return false;
		}
		return true;
	}
	return true;
}

/** Token bucket per (player, leaf). */
export class RateLimiter {
	private readonly buckets = new Map<Player, Map<string, [number, number]>>();

	allow(player: Player, path: string, [burst, perSecond]: [number, number]): boolean {
		let perPlayer = this.buckets.get(player);
		if (!perPlayer) {
			perPlayer = new Map();
			this.buckets.set(player, perPlayer);
		}
		const now = os.clock();
		const [tokens, last] = perPlayer.get(path) ?? [burst, now];
		const refilled = math.min(burst, tokens + (now - last) * perSecond);
		if (refilled < 1) {
			perPlayer.set(path, [refilled, now]);
			return false;
		}
		perPlayer.set(path, [refilled - 1, now]);
		return true;
	}

	forget(player: Player) {
		this.buckets.delete(player);
	}
}
