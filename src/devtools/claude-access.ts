import type { Channel, DevInfo, KernelStatus, ServerType } from "../kernel";
import { branchChannelOf, devRoleOf, rulesOf } from "../kernel";

/**
 * Who may use Claude on this server: prompts, live tools (run_luau, inspect, ...), toolbox inserts, keeping the
 * dev machine's session, the long-polls and Logs > Upload (claude.ts, toolbox-server.ts). Every gate asks here.
 *
 * The owner's model: two channels, prod (the single prod branch) and dev (every other branch). Claude works:
 *   1. under dev RULES (private, reserved and Studio servers on a dev branch with a dev build): every dev, as before;
 *   2. on a PUBLIC server whose branch channel is dev and whose branch an OWNER switched to (kernel 0.3.4+ owner switch:
 *      `status().switched` names this branch, and the kernel follows it by dev rules, `status().signedOnly` false,
 *      which only its in-memory `ownerBranch` gives a public server): owners only;
 *   3. nowhere else.
 * The rules themselves don't change (signatures, read-only devtools for non-owners, `TypeTorch.channel`). Older kernels
 * have no `branchChannel` (before 0.3.9) or no `switched` (before 0.3.4): their public servers stay refused.
 */

/** Why Claude is refused (an error code of the dev ops; claude-ui.ts has the short texts). */
export type ClaudeRefusal = "dev_branch_only" | "owner_switch_only" | "owners_only";

/** The server's half of the rule: "dev" (rule 1), "owners" (rule 2) or why not. */
export type ClaudeServerAccess = "dev" | "owners" | "dev_branch_only" | "owner_switch_only";

/** What the rule reads from the kernel (ServerKernel has all of it; tests pass stubs). */
export interface ClaudeAccessKernel {
	readonly branch: string;
	readonly channel: Channel;
	readonly rules?: Channel;
	readonly branchChannel?: Channel;
	readonly serverType: ServerType;
	status(): Pick<KernelStatus, "branch" | "signedOnly" | "switched">;
	devInfo(player: Player): DevInfo;
}

/**
 * A public server's branch was set by an owner switch: the kernel's switch record names this branch (only owners switch
 * or load builds on public servers), the kernel runs that branch now, and it follows it by dev rules (`signedOnly`
 * false: the owner's dev branch). Absent fields (older kernels) mean no.
 */
export function ownerSwitchedHere(kernel: Pick<ClaudeAccessKernel, "branch">, status: Pick<KernelStatus, "branch" | "signedOnly" | "switched">): boolean {
	const switched = status.switched;
	if (!typeIs(switched, "table")) return false;
	return status.signedOnly === false && status.branch === kernel.branch && switched.branch === kernel.branch && typeIs(switched.by, "number");
}

/** The server's half: rules dev, else a public dev branch an owner switched to, else refused. */
export function claudeServerAccess(kernel: ClaudeAccessKernel): ClaudeServerAccess {
	if (rulesOf(kernel) === "dev") return "dev";
	if (branchChannelOf(kernel) !== "dev" || kernel.serverType !== "public") return "dev_branch_only";
	const [ok, status] = pcall(() => kernel.status());
	if (!ok || !typeIs(status, "table")) return "owner_switch_only";
	return ownerSwitchedHere(kernel, status) ? "owners" : "owner_switch_only";
}

/** Whether `player` may use Claude here (undefined) or why not. `server`: claudeServerAccess, when already known. */
export function claudeAccess(kernel: ClaudeAccessKernel, player: Player, server = claudeServerAccess(kernel)): ClaudeRefusal | undefined {
	if (server === "dev") return undefined;
	if (server !== "owners") return server;
	return devRoleOf(kernel, player) === "owner" ? undefined : "owners_only";
}

/**
 * The rule for one generation of claude.ts. The server half reads `kernel.status()` on public servers, so it is kept
 * for `ttl` seconds (the long-poll manager asks every second); the player half (the owner check) is asked every time.
 */
export class ClaudeGate {
	private cached?: ClaudeServerAccess;
	private cachedAt = -math.huge;

	constructor(
		private readonly kernel: ClaudeAccessKernel,
		private readonly ttl = 1,
	) {}

	/** The server's half (see claudeServerAccess). */
	server(): ClaudeServerAccess {
		const now = os.clock();
		if (this.cached === undefined || now - this.cachedAt >= this.ttl) {
			this.cached = claudeServerAccess(this.kernel);
			this.cachedAt = now;
		}
		return this.cached;
	}

	/** The server may keep the dev machine's session and listen for it (rule 1 or 2). */
	serverOpen(): boolean {
		const server = this.server();
		return server === "dev" || server === "owners";
	}

	/** Rule 2 (a public server an owner switched): only owners, and a kept session only while one is paired. */
	ownersOnly(): boolean {
		return this.server() === "owners";
	}

	/** Undefined when `player` may use Claude here, else why not. */
	refusal(player: Player): ClaudeRefusal | undefined {
		return claudeAccess(this.kernel, player, this.server());
	}
}
