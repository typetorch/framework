import { GuiService, UserInputService, Workspace } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { bump, popIn, popOut } from "../ui";
import {
	canSplit,
	closeLeaf,
	closeWindow,
	countLeaves,
	dockWindow,
	FloatWindow,
	Layout,
	LayoutNode,
	LeafNode,
	leavesOf,
	limitsFor,
	openPage,
	popOut as popOutLeaf,
	raise,
	repairFocus,
	splitLeaf,
	SplitDir,
	SplitNode,
	treeOf,
	windowOf,
	WindowRect,
	clampRatio,
	findLeaf,
} from "./layout";
import { chevron, COLORS, corner, make, style } from "./widgets";

/**
 * The dev menu's window manager (plans/10 "Panes and windows"): renders the layout tree (layout.ts) of the main panel
 * and of every floating window, and owns their chrome.
 *
 * - **Panes:** each leaf is a pane with a compact header: a page picker (one dropdown at a time) and Split right, Split
 *   down, Open in new window and Close. Pages are built by the host (client.ts) into the pane's body with their own
 *   trove, which is cleaned when the pane closes, changes page or hides.
 * - **Dividers** between panes drag (minimum pane sizes), and their ratios are kept in the layout.
 * - **Floating windows:** title bar drag, resize grip, minimise (to the title bar), dock back into the main panel, close;
 *   a tap anywhere brings a window (or the main panel) to the front and focuses the pane under it. Windows stay inside
 *   the screen when it resizes.
 * - **Hidden = unmounted:** a minimised window's panes and every pane while the menu is closed are unmounted, so their
 *   refresh loops stop (no requests from panes nobody sees).
 * - **Phones and small screens** (compact): panes only stack, at most 2 in the main panel and 1 per window, and windows
 *   open maximised; touch-sized hit areas.
 *
 * Icons are drawn from Frames in square boxes (UIAspectRatioConstraint 1), like the rest of the dev menu: no glyphs.
 */

const TOUCH = UserInputService.TouchEnabled && !UserInputService.MouseEnabled;
/** Pane header height and its icon buttons (touch-sized on phones). */
const PANE_HEADER = TOUCH ? 38 : 30;
const ICON_BUTTON = TOUCH ? 34 : 26;
/** Gap between a pane's header and its body. */
const HEADER_GAP = 2;
/** Divider thickness (its hit area): a 2 px line in the middle. */
const DIVIDER = TOUCH ? 14 : 8;
/** Floating window title bar. */
const TITLE = TOUCH ? 40 : 32;
const MIN_PANE = new Vector2(200, 130);
const MIN_WINDOW = new Vector2(280, 200);
const DEFAULT_WINDOW = new Vector2(520, 440);
const SCREEN_MARGIN = 8;
const GRIP = 24;
const DOUBLE_TAP = 0.35;
/** Below this viewport size the menu is "compact" (phones): stacked panes, maximised windows. */
const COMPACT = new Vector2(720, 480);
/** Page picker dropdown. */
const MENU_WIDTH = 210;
const MENU_ROW = TOUCH ? 36 : 30;
const MENU_MAX_HEIGHT = 420;
/** Above every window (their ZIndex is their place in the stacking order), under the copy popup (1000). */
const MENU_Z = 900;
/** How long a window's title shows a short note ("Close a pane first"). */
const NOTE_SECONDS = 3;

type IconKind = "right" | "down" | "window" | "dock" | "close" | "min" | "restore";

export interface PaneTab {
	/** Cleaned when the pane closes, shows another page or hides. */
	readonly trove: Trove;
	/** The pane's column under its header: [toolbar] [content] [footer] (a vertical UIListLayout). */
	readonly body: Frame;
	/** The pane's scrolling content (script-free: AutomaticCanvasSize + layouts). */
	readonly content: ScrollingFrame;
	readonly leaf: LeafNode;
}

/** One entry of the page picker. */
export interface PickItem {
	key: string;
	title: string;
	/** Group heading shown above it ("Modules"); undefined for top-level pages. */
	group?: string;
}

/** What the window manager needs from the dev menu (client.ts). */
export interface PaneHost {
	/** Builds the pane's page into its body. */
	readonly mount: (tab: PaneTab) => void;
	/** Short title of a page key ("State"). */
	readonly title: (page: string) => string;
	/** Singleton pages open in one pane at most (the existing one is focused instead). */
	readonly single: (page: string) => boolean;
	/** The picker's pages, in sidebar order (owner-only pages only for owners). */
	readonly picks: () => PickItem[];
	/** The page a fresh pane shows. */
	readonly fallback: () => string;
	/** The focused pane changed (or its page did): repaint the sidebar. */
	readonly focused: (page: string | undefined) => void;
}

export interface WindowManagerOptions {
	readonly gui: ScreenGui;
	/** The main panel (for the stacking order and tap-to-focus). */
	readonly mainWindow: Frame;
	/** Where the main panel's tree goes (no UIPadding: it must be the exact area). */
	readonly mainHost: Frame;
	/** The client generation's trove. */
	readonly trove: Trove;
	/** The layout, kept in the client persist store and changed in place. */
	readonly layout: () => Layout;
	readonly host: PaneHost;
}

export interface WindowManager {
	/** The menu opened: mount the visible panes, pop the windows in. */
	readonly show: () => void;
	/** The menu is closing: pop the windows out (unmount() follows when the main panel is gone). */
	readonly fadeOut: () => void;
	/** The menu closed: unmount every pane (their loops stop) and remove the windows. */
	readonly unmount: () => void;
	/** The sidebar: open `page` in the focused pane (a singleton focuses its pane instead). */
	readonly open: (page: string) => void;
	/** The focused pane's page. */
	readonly focusedPage: () => string | undefined;
	/** Re-points panes: `map` returns a new page key, or undefined to keep it (non-owners lose Manage pages). */
	readonly replacePages: (map: (page: string) => string | undefined) => void;
}

interface PaneView {
	leaf: LeafNode;
	owner: number;
	frame: Frame;
	stroke: UIStroke;
	title: TextLabel;
	buttons: Map<"right" | "down" | "window" | "close", TextButton>;
	body: Frame;
	content: ScrollingFrame;
	/** The pane's own trove (header); the page's trove is a child of it. */
	trove: Trove;
	pageTrove?: Trove;
	/** The page currently built into the pane. */
	page?: string;
}

interface WinView {
	id: number;
	frame: Frame;
	title: TextLabel;
	body: Frame;
	grip: TextButton;
	minButton: TextButton;
	trove: Trove;
	note?: string;
	noteToken: number;
}

interface Drag {
	input: InputObject;
	start: Vector3;
	move: (delta: Vector3) => void;
}

function isPointer(input: InputObject): boolean {
	return input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
}

function inside(gui: GuiObject, point: Vector2): boolean {
	const origin = gui.AbsolutePosition;
	const size = gui.AbsoluteSize;
	return point.X >= origin.X && point.X <= origin.X + size.X && point.Y >= origin.Y && point.Y <= origin.Y + size.Y;
}

/** A bar of an icon (repainted by paintIcon). */
function bar(parent: Instance, x: number, y: number, w: number, h: number, rotation = 0): Frame {
	return make(
		"Frame",
		{ Name: "Bar", BorderSizePixel: 0, Position: UDim2.fromOffset(x, y), Size: UDim2.fromOffset(w, h), Rotation: rotation },
		parent,
	);
}

/** An outlined box of an icon. */
function box(parent: Instance, x: number, y: number, w: number, h: number): Frame {
	const frame = make("Frame", { Name: "Box", BackgroundTransparency: 1, Position: UDim2.fromOffset(x, y), Size: UDim2.fromOffset(w, h) }, parent);
	make("UIStroke", { Thickness: 1.5, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, frame);
	corner(frame, 2);
	return frame;
}

/** Draws a 14 x 14 icon from Frames (no glyphs) into a square holder. */
function drawIcon(holder: Frame, kind: IconKind) {
	holder.ClearAllChildren();
	make("UIAspectRatioConstraint", { AspectRatio: 1 }, holder);
	if (kind === "right") {
		box(holder, 0, 0, 14, 14);
		bar(holder, 6, 0, 2, 14);
	} else if (kind === "down") {
		box(holder, 0, 0, 14, 14);
		bar(holder, 0, 6, 14, 2);
	} else if (kind === "window") {
		// A box with an arrow leaving it to the top right.
		box(holder, 0, 4, 10, 10);
		bar(holder, 5, 5, 10, 2, -45);
		bar(holder, 9, 0, 5, 2);
		bar(holder, 12, 0, 2, 5);
	} else if (kind === "dock") {
		// A box with an arrow coming in from the top right: back into the main panel.
		box(holder, 0, 4, 10, 10);
		bar(holder, 5, 5, 10, 2, -45);
		bar(holder, 3, 9, 5, 2);
		bar(holder, 3, 6, 2, 5);
	} else if (kind === "close") {
		const a = bar(holder, 0, 6, 14, 2, 45);
		const b = bar(holder, 0, 6, 14, 2, -45);
		corner(a, 1);
		corner(b, 1);
	} else if (kind === "min") {
		bar(holder, 1, 11, 12, 2);
	} else {
		box(holder, 1, 1, 12, 12);
		bar(holder, 1, 1, 12, 3);
	}
}

function paintIcon(holder: Instance, color: Color3, transparency: number) {
	for (const part of holder.GetDescendants()) {
		if (part.IsA("Frame") && part.Name === "Bar") {
			part.BackgroundColor3 = color;
			part.BackgroundTransparency = transparency;
		} else if (part.IsA("UIStroke")) {
			part.Color = color;
			part.Transparency = transparency;
		}
	}
}

function pad8(label: TextLabel) {
	make("UIPadding", { PaddingLeft: new UDim(0, 8) }, label);
}

/** A square icon button (touch-sized on phones) with a hover tint. */
function iconButton(parent: Instance, kind: IconKind, order: number, trove: Trove): TextButton {
	const button = make(
		"TextButton",
		{
			Name: kind,
			Text: "",
			AutoButtonColor: false,
			BackgroundColor3: COLORS.button,
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			Size: UDim2.fromOffset(ICON_BUTTON, ICON_BUTTON),
			LayoutOrder: order,
		},
		parent,
	);
	make("UIAspectRatioConstraint", { AspectRatio: 1 }, button);
	corner(button, 6);
	const holder = make(
		"Frame",
		{ Name: "Icon", BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(14, 14) },
		button,
	);
	drawIcon(holder, kind);
	paintIcon(holder, COLORS.dim, 0);
	// A dimmed (disabled) icon stays dim while hovered.
	const fade = () => (button.GetAttribute("Disabled") === true ? 0.65 : 0);
	trove.connect(button.MouseEnter, () => {
		button.BackgroundTransparency = 0;
		paintIcon(holder, COLORS.text, fade());
	});
	trove.connect(button.MouseLeave, () => {
		button.BackgroundTransparency = 1;
		paintIcon(holder, COLORS.dim, fade());
	});
	return button;
}

export function createWindowManager(options: WindowManagerOptions): WindowManager {
	const { gui, mainWindow, mainHost, host } = options;
	const trove = options.trove.extend();
	const layout = options.layout;

	let shown = false;
	const panes = new Map<number, PaneView>();
	const wins = new Map<number, WinView>();
	/** Split frames and dividers, rebuilt on every relayout. */
	let containers = trove.extend();
	let menu: { trove: Trove; frame: GuiObject; anchor: GuiObject; pane: number } | undefined;
	let drag: Drag | undefined;
	let relayout: () => void = () => {};

	const viewport = (): Vector2 => {
		if (gui.AbsoluteSize.X > 0 && gui.AbsoluteSize.Y > 0) return gui.AbsoluteSize;
		return Workspace.CurrentCamera?.ViewportSize ?? new Vector2(1280, 720);
	};
	const isCompact = () => {
		const view = viewport();
		return view.X < COMPACT.X || view.Y < COMPACT.Y;
	};
	const limits = () => limitsFor(isCompact());
	/**
	 * Where a press is in AbsolutePosition space. This ScreenGui ignores the GUI inset, and an InputObject's position
	 * usually leaves the inset out (UserInputService:GetMouseLocation() includes it), but not on every client: the offset
	 * is learned from presses on the window manager's own buttons (calibrate), and the inset is assumed until then.
	 */
	let pointerOffset: Vector2 | undefined;
	const guiInset = (): Vector2 => {
		const [ok, inset] = pcall(() => GuiService.GetGuiInset()[0]);
		return ok && inset !== undefined ? inset : Vector2.zero;
	};
	const calibrate = (input: InputObject, hit: GuiObject) => {
		if (!isPointer(input)) return;
		const raw = new Vector2(input.Position.X, input.Position.Y);
		const inset = guiInset();
		if (inset.Magnitude < 0.5) return;
		const rawInside = inside(hit, raw);
		if (rawInside !== inside(hit, raw.add(inset))) pointerOffset = rawInside ? Vector2.zero : inset;
	};
	const pointOf = (input: InputObject): Vector2 => new Vector2(input.Position.X, input.Position.Y).add(pointerOffset ?? guiInset());
	/** Top of a maximised window: under Roblox's top bar (the dev menu's ScreenGui ignores the inset). */
	const topInset = () => guiInset().Y;

	// Page picker (one dropdown at a time) ------------------------------------------------------------------------

	const closeMenu = () => {
		const current = menu;
		if (!current) return;
		menu = undefined;
		popOut(current.frame, () => trove.remove(current.trove));
		// Also gone if the pop-out can't finish (the gui went away).
		task.delay(0.4, () => trove.remove(current.trove));
	};

	let openIn: (leafId: number, page: string) => void = () => {};

	const openPicker = (view: PaneView, anchor: GuiObject) => {
		if (menu && menu.pane === view.leaf.id) return closeMenu();
		closeMenu();
		const menuTrove = trove.extend();
		const view_ = viewport();
		const maxHeight = math.min(MENU_MAX_HEIGHT, view_.Y - SCREEN_MARGIN * 2);
		const frame = menuTrove.add(
			make("ScrollingFrame", {
				Name: "PanePicker",
				Active: true,
				BackgroundColor3: COLORS.header,
				BorderSizePixel: 0,
				Size: UDim2.fromOffset(MENU_WIDTH, 0),
				AutomaticSize: Enum.AutomaticSize.Y,
				CanvasSize: new UDim2(),
				AutomaticCanvasSize: Enum.AutomaticSize.Y,
				ScrollingDirection: Enum.ScrollingDirection.Y,
				ScrollBarThickness: 4,
				ScrollBarImageColor3: COLORS.dim,
				VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
				ZIndex: MENU_Z,
				Visible: false,
			}),
		);
		make("UISizeConstraint", { MaxSize: new Vector2(MENU_WIDTH, maxHeight) }, frame);
		corner(frame, 10);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, frame);
		// No UIPadding on the ScrollingFrame itself: pad an inner Frame (decision log, 2026-10-04).
		const list = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y }, frame);
		make("UIPadding", { PaddingTop: new UDim(0, 6), PaddingBottom: new UDim(0, 6), PaddingLeft: new UDim(0, 6), PaddingRight: new UDim(0, 6) }, list);
		make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 2) }, list);
		let order = 0;
		let group: string | undefined;
		let rows = 0;
		let headings = 0;
		for (const item of host.picks()) {
			if (item.group !== group) {
				group = item.group;
				if (group !== undefined) {
					order += 1;
					headings += 1;
					const heading = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: order }, list), group, 13, COLORS.dim, Enum.Font.BuilderSansBold);
					heading.Size = new UDim2(1, 0, 0, 20);
					heading.TextYAlignment = Enum.TextYAlignment.Bottom;
					pad8(heading);
				}
			}
			order += 1;
			rows += 1;
			const current = item.key === view.leaf.page;
			const row = style(
				make("TextButton", { AutoButtonColor: false, LayoutOrder: order, BackgroundColor3: COLORS.button, BackgroundTransparency: current ? 0 : 1 }, list),
				item.title,
				15,
				current ? COLORS.accent : COLORS.text,
				current ? Enum.Font.BuilderSansBold : Enum.Font.BuilderSansMedium,
			);
			row.TextWrapped = false;
			row.TextTruncate = Enum.TextTruncate.AtEnd;
			row.Size = new UDim2(1, 0, 0, MENU_ROW);
			corner(row, 6);
			make("UIPadding", { PaddingLeft: new UDim(0, item.group !== undefined ? 18 : 10), PaddingRight: new UDim(0, 8) }, row);
			menuTrove.connect(row.MouseEnter, () => (row.BackgroundTransparency = 0));
			menuTrove.connect(row.MouseLeave, () => (row.BackgroundTransparency = current ? 0 : 1));
			const key = item.key;
			menuTrove.connect(row.Activated, () => {
				const leafId = view.leaf.id;
				closeMenu();
				openIn(leafId, key);
			});
		}
		// Under the picker, or above it when there is no room; inside the screen.
		const height = math.min(maxHeight, rows * (MENU_ROW + 2) + headings * 22 + 14);
		const at = anchor.AbsolutePosition.sub(gui.AbsolutePosition);
		const x = math.clamp(at.X, SCREEN_MARGIN, math.max(SCREEN_MARGIN, view_.X - MENU_WIDTH - SCREEN_MARGIN));
		let y = at.Y + anchor.AbsoluteSize.Y + 4;
		if (y + height > view_.Y - SCREEN_MARGIN) y = math.max(SCREEN_MARGIN, at.Y - height - 4);
		frame.Position = UDim2.fromOffset(x, y);
		frame.Parent = gui;
		menu = { trove: menuTrove, frame, anchor, pane: view.leaf.id };
		popIn(frame);
	};

	// Panes ---------------------------------------------------------------------------------------------------------

	let split: (view: PaneView, dir: SplitDir) => void = () => {};
	let paintButtons: (view: PaneView) => void = () => {};
	let toWindow: (view: PaneView) => void = () => {};
	let closePane: (view: PaneView) => void = () => {};

	const createPane = (leaf: LeafNode): PaneView => {
		const paneTrove = trove.extend();
		const frame = paneTrove.add(
			make("Frame", { Name: "Pane", BackgroundTransparency: 1, BorderSizePixel: 0, Size: UDim2.fromScale(1, 1), ClipsDescendants: true }),
		);
		corner(frame, 8);
		const stroke = make("UIStroke", { Color: COLORS.accent, Thickness: 1.5, Transparency: 0.25, ApplyStrokeMode: Enum.ApplyStrokeMode.Border, Enabled: false }, frame);
		const header = make("Frame", { Name: "PaneHeader", BackgroundColor3: COLORS.header, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, PANE_HEADER) }, frame);
		corner(header, 6);
		make(
			"UIListLayout",
			{
				FillDirection: Enum.FillDirection.Horizontal,
				SortOrder: Enum.SortOrder.LayoutOrder,
				VerticalAlignment: Enum.VerticalAlignment.Center,
				Padding: new UDim(0, 2),
			},
			header,
		);
		make("UIPadding", { PaddingLeft: new UDim(0, 4), PaddingRight: new UDim(0, 4) }, header);
		// The picker: the page's title and a down chevron; it takes the rest of the header.
		const picker = make(
			"TextButton",
			{ Name: "Picker", Text: "", AutoButtonColor: false, BackgroundColor3: COLORS.button, BackgroundTransparency: 1, Size: UDim2.fromOffset(40, ICON_BUTTON), LayoutOrder: 0 },
			header,
		);
		make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, picker);
		corner(picker, 6);
		const title = style(make("TextLabel", { BackgroundTransparency: 1 }, picker), "", 15, COLORS.text, Enum.Font.BuilderSansBold);
		title.TextWrapped = false;
		title.TextTruncate = Enum.TextTruncate.AtEnd;
		title.Position = UDim2.fromOffset(8, 0);
		title.Size = new UDim2(1, -30, 1, 0);
		const caret = make(
			"Frame",
			{ BackgroundTransparency: 1, AnchorPoint: new Vector2(1, 0.5), Position: new UDim2(1, -8, 0.5, 0), Size: UDim2.fromOffset(12, 12) },
			picker,
		);
		make("UIAspectRatioConstraint", { AspectRatio: 1 }, caret);
		chevron(caret, "down", COLORS.dim, 2);
		paneTrove.connect(picker.MouseEnter, () => (picker.BackgroundTransparency = 0));
		paneTrove.connect(picker.MouseLeave, () => (picker.BackgroundTransparency = 1));

		const buttons = new Map<"right" | "down" | "window" | "close", TextButton>();
		buttons.set("right", iconButton(header, "right", 1, paneTrove));
		buttons.set("down", iconButton(header, "down", 2, paneTrove));
		buttons.set("window", iconButton(header, "window", 3, paneTrove));
		buttons.set("close", iconButton(header, "close", 4, paneTrove));

		const body = make(
			"Frame",
			{
				Name: "Body",
				BackgroundTransparency: 1,
				Position: UDim2.fromOffset(0, PANE_HEADER + HEADER_GAP),
				Size: new UDim2(1, 0, 1, -(PANE_HEADER + HEADER_GAP)),
			},
			frame,
		);
		make("UIListLayout", { FillDirection: Enum.FillDirection.Vertical, SortOrder: Enum.SortOrder.LayoutOrder }, body);
		// No UIPadding on the ScrollingFrame itself: the page pads its own Frame inside it.
		const content = make(
			"ScrollingFrame",
			{
				Name: "Content",
				BackgroundTransparency: 1,
				BorderSizePixel: 0,
				CanvasSize: new UDim2(),
				AutomaticCanvasSize: Enum.AutomaticSize.Y,
				ScrollingDirection: Enum.ScrollingDirection.Y,
				ScrollBarThickness: 6,
				ScrollBarImageColor3: COLORS.dim,
				VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
				Size: UDim2.fromScale(1, 1),
				LayoutOrder: 3,
			},
			body,
		);
		make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, content);

		const view: PaneView = { leaf, owner: 0, frame, stroke, title, buttons, body, content, trove: paneTrove };
		paneTrove.connect(picker.InputBegan, (input) => calibrate(input, picker));
		for (const [, button] of buttons) paneTrove.connect(button.InputBegan, (input) => calibrate(input, button));
		paneTrove.connect(picker.Activated, () => openPicker(view, picker));
		paneTrove.connect(buttons.get("right")!.Activated, () => split(view, "row"));
		paneTrove.connect(buttons.get("down")!.Activated, () => split(view, "column"));
		paneTrove.connect(buttons.get("window")!.Activated, () => toWindow(view));
		paneTrove.connect(buttons.get("close")!.Activated, () => closePane(view));
		// Split buttons dim while the pane is too small to split.
		paneTrove.connect(frame.GetPropertyChangedSignal("AbsoluteSize"), () => paintButtons(view));
		return view;
	};

	/** Builds the leaf's page into the pane (a fresh trove; the old page is cleaned first). */
	const mountPage = (view: PaneView) => {
		if (view.pageTrove) view.trove.remove(view.pageTrove);
		view.content.CanvasPosition = Vector2.zero;
		const pageTrove = view.trove.extend();
		view.pageTrove = pageTrove;
		view.page = view.leaf.page;
		const [ok, err] = pcall(() => host.mount({ trove: pageTrove, body: view.body, content: view.content, leaf: view.leaf }));
		if (!ok) $warn(`[devtools] pane ${view.leaf.page} failed: ${err}`);
	};

	const destroyPane = (view: PaneView) => {
		if (menu && menu.pane === view.leaf.id) closeMenu();
		trove.remove(view.trove);
	};

	/** Whether a split button can act now (limits, and room for two panes). */
	const splitFits = (view: PaneView, dir: SplitDir): boolean => {
		const size = view.frame.AbsoluteSize;
		if (size.X === 0) return true;
		return dir === "row" ? size.X >= MIN_PANE.X * 2 + DIVIDER : size.Y >= MIN_PANE.Y * 2 + DIVIDER;
	};

	paintButtons = (view: PaneView) => {
		const current = layout();
		const limit = limits();
		const tree = treeOf(current, view.owner);
		const count = tree ? countLeaves(tree) : 1;
		const right = view.buttons.get("right")!;
		const down = view.buttons.get("down")!;
		right.Visible = canSplit(current, view.owner, "row", limit);
		down.Visible = canSplit(current, view.owner, "column", limit);
		for (const [button, dir] of [
			[right, "row"],
			[down, "column"],
		] as const) {
			const fits = splitFits(view, dir);
			button.SetAttribute("Disabled", !fits);
			const holder = button.FindFirstChild("Icon");
			if (holder) paintIcon(holder, COLORS.dim, fits ? 0 : 0.65);
		}
		// A window's only pane already has a window of its own.
		view.buttons.get("window")!.Visible = !(view.owner !== 0 && count === 1) && current.windows.size() < limit.windows;
		// The main panel keeps at least one pane.
		view.buttons.get("close")!.Visible = !(view.owner === 0 && count === 1);
	};

	const paintFocus = () => {
		const focus = layout().focus;
		const several = panes.size() > 1;
		for (const [, view] of panes) {
			const focused = view.leaf.id === focus;
			view.stroke.Enabled = focused && several;
			view.title.TextColor3 = focused && several ? COLORS.accent : COLORS.text;
		}
	};

	const focusedPage = (): string | undefined => findLeaf(layout(), layout().focus)?.[0].page;

	const setFocus = (id: number) => {
		const current = layout();
		if (current.focus === id) return;
		current.focus = id;
		paintFocus();
		host.focused(focusedPage());
	};

	// Windows -------------------------------------------------------------------------------------------------------

	const windowFrame = (id: number): GuiObject | undefined => (id === 0 ? mainWindow : wins.get(id)?.frame);

	const paintOrder = () => {
		layout().order.forEach((id, index) => {
			const frame = windowFrame(id);
			if (frame) frame.ZIndex = index + 1;
		});
	};

	/** A cascading default rectangle for a new window. */
	const defaultRect = (index: number): WindowRect => {
		const view = viewport();
		const w = math.min(DEFAULT_WINDOW.X, view.X - SCREEN_MARGIN * 2);
		const h = math.min(DEFAULT_WINDOW.Y, view.Y - SCREEN_MARGIN * 2);
		const step = (index % 5) * 28 - 56;
		return { x: (view.X - w) / 2 + step, y: (view.Y - h) / 2 + step, w, h };
	};

	/** Places a window: maximised (always on phones) or its rectangle clamped to the screen (and saved). */
	const placeWindow = (win: FloatWindow, view: WinView) => {
		const screen = viewport();
		const compact = isCompact();
		let rect: WindowRect;
		if (compact || win.max === true) {
			const top = math.max(SCREEN_MARGIN, topInset() + 4);
			rect = { x: SCREEN_MARGIN, y: top, w: screen.X - SCREEN_MARGIN * 2, h: screen.Y - top - SCREEN_MARGIN };
		} else {
			const wanted = win.rect ?? defaultRect(layout().windows.indexOf(win));
			const maxW = math.max(200, screen.X - SCREEN_MARGIN * 2);
			const maxH = math.max(160, screen.Y - SCREEN_MARGIN * 2);
			const w = math.clamp(wanted.w, math.min(MIN_WINDOW.X, maxW), maxW);
			const h = math.clamp(wanted.h, math.min(MIN_WINDOW.Y, maxH), maxH);
			const x = math.clamp(wanted.x, 0, math.max(0, screen.X - w));
			const y = math.clamp(wanted.y, 0, math.max(0, screen.Y - TITLE));
			rect = { x, y, w, h };
			win.rect = rect;
		}
		view.frame.Position = UDim2.fromOffset(rect.x + rect.w / 2, rect.y);
		view.frame.Size = UDim2.fromOffset(rect.w, win.min === true ? TITLE : rect.h);
		view.body.Visible = win.min !== true;
		view.grip.Visible = win.min !== true && !compact && win.max !== true;
	};

	const paintWindow = (win: FloatWindow, view: WinView) => {
		const titles = leavesOf(win.root).map((leaf) => host.title(leaf.page));
		view.title.Text = view.note ?? titles.join("  ·  ");
		view.title.TextColor3 = view.note !== undefined ? COLORS.warn : COLORS.text;
		const holder = view.minButton.FindFirstChild("Icon") as Frame | undefined;
		if (holder) {
			drawIcon(holder, win.min === true ? "restore" : "min");
			paintIcon(holder, COLORS.dim, 0);
		}
	};

	/** A short warning in a window's title for a few seconds. */
	const noteWindow = (id: number, text: string) => {
		const view = wins.get(id);
		const win = windowOf(layout(), id);
		if (!view || !win) return;
		view.noteToken += 1;
		const token = view.noteToken;
		view.note = text;
		paintWindow(win, view);
		bump(view.title);
		view.trove.add(
			task.delay(NOTE_SECONDS, () => {
				if (view.noteToken !== token) return;
				view.note = undefined;
				const still = windowOf(layout(), id);
				if (still) paintWindow(still, view);
			}),
		);
	};

	let lastTitleTap = 0;
	let lastTitleWindow = -1;

	const createWindow = (win: FloatWindow): WinView => {
		const winTrove = trove.extend();
		const frame = winTrove.add(
			make("Frame", {
				Name: "TypeTorchWindow",
				Active: true,
				Visible: false,
				AnchorPoint: new Vector2(0.5, 0),
				BackgroundColor3: COLORS.window,
				BorderSizePixel: 0,
				ClipsDescendants: true,
			}),
		);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, frame);
		corner(frame, 10);
		const bar_ = make("Frame", { Name: "TitleBar", Active: true, BackgroundColor3: COLORS.header, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, TITLE) }, frame);
		const title = style(make("TextLabel", { BackgroundTransparency: 1 }, bar_), "", 15, COLORS.text, Enum.Font.BuilderSansBold);
		title.TextWrapped = false;
		title.TextTruncate = Enum.TextTruncate.AtEnd;
		title.Position = UDim2.fromOffset(12, 0);
		title.Size = new UDim2(1, -(12 + 3 * (ICON_BUTTON + 2) + 10), 1, 0);
		const controls = make(
			"Frame",
			{ BackgroundTransparency: 1, AnchorPoint: new Vector2(1, 0.5), Position: new UDim2(1, -6, 0.5, 0), Size: UDim2.fromOffset(3 * (ICON_BUTTON + 2), ICON_BUTTON) },
			bar_,
		);
		make(
			"UIListLayout",
			{
				FillDirection: Enum.FillDirection.Horizontal,
				HorizontalAlignment: Enum.HorizontalAlignment.Right,
				VerticalAlignment: Enum.VerticalAlignment.Center,
				SortOrder: Enum.SortOrder.LayoutOrder,
				Padding: new UDim(0, 2),
			},
			controls,
		);
		const minButton = iconButton(controls, "min", 1, winTrove);
		const dockButton = iconButton(controls, "dock", 2, winTrove);
		const closeButton = iconButton(controls, "close", 3, winTrove);
		for (const button of [minButton, dockButton, closeButton]) winTrove.connect(button.InputBegan, (input) => calibrate(input, button));
		// The tree's area: exact offsets (no UIPadding), so divider drags measure it right.
		const body = make(
			"Frame",
			{ Name: "Body", BackgroundTransparency: 1, Position: UDim2.fromOffset(6, TITLE + 4), Size: new UDim2(1, -12, 1, -(TITLE + 10)) },
			frame,
		);
		const grip = make(
			"TextButton",
			{
				Name: "Grip",
				Text: "",
				AutoButtonColor: false,
				BackgroundTransparency: 1,
				AnchorPoint: new Vector2(1, 1),
				Position: UDim2.fromScale(1, 1),
				Size: UDim2.fromOffset(GRIP, GRIP),
				ZIndex: 5,
			},
			frame,
		);
		for (const [length, offset] of [
			[0.75, 0.55],
			[0.4, 0.75],
		]) {
			make(
				"Frame",
				{
					BackgroundColor3: COLORS.dim,
					BorderSizePixel: 0,
					AnchorPoint: new Vector2(0.5, 0.5),
					Position: UDim2.fromScale(offset, offset),
					Size: new UDim2(length, 0, 0, 2),
					Rotation: -45,
					ZIndex: 5,
				},
				grip,
			);
		}
		const view: WinView = { id: win.id, frame, title, body, grip, minButton, trove: winTrove, noteToken: 0 };
		const id = win.id;
		winTrove.connect(minButton.Activated, () => {
			const current = windowOf(layout(), id);
			if (!current) return;
			current.min = current.min === true ? undefined : true;
			if (current.min === undefined) raise(layout(), id);
			repairFocus(layout());
			relayout();
		});
		winTrove.connect(dockButton.Activated, () => {
			const current = layout();
			const found = findLeaf(current, current.focus);
			const target = found && found[1] === 0 ? found[0].id : leavesOf(current.main)[0].id;
			const outcome = dockWindow(current, id, target, "row", limits());
			if (outcome === "full") return noteWindow(id, "Close a pane first");
			relayout();
		});
		winTrove.connect(closeButton.Activated, () => {
			closeWindow(layout(), id);
			relayout();
		});
		// Drag by the title bar (double-tap: maximise / restore on desktop), resize by the grip.
		winTrove.connect(bar_.InputBegan, (input) => {
			if (!isPointer(input) || input.UserInputState !== Enum.UserInputState.Begin) return;
			// Presses on the window's own buttons are no drags or double-taps.
			const raw = new Vector2(input.Position.X, input.Position.Y);
			if (inside(controls, raw) || inside(controls, raw.add(guiInset()))) return;
			const current = windowOf(layout(), id);
			if (!current || isCompact()) return;
			const now = os.clock();
			if (lastTitleWindow === id && now - lastTitleTap < DOUBLE_TAP) {
				lastTitleTap = 0;
				drag = undefined;
				current.max = current.max === true ? undefined : true;
				placeWindow(current, view);
				return;
			}
			lastTitleTap = now;
			lastTitleWindow = id;
			if (current.max === true) return;
			const from = { ...(current.rect ?? defaultRect(0)) };
			drag = {
				input,
				start: input.Position,
				move: (delta) => {
					current.rect = { x: from.x + delta.X, y: from.y + delta.Y, w: from.w, h: from.h };
					placeWindow(current, view);
				},
			};
		});
		winTrove.connect(grip.InputBegan, (input) => {
			if (!isPointer(input) || input.UserInputState !== Enum.UserInputState.Begin) return;
			const current = windowOf(layout(), id);
			if (!current || current.max === true || isCompact()) return;
			const from = { ...(current.rect ?? defaultRect(0)) };
			drag = {
				input,
				start: input.Position,
				move: (delta) => {
					current.rect = { x: from.x, y: from.y, w: from.w + delta.X, h: from.h + delta.Y };
					placeWindow(current, view);
				},
			};
		});
		frame.Parent = gui;
		return view;
	};

	const dropWindow = (view: WinView) => {
		popOut(view.frame, () => trove.remove(view.trove));
		task.delay(0.4, () => trove.remove(view.trove));
	};

	// Layout ----------------------------------------------------------------------------------------------------------

	/** Builds `node` into `parent`: a pane, or two areas and a draggable divider. */
	const build = (node: LayoutNode, parent: GuiObject, compact: boolean, into: Trove) => {
		if (node.kind === "leaf") {
			const view = panes.get(node.id);
			if (!view) return;
			view.frame.Position = UDim2.fromOffset(0, 0);
			view.frame.Size = UDim2.fromScale(1, 1);
			view.frame.Parent = parent;
			return;
		}
		const row = node.dir === "row" && !compact;
		const area = () => into.add(make("Frame", { BackgroundTransparency: 1, BorderSizePixel: 0 }, parent));
		const a = area();
		const b = area();
		const divider = into.add(
			make("TextButton", { Name: "Divider", Text: "", AutoButtonColor: false, BackgroundTransparency: 1, ZIndex: 2 }, parent),
		);
		const line = make(
			"Frame",
			{
				BackgroundColor3: COLORS.stroke,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromScale(0.5, 0.5),
				Size: row ? new UDim2(0, 2, 1, -16) : new UDim2(1, -16, 0, 2),
			},
			divider,
		);
		corner(line, 1);
		const place = () => {
			const r = node.ratio;
			if (row) {
				a.Size = new UDim2(r, -DIVIDER * r, 1, 0);
				divider.Position = new UDim2(r, -DIVIDER * r, 0, 0);
				divider.Size = new UDim2(0, DIVIDER, 1, 0);
				b.Position = new UDim2(r, DIVIDER * (1 - r), 0, 0);
				b.Size = new UDim2(1 - r, -DIVIDER * (1 - r), 1, 0);
			} else {
				a.Size = new UDim2(1, 0, r, -DIVIDER * r);
				divider.Position = new UDim2(0, 0, r, -DIVIDER * r);
				divider.Size = new UDim2(1, 0, 0, DIVIDER);
				b.Position = new UDim2(0, 0, r, DIVIDER * (1 - r));
				b.Size = new UDim2(1, 0, 1 - r, -DIVIDER * (1 - r));
			}
		};
		place();
		into.connect(divider.MouseEnter, () => (line.BackgroundColor3 = COLORS.accent));
		into.connect(divider.MouseLeave, () => (line.BackgroundColor3 = COLORS.stroke));
		into.connect(divider.InputBegan, (input) => {
			if (!isPointer(input) || input.UserInputState !== Enum.UserInputState.Begin) return;
			line.BackgroundColor3 = COLORS.accent;
			// Deltas only: an input's position may be off by the GUI inset, its movement never is.
			const from = node.ratio;
			drag = {
				input,
				start: input.Position,
				move: (delta) => {
					const total = (row ? parent.AbsoluteSize.X : parent.AbsoluteSize.Y) - DIVIDER;
					if (total <= 0) return;
					const least = (row ? MIN_PANE.X : MIN_PANE.Y) / total;
					const wanted = from + (row ? delta.X : delta.Y) / total;
					(node as SplitNode).ratio = clampRatio(least < 0.5 ? math.clamp(wanted, least, 1 - least) : 0.5);
					place();
				},
			};
		});
		build(node.a, a, compact, into);
		build(node.b, b, compact, into);
	};

	relayout = () => {
		if (!shown) return;
		const current = layout();
		repairFocus(current);
		const compact = isCompact();
		// Windows: new ones pop in, closed or docked ones pop out.
		const live = new Set<number>();
		for (const win of current.windows) {
			live.add(win.id);
			if (!wins.has(win.id)) {
				const view = createWindow(win);
				wins.set(win.id, view);
				placeWindow(win, view);
				popIn(view.frame);
			}
		}
		for (const [id, view] of wins) {
			if (live.has(id)) continue;
			wins.delete(id);
			dropWindow(view);
		}
		// Panes: the main panel's and those of windows that aren't minimised. The rest unmount (their loops stop).
		const wanted = new Map<number, [LeafNode, number]>();
		for (const leaf of leavesOf(current.main)) wanted.set(leaf.id, [leaf, 0]);
		for (const win of current.windows) {
			if (win.min === true) continue;
			for (const leaf of leavesOf(win.root)) wanted.set(leaf.id, [leaf, win.id]);
		}
		for (const [id, view] of panes) {
			if (wanted.has(id)) continue;
			panes.delete(id);
			destroyPane(view);
		}
		for (const [id, [leaf, owner]] of wanted) {
			let view = panes.get(id);
			if (!view) {
				view = createPane(leaf);
				panes.set(id, view);
			}
			view.leaf = leaf;
			view.owner = owner;
		}
		// Rebuild the split areas, move the panes into them, then drop the old areas.
		const old = containers;
		containers = trove.extend();
		build(current.main, mainHost, compact, containers);
		for (const win of current.windows) {
			const view = wins.get(win.id)!;
			placeWindow(win, view);
			if (win.min !== true) build(win.root, view.body, compact, containers);
			paintWindow(win, view);
		}
		trove.remove(old);
		// Pages mount once their pane is placed (they measure their size).
		for (const [, view] of panes) {
			if (view.page !== view.leaf.page) {
				view.title.Text = host.title(view.leaf.page);
				mountPage(view);
			}
			paintButtons(view);
		}
		if (menu && !panes.has(menu.pane)) closeMenu();
		paintFocus();
		paintOrder();
		host.focused(focusedPage());
	};

	openIn = (leafId, page) => {
		const current = layout();
		const result = openPage(current, leafId, page, (key) => host.single(key));
		if (!result) return;
		const owner = result[1];
		if (owner !== 0) {
			const win = windowOf(current, owner);
			if (win && win.min === true) win.min = undefined;
		}
		raise(current, owner);
		relayout();
		const view = panes.get(result[0].id);
		if (view && result[0].id !== leafId) bump(view.title);
	};

	split = (view, dir) => {
		if (view.buttons.get(dir === "row" ? "right" : "down")!.GetAttribute("Disabled") === true) {
			bump(view.title);
			return;
		}
		const page = host.single(view.leaf.page) ? host.fallback() : view.leaf.page;
		if (splitLeaf(layout(), view.leaf.id, dir, page, limits()) === undefined) return;
		relayout();
	};

	toWindow = (view) => {
		const win = popOutLeaf(layout(), view.leaf.id, host.fallback(), limits());
		if (!win) return;
		relayout();
	};

	closePane = (view) => {
		if (!closeLeaf(layout(), view.leaf.id)) return;
		relayout();
	};

	// Input: drags, tap-to-focus and bring-to-front, closing the picker -------------------------------------------------

	trove.connect(UserInputService.InputChanged, (input) => {
		if (!drag) return;
		const mouseMove =
			input.UserInputType === Enum.UserInputType.MouseMovement && drag.input.UserInputType === Enum.UserInputType.MouseButton1;
		if (!mouseMove && input !== drag.input) return;
		drag.move(input.Position.sub(drag.start));
	});
	trove.connect(UserInputService.InputEnded, (input) => {
		if (!drag) return;
		const mouseUp =
			input.UserInputType === Enum.UserInputType.MouseButton1 && drag.input.UserInputType === Enum.UserInputType.MouseButton1;
		if (mouseUp || input === drag.input) drag = undefined;
	});
	trove.connect(UserInputService.InputBegan, (input) => {
		if (!shown) return;
		if (input.KeyCode === Enum.KeyCode.Escape) return closeMenu();
		if (!isPointer(input) || input.UserInputState !== Enum.UserInputState.Begin) return;
		const point = pointOf(input);
		if (menu) {
			// Either reading of the position inside the picker or its button keeps it open (the button toggles it).
			const raw = new Vector2(input.Position.X, input.Position.Y);
			if (inside(menu.frame, point) || inside(menu.frame, raw)) return;
			if (!inside(menu.anchor, point) && !inside(menu.anchor, raw)) closeMenu();
		}
		const current = layout();
		for (let index = current.order.size() - 1; index >= 0; index--) {
			const id = current.order[index];
			const frame = windowFrame(id);
			if (!frame || !frame.Visible || !inside(frame, point)) continue;
			if (index !== current.order.size() - 1) {
				raise(current, id);
				paintOrder();
			}
			for (const [, view] of panes) {
				if (view.owner === id && view.frame.Parent !== undefined && inside(view.frame, point)) {
					setFocus(view.leaf.id);
					break;
				}
			}
			return;
		}
	});

	// The screen changed size: windows stay inside it; crossing the phone size re-lays out (stacked panes).
	let wasCompact = isCompact();
	trove.connect(gui.GetPropertyChangedSignal("AbsoluteSize"), () => {
		if (!shown) return;
		const compact = isCompact();
		if (compact !== wasCompact) {
			wasCompact = compact;
			relayout();
			return;
		}
		for (const win of layout().windows) {
			const view = wins.get(win.id);
			if (view) placeWindow(win, view);
		}
	});

	const unmount = () => {
		shown = false;
		drag = undefined;
		closeMenu();
		for (const [, view] of panes) destroyPane(view);
		panes.clear();
		for (const [, view] of wins) trove.remove(view.trove);
		wins.clear();
		trove.remove(containers);
		containers = trove.extend();
	};
	trove.add(() => {
		shown = false;
	});

	return {
		show: () => {
			if (!shown) {
				shown = true;
				wasCompact = isCompact();
				relayout();
				return;
			}
			// Reopened while closing: the windows pop back in.
			for (const [, view] of wins) popIn(view.frame);
		},
		fadeOut: () => {
			closeMenu();
			drag = undefined;
			for (const [, view] of wins) popOut(view.frame);
		},
		unmount,
		open: (page) => openIn(layout().focus, page),
		focusedPage,
		replacePages: (map) => {
			let changed = false;
			for (const leaf of leavesOf(layout().main)) {
				const page = map(leaf.page);
				if (page !== undefined && page !== leaf.page) {
					leaf.page = page;
					changed = true;
				}
			}
			for (const win of layout().windows) {
				for (const leaf of leavesOf(win.root)) {
					const page = map(leaf.page);
					if (page !== undefined && page !== leaf.page) {
						leaf.page = page;
						changed = true;
					}
				}
			}
			if (changed) relayout();
		},
	};
}
