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
	/** Kernel 0.3+, in `status().generation.artifact` only: its deploy's signatures (absent when unsigned). */
	readonly verified?: Verified;
}

/**
 * Kernel 0.3+: which signatures of a signed prod deploy check out, each on its own (plans/03 "Signed prod messages").
 * Absent for unsigned (dev) deploys. The dev menu shows one verified badge per `true`.
 */
export interface Verified {
	/** `sig` verifies with a key in the key asset's PublicKeys that isn't in RevokedKeys. */
	main: boolean;
	/** `sigF` verifies with the FallbackPublicKey baked into the place (and the key asset doesn't revoke it). */
	fallback: boolean;
}

/** Kernel 0.3+: how signatures are checked now. "none": no trust root, so prod servers refuse every deploy. */
export type SigningMode = "key asset" | "fallback only" | "none";

/** Kernel 0.3+: one refused message, head, pin or swap. */
export interface Refusal {
	/** "deploy", "head", "pin", "swap", "private-branch". */
	kind: string;
	why: string;
	/** Unix seconds. */
	at: number;
	branch?: string;
	seq?: number;
	assetId?: number;
	artifactId?: string;
}

/** Kernel 0.3+: refusals since this server booted. */
export interface Rejections {
	total: number;
	byKind: Record<string, number>;
	last?: Refusal;
}

/** Kernel 0.3+: `status().signing`, a summary of the trust state (`keys()` has all of it). */
export interface SigningSummary {
	mode: SigningMode;
	/** The key asset has loaded on this server. */
	loaded: boolean;
	/** Trusted main keys (PublicKeys minus RevokedKeys). */
	trusted: number;
	fallbackRevoked?: boolean;
	/** Unix seconds of the last detected change of PublicKeys/RevokedKeys. */
	lastChangeAt?: number;
	/** That change came shortly after a rekey hint (likely the user's own `typetorch keys rotate`). */
	lastChangeHinted?: boolean;
	lastReadOk?: boolean;
}

/** Kernel 0.3+: a public key; `fingerprint` = the first 8 hex digits of the SHA-256 of its raw 32 bytes. */
export interface KeyRow {
	/** base64 of the raw 32-byte Ed25519 public key. */
	key: string;
	fingerprint: string;
	/** In PublicKeys and RevokedKeys both. */
	revoked?: boolean;
}

/** Kernel 0.3+: a change of the key asset's lists versus what this server loaded before. */
export interface KeyChange {
	/** Unix seconds. */
	at: number;
	/** The read that found it: "boot", "hint", "failure", "periodic". */
	reason: string;
	hinted: boolean;
	version?: number;
	previousVersion?: number;
	added: string[];
	removed: string[];
	revokedAdded: string[];
	revokedRemoved: string[];
	/** Fingerprints. */
	before: { publicKeys: string[]; revokedKeys: string[] };
	after: { publicKeys: string[]; revokedKeys: string[] };
}

/** Kernel 0.3+: `keys()`, the trust state for devs. Public keys aren't secret. */
export interface KeyTrust {
	keyAssetId?: number;
	loaded: boolean;
	mode: SigningMode;
	/** The key asset version last loaded. */
	version?: number;
	/** Unix seconds of the last successful read. */
	loadedAt?: number;
	lastReadOk?: boolean;
	/** The last failed read (short); kept after later successes, see lastErrorAt. */
	lastError?: string;
	lastErrorAt?: number;
	reads: number;
	/** The stamped attributes were unusable. */
	configError?: string;
	publicKeys: KeyRow[];
	revokedKeys: KeyRow[];
	trusted: number;
	invalid?: string[];
	fallback?: KeyRow & { revoked: boolean };
	lastHintAt?: number;
	lastChange?: KeyChange;
	/** Changes seen since boot. */
	changes: number;
	/** This server takes only signed prod artifacts. */
	signedOnly: boolean;
	/** The BootstrapHeads kernel deploy stamped: the only unsigned heads a prod server takes (exact asset and seq). */
	bootstrap?: Record<string, { assetId: number; seq: number; artifactId?: string }>;
	/** See KernelStatus.noTrustedHead. */
	noTrustedHead?: boolean;
	/** See KernelStatus.unverified. */
	unverified?: boolean;
	rejected: Rejections;
	/** The last 10 refusals, oldest first. */
	refusals: Refusal[];
}

export type Role = "owner" | "admin" | "dev";

export interface DevInfo {
	dev: boolean;
	/** Why: "studio", "owner", "member", "badge", "revoked", "none". */
	reason: string;
	role?: Role;
	channel?: Channel;
}

/**
 * Why a generation started (or the next one will):
 * - `boot`: the first generation of this server (or, on a client, of this player's session);
 * - `deploy`: its branch got a new deploy (a deploy message, or the poll or registry catching up);
 * - `rollback`: its branch was rolled back (`typetorch rollback`);
 * - `branch`: this server switched branch (dev menu, `/tt branch`);
 * - `pin`: this server was pinned to a known artifact;
 * - `reload`: a dev or admin reloaded the branch head;
 * - `server_rollback`: `/tt rollback` (this server's own history);
 * - `auto_rollback`: the next artifact failed to start, so the kernel brought this one back;
 * - `unknown`: the kernel is older than 0.2.2 and didn't say.
 */
export type StartReason =
	| "boot"
	| "deploy"
	| "rollback"
	| "branch"
	| "pin"
	| "reload"
	| "server_rollback"
	| "auto_rollback"
	| "unknown";

/** The generation that ran before this one (in this server, or in this client). */
export interface PreviousGeneration {
	readonly artifact: ArtifactInfo;
	/** The server's branch back then. */
	readonly branch?: string;
	readonly channel?: Channel;
	/** Its generation number. */
	readonly generation: number;
}

/** How this generation started (kernel 0.2.2+ `kernel.start`; the framework fills it in on older kernels). */
export interface GenerationStart {
	/** "boot": nothing ran before it; "swap": it replaced a running generation. */
	readonly kind: "boot" | "swap";
	readonly reason: StartReason;
	readonly previous?: PreviousGeneration;
	/** The server's branch differs from the previous generation's (a branch switch). */
	readonly branchChanged: boolean;
	/** os.time() when it started. */
	readonly startedAt: number;
	/** Server only: user id of the dev or admin who asked (reload, branch, pin, server rollback). */
	readonly requestedBy?: number;
	/** Server only (kernel 0.2.2+): seconds spent loading the payload. */
	readonly loadSeconds?: number;
	/** Server only (kernel 0.2.2+): seconds the previous generation took to stop. */
	readonly stopSeconds?: number;
	/**
	 * Server only (kernel 0.2.2+): stop + start time of the whole swap. Set once the swap finished, so it is still
	 * undefined during onInit and the start of onStart.
	 */
	readonly swapSeconds?: number;
}

/** What replaces this generation (the argument of `onSwapOut`). */
export interface SwapOutInfo {
	/** Why the next generation starts ("unknown" on kernels older than 0.2.2). */
	readonly reason: StartReason;
	/** The server's branch after the swap (differs from `TypeTorch.branch` on a branch switch). */
	readonly branch?: string;
	/** The next artifact, when the kernel says (0.2.2+; on a client only `id`). */
	readonly next?: {
		readonly id?: string;
		readonly assetId?: number;
		readonly branch?: string;
		readonly commit?: string;
		readonly channel?: Channel;
	};
}

/** A swap is coming (kernel 0.2.2+), or was called off. */
export interface PendingUpdate {
	readonly reason: StartReason;
	/** The server's branch. */
	readonly branch?: string;
	readonly artifactId?: string;
	readonly commit?: string;
	/**
	 * Estimated seconds until this generation stops: the public-server jitter (up to 10 s) plus the usual load and
	 * swap time. 0 when cancelled.
	 */
	readonly eta: number;
	/** The swap was called off (the payload failed to load); this generation keeps running. */
	readonly cancelled?: boolean;
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
	/** Kernel 0.2.3+: the pin is an A/B experiment. */
	experiment?: boolean;
}

/** Kernel 0.2.3+: an A/B experiment pin on this server (see devtools/ab.ts). */
export interface ExperimentInfo {
	readonly artifactId: string;
	readonly assetId: number;
	/** User id of the owner or admin who started it (from this server or a TypeTorch/pin message). */
	readonly by?: number;
	/** os.time() when it started. */
	readonly since: number;
}

/** Kernel 0.2.3+: options of `pinArtifact`. */
export interface PinOptions {
	/**
	 * An A/B experiment (owner/admin only): any known artifact, any channel, public servers too (they stay "prod").
	 * Never stored; holds until the next deploy of the branch, `unpin`, or the server closing.
	 */
	experiment?: boolean;
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
	/** Kernel 0.2.3+: the deploy went to this percent of servers only (`ro`). */
	rollout?: number;
	/** Kernel 0.3+: its signatures, each checked on its own; absent for unsigned (dev) deploys. */
	verified?: Verified;
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
	/** Kernel 0.2.3+: set while this server runs an A/B experiment pin. */
	experiment?: ExperimentInfo;
	/** Kernel 0.2.3+: this server's bucket (0-99) for rollouts and random pins (it takes `ro`/`pct` above it). */
	rolloutBucket?: number;
	/** Kernel 0.2.3+: the last TypeTorch/pin message this server acted on. */
	lastPin?: { assetId?: number; unpin?: boolean; by: number; pct?: number; listed: boolean; receivedMs: number; sentMs: number; ok?: boolean; error?: string };
	/** Kernel 0.3+: the kernel build (short commit, "*" = dirty) and content hash stamped by `typetorch kernel deploy`. */
	kernelBuild?: string;
	kernelHash?: string;
	/** Kernel 0.3+: this server takes only signed prod artifacts (public, or a private server on a prod branch). */
	signedOnly?: boolean;
	/** Kernel 0.3+: the trust state, in short. */
	signing?: SigningSummary;
	/** Kernel 0.3+: refused messages and heads since boot. */
	rejected?: Rejections;
	/**
	 * Kernel 0.3+: a signed-only server with no trusted head for its branch (no verified head, no BootstrapHeads entry).
	 * It runs nothing new until a signed deploy arrives; it keeps polling and re-reading the keys.
	 */
	noTrustedHead?: boolean;
	/**
	 * Kernel 0.3+ boot fail-safe: no verified head loaded at boot, so this server booted an UNVERIFIED stored head (still
	 * prod channel, modules only). Updates stay strictly verified; the next signed deploy replaces or vouches for it.
	 */
	unverified?: boolean;
	/**
	 * Kernel 0.3.1+, Studio only: the running generation is the local payload (a clone of
	 * ServerStorage.TypeTorchDev.Payload, synced by the template's studio.project.json) instead of an uploaded artifact.
	 */
	localPayload?: boolean;
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
	 * studio servers; on public servers only owner/admin and only prod-channel artifacts. Kernel 0.2.3+:
	 * `{ experiment: true }` (owner/admin) allows any channel on public servers too (older kernels ignore options).
	 */
	pinArtifact?(player: Player, assetId: number, options?: PinOptions): SwapReport;

	// Kernel 0.2.2+ (additive, same kernelApi). Game code uses them through `TypeTorch` (src/typetorch.ts).
	/** How this generation started. The kernel's own table: it sets `swapSeconds` once the swap finished. */
	readonly start?: GenerationStart;
	/** Whether this generation is pinned now. */
	pinned?(): boolean;
	/** One handler per generation (the framework installs it): a swap is coming, or was called off. */
	onPending?(handler: (update: PendingUpdate) => void): void;
	/** One handler per generation: a player's dev decision changed after the first one. */
	onDevChanged?(handler: (player: Player, info: DevInfo) => void): void;
	/** Reload this server to its branch head; the owner or admins only (checked by the kernel). */
	requestReload?(player: Player): SwapReport;

	// Kernel 0.2.3+ (additive): A/B experiments. `experiment` doubles as the feature test (devtools/ab.ts).
	/** The running experiment pin, if any. */
	experiment?(): ExperimentInfo | undefined;
	/** End this server's experiment (back to its branch head). Owner/admin on public servers, devs elsewhere. */
	unpin?(player: Player): SwapReport;

	// Kernel 0.3+ (additive): signed prod deploys. `keys` doubles as the feature test.
	/** The kernel build (short commit) stamped by `typetorch kernel deploy`, if any. */
	readonly kernelBuild?: string;
	/** The trust state (key asset, keys, fallback key, last change, refusals). Devs only: check the asking player. */
	keys?(): KeyTrust;
}

export interface ClientKernel {
	readonly kernelApi: number;
	readonly kernelVersion: string;
	/** Kernel 0.2.2+ fills every field from the client tree; older kernels only `id`. */
	readonly artifact: ArtifactInfo;
	readonly generation: number;
	readonly branch?: string;
	readonly channel?: Channel;
	/** Kernel 0.2.2+. */
	readonly serverType?: ServerType;
	/** Kernel 0.2.2+: how this client generation started (a player's first one is kind "boot", reason "boot"). */
	readonly start?: GenerationStart;

	persist<T extends object>(key: string, init: () => T): T;
	onMessage(handler: (channel: string, ...args: unknown[]) => void): void;
	send(channel: string, ...args: unknown[]): void;
	sendUnreliable(channel: string, ...args: unknown[]): void;
	/** What the server last said about this player (cosmetic; the server re-checks every request). */
	devStatus(): DevInfo;
	/** Kernel events such as "dev-open" (from `/tt dev`). Returns a disconnect function. */
	onKernelEvent(handler: (name: string) => void): () => void;
	logs(since?: number, limit?: number): LogEntry[];

	// Kernel 0.2.2+ (additive): feature-detect.
	pinned?(): boolean;
	/** One handler per generation: the server says a swap is coming, or called it off. */
	onPending?(handler: (update: PendingUpdate) => void): void;
	/** One handler per generation: the server's decision about this player changed. */
	onDevChanged?(handler: (info: DevInfo) => void): void;
}

export type Kernel = ServerKernel | ClientKernel;
