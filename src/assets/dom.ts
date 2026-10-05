import { CollectionService } from "@rbxts/services";
import { assetTag, ATTR_PATH, pathSegments } from "./manifest";

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

/** The live copies tagged for `key` (normally one; two for a moment while a new version replaces the old). */
export function liveCopies(key: string): Instance[] {
	return CollectionService.GetTagged(assetTag(key)).filter(isLiveCopy);
}
