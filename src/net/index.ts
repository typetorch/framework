import type { Modding } from "../reflection/modding";
import { Players } from "@rbxts/services";
import { $warn } from "rbxts-transform-debug";
import { clientDispatcher, registeredGuards, registeredLimits, serverDispatcher } from "./runtime";
import type { ClientNetwork, GuardTree, LeafLimits, Network, ServerNetwork } from "./types";

export * from "./types";

type Guard = (value: unknown) => boolean;
type Disconnect = () => void;

function flatten(tree: unknown, prefix: string, into: Map<string, Guard>) {
	for (const [key, value] of pairs(tree as Record<string, unknown>)) {
		const path = prefix === "" ? (key as string) : `${prefix}.${key}`;
		if (typeIs(value, "function")) into.set(path, value as Guard);
		else if (typeIs(value, "table")) flatten(value, path, into);
	}
}

/**
 * Server end of one leaf. The typed views (ServerReceiver / ServerSender) declare these as methods, which roblox-ts
 * calls with `:`, so leaves are class instances (never plain tables of arrow functions).
 */
class ServerLeaf {
	constructor(private readonly path: string) {}
	on(handler: (player: Player, ...args: unknown[]) => void): Disconnect {
		return serverDispatcher().addListener(this.path, handler);
	}
	handle(handler: (player: Player, ...args: unknown[]) => unknown): Disconnect {
		return serverDispatcher().setHandler(this.path, handler);
	}
	emit(player: Player, ...args: unknown[]) {
		serverDispatcher().emit(player, this.path, args);
	}
	fire(player: Player, ...args: unknown[]) {
		serverDispatcher().send(player, this.path, args);
	}
	fireAll(...args: unknown[]) {
		serverDispatcher().sendAll(this.path, args);
	}
	fireExcept(except: Player, ...args: unknown[]) {
		const dispatcher = serverDispatcher();
		for (const player of Players.GetPlayers()) {
			if (player !== except) dispatcher.send(player, this.path, args);
		}
	}
	fireList(players: Player[], ...args: unknown[]) {
		const dispatcher = serverDispatcher();
		for (const player of players) dispatcher.send(player, this.path, args);
	}
	fireUnreliable(player: Player, ...args: unknown[]) {
		serverDispatcher().send(player, this.path, args, true);
	}
	fireAllUnreliable(...args: unknown[]) {
		serverDispatcher().sendAll(this.path, args, true);
	}
}

/** Client end of one leaf. */
class ClientLeaf {
	constructor(private readonly path: string) {}
	fire(...args: unknown[]) {
		clientDispatcher().fire(this.path, args);
	}
	fireUnreliable(...args: unknown[]) {
		clientDispatcher().fire(this.path, args, true);
	}
	invoke(...args: unknown[]): Promise<unknown> {
		return clientDispatcher().invoke(this.path, args);
	}
	invokeWithTimeout(seconds: number, ...args: unknown[]): Promise<unknown> {
		return clientDispatcher().invoke(this.path, args, seconds);
	}
	on(handler: (...args: unknown[]) => void): Disconnect {
		return clientDispatcher().addListener(this.path, handler);
	}
	emit(...args: unknown[]) {
		clientDispatcher().emit(this.path, args);
	}
}

/** Puts one leaf at its dotted path in `root` (namespaces become plain tables). Same path twice = same leaf. */
function place<T extends object>(root: Record<string, unknown>, path: string, create: () => T): T {
	const parts = path.split(".");
	let node = root;
	for (let index = 0; index < parts.size() - 1; index++) {
		const part = parts[index];
		let child = node[part] as Record<string, unknown> | undefined;
		if (child === undefined) {
			child = {};
			node[part] = child;
		}
		node = child;
	}
	const name = parts[parts.size() - 1];
	const existing = node[name];
	if (existing !== undefined) return existing as T;
	const leaf = create();
	node[name] = leaf;
	return leaf;
}

/**
 * Declares the game's network from two interfaces of (optionally nested) methods:
 *
 * ```ts
 * interface ClientToServer { coins: { collect(coinId: string): void; balance(): ProperReturns<number> } }
 * interface ServerToClient { coins: { changed(total: number): void } }
 * export const network = createNetwork<ClientToServer, ServerToClient>();
 * // server: network.server.coins.collect.on((player, coinId) => ...)
 * //         network.server.coins.balance.handle((player) => [42])
 * //         network.server.coins.changed.fire(player, 42)
 * // client: network.client.coins.collect.fire("coin-3")
 * //         network.client.coins.balance.invoke().then(...)
 * //         network.client.coins.balance.invokeWithTimeout(5).then(...)
 * //         network.client.coins.changed.on((total) => ...)
 * //         network.client.coins.changed.emit(42) // runs the local `on` handlers, no traffic (Flamework's predict)
 * ```
 *
 * `@typetorch/transformer` fills in a runtime type guard for every leaf (both directions, nested namespaces
 * included); the server checks client -> server guards on every message, after rate and shape limits. Messages travel
 * over the kernel's stable remotes, so a generation swap never breaks the network.
 *
 * `network` (in the tag below): the transformer names the leaf in guard errors and warns about generic leaves and
 * parameters that never arrive (functions, threads, AnimationTracks); older transformers ignore it.
 *
 * @metadata macro network
 */
export function createNetwork<ClientToServer extends object, ServerToClient extends object>(
	clientToServer?: Modding.Many<GuardTree<ClientToServer>>,
	serverToClient?: Modding.Many<GuardTree<ServerToClient>>,
): Network<ClientToServer, ServerToClient> {
	assert(clientToServer && serverToClient, "createNetwork: guards were not generated (is @typetorch/transformer in the tsconfig plugins?)");
	const c2s = new Map<string, Guard>();
	const s2c = new Map<string, Guard>();
	flatten(clientToServer, "", c2s);
	flatten(serverToClient, "", s2c);

	const server: Record<string, unknown> = {};
	const client: Record<string, unknown> = {};
	for (const [path, guard] of c2s) {
		if (registeredGuards.has(path)) $warn(`[net] ${path} is declared by more than one network`);
		registeredGuards.set(path, guard);
		place(server, path, () => new ServerLeaf(path));
		place(client, path, () => new ClientLeaf(path));
	}
	for (const [path] of s2c) {
		place(server, path, () => new ServerLeaf(path));
		place(client, path, () => new ClientLeaf(path));
	}

	return {
		server: server as unknown as ServerNetwork<ClientToServer, ServerToClient>,
		client: client as unknown as ClientNetwork<ClientToServer, ServerToClient>,
	};
}

/**
 * Overrides limits for client -> server leaves by dotted path, e.g. `{ "chat.say": { maxString: 200 } }`. The server
 * reads rate and shape limits; the client reads a request's `timeout` (`{ "vc.spawn": { timeout: 30 } }`), so call it
 * where both realms load it (next to createNetwork) when you set one.
 */
export function setNetworkLimits(limits: Record<string, LeafLimits>) {
	for (const [path, value] of pairs(limits)) registeredLimits.set(path as string, value);
}
