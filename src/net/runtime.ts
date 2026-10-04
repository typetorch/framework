import { $warn } from "rbxts-transform-debug";
import type { ClientKernel, ServerKernel } from "../kernel";
import { DEFAULT_LIMITS, RateLimiter, withinShape } from "./limits";
import type { LeafLimits } from "./types";

/**
 * Wire format over the kernel's stable remotes (one RemoteEvent for the whole game):
 *   event    client <-> server   channel "e:<path>", args...
 *   request  client  -> server   channel "r:<path>", requestId, args...
 *   response server  -> client   channel "__tt/res", requestId, ok, result
 * Raw channels (devtools) are registered by exact name.
 */
export const RESPONSE = "__tt/res";
const REQUEST_TIMEOUT = 15;
const KICK_AFTER = 300;
const KICK_WINDOW = 10;

type Guard = (value: unknown) => boolean;
type Listener = (...args: unknown[]) => void;

/** Guards for every client -> server leaf, filled by createNetwork() as networks are declared. */
export const registeredGuards = new Map<string, Guard>();
/** Per-leaf limit overrides (network.limits()). */
export const registeredLimits = new Map<string, LeafLimits>();

export interface LeafStats {
	inbound: number;
	outbound: number;
	rejected: number;
	errors: number;
}

function newStats(): LeafStats {
	return { inbound: 0, outbound: 0, rejected: 0, errors: 0 };
}

export class ServerDispatcher {
	readonly stats = new Map<string, LeafStats>();
	private readonly listeners = new Map<string, Set<(player: Player, ...args: unknown[]) => void>>();
	private readonly handlers = new Map<string, (player: Player, ...args: unknown[]) => unknown>();
	private readonly raw = new Map<string, (player: Player, ...args: unknown[]) => void>();
	private readonly limiter = new RateLimiter();
	private readonly strikes = new Map<Player, [count: number, since: number]>();

	constructor(readonly kernel: ServerKernel) {}

	stat(path: string): LeafStats {
		let stats = this.stats.get(path);
		if (!stats) {
			stats = newStats();
			this.stats.set(path, stats);
		}
		return stats;
	}

	addListener(path: string, listener: (player: Player, ...args: unknown[]) => void): () => void {
		let set = this.listeners.get(path);
		if (!set) {
			set = new Set();
			this.listeners.set(path, set);
		}
		set.add(listener);
		return () => set!.delete(listener);
	}

	setHandler(path: string, handler: (player: Player, ...args: unknown[]) => unknown): () => void {
		if (this.handlers.has(path)) $warn(`[net] ${path} already had a request handler; replacing it`);
		this.handlers.set(path, handler);
		return () => {
			if (this.handlers.get(path) === handler) this.handlers.delete(path);
		};
	}

	/** A raw channel (no guards or limits; the handler checks everything). Used by the dev menu. */
	setRaw(channel: string, handler: (player: Player, ...args: unknown[]) => void) {
		this.raw.set(channel, handler);
	}

	removeRaw(channel: string) {
		this.raw.delete(channel);
	}

	send(player: Player, path: string, args: unknown[], unreliable = false) {
		this.stat(path).outbound += 1;
		if (unreliable) this.kernel.sendUnreliable(player, `e:${path}`, ...args);
		else this.kernel.send(player, `e:${path}`, ...args);
	}

	sendAll(path: string, args: unknown[], unreliable = false) {
		this.stat(path).outbound += 1;
		if (unreliable) this.kernel.broadcastUnreliable(`e:${path}`, ...args);
		else this.kernel.broadcast(`e:${path}`, ...args);
	}

	forget(player: Player) {
		this.limiter.forget(player);
		this.strikes.delete(player);
	}

	private strike(player: Player) {
		const now = os.clock();
		const [count, since] = this.strikes.get(player) ?? [0, now];
		const updated: [number, number] = now - since > KICK_WINDOW ? [1, now] : [count + 1, since];
		this.strikes.set(player, updated);
		if (updated[0] >= KICK_AFTER) player.Kick("Too many requests.");
	}

	private reply(player: Player, requestId: unknown, ok: boolean, result: unknown) {
		if (requestId !== undefined) this.kernel.send(player, RESPONSE, requestId, ok, result);
	}

	readonly dispatch = (player: Player, channel: string, ...args: unknown[]) => {
		const raw = this.raw.get(channel);
		if (raw) {
			if (this.limiter.allow(player, channel, DEFAULT_LIMITS.rate)) raw(player, ...args);
			else this.strike(player);
			return;
		}
		const kind = channel.sub(1, 2);
		const path = channel.sub(3);
		if (kind !== "e:" && kind !== "r:") return;
		const stats = this.stat(path);

		let requestId: unknown;
		let callArgs = args;
		if (kind === "r:") {
			requestId = args[0];
			callArgs = [];
			for (let index = 1; index < args.size(); index++) callArgs[index - 1] = args[index];
			if (!typeIs(requestId, "number")) {
				stats.rejected += 1;
				this.strike(player);
				return;
			}
		}

		const limits = { ...DEFAULT_LIMITS, ...(registeredLimits.get(path) ?? {}) };
		if (!this.limiter.allow(player, path, limits.rate)) {
			stats.rejected += 1;
			this.strike(player);
			this.reply(player, requestId, false, "Slow down!");
			return;
		}
		const guard = registeredGuards.get(path);
		if (!guard || !withinShape(callArgs, limits) || !guard(callArgs)) {
			stats.rejected += 1;
			this.strike(player);
			this.reply(player, requestId, false, "Bad request.");
			return;
		}
		stats.inbound += 1;

		if (kind === "e:") {
			const set = this.listeners.get(path);
			if (!set) return;
			for (const listener of set) {
				const [ok, err] = pcall(listener, player, ...callArgs);
				if (!ok) {
					stats.errors += 1;
					$warn(`[net] ${path} listener threw: ${err}`);
				}
			}
			return;
		}
		const handler = this.handlers.get(path);
		if (!handler) {
			this.reply(player, requestId, false, "Not available.");
			return;
		}
		const [ok, result] = pcall(handler, player, ...callArgs);
		if (!ok) {
			stats.errors += 1;
			$warn(`[net] ${path} handler threw: ${result}`);
			this.reply(player, requestId, false, "Something went wrong, try again.");
			return;
		}
		this.reply(player, requestId, true, result);
	};
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	timeout: thread;
}

export class ClientDispatcher {
	readonly stats = new Map<string, LeafStats>();
	private readonly listeners = new Map<string, Set<Listener>>();
	private readonly raw = new Map<string, Listener>();
	private readonly pending = new Map<number, Pending>();
	private nextId = 1;
	private stopped = false;

	constructor(readonly kernel: ClientKernel) {}

	stat(path: string): LeafStats {
		let stats = this.stats.get(path);
		if (!stats) {
			stats = newStats();
			this.stats.set(path, stats);
		}
		return stats;
	}

	addListener(path: string, listener: Listener): () => void {
		let set = this.listeners.get(path);
		if (!set) {
			set = new Set();
			this.listeners.set(path, set);
		}
		set.add(listener);
		return () => set!.delete(listener);
	}

	setRaw(channel: string, listener: Listener) {
		this.raw.set(channel, listener);
	}

	removeRaw(channel: string) {
		this.raw.delete(channel);
	}

	fire(path: string, args: unknown[], unreliable = false) {
		this.stat(path).outbound += 1;
		if (unreliable) this.kernel.sendUnreliable(`e:${path}`, ...args);
		else this.kernel.send(`e:${path}`, ...args);
	}

	invoke(path: string, args: unknown[]): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.stopped) {
				reject("This version of the game is shutting down.");
				return;
			}
			const id = this.nextId++;
			const timeout = task.delay(REQUEST_TIMEOUT, () => {
				if (this.pending.delete(id)) reject("The server didn't answer in time.");
			});
			this.pending.set(id, { resolve, reject, timeout });
			this.stat(path).outbound += 1;
			this.kernel.send(`r:${path}`, id, ...args);
		});
	}

	readonly dispatch = (channel: string, ...args: unknown[]) => {
		if (channel === RESPONSE) {
			const [id, ok, result] = args as [number, boolean, unknown];
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			task.cancel(pending.timeout);
			if (ok) pending.resolve(result);
			else pending.reject(result);
			return;
		}
		const raw = this.raw.get(channel);
		if (raw) {
			raw(...args);
			return;
		}
		if (channel.sub(1, 2) !== "e:") return;
		const path = channel.sub(3);
		this.stat(path).inbound += 1;
		const set = this.listeners.get(path);
		if (!set) return;
		for (const listener of set) {
			const [ok, err] = pcall(listener, ...args);
			if (!ok) {
				this.stat(path).errors += 1;
				$warn(`[net] ${path} listener threw: ${err}`);
			}
		}
	};

	stop() {
		this.stopped = true;
		for (const [, pending] of this.pending) {
			task.cancel(pending.timeout);
			pending.reject("This version of the game is shutting down.");
		}
		this.pending.clear();
	}
}

// The running generation's dispatchers. The framework is per generation, so these never outlive their generation.
let activeServer: ServerDispatcher | undefined;
let activeClient: ClientDispatcher | undefined;

export function setServerDispatcher(dispatcher: ServerDispatcher | undefined) {
	activeServer = dispatcher;
}
export function setClientDispatcher(dispatcher: ClientDispatcher | undefined) {
	activeClient = dispatcher;
}
export function serverDispatcher(): ServerDispatcher {
	assert(activeServer, "TypeTorch networking is only available on a running server (not in edit mode).");
	return activeServer;
}
export function clientDispatcher(): ClientDispatcher {
	assert(activeClient, "TypeTorch networking is only available on a running client (not in edit mode).");
	return activeClient;
}
export function maybeServerDispatcher() {
	return activeServer;
}
export function maybeClientDispatcher() {
	return activeClient;
}
