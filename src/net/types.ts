import type { Modding } from "../reflection/modding";

/** `[value]` or `[false, reason]`, the shape every fallible call uses (reason is player-facing text). */
export type ProperReturns<T = true> = [T] | [false, string];

/** One generated guard per leaf, same shape as the declared interface. Filled in by the createNetwork macro. */
export type GuardTree<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => unknown ? Modding.Generic<A, "guard"> : GuardTree<T[K]>;
};

type Disconnect = () => void;

/** Server view of a client → server leaf. Register `on` for events or `handle` for requests (one handler each). */
export interface ServerReceiver<A extends unknown[], R> {
	on(handler: (player: Player, ...args: A) => void): Disconnect;
	handle(handler: (player: Player, ...args: A) => R): Disconnect;
	/**
	 * Runs this generation's `on` handlers now, as if `player` had sent it: no network, no limits, no guard. For tests
	 * and server-side reuse of a handler.
	 */
	emit(player: Player, ...args: A): void;
}
/** Server view of a server → client leaf. */
export interface ServerSender<A extends unknown[]> {
	fire(player: Player, ...args: A): void;
	fireAll(...args: A): void;
	fireExcept(except: Player, ...args: A): void;
	fireList(players: Player[], ...args: A): void;
	fireUnreliable(player: Player, ...args: A): void;
	fireAllUnreliable(...args: A): void;
}
/** Client view of a client → server leaf. `fire` for events, `invoke` for requests (resolves with the result). */
export interface ClientSender<A extends unknown[], R> {
	fire(...args: A): void;
	fireUnreliable(...args: A): void;
	/** Rejects when the server doesn't answer in time: the leaf's `timeout` (setNetworkLimits), else 15 s. */
	invoke(...args: A): Promise<R>;
	/** `invoke` that gives up after `seconds` (0.5 to 120; outside that it is clamped, with one warning). */
	invokeWithTimeout(seconds: number, ...args: A): Promise<R>;
}
/** Client view of a server → client leaf. */
export interface ClientReceiver<A extends unknown[]> {
	on(handler: (...args: A) => void): Disconnect;
	/**
	 * Runs this generation's `on` handlers now, as if the server had sent it (Flamework's `predict`): no network
	 * traffic, no guard. Handlers run in order on the calling thread; one that throws is warned and the rest still run.
	 */
	emit(...args: A): void;
}

type C2SOnServer<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? ServerReceiver<A, R> : C2SOnServer<T[K]>;
};
type S2COnServer<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => unknown ? ServerSender<A> : S2COnServer<T[K]>;
};
type C2SOnClient<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => infer R ? ClientSender<A, R> : C2SOnClient<T[K]>;
};
type S2COnClient<T> = {
	[K in keyof T]: T[K] extends (...args: infer A) => unknown ? ClientReceiver<A> : S2COnClient<T[K]>;
};

export type ServerNetwork<C2S, S2C> = C2SOnServer<C2S> & S2COnServer<S2C>;
export type ClientNetwork<C2S, S2C> = C2SOnClient<C2S> & S2COnClient<S2C>;

export interface Network<C2S, S2C> {
	/** Server side: receivers for client → server leaves, senders for server → client leaves. */
	readonly server: ServerNetwork<C2S, S2C>;
	/** Client side: senders for client → server leaves, receivers for server → client leaves. */
	readonly client: ClientNetwork<C2S, S2C>;
}

/** Per-leaf limits, keyed by dotted path ("coins.collect"). Defaults: see net/limits.ts. */
export interface LeafLimits {
	/** Token bucket: burst size and refill per second, per player. */
	rate?: [burst: number, perSecond: number];
	maxString?: number;
	maxEntries?: number;
	maxDepth?: number;
	/**
	 * Requests: seconds the client's `invoke` waits for the answer (default 15, 0.5 to 120). The client reads it, so
	 * set it in code both realms load (e.g. next to createNetwork). `invokeWithTimeout` overrides it per call.
	 */
	timeout?: number;
}
