/**
 * TypeScript view of the objects the TypeTorch kernel hands a generation (`Server.boot.boot(kernel)` /
 * `Client.boot.boot(kernel)`). The kernel side is Luau: kernel/src/server/Api.luau and kernel/src/shared/ClientApi.luau.
 * Keep both in sync; breaking changes bump the kernel API (`kernelApi`).
 */

export type Channel = "prod" | "dev";
export type ServerType = "public" | "private" | "reserved" | "studio";

/**
 * Kernel 0.3.9 separates two things a server used to report as one "channel":
 * - the CHANNEL, what the branch is: "prod" for the signed settings' default branch or a branch the settings configure
 *   prod, "dev" for every other branch (shown in the dev menu, /tt status, heartbeats, analytics);
 * - the RULES the server enforces: "prod" on every public server and on servers whose branch or build is prod-channel
 *   (read-only devtools for non-owners, signed deploys, owner-only rollbacks).
 * The kernel API's `channel` stays the RULES (older frameworks gate their devtools on it); 0.3.9 adds `rules` and
 * `branchChannel`. Kernel status objects (`status()`, fleet rows) report the channel as `channel` and the rules as
 * `rules`. These two helpers read either shape, on any kernel (before 0.3.9 both are the old effective channel).
 */
export function branchChannelOf(source: { readonly channel?: Channel; readonly branchChannel?: Channel }): Channel | undefined {
	return source.branchChannel ?? source.channel;
}

/** The rules a server enforces ("prod": read-only devtools for non-owners); see `branchChannelOf`. */
export function rulesOf(source: { readonly channel?: Channel; readonly rules?: Channel }): Channel | undefined {
	return source.rules ?? source.channel;
}

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
	/**
	 * Kernel 0.3.2+: the payload's network protocol hash (attribute `ProtocolHash`, stamped at build time), if any.
	 * Client events of an older artifact with the same hash still reach this generation during a swap.
	 */
	readonly protocolHash?: string;
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

/** Kernel 0.3.4: two roles. Owners: the experience creator, the owning group's owner, members with role "owner". */
export type Role = "owner" | "dev";

/**
 * A kernel's role as the framework uses it. There is no "admin" role (kernel 0.3.4): an older kernel's "admin", or any
 * other member role, counts as "dev" (least privilege).
 */
export function normalRole(role: unknown): Role | undefined {
	if (role === "owner") return "owner";
	return typeIs(role, "string") ? "dev" : undefined;
}

/**
 * A player's role as the kernel decides it now (server): undefined unless a dev. Manage (admin-server.ts) and Claude
 * (claude-access.ts) ask through this one check; a failing devInfo counts as no role.
 */
export function devRoleOf(kernel: { devInfo(player: Player): DevInfo }, player: Player): Role | undefined {
	const [ok, info] = pcall(() => kernel.devInfo(player));
	if (!ok || !typeIs(info, "table") || info.dev !== true) return undefined;
	return normalRole(info.role);
}

export interface DevInfo {
	dev: boolean;
	/** Why: "studio", "owner", "member", "badge", "revoked", "none". */
	reason: string;
	/** Older kernels may say "admin": read it through `normalRole`. */
	role?: Role;
	/** The server's RULES (read-only devtools on "prod"); see `rulesOf`. */
	channel?: Channel;
	/** Kernel 0.3.9: what the branch is; see `branchChannelOf`. */
	branchChannel?: Channel;
}

/** Kernel 0.3.4+: the last branch switch or build load on this server (`status().switched`). */
export interface SwitchInfo {
	/** Who (user id, name) and when (unix seconds). */
	by?: number;
	name: string;
	at: number;
	/** The branch it switched to (a build load: this server's branch) and, for a build load, the build. */
	branch: string;
	artifact?: string;
}

/** Kernel 0.3.4+: what `requestSwitch` asks for: a branch, or a known build to load here. */
export type SwitchRequest = { branch: string } | { assetId: number };

export interface SwitchReply {
	ok: boolean;
	error?: string;
	/** The generation now running (the switch replaces this client generation too, so it may never be seen). */
	generation?: string;
	queued?: boolean;
}

/**
 * Why a generation started (or the next one will):
 * - `boot`: the first generation of this server (or, on a client, of this player's session);
 * - `deploy`: its branch got a new deploy (a deploy message, or the poll or registry catching up);
 * - `rollback`: its branch was rolled back (`typetorch rollback`);
 * - `branch`: this server switched branch (dev menu, `/tt branch`);
 * - `pin`: this server was pinned to a known artifact;
 * - `reload`: a dev or the owner reloaded the branch head;
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
	/** Server only: user id of the dev or owner who asked (reload, branch, pin, server rollback). */
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
	/** User id of the owner who started it (from this server or a TypeTorch/pin message). */
	readonly by?: number;
	/** os.time() when it started. */
	readonly since: number;
}

/** Kernel 0.2.3+: options of `pinArtifact`. */
export interface PinOptions {
	/**
	 * An A/B experiment (owner only): any known artifact, any channel, public servers too (they stay "prod").
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
	/** The head artifact's channel when the settings don't configure the branch (a promoted prod build: "prod"). */
	channel: Channel;
	/** Kernel 0.5.2: what the branch is ("prod": the default branch or one configured prod; else "dev"). */
	branchChannel?: Channel;
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

/**
 * Kernel 0.3.2+: the running generation's health ("ok" | "failed": nothing runs | "unverified" | "degraded"). Kernel
 * 0.3.6: "backup" (the backup build baked into the place runs: nothing else could).
 */
export type HealthState = "ok" | "failed" | "unverified" | "degraded" | "backup";

/** Kernel 0.3.2+ `status().health` (plans/12 P-F1: the health window). */
export interface HealthInfo {
	state: HealthState;
	/** Errors from the running generation's own scripts since it started. */
	errors: number;
	lastError?: string;
	lastErrorAt?: number;
	/** A failed onStart the framework reported (it rolls back inside the window). */
	startFailed?: string;
	/** Why this generation failed its health check (it is being, or couldn't be, rolled back). */
	failed?: string;
	/** Seconds of the health window left (`window` s from ready; 30 s before kernel 0.3.7). */
	windowLeft?: number;
	/** The last health-window rollback on this server: from, to (the last known good it ran), why, unix seconds. */
	lastRollback?: { from: string; to?: string; why: string; at: number };
	/**
	 * Kernel 0.3.7+: the running build's thresholds (typetorch.json "health", stamped on the payload as HealthErrors,
	 * HealthWindow, HealthRollback). Older kernels: undefined (3 errors, 30 s, rollback on).
	 */
	limit?: number;
	/** Kernel 0.3.7+: the window's length in seconds after ready. */
	window?: number;
	/** Kernel 0.3.7+: whether a failed check rolls back here (false: the build turned it off, a Studio local payload,
	 * or a build restarted after nothing else could run). */
	rollback?: boolean;
	/** Kernel 0.3.7+: "payload" (the build carries settings) or "default". */
	source?: "payload" | "default";
	/** Kernel 0.3.7+: payload values that were out of bounds or of the wrong type (the defaults were used). */
	invalid?: string[];
	/** Kernel 0.3.7+: why the build failed its check while its rollback is off (it keeps running, degraded). */
	kept?: string;
	/** Kernel 0.3.7+: the place doesn't map the kernel's Health module (no health window on this server). */
	missing?: boolean;
}

/** Kernel 0.3.2+: an artifact that failed on this server (start, mount or the health window); never run again
 * automatically here (a dev's reload or pin still may). */
export interface FailedArtifact {
	assetId: number;
	artifactId?: string;
	seq?: number;
	why: string;
	at: number;
}

/**
 * Kernel 0.3.2+ `fleetStatus()`: this server's heartbeat (plans/01 "Fleet status and deploy reports"). The kernel
 * writes it nowhere; the analytics engine sends it, the Manage > Servers roll call answers with it, and with the
 * settings' `fleet` (kernel 0.3.8; the `TypeTorchFleet` key before) the kernel posts it to the fleet API itself
 * (without `k`).
 */
export interface FleetStatus {
	/** Server type. */
	t: ServerType;
	/** Branch. */
	b?: string;
	/** The branch's channel (kernel 0.3.9; before: the effective channel, i.e. the rules). No generation: absent. */
	c?: Channel;
	/** Artifact id (no generation: absent). */
	a?: string;
	/** Players, max players. */
	n: number;
	m: number;
	/** Server start, now (unix seconds). */
	s: number;
	u: number;
	/** Place id. */
	p: number;
	/** A reserved server's access code: server-only, never send it to a client. */
	k?: string;
	/** 1 during an A/B experiment. */
	x?: number;
	/** Kernel version. */
	v: string;
	/** Applied deploy seq. */
	q: number;
	/** Generation number (0: none). */
	g: number;
	h: HealthState;
	/** The last error (<= 200 bytes), while recent or unhealthy. */
	e?: string;
	sv: 2;
	/** Kernel 0.3.6: the backup build baked into the place runs (`h` is "backup" too). */
	backup?: boolean;
	/** Kernel 0.3.6: clients whose generation failed after their retry (only once something happened). */
	clients?: { resent: number; moved: number };
}

/** Kernel 0.3.2+: one deploy outcome on one server (`onDeployReport`). */
export interface DeployReport {
	/** Seq, branch, artifact id, JobId. */
	s: number;
	b: string;
	a: string;
	j: string;
	r: "swapped" | "failed" | "rolled_back" | "skipped" | "booted";
	/** Error (<= 300 bytes). */
	e?: string;
	/** Seconds the swap took. */
	d?: number;
	/** Unix seconds, generation number, kernel version, players. */
	t: number;
	g: number;
	k: string;
	p: number;
}

/** Kernel 0.3.2+ `status().fleet`: the kernel's own fleet API sender (never the token). */
export interface FleetSenderInfo {
	enabled: boolean;
	/** "unknown" (not read yet), "absent", "ok", "invalid"; absent: the place doesn't map the kernel's Fleet module. */
	settings?: "unknown" | "absent" | "ok" | "invalid";
	settingsError?: string;
	missing?: boolean;
	host?: string;
	queued?: number;
	sent?: number;
	failed?: number;
	dropped?: number;
	alerts?: number;
	lastOkAt?: number;
	lastError?: string;
	lastErrorAt?: number;
	lastStatus?: number;
	/** Kernel 0.3.9: failed requests in a row (0 once one works). */
	failures?: number;
	/** Kernel 0.3.9: seconds until the next try while the sender backs off (or holds off after a 401/403/404). */
	retryIn?: number;
	/** Kernel 0.4.0: the settings field the URL and key came from: "backend" (plans/21) or the old "fleet". */
	source?: "backend" | "fleet";
}

/**
 * Kernel 0.4.0 `status().errors`: the error reports (problem 19). Templates only (players' names, display names and
 * UserIds already replaced); never the key.
 */
export interface ErrorReportsStatus {
	/** Posting (a live server with backend settings). Studio counts without posting. */
	enabled: boolean;
	/** The place doesn't map the kernel's Errors module. */
	missing?: boolean;
	host?: string;
	/** Error kinds held (template + first stack). */
	kinds?: number;
	/** Per-minute items waiting to be posted. */
	waiting?: number;
	/** Errors seen since boot (each occurrence). */
	seen?: { server: number; client: number };
	/** Items the backend accepted. */
	sent?: number;
	requests?: number;
	failed?: number;
	/** Items the backend refused. */
	rejected?: number;
	dropped?: { kinds: number; items: number; rate: number; old: number; client: number };
	failures?: number;
	retryIn?: number;
	lastOkAt?: number;
	lastError?: string;
	lastErrorAt?: number;
	lastStatus?: number;
	/** The busiest kinds since boot. */
	top?: { fp: string; template: string; total: number; realm: "server" | "client" }[];
}

/** Who made a request, for the budget view (kernel 0.4.0). */
export type BudgetCaller = "kernel" | "devtools" | "analytics" | "game" | "framework";
export type BudgetKind = "datastore" | "memorystore" | "http" | "messaging";

/**
 * Kernel 0.4.0 `status().budget` and the fleet heartbeat's `bu`: requests in the last 60 s (rounded) next to Roblox's
 * limits for the player count. `ds` DataStore (r read, w write, l list, x remove, lr / lw limits, br / bw the server's
 * budget left, shared with the game), `ms` MemoryStore units (l = this server's players' part of the experience
 * quota), `h` HTTP, `mg` MessagingService (p publish, s subscribe requests), `by` per caller (k kernel, d devtools,
 * a analytics, g game, f framework), `mem` MB (t total, h LuaHeap).
 */
export interface BudgetSummary {
	p: number;
	ds: { r: number; w: number; l: number; x: number; lr: number; lw: number; br?: number; bw?: number };
	ms: { u: number; l: number };
	h: { r: number; l: number };
	mg: { p: number; lp: number; s: number; ls: number };
	by: Partial<Record<"k" | "d" | "a" | "g" | "f", number>>;
	mem: { t?: number; h?: number };
}

/**
 * Kernel 0.4.2 `status().perf`: server TPS (RunService.Heartbeat frames a second) over the last minute: `a` the average,
 * `m` the slowest whole second, `p` the physics FPS (workspace:GetRealPhysicsFPS(); missing when unreadable), `s` the
 * seconds counted (up to 60). Absent before the first whole second. Fleet heartbeats carry `{ a, m, p }` as `pf`, over
 * the time since the previous heartbeat. Memory is in `budget.mem` (and `memoryMb`).
 */
export interface PerfSummary {
	a: number;
	m: number;
	p?: number;
	s: number;
}

/** One bar of the budget view: TypeTorch's requests in the last 60 s, the limit, and (DataStore) the budget left. */
export interface BudgetRow {
	name: string;
	used: number;
	limit: number;
	left?: number;
}

/** Kernel 0.4.0 `api:budget()`: the dev menu's Server > Budget. */
export interface BudgetSnapshot {
	missing?: boolean;
	players: number;
	window: number;
	kinds: Record<BudgetKind, { rows: BudgetRow[]; callers: Partial<Record<BudgetCaller, number>> }>;
	/** Busiest first. */
	detail: { caller: BudgetCaller; kind: BudgetKind; op: string; perMinute: number; total: number }[];
	memory: { total?: number; luaHeap?: number; heapKb: number; tags?: { name: string; mb: number }[] };
	/** The mounted server generations (old ones stay a moment after a swap). */
	generations: { name: string; modules: number; running: boolean }[];
	/** Counts that found no free counter (counted as "other"). */
	refused: number;
}

/** Kernel 0.3.2+ `status().clients`: what clients reported about their generation start (P-K7). */
export interface ClientsSummary {
	players: number;
	reported: number;
	ok: number;
	failed: number;
	/** Reported another generation than the running one. */
	behind: number;
	/** Failed reports since boot. */
	failures: number;
	lastFailure?: { userId: number; generation: string; error?: string; at: number };
	/** Kernel 0.3.6: clients the kernel re-sent the client code to (after their own retry failed), and moved away. */
	resent?: number;
	moved?: number;
}

/**
 * Kernel 0.3.6 ("never an empty server", plans/01): the hold (no character spawns until a generation is ready), the
 * fallbacks when the head and the last known good run nothing (a build other servers run fine, the backup baked into
 * the place, background retries) and the moves (players go to another server when nothing runs).
 */
export interface FallbackStatus {
	/**
	 * Kernel 0.3.8: `bootScreen` / `kernelScreen` are the game's loading screen settings the clients got (ReplicatedFirst
	 * TypeTorchBootScreen / TypeTorchKernelScreen, or the kernel folder's BootScreen / KernelScreen).
	 */
	hold: { active: boolean; mode?: "start" | "move"; optOut?: boolean; characters?: boolean; heldMs?: number; seconds?: number; released?: number; spawned: number; bootScreen?: string; kernelScreen?: false };
	backup: { available: boolean; artifactId?: string; seq?: number; branch?: string; at?: string; failed?: { error?: string; stage?: string; at: number }; runs: number; since?: number };
	peers: { asks: number; answered: number; replies: number; lastAt?: number; refused: number; chosen?: { artifactId?: string; assetId: number; seq?: number; servers: number; at: number }; error?: string };
	chain: { runs: number; result?: "peers" | "backup" | "other" | "nothing"; why?: string; at?: number };
	recovery: { running: boolean; attempts: number; nextIn?: number; last?: { ok: boolean; artifactId?: string; error?: string; at: number } };
	moving: { active: boolean; since?: number; teleported: number; kicked: number; failures: number; lastError?: string; target?: string };
	clients: { resent: number; moved: number };
}

/** Kernel 0.3.2+: a failed lifecycle hook the framework reports (`reportError`). */
export interface ReportedError {
	/** "onStart" (a health failure: rolls back inside the window) or another hook (counts as one error). */
	kind: string;
	module: string;
	message: string;
}

export interface KernelStatus {
	jobId: string;
	placeId: number;
	placeVersion: number;
	serverType: ServerType;
	branch: string;
	/** What the branch is (kernel 0.3.9; before: the effective channel, i.e. the rules); see `branchChannelOf`. */
	channel?: Channel;
	/** Kernel 0.3.9: the rules this server enforces; see `rulesOf`. */
	rules?: Channel;
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
	/** Kernel 0.3.2+: the running generation's health window and errors. */
	health?: HealthInfo;
	/** Kernel 0.3.2+: artifacts that failed on this server, newest first. */
	failed?: FailedArtifact[];
	/** Kernel 0.3.2+: deploy reports given out (`deployReports()` has the last 20). */
	reports?: { total: number; kept: number; listeners: number };
	/** Kernel 0.3.2+: the kernel's own fleet API sender (the settings' `fleet`; the `TypeTorchFleet` key before 0.3.8). */
	fleet?: FleetSenderInfo;
	/** Kernel 0.3.4+: the last branch switch or build load here ("switched by <name> 3m ago"). */
	switched?: SwitchInfo;
	/** Kernel 0.3.2+: client generation reports. */
	clients?: ClientsSummary;
	/**
	 * Kernel 0.3.6: the backup build baked into the place (ServerStorage.TypeTorchBackup) runs: the head, the last known
	 * good and the branch's other servers had nothing that ran here. The kernel retries the real build in the background.
	 */
	backup?: boolean;
	/** Kernel 0.3.6: the hold, peers, backup, recovery and moves. */
	fallback?: FallbackStatus;
	/** Kernel 0.3.8: game messaging on the kernel-held topic, and the held roll call topic (`TypeTorch.messaging`). */
	messaging?: MessagingStatus;
	/** Kernel 0.3.8 (plans/20): the signed settings record (no values: it holds tokens). */
	settings?: SettingsStatus;
	/** Kernel 0.3.8: detached jobs (`TypeTorch.runDetached`). */
	detached?: DetachedStatus;
	/** Kernel 0.4.0: the error reports (templates only). */
	errors?: ErrorReportsStatus;
	/** Kernel 0.4.0: the budget summary (the heartbeat's `bu`); the full view is `budget()`. */
	budget?: BudgetSummary;
	/** Kernel 0.4.2: server TPS over the last minute (average, slowest second, physics FPS). */
	perf?: PerfSummary;
	/** Kernel 0.5.0 (plans/25): remote debug's counters. */
	remoteDebug?: RemoteDebugStatus;
}

/** Kernel 0.3.8: detached jobs on this server (`runDetached`): counters since boot and the running ones. */
export interface DetachedStatus {
	running: number;
	started: number;
	finished: number;
	failed: number;
	/** Jobs that ran past 60 s (each logged once). */
	slow: number;
	/** The most that may run at once (256). */
	max: number;
	/** Seconds the longest running job has run. */
	oldest?: number;
	lastError?: { generation: string; error: string; at: number };
}

/**
 * Kernel 0.3.8 (plans/20): the signed settings record's state. "ok": a verified copy is held; "missing": no record (the
 * defaults); "unsigned" / "invalid": the stored copy was refused and none was held before; "error": the read failed and
 * none is held; "unknown": not read yet. A copy refused while a good one is held shows in `refused`.
 */
export interface SettingsStatus {
	state: "ok" | "missing" | "unsigned" | "invalid" | "error" | "unknown";
	seq?: number;
	/** ISO time of the write. */
	at?: string;
	/** Seconds since `at`. */
	age?: number;
	/** Which signature verified it: the main key's `sig`, or the fallback key's `sigF`. */
	verifiedBy?: "sig" | "sigF";
	/** The fields present: defaultBranch, channels, access, fleet, analytics, game. */
	fields: string[];
	reads: number;
	error?: string;
	errorAt?: number;
	/** The last copy refused while a good one is held (unix seconds `at`). */
	refused?: { why: string; seq?: number; at: number };
}

/**
 * Kernel 0.3.8 (plans/20): a copy of the verified settings (`api:settings()`). SERVER ONLY: `fleet.token` and
 * `analytics.token` are secrets; never send any of it to a client.
 */
export interface KernelSettings {
	seq: number;
	at: string;
	defaultBranch?: string;
	channels?: Record<string, Channel>;
	access?: { members?: Record<string, string>; revoked?: Record<string, boolean>; devBadgeId?: number };
	/**
	 * Kernel 0.4.0 / CLI 0.9 (plans/21): ONE backend and one key: heartbeats to <url>/v1/fleet/*, events to <url>/v1/ingest,
	 * error reports to <url>/v1/errors. Replaces `fleet` and `analytics` (both still read while it is missing).
	 */
	backend?: { url: string; key: string; analytics?: { flushSeconds?: number; recordShare?: number; techEvery?: number; experiments?: unknown } };
	/** The old fleet settings (before `backend`). */
	fleet?: { url: string; token: string };
	/** The old analytics sink settings (before `backend`; still the way to a Basin sink). */
	analytics?: unknown;
	/** The game's own live values (`typetorch settings set game.<key> <json>`; `TypeTorch.liveConfig`). */
	game?: Record<string, unknown>;
}

/**
 * Kernel 0.3.8: who sent a game message (`TypeTorch.messaging.subscribe`). The sender's kernel writes these tags; any
 * code that can publish to the universe's MessagingService could forge them, so they are for routing (ignore dev
 * servers), not authentication.
 */
export interface GameMessageMeta {
	/** The sender's channel: kernel 0.3.9+ what its branch is; older kernels the effective channel ("prod" on public servers). */
	readonly channel: Channel;
	/** The sender's branch. */
	readonly branch?: string;
	/** The sender's JobId ("" in Studio). */
	readonly jobId: string;
	readonly serverType: ServerType;
	readonly placeVersion?: number;
	/** Unix seconds when it was sent (Roblox's `Sent`). */
	readonly sentAt: number;
	/** This server sent it (every server hears its own messages, like MessagingService). */
	readonly self: boolean;
	/** It arrived while this generation was starting, and was kept for it (the swap didn't lose it). */
	readonly replayed?: boolean;
}

/** Kernel 0.3.8: who a game message is for. "all" (default), "prod" (prod-channel servers), "branch" (the sender's). */
export type MessageTarget = "all" | "prod" | "branch";

export interface MessagingPublishOptions {
	to?: MessageTarget;
}

/** Kernel 0.3.8: `messagingPublish`'s answer. It never yields: `queued` means it goes out in order, within the budget. */
export interface MessagingPublishReport {
	ok: boolean;
	queued?: boolean;
	/** Studio: delivered to this session only (Studio never reaches live servers). */
	loopback?: boolean;
	/** Bytes on the wire (the envelope, counted JSON-escaped). */
	size?: number;
	error?: "bad_topic" | "bad_options" | "bad_data" | "too_big" | "queue_full" | "closing" | "stopping";
	detail?: string;
	limit?: number;
	/** The envelope's own bytes (what is left for data: limit - overhead). */
	overhead?: number;
}

/** Kernel 0.3.8 `status().messaging` / `messagingStatus()`. */
export interface MessagingStatus {
	/** The Roblox topic every game topic rides ("TypeTorch/game"). */
	topic: string;
	/** "off" (no listener yet), "subscribing", "on", "local" (Studio: this session only). */
	state: "off" | "subscribing" | "on" | "local";
	subscribedAt?: number;
	/** Game topics and listeners of the running generation. */
	topics: number;
	listeners: number;
	received: number;
	delivered: number;
	/** Not a valid envelope. */
	ignored: number;
	/** `to` excluded this server. */
	filtered: number;
	/** Kept during a swap and handed to the next generation. */
	replayed: number;
	held: number;
	published: number;
	/** Failed PublishAsync attempts (each retry counts). */
	failed: number;
	/** Given up: retries out, waited too long, queue full. */
	dropped: number;
	/** Publishes that waited because the universe's rate on the topic was at the soft limit. */
	throttled: number;
	queued: number;
	/** Messages on the game topic in the last 60 s, from every server (each server sees every one). */
	rate: number;
	/** At this rate publishes wait (Roblox delivers about 80 a minute on one topic for the whole universe). */
	softLimit: number;
	/** This server's publishes a minute (150 + 60 x players). */
	budget: number;
	lastError?: string;
	lastErrorAt?: number;
	rollCall: { state: "off" | "subscribing" | "on" | "local"; asks: number; handled: number };
}

/** Kernel 0.5.0 (plans/25): who asked for a remote debug op. Always an owner (the kernel refuses everyone else). */
export interface RemoteDebugCaller {
	/** "roblox": an owner signed in to the explorer with Roblox; "token": the backend's admin token (an owner by decision). */
	kind: "roblox" | "token";
	userId?: number;
	owner: true;
	via: "roblox" | "admin token";
}

/** Kernel 0.5.0: `status().remoteDebug` (counters; never a command's contents, the URL or the key). */
export interface RemoteDebugStatus {
	state: "off" | "polling" | "held";
	missing?: boolean;
	sessions?: number;
	polls?: number;
	commands?: number;
	answered?: number;
	refused?: number;
	failed?: number;
	timeouts?: number;
	redacted?: number;
	lastPollAt?: number;
	lastCommandAt?: number;
	lastOp?: string;
	lastError?: string;
	lastErrorAt?: number;
}

export interface ServerKernel {
	readonly kernelApi: number;
	readonly kernelVersion: string;
	readonly artifact: ArtifactInfo;
	readonly generation: number;
	readonly branch: string;
	/**
	 * The RULES this server enforces: the strictest of branch, artifact and server type (public servers are always
	 * "prod"). The name predates kernel 0.3.9's split; read `rules` / `branchChannel` through `rulesOf` /
	 * `branchChannelOf`.
	 */
	readonly channel: Channel;
	/** Kernel 0.3.9: the rules, by name (same as `channel`). */
	readonly rules?: Channel;
	/** Kernel 0.3.9: what the branch is ("prod": the default branch or one configured prod; else "dev"). */
	readonly branchChannel?: Channel;
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
	 * studio servers; on public servers only the owner and only prod-channel artifacts. Kernel 0.2.3+:
	 * `{ experiment: true }` (owner) allows any channel on public servers too (older kernels ignore options).
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
	/** Reload this server to its branch head; the owner only (checked by the kernel). */
	requestReload?(player: Player): SwapReport;

	// Kernel 0.2.3+ (additive): A/B experiments. `experiment` doubles as the feature test (devtools/ab.ts).
	/** The running experiment pin, if any. */
	experiment?(): ExperimentInfo | undefined;
	/** End this server's experiment (back to its branch head). The owner on public servers, devs elsewhere. */
	unpin?(player: Player): SwapReport;

	// Kernel 0.3+ (additive): signed prod deploys. `keys` doubles as the feature test.
	/** The kernel build (short commit) stamped by `typetorch kernel deploy`, if any. */
	readonly kernelBuild?: string;
	/** The trust state (key asset, keys, fallback key, last change, refusals). Devs only: check the asking player. */
	keys?(): KeyTrust;

	// Kernel 0.3.2+ (additive): bad deploys are safe. `reportError` doubles as the feature test.
	/**
	 * Reports a failed lifecycle hook of this generation. A failed onStart within 30 s of ready rolls the server back to
	 * its last known good artifact; other kinds count as one error (3 within the window also roll back). The kernel
	 * prints it as an error line. Returns false once this generation is stopping.
	 */
	reportError?(info: ReportedError): boolean;
	/** One handler per generation, run from the kernel's BindToClose (server shutdown), for at most 20 s. */
	onClose?(handler: () => void): void;
	/** This server's fleet status (cheap, no yield). `fleetStatus` doubles as the 0.3.2 fleet feature test. */
	fleetStatus?(): FleetStatus;
	/**
	 * fn(report) once per deploy outcome on this server; the last 20 are replayed at once (the boot report comes before
	 * any generation can listen). Each call runs on a kernel thread; the listener goes when this generation stops.
	 * Returns a disconnect function.
	 */
	onDeployReport?(handler: (report: DeployReport) => void): () => void;
	/** The last 20 deploy reports, oldest first. */
	deployReports?(): DeployReport[];
	/** A reserved server's own access code (server-only data: never send it to a client). */
	accessCode?(): string | undefined;

	// Kernel 0.3.8 (additive): game messaging and the held roll call topic. `messagingPublish` doubles as the feature
	// test; a place that doesn't map the kernel's Messaging module has none of them. Game code uses `TypeTorch.messaging`.
	/**
	 * fn(data, meta) for every message on game topic `topic` while this generation runs (dropped when it stops; the
	 * kernel's one subscription stays). Each call runs on a kernel thread. Errors on a bad topic. Returns a disconnect.
	 */
	messagingSubscribe?(topic: string, handler: (data: unknown, meta: GameMessageMeta) => void): () => void;
	/** One message to every server's listeners of `topic`, this one's too. Doesn't yield. */
	messagingPublish?(topic: string, data: unknown, options?: MessagingPublishOptions): MessagingPublishReport;
	messagingStatus?(): MessagingStatus;
	/** fn(data) for every roll call ask on `TypeTorch/rollcall` while this generation runs (one per generation). */
	onRollCall?(handler: (data: unknown) => void): void;

	// Kernel 0.3.8 (additive): the signed settings record (plans/20). `settings` doubles as the feature test.
	/** A copy of the verified settings, or undefined (none held yet). Server only: it holds tokens. */
	settings?(): KernelSettings | undefined;
	settingsStatus?(): SettingsStatus;
	/** One handler per generation: a fresh copy after every new good copy (the framework installs it and fans out). */
	onSettingsChanged?(handler: (settings: KernelSettings | undefined) => void): void;

	/**
	 * Kernel 0.3.8 (additive): runs fn() on a kernel thread that this generation's stop (and hard stop) can't kill.
	 * done(ok, result) runs on a kernel thread, only while this generation runs. Throws past 256 running jobs. Returns
	 * the job's id.
	 */
	runDetached?(fn: () => unknown, done?: (ok: boolean, result: unknown) => void): number;

	/**
	 * Kernel 0.4.0 (additive; plans/21 C): the analytics engine tells the kernel each player's pid, so the kernel's error
	 * reports count affected players without names or UserIds. Returns whether it was taken.
	 */
	setAnalyticsId?(player: Player, pid: string): boolean;
	/**
	 * Kernel 0.4.0: counts this caller's own DataStore / MemoryStore / HTTP / MessagingService requests for the budget
	 * view ("kernel" is refused: it counts as "game"). `op`: a category (read, write, list, remove, publish, subscribe) or
	 * a label (an HTTP target). Never throws.
	 */
	budgetCount?(caller: BudgetCaller, kind: BudgetKind, op: string, n?: number): void;
	/** Kernel 0.4.0: the full budget view (dev menu Server > Budget). Cheap, no yield. */
	budget?(): BudgetSnapshot;

	/**
	 * Kernel 0.5.0 (plans/25): remote debug. One handler per generation (the framework installs it with its devtools):
	 * the kernel calls it on a kernel thread for the explorer's read-only ops that need the generation (modules, state,
	 * assets, network, dex.children, dex.props), after checking its allow-list, the rate and that the caller is an owner;
	 * the answer is JSON-encoded and scrubbed of secrets by the kernel. `onRemoteDebug` doubles as the feature test.
	 */
	onRemoteDebug?(handler: (op: string, args: unknown, caller: RemoteDebugCaller) => unknown): void;

	/** `typetorch test --cloud`'s stub kernel: true (code that must not run in the gate checks it). */
	readonly test?: boolean;
}

export interface ClientKernel {
	readonly kernelApi: number;
	readonly kernelVersion: string;
	/** Kernel 0.2.2+ fills every field from the client tree; older kernels only `id`. */
	readonly artifact: ArtifactInfo;
	readonly generation: number;
	readonly branch?: string;
	/** The server's RULES (see ServerKernel.channel). */
	readonly channel?: Channel;
	/** Kernel 0.3.9: the rules by name, and what the branch is. */
	readonly rules?: Channel;
	readonly branchChannel?: Channel;
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

	// Kernel 0.3.2+ (additive).
	/** One handler per generation: the server dropped one of this generation's messages (it runs a newer protocol). */
	onResync?(handler: () => void): void;

	// Kernel 0.3.4+ (additive).
	/**
	 * Asks the server to switch THIS server to a branch or load a known build here, for this player. The kernel decides:
	 * on public servers, and for builds on servers that take only signed artifacts, only owners (an ordinary switch or
	 * pin; a public switch is never stored); elsewhere devs, as the dev menu's ops. Yields until it answers (up to 30 s).
	 * A switch replaces this client generation too, so the caller may not see the answer. The server has no API for the
	 * owner's way in: payload code can't do it on another player's behalf.
	 */
	requestSwitch?(request: SwitchRequest): SwitchReply;
}

export type Kernel = ServerKernel | ClientKernel;
