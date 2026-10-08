/**
 * The sink settings (the signed settings' `analytics`, kernel 0.3.8, or `new AnalyticsEngine({ settings })`): parsing with
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
	let identity: string | undefined;
	if (entry.identity !== undefined) {
		if (isUrl(entry.identity)) identity = entry.identity;
		else errors.push("identity must be an http(s) URL");
	}
	let identityToken: string | undefined;
	if (entry.identityToken !== undefined) {
		// Never echo the value.
		if (typeIs(entry.identityToken, "string") && entry.identityToken.size() > 0 && entry.identityToken.size() <= 4096) identityToken = entry.identityToken;
		else errors.push("identityToken must be a non-empty string");
	}

	if ((backend !== "basin" && backend !== "duckdb") || !isUrl(entry.events)) return { errors };
	return {
		settings: { backend, events: entry.events, recordings, token, flushSeconds, recordShare, techEvery, experiments, identity, identityToken },
		errors,
	};
}

/**
 * Kernel 0.4.0 / plans/21: the raw sink settings from the signed record. `backend` = { url, key, analytics? } is the
 * DuckDB sink at <url>/v1/ingest with the key (flushSeconds, recordShare, techEvery and experiments from
 * `backend.analytics`). The old `analytics` value is used while `backend` is missing, and whenever it names a Basin sink
 * (`backend` can't describe Basin streams). Returns what parseSettings reads (undefined: no settings).
 */
export function sinkSettings(backend: unknown, analytics: unknown, decode: (text: string) => unknown): unknown {
	if (analytics !== undefined) {
		let value: unknown = analytics;
		if (typeIs(value, "string")) {
			const [ok, decoded] = pcall(decode, value);
			value = ok ? decoded : undefined;
		}
		if (typeIs(value, "table") && (value as Record<string, unknown>).backend === "basin") return analytics;
	}
	if (!typeIs(backend, "table")) return analytics;
	const entry = backend as Record<string, unknown>;
	if (!typeIs(entry.url, "string")) return analytics;
	const base = entry.url.gsub("/+$", "")[0];
	const extra = typeIs(entry.analytics, "table") ? (entry.analytics as Record<string, unknown>) : {};
	return {
		backend: "duckdb",
		events: `${base}/v1/ingest`,
		token: entry.key,
		flushSeconds: extra.flushSeconds,
		recordShare: extra.recordShare,
		techEvery: extra.techEvery,
		experiments: extra.experiments,
	};
}

/** Where identity rows go on a Basin game: the backend (`backend` = { url, key }, or the old `fleet` = { url, token }) at /v1/identity. */
export interface IdentityTarget {
	url: string;
	token?: string;
}

/**
 * The identity target for these settings: duckdb none (identities ride in the batch body); basin the `identity` URL,
 * else the fleet API's /v1/identity from the settings' `fleet` value (a table or JSON `{ url, token }`), else none.
 */
export function identityTarget(settings: ResolvedSettings, fleetRaw: unknown, decode: (text: string) => unknown): IdentityTarget | undefined {
	if (settings.backend === "duckdb") return undefined;
	let fleet: Record<string, unknown> | undefined;
	if (typeIs(fleetRaw, "string")) {
		const [ok, decoded] = pcall(decode, fleetRaw);
		if (ok && typeIs(decoded, "table")) fleet = decoded as Record<string, unknown>;
	} else if (typeIs(fleetRaw, "table")) fleet = fleetRaw as Record<string, unknown>;
	const secret = fleet !== undefined ? (fleet.key !== undefined ? fleet.key : fleet.token) : undefined;
	const fleetToken = typeIs(secret, "string") && secret.size() > 0 ? secret : undefined;
	if (settings.identity !== undefined) return { url: settings.identity, token: settings.identityToken ?? fleetToken };
	if (fleet === undefined || !isUrl(fleet.url)) return undefined;
	const base = (fleet.url as string).gsub("/+$", "")[0];
	return { url: `${base}/v1/identity`, token: settings.identityToken ?? fleetToken };
}

/** Whether recordings can be sent at all: duckdb always (one body), basin only with a recordings stream URL. */
export function recordsSupported(settings: ResolvedSettings): boolean {
	return settings.backend === "duckdb" || settings.recordings !== undefined;
}
