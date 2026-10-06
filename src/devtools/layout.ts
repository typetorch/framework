/**
 * Dev menu window manager, the layout core (plans/10 "Panes and windows"): a binary tree of panes for the main panel and
 * for each floating window, plus focus and window order. Pure data, no Roblox instances and no imports, so it is tested
 * under Lune (scripts/test-layout.luau) and kept in the client persist store as it is (it survives swaps).
 *
 * - A **leaf** is a pane showing one page ("Artifact", "Modules/State", ...). `data` is that pane's own remembered state
 *   (the State explorer's open nodes, the Logs realm, ...).
 * - A **split** shows `a` and `b` side by side ("row", Split right) or stacked ("column", Split down); `ratio` is a's share.
 * - **Windows** float over the game; each holds its own tree. `order` lists window ids back to front, 0 = the main panel.
 */

export type SplitDir = "row" | "column";

export interface LeafNode {
	kind: "leaf";
	id: number;
	page: string;
	/** This pane's own remembered state (per page key or per pane), kept with the layout. */
	data?: Record<string, unknown>;
}

export interface SplitNode {
	kind: "split";
	id: number;
	dir: SplitDir;
	/** a's share of the split, 0.1 to 0.9. */
	ratio: number;
	a: LayoutNode;
	b: LayoutNode;
}

export type LayoutNode = LeafNode | SplitNode;

/** Window rectangle in pixels (top-left corner and size). */
export interface WindowRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface FloatWindow {
	id: number;
	root: LayoutNode;
	/** Undefined = placed by the window manager on first show. */
	rect?: WindowRect;
	/** Collapsed to its title bar (its panes are unmounted, so they pause). */
	min?: boolean;
	/** Fills the screen (always on phones). */
	max?: boolean;
}

export interface Layout {
	v: number;
	/** Next free id (leaves, splits and windows share one counter; 0 is the main panel). */
	next: number;
	main: LayoutNode;
	windows: FloatWindow[];
	/** The focused leaf: the sidebar opens pages here. */
	focus: number;
	/** Window ids back to front; 0 = the main panel. */
	order: number[];
}

/** How many panes and windows a layout may hold (phones get fewer, see limitsFor). */
export interface Limits {
	/** Panes in the main panel. */
	main: number;
	/** Panes in one floating window. */
	window: number;
	/** Floating windows. */
	windows: number;
	/** Side-by-side splits allowed ("Split right"); off on phones, where panes only stack. */
	rows: boolean;
}

export const LAYOUT_VERSION = 1;
export const MIN_RATIO = 0.1;
export const MAX_RATIO = 0.9;
/** Deepest tree kept (a deeper persisted tree is cut back to its first leaves). */
const MAX_DEPTH = 6;

/** Desktop: 6 panes in the main panel, 4 per window, 6 windows. Phones and small screens: 2 stacked panes, 1 per window. */
export function limitsFor(compact: boolean): Limits {
	return compact ? { main: 2, window: 1, windows: 3, rows: false } : { main: 6, window: 4, windows: 6, rows: true };
}

export function newLayout(page: string): Layout {
	return { v: LAYOUT_VERSION, next: 2, main: { kind: "leaf", id: 1, page }, windows: [], focus: 1, order: [0] };
}

/** The leaves of a tree, left to right (top to bottom). */
export function leavesOf(node: LayoutNode, into: LeafNode[] = []): LeafNode[] {
	if (node.kind === "leaf") into.push(node);
	else {
		leavesOf(node.a, into);
		leavesOf(node.b, into);
	}
	return into;
}

export function countLeaves(node: LayoutNode): number {
	return node.kind === "leaf" ? 1 : countLeaves(node.a) + countLeaves(node.b);
}

export function windowOf(layout: Layout, id: number): FloatWindow | undefined {
	return layout.windows.find((win) => win.id === id);
}

/** The tree with this owner id (0 = main panel, else a window id). */
export function treeOf(layout: Layout, owner: number): LayoutNode | undefined {
	if (owner === 0) return layout.main;
	return windowOf(layout, owner)?.root;
}

/** A leaf and the id of the tree that holds it (0 = main panel). */
export function findLeaf(layout: Layout, id: number): [LeafNode, number] | undefined {
	for (const leaf of leavesOf(layout.main)) if (leaf.id === id) return [leaf, 0];
	for (const win of layout.windows) {
		for (const leaf of leavesOf(win.root)) if (leaf.id === id) return [leaf, win.id];
	}
	return undefined;
}

/** Every leaf of the layout with its owner (main panel first, then the windows in list order). */
export function allLeaves(layout: Layout): Array<[LeafNode, number]> {
	const list = new Array<[LeafNode, number]>();
	for (const leaf of leavesOf(layout.main)) list.push([leaf, 0]);
	for (const win of layout.windows) for (const leaf of leavesOf(win.root)) list.push([leaf, win.id]);
	return list;
}

/** The leaves showing `page`, with their owners. */
export function leavesWithPage(layout: Layout, page: string): Array<[LeafNode, number]> {
	return allLeaves(layout).filter(([leaf]) => leaf.page === page);
}

export function findSplit(node: LayoutNode, id: number): SplitNode | undefined {
	if (node.kind === "leaf") return undefined;
	if (node.id === id) return node;
	return findSplit(node.a, id) ?? findSplit(node.b, id);
}

function takeId(layout: Layout): number {
	const id = layout.next;
	layout.next += 1;
	return id;
}

/** Replaces `target` (by identity) in the tree rooted at `node`; returns the new root. */
function replaceNode(node: LayoutNode, target: LayoutNode, replacement: LayoutNode): LayoutNode {
	if (node === target) return replacement;
	if (node.kind === "split") {
		node.a = replaceNode(node.a, target, replacement);
		node.b = replaceNode(node.b, target, replacement);
	}
	return node;
}

/** Removes `target` from the tree; its parent split collapses into the sibling. Undefined when target was the root. */
function removeNode(node: LayoutNode, target: LayoutNode): LayoutNode | undefined {
	if (node === target) return undefined;
	if (node.kind === "leaf") return node;
	if (node.a === target) return node.b;
	if (node.b === target) return node.a;
	node.a = removeNode(node.a, target) ?? node.a;
	node.b = removeNode(node.b, target) ?? node.b;
	return node;
}

function setTree(layout: Layout, owner: number, root: LayoutNode) {
	if (owner === 0) layout.main = root;
	else {
		const win = windowOf(layout, owner);
		if (win) win.root = root;
	}
}

/** Whether the tree that holds `owner` may get one more pane in direction `dir`. */
export function canSplit(layout: Layout, owner: number, dir: SplitDir, limits: Limits): boolean {
	if (dir === "row" && !limits.rows) return false;
	const tree = treeOf(layout, owner);
	if (!tree) return false;
	return countLeaves(tree) < (owner === 0 ? limits.main : limits.window);
}

/**
 * Splits leaf `id`: the new pane shows `page` and goes right of it ("row") or under it ("column"). Returns the new leaf,
 * or undefined (unknown leaf, or the tree is full).
 */
export function splitLeaf(layout: Layout, id: number, dir: SplitDir, page: string, limits: Limits): LeafNode | undefined {
	const found = findLeaf(layout, id);
	if (!found) return undefined;
	const [leaf, owner] = found;
	if (!canSplit(layout, owner, dir, limits)) return undefined;
	const fresh: LeafNode = { kind: "leaf", id: takeId(layout), page };
	const split: SplitNode = { kind: "split", id: takeId(layout), dir, ratio: 0.5, a: leaf, b: fresh };
	setTree(layout, owner, replaceNode(treeOf(layout, owner)!, leaf, split));
	layout.focus = fresh.id;
	return fresh;
}

/** The first leaf of the main panel (focus falls back here). */
function firstMain(layout: Layout): number {
	return leavesOf(layout.main)[0].id;
}

/** Puts focus back on a leaf that exists and is visible (not in a minimised window). */
export function repairFocus(layout: Layout) {
	const found = findLeaf(layout, layout.focus);
	if (found && (found[1] === 0 || windowOf(layout, found[1])?.min !== true)) return;
	layout.focus = firstMain(layout);
}

/**
 * Closes pane `id`. Its split collapses into the sibling; a window's last pane closes the window. The main panel keeps
 * at least one pane: closing its last pane is refused (false).
 */
export function closeLeaf(layout: Layout, id: number): boolean {
	const found = findLeaf(layout, id);
	if (!found) return false;
	const [leaf, owner] = found;
	const tree = treeOf(layout, owner)!;
	const rest = removeNode(tree, leaf);
	if (rest === undefined) {
		if (owner === 0) return false;
		closeWindow(layout, owner);
		return true;
	}
	setTree(layout, owner, rest);
	if (layout.focus === id) layout.focus = leavesOf(rest)[0].id;
	repairFocus(layout);
	return true;
}

export function closeWindow(layout: Layout, id: number) {
	layout.windows = layout.windows.filter((win) => win.id !== id);
	layout.order = layout.order.filter((entry) => entry !== id);
	repairFocus(layout);
}

/** Moves window `id` (0 = main panel) to the front. */
export function raise(layout: Layout, id: number) {
	if (layout.order[layout.order.size() - 1] === id) return;
	layout.order = layout.order.filter((entry) => entry !== id);
	layout.order.push(id);
}

/**
 * "Open in new window": moves pane `id` into a new floating window (on top, focused). The main panel's last pane leaves
 * a fresh pane on `fallbackPage` behind. Undefined when the window limit is reached or the leaf is unknown; a window's
 * only pane is left where it is (it already has a window of its own).
 */
export function popOut(layout: Layout, id: number, fallbackPage: string, limits: Limits): FloatWindow | undefined {
	if (layout.windows.size() >= limits.windows) return undefined;
	const found = findLeaf(layout, id);
	if (!found) return undefined;
	const [leaf, owner] = found;
	const tree = treeOf(layout, owner)!;
	const rest = removeNode(tree, leaf);
	if (rest === undefined) {
		if (owner !== 0) return undefined;
		layout.main = { kind: "leaf", id: takeId(layout), page: fallbackPage };
	} else setTree(layout, owner, rest);
	const win: FloatWindow = { id: takeId(layout), root: leaf, max: limits.rows ? undefined : true };
	layout.windows.push(win);
	layout.order.push(win.id);
	layout.focus = leaf.id;
	return win;
}

/**
 * "Dock": moves window `id`'s panes into the main panel next to leaf `target` (a split in `dir`). When that would pass
 * the main panel's limit, a one-pane window replaces the target pane instead (phones: 2 panes at most); a bigger window
 * is refused ("full"). Returns what happened.
 */
export function dockWindow(layout: Layout, id: number, target: number, dir: SplitDir, limits: Limits): "split" | "replaced" | "full" | "none" {
	const win = windowOf(layout, id);
	if (!win) return "none";
	const found = findLeaf(layout, target);
	const anchor = found && found[1] === 0 ? found[0] : leavesOf(layout.main)[0];
	const incoming = countLeaves(win.root);
	const splitDir: SplitDir = limits.rows ? dir : "column";
	let outcome: "split" | "replaced";
	if (countLeaves(layout.main) + incoming <= limits.main) {
		const split: SplitNode = { kind: "split", id: takeId(layout), dir: splitDir, ratio: 0.5, a: anchor, b: win.root };
		layout.main = replaceNode(layout.main, anchor, split);
		outcome = "split";
	} else if (incoming === 1) {
		layout.main = replaceNode(layout.main, anchor, win.root);
		outcome = "replaced";
	} else return "full";
	layout.windows = layout.windows.filter((entry) => entry !== win);
	layout.order = layout.order.filter((entry) => entry !== id);
	layout.focus = leavesOf(win.root)[0].id;
	return outcome;
}

export function clampRatio(ratio: number): number {
	if (ratio !== ratio) return 0.5;
	return math.clamp(ratio, MIN_RATIO, MAX_RATIO);
}

/** Sets a split's ratio (clamped); false when the split is unknown. */
export function setRatio(layout: Layout, id: number, ratio: number): boolean {
	let split = findSplit(layout.main, id);
	if (!split) {
		for (const win of layout.windows) {
			split = findSplit(win.root, id);
			if (split) break;
		}
	}
	if (!split) return false;
	split.ratio = clampRatio(ratio);
	return true;
}

/**
 * A pane opens `page`. Singletons (`single(page)`) open at most once: when another pane already shows it, that pane is
 * returned to be focused instead and nothing changes. Otherwise the pane switches page (its own data stays) and is
 * returned.
 */
export function openPage(layout: Layout, id: number, page: string, single: (page: string) => boolean): [LeafNode, number] | undefined {
	if (single(page)) {
		const open = leavesWithPage(layout, page)[0];
		if (open) {
			layout.focus = open[0].id;
			return open;
		}
	}
	const found = findLeaf(layout, id);
	if (!found) return undefined;
	found[0].page = page;
	layout.focus = id;
	return found;
}

// Persisted layouts ------------------------------------------------------------------------------------------------

function finite(value: unknown): value is number {
	return typeIs(value, "number") && value === value && value !== math.huge && value !== -math.huge;
}

interface Cleaner {
	used: Set<number>;
	next: number;
	pages: (page: string) => boolean;
	single: (page: string) => boolean;
	fallback: string;
	/** Singleton pages already placed (a second copy becomes the fallback page). */
	singles: Set<string>;
	leaves: number;
	maxLeaves: number;
}

function freshId(cleaner: Cleaner, wanted: unknown): number {
	if (finite(wanted) && wanted >= 1 && wanted % 1 === 0 && wanted < 2 ** 30 && !cleaner.used.has(wanted)) {
		cleaner.used.add(wanted);
		return wanted;
	}
	while (cleaner.used.has(cleaner.next)) cleaner.next += 1;
	const id = cleaner.next;
	cleaner.used.add(id);
	return id;
}

function cleanPage(cleaner: Cleaner, raw: unknown): string {
	let page = typeIs(raw, "string") && cleaner.pages(raw) ? raw : cleaner.fallback;
	if (cleaner.single(page)) {
		if (cleaner.singles.has(page)) page = cleaner.fallback;
		else cleaner.singles.add(page);
	}
	return page;
}

function cleanNode(cleaner: Cleaner, raw: unknown, depth: number): LayoutNode | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const node = raw as Record<string, unknown>;
	if (node.kind === "split" && depth < MAX_DEPTH && cleaner.leaves < cleaner.maxLeaves - 1) {
		const a = cleanNode(cleaner, node.a, depth + 1);
		const b = a !== undefined && cleaner.leaves < cleaner.maxLeaves ? cleanNode(cleaner, node.b, depth + 1) : undefined;
		if (a === undefined) return b;
		if (b === undefined) return a;
		const dir: SplitDir = node.dir === "column" ? "column" : "row";
		return { kind: "split", id: freshId(cleaner, node.id), dir, ratio: clampRatio(finite(node.ratio) ? node.ratio : 0.5), a, b };
	}
	if (node.kind === "split") {
		// Too deep or too many panes: keep the first leaf under it.
		return cleanNode(cleaner, node.a, depth + 1);
	}
	if (node.kind !== "leaf" || cleaner.leaves >= cleaner.maxLeaves) return undefined;
	cleaner.leaves += 1;
	const leaf: LeafNode = { kind: "leaf", id: freshId(cleaner, node.id), page: cleanPage(cleaner, node.page) };
	if (typeIs(node.data, "table")) leaf.data = node.data as Record<string, unknown>;
	return leaf;
}

function cleanRect(raw: unknown): WindowRect | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const rect = raw as Record<string, unknown>;
	if (!finite(rect.x) || !finite(rect.y) || !finite(rect.w) || !finite(rect.h)) return undefined;
	if (rect.w <= 0 || rect.h <= 0) return undefined;
	return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/**
 * Rebuilds a persisted layout (from an older or newer framework generation, so untrusted in shape): unknown pages
 * become `fallback`, a singleton page open twice keeps its first pane, ids are unique, ratios clamped, trees cut to
 * the desktop limits, focus and window order repaired. Anything unusable gives a fresh one-pane layout on `fallback`.
 */
export function sanitizeLayout(
	raw: unknown,
	pages: (page: string) => boolean,
	single: (page: string) => boolean,
	fallback: string,
): Layout {
	const desktop = limitsFor(false);
	const cleaner: Cleaner = { used: new Set([0]), next: 1, pages, single, fallback, singles: new Set(), leaves: 0, maxLeaves: desktop.main };
	if (!typeIs(raw, "table")) return newLayout(fallback);
	const input = raw as Record<string, unknown>;
	const main = cleanNode(cleaner, input.main, 0);
	if (main === undefined) return newLayout(fallback);
	const windows = new Array<FloatWindow>();
	if (typeIs(input.windows, "table")) {
		for (const [, item] of pairs(input.windows as object)) {
			if (windows.size() >= desktop.windows || !typeIs(item, "table")) continue;
			const win = item as Record<string, unknown>;
			cleaner.leaves = 0;
			cleaner.maxLeaves = desktop.window;
			const root = cleanNode(cleaner, win.root, 0);
			if (root === undefined) continue;
			const entry: FloatWindow = { id: freshId(cleaner, win.id), root, rect: cleanRect(win.rect) };
			if (win.min === true) entry.min = true;
			if (win.max === true) entry.max = true;
			windows.push(entry);
		}
	}
	let nextId = cleaner.next;
	for (const id of cleaner.used) nextId = math.max(nextId, id + 1);
	const order = new Array<number>();
	if (typeIs(input.order, "table")) {
		for (const [, id] of pairs(input.order as object)) {
			if (!typeIs(id, "number") || order.includes(id)) continue;
			if (id === 0 || windows.some((win) => win.id === id)) order.push(id);
		}
	}
	if (!order.includes(0)) order.unshift(0);
	for (const win of windows) if (!order.includes(win.id)) order.push(win.id);
	const layout: Layout = { v: LAYOUT_VERSION, next: nextId, main, windows, focus: finite(input.focus) ? input.focus : 0, order };
	repairFocus(layout);
	return layout;
}
