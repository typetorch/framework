import { normalRole, type ClientKernel, type ServerType, type SwitchReply, type SwitchRequest } from "../kernel";
import { jobBucket } from "./ab";

/**
 * What the dev menu offers for branches and builds (framework 0.3.1+), as pure functions: the Branch tab and Manage >
 * Servers' "Load a build" card use the same words and rules, and test-generations.luau checks them.
 *
 * Words: a "build" is one artifact. "Switch" moves THIS server to another branch, "Load here" runs a build on THIS
 * server (a pin), "Join" moves only you to a reserved server. The kernel re-checks everything.
 *
 * Kernel 0.3.4: owners switch any server and load builds on it, public and prod ones too, from their own client
 * (`kernel.requestSwitch`). These are ordinary switches and pins: Reload and Rollback keep working, and going back to
 * prod is Switch on the prod row. There are no admins (framework 0.3.2): owners and devs. Older kernels keep the 0.3.0
 * rules.
 */

export interface PickerContext {
	/** This server's type (undefined: status unknown, no actions). */
	serverType?: ServerType;
	/** This server takes only signed prod builds (kernel 0.3). */
	signedOnly: boolean;
	/** The viewer is an owner (`normalRole`: an older kernel's "admin" is a dev). */
	isOwner: boolean;
	/** The kernel takes switches from the owner's own client (0.3.4: `requestSwitch`). */
	switchKernel: boolean;
	/** The kernel has A/B experiment pins (0.2.3+). */
	experiments: boolean;
}

/** "here": the owner switches THIS public server (for its lifetime, never stored); "stored": the private/reserved
 * server's own switch (it is kept); "join": move only you to a reserved server on that branch; undefined: no button. */
export type BranchAction = "here" | "stored" | "join" | undefined;

export function branchAction(ctx: PickerContext, current: boolean): BranchAction {
	if (ctx.serverType === undefined || current) return undefined;
	if (ctx.serverType === "public") return ctx.switchKernel && ctx.isOwner ? "here" : "join";
	return "stored";
}

/** The label of a branch row's button. */
export function branchLabel(action: BranchAction): string {
	return action === "join" ? "Join" : "Switch";
}

/** "here": the owner's pin from their own client (public and prod servers, kernel 0.3.4); "pin": the dev pin
 * (private/reserved/Studio dev servers, or an A/B experiment on a public server before 0.3.4); "join": move only you to
 * a reserved server on it; undefined: none. */
export type BuildAction = "here" | "pin" | "join" | undefined;

export function buildAction(ctx: PickerContext, entry: { running: boolean; channel: string }): BuildAction {
	if (ctx.serverType === undefined || entry.running) return undefined;
	const isPublic = ctx.serverType === "public";
	if ((isPublic || ctx.signedOnly) && ctx.switchKernel && ctx.isOwner) return "here";
	if (isPublic) {
		if (ctx.isOwner && ctx.signedOnly) return undefined; // an older kernel: only `typetorch pin` reaches it
		if (ctx.isOwner && (ctx.experiments || entry.channel === "prod")) return "pin";
		return "join";
	}
	if (ctx.signedOnly) return undefined;
	return "pin";
}

export function buildLabel(action: BuildAction): string {
	return action === "join" ? "Join" : "Load here";
}

/** Kernels before 0.3.4 on prod servers: in-game loads can't reach them, only `typetorch pin`. */
export function showCliNote(ctx: PickerContext): boolean {
	return !ctx.switchKernel && ctx.signedOnly && (ctx.isOwner || ctx.serverType !== "public");
}

/** Whether this client's player is an owner (cosmetic: the kernel re-checks). An older kernel's "admin" is a dev. */
export function viewerIsOwner(kernel: ClientKernel): boolean {
	const [ok, info] = pcall(() => kernel.devStatus());
	return ok && typeIs(info, "table") && info.dev === true && normalRole(info.role) === "owner";
}

/** Kernel 0.3.4: [the kernel takes switches from the owner's own client, this player is an owner]. */
export function switchOffered(kernel: ClientKernel): [kernelHas: boolean, owner: boolean] {
	const has = typeIs((kernel as unknown as Record<string, unknown>).requestSwitch, "function");
	return [has, viewerIsOwner(kernel)];
}

/** Asks the kernel to switch this server or load a build here (yields; a switch replaces this client generation). */
export function requestSwitch(kernel: ClientKernel, request: SwitchRequest): SwitchReply {
	const [ok, reply] = pcall(() => kernel.requestSwitch!(request));
	if (!ok || !typeIs(reply, "table")) return { ok: false, error: tostring(reply) };
	return reply;
}


// Builds ---------------------------------------------------------------------------------------------------------------

export interface BuildEntry {
	seq?: number;
	commit?: string;
	artifactId?: string;
	assetId: number;
	branch: string;
	at?: string;
	live?: boolean;
	running?: boolean;
}

/** "#36  4363e8c": the deploy number and the short commit (or the id). */
export function buildTitle(entry: BuildEntry): string {
	const name = entry.commit ?? entry.artifactId ?? `asset ${entry.assetId}`;
	return entry.seq !== undefined ? `#${entry.seq}  ${name}` : name;
}

/** "#36" or the short name: what a summary line calls the build. */
export function buildName(entry: BuildEntry): string {
	return entry.seq !== undefined ? `#${entry.seq}` : entry.commit ?? entry.artifactId ?? `asset ${entry.assetId}`;
}

/** Seconds as "3h", "2d", "5m", "now". */
export function ageText(seconds: number | undefined): string {
	if (seconds === undefined) return "";
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${math.floor(seconds / 3600)}h ago`;
	return `${math.floor(seconds / 86400)}d ago`;
}

/** "dev · 3h ago". `age` = seconds since the deploy (undefined: unknown). */
export function buildDetail(entry: BuildEntry, age: number | undefined): string {
	const when = ageText(age);
	return when !== "" ? `${entry.branch} · ${when}` : entry.branch;
}

/** At most one badge: "Running here" wins over "Live" (its branch's current head). */
export function buildBadge(entry: BuildEntry): string | undefined {
	if (entry.running === true) return "Running here";
	if (entry.live === true) return "Live";
	return undefined;
}

// Where a build goes (Manage > Servers) ------------------------------------------------------------------------------

export type LoadWhere = "here" | "selected" | "share";

export interface LoadTarget {
	where: LoadWhere;
	/** "here": players on this server. */
	players?: number;
	/** "selected": how many servers are ticked. */
	selected?: number;
	/** "share": the percent and the branch. */
	pct?: number;
	branch?: string;
	/** "share": JobIds of the listed servers on that branch (to count the ones the percent reaches). */
	branchJobs?: string[];
}

/** The servers on the branch a percent reaches now: the kernel takes `jobBucket(JobId) < pct`. */
export function shareCount(pct: number, jobIds: string[]): number {
	let count = 0;
	for (const jobId of jobIds) if (jobBucket(jobId) < pct) count += 1;
	return count;
}

function servers(count: number): string {
	return `${count} server${count === 1 ? "" : "s"}`;
}

/** The primary button: "Load here", "Load on 2 servers", "Load on 10%". */
export function loadButtonLabel(target: LoadTarget): string {
	if (target.where === "here") return "Load here";
	if (target.where === "selected") return `Load on ${servers(target.selected ?? 0)}`;
	return `Load on ${target.pct ?? 0}%`;
}

/** One summary line: "Load #36 here (12 players)", "Load #36 on 2 servers", "Load #36 on 10% of dev servers (about 1
 * of 4)". */
export function loadSummary(build: BuildEntry, target: LoadTarget): string {
	const name = buildName(build);
	if (target.where === "here") {
		const players = target.players ?? 0;
		return `Load ${name} here (${players} player${players === 1 ? "" : "s"})`;
	}
	if (target.where === "selected") return `Load ${name} on ${servers(target.selected ?? 0)}`;
	const jobs = target.branchJobs ?? [];
	const reached = shareCount(target.pct ?? 0, jobs);
	return `Load ${name} on ${target.pct ?? 0}% of ${target.branch ?? "?"} servers (about ${reached} of ${jobs.size()})`;
}

/** The status line after a load: "Loading #36 on 2 servers", "Done: 2 switched", "1 of 2 switched" (failed). */
export function loadProgress(name: string, expected: number, switched: number, timedOut: boolean): [text: string, done: boolean, failed: boolean] {
	if (expected > 0 && switched >= expected) return [`Done: ${switched} switched`, true, false];
	if (timedOut) return [`${switched} of ${expected} switched`, true, true];
	return [`Loading ${name} on ${servers(expected)}`, false, false];
}

/** "switched by Owner 3m ago" (status().switched), or undefined. */
export function switchedText(info: { name?: string; at?: number } | undefined, now: number): string | undefined {
	if (info === undefined || !typeIs(info.at, "number")) return undefined;
	const age = math.max(0, now - info.at);
	return `switched by ${info.name ?? "?"} ${age < 60 ? "just now" : ageText(age)}`;
}
