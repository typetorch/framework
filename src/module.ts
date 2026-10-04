import { Trove } from "@rbxts/trove";
import type { ArtifactInfo, Channel, ClientKernel, ServerKernel } from "./kernel";

/** Lifecycle hooks. Implement the interfaces you need; the runtime calls them in dependency order. */
export interface OnInit {
	/** Sequential, dependencies first. May yield (keep it short: the generation has ~20 s to become ready). */
	onInit(): void;
}
export interface OnStart {
	/** Spawned per module after every onInit finished, so one failing or yielding module can't block the others. */
	onStart(): void;
}
export interface OnStop {
	/** Reverse dependency order, before the module's trove is cleaned. */
	onStop(): void;
}
export interface OnTick {
	/** RunService.Heartbeat. */
	onTick(dt: number): void;
}
export interface OnPhysics {
	/** RunService.PreSimulation. */
	onPhysics(dt: number): void;
}
export interface OnRender {
	/** RunService.RenderStepped (client only). */
	onRender(dt: number): void;
}
export interface OnPlayerAdded {
	/**
	 * Every player in the server, INCLUDING the ones already there when this generation started (a swap doesn't
	 * re-fire PlayerAdded). `playerTrove` is cleaned when the player leaves or the generation stops.
	 */
	onPlayerAdded(player: Player, playerTrove: Trove): void;
}

export interface BuildInfo {
	readonly branch?: string;
	readonly commit?: string;
	readonly dirty?: boolean;
	readonly channel?: Channel;
	readonly builtAt?: number;
}

/** Everything a module gets from the generation it runs in. */
export interface ModuleContext {
	readonly realm: "server" | "client";
	readonly artifact: ArtifactInfo;
	readonly branch?: string;
	readonly channel?: Channel;
	readonly generation: number;
	/** Compiled-in git info of the build (from the game's generated build.ts). */
	readonly build: BuildInfo;
	readonly kernel: ServerKernel | ClientKernel;
	/** A table that survives generation swaps. Plain data only: never instances or functions from a generation. */
	persist<T extends object>(key: string, init: () => T): T;
}

/**
 * Base class for services (@Service) and controllers (@Controller).
 *
 * - Constructor parameters are other modules, injected by type. Don't do work in the constructor: `trove` and `ctx`
 *   are attached right after construction, so start in onInit/onStart.
 * - `trove` is this module's own trove (an extension of the generation's root trove). Everything the module creates
 *   or connects goes in it, so a swap leaves nothing behind.
 */
export abstract class Module {
	protected readonly trove!: Trove;
	protected readonly ctx!: ModuleContext;
}
