/**
 * TypeScript view of the objects the TypeTorch kernel hands a generation (`Server.boot.boot(kernel)` /
 * `Client.boot.boot(kernel)`). The kernel side is Luau: kernel/src/server/Api.luau and kernel/src/shared/ClientApi.luau.
 * Keep both in sync; breaking changes bump the kernel API (`kernelApi`).
 */

export type Channel = "prod" | "dev";
export type ServerType = "public" | "private" | "reserved" | "studio";

export interface ArtifactInfo {
	readonly id: string;
	readonly assetId?: number;
	readonly channel?: Channel;
	readonly branch?: string;
	readonly commit?: string;
	readonly commitHash?: string;
	readonly builtAt?: number;
	readonly seq?: number;
}

export interface DevInfo {
	dev: boolean;
	reason: string;
	role?: "owner" | "admin" | "dev";
	channel?: Channel;
}

export interface LogEntry {
	i: number;
	t: number;
	kind: "output" | "info" | "warning" | "error";
	text: string;
}

export interface SwapReport {
	ok: boolean;
	error?: string;
	queued?: boolean;
	reason?: string;
	assetId?: number;
	artifactId?: string;
	/** Name of the generation now running (`<artifactId>#<n>`). */
	generation?: string;
	loadSeconds?: number;
	stopSeconds?: number;
	swapSeconds?: number;
	/** Set when the new generation failed to start and the kernel rolled back to this artifact. */
	rollbackTo?: string;
	/** Kernel 0.2+: set by pinArtifact when the server now holds the pinned artifact. */
	pinned?: boolean;
}

export interface NewServerReport {
	ok: boolean;
	error?: string;
	branch?: string;
	/** Kernel 0.2+: the artifact the reserved server boots pinned to. */
	assetId?: number;
}

/** One known deployment (kernel 0.2+ `artifacts()`), newest first. */
export interface ArtifactEntry {
	/** Deploy sequence number (global across branches); absent for entries only known from a server's history. */
	seq?: number;
	branch: string;
	channel: Channel;
	artifactId?: string;
	assetId: number;
	commit?: string;
	/** ISO time of the deploy. */
	at?: string;
	rollback?: boolean;
	/** The current head of its branch. */
	live: boolean;
	/** This server's current generation. */
	running: boolean;
}

export interface BranchInfo {
	name: string;
	channel: Channel;
	artifactId?: string;
	/** Kernel 0.2+. */
	assetId?: number;
	commit?: string;
	seq?: number;
	deployedAt?: string;
	by?: string;
}

export interface GenerationHistoryEntry {
	name: string;
	artifactId: string;
	at: string;
	reason: string;
	loadSeconds?: number;
	swapSeconds?: number;
}

export interface KernelStatus {
	jobId: string;
	placeId: number;
	placeVersion: number;
	serverType: ServerType;
	branch: string;
	channel?: Channel;
	/** Kernel 0.2+: the running generation was pinned (holds until a newer deploy of this server's branch). */
	pinned?: boolean;
	startedAt: number;
	uptime: number;
	generation?: { name: string; number: number; startedAt: number; uptime: number; artifact: ArtifactInfo };
	history: GenerationHistoryEntry[];
	lastMessage?: { data: Record<string, unknown>; receivedMs: number; sentMs?: number };
	players: number;
	maxPlayers: number;
	kernelVersion: string;
	kernelApi: number;
	registryError?: string;
	memoryMb: number;
	luaHeapKb: number;
	appliedSeq: number;
}

export interface ServerKernel {
	readonly kernelApi: number;
	readonly kernelVersion: string;
	readonly artifact: ArtifactInfo;
	readonly generation: number;
	readonly branch: string;
	/** Effective channel: the strictest of branch, artifact and server type (public servers are always "prod"). */
	readonly channel: Channel;
	readonly serverType: ServerType;

	/** A table that survives generation swaps (plain data or kernel-owned handles only). */
	persist<T extends object>(key: string, init: () => T): T;

	isDev(player: Player): boolean;
	devInfo(player: Player): DevInfo;

	/** The running generation's inbound handler (one per generation; the framework installs it). */
	onMessage(handler: (player: Player, channel: string, ...args: unknown[]) => void): void;
	send(player: Player, channel: string, ...args: unknown[]): void;
	broadcast(channel: string, ...args: unknown[]): void;
	sendUnreliable(player: Player, channel: string, ...args: unknown[]): void;
	broadcastUnreliable(channel: string, ...args: unknown[]): void;

	status(): KernelStatus;
	logs(since?: number, limit?: number): LogEntry[];
	branches(): BranchInfo[];
	/** Control calls re-check the acting player's permissions in the kernel. */
	reload(player: Player): SwapReport;
	rollback(player: Player): SwapReport;
	switchBranch(player: Player, branch: string): SwapReport;
	/**
	 * Reserves a server on `branch` and teleports the player. `assetId` needs kernel 0.2+ (older kernels ignore it and
	 * open the branch head), so only pass it when `pinArtifact` exists.
	 */
	newServer(player: Player, branch: string, assetId?: number): NewServerReport;

	// Kernel 0.2+ (additive, same kernelApi): feature-detect with `typeIs((kernel as any).artifacts, "function")`.
	/** Known deployments, newest first. Yields (DataStore). */
	artifacts?(): ArtifactEntry[];
	/**
	 * Swap this server to a known artifact and hold it until a newer deploy of its branch. Devs on private/reserved/
	 * studio servers; on public servers only owner/admin and only prod-channel artifacts.
	 */
	pinArtifact?(player: Player, assetId: number): SwapReport;
}

export interface ClientKernel {
	readonly kernelApi: number;
	readonly kernelVersion: string;
	readonly artifact: { readonly id: string };
	readonly generation: number;
	readonly branch?: string;
	readonly channel?: Channel;

	persist<T extends object>(key: string, init: () => T): T;
	onMessage(handler: (channel: string, ...args: unknown[]) => void): void;
	send(channel: string, ...args: unknown[]): void;
	sendUnreliable(channel: string, ...args: unknown[]): void;
	/** What the server last said about this player (cosmetic; the server re-checks every request). */
	devStatus(): DevInfo;
	/** Kernel events such as "dev-open" (from `/tt dev`). Returns a disconnect function. */
	onKernelEvent(handler: (name: string) => void): () => void;
	logs(since?: number, limit?: number): LogEntry[];
}

export type Kernel = ServerKernel | ClientKernel;
