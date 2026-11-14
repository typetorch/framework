/**
 * `TypeTorch.feedback()` (plans/32): player feedback as a built-in. The game's server validates a player's rating and
 * text and the framework writes one `feedback` / `submit` row through the analytics engine (the row contract is in
 * src/analytics/SCHEMA.md). Types only.
 */

/** `thumbs` (down / up, r 0 / 1), `stars` (r 1..steps), `scale` (r 1..steps, e.g. faces BAD..GREAT). */
export type FeedbackScaleType = "thumbs" | "stars" | "scale";

/** The rating scale the game declares once (settings record `game.feedback`, or `configure`). */
export interface FeedbackScale {
	/** Stamped on every row as `scale`: 1-32 of [a-z0-9_], e.g. `faces5`. Change it when the meaning changes. */
	readonly id: string;
	readonly type: FeedbackScaleType;
	/** 2..10 for stars / scale; thumbs is always 2 (ignored). */
	readonly steps?: number;
	/** One label per step (1-32 characters each), lowest first: thumbs `["Down", "Up"]`, a faces scale `["BAD", ...]`. */
	readonly labels?: ReadonlyArray<string>;
}

/** The `feedback` config. Every field is optional; see FEEDBACK_DEFAULTS. */
export interface FeedbackConfig {
	/** false: every submit answers `disabled`. Default true. */
	readonly enabled?: boolean;
	/** Default `{ id: "stars5", type: "stars", steps: 5 }`. */
	readonly scale?: FeedbackScale;
	/** Most characters of text kept (1..2000; the row also keeps at most 2000 UTF-8 bytes). Default 1000. */
	readonly maxText?: number;
	/** Accepted submits per player (in memory, cleared when the player leaves). Default 2 a minute, 20 a day. */
	readonly rate?: { readonly perMinute?: number; readonly perDay?: number };
}

/** A context value: a string (at most 64 characters kept), a finite number or a boolean. */
export type FeedbackContextValue = string | number | boolean;

/** What the game passes to `submit` (usually straight from its own remote: everything is checked here). */
export interface FeedbackInput {
	/** thumbs: 0 (down) / 1 (up); stars / scale: an integer 1..steps. Leave it out for text-only feedback. */
	readonly rating?: number;
	/** Free text; sanitised (control characters stripped, whitespace collapsed, trimmed) and capped. */
	readonly text?: string;
	/** A category, 1-32 of [a-z0-9_] (`bug`, `idea`); anything else is dropped with a warning. */
	readonly topic?: string;
	/** The game's own context: at most 8 keys of 1-24 [a-z0-9_]; invalid entries are dropped. */
	readonly ctx?: Readonly<Record<string, FeedbackContextValue>>;
}

/**
 * Why a submit wrote nothing: `rate_limited` (the config's per-minute / per-day limit), `empty` (no rating and no
 * text left after sanitising), `bad_rating` (not an integer in the scale), `no_session` (no analytics engine runs, or
 * the player has no session: not in this server), `disabled` (switched off, an invalid config, or edit mode).
 */
export type FeedbackRefusal = "rate_limited" | "empty" | "bad_rating" | "no_session" | "disabled";

export type FeedbackResult = { readonly ok: true } | { readonly ok: false; readonly reason: FeedbackRefusal };

export interface Feedback {
	/**
	 * Server only: checks and writes one `feedback` / `submit` row on the player's analytics session (pid, sid, device,
	 * state stamped by the engine; `play_s` from the session's join). Never yields. Accepted submits count against
	 * the player's rate limits; refused ones don't.
	 */
	submit(player: Player, input: FeedbackInput): FeedbackResult;
	/**
	 * Server only: the game's config in code, used while the settings record has no `game.feedback` (Studio, or before
	 * it is set). Throws on an invalid config. Call it once at start (a later call replaces it).
	 */
	configure(config: FeedbackConfig): void;
	/** Server only: the scale in effect (to send to clients for the UI), or undefined while feedback is disabled. */
	scale(): FeedbackScale | undefined;
}
