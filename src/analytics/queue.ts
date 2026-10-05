/**
 * The server's send queue and its HTTP budget (plans/16 section 6a). Rows wait in plain arrays that live in the
 * kernel's persist store, so a hot swap hands every unsent row to the next generation as is.
 *
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-analytics.luau).
 */

/** Plain data (persist-safe): the rows, oldest first, and what was dropped. */
export interface QueueState<T> {
	rows: T[];
	/** Rows dropped because the queue was full (oldest first). */
	dropped: number;
}

export function newQueueState<T>(): QueueState<T> {
	return { rows: [], dropped: 0 };
}

/** Removes the first `count` rows of `rows` in place and returns them. */
function removeFront<T extends defined>(rows: T[], count: number): T[] {
	const size = rows.size();
	const taken = new Array<T>();
	if (count <= 0) return taken;
	count = math.min(count, size);
	for (let index = 0; index < count; index++) taken.push(rows[index]);
	for (let index = count; index < size; index++) rows[index - count] = rows[index];
	for (let index = 0; index < count; index++) rows.pop();
	return taken;
}

/**
 * A bounded FIFO over a QueueState. Over the cap it drops the oldest rows (a tenth of the cap at once, so pushing
 * stays cheap) and counts them.
 */
export class RowQueue<T extends defined> {
	constructor(
		readonly state: QueueState<T>,
		public cap: number,
	) {}

	size(): number {
		return this.state.rows.size();
	}

	/** Drops the oldest rows until at most `cap` remain (a tenth of the cap extra, at least one). */
	private trim() {
		const rows = this.state.rows;
		if (rows.size() <= this.cap) return;
		const excess = rows.size() - this.cap + math.max(1, math.floor(this.cap / 10));
		const count = math.min(excess, rows.size());
		removeFront(rows, count);
		this.state.dropped += count;
	}

	push(row: T) {
		this.state.rows.push(row);
		if (this.state.rows.size() > this.cap) this.trim();
	}

	/**
	 * Takes rows from the front: at most `maxRows`, and stops before `maxBytes` (`sizeOf` estimates a row; the first row
	 * is always taken so a big row can't block the queue).
	 */
	take(maxRows: number, maxBytes: number, sizeOf: (row: T) => number): T[] {
		const rows = this.state.rows;
		let count = 0;
		let bytes = 0;
		while (count < maxRows && count < rows.size()) {
			const size = sizeOf(rows[count]);
			if (count > 0 && bytes + size > maxBytes) break;
			bytes += size;
			count += 1;
		}
		return removeFront(rows, count);
	}

	/** Puts rows that failed to send back at the front, in order. Over the cap, the oldest are dropped. */
	requeue(batch: T[]) {
		if (batch.size() === 0) return;
		const rows = this.state.rows;
		const size = rows.size();
		const count = batch.size();
		for (let index = size - 1; index >= 0; index--) rows[index + count] = rows[index];
		for (let index = 0; index < count; index++) rows[index] = batch[index];
		this.trim();
	}
}

/** Plain data (persist-safe) for a token bucket. */
export interface BucketState {
	tokens: number;
	/** The clock reading of the last refill. */
	last: number;
}

/**
 * HTTP budget: `burst` requests at once, refilled at `perMinute`. Roblox allows 500 requests a minute per server for
 * every HttpService user together; analytics keeps itself near 10.
 */
export function takeToken(state: BucketState, now: number, burst: number, perMinute: number): boolean {
	const elapsed = math.max(0, now - state.last);
	state.tokens = math.min(burst, state.tokens + (elapsed * perMinute) / 60);
	state.last = now;
	if (state.tokens < 1) return false;
	state.tokens -= 1;
	return true;
}

/** Seconds to wait after `failures` failed requests in a row: 5, 10, 20... at most 300, spread by `jitter` (0..1). */
export function backoffSeconds(failures: number, jitter: number): number {
	if (failures <= 0) return 0;
	const base = math.min(300, 5 * 2 ** math.min(failures - 1, 10));
	return base * (0.75 + 0.5 * math.clamp(jitter, 0, 1));
}

/** What to do with a batch after an HTTP status (0 = no response: network error, timeout, HttpService off). */
export type Outcome = "sent" | "retry" | "split" | "drop" | "config";

/**
 * 2xx sent; 413 split the batch; 401/403/404 a settings problem (wrong token or URL: keep the rows, wait long, a
 * settings change retries at once); 408/429/5xx/no response retry with backoff; other 4xx drop the batch.
 */
export function classifyStatus(status: number): Outcome {
	if (status >= 200 && status < 300) return "sent";
	if (status === 413) return "split";
	if (status === 401 || status === 403 || status === 404) return "config";
	if (status === 408 || status === 429 || status === 0 || status >= 500) return "retry";
	// 400, 422...: the batch itself is refused; sending it again won't help.
	return "drop";
}
