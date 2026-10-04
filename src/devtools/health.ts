import type { KernelStatus } from "../kernel";

/** The newest kernel this framework release knows about. Bump it with every kernel release. */
export const LATEST_KERNEL = "0.2.2";
/** The oldest kernel API this framework runs on. */
export const REQUIRED_KERNEL_API = 1;
/** Auto-rollbacks newer than this (seconds) are reported. */
const RECENT_ROLLBACK = 15 * 60;
const HIGH_MEMORY_MB = 3000;

export type HealthLevel = "error" | "warn" | "info";

export interface HealthIssue {
	level: HealthLevel;
	title: string;
	detail: string;
}

/** Facts only the server can check (devtools "status" op); missing on older frameworks. */
export interface ServerFacts {
	/** loadstring works (ServerScriptService.LoadStringEnabled); Claude's run_luau needs it. */
	loadstring?: boolean;
	/** HttpService.HttpEnabled; remote-claude needs it. */
	http?: boolean;
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

function secondsSince(iso: string): number | undefined {
	const [ok, time] = pcall(() => DateTime.fromIsoDate(iso));
	if (!ok || time === undefined) return undefined;
	return DateTime.now().UnixTimestamp - time.UnixTimestamp;
}

/** Everything about this server a dev should notice, worst first. */
export function checkHealth(status: KernelStatus, facts?: ServerFacts): HealthIssue[] {
	const issues = new Array<HealthIssue>();
	if (status.kernelApi < REQUIRED_KERNEL_API) {
		issues.push({
			level: "error",
			title: "Kernel update required",
			detail: `API ${status.kernelApi}, needs ${REQUIRED_KERNEL_API}. Republish the place, then restart servers.`,
		});
	} else if (versionLess(status.kernelVersion, LATEST_KERNEL)) {
		issues.push({
			level: "warn",
			title: "Kernel update",
			detail: `${status.kernelVersion} to ${LATEST_KERNEL}. Republish the place, then restart servers.`,
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
	if (status.pinned === true) {
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
