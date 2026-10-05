import { CollectionService, HttpService, InsertService } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $print, $warn } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import { liveCopies, numberAttribute, resolveParent, stringAttribute } from "./dom";
import {
	AssetEntry,
	AssetFacts,
	AssetManifest,
	AssetStatus,
	AssetSyncReport,
	assetTag,
	ATTR_HASH,
	ATTR_ID,
	ATTR_KEY,
	ATTR_PATH,
	ATTR_VERSION,
	decideAsset,
	keyOfTag,
	parseManifest,
	summarizeAssets,
} from "./manifest";

/**
 * AssetSync (plans/13 "Hot assets"): the server built-in that runs on every generation start, before any module loads.
 * It makes the place match the artifact's asset manifest, key by key (manifest.ts `decideAsset`): keep the live copy,
 * adopt the place's baked copy, or LoadAssetVersion the manifest's version, then destroy the copy it replaced.
 *
 * Hot assets are deliberately NOT in a generation trove: tags and instances outlive swaps, a swap changes them only when
 * the manifest changes, and a rollback restores older versions by `ver`. Keys the manifest doesn't name are left as
 * they are (builders' content). Replicated assets reach clients through replication; clients never ask for anything.
 */

/** Seconds AssetSync may hold a generation's start. Loads still running then keep going and swap in when they finish. */
export const ASSET_SYNC_TIMEOUT = 8;
/** The JSON attribute the CLI stamps (plans/13 "In the artifact"). */
const MANIFEST_ATTRIBUTE = "Assets";
const MAX_UNMANAGED = 50;
const MAX_REPORTED = 300;

let report: AssetSyncReport = emptyReport();
const entryByKey = new Map<string, AssetEntry>();
const keyById = new Map<number, string>();
/** Bumped by every sync and when its generation stops: a load that finishes for an older one never applies. */
let epoch = 0;

function emptyReport(): AssetSyncReport {
	return { manifest: "none", errors: [], running: false, entries: [], unmanaged: [] };
}

function shortError(err: unknown): string {
	const text = tostring(err);
	return text.size() > 200 ? `${text.sub(1, 200)}...` : text;
}

/** The running manifest's entry for a key (server; undefined without a manifest). */
export function manifestEntry(key: string): AssetEntry | undefined {
	return entryByKey.get(key);
}

/** The key the running manifest gives an asset id (server). */
export function keyForAssetId(id: number): string | undefined {
	return keyById.get(id);
}

/** The last sync, for the dev menu (op "assets"; at most 300 keys, to keep the reply small). */
export function assetReport(): AssetSyncReport {
	if (report.entries.size() <= MAX_REPORTED) return report;
	const entries = new Array<AssetStatus>();
	for (let index = 0; index < MAX_REPORTED; index++) entries.push(report.entries[index]);
	return { ...report, entries };
}

/** Failures and manifest problems for Server > Status (devtools ServerFacts.assets). */
export function assetFacts(): AssetFacts | undefined {
	return summarizeAssets(report);
}

function setManifest(manifest: AssetManifest | undefined) {
	entryByKey.clear();
	keyById.clear();
	for (const entry of manifest?.entries ?? []) {
		entryByKey.set(entry.key, entry);
		keyById.set(entry.id, entry.key);
	}
}

/** The generation's mount (`<artifactId>#<n>`), which holds this framework copy under include/. */
function mountRoot(): Instance | undefined {
	let node: Instance | undefined = script.Parent;
	while (node !== undefined && node !== game) {
		if (node.GetAttribute("ArtifactId") !== undefined && node.FindFirstChild("Server") !== undefined) return node;
		node = node.Parent;
	}
	return undefined;
}

/** Like the kernel's findPayloadRoot: the Model holding Server and Client. */
function payloadRoot(container: Instance): Instance | undefined {
	if (container.FindFirstChild("Server") && container.FindFirstChild("Client")) return container;
	for (const descendant of container.GetDescendants()) {
		if (descendant.IsA("Model") && descendant.FindFirstChild("Server") && descendant.FindFirstChild("Client")) return descendant;
	}
	return undefined;
}

interface Outcome {
	done: boolean;
	ok?: boolean;
	value?: unknown;
}

/** Runs `callback` in its own thread and waits for it until `deadline` (os.clock); a late thread is cancelled. */
function within(deadline: number, callback: () => unknown): Outcome {
	const outcome: Outcome = { done: false };
	const thread = task.spawn(() => {
		const [ok, value] = pcall(callback);
		outcome.ok = ok;
		outcome.value = value;
		outcome.done = true;
	});
	while (!outcome.done && os.clock() < deadline) task.wait();
	if (!outcome.done && coroutine.status(thread) === "suspended") task.cancel(thread);
	return outcome;
}

interface ManifestSource {
	raw?: unknown;
	from?: string;
	error?: string;
}

/**
 * The `Assets` attribute: on the mount (if a kernel copies it there), on the payload's Server folder (it keeps its
 * attributes when the kernel mounts it), else on the payload's root Model. The kernel moves Server/Shared/Client/include
 * out of that root and drops it, so the root is read from the payload asset again (InsertService caches it per id).
 */
function readManifest(kernel: ServerKernel, deadline: number): ManifestSource {
	const root = mountRoot();
	const onMount = root?.GetAttribute(MANIFEST_ATTRIBUTE);
	if (onMount !== undefined) return { raw: onMount, from: "mount" };
	const onServer = root?.FindFirstChild("Server")?.GetAttribute(MANIFEST_ATTRIBUTE);
	if (onServer !== undefined) return { raw: onServer, from: "Server" };
	const assetId = kernel.artifact.assetId;
	if (assetId === undefined) return {};
	const outcome = within(deadline, () => {
		const container = InsertService.LoadAsset(assetId);
		const value = payloadRoot(container)?.GetAttribute(MANIFEST_ATTRIBUTE);
		container.Destroy();
		return value;
	});
	if (!outcome.done) return { error: "reading the manifest timed out" };
	if (!outcome.ok) return { error: `reading the manifest failed: ${shortError(outcome.value)}` };
	return outcome.value === undefined ? {} : { raw: outcome.value, from: "payload" };
}

/** Marks `instance` as the live copy of `entry` (attributes first, so they replicate with the tag). */
function stamp(instance: Instance, entry: AssetEntry, version: number | undefined) {
	instance.SetAttribute(ATTR_KEY, entry.key);
	instance.SetAttribute(ATTR_ID, entry.id);
	instance.SetAttribute(ATTR_VERSION, version);
	instance.SetAttribute(ATTR_PATH, entry.path);
	instance.AddTag(assetTag(entry.key));
}

/** Assets hold no scripts (plans/13); removes any that came along anyway. */
function stripScripts(root: Instance): number {
	let removed = 0;
	for (const descendant of root.GetDescendants()) {
		if (descendant.IsA("LuaSourceContainer")) {
			removed += 1;
			descendant.Destroy();
		}
	}
	return removed;
}

/** LoadAssetVersion(ver) -> the asset's root, unparented, without scripts. Yields; throws a short reason. */
function loadCopy(entry: AssetEntry): Instance {
	const container = InsertService.LoadAssetVersion(entry.ver);
	const roots = container.GetChildren();
	let root = roots.find((child) => child.GetAttribute(ATTR_KEY) === entry.key);
	if (root === undefined && roots.size() === 1) root = roots[0];
	let problem: string | undefined;
	const key = root?.GetAttribute(ATTR_KEY);
	if (root === undefined) problem = `the asset has ${roots.size()} roots`;
	else if (key !== undefined && key !== entry.key) problem = `the asset is "${tostring(key)}"`;
	else if (entry.className !== undefined && root.ClassName !== entry.className) problem = `expected a ${entry.className}, got a ${root.ClassName}`;
	else if (root.IsA("LuaSourceContainer")) problem = "the asset is a script";
	if (problem !== undefined || root === undefined) {
		container.Destroy();
		error(problem ?? "no root", 0);
	}
	root.Parent = undefined;
	container.Destroy();
	const removed = stripScripts(root);
	if (removed > 0) $warn(`hot asset ${entry.key}: removed ${removed} scripts`);
	return root;
}

interface PendingLoad {
	status: AssetStatus;
	fail: (why: string) => void;
}

function destroyEach(instances: Instance[], indexes: number[]) {
	for (const index of indexes) instances[index].Destroy();
}

/** Keep, adopt or start a load for one key. Returns the load when one started. */
function syncEntry(entry: AssetEntry, status: AssetStatus, placeMatches: boolean, ownEpoch: number, threads: thread[]): PendingLoad | undefined {
	const tag = assetTag(entry.key);
	const tagged = liveCopies(entry.key);
	const parent = resolveParent(entry.path, false);
	const baked = parent === undefined ? [] : parent.GetChildren().filter((child) => child.GetAttribute(ATTR_KEY) === entry.key && !child.HasTag(tag));
	const decision = decideAsset(
		entry,
		tagged.map((copy) => ({ version: numberAttribute(copy, ATTR_VERSION) })),
		baked.map((copy) => ({ hash: stringAttribute(copy, ATTR_HASH) })),
		placeMatches,
	);

	if (decision.action === "keep") {
		destroyEach(tagged, decision.staleTagged);
		status.source = "kept";
		status.version = entry.ver;
		status.live = true;
		return undefined;
	}
	if (decision.action === "adopt") {
		stamp(baked[decision.use!], entry, entry.ver);
		destroyEach(tagged, decision.staleTagged);
		status.source = "baked";
		status.version = entry.ver;
		status.live = true;
		return undefined;
	}

	// Load. Until it works, the old copy stays live.
	status.version = numberAttribute(tagged[tagged.size() - 1], ATTR_VERSION);
	status.live = tagged.size() > 0;
	const fallback = decision.fallbackBaked !== undefined ? baked[decision.fallbackBaked] : undefined;
	const fail = (why: string) => {
		status.source = "failed";
		status.error = why;
		// A new server whose load failed keeps the place's copy as the live one, without a version (retried next time).
		if (fallback !== undefined && fallback.Parent !== undefined && !fallback.HasTag(tag)) {
			stamp(fallback, entry, undefined);
			status.live = true;
		}
	};
	const started = os.clock();
	threads.push(
		task.spawn(() => {
			const [loaded, result] = pcall(() => loadCopy(entry));
			if (ownEpoch !== epoch) {
				// This generation stopped meanwhile; the next sync decides again.
				if (loaded) (result as Instance).Destroy();
				return;
			}
			const late = status.source === "failed";
			let placed = loaded;
			let reason = loaded ? "" : shortError(result);
			if (loaded) {
				const copy = result as Instance;
				const [ok, err] = pcall(() => {
					const target = resolveParent(entry.path, true);
					if (target === undefined) error(`no ${entry.path.split("/")[0]} service`, 0);
					stamp(copy, entry, entry.ver);
					copy.Parent = target;
				});
				placed = ok;
				if (!ok) {
					reason = shortError(err);
					copy.Destroy();
				}
			}
			if (!placed) {
				fail(reason);
				$warn(`hot asset ${entry.key} (version ${entry.n ?? entry.ver}) failed: ${reason}`);
				return;
			}
			// The new copy is live: the copies it replaces go.
			destroyEach(tagged, decision.staleTagged);
			destroyEach(baked, decision.staleBaked);
			status.source = "loaded";
			status.error = undefined;
			status.version = entry.ver;
			status.live = true;
			status.ms = math.floor((os.clock() - started) * 1000);
			if (late) {
				status.late = true;
				$print(`hot asset ${entry.key} loaded late (${status.ms} ms)`);
			}
		}),
	);
	return { status, fail };
}

/** Tagged keys the manifest doesn't name (left as they are). */
function unmanagedKeys(): string[] {
	const keys = new Array<string>();
	for (const tag of CollectionService.GetAllTags()) {
		const key = keyOfTag(tag);
		if (key !== undefined && !entryByKey.has(key) && liveCopies(key).size() > 0) keys.push(key);
		if (keys.size() >= MAX_UNMANAGED) break;
	}
	keys.sort();
	return keys;
}

function run(kernel: ServerKernel, deadline: number, ownEpoch: number, threads: thread[]) {
	const found = readManifest(kernel, deadline);
	if (found.error !== undefined) {
		report.manifest = "unread";
		report.errors.push(found.error);
		return;
	}
	report.from = found.from;
	const parsed = parseManifest(found.raw, (text) => HttpService.JSONDecode(text));
	for (const why of parsed.errors) report.errors.push(why);
	const manifest = parsed.manifest;
	if (manifest === undefined) {
		report.manifest = found.raw === undefined ? "none" : "invalid";
		report.unmanaged = unmanagedKeys();
		return;
	}
	setManifest(manifest);
	report.manifest = "ok";
	const placeMatches = manifest.placeVersion !== undefined && manifest.placeVersion === game.PlaceVersion;

	const loads = new Array<PendingLoad>();
	for (const entry of manifest.entries) {
		const status: AssetStatus = { key: entry.key, id: entry.id, wanted: entry.ver, n: entry.n, live: false, source: "loading" };
		report.entries.push(status);
		const [ok, result] = pcall(() => syncEntry(entry, status, placeMatches, ownEpoch, threads));
		if (!ok) {
			status.source = "failed";
			status.error = shortError(result);
			$warn(`hot asset ${entry.key} failed: ${status.error}`);
		} else if (result !== undefined) loads.push(result);
	}
	// Loads run in parallel; the generation waits for them until the deadline, then starts anyway.
	while (os.clock() < deadline && loads.some((load) => load.status.source === "loading")) task.wait();
	for (const load of loads) {
		if (load.status.source !== "loading") continue;
		report.timedOut = true;
		load.fail("timed out");
		$warn(`hot asset ${load.status.key}: still loading after ${ASSET_SYNC_TIMEOUT} s; the old copy stays until it finishes`);
	}
	report.unmanaged = unmanagedKeys();
}

/**
 * Runs AssetSync for a starting server generation (runtime/start.ts, before the modules load). Yields up to
 * ASSET_SYNC_TIMEOUT seconds and never throws: problems end up in the report and the Status page.
 */
export function syncHotAssets(kernel: ServerKernel, trove: Trove) {
	const started = os.clock();
	epoch += 1;
	const ownEpoch = epoch;
	const threads = new Array<thread>();
	// The generation stopped: loads still running are dropped (instances persist; the next generation syncs again).
	trove.add(() => {
		if (epoch === ownEpoch) epoch += 1;
		for (const thread of threads) {
			if (coroutine.status(thread) === "suspended") task.cancel(thread);
		}
	});
	setManifest(undefined);
	report = emptyReport();
	report.running = true;
	const [ok, err] = pcall(() => run(kernel, started + ASSET_SYNC_TIMEOUT, ownEpoch, threads));
	if (!ok) {
		report.errors.push(`AssetSync failed: ${shortError(err)}`);
		$warn(`AssetSync failed: ${err}`);
	}
	report.running = false;
	report.ms = math.floor((os.clock() - started) * 1000);
	if (report.entries.size() > 0) {
		const counts = new Map<string, number>();
		for (const status of report.entries) counts.set(status.source, (counts.get(status.source) ?? 0) + 1);
		const parts = new Array<string>();
		for (const [source, count] of counts) parts.push(`${count} ${source}`);
		parts.sort();
		$print(`hot assets: ${parts.join(", ")} in ${report.ms} ms`);
	}
}
