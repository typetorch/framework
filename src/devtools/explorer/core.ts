import { CLASS_ICONS } from "./icons";

/**
 * Explorer core, shared by both realms: the server runs these handlers per dev (explorer-server.ts) and the client runs
 * the same handlers over its local DataModel (no requests). Instances travel as ids from a Registry, so duplicate
 * names are never ambiguous; values travel as a kind tag plus text and are parsed (validated) where they are applied.
 */

export type Realm = "client" | "server";
export type Kind =
	| "boolean"
	| "number"
	| "string"
	| "Vector2"
	| "Vector3"
	| "UDim"
	| "UDim2"
	| "Color3"
	| "Enum"
	| "Instance"
	| "other";

/** One tree row. `parent` is the parent's id (0 = game). */
export interface Row {
	id: number;
	name: string;
	className: string;
	childCount: number;
	parent: number;
}

export interface ChildrenPage {
	id: number;
	rows: Row[];
	total: number;
	offset: number;
	/** The id is no longer valid (destroyed or swept). */
	gone?: boolean;
}

/** A property or attribute row. Rows arrive sorted by category, then layout order, then name. */
export interface PropRow {
	name: string;
	category: string;
	kind: Kind;
	text: string;
	readOnly: boolean;
	deprecated: boolean;
	enumType?: string;
	/** Instance values: the referenced instance's id (select it in the tree). */
	ref?: number;
}

export interface PropsReply {
	id: number;
	name: string;
	className: string;
	path: string;
	props: PropRow[];
	attrs: PropRow[];
	tags: string[];
}

/** One search hit: its row plus the names from the search root down to it. */
export interface FindHit {
	row: Row;
	path: string[];
}

export interface FindPage {
	hits: FindHit[];
	/** No more pages (walk finished, capped or cancelled). */
	done: boolean;
	/** Stopped at the hit or visit cap. */
	capped: boolean;
}

interface FindState {
	token: number;
	needle: string;
	root: Instance;
	queue: Instance[];
	head: number;
	visits: number;
	hits: number;
}

export type Handler = (payload: unknown) => unknown;

export const PAGE = 500;
const MAX_PAGE = 2000;
const MAX_IDS = 100_000;
const SWEEP_EVERY = 5000;
const FIND_HITS = 500;
const FIND_VISITS = 20_000;
const FIND_PAGE_VISITS = 2000;
const FIND_PAGE_HITS = 100;
/** Find pages: a burst of 12, then 5 per second. */
const FIND_BURST = 12;
const FIND_RATE = 5;
/** Kinds the property grid can edit (Instance links and "other" are read-only). */
export const EDITABLE = new Set<Kind>(["boolean", "number", "string", "Vector2", "Vector3", "UDim", "UDim2", "Color3", "Enum"]);
/** Properties never shown (legacy physics aliases that read as noise). */
const HIDDEN = new Set(["Velocity", "RotVelocity"]);
const CATEGORIES = ["Data", "Appearance", "Text", "Image", "Behavior", "Transform", "Pivot", "Collision", "Part"];
const DECLARED: Record<string, Kind> = {
	bool: "boolean",
	boolean: "boolean",
	float: "number",
	double: "number",
	int: "number",
	int64: "number",
	number: "number",
	string: "string",
	Vector2: "Vector2",
	Vector3: "Vector3",
	UDim: "UDim",
	UDim2: "UDim2",
	Color3: "Color3",
	Instance: "Instance",
	Object: "Instance",
	EnumItem: "Enum",
};
const ACTUAL: Record<string, Kind> = { ...DECLARED, EnumItem: "Enum", Instance: "Instance" };

const reflection = game.GetService("ReflectionService");

// Classes ----------------------------------------------------------------------------------------------------------

const superclasses = new Map<string, string | false>();
function superclassOf(className: string): string | undefined {
	let cached = superclasses.get(className);
	if (cached === undefined) {
		const [ok, info] = pcall(() => reflection.GetClass(className) as { Superclass?: string } | undefined);
		cached = (ok && info && typeIs(info.Superclass, "string") && info.Superclass) || false;
		superclasses.set(className, cached);
	}
	return cached === false ? undefined : cached;
}

const classCache = new Map<string, [number, number]>();
/** [icon index, explorer order], inherited from the nearest superclass that sets them. */
export function classInfo(className: string): [number, number] {
	let info = classCache.get(className);
	if (info) return info;
	let icon = -1;
	let order = -1;
	let current: string | undefined = className;
	for (let depth = 0; current !== undefined && depth < 24 && (icon < 0 || order < 0); depth++) {
		const entry = CLASS_ICONS[current];
		if (entry && icon < 0) icon = entry[0];
		if (entry && order < 0) order = entry[1];
		current = superclassOf(current);
	}
	info = [math.max(icon, 0), order < 0 ? 999 : order];
	classCache.set(className, info);
	return info;
}

interface Named {
	name: string;
	className: string;
}

/** Explorer order (ExplorerOrder, then name), as a table.sort comparator. */
export function rowBefore(a: Named, b: Named): boolean {
	const orderA = classInfo(a.className)[1];
	const orderB = classInfo(b.className)[1];
	return orderA !== orderB ? orderA < orderB : a.name.lower() < b.name.lower();
}

// Values -----------------------------------------------------------------------------------------------------------

export function num(value: number): string {
	if (value !== value || math.abs(value) === math.huge) return tostring(value);
	if (value % 1 === 0 && math.abs(value) < 1e15) return "%d".format(value);
	return "%.3f".format(value).gsub("0+$", "")[0];
}

function trim(text: string): string {
	return text.gsub("^%s+", "")[0].gsub("%s+$", "")[0];
}

function numbers(text: string, count: number): number[] | undefined {
	const parts = text.split(",");
	if (parts.size() !== count) return undefined;
	const values = new Array<number>();
	for (const part of parts) {
		const value = tonumber(trim(part));
		if (value === undefined || value !== value || math.abs(value) === math.huge) return undefined;
		values.push(value);
	}
	return values;
}

export function enumItems(enumType: string): EnumItem[] {
	const [ok, items] = pcall(() => (Enum as unknown as Record<string, { GetEnumItems(): EnumItem[] }>)[enumType].GetEnumItems());
	return ok ? items : [];
}

/** "Material" for Enum.Material.Plastic (tostring of an EnumType may or may not carry the "Enum." prefix). */
export function enumName(item: EnumItem): string {
	return tostring(item.EnumType).gsub("^Enum%.", "")[0];
}

export function kindOf(value: unknown): Kind {
	return ACTUAL[typeOf(value)] ?? "other";
}

/** The ReflectionService type wins when it agrees with the live value (or the value is nil); else the value's type. */
function chooseKind(declared: Kind | undefined, value: unknown): Kind {
	if (value === undefined) return declared ?? "other";
	const actual = kindOf(value);
	return declared === actual ? declared : actual;
}

/** Text for a value, matching what decode() parses back. */
export function encode(value: unknown): string {
	switch (typeOf(value)) {
		case "nil":
			return "nil";
		case "number":
			return num(value as number);
		case "string":
			return value as string;
		case "Vector2": {
			const v = value as Vector2;
			return `${num(v.X)}, ${num(v.Y)}`;
		}
		case "Vector3": {
			const v = value as Vector3;
			return `${num(v.X)}, ${num(v.Y)}, ${num(v.Z)}`;
		}
		case "UDim": {
			const v = value as UDim;
			return `${num(v.Scale)}, ${num(v.Offset)}`;
		}
		case "UDim2": {
			const v = value as UDim2;
			return `${num(v.X.Scale)}, ${num(v.X.Offset)}, ${num(v.Y.Scale)}, ${num(v.Y.Offset)}`;
		}
		case "Color3": {
			const v = value as Color3;
			return `${math.round(v.R * 255)}, ${math.round(v.G * 255)}, ${math.round(v.B * 255)}`;
		}
		case "EnumItem":
			return (value as EnumItem).Name;
		case "Instance":
			return (value as Instance).GetFullName();
		default:
			return tostring(value).sub(1, 300);
	}
}

/** Parses `text` as `kind`. Returns [true, value] or [false, reason]. */
export function decode(kind: Kind, text: string, enumType?: string): [boolean, unknown] {
	const fail = (reason: string): [boolean, unknown] => [false, reason];
	if (kind === "string") return [true, text];
	if (kind === "boolean") return text === "true" || text === "false" ? [true, text === "true"] : fail("true or false");
	if (kind === "Enum") {
		for (const item of enumItems(enumType ?? "")) if (item.Name === text) return [true, item];
		return fail(`not a ${enumType} item`);
	}
	const counts: Partial<Record<Kind, number>> = { number: 1, Vector2: 2, UDim: 2, Vector3: 3, Color3: 3, UDim2: 4 };
	const count = counts[kind];
	if (count === undefined) return fail(`${kind} values can't be edited`);
	const n = numbers(text, count);
	if (!n) return fail(count === 1 ? "not a number" : `expected ${count} numbers`);
	if (kind === "number") return [true, n[0]];
	if (kind === "Vector2") return [true, new Vector2(n[0], n[1])];
	if (kind === "UDim") return [true, new UDim(n[0], n[1])];
	if (kind === "Vector3") return [true, new Vector3(n[0], n[1], n[2])];
	if (kind === "UDim2") return [true, new UDim2(n[0], n[1], n[2], n[3])];
	const byte = (value: number) => math.clamp(math.round(value), 0, 255);
	return [true, Color3.fromRGB(byte(n[0]), byte(n[1]), byte(n[2]))];
}

// Reflection -------------------------------------------------------------------------------------------------------

interface ReflectedProperty {
	Name?: string;
	Type?: { ScriptType?: string; EngineType?: string; EnumType?: string };
	Display?: { Category?: string; LayoutOrder?: number; DeprecationMessage?: string };
	Permits?: { Write?: unknown };
}

interface PropMeta {
	name: string;
	category: string;
	rank: number;
	order: number;
	writable: boolean;
	deprecated: boolean;
	declared?: Kind;
	enumType?: string;
}

function declaredKind(name: string | undefined): [Kind | undefined, string | undefined] {
	if (!typeIs(name, "string")) return [undefined, undefined];
	const clean = name.gsub("%?$", "")[0];
	if (clean.sub(1, 5) === "Enum.") return ["Enum", clean.sub(6)];
	return [DECLARED[clean], undefined];
}

const metaCache = new Map<string, PropMeta[]>();
/** ReflectionService properties of a class, cached, sorted by category rank, layout order and name. */
export function propsOf(className: string): PropMeta[] {
	const cached = metaCache.get(className);
	if (cached) return cached;
	const metas = new Array<PropMeta>();
	const [ok, list] = pcall(() => reflection.GetPropertiesOfClass(className) as ReflectedProperty[]);
	const seen = new Set<string>();
	for (const entry of ok && list ? list : []) {
		const name = entry.Name;
		if (!typeIs(name, "string") || seen.has(name) || HIDDEN.has(name)) continue;
		seen.add(name);
		let [declared, enumType] = declaredKind(entry.Type?.ScriptType);
		if (declared === undefined) [declared, enumType] = declaredKind(entry.Type?.EngineType);
		if (typeIs(entry.Type?.EnumType, "string")) [declared, enumType] = ["Enum", entry.Type!.EnumType.gsub("^Enum%.", "")[0]];
		const category = entry.Display?.Category ?? "Other";
		const rank = CATEGORIES.indexOf(category);
		const deprecation = entry.Display?.DeprecationMessage;
		metas.push({
			name,
			category,
			rank: rank === -1 ? 100 : rank,
			order: entry.Display?.LayoutOrder ?? 0,
			writable: entry.Permits?.Write !== undefined,
			// Lower-case names are legacy aliases (brickColor, className...): treat them as deprecated.
			deprecated: (typeIs(deprecation, "string") && deprecation !== "") || name.sub(1, 1).lower() === name.sub(1, 1),
			declared,
			enumType,
		});
	}
	metas.sort((a, b) => {
		if (a.rank !== b.rank) return a.rank < b.rank;
		if (a.category !== b.category) return a.category < b.category;
		if (a.order !== b.order) return a.order < b.order;
		return a.name < b.name;
	});
	metaCache.set(className, metas);
	return metas;
}

// Registry ---------------------------------------------------------------------------------------------------------

/**
 * Incrementing id <-> Instance, one per dev (server) or one per client. Strong maps on purpose: Roblox can collect an
 * Instance's Lua userdata while the Instance is still alive, so a weak table would drop live ids. Destroyed instances
 * are swept every few thousand new ids and the whole registry resets past MAX_IDS (the client re-roots on "gone").
 */
export class Registry {
	private nextId = 1;
	private readonly byId = new Map<number, Instance>();
	private readonly ids = new Map<Instance, number>();

	constructor() {
		this.clear();
	}

	clear() {
		this.byId.clear();
		this.ids.clear();
		this.byId.set(0, game);
		this.ids.set(game, 0);
	}

	id(instance: Instance): number {
		const known = this.ids.get(instance);
		if (known !== undefined) return known;
		if (this.nextId % SWEEP_EVERY === 0) this.sweep();
		const id = this.nextId++;
		this.byId.set(id, instance);
		this.ids.set(instance, id);
		return id;
	}

	get(id: unknown): Instance {
		if (!typeIs(id, "number")) error("bad id", 0);
		const instance = this.byId.get(id);
		if (instance && (id === 0 || instance.Parent !== undefined)) return instance;
		if (instance) {
			this.byId.delete(id);
			this.ids.delete(instance);
		}
		error("gone", 0);
	}

	private sweep() {
		let alive = 0;
		for (const [id, instance] of this.byId) {
			if (id === 0 || instance.Parent !== undefined) alive += 1;
			else {
				this.byId.delete(id);
				this.ids.delete(instance);
			}
		}
		if (alive > MAX_IDS) this.clear();
	}
}

// Handlers ---------------------------------------------------------------------------------------------------------

const KEYWORDS = new Set([
	"and",
	"break",
	"do",
	"else",
	"elseif",
	"end",
	"false",
	"for",
	"function",
	"if",
	"in",
	"local",
	"nil",
	"not",
	"or",
	"repeat",
	"return",
	"then",
	"true",
	"until",
	"while",
]);

function quote(text: string): string {
	return "%q".format(text).gsub("\\\n", "\\n")[0];
}

/** `.Name`, or `["Spawn point"]` when the name isn't a plain identifier. */
function member(name: string): string {
	const [plain] = name.match("^[%a_][%w_]*$");
	return plain !== undefined && !KEYWORDS.has(name) ? `.${name}` : `[${quote(name)}]`;
}

/** A Luau-style path: game.Workspace.Map["Spawn point"]. */
export function luaPath(names: string[]): string {
	let path = "game";
	for (const name of names) path += member(name);
	return path;
}

/**
 * A path to paste into code: `workspace.Map.Part`, `game:GetService("ReplicatedStorage").Assets["Spawn point"]`.
 * `names` start at a child of game; `serviceClass` is that child's ClassName (services can be renamed).
 */
export function servicePath(names: string[], serviceClass?: string): string {
	if (names.size() === 0) return "game";
	const service = serviceClass ?? names[0];
	let path = service === "Workspace" ? "workspace" : `game:GetService(${quote(service)})`;
	for (let index = 1; index < names.size(); index++) path += member(names[index]);
	return path;
}

function namesOf(instance: Instance): string[] {
	const names = new Array<string>();
	let current: Instance | undefined = instance;
	while (current && current !== game) {
		names.unshift(current.Name);
		current = current.Parent;
	}
	return names;
}

function field<T>(payload: unknown, key: string, check: (value: unknown) => boolean, what: string): T {
	const value = typeIs(payload, "table") ? (payload as Record<string, unknown>)[key] : undefined;
	if (!check(value)) error(`bad ${what}`, 0);
	return value as T;
}

const isText = (max: number) => (value: unknown) => typeIs(value, "string") && value.size() <= max;
const isId = (value: unknown) => typeIs(value, "number") && value >= 0 && value % 1 === 0;

/**
 * The explorer ops (names without the "explorer." prefix). `canEdit` gates every change; the server passes "the
 * effective channel is dev" (the dispatcher already checked that the player is a dev). `audit` gets one line per change.
 */
export function explorerHandlers(
	registry: Registry,
	canEdit: () => boolean,
	audit: (line: string) => void = () => {},
): Record<string, Handler> {
	const rowOf = (instance: Instance, parent: number): Row | undefined => {
		const [ok, row] = pcall(() => ({
			id: registry.id(instance),
			name: instance.Name,
			className: instance.ClassName,
			childCount: instance.GetChildren().size(),
			parent,
		}));
		return ok ? row : undefined;
	};
	const childrenOf = (instance: Instance) => {
		const [ok, children] = pcall(() => instance.GetChildren());
		return ok ? children : [];
	};
	const requireEdit = () => {
		if (!canEdit()) error("read-only here", 0);
	};
	const target = (payload: unknown) => registry.get(field<number>(payload, "id", isId, "id"));
	const get = (instance: Instance, name: string) => (instance as unknown as Record<string, unknown>)[name];
	let finding: FindState | undefined;
	let findBudget = FIND_BURST;
	let findRefill = os.clock();

	return {
		/** { nodes: { id, offset?, limit? }[] } -> ChildrenPage[] (one per node; `gone` when the id is stale). */
		children: (payload) => {
			const nodes = field<{ id: unknown; offset?: unknown; limit?: unknown }[]>(
				payload,
				"nodes",
				(value) => typeIs(value, "table") && (value as unknown[]).size() <= 64,
				"nodes",
			);
			return nodes.map((node): ChildrenPage => {
				if (!typeIs(node, "table")) node = { id: -1 };
				const id = isId(node.id) ? (node.id as number) : -1;
				const [ok, instance] = pcall(() => registry.get(id));
				if (!ok) return { id, rows: [], total: 0, offset: 0, gone: true };
				const offset = isId(node.offset) ? (node.offset as number) : 0;
				const limit = isId(node.limit) ? math.clamp(node.limit as number, 1, MAX_PAGE) : PAGE;
				// Sort on cheap fields first; ids and child counts only for the page that is sent.
				const sorted = new Array<Named & { instance: Instance }>();
				for (const child of childrenOf(instance)) {
					const [readable, name, className] = pcall(() => $tuple(child.Name, child.ClassName));
					if (readable) sorted.push({ instance: child, name, className: className! });
				}
				sorted.sort(rowBefore);
				const page = new Array<Row>();
				for (let index = offset; index < math.min(sorted.size(), offset + limit); index++) {
					const row = rowOf(sorted[index].instance, id);
					if (row) page.push(row);
				}
				return { id, rows: page, total: sorted.size(), offset };
			});
		},

		/** { id } -> PropsReply. */
		props: (payload) => {
			const instance = target(payload);
			const editable = canEdit();
			const props = new Array<PropRow>();
			for (const meta of propsOf(instance.ClassName)) {
				const [ok, value] = pcall(get, instance, meta.name);
				if (!ok) continue;
				const kind = chooseKind(meta.declared, value);
				props.push({
					name: meta.name,
					category: meta.category,
					kind,
					text: encode(value),
					readOnly: !editable || !meta.writable || !EDITABLE.has(kind),
					deprecated: meta.deprecated,
					enumType: typeIs(value, "EnumItem") ? enumName(value) : kind === "Enum" ? meta.enumType : undefined,
					ref: kind === "Instance" && typeIs(value, "Instance") ? registry.id(value) : undefined,
				});
			}
			const attrs = new Array<PropRow>();
			for (const [name, value] of instance.GetAttributes()) {
				const kind = kindOf(value);
				attrs.push({
					name,
					category: "Attributes",
					kind,
					text: encode(value),
					readOnly: !editable || !EDITABLE.has(kind),
					deprecated: false,
					enumType: typeIs(value, "EnumItem") ? enumName(value) : undefined,
				});
			}
			attrs.sort((a, b) => a.name < b.name);
			const reply: PropsReply = {
				id: registry.id(instance),
				name: instance.Name,
				className: instance.ClassName,
				path: luaPath(namesOf(instance)),
				props,
				attrs,
				tags: instance.GetTags(),
			};
			return reply;
		},

		/** { id, name, text } -> new text. The kind comes from the server's own read, never from the client. */
		set: (payload) => {
			requireEdit();
			const instance = target(payload);
			const name = field<string>(payload, "name", isText(100), "name");
			const text = field<string>(payload, "text", isText(4000), "value");
			const meta = propsOf(instance.ClassName).find((entry) => entry.name === name);
			if (!meta || !meta.writable) error(`${name} is read-only`, 0);
			const [, current] = pcall(get, instance, name);
			const kind = chooseKind(meta.declared, current);
			const enumType = meta.enumType ?? (typeIs(current, "EnumItem") ? enumName(current) : undefined);
			const [parsed, value] = decode(kind, text, enumType);
			if (!parsed) error(value as string, 0);
			const [ok, err] = pcall(() => {
				(instance as unknown as Record<string, unknown>)[name] = value;
			});
			if (!ok) error(tostring(err), 0);
			audit(`set ${instance.GetFullName()}.${name} = ${text.sub(1, 200)}`);
			return encode(get(instance, name));
		},

		/** { id, name, text } -> new text. Attributes keep their current type. */
		attr: (payload) => {
			requireEdit();
			const instance = target(payload);
			const name = field<string>(payload, "name", isText(100), "name");
			const text = field<string>(payload, "text", isText(4000), "value");
			const current = instance.GetAttribute(name);
			if (current === undefined) error("no such attribute", 0);
			const enumType = typeIs(current, "EnumItem") ? enumName(current) : undefined;
			const [parsed, value] = decode(kindOf(current), text, enumType);
			if (!parsed) error(value as string, 0);
			const [ok, err] = pcall(() => instance.SetAttribute(name, value as AttributeValue));
			if (!ok) error(tostring(err), 0);
			audit(`attr ${instance.GetFullName()}@${name} = ${text.sub(1, 200)}`);
			return encode(instance.GetAttribute(name));
		},

		/** { id, name } */
		rename: (payload) => {
			requireEdit();
			const instance = target(payload);
			const name = field<string>(payload, "name", (value) => isText(100)(value) && (value as string).size() > 0, "name");
			const before = instance.GetFullName();
			const [ok, err] = pcall(() => {
				instance.Name = name;
			});
			if (!ok) error(tostring(err), 0);
			audit(`rename ${before} -> ${name}`);
			return true;
		},

		/** { id } */
		destroy: (payload) => {
			requireEdit();
			const instance = target(payload);
			if (instance === game || instance.Parent === game) error("can't delete a service", 0);
			if (instance.IsA("Player") || instance.IsA("Terrain")) error(`can't delete a ${instance.ClassName}`, 0);
			const path = instance.GetFullName();
			const [ok, err] = pcall(() => instance.Destroy());
			if (!ok) error(tostring(err), 0);
			audit(`destroy ${path}`);
			return true;
		},

		/**
		 * { id, query, token, next? } -> FindPage. A breadth-first walk under `id` for Name or ClassName containing the
		 * query (case-insensitive), one page per call: `next` continues the walk started by the call with the same token.
		 * Yields every 200 instances; a newer search cancels the running one. Capped hits and visits; rate limited.
		 */
		find: (payload) => {
			const now = os.clock();
			findBudget = math.min(FIND_BURST, findBudget + (now - findRefill) * FIND_RATE);
			findRefill = now;
			if (findBudget < 1) error("rate limited", 0);
			findBudget -= 1;
			const root = target(payload);
			const query = field<string>(payload, "query", (value) => isText(100)(value) && (value as string).size() > 0, "query");
			const needle = query.lower();
			const token = field<number>(payload, "token", isId, "token");
			if ((payload as { next?: unknown }).next !== true) {
				finding = { token, needle, root, queue: childrenOf(root), head: 0, visits: 0, hits: 0 };
			}
			const state = finding;
			if (!state || state.token !== token || state.needle !== needle || state.root !== root) error("stale search", 0);
			const hits = new Array<FindHit>();
			let visits = 0;
			while (
				state.head < state.queue.size() &&
				state.hits < FIND_HITS &&
				state.visits < FIND_VISITS &&
				visits < FIND_PAGE_VISITS &&
				hits.size() < FIND_PAGE_HITS
			) {
				const instance = state.queue[state.head];
				state.head += 1;
				state.visits += 1;
				visits += 1;
				if (visits % 200 === 0) {
					task.wait();
					if (finding !== state) return { hits: [], done: true, capped: false } satisfies FindPage;
				}
				const [ok, matched] = pcall(
					() =>
						instance.Name.lower().find(needle, 1, true)[0] !== undefined ||
						instance.ClassName.lower().find(needle, 1, true)[0] !== undefined,
				);
				const parent = instance.Parent;
				if (ok && matched && parent) {
					const row = rowOf(instance, registry.id(parent));
					const names = new Array<string>();
					for (let at: Instance | undefined = instance; at && at !== root && names.size() < 32; at = at.Parent) {
						names.unshift(at.Name);
					}
					if (row) {
						state.hits += 1;
						hits.push({ row, path: names });
					}
				}
				for (const child of childrenOf(instance)) state.queue.push(child);
			}
			const exhausted = state.head >= state.queue.size();
			const capped = !exhausted && (state.hits >= FIND_HITS || state.visits >= FIND_VISITS);
			if (exhausted || capped) finding = undefined;
			return { hits, done: exhausted || capped, capped } satisfies FindPage;
		},

		/** { id } -> Row[] from the top-level service down to the instance. */
		ancestry: (payload) => {
			const chain = new Array<Row>();
			let current: Instance | undefined = target(payload);
			while (current && current !== game) {
				const parent: Instance | undefined = current.Parent;
				if (!parent) break;
				const row = rowOf(current, registry.id(parent));
				if (row) chain.unshift(row);
				current = parent;
			}
			return chain;
		},

		/** { id } -> { instance } (nil on the client when the instance doesn't replicate to it). */
		instance: (payload) => ({ instance: target(payload) }),
	};
}

export const EXPLORER_OPS = ["children", "props", "set", "attr", "rename", "destroy", "find", "ancestry", "instance"];
