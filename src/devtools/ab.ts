import type { ServerKernel } from "../kernel";

/**
 * A/B experiments on live servers (kernel 0.2.3; plans/10 "Manage > Servers (A/B)", plans/01).
 *
 * - On a public server, an owner may pin ANY known artifact (dev channel too) as an experiment:
 *   `kernel.pinArtifact(player, assetId, { experiment: true })`. The server stays "prod" (public), so devtools stay
 *   read-only there. The pin holds until the next deploy of the server's branch, an unpin, or the server closing.
 * - Manage > Servers pins many servers at once through the kernel topic `TypeTorch/pin` (PinMessage): by JobId, or a
 *   random `pct` of the servers on one branch (`jobBucket(JobId) < pct`, the same buckets as deploy rollouts `ro`).
 * - Unsigned, like deploy messages (plans/12 S-C2 stays open): the kernel re-checks the fields, a 120 s freshness
 *   window and that `by` is an owner, and only pins known deployments.
 */

/** Kernel 0.2.3 MessagingService topic for remote experiment pins (kernel Constants.PIN_TOPIC). */
export const PIN_TOPIC = "TypeTorch/pin";
/** The first kernel with experiment pins, remote pins and rollouts. */
export const AB_KERNEL = "0.2.3";
/** The error code the dev menu turns into "Needs kernel 0.2.3". */
export const NEEDS_KERNEL_AB = "needs_kernel";
/** MessagingService caps a message at 1 KiB; 15 JobIds (36 characters each) stay well under it. */
export const PIN_JOBS_PER_MESSAGE = 15;

/** A TypeTorch/pin message (kernel 0.2.3). */
export interface PinMessage {
	/** JobIds that apply it. */
	j?: string[];
	/** Or: servers whose jobBucket is below this percent (1-100). */
	pct?: number;
	/** Payload asset id of a known deployment (optional for unpin: then any experiment ends). */
	a?: number;
	/** Only servers on this branch apply it. */
	b: string;
	/** The owner who asked (the kernel checks the role). */
	by: number;
	/** Sent at, unix milliseconds (refused when more than 120 s off). */
	t: number;
	/** End the experiment instead (back to the branch head). */
	unpin?: boolean;
}

/** What Manage > Servers asks the server to publish (op admin.ab). Exactly one of jobIds / pct. */
export interface AbRequest {
	jobIds?: string[];
	pct?: number;
	/** The branch a `pct` request targets. */
	branch?: string;
	/** Required unless unpin. */
	assetId?: number;
	unpin?: boolean;
}

export interface AbReply {
	ok: boolean;
	/** Servers addressed by JobId (pct requests: undefined). */
	servers?: number;
	/** Selected JobIds that are no longer in the list. */
	skipped: number;
	/** Messages published, and how many of them failed. */
	messages: number;
	failed: number;
}

/**
 * The kernel's bucket for a server, 0-99: djb2 over the JobId's bytes, mod 2^32, mod 100. Deploy rollouts (`ro`) and
 * random A/B pins (`pct`) take the servers whose bucket is below the percent. Same function as the kernel's jobBucket.
 */
export function jobBucket(jobId: string): number {
	let hash = 5381;
	for (let index = 1; index <= jobId.size(); index++) {
		hash = (hash * 33 + string.byte(jobId, index)[0]) % 4294967296;
	}
	return hash % 100;
}

/** Kernel 0.2.3+: experiment pins, `unpin`, TypeTorch/pin and rollouts. Feature-detected by `experiment()`. */
export function kernelHasExperiments(kernel: ServerKernel): boolean {
	return typeIs((kernel as unknown as Record<string, unknown>).experiment, "function");
}
