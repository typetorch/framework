import type { AssetFacts } from "../assets/manifest";
import type { DetachedStatus, HealthInfo, KernelStatus, SettingsStatus } from "../kernel";

/** The newest kernel this framework release knows about. Bump it with every kernel release. */
export const LATEST_KERNEL = "0.3.8";

/** Kernels before 0.3.7 use fixed thresholds: 3 errors within 30 s of ready roll back. */
const OLD_HEALTH_ERRORS = 3;
const OLD_HEALTH_WINDOW = 30;

/**
 * The live health window while it is open (kernel 0.3.7 thresholds; older kernels: 3): "1/3 errors, 24 s left", plus
 * ", no rollback" when a failure would only mark the server degraded. Undefined once the window closed.
 */
export function healthWindowText(health: HealthInfo): string | undefined {
	if (health.windowLeft === undefined) return undefined;
	const limit = health.limit ?? OLD_HEALTH_ERRORS;
	return `${health.errors}/${limit} errors, ${health.windowLeft} s left${health.rollback === false ? ", no rollback" : ""}`;
}

/** The running build's thresholds for the Status block: "3 errors / 30 s", or "3 errors / 30 s, no rollback". */
export function healthLimitsText(health: HealthInfo): string {
	const limit = health.limit ?? OLD_HEALTH_ERRORS;
	const seconds = health.window ?? OLD_HEALTH_WINDOW;
	return `${limit} errors / ${seconds} s${health.rollback === false ? ", no rollback" : ""}`;
}

/** The fleet API's last error as a short fix (the dev PC's `bun run local` restarts the server and its tunnel). */
export function fleetFix(lastError: string | undefined): string {
	if (lastError === undefined) return "-";
	if (lastError === "HTTP 530") return "HTTP 530: tunnel down. Run bun run local";
	if (lastError === "HTTP 502" || lastError === "HTTP 504") return `${lastError}: server down. Run bun run local`;
	if (lastError === "HTTP 401" || lastError === "HTTP 403") return `${lastError}: token mismatch. Run fleet setup`;
	if (lastError === "HTTP 404") return "HTTP 404: wrong URL. Run bun run local";
	if (lastError === "HTTP 429") return "HTTP 429: rate limited";
	return lastError;
}
/** The oldest kernel API this framework runs on. */
export const REQUIRED_KERNEL_API = 1;
/** The first kernel that writes the heartbeat and deploy reports itself. */
export const REPORTS_KERNEL = "0.3.2";
/** Auto-rollbacks newer than this (seconds) are reported. */
const RECENT_ROLLBACK = 15 * 60;
const HIGH_MEMORY_MB = 3000;

export type HealthLevel = "error" | "warn" | "info";

export interface HealthIssue {
	level: HealthLevel;
	title: string;
	detail: string;
	/** A fix the Status page offers next to the issue ("migrate": move everyone to a new server, admin-ui.ts). */
	action?: "migrate";
}

/** Facts only the server can check (devtools "status" op); missing on older frameworks. */
export interface ServerFacts {
	/** loadstring works (ServerScriptService.LoadStringEnabled); Claude's run_luau needs it. */
	loadstring?: boolean;
	/** HttpService.HttpEnabled; remote-claude needs it. */
	http?: boolean;
	/** The kernel has A/B experiment pins (0.2.3+, devtools/ab.ts). */
	experiments?: boolean;
	/** Hot assets (assets/sync.ts): failed loads and manifest problems; absent without a manifest. */
	assets?: AssetFacts;
}

/** "0.2.0" < "0.2.1"; missing parts count as 0, non-numbers as 0. */
export function versionLess(a: string, b: string): boolean {
	const left = a.split(".");
	const right = b.split(".");
	for (let index = 0; index < math.max(left.size(), right.size()); index++) {
		const x = tonumber(left[index]) ?? 0;
		const y = tonumber(right[index]) ?? 0;
		if (x !== y) return x < y;
	}
	return false;
}

/** Seconds since an ISO time (undefined: unparsable). */
export function secondsSince(iso: string): number | undefined {
	const [ok, time] = pcall(() => DateTime.fromIsoDate(iso));
	if (!ok || time === undefined) return undefined;
	return DateTime.now().UnixTimestamp - time.UnixTimestamp;
}

function clock(unix: number): string {
	return DateTime.fromUnixTimestamp(unix).FormatUniversalTime("MMM D HH:mm", "en-us") + " UTC";
}

/**
 * Kernel 0.3 signing (status().signing / rejected; nothing on older kernels). Shared with Artifact > Signing.
 * - a key change without a rekey hint before it: error (a rotation the user may not have done);
 * - booted an unverified prod head (the boot fail-safe), no trusted prod head, the fallback key revoked, or no trust
 *   root on a signed-only server: error;
 * - fallback-only mode (the key asset never loaded): warn; refusals: warn with the last reason;
 * - a key change after a rekey hint: info.
 */
export function signingIssues(status: KernelStatus): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	const signing = status.signing;
	if (signing === undefined) return issues;
	if (status.unverified === true) {
		// The boot fail-safe ran an unsigned stored head (the next signed deploy replaces or vouches for it).
		issues.push({ level: "error", title: "Booted an unverified prod head", detail: "No signed head at boot. Deploy prod signed." });
	} else if (status.noTrustedHead === true) {
		issues.push({ level: "error", title: "No trusted prod head", detail: "Waiting for a signed deploy." });
	}
	if (signing.lastChangeAt !== undefined) {
		if (signing.lastChangeHinted === true) {
			issues.push({ level: "info", title: "Keys rotated", detail: clock(signing.lastChangeAt) });
		} else {
			issues.push({ level: "error", title: "Keys changed", detail: `${clock(signing.lastChangeAt)}, no rekey hint. Rotated by you?` });
		}
	}
	if (signing.fallbackRevoked === true) {
		issues.push({ level: "error", title: "Fallback Key revoked", detail: "Replace it, then kernel deploy." });
	}
	if (signing.mode === "none" && status.signedOnly === true) {
		issues.push({ level: "error", title: "No signing keys", detail: "Prod refuses every deploy. Run keys init." });
	} else if (signing.mode === "fallback only") {
		issues.push({ level: "warn", title: "Fallback Key only", detail: "The Root Key asset never loaded here." });
	}
	const rejected = status.rejected;
	if (rejected !== undefined && rejected.total > 0) {
		issues.push({ level: "warn", title: `Rejected ${rejected.total}`, detail: rejected.last?.why ?? "-" });
	}
	return issues;
}

/**
 * Kernel 0.3.2 (plans/12 P-F1, P-O1, P-K7): the health window, the kernel's heartbeat and deploy reports, and client
 * generation reports.
 * - a health-window rollback in the last 15 min: error; errors after the window (degraded): warn;
 * - the live health window while it is open ("1/3 errors, 24 s left"): info, warn once an error counted; payload
 *   health settings out of bounds (kernel 0.3.7 used the defaults) or the kernel's Health module not mapped: warn;
 * - no deploy reports: info on kernels before 0.3.2 (live servers only); the kernel's own fleet API sender failing
 *   (the settings' `fleet`), invalid, or its module not mapped in the place: warn;
 * - clients whose generation failed to start: warn.
 */
export function deployIssues(status: KernelStatus): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	const health = status.health;
	const rollback = health?.lastRollback;
	const windowLine = health !== undefined ? healthWindowText(health) : undefined;
	if (rollback !== undefined && os.time() - rollback.at <= RECENT_ROLLBACK) {
		issues.push({ level: "error", title: "Failed health check", detail: `${rollback.from}: ${rollback.why}` });
	} else if (health?.state === "degraded" && health.errors > 0 && windowLine === undefined) {
		issues.push({ level: "warn", title: `Errors ${health.errors}`, detail: health.lastError ?? "-" });
	}
	// Kernel 0.3.7: the live window (the new build's own errors against its limit, the time left).
	if (health !== undefined && windowLine !== undefined) {
		issues.push({ level: health.errors > 0 ? "warn" : "info", title: "Health window", detail: windowLine });
	}
	if (health?.invalid !== undefined && health.invalid.size() > 0) {
		issues.push({ level: "warn", title: "Health settings", detail: `Defaults used: ${health.invalid[0]}` });
	}
	if (health?.missing === true) {
		issues.push({ level: "warn", title: "No health window", detail: "Map the kernel's Health module." });
	}
	if (status.reports === undefined) {
		if (status.serverType !== "studio" && versionLess(status.kernelVersion, REPORTS_KERNEL)) {
			issues.push({ level: "info", title: "No deploy reports", detail: `Needs kernel ${REPORTS_KERNEL}.` });
		}
	}
	const fleet = status.fleet;
	if (fleet?.missing === true) {
		issues.push({ level: "warn", title: "No fleet API", detail: "Map the kernel's Fleet module." });
	} else if (fleet?.settings === "invalid") {
		issues.push({ level: "warn", title: "Fleet settings", detail: fleet.settingsError ?? "settings.fleet is invalid." });
	} else if (fleet?.enabled === true && fleet.lastErrorAt !== undefined && (fleet.lastOkAt === undefined || fleet.lastErrorAt > fleet.lastOkAt)) {
		issues.push({ level: "warn", title: "Fleet API failing", detail: fleetFix(fleet.lastError) });
	}
	const clients = status.clients;
	if (clients !== undefined && clients.failed > 0) {
		issues.push({
			level: "warn",
			title: `Clients failed ${clients.failed}`,
			detail: clients.lastFailure?.error ?? "-",
		});
	}
	if (clients?.moved !== undefined && clients.moved > 0) {
		issues.push({ level: "warn", title: `Clients moved ${clients.moved}`, detail: "Their game didn't load here." });
	}
	return issues;
}

/**
 * Kernel 0.3.6 ("never an empty server"): flagged like the boot fail-safe.
 * - the backup build baked into the place runs (nothing else could): error;
 * - players are being moved to another server (nothing runs here): error;
 * - the backup failed here: warn.
 */
export function fallbackIssues(status: KernelStatus): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	const fallback = status.fallback;
	if (status.backup === true) {
		const at = fallback?.backup.at;
		issues.push({ level: "error", title: "Running the backup build", detail: `${fallback?.backup.artifactId ?? "-"}${at !== undefined ? `, baked ${at.sub(1, 10)}` : ""}. Retrying the real one.` });
	}
	if (fallback?.moving.active === true) {
		issues.push({ level: "error", title: "Moving players out", detail: "Nothing runs on this server." });
	}
	if (fallback?.backup.failed !== undefined) {
		issues.push({ level: "warn", title: "Backup build failed", detail: fallback.backup.failed.error ?? "-" });
	}
	return issues;
}

/** How old, in a few words: "45 s", "3m", "2h", "4d". */
function ageText(seconds: number): string {
	if (seconds < 60) return `${math.floor(seconds)} s`;
	if (seconds < 3600) return `${math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${math.floor(seconds / 3600)}h`;
	return `${math.floor(seconds / 86400)}d`;
}

/** The Status page's Settings line: "#12, 3m old (sig)", "none (run typetorch settings push)", "refused: ...". */
export function settingsText(settings: SettingsStatus): string {
	if (settings.state === "ok") {
		return `#${settings.seq ?? "?"}${settings.age !== undefined ? `, ${ageText(settings.age)} old` : ""}${settings.verifiedBy !== undefined ? ` (${settings.verifiedBy})` : ""}`;
	}
	if (settings.state === "missing") return "none: run typetorch settings push";
	if (settings.state === "unknown") return "not read yet";
	return `${settings.state}: ${settings.error ?? "-"}`;
}

/** A refused copy this recent is reported even while a good one is held. */
const RECENT_REFUSAL = 15 * 60;

/**
 * Kernel 0.3.8 (plans/20) signed settings (status().settings):
 * - no record: warn ("typetorch settings push"); unsigned or invalid with nothing held: error; the read failing with
 *   nothing held: warn;
 * - a copy refused in the last 15 minutes while a good one is held (game code wrote it, or a replay): warn.
 */
export function settingsIssues(status: KernelStatus): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	const settings = status.settings;
	if (settings === undefined) return issues;
	if (settings.state === "missing") {
		issues.push({ level: "warn", title: "No settings", detail: "Run typetorch settings push." });
	} else if (settings.state === "unsigned" || settings.state === "invalid") {
		issues.push({ level: "error", title: "Settings refused", detail: settings.error ?? settings.state });
	} else if (settings.state === "error") {
		issues.push({ level: "warn", title: "Settings unreadable", detail: settings.error ?? "-" });
	}
	const refused = settings.refused;
	if (settings.state === "ok" && refused !== undefined && os.time() - refused.at <= RECENT_REFUSAL) {
		issues.push({ level: "warn", title: "Settings copy refused", detail: `${refused.why}; kept #${settings.seq ?? "?"}` });
	}
	return issues;
}

/** Kernel 0.3.8 detached jobs, for Server > Status: "2 running (oldest 4 s), 1 failed". */
export function detachedText(detached: DetachedStatus): string {
	const parts = [`${detached.running} running${detached.oldest !== undefined ? ` (oldest ${detached.oldest} s)` : ""}`];
	if (detached.failed > 0) parts.push(`${detached.failed} failed`);
	return parts.join(", ");
}

/** A detached job slower than this (seconds) is flagged while it runs (the kernel logs it at 60 s too). */
const DETACHED_SLOW = 60;

/**
 * Kernel 0.3.8 detached jobs (status().detached): one still running past 60 s (a stuck library call keeps an old
 * generation alive), or the server near its cap: warn.
 */
export function detachedIssues(status: KernelStatus): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	const detached = status.detached;
	if (detached === undefined) return issues;
	if (detached.oldest !== undefined && detached.oldest >= DETACHED_SLOW) {
		issues.push({ level: "warn", title: "Detached job slow", detail: `${detached.running} running, the oldest for ${detached.oldest} s` });
	}
	if (detached.running >= detached.max * 0.8) {
		issues.push({ level: "warn", title: "Detached jobs near the cap", detail: `${detached.running} of ${detached.max}` });
	}
	return issues;
}

/**
 * Kernel 0.3.8 game messaging (status().messaging): the universe's rate on the game topic at the soft limit (publishes
 * wait), dropped messages, or the topic not subscribed after failures: warn, with the numbers.
 */
export function messagingIssues(status: KernelStatus): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	const messaging = status.messaging;
	if (messaging === undefined) return issues;
	if (messaging.state === "subscribing" && messaging.lastError !== undefined) {
		issues.push({ level: "warn", title: "Messaging offline", detail: messaging.lastError });
	}
	if (messaging.rate >= messaging.softLimit && messaging.queued > 0) {
		issues.push({ level: "warn", title: "Messaging busy", detail: `${messaging.rate}/min on ${messaging.topic}; ${messaging.queued} waiting` });
	}
	if (messaging.dropped > 0) {
		issues.push({ level: "warn", title: `Messages dropped ${messaging.dropped}`, detail: messaging.lastError ?? "Queue full or too slow." });
	}
	return issues;
}

/**
 * Hot assets (plans/13): a failed load keeps the old copy (warn); a failure with nothing live for the key is an
 * error; an unusable manifest is a warning.
 */
export function assetIssues(assets: AssetFacts | undefined): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	if (assets === undefined) return issues;
	if (assets.failed > 0) {
		const more = assets.failed > 1 ? ` (+${assets.failed - 1} more)` : "";
		issues.push({
			level: assets.missing > 0 ? "error" : "warn",
			title: assets.missing > 0 ? "Hot asset missing" : "Hot asset failed",
			detail: `${assets.first ?? "-"}${more}`,
		});
	}
	if (assets.manifestError !== undefined) issues.push({ level: "warn", title: "Asset manifest", detail: assets.manifestError });
	return issues;
}

/** Everything about this server a dev should notice, worst first. */
export function checkHealth(status: KernelStatus, facts?: ServerFacts): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	if (status.kernelApi < REQUIRED_KERNEL_API) {
		issues.push({
			level: "error",
			title: "Kernel update required",
			detail: `API ${status.kernelApi}, needs ${REQUIRED_KERNEL_API}. Republish the place, then migrate.`,
			action: "migrate",
		});
	} else if (versionLess(status.kernelVersion, LATEST_KERNEL)) {
		issues.push({
			level: "warn",
			title: "Kernel update",
			detail: `${status.kernelVersion} to ${LATEST_KERNEL}. Republish the place, then migrate.`,
			action: "migrate",
		});
	}
	if (status.generation === undefined) {
		issues.push({ level: "error", title: "No game running", detail: "No artifact is mounted on this server." });
	}
	for (const entry of status.history ?? []) {
		if (entry.reason.find("rollback", 1, true)[0] === undefined) continue;
		const age = secondsSince(entry.at);
		if (age !== undefined && age <= RECENT_ROLLBACK) {
			issues.push({ level: "warn", title: "Rolled back", detail: `${entry.reason} to ${entry.artifactId}` });
		}
	}
	if (status.registryError !== undefined) {
		issues.push({ level: "warn", title: "Registry", detail: status.registryError });
	}
	if (facts?.http === false) {
		issues.push({ level: "warn", title: "HTTP off", detail: "Claude needs HTTP requests enabled for this place." });
	}
	if (typeIs(status.memoryMb, "number") && status.memoryMb > HIGH_MEMORY_MB) {
		issues.push({ level: "warn", title: "High memory", detail: "%.0f MB".format(status.memoryMb) });
	}
	if (facts?.loadstring === false && status.channel === "dev") {
		issues.push({ level: "info", title: "run_luau off", detail: "LoadStringEnabled is off in this place." });
	}
	for (const issue of assetIssues(facts?.assets)) issues.push(issue);
	for (const issue of signingIssues(status)) issues.push(issue);
	for (const issue of deployIssues(status)) issues.push(issue);
	for (const issue of fallbackIssues(status)) issues.push(issue);
	for (const issue of messagingIssues(status)) issues.push(issue);
	for (const issue of settingsIssues(status)) issues.push(issue);
	for (const issue of detachedIssues(status)) issues.push(issue);
	if (status.localPayload === true) {
		issues.push({ level: "info", title: "Studio: local payload", detail: "Edits need Stop + Play. Reload remounts it." });
	}
	if (status.experiment !== undefined) {
		issues.push({ level: "info", title: "A/B experiment", detail: `${status.experiment.artifactId} until the next deploy` });
	} else if (status.pinned === true) {
		issues.push({ level: "info", title: "Pinned", detail: "Holds this artifact until the next deploy." });
	}
	const rank = { error: 0, warn: 1, info: 2 };
	issues.sort((a, b) => rank[a.level] < rank[b.level]);
	return issues;
}

/** The level a badge shows: errors and warnings only (info is shown on the page, not as a badge). */
export function badgeLevel(issues: HealthIssue[]): HealthLevel | undefined {
	for (const issue of issues) if (issue.level === "error") return "error";
	for (const issue of issues) if (issue.level === "warn") return "warn";
	return undefined;
}
