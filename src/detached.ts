import type { Trove } from "@rbxts/trove";
import type { ServerKernel } from "./kernel";
import { Relay } from "./runtime/relay";

/**
 * `TypeTorch.runDetached(fn)` (server only, kernel 0.3.8): runs `fn` on a thread the KERNEL owns, so a deploy's swap
 * (this generation's stop, and its hard stop, which kills the generation's own threads mid-call) never cuts it off.
 * Made for library calls that must not stop halfway: a ProfileStore / ProfileService load, save or release cut off
 * by a hard stop jams that player's profile on this server (docs: Player data, "Why the jobs").
 *
 *   TypeTorch.runDetached(() => store.StartSessionAsync(key)).then((profile) => ...);
 *
 * - The Promise settles on this generation's thread while it runs. A result that arrives after this generation
 *   stopped is dropped: a job whose result must survive a swap writes it into `persist` itself.
 * - A job keeps this generation's closures (and everything they reference) alive until it ends: keep jobs short.
 * - Errors reject the Promise and go to the kernel's log with the generation's name; they never count toward the
 *   build's health window. At most 256 jobs run at once per server (then it throws); one past 60 s is logged.
 * - Older kernels: throws "needs kernel 0.3.8; use the DataHost job queue (Player data guide)". Clients: throws.
 */

/** The first kernel with `api:runDetached`. */
export const DETACHED_KERNEL = "0.3.8";

interface Binding {
	realm: "server" | "client";
	kernel?: ServerKernel;
	kernelVersion: string;
	relay?: Relay;
}

let binding: Binding | undefined;

/** Called by bindTypeTorch. */
export function bindDetached(realm: "server" | "client", kernel: unknown, trove: Trove, kernelVersion: string) {
	const server = realm === "server" ? (kernel as ServerKernel) : undefined;
	const supported = server !== undefined && typeIs((server as unknown as Record<string, unknown>).runDetached, "function");
	binding = { realm, kernel: server, kernelVersion, relay: supported ? new Relay(trove) : undefined };
}

/** Called by unbindTypeTorch. */
export function unbindDetached() {
	binding = undefined;
}

/** `runDetached` reaches a kernel thread (a server on kernel 0.3.8+). */
export function detachedSupported(): boolean {
	return binding?.relay !== undefined;
}

/** `TypeTorch.runDetached`. */
export function runDetached<T>(fn: () => T): Promise<T> {
	if (!typeIs(fn, "function")) error("TypeTorch.runDetached: pass a function", 3);
	const current = binding;
	// Edit mode (no kernel, no swaps): run it here.
	if (current === undefined) return Promise.try(fn);
	if (current.realm === "client") error("TypeTorch.runDetached is server-only", 3);
	const kernel = current.kernel;
	const relay = current.relay;
	if (kernel === undefined || relay === undefined) {
		error(
			`TypeTorch.runDetached needs kernel ${DETACHED_KERNEL} (this server runs ${current.kernelVersion}); use the DataHost job queue (Player data guide)`,
			3,
		);
	}
	let settle: ((ok: boolean, value: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		settle = (ok, value) => (ok ? resolve(value as T) : reject(value));
	});
	// Throws at once past the kernel's cap (256 running jobs).
	kernel.runDetached!(fn, (ok, value) => relay.run(() => settle?.(ok, value)));
	return promise;
}
