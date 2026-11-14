import { HttpService } from "@rbxts/services";
import { $warn } from "rbxts-transform-debug";
import { builtinRowWriter, builtinSession } from "../analytics/rows";
import { PROPS_MAX_BYTES } from "../analytics/schema";
import { playerState, type PlayerState } from "../runtime/player-state";
import { currentSettings } from "../settings";
import type { Feedback, FeedbackConfig, FeedbackInput, FeedbackResult, FeedbackScale } from "./api";
import { buildFeedbackProps, rateAllows, rateRecord, resolveFeedbackConfig, type FeedbackProps, type RateState, type ResolvedFeedbackConfig } from "./core";

/** The playerState store of accepted submits (removed when the player leaves; kept across swaps). */
export const RATE_STORE = "__typetorch/feedback.rate.v1";

const OK: FeedbackResult = { ok: true };

function refuse(reason: Exclude<FeedbackResult, { ok: true }>["reason"]): FeedbackResult {
	return { ok: false, reason };
}

function encodedSize(props: FeedbackProps): number {
	const [ok, text] = pcall(() => HttpService.JSONEncode(props));
	return ok ? text.size() : math.huge;
}

/**
 * `TypeTorch.feedback()` on the server (plans/32): the config from the settings record's `game.feedback` (live), else
 * the game's `configure`, else the defaults; the rate windows per player (playerState: kept across swaps, gone when
 * the player leaves); one `feedback` / `submit` row through the analytics engine (analytics/rows.ts).
 */
export class FeedbackServer implements Feedback {
	private codeConfig: ResolvedFeedbackConfig | undefined;
	/** The last settings value read and what it resolved to (undefined: invalid, warned). */
	private recordCache: { raw: unknown; config: ResolvedFeedbackConfig | undefined } | undefined;
	private readonly rates: PlayerState<RateState>;

	constructor(private readonly clock: () => number = os.clock) {
		this.rates = playerState<RateState>(RATE_STORE, () => ({ times: [] }));
	}

	configure(config: FeedbackConfig) {
		this.codeConfig = resolveFeedbackConfig(config);
	}

	/** The config in effect, or undefined when the record's value is invalid (feedback is then disabled). */
	private config(): ResolvedFeedbackConfig | undefined {
		const record = currentSettings()?.game;
		const raw = record !== undefined ? record.feedback : undefined;
		if (raw === undefined) return this.codeConfig ?? resolveFeedbackConfig(undefined);
		const cache = this.recordCache;
		if (cache && cache.raw === raw) return cache.config;
		const [ok, result] = pcall(() => resolveFeedbackConfig(raw));
		if (!ok) warn(`[TypeTorch] feedback is disabled: the settings record's game.feedback is invalid: ${result}`);
		this.recordCache = { raw, config: ok ? result : undefined };
		return this.recordCache.config;
	}

	scale(): FeedbackScale | undefined {
		const config = this.config();
		if (!config || !config.enabled) return undefined;
		const scale = config.scale;
		return { id: scale.id, type: scale.type, steps: scale.steps, labels: scale.labels ? [...scale.labels] : undefined };
	}

	submit(player: Player, input: FeedbackInput): FeedbackResult {
		const config = this.config();
		if (!config || !config.enabled) return refuse("disabled");
		const writer = builtinRowWriter();
		const session = typeIs(player, "Instance") && player.IsA("Player") ? builtinSession(player) : undefined;
		if (!writer || !session) return refuse("no_session");
		const safe: FeedbackInput = typeIs(input, "table") ? input : {};
		const built = buildFeedbackProps(config, safe, session.playSeconds, encodedSize, PROPS_MAX_BYTES);
		if ("reason" in built) {
			if (built.reason === "bad_rating") $warn(`[TypeTorch] feedback: rating ${tostring(safe.rating)} is not in the scale ${config.scale.id}`);
			return refuse(built.reason);
		}
		if (safe.topic !== undefined && built.props.topic === undefined) $warn(`[TypeTorch] feedback: topic dropped (1-32 of [a-z0-9_])`);
		const rate = this.rates.get(player);
		const now = this.clock();
		if (!rateAllows(rate, now, config.perMinute, config.perDay)) return refuse("rate_limited");
		rateRecord(rate, now);
		writer(player, "feedback", "submit", built.props);
		return OK;
	}
}
