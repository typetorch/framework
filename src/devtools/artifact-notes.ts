/**
 * What changed in an artifact, read from its payload asset's description. The CLI writes it (cli naming.ts
 * `assetDescription`): `key=value` identity lines (artifact, commit, branch, channel, built, framework, kernel, ...),
 * then a `---` line and up to about 8 short change lines. Older artifacts have identity lines only.
 */
export interface ArtifactNotes {
	identity: Record<string, string>;
	changes: string[];
}

export function parseArtifactNotes(description: string): ArtifactNotes {
	const identity: Record<string, string> = {};
	const changes = new Array<string>();
	let inChanges = false;
	for (const raw of description.split("\n")) {
		const line = raw.gsub("\r", "")[0];
		if (line === "---") {
			inChanges = true;
			continue;
		}
		if (inChanges) {
			if (line !== "" && changes.size() < 12) changes.push(line.sub(1, 200));
			continue;
		}
		const [key, value] = line.match("^([%w_]+)=(.*)$") as LuaTuple<[string?, string?]>;
		if (key !== undefined && value !== undefined) identity[key] = value.sub(1, 200);
	}
	return { identity, changes };
}
