import { persistKeys, runningModules } from "../runtime/registry";
import type { ModuleState, PersistSummary, StateSummary } from "./protocol";
import { PERSIST_ROOT, StateRoot } from "./state-inspect";

/** Shared by the client Modules tabs (local) and the server "state" / "state.inspect" ops. */

const HOOKS = ["onInit", "onStart", "onStop", "onTick", "onPhysics", "onRender", "onPlayerAdded"];
const PREVIEW_ENTRIES = 6;
const PREVIEW_CHARS = 300;

/**
 * Framework-internal persist stores never show (they are opened through the kernel directly, not ctx.persist; the
 * remote-claude store holds refresh tokens).
 */
function isInternalStore(key: string): boolean {
	return key === "remoteClaude" || key.sub(1, 10) === "typetorch/";
}

function scalar(value: unknown): string {
	if (typeIs(value, "string")) return value.size() > 40 ? `"${value.sub(1, 40)}..."` : `"${value}"`;
	if (typeIs(value, "table")) return "{...}";
	return tostring(value);
}

function summarize(key: string, value: object): PersistSummary {
	let entries = 0;
	const parts = new Array<string>();
	for (const [entryKey, entryValue] of pairs(value)) {
		entries += 1;
		if (parts.size() < PREVIEW_ENTRIES) parts.push(`${tostring(entryKey)}=${scalar(entryValue)}`);
	}
	let preview = parts.join(", ");
	if (entries > PREVIEW_ENTRIES) preview += ", ...";
	return { key, kind: typeOf(value), entries, preview: preview.sub(1, PREVIEW_CHARS) };
}

export function describeState(): StateSummary {
	const modules = runningModules.map((running): ModuleState => {
		const hooks = HOOKS.filter((hook) => typeIs((running.instance as Record<string, unknown>)[hook], "function"));
		return {
			name: running.name,
			dependencies: running.dependencies,
			loadOrder: running.loadOrder,
			initMs: running.initSeconds !== undefined ? math.floor(running.initSeconds * 1000) : undefined,
			hooks,
		};
	});
	const persist = new Array<PersistSummary>();
	for (const [key, value] of persistKeys) {
		if (isInternalStore(key)) continue;
		persist.push(summarize(key, value));
	}
	persist.sort((a, b) => a.key < b.key);
	return { modules, persist };
}

/**
 * Modules > State roots for this realm: every live module of the running generation (by name; a second module with
 * the same name gets "#2"), then the persist store (the ctx.persist tables this generation opened, keyed by name).
 */
export function stateRoots(): StateRoot[] {
	const roots = new Array<StateRoot>();
	const seen = new Map<string, number>();
	const modules = [...runningModules];
	modules.sort((a, b) => a.name.lower() < b.name.lower());
	for (const running of modules) {
		const n = (seen.get(running.name) ?? 0) + 1;
		seen.set(running.name, n);
		const token = n === 1 ? running.name : `${running.name}#${n}`;
		roots.push({ token, label: token, kind: "module", value: running.instance });
	}
	const stores: Record<string, object> = {};
	for (const [key, value] of persistKeys) {
		if (!isInternalStore(key)) stores[key] = value;
	}
	roots.push({ token: PERSIST_ROOT, label: "persist", kind: "persist", value: stores });
	return roots;
}
