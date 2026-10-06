import type { Trove } from "@rbxts/trove";

/**
 * Moves kernel callbacks onto this generation's own threads. The kernel calls back on threads it owns (they outlive a
 * swap); a BindableEvent's handlers run on threads of the script that connected it, here this generation's, so the
 * generation's hard stop ends any callback that is still running. Jobs stay in a table (functions and tables don't
 * cross a BindableEvent intact).
 */
export class Relay {
	private readonly event: BindableEvent;
	private readonly jobs = new Map<number, () => void>();
	private next = 0;

	constructor(trove: Trove) {
		this.event = trove.add(new Instance("BindableEvent"));
		trove.connect(this.event.Event, (id: unknown) => {
			if (!typeIs(id, "number")) return;
			const job = this.jobs.get(id);
			this.jobs.delete(id);
			job?.();
		});
		trove.add(() => this.jobs.clear());
	}

	/** Runs `job` on this generation's thread (soon; doesn't yield). */
	run(job: () => void) {
		this.next += 1;
		this.jobs.set(this.next, job);
		this.event.Fire(this.next);
	}
}
