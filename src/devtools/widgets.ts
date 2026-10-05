import { Players, UserInputService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { bump, popIn, popOut } from "../ui";

/**
 * Building blocks of the dev menu UI (plans/10), shared by its tabs: colors, instance helpers, the `Page` column,
 * buttons, an icon button, a search box and a player selector. User UI rules: no emojis or glyph icons (icons are
 * drawn from Frames), short labels, TextSize >= 14, buttons >= 32 px, script-free ScrollingFrames, troves for
 * everything that connects or spawns.
 */

export const COLORS = {
	window: Color3.fromRGB(22, 24, 30),
	header: Color3.fromRGB(30, 33, 41),
	row: Color3.fromRGB(36, 40, 50),
	button: Color3.fromRGB(50, 55, 68),
	stroke: Color3.fromRGB(64, 69, 82),
	accent: Color3.fromRGB(255, 138, 61),
	text: Color3.fromRGB(232, 234, 240),
	dim: Color3.fromRGB(150, 157, 172),
	good: Color3.fromRGB(112, 214, 134),
	warn: Color3.fromRGB(255, 196, 87),
	bad: Color3.fromRGB(255, 107, 107),
	info: Color3.fromRGB(122, 178, 255),
	dark: Color3.fromRGB(18, 18, 22),
};

/** Height of buttons and single-line inputs (phone-readable). */
export const BUTTON_HEIGHT = 34;
/** Fixed width of a picker row's action button, so the rows line up. */
export const ACTION_WIDTH = 104;

export function make<T extends keyof CreatableInstances>(
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

export function corner(parent: Instance, radius: number) {
	make("UICorner", { CornerRadius: new UDim(0, radius) }, parent);
}

export function pad(parent: Instance, vertical: number, horizontal: number) {
	make(
		"UIPadding",
		{
			PaddingTop: new UDim(0, vertical),
			PaddingBottom: new UDim(0, vertical),
			PaddingLeft: new UDim(0, horizontal),
			PaddingRight: new UDim(0, horizontal),
		},
		parent,
	);
}

export function style<T extends TextLabel | TextButton | TextBox>(
	gui: T,
	text: string,
	size = 15,
	color = COLORS.text,
	font: Enum.Font = Enum.Font.BuilderSans,
): T {
	gui.Text = text;
	gui.TextSize = size;
	gui.TextColor3 = color;
	gui.Font = font;
	gui.TextXAlignment = Enum.TextXAlignment.Left;
	gui.TextWrapped = true;
	gui.BorderSizePixel = 0;
	return gui;
}

export function verticalList(parent: Instance, gap: number) {
	make(
		"UIListLayout",
		{ FillDirection: Enum.FillDirection.Vertical, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, gap) },
		parent,
	);
}

/** Script-free scrolling (user UI rule): AutomaticCanvasSize + a layout; Lua never touches CanvasSize. */
export function scrolling(parent: Instance, props: Partial<WritableInstanceProperties<ScrollingFrame>>): ScrollingFrame {
	const frame = make(
		"ScrollingFrame",
		{
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			CanvasSize: new UDim2(),
			AutomaticCanvasSize: Enum.AutomaticSize.Y,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			ScrollBarThickness: 6,
			ScrollBarImageColor3: COLORS.dim,
			VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
		},
		parent,
	);
	for (const [key, value] of pairs(props as unknown as Record<string, unknown>)) {
		(frame as unknown as Record<string, unknown>)[key] = value;
	}
	return frame;
}

/** Next LayoutOrder in a list container (counts every child, so it only grows). */
function nextOrder(row: Instance): number {
	return row.GetChildren().size();
}

export function addButton(row: Instance, text: string, onClick: () => void, color = COLORS.button): TextButton {
	const button = style(make("TextButton", { AutoButtonColor: true }), text, 15, COLORS.text, Enum.Font.BuilderSansMedium);
	button.TextXAlignment = Enum.TextXAlignment.Center;
	button.TextWrapped = false;
	button.BackgroundColor3 = color;
	button.Size = UDim2.fromOffset(0, BUTTON_HEIGHT);
	button.AutomaticSize = Enum.AutomaticSize.X;
	button.LayoutOrder = nextOrder(row);
	corner(button, 6);
	pad(button, 0, 12);
	button.Parent = row;
	button.Activated.Connect(onClick);
	return button;
}

/** Paints a toggle-style button (selected realm, sub-tab, on/off switch). */
export function paintSelected(button: TextButton, selected: boolean, color = COLORS.accent) {
	button.BackgroundColor3 = selected ? color : COLORS.button;
	button.TextColor3 = selected ? COLORS.dark : COLORS.text;
}

/** A horizontal row of buttons that wraps on narrow screens. */
export function buttonRow(): Frame {
	const row = make("Frame", {
		BackgroundTransparency: 1,
		Size: new UDim2(1, 0, 0, BUTTON_HEIGHT),
		AutomaticSize: Enum.AutomaticSize.Y,
	});
	make(
		"UIListLayout",
		{
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, 6),
			Wraps: true,
		},
		row,
	);
	return row;
}

/**
 * "45s", "12m", "3h 04m", "2d 3h": the short uptime and age text of Manage > Servers rows ("up 12m", "seen 2m ago") and
 * the Artifact tab ("Running", "Server up", "Built ... (8m ago)").
 */
export function shortDuration(seconds: number | undefined): string {
	if (seconds === undefined) return "-";
	const total = math.max(0, math.floor(seconds));
	const days = math.floor(total / 86400);
	const hours = math.floor((total % 86400) / 3600);
	const minutes = math.floor((total % 3600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return "%dh %02dm".format(hours, minutes);
	if (minutes > 0) return `${minutes}m`;
	return `${total}s`;
}

/** How long a two-tap button stays armed ("Confirm"). */
export const ARM_SECONDS = 4;

/** A two-tap button's state. Keep it outside redraws, so a refresh neither drops the arm nor the lock. */
export interface ArmState {
	armedAt: number;
	locked: boolean;
}

export function newArmState(): ArmState {
	return { armedAt: -math.huge, locked: false };
}

/**
 * The confirm pattern for actions that move a whole server (Migrate, Switch, Load here): the first tap turns the button
 * green "Confirm" for ARM_SECONDS and calls `onArm` (say what will happen); the second runs `run` once and locks the
 * button dark with `busyLabel`. `run` gets `unlock` for when it failed. `idle` may change (call the returned paint).
 */
export function armLock(
	button: TextButton,
	state: ArmState,
	idle: { label: string; color?: Color3 },
	busyLabel: string,
	onArm: () => void,
	run: (unlock: () => void) => void,
): () => void {
	const paint = () => {
		if (state.locked) {
			button.AutoButtonColor = false;
			button.BackgroundColor3 = COLORS.button;
			button.TextColor3 = COLORS.dim;
			button.Text = busyLabel;
			return;
		}
		button.AutoButtonColor = true;
		if (os.clock() - state.armedAt < ARM_SECONDS) {
			button.BackgroundColor3 = COLORS.good;
			button.TextColor3 = COLORS.dark;
			button.Text = "Confirm";
			return;
		}
		button.BackgroundColor3 = idle.color ?? COLORS.button;
		button.TextColor3 = idle.color !== undefined ? COLORS.dark : COLORS.text;
		button.Text = idle.label;
	};
	const unlock = () => {
		state.locked = false;
		state.armedAt = -math.huge;
		if (button.Parent) paint();
	};
	paint();
	button.Activated.Connect(() => {
		if (state.locked) return;
		if (os.clock() - state.armedAt < ARM_SECONDS) {
			state.armedAt = -math.huge;
			state.locked = true;
			paint();
			run(unlock);
			return;
		}
		state.armedAt = os.clock();
		paint();
		bump(button);
		onArm();
		task.delay(ARM_SECONDS, () => {
			if (button.Parent) paint();
		});
	});
	return paint;
}

/** A row of small word chips ("Here", "Reserved", "A/B") that wraps instead of truncating. */
export function chipRow(): Frame {
	const row = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y });
	make(
		"UIListLayout",
		{
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, 4),
			Wraps: true,
		},
		row,
	);
	return row;
}

/** One chip: a short word on a dark pill with a colored outline; it sizes to its text and never truncates. */
export function chip(row: Instance, text: string, color: Color3): TextLabel {
	const label = style(make("TextLabel", { BackgroundColor3: COLORS.window, BackgroundTransparency: 0 }), text, 13, color, Enum.Font.BuilderSansBold);
	label.TextWrapped = false;
	label.TextXAlignment = Enum.TextXAlignment.Center;
	label.Size = UDim2.fromOffset(0, 20);
	label.AutomaticSize = Enum.AutomaticSize.X;
	label.LayoutOrder = nextOrder(row);
	corner(label, 10);
	pad(label, 0, 7);
	make("UIStroke", { Color: color, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, label);
	label.Parent = row;
	return label;
}

/** An empty item that takes the rest of a buttonRow's line, pushing the next items to the right. */
export function spacer(row: Instance): Frame {
	const gap = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromOffset(0, BUTTON_HEIGHT), LayoutOrder: nextOrder(row) });
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, gap);
	gap.Parent = row;
	return gap;
}

export type ChevronDirection = "up" | "down" | "right";

/**
 * A chevron drawn from two rotated Frames (no glyphs), filling `parent` (give it a square size). Returns its holder,
 * so callers can show or hide it.
 */
export function chevron(parent: Instance, direction: ChevronDirection, color = COLORS.text, thickness = 3): Frame {
	const holder = make("Frame", { Name: "Chevron", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1) }, parent);
	// side -1 / +1 = the two arms. Up: arms left/right meeting at the top; down: meeting at the bottom; right: arms
	// top/bottom meeting at the right.
	for (const side of [-1, 1]) {
		const horizontalPair = direction !== "right";
		const rotation = direction === "up" ? side * 45 : -side * 45;
		const arm = make(
			"Frame",
			{
				BackgroundColor3: color,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: horizontalPair
					? new UDim2(0.5 + side * 0.09, 0, 0.5, 0)
					: new UDim2(0.5, 0, 0.5 + side * 0.09, 0),
				Size: new UDim2(0.3, 0, 0, thickness),
				Rotation: rotation,
			},
			holder,
		);
		corner(arm, 2);
	}
	return holder;
}

/** A square icon button with an "up" chevron (no glyphs). */
export function upButton(row: Instance, onClick: () => void): TextButton {
	const button = make("TextButton", {
		Name: "Up",
		AutoButtonColor: true,
		Text: "",
		BackgroundColor3: COLORS.button,
		BorderSizePixel: 0,
		Size: UDim2.fromOffset(BUTTON_HEIGHT, BUTTON_HEIGHT),
		LayoutOrder: nextOrder(row),
	});
	make("UIAspectRatioConstraint", { AspectRatio: 1 }, button);
	corner(button, 6);
	chevron(button, "up");
	button.Parent = row;
	button.Activated.Connect(onClick);
	return button;
}

/** Width of the right-hand button of a two-part row (sideButton). */
export const SIDE_BUTTON = 76;

/**
 * A fixed-width button pinned to the right edge of `row` (a Frame with a fixed height). The row's left part must be
 * sized `UDim2(1, -(SIDE_BUTTON + 8), ...)` so the two never overlap at any width.
 */
export function sideButton(row: Instance, text: string, color = COLORS.button, textColor = COLORS.text): TextButton {
	const button = style(make("TextButton", { AutoButtonColor: true }), text, 15, textColor, Enum.Font.BuilderSansMedium);
	button.TextXAlignment = Enum.TextXAlignment.Center;
	button.TextWrapped = false;
	button.TextTruncate = Enum.TextTruncate.AtEnd;
	button.BackgroundColor3 = color;
	button.AnchorPoint = new Vector2(1, 0);
	button.Position = UDim2.fromScale(1, 0);
	button.Size = new UDim2(0, SIDE_BUTTON, 1, 0);
	corner(button, 6);
	button.Parent = row;
	return button;
}

/** A fixed-height row for "left part + sideButton" layouts (no AutomaticSize, no flex: it can't outgrow its parent). */
export function fixedRow(height = BUTTON_HEIGHT): Frame {
	return make("Frame", { BackgroundTransparency: 1, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, height) });
}

/** A single-line text box that takes the rest of a buttonRow's line. */
export function searchBox(row: Instance, placeholder: string, minWidth = 120): TextBox {
	const box = style(make("TextBox", { ClearTextOnFocus: false }), "", 15);
	box.PlaceholderText = placeholder;
	box.PlaceholderColor3 = COLORS.dim;
	box.TextWrapped = false;
	box.ClipsDescendants = true;
	box.BackgroundColor3 = COLORS.row;
	box.Size = UDim2.fromOffset(minWidth, BUTTON_HEIGHT);
	box.LayoutOrder = nextOrder(row);
	corner(box, 6);
	pad(box, 0, 8);
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, box);
	box.Parent = row;
	return box;
}

export function escapeRich(text: string): string {
	return text.gsub("&", "&amp;")[0].gsub("<", "&lt;")[0].gsub(">", "&gt;")[0];
}

export function hex(color: Color3): string {
	return `#${color.ToHex()}`;
}

/** A RichText tag like "LIVE" in a color. */
export function tag(text: string, color: Color3): string {
	return ` <font color="${hex(color)}"><b>${escapeRich(text)}</b></font>`;
}

/** One column of rows inside a ScrollingFrame or a fixed bar. Rows are rebuilt freely; the layout sizes everything. */
export class Page {
	private order = 0;

	constructor(readonly frame: Frame) {}

	static mount(parent: Instance, gap = 6): Page {
		const frame = make("Frame", {
			Name: "Page",
			BackgroundTransparency: 1,
			Size: UDim2.fromScale(1, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
		});
		verticalList(frame, gap);
		frame.Parent = parent;
		return new Page(frame);
	}

	place<T extends GuiObject>(gui: T): T {
		this.order += 1;
		gui.LayoutOrder = this.order;
		gui.Parent = this.frame;
		return gui;
	}

	clear() {
		for (const child of this.frame.GetChildren()) {
			if (child.IsA("GuiObject")) child.Destroy();
		}
		this.order = 0;
	}

	group(gap = 6): Page {
		const page = Page.mount(this.frame, gap);
		this.order += 1;
		page.frame.LayoutOrder = this.order;
		return page;
	}

	section(text: string): TextLabel {
		const label = style(make("TextLabel", { BackgroundTransparency: 1 }), text, 16, COLORS.accent, Enum.Font.BuilderSansBold);
		label.Size = new UDim2(1, 0, 0, 26);
		label.TextYAlignment = Enum.TextYAlignment.Bottom;
		return this.place(label);
	}

	text(text: string, color = COLORS.text, code = false): TextLabel {
		const label = style(
			make("TextLabel", { BackgroundTransparency: 1 }),
			text,
			code ? 14 : 15,
			color,
			code ? Enum.Font.Code : Enum.Font.BuilderSans,
		);
		label.Size = UDim2.fromScale(1, 0);
		label.AutomaticSize = Enum.AutomaticSize.Y;
		return this.place(label);
	}

	/** Label + value. The value is a read-only TextBox, so it can be selected and copied (commit hashes, job ids). */
	field(name: string, value: string, color = COLORS.text): TextBox {
		const row = this.place(
			make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y }),
		);
		const label = style(make("TextLabel", { BackgroundTransparency: 1 }, row), name, 15, COLORS.dim);
		label.Size = new UDim2(0.34, -8, 0, 0);
		label.AutomaticSize = Enum.AutomaticSize.Y;
		const box = style(make("TextBox", { BackgroundTransparency: 1 }, row), value, 14, color, Enum.Font.Code);
		box.TextEditable = false;
		box.ClearTextOnFocus = false;
		box.Size = new UDim2(0.66, 0, 0, 0);
		box.Position = UDim2.fromScale(0.34, 0);
		box.AutomaticSize = Enum.AutomaticSize.Y;
		return box;
	}

	/** Label + an editable value; `commit` runs when the player presses Enter with a changed value. */
	editable(name: string, value: string, commit: (text: string) => void): TextBox {
		const box = this.field(name, value);
		box.TextEditable = true;
		box.BackgroundTransparency = 0;
		box.BackgroundColor3 = COLORS.row;
		corner(box, 4);
		pad(box, 4, 6);
		box.FocusLost.Connect((enterPressed) => {
			if (enterPressed && box.Text !== value) commit(box.Text);
			else box.Text = value;
		});
		return box;
	}

	/** A horizontal row of buttons (wraps on narrow screens). Add buttons with addButton(row, ...). */
	buttons(): Frame {
		return this.place(buttonRow());
	}

	/** A full-width clickable row (dex children). */
	link(text: string, onClick: () => void): TextButton {
		const button = style(make("TextButton", { AutoButtonColor: true }), text, 15);
		button.BackgroundColor3 = COLORS.row;
		button.TextWrapped = false;
		button.TextTruncate = Enum.TextTruncate.AtEnd;
		button.Size = new UDim2(1, 0, 0, BUTTON_HEIGHT);
		corner(button, 4);
		pad(button, 0, 8);
		button.Activated.Connect(onClick);
		return this.place(button);
	}

	/**
	 * A picker row: a RichText title line and a dim detail line, plus an optional fixed-width action button on the
	 * right. Callers escape their values (escapeRich).
	 */
	row(title: string, detail: string, action?: { label: string; color?: Color3; onClick: (button: TextButton) => void }) {
		const row = this.place(
			make("Frame", {
				BackgroundColor3: COLORS.row,
				BorderSizePixel: 0,
				Size: UDim2.fromScale(1, 0),
				AutomaticSize: Enum.AutomaticSize.Y,
			}),
		);
		corner(row, 6);
		pad(row, 6, 8);
		const label = style(
			make("TextLabel", { BackgroundTransparency: 1, RichText: true }, row),
			`${title}\n<font size="14" color="${hex(COLORS.dim)}">${detail}</font>`,
			15,
		);
		label.Size = new UDim2(1, action ? -(ACTION_WIDTH + 8) : 0, 0, 0);
		label.AutomaticSize = Enum.AutomaticSize.Y;
		if (action) {
			const button = style(
				make("TextButton", { AutoButtonColor: true }, row),
				action.label,
				15,
				action.color ? COLORS.dark : COLORS.text,
				Enum.Font.BuilderSansMedium,
			);
			button.TextXAlignment = Enum.TextXAlignment.Center;
			button.TextWrapped = false;
			button.BackgroundColor3 = action.color ?? COLORS.button;
			button.AnchorPoint = new Vector2(1, 0);
			button.Position = UDim2.fromScale(1, 0);
			button.Size = UDim2.fromOffset(ACTION_WIDTH, BUTTON_HEIGHT);
			corner(button, 6);
			button.Activated.Connect(() => action.onClick(button));
		}
		return row;
	}

	input(placeholder: string, height: number, multiline: boolean): TextBox {
		const box = style(make("TextBox", { ClearTextOnFocus: false }), "", 15);
		box.PlaceholderText = placeholder;
		box.PlaceholderColor3 = COLORS.dim;
		box.MultiLine = multiline;
		box.TextYAlignment = Enum.TextYAlignment.Top;
		box.BackgroundColor3 = COLORS.row;
		box.Size = new UDim2(1, 0, 0, height);
		corner(box, 6);
		pad(box, 6, 8);
		return this.place(box);
	}
}

// Copy popup --------------------------------------------------------------------------------------------------------

/** Closes the open copy popup (one at a time). */
let closeCopy: (() => void) | undefined;

/**
 * Roblox has no clipboard API, so "copy" shows `text` in a small popup: a read-only TextBox with all of it selected.
 * The player copies it with Ctrl+C (a dim hint says so on keyboards) or, on touch, with long-press > Copy. Text with
 * line breaks or over 80 characters shows on several lines and scrolls when long.
 *
 * - `anchor`: the popup opens next to it, inside its ScreenGui, and closes by itself when the anchor leaves the game
 *   (so it goes with the tab trove that owns the anchor). Without an anchor it is centered in its own ScreenGui.
 * - Closes on Escape, Enter, a click or tap outside, or its close button. Opening another one closes it.
 * - Client only. Returns a function that closes it.
 */
export function copyText(text: string, anchor?: GuiObject): () => void {
	closeCopy?.();
	const touch = UserInputService.TouchEnabled && !UserInputService.MouseEnabled;
	const keyboard = UserInputService.KeyboardEnabled && !touch;
	const multiline = text.find("\n", 1, true)[0] !== undefined || text.size() > 80;
	const trove = new Trove();

	// Inside the anchor's ScreenGui (same coordinates, same lifetime), else a ScreenGui of its own.
	let layer = anchor?.FindFirstAncestorWhichIsA("LayerCollector");
	if (!layer) {
		layer = trove.add(
			make("ScreenGui", {
				Name: "TypeTorchCopy",
				DisplayOrder: 1000,
				IgnoreGuiInset: true,
				ResetOnSpawn: false,
				ZIndexBehavior: Enum.ZIndexBehavior.Sibling,
			}),
		);
		layer.Parent = Players.LocalPlayer.WaitForChild("PlayerGui");
	}
	// A transparent full-size button under the panel: a click or tap outside closes. ZIndex is set on every piece, so
	// it also stays on top in a ScreenGui with Global ZIndexBehavior.
	const backdrop = trove.add(
		make("TextButton", {
			Name: "CopyText",
			Text: "",
			AutoButtonColor: false,
			BackgroundTransparency: 1,
			Size: UDim2.fromScale(1, 1),
			ZIndex: 1000,
		}),
	);
	const layerSize = layer.IsA("GuiBase2d") ? layer.AbsoluteSize : new Vector2(800, 600);
	const closeSize = touch ? 34 : 26;
	const hint = keyboard ? 16 : 0;
	const width = math.min(420, math.max(220, layerSize.X - 32));
	const lineHeight = 18;
	const boxHeight = multiline ? math.min(240, math.max(3, text.split("\n").size()) * lineHeight + 12) : BUTTON_HEIGHT;
	const height = boxHeight + 16 + hint;

	const panel = make(
		"Frame",
		{ BackgroundColor3: COLORS.header, BorderSizePixel: 0, Size: UDim2.fromOffset(width, height), ZIndex: 1001 },
		backdrop,
	);
	corner(panel, 8);
	make("UIStroke", { Color: COLORS.stroke, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, panel);
	// Swallow clicks on the panel itself (they would reach the backdrop and close it).
	make("TextButton", { Text: "", AutoButtonColor: false, BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: 1001 }, panel);

	const boxFrame = make(
		"Frame",
		{
			BackgroundColor3: COLORS.row,
			BorderSizePixel: 0,
			ClipsDescendants: true,
			Position: UDim2.fromOffset(8, 8),
			Size: new UDim2(1, -(closeSize + 24), 0, boxHeight),
			ZIndex: 1002,
		},
		panel,
	);
	corner(boxFrame, 6);
	const box = style(
		make("TextBox", {
			BackgroundTransparency: 1,
			ClearTextOnFocus: false,
			TextEditable: false,
			MultiLine: multiline,
			ZIndex: 1003,
		}),
		text,
		14,
		COLORS.text,
		Enum.Font.Code,
	);
	if (multiline) {
		// Script-free scrolling: the box grows with its text, the canvas follows (no UIPadding on the ScrollingFrame).
		const scroll = scrolling(boxFrame, { Size: UDim2.fromScale(1, 1), ZIndex: 1003 });
		verticalList(scroll, 0);
		const inner = make(
			"Frame",
			{ BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, ZIndex: 1003 },
			scroll,
		);
		pad(inner, 6, 8);
		box.TextYAlignment = Enum.TextYAlignment.Top;
		box.Size = UDim2.fromScale(1, 0);
		box.AutomaticSize = Enum.AutomaticSize.Y;
		box.Parent = inner;
	} else {
		box.TextWrapped = false;
		box.ClipsDescendants = true;
		box.Size = UDim2.fromScale(1, 1);
		pad(box, 0, 8);
		box.Parent = boxFrame;
	}

	// Close button: an X from two bars (no glyphs).
	const closeButton = make(
		"TextButton",
		{
			Text: "",
			AutoButtonColor: true,
			BackgroundColor3: COLORS.button,
			BorderSizePixel: 0,
			AnchorPoint: new Vector2(1, 0),
			Position: new UDim2(1, -8, 0, 8),
			Size: UDim2.fromOffset(closeSize, closeSize),
			ZIndex: 1002,
		},
		panel,
	);
	corner(closeButton, 6);
	for (const angle of [45, -45]) {
		make(
			"Frame",
			{
				BackgroundColor3: COLORS.text,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromScale(0.5, 0.5),
				Size: UDim2.fromOffset(math.floor(closeSize * 0.5), 2),
				Rotation: angle,
				ZIndex: 1003,
			},
			closeButton,
		);
	}
	if (keyboard) {
		const label = style(make("TextLabel", { BackgroundTransparency: 1, ZIndex: 1002 }, panel), "Ctrl+C", 13, COLORS.dim);
		label.TextXAlignment = Enum.TextXAlignment.Right;
		label.AnchorPoint = new Vector2(1, 1);
		label.Position = new UDim2(1, -(closeSize + 16), 1, -4);
		label.Size = UDim2.fromOffset(80, hint);
	}

	// Next to the anchor (below it, or above when there is no room), clamped to the layer; centered without one.
	backdrop.Parent = layer;
	if (anchor) {
		const origin = backdrop.AbsolutePosition;
		const at = anchor.AbsolutePosition.sub(origin);
		const room = backdrop.AbsoluteSize;
		const x = math.clamp(at.X, 8, math.max(8, room.X - width - 8));
		let y = at.Y + anchor.AbsoluteSize.Y + 4;
		if (y + height > room.Y - 8) y = at.Y - height - 4;
		panel.Position = UDim2.fromOffset(x, math.clamp(y, 8, math.max(8, room.Y - height - 8)));
	} else {
		panel.AnchorPoint = new Vector2(0.5, 0.5);
		panel.Position = UDim2.fromScale(0.5, 0.5);
	}
	popIn(panel);

	let closed = false;
	// Select everything (again a frame later: focusing can move the cursor).
	const selectAll = () => {
		if (closed || !box.Parent) return;
		box.CaptureFocus();
		box.SelectionStart = 1;
		box.CursorPosition = text.size() + 1;
	};
	selectAll();
	task.defer(selectAll);

	// Connections end the moment it closes; the pieces go after the pop-out (or at once if that can't play).
	const events = trove.extend();
	let close: (animate?: boolean) => void = () => {};
	close = (animate = true) => {
		if (closed) return;
		closed = true;
		if (closeCopy === close) closeCopy = undefined;
		trove.remove(events);
		if (box.IsFocused()) box.ReleaseFocus();
		if (animate && panel.IsDescendantOf(game)) {
			popOut(panel, () => trove.destroy());
			task.delay(0.5, () => trove.destroy());
		} else trove.destroy();
	};
	closeCopy = close;
	events.connect(backdrop.Activated, () => close());
	events.connect(backdrop.MouseButton2Click, () => close());
	events.connect(closeButton.Activated, () => close());
	events.connect(box.FocusLost, (enter) => enter && close());
	events.connect(UserInputService.InputBegan, (input) => {
		if (input.KeyCode === Enum.KeyCode.Escape) close();
	});
	if (anchor) {
		events.connect(anchor.AncestryChanged, () => {
			if (!anchor.IsDescendantOf(game)) close(false);
		});
	}
	return () => close();
}

// Player selector ---------------------------------------------------------------------------------------------------

/** userId -> headshot content id (thumbnails never change within a session). */
const headshots = new Map<number, string>();

export interface PlayerSelectorOptions {
	/** Players to leave out (for example the local player). */
	exclude?: (player: Player) => boolean;
	/** UserId of the selected player (highlighted). */
	selected?: number;
	/** Shown when nobody is listed. */
	emptyText?: string;
	onSelect: (player: Player) => void;
}

/**
 * The players in this server (headshot, DisplayName, @Name) as a single-selection list inside `target`. Rebuilds on
 * join and leave; every connection and thumbnail request lives in `trove`. Returns the list's Page.
 */
export function playerSelector(target: Page, trove: Trove, options: PlayerSelectorOptions): Page {
	const list = target.group(4);
	let selected = options.selected;

	const draw = (leaving?: Player) => {
		list.clear();
		const players = Players.GetPlayers().filter(
			(player) => player !== leaving && !(options.exclude !== undefined && options.exclude(player)),
		);
		players.sort((a, b) => a.DisplayName.lower() < b.DisplayName.lower());
		if (players.size() === 0) {
			list.text(options.emptyText ?? "No players", COLORS.dim);
			return;
		}
		for (const player of players) {
			const isSelected = player.UserId === selected;
			const row = list.place(
				make("TextButton", {
					Name: player.Name,
					AutoButtonColor: true,
					Text: "",
					BackgroundColor3: isSelected ? COLORS.accent : COLORS.row,
					BorderSizePixel: 0,
					Size: new UDim2(1, 0, 0, 44),
				}),
			);
			corner(row, 6);
			const image = make(
				"ImageLabel",
				{
					BackgroundColor3: COLORS.button,
					BorderSizePixel: 0,
					AnchorPoint: new Vector2(0, 0.5),
					Position: new UDim2(0, 6, 0.5, 0),
					Size: UDim2.fromOffset(32, 32),
					Image: headshots.get(player.UserId) ?? "",
				},
				row,
			);
			make("UIAspectRatioConstraint", { AspectRatio: 1 }, image);
			corner(image, 16);
			const label = style(
				make("TextLabel", { BackgroundTransparency: 1, RichText: true }, row),
				`<b>${escapeRich(player.DisplayName)}</b>  <font color="${hex(isSelected ? COLORS.dark : COLORS.dim)}">@${escapeRich(player.Name)}</font>`,
				15,
				isSelected ? COLORS.dark : COLORS.text,
			);
			label.TextWrapped = false;
			label.TextTruncate = Enum.TextTruncate.AtEnd;
			label.Position = UDim2.fromOffset(46, 0);
			label.Size = new UDim2(1, -52, 1, 0);
			row.Activated.Connect(() => {
				selected = player.UserId;
				options.onSelect(player);
			});
			if (!headshots.has(player.UserId)) {
				trove.add(
					task.spawn(() => {
						const [ok, content] = pcall(
							() =>
								Players.GetUserThumbnailAsync(
									player.UserId,
									Enum.ThumbnailType.HeadShot,
									Enum.ThumbnailSize.Size48x48,
								)[0],
						);
						if (!ok || !typeIs(content, "string")) return;
						headshots.set(player.UserId, content);
						if (image.Parent) image.Image = content;
					}),
				);
			}
		}
	};

	trove.connect(Players.PlayerAdded, () => draw());
	trove.connect(Players.PlayerRemoving, (player) => draw(player));
	draw();
	return list;
}
