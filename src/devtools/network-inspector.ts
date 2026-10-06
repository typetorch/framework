import { UserInputService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ClientKernel } from "../kernel";
import { PACKET_CAPACITY, PacketPage, PacketRecord, PacketStatus, PacketSummary, PacketTap } from "../net/inspect";
import type { ClientDispatcher } from "../net/runtime";
import {
	addButton,
	COLORS,
	copyText,
	corner,
	escapeRich,
	hex,
	make,
	pad,
	Page,
	paintSelected,
	playerSelector,
	scrolling,
	searchBox,
	spacer,
	style,
	buttonRow,
	verticalList,
} from "./widgets";

/**
 * Network > Packets: a packet inspector (remote spy) for the framework's typed network (plans/10).
 *
 * - **Client** realm: this client's own traffic, captured locally (net/inspect.ts) while the tab is open.
 * - **Server** realm: every player's traffic, captured on the server only while a dev polls it
 *   (devtools/network-server.ts; dev-only, read-only, stops 60 s after the last poll). Polled once a second.
 *
 * The list is virtualized (a pool of row slots over a ScrollingFrame whose CanvasSize this file sets, like the
 * explorer tree); everything else is script-free. A row opens its pretty-printed payload. "Block" (client realm,
 * dev-channel servers) drops one path's messages on this client until the last Packets pane closes.
 *
 * **Several panes share one feed** (plans/10 "Panes and windows"): one client capture and one server poll (the server
 * refuses polls closer than 0.5 s per dev, and `net.stop` ends that dev's capture for every pane), with the rows kept
 * once per realm. Each pane has its own realm, filters, player, Pause (it freezes that pane; the feed stops when every
 * pane is paused) and Clear (it hides older rows in that pane only). The player filter works on the client.
 */

type Realm = "client" | "server";
type Direction = "both" | "in" | "out";

export interface InspectorTab {
	/** Cleaned on tab switch, window close and swap. */
	readonly trove: Trove;
	/** The tab's scrolling content: hidden while the inspector (which scrolls by itself) shows. */
	readonly content: ScrollingFrame;
	/** A sticky button row above the content. */
	readonly toolbar: () => Frame;
}

export interface InspectorDeps {
	readonly kernel: ClientKernel;
	readonly dispatcher: ClientDispatcher;
	/** One dev op on the server; yields until it answers. */
	readonly call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
	/** This pane's remembered realm and filters (client.ts: per pane); defaults to one shared persist store. */
	readonly persist?: object;
}

/** Remembered across swaps (kernel persist store). */
interface InspectorPersist {
	realm?: Realm;
	dir?: Direction;
	rejected?: boolean;
}

/** A list row: a summary, plus the full arguments once known (client rows always; server rows once opened). */
type Row = PacketSummary & { args?: string };

interface View {
	rows: Row[];
	cursor: number;
	/** The server tap's session (it changes when the server swaps). */
	session?: string;
	skipped: number;
	dropped: number;
	/** Bumped when the rows start over (a new server tap): panes reset their Clear point and selection. */
	resets: number;
}

interface Slot {
	button: TextButton;
	strip: Frame;
	time: TextLabel;
	arrowIn: Frame;
	arrowOut: Frame;
	path: TextLabel;
	player: TextLabel;
	size: TextLabel;
	row?: Row;
}

const TOUCH = UserInputService.TouchEnabled && !UserInputService.MouseEnabled;
/** List row height: 22 px with a mouse, 30 px touch targets on phones. */
const ROW = TOUCH ? 30 : 22;
/** Seconds between server polls (at most one a second; the server refuses polls closer than 0.5 s). */
const POLL = 1;
const LOCAL_REFRESH = 0.5;
const TOP = 4;
const TIME_WIDTH = 104;
const SIZE_WIDTH = 72;
const PLAYER_WIDTH = 110;
const ARROW = 16;
/** List and detail side by side from this width; stacked below it (phones). */
const WIDE = 640;
const GAP = 8;
const PANE = Color3.fromRGB(28, 31, 38);
const SELECTION = Color3.fromRGB(60, 74, 104);
const LATE = "(late response)";

const STATUS_COLORS: Record<PacketStatus, Color3> = {
	ok: COLORS.good,
	rejected: COLORS.bad,
	limited: COLORS.warn,
	error: COLORS.bad,
	blocked: COLORS.dim,
};

const DIRECTION_LABELS: Record<Direction, string> = { both: "In+Out", in: "In", out: "Out" };
const NEXT_DIRECTION: Record<Direction, Direction> = { both: "in", in: "out", out: "both" };

// The shared feed ----------------------------------------------------------------------------------------------------
// Per generation (this module is required fresh by every generation): the client capture and both views survive pane
// closes, so reopening the page shows what was there.
let clientTap: PacketTap | undefined;
const newView = (): View => ({ rows: [], cursor: 0, skipped: 0, dropped: 0, resets: 0 });
const views: Record<Realm, View> = { client: newView(), server: newView() };

/** A Packets pane watching the feed. */
interface Watcher {
	realm: () => Realm;
	paused: () => boolean;
	/** New rows, a restart or a problem in `realm`. */
	changed: (realm: Realm) => void;
}
const watchers = new Set<Watcher>();
let feedThread: thread | undefined;
let feedDeps: InspectorDeps | undefined;
let serverWatching = false;
/** Bumped when the server poll stops: a reply still on its way is dropped. */
let pollEpoch = 0;
let lastPoll = -math.huge;
let lastDropped = 0;
/** The server poll's last problem and the server's channel (every server pane shows them). */
let serverProblem: string | undefined;
let serverChannel: string | undefined;

function notify(realm: Realm) {
	for (const watcher of [...watchers]) {
		if (watcher.realm() !== realm) continue;
		const [ok, err] = pcall(() => watcher.changed(realm));
		if (!ok) $warn(`[devtools] packets pane failed: ${err}`);
	}
}

function anyActive(): boolean {
	for (const watcher of watchers) if (!watcher.paused()) return true;
	return false;
}

function wantsServer(): boolean {
	for (const watcher of watchers) if (!watcher.paused() && watcher.realm() === "server") return true;
	return false;
}

function appendRows(view: View, rows: Row[]) {
	for (const row of rows) view.rows.push(row);
	const extra = view.rows.size() - PACKET_CAPACITY;
	if (extra <= 0) return;
	const kept = new Array<Row>();
	for (let index = extra; index < view.rows.size(); index++) kept.push(view.rows[index]);
	view.rows = kept;
}

function restartServerView() {
	const view = views.server;
	view.rows = [];
	view.cursor = 0;
	view.skipped = 0;
	view.resets += 1;
}

/** Ends this dev's server capture (no pane wants it). Not in a trove: it must still go out while the last pane closes. */
function stopServer() {
	if (!serverWatching) return;
	serverWatching = false;
	pollEpoch += 1;
	const call = feedDeps?.call;
	if (call) task.spawn(() => call("net.stop"));
}

function pollServer(call: InspectorDeps["call"]) {
	const view = views.server;
	const mine = pollEpoch;
	serverWatching = true;
	const [ok, reply] = call("net.packets", { since: view.cursor });
	if (mine !== pollEpoch) return;
	if (!ok || !typeIs(reply, "table")) {
		if (reply !== "rate_limited") {
			serverProblem = `Server: ${tostring(reply)}`;
			notify("server");
		}
		return;
	}
	serverProblem = undefined;
	const page = reply as PacketPage;
	serverChannel = page.channel;
	if (view.session !== page.session) {
		const restarted = view.session !== undefined && view.cursor > 0;
		view.session = page.session;
		if (restarted) {
			// The server swapped (a new ring): start over next poll.
			restartServerView();
			notify("server");
			return;
		}
	}
	view.cursor = page.next;
	view.skipped += page.skipped;
	view.dropped = page.dropped;
	if (page.packets.size() > 0) appendRows(view, page.packets);
	notify("server");
}

function pullLocal(tap: PacketTap) {
	const view = views.client;
	const [records, cursor, skipped] = tap.since(view.cursor, PACKET_CAPACITY);
	view.cursor = cursor;
	view.skipped += skipped;
	if (records.size() > 0) appendRows(view, records);
	if (records.size() > 0 || tap.dropped !== lastDropped) {
		lastDropped = tap.dropped;
		notify("client");
	}
}

/** Polls the server only now and then: the next loop turn does it at once (a pane switched to the server realm). */
function pollSoon() {
	lastPoll = -math.huge;
}

/** One loop for every pane: this client's capture twice a second, the server once a second while a pane shows it. */
function runFeed() {
	if (feedThread !== undefined) return;
	feedThread = task.spawn(() => {
		let lastLocal = -math.huge;
		while (watchers.size() > 0) {
			const [ok, err] = pcall(() => {
				const tap = clientTap;
				const deps = feedDeps;
				if (!tap || !deps) return;
				const active = anyActive();
				tap.recording = active;
				if (active && os.clock() - lastLocal >= LOCAL_REFRESH) {
					lastLocal = os.clock();
					pullLocal(tap);
				}
				if (!wantsServer()) stopServer();
				else if (os.clock() - lastPoll >= POLL) {
					lastPoll = os.clock();
					pollServer(deps.call);
				}
			});
			if (!ok) $warn(`[devtools] packets refresh failed: ${err}`);
			task.wait(0.1);
		}
		feedThread = undefined;
	});
}

/** A pane starts watching: the client tap goes on the dispatcher (capture starts) and the loop runs. */
function attach(deps: InspectorDeps, watcher: Watcher): PacketTap {
	feedDeps = deps;
	const tap = clientTap ?? new PacketTap();
	clientTap = tap;
	tap.recording = true;
	deps.dispatcher.tap = tap;
	watchers.add(watcher);
	runFeed();
	return tap;
}

/** A pane stops watching; the last one ends both captures and every block. */
function detach(watcher: Watcher) {
	watchers.delete(watcher);
	if (watchers.size() > 0) return;
	stopServer();
	const tap = clientTap;
	const deps = feedDeps;
	if (tap && deps && deps.dispatcher.tap === tap) deps.dispatcher.tap = undefined;
	tap?.blocked.clear();
}

function clock(t: number): string {
	return `${os.date("%H:%M:%S", math.floor(t / 1000))}.${"%03d".format(t % 1000)}`;
}

function sizeText(row: PacketSummary): string {
	const text = row.bytes < 1024 ? `${row.bytes} B` : "%.1f KB".format(row.bytes / 1024);
	return row.approx ? `${text}+` : text;
}

function metaText(row: PacketSummary): string {
	const lines = [`${row.dir}  ${row.kind}  #${row.i}  ${clock(row.t)}`];
	if (row.player !== undefined) lines.push(row.userId !== undefined ? `${row.player} (${row.userId})` : row.player);
	lines.push(`${row.status}${row.reason !== undefined ? `: ${row.reason}` : ""}  ${sizeText(row)}`);
	return lines.join("\n");
}

/** A left or right arrow drawn from three Frames (no glyphs), 16 x 16, vertically centered at `x`. */
function arrow(parent: Instance, right: boolean, color: Color3): Frame {
	const holder = make(
		"Frame",
		{ BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 0.5), Size: UDim2.fromOffset(ARROW, ARROW), Visible: false },
		parent,
	);
	const bar = (x: number, y: number, length: number, rotation: number) =>
		make(
			"Frame",
			{
				BackgroundColor3: color,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromOffset(x, y),
				Size: UDim2.fromOffset(length, 2),
				Rotation: rotation,
			},
			holder,
		);
	const side = right ? 1 : -1;
	bar(8, 8, 11, 0);
	bar(8 + side * 3.4, 5.9, 6, side * 45);
	bar(8 + side * 3.4, 10.1, 6, -side * 45);
	return holder;
}

export function renderNetworkInspector(tab: InspectorTab, deps: InspectorDeps) {
	const { trove, content } = tab;
	const { kernel, call } = deps;
	const persist = (deps.persist as InspectorPersist | undefined) ?? kernel.persist<InspectorPersist>("typetorch/netinspect", () => ({}));
	let realm: Realm = persist.realm === "server" ? "server" : "client";
	let direction: Direction = persist.dir === "in" || persist.dir === "out" ? persist.dir : "both";
	let rejectedOnly = persist.rejected === true;
	let query = "";
	let paused = false;
	let playerFilter: number | undefined;
	let selected: Row | undefined;
	let detailEpoch = 0;
	let follow = true;
	let alive = true;
	trove.add(() => {
		alive = false;
	});
	/** Clear in this pane only: rows up to this sequence number stay hidden (per realm, until the rows start over). */
	const floor: Record<Realm, number> = { client: 0, server: 0 };
	const seenResets: Record<Realm, number> = { client: views.client.resets, server: views.server.resets };
	let onChanged: (realm: Realm) => void = () => {};
	const watcher: Watcher = {
		realm: () => realm,
		paused: () => paused,
		changed: (changed) => onChanged(changed),
	};
	// Capture: this client records while any Packets pane is open; blocks last only that long too.
	const tap = attach(deps, watcher);
	trove.add(() => detach(watcher));

	// Layout ------------------------------------------------------------------------------------------------------

	const bar = tab.toolbar();
	const host = trove.add(make("Frame", { Name: "Packets", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), LayoutOrder: 3 }));
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, host);
	make("UIPadding", { PaddingTop: new UDim(0, 4), PaddingLeft: new UDim(0, 10), PaddingRight: new UDim(0, 10) }, host);
	verticalList(host, 6);
	host.Parent = content.Parent;
	content.Visible = false;
	trove.add(() => {
		content.Visible = true;
	});

	const note = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 1, Visible: false }, host), "Prod server: read-only, devs only", 14, COLORS.dim);
	note.Size = new UDim2(1, 0, 0, 18);
	note.TextWrapped = false;
	note.TextTruncate = Enum.TextTruncate.AtEnd;

	const main = make("Frame", { Name: "Main", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), LayoutOrder: 2 }, host);
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, main);

	const status = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 3 }, host), "", 14, COLORS.dim, Enum.Font.Code);
	status.Size = new UDim2(1, 0, 0, 20);
	status.TextWrapped = false;
	status.TextTruncate = Enum.TextTruncate.AtEnd;

	const listPane = make("Frame", { Name: "List", BackgroundColor3: PANE, BorderSizePixel: 0, ClipsDescendants: true, Size: UDim2.fromScale(1, 1) }, main);
	corner(listPane, 6);
	// The one ScrollingFrame here that sets CanvasSize itself (virtualized: rows x ROW px, drawn by a pool of slots).
	const list = make(
		"ScrollingFrame",
		{
			BackgroundTransparency: 1,
			BorderSizePixel: 0,
			Size: UDim2.fromScale(1, 1),
			CanvasSize: new UDim2(),
			AutomaticCanvasSize: Enum.AutomaticSize.None,
			ScrollingDirection: Enum.ScrollingDirection.Y,
			ScrollBarThickness: 6,
			ScrollBarImageColor3: COLORS.dim,
			VerticalScrollBarInset: Enum.ScrollBarInset.ScrollBar,
		},
		listPane,
	);
	const empty = style(make("TextLabel", { BackgroundTransparency: 1, Visible: false }, listPane), "No packets yet", 15, COLORS.dim);
	empty.TextXAlignment = Enum.TextXAlignment.Center;
	empty.Size = UDim2.fromScale(1, 1);

	// Detail: [Copy][Block] ... [Close] / path / meta / payload (script-free scrolling, padded inner Frame).
	const detailPane = make("Frame", { Name: "Detail", BackgroundColor3: PANE, BorderSizePixel: 0, ClipsDescendants: true, Visible: false }, main);
	corner(detailPane, 6);
	const detail = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1) }, detailPane);
	pad(detail, 8, 10);
	verticalList(detail, 6);
	const actions = buttonRow();
	actions.LayoutOrder = 1;
	actions.Parent = detail;
	const copyButton = addButton(actions, "Copy", () => copy());
	const blockButton = addButton(actions, "Block", () => toggleBlock());
	spacer(actions);
	addButton(actions, "Close", () => choose(undefined));
	const title = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 2 }, detail), "", 15, COLORS.text, Enum.Font.BuilderSansBold);
	title.Size = UDim2.fromScale(1, 0);
	title.AutomaticSize = Enum.AutomaticSize.Y;
	const meta = style(make("TextLabel", { BackgroundTransparency: 1, LayoutOrder: 3 }, detail), "", 14, COLORS.dim, Enum.Font.Code);
	meta.Size = UDim2.fromScale(1, 0);
	meta.AutomaticSize = Enum.AutomaticSize.Y;
	const payloadScroll = scrolling(detail, { Name: "Payload", Size: UDim2.fromScale(1, 0), LayoutOrder: 4, BackgroundTransparency: 0, BackgroundColor3: COLORS.window });
	make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, payloadScroll);
	corner(payloadScroll, 4);
	const payloadFrame = make("Frame", { BackgroundTransparency: 1, Size: UDim2.fromScale(1, 0), AutomaticSize: Enum.AutomaticSize.Y }, payloadScroll);
	pad(payloadFrame, 6, 8);
	verticalList(payloadFrame, 0);
	// A read-only TextBox, so it can also be selected by hand.
	const payload = style(make("TextBox", { BackgroundTransparency: 1, ClearTextOnFocus: false, TextEditable: false, MultiLine: true }, payloadFrame), "", 14, COLORS.text, Enum.Font.Code);
	payload.Size = UDim2.fromScale(1, 0);
	payload.AutomaticSize = Enum.AutomaticSize.Y;
	payload.TextYAlignment = Enum.TextYAlignment.Top;

	/** Wide: list and detail side by side. Narrow (phones): the detail takes the whole area; Close goes back. */
	const layoutMain = () => {
		const wide = main.AbsoluteSize.X >= WIDE;
		listPane.Visible = !selected || wide;
		detailPane.Visible = selected !== undefined;
		listPane.Size = selected && wide ? new UDim2(0.55, -GAP / 2, 1, 0) : UDim2.fromScale(1, 1);
		detailPane.Position = wide ? new UDim2(0.55, GAP / 2, 0, 0) : UDim2.fromScale(0, 0);
		detailPane.Size = wide ? new UDim2(0.45, -GAP / 2, 1, 0) : UDim2.fromScale(1, 1);
	};
	trove.connect(main.GetPropertyChangedSignal("AbsoluteSize"), layoutMain);

	// List (virtualized) ------------------------------------------------------------------------------------------

	const slots = new Array<Slot>();
	let visible = new Array<Row>();
	let showTime = true;
	let showPlayer = false;
	let choose: (row: Row | undefined) => void;

	const placeSlot = (slot: Slot) => {
		let x = 10;
		slot.time.Visible = showTime;
		if (showTime) {
			slot.time.Position = UDim2.fromOffset(x, 0);
			x += TIME_WIDTH + 4;
		}
		slot.arrowIn.Position = new UDim2(0, x, 0.5, 0);
		slot.arrowOut.Position = new UDim2(0, x, 0.5, 0);
		x += ARROW + 6;
		let right = 6 + SIZE_WIDTH + 6;
		slot.player.Visible = showPlayer;
		if (showPlayer) {
			slot.player.Position = new UDim2(1, -(right + PLAYER_WIDTH), 0, 0);
			right += PLAYER_WIDTH + 6;
		}
		slot.path.Position = UDim2.fromOffset(x, 0);
		slot.path.Size = new UDim2(1, -(x + right), 1, 0);
	};

	const makeSlot = (): Slot => {
		const button = make(
			"TextButton",
			{
				Text: "",
				AutoButtonColor: false,
				BorderSizePixel: 0,
				BackgroundColor3: SELECTION,
				BackgroundTransparency: 1,
				Visible: false,
				Size: new UDim2(1, -4, 0, ROW),
			},
			list,
		);
		corner(button, 4);
		const strip = make(
			"Frame",
			{ BorderSizePixel: 0, BackgroundColor3: COLORS.good, Position: UDim2.fromOffset(3, 4), Size: new UDim2(0, 3, 1, -8) },
			button,
		);
		const label = (font: Enum.Font, color: Color3, width: number) => {
			const gui = style(make("TextLabel", { BackgroundTransparency: 1 }, button), "", 14, color, font);
			gui.TextWrapped = false;
			gui.TextTruncate = Enum.TextTruncate.AtEnd;
			gui.Size = new UDim2(0, width, 1, 0);
			return gui;
		};
		const time = label(Enum.Font.Code, COLORS.dim, TIME_WIDTH);
		const path = label(Enum.Font.BuilderSansMedium, COLORS.text, 100);
		path.RichText = true;
		const player = label(Enum.Font.BuilderSans, COLORS.dim, PLAYER_WIDTH);
		const size = label(Enum.Font.Code, COLORS.dim, SIZE_WIDTH);
		size.TextXAlignment = Enum.TextXAlignment.Right;
		size.AnchorPoint = new Vector2(1, 0);
		size.Position = new UDim2(1, -6, 0, 0);
		const slot: Slot = {
			button,
			strip,
			time,
			arrowIn: arrow(button, false, COLORS.info),
			arrowOut: arrow(button, true, COLORS.accent),
			path,
			player,
			size,
		};
		button.Activated.Connect(() => {
			if (slot.row) choose(slot.row === selected ? undefined : slot.row);
		});
		placeSlot(slot);
		return slot;
	};

	const bind = (slot: Slot, row: Row, index: number) => {
		slot.row = row;
		slot.button.Visible = true;
		slot.button.Position = UDim2.fromOffset(0, TOP + index * ROW);
		slot.button.BackgroundTransparency = row === selected ? 0 : 1;
		slot.strip.BackgroundColor3 = STATUS_COLORS[row.status];
		slot.time.Text = clock(row.t);
		slot.arrowIn.Visible = row.dir === "in";
		slot.arrowOut.Visible = row.dir === "out";
		const kind = row.kind !== "fire" ? `  <font color="${hex(COLORS.dim)}">${row.kind}</font>` : "";
		slot.path.Text = `${escapeRich(row.path)}${kind}`;
		slot.path.TextColor3 = row.status === "ok" ? COLORS.text : STATUS_COLORS[row.status];
		slot.player.Text = row.player ?? "";
		slot.size.Text = sizeText(row);
	};

	const bottom = () => math.max(0, visible.size() * ROW + TOP * 2 - list.AbsoluteWindowSize.Y);

	const render = () => {
		list.CanvasSize = UDim2.fromOffset(0, visible.size() * ROW + TOP * 2);
		const first = math.max(0, math.floor((list.CanvasPosition.Y - TOP) / ROW));
		slots.forEach((slot, index) => {
			const row = visible[first + index];
			if (row) bind(slot, row, first + index);
			else {
				slot.button.Visible = false;
				slot.row = undefined;
			}
		});
		empty.Visible = visible.size() === 0;
		empty.Text = paused ? "Paused" : "No packets yet";
	};

	const layoutColumns = () => {
		const width = list.AbsoluteWindowSize.X;
		showTime = width >= 380;
		showPlayer = realm === "server" && width >= 480;
		for (const slot of slots) placeSlot(slot);
	};

	const resizePool = () => {
		const need = math.ceil(list.AbsoluteWindowSize.Y / ROW) + 3;
		while (slots.size() < need) slots.push(makeSlot());
		layoutColumns();
		render();
		if (follow) list.CanvasPosition = new Vector2(0, bottom());
	};
	trove.connect(list.GetPropertyChangedSignal("AbsoluteWindowSize"), resizePool);
	trove.connect(list.GetPropertyChangedSignal("CanvasPosition"), () => {
		// Newest at the bottom: follow new packets unless the dev scrolled up.
		follow = list.CanvasPosition.Y >= bottom() - ROW / 2;
		render();
	});

	// Filtering -----------------------------------------------------------------------------------------------------

	const matches = (row: Row) => {
		if (row.i <= floor[realm]) return false;
		if (direction !== "both" && row.dir !== direction) return false;
		if (rejectedOnly && row.status !== "rejected" && row.status !== "limited") return false;
		if (realm === "server" && playerFilter !== undefined && row.userId !== playerFilter && row.player !== "all") return false;
		if (query === "") return true;
		if (row.path.lower().find(query, 1, true)[0] !== undefined) return true;
		return row.player !== undefined && row.player.lower().find(query, 1, true)[0] !== undefined;
	};

	const updateStatus = () => {
		const view = views[realm];
		const parts = new Array<string>();
		parts.push(visible.size() === view.rows.size() ? `${visible.size()} packets` : `${visible.size()} of ${view.rows.size()}`);
		if (paused) parts.push("paused");
		if (view.skipped > 0) parts.push(`${view.skipped} skipped`);
		const dropped = realm === "client" ? tap.dropped : view.dropped;
		if (dropped > 0) parts.push(`${dropped} over the rate cap`);
		if (tap.blocked.size() > 0) parts.push(`${tap.blocked.size()} blocked`);
		const problem = realm === "server" ? serverProblem : undefined;
		if (problem !== undefined) parts.push(problem);
		status.Text = parts.join("   ");
		status.TextColor3 = problem !== undefined ? COLORS.bad : paused || tap.blocked.size() > 0 ? COLORS.warn : COLORS.dim;
	};

	/** Re-filters and redraws, keeping the top row in place unless following the newest. */
	const refresh = () => {
		const first = math.max(0, math.floor((list.CanvasPosition.Y - TOP) / ROW));
		const anchor = follow ? undefined : visible[first];
		const offset = list.CanvasPosition.Y - (TOP + first * ROW);
		visible = views[realm].rows.filter(matches);
		render();
		if (follow) list.CanvasPosition = new Vector2(0, bottom());
		else if (anchor) {
			const index = visible.indexOf(anchor);
			if (index >= 0) list.CanvasPosition = new Vector2(0, math.min(bottom(), TOP + index * ROW + offset));
		}
		updateStatus();
	};

	// Detail ------------------------------------------------------------------------------------------------------

	const blockable = (row: Row) => realm === "client" && kernel.channel === "dev" && row.path !== LATE;
	const paintBlock = () => {
		const blocked = selected !== undefined && tap.blocked.has(selected.path);
		blockButton.Text = blocked ? "Unblock" : "Block";
		paintSelected(blockButton, blocked, COLORS.warn);
	};
	const toggleBlock = () => {
		if (!selected || !blockable(selected)) return;
		if (tap.blocked.has(selected.path)) tap.blocked.delete(selected.path);
		else tap.blocked.add(selected.path);
		paintBlock();
		updateStatus();
	};
	const copy = () => {
		if (!selected) return;
		copyText(`${selected.path}\n${metaText(selected)}\n\n${payload.Text}`, copyButton);
	};

	const showDetail = (row: Row) => {
		title.Text = row.path;
		meta.Text = metaText(row);
		meta.TextColor3 = row.status === "ok" ? COLORS.dim : STATUS_COLORS[row.status];
		blockButton.Visible = blockable(row);
		paintBlock();
	};

	choose = (row) => {
		selected = row;
		detailEpoch += 1;
		layoutMain();
		render();
		if (!row) return;
		showDetail(row);
		payloadScroll.CanvasPosition = Vector2.zero;
		if (row.args !== undefined) {
			payload.Text = row.args;
			return;
		}
		if (realm === "client") {
			payload.Text = tap.get(row.i)?.args ?? "Gone";
			return;
		}
		payload.Text = "Loading...";
		const mine = detailEpoch;
		trove.add(
			task.spawn(() => {
				const [ok, reply] = call("net.packet", row.i);
				if (!alive || mine !== detailEpoch) return;
				if (!ok || !typeIs(reply, "table")) {
					payload.Text = reply === "gone" ? "No longer on the server" : `Failed: ${tostring(reply)}`;
					return;
				}
				const record = reply as PacketRecord;
				row.args = typeIs(record.args, "string") ? record.args : "";
				// The outcome may have been filled in after the row was listed (a handler error).
				if (typeIs(record.status, "string") && STATUS_COLORS[record.status] !== undefined) row.status = record.status;
				row.reason = typeIs(record.reason, "string") ? record.reason : undefined;
				payload.Text = row.args;
				showDetail(row);
				render();
			}),
		);
	};

	// The feed's news ---------------------------------------------------------------------------------------------------

	const showNote = () => {
		note.Visible = realm === "server" && (serverChannel ?? kernel.channel) === "prod";
	};

	onChanged = (changed) => {
		if (!alive || changed !== realm) return;
		const view = views[changed];
		if (view.resets !== seenResets[changed]) {
			// The rows started over (a new server tap): this pane's Clear point and selection go with them.
			seenResets[changed] = view.resets;
			floor[changed] = 0;
			if (selected !== undefined) choose(undefined);
		}
		showNote();
		if (paused) updateStatus();
		else refresh();
	};

	// Player filter (server realm): a panel over the list, one at a time ---------------------------------------------

	let pickerTrove: Trove | undefined;
	let playerButton: TextButton;
	const closePicker = () => {
		if (pickerTrove) trove.remove(pickerTrove);
		pickerTrove = undefined;
	};
	const setPlayer = (player: Player | undefined) => {
		playerFilter = player?.UserId;
		playerButton.Text = player ? `@${player.Name.sub(1, 16)}` : "Player";
		paintSelected(playerButton, player !== undefined);
		closePicker();
		follow = true;
		choose(undefined);
		refresh();
	};
	const openPicker = () => {
		closePicker();
		const pickerT = trove.extend();
		pickerTrove = pickerT;
		const panel = pickerT.add(
			make(
				"Frame",
				{ Name: "PlayerPicker", Active: true, BackgroundColor3: PANE, BorderSizePixel: 0, Size: UDim2.fromScale(1, 1), ZIndex: 10 },
				main,
			),
		);
		corner(panel, 6);
		const scroller = scrolling(panel, { Size: UDim2.fromScale(1, 1) });
		const page = Page.mount(scroller, 4);
		pad(page.frame, 8, 10);
		page.link("All players", () => setPlayer(undefined));
		playerSelector(page, pickerT, { selected: playerFilter, onSelect: (player) => setPlayer(player) });
	};

	// Toolbar -------------------------------------------------------------------------------------------------------

	const realmButtons = new Map<Realm, TextButton>();
	let pauseButton: TextButton;
	let directionButton: TextButton;
	let rejectedButton: TextButton;

	const paintToolbar = () => {
		for (const [name, button] of realmButtons) paintSelected(button, name === realm);
		pauseButton.Text = paused ? "Resume" : "Pause";
		paintSelected(pauseButton, paused, COLORS.warn);
		directionButton.Text = DIRECTION_LABELS[direction];
		paintSelected(directionButton, direction !== "both");
		paintSelected(rejectedButton, rejectedOnly, COLORS.bad);
		playerButton.Visible = realm === "server";
		paintSelected(playerButton, playerFilter !== undefined);
	};

	const setRealm = (value: Realm) => {
		if (realm === value) return;
		realm = value;
		persist.realm = value;
		if (realm === "server") pollSoon();
		follow = true;
		closePicker();
		choose(undefined);
		showNote();
		paintToolbar();
		layoutColumns();
		refresh();
	};

	realmButtons.set("client", addButton(bar, "Client", () => setRealm("client")));
	realmButtons.set("server", addButton(bar, "Server", () => setRealm("server")));
	// Pause freezes this pane; the feed keeps running for the others (and stops when every pane is paused).
	pauseButton = addButton(bar, "Pause", () => {
		paused = !paused;
		if (!paused) {
			pollSoon();
			refresh();
		}
		paintToolbar();
		render();
		updateStatus();
	});
	// Clear hides what this pane shows so far; the rows stay for other panes.
	addButton(bar, "Clear", () => {
		const rows = views[realm].rows;
		floor[realm] = rows.size() > 0 ? rows[rows.size() - 1].i : floor[realm];
		follow = true;
		choose(undefined);
		refresh();
	});
	directionButton = addButton(bar, DIRECTION_LABELS[direction], () => {
		direction = NEXT_DIRECTION[direction];
		persist.dir = direction;
		follow = true;
		paintToolbar();
		refresh();
	});
	rejectedButton = addButton(bar, "Rejected", () => {
		rejectedOnly = !rejectedOnly;
		persist.rejected = rejectedOnly;
		follow = true;
		paintToolbar();
		refresh();
	});
	playerButton = addButton(bar, "Player", () => {
		if (pickerTrove) closePicker();
		else openPicker();
	});
	const search = searchBox(bar, "Path or player");
	trove.connect(search.GetPropertyChangedSignal("Text"), () => {
		query = search.Text.lower();
		follow = true;
		refresh();
	});

	paintToolbar();
	showNote();
	layoutMain();
	resizePool();
	refresh();
}
