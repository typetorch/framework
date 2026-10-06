import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";

/**
 * Shared data feeds for the dev menu's panes (plans/10 "Panes and windows"). Two panes on the same page must not double
 * the server requests or trip the server's per-dev limits:
 *
 * - `PollFeed`: one poll loop per op, however many panes show it (Server > Status, Modules > Overview / Assets on the
 *   server realm, Network > Stats). It runs only while a pane watches it (a hidden pane is unmounted, so it stops
 *   watching), and a new watcher gets the latest value at once.
 * - `TokenBucket`: a client-side copy of a server bucket, a little stricter, shared by every pane that spends it
 *   (Modules > State's `state.inspect`); callers wait for tokens instead of getting "Slow down".
 * - `Gate`: at most one call per interval across panes (Logs > Others' `logs.player`, 1 per 2 s per dev on the server).
 */

/** One poll loop shared by every pane watching the same data. */
export class PollFeed<T> {
	private readonly listeners = new Set<(value: T) => void>();
	private last?: T;
	private lastAt = -math.huge;
	private thread?: thread;
	private run = 0;

	constructor(
		private readonly fetch: () => T,
		private readonly interval: number,
		private readonly name: string,
	) {}

	/** True while at least one pane watches. */
	active(): boolean {
		return this.listeners.size() > 0;
	}

	/**
	 * Calls `listener` with every new value until `trove` is cleaned. The latest value (if fresher than one interval)
	 * is delivered at once; the loop starts with the first watcher and stops with the last.
	 */
	watch(trove: Trove, listener: (value: T) => void) {
		this.listeners.add(listener);
		trove.add(() => {
			this.listeners.delete(listener);
			if (this.listeners.size() === 0) this.stop();
		});
		if (this.last !== undefined && os.clock() - this.lastAt < this.interval) {
			const value = this.last;
			const [ok, err] = pcall(listener, value);
			if (!ok) $warn(`[devtools] ${this.name} listener failed: ${err}`);
		}
		if (this.thread === undefined) this.start(this.last === undefined || os.clock() - this.lastAt >= this.interval);
	}

	private start(now: boolean) {
		this.run += 1;
		const run = this.run;
		this.thread = task.spawn(() => {
			if (!now) task.wait(math.max(0, this.interval - (os.clock() - this.lastAt)));
			while (this.run === run && this.listeners.size() > 0) {
				const [ok, value] = pcall(this.fetch);
				if (this.run !== run) return;
				if (ok) {
					this.last = value;
					this.lastAt = os.clock();
					for (const listener of [...this.listeners]) {
						const [fine, err] = pcall(listener, value);
						if (!fine) $warn(`[devtools] ${this.name} listener failed: ${err}`);
					}
				} else $warn(`[devtools] ${this.name} refresh failed: ${value}`);
				task.wait(this.interval);
			}
		});
	}

	private stop() {
		this.run += 1;
		const thread = this.thread;
		this.thread = undefined;
		// Suspended in task.wait or in a dev op's yield; a late op reply finds the thread dead and is dropped.
		if (thread !== undefined && thread !== coroutine.running() && coroutine.status(thread) === "suspended") task.cancel(thread);
	}

	/** Stops the loop and forgets the last value (the generation's trove calls it on a swap). */
	destroy() {
		this.listeners.clear();
		this.stop();
		this.last = undefined;
	}
}

/** A token bucket on the client, shared by every pane that spends it: `take` waits until `cost` tokens are there. */
export class TokenBucket {
	private tokens: number;
	private at = os.clock();

	constructor(
		private readonly burst: number,
		private readonly rate: number,
	) {
		this.tokens = burst;
	}

	private fill() {
		const now = os.clock();
		this.tokens = math.min(this.burst, this.tokens + (now - this.at) * this.rate);
		this.at = now;
	}

	/** Yields until `cost` tokens are free (at most `burst` are ever asked for), then spends them. */
	take(cost: number) {
		const wanted = math.min(cost, this.burst);
		this.fill();
		while (this.tokens < wanted) {
			task.wait((wanted - this.tokens) / this.rate + 0.02);
			this.fill();
		}
		this.tokens -= wanted;
	}
}

/** At most one pass per `spacing` seconds across every caller: `pass` yields until it's this caller's turn. */
export class Gate {
	private nextAt = -math.huge;

	constructor(private readonly spacing: number) {}

	pass() {
		const now = os.clock();
		const at = math.max(now, this.nextAt);
		this.nextAt = at + this.spacing;
		if (at > now) task.wait(at - now);
	}
}
