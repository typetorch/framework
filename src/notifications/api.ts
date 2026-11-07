/**
 * `TypeTorch.notifications()` (plans/29, plans/29-contract.md "Framework API"): native Roblox experience notifications.
 * The game says WHY a player should hear from it (an intent); the TypeTorch backend decides when and what and sends;
 * the framework verifies the tap and writes the rows. Types only.
 */
import type { WantOptions } from "./protocol";

export type { WantOptions } from "./protocol";

/** What `onOpen` gets for a player who joined from a notification whose signed launch data verified. */
export interface NotifyOpen {
	/** The send's id (10 chars). */
	readonly nid: string;
	/** The kind name ("gift_new"; "custom" for one-offs). */
	readonly kind: string;
	/** The intent's `data` (where to take the player); "" when none. Only ever from a verified token. */
	readonly data: string;
	/** Seconds since the backend sent it. */
	readonly ageSeconds: number;
	/**
	 * The first join from this notification (the backend says so). A repeat (a second tap on the same notification) or an
	 * id the backend doesn't know is false; when the backend can't be reached it is true.
	 */
	readonly first: boolean;
}

/**
 * `promptOptIn`'s answer: `shown` (Roblox showed its prompt and it closed: Roblox doesn't say whether the player
 * accepted), `unavailable` (CanPromptOptInAsync said no: under 13, already opted in, asked in the last 30 days, Studio),
 * `error` (a call failed or timed out), `busy` (a prompt is open), `already` (asked once this session).
 */
export type OptInResult = "shown" | "unavailable" | "error" | "busy" | "already";

export interface Notifications {
	/**
	 * Server: asks the backend to notify the user for `kind` (declared in typetorch.json `notifications.kinds`). Upsert by
	 * (user, kind, options.key); works for players not in this server (pass the UserId). Batched and swap-safe; false
	 * (with a warning) when an argument is refused here. Writes a `notify` / `want` row.
	 */
	want(user: Player | number, kind: string, options?: WantOptions): boolean;
	/** Server: drops the intent (no key: every key of that kind), e.g. the player already did it. Row `drop`. */
	drop(user: Player | number, kind: string, key?: string, why?: string): boolean;
	/**
	 * Server: `callback(player, open)` for each player who joined from a notification (verified launch data), including
	 * those who joined before the first callback connected in this generation. Returns a disconnect (for the trove).
	 */
	onOpen(callback: (player: Player, open: NotifyOpen) => void): () => void;
	/**
	 * Client: Roblox's notification opt-in prompt, at most once per session (show your own explainer first: Roblox's text
	 * is fixed). Yields until the prompt closes (at most about 130 s). `where` names the spot that asked ("streak_2":
	 * 1-32 of [a-zA-Z0-9_]). Rows optin_check / optin_shown / optin_closed, written by the server.
	 */
	promptOptIn(where: string): OptInResult;
}
