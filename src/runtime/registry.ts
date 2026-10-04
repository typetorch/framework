import type { Trove } from "@rbxts/trove";

/**
 * Classes registered by @Service / @Controller as their modules load. The framework ships inside every artifact, so
 * each generation requires its own copy of this module and starts with an empty list (no stale classes from the
 * previous generation).
 */
export interface ModuleConfig {
	/** Tie-breaker between modules with no dependency relation (lower starts first). Default 0. */
	loadOrder?: number;
}

export interface RegisteredModule {
	readonly ctor: object;
	readonly realm: "server" | "client";
	readonly config: ModuleConfig;
}

export const registered = new Array<RegisteredModule>();

export interface RunningModule {
	readonly name: string;
	readonly instance: object;
	readonly trove: Trove;
	readonly dependencies: string[];
	readonly loadOrder: number;
	initSeconds?: number;
}

/** Modules of the running generation, in start order (the dev menu reads this). */
export const runningModules = new Array<RunningModule>();
