import { HttpService } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { KernelSettings, ServerKernel } from "./kernel";
import { Relay } from "./runtime/relay";

/**
 * The signed settings record (kernel 0.3.8, plans/20) for game code and built-ins, server only.
 *
 * The kernel reads one DataStore entry the CLI writes and signs with both prod keys (`typetorch settings ...`,
 * `fleet setup`, `access push`), verifies it, keeps the last good copy, and hands this generation a copy
 * (`api:settings()`) plus every new one (`api:onSettingsChanged`). It replaced ConfigService: `analytics` and `fleet`
 * feed the AnalyticsEngine, and `game` holds the game's own live values (flags, kill switches, prices):
 *
 *   const price = TypeTorch.liveConfig("shop.price", { default: 50, parse: (raw) => t.number(raw) ? raw : 50 });
 *   price.get(); // the current value (the default without a record, a key or kernel 0.3.8)
 *   this.trove.add(price.onChanged((value) => this.reprice(value)));
 *
 * `typetorch settings set game.shop.price 75` changes it on every server within seconds (the CLI pings them). Values
 * are JSON; the whole `game` field is at most 16 KB. Server only: nothing of it reaches clients (the record holds
 * tokens); send what a client needs through your own network.
 * Older kernels: liveConfig gives the default and warns once ("needs kernel 0.3.8"); there is no ConfigService fallback.
 *
 * Scheduled live events (the explorer's Live events page): `game["tt.events"]` is a schedule the owner signs with the
 * CLI like any other value, `{ v: 1, events: [{ id, name, start, end, set: { [key]: JSON } }] }` (unix seconds, UTC).
 * While an event runs (start <= now < end, this server's clock) its `set` values replace the record's `game[key]` for
 * liveConfig, so `get()` and `onChanged` switch at the start and end times on their own: no message is needed, a
 * server that starts mid-event picks it up, and the event still ends when the backend is down. Two events setting the
 * same key at once: the later start wins (then the higher id). `liveEvents()` lists them for game UI.
 */

/** The first kernel with the signed settings record. */
export const SETTINGS_KERNEL = "0.3.8";

export interface LiveConfigOptions<T> {
	/** The value without a record, without the key, on older kernels, or when `parse` throws. */
	default: T;
	/** Turns the raw JSON value into T (throw to refuse it: the default is used, with one warning per value). */
	parse?: (raw: unknown) => T;
}

export interface LiveConfig<T> {
	readonly key: string;
	/** The current value (cheap: no yield). */
	get(): T;
	/**
	 * fn(value, previous) when the value changes (a new settings copy whose `game[key]` differs). Belongs to this
	 * generation; returns a disconnect for the trove.
	 */
	onChanged(callback: (value: T, previous: T) => void): () => void;
}

interface Binding {
	realm: "server" | "client";
	kernel?: ServerKernel;
	kernelVersion: string;
	current?: KernelSettings;
}

let binding: Binding | undefined;
const listeners = new Set<(settings: KernelSettings | undefined) => void>();
/** Called when a scheduled event starts or ends (the copy didn't change, the clock crossed a boundary). */
const tickListeners = new Set<() => void>();
let boundaryThread: thread | undefined;

/** The `game` key of the signed live event schedule (written by `typetorch settings set game.tt.events -`). */
export const LIVE_EVENTS_KEY = "tt.events";
/** The most events a schedule may hold (the rest are ignored). */
export const LIVE_EVENTS_MAX = 64;
/** The longest wait between two looks at the clock (so a clock jump or a long sleep can't delay a switch for long). */
const BOUNDARY_RECHECK_SECONDS = 60;

/** One scheduled live event from the signed schedule. */
export interface LiveEvent {
	readonly id: string;
	readonly name: string;
	/** Unix seconds (UTC), inclusive. */
	readonly startsAt: number;
	/** Unix seconds (UTC), exclusive. */
	readonly endsAt: number;
	/** The `game` values it sets while it runs. */
	readonly set: Readonly<Record<string, unknown>>;
}

export interface LiveEvents {
	/** The events running now (start order). */
	active(): LiveEvent[];
	/** The events not started yet (start order). */
	upcoming(): LiveEvent[];
	/** fn(active) when the set of running events changes (a start, an end, a new schedule). Returns a disconnect. */
	onChanged(callback: (active: LiveEvent[]) => void): () => void;
}

let parsedFor: KernelSettings | undefined;
let parsedEvents: LiveEvent[] = [];

/** The schedule in a settings copy, checked (a bad entry is skipped, never an error), in start order. */
export function scheduleOf(settings: KernelSettings | undefined): LiveEvent[] {
	if (settings === undefined) return [];
	if (settings === parsedFor) return parsedEvents;
	const out: LiveEvent[] = [];
	const values = settings.game;
	const raw = typeIs(values, "table") ? (values as Record<string, unknown>)[LIVE_EVENTS_KEY] : undefined;
	if (typeIs(raw, "table")) {
		const record = raw as { v?: unknown; events?: unknown };
		if (record.v === 1 && typeIs(record.events, "table")) {
			for (const item of record.events as unknown[]) {
				if (out.size() >= LIVE_EVENTS_MAX) break;
				if (!typeIs(item, "table")) continue;
				const e = item as { id?: unknown; name?: unknown; start?: unknown; end?: unknown; set?: unknown };
				if (!typeIs(e.id, "string") || !typeIs(e.start, "number") || !typeIs(e.end, "number") || !typeIs(e.set, "table")) continue;
				if (e.start !== e.start || e.end !== e.end || e.end <= e.start) continue;
				out.push({ id: e.id, name: typeIs(e.name, "string") ? e.name : e.id, startsAt: e.start, endsAt: e.end, set: e.set as Record<string, unknown> });
			}
		}
	}
	out.sort((a, b) => (a.startsAt !== b.startsAt ? a.startsAt < b.startsAt : a.id < b.id));
	parsedFor = settings;
	parsedEvents = out;
	return out;
}

/** The events running at `now` (start order). */
export function activeAt(settings: KernelSettings | undefined, now: number): LiveEvent[] {
	return scheduleOf(settings).filter((e) => e.startsAt <= now && now < e.endsAt);
}

/** The soonest start or end after `now`, or undefined. */
function nextBoundary(settings: KernelSettings | undefined, now: number): number | undefined {
	let soonest: number | undefined;
	for (const e of scheduleOf(settings)) {
		for (const at of [e.startsAt, e.endsAt]) if (at > now && (soonest === undefined || at < soonest)) soonest = at;
	}
	return soonest;
}

/** Wakes at the soonest start or end (or within BOUNDARY_RECHECK_SECONDS) and tells the tick listeners. */
function scheduleBoundary(current: Binding) {
	if (boundaryThread !== undefined) {
		pcall(task.cancel, boundaryThread);
		boundaryThread = undefined;
	}
	if (binding !== current) return;
	const now = os.time();
	const soonest = nextBoundary(current.current, now);
	if (soonest === undefined) return;
	const wait = math.clamp(soonest - now, 0, BOUNDARY_RECHECK_SECONDS) + 0.05;
	boundaryThread = task.delay(wait, () => {
		boundaryThread = undefined;
		if (binding !== current) return;
		for (const listener of [...tickListeners]) task.spawn(listener);
		scheduleBoundary(current);
	});
}

function hasMethod(kernel: object, name: string): boolean {
	return typeIs((kernel as Record<string, unknown>)[name], "function");
}

/** Called by bindTypeTorch: this generation's copy and the kernel's change hook (server, kernel 0.3.8+). */
export function bindSettings(realm: "server" | "client", kernel: unknown, trove: Trove, kernelVersion: string) {
	listeners.clear();
	tickListeners.clear();
	const current: Binding = { realm, kernelVersion, kernel: realm === "server" ? (kernel as ServerKernel) : undefined };
	binding = current;
	const server = current.kernel;
	if (server === undefined || !hasMethod(server, "settings")) return;
	const [ok, copy] = pcall(() => server.settings!());
	if (ok) current.current = copy;
	scheduleBoundary(current);
	if (hasMethod(server, "onSettingsChanged")) {
		// Kernel threads -> this generation's threads (the hard stop ends a listener that still runs).
		const relay = new Relay(trove);
		server.onSettingsChanged!((settings) =>
			relay.run(() => {
				if (binding !== current) return;
				current.current = settings;
				scheduleBoundary(current);
				for (const listener of [...listeners]) task.spawn(listener, settings);
			}),
		);
	}
}

/** Called by unbindTypeTorch. */
export function unbindSettings() {
	binding = undefined;
	listeners.clear();
	tickListeners.clear();
	if (boundaryThread !== undefined) {
		pcall(task.cancel, boundaryThread);
		boundaryThread = undefined;
	}
}

/** Whether the running kernel has the signed settings (0.3.8+, a server). */
export function settingsSupported(): boolean {
	const kernel = binding?.kernel;
	return kernel !== undefined && hasMethod(kernel, "settings");
}

/** This generation's copy of the settings (server only; undefined: none held, a client, an older kernel). */
export function currentSettings(): KernelSettings | undefined {
	return binding?.current;
}

/** fn() when a scheduled live event starts or ends while this generation runs. Returns a disconnect. */
function onTick(callback: () => void): () => void {
	tickListeners.add(callback);
	return () => {
		tickListeners.delete(callback);
	};
}

/** fn(settings) after every new copy while this generation runs. Returns a disconnect. */
export function onSettings(callback: (settings: KernelSettings | undefined) => void): () => void {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

const warned = new Set<string>();
function warnOnce(key: string, text: string) {
	if (warned.has(key)) return;
	warned.add(key);
	$warn(text);
}

function encoded(value: unknown): string {
	if (value === undefined) return "";
	const [ok, text] = pcall(() => HttpService.JSONEncode(value));
	return ok ? text : tostring(value);
}

class LiveConfigHandle<T> implements LiveConfig<T> {
	constructor(
		readonly key: string,
		private readonly options: LiveConfigOptions<T>,
	) {}

	/** A running event's value for the key (the latest start wins), else the record's `game[key]`. */
	private raw(settings: KernelSettings | undefined): unknown {
		const running = activeAt(settings, os.time());
		for (let i = running.size() - 1; i >= 0; i--) {
			const value = running[i].set[this.key];
			if (value !== undefined) return value;
		}
		const values = settings?.game;
		return typeIs(values, "table") ? (values as Record<string, unknown>)[this.key] : undefined;
	}

	private resolve(raw: unknown): T {
		if (raw === undefined) return this.options.default;
		const parse = this.options.parse;
		if (parse === undefined) return raw as T;
		const [ok, value] = pcall(parse, raw);
		if (ok) return value;
		warnOnce(`${this.key}\0${encoded(raw)}`, `TypeTorch.liveConfig("${this.key}"): parse refused the value (${tostring(value)}); using the default`);
		return this.options.default;
	}

	get(): T {
		const current = binding;
		if (current?.realm === "client") error(`TypeTorch.liveConfig("${this.key}") is server-only`, 2);
		// `typetorch test --cloud` runs a stub kernel with no signed settings at all: the default is expected there.
		if (current?.kernel !== undefined && current.kernel.test !== true && !settingsSupported()) {
			warnOnce(
				`old:${this.key}`,
				`TypeTorch.liveConfig("${this.key}") needs kernel ${SETTINGS_KERNEL} (signed settings; this server runs ${current.kernelVersion}): using the default`,
			);
		}
		return this.resolve(this.raw(current?.current));
	}

	onChanged(callback: (value: T, previous: T) => void): () => void {
		let lastRaw = encoded(this.raw(binding?.current));
		let last = this.get();
		const check = (settings: KernelSettings | undefined) => {
			const raw = this.raw(settings);
			const text = encoded(raw);
			if (text === lastRaw) return;
			lastRaw = text;
			const value = this.resolve(raw);
			const previous = last;
			last = value;
			callback(value, previous);
		};
		const stopSettings = onSettings(check);
		const stopTick = onTick(() => check(binding?.current));
		return () => {
			stopSettings();
			stopTick();
		};
	}
}

/** `TypeTorch.liveConfig`. */
export function liveConfig<T>(key: string, options: LiveConfigOptions<T>): LiveConfig<T> {
	if (!typeIs(key, "string") || key.size() === 0 || key.size() > 64) error("TypeTorch.liveConfig: the key must be 1-64 characters", 2);
	if (!typeIs(options, "table")) error("TypeTorch.liveConfig: pass { default, parse? }", 2);
	return new LiveConfigHandle(key, options);
}

function idsOf(events: LiveEvent[]): string {
	return events.map((e) => `${e.id}@${e.startsAt}-${e.endsAt}`).join(",");
}

const liveEventsHandle: LiveEvents = {
	active() {
		if (binding?.realm === "client") error("TypeTorch.liveEvents() is server-only", 2);
		return activeAt(binding?.current, os.time());
	},
	upcoming() {
		if (binding?.realm === "client") error("TypeTorch.liveEvents() is server-only", 2);
		const now = os.time();
		return scheduleOf(binding?.current).filter((e) => e.startsAt > now);
	},
	onChanged(callback) {
		let last = idsOf(activeAt(binding?.current, os.time()));
		const check = () => {
			const running = activeAt(binding?.current, os.time());
			const text = idsOf(running);
			if (text === last) return;
			last = text;
			callback(running);
		};
		const stopSettings = onSettings(check);
		const stopTick = onTick(check);
		return () => {
			stopSettings();
			stopTick();
		};
	},
};

/** `TypeTorch.liveEvents()`: the signed schedule's events (server only). */
export function liveEvents(): LiveEvents {
	return liveEventsHandle;
}
