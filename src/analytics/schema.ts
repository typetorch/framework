/**
 * The TypeTorch analytics contract (plans/16): the rows the engine writes and the sink settings it reads. The read
 * side (`@typetorch/analytics`, the DuckDB server, the Basin stream schemas) is built from the same contract, written
 * down in SCHEMA.md next to this file. Change both together, and bump `v` for breaking changes.
 */

/** Row format version (column `v`). */
export const SCHEMA_VERSION = 1;
/** The first-session recording codec (column `codec`). */
export const RECORDING_CODEC = "tt-rec-1";
/** Most bytes of the `props` JSON text. Larger props become `{"_trunc":<bytes>}`. */
export const PROPS_MAX_BYTES = 4096;

export type EventKind =
	| "session"
	| "tech"
	| "zone"
	| "funnel"
	| "purchase"
	| "currency"
	| "state"
	| "experiment"
	| "custom"
	| "recording_meta"
	| "fleet";

export type DeviceKind = "desktop" | "phone" | "tablet" | "console" | "vr" | "unknown";

/** One row of the events table. Flat; every column is always present. */
export interface EventRow {
	/** Row format version: 1. */
	v: number;
	/** Unix ms on the server's clock (client events are corrected by the server). */
	t: number;
	kind: EventKind;
	name: string;
	/** Random player id ("" for server-only events). Never the UserId. */
	pid: string;
	/** Session id ("" for server-only events). */
	sid: string;
	/** game.JobId ("" in Studio). */
	job: string;
	/** Server type: public, private, reserved, studio. */
	srv: string;
	/** game.PlaceId. */
	place: number;
	/** Artifact id that was live. */
	art: string;
	/** Artifact deploy seq (0 when unknown). */
	seq: number;
	branch: string;
	channel: string;
	dev: DeviceKind;
	/** In the player's first-ever session. */
	newp: boolean;
	/** The player's state after this event: `zone:Lobby|screen:Shop|activity:round` (empty parts left out). */
	state: string;
	/** JSON object of the player's experiment variants, `{}` when none. */
	exp: string;
	/** The server's experiment (a kernel A/B pin's artifact id) or "". */
	sexp: string;
	src: "server" | "client";
	/** JSON object, at most 4096 bytes. */
	props: string;
}

/** One row of the recordings table: one packed chunk of a player's first-ever session. */
export interface RecordingRow {
	v: number;
	/** Chunk start, unix ms (server clock). */
	t: number;
	pid: string;
	sid: string;
	job: string;
	art: string;
	/** 0, 1, 2... per session. */
	chunk: number;
	/** "tt-rec-1". */
	codec: string;
	/** Base64 of the packed binary chunk (SCHEMA.md "tt-rec-1"). */
	data: string;
	/** Position samples in the chunk. */
	n: number;
}

/**
 * Which UserId a pid belongs to, sent once per session when the pid is known. Only to the dev's own server (the
 * analytics server, or the fleet API for Basin games), never into the events table: it lets the dev map pids and
 * UserIds (support, Right to Erasure) and delete the link.
 */
export interface IdentityRow {
	pid: string;
	/** The player's UserId. */
	uid: number;
	/** Unix ms. */
	t: number;
}

/** Live overrides of one per-player experiment (settings key `experiments`). */
export interface ExperimentOverride {
	/** false: everyone gets the first variant (control) and the experiment isn't stamped on events. */
	active?: boolean;
	/** Relative weight per variant, in the order the game passes them (equal when missing or wrong length). */
	weights?: number[];
	/** Everyone gets this variant (must be one of the game's variants). */
	variant?: string;
}

/** The sink settings: the signed settings' `analytics` (kernel 0.3.8, server-only), or `new AnalyticsEngine({ settings })`. */
export interface AnalyticsSettings {
	backend: "basin" | "duckdb";
	/** basin: the events stream's ingest URL; duckdb: the analytics server's ingest URL. */
	events: string;
	/** basin: the recordings stream's ingest URL (no URL: nothing is recorded). duckdb: unused. */
	recordings?: string;
	/** Write-only ingest token, sent as `Authorization: Bearer <token>`. Never logged. */
	token?: string;
	/** Seconds between flushes (default 15, 5..300). */
	flushSeconds?: number;
	/** Share of new players whose first session is recorded (default 1, 0..1). */
	recordShare?: number;
	/** Seconds between tech health samples (default 60, 15..3600). */
	techEvery?: number;
	/** Live experiment overrides by experiment name. */
	experiments?: Record<string, ExperimentOverride>;
	/**
	 * basin: where identity rows go (the fleet API's `POST /v1/identity` URL). Default: the settings' `fleet` url
	 * + /v1/identity when the server can read it; without either, identities aren't sent. duckdb: unused (they go in
	 * the batch body).
	 */
	identity?: string;
	/** basin: the token for `identity` (default: the settings' `fleet` token). Never logged. */
	identityToken?: string;
}

/** AnalyticsSettings with every default filled in. */
export interface ResolvedSettings {
	backend: "basin" | "duckdb";
	events: string;
	recordings?: string;
	token?: string;
	flushSeconds: number;
	recordShare: number;
	techEvery: number;
	experiments: Map<string, ExperimentOverride>;
	identity?: string;
	identityToken?: string;
}

export type AnalyticsValue = string | number | boolean;
/** Event properties: a flat JSON object (nested tables work but are harder to query). */
export type AnalyticsProps = { readonly [key: string]: AnalyticsValue | undefined };

export interface AnalyticsPurchase {
	/** Developer product, game pass or subscription id. */
	product: number;
	/** Price in Robux. */
	robux: number;
	/** Where the prompt was shown, e.g. "shop". */
	where?: string;
	/** "product" (default), "gamepass", "subscription" or your own. Becomes the event name. */
	kind?: string;
}

/** What the automatic collectors do. Everything is on by default. */
export interface AnalyticsOptions {
	/** Server only: the sink settings. When set, the signed settings aren't read (tests, Studio, kernels before 0.3.8). */
	settings?: AnalyticsSettings;
	/** Server: joins, leaves, device, join source, first-ever vs returning. Default true. */
	sessions?: boolean;
	/** FPS, ping, memory, load time, errors, swaps. Default true. */
	tech?: boolean;
	/** Server: zones tagged `TTZone`. Default true. */
	zones?: boolean;
	/** Client: ScreenGuis in PlayerGui and GuiObjects tagged `TTScreen`. Default true. */
	screens?: boolean;
	/** First-ever-session recording (server: accept it; client: record it). Default true. */
	recording?: boolean;
	/**
	 * Server: the kernel's fleet rows (kernel 0.3.2+ `fleetStatus` / `onDeployReport`): a heartbeat every ~60 s and
	 * one row per deploy report, kind "fleet". They go before analytics events. Default true.
	 */
	fleet?: boolean;
	/**
	 * Server: one identity row `{ pid, uid, t }` per session once the pid is known (UserId and pid, nothing else), so
	 * the dev's own server can map them. duckdb: in the batch body (`identities`); basin: to the fleet API (Basin rows
	 * can't be deleted). Never part of the events table. Default true.
	 */
	identity?: boolean;
}

/** Kernel 0.3.2+ `fleetStatus()`: the server's heartbeat (sent as the props of a "fleet" / "heartbeat" row). */
export type FleetStatus = { readonly [key: string]: unknown };

/** Kernel 0.3.2+ deploy report `{ s, b, a, j, r, e?, d?, t, g, k, p }` (the props of a "fleet" / "deploy_report" row). */
export type DeployReport = { readonly [key: string]: unknown };

/** Counters of the server engine (`AnalyticsEngine.stats()`). */
export interface AnalyticsStats {
	/** Settings are loaded and valid. */
	configured: boolean;
	backend?: "basin" | "duckdb";
	/** Rows waiting to be sent. */
	queued: number;
	queuedRecordings: number;
	/** Fleet rows waiting (they go first). */
	queuedFleet: number;
	/** Identity rows waiting (pid -> UserId, for the dev's own server). */
	queuedIdentities: number;
	/** Rows sent since the server started (across swaps). */
	sent: number;
	/** Rows dropped because the queue was full. */
	dropped: number;
	/** Rows the backend refused (HTTP 4xx). */
	rejected: number;
	/** Failed requests in a row (0 after a success). */
	failures: number;
	/** Failed requests since the server started, every attempt (across swaps). */
	failed: number;
	/**
	 * The last failure's message ("both: HttpError: NetFail", "both: HTTP 530 ..."). Kept after a later success:
	 * compare `lastErrorAt` with `lastOkAt`.
	 */
	lastError?: string;
	/** HTTP status of the last failure (0: no answer at all, an HttpError). */
	lastStatus?: number;
	/** os.time() of the last failed request and of the last accepted one. */
	lastErrorAt?: number;
	lastOkAt?: number;
	/** Seconds until the next attempt while backing off after failures. */
	retryIn?: number;
	/** While failing: what the last failure means and what to do (hints.ts); the same words the log line and the dev menu use. */
	reason?: string;
	fix?: string;
	/** Settings problems (never contains the token). */
	settingsErrors: string[];
}
