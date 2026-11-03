/**
 * Dev menu command palette, the core (Ctrl+K, devtools/palette.ts): the command shape, fuzzy matching, the `when`
 * filter, the result order (recent commands first on an empty query, grouped results), the recent list and the two-step
 * confirm. Pure data, no Roblox instances and no imports, so it is tested under Lune (scripts/test-commands.luau).
 *
 * - A **command** has a stable `id` (dynamic ones carry their subject: "branch.switch:dev", "player.open:123"), a
 *   `title`, a `group` heading, optional `keywords` and a `hint` (a shortcut or a short note shown on the right).
 * - `when(ctx)` decides whether it is offered now (role, kernel capabilities, server type: devtools/build-actions.ts
 *   rules, never copies of them). A `when` that errors hides the command.
 * - `searchOnly` commands (one per build, per player, per server) only list once something is typed.
 * - `confirm(ctx)` makes it two-step, like the Branch tab's armed buttons: the first Enter (or click) arms it and shows
 *   the text, a second one within ARM_SECONDS runs it. Every action that swaps what runs on the server has one.
 * The kernel and the server stay the authority: hiding a command is cosmetic, they re-check every request.
 */

/** How a command was picked: Shift+Enter or Shift+click asks for a split instead of the focused pane. */
export interface RunHow {
	split: boolean;
}

export interface Command<C> {
	/** Stable id (the recent list keeps it). */
	id: string;
	title: string;
	/** Heading the result is listed under ("Pages", "Panes", "Server", "Players", ...). */
	group: string;
	/** Extra words that find it (names, ids, synonyms). */
	keywords?: string[];
	/** Dim text on the right: a shortcut ("Shift+Enter: split") or a detail ("3 players"). */
	hint?: string;
	/** Listed only once the query isn't empty (long lists). */
	searchOnly?: boolean;
	/** Listed last on every non-empty query, whatever it matches ("Ask Claude: <query>"); never on an empty one. */
	fallback?: boolean;
	/** Offered now (undefined: always). Errors count as false. */
	when?: (ctx: C) => boolean;
	/** Two-step: the text shown when armed ("Switch this server (3 players) to dev?"). */
	confirm?: (ctx: C) => string;
	/** The palette stays open after it runs (it reports progress in the palette's status line). */
	keepOpen?: boolean;
	run: (ctx: C, how: RunHow) => void;
}

/** Commands made on demand (one per branch, build, player...), from the context and the query. */
export type CommandSource<C> = (ctx: C, query: string) => Array<Command<C>>;

/** A titled block of results. */
export interface ResultGroup<C> {
	group: string;
	items: Array<Command<C>>;
}

/** The heading of the recent commands on an empty query. */
export const RECENT_GROUP = "Recent";
/** How many recent command ids are kept. */
export const RECENT_MAX = 8;
/** How long an armed command waits for its second Enter (seconds; widgets.ts ARM_SECONDS). */
export const ARM_SECONDS = 4;
/** Results shown at most (the rest: type more). */
export const RESULT_LIMIT = 60;

/** Static commands plus sources. Registration order is the listing order on an empty query. */
export class CommandRegistry<C> {
	private readonly commands = new Array<Command<C>>();
	private readonly sources = new Array<CommandSource<C>>();

	add(command: Command<C>) {
		this.commands.push(command);
	}

	addSource(source: CommandSource<C>) {
		this.sources.push(source);
	}

	/** Every command for this context and query (static first, then each source's, in order). Failing sources add nothing. */
	collect(ctx: C, query: string): Array<Command<C>> {
		const list = new Array<Command<C>>();
		for (const command of this.commands) list.push(command);
		for (const source of this.sources) {
			const [ok, made] = pcall(source, ctx, query);
			if (ok && typeIs(made, "table")) for (const command of made as Array<Command<C>>) list.push(command);
		}
		return list;
	}
}

// Matching ---------------------------------------------------------------------------------------------------------

function isWordChar(char: string): boolean {
	return char.match("^%w$")[0] !== undefined;
}

/** A match at `at` starts a word: the first character, or after a space, "/", "-", ".", ":", "(" and the like. */
function startsWord(text: string, at: number): boolean {
	return at <= 1 || !isWordChar(text.sub(at - 1, at - 1));
}

/**
 * How well `query` matches `text` (case-insensitive), or undefined for no match. A plain substring beats a scattered
 * one; matches at the start and at word starts score higher; shorter texts win ties. "" matches everything with 0.
 */
export function fuzzyScore(query: string, text: string): number | undefined {
	const q = query.lower();
	const t = text.lower();
	const qSize = q.size();
	if (qSize === 0) return 0;
	if (qSize > t.size()) return undefined;
	const [start] = t.find(q, 1, true);
	if (start !== undefined) {
		let score = 100 + qSize * 4;
		if (start === 1) score += 40;
		else if (startsWord(t, start)) score += 25;
		return score - (start - 1) * 0.5 - (t.size() - qSize) * 0.1;
	}
	// Scattered: every query character in order ("swb" finds "Switch branch"). Runs and word starts score.
	let score = 0;
	let from = 1;
	let previous = -1;
	for (let index = 1; index <= qSize; index++) {
		const char = q.sub(index, index);
		const [at] = t.find(char, from, true);
		if (at === undefined) return undefined;
		if (at === previous + 1) score += 6;
		else score -= math.min(at - from, 10) * 0.3;
		if (startsWord(t, at) && isWordChar(char)) score += 8;
		score += 1;
		previous = at;
		from = at + 1;
	}
	return score - (t.size() - qSize) * 0.05;
}

/** The query's words ("switch dev" -> ["switch", "dev"]). */
export function queryWords(query: string): string[] {
	const words = new Array<string>();
	for (const [word] of query.gmatch("%S+")) words.push(word as string);
	return words;
}

/**
 * How well a command matches `query`, or undefined. The whole query against the title counts most; otherwise every
 * word must match the title, a keyword or the group ("srv rel" finds "Reload" in "Server").
 */
export function commandScore<C>(command: Command<C>, query: string): number | undefined {
	const words = queryWords(query);
	if (words.size() === 0) return 0;
	const whole = fuzzyScore(words.join(" "), command.title);
	let total = 0;
	for (const word of words) {
		let best = fuzzyScore(word, command.title);
		for (const keyword of command.keywords ?? []) {
			const score = fuzzyScore(word, keyword);
			if (score !== undefined && (best === undefined || score - 10 > best)) best = score - 10;
		}
		const groupScore = fuzzyScore(word, command.group);
		if (groupScore !== undefined && (best === undefined || groupScore - 30 > best)) best = groupScore - 30;
		if (best === undefined) return whole !== undefined ? whole + 50 : undefined;
		total += best;
	}
	return whole !== undefined ? math.max(whole + 50, total) : total;
}

// Filtering and order ----------------------------------------------------------------------------------------------

/** Whether `command` is offered in `ctx` now (no `when`: yes; a `when` that errors: no). */
export function isAvailable<C>(command: Command<C>, ctx: C): boolean {
	if (command.when === undefined) return true;
	const [ok, result] = pcall(command.when, ctx);
	return ok && result === true;
}

/** The commands offered now, in their order (the first of a duplicate id wins). */
export function available<C>(commands: Array<Command<C>>, ctx: C): Array<Command<C>> {
	const seen = new Set<string>();
	const list = new Array<Command<C>>();
	for (const command of commands) {
		if (seen.has(command.id) || !isAvailable(command, ctx)) continue;
		seen.add(command.id);
		list.push(command);
	}
	return list;
}

/** Groups in order of their first item; items keep their order. */
export function groupResults<C>(list: Array<Command<C>>): Array<ResultGroup<C>> {
	const groups = new Array<ResultGroup<C>>();
	const byName = new Map<string, ResultGroup<C>>();
	for (const command of list) {
		let group = byName.get(command.group);
		if (!group) {
			group = { group: command.group, items: [] };
			byName.set(command.group, group);
			groups.push(group);
		}
		group.items.push(command);
	}
	return groups;
}

/**
 * The palette's results for `query`: only commands whose `when` passes.
 * - Empty query: the recent ones (newest first, under RECENT_GROUP), then every other command that isn't `searchOnly`,
 *   grouped in registration order.
 * - Otherwise: matches by score; groups are ordered by their best match, items by score inside a group (ties keep the
 *   registration order). At most `limit` results, then the `fallback` commands.
 */
export function searchCommands<C>(
	commands: Array<Command<C>>,
	ctx: C,
	query: string,
	recent: string[],
	limit = RESULT_LIMIT,
): Array<ResultGroup<C>> {
	const offered = available(commands, ctx);
	if (queryWords(query).size() === 0) {
		const byId = new Map<string, Command<C>>();
		for (const command of offered) byId.set(command.id, command);
		const result = new Array<ResultGroup<C>>();
		const recentItems = new Array<Command<C>>();
		const taken = new Set<string>();
		for (const id of recent) {
			const command = byId.get(id);
			if (command === undefined || command.fallback === true || taken.has(id)) continue;
			taken.add(id);
			recentItems.push(command);
		}
		let count = 0;
		if (recentItems.size() > 0) {
			const items = new Array<Command<C>>();
			for (const command of recentItems) {
				if (count >= limit) break;
				items.push(command);
				count += 1;
			}
			result.push({ group: RECENT_GROUP, items });
		}
		const rest = new Array<Command<C>>();
		for (const command of offered) {
			if (count >= limit) break;
			if (command.searchOnly === true || command.fallback === true || taken.has(command.id)) continue;
			rest.push(command);
			count += 1;
		}
		for (const group of groupResults(rest)) result.push(group);
		return result;
	}
	const scored = new Array<[command: Command<C>, score: number, index: number]>();
	const fallbacks = new Array<Command<C>>();
	offered.forEach((command, index) => {
		if (command.fallback === true) {
			fallbacks.push(command);
			return;
		}
		const score = commandScore(command, query);
		if (score !== undefined) scored.push([command, score, index]);
	});
	// Best group first, then by score inside each group.
	const groupBest = new Map<string, number>();
	const groupFirst = new Map<string, number>();
	for (const [command, score, index] of scored) {
		const best = groupBest.get(command.group);
		if (best === undefined || score > best) groupBest.set(command.group, score);
		if (!groupFirst.has(command.group)) groupFirst.set(command.group, index);
	}
	scored.sort((a, b) => {
		const [ca, sa, ia] = a;
		const [cb, sb, ib] = b;
		if (ca.group !== cb.group) {
			const ga = groupBest.get(ca.group)!;
			const gb = groupBest.get(cb.group)!;
			if (ga !== gb) return ga > gb;
			return groupFirst.get(ca.group)! < groupFirst.get(cb.group)!;
		}
		if (sa !== sb) return sa > sb;
		return ia < ib;
	});
	const list = new Array<Command<C>>();
	for (const [command] of scored) {
		if (list.size() >= limit) break;
		list.push(command);
	}
	for (const command of fallbacks) list.push(command);
	return groupResults(list);
}

/** The results in display order (what Up / Down walk). */
export function flatten<C>(groups: Array<ResultGroup<C>>): Array<Command<C>> {
	const list = new Array<Command<C>>();
	for (const group of groups) for (const command of group.items) list.push(command);
	return list;
}

/** Moves the selection by `delta`, wrapping; 0 results: 0. Indexes are 0-based. */
export function moveSelection(index: number, delta: number, count: number): number {
	if (count <= 0) return 0;
	return (((index + delta) % count) + count) % count;
}

// Recent commands --------------------------------------------------------------------------------------------------

/** A persisted recent list as it should be: strings only, no duplicates, at most `max` (garbage: empty). */
export function sanitizeRecent(value: unknown, max = RECENT_MAX): string[] {
	const list = new Array<string>();
	if (!typeIs(value, "table")) return list;
	const seen = new Set<string>();
	for (const entry of value as unknown[]) {
		if (list.size() >= max) break;
		if (!typeIs(entry, "string") || entry === "" || seen.has(entry)) continue;
		seen.add(entry);
		list.push(entry);
	}
	return list;
}

/** `id` moved to the front of the recent list (newest first, at most `max`). */
export function pushRecent(recent: string[], id: string, max = RECENT_MAX): string[] {
	const list = [id];
	for (const entry of recent) {
		if (list.size() >= max) break;
		if (entry !== id) list.push(entry);
	}
	return list;
}

// Two-step confirm -------------------------------------------------------------------------------------------------

/** The armed command, if any (kept by the palette across redraws). */
export interface ArmedCommand {
	id?: string;
	at: number;
}

/**
 * One Enter (or click) on a command that has `confirm`: "arm" the first time (or after ARM_SECONDS, or when another
 * command was armed), "run" when the same command was armed less than ARM_SECONDS ago. Updates `armed`.
 */
export function armStep(armed: ArmedCommand, id: string, now: number, seconds = ARM_SECONDS): "arm" | "run" {
	if (armed.id === id && now - armed.at < seconds) {
		armed.id = undefined;
		armed.at = -math.huge;
		return "run";
	}
	armed.id = id;
	armed.at = now;
	return "arm";
}

/** Whether `id` is armed now. */
export function isArmed(armed: ArmedCommand, id: string, now: number, seconds = ARM_SECONDS): boolean {
	return armed.id === id && now - armed.at < seconds;
}

// Hotkey -----------------------------------------------------------------------------------------------------------

/**
 * Ctrl+K or Cmd+K: `key` is the pressed KeyCode's name, `held` whether a Control / Command (Super, Meta) key is down,
 * `processed` the engine's gameProcessedEvent (typing in chat or a TextBox: never a shortcut).
 */
export function isPaletteHotkey(key: string, held: boolean, processed: boolean): boolean {
	return !processed && held && key === "K";
}
