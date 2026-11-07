/**
 * The `session` / `join` row's join metadata (plans/29 "Native join metadata"): every field of `Player:GetJoinData()`
 * and the player facts, as props. The engine reads the data (enum values as their names, the TeleportData's JSON size,
 * other players' pids looked up beforehand) and this builds the props.
 *
 * Privacy: no other player's UserId ever lands in a prop. Referrer, followed user and party members become pids (the
 * game's pseudonymous ids) when this game knows them, else "other" (ref / follow) or nothing (party_pids).
 *
 * Pure: no imports and no services, so it runs under Lune (scripts/test-analytics-join.luau).
 */

/** What the engine reads from GetJoinData (enums already turned into names). */
export interface JoinDataLike {
	SourcePlaceId?: number;
	SourceGameId?: number;
	ReferredByPlayerId?: number;
	Members?: number[];
	/** Whether TeleportData was present (its content never leaves the server). */
	HasTeleportData?: boolean;
	LaunchData?: string;
	GameJoinContext?: {
		JoinSource?: string;
		ItemType?: string;
		AssetId?: string;
		OutfitId?: string;
		AssetType?: string;
	};
}

/** The joining player and this server. */
export interface JoinFacts {
	userId: number;
	/** game.GameId (a teleport from another game is `teleport_game`). */
	gameId: number;
	followUserId: number;
	/** Player.AccountAge (days). */
	accountAge: number;
	locale?: string;
	verified?: boolean;
	/** Enum.MembershipType name. */
	membership?: string;
	/** The TeleportData's JSON size in bytes (undefined: none or not encodable). */
	tpBytes?: number;
}

/** The launch data's verdict (notifications/token.ts verifyToken): undefined when it isn't a TypeTorch token. */
export type LaunchVerdict = { ok: true; nid: string; kind: string } | { ok: false; why: string } | undefined;

export interface JoinOptions {
	/**
	 * Keep the first LAUNCH_KEEP chars of the game's own launch data in `launch` (the analytics settings'
	 * `joinLaunchPrefix`, default off: launch data can carry anything a link maker put there). `launch_len` is always kept.
	 */
	launchPrefix?: boolean;
	/**
	 * The analytics settings' `joinData` (plans/30). "off": only what the join row carried before plans/29 (`from`,
	 * `ctx`, `tp`, `party`; the engine adds age, prem, country, friends, ret). "full" / "summary": every summary prop.
	 */
	mode?: JoinDataMode;
}

/** `joinData` (plans/30): "full" (default: the summary props + `jd`), "summary" (no `jd`), "off" (see JoinOptions.mode). */
export type JoinDataMode = "full" | "summary" | "off";
export const JOIN_DATA_MODES: ReadonlyArray<JoinDataMode> = ["full", "summary", "off"];
/** The props the join row had before plans/29 (joinData "off" keeps only these from joinProps). */
const LEGACY_PROPS = ["from", "ctx", "tp", "party"];

/** Party pids kept at most. */
export const PARTY_PIDS_MAX = 10;
/** The game's own launch data: this many characters are kept. */
export const LAUNCH_KEEP = 32;

/** UserIds whose pids the row wants (referrer, followed user, party members), without the player and duplicates. */
export function wantedUserIds(data: JoinDataLike | undefined, facts: JoinFacts): number[] {
	const seen = new Set<number>();
	const list = new Array<number>();
	const add = (userId: unknown) => {
		if (!typeIs(userId, "number") || userId <= 0 || userId === facts.userId || seen.has(userId)) return;
		seen.add(userId);
		list.push(userId);
	};
	add(data?.ReferredByPlayerId);
	add(facts.followUserId);
	if (data?.Members !== undefined) for (const member of data.Members) add(member);
	return list;
}

/**
 * The join props. `pidOf(userId)` answers a known pid (a player in this server, or one this game's records know) or
 * undefined.
 */
export function joinProps(
	data: JoinDataLike | undefined,
	facts: JoinFacts,
	pidOf: (userId: number) => string | undefined,
	launch: LaunchVerdict,
	options: JoinOptions = {},
): Record<string, unknown> {
	const info: Record<string, unknown> = {};
	let from = "direct";
	const mapped = (userId: number) => pidOf(userId) ?? "other";
	if (data !== undefined) {
		if (data.SourcePlaceId !== undefined && data.SourcePlaceId !== 0) {
			from = data.SourceGameId !== undefined && data.SourceGameId !== facts.gameId ? "teleport_game" : "teleport";
			info.src_place = data.SourcePlaceId;
			if (data.SourceGameId !== undefined && data.SourceGameId !== 0) info.src_game = data.SourceGameId;
		} else if (data.ReferredByPlayerId !== undefined && data.ReferredByPlayerId !== 0) from = "referral";
		// TODO(S6): GameJoinContext.JoinSource may name a notification tap too (an unsigned second signal); only the
		// verified token decides `from = "notification"` until the spike says what Roblox sends.
		else if (launch !== undefined && launch.ok) from = "notification";
		else if (data.LaunchData !== undefined && data.LaunchData !== "") from = "share";
		if (data.ReferredByPlayerId !== undefined && data.ReferredByPlayerId > 0) info.ref = mapped(data.ReferredByPlayerId);

		const context = data.GameJoinContext;
		if (context !== undefined) {
			if (context.JoinSource !== undefined) info.ctx = context.JoinSource;
			if (context.ItemType !== undefined) info.ctx_item = context.ItemType;
			if (context.AssetId !== undefined && context.AssetId !== "") info.ctx_asset = context.AssetId;
			if (context.OutfitId !== undefined && context.OutfitId !== "") info.ctx_outfit = context.OutfitId;
			if (context.AssetType !== undefined) info.ctx_asset_type = context.AssetType;
		}
		if (data.HasTeleportData === true) {
			info.tp = true;
			if (facts.tpBytes !== undefined) info.tp_bytes = facts.tpBytes;
		}
		const members = data.Members;
		if (members !== undefined && members.size() > 0) {
			info.party = members.size();
			const pids = new Array<string>();
			for (const member of members) {
				if (member === facts.userId || pids.size() >= PARTY_PIDS_MAX) continue;
				const pid = pidOf(member);
				if (pid !== undefined && !pids.includes(pid)) pids.push(pid);
			}
			if (pids.size() > 0) info.party_pids = pids;
		}
		const launchData = data.LaunchData;
		if (launch !== undefined) {
			if (launch.ok) {
				info.launch = "notification";
				info.nid = launch.nid;
				info.nk = launch.kind;
			} else {
				info.launch = "tt_bad";
				info.launch_bad = launch.why;
			}
		} else if (launchData !== undefined && launchData !== "") {
			if (options.launchPrefix === true) info.launch = launchData.sub(1, LAUNCH_KEEP);
			info.launch_len = launchData.size();
		}
	}
	if (from === "direct" && facts.followUserId !== 0) from = "follow";
	if (facts.followUserId > 0) info.follow = mapped(facts.followUserId);
	info.from = from;
	info.age_days = math.max(0, math.floor(facts.accountAge));
	if (facts.locale !== undefined && facts.locale !== "") info.locale = facts.locale;
	if (facts.verified !== undefined) info.verified = facts.verified;
	if (facts.membership !== undefined) info.membership = facts.membership;
	if (options.mode === "off") {
		const legacy: Record<string, unknown> = {};
		for (const name of LEGACY_PROPS) if (info[name] !== undefined) legacy[name] = info[name];
		return legacy;
	}
	return info;
}

// The raw join data: `jd` (plans/30) -----------------------------------------------------------------------------------

/** Bytes of the `jd` JSON at most (props hold 4 KB; the join row's other props stay well under the rest). */
export const JD_MAX_BYTES = 1024;
/** LaunchData bytes kept (Roblox's own limit for launch data). */
export const JD_LAUNCH_MAX = 200;
/** TeleportData: top-level keys listed at most, and characters per key. */
export const JD_TP_KEYS_MAX = 20;
export const JD_KEY_CHARS = 32;
/** GameJoinContext values are cut to this when `jd` is over the cap. */
export const JD_CONTEXT_CUT = 64;

/** GetJoinData's keys this builder knows; anything else is reported by type only (`other`). */
const KNOWN_KEYS = new Set(["LaunchData", "SourcePlaceId", "SourceGameId", "GameJoinContext", "TeleportData", "Members", "ReferredByPlayerId"]);

/** The value's type name: `typeof` in game (Instance, EnumItem, Vector3 ...), the Lua type under Lune. */
function typeName(value: unknown): string {
	return typeOf(value);
}

/** `text` cut to at most `max` bytes without splitting a UTF-8 sequence. */
export function cutUtf8(text: string, max: number): string {
	if (text.size() <= max) return text;
	let size = math.max(0, max);
	// A continuation byte (10xxxxxx) right after the cut means the cut splits a character: step back to its lead byte.
	while (size > 0) {
		const [following] = string.byte(text, size + 1);
		if (following === undefined || bit32.band(following, 0xc0) !== 0x80) break;
		size -= 1;
	}
	return text.sub(1, size);
}

/** A GameJoinContext field as text: EnumItems by `.Name`, strings as they are, everything else by tostring / its type. */
function fieldText(value: unknown): string {
	if (typeIs(value, "EnumItem")) return value.Name;
	if (typeIs(value, "string")) return value;
	if (typeIs(value, "number") || typeIs(value, "boolean")) return tostring(value);
	return typeName(value);
}

function sortedStringKeys(value: object): string[] {
	const keys = new Array<string>();
	for (const [key] of pairs(value)) if (typeIs(key, "string")) keys.push(key);
	keys.sort();
	return keys;
}

interface JdTeleport {
	bytes?: number;
	type: string;
	keys?: string[];
}

interface JdMembers {
	count: number;
	pids?: string[];
}

/** The `jd` value (see plans/30-join-data-raw.md for the shape). */
export interface JoinDataJson {
	keys: string[];
	LaunchData?: string;
	LaunchDataLen?: number;
	SourcePlaceId?: number;
	SourceGameId?: number;
	GameJoinContext?: Record<string, string>;
	TeleportData?: JdTeleport;
	Members?: JdMembers;
	ReferredByPlayerId?: string;
	FollowUserId?: string;
	other?: Record<string, string>;
	trunc?: boolean;
}

/**
 * `Player:GetJoinData()` field by field, privacy-safe (plans/30): the launch data (200 bytes), place / game ids, the
 * join context as text, the TeleportData's size, type and top-level keys (never its content), Members / referrer /
 * followed user as pids from `pidOf` (the same lookups as the summary props) else "other", and unknown keys by type
 * only. At most JD_MAX_BYTES of JSON as `encodeJoinData` writes it (`encode`: HttpService.JSONEncode in game, only to
 * size the TeleportData; `quote`: a string as JSON), cut in the plan's order with `trunc`. Not a table (GetJoinData
 * failed): undefined.
 */
export function joinDataJson(
	raw: unknown,
	followUserId: number,
	pidOf: (userId: number) => string | undefined,
	encode: (value: unknown) => string,
	quote: (text: string) => string,
): JoinDataJson | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const data = raw as Record<string, unknown>;
	const keys = new Array<string>();
	for (const [key] of pairs(data)) keys.push(typeIs(key, "string") ? key.sub(1, JD_KEY_CHARS) : typeName(key));
	keys.sort();
	const jd: JoinDataJson = { keys };
	const mapped = (userId: number) => pidOf(userId) ?? "other";
	const other: Record<string, string> = {};
	let others = 0;

	for (const [key, value] of pairs(data)) {
		if (!typeIs(key, "string") || !KNOWN_KEYS.has(key)) {
			other[typeIs(key, "string") ? key.sub(1, JD_KEY_CHARS) : typeName(key)] = typeName(value);
			others += 1;
		}
	}
	const launch = data.LaunchData;
	if (launch !== undefined) {
		if (typeIs(launch, "string")) {
			jd.LaunchData = cutUtf8(launch, JD_LAUNCH_MAX);
			jd.LaunchDataLen = launch.size();
		} else {
			other.LaunchData = typeName(launch);
			others += 1;
		}
	}
	for (const name of ["SourcePlaceId", "SourceGameId"] as const) {
		const value = data[name];
		if (value === undefined) continue;
		if (typeIs(value, "number")) jd[name] = value;
		else {
			other[name] = typeName(value);
			others += 1;
		}
	}
	const context = data.GameJoinContext;
	if (context !== undefined) {
		if (typeIs(context, "table")) {
			const fields: Record<string, string> = {};
			for (const [name, value] of pairs(context as object)) fields[typeIs(name, "string") ? name.sub(1, JD_KEY_CHARS) : typeName(name)] = fieldText(value);
			jd.GameJoinContext = fields;
		} else {
			other.GameJoinContext = typeName(context);
			others += 1;
		}
	}
	const teleport = data.TeleportData;
	if (teleport !== undefined) {
		const info: JdTeleport = { type: typeName(teleport) };
		const [encodedOk, encoded] = pcall(() => encode(teleport));
		if (encodedOk && typeIs(encoded, "string")) info.bytes = encoded.size();
		if (typeIs(teleport, "table")) {
			const names = sortedStringKeys(teleport as object);
			const cut = new Array<string>();
			for (const name of names) {
				if (cut.size() >= JD_TP_KEYS_MAX) break;
				cut.push(name.sub(1, JD_KEY_CHARS));
			}
			info.keys = cut;
		}
		jd.TeleportData = info;
	}
	const members = data.Members;
	if (members !== undefined) {
		if (typeIs(members, "table")) {
			const pids = new Array<string>();
			let count = 0;
			for (const [, member] of pairs(members as object)) {
				count += 1;
				pids.push(typeIs(member, "number") ? mapped(member) : "other");
			}
			jd.Members = { count, pids };
		} else {
			other.Members = typeName(members);
			others += 1;
		}
	}
	const referrer = data.ReferredByPlayerId;
	if (typeIs(referrer, "number")) {
		if (referrer > 0) jd.ReferredByPlayerId = mapped(referrer);
	} else if (referrer !== undefined) {
		other.ReferredByPlayerId = typeName(referrer);
		others += 1;
	}
	if (followUserId > 0) jd.FollowUserId = mapped(followUserId);
	if (others > 0) jd.other = other;
	return capJoinData(jd, quote);
}

function jsonNumber(value: number): string {
	if (value === value && value % 1 === 0 && math.abs(value) < 2 ** 53) return string.format("%d", value);
	return value === value && math.abs(value) !== math.huge ? string.format("%.17g", value) : "null";
}

function jsonStrings(list: string[], quote: (text: string) => string): string {
	return `[${list.map((item) => quote(item)).join(",")}]`;
}

function jsonObject(value: Record<string, string>, quote: (text: string) => string): string {
	const names = sortedStringKeys(value);
	return `{${names.map((name) => `${quote(name)}:${quote(value[name])}`).join(",")}}`;
}

/**
 * `jd` as JSON text, field order fixed. Written here rather than by HttpService.JSONEncode, which turns an empty table
 * into `[]`: the plan's `GameJoinContext: {}` (present but empty, the evidence case) stays an object, and lists stay
 * lists.
 */
export function encodeJoinData(jd: JoinDataJson, quote: (text: string) => string): string {
	const parts = new Array<string>();
	parts.push(`"keys":${jsonStrings(jd.keys, quote)}`);
	if (jd.LaunchData !== undefined) parts.push(`"LaunchData":${quote(jd.LaunchData)}`);
	if (jd.LaunchDataLen !== undefined) parts.push(`"LaunchDataLen":${jsonNumber(jd.LaunchDataLen)}`);
	if (jd.SourcePlaceId !== undefined) parts.push(`"SourcePlaceId":${jsonNumber(jd.SourcePlaceId)}`);
	if (jd.SourceGameId !== undefined) parts.push(`"SourceGameId":${jsonNumber(jd.SourceGameId)}`);
	if (jd.GameJoinContext !== undefined) parts.push(`"GameJoinContext":${jsonObject(jd.GameJoinContext, quote)}`);
	const teleport = jd.TeleportData;
	if (teleport !== undefined) {
		const fields = new Array<string>();
		if (teleport.bytes !== undefined) fields.push(`"bytes":${jsonNumber(teleport.bytes)}`);
		fields.push(`"type":${quote(teleport.type)}`);
		if (teleport.keys !== undefined) fields.push(`"keys":${jsonStrings(teleport.keys, quote)}`);
		parts.push(`"TeleportData":{${fields.join(",")}}`);
	}
	const members = jd.Members;
	if (members !== undefined) {
		const pids = members.pids !== undefined ? `,"pids":${jsonStrings(members.pids, quote)}` : "";
		parts.push(`"Members":{"count":${jsonNumber(members.count)}${pids}}`);
	}
	if (jd.ReferredByPlayerId !== undefined) parts.push(`"ReferredByPlayerId":${quote(jd.ReferredByPlayerId)}`);
	if (jd.FollowUserId !== undefined) parts.push(`"FollowUserId":${quote(jd.FollowUserId)}`);
	if (jd.other !== undefined) parts.push(`"other":${jsonObject(jd.other, quote)}`);
	if (jd.trunc === true) parts.push(`"trunc":true`);
	return `{${parts.join(",")}}`;
}

/**
 * Cuts `jd` to JD_MAX_BYTES of JSON, in the plan's order: TeleportData.keys (then the field), Members.pids (then the
 * field), LaunchData (shorter), GameJoinContext values (each to 64), `other` (entry by entry); `trunc: true` once cut.
 * Still over (an absurd join context): only `keys` (shortened), the ids, LaunchDataLen and `trunc` stay.
 */
export function capJoinData(jd: JoinDataJson, quote: (text: string) => string): JoinDataJson {
	const bytes = () => encodeJoinData(jd, quote).size();
	const over = () => bytes() > JD_MAX_BYTES;
	if (!over()) return jd;
	jd.trunc = true;
	const teleport = jd.TeleportData;
	if (teleport && teleport.keys) {
		while (teleport.keys.size() > 0 && over()) teleport.keys.pop();
		if (over()) teleport.keys = undefined;
	}
	const members = jd.Members;
	if (members && members.pids && over()) {
		while (members.pids.size() > 0 && over()) members.pids.pop();
		if (over()) members.pids = undefined;
	}
	if (jd.LaunchData !== undefined && over()) {
		let size = jd.LaunchData.size();
		while (size > 0 && over()) {
			size = math.max(0, size - math.max(8, math.min(64, bytes() - JD_MAX_BYTES)));
			jd.LaunchData = cutUtf8(jd.LaunchData!, size);
			size = jd.LaunchData.size();
		}
	}
	const context = jd.GameJoinContext;
	if (context && over()) for (const [name, value] of pairs(context)) context[name] = cutUtf8(value, JD_CONTEXT_CUT);
	const other = jd.other;
	if (other && over()) {
		for (const [name] of pairs(other)) {
			if (!over()) break;
			other[name] = undefined as unknown as string;
		}
		if (next(other)[0] === undefined) jd.other = undefined;
	}
	if (!over()) return jd;
	const minimal: JoinDataJson = {
		keys: [],
		LaunchDataLen: jd.LaunchDataLen,
		SourcePlaceId: jd.SourcePlaceId,
		SourceGameId: jd.SourceGameId,
		trunc: true,
	};
	for (const key of jd.keys) {
		if (minimal.keys.size() >= 16) break;
		minimal.keys.push(key);
	}
	return minimal;
}
