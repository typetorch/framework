import { Workspace } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type {
	Channel,
	GameMessageMeta,
	MessageTarget,
	MessagingPublishOptions,
	MessagingStatus,
	ServerKernel,
	ServerType,
} from "./kernel";
import { Relay } from "./runtime/relay";

/**
 * `TypeTorch.messaging` (server only, kernel 0.3.8; plans/19 item 4): cross-server messages for game code, over ONE
 * MessagingService topic the kernel holds (`TypeTorch/game`).
 *
 * - **Topics** are names (1-64 characters of letters, digits and `_ - . : /`; `__` is reserved), multiplexed over the
 *   kernel's topic: a game's "1guard" becomes `TypeTorch.messaging.subscribe("1guard", ...)`. The kernel subscribes once
 *   and keeps the subscription for the server's life, so a swap never subscribes again; listeners belong to this
 *   generation (its trove) and go with it. A message that arrives mid-swap is kept and replayed to the next generation.
 * - **Tags:** every message carries its sender's JobId, branch, effective channel (prod/dev), server type and place
 *   version (`meta`). By default a listener hears prod-channel servers and servers on its own branch, so a dev branch
 *   never reaches prod (a dev test of a "ban" or an announcement stays on dev servers); `from` widens or narrows that.
 *   `publish(..., { to })` limits who hears it: "prod" or "branch". Tags aren't authentication: any code that can
 *   publish to the universe's MessagingService could forge them.
 * - **Limits** (Roblox, checked by the kernel): a message is at most 1 KiB, counted on the JSON-escaped envelope (about
 *   850 bytes of data). The universe delivers about 80 messages a minute on one topic in total (40 + 80 x servers
 *   receives a minute, and every server receives every message): the kernels slow publishing down together near that.
 *   Publishing doesn't yield; it queues and retries.
 * - **Studio** never touches MessagingService: messages loop back to the session. The cloud test (`typetorch test
 *   --cloud`) publishes nothing. Edit mode (no kernel) loops back too.
 * - **Older kernels** (before 0.3.8): `subscribe` and `publish` throw "needs kernel 0.3.8"; use MessagingService until
 *   the place's kernel is updated.
 */

/** The first kernel with `TypeTorch.messaging` and the kernel-held roll call topic. */
export const MESSAGING_KERNEL = "0.3.8";
export const TOPIC_MAX = 64;
const TOPIC_PATTERN = "^[%w_%-%.:/]+$";
const DEPTH_MAX = 16;

/** Which senders a listener hears (default: prod-channel servers and servers on this branch). */
export type MessageSource = "all" | "prod" | "branch";

export interface MessagingSubscribeOptions {
	/**
	 * "all": every server of the universe (dev branches too); "prod": prod-channel servers only; "branch": servers on this
	 * server's branch only. Default: prod-channel servers and this branch's.
	 */
	from?: MessageSource;
}

export interface MessagingApi {
	/**
	 * Server only. `callback(data, meta)` for every message on `topic`, from this server too (`meta.self`), while this
	 * generation runs. Returns a disconnect (a trove takes it: `this.trove.add(TypeTorch.messaging.subscribe(...))`).
	 * Each call runs in its own thread of this generation. Throws on a bad topic, on a client, and on kernels before 0.3.8.
	 */
	subscribe<T = unknown>(
		topic: string,
		callback: (data: T, meta: GameMessageMeta) => void,
		options?: MessagingSubscribeOptions,
	): () => void;
	/**
	 * Server only. Sends `data` (plain JSON data: strings, numbers, booleans, arrays, string-keyed tables) to every
	 * server's listeners of `topic`. Doesn't yield: the kernel queues it and retries. Returns false when it was dropped at
	 * once (the queue is full, the server is closing). Throws on a bad topic or data, a message over 1 KiB (with its size),
	 * on a client, and on kernels before 0.3.8. A no-op in the cloud test.
	 */
	publish(topic: string, data: unknown, options?: MessagingPublishOptions): boolean;
	/** Server only: the kernel's counters, queue and budget (undefined before kernel 0.3.8). */
	status(): MessagingStatus | undefined;
}

/** Why `topic` isn't a valid game topic, or undefined. */
export function topicProblem(topic: unknown): string | undefined {
	if (!typeIs(topic, "string")) return "the topic must be a string";
	if (topic.size() === 0 || topic.size() > TOPIC_MAX) return `the topic must be 1-${TOPIC_MAX} characters`;
	if (topic.match(TOPIC_PATTERN)[0] === undefined) return "the topic may only use letters, digits and _ - . : /";
	if (topic.sub(1, 2) === "__") return "topics starting with __ are reserved";
	return undefined;
}

/**
 * Why `value` can't travel as JSON, or undefined (the kernel checks the same rules): nil, booleans, finite numbers,
 * strings, and tables that are arrays (1..n, no holes) or have string keys, with no metatable or cycle.
 */
export function jsonProblem(value: unknown, depth = 1, seen = new Set<object>()): string | undefined {
	if (value === undefined || typeIs(value, "boolean") || typeIs(value, "string")) return undefined;
	if (typeIs(value, "number")) {
		return value !== value || value === math.huge || value === -math.huge ? "a number that isn't finite (NaN or inf)" : undefined;
	}
	if (!typeIs(value, "table")) return `a value of type ${typeOf(value)} (send plain data: strings, numbers, booleans, tables)`;
	if (depth > DEPTH_MAX) return `tables nested deeper than ${DEPTH_MAX}`;
	if (seen.has(value)) return "a table that contains itself";
	if (getmetatable(value) !== undefined) return "a table with a metatable (a class instance?)";
	seen.add(value);
	let count = 0;
	let stringKeys = false;
	let numberKeys = false;
	for (const [key, inner] of pairs(value as Record<string | number, unknown>)) {
		if (typeIs(key, "string")) stringKeys = true;
		else if (typeIs(key, "number")) numberKeys = true;
		else return `a table key of type ${typeOf(key)}`;
		count += 1;
		const problem = jsonProblem(inner, depth + 1, seen);
		if (problem !== undefined) return problem;
	}
	seen.delete(value);
	if (stringKeys && numberKeys) return "a table mixing array items and string keys";
	if (numberKeys && count !== (value as unknown[]).size()) return "an array with holes or non-integer keys";
	return undefined;
}

/** Whether a listener with `from` hears a message tagged `meta`, on a server on `branch`. */
export function hears(from: MessageSource | undefined, meta: GameMessageMeta, branch: string): boolean {
	if (from === "all") return true;
	if (from === "prod") return meta.channel === "prod";
	if (from === "branch") return meta.branch === branch;
	return meta.channel === "prod" || meta.branch === branch;
}

/** `typetorch test --cloud` runs this generation (the stub kernel's `test`, or the place's TypeTorchTest attribute). */
export function isCloudTest(kernel: unknown): boolean {
	if (typeIs(kernel, "table") && (kernel as { test?: unknown }).test === true) return true;
	const [ok, flag] = pcall(() => Workspace.GetAttribute("TypeTorchTest"));
	return ok && flag === true;
}

/** "0.2.0" < "0.2.1"; missing parts count as 0. */
function versionLess(a: string, b: string): boolean {
	const left = a.split(".");
	const right = b.split(".");
	for (let index = 0; index < math.max(left.size(), right.size()); index++) {
		const x = tonumber(left[index]) ?? 0;
		const y = tonumber(right[index]) ?? 0;
		if (x !== y) return x < y;
	}
	return false;
}

interface Listener {
	callback: (data: unknown, meta: GameMessageMeta) => void;
	from?: MessageSource;
}

interface TopicEntry {
	listeners: Set<Listener>;
	/** The kernel listener of this topic (one per topic per generation). */
	disconnect?: () => void;
}

interface Binding {
	realm: "server" | "client";
	kernel?: ServerKernel;
	trove: Trove;
	relay?: Relay;
	branch: string;
	kernelVersion: string;
	test: boolean;
	topics: Map<string, TopicEntry>;
}

let binding: Binding | undefined;
/** Edit mode (no kernel): this process only. */
const localTopics = new Map<string, TopicEntry>();
/** Publishes the cloud test skipped (for tests). */
let skipped = 0;

function hasMethod(kernel: object, name: string): boolean {
	return typeIs((kernel as Record<string, unknown>)[name], "function");
}

function needsKernel(current: Binding): string {
	if (versionLess(current.kernelVersion, MESSAGING_KERNEL)) {
		return `TypeTorch.messaging needs kernel ${MESSAGING_KERNEL} (this server runs ${current.kernelVersion}): update the place's kernel (typetorch kernel deploy), or keep using MessagingService until then`;
	}
	return `TypeTorch.messaging: this place's kernel ${current.kernelVersion} doesn't map its Messaging module (TypeTorchKernel.Messaging in kernel/place.project.json): run typetorch kernel deploy`;
}

function serverOnly(name: string) {
	if (binding?.realm === "client") error(`TypeTorch.messaging.${name} is server-only`, 3);
}

function deliver(entry: TopicEntry | undefined, data: unknown, meta: GameMessageMeta, branch: string) {
	if (entry === undefined) return;
	for (const listener of [...entry.listeners]) {
		if (hears(listener.from, meta, branch)) task.spawn(listener.callback, data, meta);
	}
}

class MessagingRuntime implements MessagingApi {
	subscribe<T = unknown>(
		topic: string,
		callback: (data: T, meta: GameMessageMeta) => void,
		options?: MessagingSubscribeOptions,
	): () => void {
		serverOnly("subscribe");
		const problem = topicProblem(topic);
		if (problem !== undefined) error(`TypeTorch.messaging.subscribe: ${problem}`, 2);
		if (!typeIs(callback, "function")) error("TypeTorch.messaging.subscribe: the callback must be a function", 2);
		const from = options?.from;
		if (from !== undefined && from !== "all" && from !== "prod" && from !== "branch") {
			error('TypeTorch.messaging.subscribe: options.from must be "all", "prod" or "branch"', 2);
		}
		const current = binding;
		const kernel = current?.kernel;
		const live = current !== undefined && kernel !== undefined && !current.test;
		if (live && !hasMethod(kernel, "messagingSubscribe")) error(needsKernel(current), 2);
		const topics = current?.topics ?? localTopics;
		let entry = topics.get(topic);
		if (entry === undefined) {
			entry = { listeners: new Set() };
			topics.set(topic, entry);
		}
		const listener: Listener = { callback: callback as (data: unknown, meta: GameMessageMeta) => void, from };
		entry.listeners.add(listener);
		if (live && entry.disconnect === undefined) {
			// One kernel listener per topic; its calls (kernel threads) move onto this generation's threads.
			const relay = (current.relay ??= new Relay(current.trove));
			const mine = entry;
			const branch = current.branch;
			entry.disconnect = kernel.messagingSubscribe!(topic, (data, meta) =>
				relay.run(() => {
					if (binding === current) deliver(mine, data, meta, branch);
				}),
			);
		}
		const owner = entry;
		return () => {
			if (!owner.listeners.delete(listener) || owner.listeners.size() > 0) return;
			owner.disconnect?.();
			owner.disconnect = undefined;
			if (topics.get(topic) === owner) topics.delete(topic);
		};
	}

	publish(topic: string, data: unknown, options?: MessagingPublishOptions): boolean {
		serverOnly("publish");
		const problem = topicProblem(topic);
		if (problem !== undefined) error(`TypeTorch.messaging.publish: ${problem}`, 2);
		const to: MessageTarget | undefined = options?.to;
		if (to !== undefined && to !== "all" && to !== "prod" && to !== "branch") {
			error('TypeTorch.messaging.publish: options.to must be "all", "prod" or "branch"', 2);
		}
		const current = binding;
		const kernel = current?.kernel;
		if (current === undefined || kernel === undefined || current.test) {
			const bad = jsonProblem(data);
			if (bad !== undefined) error(`TypeTorch.messaging.publish("${topic}"): the data can't travel as JSON: ${bad}`, 2);
			if (current?.test) {
				// typetorch test --cloud: no message ever leaves the task (no fake announcements from the gate).
				skipped += 1;
				return true;
			}
			// Edit mode: this process only, like Studio.
			const meta: GameMessageMeta = { channel: "dev" as Channel, branch: "local", jobId: "", serverType: "studio" as ServerType, sentAt: os.time(), self: true };
			if (to !== "prod") deliver(localTopics.get(topic), data, meta, "local");
			return true;
		}
		if (!hasMethod(kernel, "messagingPublish")) error(needsKernel(current), 2);
		const report = kernel.messagingPublish!(topic, data, options);
		if (report.ok) return true;
		const error_ = report.error;
		if (error_ === "too_big") {
			const limit = report.limit ?? 1000;
			const left = math.max(0, limit - (report.overhead ?? 0));
			error(
				`TypeTorch.messaging.publish("${topic}"): the message is ${report.size} bytes, over the ${limit}-byte limit (about ${left} bytes are left for data, counted as JSON): send ids or a few short fields, not whole objects`,
				2,
			);
		}
		if (error_ === "bad_data") error(`TypeTorch.messaging.publish("${topic}"): the data can't travel as JSON: ${report.detail}`, 2);
		if (error_ === "bad_topic" || error_ === "bad_options") error(`TypeTorch.messaging.publish: ${report.detail}`, 2);
		if (error_ === "queue_full") $warn(`TypeTorch.messaging.publish("${topic}"): the kernel's queue is full; the message was dropped`);
		return false;
	}

	status(): MessagingStatus | undefined {
		const kernel = binding?.kernel;
		if (kernel === undefined || !hasMethod(kernel, "messagingStatus")) return undefined;
		return kernel.messagingStatus!();
	}
}

/** The `TypeTorch.messaging` object. */
export const messaging: MessagingApi = new MessagingRuntime();

/** Whether `TypeTorch.messaging` reaches other servers here (a server on kernel 0.3.8+ with the Messaging module). */
export function messagingSupported(): boolean {
	const kernel = binding?.kernel;
	return kernel !== undefined && hasMethod(kernel, "messagingPublish");
}

/** Called by bindTypeTorch: this generation's kernel. */
export function bindMessaging(realm: "server" | "client", kernel: unknown, trove: Trove, branch: string, kernelVersion: string) {
	binding = {
		realm,
		kernel: realm === "server" ? (kernel as ServerKernel) : undefined,
		trove,
		branch,
		kernelVersion,
		test: realm === "server" && isCloudTest(kernel),
		topics: new Map(),
	};
}

/** Called by unbindTypeTorch: the kernel already dropped this generation's listeners. */
export function unbindMessaging() {
	binding = undefined;
}

/** For tests: publishes the cloud test skipped. */
export function skippedPublishes(): number {
	return skipped;
}
