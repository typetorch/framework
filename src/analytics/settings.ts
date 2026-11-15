/**
 * The sink settings (the signed settings' `analytics`, kernel 0.3.8, or `new AnalyticsEngine({ settings })`): parsing with
 * defaults and clamps. Errors never repeat the token.
 *
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-analytics.luau). The JSON
 * decoder is passed in (HttpService.JSONDecode in game, serde under Lune).
 */

import type { JoinDataMode } from "./join";
import type { ExperimentOverride, ExtendedSettings, ResolvedSettings } from "./schema";

export const DEFAULT_FLUSH_SECONDS = 15;
export const DEFAULT_TECH_EVERY = 60;
/** The recording window after the first input (`recordSeconds`): default, and its clamp (the 10 minute recording cap). */
export const DEFAULT_RECORD_SECONDS = 60;
export const RECORD_SECONDS_MIN = 10;
export const RECORD_SECONDS_MAX = 600;

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

/** Event names in one `positions` list (options or settings). */
export const POSITION_NAMES_MAX = 64;

/** A `positions` list (options or settings): event names (1-64 characters), at most 64. Undefined when it isn't one. */
export function parsePositionNames(value: unknown): Set<string> | undefined {
	if (!typeIs(value, "table")) return undefined;
	const names = new Set<string>();
	let count = 0;
	for (const [key, name] of pairs(value as object)) {
		count += 1;
		if (!typeIs(key, "number") || !typeIs(name, "string") || name.size() < 1 || name.size() > 64 || count > POSITION_NAMES_MAX) {
			return undefined;
		}
		names.add(name);
	}
	return names;
}

/** `options.positions` as a set: none when unset; a bad list warns and means none. */
export function optionPositions(value: unknown): Set<string> {
	if (value === undefined) return new Set();
	const names = parsePositionNames(value);
	if (names) return names;
	warn("[analytics] options.positions must be a list of event names (1-64 characters, at most 64): ignored");
	return new Set();
}

/** Per-player overrides one experiment may hold (`players`). */
export const EXPERIMENT_PLAYERS_MAX = 200;

/** A `players` key: a UserId (digits) or a pid (32 lowercase hex). */
function isPlayerKey(key: unknown): key is string {
	if (!typeIs(key, "string")) return false;
	if (key.size() >= 1 && key.size() <= 19 && key.match("^%d+$")[0] !== undefined) return true;
	return key.size() === 32 && key.match("^[0-9a-f]+$")[0] !== undefined;
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
		if (entry.players !== undefined) {
			const players: Record<string, string> = {};
			let ok = typeIs(entry.players, "table");
			let count = 0;
			if (ok) {
				for (const [key, variant] of pairs(entry.players as object)) {
					count += 1;
					if (!isPlayerKey(key) || !typeIs(variant, "string") || variant.size() < 1 || variant.size() > 32) ok = false;
					else players[key] = variant;
				}
			}
			if (ok && count <= EXPERIMENT_PLAYERS_MAX) override.players = players;
			else errors.push(`experiments.${name}.players must map UserIds or pids to variant names (at most ${EXPERIMENT_PLAYERS_MAX})`);
		}
		result.set(name, override);
	}
	return result;
}

// Extended recording (plans/36) ---------------------------------------------------------------------------------------

/** The built-in experiment that rolls extended recording out: variant "on" gets it. */
export const EXT_EXPERIMENT = "tt_extended_recording";
export const EXT_VARIANTS = ["off", "on"];
export const EXT_SECONDS_MIN = 10;
export const EXT_SECONDS_MAX = 600;

/** The defaults of `analytics.extended`. */
export function defaultExtended(): ExtendedSettings {
	return {
		seconds: 300,
		maxPlaytime: 60,
		afkSeconds: 30,
		hz: 3.33,
		entMax: 24,
		entRadius: 150,
		uiBudgetMs: 0.25,
		uiKeyframeSeconds: 60,
		dryRun: false,
		streams: { pose: true, ent: true, ui: true, view: true },
	};
}

/**
 * `analytics.extended` with defaults and clamps; problems go to `errors` as `extended.<field> ...` (a bad field keeps its
 * default). Also reads the copy the hello carries to the client (the same shape). Unknown fields are ignored.
 */
export function parseExtended(value: unknown, errors: string[]): ExtendedSettings {
	const result = defaultExtended();
	if (value === undefined) return result;
	if (!typeIs(value, "table")) {
		errors.push("extended must be an object");
		return result;
	}
	const entry = value as Record<string, unknown>;
	result.seconds = clampNumber(entry.seconds, result.seconds, EXT_SECONDS_MIN, EXT_SECONDS_MAX, "extended.seconds", errors);
	result.maxPlaytime = clampNumber(entry.maxPlaytime, result.maxPlaytime, 0, 86400, "extended.maxPlaytime", errors);
	result.afkSeconds = clampNumber(entry.afkSeconds, result.afkSeconds, 5, 600, "extended.afkSeconds", errors);
	result.hz = clampNumber(entry.hz, result.hz, 1, 10, "extended.hz", errors);
	result.entMax = math.floor(clampNumber(entry.entMax, result.entMax, 0, 255, "extended.entMax", errors));
	result.entRadius = clampNumber(entry.entRadius, result.entRadius, 10, 2000, "extended.entRadius", errors);
	result.uiBudgetMs = clampNumber(entry.uiBudgetMs, result.uiBudgetMs, 0.05, 4, "extended.uiBudgetMs", errors);
	result.uiKeyframeSeconds = clampNumber(entry.uiKeyframeSeconds, result.uiKeyframeSeconds, 10, 600, "extended.uiKeyframeSeconds", errors);
	if (entry.dryRun !== undefined) {
		if (typeIs(entry.dryRun, "boolean")) result.dryRun = entry.dryRun;
		else errors.push("extended.dryRun must be true or false");
	}
	if (entry.streams !== undefined) {
		if (!typeIs(entry.streams, "table")) errors.push("extended.streams must be { pose, ent, ui, view } (each true or false)");
		else {
			const streams = entry.streams as Record<string, unknown>;
			for (const name of ["pose", "ent", "ui", "view"] as const) {
				const flag = streams[name];
				if (flag === undefined) continue;
				if (typeIs(flag, "boolean")) result.streams[name] = flag;
				else errors.push(`extended.streams.${name} must be true or false`);
			}
		}
	}
	return result;
}

/**
 * Whether a player may get extended recording (plans/36): under `maxPlaytime` seconds of total playtime at the join.
 * A first visit (`newp`) is 0. A record without `play` (written before framework 0.7.2) is unknown: not eligible.
 */
export function extendedEligible(newp: boolean, play: number | undefined, maxPlaytime: number): boolean {
	if (newp) return true;
	return play !== undefined && play < maxPlaytime;
}

/** Problems sinkSettings found while building its value (`sinkErrors`), at most this many are kept. */
const SINK_ERRORS_MAX = 8;

/**
 * Reads the settings value: a table (the configs API stores JSON objects) or a JSON string. `undefined` (no key) gives
 * no settings and no errors. Unknown fields are ignored, except `sinkErrors` (strings sinkSettings found wrong in the
 * record's `backend`), which join `errors`.
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
	if (typeIs(entry.sinkErrors, "table")) {
		let count = 0;
		for (const problem of entry.sinkErrors as unknown[]) {
			if (!typeIs(problem, "string") || count >= SINK_ERRORS_MAX) continue;
			errors.push(problem.sub(1, 200));
			count += 1;
		}
	}

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
	const recordSeconds = clampNumber(entry.recordSeconds, DEFAULT_RECORD_SECONDS, RECORD_SECONDS_MIN, RECORD_SECONDS_MAX, "recordSeconds", errors);
	let positions = new Set<string>();
	if (entry.positions !== undefined) {
		const parsed = parsePositionNames(entry.positions);
		if (parsed) positions = parsed;
		else errors.push("positions must be a list of event names (1-64 characters, at most 64)");
	}
	const techEvery = clampNumber(entry.techEvery, DEFAULT_TECH_EVERY, 15, 3600, "techEvery", errors);
	const experiments = parseExperiments(entry.experiments, errors);
	const extended = parseExtended(entry.extended, errors);
	let joinData: JoinDataMode = "full";
	if (entry.joinData !== undefined) {
		if (entry.joinData === "full" || entry.joinData === "summary" || entry.joinData === "off") joinData = entry.joinData;
		else errors.push(`joinData must be "full", "summary" or "off" (using "full")`);
	}
	let joinLaunchPrefix = false;
	if (entry.joinLaunchPrefix !== undefined) {
		if (typeIs(entry.joinLaunchPrefix, "boolean")) joinLaunchPrefix = entry.joinLaunchPrefix;
		else errors.push("joinLaunchPrefix must be true or false");
	}
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
		settings: {
				backend,
				events: entry.events,
				recordings,
				token,
				flushSeconds,
				recordShare,
				recordSeconds,
				techEvery,
				experiments,
				positions,
				identity,
				identityToken,
				joinLaunchPrefix,
				joinData,
				extended,
			},
		errors,
	};
}

/**
 * Kernel 0.4.0 / plans/21: the raw sink settings from the signed record. `backend` = { url, key, ingest?, analytics? } is
 * the DuckDB sink at <url>/v1/ingest with the key (flushSeconds, recordShare, recordSeconds, positions, techEvery and
 * experiments from `backend.analytics`). Framework 0.7.2 (plans/35 C): with an `ingest` URL (separate ingest servers)
 * events go to <ingest>/v1/ingest instead, same key; a bad `ingest` falls back to <url>/v1/ingest and adds a
 * `sinkErrors` line (parseSettings reports it; the server warns once). The kernel keeps using `url`. The old `analytics`
 * value is used while `backend` is missing, and whenever it names a Basin sink (`backend` can't describe Basin streams).
 * Returns what parseSettings reads (undefined: no settings).
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
	let base = entry.url.gsub("/+$", "")[0];
	const sinkErrors = new Array<string>();
	if (entry.ingest !== undefined) {
		const ingest = typeIs(entry.ingest, "string") ? entry.ingest.gsub("/+$", "")[0] : undefined;
		// The same check parseSettings makes on the events URL; the value is never echoed.
		if (ingest !== undefined && isUrl(ingest)) base = ingest;
		else sinkErrors.push("backend.ingest must be an http(s) URL (events go to backend.url instead)");
	}
	const extra = typeIs(entry.analytics, "table") ? (entry.analytics as Record<string, unknown>) : {};
	return {
		backend: "duckdb",
		events: `${base}/v1/ingest`,
		sinkErrors: sinkErrors.size() > 0 ? sinkErrors : undefined,
		token: entry.key,
		flushSeconds: extra.flushSeconds,
		recordShare: extra.recordShare,
		recordSeconds: extra.recordSeconds,
		positions: extra.positions,
		techEvery: extra.techEvery,
		experiments: extra.experiments,
		joinLaunchPrefix: extra.joinLaunchPrefix,
		joinData: extra.joinData,
		extended: extra.extended,
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
