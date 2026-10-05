/**
 * The sink settings (ConfigService key `TypeTorchAnalytics`, or `new AnalyticsEngine({ settings })`): parsing with
 * defaults and clamps. Errors never repeat the token.
 *
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-analytics.luau). The JSON
 * decoder is passed in (HttpService.JSONDecode in game, serde under Lune).
 */

import type { ExperimentOverride, ResolvedSettings } from "./schema";

export const DEFAULT_FLUSH_SECONDS = 15;
export const DEFAULT_TECH_EVERY = 60;

export interface ParsedSettings {
	/** Undefined when there are no settings, or they're unusable (see `errors`). */
	settings?: ResolvedSettings;
	errors: string[];
}

function isUrl(value: unknown): value is string {
	return typeIs(value, "string") && value.size() <= 2048 && value.match("^https?://[^%s]+$")[0] !== undefined;
}

function clampNumber(value: unknown, fallback: number, low: number, high: number, label: string, errors: string[]): number {
	if (value === undefined) return fallback;
	if (!typeIs(value, "number") || value !== value) {
		errors.push(`${label} must be a number`);
		return fallback;
	}
	return math.clamp(value, low, high);
}

function parseExperiments(value: unknown, errors: string[]): Map<string, ExperimentOverride> {
	const result = new Map<string, ExperimentOverride>();
	if (value === undefined) return result;
	if (!typeIs(value, "table")) {
		errors.push("experiments must be an object");
		return result;
	}
	for (const [name, raw] of pairs(value as object)) {
		if (!typeIs(name, "string") || name.size() > 64) {
			errors.push("experiments: bad experiment name");
			continue;
		}
		if (!typeIs(raw, "table")) {
			errors.push(`experiments.${name} must be an object`);
			continue;
		}
		const entry = raw as Record<string, unknown>;
		const override: ExperimentOverride = {};
		if (entry.active !== undefined) {
			if (typeIs(entry.active, "boolean")) override.active = entry.active;
			else errors.push(`experiments.${name}.active must be true or false`);
		}
		if (entry.variant !== undefined) {
			if (typeIs(entry.variant, "string") && entry.variant.size() <= 32) override.variant = entry.variant;
			else errors.push(`experiments.${name}.variant must be a variant name`);
		}
		if (entry.weights !== undefined) {
			const weights = new Array<number>();
			let ok = typeIs(entry.weights, "table");
			if (ok) {
				for (const weight of entry.weights as unknown[]) {
					if (!typeIs(weight, "number") || weight !== weight || weight < 0 || weight === math.huge) ok = false;
					else weights.push(weight);
				}
			}
			if (ok && weights.size() > 0) override.weights = weights;
			else errors.push(`experiments.${name}.weights must be a list of numbers >= 0`);
		}
		result.set(name, override);
	}
	return result;
}

/**
 * Reads the settings value: a table (the configs API stores JSON objects) or a JSON string. `undefined` (no key) gives
 * no settings and no errors. Unknown fields are ignored.
 */
export function parseSettings(raw: unknown, decode: (text: string) => unknown): ParsedSettings {
	const errors = new Array<string>();
	if (raw === undefined) return { errors };
	let value: unknown = raw;
	if (typeIs(value, "string")) {
		const [ok, decoded] = pcall(decode, value);
		if (!ok) return { errors: ["the settings are not JSON"] };
		value = decoded;
	}
	if (!typeIs(value, "table")) return { errors: ["the settings must be a JSON object"] };
	const entry = value as Record<string, unknown>;

	const backend = entry.backend;
	if (backend !== "basin" && backend !== "duckdb") errors.push(`backend must be "basin" or "duckdb"`);
	if (!isUrl(entry.events)) errors.push("events must be an http(s) URL");
	let recordings: string | undefined;
	if (entry.recordings !== undefined) {
		if (isUrl(entry.recordings)) recordings = entry.recordings;
		else errors.push("recordings must be an http(s) URL");
	}
	let token: string | undefined;
	if (entry.token !== undefined) {
		// Never echo the value.
		if (typeIs(entry.token, "string") && entry.token.size() > 0 && entry.token.size() <= 4096) token = entry.token;
		else errors.push("token must be a non-empty string");
	}
	const flushSeconds = clampNumber(entry.flushSeconds, DEFAULT_FLUSH_SECONDS, 5, 300, "flushSeconds", errors);
	const recordShare = clampNumber(entry.recordShare, 1, 0, 1, "recordShare", errors);
	const techEvery = clampNumber(entry.techEvery, DEFAULT_TECH_EVERY, 15, 3600, "techEvery", errors);
	const experiments = parseExperiments(entry.experiments, errors);

	if ((backend !== "basin" && backend !== "duckdb") || !isUrl(entry.events)) return { errors };
	return {
		settings: { backend, events: entry.events, recordings, token, flushSeconds, recordShare, techEvery, experiments },
		errors,
	};
}

/** Whether recordings can be sent at all: duckdb always (one body), basin only with a recordings stream URL. */
export function recordsSupported(settings: ResolvedSettings): boolean {
	return settings.backend === "duckdb" || settings.recordings !== undefined;
}
