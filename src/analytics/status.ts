import type { AnalyticsStats } from "./schema";

/**
 * Where the dev menu finds the running server engine's counters (devtools/server.ts, Status > Analytics): the engine
 * registers a getter when it starts and removes it when its generation stops. Module state is fresh in every
 * generation, like the engine itself. Types only, so importing this loads nothing else.
 */
let provider: (() => AnalyticsStats | undefined) | undefined;

/** Registers the engine's `stats()`; the returned function removes it again (only if it is still the registered one). */
export function registerAnalyticsStatus(getter: () => AnalyticsStats | undefined): () => void {
	provider = getter;
	return () => {
		if (provider === getter) provider = undefined;
	};
}

/** The running server engine's stats, or undefined when none runs in this generation. */
export function analyticsStatus(): AnalyticsStats | undefined {
	return provider?.();
}
