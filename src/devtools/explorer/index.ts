import { TextService, UserInputService, Workspace } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { popIn } from "../../ui";
import { copyText } from "../widgets";
import {
	ChildrenPage,
	FindPage,
	PAGE,
	PropRow,
	PropsReply,
	Realm,
	Registry,
	Row,
	classInfo,
	enumItems,
	explorerHandlers,
	luaPath,
	rowBefore,
	servicePath,
} from "./core";

export type { Realm } from "./core";

/** Remembered across swaps when the caller passes kernel.persist(...). */
export interface ExplorerPersist {
	realm?: Realm;
	split?: number;
	deprecated?: boolean;
	auto?: boolean;
}

export interface ExplorerDeps {
	/** Sends one dev op ("explorer.*") to the server; resolves with the reply, rejects with the error text. */
	readonly request: (op: string, payload: unknown) => Promise<unknown>;
	/** Whether edit controls show for a realm. Cosmetic: the server re-checks every change. */
	readonly canEdit: (realm: Realm) => boolean;
	trove: Trove;
	persist?: ExplorerPersist;
	/** Selection changes, with a Luau path like game.Workspace.Coins (e.g. for the Claude tab's context). */
	readonly onSelect?: (realm: Realm, path?: string) => void;
}

const TOUCH = UserInputService.TouchEnabled && !UserInputService.MouseEnabled;
/** Tree row height: 20 px with a mouse, 32 px touch targets on phones. */
const ROW = TOUCH ? 32 : 20;
const PROP = TOUCH ? 34 : 24;
const INDENT = 14;
const BAR = 34;
/** The up button: a thin chevron in a small square. */
const UP = TOUCH ? 32 : 30;
/** Breadcrumb bar under the toolbar. */
const CRUMB = TOUCH ? 32 : 24;
const STATUS = TOUCH ? 32 : 26;
const SPLIT = TOUCH ? 16 : 10;
/** Inner padding of both panes, so text never touches the edge or sits under the scrollbar. */
const INSET = 10;
const TREE_TOP = 4;
const TREE_LEFT = 4;
const AUTO_REFRESH = 3;
/**
 * Class icons: Studio's ClassImages.PNG (a 2352x16 strip) repacked into a 32-column grid (512x80, same order), uploaded
 * as an image. Live clients downscale textures wider than 1024 px, so 16 px offsets into the original strip landed on
 * the wrong, squished icons. Source: framework/assets/class-icons.png.
 */
const ICONS = "rbxassetid://97389585475400";
const ICON_COLUMNS = 32;
const STALE = "explorer: stale";

const COLORS = {
	pane: Color3.fromRGB(28, 31, 38),
	header: Color3.fromRGB(30, 33, 41),
	row: Color3.fromRGB(36, 40, 50),
	button: Color3.fromRGB(50, 55, 68),
	selection: Color3.fromRGB(60, 74, 104),
	stroke: Color3.fromRGB(64, 69, 82),
	accent: Color3.fromRGB(255, 138, 61),
	text: Color3.fromRGB(232, 234, 240),
	dim: Color3.fromRGB(150, 157, 172),
	good: Color3.fromRGB(112, 214, 134),
	bad: Color3.fromRGB(255, 107, 107),
	info: Color3.fromRGB(122, 178, 255),
	dark: Color3.fromRGB(18, 18, 22),
};

function make<T extends keyof CreatableInstances>(
	className: T,
	props: Partial<WritableInstanceProperties<CreatableInstances[T]>>,
	parent?: Instance,
): CreatableInstances[T] {
	const instance = new Instance(className);
	for (const [key, value] of pairs(props as unknown as Record<string, unknown>)) {
		(instance as unknown as Record<string, unknown>)[key] = value;
	}
	if (parent) instance.Parent = parent;
	return instance;
}

function corner(parent: Instance, radius = 6) {
	make("UICorner", { CornerRadius: new UDim(0, radius) }, parent);
}

function text<T extends TextLabel | TextButton | TextBox>(gui: T, value: string, size = 15, color = COLORS.text): T {
	gui.Text = value;
	gui.TextSize = size;
	gui.TextColor3 = color;
	gui.Font = Enum.Font.BuilderSans;
	gui.TextXAlignment = Enum.TextXAlignment.Left;
	gui.TextTruncate = Enum.TextTruncate.AtEnd;
	gui.BorderSizePixel = 0;
	return gui;
}

function button(parent: Instance, label: string, width: number, order: number): TextButton {
	const gui = text(make("TextButton", { AutoButtonColor: true, BackgroundColor3: COLORS.button }, parent), label);
	gui.Font = Enum.Font.BuilderSansMedium;
	gui.TextXAlignment = Enum.TextXAlignment.Center;
	gui.Size = new UDim2(0, width, 1, 0);
	gui.LayoutOrder = order;
	corner(gui);
	return gui;
}

function escape(value: string): string {
	return value.gsub("&", "&amp;")[0].gsub("<", "&lt;")[0].gsub(">", "&gt;")[0];
}

/** A thin bar for icons drawn from Frames (no glyphs). */
function bar(parent: Instance, length: number, color = COLORS.dim): Frame {
	return make(
		"Frame",
		{ AnchorPoint: new Vector2(0.5, 0.5), BackgroundColor3: color, BorderSizePixel: 0, Size: UDim2.fromOffset(length, 2) },
		parent,
	);
}

/** Two bars as a ">" (closed) or "v" (open) chevron. GUI rotation is not inherited, so each bar moves itself. */
function chevron(bars: Frame[], open: boolean) {
	bars[0].Rotation = 45;
	bars[1].Rotation = -45;
	bars[0].Position = open ? new UDim2(0.5, -2, 0.5, 0) : new UDim2(0.5, 0, 0.5, -2);
	bars[1].Position = open ? new UDim2(0.5, 2, 0.5, 0) : new UDim2(0.5, 0, 0.5, 2);
}

interface Entry {
	id: number;
	depth: number;
	/** A "load more" row for the children of `id`. */
	more?: boolean;
	/** The "Descendants" divider in search results. */
	divider?: boolean;
	/** Search results: the path from the search root ("Coins › Coin3"). */
	path?: string;
}

/** Search results, shown in the tree pane while the search box has text. */
interface Results {
	/** Pass 1 (instant, from the cache): matching direct children of the search root. */
	direct: number[];
	/** Pass 2 (paged walk): [id, relative path] of matching descendants. */
	hits: [number, string][];
	done: boolean;
}

interface Slot {
	frame: TextButton;
	toggle: TextButton;
	bars: Frame[];
	icon: ImageLabel;
	label: TextLabel;
	entry?: Entry;
}

/**
 * Studio-like explorer + properties (plans/10, Dex): a virtualized tree (a pool of row Frames rebound on scroll, never
 * one Frame per instance) beside a ReflectionService property grid, for the local DataModel ("client") or the
 * server's ("server", lazily over `deps.request`). Fills `parent`; returns a cleanup function.
 */
export function mountExplorer(parent: GuiObject, deps: ExplorerDeps): () => void {
	const trove = deps.trove.extend();
	const persist = deps.persist ?? {};
	const localOps = explorerHandlers(new Registry(), () => deps.canEdit("client"));
	let alive = true;
	trove.add(() => (alive = false));

	let realm: Realm = persist.realm === "server" ? "server" : "client";
	let epoch = 0;
	let nodes = new Map<number, Row>();
	let kids = new Map<number, number[]>();
	let totals = new Map<number, number>();
	let expanded = new Set<number>();
	let selected: number | undefined;
	let query = "";
	let results: Results | undefined;
	let searchRoot = 0;
	const loading = new Set<number>();
	let visible = new Array<Entry>();

	// Layout ------------------------------------------------------------------------------------------------------

	const root = trove.add(make("Frame", { Name: "Explorer", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1) }, parent));
	const toolbar = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, BAR) }, root);
	make(
		"UIListLayout",
		{
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, 6),
		},
		toolbar,
	);
	// Thin "^" from two 2 px bars (about 9 px wide), no glyphs.
	const upButton = button(toolbar, "", UP, 1);
	upButton.Size = UDim2.fromOffset(UP, UP);
	const upLeft = bar(upButton, 6);
	upLeft.Position = new UDim2(0.5, -2, 0.5, 0);
	upLeft.Rotation = -45;
	const upRight = bar(upButton, 6);
	upRight.Position = new UDim2(0.5, 2, 0.5, 0);
	upRight.Rotation = 45;
	const realmButtons = new Map<Realm, TextButton>([
		["client", button(toolbar, "Client", 64, 2)],
		["server", button(toolbar, "Server", 64, 3)],
	]);
	const realmWidth = () => (root.AbsoluteSize.X < 440 ? 54 : 64);
	const searchBox = text(make("TextBox", { ClearTextOnFocus: false, BackgroundColor3: COLORS.row }, toolbar), "");
	searchBox.PlaceholderText = "Search name or class";
	searchBox.PlaceholderColor3 = COLORS.dim;
	searchBox.LayoutOrder = 4;
	corner(searchBox);
	make("UIPadding", { PaddingLeft: new UDim(0, 8), PaddingRight: new UDim(0, 8) }, searchBox);
	const refreshButton = button(toolbar, "Refresh", 80, 5);
	// Narrow screens (phones) get slimmer buttons so the search box keeps room.
	const sizeToolbar = () => {
		const width = realmWidth();
		for (const [, gui] of realmButtons) gui.Size = new UDim2(0, width, 1, 0);
		refreshButton.Size = new UDim2(0, width + 14, 1, 0);
		searchBox.Size = new UDim2(1, -(UP + 3 * width + 14 + 4 * 6), 1, 0);
	};
	trove.connect(root.GetPropertyChangedSignal("AbsoluteSize"), sizeToolbar);
	sizeToolbar();

	const crumbs = make("Frame", { BackgroundTransparency: 1, ClipsDescendants: true }, root);
	crumbs.Position = UDim2.fromOffset(0, BAR + 4);
	crumbs.Size = new UDim2(1, 0, 0, CRUMB);
	make(
		"UIListLayout",
		{
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
		},
		crumbs,
	);
	const top = BAR + 4 + CRUMB + 4;
	const body = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(0, top) }, root);
	body.Size = new UDim2(1, 0, 1, -(top + STATUS + 6));
	const pane = (name: string) => {
		const frame = make("Frame", { Name: name, BackgroundColor3: COLORS.pane, BorderSizePixel: 0, ClipsDescendants: true }, body);
		corner(frame);
		return frame;
	};
	const scroller = (parentPane: Frame, automatic: boolean) =>
		make(
			"ScrollingFrame",
			{
				BackgroundTransparency: 1,
				BorderSizePixel: 0,
				Size: UDim2.fromScale(1, 1),
				CanvasSize: new UDim2(),
				AutomaticCanvasSize: automatic ? Enum.AutomaticSize.Y : Enum.AutomaticSize.None,
				ScrollingDirection: Enum.ScrollingDirection.Y,
				ScrollBarThickness: 6,
				ScrollBarImageColor3: COLORS.dim,
				VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
			},
			parentPane,
		);
	const treePane = pane("Tree");
	// The one ScrollingFrame that sets CanvasSize itself: rows x ROW px, drawn by a pool of reusable rows.
	// No UIPadding on ScrollingFrames: it shifts scale-width children without shrinking them, so they overflow the
	// right edge. Rows are inset by their own Position/Size instead (bind, makeSlot).
	const tree = scroller(treePane, false);
	const splitter = make("TextButton", { Text: "", AutoButtonColor: false, BackgroundTransparency: 1 }, body);
	const grip = make("Frame", { AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5) }, splitter);
	grip.BackgroundColor3 = COLORS.stroke;
	grip.BorderSizePixel = 0;
	corner(grip, 2);
	const propsPane = pane("Properties");
	// Script-free: AutomaticCanvasSize + a list layout.
	const props = scroller(propsPane, true);
	// The padding lives on a plain inner Frame (see the tree note above); rows go into propsList.
	const propsList = make(
		"Frame",
		{ Name: "List", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y },
		props,
	);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 2) }, propsList);
	make(
		"UIPadding",
		{
			PaddingTop: new UDim(0, 6),
			PaddingBottom: new UDim(0, INSET),
			PaddingLeft: new UDim(0, 8),
			PaddingRight: new UDim(0, INSET),
		},
		propsList,
	);

	const statusBar = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 1) }, root);
	statusBar.Position = UDim2.fromScale(0, 1);
	statusBar.Size = new UDim2(1, 0, 0, STATUS);
	const status = text(make("TextBox", { BackgroundTransparency: 1, ClearTextOnFocus: false, TextEditable: false }, statusBar), "");
	status.Font = Enum.Font.Code;
	status.TextSize = 14;
	status.Size = new UDim2(1, -86, 1, 0);
	const autoButton = button(statusBar, "Auto", 80, 0);
	autoButton.AnchorPoint = new Vector2(1, 0);
	autoButton.Position = UDim2.fromScale(1, 0);
	const setStatus = (value: string, color = COLORS.dim) => {
		status.Text = value;
		status.TextColor3 = color;
	};

	// Copy popups (widgets.copyText) open next to the row they copy from but are anchored to this pin, moved over that
	// row: rows are rebuilt by refreshes and rebound on scroll, the pin lives as long as the explorer.
	const copyPin = make("Frame", { Name: "CopyPin", BackgroundTransparency: 1, Active: false }, root);
	const copyFrom = (source: GuiObject, value: string) => {
		const at = source.AbsolutePosition.sub(root.AbsolutePosition);
		copyPin.Position = UDim2.fromOffset(at.X, at.Y);
		copyPin.Size = UDim2.fromOffset(source.AbsoluteSize.X, source.AbsoluteSize.Y);
		copyText(value, copyPin);
	};
	/** Right-click (buttons and boxes) and, except on text boxes (their long-press is the native copy menu), long-press. */
	const onMenu = (gui: GuiObject, open: () => void) => {
		if (gui.IsA("GuiButton")) gui.MouseButton2Click.Connect(open);
		else {
			gui.InputBegan.Connect((input) => {
				if (input.UserInputType === Enum.UserInputType.MouseButton2) open();
			});
		}
		if (!gui.IsA("TextBox")) {
			gui.TouchLongPress.Connect((_, state) => {
				if (state === Enum.UserInputState.Begin) open();
			});
		}
	};

	let split = math.clamp(persist.split ?? 0.5, 0.2, 0.8);
	const vertical = () => body.AbsoluteSize.X < 520;
	const layout = () => {
		const half = SPLIT / 2;
		if (vertical()) {
			treePane.Size = new UDim2(1, 0, split, -half);
			splitter.Position = new UDim2(0, 0, split, -half);
			splitter.Size = new UDim2(1, 0, 0, SPLIT);
			propsPane.Position = new UDim2(0, 0, split, half);
			propsPane.Size = new UDim2(1, 0, 1 - split, -half);
			grip.Size = UDim2.fromOffset(40, 4);
		} else {
			treePane.Size = new UDim2(split, -half, 1, 0);
			splitter.Position = new UDim2(split, -half, 0, 0);
			splitter.Size = new UDim2(0, SPLIT, 1, 0);
			propsPane.Position = new UDim2(split, half, 0, 0);
			propsPane.Size = new UDim2(1 - split, -half, 1, 0);
			grip.Size = UDim2.fromOffset(4, 40);
		}
	};
	trove.connect(body.GetPropertyChangedSignal("AbsoluteSize"), layout);
	layout();

	// Dragging works on deltas, so GUI insets never matter.
	let drag: [Vector3, number] | undefined;
	const isPress = (input: InputObject) =>
		input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
	trove.connect(splitter.InputBegan, (input) => {
		if (isPress(input)) drag = [input.Position, split];
	});
	trove.connect(UserInputService.InputChanged, (input) => {
		if (!drag) return;
		if (input.UserInputType !== Enum.UserInputType.MouseMovement && input.UserInputType !== Enum.UserInputType.Touch) return;
		const delta = input.Position.sub(drag[0]);
		const moved = vertical() ? delta.Y / body.AbsoluteSize.Y : delta.X / body.AbsoluteSize.X;
		split = math.clamp(drag[1] + moved, 0.2, 0.8);
		persist.split = split;
		layout();
	});
	trove.connect(UserInputService.InputEnded, (input) => {
		if (isPress(input)) drag = undefined;
	});

	// Requests ----------------------------------------------------------------------------------------------------

	/** Runs one op in the current realm (yields for server ops). A closed explorer or a realm switch stops the thread. */
	const call = (op: string, payload: unknown): unknown => {
		const myEpoch = epoch;
		let ok: boolean;
		let result: unknown;
		if (realm === "client") [ok, result] = pcall(localOps[op], payload);
		else [ok, result] = deps.request(`explorer.${op}`, payload).await();
		if (!alive || myEpoch !== epoch) error(STALE, 0);
		if (!ok) error(result, 0);
		return result;
	};
	const go = (callback: () => void) => {
		task.spawn(() => {
			const [ok, err] = pcall(callback);
			if (!ok && err !== STALE && alive) setStatus(tostring(err), COLORS.bad);
		});
	};

	// Tree --------------------------------------------------------------------------------------------------------

	const slots = new Array<Slot>();
	const isOpen = (id: number) => expanded.has(id);
	const hit = (row: Row) =>
		query !== "" &&
		(row.name.lower().find(query, 1, true)[0] !== undefined || row.className.lower().find(query, 1, true)[0] !== undefined);

	const bind = (slot: Slot, entry: Entry, index: number) => {
		slot.entry = entry;
		slot.frame.Visible = true;
		slot.frame.Position = UDim2.fromOffset(TREE_LEFT, TREE_TOP + index * ROW);
		const row = nodes.get(entry.id);
		const plain = entry.more || entry.divider;
		// Tree rows: indent + chevron column. Search results: flat, no chevrons.
		const x = results ? 0 : entry.depth * INDENT;
		const lead = results ? 6 : x + ROW;
		slot.toggle.Position = UDim2.fromOffset(x, 0);
		slot.toggle.Visible = !plain && !results && row !== undefined && row.childCount > 0;
		slot.icon.Visible = !plain;
		slot.icon.Position = new UDim2(0, lead, 0.5, 0);
		slot.label.Position = new UDim2(0, lead + (plain ? 0 : 22), 0, 0);
		slot.label.Size = new UDim2(1, -(lead + 26), 1, 0);
		slot.frame.BackgroundTransparency = !plain && entry.id === selected ? 0 : 1;
		if (entry.divider) {
			slot.label.Text = "Descendants";
			slot.label.TextColor3 = COLORS.dim;
			return;
		}
		if (entry.more || !row) {
			const left = (totals.get(entry.id) ?? 0) - (kids.get(entry.id)?.size() ?? 0);
			slot.label.Text = `Load more (${left} left)`;
			slot.label.TextColor3 = COLORS.info;
			return;
		}
		chevron(slot.bars, isOpen(entry.id));
		const iconIndex = classInfo(row.className)[0];
		slot.icon.ImageRectOffset = new Vector2((iconIndex % ICON_COLUMNS) * 16, math.floor(iconIndex / ICON_COLUMNS) * 16);
		slot.label.Text = `${escape(entry.path ?? row.name)}  <font color="#${COLORS.dim.ToHex()}">${row.className}</font>`;
		slot.label.TextColor3 = COLORS.text;
	};

	const render = () => {
		// Rows + top padding + room at the bottom so the last row is never cut.
		tree.CanvasSize = UDim2.fromOffset(0, visible.size() * ROW + TREE_TOP + INSET);
		const first = math.max(0, math.floor((tree.CanvasPosition.Y - TREE_TOP) / ROW));
		slots.forEach((slot, index) => {
			const entry = visible[first + index];
			if (entry) bind(slot, entry, first + index);
			else {
				slot.frame.Visible = false;
				slot.entry = undefined;
			}
		});
	};

	/** visible = the search results, or a depth-first walk over the loaded children of every open node. */
	const rebuild = () => {
		const list = new Array<Entry>();
		const walk = (id: number, depth: number) => {
			const children = kids.get(id);
			if (!children) return;
			for (const child of children) {
				list.push({ id: child, depth });
				if (isOpen(child)) walk(child, depth + 1);
			}
			if ((totals.get(id) ?? 0) > children.size()) list.push({ id, depth, more: true });
		};
		if (results) {
			for (const id of results.direct) list.push({ id, depth: 0 });
			if (results.hits.size() > 0 || !results.done) list.push({ id: -1, depth: 0, divider: true });
			for (const [id, path] of results.hits) list.push({ id, depth: 0, path });
		} else walk(0, 0);
		visible = list;
		render();
	};

	const forget = (id: number) => {
		expanded.delete(id);
		kids.delete(id);
		totals.delete(id);
		nodes.delete(id);
		if (selected === id) choose(undefined);
	};

	const apply = (page: ChildrenPage, append: boolean) => {
		if (page.gone) return forget(page.id);
		const ids = append ? kids.get(page.id) ?? [] : [];
		for (const row of page.rows) {
			nodes.set(row.id, row);
			ids.push(row.id);
		}
		kids.set(page.id, ids);
		totals.set(page.id, page.total);
		const row = nodes.get(page.id);
		if (row) row.childCount = page.total;
	};

	const fetch = (requests: { id: number; offset?: number; limit?: number }[], append = false) => {
		for (let start = 0; start < requests.size(); start += 64) {
			const chunk = new Array<{ id: number; offset?: number; limit?: number }>();
			for (let index = start; index < math.min(start + 64, requests.size()); index++) chunk.push(requests[index]);
			for (const page of call("children", { nodes: chunk }) as ChildrenPage[]) apply(page, append);
		}
	};

	const load = (id: number, more = false) => {
		if (loading.has(id)) return;
		loading.add(id);
		go(() => {
			const [ok, err] = pcall(() => fetch([{ id, offset: more ? kids.get(id)?.size() ?? 0 : 0 }], more));
			loading.delete(id);
			if (!ok) error(err, 0);
			rebuild();
		});
	};

	const toggle = (id: number) => {
		if (results) return;
		if (isOpen(id)) expanded.delete(id);
		else {
			expanded.add(id);
			if (!kids.has(id)) return load(id);
		}
		rebuild();
	};

	const scrollTo = (id: number) => {
		const index = visible.findIndex((entry) => !entry.more && entry.id === id);
		if (index === -1) return;
		const top = tree.CanvasPosition.Y;
		const view = tree.AbsoluteWindowSize.Y - INSET;
		const y = index * ROW + TREE_TOP;
		if (y < top) tree.CanvasPosition = new Vector2(0, y);
		else if (y + ROW > top + view) tree.CanvasPosition = new Vector2(0, y + ROW - view);
	};

	let choose: (id: number | undefined, scroll?: boolean) => void;
	const announce = () => deps.onSelect?.(realm, selected !== undefined ? pathOf(selected) : undefined);
	let openMenu: (slot: Slot) => void;
	let lastClick: [number, number] = [-1, 0];
	const makeSlot = (): Slot => {
		const frame = make("TextButton", { Text: "", AutoButtonColor: false, BorderSizePixel: 0, Visible: false }, tree);
		frame.BackgroundColor3 = COLORS.selection;
		frame.Size = new UDim2(1, -(TREE_LEFT + INSET), 0, ROW);
		const toggleButton = make("TextButton", { Text: "", BackgroundTransparency: 1, Size: UDim2.fromOffset(ROW, ROW) }, frame);
		const bars = [bar(toggleButton, 7), bar(toggleButton, 7)];
		const icon = make("ImageLabel", { BackgroundTransparency: 1, Image: ICONS, ImageRectSize: new Vector2(16, 16) }, frame);
		icon.Size = UDim2.fromOffset(16, 16);
		icon.AnchorPoint = new Vector2(0, 0.5);
		const label = text(make("TextLabel", { BackgroundTransparency: 1, RichText: true }, frame), "", TOUCH ? 15 : 14);
		const slot: Slot = { frame, toggle: toggleButton, bars, icon, label };
		frame.Activated.Connect(() => {
			const entry = slot.entry;
			if (!entry || entry.divider) return;
			if (entry.more) return load(entry.id, true);
			if (results) {
				// A search result: select it now, expand its ancestors in the tree behind the results.
				choose(entry.id);
				return reveal(entry.id, true);
			}
			const now = os.clock();
			if (lastClick[0] === entry.id && now - lastClick[1] < 0.35) toggle(entry.id);
			lastClick = [entry.id, now];
			choose(entry.id);
		});
		toggleButton.Activated.Connect(() => slot.entry && !slot.entry.more && toggle(slot.entry.id));
		frame.MouseButton2Click.Connect(() => openMenu(slot));
		frame.TouchLongPress.Connect((_, state) => state === Enum.UserInputState.Begin && openMenu(slot));
		return slot;
	};
	const resizePool = () => {
		const need = math.ceil(tree.AbsoluteWindowSize.Y / ROW) + 4;
		while (slots.size() < need) slots.push(makeSlot());
		render();
	};
	trove.connect(tree.GetPropertyChangedSignal("CanvasPosition"), render);
	trove.connect(tree.GetPropertyChangedSignal("AbsoluteWindowSize"), resizePool);

	/** Path from the cached rows (no request): game.Workspace.Map["Spawn point"]. */
	const pathOf = (id: number) => {
		const names = new Array<string>();
		for (let row = nodes.get(id); row; row = row.parent !== 0 ? nodes.get(row.parent) : undefined) names.unshift(row.name);
		return luaPath(names);
	};

	/**
	 * "Copy path": workspace.Map.Part or game:GetService("ReplicatedStorage").X, from the cached rows. The second value
	 * is false when an ancestor isn't cached (search hits), so the path doesn't reach game yet.
	 */
	const servicePathOf = (id: number): [string, boolean] => {
		const names = new Array<string>();
		let top: Row | undefined;
		for (let row = nodes.get(id); row; row = row.parent !== 0 ? nodes.get(row.parent) : undefined) {
			names.unshift(row.name);
			top = row;
		}
		return [servicePath(names, top?.className), top !== undefined && top.parent === 0];
	};

	/**
	 * Breadcrumbs: game > ... > selection, every segment selects that ancestor (ids, so the server realm works too).
	 * When the path doesn't fit, "game" and the last segments stay and the middle collapses to "...".
	 */
	const crumbTrove = trove.extend();
	const drawCrumbs = () => {
		crumbTrove.clean();
		// [id, name]: 0 = game, -1 = the collapsed middle.
		const chain = new Array<[number, string]>();
		for (let row = selected !== undefined ? nodes.get(selected) : undefined; row; row = row.parent !== 0 ? nodes.get(row.parent) : undefined) {
			chain.unshift([row.id, row.name]);
		}
		chain.unshift([0, "game"]);
		const SEPARATOR = 14;
		const widthOf = (label: string) => TextService.GetTextSize(label, 14, Enum.Font.BuilderSans, new Vector2(10000, CRUMB)).X + 10;
		const room = crumbs.AbsoluteSize.X;
		let total = 0;
		for (const [, name] of chain) total += widthOf(name) + SEPARATOR;
		let shown = chain;
		if (total > room && chain.size() > 2) {
			let used = widthOf("game") + widthOf("...") + widthOf(chain[chain.size() - 1][1]) + 3 * SEPARATOR;
			let first = chain.size() - 1;
			while (first > 1 && used + widthOf(chain[first - 1][1]) + SEPARATOR <= room) {
				first -= 1;
				used += widthOf(chain[first][1]) + SEPARATOR;
			}
			shown = [chain[0]];
			if (first > 1) shown.push([-1, "..."]);
			for (let index = first; index < chain.size(); index++) shown.push(chain[index]);
		}
		let used = 0;
		shown.forEach((segment, index) => {
			if (index > 0) {
				const separator = crumbTrove.add(make("Frame", { BackgroundTransparency: 1, LayoutOrder: index * 2 - 1 }, crumbs));
				separator.Size = UDim2.fromOffset(SEPARATOR, CRUMB);
				chevron([bar(separator, 6), bar(separator, 6)], false);
				used += SEPARATOR;
			}
			const last = index === shown.size() - 1;
			const [id, label] = segment;
			const gui = crumbTrove.add(text(make("TextButton", { BackgroundTransparency: 1, LayoutOrder: index * 2 }, crumbs), label, 14));
			gui.TextColor3 = last ? COLORS.text : COLORS.dim;
			gui.TextXAlignment = Enum.TextXAlignment.Center;
			const width = widthOf(label);
			gui.Size = UDim2.fromOffset(last ? math.max(40, math.min(width, room - used)) : width, CRUMB);
			used += width;
			if (id === -1) return;
			gui.Activated.Connect(() => {
				if (id !== 0) return choose(id, true);
				choose(undefined);
				tree.CanvasPosition = Vector2.zero;
			});
		});
	};
	trove.connect(crumbs.GetPropertyChangedSignal("AbsoluteSize"), () => drawCrumbs());

	/**
	 * Expands every ancestor of `id` (loading as needed) and selects it: Instance links and leaving a search.
	 * `inPlace` (search results) keeps the results on screen and only prepares the tree behind them.
	 */
	const reveal = (id: number, inPlace = false) =>
		go(() => {
			if (results && !inPlace) {
				results = undefined;
				query = "";
				searchBox.Text = "";
			}
			for (const row of call("ancestry", { id }) as Row[]) {
				if (row.parent !== 0) expanded.add(row.parent);
				if (!kids.has(row.parent)) fetch([{ id: row.parent }]);
				const siblings = kids.get(row.parent);
				if (siblings && !siblings.includes(row.id)) siblings.push(row.id);
				if (!nodes.has(row.id)) nodes.set(row.id, row);
			}
			rebuild();
			if (!inPlace) return choose(id, true);
			drawCrumbs();
			announce();
		});

	// Properties --------------------------------------------------------------------------------------------------

	const propsTrove = trove.extend();
	const closedCategories = new Set<string>();
	let current: PropsReply | undefined;
	let propsEpoch = 0;
	let drawProps: () => void;

	const loadProps = (id: number | undefined, keepScroll = false) => {
		propsEpoch += 1;
		const mine = propsEpoch;
		if (id === undefined) {
			current = undefined;
			return drawProps();
		}
		go(() => {
			const [ok, reply] = pcall(() => call("props", { id }) as PropsReply);
			if (mine !== propsEpoch || reply === STALE) return;
			if (!ok) {
				if (reply === "gone") {
					forget(id);
					rebuild();
				}
				error(reply, 0);
			}
			current = reply;
			const scroll = props.CanvasPosition;
			drawProps();
			props.CanvasPosition = keepScroll ? scroll : Vector2.zero;
		});
	};

	choose = (id, scroll = false) => {
		selected = id;
		if (scroll && id !== undefined) scrollTo(id);
		render();
		drawCrumbs();
		loadProps(id);
		announce();
	};

	/** Sends one typed edit; `failed` reverts an optimistic change (checkboxes) before the grid reloads. */
	const commit = (row: PropRow, value: string, failed?: () => void) => {
		const id = current?.id;
		if (id === undefined) return;
		go(() => {
			const [ok, reply] = pcall(() => call(row.category === "Attributes" ? "attr" : "set", { id, name: row.name, text: value }));
			if (!ok && reply === STALE) return;
			if (!ok) failed?.();
			setStatus(ok ? `${row.name} = ${reply}` : `${row.name}: ${tostring(reply).sub(1, 120)}`, ok ? COLORS.good : COLORS.bad);
			const node = nodes.get(id);
			if (ok && row.name === "Name" && node) {
				node.name = tostring(reply);
				render();
				drawCrumbs();
			}
			loadProps(id, true);
		});
	};

	// Overlays (context menu, enum dropdown): one at a time, over a backdrop that closes it.
	let overlay: TextButton | undefined;
	const closeOverlay = () => {
		overlay?.Destroy();
		overlay = undefined;
	};
	const openOverlay = (anchor: GuiObject, width: number, height: number): Frame => {
		closeOverlay();
		const backdrop = make("TextButton", { Text: "", AutoButtonColor: false, BackgroundTransparency: 1, ZIndex: 50 }, root);
		backdrop.Size = UDim2.fromScale(1, 1);
		backdrop.Activated.Connect(closeOverlay);
		backdrop.MouseButton2Click.Connect(closeOverlay);
		overlay = backdrop;
		const panel = make("Frame", { BackgroundColor3: COLORS.header, BorderSizePixel: 0, ZIndex: 51 }, backdrop);
		panel.Size = UDim2.fromOffset(width, height);
		corner(panel);
		make("UIStroke", { Color: COLORS.stroke, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, panel);
		const at = anchor.AbsolutePosition.sub(root.AbsolutePosition);
		const x = math.clamp(at.X, 0, math.max(0, root.AbsoluteSize.X - width));
		let y = at.Y + anchor.AbsoluteSize.Y;
		if (y + height > root.AbsoluteSize.Y) y = math.max(0, at.Y - height);
		panel.Position = UDim2.fromOffset(x, y);
		popIn(panel);
		return panel;
	};
	const listIn = (panel: Frame, automatic: boolean) => {
		const scroll = scroller(panel as Frame, automatic);
		// Items go into a plain inner Frame that carries the padding (see the tree note).
		const list = make(
			"Frame",
			{ Name: "List", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y },
			scroll,
		);
		make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 2) }, list);
		make("UIPadding", { PaddingTop: new UDim(0, 4), PaddingBottom: new UDim(0, 4), PaddingLeft: new UDim(0, 4), PaddingRight: new UDim(0, 4) }, list);
		return list;
	};
	const item = (list: Instance, label: string, onClick: () => void, color = COLORS.text) => {
		const gui = text(make("TextButton", { AutoButtonColor: true, BackgroundColor3: COLORS.header, ZIndex: 52 }, list), label, 15, color);
		gui.Size = new UDim2(1, 0, 0, TOUCH ? 34 : 26);
		gui.LayoutOrder = list.GetChildren().size();
		make("UIPadding", { PaddingLeft: new UDim(0, 8) }, gui);
		gui.Activated.Connect(onClick);
		return gui;
	};

	const openEnum = (anchor: GuiObject, row: PropRow) => {
		const items = enumItems(row.enumType ?? "");
		if (items.size() === 0) return;
		const height = math.min(items.size() * ((TOUCH ? 34 : 26) + 2) + 8, 260);
		const list = listIn(openOverlay(anchor, math.max(anchor.AbsoluteSize.X, 160), height), true);
		for (const enumItem of items) {
			item(list, enumItem.Name, () => {
				closeOverlay();
				if (enumItem.Name !== row.text) commit(row, enumItem.Name);
			}, enumItem.Name === row.text ? COLORS.accent : COLORS.text);
		}
	};

	/** Context menu of a property, attribute or tags row: copy its value or its name. */
	const openCopyMenu = (anchor: GuiObject, name: string, value: string) => {
		const actions: [string, string][] = [
			["Copy value", value],
			["Copy name", name],
		];
		const height = actions.size() * ((TOUCH ? 34 : 26) + 2) + 8;
		const list = listIn(openOverlay(anchor, 160, height), false);
		for (const [label, copied] of actions) {
			item(list, label, () => {
				closeOverlay();
				copyFrom(anchor, copied);
			});
		}
	};

	/** `menu` opens the row's Copy menu; every interactive value cell forwards right-click (and long-press) to it. */
	const valueEditor = (slot: Frame, row: PropRow, editable: boolean, menu: () => void) => {
		const dimmed = editable ? COLORS.text : COLORS.dim;
		// Long values end in an ellipsis; hovering shows the full value in the status bar (the editor holds it too).
		slot.MouseEnter.Connect(() => setStatus(`${row.name} = ${row.text}`, COLORS.text));
		if (row.kind === "Instance" && row.ref !== undefined) {
			const link = text(make("TextButton", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1) }, slot), row.text, 14, COLORS.info);
			link.Activated.Connect(() => reveal(row.ref!));
			onMenu(link, menu);
		} else if (row.kind === "boolean") {
			// Checkbox: the whole value cell is the touch target; the box is 20 px (24 on touch).
			const hitArea = make("TextButton", { Text: "", AutoButtonColor: false, BackgroundTransparency: 1 }, slot);
			hitArea.Size = UDim2.fromScale(1, 1);
			onMenu(hitArea, menu);
			const size = TOUCH ? 24 : 20;
			const box = make("Frame", { BorderSizePixel: 0, AnchorPoint: new Vector2(0, 0.5), Position: UDim2.fromScale(0, 0.5) }, hitArea);
			box.Size = UDim2.fromOffset(size, size);
			corner(box, 4);
			const outline = make("UIStroke", { Thickness: 1.5, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, box);
			// Check mark from two rotated bars: a short leg down-right, a long leg up-right.
			const tick = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1) }, box);
			const shortLeg = bar(tick, 6, COLORS.dark);
			shortLeg.Position = new UDim2(0.5, -3, 0.5, 1);
			shortLeg.Rotation = 45;
			const longLeg = bar(tick, 11, COLORS.dark);
			longLeg.Position = new UDim2(0.5, 2, 0.5, -1);
			longLeg.Rotation = -50;
			let checked = row.text === "true";
			const paint = () => {
				const on = editable ? COLORS.accent : COLORS.dim;
				box.BackgroundColor3 = checked ? on : COLORS.row;
				box.BackgroundTransparency = editable ? 0 : 0.35;
				outline.Color = checked ? on : editable ? COLORS.dim : COLORS.stroke;
				tick.Visible = checked;
			};
			paint();
			if (editable) {
				hitArea.Activated.Connect(() => {
					checked = !checked;
					paint();
					commit(row, checked ? "true" : "false", () => {
						checked = !checked;
						paint();
					});
				});
			}
		} else if (row.kind === "Enum" && editable) {
			const pick = text(make("TextButton", { AutoButtonColor: true, BackgroundColor3: COLORS.row }, slot), row.text, 14);
			pick.Size = UDim2.fromScale(1, 1);
			corner(pick, 4);
			make("UIPadding", { PaddingLeft: new UDim(0, 6) }, pick);
			pick.Activated.Connect(() => openEnum(pick, row));
			onMenu(pick, menu);
		} else {
			let offset = 0;
			if (row.kind === "Color3") {
				const [r, g, b] = row.text.match("(%d+), (%d+), (%d+)") as LuaTuple<[string?, string?, string?]>;
				const swatch = make("Frame", { BorderSizePixel: 0, AnchorPoint: new Vector2(0, 0.5), Position: UDim2.fromScale(0, 0.5) }, slot);
				swatch.Size = UDim2.fromOffset(16, 16);
				swatch.BackgroundColor3 = Color3.fromRGB(tonumber(r) ?? 0, tonumber(g) ?? 0, tonumber(b) ?? 0);
				make("UIStroke", { Color: COLORS.stroke, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, swatch);
				offset = 22;
			}
			// Read-only values are TextBoxes too (not labels), so they can be selected and copied in place.
			const box = text(make("TextBox", { ClearTextOnFocus: false, TextEditable: editable, ClipsDescendants: true }, slot), row.text, 14, dimmed);
			box.Font = Enum.Font.Code;
			box.BackgroundColor3 = COLORS.row;
			box.BackgroundTransparency = editable ? 0 : 1;
			box.Position = UDim2.fromOffset(offset, 0);
			box.Size = new UDim2(1, -offset, 1, 0);
			onMenu(box, menu);
			if (editable) {
				corner(box, 4);
				make("UIPadding", { PaddingLeft: new UDim(0, 6), PaddingRight: new UDim(0, 6) }, box);
				box.FocusLost.Connect((enter) => {
					if (enter && box.Text !== row.text) commit(row, box.Text);
					else box.Text = row.text;
				});
			}
		}
	};

	drawProps = () => {
		propsTrove.clean();
		let order = 0;
		const place = <T extends GuiObject>(gui: T): T => {
			order += 1;
			gui.LayoutOrder = order;
			gui.Parent = propsList;
			return propsTrove.add(gui);
		};
		const line = (height = PROP) => place(make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, height) }));
		if (!current) {
			place(text(make("TextLabel", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, PROP) }), "Select an instance", 15, COLORS.dim));
			return;
		}
		const reply = current;
		const edit = deps.canEdit(realm);

		const head = line(PROP + 4);
		const title = text(make("TextLabel", { BackgroundTransparency: 1, RichText: true }, head), "", 16);
		title.Text = `<b>${escape(reply.name)}</b>  <font color="#${COLORS.dim.ToHex()}">${reply.className}</font>`;
		title.Size = new UDim2(1, -120, 1, 0);
		const deprecatedToggle = text(make("TextButton", { AutoButtonColor: true }, head), "Deprecated", 14);
		deprecatedToggle.TextXAlignment = Enum.TextXAlignment.Center;
		deprecatedToggle.BackgroundColor3 = persist.deprecated ? COLORS.accent : COLORS.button;
		deprecatedToggle.TextColor3 = persist.deprecated ? COLORS.dark : COLORS.text;
		deprecatedToggle.AnchorPoint = new Vector2(1, 0.5);
		deprecatedToggle.Position = UDim2.fromScale(1, 0.5);
		deprecatedToggle.Size = new UDim2(0, 110, 1, -4);
		corner(deprecatedToggle, 4);
		deprecatedToggle.Activated.Connect(() => {
			persist.deprecated = !persist.deprecated;
			drawProps();
		});

		const header = (category: string) => {
			const gui = place(text(make("TextButton", { AutoButtonColor: false, BackgroundColor3: COLORS.header }), category, 15, COLORS.accent));
			gui.Font = Enum.Font.BuilderSansBold;
			gui.Size = new UDim2(1, 0, 0, PROP);
			make("UIPadding", { PaddingLeft: new UDim(0, 20) }, gui);
			const holder = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromOffset(16, PROP), Position: UDim2.fromOffset(-20, 0) }, gui);
			chevron([bar(holder, 7, COLORS.accent), bar(holder, 7, COLORS.accent)], !closedCategories.has(category));
			gui.Activated.Connect(() => {
				if (closedCategories.has(category)) closedCategories.delete(category);
				else closedCategories.add(category);
				drawProps();
			});
		};
		let category: string | undefined;
		const rows = [...reply.props, ...reply.attrs];
		for (const row of rows) {
			if (row.deprecated && !persist.deprecated) continue;
			if (row.category !== category) {
				category = row.category;
				header(category);
			}
			if (closedCategories.has(category)) continue;
			// A button row, so right-click / long-press anywhere on it (the name included) opens the Copy menu.
			const frame = place(make("TextButton", { Text: "", AutoButtonColor: false, BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, PROP) }));
			const menu = () => openCopyMenu(frame, row.name, row.text);
			onMenu(frame, menu);
			const name = text(make("TextLabel", { BackgroundTransparency: 1 }, frame), row.name, 14, row.readOnly ? COLORS.dim : COLORS.text);
			name.Size = new UDim2(0.42, -6, 1, 0);
			const slot = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromScale(0.42, 0) }, frame);
			slot.Size = new UDim2(0.58, 0, 1, -2);
			valueEditor(slot, row, edit && !row.readOnly, menu);
		}
		if (reply.tags.size() > 0) {
			header("Tags");
			if (!closedCategories.has("Tags")) {
				// Selectable in place (a read-only TextBox), and in the Copy menu.
				const list = reply.tags.join(", ");
				const tags = place(text(make("TextBox", { BackgroundTransparency: 1, ClearTextOnFocus: false, TextEditable: false }), list, 14));
				tags.TextWrapped = true;
				tags.TextTruncate = Enum.TextTruncate.None;
				tags.Size = UDim2.fromScale(1, 0);
				tags.AutomaticSize = Enum.AutomaticSize.Y;
				onMenu(tags, () => openCopyMenu(tags, "Tags", list));
			}
		}
	};

	// Context menu ------------------------------------------------------------------------------------------------

	let highlight: Highlight | undefined;
	let highlightToken = 0;
	const showInWorld = (id: number) =>
		go(() => {
			const instance = (call("instance", { id }) as { instance?: Instance }).instance;
			if (!instance) return setStatus("Not in your world", COLORS.dim);
			if (!instance.IsA("PVInstance")) return setStatus("Only parts and models", COLORS.dim);
			if (!highlight) {
				highlight = trove.add(make("Highlight", { FillColor: COLORS.accent, OutlineColor: COLORS.accent, FillTransparency: 0.6 }));
				highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop;
				highlight.Parent = Workspace.CurrentCamera ?? Workspace;
			}
			highlight.Adornee = instance;
			highlight.Enabled = true;
			highlightToken += 1;
			const token = highlightToken;
			task.delay(6, () => {
				if (token === highlightToken && highlight) highlight.Enabled = false;
			});
		});

	openMenu = (slot: Slot) => {
		const entry = slot.entry;
		if (!entry || entry.more || entry.divider) return;
		const id = entry.id;
		choose(id);
		const actions: [string, () => void, Color3?][] = [
			["Copy path", () => {
				const source = slot.frame;
				go(() => {
					// Search hits can have ancestors that aren't cached yet: fetch them first.
					if (!servicePathOf(id)[1]) {
						for (const row of call("ancestry", { id }) as Row[]) if (!nodes.has(row.id)) nodes.set(row.id, row);
					}
					copyFrom(source, servicePathOf(id)[0]);
				});
			}],
			["Highlight", () => showInWorld(id)],
		];
		const removeRow = () => {
			const parentId = nodes.get(id)?.parent ?? 0;
			const siblings = kids.get(parentId);
			if (siblings) kids.set(parentId, siblings.filter((other) => other !== id));
			totals.set(parentId, math.max(0, (totals.get(parentId) ?? 1) - 1));
			if (results) {
				results.direct = results.direct.filter((other) => other !== id);
				results.hits = results.hits.filter(([other]) => other !== id);
			}
			forget(id);
			rebuild();
		};
		if (deps.canEdit(realm)) {
			actions.push(["Rename", () => {
				const box = text(make("TextBox", { ClearTextOnFocus: false, BackgroundColor3: COLORS.row }), nodes.get(id)?.name ?? "", 15);
				const panel = openOverlay(slot.label, 220, (TOUCH ? 34 : 28) + 8);
				box.Parent = panel;
				box.ZIndex = 52;
				box.Position = UDim2.fromOffset(4, 4);
				box.Size = new UDim2(1, -8, 1, -8);
				corner(box, 4);
				box.CaptureFocus();
				box.FocusLost.Connect((enter) => {
					closeOverlay();
					if (!enter || box.Text === "") return;
					const name = box.Text;
					go(() => {
						call("rename", { id, name });
						const node = nodes.get(id);
						if (node) node.name = name;
						setStatus(`Renamed to ${name}`, COLORS.good);
						render();
						drawCrumbs();
						if (selected === id) loadProps(id, true);
					});
				});
			}]);
			actions.push(["Delete", () => {
				go(() => {
					call("destroy", { id });
					setStatus("Deleted", COLORS.good);
					removeRow();
				});
			}, COLORS.bad]);
		}
		const height = actions.size() * ((TOUCH ? 34 : 26) + 2) + 8;
		const list = listIn(openOverlay(slot.label, 180, height), false);
		for (const [label, run, color] of actions) {
			let armed = false;
			const gui = item(list, label, () => {
				// Delete asks twice: the first press arms it.
				if (color === COLORS.bad && !armed) {
					armed = true;
					gui.Text = "Confirm delete";
					return;
				}
				if (label !== "Rename") closeOverlay();
				run();
			}, color);
		}
	};

	// Toolbar, keys, refresh ---------------------------------------------------------------------------------------

	const paintToggles = () => {
		for (const [name, gui] of realmButtons) {
			gui.BackgroundColor3 = name === realm ? COLORS.accent : COLORS.button;
			gui.TextColor3 = name === realm ? COLORS.dark : COLORS.text;
		}
		autoButton.BackgroundColor3 = persist.auto ? COLORS.accent : COLORS.button;
		autoButton.TextColor3 = persist.auto ? COLORS.dark : COLORS.text;
	};

	const setRealm = (target: Realm) => {
		realm = target;
		persist.realm = target;
		epoch += 1;
		nodes = new Map();
		kids = new Map();
		totals = new Map();
		expanded = new Set();
		loading.clear();
		results = undefined;
		query = "";
		searchBox.Text = "";
		closeOverlay();
		paintToggles();
		setStatus("");
		tree.CanvasPosition = Vector2.zero;
		choose(undefined);
		rebuild();
		load(0);
	};

	/**
	 * Search, two passes: (1) matching direct children of the current node, instantly from the cache, on every
	 * keystroke; (2) after a short pause, a breadth-first descendant walk done by the realm's owner (the server for
	 * "server"), fetched page by page and appended under "Descendants". Typing again cancels the walk.
	 */
	let searchToken = 0;
	const runSearch = (walk: boolean) => {
		searchToken += 1;
		const token = searchToken;
		const raw = searchBox.Text.gsub("^%s+", "")[0].gsub("%s+$", "")[0];
		query = raw.lower();
		if (raw === "") {
			if (!results) return;
			results = undefined;
			setStatus("");
			rebuild();
			if (selected !== undefined) reveal(selected);
			return;
		}
		if (!results) {
			// The current node; a leaf searches its parent instead.
			const row = selected !== undefined ? nodes.get(selected) : undefined;
			searchRoot = row ? (row.childCount > 0 ? row.id : row.parent) : 0;
		}
		const root = searchRoot;
		const direct = () =>
			(kids.get(root) ?? []).filter((id) => {
				const row = nodes.get(id);
				return row !== undefined && hit(row);
			});
		const current: Results = { direct: direct(), hits: [], done: false };
		results = current;
		tree.CanvasPosition = Vector2.zero;
		rebuild();
		const where = root === 0 ? "game" : nodes.get(root)?.name ?? "selection";
		setStatus(`${current.direct.size()} in ${where}${walk ? ", searching..." : ""}`);
		if (!walk) return;
		go(() => {
			if (!kids.has(root)) {
				fetch([{ id: root }]);
				if (token !== searchToken) return;
				current.direct = direct();
			}
			const shown = new Set(current.direct);
			let page: FindPage | undefined;
			while (!page || !page.done) {
				page = call("find", { id: root, query: raw, token, next: page !== undefined }) as FindPage;
				if (token !== searchToken) return;
				for (const found of page.hits) {
					nodes.set(found.row.id, found.row);
					if (shown.has(found.row.id)) continue;
					shown.add(found.row.id);
					current.hits.push([found.row.id, found.path.join(" › ")]);
				}
				current.done = page.done;
				rebuild();
				const count = current.direct.size() + current.hits.size();
				const more = page.capped ? "+" : "";
				setStatus(`${count}${more} in ${where}${page.done ? "" : ", searching..."}`, count > 0 ? COLORS.text : COLORS.dim);
			}
		});
	};
	trove.connect(searchBox.GetPropertyChangedSignal("Text"), () => {
		runSearch(false);
		const token = searchToken;
		task.delay(0.35, () => alive && token === searchToken && runSearch(true));
	});
	trove.connect(searchBox.FocusLost, (enter) => enter && runSearch(true));

	let refreshing = false;
	const refresh = (withProps: boolean) => {
		if (refreshing) return;
		if (results) return runSearch(true);
		refreshing = true;
		go(() => {
			const requests = [{ id: 0, limit: math.max(PAGE, kids.get(0)?.size() ?? 0) }];
			const walk = (id: number) => {
				for (const child of kids.get(id) ?? []) {
					if (!expanded.has(child)) continue;
					requests.push({ id: child, limit: math.max(PAGE, kids.get(child)?.size() ?? 0) });
					walk(child);
				}
			};
			walk(0);
			const [ok, err] = pcall(() => fetch(requests));
			refreshing = false;
			if (!ok) error(err, 0);
			rebuild();
			const focused = UserInputService.GetFocusedTextBox();
			if (withProps && selected !== undefined && !(focused && focused.IsDescendantOf(props))) loadProps(selected, true);
		});
	};

	realmButtons.get("client")!.Activated.Connect(() => setRealm("client"));
	realmButtons.get("server")!.Activated.Connect(() => setRealm("server"));
	refreshButton.Activated.Connect(() => refresh(true));
	autoButton.Activated.Connect(() => {
		persist.auto = !persist.auto;
		paintToggles();
	});
	upButton.Activated.Connect(() => {
		const row = selected !== undefined ? nodes.get(selected) : undefined;
		if (row && row.parent !== 0) choose(row.parent, true);
		else {
			choose(undefined);
			tree.CanvasPosition = Vector2.zero;
		}
	});

	// Arrow keys move the selection while the pointer is over the explorer.
	let hovering = false;
	trove.connect(root.MouseEnter, () => (hovering = true));
	trove.connect(root.MouseLeave, () => (hovering = false));
	trove.connect(UserInputService.InputBegan, (input, processed) => {
		if (processed || !hovering || selected === undefined || overlay) return;
		const index = visible.findIndex((entry) => !entry.more && entry.id === selected);
		const row = nodes.get(selected);
		const step = (direction: number) => {
			for (let at = index + direction; at >= 0 && at < visible.size(); at += direction) {
				const entry = visible[at];
				if (!entry.more && !entry.divider) return choose(entry.id, true);
			}
		};
		if (input.KeyCode === Enum.KeyCode.Up) step(-1);
		else if (input.KeyCode === Enum.KeyCode.Down) step(1);
		else if (results) return;
		else if (input.KeyCode === Enum.KeyCode.Right && row && row.childCount > 0) {
			if (isOpen(selected)) step(1);
			else toggle(selected);
		} else if (input.KeyCode === Enum.KeyCode.Left && row) {
			if (isOpen(selected) && row.childCount > 0) toggle(selected);
			else if (row.parent !== 0) choose(row.parent, true);
		}
	});

	// Optional auto-refresh: only the expanded nodes (and the selection's properties), every 3 s.
	trove.add(
		task.spawn(() => {
			while (alive) {
				task.wait(AUTO_REFRESH);
				if (persist.auto && !results) refresh(overlay === undefined);
			}
		}),
	);

	resizePool();
	setRealm(realm);
	return () => trove.destroy();
}
