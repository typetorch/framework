import type { DexNode, DexProperty } from "./protocol";

/** Shared by the client dex (local tree) and the server dex (requests from a dev). */

const MAX_CHILDREN = 200;
const EDITABLE = new Set(["string", "number", "boolean"]);

export function resolvePath(path: string[]): Instance | undefined {
	let node: Instance = game;
	for (const name of path) {
		const child = node.FindFirstChild(name);
		if (!child) return undefined;
		node = child;
	}
	return node;
}

export function listChildren(instance: Instance): DexNode[] {
	const nodes = new Array<DexNode>();
	const [ok, children] = pcall(() => instance.GetChildren());
	if (!ok) return nodes;
	for (const child of children) {
		if (nodes.size() >= MAX_CHILDREN) break;
		const [countOk, count] = pcall(() => child.GetChildren().size());
		nodes.push({ name: child.Name, className: child.ClassName, children: countOk ? count : 0 });
	}
	nodes.sort((a, b) => a.name.lower() < b.name.lower());
	return nodes;
}

function describe(value: unknown): string {
	const kind = typeOf(value);
	if (kind === "Instance") return (value as Instance).GetFullName();
	if (kind === "string") return value as string;
	return tostring(value);
}

/** Properties through ReflectionService (scripts can read it since Feb 2026), plus attributes and tags. */
export function listProperties(instance: Instance): DexProperty[] {
	const properties = new Array<DexProperty>();
	const reflection = game.GetService("ReflectionService");
	const [ok, reflected] = pcall(() => reflection.GetPropertiesOfClass(instance.ClassName) as unknown as { Name: string }[]);
	if (ok && reflected) {
		const seen = new Set<string>();
		for (const entry of reflected) {
			const name = entry.Name;
			if (!typeIs(name, "string") || seen.has(name)) continue;
			seen.add(name);
			const [readOk, value] = pcall(() => (instance as unknown as Record<string, unknown>)[name]);
			if (!readOk) continue;
			properties.push({ name, value: describe(value).sub(1, 300), kind: typeOf(value) });
		}
	} else {
		for (const name of ["Name", "ClassName", "Parent"]) {
			const value = (instance as unknown as Record<string, unknown>)[name];
			properties.push({ name, value: describe(value), kind: typeOf(value) });
		}
	}
	properties.sort((a, b) => a.name < b.name);
	for (const [name, value] of instance.GetAttributes()) {
		properties.push({ name: `@${name}`, value: describe(value).sub(1, 300), kind: typeOf(value) });
	}
	const tags = instance.GetTags();
	if (tags.size() > 0) properties.push({ name: "#tags", value: tags.join(", "), kind: "tags" });
	return properties;
}

/** Sets a string/number/boolean property ("Name") or attribute ("@Name") from text. */
export function setProperty(instance: Instance, name: string, text: string): [boolean, string?] {
	const isAttribute = name.sub(1, 1) === "@";
	const key = isAttribute ? name.sub(2) : name;
	const current = isAttribute ? instance.GetAttribute(key) : (instance as unknown as Record<string, unknown>)[key];
	const kind = typeOf(current);
	if (!EDITABLE.has(kind) && !(isAttribute && current === undefined)) return [false, `${kind} values can't be edited here`];
	let value: unknown = text;
	if (kind === "number") {
		const parsed = tonumber(text);
		if (parsed === undefined) return [false, "not a number"];
		value = parsed;
	} else if (kind === "boolean") {
		value = text.lower() === "true";
	}
	const [ok, err] = pcall(() => {
		if (isAttribute) instance.SetAttribute(key, value as AttributeValue);
		else (instance as unknown as Record<string, unknown>)[key] = value;
	});
	return ok ? [true] : [false, tostring(err)];
}
