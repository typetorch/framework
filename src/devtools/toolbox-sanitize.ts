/**
 * The Creator Store sanitizer (plans/14 "Sanitizer"): what a third-party model may keep before it is parented into a
 * live dev server. No imports and no services, so it also runs offline under Lune (scripts/test-toolbox-sanitize.luau).
 *
 * Strict (default):
 *   - every LuaSourceContainer (Script, LocalScript, ModuleScript, any RunContext) is removed;
 *   - RemoteEvent, RemoteFunction, UnreliableRemoteEvent, BindableEvent, BindableFunction are removed;
 *   - Explosion, SpawnLocation, PackageLink, ForceField, ProximityPrompt, ClickDetector, DragDetector are removed
 *     (side effects on players or the spawn);
 *   - Tool and HopperBin become a plain Model with the same children (nothing can be picked up into a backpack);
 *   - every Sound stops (Playing and PlayOnRemove off);
 *   - every BasePart is anchored when `anchor` (the default; it also covers welds that load wrong).
 * "Keep scripts" (off by default, the dev's explicit choice on the approval card; spike T4): server Scripts (RunContext
 * Legacy or Server), ModuleScripts, bindables and the interaction detectors stay; LocalScripts, client-RunContext
 * Scripts, remotes and the side-effect classes still go. The model stays Sandboxed (toolbox-server.ts sets the
 * capability set).
 */

const REMOTES = new ReadonlySet<string>(["RemoteEvent", "RemoteFunction", "UnreliableRemoteEvent"]);
const BINDABLES = new ReadonlySet<string>(["BindableEvent", "BindableFunction"]);
/** Side effects on players or the spawn: always removed. */
const ALWAYS_REMOVED = new ReadonlySet<string>(["Explosion", "SpawnLocation", "PackageLink", "ForceField"]);
/** Interaction surfaces: removed unless scripts are kept (kept scripts need them to work). */
const INTERACTIONS = new ReadonlySet<string>(["ProximityPrompt", "ClickDetector", "DragDetector"]);
const BACKPACK_ITEMS = new ReadonlySet<string>(["Tool", "HopperBin"]);

/** A script "Keep scripts" may keep: a server Script (RunContext Legacy or Server) or a ModuleScript. */
export function isKeepableScript(instance: Instance): boolean {
	if (instance.ClassName === "ModuleScript") return true;
	if (instance.ClassName !== "Script") return false;
	const [ok, context] = pcall(() => (instance as Script).RunContext);
	return ok && (context === Enum.RunContext.Legacy || context === Enum.RunContext.Server);
}

export interface AssetScan {
	instances: number;
	parts: number;
	meshParts: number;
	/** Every LuaSourceContainer. */
	scripts: number;
	/** Paths (relative to the root) of the scripts "Keep scripts" would keep, at most `maxList`. */
	keepable: string[];
	keepableCount: number;
	remotes: number;
	bindables: number;
	/** Explosion, SpawnLocation, PackageLink, ForceField. */
	sideEffects: number;
	interactions: number;
	tools: number;
	sounds: number;
}

function relativePath(root: Instance, instance: Instance): string {
	const names = new Array<string>();
	for (let at: Instance | undefined = instance; at && at !== root; at = at.Parent) names.unshift(at.Name);
	return names.join(".");
}

/** Counts what an (unparented) asset holds. */
export function scanAsset(root: Instance, maxList = 12): AssetScan {
	const scan: AssetScan = { instances: 0, parts: 0, meshParts: 0, scripts: 0, keepable: [], keepableCount: 0, remotes: 0, bindables: 0, sideEffects: 0, interactions: 0, tools: 0, sounds: 0 };
	for (const instance of root.GetDescendants()) {
		scan.instances += 1;
		const className = instance.ClassName;
		if (instance.IsA("BasePart")) {
			scan.parts += 1;
			if (instance.IsA("MeshPart")) scan.meshParts += 1;
		}
		if (instance.IsA("LuaSourceContainer")) {
			scan.scripts += 1;
			if (isKeepableScript(instance)) {
				scan.keepableCount += 1;
				if (scan.keepable.size() < maxList) scan.keepable.push(`${relativePath(root, instance)} (${className})`.sub(1, 120));
			}
		}
		if (REMOTES.has(className)) scan.remotes += 1;
		if (BINDABLES.has(className)) scan.bindables += 1;
		if (ALWAYS_REMOVED.has(className)) scan.sideEffects += 1;
		if (INTERACTIONS.has(className)) scan.interactions += 1;
		if (BACKPACK_ITEMS.has(className)) scan.tools += 1;
		if (className === "Sound") scan.sounds += 1;
	}
	return scan;
}

export interface SanitizeOptions {
	keepScripts: boolean;
	anchor: boolean;
}

export interface SanitizeReport {
	removed: { scripts: number; remotes: number; other: number };
	kept: { scripts: number };
	toolsConverted: number;
	soundsStopped: number;
	partsAnchored: number;
}

/** What `options` removes from an instance, or undefined when it stays. */
function removalOf(instance: Instance, options: SanitizeOptions): "scripts" | "remotes" | "other" | undefined {
	const className = instance.ClassName;
	if (instance.IsA("LuaSourceContainer")) return options.keepScripts && isKeepableScript(instance) ? undefined : "scripts";
	if (REMOTES.has(className)) return "remotes";
	if (BINDABLES.has(className)) return options.keepScripts ? undefined : "remotes";
	if (ALWAYS_REMOVED.has(className)) return "other";
	if (INTERACTIONS.has(className)) return options.keepScripts ? undefined : "other";
	return undefined;
}

/** Strips an (unparented) asset in place. Run `leftovers` after it. */
export function sanitizeAsset(root: Instance, options: SanitizeOptions): SanitizeReport {
	const report: SanitizeReport = { removed: { scripts: 0, remotes: 0, other: 0 }, kept: { scripts: 0 }, toolsConverted: 0, soundsStopped: 0, partsAnchored: 0 };
	// Removals first. GetDescendants lists ancestors before descendants, so a removed container is seen first and what
	// it holds goes with it (counted once: scripts inside it count as scripts).
	const doomed = new Set<Instance>();
	const order = new Array<Instance>();
	for (const instance of root.GetDescendants()) {
		let inDoomed = false;
		for (let at = instance.Parent; at !== undefined && at !== root; at = at.Parent) {
			if (doomed.has(at)) {
				inDoomed = true;
				break;
			}
		}
		if (inDoomed) continue;
		const removal = removalOf(instance, options);
		if (removal === undefined) continue;
		for (const inner of instance.GetDescendants()) if (inner.IsA("LuaSourceContainer")) report.removed.scripts += 1;
		report.removed[removal] += 1;
		doomed.add(instance);
		order.push(instance);
	}
	for (const instance of order) instance.Destroy();
	// Backpack items become plain models (deepest first, so nested ones convert too).
	const items = root.GetDescendants().filter((instance) => BACKPACK_ITEMS.has(instance.ClassName));
	for (let index = items.size() - 1; index >= 0; index--) {
		const item = items[index];
		const model = new Instance("Model");
		model.Name = item.Name;
		for (const child of item.GetChildren()) child.Parent = model;
		model.Parent = item.Parent;
		item.Destroy();
		report.toolsConverted += 1;
	}
	for (const instance of root.GetDescendants()) {
		if (instance.IsA("Sound")) {
			instance.Playing = false;
			instance.PlayOnRemove = false;
			report.soundsStopped += 1;
		} else if (instance.IsA("BasePart") && options.anchor) {
			instance.Anchored = true;
			report.partsAnchored += 1;
		} else if (instance.IsA("LuaSourceContainer")) {
			report.kept.scripts += 1;
		}
	}
	return report;
}

/**
 * What must not be left after sanitizing: any script (strict), or with "Keep scripts" anything not keepable (a
 * LocalScript, a client-RunContext Script), a remote, a backpack item or a side-effect instance. 0 means clean.
 */
export function leftovers(root: Instance, keepScripts: boolean): number {
	let count = 0;
	for (const instance of root.GetDescendants()) {
		const className = instance.ClassName;
		if (instance.IsA("LuaSourceContainer") && !(keepScripts && isKeepableScript(instance))) count += 1;
		else if (REMOTES.has(className) || ALWAYS_REMOVED.has(className) || BACKPACK_ITEMS.has(className)) count += 1;
		else if (!keepScripts && (BINDABLES.has(className) || INTERACTIONS.has(className))) count += 1;
	}
	return count;
}
