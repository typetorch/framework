import { persistKeys, runningModules } from "../runtime/registry";
import type { ModuleState, PersistSummary, StateSummary } from "./protocol";

/** Shared by the client State tab (local) and the server "state" op. */

const HOOKS = ["onInit", "onStart", "onStop", "onTick", "onPhysics", "onRender", "onPlayerAdded"];
const PREVIEW_ENTRIES = 6;
const PREVIEW_CHARS = 300;

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
		// Framework-internal stores never show here (they are opened through the kernel directly, not ctx.persist).
		if (key === "remoteClaude" || key.sub(1, 10) === "typetorch/") continue;
		persist.push(summarize(key, value));
	}
	persist.sort((a, b) => a.key < b.key);
	return { modules, persist };
}
