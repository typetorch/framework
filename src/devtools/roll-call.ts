/**
 * Admin > Servers' server list (framework 0.3.0, user decision): a MessagingService roll call, no MemoryStore.
 *
 * - A dev opens the list: this server subscribes to its own reply topic `TypeTorch/rollcall/<its JobId>`, publishes one
 *   ask `{ q, j = its JobId, t }` on `TypeTorch/rollcall`, collects replies for COLLECT_SECONDS and caches the list for
 *   CACHE_SECONDS (errors ERROR_CACHE_SECONDS), one roll call at a time.
 * - Every server listens on `TypeTorch/rollcall` and answers an ask with one message `{ q, j = its JobId, s = its row }`
 *   on the asker's reply topic, after a random wait of up to REPLY_JITTER seconds: at most REPLIES_PER_MINUTE per
 *   minute and one per asker every REPLY_GAP seconds, never to an ask older than ASK_MAX_AGE seconds. The row is the
 *   kernel's `fleetStatus()` on kernel 0.3.2+ (else the admin fields), cut to fit one message (`e`, then `k`, dropped).
 * - MessagingService limits (Roblox docs; conservative figures): a server publishes 150 + 60 x players messages a minute,
 *   a topic takes 10 + 20 x servers messages a minute, the whole game 100 + 50 x servers. One roll call costs the asker
 *   1 publish and each server 1 (so 100 servers: 101 messages, against 2,010 a minute on the reply topic and 5,100 a
 *   minute for the game); answering stays under REPLIES_PER_MINUTE per server whatever askers do, and an asker asks at
 *   most once per CACHE_SECONDS. Subscriptions: one permanent (the ask topic) and one while asking.
 * - Trust: like the MemoryStore list it replaces, any server of the universe can answer, so rows are hints for the dev
 *   menu (the kernels re-check every action they lead to). `k` (a reserved server's access code) stays server-side.
 */

export const ROLL_CALL_TOPIC = "TypeTorch/rollcall";
export const COLLECT_SECONDS = 3;
export const CACHE_SECONDS = 15;
export const ERROR_CACHE_SECONDS = 5;
export const REPLIES_PER_MINUTE = 12;
export const REPLY_GAP = 5;
export const REPLY_JITTER = 1;
export const ASK_MAX_AGE = 30;
/** MessagingService caps a message at 1 KiB. */
export const MAX_REPLY_BYTES = 950;
export const MAX_ROWS = 500;

/** The topic only `jobId` listens on for its roll call's replies. */
export function replyTopic(jobId: string): string {
	return `${ROLL_CALL_TOPIC}/${jobId}`;
}

export function isJobId(value: unknown): value is string {
	return typeIs(value, "string") && value.size() > 0 && value.size() <= 64 && value.match("^[%w%-]+$")[0] !== undefined;
}

export interface RollCallRow {
	key: string;
	value: Record<string, unknown>;
}

export interface RollCallList {
	/** os.clock() of the roll call. */
	at: number;
	rows: RollCallRow[];
	truncated: boolean;
	error?: string;
}

export interface RollCallConnection {
	Disconnect(): void;
}

export interface RollCallDeps {
	jobId: string;
	/** MessagingService.SubscribeAsync with the message's Data (yields, may throw). */
	subscribe: (topic: string, handler: (data: unknown) => void) => RollCallConnection;
	/** MessagingService.PublishAsync (yields, may throw). */
	publish: (topic: string, data: string) => void;
	/** This server's row, or undefined to stay silent (shutting down, migrating). */
	entry: () => Record<string, unknown> | undefined;
	encode: (value: unknown) => string;
	decode: (text: string) => unknown;
	clock: () => number;
	unixMs: () => number;
	wait: (seconds: number) => void;
	spawn: (callback: () => void) => void;
	random: () => number;
	warn: (text: string) => void;
}

export class RollCall {
	private cache: RollCallList | undefined;
	private waiting: thread[] | undefined;
	private nextId = 0;
	private replied: number[] = [];
	private lastReplyTo = new Map<string, number>();
	private stopped = false;
	/** Replies sent and asks ignored (for tests and the dev menu). */
	readonly counters = { asked: 0, answered: 0, ignored: 0, limited: 0 };

	constructor(private readonly deps: RollCallDeps) {
		this.nextId = math.floor(deps.random() * 1e9);
	}

	/** Answers other servers' roll calls until `stop` (call once per generation). Doesn't yield. */
	listen() {
		if (!isJobId(this.deps.jobId)) return; // Studio: no JobId
		this.deps.spawn(() => {
			const [ok, connection] = pcall(() => this.deps.subscribe(ROLL_CALL_TOPIC, (data) => this.onAsk(data)));
			if (!ok) {
				this.deps.warn(`[admin] roll call unavailable: ${connection}`);
				return;
			}
			if (this.stopped) connection.Disconnect();
			else this.connection = connection;
		});
	}

	private connection: RollCallConnection | undefined;

	stop() {
		this.stopped = true;
		this.connection?.Disconnect();
		this.connection = undefined;
	}

	/** Drops the cached list (the next ask calls the roll again). */
	invalidate() {
		this.cache = undefined;
	}

	private parse(data: unknown): Record<string, unknown> | undefined {
		if (!typeIs(data, "string") || data.size() > 1024) return undefined;
		const [ok, value] = pcall(() => this.deps.decode(data));
		return ok && typeIs(value, "table") ? (value as Record<string, unknown>) : undefined;
	}

	/** One ask from the ask topic. */
	onAsk(data: unknown) {
		const ask = this.parse(data);
		if (!ask || !typeIs(ask.q, "number") || !isJobId(ask.j) || !typeIs(ask.t, "number")) {
			this.counters.ignored += 1;
			return;
		}
		const asker = ask.j;
		const q = ask.q;
		if (asker === this.deps.jobId || math.abs(this.deps.unixMs() - ask.t) > ASK_MAX_AGE * 1000) {
			this.counters.ignored += 1;
			return;
		}
		const now = this.deps.clock();
		const last = this.lastReplyTo.get(asker);
		this.replied = this.replied.filter((at) => now - at < 60);
		if ((last !== undefined && now - last < REPLY_GAP) || this.replied.size() >= REPLIES_PER_MINUTE) {
			this.counters.limited += 1;
			return;
		}
		this.lastReplyTo.set(asker, now);
		this.replied.push(now);
		this.deps.spawn(() => {
			this.deps.wait(this.deps.random() * REPLY_JITTER);
			const body = this.encodeReply(q);
			if (body === undefined || this.stopped) return;
			const [ok, err] = pcall(() => this.deps.publish(replyTopic(asker), body));
			if (ok) this.counters.answered += 1;
			else this.deps.warn(`[admin] roll call reply failed: ${err}`);
		});
	}

	/** `{ q, j, s }` within MAX_REPLY_BYTES: drops `e`, then `k`, if the row is too big; undefined when silent. */
	encodeReply(q: number): string | undefined {
		const entry = this.deps.entry();
		if (entry === undefined) return undefined;
		const row = { ...entry };
		let body = this.deps.encode({ q, j: this.deps.jobId, s: row });
		for (const field of ["e", "k"]) {
			if (body.size() <= MAX_REPLY_BYTES) break;
			(row as Record<string, unknown>)[field] = undefined;
			body = this.deps.encode({ q, j: this.deps.jobId, s: row });
		}
		return body.size() <= MAX_REPLY_BYTES ? body : undefined;
	}

	/** The universe's servers (not this one): cached, one roll call at a time. Yields up to COLLECT_SECONDS. */
	ask(): RollCallList {
		const cache = this.cache;
		if (cache && this.deps.clock() - cache.at < (cache.error !== undefined ? ERROR_CACHE_SECONDS : CACHE_SECONDS)) return cache;
		if (this.waiting) {
			this.waiting.push(coroutine.running());
			coroutine.yield();
			return this.cache ?? { at: this.deps.clock(), rows: [], truncated: false, error: "no_reply" };
		}
		const mine = new Array<thread>();
		this.waiting = mine;
		this.cache = this.call();
		this.waiting = undefined;
		for (const thread of mine) if (coroutine.status(thread) === "suspended") task.spawn(thread);
		return this.cache;
	}

	private call(): RollCallList {
		const at = this.deps.clock();
		if (!isJobId(this.deps.jobId)) return { at, rows: [], truncated: false };
		this.nextId += 1;
		const q = this.nextId;
		const rows = new Map<string, Record<string, unknown>>();
		let truncated = false;
		const [subscribed, connection] = pcall(() =>
			this.deps.subscribe(replyTopic(this.deps.jobId), (data) => {
				const reply = this.parse(data);
				if (!reply || reply.q !== q || !isJobId(reply.j) || !typeIs(reply.s, "table")) return;
				if (rows.size() >= MAX_ROWS && !rows.has(reply.j)) {
					truncated = true;
					return;
				}
				rows.set(reply.j, reply.s as Record<string, unknown>);
			}),
		);
		if (!subscribed) return { at, rows: [], truncated: false, error: tostring(connection) };
		const [published, err] = pcall(() =>
			this.deps.publish(ROLL_CALL_TOPIC, this.deps.encode({ q, j: this.deps.jobId, t: this.deps.unixMs() })),
		);
		if (!published) {
			connection.Disconnect();
			return { at, rows: [], truncated: false, error: tostring(err) };
		}
		this.counters.asked += 1;
		this.deps.wait(COLLECT_SECONDS);
		connection.Disconnect();
		const list = new Array<RollCallRow>();
		for (const [key, value] of rows) if (key !== this.deps.jobId) list.push({ key, value });
		return { at: this.deps.clock(), rows: list, truncated };
	}
}
