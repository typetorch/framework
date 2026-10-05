/**
 * Hot assets (plans/13 "Hot assets"): the artifact's asset manifest and the per-key AssetSync decision.
 *
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-hot-assets.luau). The server
 * half (assets/sync.ts) finds the instances and acts on the decision; the handles (assets/hot-asset.ts) read the tags.
 *
 * The manifest is the JSON attribute `Assets` the CLI stamps on the payload:
 * `{"v":1,"assets":{"<key>":{"id","ver","n","hash","realm","path","className"}}}` (an optional top-level
 * `placeVersion` lets a server adopt the place's copies by place version, see decideAsset).
 */

/** CollectionService tag of the live instance of a key: `__typetorch_asset:<key>`. */
export const ASSET_TAG_PREFIX = "__typetorch_asset:";
/** The key builders set in Studio (`"ui/shop"`). */
export const ATTR_KEY = "TypeTorchAsset";
/** The Roblox asset id (stamped by the export, and by AssetSync on the live instance). */
export const ATTR_ID = "TypeTorchAssetId";
/** First 12 hex of the SHA-256 of the exported bytes (stamped by the export). */
export const ATTR_HASH = "TypeTorchAssetHash";
/** The assetVersionId of the live instance (AssetSync). */
export const ATTR_VERSION = "TypeTorchAssetVersion";
/**
 * The parent path the live instance was placed at (AssetSync). Clones keep tags and attributes, so a game's clones of
 * a template are tagged too: only an instance whose Parent is still this path counts as the live one.
 */
export const ATTR_PATH = "TypeTorchAssetPath";

export const MAX_KEY_LENGTH = 64;
const MAX_ASSETS = 1000;
const MAX_ERRORS = 20;
const MAX_PATH_DEPTH = 20;
const MAX_SEGMENT = 100;
const MAX_MANIFEST_BYTES = 512 * 1024;

export type AssetRealm = "replicated" | "server";

/** One manifest entry (one key), validated. */
export interface AssetEntry {
	readonly key: string;
	/** The Roblox asset id (a group-owned Model; stays the same for every version of the key). */
	readonly id: number;
	/** The assetVersionId LoadAssetVersion loads (pins the version; a rollback brings back an older one). */
	readonly ver: number;
	/** The asset's version number (1, 2, 3...), for people. */
	readonly n?: number;
	/** 12 lowercase hex characters. */
	readonly hash: string;
	readonly realm: AssetRealm;
	/** The parent path, e.g. "ReplicatedStorage/Assets/UI" (the first segment is a service). */
	readonly path: string;
	/** The root's ClassName, when the lockfile has it (a load of another class fails). */
	readonly className?: string;
}

export interface AssetManifest {
	/** Sorted by key. */
	readonly entries: AssetEntry[];
	/** The place version the export ran against, if the CLI stamped it (see decideAsset). */
	readonly placeVersion?: number;
}

export interface ParsedManifest {
	/** Undefined when there is no usable manifest (no attribute, or an unusable one: see errors). */
	manifest?: AssetManifest;
	/** What was wrong (at most 20 lines); entries with a problem are skipped. */
	errors: string[];
}

export function assetTag(key: string): string {
	return ASSET_TAG_PREFIX + key;
}

/** The key of a hot-asset tag, or undefined for other tags. */
export function keyOfTag(tag: string): string | undefined {
	if (tag.sub(1, ASSET_TAG_PREFIX.size()) !== ASSET_TAG_PREFIX) return undefined;
	const key = tag.sub(ASSET_TAG_PREFIX.size() + 1);
	return isAssetKey(key) ? key : undefined;
}

/** Lowercase `a-z 0-9 / - _`, 1 to 64 characters. */
export function isAssetKey(value: unknown): value is string {
	if (!typeIs(value, "string") || value.size() === 0 || value.size() > MAX_KEY_LENGTH) return false;
	return value.match("^[a-z0-9/_%-]+$")[0] !== undefined;
}

/** A positive whole number below 2^53, from a number or a decimal string (ids may travel as strings). */
export function wholeNumber(value: unknown): number | undefined {
	let number: unknown = value;
	if (typeIs(value, "string")) {
		if (value.size() === 0 || value.size() > 16 || value.match("^%d+$")[0] === undefined) return undefined;
		number = tonumber(value);
	}
	if (!typeIs(number, "number") || number !== number || number < 1 || number % 1 !== 0 || number >= 2 ** 53) return undefined;
	return number;
}

/** "ReplicatedStorage/Assets/UI" -> its segments; undefined when empty segments, too deep or too long. */
export function pathSegments(path: unknown): string[] | undefined {
	if (!typeIs(path, "string") || path.size() === 0 || path.size() > MAX_PATH_DEPTH * (MAX_SEGMENT + 1)) return undefined;
	const parts = path.split("/");
	if (parts.size() > MAX_PATH_DEPTH) return undefined;
	for (const part of parts) {
		if (part.size() === 0 || part.size() > MAX_SEGMENT) return undefined;
	}
	return parts;
}

/** ServerStorage and ServerScriptService are "server"; everything else replicates. */
export function realmOfPath(path: string): AssetRealm {
	const first = path.split("/")[0];
	return first === "ServerStorage" || first === "ServerScriptService" ? "server" : "replicated";
}

function short(text: string): string {
	return text.size() > 40 ? `${text.sub(1, 40)}...` : text;
}

/**
 * Reads the `Assets` attribute value. Never throws: no attribute (undefined) is no manifest and no error; an unusable
 * attribute is no manifest plus errors; bad entries are skipped with an error each.
 */
export function parseManifest(raw: unknown, decode: (text: string) => unknown): ParsedManifest {
	const errors = new Array<string>();
	const note = (why: string) => {
		if (errors.size() < MAX_ERRORS) errors.push(why);
	};
	if (raw === undefined) return { errors };
	if (!typeIs(raw, "string")) {
		note("Assets is not a string");
		return { errors };
	}
	if (raw.size() > MAX_MANIFEST_BYTES) {
		note("Assets is too long");
		return { errors };
	}
	const [ok, data] = pcall(() => decode(raw));
	if (!ok || !typeIs(data, "table")) {
		note("Assets is not JSON");
		return { errors };
	}
	const root = data as { v?: unknown; assets?: unknown; placeVersion?: unknown };
	if (root.v !== 1) {
		note(`Assets version ${short(tostring(root.v))} is unknown`);
		return { errors };
	}
	if (root.assets !== undefined && !typeIs(root.assets, "table")) {
		note("Assets has no assets map");
		return { errors };
	}

	const keys = new Array<string>();
	let count = 0;
	if (root.assets !== undefined) {
		for (const [key] of pairs(root.assets as Record<string, unknown>)) {
			count += 1;
			if (count > MAX_ASSETS) {
				note(`more than ${MAX_ASSETS} assets; the rest are ignored`);
				break;
			}
			if (isAssetKey(key)) keys.push(key);
			else note(`bad key ${short(tostring(key))}`);
		}
	}
	keys.sort();

	const entries = new Array<AssetEntry>();
	const idOwners = new Map<number, string>();
	const assets = root.assets as Record<string, unknown>;
	for (const key of keys) {
		const raw = assets[key];
		if (!typeIs(raw, "table")) {
			note(`${key}: not an object`);
			continue;
		}
		const item = raw as Record<string, unknown>;
		const id = wholeNumber(item.id);
		const ver = wholeNumber(item.ver);
		const hash = typeIs(item.hash, "string") ? item.hash.lower() : undefined;
		const segments = pathSegments(item.path);
		if (id === undefined) note(`${key}: bad id`);
		else if (ver === undefined) note(`${key}: bad ver`);
		else if (hash === undefined || hash.size() !== 12 || hash.match("^[0-9a-f]+$")[0] === undefined) note(`${key}: bad hash`);
		else if (segments === undefined) note(`${key}: bad path`);
		else if (item.realm !== undefined && item.realm !== "replicated" && item.realm !== "server") note(`${key}: bad realm`);
		else if (item.className !== undefined && (!typeIs(item.className, "string") || item.className.size() === 0 || item.className.size() > 100)) {
			note(`${key}: bad className`);
		} else if (idOwners.has(id)) note(`${key}: id ${id} is also ${idOwners.get(id)}`);
		else {
			idOwners.set(id, key);
			const path = item.path as string;
			entries.push({
				key,
				id,
				ver,
				n: wholeNumber(item.n),
				hash,
				realm: item.realm === "server" || item.realm === "replicated" ? item.realm : realmOfPath(path),
				path,
				className: item.className as string | undefined,
			});
		}
	}
	return { manifest: { entries, placeVersion: wholeNumber(root.placeVersion) }, errors };
}

// The decision --------------------------------------------------------------------------------------------------------

/** A live (tagged) copy of the key: its TypeTorchAssetVersion. Only copies whose Parent is their own path count. */
export interface TaggedCopy {
	version?: number;
}

/** An untagged copy of the key under the entry's path (the place's baked copy): its TypeTorchAssetHash. */
export interface BakedCopy {
	hash?: string;
}

export interface AssetDecision {
	/**
	 * keep: a tagged copy already has the manifest version; adopt: tag the place's baked copy; load: LoadAssetVersion.
	 */
	action: "keep" | "adopt" | "load";
	/** keep: the index in `tagged`; adopt: the index in `baked`. */
	use?: number;
	/** Tagged copies to destroy once the chosen one is live (keep, adopt: at once; load: after the load worked). */
	staleTagged: number[];
	/** load: baked copies of this key the loaded one supersedes (destroyed after the load worked). */
	staleBaked: number[];
	/**
	 * load: when it fails and nothing is tagged yet, tag this baked copy without a version, so `get()` still finds the
	 * place's copy (the next generation retries the load).
	 */
	fallbackBaked?: number;
}

function indexes(count: number, except?: number): number[] {
	const list = new Array<number>();
	for (let index = 0; index < count; index++) {
		if (index !== except) list.push(index);
	}
	return list;
}

/**
 * What AssetSync does for one key:
 * 1. keep the tagged copy whose TypeTorchAssetVersion is the manifest's `ver` (the newest one if several);
 * 2. else adopt the baked copy whose TypeTorchAssetHash is the manifest's hash, or, when `placeMatches` (the manifest
 *    names this server's place version, so the place holds exactly what was exported) the only baked copy;
 * 3. else load `ver`, then destroy every other tagged copy and the superseded baked copies.
 */
export function decideAsset(entry: AssetEntry, tagged: readonly TaggedCopy[], baked: readonly BakedCopy[], placeMatches = false): AssetDecision {
	for (let index = tagged.size() - 1; index >= 0; index--) {
		if (tagged[index].version === entry.ver) {
			return { action: "keep", use: index, staleTagged: indexes(tagged.size(), index), staleBaked: [] };
		}
	}
	let adopt: number | undefined;
	for (let index = 0; index < baked.size(); index++) {
		const hash = baked[index].hash;
		if (typeIs(hash, "string") && hash.lower() === entry.hash) {
			adopt = index;
			break;
		}
	}
	if (adopt === undefined && placeMatches && baked.size() === 1) adopt = 0;
	if (adopt !== undefined) return { action: "adopt", use: adopt, staleTagged: indexes(tagged.size()), staleBaked: [] };
	return {
		action: "load",
		staleTagged: indexes(tagged.size()),
		staleBaked: indexes(baked.size()),
		fallbackBaked: tagged.size() === 0 && baked.size() > 0 ? 0 : undefined,
	};
}

// Status (devtools op "assets", Server > Status) ------------------------------------------------------------------------

/** kept: already live with the manifest version; baked: the place's copy adopted; loaded; failed (see `error`). */
export type AssetSource = "baked" | "loaded" | "kept" | "failed" | "loading";

export interface AssetStatus {
	key: string;
	id: number;
	/** The manifest's assetVersionId. */
	wanted: number;
	/** Its version number, if the manifest has it. */
	n?: number;
	/** The live copy's TypeTorchAssetVersion (after a failure: the old copy's, or undefined). */
	version?: number;
	/** Something is tagged for the key now (a failure keeps the old copy, or the place's copy). */
	live: boolean;
	source: AssetSource;
	error?: string;
	/** Load time. */
	ms?: number;
	/** Loaded after the start-up wait ran out. */
	late?: boolean;
}

export interface AssetSyncReport {
	/** none: the artifact has no Assets attribute; invalid: unusable; unread: reading it failed (see errors). */
	manifest: "none" | "ok" | "invalid" | "unread";
	/** Where the manifest was found: "mount", "Server" (the payload's Server folder) or "payload" (re-read). */
	from?: string;
	errors: string[];
	/** AssetSync is still holding the generation's start. */
	running: boolean;
	ms?: number;
	/** The start-up wait ran out before every load finished (late loads still swap in). */
	timedOut?: boolean;
	entries: AssetStatus[];
	/** Tagged keys this manifest doesn't name: left as they are. */
	unmanaged: string[];
}

/** What Server > Status needs (devtools ServerFacts.assets). */
export interface AssetFacts {
	failed: number;
	/** Failed with nothing live for the key. */
	missing: number;
	/** "key: error" of the first failure. */
	first?: string;
	manifestError?: string;
}

export function summarizeAssets(report: AssetSyncReport): AssetFacts | undefined {
	if (report.manifest === "none" && report.errors.size() === 0) return undefined;
	let failed = 0;
	let missing = 0;
	let first: string | undefined;
	for (const status of report.entries) {
		if (status.source !== "failed") continue;
		failed += 1;
		if (!status.live) missing += 1;
		if (first === undefined) first = `${status.key}: ${status.error ?? "failed"}`;
	}
	return { failed, missing, first, manifestError: report.errors[0] };
}
