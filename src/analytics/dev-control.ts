/**
 * Per-player dev overrides of analytics experiments (the dev menu's Server > Experiments page and its palette commands):
 * an owner or dev picks a variant of an experiment for themselves, sees which one they're in, and clears it.
 *
 * Who may: the dev menu decides (devtools/server.ts registers the gate: devs where the dev-only tools are open to them,
 * owners everywhere, like Modules > State). Without a registered gate (no dev menu in this generation) nobody may, and a
 * stored override is not applied. It only ever changes the player's own variant.
 *
 * Where: the analytics DataStore, key `dexp/<UserId>` = { [experiment]: variant }, read once per join and only for
 * players the gate allows (so other players cost nothing), and written on each change, so the override follows the
 * dev to every server and session. It wins over the signed settings (stop, settle, weights, `players`), is stamped
 * `forced` on the experiment row (the backend leaves forced players out of the results), and the game sees it the next
 * time it asks for the variant (usually the next join).
 *
 * The running engine registers its half here (like analytics/status.ts), so devtools never imports the engine.
 */

/** Overrides one player may hold (one per experiment). */
export const DEV_OVERRIDES_MAX = 32;
/** The DataStore key prefix (in the analytics store, next to `p/<UserId>`). */
export const DEV_OVERRIDE_PREFIX = "dexp/";

/** One experiment as the dev menu shows it to the player. */
export interface DevExperiment {
	name: string;
	/** The game's variants, once the game asked for this player's variant (the first is the control). */
	variants?: string[];
	/** The variant the player gets now (undefined while the game hasn't asked yet). */
	variant?: string;
	/** false: the experiment is stopped (everyone gets the control, not stamped). */
	active: boolean;
	/** "dev": the player's own override; "settings": the signed settings forced it; "random": the hash and the weights. */
	how?: "dev" | "settings" | "random";
	/** The player's own override, if any (may name a variant the game doesn't have: then it is ignored). */
	override?: string;
}

export interface DevExperimentsReply {
	experiments: DevExperiment[];
	/** The override was written to the DataStore (false: it holds for this server only until it saves). */
	saved?: boolean;
}

/** What the running engine offers the dev menu. */
export interface DevExperimentControl {
	readonly list: (player: Player) => DevExperiment[];
	/** Sets (variant) or clears (undefined) the player's override; throws a short message when it can't. */
	readonly set: (player: Player, name: string, variant: string | undefined) => DevExperimentsReply;
}

let control: DevExperimentControl | undefined;
let gate: ((player: Player) => boolean) | undefined;

/** The engine registers itself; the returned function removes it again (only if it is still the registered one). */
export function registerDevExperiments(value: DevExperimentControl): () => void {
	control = value;
	return () => {
		if (control === value) control = undefined;
	};
}

/** The running engine's control, or undefined when none runs in this generation. */
export function devExperiments(): DevExperimentControl | undefined {
	return control;
}

/** The dev menu registers who may hold an override; the returned function removes it. */
export function registerDevGate(value: (player: Player) => boolean): () => void {
	gate = value;
	return () => {
		if (gate === value) gate = undefined;
	};
}

/** Whether `player` may hold a dev override here (false without a gate; a failing gate counts as no). */
export function devOverrideAllowed(player: Player): boolean {
	const check = gate;
	if (check === undefined) return false;
	const [ok, allowed] = pcall(() => check(player));
	return ok && allowed === true;
}

/** A variant name as the framework takes it (isVariantList: 1-32 characters). */
export function isVariantName(value: unknown): value is string {
	return typeIs(value, "string") && value.size() >= 1 && value.size() <= 32;
}

/** A stored record cleaned: experiment name -> variant, at most DEV_OVERRIDES_MAX, bad entries dropped. */
export function cleanDevOverrides(raw: unknown, isName: (value: unknown) => boolean): Map<string, string> {
	const result = new Map<string, string>();
	if (!typeIs(raw, "table")) return result;
	for (const [name, variant] of pairs(raw as object)) {
		if (result.size() >= DEV_OVERRIDES_MAX) break;
		if (isName(name) && isVariantName(variant)) result.set(name as string, variant);
	}
	return result;
}
