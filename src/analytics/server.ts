import {
	CollectionService,
	DataStoreService,
	HttpService,
	LocalizationService,
	Players,
	RunService,
	Stats,
	Workspace,
} from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { KernelSettings, ServerKernel } from "../kernel";
import { maybeServerDispatcher } from "../net/runtime";
import { observePlayers } from "../players";
import { currentSettings, onSettings, settingsSupported } from "../settings";
import { closeHooksSupported, onGenerationClose, TypeTorch, type GenerationScope } from "../typetorch";
import { toBase64 } from "./codec";
import { encodeProps, scrubNames } from "./props";
import { assignVariant, inShare, isExperimentName, isVariantList } from "./experiments";
import {
	CHANNEL,
	CHUNK_MAX_BYTES,
	CLIENT_BATCH_MAX,
	cleanClientEvent,
	cleanHello,
	isEventName,
	type HelloInfo,
	type ServerHello,
} from "./protocol";
import { backoffSeconds, classifyStatus, newQueueState, RowQueue, takeToken, type BucketState, type QueueState } from "./queue";
import {
	RECORDING_CODEC,
	SCHEMA_VERSION,
	type AnalyticsOptions,
	type AnalyticsProps,
	type AnalyticsStats,
	type DeployReport,
	type DeviceKind,
	type EventKind,
	type EventRow,
	type ExperimentOverride,
	type FleetStatus,
	type IdentityRow,
	type RecordingRow,
	type ResolvedSettings,
} from "./schema";
import { identityTarget, parseSettings, recordsSupported, DEFAULT_TECH_EVERY, type ParsedSettings } from "./settings";
import { buildRequests, estimateEventBytes, estimateRecordingBytes, type SinkRequest } from "./sinks";

/**
 * The server half of the analytics engine (plans/16): player ids, sessions, the automatic collectors (joins, tech
 * health, zones), client intake and the sinks. One per generation, shared by every `new AnalyticsEngine()`. Everything
 * that must survive a hot swap (the queue, sessions, counters) is plain data in the kernel's persist store.
 */

const PERSIST_KEY = "__typetorch/analytics.v1";
const CLOSE_KEY = "__typetorch/analytics-close";
/** The DataStore with the UserId -> pid link: key `p/<UserId>` -> { pid, first, last } (unix seconds). */
const PLAYER_STORE = "TypeTorchAnalytics";

const EVENTS_CAP = 10000;
/** While no settings are known, keep only the newest rows. */
const EVENTS_CAP_UNCONFIGURED = 1000;
const RECORDINGS_CAP = 300;
/** Fleet rows (kernel heartbeats, deploy reports) queue apart from analytics events and are sent first. */
const FLEET_CAP = 2000;
/** Deploy reports already sent, by (s, j, r), remembered across generations. */
const FLEET_SEEN_MAX = 200;
const HEARTBEAT_EVERY = 60;
const HEARTBEAT_JITTER = 10;
const BATCH_ROWS = 500;
const BATCH_RECORDINGS = 50;
const BATCH_BYTES = 900000;
/** HTTP budget: a burst of 3, refilled at 10 a minute (Roblox: 500 a minute per server for everything). */
const HTTP_BURST = 3;
const HTTP_PER_MINUTE = 10;
/** Identity rows (pid -> UserId) waiting; past this the oldest go. */
const IDENTITIES_CAP = 500;
const BATCH_IDENTITIES = 200;
/** Rows kept per player while their pid loads. */
const PENDING_MAX = 200;
/** Client events: burst and refill per minute, and the most per session. */
const CLIENT_BURST = 120;
const CLIENT_PER_MINUTE = 120;
const CLIENT_SESSION_MAX = 5000;
/**
 * Distinct experiments one session may hold. Each one is re-encoded into `exp` and stamped on every later row, and a
 * client can name experiments ("exp" messages), so without a cap one player could grow `exp` past the ingest limit
 * (1 KB) and have every row of theirs dropped, or spend the server's time re-encoding it.
 */
const EXPERIMENTS_MAX = 32;
/** Friend-list pages read per join for the join's `friends` (one web call each; most players fit on the first). */
const FRIEND_PAGES_MAX = 10;
/** A recording: at most this many bytes, chunks and seconds after the join. */
const RECORDING_MAX_BYTES = 262144;
const RECORDING_MAX_CHUNKS = 80;
const RECORDING_MAX_SECONDS = 900;
/** The join event waits this long for the client's device info. */
const DEVICE_WAIT = 8;
const ZONE_INTERVAL = 0.5;
const ZONE_TAG = "TTZone";

interface RecordingState {
	/** Decided: recorded or not. */
	decided: boolean;
	on: boolean;
	started: boolean;
	ended: boolean;
	/** Next chunk index expected. */
	chunk: number;
	bytes: number;
}

/** One player's session. Plain data (persist), keyed by tostring(UserId). */
interface PlayerSession {
	pid: string;
	sid: string;
	/** The pid is known (the DataStore read finished). */
	ready: boolean;
	/** The pid is temporary: the DataStore read failed. */
	temp: boolean;
	/** The pid this server created for a first visit (kept so a swap mid-lookup still knows it's a first visit). */
	created?: string;
	newp: boolean;
	/** Days since the last visit, -1 for a first visit or when unknown. */
	ret: number;
	/** Unix seconds of the first visit (the DataStore record). */
	first: number;
	/** Unix ms of the join. */
	joinedAt: number;
	joined: boolean;
	left: boolean;
	dev: DeviceKind;
	device?: HelloInfo;
	zone: string;
	zoneSince: number;
	screen: string;
	activity?: string;
	/** Active experiments: name -> variant. */
	exp: Map<string, string>;
	expJson: string;
	stateText: string;
	pending: EventRow[];
	rec: RecordingState;
	clientEvents: number;
}

interface ServerStore {
	events: QueueState<EventRow>;
	recordings: QueueState<RecordingRow>;
	/** Kind "fleet" rows: their own queue, sent before `events`, so the events cap never drops them. */
	fleet: QueueState<EventRow>;
	/** Deploy report keys `s|j|r` already queued, oldest first (at most FLEET_SEEN_MAX). */
	fleetSeen: string[];
	/** Rows of a request that was running when the last generation stopped (sent again: at least once). */
	inflightEvents: EventRow[];
	inflightRecordings: RecordingRow[];
	/** Identity rows waiting to be sent, and those of a request running when the last generation stopped. */
	identities?: IdentityRow[];
	inflightIdentities?: IdentityRow[];
	budget: BucketState;
	failures: number;
	sent: number;
	rejected: number;
	lastError?: string;
	players: Map<string, PlayerSession>;
	/** os.time() of the last swap, for "left within 60 s of a swap". */
	lastSwapAt?: number;
	/** Generation whose start was logged. */
	logged?: number;
	/** Server-wide activity (`state(name)` without a player). */
	activity?: string;
}

interface CloseRelay {
	event?: BindableEvent;
	/** The generation listening (0 = none). */
	listening: number;
	done: boolean;
}

interface PlayerRecord {
	pid: string;
	first: number;
	last: number;
}

function nowMs(): number {
	return DateTime.now().UnixTimestampMillis;
}

function newId(): string {
	return HttpService.GenerateGUID(false).gsub("%-", "")[0].lower();
}

function quote(text: string): string {
	return HttpService.JSONEncode(text);
}

function decode(text: string): unknown {
	return HttpService.JSONDecode(text);
}

function ageBucket(days: number): string {
	if (days < 1) return "<1d";
	if (days < 7) return "1-7d";
	if (days < 30) return "7-30d";
	if (days < 90) return "30-90d";
	if (days < 365) return "90-365d";
	if (days < 1095) return "1-3y";
	return "3y+";
}

/** Whether this generation runs inside `typetorch test --cloud` (cli/src/cloudtest.ts: stub kernel `test = true`, attribute). */
function isCloudTest(kernel: ServerKernel | undefined): boolean {
	if ((kernel as unknown as { test?: unknown } | undefined)?.test === true) return true;
	const [ok, flag] = pcall(() => Workspace.GetAttribute("TypeTorchTest"));
	return ok && flag === true;
}

function newSession(): PlayerSession {
	return {
		pid: "",
		sid: newId(),
		ready: false,
		temp: false,
		newp: false,
		ret: -1,
		first: 0,
		joinedAt: nowMs(),
		joined: false,
		left: false,
		dev: "unknown",
		zone: "",
		zoneSince: 0,
		screen: "",
		exp: new Map(),
		expJson: "{}",
		stateText: "",
		pending: [],
		rec: { decided: false, on: false, started: false, ended: false, chunk: 0, bytes: 0 },
		clientEvents: 0,
	};
}

function newStore(): ServerStore {
	return {
		events: newQueueState(),
		recordings: newQueueState(),
		fleet: newQueueState(),
		fleetSeen: [],
		inflightEvents: [],
		inflightRecordings: [],
		identities: [],
		inflightIdentities: [],
		budget: { tokens: HTTP_BURST, last: os.clock() },
		failures: 0,
		sent: 0,
		rejected: 0,
		players: new Map(),
	};
}

interface Zone {
	instance: Instance;
	name: string;
}

export class ServerAnalytics {
	private readonly store: ServerStore;
	private readonly events: RowQueue<EventRow>;
	private readonly recordings: RowQueue<RecordingRow>;
	private readonly fleet: RowQueue<EventRow>;
	private readonly sessions = new Map<Player, PlayerSession>();
	private readonly helloWaiting = new Set<Player>();
	private readonly clientBudgets = new Map<Player, BucketState>();
	private readonly lastChunkAt = new Map<Player, number>();
	private readonly errors = new Map<string, number>();
	private readonly zones = new Map<Instance, Zone>();
	private readonly kernel?: ServerKernel;
	private settings?: ResolvedSettings;
	private settingsErrors = new Array<string>();
	/** The first settings read finished (found or not), so experiment overrides are as known as they get. */
	private settingsTried = false;
	/** The settings' `fleet` value (Basin games send identities to the fleet API). */
	private fleetSettings?: unknown;
	private nextFlushAt = 0;
	private backoffUntil = 0;
	private batchRows = BATCH_ROWS;
	private lastWarnAt = -math.huge;
	private flushing = false;
	private closing = false;
	private readonly identity: { job: string; srv: string; place: number; art: string; seq: number; branch: string; channel: string };
	private sexp = "";
	private stopped = false;
	/**
	 * `typetorch test --cloud`: the payload boots headless in a Luau Execution task, where HttpService works. The engine
	 * then collects as usual but sends nothing (no rows, no identity rows, no HTTP), or every prod deploy would put a
	 * fake server session into the owner's analytics. Set by the stub kernel's `test` or the TypeTorchTest attribute.
	 */
	private readonly testMode: boolean;

	constructor(
		private readonly options: AnalyticsOptions,
		scope: GenerationScope,
		private readonly trove: Trove,
	) {
		this.kernel = scope.server;
		this.testMode = isCloudTest(scope.server);
		this.store = TypeTorch.persist(PERSIST_KEY, newStore);
		this.events = new RowQueue(this.store.events, EVENTS_CAP_UNCONFIGURED);
		this.recordings = new RowQueue(this.store.recordings, RECORDINGS_CAP);
		this.fleet = new RowQueue(this.store.fleet, FLEET_CAP);
		const artifact = TypeTorch.artifact;
		this.identity = {
			job: game.JobId,
			srv: TypeTorch.serverType,
			place: game.PlaceId,
			art: artifact.id,
			seq: artifact.seq ?? 0,
			branch: TypeTorch.branch,
			channel: TypeTorch.channel,
		};
		this.sexp = this.serverExperiment();

		// A request that was running when the last generation stopped: send its rows again.
		if (this.store.inflightEvents.size() > 0) this.requeueEvents(this.store.inflightEvents);
		if (this.store.inflightRecordings.size() > 0) this.recordings.requeue(this.store.inflightRecordings);
		// Stores from before identities existed (a hot swap from an older framework) have neither list.
		if (this.store.identities === undefined) this.store.identities = [];
		const handedOver = this.store.inflightIdentities ?? [];
		if (handedOver.size() > 0) this.requeueIdentities(handedOver);
		this.store.inflightIdentities = [];
		this.store.inflightEvents = [];
		this.store.inflightRecordings = [];

		trove.add(() => {
			this.stopped = true;
		});
		if (this.testMode) print("[analytics] cloud test: rows are collected but nothing is sent (no uploads, no identity rows)");
		this.startSettings();
		this.startIntake();
		this.startSessions();
		if (options.tech !== false) this.startTech();
		if (options.zones !== false) this.startZones();
		if (options.fleet !== false) this.startFleet();
		this.startFlushing();
		this.startClose();
	}

	// Identity and rows ------------------------------------------------------------------------------------------------

	private serverExperiment(): string {
		const kernel = this.kernel;
		if (!kernel || !typeIs((kernel as unknown as Record<string, unknown>).experiment, "function")) return "";
		const [ok, info] = pcall(() => kernel.experiment!());
		return ok && info !== undefined ? info.artifactId : "";
	}

	private stateOf(session: PlayerSession | undefined): string {
		const parts = new Array<string>();
		if (session && session.zone !== "") parts.push(`zone:${session.zone}`);
		if (session && session.screen !== "") parts.push(`screen:${session.screen}`);
		const activity = session?.activity ?? this.store.activity;
		if (activity !== undefined && activity !== "") parts.push(`activity:${activity}`);
		return parts.join("|");
	}

	private refreshState(session: PlayerSession) {
		session.stateText = this.stateOf(session);
	}

	/** Builds a row stamped with the identity and the player's session, and queues it (or holds it until the pid). */
	emit(session: PlayerSession | undefined, kind: EventKind, name: string, props: string, src: "server" | "client" = "server", t?: number) {
		if (this.stopped) return;
		const id = this.identity;
		const row: EventRow = {
			v: SCHEMA_VERSION,
			t: t ?? nowMs(),
			kind,
			name,
			pid: session?.pid ?? "",
			sid: session?.sid ?? "",
			job: id.job,
			srv: id.srv,
			place: id.place,
			art: id.art,
			seq: id.seq,
			branch: id.branch,
			channel: id.channel,
			dev: session?.dev ?? "unknown",
			newp: session?.newp ?? false,
			state: session ? session.stateText : this.stateOf(undefined),
			exp: session?.expJson ?? "{}",
			sexp: this.sexp,
			src,
			props,
		};
		if (session && !session.ready) {
			if (session.pending.size() < PENDING_MAX) session.pending.push(row);
			return;
		}
		this.events.push(row);
	}

	/** Puts events-table rows back: fleet rows to their own queue, the rest to `events`. */
	private requeueEvents(rows: EventRow[]) {
		const fleet = new Array<EventRow>();
		const events = new Array<EventRow>();
		for (const row of rows) (row.kind === "fleet" ? fleet : events).push(row);
		this.fleet.requeue(fleet);
		this.events.requeue(events);
	}

	/** A "fleet" row (server-only, src server) on the fleet queue. */
	private emitFleet(name: string, props: object) {
		if (this.stopped) return;
		const id = this.identity;
		this.fleet.push({
			v: SCHEMA_VERSION,
			t: nowMs(),
			kind: "fleet",
			name,
			pid: "",
			sid: "",
			job: id.job,
			srv: id.srv,
			place: id.place,
			art: id.art,
			seq: id.seq,
			branch: id.branch,
			channel: id.channel,
			dev: "unknown",
			newp: false,
			state: this.stateOf(undefined),
			exp: "{}",
			sexp: this.sexp,
			src: "server",
			props: encodeProps(props),
		});
	}

	/** The player's session; created now if game code is faster than the engine's own join handler. */
	sessionOf(player: Player): PlayerSession | undefined {
		const session = this.sessions.get(player);
		if (session || this.stopped || player.Parent !== Players) return session;
		this.onPlayer(player);
		return this.sessions.get(player);
	}

	/** Game code's events. `player` undefined: a server-only event (no pid). */
	track(player: Player | undefined, kind: EventKind, name: string, props?: object) {
		if (!isEventName(name)) {
			$warn(`[analytics] ${kind} event name must be 1-64 characters: ${tostring(name).sub(1, 80)}`);
			return;
		}
		const session = player ? this.sessionOf(player) : undefined;
		if (player && !session) return;
		this.emit(session, kind, name, encodeProps(props));
	}

	/** Activity: per player, or server-wide (every player without their own) when `player` is undefined. */
	setActivity(player: Player | undefined, activity: string | undefined) {
		if (activity !== undefined && !isEventName(activity)) return;
		if (player) {
			const session = this.sessionOf(player);
			if (!session) return;
			const from = session.activity ?? this.store.activity ?? "";
			session.activity = activity;
			this.refreshState(session);
			const to = activity ?? this.store.activity ?? "";
			if (from !== to) this.emit(session, "state", "activity", encodeProps({ to, from }));
			return;
		}
		const before = this.store.activity ?? "";
		this.store.activity = activity;
		if (before === (activity ?? "")) return;
		for (const [, session] of this.sessions) {
			if (session.activity !== undefined || session.left) continue;
			this.refreshState(session);
			this.emit(session, "state", "activity", encodeProps({ to: activity ?? "", from: before }));
		}
	}

	setScreen(session: PlayerSession, screen: string, src: "server" | "client", t?: number, props?: string) {
		const from = session.screen;
		if (from === screen) return;
		session.screen = screen;
		this.refreshState(session);
		this.emit(session, "state", "screen", props ?? encodeProps({ to: screen, from }), src, t);
	}

	// Experiments ------------------------------------------------------------------------------------------------------

	private overrides(): Record<string, ExperimentOverride> {
		const result: Record<string, ExperimentOverride> = {};
		if (this.settings) for (const [name, override] of this.settings.experiments) result[name] = override;
		return result;
	}

	/** The player's variant (stamped on their later events while active). May yield until the player's pid loads. */
	experiment(player: Player, name: string, variants: string[]): string {
		const control = variants[0] ?? "";
		if (!isExperimentName(name) || !isVariantList(variants)) {
			$warn(`[analytics] experiment("${tostring(name).sub(1, 64)}"): bad name or variants (1-16 distinct names)`);
			return control;
		}
		const session = this.sessionOf(player);
		if (!session) return control;
		const deadline = os.clock() + 10;
		while ((!session.ready || !this.settingsTried) && os.clock() < deadline && !this.stopped) task.wait(0.1);
		if (!session.ready) return control;
		if (!session.exp.has(name) && session.exp.size() >= EXPERIMENTS_MAX) {
			this.warn(`experiment("${name}") not assigned: a session holds at most ${EXPERIMENTS_MAX} experiments`);
			return control;
		}
		const assignment = assignVariant(session.pid, name, variants, this.settings?.experiments.get(name));
		const current = session.exp.get(name);
		if (assignment.active && current !== assignment.variant) {
			session.exp.set(name, assignment.variant);
			session.expJson = encodeProps(session.exp as unknown as object);
			this.emit(
				session,
				"experiment",
				name,
				encodeProps({ variant: assignment.variant, variants: variants.size(), forced: assignment.forced || undefined }),
			);
		} else if (!assignment.active && current !== undefined) {
			session.exp.delete(name);
			session.expJson = encodeProps(session.exp as unknown as object);
		}
		return assignment.variant;
	}

	// Settings ---------------------------------------------------------------------------------------------------------

	private applySettings(parsed: ParsedSettings) {
		const errorsText = parsed.errors.join("; ");
		if (errorsText !== this.settingsErrors.join("; ") && errorsText !== "") {
			$warn(`[analytics] settings.analytics: ${errorsText}`);
		}
		this.settingsErrors = parsed.errors;
		const hadSettings = this.settings !== undefined;
		this.settings = parsed.settings;
		this.events.cap = parsed.settings ? EVENTS_CAP : EVENTS_CAP_UNCONFIGURED;
		// New settings (a fixed token or URL): try at once.
		this.backoffUntil = 0;
		this.store.failures = 0;
		if (!hadSettings && parsed.settings) this.nextFlushAt = os.clock() + 2;
		for (const [player, session] of this.sessions) {
			if (session.ready && !this.helloWaiting.has(player) && session.device !== undefined) this.sendHello(player, session);
		}
	}

	private startSettings() {
		const given = this.options.settings;
		if (given !== undefined) {
			this.applySettings(parseSettings(given, decode));
			this.settingsTried = true;
			return;
		}
		// Kernel 0.3.8 (plans/20): the signed settings record's `analytics` (the sink) and `fleet` (identities on Basin),
		// live through the kernel's change hook. Older kernels have no settings (no ConfigService fallback): pass
		// `new AnalyticsEngine({ settings })`.
		if (!settingsSupported()) {
			if (this.kernel !== undefined && this.kernel.test !== true) {
				$warn(
					`[analytics] no sink settings: they come from the signed settings record (kernel 0.3.8+, "typetorch settings set analytics -"); this server runs kernel ${this.kernel.kernelVersion}. Or pass new AnalyticsEngine({ settings })`,
				);
			}
			this.settingsTried = true;
			return;
		}
		let lastRaw: string | undefined;
		const apply = (settings: KernelSettings | undefined) => {
			this.fleetSettings = settings?.fleet;
			const value = settings?.analytics;
			// Compare without decoding twice; the text never reaches a log.
			const [encodedOk, raw] = pcall(() => (value === undefined ? "" : HttpService.JSONEncode(value)));
			const text = encodedOk ? raw : tostring(os.clock());
			if (text === lastRaw) return;
			lastRaw = text;
			this.applySettings(parseSettings(value, decode));
		};
		apply(currentSettings());
		this.settingsTried = true;
		this.trove.add(onSettings(apply));
	}

	// Sessions ---------------------------------------------------------------------------------------------------------

	private dataStore(): DataStore | undefined {
		const [ok, store] = pcall(() => DataStoreService.GetDataStore(PLAYER_STORE));
		return ok ? store : undefined;
	}

	private waitForBudget(kind: Enum.DataStoreRequestType) {
		const deadline = os.clock() + 10;
		while (os.clock() < deadline) {
			const [ok, budget] = pcall(() => DataStoreService.GetRequestBudgetForRequestType(kind));
			if (!ok || budget >= 1) return;
			task.wait(1);
		}
	}

	/** One read per join, with retries. (true, record | undefined) or (false) when the store can't be read. */
	private readRecord(userId: number): [boolean, PlayerRecord?] {
		const store = this.dataStore();
		if (!store) return [false];
		for (let attempt = 1; attempt <= 3; attempt++) {
			this.waitForBudget(Enum.DataStoreRequestType.GetAsync);
			const [ok, value] = pcall(() => store.GetAsync(`p/${userId}`)[0]);
			if (ok) {
				if (!typeIs(value, "table")) return [true, undefined];
				const record = value as Partial<PlayerRecord>;
				if (!typeIs(record.pid, "string") || record.pid.size() < 8) return [true, undefined];
				return [true, { pid: record.pid, first: typeIs(record.first, "number") ? record.first : 0, last: typeIs(record.last, "number") ? record.last : 0 }];
			}
			task.wait(attempt * 2);
		}
		return [false];
	}

	/** Writes the record (first join, leave). Keeps a pid another server wrote first; returns the stored pid. */
	private writeRecord(userId: number, pid: string, first: number): string | undefined {
		const store = this.dataStore();
		if (!store) return undefined;
		const now = os.time();
		for (let attempt = 1; attempt <= 3; attempt++) {
			this.waitForBudget(Enum.DataStoreRequestType.UpdateAsync);
			let stored = pid;
			const [ok] = pcall(() =>
				store.UpdateAsync(`p/${userId}`, (old: unknown) => {
					const record = typeIs(old, "table") ? (old as Partial<PlayerRecord>) : undefined;
					if (record && typeIs(record.pid, "string") && record.pid.size() >= 8) {
						stored = record.pid;
						return $tuple({ pid: record.pid, first: typeIs(record.first, "number") ? record.first : first, last: now });
					}
					stored = pid;
					return $tuple({ pid, first, last: now });
				}),
			);
			if (ok) return stored;
			task.wait(attempt * 2);
		}
		return undefined;
	}

	/**
	 * Loads (or creates) the player's pid, then releases their held rows and answers their client. Results go into the
	 * persisted session even if this generation stopped meanwhile; a lookup that another generation finished first
	 * changes nothing.
	 */
	private resolve(player: Player, session: PlayerSession) {
		const [ok, record] = this.readRecord(player.UserId);
		if (session.ready) return;
		const nowSeconds = os.time();
		let pid: string;
		let newp = false;
		let temp = false;
		let first = nowSeconds;
		let ret = -1;
		if (ok && record) {
			pid = record.pid;
			first = record.first;
			// Created by this server for this session (a swap restarted the lookup): still the first visit.
			newp = session.created !== undefined && record.pid === session.created;
			if (!newp && record.last > 0) ret = math.max(0, math.floor((nowSeconds - record.last) / 86400));
		} else if (ok) {
			const created = session.created ?? newId();
			session.created = created;
			const stored = this.writeRecord(player.UserId, created, nowSeconds);
			pid = stored ?? created;
			// Another server created the record first (two joins at once): not a first visit here.
			newp = stored === created;
			temp = stored === undefined;
		} else {
			// The store can't be read (Studio without API access, an outage): a session-only id, never recorded.
			pid = `t${newId().sub(2)}`;
			temp = true;
		}
		if (session.ready) return;
		session.pid = pid;
		session.newp = newp;
		session.temp = temp;
		session.first = first;
		session.ret = ret;
		session.ready = true;
		if (this.options.identity !== false) this.queueIdentity(player.UserId, pid);
		for (const row of session.pending) {
			row.pid = session.pid;
			row.newp = session.newp;
			this.events.push(row);
		}
		session.pending = [];
		if (this.helloWaiting.has(player)) this.sendHello(player, session);
	}

	private joinSource(player: Player): Record<string, unknown> {
		const [ok, data] = pcall(() => player.GetJoinData());
		const info: Record<string, unknown> = {};
		let from = "direct";
		if (ok && data) {
			if (data.SourcePlaceId !== undefined && data.SourcePlaceId !== 0) {
				from = data.SourceGameId !== undefined && data.SourceGameId !== game.GameId ? "teleport_game" : "teleport";
			} else if (data.ReferredByPlayerId !== undefined && data.ReferredByPlayerId !== 0) from = "referral";
			else if (data.LaunchData !== undefined && data.LaunchData !== "") from = "share";
			const context = data.GameJoinContext;
			if (context !== undefined) {
				const [contextOk, source] = pcall(() => context.JoinSource.Name);
				if (contextOk) info.ctx = source;
			}
			if (data.TeleportData !== undefined) info.tp = true;
			if (data.Members !== undefined && data.Members.size() > 0) info.party = data.Members.size();
		}
		if (from === "direct" && player.FollowUserId !== 0) from = "follow";
		info.from = from;
		return info;
	}

	/**
	 * How many of the player's friends are in this server: one `GetFriendsAsync` per join (at most FRIEND_PAGES_MAX
	 * pages) intersected with the players here, instead of an IsFriendsWith call per player. Stops early once every
	 * other player was found; after each yield it stops with the count so far if the player left or the generation
	 * stopped. No call when the player is alone; a failed call counts what it read (0 at first).
	 */
	private friendsHere(player: Player): number {
		const others = new Set<number>();
		for (const other of Players.GetPlayers()) if (other !== player) others.add(other.UserId);
		if (others.size() === 0) return 0;
		const [ok, pages] = pcall(() => Players.GetFriendsAsync(player.UserId as never));
		if (!ok || pages === undefined) return 0;
		let count = 0;
		for (let page = 1; page <= FRIEND_PAGES_MAX; page++) {
			if (this.stopped || player.Parent === undefined) break;
			const [pageOk, entries] = pcall(() => pages.GetCurrentPage());
			if (!pageOk || !typeIs(entries, "table")) break;
			for (const entry of entries) {
				if (typeIs(entry, "table") && others.delete(entry.Id)) count += 1;
			}
			if (others.size() === 0 || pages.IsFinished || page === FRIEND_PAGES_MAX) break;
			const [nextOk] = pcall(() => pages.AdvanceToNextPageAsync());
			if (!nextOk) break;
		}
		return count;
	}

	private emitJoin(player: Player, session: PlayerSession) {
		const deadline = os.clock() + DEVICE_WAIT;
		while (session.device === undefined && os.clock() < deadline && player.Parent !== undefined && !this.stopped) task.wait(0.25);
		if (session.joined || this.stopped) return;
		session.joined = true;
		const props = this.joinSource(player);
		props.age = ageBucket(player.AccountAge);
		props.prem = player.MembershipType === Enum.MembershipType.Premium;
		const [countryOk, country] = pcall(() => LocalizationService.GetCountryRegionForPlayerAsync(player));
		if (countryOk) props.country = country;
		props.friends = this.friendsHere(player);
		props.ret = session.ret;
		// The engine started after this player joined (created later, or added by a deploy).
		if (nowMs() - session.joinedAt > 60000) props.late = true;
		this.emit(session, "session", "join", encodeProps(props), "server", session.joinedAt);
	}

	private onPlayer(player: Player) {
		if (this.sessions.has(player) || this.stopped) return;
		const key = tostring(player.UserId);
		let session = this.store.players.get(key);
		if (!session || session.left) {
			session = newSession();
			this.store.players.set(key, session);
		}
		this.sessions.set(player, session);
		this.refreshState(session);
		const current = session;
		if (!current.ready) task.spawn(() => this.resolve(player, current));
		if (!current.joined && this.options.sessions !== false) task.spawn(() => this.emitJoin(player, current));
	}

	private leave(player: Player, why: string) {
		const session = this.sessions.get(player);
		if (!session || session.left) return;
		session.left = true;
		const now = nowMs();
		if (session.zone !== "") {
			this.emit(session, "zone", "leave", encodeProps({ zone: session.zone, secs: math.floor((now - session.zoneSince) / 1000) }));
		}
		if (session.rec.started && !session.rec.ended) {
			session.rec.ended = true;
			this.emit(session, "recording_meta", "end", encodeProps({ chunks: session.rec.chunk, bytes: session.rec.bytes, why: "left" }));
		}
		if (this.options.sessions !== false) {
			const lastSwap = this.store.lastSwapAt;
			this.emit(
				session,
				"session",
				"leave",
				encodeProps({
					secs: math.floor((now - session.joinedAt) / 1000),
					why,
					swap60: lastSwap !== undefined && os.time() - lastSwap <= 60 ? true : undefined,
				}),
			);
		}
		this.sessions.delete(player);
		this.helloWaiting.delete(player);
		this.clientBudgets.delete(player);
		this.lastChunkAt.delete(player);
		this.store.players.delete(tostring(player.UserId));
		if (session.ready && !session.temp) {
			const userId = player.UserId;
			task.spawn(() => this.writeRecord(userId, session.pid, session.first > 0 ? session.first : os.time()));
		}
	}

	private startSessions() {
		// Sessions left over from a generation that stopped while a player was leaving.
		const present = new Set<string>();
		for (const player of Players.GetPlayers()) present.add(tostring(player.UserId));
		for (const [key, session] of this.store.players) {
			if (present.has(key)) continue;
			this.store.players.delete(key);
			if (session.ready && this.options.sessions !== false) {
				this.emit(session, "session", "leave", encodeProps({ secs: math.floor((nowMs() - session.joinedAt) / 1000), why: "gone" }));
			}
		}
		observePlayers(this.trove, (player) => this.onPlayer(player));
		this.trove.connect(Players.PlayerRemoving, (player) => this.leave(player, "left"));

		// Swaps and boots, once per generation.
		const start = TypeTorch.startInfo;
		const generation = TypeTorch.generation;
		if (this.store.logged !== generation) {
			this.store.logged = generation;
			if (start.kind === "swap") {
				this.store.lastSwapAt = start.startedAt;
				const previous = start.previous?.artifact.id;
				this.trove.add(
					task.delay(5, () => {
						const info = TypeTorch.startInfo;
						this.emit(
							undefined,
							"tech",
							info.reason === "rollback" || info.reason === "server_rollback" || info.reason === "auto_rollback" ? "rollback" : "swap",
							encodeProps({
								reason: info.reason,
								from: previous,
								gen: generation,
								load: info.loadSeconds,
								stop: info.stopSeconds,
								swap: info.swapSeconds,
								players: Players.GetPlayers().size(),
							}),
						);
					}),
				);
			} else {
				this.emit(undefined, "tech", "start", encodeProps({ gen: generation, kernel: TypeTorch.kernelVersion, load: start.loadSeconds }));
			}
		}
		this.trove.add(
			TypeTorch.onSwapOut((info) => {
				this.emit(undefined, "tech", "swap_out", encodeProps({ reason: info.reason, next: info.next?.id, players: Players.GetPlayers().size() }));
			}),
		);
	}

	// Client intake ----------------------------------------------------------------------------------------------------

	private recordingAllowed(session: PlayerSession): boolean {
		const settings = this.settings;
		return (
			this.options.recording !== false &&
			settings !== undefined &&
			recordsSupported(settings) &&
			session.newp &&
			!session.temp &&
			nowMs() - session.joinedAt < RECORDING_MAX_SECONDS * 1000 &&
			inShare(session.pid, settings.recordShare)
		);
	}

	private sendHello(player: Player, session: PlayerSession) {
		const dispatcher = maybeServerDispatcher();
		if (!dispatcher || this.stopped) return;
		this.helloWaiting.delete(player);
		if (!session.rec.decided && this.settings !== undefined) {
			session.rec.decided = true;
			session.rec.on = this.recordingAllowed(session);
		}
		const hello: ServerHello = {
			pid: session.pid,
			newp: session.newp,
			rec: session.rec.on && !session.rec.ended && this.options.recording !== false,
			tech: this.settings?.techEvery ?? DEFAULT_TECH_EVERY,
			exps: this.overrides(),
		};
		dispatcher.kernel.send(player, CHANNEL, "hi", hello);
	}

	private onHello(player: Player, session: PlayerSession, raw: unknown) {
		const info = cleanHello(raw);
		if (!info) return;
		const first = session.device === undefined;
		session.device = info;
		session.dev = info.dev;
		if (first && this.options.sessions !== false) {
			this.emit(
				session,
				"session",
				"device",
				encodeProps({ input: info.input, w: info.w, h: info.h, touch: info.touch, kb: info.kb, mouse: info.mouse, pad: info.pad, vr: info.vr }),
				"client",
			);
			if (info.load !== undefined && this.options.tech !== false) {
				this.emit(session, "tech", "load", encodeProps({ secs: info.load }), "client");
			}
		}
		if (session.ready) this.sendHello(player, session);
		else this.helloWaiting.add(player);
	}

	/** One client-sent event (or an "exp" message, which may add a row): within the player's budget and the session cap. */
	private takeClientEvent(player: Player, session: PlayerSession): boolean {
		if (session.clientEvents >= CLIENT_SESSION_MAX) return false;
		let budget = this.clientBudgets.get(player);
		if (!budget) {
			budget = { tokens: CLIENT_BURST, last: os.clock() };
			this.clientBudgets.set(player, budget);
		}
		if (!takeToken(budget, os.clock(), CLIENT_BURST, CLIENT_PER_MINUTE)) return false;
		session.clientEvents += 1;
		return true;
	}

	private onEvents(player: Player, session: PlayerSession, batch: unknown) {
		if (!typeIs(batch, "table")) return;
		const list = batch as unknown[];
		if (list.size() > CLIENT_BATCH_MAX) return;
		const now = nowMs();
		const halfPing = math.floor(math.clamp(player.GetNetworkPing(), 0, 2) * 500);
		for (const raw of list) {
			const event = cleanClientEvent(raw);
			if (!event) continue;
			const [age, kind, name, props] = event;
			const [ok, decoded] = pcall(decode, props);
			if (!ok || !typeIs(decoded, "table")) continue;
			if (!this.takeClientEvent(player, session)) return;
			const t = now - age - halfPing;
			if (kind === "state") {
				const to = (decoded as { to?: unknown }).to;
				const target = typeIs(to, "string") && (to === "" || isEventName(to)) ? to : undefined;
				if (target === undefined) continue;
				if (name === "screen") {
					this.setScreen(session, target, "client", t, props);
					continue;
				}
				if (name === "activity") {
					session.activity = target === "" ? undefined : target;
					this.refreshState(session);
				}
			}
			this.emit(session, kind as EventKind, name, props, "client", t);
		}
	}

	private onChunk(player: Player, session: PlayerSession, args: unknown[]) {
		const [chunk, age, n, data, last, why] = args as [unknown, unknown, unknown, unknown, unknown, unknown];
		const rec = session.rec;
		if (!session.ready || !rec.on || rec.ended) return;
		if (!typeIs(chunk, "number") || chunk % 1 !== 0 || chunk < 0 || chunk > RECORDING_MAX_CHUNKS) return;
		if (!typeIs(age, "number") || age !== age || age < 0 || age > 600000) return;
		if (!typeIs(n, "number") || n % 1 !== 0 || n < 0 || n > 5000) return;
		if (!typeIs(data, "buffer")) return;
		const size = buffer.len(data);
		if (size < 4 || size > CHUNK_MAX_BYTES || buffer.readu8(data, 0) !== 1) return;
		if (chunk < rec.chunk) return; // a resend
		const clock = os.clock();
		const lastAt = this.lastChunkAt.get(player);
		if (lastAt !== undefined && clock - lastAt < 1 && last !== true) return;
		this.lastChunkAt.set(player, clock);
		const settings = this.settings;
		if (!settings || !recordsSupported(settings)) return;
		const t = nowMs() - age - math.floor(math.clamp(player.GetNetworkPing(), 0, 2) * 500);
		if (!rec.started) {
			rec.started = true;
			this.emit(session, "recording_meta", "start", encodeProps({ share: settings.recordShare }), "server", t);
		}
		rec.chunk = chunk + 1;
		rec.bytes += size;
		const id = this.identity;
		this.recordings.push({
			v: SCHEMA_VERSION,
			t,
			pid: session.pid,
			sid: session.sid,
			job: id.job,
			art: id.art,
			chunk,
			codec: RECORDING_CODEC,
			data: toBase64(data),
			n,
		});
		const capped = rec.bytes >= RECORDING_MAX_BYTES || rec.chunk >= RECORDING_MAX_CHUNKS;
		if (last === true || capped) {
			rec.ended = true;
			const reason = capped ? "cap" : typeIs(why, "string") && isEventName(why) ? why : "end";
			this.emit(session, "recording_meta", "end", encodeProps({ chunks: rec.chunk, bytes: rec.bytes, why: reason }));
		}
	}

	private startIntake() {
		const dispatcher = maybeServerDispatcher();
		if (!dispatcher) return;
		dispatcher.setRaw(CHANNEL, (player, op, ...args) => {
			const session = this.sessions.get(player);
			if (!session || this.stopped) return;
			const [ok, err] = pcall(() => {
				if (op === "hello") this.onHello(player, session, args[0]);
				else if (op === "ev") this.onEvents(player, session, args[0]);
				else if (op === "exp") {
					const [name, variants] = args;
					// A client names an experiment: within its event budget (it may add an "experiment" row and grows `exp`).
					// experiment() may wait for the pid: not on the kernel's message thread.
					if (isExperimentName(name) && isVariantList(variants) && this.takeClientEvent(player, session)) {
						task.spawn(() => this.experiment(player, name, variants));
					}
				} else if (op === "rec") {
					if (this.options.recording !== false) this.onChunk(player, session, args);
				}
			});
			if (!ok) $warn(`[analytics] client message failed: ${tostring(err).sub(1, 200)}`);
		});
		this.trove.add(() => dispatcher.removeRaw(CHANNEL));
	}

	// Tech health ------------------------------------------------------------------------------------------------------

	private startTech() {
		let frames = 0;
		let since = os.clock();
		this.trove.connect(RunService.Heartbeat, () => {
			frames += 1;
		});
		this.trove.add(
			TypeTorch.onLog((entry) => {
				if (entry.kind !== "error" || this.errors.size() >= 50) return;
				const text = entry.text.sub(1, 300);
				this.errors.set(text, (this.errors.get(text) ?? 0) + 1);
			}),
		);
		this.trove.add(
			task.spawn(() => {
				while (true) {
					task.wait(this.settings?.techEvery ?? DEFAULT_TECH_EVERY);
					const elapsed = math.max(os.clock() - since, 0.001);
					const heartbeat = frames / elapsed;
					frames = 0;
					since = os.clock();
					const pings = new Array<number>();
					for (const player of Players.GetPlayers()) {
						const [ok, ping] = pcall(() => player.GetNetworkPing());
						if (ok) pings.push(math.floor(ping * 1000));
					}
					pings.sort((a, b) => a < b);
					const percentile = (share: number) => (pings.size() > 0 ? pings[math.min(pings.size() - 1, math.floor(pings.size() * share))] : undefined);
					let health: string | undefined;
					let healthErrors: number | undefined;
					const kernel = this.kernel;
					if (kernel) {
						const [ok, status] = pcall(() => kernel.status());
						if (ok && status.health) {
							health = status.health.state;
							healthErrors = status.health.errors;
						}
					}
					this.emit(
						undefined,
						"tech",
						"server",
						encodeProps({
							fps: math.floor(Workspace.GetRealPhysicsFPS() + 0.5),
							hb: math.floor(heartbeat + 0.5),
							mem: math.floor(Stats.GetTotalMemoryUsageMb() / 10 + 0.5) * 10,
							players: Players.GetPlayers().size(),
							ping50: percentile(0.5),
							ping90: percentile(0.9),
							q: this.events.size(),
							qr: this.recordings.size(),
							dropped: this.store.events.dropped + this.store.recordings.dropped + this.store.fleet.dropped,
							sent: this.store.sent,
							fails: this.store.failures,
							health,
							errors: healthErrors,
						}),
					);
					let reported = 0;
					for (const [text, count] of this.errors) {
						if (reported >= 10) break;
						reported += 1;
						this.emit(undefined, "tech", "error", encodeProps({ msg: scrubNames(text), n: count }));
					}
					this.errors.clear();
				}
			}),
		);
	}

	// Zones ------------------------------------------------------------------------------------------------------------

	private zoneAt(position: Vector3): string {
		let best = "";
		let bestVolume = math.huge;
		for (const [, zone] of this.zones) {
			let cframe: CFrame;
			let size: Vector3;
			const instance = zone.instance;
			if (instance.IsA("BasePart")) {
				cframe = instance.CFrame;
				size = instance.Size;
			} else if (instance.IsA("Model")) {
				const [box, boxSize] = instance.GetBoundingBox();
				cframe = box;
				size = boxSize;
			} else continue;
			const offset = cframe.PointToObjectSpace(position);
			if (math.abs(offset.X) <= size.X / 2 && math.abs(offset.Y) <= size.Y / 2 && math.abs(offset.Z) <= size.Z / 2) {
				const volume = size.X * size.Y * size.Z;
				if (volume < bestVolume) {
					bestVolume = volume;
					best = zone.name;
				}
			}
		}
		return best;
	}

	private startZones() {
		const nameOf = (instance: Instance) => {
			const attribute = instance.GetAttribute("Name");
			const name = typeIs(attribute, "string") && attribute !== "" ? attribute : instance.Name;
			return name.sub(1, 64);
		};
		const add = (instance: Instance) => {
			if (instance.IsA("BasePart") || instance.IsA("Model")) this.zones.set(instance, { instance, name: nameOf(instance) });
		};
		this.trove.connect(CollectionService.GetInstanceAddedSignal(ZONE_TAG), add);
		this.trove.connect(CollectionService.GetInstanceRemovedSignal(ZONE_TAG), (instance) => this.zones.delete(instance));
		for (const instance of CollectionService.GetTagged(ZONE_TAG)) add(instance);
		this.trove.add(
			task.spawn(() => {
				while (true) {
					task.wait(ZONE_INTERVAL);
					if (this.zones.size() === 0) continue;
					for (const [player, session] of this.sessions) {
						if (session.left) continue;
						const root = player.Character?.FindFirstChild("HumanoidRootPart");
						if (!root || !root.IsA("BasePart")) continue;
						const zone = this.zoneAt(root.Position);
						if (zone === session.zone) continue;
						const now = nowMs();
						const previous = session.zone;
						session.zone = zone;
						this.refreshState(session);
						if (previous !== "") {
							this.emit(session, "zone", "leave", encodeProps({ zone: previous, to: zone, secs: math.floor((now - session.zoneSince) / 1000) }));
						}
						session.zoneSince = now;
						if (zone !== "") this.emit(session, "zone", "enter", encodeProps({ zone, from: previous }));
					}
				}
			}),
		);
	}

	// Fleet (kernel 0.3.2+: heartbeats and deploy reports leave MemoryStore and go through analytics) ------------------

	private startFleet() {
		const kernel = this.kernel as unknown as Record<string, unknown> | undefined;
		if (!kernel) return;
		if (typeIs(kernel.fleetStatus, "function")) {
			const status = kernel.fleetStatus as (self: unknown) => FleetStatus;
			const beat = () => {
				const [ok, value] = pcall(() => status(kernel));
				if (ok && typeIs(value, "table")) this.emitFleet("heartbeat", value as object);
			};
			this.trove.add(
				task.spawn(() => {
					beat();
					while (true) {
						task.wait(HEARTBEAT_EVERY + (math.random() * 2 - 1) * HEARTBEAT_JITTER);
						beat();
					}
				}),
			);
		}
		if (typeIs(kernel.onDeployReport, "function")) {
			const subscribe = kernel.onDeployReport as (self: unknown, callback: (report: DeployReport) => void) => unknown;
			// It replays the last 20 to a new listener: (s, j, r) already queued by any generation are skipped.
			const [ok, disconnect] = pcall(() => subscribe(kernel, (report: DeployReport) => this.onDeployReport(report)));
			if (ok && typeIs(disconnect, "function")) this.trove.add(disconnect as () => void);
		}
	}

	private onDeployReport(report: DeployReport) {
		if (!typeIs(report, "table") || this.stopped) return;
		const key = `${tostring(report.s)}|${tostring(report.j)}|${tostring(report.r)}`;
		const seen = this.store.fleetSeen;
		if (seen.includes(key)) return;
		seen.push(key);
		while (seen.size() > FLEET_SEEN_MAX) seen.shift();
		this.emitFleet("deploy_report", report as object);
	}

	// Sinks ------------------------------------------------------------------------------------------------------------

	private warn(message: string) {
		const now = os.clock();
		if (now - this.lastWarnAt < 60) return;
		this.lastWarnAt = now;
		$warn(`[analytics] ${message}`);
	}

	/** POST one request. Returns the HTTP status (0: no response). Never logs the token or the body. */
	private post(request: SinkRequest): number {
		const [ok, response] = pcall(() =>
			HttpService.RequestAsync({
				Url: request.url,
				Method: "POST",
				Headers: request.headers,
				Body: request.body,
				Compress: request.gzip ? Enum.HttpCompression.Gzip : Enum.HttpCompression.None,
			}),
		);
		if (!ok) {
			this.store.lastError = `${request.table}: ${tostring(response).sub(1, 120)}`;
			return 0;
		}
		if (!response.Success) this.store.lastError = `${request.table}: HTTP ${response.StatusCode} ${response.StatusMessage.sub(1, 60)}`;
		return response.StatusCode;
	}

	/** Sends one batch per table. `final`: shutdown, ignore the budget. */
	private flushOnce(final: boolean) {
		if (this.testMode) {
			// The cloud test: drop what was collected instead of sending it (the task's rows are not real play).
			this.store.events.rows.clear();
			this.store.fleet.rows.clear();
			this.store.recordings.rows.clear();
			this.store.identities = [];
			return;
		}
		const settings = this.settings;
		if (!settings || this.flushing) return;
		this.flushing = true;
		const now = os.clock();
		this.nextFlushAt = now + settings.flushSeconds;
		// Fleet rows first, then analytics events, in one events batch.
		const events = this.fleet.take(this.batchRows, BATCH_BYTES / 2, estimateEventBytes);
		if (events.size() < this.batchRows) {
			for (const row of this.events.take(this.batchRows - events.size(), BATCH_BYTES / 2, estimateEventBytes)) events.push(row);
		}
		const recordings = recordsSupported(settings) ? this.recordings.take(BATCH_RECORDINGS, BATCH_BYTES, estimateRecordingBytes) : [];
		const waiting = this.store.identities ?? [];
		const identities = waiting.size() > 0 ? this.takeIdentities() : [];
		// Basin without a fleet API to send them to: identities are dropped (they never go into Basin).
		const target = settings.backend === "basin" && identities.size() > 0 ? identityTarget(settings, this.fleetSettings, decode) : undefined;
		const sendIdentities = settings.backend === "duckdb" || target !== undefined ? identities : [];
		if (events.size() === 0 && recordings.size() === 0 && sendIdentities.size() === 0) {
			this.flushing = false;
			return;
		}
		// Rows taken but not settled live in persist while a request yields: a swap that stops this thread hands them
		// to the next generation (sent again: at least once).
		this.store.inflightEvents = events;
		this.store.inflightRecordings = recordings;
		this.store.inflightIdentities = sendIdentities;
		const requests = buildRequests(settings, events, recordings, quote, sendIdentities, target);
		const settle = (request: SinkRequest, giveBack: boolean) => {
			if (request.events > 0) {
				if (giveBack) this.requeueEvents(events);
				this.store.inflightEvents = [];
			}
			if (request.recordings > 0) {
				if (giveBack) this.recordings.requeue(recordings);
				this.store.inflightRecordings = [];
			}
			if (request.identities > 0) {
				if (giveBack) this.requeueIdentities(sendIdentities);
				this.store.inflightIdentities = [];
			}
		};
		let failed = false;
		for (const request of requests) {
			if (failed || (!final && !takeToken(this.store.budget, os.clock(), HTTP_BURST, HTTP_PER_MINUTE))) {
				settle(request, true);
				continue;
			}
			const status = this.post(request);
			const outcome = classifyStatus(status);
			const rows = request.events + request.recordings + request.identities;
			if (outcome === "sent") {
				// Identity rows aren't analytics rows: "sent" counts events and recordings.
				this.store.sent += request.events + request.recordings;
				this.store.failures = 0;
				this.batchRows = BATCH_ROWS;
				settle(request, false);
			} else if (outcome === "split" && rows > 1) {
				settle(request, true);
				this.batchRows = math.max(1, math.floor(math.max(request.events, 2) / 2));
			} else if (outcome === "drop" || outcome === "split") {
				this.store.rejected += rows;
				settle(request, false);
				this.warn(`analytics upload refused ${rows} rows (HTTP ${status}); they were dropped`);
			} else {
				settle(request, true);
				failed = true;
				this.store.failures += 1;
				const wait = outcome === "config" ? 300 : backoffSeconds(this.store.failures, math.random());
				this.backoffUntil = os.clock() + wait;
				// "both" = one batch with events and recordings (the DuckDB sink); say "analytics upload" instead.
				const what = request.table === "both" ? "analytics upload" : `analytics upload (${request.table})`;
				const reason = status > 0 ? `HTTP ${status}` : (this.store.lastError ?? "no response");
				const fix = status === 530 ? ": the tunnel is down, run bun run local on the dev PC" : "";
				this.warn(
					outcome === "config"
						? `${what} got HTTP ${status}: check the URL and token in settings.analytics (typetorch settings set analytics -); retrying in ${math.floor(wait)} s`
						: `${what} failed (${reason}${fix}); retrying in ${math.floor(wait)} s`,
				);
			}
		}
		// Recordings without a request (basin without a recordings URL) were never taken; nothing else is left.
		this.store.inflightEvents = [];
		this.store.inflightRecordings = [];
		this.store.inflightIdentities = [];
		this.flushing = false;
	}

	// Identities (pid -> UserId for the dev's own server) ----------------------------------------------------------------

	private identityList(): IdentityRow[] {
		if (this.store.identities === undefined) this.store.identities = [];
		return this.store.identities;
	}

	private queueIdentity(userId: number, pid: string) {
		const list = this.identityList();
		list.push({ pid, uid: userId, t: nowMs() });
		while (list.size() > IDENTITIES_CAP) list.remove(0);
	}

	private takeIdentities(): IdentityRow[] {
		const list = this.identityList();
		const taken = new Array<IdentityRow>();
		while (list.size() > 0 && taken.size() < BATCH_IDENTITIES) taken.push(list.remove(0)!);
		return taken;
	}

	/** Puts identity rows back in front (a failed or unsent request), keeping the cap. */
	private requeueIdentities(rows: IdentityRow[]) {
		const list = this.identityList();
		const merged = [...rows];
		for (const row of list) merged.push(row);
		while (merged.size() > IDENTITIES_CAP) merged.remove(0);
		this.store.identities = merged;
	}

	private startFlushing() {
		this.nextFlushAt = os.clock() + 5;
		this.trove.add(
			task.spawn(() => {
				while (true) {
					task.wait(1);
					if (!this.settings || this.closing) continue;
					const now = os.clock();
					if (now < this.backoffUntil) continue;
					const due =
						now >= this.nextFlushAt ||
						this.events.size() + this.fleet.size() >= BATCH_ROWS ||
						this.recordings.size() >= 20;
					if (due) this.flushOnce(false);
				}
			}),
		);
	}

	/** game code's flush(): send now (within the budget), on its own thread. */
	flushSoon() {
		if (this.stopped) return;
		this.nextFlushAt = 0;
	}

	// Shutdown ---------------------------------------------------------------------------------------------------------

	/** Server shutdown: everyone leaves, the records get their `last`, and the queue is sent (about 15 s at most). */
	close() {
		if (this.closing || this.stopped || this.testMode) return;
		this.closing = true;
		for (const player of Players.GetPlayers()) this.leave(player, "shutdown");
		const deadline = os.clock() + 14;
		let rounds = 0;
		while (
			(this.events.size() > 0 || this.fleet.size() > 0 || this.recordings.size() > 0) &&
			os.clock() < deadline &&
			rounds < 6 &&
			this.settings
		) {
			while (this.flushing && os.clock() < deadline) task.wait(0.1);
			this.flushOnce(true);
			rounds += 1;
			if (this.store.failures > 0) break;
		}
	}

	private startClose() {
		if (closeHooksSupported()) {
			this.trove.add(onGenerationClose(() => this.close()));
			return;
		}
		// Kernels before 0.3.2 have no onClose: one BindToClose per server relays shutdown to the generation that runs
		// the engine (an event kept in persist, so swaps never add BindToClose callbacks).
		const relay = TypeTorch.persist<CloseRelay>(CLOSE_KEY, () => ({ listening: 0, done: false }));
		if (!relay.event) {
			const event = new Instance("BindableEvent");
			relay.event = event;
			game.BindToClose(() => {
				if (relay.listening === 0) return;
				relay.done = false;
				event.Fire();
				const started = os.clock();
				while (!relay.done && os.clock() - started < 15) task.wait(0.1);
			});
		}
		const generation = TypeTorch.generation;
		relay.listening = generation;
		this.trove.connect(relay.event.Event, () => {
			this.close();
			relay.done = true;
		});
		this.trove.add(() => {
			if (relay.listening === generation) relay.listening = 0;
		});
	}

	// Stats ------------------------------------------------------------------------------------------------------------

	stats(): AnalyticsStats {
		return {
			configured: this.settings !== undefined,
			backend: this.settings?.backend,
			queued: this.events.size(),
			queuedRecordings: this.recordings.size(),
			queuedFleet: this.fleet.size(),
			queuedIdentities: this.store.identities?.size() ?? 0,
			sent: this.store.sent,
			dropped: this.store.events.dropped + this.store.recordings.dropped + this.store.fleet.dropped,
			rejected: this.store.rejected,
			failures: this.store.failures,
			lastError: this.store.lastError,
			settingsErrors: [...this.settingsErrors],
		};
	}
}
