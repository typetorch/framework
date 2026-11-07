/**
 * Notifications wire (plans/29-contract.md "HTTP"): the intent items the game server posts to
 * `<backend.url>/v1/notify/intents`, their checks and JSON, the swap-safe queue they wait in, and the client → server
 * opt-in row message. The contract is shared with backend/src/notify and the CLI: never change a shape here alone.
 *
 * Pure: no imports and no services, so it runs under Lune (scripts/test-notifications.luau). The string quoter is
 * passed in (HttpService.JSONEncode of a string in game), so integers keep every digit (`rev` is 13+ digits).
 */

/** Client → server raw channel: opt-in rows ("optin", payload). */
export const CHANNEL = "__tt/nt";

/** Items per POST (the backend refuses more). */
export const BATCH_ITEMS = 200;
/** Body bytes per POST at most (the backend allows 256 KB). */
export const BATCH_BYTES = 200000;
/** Items kept waiting at most; past this the oldest presence items go first, then the oldest of any op. */
export const QUEUE_CAP = 5000;
/** Retries of opened / played calls kept at most. */
export const CALLS_CAP = 500;

export const KIND_PATTERN = "^[a-z0-9_]+$";
export const KIND_MAX = 24;
export const KEY_MAX = 64;
export const PARAMS_MAX = 8;
export const PARAM_NAME_MAX = 32;
export const PARAM_VALUE_MAX = 64;
export const DATA_MAX = 64;
export const TEMPLATE_MAX = 128;
export const WHY_MAX = 64;
/** Kinds one user can switch off at most (`setOff`). */
export const OFF_MAX = 32;

export interface WantItem {
	op: "want";
	u: number;
	k: string;
	key?: string;
	at?: number;
	until?: number;
	params?: Record<string, string>;
	data?: string;
	template?: string;
	rev: number;
}

export interface DropItem {
	op: "drop";
	u: number;
	k: string;
	key?: string;
	why?: string;
	rev: number;
}

export interface PresenceItem {
	op: "presence";
	u: number;
	online: boolean;
	/** Unix MILLISECONDS (contract review fixes; the backend orders a user's presence by it, online wins a tie). */
	at: number;
}

/** Replaces the user's switched-off kinds (the backend skips their intents, whoever issued them: `pref_off`). */
export interface PrefsItem {
	op: "prefs";
	u: number;
	/** Sorted, unique kind names (at most OFF_MAX); empty = every kind on. */
	off: string[];
	rev: number;
}

export type Item = WantItem | DropItem | PresenceItem | PrefsItem;

/** `want` options as game code passes them (checked by `cleanWant`). */
export interface WantOptions {
	/** The intent's key (upsert by user + kind + key): a letter GUID, a streak's day. Default "". */
	key?: string;
	/** Earliest send, unix seconds (default: now). */
	at?: number;
	/** Latest send, unix seconds, after `at` (default: the backend's, now + 7 days). */
	until?: number;
	/** The template's placeholders: at most 8, names [a-zA-Z0-9_-]{1,32} (Roblox templates use `{user-streak-remaining}`), values at most 64 chars (numbers become text). */
	params?: Record<string, string | number>;
	/** Echoed to `onOpen` from the verified launch data: at most 64 bytes. */
	data?: string;
	/** A template id, only for kinds with `allowTemplate` (the backend checks). */
	template?: string;
}

/** A pending POST /v1/notify/opened (a join whose call failed: retried with the intents). */
export interface OpenedCall {
	nid: string;
	u: number;
}

/** A pending POST /v1/notify/played. */
export interface PlayedCall {
	nid: string;
	u: number;
	secs: number;
}

/** Plain data (persist-safe): everything waiting to be sent, and the rev clock. */
export interface QueueState {
	items: Item[];
	/** Items of a request that was running when the last generation stopped (sent again: at least once). */
	inflight: Item[];
	opened: OpenedCall[];
	played: PlayedCall[];
	/** The last rev handed out (monotonic per server, across swaps). */
	lastRev: number;
	dropped: number;
	sent: number;
	rejected: number;
	failures: number;
}

export function newQueueState(): QueueState {
	return { items: [], inflight: [], opened: [], played: [], lastRev: 0, dropped: 0, sent: 0, rejected: 0, failures: 0 };
}

/**
 * `rev` = the server's `os.time() * 1000 + seq` (seq: the count within that second), and always above the last one, so
 * the backend's last-write-wins per (u, k, key) follows this server's call order even past 1000 calls a second or a
 * clock step back.
 */
export function nextRev(state: QueueState, nowSeconds: number): number {
	const rev = math.max(math.floor(nowSeconds) * 1000, state.lastRev + 1);
	state.lastRev = rev;
	return rev;
}

export function isKind(value: unknown): value is string {
	return typeIs(value, "string") && value.size() >= 1 && value.size() <= KIND_MAX && value.match(KIND_PATTERN)[0] !== undefined;
}

export function isUserId(value: unknown): value is number {
	return typeIs(value, "number") && value === value && value >= 1 && value < 2 ** 53 && value % 1 === 0;
}

function isUnixSeconds(value: unknown): value is number {
	return typeIs(value, "number") && value === value && value >= 0 && value < 1e11;
}

/** The want item for these options, or the problem (never repeats a value). */
export function cleanWant(userId: unknown, kind: unknown, options: WantOptions | undefined, rev: number): WantItem | string {
	if (!isUserId(userId)) return "the user must be a Player or a positive UserId";
	if (!isKind(kind)) return "the kind must be 1-24 of [a-z0-9_]";
	const item: WantItem = { op: "want", u: userId, k: kind, rev };
	if (options === undefined) return item;
	if (!typeIs(options, "table")) return "options must be a table";
	if (options.key !== undefined) {
		if (!typeIs(options.key, "string") || options.key.size() > KEY_MAX) return `key must be text of at most ${KEY_MAX} characters`;
		if (options.key !== "") item.key = options.key;
	}
	if (options.at !== undefined) {
		if (!isUnixSeconds(options.at)) return "at must be unix seconds";
		item.at = math.floor(options.at);
	}
	if (options.until !== undefined) {
		if (!isUnixSeconds(options.until)) return "until must be unix seconds";
		item.until = math.floor(options.until);
	}
	if (item.at !== undefined && item.until !== undefined && item.until <= item.at) return "until must be after at";
	if (options.params !== undefined) {
		if (!typeIs(options.params, "table")) return "params must be a table";
		const params: Record<string, string> = {};
		let count = 0;
		for (const [name, raw] of pairs(options.params as object)) {
			count += 1;
			if (count > PARAMS_MAX) return `at most ${PARAMS_MAX} params`;
			if (!typeIs(name, "string") || name.size() < 1 || name.size() > PARAM_NAME_MAX || name.match("^[%w_%-]+$")[0] === undefined) {
				return "param names must be 1-32 of [a-zA-Z0-9_-]";
			}
			const value = typeIs(raw, "number") ? tostring(raw) : raw;
			if (!typeIs(value, "string") || value.size() > PARAM_VALUE_MAX) return `param ${name} must be text of at most ${PARAM_VALUE_MAX} characters`;
			params[name] = value;
		}
		if (count > 0) item.params = params;
	}
	if (options.data !== undefined) {
		if (!typeIs(options.data, "string") || options.data.size() > DATA_MAX) return `data must be text of at most ${DATA_MAX} bytes`;
		if (options.data !== "") item.data = options.data;
	}
	if (options.template !== undefined) {
		if (!typeIs(options.template, "string") || options.template.size() < 1 || options.template.size() > TEMPLATE_MAX) {
			return `template must be a message id of at most ${TEMPLATE_MAX} characters`;
		}
		item.template = options.template;
	}
	return item;
}

/** The drop item, or the problem. No key: every key of that kind. */
export function cleanDrop(userId: unknown, kind: unknown, key: unknown, why: unknown, rev: number): DropItem | string {
	if (!isUserId(userId)) return "the user must be a Player or a positive UserId";
	if (!isKind(kind)) return "the kind must be 1-24 of [a-z0-9_]";
	const item: DropItem = { op: "drop", u: userId, k: kind, rev };
	if (key !== undefined) {
		if (!typeIs(key, "string") || key.size() > KEY_MAX) return `key must be text of at most ${KEY_MAX} characters`;
		item.key = key;
	}
	if (why !== undefined) {
		if (!typeIs(why, "string") || why.size() > WHY_MAX) return `why must be text of at most ${WHY_MAX} characters`;
		if (why !== "") item.why = why;
	}
	return item;
}

/**
 * The prefs item (`setOff`): the kinds as a list of kind names, duplicates removed, sorted; at most OFF_MAX. Kinds need
 * not be in the pushed config yet (a kind added later is covered at once).
 */
export function cleanPrefs(userId: unknown, kinds: unknown, rev: number): PrefsItem | string {
	if (!isUserId(userId)) return "the user must be a Player or a positive UserId";
	if (!typeIs(kinds, "table")) return "kinds must be a list of kind names";
	const list = kinds as unknown[];
	let count = 0;
	for (const [index] of pairs(list as object)) {
		count += 1;
		if (!typeIs(index, "number")) return "kinds must be a list of kind names";
	}
	if (count !== list.size()) return "kinds must be a list of kind names";
	const seen = new Set<string>();
	const off = new Array<string>();
	for (const kind of list) {
		if (!isKind(kind)) return "every kind must be 1-24 of [a-z0-9_]";
		if (seen.has(kind)) continue;
		seen.add(kind);
		off.push(kind);
	}
	if (off.size() > OFF_MAX) return `at most ${OFF_MAX} kinds`;
	off.sort();
	return { op: "prefs", u: userId, off, rev };
}

/** Adds a prefs item, replacing one for the same user still waiting (only the newest set matters). */
export function pushPrefs(state: QueueState, item: PrefsItem) {
	const kept = new Array<Item>();
	for (const entry of state.items) if (!(entry.op === "prefs" && entry.u === item.u)) kept.push(entry);
	state.items = kept;
	pushItem(state, item);
}

/** Adds an item; over the cap drops presence items first (the backend re-learns presence on the next join), then the oldest. */
export function pushItem(state: QueueState, item: Item) {
	state.items.push(item);
	if (state.items.size() <= QUEUE_CAP) return;
	const excess = state.items.size() - QUEUE_CAP;
	let removed = 0;
	const kept = new Array<Item>();
	for (const entry of state.items) {
		if (removed < excess && entry.op === "presence") removed += 1;
		else kept.push(entry);
	}
	while (kept.size() > QUEUE_CAP) {
		kept.remove(0);
		removed += 1;
	}
	state.items = kept;
	state.dropped += removed;
}

type Quote = (text: string) => string;

function int(value: number): string {
	return string.format("%d", value >= 0 ? math.floor(value) : -math.floor(-value));
}

/** One item as JSON (fixed field order; integers keep every digit). */
export function encodeItem(item: Item, quote: Quote): string {
	const parts = new Array<string>();
	parts.push(`"op":${quote(item.op)}`, `"u":${int(item.u)}`);
	if (item.op === "presence") {
		parts.push(`"online":${item.online ? "true" : "false"}`, `"at":${int(item.at)}`);
		return `{${parts.join(",")}}`;
	}
	if (item.op === "prefs") {
		parts.push(`"off":[${item.off.map((kind) => quote(kind)).join(",")}]`, `"rev":${int(item.rev)}`);
		return `{${parts.join(",")}}`;
	}
	parts.push(`"k":${quote(item.k)}`);
	if (item.key !== undefined) parts.push(`"key":${quote(item.key)}`);
	if (item.op === "want") {
		if (item.at !== undefined) parts.push(`"at":${int(item.at)}`);
		if (item.until !== undefined) parts.push(`"until":${int(item.until)}`);
		if (item.params !== undefined) {
			const names = new Array<string>();
			for (const [name] of pairs(item.params)) names.push(name as string);
			names.sort();
			const fields = names.map((name) => `${quote(name)}:${quote(item.params![name])}`);
			parts.push(`"params":{${fields.join(",")}}`);
		}
		if (item.data !== undefined) parts.push(`"data":${quote(item.data)}`);
		if (item.template !== undefined) parts.push(`"template":${quote(item.template)}`);
	} else if (item.why !== undefined) parts.push(`"why":${quote(item.why)}`);
	parts.push(`"rev":${int(item.rev)}`);
	return `{${parts.join(",")}}`;
}

/**
 * Takes the next batch from the front: at most BATCH_ITEMS items and BATCH_BYTES of body (the first item always goes).
 * Returns the items and the request body `{"v":1,"items":[...]}`.
 */
export function takeBatch(state: QueueState, quote: Quote, maxItems = BATCH_ITEMS): [Item[], string] {
	const taken = new Array<Item>();
	const encoded = new Array<string>();
	let bytes = 20;
	let count = 0;
	const items = state.items;
	while (count < items.size() && count < maxItems) {
		const text = encodeItem(items[count], quote);
		if (count > 0 && bytes + text.size() + 1 > BATCH_BYTES) break;
		bytes += text.size() + 1;
		encoded.push(text);
		taken.push(items[count]);
		count += 1;
	}
	const rest = new Array<Item>();
	for (let index = count; index < items.size(); index++) rest.push(items[index]);
	state.items = rest;
	return [taken, `{"v":1,"items":[${encoded.join(",")}]}`];
}

/** Puts a batch back in front, in order (a failed request). */
export function requeueItems(state: QueueState, batch: Item[]) {
	if (batch.size() === 0) return;
	const merged = [...batch];
	for (const item of state.items) merged.push(item);
	state.items = merged;
	while (state.items.size() > QUEUE_CAP) {
		state.items.remove(0);
		state.dropped += 1;
	}
}

/** Adds a retry call, keeping the cap (the oldest go). */
export function pushCall<T extends defined>(list: T[], call: T) {
	list.push(call);
	while (list.size() > CALLS_CAP) list.remove(0);
}

/** `POST /v1/notify/intents`'s answer: how many were refused, and the first reason. */
export function readIntentsAnswer(body: unknown): { accepted: number; rejected: number; why?: string } {
	if (!typeIs(body, "table")) return { accepted: 0, rejected: 0 };
	const answer = body as { accepted?: unknown; rejected?: unknown };
	const accepted = typeIs(answer.accepted, "number") ? answer.accepted : 0;
	let rejected = 0;
	let why: string | undefined;
	if (typeIs(answer.rejected, "table")) {
		for (const entry of answer.rejected as unknown[]) {
			rejected += 1;
			if (why === undefined && typeIs(entry, "table")) {
				const reason = (entry as { why?: unknown }).why;
				if (typeIs(reason, "string")) why = reason.sub(1, 64);
			}
		}
	}
	return { accepted, rejected, why };
}

/** `POST /v1/notify/opened`'s answer. */
export function readOpenedState(body: unknown): "first" | "repeat" | "unknown" | undefined {
	if (!typeIs(body, "table")) return undefined;
	const state = (body as { state?: unknown }).state;
	return state === "first" || state === "repeat" || state === "unknown" ? state : undefined;
}

// Opt-in rows (client → server) -------------------------------------------------------------------------------------

export type OptInRowName = "optin_check" | "optin_shown" | "optin_closed";

export interface OptInRow {
	name: OptInRowName;
	where: string;
	can?: boolean;
	err?: string;
	secs?: number;
}

/** `where` names the game's spot that asked ("streak_2"): 1-32 of [a-zA-Z0-9_]. */
export function isWhere(value: unknown): value is string {
	return typeIs(value, "string") && value.size() >= 1 && value.size() <= 32 && value.match("^[%w_]+$")[0] !== undefined;
}

/** A client's opt-in row, checked field by field (unknown fields dropped); undefined when it isn't one. */
export function cleanOptInRow(raw: unknown): OptInRow | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const entry = raw as Record<string, unknown>;
	const name = entry.name;
	if (name !== "optin_check" && name !== "optin_shown" && name !== "optin_closed") return undefined;
	if (!isWhere(entry.where)) return undefined;
	const row: OptInRow = { name, where: entry.where };
	if (name === "optin_check") {
		if (!typeIs(entry.can, "boolean")) return undefined;
		row.can = entry.can;
	}
	if (entry.err !== undefined) {
		if (!typeIs(entry.err, "string")) return undefined;
		row.err = entry.err.sub(1, 64);
	}
	if (name === "optin_closed") {
		if (!typeIs(entry.secs, "number") || entry.secs !== entry.secs || entry.secs < 0) return undefined;
		row.secs = math.min(math.floor(entry.secs), 3600);
	}
	return row;
}
