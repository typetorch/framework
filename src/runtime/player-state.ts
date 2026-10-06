import { Players } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";

/**
 * `ctx.playerState(key, init)` / `TypeTorch.playerState(key, init)`: per-player state that survives swaps and is
 * removed when the player really leaves (never on a swap: players don't leave then).
 *
 * Every store lives in one persist table, `__playerState` (store key -> UserId -> value), so the dev menu's
 * Modules > State shows it under persist, per store and per player, and a leave cleans every store, including the ones
 * this generation's code no longer opens (once it opened any). Players who left between two generations are dropped
 * when the next generation opens its first store.
 */
export interface PlayerState<T> {
	/** The player's value; the first call for a player (in this server) stores `init(player)`. */
	get(player: Player): T;
	set(player: Player, value: T): void;
	/** Whether the player has a value (without creating one). */
	has(player: Player): boolean;
	delete(player: Player): void;
}

/** The persist key that holds every store. `__` keys are the framework's. */
export const PLAYER_STATE_KEY = "__playerState";

type Stores = Map<string, Map<number, unknown>>;
type Persist = <T extends object>(key: string, init: () => T) => T;

let persist: Persist | undefined;
let generationTrove: Trove | undefined;
/** Edit mode (no generation): the stores live for the session only. */
const localStores: Stores = new Map();
/** This generation's handles, by store key (the same key twice is the same handle). */
const handles = new Map<string, PlayerStateHandle<unknown>>();
let pruned = false;

function stores(): Stores {
	if (!persist) return localStores;
	const all = persist<Stores>(PLAYER_STATE_KEY, () => new Map());
	if (!pruned) {
		// Once per generation: drop players who left while no generation listened (between a stop and the next start).
		pruned = true;
		const present = new Set<number>();
		for (const player of Players.GetPlayers()) present.add(player.UserId);
		for (const [, store] of all) {
			for (const [userId] of store) if (!present.has(userId)) store.delete(userId);
		}
	}
	return all;
}

/** A player who left (or is leaving and was already cleaned up) gets no new entry. */
function gone(player: Player): boolean {
	return player.Parent === undefined;
}

class PlayerStateHandle<T> implements PlayerState<T> {
	constructor(
		private readonly key: string,
		private readonly init: (player: Player) => T,
	) {}

	private store(): Map<number, T> {
		const all = stores();
		let store = all.get(this.key) as Map<number, T> | undefined;
		if (!store) {
			store = new Map();
			all.set(this.key, store as Map<number, unknown>);
		}
		return store;
	}

	get(player: Player): T {
		const store = this.store();
		if (store.has(player.UserId)) return store.get(player.UserId) as T;
		const value = this.init(player);
		if (!gone(player)) store.set(player.UserId, value);
		return value;
	}

	set(player: Player, value: T) {
		if (!gone(player)) this.store().set(player.UserId, value);
	}

	has(player: Player): boolean {
		return this.store().has(player.UserId);
	}

	delete(player: Player) {
		this.store().delete(player.UserId);
	}
}

/** See `PlayerState`. Store plain data only (the `persist` rules); version the key when the shape changes. */
export function playerState<T>(key: string, init: (player: Player) => T): PlayerState<T> {
	assert(typeIs(key, "string"), "playerState: the key must be a string");
	assert(typeIs(init, "function"), "playerState: init must be a function");
	let handle = handles.get(key);
	if (!handle) {
		handle = new PlayerStateHandle(key, init as (player: Player) => unknown);
		handles.set(key, handle);
		// Opening the generation's first store drops the players who left between generations.
		if (persist) stores();
	}
	return handle as unknown as PlayerState<T>;
}

/**
 * runtime/start.ts, before any module loads: the stores persist through `persistFn` (TypeTorch.persist), and a real
 * leave (PlayerRemoving, connected in the generation's root trove) removes the player from every store, deferred so
 * the game's own PlayerRemoving handlers can still read it.
 */
export function bindPlayerStates(trove: Trove, persistFn: Persist) {
	persist = persistFn;
	generationTrove = trove;
	pruned = false;
	handles.clear();
	trove.connect(Players.PlayerRemoving, (player) => {
		const userId = player.UserId;
		task.defer(() => {
			// Only once this generation opened a store (so games that never use it get no persist entry).
			if (generationTrove !== trove || !persist || handles.size() === 0) return;
			for (const [, store] of stores()) store.delete(userId);
		});
	});
	trove.add(() => {
		if (generationTrove !== trove) return;
		persist = undefined;
		generationTrove = undefined;
		handles.clear();
	});
}
