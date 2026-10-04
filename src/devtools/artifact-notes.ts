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

/**
 * The payload root's `Notes` attribute (stamped by the CLI at build time; attributes aren't text-filtered, unlike the
 * asset description): `{"v":1,"message","changes":[],"sources":{"template","framework","kernel"},"built","branch"}`.
 */
export function notesFromAttribute(json: string, decode: (text: string) => unknown): ArtifactNotes | undefined {
	const [ok, value] = pcall(() => decode(json));
	if (!ok || !typeIs(value, "table")) return undefined;
	const data = value as {
		message?: unknown;
		changes?: unknown;
		sources?: { template?: unknown; framework?: unknown; kernel?: unknown };
		built?: unknown;
		branch?: unknown;
	};
	const identity: Record<string, string> = {};
	const put = (key: string, raw: unknown) => {
		if (typeIs(raw, "string") && raw !== "") identity[key] = raw.sub(1, 200);
	};
	if (typeIs(data.sources, "table")) {
		put("commit", data.sources.template);
		put("framework", data.sources.framework);
		put("kernel", data.sources.kernel);
	}
	put("built", data.built);
	put("branch", data.branch);
	const changes = new Array<string>();
	if (typeIs(data.message, "string") && data.message !== "") changes.push(data.message.sub(1, 200));
	if (typeIs(data.changes, "table")) {
		for (const [, line] of pairs(data.changes as object)) {
			if (typeIs(line, "string") && line !== "" && changes.size() < 12 && !changes.includes(line)) changes.push(line.sub(1, 200));
		}
	}
	return { identity, changes };
}
