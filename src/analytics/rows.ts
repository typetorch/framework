/**
 * How built-ins outside the engine (notifications) write rows into the running server engine's events: the engine
 * registers a writer when it starts and removes it when its generation stops (the `status.ts` pattern). Module state is
 * fresh in every generation. Types only, so importing this loads nothing else.
 *
 * `target`: a Player (their session's pid / sid), a UserId (the session of that player when they are in this server;
 * otherwise a server row without a pid: never a raw UserId in `events`), or undefined (a server row).
 */
export type BuiltinRowKind = "notify";
export type BuiltinRowWriter = (target: Player | number | undefined, kind: BuiltinRowKind, name: string, props: object) => void;

let writer: BuiltinRowWriter | undefined;

/** Registers the engine's writer; the returned function removes it again (only if it is still the registered one). */
export function registerBuiltinRows(fn: BuiltinRowWriter): () => void {
	writer = fn;
	return () => {
		if (writer === fn) writer = undefined;
	};
}

/** The running server engine's writer, or undefined when no engine runs in this generation (yet). */
export function builtinRowWriter(): BuiltinRowWriter | undefined {
	return writer;
}
