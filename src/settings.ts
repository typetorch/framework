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

function hasMethod(kernel: object, name: string): boolean {
	return typeIs((kernel as Record<string, unknown>)[name], "function");
}

/** Called by bindTypeTorch: this generation's copy and the kernel's change hook (server, kernel 0.3.8+). */
export function bindSettings(realm: "server" | "client", kernel: unknown, trove: Trove, kernelVersion: string) {
	listeners.clear();
	const current: Binding = { realm, kernelVersion, kernel: realm === "server" ? (kernel as ServerKernel) : undefined };
	binding = current;
	const server = current.kernel;
	if (server === undefined || !hasMethod(server, "settings")) return;
	const [ok, copy] = pcall(() => server.settings!());
	if (ok) current.current = copy;
	if (hasMethod(server, "onSettingsChanged")) {
		// Kernel threads -> this generation's threads (the hard stop ends a listener that still runs).
		const relay = new Relay(trove);
		server.onSettingsChanged!((settings) =>
			relay.run(() => {
				if (binding !== current) return;
				current.current = settings;
				for (const listener of [...listeners]) task.spawn(listener, settings);
			}),
		);
	}
}

/** Called by unbindTypeTorch. */
export function unbindSettings() {
	binding = undefined;
	listeners.clear();
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

	private raw(settings: KernelSettings | undefined): unknown {
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
		if (current?.kernel !== undefined && !settingsSupported()) {
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
		return onSettings((settings) => {
			const raw = this.raw(settings);
			const text = encoded(raw);
			if (text === lastRaw) return;
			lastRaw = text;
			const value = this.resolve(raw);
			const previous = last;
			last = value;
			callback(value, previous);
		});
	}
}

/** `TypeTorch.liveConfig`. */
export function liveConfig<T>(key: string, options: LiveConfigOptions<T>): LiveConfig<T> {
	if (!typeIs(key, "string") || key.size() === 0 || key.size() > 64) error("TypeTorch.liveConfig: the key must be 1-64 characters", 2);
	if (!typeIs(options, "table")) error("TypeTorch.liveConfig: pass { default, parse? }", 2);
	return new LiveConfigHandle(key, options);
}
