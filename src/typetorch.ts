import { LogService, Players, RunService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type {
	ArtifactEntry,
	ArtifactInfo,
	BranchInfo,
	Channel,
	ClientKernel,
	DevInfo,
	GenerationStart,
	KernelStatus,
	LogEntry,
	PendingUpdate,
	PreviousGeneration,
	Role,
	ServerKernel,
	ServerType,
	StartReason,
	SwapOutInfo,
	SwapReport,
} from "./kernel";
import { normalRole } from "./kernel";
import type { BuildInfo } from "./module";
import type { Modding } from "./reflection/modding";
import { resolveModule, tryResolveModule } from "./runtime/dependency";
import { playerState, type PlayerState } from "./runtime/player-state";
import { persistKeys } from "./runtime/registry";
import { hotAsset, type HotAsset } from "./assets/hot-asset";

/**
 * `TypeTorch`: the runtime API for game code, on the server and the client. It describes the running generation
 * (artifact, branch, channel, how it started), raises generation-scoped events (swap out, pending update, branch
 * change, dev status, logs) and wraps the kernel's persist store, dev roles and server status.
 *
 * The framework ships inside every artifact, so each generation has its own copy of this module: its listeners go away
 * with the generation, and nothing here outlives a swap except what `persist` stores in the kernel.
 * Features that need kernel 0.2.2 are feature-detected (see `features`); older kernels get the documented fallbacks.
 */

/** The argument of `onBranchChanged`. */
export interface BranchChange {
	/** The server's branch before (the previous generation's). */
	readonly from: string;
	/** The server's branch now (`TypeTorch.branch`). */
	readonly to: string;
	readonly start: GenerationStart;
}

/** What the running kernel supports (all false outside a running kernel). */
export interface TypeTorchFeatures {
	/** The kernel reports the start reason, timings and requester, and the next artifact in `onSwapOut` (0.2.2+). */
	readonly kernelStart: boolean;
	/** `onUpdatePending` fires (0.2.2+). */
	readonly updatePending: boolean;
	/** `onPlayerDevChanged` fires: server on kernel 0.2.2+, client always (it polls on older kernels). */
	readonly devChanged: boolean;
	/** `artifacts()` works (kernel 0.2.0+). */
	readonly artifacts: boolean;
	/** `requestReload` works (0.2.2+). */
	readonly requestReload: boolean;
}

export interface TypeTorchApi {
	// Identity ---------------------------------------------------------------------------------------------------------
	readonly realm: "server" | "client";
	/** True inside a generation started by the kernel; false in edit mode (UI Labs stories), where defaults apply. */
	readonly running: boolean;
	/** The running artifact. On a client before kernel 0.2.2, fields other than `id` come from the game's build.ts. */
	readonly artifact: ArtifactInfo;
	/** This generation's number in this server (or this client): 1 for the first one, +1 per swap. */
	readonly generation: number;
	/** The server's branch. A branch switch starts a new generation (see `startInfo` and `onBranchChanged`). */
	readonly branch: string;
	/** Effective channel: the strictest of branch, artifact and server type (public servers are always "prod"). */
	readonly channel: Channel;
	/** On a client before kernel 0.2.2 this is a best guess. */
	readonly serverType: ServerType;
	readonly kernelVersion: string;
	readonly kernelApi: number;
	/** game.JobId (on a client: its server's). */
	readonly jobId: string;
	readonly isStudio: boolean;
	/** How this generation started: boot or swap, the reason, the previous artifact and branch, timings. */
	readonly startInfo: GenerationStart;
	readonly features: TypeTorchFeatures;

	/** Whether this generation is pinned to an artifact (holds until its branch gets a newer deploy). Cheap. */
	isPinned(): boolean;

	// Persist ----------------------------------------------------------------------------------------------------------
	/**
	 * A table that survives swaps: the first call in a server (or client) runs `init`, every later call and every
	 * later generation gets the same table back. It lives in memory only, until the server shuts down.
	 *
	 * Store plain data: tables, arrays, Maps and Sets of strings, numbers, booleans, and Players. Never store functions,
	 * class instances, Promises, threads, connections, charm atoms or instances this generation created: they hold on
	 * to the old generation's code (it never gets garbage collected, and its methods are old code) or are destroyed by
	 * its trove. Version the key (`"shop.v2"`) when the shape changes. Keys starting with `__` are reserved.
	 */
	persist<T extends object>(key: string, init: () => T): T;
	/**
	 * Per-player state that survives swaps, keyed by UserId (same as `ctx.playerState`): `get(player)` stores
	 * `init(player)` the first time, then `set`, `has`, `delete`. A player's entry is removed when they really leave,
	 * never on a swap. Plain data only (the `persist` rules). The dev menu shows it under persist, `__playerState`.
	 */
	playerState<T>(key: string, init: (player: Player) => T): PlayerState<T>;

	// Modules ----------------------------------------------------------------------------------------------------------
	/**
	 * The running module of type T (a @Service on the server, a @Controller on the client), for code that isn't a
	 * constructor: methods, plain classes, command handlers. Same as `Dependency<T>()`. Works from onInit/onStart on;
	 * throws a clear error before every module is constructed (a constructor, a field initializer, module top-level
	 * code), for the other realm's modules, and once this generation stopped.
	 *
	 * @metadata macro
	 */
	module<T>(id?: Modding.Generic<T, "id">): T;
	/**
	 * Like `module`, but undefined instead of an error (not constructed yet, other realm, not a module, stopped, edit
	 * mode).
	 *
	 * @metadata macro
	 */
	tryModule<T>(id?: Modding.Generic<T, "id">): T | undefined;

	// Dev and roles ----------------------------------------------------------------------------------------------------
	/**
	 * Server: the kernel's decision (Studio, owner, project member or dev badge, not revoked); may yield the first time
	 * for a player (badge and group checks), then it is cached. Client: only the local player is known (cosmetic: the
	 * server re-checks everything); other players are false.
	 */
	isDev(player: Player): boolean;
	/** "owner" | "dev", or undefined. Same rules as `isDev`. An older kernel's "admin" counts as "dev". */
	role(player: Player): Role | undefined;
	/** A dev whose role is owner (the experience creator, the owning group's owner, members with role "owner"). */
	isOwner(player: Player): boolean;
	/** @deprecated There are no admins (framework 0.3.2): the same as `isOwner`. */
	isAdmin(player: Player): boolean;
	devInfo(player: Player): DevInfo;

	// Server-only reads ------------------------------------------------------------------------------------------------
	/** Server only. Uptime, players, memory, generation history, last deploy message. Cheap (no yield). */
	status(): KernelStatus;
	/** Server only. Known branches and their heads. Yields at most every 30 s (cached registry read). */
	branches(): BranchInfo[];
	/**
	 * Server only, kernel 0.2.0+ (undefined before). Known deployments, newest first. Yields at most every 30 s (a
	 * cached DataStore read); don't call it per player or per frame.
	 */
	artifacts(): ArtifactEntry[] | undefined;
	/**
	 * Server only, kernel 0.2.2+. Reloads this server to its branch head. The kernel allows it only for the owner. On
	 * success it returns at once ({ ok: true, queued: true }) and the swap follows, which stops this
	 * generation (onSwapOut fires).
	 */
	requestReload(player: Player): SwapReport;

	// Logs -------------------------------------------------------------------------------------------------------------
	/** The kernel's log ring buffer (server 500 lines, client 300), entries with `i > since`, oldest first. */
	logs(since?: number, limit?: number): LogEntry[];
	/**
	 * Every new log line of this realm (from the kernel's buffer, so `i` matches `logs()`). Don't print or warn from the
	 * listener: it would see its own output. A listener that throws is removed. Returns a disconnect function.
	 */
	onLog(callback: (entry: LogEntry) => void): () => void;

	// Generation-scoped events: every listener is dropped when this generation stops. Each returns a disconnect
	// function (a trove takes it: `this.trove.add(TypeTorch.onSwapOut(...))`). ----------------------------------------
	/**
	 * Fires just before this generation stops, before any module's onStop, so code can save state with `persist`.
	 * Runs synchronously and delays the swap: keep it short, don't yield. Doesn't fire on server shutdown (use
	 * game.BindToClose). Kernels before 0.2.2 pass `{ reason: "unknown" }`.
	 */
	onSwapOut(callback: (info: SwapOutInfo) => void): () => void;
	/**
	 * Kernel 0.2.2+: a deploy (or reload, branch switch, pin) reached this server and a swap is coming in about
	 * `update.eta` seconds; show a small "updating" hint. Fires again with `cancelled: true` if the new payload failed
	 * to load (hide the hint). On public servers it can fire twice for one deploy (the second with a shorter ETA).
	 */
	onUpdatePending(callback: (update: PendingUpdate) => void): () => void;
	/**
	 * Fires once in a generation that started because the server's branch changed (dev menu, `/tt branch`), shortly
	 * after every module started. Subscribing later still delivers it once.
	 */
	onBranchChanged(callback: (change: BranchChange) => void): () => void;
	/**
	 * A player's dev status changed (revoked, made a member, badge granted). Server: kernel 0.2.2+, only changes after
	 * the first decision (use `isDev` in onPlayerAdded for the first). Client: the local player only.
	 */
	onPlayerDevChanged(callback: (player: Player, info: DevInfo) => void): () => void;

	// Hot assets -------------------------------------------------------------------------------------------------------
	/**
	 * A handle on a hot asset (plans/13): the live copy of `keyOrId` (a key like "ui/shop", or its asset id), its
	 * version and a `changed` event, on the server and the client. Same as `hotAsset(keyOrId, fallback)`.
	 */
	asset(keyOrId: string | number, fallback?: Instance): HotAsset;
}

// State of this generation's binding ------------------------------------------------------------------------------------

const PREVIOUS_KEY = "__typetorch/generation";

interface GenerationRecord {
	last?: PreviousGeneration;
}

let server: ServerKernel | undefined;
let client: ClientKernel | undefined;
let generationTrove: Trove | undefined;
let branchChange: BranchChange | undefined;
let branchAnnounced = false;
let devPolling = false;
let logConnection: RBXScriptConnection | undefined;
let lastLog = 0;
let logQueued = false;
/** Edit mode (no kernel): persist tables live for the session. */
const localPersist = new Map<string, object>();

const swapOutListeners = new Set<(info: SwapOutInfo) => void>();
/** Framework-internal: run on server shutdown after every module's onStop (kernel 0.3.2+ onClose). */
const closeListeners = new Set<() => void>();
const pendingListeners = new Set<(update: PendingUpdate) => void>();
const branchListeners = new Set<(change: BranchChange) => void>();
const devListeners = new Set<(player: Player, info: DevInfo) => void>();
const logListeners = new Set<(entry: LogEntry) => void>();

const NO_FEATURES: TypeTorchFeatures = {
	kernelStart: false,
	updatePending: false,
	devChanged: false,
	artifacts: false,
	requestReload: false,
};

function hasMethod(kernel: object, name: string): boolean {
	return typeIs((kernel as Record<string, unknown>)[name], "function");
}

function kernelOf(): ServerKernel | ClientKernel | undefined {
	return server ?? client;
}

function serverOnly(name: string): ServerKernel {
	if (server) return server;
	error(`TypeTorch.${name}() is server-only${client ? "" : " and needs a running kernel"}`, 3);
}

/** A client on a kernel before 0.2.2 doesn't get the server type; guess it the way the kernel decides it. */
function guessServerType(): ServerType {
	if (RunService.IsStudio()) return "studio";
	const [ok, privateId] = pcall(() => game.PrivateServerId);
	if (!ok || privateId === "") return "public";
	const [ownerOk, owner] = pcall(() => game.PrivateServerOwnerId);
	return ownerOk && owner !== 0 ? "private" : "reserved";
}

/** Fills what the kernel didn't say (kernel 0.1, or a client before 0.2.2) from the game's compiled-in build.ts. */
function withBuild(artifact: ArtifactInfo, build: BuildInfo): ArtifactInfo {
	return { branch: build.branch, commit: build.commit, channel: build.channel, builtAt: build.builtAt, ...artifact };
}

function spawnEach<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A) {
	for (const listener of [...listeners]) task.spawn(listener, ...args);
}

function flushLogs() {
	logQueued = false;
	const kernel = kernelOf();
	if (!kernel) return;
	for (const entry of kernel.logs(lastLog, 200)) {
		lastLog = entry.i;
		for (const listener of [...logListeners]) {
			const [ok, err] = pcall(listener, entry);
			if (!ok) {
				// Removed first: its warning is a log line too.
				logListeners.delete(listener);
				$warn(`TypeTorch.onLog listener removed after it threw: ${err}`);
			}
		}
	}
}

/** One LogService connection per generation, made on the first onLog. Reads the kernel's buffer after it updated. */
function ensureLogs() {
	const kernel = kernelOf();
	if (logConnection || !kernel || !generationTrove) return;
	const latest = kernel.logs(undefined, 1);
	lastLog = latest.size() > 0 ? latest[latest.size() - 1].i : 0;
	logConnection = generationTrove.connect(LogService.MessageOut, () => {
		if (logQueued) return;
		logQueued = true;
		task.defer(flushLogs);
	});
}

/** Clients on kernels before 0.2.2: compare the cached dev status once a second (a table copy). */
function ensureDevPolling() {
	if (devPolling || !client || !generationTrove || hasMethod(client, "onDevChanged")) return;
	devPolling = true;
	const kernel = client;
	let last = kernel.devStatus();
	generationTrove.add(
		task.spawn(() => {
			while (true) {
				task.wait(1);
				const now = kernel.devStatus();
				if (now.dev !== last.dev || now.role !== last.role) {
					last = now;
					spawnEach(devListeners, Players.LocalPlayer, now);
				}
			}
		}),
	);
}

function listen<T>(listeners: Set<T>, callback: T): () => void {
	listeners.add(callback);
	return () => {
		listeners.delete(callback);
	};
}

class TypeTorchRuntime implements TypeTorchApi {
	realm: "server" | "client" = RunService.IsServer() ? "server" : "client";
	running = false;
	artifact: ArtifactInfo = { id: "local" };
	generation = 0;
	branch = "local";
	channel: Channel = "dev";
	serverType: ServerType = "studio";
	kernelVersion = "none";
	kernelApi = 0;
	jobId = game.JobId;
	isStudio = RunService.IsStudio();
	startInfo: GenerationStart = { kind: "boot", reason: "boot", branchChanged: false, startedAt: os.time() };
	features: TypeTorchFeatures = NO_FEATURES;

	isPinned(): boolean {
		if (server) return hasMethod(server, "pinned") ? server.pinned!() : server.status().pinned === true;
		if (client) return hasMethod(client, "pinned") ? client.pinned!() : false;
		return false;
	}

	persist<T extends object>(key: string, init: () => T): T {
		assert(typeIs(key, "string"), "TypeTorch.persist: the key must be a string");
		const kernel = kernelOf();
		let value: T;
		if (kernel) value = kernel.persist(key, init);
		else {
			const stored = localPersist.get(key) as T | undefined;
			value = stored ?? init();
			localPersist.set(key, value);
		}
		persistKeys.set(key, value);
		return value;
	}

	playerState<T>(key: string, init: (player: Player) => T): PlayerState<T> {
		return playerState(key, init);
	}

	module<T>(id?: Modding.Generic<T, "id">): T {
		return resolveModule(id, (name) => `TypeTorch.module<${name}>()`) as T;
	}

	tryModule<T>(id?: Modding.Generic<T, "id">): T | undefined {
		return tryResolveModule(id, (name) => `TypeTorch.tryModule<${name}>()`) as T | undefined;
	}

	devInfo(player: Player): DevInfo {
		if (server) return server.devInfo(player);
		if (client) return player === Players.LocalPlayer ? client.devStatus() : { dev: false, reason: "unknown" };
		return this.isStudio ? { dev: true, reason: "studio", role: "owner" } : { dev: false, reason: "none" };
	}

	isDev(player: Player): boolean {
		if (server) return server.isDev(player);
		return this.devInfo(player).dev === true;
	}

	role(player: Player): Role | undefined {
		const info = this.devInfo(player);
		return info.dev ? normalRole(info.role) : undefined;
	}

	isOwner(player: Player): boolean {
		return this.role(player) === "owner";
	}

	isAdmin(player: Player): boolean {
		return this.isOwner(player);
	}

	status(): KernelStatus {
		return serverOnly("status").status();
	}

	branches(): BranchInfo[] {
		return serverOnly("branches").branches();
	}

	artifacts(): ArtifactEntry[] | undefined {
		const kernel = serverOnly("artifacts");
		return hasMethod(kernel, "artifacts") ? kernel.artifacts!() : undefined;
	}

	requestReload(player: Player): SwapReport {
		const kernel = serverOnly("requestReload");
		// Older kernels have only reload(), which runs the swap on the calling thread: called from game code, this
		// generation's hard stop would kill it halfway. So no fallback.
		if (!hasMethod(kernel, "requestReload")) return { ok: false, error: "needs kernel 0.2.2" };
		return kernel.requestReload!(player);
	}

	logs(since?: number, limit?: number): LogEntry[] {
		return kernelOf()?.logs(since, limit) ?? [];
	}

	onLog(callback: (entry: LogEntry) => void): () => void {
		const disconnect = listen(logListeners, callback);
		ensureLogs();
		return disconnect;
	}

	onSwapOut(callback: (info: SwapOutInfo) => void): () => void {
		return listen(swapOutListeners, callback);
	}

	onUpdatePending(callback: (update: PendingUpdate) => void): () => void {
		return listen(pendingListeners, callback);
	}

	onBranchChanged(callback: (change: BranchChange) => void): () => void {
		const disconnect = listen(branchListeners, callback);
		const change = branchChange;
		if (change && branchAnnounced) {
			task.defer(() => {
				if (branchListeners.has(callback)) callback(change);
			});
		}
		return disconnect;
	}

	onPlayerDevChanged(callback: (player: Player, info: DevInfo) => void): () => void {
		const disconnect = listen(devListeners, callback);
		ensureDevPolling();
		return disconnect;
	}

	asset(keyOrId: string | number, fallback?: Instance): HotAsset {
		return hotAsset(keyOrId, fallback);
	}
}

/** The runtime API for game code (server and client). See `TypeTorchApi` and the README. */
export const TypeTorch: TypeTorchApi = new TypeTorchRuntime();

const runtime = TypeTorch as TypeTorchRuntime;

// Lifecycle (called by runtime/start.ts) --------------------------------------------------------------------------------

/** Binds `TypeTorch` to this generation's kernel. `trove` is the generation's root trove. */
export function bindTypeTorch(
	realm: "server" | "client",
	kernel: ServerKernel | ClientKernel,
	build: BuildInfo,
	trove: Trove,
) {
	generationTrove = trove;
	runtime.realm = realm;
	runtime.running = true;
	runtime.generation = kernel.generation;
	runtime.kernelVersion = kernel.kernelVersion;
	runtime.kernelApi = kernel.kernelApi;
	runtime.artifact = withBuild(kernel.artifact, build);
	runtime.branch = kernel.branch ?? build.branch ?? "unknown";
	// A client that doesn't know the channel assumes the strictest.
	runtime.channel = kernel.channel ?? "prod";
	if (realm === "server") {
		server = kernel as ServerKernel;
		runtime.serverType = server.serverType;
	} else {
		client = kernel as ClientKernel;
		runtime.serverType = client.serverType ?? guessServerType();
	}

	// Kernel hooks fire on kernel threads; the relay moves them onto this generation's own threads, so the hard stop
	// ends any listener that is still running.
	const relay = trove.add(new Instance("BindableEvent"));
	trove.connect(relay.Event, (kind: unknown, first: unknown, second: unknown) => {
		if (kind === "pending") spawnEach(pendingListeners, first as PendingUpdate);
		else if (kind === "dev") spawnEach(devListeners, first as Player, second as DevInfo);
	});
	const hasPending = hasMethod(kernel, "onPending");
	if (hasPending) kernel.onPending!((update) => relay.Fire("pending", update));
	let devChanged = realm === "client";
	if (server && hasMethod(server, "onDevChanged")) {
		server.onDevChanged!((player, info) => relay.Fire("dev", player, info));
		devChanged = true;
	} else if (client && hasMethod(client, "onDevChanged")) {
		client.onDevChanged!((info) => relay.Fire("dev", Players.LocalPlayer, info));
	}

	// How this generation started: the kernel says (0.2.2+), or the framework's own record of the previous generation.
	const record = kernel.persist<GenerationRecord>(PREVIOUS_KEY, () => ({}));
	const kernelStart = kernel.start;
	let start: GenerationStart;
	if (kernelStart !== undefined) start = kernelStart;
	else {
		const previous = record.last;
		const branchChanged = previous !== undefined && previous.branch !== runtime.branch;
		start = {
			kind: previous ? "swap" : "boot",
			reason: previous === undefined ? "boot" : branchChanged ? "branch" : "unknown",
			previous,
			branchChanged,
			startedAt: os.time(),
		};
	}
	runtime.startInfo = start;
	branchAnnounced = false;
	const from = start.previous?.branch;
	branchChange = start.branchChanged && from !== undefined ? { from, to: runtime.branch, start } : undefined;

	runtime.features = {
		kernelStart: kernelStart !== undefined,
		updatePending: hasPending,
		devChanged,
		artifacts: server !== undefined && hasMethod(server, "artifacts"),
		requestReload: server !== undefined && hasMethod(server, "requestReload"),
	};
}

/** Every module started: remember this generation for the next one, announce a branch change. */
export function startedTypeTorch() {
	const kernel = kernelOf();
	if (!kernel) return;
	const record = kernel.persist<GenerationRecord>(PREVIOUS_KEY, () => ({}));
	record.last = {
		artifact: { ...runtime.artifact },
		branch: runtime.branch,
		channel: runtime.channel,
		generation: runtime.generation,
	};
	const change = branchChange;
	if (change) {
		task.defer(() => {
			branchAnnounced = true;
			spawnEach(branchListeners, change);
		});
	}
}

/** The kernel is stopping this generation (`info` from kernel 0.2.2+). Runs before any module's onStop. */
export function swapOutTypeTorch(info: unknown) {
	const swapOut: SwapOutInfo = typeIs(info, "table") ? (info as SwapOutInfo) : { reason: "unknown" as StartReason };
	for (const listener of [...swapOutListeners]) {
		const [ok, err] = pcall(listener, swapOut);
		if (!ok) $warn(`TypeTorch.onSwapOut listener threw: ${err}`);
	}
}

// Framework-internal (not exported from the package root): built-ins that live with the generation, such as the
// analytics engine, use these instead of a module's trove.

/** The running generation: its root trove and kernel. Undefined outside a running generation (edit mode). */
export interface GenerationScope {
	readonly trove: Trove;
	readonly server?: ServerKernel;
	readonly client?: ClientKernel;
}

export function generationScope(): GenerationScope | undefined {
	if (!generationTrove) return undefined;
	return { trove: generationTrove, server, client };
}

/**
 * Server shutdown hook for built-ins: runs after every module's onStop, inside the kernel's onClose (kernel 0.3.2+, up
 * to 20 s; may yield). Returns a disconnect function. `closeHooksSupported()` says whether it will ever run.
 */
export function onGenerationClose(callback: () => void): () => void {
	return listen(closeListeners, callback);
}

/** Whether the running server kernel has onClose (0.3.2+), so `onGenerationClose` hooks run on shutdown. */
export function closeHooksSupported(): boolean {
	return server !== undefined && hasMethod(server, "onClose");
}

/** Called by runtime/start.ts from the kernel's onClose, after the modules stopped. Hooks run in parallel. */
export function closeTypeTorch() {
	const running = new Array<thread>();
	for (const listener of [...closeListeners]) {
		running.push(
			task.spawn(() => {
				const [ok, err] = pcall(listener);
				if (!ok) $warn(`TypeTorch close hook threw: ${err}`);
			}),
		);
	}
	// The kernel gives onClose up to 20 s; wait for the hooks a bit less than that.
	const deadline = os.clock() + 18;
	while (os.clock() < deadline && running.some((thread) => coroutine.status(thread) !== "dead")) task.wait(0.1);
}

/** The generation stopped (or failed to start): drop every listener and the kernel. */
export function unbindTypeTorch() {
	swapOutListeners.clear();
	closeListeners.clear();
	pendingListeners.clear();
	branchListeners.clear();
	devListeners.clear();
	logListeners.clear();
	server = undefined;
	client = undefined;
	generationTrove = undefined;
	branchChange = undefined;
	logConnection = undefined;
	devPolling = false;
	runtime.running = false;
	runtime.features = NO_FEATURES;
}
