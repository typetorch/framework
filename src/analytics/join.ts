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
}

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
	return info;
}
