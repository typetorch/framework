import { Players, UserInputService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ClientKernel } from "../kernel";
import { bump, popIn, popOut, PopupQueue } from "../ui";
import type {
	AdminBanEntry,
	AdminPlayer,
	AdminPlayersReply,
	AdminRole,
	AdminServer,
	AdminServersReply,
} from "./admin-server";
import {
	addButton,
	BUTTON_HEIGHT,
	COLORS,
	corner,
	escapeRich,
	make,
	pad,
	Page,
	paintSelected,
	searchBox,
	spacer,
	style,
	tag,
	verticalList,
} from "./widgets";

/**
 * The dev menu's Admin tab (plans/10, "Admin"): sub-tabs Players, Servers and Bans. The server (admin-server.ts)
 * decides every permission; this UI only hides what the server says you can't do.
 *  - Players: one row per player (headshot, display name, role, @name and user id, ping) and a "more" button that
 *    opens a small menu: Teleport to, Bring, Respawn, Kick, Ban. Kick and Ban open a card (reason; Ban adds a duration
 *    and "ban alts"); their button arms "Confirm" on the first tap.
 *  - Servers: the universe's live servers (short JobId, copyable by focusing it; type, branch, channel, artifact,
 *    players, uptime) with Join, plus New server and, for admins, Shut down (a card, then an armed button).
 *  - Bans: Unban by user id and the ban history of a user id (admins).
 * Cards go through one PopupQueue (never two at once) and pop in and out through a UIScale; everything lives in the tab
 * trove, so a tab switch or a swap removes it.
 */

const PLAYERS_REFRESH = 3;
/** The server caches the list for 15 s, so polling faster gains nothing. */
const SERVERS_REFRESH = 20;
const ARM_SECONDS = 4;
const REASON_MAX = 200;
const ROW_HEIGHT = 52;
const MENU_WIDTH = 180;
const MENU_ROW = 36;
const MORE_SIZE = 34;
const SERVER_ACTION = 72;
const ID_WIDTH = 80;

const ROLE_COLORS: Record<AdminRole, Color3> = { owner: COLORS.accent, admin: COLORS.info, dev: COLORS.good };
const ROLE_ORDER: Record<AdminRole, number> = { owner: 3, admin: 2, dev: 1 };

/** Ban presets (ids match admin-server.ts BAN_PRESETS). */
const PRESETS: Array<[id: string, label: string]> = [
	["1h", "1 h"],
	["1d", "1 d"],
	["7d", "7 d"],
	["perm", "Perm"],
];

/** Short text for the error codes of admin-server.ts. */
const ERRORS: Record<string, string> = {
	rate_limited: "Slow down",
	admins_only: "Admins only",
	prod_admin_only: "Admins only on prod",
	protected: "Their role is too high",
	self: "Not on yourself",
	not_in_server: "They left",
	no_character: "No character",
	bad_request: "Bad input",
	not_joinable: "Can't join that one",
	gone: "Server is gone",
	here: "You're already here",
	studio: "Not in Studio",
	no_reply: "No reply",
	"not a dev": "Not a dev",
};

export interface AdminTab {
	readonly page: Page;
	readonly trove: Trove;
	readonly content: ScrollingFrame;
	readonly toolbar: () => Frame;
	readonly footer: () => Page;
}

export interface AdminDeps {
	kernel: ClientKernel;
	/** Sends one dev op and yields for the answer (client.ts `call`). */
	call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
}

/** The Admin sub-tabs, keyed like client.ts RENDER ("Tab/Sub"). */
export function adminTabs(deps: AdminDeps): Record<string, (tab: AdminTab) => void> {
	return {
		"Admin/Players": (tab) => renderPlayers(tab, deps),
		"Admin/Servers": (tab) => renderServers(tab, deps),
		"Admin/Bans": (tab) => renderBans(tab, deps),
	};
}

// Helpers -------------------------------------------------------------------------------------------------------------

function spawnIn(trove: Trove, callback: () => void) {
	trove.add(task.spawn(callback));
}

/** Runs `callback` now and every `interval` seconds until `trove` is cleaned. Errors are logged, not fatal. */
function every(trove: Trove, interval: number, callback: () => void) {
	spawnIn(trove, () => {
		while (true) {
			const [ok, err] = pcall(callback);
			if (!ok) $warn(`[devtools] admin refresh failed: ${err}`);
			task.wait(interval);
		}
	});
}

function errorText(reply: unknown): string {
	if (typeIs(reply, "table")) reply = (reply as { error?: unknown }).error;
	if (typeIs(reply, "string")) return ERRORS[reply] ?? reply;
	return "Failed";
}

/** The op succeeded and its reply isn't `{ ok: false }` (kernel reports). */
function succeeded(ok: boolean, reply: unknown): boolean {
	return ok && !(typeIs(reply, "table") && (reply as { ok?: unknown }).ok === false);
}

function duration(seconds: number | undefined): string {
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

function banLength(seconds: number | undefined): string {
	if (seconds === undefined) return "";
	if (seconds < 0) return "permanent";
	return duration(seconds);
}

function parseUserId(text: string): number | undefined {
	const value = tonumber(text.gsub("%s", "")[0]);
	return value !== undefined && value > 0 && value % 1 === 0 && value < 2 ** 53 ? value : undefined;
}

/** Keeps a TextBox at most `max` characters (cut on a character boundary). */
function limitLength(box: TextBox, trove: Trove, max = REASON_MAX) {
	trove.connect(box.GetPropertyChangedSignal("Text"), () => {
		const cut = utf8.offset(box.Text, max + 1);
		if (cut !== undefined && cut <= box.Text.size()) box.Text = box.Text.sub(1, cut - 1);
	});
}

/** A one-line result under the tab (in its footer). */
function resultLabel(foot: Page): (text: string, color: Color3) => void {
	const label = foot.place(
		style(make("TextLabel", { BackgroundTransparency: 1 }), "", 14, COLORS.dim, Enum.Font.BuilderSansMedium),
	);
	label.TextWrapped = false;
	label.TextTruncate = Enum.TextTruncate.AtEnd;
	label.Size = new UDim2(1, 0, 0, 18);
	return (text, color) => {
		label.Text = text;
		label.TextColor3 = color;
		bump(label);
	};
}

/** A button whose first tap arms it ("Confirm"); a second tap within 4 s runs `run`. */
function armButton(row: Instance, label: string, color: Color3, run: () => void): TextButton {
	let armedAt = -math.huge;
	const button: TextButton = addButton(
		row,
		label,
		() => {
			if (os.clock() - armedAt < ARM_SECONDS) {
				armedAt = -math.huge;
				button.Text = label;
				run();
				return;
			}
			armedAt = os.clock();
			button.Text = "Confirm";
			bump(button);
			task.delay(ARM_SECONDS, () => {
				if (button.Parent && os.clock() - armedAt >= ARM_SECONDS - 0.05) button.Text = label;
			});
		},
		color,
	);
	button.TextColor3 = COLORS.dark;
	return button;
}

/** The window (overlay host) and the body (the area overlays cover) around a tab's content. */
function hostOf(tab: AdminTab): [host: GuiObject, area: GuiObject] {
	const body = tab.content.Parent;
	const window = body?.Parent;
	if (body && body.IsA("GuiObject") && window && window.IsA("GuiObject")) return [window, body];
	return [tab.content, tab.content];
}

function inside(gui: GuiObject, point: Vector2): boolean {
	const origin = gui.AbsolutePosition;
	const size = gui.AbsoluteSize;
	return point.X >= origin.X && point.X <= origin.X + size.X && point.Y >= origin.Y && point.Y <= origin.Y + size.Y;
}

function isPointer(input: InputObject): boolean {
	return input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
}

// Icons (drawn from Frames: no emojis or font glyphs) -------------------------------------------------------------

type IconKind = "goto" | "bring" | "respawn" | "kick" | "ban";

function drawIcon(parent: Instance, kind: IconKind, color: Color3): Frame {
	const box = make(
		"Frame",
		{ BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 0.5), Position: new UDim2(0, 10, 0.5, 0), Size: UDim2.fromOffset(16, 16) },
		parent,
	);
	const bar = (x: number, y: number, w: number, h: number, rotation = 0) =>
		make("Frame", { BackgroundColor3: color, BorderSizePixel: 0, Position: UDim2.fromOffset(x, y), Size: UDim2.fromOffset(w, h), Rotation: rotation }, box);
	const dot = (x: number, y: number, size: number) => corner(bar(x, y, size, size), size / 2);
	const ring = (x: number, y: number, size: number) => {
		const frame = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(x, y), Size: UDim2.fromOffset(size, size) }, box);
		corner(frame, size / 2);
		make("UIStroke", { Color: color, Thickness: 2, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, frame);
		return frame;
	};
	if (kind === "goto") {
		// An arrow running right into a dot: go to them.
		bar(0, 7, 9, 2);
		bar(4, 5, 6, 2, 45);
		bar(4, 9, 6, 2, -45);
		dot(11, 5, 6);
	} else if (kind === "bring") {
		// A dot on the left and an arrow pointing at it: pull them here.
		dot(0, 5, 6);
		bar(7, 7, 9, 2);
		bar(6, 5, 6, 2, -45);
		bar(6, 9, 6, 2, 45);
	} else if (kind === "respawn") {
		// A ring with a head on top: go round again.
		ring(1, 2, 13);
		dot(9, 0, 6);
	} else if (kind === "kick") {
		// A door frame and an arrow leaving it.
		const door = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(0, 1), Size: UDim2.fromOffset(8, 14) }, box);
		corner(door, 2);
		make("UIStroke", { Color: color, Thickness: 2, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, door);
		bar(5, 7, 10, 2);
		bar(10, 5, 6, 2, 45);
		bar(10, 9, 6, 2, -45);
	} else {
		// No entry: a ring with a diagonal bar.
		ring(1, 1, 14);
		bar(1, 7, 14, 2, 45);
	}
	return box;
}

/** Three dots stacked (the "more" button). */
function drawDots(button: GuiObject) {
	for (const offset of [-7, 0, 7]) {
		const dot = make(
			"Frame",
			{
				BackgroundColor3: COLORS.text,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: new UDim2(0.5, 0, 0.5, offset),
				Size: UDim2.fromOffset(4, 4),
			},
			button,
		);
		corner(dot, 2);
	}
}

/** A checkbox row: a square that fills when on, and a short label. */
function checkbox(page: Page, label: string, get: () => boolean, set: (on: boolean) => void) {
	const row = page.place(
		make("TextButton", { AutoButtonColor: false, Text: "", BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, BUTTON_HEIGHT) }),
	);
	const box = make(
		"Frame",
		{ BackgroundColor3: COLORS.row, BorderSizePixel: 0, AnchorPoint: new Vector2(0, 0.5), Position: new UDim2(0, 0, 0.5, 0), Size: UDim2.fromOffset(22, 22) },
		row,
	);
	corner(box, 5);
	make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, box);
	const fill = make(
		"Frame",
		{ BackgroundColor3: COLORS.accent, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(12, 12) },
		box,
	);
	corner(fill, 3);
	const text = style(make("TextLabel", { BackgroundTransparency: 1 }, row), label, 15);
	text.TextWrapped = false;
	text.Position = UDim2.fromOffset(32, 0);
	text.Size = new UDim2(1, -32, 1, 0);
	const paint = () => {
		fill.Visible = get();
	};
	row.Activated.Connect(() => {
		set(!get());
		paint();
		bump(box);
	});
	paint();
}

// Cards (modal, one at a time) -----------------------------------------------------------------------------------

/**
 * Modal cards over the tab body: a dim overlay (tap outside or Escape = cancel) with a centered card. One PopupQueue,
 * so two cards never overlap; pops through a UIScale. Each card has its own trove inside the tab trove.
 */
class Cards {
	private readonly queue = new PopupQueue();

	constructor(private readonly tab: AdminTab) {}

	open(build: (card: Page, close: () => void, cardTrove: Trove) => void) {
		this.queue.enqueue((done) => {
			const [host, area] = hostOf(this.tab);
			if (!area.Parent) return done();
			const cardTrove = this.tab.trove.extend();
			const overlay = cardTrove.add(
				make("TextButton", {
					Name: "AdminCard",
					AutoButtonColor: false,
					Text: "",
					BackgroundColor3: Color3.fromRGB(0, 0, 0),
					BackgroundTransparency: 0.45,
					BorderSizePixel: 0,
					Position: area.Position,
					Size: area.Size,
					ZIndex: 30,
				}),
			);
			const card = make(
				"Frame",
				{
					Name: "Card",
					Active: true,
					AnchorPoint: new Vector2(0.5, 0.5),
					Position: UDim2.fromScale(0.5, 0.5),
					Size: new UDim2(1, -24, 0, 0),
					AutomaticSize: Enum.AutomaticSize.Y,
					BackgroundColor3: COLORS.header,
					BorderSizePixel: 0,
				},
				overlay,
			);
			make("UISizeConstraint", { MaxSize: new Vector2(380, math.huge) }, card);
			corner(card, 12);
			make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, card);
			const page = Page.mount(card, 8);
			pad(page.frame, 12, 12);

			let closed = false;
			const close = () => {
				if (closed) return;
				closed = true;
				popOut(card, () => {
					this.tab.trove.remove(cardTrove);
					done();
				});
			};
			cardTrove.connect(overlay.Activated, close);
			cardTrove.connect(UserInputService.InputBegan, (input) => {
				if (input.KeyCode === Enum.KeyCode.Escape) close();
			});
			build(page, close, cardTrove);
			overlay.Parent = host;
			popIn(card);
		});
	}
}

function cardTitle(card: Page, title: string, detail?: string) {
	const label = card.text(title);
	label.Font = Enum.Font.BuilderSansBold;
	label.TextSize = 18;
	if (detail !== undefined) card.text(detail, COLORS.dim, true);
}

/** A status line inside a card (hidden until used). */
function cardStatus(card: Page): (text: string, color: Color3) => void {
	const label = card.text("", COLORS.dim);
	label.Visible = false;
	return (text, color) => {
		label.Text = text;
		label.TextColor3 = color;
		label.Visible = text !== "";
	};
}

// Per-player menu (a small floating panel, like the chat's "+" menu) -------------------------------------------------

interface MenuItem {
	name: string;
	icon: IconKind;
	color?: Color3;
	run: () => void;
}

class PlayerMenu {
	private current?: { trove: Trove; frame: Frame; anchor: GuiObject };

	constructor(private readonly tab: AdminTab) {
		tab.trove.connect(UserInputService.InputBegan, (input) => {
			const current = this.current;
			if (!current) return;
			if (input.KeyCode === Enum.KeyCode.Escape) return this.close();
			if (!isPointer(input)) return;
			// The dev menu's ScreenGui ignores the GUI inset, so input positions match AbsolutePosition.
			const point = new Vector2(input.Position.X, input.Position.Y);
			if (!inside(current.frame, point) && !inside(current.anchor, point)) this.close();
		});
		tab.trove.connect(tab.content.GetPropertyChangedSignal("CanvasPosition"), () => this.close());
	}

	isFor(anchor: GuiObject): boolean {
		return this.current?.anchor === anchor;
	}

	toggle(anchor: GuiObject, items: MenuItem[]) {
		if (this.isFor(anchor)) return this.close();
		this.close();
		if (items.size() === 0) return;
		const [host] = hostOf(this.tab);
		const menuTrove = this.tab.trove.extend();
		const frame = menuTrove.add(
			make("Frame", {
				Name: "PlayerMenu",
				Active: true,
				BackgroundColor3: COLORS.header,
				BorderSizePixel: 0,
				Size: UDim2.fromOffset(MENU_WIDTH, 0),
				AutomaticSize: Enum.AutomaticSize.Y,
				Visible: false,
				ZIndex: 25,
			}),
		);
		corner(frame, 12);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, frame);
		pad(frame, 6, 6);
		make("UIListLayout", { SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 2) }, frame);
		items.forEach((item, index) => {
			const row = make(
				"TextButton",
				{
					AutoButtonColor: false,
					Text: "",
					BackgroundColor3: COLORS.button,
					BackgroundTransparency: 1,
					BorderSizePixel: 0,
					Size: new UDim2(1, 0, 0, MENU_ROW),
					LayoutOrder: index,
				},
				frame,
			);
			corner(row, 8);
			const color = item.color ?? COLORS.text;
			drawIcon(row, item.icon, color);
			const label = style(make("TextLabel", { BackgroundTransparency: 1 }, row), item.name, 15, color, Enum.Font.BuilderSansMedium);
			label.TextWrapped = false;
			label.Position = UDim2.fromOffset(36, 0);
			label.Size = new UDim2(1, -40, 1, 0);
			menuTrove.connect(row.MouseEnter, () => (row.BackgroundTransparency = 0));
			menuTrove.connect(row.MouseLeave, () => (row.BackgroundTransparency = 1));
			menuTrove.connect(row.Activated, () => {
				this.close();
				item.run();
			});
		});
		// Under the button, right-aligned to it; above it when there is no room below. Window coordinates.
		const height = items.size() * (MENU_ROW + 2) + 10;
		const at = anchor.AbsolutePosition.sub(host.AbsolutePosition);
		const x = math.clamp(at.X + anchor.AbsoluteSize.X - MENU_WIDTH, 4, math.max(4, host.AbsoluteSize.X - MENU_WIDTH - 4));
		let y = at.Y + anchor.AbsoluteSize.Y + 4;
		if (y + height > host.AbsoluteSize.Y - 4) y = math.max(4, at.Y - height - 4);
		frame.Position = UDim2.fromOffset(x, y);
		frame.Parent = host;
		this.current = { trove: menuTrove, frame, anchor };
		popIn(frame);
	}

	close() {
		const current = this.current;
		if (!current) return;
		this.current = undefined;
		popOut(current.frame, () => this.tab.trove.remove(current.trove));
	}
}

// Players -------------------------------------------------------------------------------------------------------------

/** userId -> headshot content id (thumbnails never change within a session). */
const headshots = new Map<number, string>();

interface PlayerRow {
	frame: Frame;
	image: ImageLabel;
	title: TextLabel;
	ping: TextLabel;
	sub: TextBox;
	more: TextButton;
	data: AdminPlayer;
}

function canAny(data: AdminPlayer): boolean {
	const can = data.can;
	return can.tp || can.bring || can.respawn || can.kick || can.ban;
}

function renderPlayers(tab: AdminTab, deps: AdminDeps) {
	const { page, trove } = tab;
	const setResult = resultLabel(tab.footer());
	const cards = new Cards(tab);
	const menu = new PlayerMenu(tab);
	const note = page.text("Loading...", COLORS.dim);
	const list = page.group(4);
	const rows = new Map<number, PlayerRow>();
	let busy = false;

	const act = (label: string, op: string, userId: number, doneText: string) => {
		if (busy) return;
		busy = true;
		setResult(`${label}...`, COLORS.dim);
		spawnIn(trove, () => {
			const [ok, reply] = deps.call(op, { userId });
			busy = false;
			if (succeeded(ok, reply)) setResult(doneText, COLORS.good);
			else setResult(`Failed: ${errorText(reply)}`, COLORS.bad);
		});
	};

	const openKick = (data: AdminPlayer) =>
		cards.open((card, close, cardTrove) => {
			cardTitle(card, `Kick ${data.displayName}`, `@${data.name}  ${data.userId}`);
			const reason = card.input("Reason (optional)", BUTTON_HEIGHT, false);
			limitLength(reason, cardTrove);
			const status = cardStatus(card);
			const buttons = card.buttons();
			addButton(buttons, "Cancel", close);
			spacer(buttons);
			let sending = false;
			armButton(buttons, "Kick", COLORS.bad, () => {
				if (sending) return;
				sending = true;
				status("Kicking...", COLORS.dim);
				spawnIn(cardTrove, () => {
					const [ok, reply] = deps.call("admin.kick", { userId: data.userId, reason: reason.Text });
					sending = false;
					if (succeeded(ok, reply)) {
						setResult(`Kicked ${data.displayName}`, COLORS.good);
						close();
					} else {
						status(`Failed: ${errorText(reply)}`, COLORS.bad);
					}
				});
			});
		});

	const openBan = (data: AdminPlayer) =>
		cards.open((card, close, cardTrove) => {
			cardTitle(card, `Ban ${data.displayName}`, `@${data.name}  ${data.userId}`);
			let preset = "1d";
			const presetRow = card.buttons();
			const presetButtons = new Map<string, TextButton>();
			const paint = () => {
				for (const [id, button] of presetButtons) paintSelected(button, id === preset);
			};
			for (const [id, label] of PRESETS) {
				presetButtons.set(
					id,
					addButton(presetRow, label, () => {
						preset = id;
						paint();
					}),
				);
			}
			paint();
			const reason = card.input("Reason (shown to them)", BUTTON_HEIGHT, false);
			limitLength(reason, cardTrove);
			// ExcludeAltAccounts = false by default: alts are banned too.
			let banAlts = true;
			checkbox(
				card,
				"Ban alts too",
				() => banAlts,
				(on) => (banAlts = on),
			);
			const status = cardStatus(card);
			const buttons = card.buttons();
			addButton(buttons, "Cancel", close);
			spacer(buttons);
			let sending = false;
			armButton(buttons, "Ban", COLORS.bad, () => {
				if (sending) return;
				sending = true;
				status("Banning...", COLORS.dim);
				spawnIn(cardTrove, () => {
					const [ok, reply] = deps.call("admin.ban", { userId: data.userId, preset, reason: reason.Text, banAlts });
					sending = false;
					if (succeeded(ok, reply)) {
						setResult(`Banned ${data.displayName}`, COLORS.good);
						close();
					} else {
						status(`Failed: ${errorText(reply)}`, COLORS.bad);
					}
				});
			});
		});

	const menuFor = (data: AdminPlayer): MenuItem[] => {
		const items = new Array<MenuItem>();
		const who = data.displayName;
		if (data.can.tp) items.push({ name: "Teleport to", icon: "goto", run: () => act(`Going to ${who}`, "admin.tp", data.userId, `At ${who}`) });
		if (data.can.bring) items.push({ name: "Bring", icon: "bring", run: () => act(`Bringing ${who}`, "admin.bring", data.userId, `Brought ${who}`) });
		if (data.can.respawn) {
			items.push({ name: "Respawn", icon: "respawn", run: () => act(`Respawning ${who}`, "admin.respawn", data.userId, `Respawned ${who}`) });
		}
		if (data.can.kick) items.push({ name: "Kick", icon: "kick", color: COLORS.bad, run: () => openKick(data) });
		if (data.can.ban) items.push({ name: "Ban", icon: "ban", color: COLORS.bad, run: () => openBan(data) });
		return items;
	};

	const updateRow = (row: PlayerRow) => {
		const data = row.data;
		let title = `<b>${escapeRich(data.displayName)}</b>`;
		if (data.role) title += tag(data.role.upper(), ROLE_COLORS[data.role]);
		if (data.you) title += tag("YOU", COLORS.dim);
		row.title.Text = title;
		const ping = data.pingMs;
		row.ping.Text = ping !== undefined ? `${ping} ms` : "";
		row.ping.TextColor3 = ping === undefined || ping < 120 ? COLORS.dim : ping < 250 ? COLORS.warn : COLORS.bad;
		// A TextBox, so the user id can be selected and copied (it is what Bans > Unban takes).
		if (!row.sub.IsFocused()) row.sub.Text = `@${data.name}  ${data.userId}`;
		row.more.Visible = canAny(data);
	};

	const createRow = (data: AdminPlayer): PlayerRow => {
		const frame = make("Frame", { Name: tostring(data.userId), BackgroundColor3: COLORS.row, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, ROW_HEIGHT) });
		corner(frame, 6);
		const image = make(
			"ImageLabel",
			{
				BackgroundColor3: COLORS.button,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0, 0.5),
				Position: new UDim2(0, 8, 0.5, 0),
				Size: UDim2.fromOffset(36, 36),
				Image: headshots.get(data.userId) ?? "",
			},
			frame,
		);
		make("UIAspectRatioConstraint", { AspectRatio: 1 }, image);
		corner(image, 18);
		const left = 52;
		const right = MORE_SIZE + 12;
		const title = style(make("TextLabel", { BackgroundTransparency: 1, RichText: true }, frame), "", 15);
		title.TextWrapped = false;
		title.TextTruncate = Enum.TextTruncate.AtEnd;
		title.Position = UDim2.fromOffset(left, 7);
		title.Size = new UDim2(1, -(left + right + 58), 0, 19);
		const ping = style(make("TextLabel", { BackgroundTransparency: 1 }, frame), "", 14, COLORS.dim, Enum.Font.Code);
		ping.TextWrapped = false;
		ping.TextXAlignment = Enum.TextXAlignment.Right;
		ping.AnchorPoint = new Vector2(1, 0);
		ping.Position = new UDim2(1, -right, 0, 7);
		ping.Size = UDim2.fromOffset(56, 19);
		const sub = style(make("TextBox", { BackgroundTransparency: 1, ClearTextOnFocus: false, TextEditable: false }, frame), "", 14, COLORS.dim, Enum.Font.Code);
		sub.TextWrapped = false;
		sub.ClipsDescendants = true;
		sub.Position = UDim2.fromOffset(left, 27);
		sub.Size = new UDim2(1, -(left + right), 0, 18);
		const more = make(
			"TextButton",
			{
				Name: "More",
				AutoButtonColor: true,
				Text: "",
				BackgroundColor3: COLORS.button,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(1, 0.5),
				Position: new UDim2(1, -8, 0.5, 0),
				Size: UDim2.fromOffset(MORE_SIZE, MORE_SIZE),
			},
			frame,
		);
		corner(more, 6);
		drawDots(more);
		const row: PlayerRow = { frame, image, title, ping, sub, more, data };
		more.Activated.Connect(() => menu.toggle(more, menuFor(row.data)));
		if (!headshots.has(data.userId)) {
			spawnIn(trove, () => {
				const [ok, content] = pcall(
					() => Players.GetUserThumbnailAsync(data.userId, Enum.ThumbnailType.HeadShot, Enum.ThumbnailSize.Size48x48)[0],
				);
				if (!ok || !typeIs(content, "string")) return;
				headshots.set(data.userId, content);
				if (image.Parent) image.Image = content;
			});
		}
		frame.Parent = list.frame;
		return row;
	};

	const refresh = () => {
		const [ok, reply] = deps.call("admin.players");
		if (!ok || !typeIs(reply, "table")) {
			note.Text = `Failed: ${errorText(reply)}`;
			note.TextColor3 = COLORS.bad;
			note.Visible = true;
			return;
		}
		const players = [...(reply as AdminPlayersReply).players];
		note.Visible = players.size() === 0;
		note.Text = "Nobody here";
		note.TextColor3 = COLORS.dim;
		// You first, then by role, then by name.
		players.sort((a, b) => {
			if (a.you !== b.you) return a.you;
			const ra = a.role ? ROLE_ORDER[a.role] : 0;
			const rb = b.role ? ROLE_ORDER[b.role] : 0;
			if (ra !== rb) return ra > rb;
			return a.displayName.lower() < b.displayName.lower();
		});
		const seen = new Set<number>();
		players.forEach((data, index) => {
			seen.add(data.userId);
			let row = rows.get(data.userId);
			if (!row) {
				row = createRow(data);
				rows.set(data.userId, row);
			}
			row.data = data;
			row.frame.LayoutOrder = index;
			updateRow(row);
		});
		const gone = new Array<number>();
		for (const [userId] of rows) if (!seen.has(userId)) gone.push(userId);
		for (const userId of gone) {
			const row = rows.get(userId)!;
			if (menu.isFor(row.more)) menu.close();
			row.frame.Destroy();
			rows.delete(userId);
		}
	};
	every(trove, PLAYERS_REFRESH, refresh);
}

// Servers -------------------------------------------------------------------------------------------------------------

function renderServers(tab: AdminTab, deps: AdminDeps) {
	const { page, trove } = tab;
	const bar = tab.toolbar();
	const foot = tab.footer();
	const footButtons = foot.buttons();
	footButtons.Visible = false;
	const setResult = resultLabel(foot);
	const cards = new Cards(tab);
	const note = page.text("Loading...", COLORS.dim);
	const list = page.group(4);
	let loading = false;
	let busy = false;
	let playersHere = 0;

	const act = (label: string, op: string, payload: unknown, doneText: string) => {
		if (busy) return;
		busy = true;
		setResult(`${label}...`, COLORS.dim);
		spawnIn(trove, () => {
			const [ok, reply] = deps.call(op, payload);
			busy = false;
			if (succeeded(ok, reply)) setResult(doneText, COLORS.good);
			else setResult(`Failed: ${errorText(reply)}`, COLORS.bad);
		});
	};

	const drawServer = (server: AdminServer) => {
		const row = list.place(
			make("Frame", {
				BackgroundColor3: server.here ? COLORS.button : COLORS.row,
				BorderSizePixel: 0,
				Size: UDim2.fromScale(1, 0),
				AutomaticSize: Enum.AutomaticSize.Y,
			}),
		);
		corner(row, 6);
		pad(row, 6, 8);
		const left = make(
			"Frame",
			{ BackgroundTransparency: 1, Size: new UDim2(1, -(SERVER_ACTION + 8), 0, 0), AutomaticSize: Enum.AutomaticSize.Y },
			row,
		);
		verticalList(left, 2);
		const top = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, 20), LayoutOrder: 1 }, left);
		// The short JobId; focusing it shows the full id selected, ready to copy.
		const short = server.jobId.sub(1, 8);
		const idBox = style(
			make("TextBox", { BackgroundTransparency: 1, ClearTextOnFocus: false, TextEditable: false }, top),
			short,
			15,
			COLORS.text,
			Enum.Font.Code,
		);
		idBox.TextWrapped = false;
		idBox.ClipsDescendants = true;
		idBox.Size = new UDim2(0, ID_WIDTH, 1, 0);
		let tags = tag(server.type.upper(), COLORS.info);
		if (server.here) tags = tag("HERE", COLORS.accent) + tags;
		const tagLabel = style(make("TextLabel", { BackgroundTransparency: 1, RichText: true }, top), tags, 14);
		tagLabel.TextWrapped = false;
		tagLabel.TextTruncate = Enum.TextTruncate.AtEnd;
		tagLabel.Position = UDim2.fromOffset(ID_WIDTH, 0);
		tagLabel.Size = new UDim2(1, -ID_WIDTH, 1, 0);
		idBox.Focused.Connect(() => {
			idBox.Text = server.jobId;
			idBox.Size = UDim2.fromScale(1, 1);
			tagLabel.Visible = false;
			idBox.SelectionStart = 1;
			idBox.CursorPosition = server.jobId.size() + 1;
		});
		idBox.FocusLost.Connect(() => {
			idBox.Text = short;
			idBox.Size = new UDim2(0, ID_WIDTH, 1, 0);
			tagLabel.Visible = true;
		});
		let lineTwo = `${server.players}/${server.maxPlayers}  up ${duration(server.uptime)}`;
		if (!server.here && server.age > 90) lineTwo += `  seen ${duration(server.age)} ago`;
		const detail = style(
			make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 2 }, left),
			`${server.branch ?? "?"} (${server.channel ?? "?"})  ${server.artifact ?? "-"}\n${lineTwo}`,
			14,
			COLORS.dim,
		);
		detail.Size = UDim2.fromScale(1, 0);
		detail.AutomaticSize = Enum.AutomaticSize.Y;

		if (server.joinable) {
			const join = style(make("TextButton", { AutoButtonColor: true }, row), "Join", 15, COLORS.dark, Enum.Font.BuilderSansMedium);
			join.TextXAlignment = Enum.TextXAlignment.Center;
			join.TextWrapped = false;
			join.BackgroundColor3 = COLORS.accent;
			join.AnchorPoint = new Vector2(1, 0);
			join.Position = UDim2.fromScale(1, 0);
			join.Size = UDim2.fromOffset(SERVER_ACTION, BUTTON_HEIGHT);
			corner(join, 6);
			join.Activated.Connect(() => act(`Joining ${short}`, "admin.join", { jobId: server.jobId }, "Teleporting..."));
		} else {
			const state = style(
				make("TextLabel", { BackgroundTransparency: 1 }, row),
				server.here ? "Here" : "Locked",
				14,
				COLORS.dim,
				Enum.Font.BuilderSansMedium,
			);
			state.TextXAlignment = Enum.TextXAlignment.Center;
			state.TextWrapped = false;
			state.AnchorPoint = new Vector2(1, 0);
			state.Position = UDim2.fromScale(1, 0);
			state.Size = UDim2.fromOffset(SERVER_ACTION, BUTTON_HEIGHT);
		}
	};

	const load = () => {
		if (loading) return;
		loading = true;
		spawnIn(trove, () => {
			const [ok, reply] = deps.call("admin.servers");
			loading = false;
			if (!ok || !typeIs(reply, "table")) {
				note.Text = `Failed: ${errorText(reply)}`;
				note.TextColor3 = COLORS.bad;
				return;
			}
			const data = reply as AdminServersReply;
			footButtons.Visible = data.you.admin;
			list.clear();
			const count = data.servers.size();
			note.Text = `${count}${data.truncated ? "+" : ""} server${count === 1 ? "" : "s"}${
				data.error !== undefined ? `  (list failed: ${data.error})` : ""
			}`;
			note.TextColor3 = data.error !== undefined ? COLORS.warn : COLORS.dim;
			for (const server of data.servers) {
				if (server.here) playersHere = server.players;
				drawServer(server);
			}
		});
	};

	const openShutdown = () =>
		cards.open((card, close, cardTrove) => {
			cardTitle(card, "Shut down this server?", `Kicks ${playersHere} player${playersHere === 1 ? "" : "s"}`);
			const status = cardStatus(card);
			const buttons = card.buttons();
			addButton(buttons, "Cancel", close);
			spacer(buttons);
			let sending = false;
			armButton(buttons, "Shut down", COLORS.bad, () => {
				if (sending) return;
				sending = true;
				status("Shutting down...", COLORS.dim);
				spawnIn(cardTrove, () => {
					const [ok, reply] = deps.call("admin.shutdown");
					sending = false;
					if (succeeded(ok, reply)) {
						setResult("Shutting down", COLORS.warn);
						close();
					} else {
						status(`Failed: ${errorText(reply)}`, COLORS.bad);
					}
				});
			});
		});

	addButton(bar, "Refresh", load);
	addButton(bar, "New server", () => act("Opening a server", "admin.newServer", undefined, "Teleporting..."));
	spacer(footButtons);
	colorButton(footButtons, "Shut down", COLORS.bad, openShutdown);
	every(trove, SERVERS_REFRESH, load);
}

/** A colored action button (dark text) without arming: its card asks for the confirmations. */
function colorButton(row: Instance, label: string, color: Color3, onClick: () => void): TextButton {
	const button = addButton(row, label, onClick, color);
	button.TextColor3 = COLORS.dark;
	return button;
}

// Bans ----------------------------------------------------------------------------------------------------------------

function renderBans(tab: AdminTab, deps: AdminDeps) {
	const { page, trove } = tab;
	const [statusOk, info] = pcall(() => deps.kernel.devStatus());
	const role = statusOk && typeIs(info, "table") ? info.role : undefined;
	if (role !== "owner" && role !== "admin") {
		// Cosmetic: the server refuses these ops for non-admins anyway.
		page.text("Admins only", COLORS.dim);
		return;
	}

	page.section("Unban");
	const unbanRow = page.buttons();
	const unbanBox = searchBox(unbanRow, "User id", 110);
	const unbanStatus = page.text("", COLORS.dim);
	unbanStatus.Visible = false;
	const setUnban = (text: string, color: Color3) => {
		unbanStatus.Text = text;
		unbanStatus.TextColor3 = color;
		unbanStatus.Visible = true;
		bump(unbanStatus);
	};
	let unbanning = false;
	addButton(unbanRow, "Unban", () => {
		const userId = parseUserId(unbanBox.Text);
		if (userId === undefined) return setUnban("Enter a user id", COLORS.bad);
		if (unbanning) return;
		unbanning = true;
		setUnban(`Unbanning ${userId}...`, COLORS.dim);
		spawnIn(trove, () => {
			const [ok, reply] = deps.call("admin.unban", { userId });
			unbanning = false;
			if (succeeded(ok, reply)) setUnban(`Unbanned ${userId}`, COLORS.good);
			else setUnban(`Failed: ${errorText(reply)}`, COLORS.bad);
		});
	});

	page.section("History");
	const historyRow = page.buttons();
	const historyBox = searchBox(historyRow, "User id", 110);
	const results = page.group(4);
	let looking = false;
	addButton(historyRow, "Look up", () => {
		const userId = parseUserId(historyBox.Text);
		results.clear();
		if (userId === undefined) {
			results.text("Enter a user id", COLORS.bad);
			return;
		}
		if (looking) return;
		looking = true;
		results.text("Loading...", COLORS.dim);
		spawnIn(trove, () => {
			const [ok, reply] = deps.call("admin.history", { userId });
			looking = false;
			results.clear();
			if (!ok || !typeIs(reply, "table")) {
				results.text(`Failed: ${errorText(reply)}`, COLORS.bad);
				return;
			}
			const entries = [...(reply as AdminBanEntry[])];
			if (entries.size() === 0) {
				results.text("No bans", COLORS.dim);
				return;
			}
			// Newest first (ISO times sort as text).
			entries.sort((a, b) => (a.start ?? "") > (b.start ?? ""));
			for (const entry of entries) {
				let title = (entry.ban ? tag("BAN", COLORS.bad) : tag("UNBAN", COLORS.good)).sub(2);
				const length = entry.ban ? banLength(entry.duration) : "";
				if (length !== "") title += `  ${escapeRich(length)}`;
				const lines = [entry.start !== undefined ? entry.start.sub(1, 16).gsub("T", " ")[0] : "-"];
				if (entry.displayReason !== undefined && entry.displayReason !== "") lines.push(`Shown: ${entry.displayReason}`);
				if (entry.privateReason !== undefined && entry.privateReason !== "") lines.push(`Note: ${entry.privateReason}`);
				results.row(title, escapeRich(lines.join("\n")));
			}
		});
	});
}
