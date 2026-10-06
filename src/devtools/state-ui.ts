import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { stateRoots } from "./state";
import { inspectState, STATE_MAX_QUERIES, STATE_PAGE, stateNodeId } from "./state-inspect";
import type { StateEntry, StateQuery, StateReply } from "./state-inspect";
import { addButton, BUTTON_HEIGHT, chevron, COLORS, copyText, corner, escapeRich, hex, make, Page, paintSelected, searchBox, style } from "./widgets";

/**
 * Dev menu Modules > State (plans/10): the live state explorer, with the Modules group's Server | Client toolbar.
 *
 * Roots are the running generation's modules (services on the server, controllers on the client) and the persist
 * store. Tap a row to open it: its own fields, then tables, arrays, Maps and Sets inside, one page of STATE_PAGE
 * entries per open node (Prev / Next). Tap a value that doesn't open to copy its preview. The toolbar has a key filter
 * (open nodes stay listed), Refresh, and Auto (refresh every 2 s). Server data comes from op "state.inspect"
 * (state-inspect.ts, one call per refresh for up to STATE_MAX_QUERIES open nodes), client data from this client.
 *
 * Rows are fixed-height text rows in the tab's script-free ScrollingFrame (the "keep" rows of the scrolling-frames
 * recipe); each row is reused by its path, so a refresh changes texts, not instances.
 */

const AUTO_REFRESH = 2;
const ROW_HEIGHT = 32;
const NOTE_HEIGHT = 22;
const INDENT = 14;
const MAX_INDENT_LEVELS = 8;
/** Open nodes per realm (each costs one query per refresh). */
const MAX_OPEN = 20;
const FILTER_DELAY = 0.35;

type Realm = "server" | "client";

interface OpenNode {
	path: string[];
	page: number;
}

/** Kept in the kernel persist store (survives swaps): open nodes and pages per realm, the filter, Auto. */
export interface StateExplorerPersist {
	auto?: boolean;
	filter?: string;
	open?: { server?: Map<string, OpenNode>; client?: Map<string, OpenNode> };
	rootPage?: { server?: number; client?: number };
}

/** What the tab needs from client.ts's TabContext. */
export interface StateTab {
	readonly page: Page;
	readonly trove: Trove;
	readonly toolbar: () => Frame;
}

export interface StateTabOptions {
	/** Sends one dev op and yields for the reply. */
	call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
	/** The Modules group's realm (shared with Overview and Assets). */
	realm: () => Realm;
	setRealm: (realm: Realm) => void;
	persist: StateExplorerPersist;
}

const ERRORS: Record<string, string> = {
	owners_only: "Owners only on prod servers",
	rate_limited: "Slow down",
	"not a dev": "Devs only",
};

const VALUE_COLORS: Record<string, Color3> = {
	string: COLORS.good,
	number: COLORS.info,
	boolean: COLORS.accent,
	nil: COLORS.dim,
	function: COLORS.dim,
	thread: COLORS.dim,
};

type Line =
	| { kind: "entry"; id: string; depth: number; path: string[]; entry: StateEntry; open: boolean }
	| { kind: "pager"; id: string; depth: number; node?: string; reply: StateReply }
	| { kind: "note"; id: string; depth: number; text: string; color: Color3 };

interface RowView {
	kind: Line["kind"];
	frame: GuiObject;
	label: TextLabel;
	icon?: Frame;
	collapsed?: Frame;
	expanded?: Frame;
	prev?: TextButton;
	next?: TextButton;
}

function startsWith(path: ReadonlyArray<string>, prefix: ReadonlyArray<string>): boolean {
	if (path.size() < prefix.size()) return false;
	for (let index = 0; index < prefix.size(); index++) if (path[index] !== prefix[index]) return false;
	return true;
}

function indentOf(depth: number): number {
	return 6 + math.min(depth, MAX_INDENT_LEVELS) * INDENT;
}

export function renderStateTab(tab: StateTab, options: StateTabOptions) {
	const persist = options.persist;
	if (persist.open === undefined) persist.open = {};
	if (persist.rootPage === undefined) persist.rootPage = {};
	const opened = persist.open;
	const rootPages = persist.rootPage;
	const openOf = (realm: Realm): Map<string, OpenNode> => {
		let open = opened[realm];
		if (open === undefined) {
			open = new Map();
			opened[realm] = open;
		}
		return open;
	};

	// Toolbar: Server | Client, the key filter, Refresh, Auto.
	const bar = tab.toolbar();
	const realmButtons = new Map<Realm, TextButton>();
	let requestRefresh: () => void = () => {};
	const pick = (realm: Realm) => {
		options.setRealm(realm);
		for (const [name, button] of realmButtons) paintSelected(button, name === realm);
		requestRefresh();
	};
	realmButtons.set("server", addButton(bar, "Server", () => pick("server")));
	realmButtons.set("client", addButton(bar, "Client", () => pick("client")));
	for (const [name, button] of realmButtons) paintSelected(button, name === options.realm());
	const filterBox = searchBox(bar, "Filter keys", 100);
	filterBox.Text = persist.filter ?? "";
	addButton(bar, "Refresh", () => requestRefresh());
	const autoButton = addButton(bar, "Auto", () => {
		persist.auto = persist.auto === false;
		paintSelected(autoButton, persist.auto !== false);
	});
	paintSelected(autoButton, persist.auto !== false);

	let filterToken = 0;
	tab.trove.connect(filterBox.GetPropertyChangedSignal("Text"), () => {
		filterToken += 1;
		const mine = filterToken;
		tab.trove.add(
			task.delay(FILTER_DELAY, () => {
				if (mine !== filterToken) return;
				const text = filterBox.Text.match("^%s*(.-)%s*$")[0] as string;
				if ((persist.filter ?? "") === text) return;
				persist.filter = text === "" ? undefined : text.sub(1, 64);
				// A new filter starts every list on its first page.
				for (const realm of ["server", "client"] as const) {
					rootPages[realm] = 0;
					for (const [, node] of openOf(realm)) node.page = 0;
				}
				requestRefresh();
			}),
		);
	});

	const status = tab.page.text("", COLORS.dim);
	status.Visible = false;
	const setStatus = (text: string, color = COLORS.dim) => {
		status.Text = text;
		status.TextColor3 = color;
		status.Visible = text !== "";
	};
	const tree = tab.page.group(2);
	tree.text("Loading...", COLORS.dim);
	let loaded = false;

	// Rows, reused by id -------------------------------------------------------------------------------------------
	const views = new Map<string, RowView>();
	const handlers = new Map<Instance, () => void>();
	const pagerHandlers = new Map<Instance, (delta: number) => void>();

	const createRow = (kind: Line["kind"]): RowView => {
		if (kind === "note") {
			const label = style(make("TextLabel", { BackgroundTransparency: 1 }), "", 14, COLORS.dim);
			label.TextWrapped = false;
			label.TextTruncate = Enum.TextTruncate.AtEnd;
			label.Size = new UDim2(1, 0, 0, NOTE_HEIGHT);
			return { kind, frame: label, label };
		}
		if (kind === "pager") {
			const frame = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, BUTTON_HEIGHT) });
			const label = style(make("TextLabel", { BackgroundTransparency: 1 }, frame), "", 14, COLORS.dim);
			label.TextWrapped = false;
			label.TextTruncate = Enum.TextTruncate.AtEnd;
			const button = (text: string, right: number, delta: number) => {
				const view = style(make("TextButton", { AutoButtonColor: true }, frame), text, 14, COLORS.text, Enum.Font.BuilderSansMedium);
				view.TextXAlignment = Enum.TextXAlignment.Center;
				view.TextWrapped = false;
				view.BackgroundColor3 = COLORS.button;
				view.AnchorPoint = new Vector2(1, 0.5);
				view.Position = new UDim2(1, -right, 0.5, 0);
				view.Size = UDim2.fromOffset(60, BUTTON_HEIGHT - 2);
				corner(view, 6);
				view.Activated.Connect(() => pagerHandlers.get(frame)?.(delta));
				return view;
			};
			const nextButton = button("Next", 0, 1);
			const prevButton = button("Prev", 66, -1);
			return { kind, frame, label, prev: prevButton, next: nextButton };
		}
		const frame = make("TextButton", {
			AutoButtonColor: true,
			Text: "",
			BackgroundColor3: COLORS.row,
			BackgroundTransparency: 0.4,
			BorderSizePixel: 0,
			Size: new UDim2(1, 0, 0, ROW_HEIGHT),
		});
		corner(frame, 4);
		const icon = make("Frame", { Name: "Icon", BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 0.5), Size: UDim2.fromOffset(12, 12) }, frame);
		make("UIAspectRatioConstraint", { AspectRatio: 1 }, icon);
		const collapsed = chevron(icon, "right", COLORS.dim, 2);
		const expanded = chevron(icon, "down", COLORS.dim, 2);
		const label = style(make("TextLabel", { BackgroundTransparency: 1, RichText: true }, frame), "", 15);
		label.TextWrapped = false;
		label.TextTruncate = Enum.TextTruncate.AtEnd;
		frame.Activated.Connect(() => handlers.get(frame)?.());
		return { kind, frame, label, icon, collapsed, expanded };
	};

	const setText = (label: TextLabel, text: string) => {
		if (label.Text !== text) label.Text = text;
	};

	const toggle = (path: string[]) => {
		const realm = options.realm();
		const open = openOf(realm);
		const id = stateNodeId(path);
		if (open.has(id)) {
			// Closing a node closes everything under it.
			for (const [other, node] of open) if (startsWith(node.path, path)) open.delete(other);
		} else {
			if (open.size() >= MAX_OPEN) {
				setStatus(`${MAX_OPEN} open at most: close some first`, COLORS.warn);
				return;
			}
			open.set(id, { path: [...path], page: 0 });
		}
		requestRefresh();
	};

	const updateRow = (view: RowView, line: Line) => {
		const indent = indentOf(line.depth);
		if (line.kind === "note") {
			view.label.TextColor3 = line.color;
			view.label.Position = UDim2.fromOffset(indent + 18, 0);
			view.label.Size = new UDim2(1, -(indent + 18), 0, NOTE_HEIGHT);
			setText(view.label, line.text);
			return;
		}
		if (line.kind === "pager") {
			const reply = line.reply;
			const from = reply.page * STATE_PAGE;
			const to = math.min(reply.matched, from + STATE_PAGE);
			view.label.Position = UDim2.fromOffset(indent + 18, 0);
			view.label.Size = new UDim2(1, -(indent + 18 + 132), 1, 0);
			setText(view.label, `${from + 1}-${to} of ${reply.matched}`);
			const first = reply.page <= 0;
			const last = reply.page >= reply.pages - 1;
			view.prev!.TextColor3 = first ? COLORS.dim : COLORS.text;
			view.next!.TextColor3 = last ? COLORS.dim : COLORS.text;
			const node = line.node;
			pagerHandlers.set(view.frame, (delta) => {
				const realm = options.realm();
				const wanted = math.clamp(reply.page + delta, 0, reply.pages - 1);
				if (wanted === reply.page) return;
				if (node === undefined) rootPages[realm] = wanted;
				else {
					const open = openOf(realm).get(node);
					if (!open) return;
					open.page = wanted;
				}
				requestRefresh();
			});
			return;
		}
		const entry = line.entry;
		view.icon!.Position = new UDim2(0, indent, 0.5, 0);
		view.icon!.Visible = entry.expandable;
		view.collapsed!.Visible = !line.open;
		view.expanded!.Visible = line.open;
		view.label.Position = UDim2.fromOffset(indent + 18, 0);
		view.label.Size = new UDim2(1, -(indent + 24), 1, 0);
		const color = entry.cycle === true ? COLORS.warn : VALUE_COLORS[entry.type] ?? COLORS.text;
		const keyColor = line.depth === 0 ? COLORS.accent : COLORS.text;
		setText(
			view.label,
			`<font color="${hex(keyColor)}"><b>${escapeRich(entry.key)}</b></font>  <font size="13" color="${hex(COLORS.dim)}">${escapeRich(
				entry.type,
			)}</font>  <font color="${hex(color)}">${escapeRich(entry.preview)}</font>`,
		);
		const frame = view.frame;
		const path = line.path;
		handlers.set(frame, entry.expandable ? () => toggle(path) : () => copyText(entry.preview, frame));
	};

	const paint = (lines: Line[]) => {
		if (!loaded) {
			tree.clear();
			loaded = true;
		}
		const used = new Set<string>();
		lines.forEach((line, index) => {
			let view = views.get(line.id);
			if (view && view.kind !== line.kind) {
				view.frame.Destroy();
				views.delete(line.id);
				view = undefined;
			}
			if (!view) {
				view = createRow(line.kind);
				views.set(line.id, view);
				view.frame.Parent = tree.frame;
			}
			view.frame.LayoutOrder = index;
			updateRow(view, line);
			used.add(line.id);
		});
		for (const [id, view] of views) {
			if (used.has(id)) continue;
			handlers.delete(view.frame);
			pagerHandlers.delete(view.frame);
			view.frame.Destroy();
			views.delete(id);
		}
	};

	const clearRows = () => paint([]);

	// Refresh: one query for the roots plus one per open node, then the visible tree as lines --------------------
	const refreshOnce = () => {
		const realm = options.realm();
		const open = openOf(realm);
		const nodes = new Array<[string, OpenNode]>();
		for (const [id, node] of open) nodes.push([id, node]);
		nodes.sort((a, b) => a[1].path.size() < b[1].path.size());
		const keepFor = (path: string[]) => {
			const keep = new Array<string>();
			for (const [, node] of nodes) {
				if (node.path.size() === path.size() + 1 && startsWith(node.path, path)) keep.push(node.path[path.size()]);
			}
			return keep;
		};
		const filter = persist.filter;
		const queries = new Array<StateQuery>();
		queries.push({ side: realm, root: "", path: [], page: rootPages[realm] ?? 0, filter, keep: keepFor([]) });
		for (const [, node] of nodes) {
			queries.push({ side: realm, root: node.path[0], path: node.path.filter((_, index) => index > 0), page: node.page, filter, keep: keepFor(node.path) });
		}

		let replies = new Array<StateReply>();
		if (realm === "client") {
			const roots = stateRoots();
			for (const query of queries) replies.push(inspectState(roots, query));
		} else {
			for (let from = 0; from < queries.size(); from += STATE_MAX_QUERIES) {
				const batch = queries.filter((_, index) => index >= from && index < from + STATE_MAX_QUERIES);
				const [ok, reply] = options.call("state.inspect", { queries: batch });
				if (options.realm() !== realm) return;
				if (!ok || !typeIs(reply, "table")) {
					const text = typeIs(reply, "string") ? ERRORS[reply] ?? `Failed: ${reply}` : "Failed";
					setStatus(text, reply === "rate_limited" ? COLORS.warn : COLORS.bad);
					if (reply === "owners_only") clearRows();
					return;
				}
				for (const item of reply as StateReply[]) replies.push(item);
			}
		}
		if (options.realm() !== realm) return;
		setStatus("");

		const byId = new Map<string, StateReply>();
		nodes.forEach(([id], index) => {
			const reply = replies[index + 1];
			if (reply) byId.set(id, reply);
		});
		const lines = new Array<Line>();
		const visit = (reply: StateReply, path: string[], depth: number, node: string | undefined) => {
			const base = node ?? "";
			if (reply.missing === true) {
				lines.push({ kind: "note", id: `${base}|gone`, depth, text: "Gone", color: COLORS.dim });
				return;
			}
			if (reply.truncated === true) {
				lines.push({ kind: "note", id: `${base}|cut`, depth, text: `${reply.capped === true ? "Over " : ""}${reply.size} keys: first 20000 listed`, color: COLORS.warn });
			}
			if (reply.pages > 1) lines.push({ kind: "pager", id: `${base}|pager`, depth, node, reply });
			if (reply.entries.size() === 0) {
				lines.push({ kind: "note", id: `${base}|empty`, depth, text: filter !== undefined ? "No match" : "Empty", color: COLORS.dim });
			}
			for (const entry of reply.entries) {
				const childPath = [...path, entry.seg];
				const id = stateNodeId(childPath);
				const isOpen = entry.expandable && open.has(id);
				lines.push({ kind: "entry", id, depth, path: childPath, entry, open: isOpen });
				if (!isOpen) continue;
				const child = byId.get(id);
				if (child) visit(child, childPath, depth + 1, id);
				else lines.push({ kind: "note", id: `${id}|loading`, depth: depth + 1, text: "Loading...", color: COLORS.dim });
			}
		};
		visit(replies[0], [], 0, undefined);
		paint(lines);
	};

	let busy = false;
	let again = false;
	const refresh = () => {
		if (busy) {
			again = true;
			return;
		}
		busy = true;
		while (true) {
			again = false;
			const [ok, err] = pcall(refreshOnce);
			if (!ok) {
				$warn(`[devtools] state refresh failed: ${err}`);
				setStatus(`Failed: ${err}`, COLORS.bad);
			}
			if (!again) break;
		}
		busy = false;
	};
	requestRefresh = () => {
		tab.trove.add(task.spawn(refresh));
	};

	// First load at once, then every AUTO_REFRESH s while Auto is on.
	tab.trove.add(
		task.spawn(() => {
			refresh();
			while (true) {
				task.wait(AUTO_REFRESH);
				if (persist.auto !== false) refresh();
			}
		}),
	);
}
