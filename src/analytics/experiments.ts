/**
 * Per-player experiment assignment (plans/16 section 5): deterministic from the player id and the experiment name, so
 * a player keeps their variant in every session, on every server, and the server and the client compute the same one.
 *
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-analytics.luau).
 */

import type { ExperimentOverride } from "./schema";

const TWO_32 = 4294967296;

/** 32-bit FNV-1a of the UTF-8 bytes of `text`. Exact (no float rounding): `h * 16777619 = (h << 24) + h * 403`. */
export function hash32(text: string): number {
	let hash = 2166136261;
	for (let index = 1; index <= text.size(); index++) {
		hash = bit32.bxor(hash, string.byte(text, index)[0]);
		hash = (bit32.lshift(hash, 24) + hash * 403) % TWO_32;
	}
	return hash;
}

/** A stable number in [0, 1) for `text`. */
export function unitHash(text: string): number {
	return hash32(text) / TWO_32;
}

export interface Assignment {
	variant: string;
	/** false when the experiment is switched off (the first variant, not stamped on events). */
	active: boolean;
	/** The variant was forced by the settings key. */
	forced: boolean;
}

/** Relative weights, or undefined when they don't fit the variants (then every variant weighs the same). */
function usableWeights(weights: unknown, count: number): number[] | undefined {
	if (!typeIs(weights, "table")) return undefined;
	const list = weights as number[];
	if (list.size() !== count) return undefined;
	let total = 0;
	for (const weight of list) {
		if (!typeIs(weight, "number") || weight !== weight || weight < 0 || weight === math.huge) return undefined;
		total += weight;
	}
	return total > 0 ? list : undefined;
}

/**
 * The variant of experiment `name` for player `pid`. The first variant is the control: everyone gets it while the
 * experiment is switched off (`active: false`). `weights` split players unevenly (`[9, 1]`: 10% get the second);
 * `variant` forces one for everyone. The point in [0, 1) is unitHash(`<name>:<pid>`), so changing weights moves as few
 * players as possible.
 */
export function assignVariant(pid: string, name: string, variants: string[], override?: ExperimentOverride): Assignment {
	const control = variants[0] ?? "";
	if (variants.size() === 0) return { variant: "", active: false, forced: false };
	if (override?.active === false) return { variant: control, active: false, forced: false };
	const forced = override?.variant;
	if (typeIs(forced, "string") && variants.includes(forced)) return { variant: forced, active: true, forced: true };
	const weights = usableWeights(override?.weights, variants.size());
	const point = unitHash(`${name}:${pid}`);
	if (!weights) {
		const index = math.min(math.floor(point * variants.size()), variants.size() - 1);
		return { variant: variants[index], active: true, forced: false };
	}
	let total = 0;
	for (const weight of weights) total += weight;
	let cumulative = 0;
	for (let index = 0; index < variants.size(); index++) {
		cumulative += weights[index] / total;
		if (point < cumulative) return { variant: variants[index], active: true, forced: false };
	}
	// Float rounding at the top end: the last variant with weight.
	for (let index = variants.size() - 1; index >= 0; index--) {
		if (weights[index] > 0) return { variant: variants[index], active: true, forced: false };
	}
	return { variant: control, active: true, forced: false };
}

/** Whether player `pid` is in the recorded share (0..1) of new players. Stable per player. */
export function inShare(pid: string, share: number): boolean {
	if (share >= 1) return true;
	if (share <= 0) return false;
	return unitHash(`__rec:${pid}`) < share;
}

/** A valid experiment name: 1-64 chars, letters, digits, `_`, `-`, `.`, `/`. */
export function isExperimentName(value: unknown): value is string {
	return typeIs(value, "string") && value.size() >= 1 && value.size() <= 64 && value.match("^[%w_%-%./]+$")[0] !== undefined;
}

/** 1-16 distinct variant names of 1-32 chars each. */
export function isVariantList(value: unknown): value is string[] {
	if (!typeIs(value, "table")) return false;
	const list = value as unknown[];
	const size = list.size();
	if (size < 1 || size > 16) return false;
	let count = 0;
	for (const [key] of pairs(value as object)) {
		count += 1;
		if (!typeIs(key, "number")) return false;
	}
	if (count !== size) return false;
	const seen = new Set<string>();
	for (const variant of list) {
		if (!typeIs(variant, "string") || variant.size() < 1 || variant.size() > 32 || seen.has(variant)) return false;
		seen.add(variant);
	}
	return true;
}
