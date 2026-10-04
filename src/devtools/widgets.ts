import { Players } from "@rbxts/services";
import { Trove } from "@rbxts/trove";

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
