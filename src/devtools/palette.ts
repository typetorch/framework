import { UserInputService, Workspace } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { popIn, popOut } from "../ui";
import {
	ArmedCommand,
	armStep,
	Command,
	CommandRegistry,
	flatten,
	isArmed,
	isAvailable,
	moveSelection,
	pushRecent,
	searchCommands,
	ARM_SECONDS,
} from "./commands";
import { BUTTON_HEIGHT, COLORS, corner, make, pad, scrolling, style, verticalList } from "./widgets";

/**
 * The dev menu's command palette (Ctrl+K / Cmd+K, or the search button in the menu header): a search box over every
 * command the dev may run now (devtools/commands.ts: fuzzy match, `when` filter, recent first on an empty query).
 *
 * Keys: type to filter, Up / Down to pick, Enter runs, Shift+Enter runs "in a split" (pages), Escape closes. Clicking a
 * row runs it (Shift+click: split). Two-step commands (anything that swaps what runs on the server) arm on the first
 * Enter or tap and run on the second within ARM_SECONDS; the status line under the list says what will happen and,
 * for commands that keep it open, how it went.
 *
 * It lives in the dev menu's ScreenGui above every window (under the page picker and the copy popup) and pops in and
 * out through a UIScale. Everything is rebuilt per keystroke (at most RESULT_LIMIT rows).
 */

const TOUCH = UserInputService.TouchEnabled && !UserInputService.MouseEnabled;
const WIDTH = 560;
const ROW = TOUCH ? 40 : 30;
const GROUP_ROW = 22;
const LIST_MAX = 380;
const TOP = TOUCH ? 12 : 72;
/** Above every window (their ZIndex is their stacking order) and the page picker (900), under the copy popup (1000). */
const PALETTE_Z = 950;
const KEYS_HINT = "Enter run   Shift+Enter split   Esc close";

export interface PaletteOptions<C> {
	/** The dev menu's ScreenGui. */
	readonly gui: ScreenGui;
	/** The client generation's trove. */
	readonly trove: Trove;
	readonly registry: CommandRegistry<C>;
	/** A fresh context for `when`, sources and `run` (read on every redraw). */
	readonly context: () => C;
	/** Recent command ids, newest first (kept in the menu's persist store). */
	readonly recent: () => string[];
	readonly setRecent: (list: string[]) => void;
	/** The palette opened: load what the dynamic commands need, then call `refresh`. */
	readonly opened?: () => void;
}

export interface Palette {
	readonly open: (query?: string) => void;
	readonly close: () => void;
	readonly isOpen: () => boolean;
	/** Redraws the results (data for dynamic commands arrived). */
	readonly refresh: () => void;
	/** The status line under the list (progress and results of commands that keep the palette open). */
	readonly report: (text: string, color: Color3) => void;
}

interface RowView<C> {
	button: TextButton;
	hint: TextLabel;
	command: Command<C>;
}

export function createPalette<C>(options: PaletteOptions<C>): Palette {
	const { gui, trove, registry } = options;
	let shown = false;
	let selected = 0;
	let rows = new Array<RowView<C>>();
	const armed: ArmedCommand = { at: -math.huge };
	let statusToken = 0;

	const root = trove.add(
		make(
			"Frame",
			{ Name: "CommandPalette", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), Visible: false, ZIndex: PALETTE_Z },
			gui,
		),
	);
	// Click or tap outside: close.
	const backdrop = make(
		"TextButton",
		{
			Name: "Backdrop",
			Text: "",
			AutoButtonColor: false,
			BackgroundColor3: COLORS.dark,
			BackgroundTransparency: 0.55,
			BorderSizePixel: 0,
			Size: UDim2.fromScale(1, 1),
		},
		root,
	);
	const panel = make(
		"Frame",
		{ Name: "Panel", Active: true, BackgroundColor3: COLORS.header, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0), ZIndex: 2 },
		root,
	);
	corner(panel, 10);
	make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, panel);
	pad(panel, 8, 8);
	verticalList(panel, 6);

	const box = style(make("TextBox", { Name: "Search", ClearTextOnFocus: false, LayoutOrder: 1, ZIndex: 3 }), "", 16);
	box.PlaceholderText = "Run a command or open a page";
	box.PlaceholderColor3 = COLORS.dim;
	box.TextWrapped = false;
	box.ClipsDescendants = true;
	box.BackgroundColor3 = COLORS.row;
	box.Size = new UDim2(1, 0, 0, BUTTON_HEIGHT + 4);
	corner(box, 6);
	pad(box, 0, 10);
	box.Parent = panel;

	const list = scrolling(panel, { Name: "Results", LayoutOrder: 2, ScrollBarThickness: 4, ZIndex: 3 });
	verticalList(list, 2);

	const status = style(make("TextLabel", { Name: "Status", BackgroundTransparency: 1, LayoutOrder: 3, ZIndex: 3 }, panel), "", 13, COLORS.dim);
	status.TextWrapped = false;
	status.TextTruncate = Enum.TextTruncate.AtEnd;
	status.Size = new UDim2(1, 0, 0, 18);
	pad(status, 0, 4);

	const viewport = (): Vector2 => {
		if (gui.AbsoluteSize.X > 0 && gui.AbsoluteSize.Y > 0) return gui.AbsoluteSize;
		return Workspace.CurrentCamera?.ViewportSize ?? new Vector2(1280, 720);
	};
	const place = () => {
		const view = viewport();
		const width = math.min(WIDTH, view.X - 24);
		const top = math.min(TOP, math.max(8, view.Y * 0.08));
		const listHeight = math.max(ROW * 3, math.min(LIST_MAX, view.Y - top - (BUTTON_HEIGHT + 4) - 18 - 16 - 12 - 24));
		list.Size = new UDim2(1, 0, 0, listHeight);
		panel.Size = UDim2.fromOffset(width, 16 + BUTTON_HEIGHT + 4 + 6 + listHeight + 6 + 18);
		panel.Position = new UDim2(0.5, 0, 0, top);
	};
	trove.connect(gui.GetPropertyChangedSignal("AbsoluteSize"), () => shown && place());

	const idleStatus = () => {
		status.Text = TOUCH ? "" : KEYS_HINT;
		status.TextColor3 = COLORS.dim;
	};
	const report = (text: string, color: Color3) => {
		statusToken += 1;
		status.Text = text;
		status.TextColor3 = color;
	};

	const paintRow = (row: RowView<C>, index: number) => {
		const isSelected = index === selected;
		row.button.BackgroundTransparency = isSelected ? 0 : 1;
		if (isArmed(armed, row.command.id, os.clock())) {
			row.hint.Text = TOUCH ? "Tap to confirm" : "Enter to confirm";
			row.hint.TextColor3 = COLORS.good;
		} else {
			row.hint.Text = row.command.hint ?? "";
			row.hint.TextColor3 = COLORS.dim;
		}
	};
	const paintRows = () => rows.forEach((row, index) => paintRow(row, index));

	/** Keeps the selected row inside the list's visible area. */
	const scrollToSelected = () => {
		const row = rows[selected];
		if (!row) return;
		const top = row.button.AbsolutePosition.Y - list.AbsolutePosition.Y + list.CanvasPosition.Y;
		const bottom = top + row.button.AbsoluteSize.Y;
		const view = list.AbsoluteSize.Y;
		if (top < list.CanvasPosition.Y) list.CanvasPosition = new Vector2(0, math.max(0, top - GROUP_ROW));
		else if (bottom > list.CanvasPosition.Y + view) list.CanvasPosition = new Vector2(0, bottom - view);
	};

	let run: (index: number, split: boolean) => void = () => {};

	const render = () => {
		if (!shown) return;
		for (const child of list.GetChildren()) if (child.IsA("GuiObject")) child.Destroy();
		rows = [];
		const [ok, groups] = pcall(() => {
			const ctx = options.context();
			return searchCommands(registry.collect(ctx, box.Text), ctx, box.Text, options.recent());
		});
		if (!ok) {
			$warn(`[devtools] command palette failed: ${groups}`);
			report("The palette failed, see the output", COLORS.bad);
			return;
		}
		let order = 0;
		for (const group of groups) {
			const heading = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: order, ZIndex: 3 }), group.group.upper(), 12, COLORS.dim, Enum.Font.BuilderSansBold);
			heading.TextWrapped = false;
			heading.Size = new UDim2(1, 0, 0, GROUP_ROW);
			heading.TextYAlignment = Enum.TextYAlignment.Bottom;
			pad(heading, 0, 8);
			heading.Parent = list;
			order += 1;
			for (const command of group.items) {
				const index = rows.size();
				const button = make(
					"TextButton",
					{
						Name: command.id,
						Text: "",
						AutoButtonColor: false,
						BackgroundColor3: COLORS.button,
						BackgroundTransparency: 1,
						BorderSizePixel: 0,
						Size: new UDim2(1, 0, 0, ROW),
						LayoutOrder: order,
						ZIndex: 3,
					},
					list,
				);
				corner(button, 6);
				order += 1;
				const title = style(make("TextLabel", { BackgroundTransparency: 1, ZIndex: 4 }, button), command.title, 15, COLORS.text, Enum.Font.BuilderSansMedium);
				title.TextWrapped = false;
				title.TextTruncate = Enum.TextTruncate.AtEnd;
				title.Position = UDim2.fromOffset(10, 0);
				title.Size = new UDim2(0.68, -10, 1, 0);
				const hint = style(make("TextLabel", { BackgroundTransparency: 1, ZIndex: 4 }, button), "", 13, COLORS.dim, Enum.Font.Code);
				hint.TextWrapped = false;
				hint.TextTruncate = Enum.TextTruncate.AtEnd;
				hint.TextXAlignment = Enum.TextXAlignment.Right;
				hint.AnchorPoint = new Vector2(1, 0);
				hint.Position = new UDim2(1, -10, 0, 0);
				hint.Size = new UDim2(0.32, -10, 1, 0);
				const row: RowView<C> = { button, hint, command };
				rows.push(row);
				button.MouseEnter.Connect(() => {
					if (selected === index) return;
					selected = index;
					paintRows();
				});
				button.Activated.Connect(() => {
					const shift = UserInputService.IsKeyDown(Enum.KeyCode.LeftShift) || UserInputService.IsKeyDown(Enum.KeyCode.RightShift);
					run(index, shift);
				});
			}
		}
		if (rows.size() === 0) {
			const none = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 0, ZIndex: 3 }), "No matches", 14, COLORS.dim);
			none.Size = new UDim2(1, 0, 0, ROW);
			pad(none, 0, 10);
			none.Parent = list;
		}
		selected = math.clamp(selected, 0, math.max(0, rows.size() - 1));
		paintRows();
	};

	const close = () => {
		if (!shown) return;
		shown = false;
		armed.id = undefined;
		if (box.IsFocused()) box.ReleaseFocus();
		popOut(panel, () => {
			if (!shown) root.Visible = false;
		});
		backdrop.Visible = false;
	};

	run = (index, split) => {
		const row = rows[index];
		if (!row) return;
		const command = row.command;
		const ctx = options.context();
		if (!isAvailable(command, ctx)) {
			report("Not available now", COLORS.bad);
			render();
			return;
		}
		if (command.confirm !== undefined) {
			if (armStep(armed, command.id, os.clock()) === "arm") {
				const [ok, text] = pcall(() => command.confirm!(ctx));
				report(ok ? `${text}  ${TOUCH ? "Tap" : "Enter"} again to confirm` : "Confirm?", COLORS.warn);
				paintRows();
				const token = statusToken;
				trove.add(
					task.delay(ARM_SECONDS, () => {
						if (!shown) return;
						paintRows();
						if (token === statusToken) idleStatus();
					}),
				);
				return;
			}
		}
		armed.id = undefined;
		options.setRecent(pushRecent(options.recent(), command.id));
		if (command.keepOpen !== true) close();
		else paintRows();
		const [ok, err] = pcall(() => command.run(ctx, { split }));
		if (!ok) {
			$warn(`[devtools] command ${command.id} failed: ${err}`);
			report(`Failed: ${err}`, COLORS.bad);
		}
	};

	trove.connect(box.GetPropertyChangedSignal("Text"), () => {
		if (!shown) return;
		selected = 0;
		armed.id = undefined;
		list.CanvasPosition = Vector2.zero;
		render();
	});
	trove.connect(box.FocusLost, (enter, cause) => {
		if (!shown) return;
		if (enter) {
			const shift = UserInputService.IsKeyDown(Enum.KeyCode.LeftShift) || UserInputService.IsKeyDown(Enum.KeyCode.RightShift);
			run(selected, shift);
			// Still open (armed, or a command that reports here): keep typing.
			if (shown) task.defer(() => shown && box.CaptureFocus());
			return;
		}
		if (cause?.KeyCode === Enum.KeyCode.Escape) close();
	});
	// Up / Down while typing (the box holds focus, so these arrive as processed), Escape when it doesn't.
	trove.connect(UserInputService.InputBegan, (input) => {
		if (!shown) return;
		if (input.KeyCode === Enum.KeyCode.Escape) return close();
		const delta = input.KeyCode === Enum.KeyCode.Down ? 1 : input.KeyCode === Enum.KeyCode.Up ? -1 : 0;
		if (delta === 0 || rows.size() === 0) return;
		selected = moveSelection(selected, delta, rows.size());
		paintRows();
		scrollToSelected();
	});
	trove.connect(backdrop.Activated, close);

	return {
		open: (query) => {
			if (!shown) {
				shown = true;
				selected = 0;
				armed.id = undefined;
				root.Visible = true;
				backdrop.Visible = true;
				place();
				idleStatus();
				popIn(panel);
			}
			box.Text = query ?? "";
			list.CanvasPosition = Vector2.zero;
			render();
			box.CaptureFocus();
			// Focusing can select the text or move the caret a frame later: put it at the end.
			task.defer(() => {
				if (!shown) return;
				box.CaptureFocus();
				box.CursorPosition = box.Text.size() + 1;
			});
			options.opened?.();
		},
		close,
		isOpen: () => shown,
		refresh: () => {
			if (!shown) return;
			render();
		},
		report,
	};
}
