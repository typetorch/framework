import { CollectionService } from "@rbxts/services";
import { ASSET_TAG_PREFIX, assetTag, ATTR_PATH, pathSegments } from "./manifest";

/** Hot assets: instance helpers shared by AssetSync (server) and the handles (both realms). */

/** A number attribute, or undefined. */
export function numberAttribute(instance: Instance | undefined, name: string): number | undefined {
	const value = instance?.GetAttribute(name);
	return typeIs(value, "number") ? value : undefined;
}

/** A string attribute, or undefined. */
export function stringAttribute(instance: Instance | undefined, name: string): string | undefined {
	const value = instance?.GetAttribute(name);
	return typeIs(value, "string") ? value : undefined;
}

/**
 * The instance at a parent path ("ReplicatedStorage/Assets/UI"). The first segment must be a service; `create` makes
 * the missing Folders below it (never a service, never a replacement of something that exists).
 */
export function resolveParent(path: string, create: boolean): Instance | undefined {
	const segments = pathSegments(path);
	if (segments === undefined) return undefined;
	const [found, service] = pcall(() => game.FindService(segments[0]));
	let current: Instance | undefined = found ? service : undefined;
	if (current === undefined && create) {
		const [ok, made] = pcall(() => game.GetService(segments[0] as keyof Services));
		current = ok ? made : undefined;
	}
	if (current === undefined || current.Parent !== game) return undefined;
	for (let index = 1; index < segments.size(); index++) {
		let child: Instance | undefined = current.FindFirstChild(segments[index]);
		if (child === undefined) {
			if (!create) return undefined;
			child = new Instance("Folder");
			child.Name = segments[index];
			child.Parent = current;
		}
		current = child;
	}
	return current;
}

/**
 * The live copy of a key sits where AssetSync put it: its Parent is its own TypeTorchAssetPath. Clones of it (a game
 * cloning a UI template into PlayerGui) keep the tag and the attributes but live elsewhere, so they never count.
 */
export function isLiveCopy(instance: Instance): boolean {
	const path = stringAttribute(instance, ATTR_PATH);
	const parent = instance.Parent;
	return path !== undefined && parent !== undefined && resolveParent(path, false) === parent;
}

/**
 * Copies the CollectionService tags of `from` and its descendants onto the instances at the same place in `to` (matched
 * by name, and by order among siblings of the same name); AssetSync's own `__typetorch_asset:` tags stay out. A loaded
 * hot-asset version arrives without the tags its place copy has (2026-10-13: a game that finds its UI by tag lost it
 * on every server that loaded the uploads), so the load gives them back from the place's copy before it goes live.
 * Returns how many tags were added.
 */
export function restoreTags(from: Instance, to: Instance): number {
	let added = 0;
	const visit = (source: Instance, target: Instance) => {
		for (const tag of source.GetTags()) {
			if (tag.sub(1, ASSET_TAG_PREFIX.size()) === ASSET_TAG_PREFIX || target.HasTag(tag)) continue;
			target.AddTag(tag);
			added += 1;
		}
		const byName = new Map<string, Instance[]>();
		for (const child of target.GetChildren()) {
			const list = byName.get(child.Name);
			if (list === undefined) byName.set(child.Name, [child]);
			else list.push(child);
		}
		const seen = new Map<string, number>();
		for (const child of source.GetChildren()) {
			const index = seen.get(child.Name) ?? 0;
			seen.set(child.Name, index + 1);
			const match = byName.get(child.Name)?.[index];
			if (match !== undefined) visit(child, match);
		}
	};
	visit(from, to);
	return added;
}

/** The live copies tagged for `key` (normally one; two for a moment while a new version replaces the old). */
export function liveCopies(key: string): Instance[] {
	return CollectionService.GetTagged(assetTag(key)).filter(isLiveCopy);
}
