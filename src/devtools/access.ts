import type { Channel, DevInfo, KernelStatus, ServerType } from "../kernel";
import { branchChannelOf, devRoleOf, rulesOf } from "../kernel";

/**
 * Framework 0.4.1: who may use the dev-only devtools on this server. Every such gate asks here: Claude (prompts, live
 * tools, toolbox inserts, keeping the dev machine's session, the long-polls; claude.ts, toolbox-server.ts), Logs >
 * Upload, Dex edits (explorer-server.ts), Modules > State reads for non-owners (server.ts), Manage's own respawn
 * (admin-server.ts), and on the client (cosmetic; the server re-checks) Dex edits, Network packet blocking, the
 * Claude tab, the hot-swap sound and the run_luau hint (op "access", `facts.access` of op "status").
 *
 * The owner's model: two channels, prod (the single prod branch) and dev (every other branch). The tools work:
 *   1. under dev RULES (private, reserved and Studio servers on a dev branch with a dev build): every dev, as before;
 *   2. on a PUBLIC server whose branch channel is dev and whose branch an OWNER switched to (kernel 0.3.4+ owner switch:
 *      `status().switched` names this branch, and the kernel follows it by dev rules, `status().signedOnly` false,
 *      which only its in-memory `ownerBranch` gives a public server): owners only;
 *   3. nowhere else.
 * The rules themselves don't change (signatures, owner-only rollbacks in the kernel, `TypeTorch.channel`, which games
 * split data stores by). Older kernels have no `branchChannel` (before 0.3.9) or no `switched` (before 0.3.4): their
 * public servers stay refused, as before.
 */

/** Why the dev-only tools are refused (an error code of the dev ops; client.ts and claude-ui.ts have short texts). */
export type DevRefusal = "dev_branch_only" | "owner_switch_only" | "owners_only";

/** The server's half of the rule: "dev" (rule 1), "owners" (rule 2) or why not. */
export type ServerAccess = "dev" | "owners" | "dev_branch_only" | "owner_switch_only";

/** What op "access" answers (and `facts.access` of op "status" holds: "ok" or the refusal). */
export type AccessReply = { ok: true } | { ok: false; error: DevRefusal };

/** What the rule reads from the kernel (ServerKernel has all of it; tests pass stubs). */
export interface AccessKernel {
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
export function ownerSwitchedHere(kernel: Pick<AccessKernel, "branch">, status: Pick<KernelStatus, "branch" | "signedOnly" | "switched">): boolean {
	const switched = status.switched;
	if (!typeIs(switched, "table")) return false;
	return status.signedOnly === false && status.branch === kernel.branch && switched.branch === kernel.branch && typeIs(switched.by, "number");
}

/** The server's half: rules dev, else a public dev branch an owner switched to, else refused. */
export function serverAccess(kernel: AccessKernel): ServerAccess {
	if (rulesOf(kernel) === "dev") return "dev";
	if (branchChannelOf(kernel) !== "dev" || kernel.serverType !== "public") return "dev_branch_only";
	const [ok, status] = pcall(() => kernel.status());
	if (!ok || !typeIs(status, "table")) return "owner_switch_only";
	return ownerSwitchedHere(kernel, status) ? "owners" : "owner_switch_only";
}

/** Whether `player` may use the dev-only tools here (undefined) or why not. `server`: serverAccess, when known. */
export function devAccess(kernel: AccessKernel, player: Player, server = serverAccess(kernel)): DevRefusal | undefined {
	if (server === "dev") return undefined;
	if (server !== "owners") return server;
	return devRoleOf(kernel, player) === "owner" ? undefined : "owners_only";
}

/**
 * The rule for one generation. The server half reads `kernel.status()` on public servers, so it is kept for `ttl`
 * seconds (Claude's long-poll manager asks every second); the player half (the owner check) is asked every time.
 */
export class DevAccess {
	private cached?: ServerAccess;
	private cachedAt = -math.huge;

	constructor(
		private readonly kernel: AccessKernel,
		private readonly ttl = 1,
	) {}

	/** The server's half (see serverAccess). */
	server(): ServerAccess {
		const now = os.clock();
		if (this.cached === undefined || now - this.cachedAt >= this.ttl) {
			this.cached = serverAccess(this.kernel);
			this.cachedAt = now;
		}
		return this.cached;
	}

	/** Some player may use the tools here (rule 1 or 2): e.g. the server keeps the dev machine's session. */
	serverOpen(): boolean {
		const server = this.server();
		return server === "dev" || server === "owners";
	}

	/** Rule 2 (a public server an owner switched): owners only; a kept Claude session only while one is paired. */
	ownersOnly(): boolean {
		return this.server() === "owners";
	}

	/** Undefined when `player` may use the tools here, else why not. */
	refusal(player: Player): DevRefusal | undefined {
		return devAccess(this.kernel, player, this.server());
	}

	allows(player: Player): boolean {
		return this.refusal(player) === undefined;
	}

	/** Op "access". */
	reply(player: Player): AccessReply {
		const refusal = this.refusal(player);
		return refusal === undefined ? { ok: true } : { ok: false, error: refusal };
	}
}
