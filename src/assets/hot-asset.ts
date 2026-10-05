import { CollectionService, RunService } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { isLiveCopy, liveCopies, numberAttribute } from "./dom";
import { assetTag, ATTR_ID, ATTR_VERSION, isAssetKey, keyOfTag } from "./manifest";
import { keyForAssetId, manifestEntry } from "./sync";

/**
 * `hotAsset(key | assetId, fallback?)` (plans/13 "Hot assets"): a handle on the live copy of a hot asset, on the server
 * and the client. It reads the CollectionService tag AssetSync puts on the live copy (`__typetorch_asset:<key>`), so a
 * client never asks the server for anything: replicated assets arrive through replication.
 *
 * ```ts
 * const shop = hotAsset("ui/shop");
 * shop.changed(rebuild, this.trove); // a new version went live
 * rebuild(shop.get());
 * ```
 */
export interface HotAsset {
	/**
	 * The key ("ui/shop"). A handle made from an asset id resolves it through the manifest (server) or the live copy's
	 * TypeTorchAssetId (client); undefined until then.
	 */
	readonly key: string | undefined;
	/** The TypeTorchAssetVersion (assetVersionId) of what `get()` returns now, or undefined. */
	readonly version: number | undefined;
	/**
	 * The live copy now. Without one: the `fallback`, if it is still parented; else undefined. Clone it, don't parent
	 * or edit it: it is replaced (destroyed) when a new version goes live.
	 */
	get(): Instance | undefined;
	/** `get()`, waiting for a live copy when there is none (up to `timeout` seconds; forever without one). */
	wait(timeout?: number): Instance | undefined;
	/**
	 * Calls `callback` with the new live copy each time one replaces the previous (a new version, a rollback, the first
	 * copy arriving on a client). Returns a disconnect function. The connection is dropped when `trove` is cleaned
	 * (pass the module's: `shop.changed(rebuild, this.trove)`), or else when this generation stops.
	 */
	changed(callback: (instance: Instance) => void, trove?: Trove): () => void;
}

type Listener = (instance: Instance) => void;

interface Watcher {
	key: string;
	/** Live copies in the order they arrived (the newest one wins). */
	copies: Instance[];
	listeners: Set<Listener>;
	last?: Instance;
	connections: RBXScriptConnection[];
}

const isServer = RunService.IsServer();
/** `changed()` connections without a trove of their own go here (the generation's root trove). */
let generationTrove: Trove | undefined;
const watchers = new Map<string, Watcher>();
/** Asset id -> key, once resolved (ids never change for a key). */
const keyCache = new Map<number, string>();
/** Asset ids not resolved yet that someone listens for (client: the copy hasn't replicated yet). */
const pendingIds = new Map<number, Set<() => boolean>>();
let tagAdded: RBXScriptConnection | undefined;

/** The copy `get()` returns: the newest live one (on the server, preferring the manifest's version). */
function pick(key: string, copies: readonly Instance[]): Instance | undefined {
	const live = copies.filter(isLiveCopy);
	if (live.size() === 0) return undefined;
	const wanted = isServer ? manifestEntry(key)?.ver : undefined;
	if (wanted !== undefined) {
		for (let index = live.size() - 1; index >= 0; index--) {
			if (numberAttribute(live[index], ATTR_VERSION) === wanted) return live[index];
		}
	}
	return live[live.size() - 1];
}

/** One tag connection pair per key while anyone listens; shared by every handle of the key. */
function watch(key: string): Watcher {
	const existing = watchers.get(key);
	if (existing) return existing;
	const tag = assetTag(key);
	const watcher: Watcher = { key, copies: liveCopies(key), listeners: new Set(), connections: [] };
	watcher.last = pick(key, watcher.copies);
	const update = () => {
		const now = pick(key, watcher.copies);
		if (now === watcher.last) return;
		watcher.last = now;
		if (now === undefined) return;
		for (const listener of [...watcher.listeners]) task.spawn(listener, now);
	};
	watcher.connections.push(
		CollectionService.GetInstanceAddedSignal(tag).Connect((instance) => {
			if (!isLiveCopy(instance)) return; // a clone of the template somewhere else
			const index = watcher.copies.indexOf(instance);
			if (index >= 0) watcher.copies.remove(index);
			watcher.copies.push(instance);
			update();
		}),
	);
	watcher.connections.push(
		CollectionService.GetInstanceRemovedSignal(tag).Connect((instance) => {
			const index = watcher.copies.indexOf(instance);
			if (index < 0) return;
			watcher.copies.remove(index);
			update();
		}),
	);
	watchers.set(key, watcher);
	return watcher;
}

function release(watcher: Watcher) {
	if (watcher.listeners.size() > 0) return;
	for (const connection of watcher.connections) connection.Disconnect();
	if (watchers.get(watcher.key) === watcher) watchers.delete(watcher.key);
}

/** A key as is; an asset id through the manifest (server) or a live copy's TypeTorchAssetId. */
function resolveKey(ref: string | number): string | undefined {
	if (typeIs(ref, "string")) return ref;
	const known = keyCache.get(ref) ?? (isServer ? keyForAssetId(ref) : undefined);
	if (known !== undefined) return known;
	for (const tag of CollectionService.GetAllTags()) {
		const key = keyOfTag(tag);
		if (key === undefined) continue;
		for (const instance of CollectionService.GetTagged(tag)) {
			if (numberAttribute(instance, ATTR_ID) === ref && isLiveCopy(instance)) {
				keyCache.set(ref, key);
				return key;
			}
		}
	}
	return undefined;
}

function stopTagAdded() {
	tagAdded?.Disconnect();
	tagAdded = undefined;
}

/** Retries `retry` (true = resolved, done) whenever a new hot-asset tag appears, until it resolves or is removed. */
function awaitId(id: number, retry: () => boolean): () => void {
	let retries = pendingIds.get(id);
	if (retries === undefined) {
		retries = new Set();
		pendingIds.set(id, retries);
	}
	retries.add(retry);
	if (tagAdded === undefined) {
		tagAdded = CollectionService.TagAdded.Connect((tag) => {
			if (keyOfTag(tag) === undefined) return;
			// Deferred: the new copy is fully in place (parent and attributes) by then.
			task.defer(() => {
				const ids = new Array<number>();
				for (const [pendingId] of pendingIds) ids.push(pendingId);
				for (const pendingId of ids) {
					const waiting = pendingIds.get(pendingId);
					if (waiting === undefined) continue;
					for (const callback of [...waiting]) {
						if (callback()) waiting.delete(callback);
					}
					if (waiting.size() === 0) pendingIds.delete(pendingId);
				}
				if (pendingIds.size() === 0) stopTagAdded();
			});
		});
	}
	return () => {
		const waiting = pendingIds.get(id);
		waiting?.delete(retry);
		if (waiting !== undefined && waiting.size() === 0) pendingIds.delete(id);
		if (pendingIds.size() === 0) stopTagAdded();
	};
}

/**
 * A handle on the hot asset `keyOrId` (a key like "ui/shop", or its Roblox asset id). `fallback` is an instance the
 * caller already holds (e.g. the template in the place) that `get()` returns while nothing is live for the key.
 * Works on the server and the client; also `TypeTorch.asset(...)`.
 */
export function hotAsset(keyOrId: string | number, fallback?: Instance): HotAsset {
	if (typeIs(keyOrId, "string")) {
		if (!isAssetKey(keyOrId)) error(`hotAsset: "${keyOrId}" is not an asset key (a-z 0-9 / - _, at most 64)`, 2);
	} else if (!typeIs(keyOrId, "number") || keyOrId < 1 || keyOrId % 1 !== 0) {
		error("hotAsset: expected an asset key or an asset id", 2);
	}
	let resolved = typeIs(keyOrId, "string") ? keyOrId : undefined;
	const key = () => {
		if (resolved === undefined) resolved = resolveKey(keyOrId);
		return resolved;
	};
	const current = (): Instance | undefined => {
		const known = key();
		if (known !== undefined) {
			const watcher = watchers.get(known);
			const live = pick(known, watcher !== undefined ? watcher.copies : liveCopies(known));
			if (live !== undefined) return live;
		}
		return fallback !== undefined && fallback.Parent !== undefined ? fallback : undefined;
	};
	/** `callback` for each new live copy, without a trove; returns the disconnect. */
	const listen = (callback: Listener): (() => void) => {
		let closed = false;
		let detach: (() => void) | undefined;
		const attach = (known: string) => {
			const watcher = watch(known);
			watcher.listeners.add(callback);
			detach = () => {
				watcher.listeners.delete(callback);
				release(watcher);
			};
		};
		const known = key();
		if (known !== undefined) attach(known);
		else {
			detach = awaitId(keyOrId as number, () => {
				const found = key();
				if (found === undefined) return false;
				if (!closed) {
					attach(found);
					const live = current();
					if (live !== undefined) task.spawn(callback, live);
				}
				return true;
			});
		}
		return () => {
			if (closed) return;
			closed = true;
			detach?.();
		};
	};

	const handle = {
		get(): Instance | undefined {
			return current();
		},
		wait(timeout?: number): Instance | undefined {
			const now = current();
			if (now !== undefined) return now;
			const thread = coroutine.running();
			let finished = false;
			let timer: thread | undefined;
			let stop: (() => void) | undefined;
			const finish = (instance: Instance | undefined) => {
				if (finished) return;
				finished = true;
				stop?.();
				if (timer !== undefined && coroutine.status(timer) === "suspended") task.cancel(timer);
				task.spawn(thread, instance);
			};
			stop = listen((instance) => finish(instance));
			timer =
				timeout !== undefined
					? task.delay(timeout, () => finish(current()))
					: task.delay(5, () => $warn(`hotAsset(${tostring(keyOrId)}).wait() is still waiting for a live copy`));
			const [instance] = coroutine.yield() as LuaTuple<[Instance | undefined]>;
			return instance;
		},
		changed(callback: Listener, trove?: Trove): () => void {
			const disconnect = listen(callback);
			(trove ?? generationTrove)?.add(disconnect);
			return disconnect;
		},
	};
	// `key` (until resolved) and `version` are read on access.
	setmetatable(handle, {
		__index: (_, field) => {
			if (field === "key") return key();
			if (field === "version") return numberAttribute(current(), ATTR_VERSION);
			return undefined;
		},
	});
	return handle as unknown as HotAsset;
}

/** runtime/start.ts: binds handles to this generation (changed() without a trove ends with it). */
export function bindHotAssets(trove: Trove) {
	generationTrove = trove;
	trove.add(() => {
		generationTrove = undefined;
		for (const [, watcher] of watchers) {
			for (const connection of watcher.connections) connection.Disconnect();
		}
		watchers.clear();
		pendingIds.clear();
		stopTagAdded();
		keyCache.clear();
	});
}
