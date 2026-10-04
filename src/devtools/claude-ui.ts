import { TextService, UserInputService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import type { ClientKernel } from "../kernel";
import { popIn, popOut } from "../ui";
import type {
	ClaudeApproval,
	ClaudeConversation,
	ClaudeConversationSummary,
	ClaudeEvent,
	ClaudeEventsReply,
	ClaudeMessage,
	ClaudePromptRequest,
	ClaudeRequestView,
	ClaudeSessionView,
} from "./protocol";
import { chevron, COLORS, corner, escapeRich, hex, make, pad, SIDE_BUTTON, sideButton, style } from "./widgets";

/**
 * The dev menu's Claude tab, modeled on the Claude desktop chat (plans/11):
 *   - top: one status line ("Connected · d3a37b29 · dev"; tap it for recent chats), New chat, Unpair; the pairing box
 *     only while not paired;
 *   - middle: the messages (own ScrollingFrame: AutomaticCanvasSize + a padded inner Frame with a UIListLayout). User
 *     prompts are right-aligned bubbles; Claude's replies are full-width Markdown (one wrapped TextLabel per block,
 *     the last block updated in place while it streams); tool calls are one dim line each (tap for details); errors
 *     one red line; three animated dots while a run is active. It sticks to the bottom unless the dev scrolls up, and
 *     a round button scrolls back down;
 *   - bottom: the composer, always visible: a growing message box (1 to 5 lines, then it scrolls), a "+" menu with the
 *     Dex path / Errors context toggles (shown as chips when on) and a round Send button that becomes Stop while a
 *     run is active.
 * Follow-ups continue the open conversation (the dev machine resumes the same Claude Code session); the open
 * conversation survives swaps through the kernel persist store. Debug lines (model, turns, cost, session ids) never
 * show. Everything lives in the tab's trove; the tab's own content ScrollingFrame is hidden while it is open.
 */

const PERSIST_KEY = "typetorch/claude-chat";
const POLL_ACTIVE = 1;
const POLL_IDLE = 2;
const SESSION_REFRESH = 10;
const FONT = Enum.Font.Code;
const TEXT_SIZE = 15;
const SMALL = 14;
const LINE = 18;
const MAX_LINES = 5;
const ROUND = 32;
const MAX_PROMPT = 4000;
/** User bubbles take at most this share of the panel width. */
const BUBBLE_SHARE = 0.8;

const BUBBLE_BG = COLORS.header;
const CODE_BG = Color3.fromRGB(13, 14, 18);
const CODE_TEXT = Color3.fromRGB(205, 210, 222);
const DIMMER = Color3.fromRGB(118, 124, 138);

/** Short text for the error codes of devtools/claude.ts and the dev machine. */
const ERRORS: Record<string, string> = {
	not_connected: "Not connected: start the dev server on this branch",
	needs_pairing: "Pair first",
	bad_code: "Wrong or expired code",
	not_allowed: "Not on the session's user list",
	prod_channel: "Claude works on dev-channel servers only",
	busy: "Wait for the running prompt",
	rate_limited: "Too many tries, wait a bit",
	empty: "Write a message first",
	too_long: "Message too long",
	context_too_large: "Attached context too large",
	unreachable: "Can't reach the dev machine",
	unauthorized: "Rejected by the dev machine",
	forbidden: "Rejected by the dev machine",
	remote_rate_limited: "Dev machine busy, try again",
	not_yours: "Only the requester can stop it",
	not_found: "Not found on the dev machine",
	conversation_gone: "That chat is gone (the dev machine restarted)",
	api_billing_refused: "Refused: Claude Code must use a subscription login",
	cancelled: "Stopped",
	"claude timed out": "Claude timed out",
};

function errorText(code: unknown): string {
	if (typeIs(code, "string")) return ERRORS[code] ?? code;
	return "Failed";
}

function trim(text: string): string {
	return (text.match("^%s*(.-)%s*$")[0] as string | undefined) ?? "";
}

/** What survives swaps (kernel persist store). */
interface ChatState {
	conversationId?: string;
	draft: string;
	attachPath: boolean;
	attachErrors: boolean;
}

/** The parts of the dev menu's TabContext this tab uses (client.ts passes its own). */
export interface ClaudeChatTab {
	readonly trove: Trove;
	/** The tab's scrolling content: hidden while this tab is open; the chat goes next to it in the window body. */
	readonly content: ScrollingFrame;
}

export interface ClaudeChatDeps {
	kernel: ClientKernel;
	/** Sends one dev op and yields for the answer (client.ts `call`). */
	call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
	/** The explorer's selection as "<realm> <path>", if any (the "Dex path" context). */
	dexSelection: () => string | undefined;
	/** Shows text pre-selected for copying (widgets.ts copyText). Without it, replies have no Copy button. */
	copyText?: (text: string, anchor?: GuiObject) => void;
}

// Markdown → RichText -------------------------------------------------------------------------------------------------

type Block =
	| { kind: "p"; text: string }
	| { kind: "h"; text: string; level: number }
	| { kind: "li"; text: string; marker: string; indent: number }
	| { kind: "code"; text: string }
	| { kind: "rule" };

/** Splits Markdown into blocks: paragraphs, headings, list items, fenced code, rules. */
export function parseMarkdown(text: string): Block[] {
	const blocks = new Array<Block>();
	let paragraph = new Array<string>();
	let code: string[] | undefined;
	const flush = () => {
		if (paragraph.size() > 0) blocks.push({ kind: "p", text: paragraph.join("\n") });
		paragraph = [];
	};
	for (const raw of text.split("\n")) {
		const line = raw.gsub("\r$", "")[0];
		const fence = line.match("^%s*```")[0] !== undefined;
		if (code !== undefined) {
			if (fence) {
				blocks.push({ kind: "code", text: code.join("\n") });
				code = undefined;
			} else code.push(line);
			continue;
		}
		if (fence) {
			flush();
			code = [];
			continue;
		}
		if (line.match("^%s*$")[0] !== undefined) {
			flush();
			continue;
		}
		if (line.match("^%s*[%-%*_][%-%*_][%-%*_]+%s*$")[0] !== undefined) {
			flush();
			blocks.push({ kind: "rule" });
			continue;
		}
		const [hashes, heading] = line.match("^(#+)%s+(.+)$") as LuaTuple<[string?, string?]>;
		if (hashes !== undefined && heading !== undefined) {
			flush();
			blocks.push({ kind: "h", text: heading, level: hashes.size() });
			continue;
		}
		const [indent, bulletText] = line.match("^(%s*)[%-%*%+]%s+(.*)$") as LuaTuple<[string?, string?]>;
		if (indent !== undefined && bulletText !== undefined) {
			flush();
			blocks.push({ kind: "li", text: bulletText, marker: "•", indent: math.min(math.floor(indent.size() / 2), 4) });
			continue;
		}
		const [numberIndent, digits, item] = line.match("^(%s*)(%d+)[%.%)]%s+(.*)$") as LuaTuple<[string?, string?, string?]>;
		if (numberIndent !== undefined && digits !== undefined && item !== undefined) {
			flush();
			blocks.push({ kind: "li", text: item, marker: `${digits}.`, indent: math.min(math.floor(numberIndent.size() / 2), 4) });
			continue;
		}
		paragraph.push(line);
	}
	flush();
	// Still streaming: an open fence shows as a code block already.
	if (code !== undefined) blocks.push({ kind: "code", text: code.join("\n") });
	return blocks;
}

/** Inline Markdown → RichText: escapes &, < and > first, then `code`, links, **bold** and *italic*. */
export function inline(text: string): string {
	const parts = text.split("`");
	let out = "";
	parts.forEach((part, index) => {
		const safe = escapeRich(part);
		const isCode = index % 2 === 1 && index < parts.size() - 1;
		if (isCode) {
			out += `<font color="${hex(COLORS.info)}"><mark color="${hex(CODE_BG)}" transparency="0.2">${safe}</mark></font>`;
			return;
		}
		if (index % 2 === 1) out += "`";
		let formatted = safe.gsub("(https?://[^%s<%)]+)", `<font color="${hex(COLORS.info)}">%1</font>`)[0];
		formatted = formatted.gsub("%[([^%]]-)%]%(([^%)]-)%)", `<font color="${hex(COLORS.info)}"><u>%1</u></font>`)[0];
		formatted = formatted.gsub("%*%*(.-)%*%*", "<b>%1</b>")[0];
		formatted = formatted.gsub("%*([^%*%s][^%*]-)%*", "<i>%1</i>")[0];
		out += formatted;
	});
	return out;
}

function label(text: string, color: Color3, size = TEXT_SIZE, rich = true): TextLabel {
	const result = style(make("TextLabel", { BackgroundTransparency: 1, RichText: rich }), text, size, color, FONT);
	result.Size = UDim2.fromScale(1, 0);
	result.AutomaticSize = Enum.AutomaticSize.Y;
	result.TextWrapped = true;
	return result;
}

function roundButton(parent: Instance, color: Color3): TextButton {
	const button = make(
		"TextButton",
		{ AutoButtonColor: true, Text: "", BackgroundColor3: color, BorderSizePixel: 0, Size: UDim2.fromOffset(ROUND, ROUND) },
		parent,
	);
	corner(button, ROUND / 2);
	return button;
}

/** A block's rendered GUI: a key (kind + marker) so it can be updated in place while it streams. */
interface Rendered {
	key: string;
	gui: GuiObject;
	text: TextLabel | TextBox;
	marker?: TextLabel;
}

function blockKey(block: Block): string {
	if (block.kind === "li") return `li:${block.indent}`;
	if (block.kind === "h") return `h:${math.min(block.level, 3)}`;
	return block.kind;
}

function createBlock(block: Block): Rendered {
	if (block.kind === "code") {
		const box = make("Frame", { BackgroundColor3: CODE_BG, BorderSizePixel: 0, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y });
		corner(box, 8);
		pad(box, 8, 10);
		// Plain read-only TextBox: code can be selected and copied (rich text would show its tags when focused).
		const text = style(make("TextBox", { BackgroundTransparency: 1, ClearTextOnFocus: false, TextEditable: false, MultiLine: true }, box), "", SMALL, CODE_TEXT, FONT);
		text.TextWrapped = true;
		text.TextYAlignment = Enum.TextYAlignment.Top;
		text.Size = UDim2.fromScale(1, 0);
		text.AutomaticSize = Enum.AutomaticSize.Y;
		return { key: blockKey(block), gui: box, text };
	}
	if (block.kind === "rule") {
		const line = make("Frame", { BackgroundColor3: COLORS.stroke, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, 1) });
		return { key: "rule", gui: line, text: label("", COLORS.text) };
	}
	if (block.kind === "li") {
		// A marker column and a hanging indent: wrapped lines line up under the text, not under the marker.
		const left = block.indent * 16;
		const row = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y });
		const marker = style(make("TextLabel", { BackgroundTransparency: 1 }, row), "", TEXT_SIZE, COLORS.dim, FONT);
		marker.TextWrapped = false;
		marker.TextXAlignment = Enum.TextXAlignment.Right;
		marker.Position = UDim2.fromOffset(left, 0);
		marker.Size = UDim2.fromOffset(22, LINE);
		const text = label("", COLORS.text);
		text.Position = UDim2.fromOffset(left + 28, 0);
		text.Size = new UDim2(1, -(left + 28), 0, 0);
		text.Parent = row;
		return { key: blockKey(block), gui: row, text, marker };
	}
	const text = label("", COLORS.text);
	return { key: blockKey(block), gui: text, text };
}

function blockText(block: Block): string {
	if (block.kind === "h") return `<font size="${block.level <= 1 ? 19 : block.level === 2 ? 17 : 16}"><b>${inline(block.text)}</b></font>`;
	if (block.kind === "code") return block.text;
	if (block.kind === "rule") return "";
	return inline(block.text);
}

/** Brings `rendered` (the GUI of a text segment) in line with `blocks`, reusing every block whose kind is unchanged. */
function syncBlocks(holder: Frame, rendered: Rendered[], blocks: Block[]) {
	for (let index = 0; index < blocks.size(); index++) {
		const block = blocks[index];
		let current: Rendered | undefined = rendered[index];
		if (current && current.key !== blockKey(block)) {
			for (let rest = rendered.size() - 1; rest >= index; rest--) rendered[rest].gui.Destroy();
			for (let rest = rendered.size() - 1; rest >= index; rest--) rendered.remove(rest);
			current = undefined;
		}
		if (!current) {
			current = createBlock(block);
			current.gui.LayoutOrder = index;
			current.gui.Parent = holder;
			rendered.push(current);
		}
		const text = blockText(block);
		if (current.text.Text !== text) current.text.Text = text;
		if (current.marker && block.kind === "li" && current.marker.Text !== block.marker) current.marker.Text = block.marker;
	}
	for (let rest = rendered.size() - 1; rest >= blocks.size(); rest--) {
		rendered[rest].gui.Destroy();
		rendered.remove(rest);
	}
}

/** The short tool name: "run_luau" from "mcp__typetorch-game__run_luau" (older dev servers send the full name). */
function shortTool(tool: string | undefined): string {
	if (tool === undefined) return "";
	const [rest] = tool.match("^mcp__.-__(.+)$");
	return rest !== undefined ? (rest as string) : tool;
}

/** "Read src/foo.ts", "Edited ...", "Ran bun run build", "Ran luau on server", "Checked server status". */
function toolLine(event: ClaudeEvent): string {
	const target = event.target ?? "";
	const tool = shortTool(event.tool);
	if (tool === "Read") return `Read ${target}`;
	if (tool === "Edit") return `Edited ${target}`;
	if (tool === "Write") return `Wrote ${target}`;
	if (tool === "Glob" || tool === "Grep") return `Searched ${target}`;
	if (tool === "Bash") return `Ran ${target}`;
	if (tool === "run_luau") return "Ran luau on server";
	if (tool === "game_logs") return target === "client" ? "Read client logs" : "Read server logs";
	if (tool === "inspect") return `Inspected ${target}`;
	if (tool === "find") return "Searched the game";
	if (tool === "game_status") return "Checked server status";
	if (tool === "screenshot") return "Screenshot";
	return tool !== "" ? tool : event.text;
}

/** A glyph drawn from Frames for the "+" menu (no emojis or font glyphs). */
function menuIcon(parent: Instance, kind: string, color: Color3) {
	const box = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 0.5), Position: new UDim2(0, 10, 0.5, 0), Size: UDim2.fromOffset(16, 16) }, parent);
	const bar = (x: number, y: number, w: number, h: number) =>
		make("Frame", { BackgroundColor3: color, BorderSizePixel: 0, Position: UDim2.fromOffset(x, y), Size: UDim2.fromOffset(w, h) }, box);
	if (kind === "dex") {
		// A small tree: a root bar and two indented children.
		bar(0, 1, 10, 3);
		bar(5, 7, 10, 3);
		bar(5, 13, 10, 3);
		bar(2, 4, 2, 11);
	} else if (kind === "errors") {
		const ring = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromOffset(16, 16) }, box);
		corner(ring, 8);
		make("UIStroke", { Color: color, Thickness: 2, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, ring);
		bar(7, 3, 2, 6);
		bar(7, 11, 2, 2);
	} else {
		// A camera: a body and a lens.
		const body = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(0, 3), Size: UDim2.fromOffset(16, 11) }, box);
		corner(body, 3);
		make("UIStroke", { Color: color, Thickness: 2, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, body);
		const lens = make("Frame", { BackgroundColor3: color, BorderSizePixel: 0, Position: UDim2.fromOffset(5, 6), Size: UDim2.fromOffset(6, 6) }, box);
		corner(lens, 3);
	}
	return box;
}

// Messages ------------------------------------------------------------------------------------------------------------

interface ToolSegment {
	kind: "tool";
	event: ClaudeEvent;
	result?: string;
	/** Game tools: the full result text. */
	resultDetail?: string;
	failed: boolean;
	dot: Frame;
}

type Segment = { kind: "text"; block?: number; text: string; holder: Frame; rendered: Rendered[]; dirty: boolean } | ToolSegment | { kind: "note"; line: TextLabel };

interface Message {
	id: string;
	prompt: string;
	state: string;
	finished: boolean;
	/** Next event index to ask the dev machine for. */
	cursor: number;
	/** Events applied so far (dedupe by index). */
	seen: Set<number>;
	commit?: string;
	artifactId?: string;
	error?: string;
	frame: Frame;
	bubble: Frame;
	reply: Frame;
	segments: Segment[];
	outcome: TextLabel;
	dots: Frame;
}

// The tab -------------------------------------------------------------------------------------------------------------

export function renderClaudeChat(tab: ClaudeChatTab, deps: ClaudeChatDeps) {
	const { kernel, call } = deps;
	const trove = tab.trove;
	const state = kernel.persist<ChatState>(PERSIST_KEY, () => ({ draft: "", attachPath: false, attachErrors: false }));

	// The chat takes the content's place in the window body (like the explorer).
	const content = tab.content;
	const host = trove.add(
		make("Frame", { Name: "ClaudeChat", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), LayoutOrder: 3, ClipsDescendants: true }),
	);
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, host);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, FillDirection: Enum.FillDirection.Vertical }, host);
	host.Parent = content.Parent;
	content.Visible = false;
	trove.add(() => {
		content.Visible = true;
	});

	if (kernel.channel !== "dev") {
		const note = label(errorText("prod_channel"), COLORS.dim, SMALL, false);
		pad(note, 12, 12);
		note.Parent = host;
		return;
	}

	/** Runs `work` in its own thread (dev ops yield), inside the tab's trove. */
	let notify: (text: string, color?: Color3) => void = () => {};
	const spawn = (work: () => void) =>
		trove.add(
			task.spawn(() => {
				const [ok, err] = pcall(work);
				if (!ok) notify(`Failed: ${err}`, COLORS.bad);
			}),
		);

	// Top: status line (tap: recent chats), New chat, Unpair; pairing while not paired --------------------------------
	const top = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 1 }, host);
	pad(top, 6, 10);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) }, top);
	const statusRow = make(
		"Frame",
		{ BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, ROUND), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 1 },
		top,
	);
	make(
		"UIListLayout",
		{
			FillDirection: Enum.FillDirection.Horizontal,
			SortOrder: Enum.SortOrder.LayoutOrder,
			VerticalAlignment: Enum.VerticalAlignment.Center,
			Padding: new UDim(0, 6),
			Wraps: true,
		},
		statusRow,
	);
	const statusButton = make(
		"TextButton",
		{ AutoButtonColor: false, Text: "", BackgroundTransparency: 1, Size: UDim2.fromOffset(150, ROUND), LayoutOrder: 1 },
		statusRow,
	);
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, statusButton);
	const smallButton = (text: string, order: number) => {
		const button = style(make("TextButton", { AutoButtonColor: true, LayoutOrder: order }), text, SMALL, COLORS.text, Enum.Font.BuilderSansMedium);
		button.TextXAlignment = Enum.TextXAlignment.Center;
		button.TextWrapped = false;
		button.BackgroundColor3 = COLORS.button;
		button.Size = UDim2.fromOffset(0, ROUND);
		button.AutomaticSize = Enum.AutomaticSize.X;
		corner(button, 8);
		pad(button, 0, 10);
		button.Parent = statusRow;
		return button;
	};
	const newButton = smallButton("New chat", 2);
	const unpairButton = smallButton("Unpair", 3);
	const status = style(make("TextLabel", { BackgroundTransparency: 1 }, statusButton), "Checking...", SMALL, COLORS.dim, FONT);
	status.TextWrapped = false;
	status.TextTruncate = Enum.TextTruncate.AtEnd;
	status.Size = new UDim2(1, -18, 1, 0);
	const statusChevron = make(
		"Frame",
		{ BackgroundTransparency: 1, AnchorPoint: new Vector2(1, 0.5), Position: new UDim2(1, 0, 0.5, 0), Size: UDim2.fromOffset(14, 14) },
		statusButton,
	);
	chevron(statusChevron, "down", COLORS.dim, 2);

	const chats = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 2, Visible: false }, top);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 4) }, chats);

	const pairing = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 3, Visible: false }, top);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 4) }, pairing);
	const codeRow = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, 34), LayoutOrder: 1 }, pairing);
	// A TextBox can't mask, so its real text is invisible (TextTransparency 1) under a label with one dot per character.
	const codeBox = style(make("TextBox", { ClearTextOnFocus: false }, codeRow), "", TEXT_SIZE, COLORS.text, FONT);
	codeBox.TextTransparency = 1;
	codeBox.PlaceholderText = "";
	codeBox.TextWrapped = false;
	codeBox.ClipsDescendants = true;
	codeBox.BackgroundColor3 = COLORS.row;
	codeBox.Size = new UDim2(1, -(SIDE_BUTTON + 8), 1, 0);
	corner(codeBox, 8);
	pad(codeBox, 0, 10);
	const mask = style(make("TextLabel", { BackgroundTransparency: 1, Interactable: false }, codeBox), "", TEXT_SIZE, COLORS.dim, FONT);
	mask.Size = UDim2.fromScale(1, 1);
	mask.TextWrapped = false;
	mask.TextTruncate = Enum.TextTruncate.AtEnd;
	const paintMask = () => {
		const length = math.min(codeBox.Text.size(), 64);
		mask.Text = length > 0 ? string.rep("•", length) : "Pairing code";
		mask.TextColor3 = length > 0 ? COLORS.text : COLORS.dim;
	};
	paintMask();
	trove.connect(codeBox.GetPropertyChangedSignal("Text"), paintMask);
	const pairButton = sideButton(codeRow, "Pair", COLORS.accent, COLORS.dark);
	const pairHint = label("Paste the code from the dev server", COLORS.dim, SMALL, false);
	pairHint.LayoutOrder = 2;
	pairHint.Parent = pairing;

	// Middle: messages ----------------------------------------------------------------------------------------------
	const middle = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), LayoutOrder: 2 }, host);
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, middle);
	const scroller = make(
		"ScrollingFrame",
		{
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			Size: UDim2.fromScale(1, 1),
			CanvasSize: new UDim2(),
			AutomaticCanvasSize: Enum.AutomaticSize.Y,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			ScrollBarThickness: 5,
			ScrollBarImageColor3: COLORS.dim,
			VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
		},
		middle,
	);
	// Padding lives on a plain inner Frame (a UIPadding on a ScrollingFrame doesn't inset scale-width children).
	const list = make("Frame", { Name: "Messages", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y }, scroller);
	make("UIPadding", { PaddingTop: new UDim(0, 8), PaddingBottom: new UDim(0, 12), PaddingLeft: new UDim(0, 12), PaddingRight: new UDim(0, 14) }, list);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 14) }, list);
	const emptyHint = label("Ask Claude about this game", DIMMER, SMALL, false);
	emptyHint.TextXAlignment = Enum.TextXAlignment.Center;
	emptyHint.LayoutOrder = -1;
	emptyHint.Parent = list;

	const downButton = roundButton(middle, COLORS.button);
	downButton.AnchorPoint = new Vector2(0.5, 1);
	downButton.Position = new UDim2(0.5, 0, 1, -8);
	downButton.ZIndex = 5;
	downButton.Visible = false;
	make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, downButton);
	const downIcon = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(18, 18), ZIndex: 5 }, downButton);
	chevron(downIcon, "down", COLORS.text, 2);

	// Stick to the bottom while output streams, unless the dev scrolled up; the round button scrolls back down.
	let follow = true;
	const bottom = () => math.max(0, scroller.AbsoluteCanvasSize.Y - scroller.AbsoluteWindowSize.Y);
	const atBottom = () => scroller.CanvasPosition.Y >= bottom() - 24;
	let downShown = false;
	const setDownVisible = (visible: boolean) => {
		if (visible === downShown) return;
		downShown = visible;
		if (visible) popIn(downButton);
		else popOut(downButton);
	};
	const scrollToEnd = () => {
		follow = true;
		scroller.CanvasPosition = new Vector2(0, bottom());
	};
	trove.connect(scroller.GetPropertyChangedSignal("CanvasPosition"), () => {
		follow = atBottom();
		setDownVisible(!follow);
	});
	trove.connect(scroller.GetPropertyChangedSignal("AbsoluteCanvasSize"), () => {
		if (follow) scrollToEnd();
		else setDownVisible(true);
	});
	trove.connect(downButton.Activated, scrollToEnd);

	// Bottom: the composer -------------------------------------------------------------------------------------------
	const composerArea = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 3 }, host);
	make("UIPadding", { PaddingTop: new UDim(0, 4), PaddingBottom: new UDim(0, 8), PaddingLeft: new UDim(0, 10), PaddingRight: new UDim(0, 10) }, composerArea);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 4) }, composerArea);
	const notice = label("", COLORS.dim, SMALL, false);
	notice.LayoutOrder = 1;
	notice.Visible = false;
	notice.Parent = composerArea;
	notify = (text, color = COLORS.dim) => {
		notice.Text = text;
		notice.TextColor3 = color;
		notice.Visible = text !== "";
	};

	const composer = make(
		"Frame",
		{ BackgroundColor3: COLORS.row, BorderSizePixel: 0, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 2 },
		composerArea,
	);
	corner(composer, 14);
	make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, composer);
	pad(composer, 8, 10);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) }, composer);

	// Active context toggles: small removable chips above the message box.
	const chips = make(
		"Frame",
		{ BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 1, Visible: false },
		composer,
	);
	make(
		"UIListLayout",
		{ FillDirection: Enum.FillDirection.Horizontal, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 4), Wraps: true },
		chips,
	);

	// The message box grows from 1 to 5 lines, then scrolls (its height follows TextBounds; the canvas is automatic).
	const inputScroll = make(
		"ScrollingFrame",
		{
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			Size: new UDim2(1, 0, 0, LINE + 4),
			CanvasSize: new UDim2(),
			AutomaticCanvasSize: Enum.AutomaticSize.Y,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			ScrollBarThickness: 3,
			ScrollBarImageColor3: COLORS.dim,
			VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
			LayoutOrder: 2,
		},
		composer,
	);
	const box = style(make("TextBox", { ClearTextOnFocus: false, MultiLine: true }, inputScroll), state.draft, TEXT_SIZE, COLORS.text, FONT);
	box.PlaceholderText = "Ask Claude";
	box.PlaceholderColor3 = DIMMER;
	box.BackgroundTransparency = 1;
	box.TextWrapped = true;
	box.TextYAlignment = Enum.TextYAlignment.Top;
	box.Size = new UDim2(1, 0, 0, LINE + 4);
	box.AutomaticSize = Enum.AutomaticSize.Y;
	const fitBox = () => {
		const lines = math.max(1, math.ceil((box.TextBounds.Y - 1) / LINE));
		inputScroll.Size = new UDim2(1, 0, 0, math.min(lines, MAX_LINES) * LINE + 4);
		// Typing at the end keeps the caret in view.
		if (box.CursorPosition === -1 || box.CursorPosition >= box.Text.size()) {
			inputScroll.CanvasPosition = new Vector2(0, math.max(0, inputScroll.AbsoluteCanvasSize.Y - inputScroll.AbsoluteWindowSize.Y));
		}
	};
	trove.connect(box.GetPropertyChangedSignal("TextBounds"), fitBox);
	trove.connect(box.GetPropertyChangedSignal("Text"), () => (state.draft = box.Text));
	fitBox();

	const actions = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, ROUND), LayoutOrder: 3 }, composer);
	const plusButton = roundButton(actions, COLORS.button);
	for (const [w, h] of [
		[12, 2],
		[2, 12],
	]) {
		make(
			"Frame",
			{ BackgroundColor3: COLORS.text, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(w, h) },
			plusButton,
		);
	}
	const sendButton = roundButton(actions, COLORS.accent);
	sendButton.AnchorPoint = new Vector2(1, 0);
	sendButton.Position = UDim2.fromScale(1, 0);
	const sendIcon = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: new UDim2(0.5, 0, 0.5, -1), Size: UDim2.fromOffset(18, 18) }, sendButton);
	chevron(sendIcon, "up", COLORS.dark, 3);
	const stopIcon = make(
		"Frame",
		{ BackgroundColor3: COLORS.dark, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(11, 11), Visible: false },
		sendButton,
	);
	corner(stopIcon, 2);

	// "+" menu: a floating panel above the "+" button (like the desktop app's): toggles with a checkmark when on, items
	// for later dimmed. It closes on an outside click or Escape.
	interface MenuItem {
		name: string;
		icon: string;
		get?: () => boolean;
		set?: (on: boolean) => void;
		disabled?: boolean;
	}
	const items: MenuItem[] = [
		{ name: "Dex path", icon: "dex", get: () => state.attachPath, set: (on) => (state.attachPath = on) },
		{ name: "Errors", icon: "errors", get: () => state.attachErrors, set: (on) => (state.attachErrors = on) },
		{ name: "Screenshot", icon: "camera", disabled: true },
	];
	const MENU_WIDTH = 210;
	const MENU_ROW = 36;
	const menu = make(
		"Frame",
		{
			Name: "PlusMenu",
			BackgroundColor3: COLORS.header,
			BorderSizePixel: 0,
			AnchorPoint: new Vector2(0, 1),
			Size: UDim2.fromOffset(MENU_WIDTH, 0),
			AutomaticSize: Enum.AutomaticSize.Y,
			Visible: false,
			ZIndex: 20,
		},
		host,
	);
	corner(menu, 12);
	make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, menu);
	pad(menu, 6, 6);
	make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 2) }, menu);
	// Soft shadow: a darker, larger rounded frame behind the panel.
	const shadow = make(
		"Frame",
		{ BackgroundColor3: Color3.fromRGB(0, 0, 0), BackgroundTransparency: 0.6, BorderSizePixel: 0, AnchorPoint: new Vector2(0, 1), Visible: false, ZIndex: 19 },
		host,
	);
	corner(shadow, 14);
	const checks = new Map<MenuItem, Frame>();
	items.forEach((item, index) => {
		const row = make(
			"TextButton",
			{ AutoButtonColor: false, Text: "", BackgroundColor3: COLORS.button, BackgroundTransparency: 1, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, MENU_ROW), LayoutOrder: index, ZIndex: 21 },
			menu,
		);
		corner(row, 8);
		const color = item.disabled ? DIMMER : COLORS.text;
		const icon = menuIcon(row, item.icon, color);
		const text = style(make("TextLabel", { BackgroundTransparency: 1, ZIndex: 22 }, row), item.name, SMALL, color, FONT);
		text.TextWrapped = false;
		text.Position = UDim2.fromOffset(36, 0);
		text.Size = new UDim2(1, -64, 1, 0);
		// A checkmark on the right while a toggle is on (two Frames).
		const check = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(1, 0.5), Position: new UDim2(1, -10, 0.5, 0), Size: UDim2.fromOffset(14, 14), Visible: false, ZIndex: 22 }, row);
		make("Frame", { BackgroundColor3: COLORS.accent, BorderSizePixel: 0, Position: UDim2.fromOffset(0, 7), Size: UDim2.fromOffset(6, 2), Rotation: 45, ZIndex: 22 }, check);
		make("Frame", { BackgroundColor3: COLORS.accent, BorderSizePixel: 0, Position: UDim2.fromOffset(3, 5), Size: UDim2.fromOffset(11, 2), Rotation: -50, ZIndex: 22 }, check);
		checks.set(item, check);
		for (const part of [...icon.GetDescendants(), icon]) if (part.IsA("GuiObject")) part.ZIndex = 22;
		if (item.disabled) return;
		trove.connect(row.MouseEnter, () => (row.BackgroundTransparency = 0));
		trove.connect(row.MouseLeave, () => (row.BackgroundTransparency = 1));
		trove.connect(row.Activated, () => {
			if (item.get && item.set) item.set(!item.get());
			paintToggles();
		});
	});
	const closeMenu = () => {
		if (!menu.Visible) return;
		shadow.Visible = false;
		popOut(menu);
	};
	const openMenu = () => {
		// Above the "+" button, in host coordinates.
		const at = plusButton.AbsolutePosition.sub(host.AbsolutePosition);
		const x = math.clamp(at.X, 4, math.max(4, host.AbsoluteSize.X - MENU_WIDTH - 4));
		menu.Position = UDim2.fromOffset(x, at.Y - 6);
		shadow.Position = UDim2.fromOffset(x + 2, at.Y - 2);
		popIn(menu);
		task.defer(() => {
			shadow.Size = UDim2.fromOffset(menu.AbsoluteSize.X, menu.AbsoluteSize.Y);
			shadow.Visible = menu.Visible;
		});
	};
	trove.connect(plusButton.Activated, () => (menu.Visible ? closeMenu() : openMenu()));
	const inside = (gui: GuiObject, point: Vector2) => {
		const corner0 = gui.AbsolutePosition;
		const size = gui.AbsoluteSize;
		return point.X >= corner0.X && point.X <= corner0.X + size.X && point.Y >= corner0.Y && point.Y <= corner0.Y + size.Y;
	};
	trove.connect(UserInputService.InputBegan, (input) => {
		if (!menu.Visible) return;
		if (input.KeyCode === Enum.KeyCode.Escape) return closeMenu();
		const pointer = input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
		if (!pointer) return;
		const point = new Vector2(input.Position.X, input.Position.Y);
		// AbsolutePosition ignores the GUI inset; input positions include it when the ScreenGui ignores it, which the dev menu does.
		if (!inside(menu, point) && !inside(plusButton, point)) closeMenu();
	});

	let paintToggles: () => void = () => {};
	paintToggles = () => {
		for (const child of chips.GetChildren()) if (child.IsA("GuiObject")) child.Destroy();
		let count = 0;
		items.forEach((item, index) => {
			const on = item.get?.() === true;
			const check = checks.get(item);
			if (check) check.Visible = on;
			if (!on) return;
			count += 1;
			const chip = make("Frame", { BackgroundColor3: COLORS.button, BorderSizePixel: 0, Size: UDim2.fromOffset(0, 24), AutomaticSize: Enum.AutomaticSize.X, LayoutOrder: index }, chips);
			corner(chip, 12);
			make("UIPadding", { PaddingLeft: new UDim(0, 10), PaddingRight: new UDim(0, 4) }, chip);
			make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, VerticalAlignment: Enum.VerticalAlignment.Center, Padding: new UDim(0, 4) }, chip);
			const text = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 1 }, chip), item.name, SMALL, COLORS.text, FONT);
			text.TextWrapped = false;
			text.Size = UDim2.fromOffset(0, 24);
			text.AutomaticSize = Enum.AutomaticSize.X;
			// Remove: a small "x" drawn from two Frames.
			const remove = make("TextButton", { AutoButtonColor: true, Text: "", BackgroundTransparency: 1, Size: UDim2.fromOffset(20, 20), LayoutOrder: 2 }, chip);
			for (const angle of [45, -45]) {
				make("Frame", { BackgroundColor3: COLORS.dim, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(10, 2), Rotation: angle }, remove);
			}
			trove.connect(remove.Activated, () => {
				item.set?.(false);
				paintToggles();
			});
		});
		chips.Visible = count > 0;
	};
	paintToggles();

	// Messages --------------------------------------------------------------------------------------------------------
	let messages = new Array<Message>();
	let active: Message | undefined;
	/** Bumped whenever the transcript is replaced, so replies for an older view are dropped. */
	let view = 0;
	let paired = false;
	let sending = false;
	let order = 0;
	let refreshSession: () => void = () => {};

	const running = () => active !== undefined && !active.finished;
	const paintComposer = () => {
		const busy = running();
		sendIcon.Visible = !busy;
		stopIcon.Visible = busy;
		sendButton.BackgroundColor3 = busy ? COLORS.text : COLORS.accent;
	};
	const paintEmpty = () => {
		emptyHint.Visible = messages.size() === 0;
	};

	// User bubbles: right-aligned, as wide as their text up to 80% of the panel (TextService measures the text).
	const bubbles = new Array<{ frame: Frame; text: string }>();
	const fitBubble = (bubble: { frame: Frame; text: string }) => {
		const max = math.max(80, math.floor((list.AbsoluteSize.X - 26) * BUBBLE_SHARE));
		const size = TextService.GetTextSize(bubble.text, TEXT_SIZE, FONT, new Vector2(max - 24, 100_000));
		bubble.frame.Size = UDim2.fromOffset(math.min(max, math.ceil(size.X) + 26), 0);
	};
	trove.connect(list.GetPropertyChangedSignal("AbsoluteSize"), () => {
		for (const bubble of bubbles) fitBubble(bubble);
	});

	const copyButtons = new Map<string, TextButton>();
	const approvalCards = new Map<string, Frame>();
	const buildMessage = (id: string, prompt: string): Message => {
		order += 1;
		const frame = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: order }, list);
		make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 8) }, frame);
		const userRow = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 1 }, frame);
		make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, HorizontalAlignment: Enum.HorizontalAlignment.Right }, userRow);
		const bubble = make("Frame", { BackgroundColor3: BUBBLE_BG, BorderSizePixel: 0, AutomaticSize: Enum.AutomaticSize.Y }, userRow);
		corner(bubble, 14);
		pad(bubble, 8, 12);
		const text = label(escapeRich(prompt), COLORS.text, TEXT_SIZE, true);
		text.Parent = bubble;
		const fit = { frame: bubble, text: prompt };
		bubbles.push(fit);
		fitBubble(fit);
		const reply = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 2 }, frame);
		make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 8) }, reply);
		if (deps.copyText) {
			// Copy: the whole reply as plain Markdown, pre-selected (rich text can't be selected with its formatting).
			const copy = make("TextButton", { AutoButtonColor: true, Text: "", BackgroundTransparency: 1, Size: UDim2.fromOffset(28, 24), LayoutOrder: 100_002, Visible: false }, reply);
			for (const [x, y] of [
				[4, 2],
				[9, 7],
			]) {
				const sheet = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(x, y), Size: UDim2.fromOffset(12, 14) }, copy);
				corner(sheet, 2);
				make("UIStroke", { Color: DIMMER, Thickness: 1.5, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, sheet);
			}
			copyButtons.set(id, copy);
		}
		const outcome = label("", DIMMER, SMALL, false);
		outcome.LayoutOrder = 100_000;
		outcome.Visible = false;
		outcome.Parent = reply;
		// Working indicator: three dots, no text.
		const dots = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromOffset(44, 14), LayoutOrder: 100_001, Visible: false }, reply);
		for (let index = 0; index < 3; index++) {
			const dotFrame = make("Frame", { BackgroundColor3: COLORS.dim, BorderSizePixel: 0, Position: UDim2.fromOffset(index * 14, 3), Size: UDim2.fromOffset(8, 8) }, dots);
			corner(dotFrame, 4);
		}
		return { id, prompt, state: "queued", finished: false, cursor: 0, seen: new Set(), frame, bubble, reply, segments: [], outcome, dots };
	};

	const addNote = (message: Message, text: string, color: Color3) => {
		const line = label(text, color, SMALL, false);
		line.LayoutOrder = message.segments.size() + 1;
		line.Parent = message.reply;
		message.segments.push({ kind: "note", line });
	};

	/** Applies new events to a message: text streams into its block, tools become one line, errors one red line. */
	const applyEvents = (message: Message, events: ClaudeEvent[]) => {
		for (const event of events) {
			if (event.i >= 0) {
				if (message.seen.has(event.i)) continue;
				message.seen.add(event.i);
			}
			const last = message.segments[message.segments.size() - 1];
			if (event.kind === "assistant_text") {
				if (last && last.kind === "text" && last.block === event.block) {
					last.text += event.text;
					last.dirty = true;
				} else {
					const holder = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: message.segments.size() + 1 }, message.reply);
					make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) }, holder);
					message.segments.push({ kind: "text", block: event.block, text: event.text, holder, rendered: [], dirty: true });
				}
			} else if (event.kind === "tool_use") {
				const row = make("TextButton", { AutoButtonColor: false, Text: "", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: message.segments.size() + 1 }, message.reply);
				make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 2) }, row);
				const lineRow = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 1 }, row);
				const dotFrame = make("Frame", { BackgroundColor3: COLORS.info, BorderSizePixel: 0, Position: UDim2.fromOffset(1, 6), Size: UDim2.fromOffset(6, 6) }, lineRow);
				corner(dotFrame, 3);
				const line = label(escapeRich(toolLine(event)), DIMMER, SMALL, true);
				line.TextWrapped = false;
				line.TextTruncate = Enum.TextTruncate.AtEnd;
				line.AutomaticSize = Enum.AutomaticSize.None;
				line.Size = new UDim2(1, -14, 0, LINE);
				line.Position = UDim2.fromOffset(14, 0);
				line.Parent = lineRow;
				const details = label("", DIMMER, SMALL, false);
				details.LayoutOrder = 2;
				details.Visible = false;
				details.Parent = row;
				const segment: ToolSegment = { kind: "tool", event, failed: false, dot: dotFrame };
				message.segments.push(segment);
				trove.connect(row.Activated, () => {
					// Tap: the input (run_luau: the code) and the output, truncated.
					const lines = new Array<string>();
					const input = event.detail ?? event.target;
					if (input !== undefined && input !== "") lines.push(input.sub(1, 600));
					const output = segment.resultDetail ?? segment.result;
					if (output !== undefined) lines.push(`-> ${output.sub(1, 600)}`);
					details.Text = lines.join("\n");
					details.Visible = !details.Visible && lines.size() > 0;
				});
			} else if (event.kind === "tool_result") {
				for (let index = message.segments.size() - 1; index >= 0; index--) {
					const segment = message.segments[index];
					if (segment.kind === "tool" && segment.result === undefined) {
						segment.result = event.text;
						segment.resultDetail = event.detail;
						segment.failed = event.text.sub(1, 6) === "error:";
						segment.dot.BackgroundColor3 = segment.failed ? COLORS.bad : DIMMER;
						const full = `${event.text} ${event.detail ?? ""}`;
						if (shortTool(segment.event.tool) === "run_luau" && full.find("loadstring is unavailable", 1, true)[0] !== undefined) {
							addNote(message, "Luau is off on this server: republish the kernel place", DIMMER);
						}
						break;
					}
				}
			} else if (event.kind === "error") {
				addNote(message, errorText(event.text), COLORS.bad);
			} else if (event.kind === "status" && event.state === undefined) {
				addNote(message, event.text, DIMMER);
			}
		}
		for (const segment of message.segments) {
			if (segment.kind === "text" && segment.dirty) {
				segment.dirty = false;
				syncBlocks(segment.holder, segment.rendered, parseMarkdown(segment.text));
			}
		}
	};

	/** The reply's plain text (for Copy). */
	const replyText = (message: Message) => {
		const parts = new Array<string>();
		for (const segment of message.segments) if (segment.kind === "text") parts.push(segment.text);
		return parts.join("\n\n");
	};

	/** The end of a message: dots while it runs, one short line when it finished with something to say. */
	const paintOutcome = (message: Message) => {
		message.dots.Visible = !message.finished;
		const copy = copyButtons.get(message.id);
		if (copy && deps.copyText) {
			copy.Visible = message.finished && message.segments.some((segment) => segment.kind === "text");
			if (copy.GetAttribute("Wired") !== true) {
				copy.SetAttribute("Wired", true);
				trove.connect(copy.Activated, () => deps.copyText!(replyText(message), copy));
			}
		}
		let text = "";
		let color = DIMMER;
		if (message.finished) {
			if (message.state === "deployed") text = `Deployed${message.artifactId !== undefined ? ` ${message.artifactId}` : ""}`;
			else if (message.state === "committed") text = `Committed${message.commit !== undefined ? ` ${message.commit.sub(1, 7)}` : ""}`;
			else if (message.state === "cancelled") text = "Stopped";
			else if (message.state === "lost") text = "Lost (the dev machine restarted)";
			else if (message.state === "failed" && !message.segments.some((s) => s.kind === "note")) {
				text = errorText(message.error ?? "Failed");
				color = COLORS.bad;
			}
		}
		message.outcome.Text = text;
		message.outcome.TextColor3 = color;
		message.outcome.Visible = text !== "";
	};

	const addMessage = (id: string, prompt: string) => {
		const message = buildMessage(id, prompt);
		messages.push(message);
		paintOutcome(message);
		paintEmpty();
		return message;
	};

	const clearTranscript = () => {
		view += 1;
		for (const message of messages) message.frame.Destroy();
		messages = [];
		bubbles.clear();
		copyButtons.clear();
		for (const [, card] of approvalCards) card.Destroy();
		approvalCards.clear();
		active = undefined;
		paintComposer();
		paintEmpty();
	};

	const fromStored = (stored: ClaudeMessage) => {
		const message = addMessage(stored.id, stored.prompt);
		message.state = stored.state;
		message.finished = stored.finished;
		message.cursor = stored.next;
		message.commit = stored.commit;
		message.artifactId = stored.artifactId;
		message.error = stored.error;
		// Over the size budget the dev menu gets no events: show the summary (or the error) instead.
		if (stored.events.size() === 0 && stored.error !== undefined) applyEvents(message, [{ i: -1, kind: "error", text: stored.error }]);
		else if (stored.events.size() === 0 && stored.summary !== undefined) applyEvents(message, [{ i: -1, kind: "assistant_text", text: stored.summary, block: 0 }]);
		else applyEvents(message, stored.events);
		paintOutcome(message);
		return message;
	};

	/** Opens a conversation from the dev machine (after a swap, a rejoin or a pick). */
	const openConversation = (id: string) => {
		clearTranscript();
		const myView = view;
		state.conversationId = id;
		notify("Loading...");
		const [ok, reply] = call("claude.conversation", id);
		if (myView !== view) return;
		const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: string; conversation?: ClaudeConversation };
		if (!ok || answer.ok !== true || !answer.conversation) {
			const code = ok ? answer.error : reply;
			if (code === "conversation_gone") state.conversationId = undefined;
			notify(errorText(code), COLORS.warn);
			return;
		}
		notify("");
		for (const stored of answer.conversation.messages) {
			const message = fromStored(stored);
			if (!message.finished) active = message;
		}
		paintComposer();
		scrollToEnd();
	};

	// run_luau approvals: one card per snippet waiting for this dev, under the transcript.
	const decide = (id: string, decision: string) =>
		spawn(() => {
			const card = approvalCards.get(id);
			if (card) {
				approvalCards.delete(id);
				card.Destroy();
			}
			const [ok, reply] = call("claude.approve", { id, decision });
			const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: string };
			if (!ok || answer.ok !== true) notify(errorText(ok ? answer.error : reply), COLORS.warn);
		});
	const showApprovals = (approvals: ClaudeApproval[]) => {
		const wanted = new Set<string>();
		for (const approval of approvals) {
			wanted.add(approval.id);
			if (approvalCards.has(approval.id)) continue;
			order += 1;
			const card = make(
				"Frame",
				{ BackgroundColor3: COLORS.header, BorderSizePixel: 0, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: order + 1_000_000 },
				list,
			);
			corner(card, 12);
			make("UIStroke", { Color: COLORS.warn, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, card);
			pad(card, 10, 12);
			make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 8) }, card);
			const title = label(`<b>Run on server?</b>  ${escapeRich(approval.description)}`, COLORS.text, SMALL, true);
			title.LayoutOrder = 1;
			title.Parent = card;
			// The code: a scrollable, selectable monospace box (at most about 9 lines tall).
			const codeScroll = make(
				"ScrollingFrame",
				{
					BackgroundColor3: CODE_BG,
					BorderSizePixel: 0,
					Size: new UDim2(1, 0, 0, math.min(9, approval.code.split("\n").size()) * LINE + 16),
					CanvasSize: new UDim2(),
					AutomaticCanvasSize: Enum.AutomaticSize.XY,
					ScrollBarThickness: 4,
					ScrollBarImageColor3: COLORS.dim,
					LayoutOrder: 2,
				},
				card,
			);
			corner(codeScroll, 8);
			const codeHolder = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.XY }, codeScroll);
			make("UIPadding", { PaddingTop: new UDim(0, 8), PaddingBottom: new UDim(0, 8), PaddingLeft: new UDim(0, 10), PaddingRight: new UDim(0, 10) }, codeHolder);
			const code = style(make("TextBox", { ClearTextOnFocus: false, TextEditable: false, MultiLine: true, BackgroundTransparency: 1 }, codeHolder), approval.code, SMALL, CODE_TEXT, FONT);
			code.TextWrapped = false;
			code.TextYAlignment = Enum.TextYAlignment.Top;
			code.Size = UDim2.fromOffset(0, 0);
			code.AutomaticSize = Enum.AutomaticSize.XY;
			const buttons = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, ROUND), AutomaticSize: Enum.AutomaticSize.Y, LayoutOrder: 3 }, card);
			make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6), Wraps: true }, buttons);
			const button = (text: string, color: Color3, textColor: Color3, decision: string, index: number) => {
				const b = style(make("TextButton", { AutoButtonColor: true, LayoutOrder: index }), text, SMALL, textColor, Enum.Font.BuilderSansMedium);
				b.TextXAlignment = Enum.TextXAlignment.Center;
				b.TextWrapped = false;
				b.BackgroundColor3 = color;
				b.Size = UDim2.fromOffset(0, ROUND);
				b.AutomaticSize = Enum.AutomaticSize.X;
				corner(b, 8);
				pad(b, 0, 12);
				b.Parent = buttons;
				trove.connect(b.Activated, () => decide(approval.id, decision));
			};
			button("Run", COLORS.accent, COLORS.dark, "once", 1);
			button("Always in this chat", COLORS.button, COLORS.text, "always", 2);
			button("Deny", COLORS.button, COLORS.bad, "deny", 3);
			popIn(card);
			approvalCards.set(approval.id, card);
		}
		for (const [id, card] of approvalCards) {
			if (wanted.has(id)) continue;
			approvalCards.delete(id);
			card.Destroy();
		}
	};

	let failures = 0;
	/** One round of polling for the running message (more pages right away when the dev machine has them). */
	const poll = () => {
		const message = active;
		if (!message || message.finished) return;
		const myView = view;
		for (let page = 0; page < 5; page++) {
			const [ok, reply] = call("claude.events", { id: message.id, since: message.cursor });
			if (myView !== view || active !== message) return;
			const answer = (typeIs(reply, "table") ? reply : {}) as ClaudeEventsReply;
			if (!ok || answer.ok !== true) {
				if (ok && answer.error === "needs_pairing") refreshSession();
				failures += 1;
				// The dev machine is gone (stopped, restarted, unpaired): stop waiting for this run.
				if (failures >= 15) {
					message.finished = true;
					message.state = "lost";
					paintOutcome(message);
					paintComposer();
					showApprovals([]);
				}
				return;
			}
			failures = 0;
			showApprovals(answer.approvals ?? []);
			applyEvents(message, answer.events ?? []);
			message.cursor = math.max(message.cursor, answer.next ?? message.cursor);
			message.state = answer.state ?? message.state;
			message.commit = answer.commit ?? message.commit;
			message.artifactId = answer.artifactId ?? message.artifactId;
			message.error = answer.runError ?? message.error;
			message.finished = answer.finished === true;
			paintOutcome(message);
			if (message.finished) {
				paintComposer();
				showApprovals([]);
				return;
			}
			if (answer.more !== true) return;
		}
	};

	// Working dots: a slow wave, only while something runs.
	trove.add(
		task.spawn(() => {
			let phase = 0;
			while (true) {
				task.wait(0.25);
				const message = active;
				if (!message || message.finished || !message.dots.Visible) continue;
				phase = (phase + 1) % 3;
				message.dots.GetChildren().forEach((child, index) => {
					if (child.IsA("Frame")) child.BackgroundTransparency = index === phase ? 0 : 0.6;
				});
			}
		}),
	);

	// Session ------------------------------------------------------------------------------------------------------------
	let lastSession = -math.huge;
	let loaded = false;
	refreshSession = () => {
		lastSession = os.clock();
		const [ok, reply] = call("claude.session");
		if (!ok || !typeIs(reply, "table")) {
			status.Text = "Error";
			status.TextColor3 = COLORS.bad;
			return;
		}
		const session = reply as ClaudeSessionView;
		paired = session.available && session.allowed && session.paired === true;
		if (!session.available) {
			status.Text = "Not connected";
			status.TextColor3 = COLORS.warn;
		} else if (!session.allowed) {
			status.Text = "Not allowed";
			status.TextColor3 = COLORS.warn;
		} else if (!paired) {
			status.Text = `Not paired · ${session.label}`;
			status.TextColor3 = COLORS.warn;
		} else {
			status.Text = `Connected · ${session.label} · ${session.branch ?? "?"}`;
			status.TextColor3 = COLORS.good;
		}
		pairing.Visible = session.available && session.allowed && !paired;
		unpairButton.Visible = paired;
		newButton.Visible = paired;
		statusChevron.Visible = paired;
		if (!paired) chats.Visible = false;
		if (!session.available) notify(errorText("not_connected"), COLORS.warn);
		else if (!session.allowed) notify(errorText("not_allowed"), COLORS.warn);
		else if (notice.Text === errorText("not_connected") || notice.Text === errorText("not_allowed")) notify("");
		// First time paired in this tab: reopen the chat that was open before the swap.
		if (paired && !loaded) {
			loaded = true;
			if (state.conversationId !== undefined) openConversation(state.conversationId);
		}
	};

	// Actions ------------------------------------------------------------------------------------------------------------
	let pairingBusy = false;
	const pair = () => {
		if (pairingBusy) return;
		const code = trim(codeBox.Text);
		codeBox.Text = "";
		if (code === "") return notify("Paste a code first", COLORS.warn);
		pairingBusy = true;
		spawn(() => {
			notify("Pairing...");
			const [ok, reply] = call("claude.pair", { code });
			pairingBusy = false;
			const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: string };
			if (ok && answer.ok === true) {
				notify("");
				refreshSession();
			} else notify(errorText(ok ? answer.error : reply), COLORS.bad);
		});
	};
	trove.connect(pairButton.Activated, pair);
	trove.connect(codeBox.FocusLost, (enterPressed) => {
		if (enterPressed) pair();
	});

	trove.connect(unpairButton.Activated, () =>
		spawn(() => {
			call("claude.unpair");
			notify("");
			refreshSession();
		}),
	);

	trove.connect(newButton.Activated, () => {
		state.conversationId = undefined;
		chats.Visible = false;
		clearTranscript();
		notify("");
	});

	// Recent chats: tap the status line.
	trove.connect(statusButton.Activated, () => {
		if (!paired) return;
		if (chats.Visible) {
			chats.Visible = false;
			return;
		}
		spawn(() => {
			const [ok, reply] = call("claude.conversations");
			const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: string; conversations?: ClaudeConversationSummary[] };
			if (!ok || answer.ok !== true) return notify(errorText(ok ? answer.error : reply), COLORS.bad);
			for (const child of chats.GetChildren()) if (child.IsA("GuiObject")) child.Destroy();
			const recent = (answer.conversations ?? []).filter((_, index) => index < 6);
			if (recent.size() === 0) label("No chats yet", DIMMER, SMALL, false).Parent = chats;
			recent.forEach((conversation, index) => {
				const current = conversation.id === state.conversationId;
				const row = style(make("TextButton", { AutoButtonColor: true, LayoutOrder: index }), conversation.title, SMALL, COLORS.text, FONT);
				row.TextWrapped = false;
				row.TextTruncate = Enum.TextTruncate.AtEnd;
				row.BackgroundColor3 = current ? COLORS.button : COLORS.row;
				row.Size = new UDim2(1, 0, 0, ROUND);
				corner(row, 8);
				pad(row, 0, 10);
				row.Parent = chats;
				trove.connect(row.Activated, () => {
					chats.Visible = false;
					spawn(() => openConversation(conversation.id));
				});
			});
			popIn(chats);
		});
	});

	const lastClientErrors = (): string[] => {
		const errors = new Array<string>();
		for (const entry of kernel.logs(undefined, 300)) {
			if (entry.kind === "error") errors.push(entry.text.sub(1, 500));
		}
		return errors.filter((_, index) => index >= errors.size() - 5);
	};

	const send = () => {
		if (sending) return;
		const prompt = trim(box.Text);
		if (prompt === "") return notify(errorText("empty"), COLORS.warn);
		if (prompt.size() > MAX_PROMPT) return notify(errorText("too_long"), COLORS.warn);
		sending = true;
		menu.Visible = false;
		spawn(() => {
			const request: ClaudePromptRequest = { prompt, errors: state.attachErrors };
			if (state.conversationId !== undefined) request.conversationId = state.conversationId;
			if (state.attachPath) {
				const path = deps.dexSelection();
				if (path !== undefined) request.path = path;
			}
			if (state.attachErrors) request.clientErrors = lastClientErrors();
			const myView = view;
			const [ok, reply] = call("claude.prompt", request);
			sending = false;
			const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: string; request?: ClaudeRequestView };
			if (!ok || answer.ok !== true || !answer.request) {
				const code = ok ? answer.error : reply;
				if (code === "conversation_gone") {
					// The dev machine forgot the chat: keep the text; the next Send starts a new chat.
					state.conversationId = undefined;
					clearTranscript();
				}
				if (code === "needs_pairing") refreshSession();
				return notify(errorText(code), COLORS.bad);
			}
			notify("");
			box.Text = "";
			state.draft = "";
			const conversationId = answer.request.conversationId;
			if (myView !== view && conversationId !== undefined) {
				// The dev switched chats while this was sending: show the chat the message went to.
				openConversation(conversationId);
				return;
			}
			if (conversationId !== undefined) state.conversationId = conversationId;
			chats.Visible = false;
			active = addMessage(answer.request.id, prompt);
			paintComposer();
			scrollToEnd();
		});
	};
	trove.connect(sendButton.Activated, () => {
		const message = active;
		if (!message || message.finished) return send();
		// Stop. If the dev machine can't be told (gone, or the run already ended), the run ends here anyway.
		spawn(() => {
			const [ok, reply] = call("claude.cancel", message.id);
			const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: string };
			if (ok && answer.ok === true) return;
			const code = ok ? answer.error : reply;
			if (code === "not_found" || code === "not_connected" || code === "unreachable" || code === "conflict" || !ok) {
				message.finished = true;
				message.state = "cancelled";
				paintOutcome(message);
				paintComposer();
				showApprovals([]);
			} else notify(errorText(code), COLORS.bad);
		});
	});

	// Loop: the running message about once a second, the session every 10 s. Only while this tab is open.
	paintComposer();
	paintEmpty();
	trove.add(
		task.spawn(() => {
			while (true) {
				const [ok, err] = pcall(() => {
					if (os.clock() - lastSession >= SESSION_REFRESH) refreshSession();
					poll();
				});
				if (!ok) notify(`Failed: ${err}`, COLORS.bad);
				task.wait(running() ? POLL_ACTIVE : POLL_IDLE);
			}
		}),
	);
}
