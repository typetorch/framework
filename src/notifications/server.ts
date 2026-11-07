import { HttpService, Players, Workspace } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import { builtinRowWriter } from "../analytics/rows";
import { backoffSeconds, classifyStatus, configWaitSeconds, takeToken, type BucketState } from "../analytics/queue";
import { maybeServerDispatcher } from "../net/runtime";
import { observePlayers } from "../players";
import { currentSettings, onSettings } from "../settings";
import { closeHooksSupported, onGenerationClose, TypeTorch } from "../typetorch";
import type { Notifications, NotifyOpen, OptInResult } from "./api";
import {
	BATCH_ITEMS,
	CHANNEL,
	cleanDrop,
	cleanOptInRow,
	cleanPrefs,
	cleanWant,
	newQueueState,
	nextRev,
	pushCall,
	pushItem,
	pushPrefs,
	readIntentsAnswer,
	readOpenedState,
	requeueItems,
	takeBatch,
	type Item,
	type OpenedCall,
	type PlayedCall,
	type QueueState,
	type WantOptions,
} from "./protocol";
import { keyHash, readKeys, verifyToken } from "./token";

/**
 * The server half of TypeTorch notifications (plans/29): intents and presence batched to the backend, the launch data
 * verified on join (`open` / `open_bad` rows, `onOpen`), `played` at the end of an opened session, and the client's
 * opt-in rows. One per generation, started by runtime/start.ts; everything that must survive a swap is plain data in
 * persist (the queue, who joined when, the opens).
 */

const PERSIST_KEY = "__typetorch/notify.v1";
/** HTTP budget of its own (Roblox: 500 a minute per server for everything): a burst of 5, 20 a minute. */
const HTTP_BURST = 5;
const HTTP_PER_MINUTE = 20;
/** Seconds a join waits for POST /v1/notify/opened before it counts as a first open (the call is retried later). */
const OPENED_WAIT = 5;
/** Rows held while no analytics engine runs (yet); past this the oldest go. */
const HELD_MAX = 200;
/** Opt-in rows a player's client may send per name per session. */
const OPTIN_ROWS_MAX = 3;
/** Batches per flush (more only while a full batch waits). */
const BATCHES_PER_FLUSH = 3;
const DEFAULT_FLUSH_SECONDS = 15;
/**
 * Seconds between presence refreshes (`online` again for every player still here): the backend counts a user online
 * only while their last `online` is newer than `notify.presenceStaleHours` (default 6 h), so half of that.
 */
const PRESENCE_REFRESH = 3 * 3600;

/** Presence `at`: unix milliseconds (the backend orders a user's presence by it). */
function nowMs(): number {
	return DateTime.now().UnixTimestampMillis;
}

interface OpenRecord {
	nid: string;
	k: string;
	data: string;
	age: number;
	first: boolean;
	/**
	 * Waiting for POST /v1/notify/opened: no `open` row and no onOpen yet. A swap during the wait leaves it pending and
	 * the next generation finishes it (the row once, onOpen once).
	 */
	pending: boolean;
	/** The backend's answer (first / repeat / unknown), or "failed" (the retry is queued); undefined: no answer yet. */
	state?: string;
	/** Handed to at least one onOpen callback. */
	delivered: boolean;
}

interface HeldRow {
	u?: number;
	name: string;
	props: Record<string, unknown>;
}

interface NotifyStore {
	queue: QueueState;
	/** UserId -> os.time() of the join this server handled (a swap doesn't verify twice). */
	joined: Map<string, number>;
	/** UserIds whose `online` presence was queued. */
	present: Map<string, boolean>;
	/** UserId -> the verified open of their session. */
	opens: Map<string, OpenRecord>;
	/** UserId -> opt-in row name -> count this session. */
	optin: Map<string, Map<string, number>>;
	held: HeldRow[];
	budget: BucketState;
	lastError?: string;
	/** os.time() of the last presence refresh round (every PRESENCE_REFRESH s; persisted so a swap keeps the timer). */
	presenceRefreshedAt?: number;
}

function newStore(): NotifyStore {
	return {
		queue: newQueueState(),
		joined: new Map(),
		present: new Map(),
		opens: new Map(),
		optin: new Map(),
		held: [],
		budget: { tokens: HTTP_BURST, last: os.clock() },
		presenceRefreshedAt: os.time(),
	};
}

function quote(text: string): string {
	return HttpService.JSONEncode(text);
}

function isCloudTest(kernel: ServerKernel | undefined): boolean {
	if ((kernel as unknown as { test?: unknown } | undefined)?.test === true) return true;
	const [ok, flag] = pcall(() => Workspace.GetAttribute("TypeTorchTest"));
	return ok && flag === true;
}

interface Endpoint {
	base: string;
	key: string;
}

/** `<backend.url>` and the key, when the settings record has a backend (no backend: Studio, nothing is posted). */
function endpoint(): Endpoint | undefined {
	const backend = currentSettings()?.backend as Record<string, unknown> | undefined;
	if (!typeIs(backend, "table")) return undefined;
	const url = backend.url;
	const key = backend.key;
	if (!typeIs(url, "string") || url.match("^https?://")[0] === undefined || !typeIs(key, "string") || key === "") return undefined;
	return { base: url.gsub("/+$", "")[0], key };
}

/** Notifications are set up: the record carries `backend.notify` (the CLI's `notify key rotate`). */
function configured(): boolean {
	const backend = currentSettings()?.backend as Record<string, unknown> | undefined;
	return typeIs(backend, "table") && typeIs(backend.notify, "table");
}

function flushSeconds(): number {
	const backend = currentSettings()?.backend;
	const value = backend?.analytics?.flushSeconds;
	return typeIs(value, "number") && value === value ? math.clamp(value, 5, 300) : DEFAULT_FLUSH_SECONDS;
}

function userIdOf(user: Player | number): number | undefined {
	if (typeIs(user, "Instance")) return user.IsA("Player") ? user.UserId : undefined;
	return typeIs(user, "number") ? user : undefined;
}

export class NotifyServer implements Notifications {
	private readonly store: NotifyStore;
	private readonly listeners = new Set<(player: Player, open: NotifyOpen) => void>();
	private readonly testMode: boolean;
	private stopped = false;
	private flushing = false;
	private nextFlushAt = 0;
	private backoffUntil = 0;
	private batchItems = BATCH_ITEMS;
	private readonly warned = new Map<string, number>();

	constructor(
		private readonly kernel: ServerKernel | undefined,
		private readonly trove: Trove,
	) {
		this.testMode = isCloudTest(kernel);
		this.store = TypeTorch.persist(PERSIST_KEY, newStore);
		// A request that was running when the last generation stopped: its items go again (at least once).
		const queue = this.store.queue;
		if (queue.inflight.size() > 0) requeueItems(queue, queue.inflight);
		queue.inflight = [];
		// A store from before the presence refresh: the timer starts now.
		if (this.store.presenceRefreshedAt === undefined) this.store.presenceRefreshedAt = os.time();
		trove.add(() => {
			this.stopped = true;
		});

		// Players who left while no generation listened: their sessions end now.
		const here = new Set<string>();
		for (const player of Players.GetPlayers()) here.add(tostring(player.UserId));
		for (const [key] of this.store.joined) if (!here.has(key)) this.ended(key, tonumber(key)!);

		observePlayers(trove, (player) => {
			task.spawn(() => this.joined(player));
		});
		trove.connect(Players.PlayerRemoving, (player) => this.left(player));
		trove.add(
			onSettings(() => {
				if (configured()) for (const player of Players.GetPlayers()) this.presenceOnline(player.UserId);
			}),
		);

		const dispatcher = maybeServerDispatcher();
		if (dispatcher) {
			dispatcher.setRaw(CHANNEL, (player, op, payload) => {
				if (op === "optin") this.onOptInRow(player, payload);
			});
			trove.add(() => dispatcher.removeRaw(CHANNEL));
		}

		this.nextFlushAt = os.clock() + 5;
		trove.add(task.spawn(() => this.loop()));
		if (closeHooksSupported()) trove.add(onGenerationClose(() => this.close()));
	}

	// Game API ---------------------------------------------------------------------------------------------------------

	want(user: Player | number, kind: string, options?: WantOptions): boolean {
		if (this.stopped) return false;
		const userId = userIdOf(user);
		const item = cleanWant(userId, kind, options, nextRev(this.store.queue, os.time()));
		if (typeIs(item, "string")) {
			this.warn(`want("${tostring(kind).sub(1, 32)}") refused: ${item}`);
			return false;
		}
		pushItem(this.store.queue, item);
		this.row(item.u, "want", {
			k: item.k,
			key: item.key !== undefined ? keyHash(item.key) : undefined,
			at: item.at,
			until: item.until,
			offline: Players.GetPlayerByUserId(item.u) === undefined,
		});
		return true;
	}

	drop(user: Player | number, kind: string, key?: string, why?: string): boolean {
		if (this.stopped) return false;
		const item = cleanDrop(userIdOf(user), kind, key, why, nextRev(this.store.queue, os.time()));
		if (typeIs(item, "string")) {
			this.warn(`drop("${tostring(kind).sub(1, 32)}") refused: ${item}`);
			return false;
		}
		pushItem(this.store.queue, item);
		this.row(item.u, "drop", { k: item.k, key: item.key !== undefined ? keyHash(item.key) : undefined, why: item.why });
		return true;
	}

	setOff(user: Player | number, kinds: string[]): boolean {
		if (this.stopped) return false;
		const item = cleanPrefs(userIdOf(user), kinds, nextRev(this.store.queue, os.time()));
		if (typeIs(item, "string")) {
			this.warn(`setOff refused: ${item}`);
			return false;
		}
		pushPrefs(this.store.queue, item);
		return true;
	}

	onOpen(callback: (player: Player, open: NotifyOpen) => void): () => void {
		this.listeners.add(callback);
		// Opens that no callback has seen yet (players who joined before the game connected one).
		task.defer(() => {
			if (this.stopped || !this.listeners.has(callback)) return;
			for (const player of Players.GetPlayers()) {
				const record = this.store.opens.get(tostring(player.UserId));
				if (record && !record.pending && !record.delivered) this.deliver(player, record);
			}
		});
		return () => {
			this.listeners.delete(callback);
		};
	}

	promptOptIn(_where: string): OptInResult {
		this.warn("promptOptIn() is client-only (Roblox shows the prompt on the player's device)");
		return "error";
	}

	// Joins and leaves -------------------------------------------------------------------------------------------------

	private presenceOnline(userId: number) {
		const key = tostring(userId);
		if (this.store.present.has(key) || !configured()) return;
		this.store.present.set(key, true);
		pushItem(this.store.queue, { op: "presence", u: userId, online: true, at: nowMs() });
	}

	/** Every PRESENCE_REFRESH s: `online` again for every player still here (one round per server, swaps included). */
	private refreshPresence() {
		const store = this.store;
		const now = os.time();
		if (now - (store.presenceRefreshedAt ?? now) < PRESENCE_REFRESH) return;
		store.presenceRefreshedAt = now;
		if (!configured()) return;
		const at = nowMs();
		for (const player of Players.GetPlayers()) {
			if (store.present.has(tostring(player.UserId))) pushItem(store.queue, { op: "presence", u: player.UserId, online: true, at });
		}
	}

	private joined(player: Player) {
		if (this.stopped || player.Parent !== Players) return;
		const key = tostring(player.UserId);
		this.presenceOnline(player.UserId);
		// Handled by this server already (a swap): verified once, by the generation that saw the join. An open still
		// waiting for the backend when that generation stopped is finished here.
		if (this.store.joined.has(key)) {
			const pending = this.store.opens.get(key);
			if (pending && pending.pending) this.finishOpen(player, pending);
			return;
		}
		this.store.joined.set(key, os.time());
		const [ok, data] = pcall(() => player.GetJoinData());
		if (!ok || !data) return;
		const verdict = verifyToken(data.LaunchData, player.UserId, readKeys(currentSettings()?.backend?.notify), os.time());
		if (verdict === undefined) return;
		if (!verdict.ok) {
			this.row(player, "open_bad", { why: verdict.why });
			return;
		}
		const record: OpenRecord = {
			nid: verdict.nid,
			k: verdict.kind,
			data: verdict.data,
			age: verdict.ageSeconds,
			first: true,
			pending: true,
			delivered: false,
		};
		this.store.opens.set(key, record);
		this.opened(player.UserId, record);
		// Stopped during the wait: the record stays pending for the next generation.
		if (this.stopped) return;
		this.finishOpen(player, record);
	}

	/**
	 * The `open` row and onOpen, once per open: `first` from the backend's answer; without one (a failure, the wait ran
	 * out, or a swap cut the request off) true, with the opened call queued for retry unless it already is.
	 */
	private finishOpen(player: Player, record: OpenRecord) {
		if (!record.pending) return;
		record.pending = false;
		const state = record.state;
		if (state === undefined && endpoint() && !this.testMode) {
			const queued = this.store.queue.opened.some((call) => call.nid === record.nid && call.u === player.UserId);
			if (!queued) pushCall(this.store.queue.opened, { nid: record.nid, u: player.UserId });
		}
		record.first = state === undefined || state === "failed" || state === "first";
		this.row(player, "open", { nid: record.nid, k: record.k, age: record.age, first: record.first });
		if (player.Parent === Players) this.deliver(player, record);
	}

	/**
	 * POST /v1/notify/opened, waiting at most OPENED_WAIT: the answer goes into `record.state` (in persist, so a
	 * generation after a swap can read it); a failure queues the call for retry and sets "failed". No backend (Studio)
	 * or no HTTP budget: "failed" without a request (the budget case is queued).
	 */
	private opened(userId: number, record: OpenRecord) {
		const target = endpoint();
		if (!target || this.testMode) {
			record.state = "failed";
			return;
		}
		const call: OpenedCall = { nid: record.nid, u: userId };
		if (!takeToken(this.store.budget, os.clock(), HTTP_BURST, HTTP_PER_MINUTE)) {
			pushCall(this.store.queue.opened, call);
			record.state = "failed";
			return;
		}
		let done = false;
		task.spawn(() => {
			const [status, body] = this.post(target, "/v1/notify/opened", `{"nid":${quote(record.nid)},"u":${string.format("%d", userId)}}`);
			const answer = status >= 200 && status < 300 ? readOpenedState(this.decode(body)) : undefined;
			if (answer === undefined && classifyStatus(status) !== "drop") pushCall(this.store.queue.opened, call);
			if (record.pending) record.state = answer ?? "failed";
			done = true;
		});
		const deadline = os.clock() + OPENED_WAIT;
		while (!done && os.clock() < deadline && !this.stopped) task.wait(0.1);
		// The wait ran out: first = true now; a late answer changes nothing, a late failure queues the retry itself.
		if (!done && !this.stopped) record.state = "failed";
	}

	private deliver(player: Player, record: OpenRecord) {
		if (this.listeners.size() === 0 || record.delivered) return;
		record.delivered = true;
		const open: NotifyOpen = { nid: record.nid, kind: record.k, data: record.data, ageSeconds: record.age, first: record.first };
		for (const listener of [...this.listeners]) {
			task.spawn(() => {
				const [ok, err] = pcall(listener, player, table.clone(open));
				if (!ok) $warn(`[notifications] an onOpen callback threw: ${err}`);
			});
		}
	}

	private left(player: Player) {
		this.ended(tostring(player.UserId), player.UserId);
	}

	/** The session of `userId` ended: `played` for an opened one, presence offline. */
	private ended(key: string, userId: number) {
		const joinedAt = this.store.joined.get(key);
		const record = this.store.opens.get(key);
		if (record && joinedAt !== undefined) {
			const secs = math.max(0, os.time() - joinedAt);
			this.row(userId, "played", { nid: record.nid, k: record.k, secs });
			if (endpoint() && !this.testMode) pushCall<PlayedCall>(this.store.queue.played, { nid: record.nid, u: userId, secs });
		}
		if (this.store.present.has(key)) pushItem(this.store.queue, { op: "presence", u: userId, online: false, at: nowMs() });
		this.store.joined.delete(key);
		this.store.opens.delete(key);
		this.store.present.delete(key);
		this.store.optin.delete(key);
	}

	// Rows -------------------------------------------------------------------------------------------------------------

	/** A `notify` row through the analytics engine; held (at most HELD_MAX) while none runs yet. */
	private row(target: Player | number, name: string, props: Record<string, unknown>) {
		const writer = builtinRowWriter();
		if (writer) {
			this.drainHeld();
			writer(target, "notify", name, props);
			return;
		}
		const held = this.store.held;
		held.push({ u: typeIs(target, "number") ? target : target.UserId, name, props });
		while (held.size() > HELD_MAX) held.remove(0);
	}

	private drainHeld() {
		const writer = builtinRowWriter();
		const held = this.store.held;
		if (!writer || held.size() === 0) return;
		this.store.held = [];
		for (const row of held) writer(row.u, "notify", row.name, row.props);
	}

	/** A client's opt-in row: checked here, written by this server (never a raw client row), capped per session. */
	private onOptInRow(player: Player, payload: unknown) {
		if (this.stopped) return;
		const row = cleanOptInRow(payload);
		if (!row) return;
		const key = tostring(player.UserId);
		let counts = this.store.optin.get(key);
		if (!counts) {
			counts = new Map();
			this.store.optin.set(key, counts);
		}
		const count = counts.get(row.name) ?? 0;
		if (count >= OPTIN_ROWS_MAX) return;
		counts.set(row.name, count + 1);
		this.row(player, row.name, { where: row.where, can: row.can, err: row.err, secs: row.secs });
	}

	// Sending ----------------------------------------------------------------------------------------------------------

	private decode(body: string): unknown {
		const [ok, value] = pcall(() => HttpService.JSONDecode(body));
		return ok ? value : undefined;
	}

	/** POST JSON to the backend with its key (the ingest headers). Returns the status (0: no response) and body. Never logs the key. */
	private post(target: Endpoint, path: string, body: string): [number, string] {
		const kernel = this.kernel;
		if (kernel !== undefined && typeIs((kernel as unknown as Record<string, unknown>).budgetCount, "function")) {
			pcall(() => kernel.budgetCount!("framework", "http", "notify"));
		}
		const [ok, response] = pcall(() =>
			HttpService.RequestAsync({
				Url: `${target.base}${path}`,
				Method: "POST",
				Headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.key}` },
				Body: body,
			}),
		);
		if (!ok) {
			this.store.lastError = `${path}: ${tostring(response).sub(1, 120)}`;
			return [0, ""];
		}
		if (!response.Success) this.store.lastError = `${path}: HTTP ${response.StatusCode}`;
		return [response.StatusCode, response.Body];
	}

	private fail(status: number, what: string) {
		const queue = this.store.queue;
		queue.failures += 1;
		const wait = classifyStatus(status) === "config" ? configWaitSeconds(math.random()) : backoffSeconds(queue.failures, math.random());
		this.backoffUntil = os.clock() + wait;
		this.warn(`${what} failed (${status === 0 ? "no response" : `HTTP ${status}`}); retrying in ${math.floor(wait)} s`);
	}

	/** One round: intents (up to BATCHES_PER_FLUSH batches), then the opened / played retries. `final`: ignore the budget. */
	private flushOnce(final: boolean) {
		const target = endpoint();
		const queue = this.store.queue;
		if (this.testMode) {
			queue.items = [];
			queue.opened = [];
			queue.played = [];
			return;
		}
		if (!target || this.flushing) return;
		this.flushing = true;
		this.nextFlushAt = os.clock() + flushSeconds();
		let failed = false;
		for (let round = 0; round < BATCHES_PER_FLUSH && queue.items.size() > 0 && !failed; round++) {
			if (round > 0 && queue.items.size() < BATCH_ITEMS) break;
			if (!final && !takeToken(this.store.budget, os.clock(), HTTP_BURST, HTTP_PER_MINUTE)) break;
			const [batch, body] = takeBatch(queue, quote, this.batchItems);
			queue.inflight = batch;
			const [status, answerText] = this.post(target, "/v1/notify/intents", body);
			const outcome = classifyStatus(status);
			if (outcome === "sent") {
				const answer = readIntentsAnswer(this.decode(answerText));
				queue.sent += batch.size() - answer.rejected;
				queue.failures = 0;
				this.batchItems = BATCH_ITEMS;
				if (answer.rejected > 0) {
					queue.rejected += answer.rejected;
					this.warn(`the backend refused ${answer.rejected} notification intent(s)${answer.why !== undefined ? ` (${answer.why})` : ""}`);
				}
			} else if (outcome === "split" && batch.size() > 1) {
				requeueItems(queue, batch);
				this.batchItems = math.max(1, math.floor(batch.size() / 2));
			} else if (outcome === "drop" || outcome === "split") {
				queue.rejected += batch.size();
				this.warn(`the backend refused a batch of ${batch.size()} notification intent(s) (HTTP ${status}); dropped`);
			} else {
				requeueItems(queue, batch);
				failed = true;
				this.fail(status, "notification intents upload");
			}
			queue.inflight = [];
		}
		if (!failed) failed = this.retryCalls(target, final, queue.opened, "/v1/notify/opened", (call) => `{"nid":${quote(call.nid)},"u":${string.format("%d", call.u)}}`);
		if (!failed) this.retryCalls(target, final, queue.played, "/v1/notify/played", (call) => `{"nid":${quote(call.nid)},"u":${string.format("%d", call.u)},"secs":${string.format("%d", call.secs)}}`);
		this.flushing = false;
	}

	/** Sends queued single calls oldest first; stops at the first retryable failure (returns true then). */
	private retryCalls<T extends OpenedCall>(target: Endpoint, final: boolean, list: T[], path: string, encode: (call: T) => string): boolean {
		while (list.size() > 0) {
			if (!final && !takeToken(this.store.budget, os.clock(), HTTP_BURST, HTTP_PER_MINUTE)) return false;
			const call = list[0];
			const [status] = this.post(target, path, encode(call));
			const outcome = classifyStatus(status);
			if (outcome === "retry" || outcome === "config") {
				this.fail(status, path);
				return true;
			}
			// Sent, or refused for good: either way it leaves the list (it may have moved while the request yielded).
			const index = list.indexOf(call);
			if (index >= 0) list.remove(index);
			if (outcome === "sent") this.store.queue.failures = 0;
		}
		return false;
	}

	private loop() {
		while (!this.stopped) {
			task.wait(1);
			if (builtinRowWriter() && this.store.held.size() > 0) this.drainHeld();
			this.refreshPresence();
			const now = os.clock();
			if (now < this.backoffUntil) continue;
			const queue = this.store.queue;
			const waiting = queue.items.size() + queue.opened.size() + queue.played.size();
			if (waiting === 0) continue;
			if (now >= this.nextFlushAt || queue.items.size() >= BATCH_ITEMS) this.flushOnce(false);
		}
	}

	/** Server shutdown: every session ends (played, presence offline) and what waits is sent once. */
	private close() {
		if (this.stopped) return;
		for (const player of Players.GetPlayers()) this.left(player);
		const deadline = os.clock() + 10;
		while (this.flushing && os.clock() < deadline) task.wait(0.1);
		this.flushOnce(true);
	}

	/** At most one line per message a minute. */
	private warn(message: string) {
		const now = os.clock();
		const last = this.warned.get(message);
		if (last !== undefined && now - last < 60) return;
		this.warned.set(message, now);
		$warn(`[notifications] ${message}`);
	}

	/** Counters for tests and the dev menu. */
	stats() {
		const queue = this.store.queue;
		return {
			configured: configured(),
			posting: endpoint() !== undefined && !this.testMode,
			queued: queue.items.size(),
			opened: queue.opened.size(),
			played: queue.played.size(),
			sent: queue.sent,
			rejected: queue.rejected,
			dropped: queue.dropped,
			failures: queue.failures,
			lastError: this.store.lastError,
		};
	}
}

export type { Item };
