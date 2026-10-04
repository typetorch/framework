import { HttpService, Players, UserInputService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ArtifactInfo, BranchInfo, ClientKernel, DevInfo, KernelStatus, LogEntry, SwapReport } from "../kernel";
import type { ClientDispatcher, LeafStats } from "../net/runtime";
import { runningModules } from "../runtime/registry";
import { popIn, popOut } from "../ui";
import { listChildren, listProperties, resolvePath, setProperty } from "./dex";
import {
	ClaudePromptRequest,
	ClaudeRequestView,
	ClaudeSessionView,
	DEV_REQUEST,
	DEV_RESPONSE,
	DexNode,
	DexProperty,
	ModuleSummary,
	NetStat,
	StateSummary,
} from "./protocol";
import { describeState } from "./state";

/**
 * Client half of the dev menu (plans/10), built in code. Only devs see it: the toggle button, Ctrl+Shift+D and
 * `/tt dev` all check the server's last word on dev status, and the server re-checks every request anyway.
 * Prod-channel servers are read-only (the server enforces it; the UI only hides edit controls).
 */

const REQUEST_TIMEOUT = 15;
const REFRESH = 2;
const CLAUDE_POLL = 2.5;
const MAX_LOG_ROWS = 300;
const HEADER = 46;
const TAB_WIDTH = 116;
const PERSIST_KEY = "typetorch/devtools";

const COLORS = {
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

const LOG_COLORS: Record<string, Color3> = {
	output: COLORS.text,
	info: COLORS.info,
	warning: COLORS.warn,
	error: COLORS.bad,
};

const CLAUDE_STATE_COLORS: Record<string, Color3> = {
	queued: COLORS.dim,
	running: COLORS.info,
	committed: COLORS.info,
	building: COLORS.info,
	deployed: COLORS.good,
	failed: COLORS.bad,
	cancelled: COLORS.dim,
	lost: COLORS.dim,
};

/** Short text for the remote-claude error codes of devtools/claude.ts. */
const CLAUDE_ERRORS: Record<string, string> = {
	not_connected: "Not connected: start `typetorch remote-claude` on this branch",
	no_secret: "Secret typetorch_remote_claude is missing",
	not_allowed: "not on the session's user list",
	prod_channel: "Prompts work on dev-channel servers only.",
	busy: "Wait for your running request",
	rate_limited: "Limit: 10 prompts per 10 min",
	empty: "Write a prompt first",
	too_long: "Prompt too long (4000 max)",
	context_too_large: "Attached context too large",
	unreachable: "Can't reach the dev machine",
	unauthorized: "Rejected by the dev machine",
	forbidden: "Rejected by the dev machine",
	remote_rate_limited: "Dev machine busy, try again",
	not_yours: "Only the requester can cancel",
	not_found: "Request not found",
};

function claudeError(code: unknown): string {
	if (typeIs(code, "string")) return CLAUDE_ERRORS[code] ?? `Failed: ${code}`;
	return "Failed";
}

interface ClaudeReply {
	ok?: boolean;
	error?: string;
	request?: ClaudeRequestView;
}

const TABS = ["Artifact", "Server", "Logs", "Dex", "Network", "State", "Branch", "Claude"] as const;
type TabName = (typeof TABS)[number];

interface StatusReply {
	server: KernelStatus;
	artifact: ArtifactInfo;
	modules: ModuleSummary[];
	you: DevInfo;
}

interface TabContext {
	readonly page: Page;
	/** Cleaned on tab switch and when the window closes. */
	readonly trove: Trove;
	readonly content: ScrollingFrame;
}

// Instance helpers ----------------------------------------------------------------------------------------------------

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

function corner(parent: Instance, radius: number) {
	make("UICorner", { CornerRadius: new UDim(0, radius) }, parent);
}

function pad(parent: Instance, vertical: number, horizontal: number) {
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

function style<T extends TextLabel | TextButton | TextBox>(
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

function verticalList(parent: Instance, gap: number) {
	make(
		"UIListLayout",
		{ FillDirection: Enum.FillDirection.Vertical, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, gap) },
		parent,
	);
}

/** Script-free scrolling (user UI rule): AutomaticCanvasSize + a layout; Lua never touches CanvasSize. */
function scrolling(parent: Instance, props: Partial<WritableInstanceProperties<ScrollingFrame>>): ScrollingFrame {
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

function addButton(row: Instance, text: string, onClick: () => void, color = COLORS.button): TextButton {
	const button = style(make("TextButton", { AutoButtonColor: true }), text, 15, COLORS.text, Enum.Font.BuilderSansMedium);
	button.TextXAlignment = Enum.TextXAlignment.Center;
	button.TextWrapped = false;
	button.BackgroundColor3 = color;
	button.Size = UDim2.fromOffset(0, 34);
	button.AutomaticSize = Enum.AutomaticSize.X;
	button.LayoutOrder = row.GetChildren().size();
	corner(button, 6);
	pad(button, 0, 12);
	button.Parent = row;
	button.Activated.Connect(onClick);
	return button;
}

/** One column of rows inside the content ScrollingFrame. Rows are rebuilt freely; the layout sizes everything. */
class Page {
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
		const row = this.place(
			make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, 34), AutomaticSize: Enum.AutomaticSize.Y }),
		);
		make(
			"UIListLayout",
			{
				FillDirection: Enum.FillDirection.Horizontal,
				SortOrder: Enum.SortOrder.LayoutOrder,
				Padding: new UDim(0, 6),
				Wraps: true,
			},
			row,
		);
		return row;
	}

	/** A full-width clickable row (dex children). */
	link(text: string, onClick: () => void): TextButton {
		const button = style(make("TextButton", { AutoButtonColor: true }), text, 15);
		button.BackgroundColor3 = COLORS.row;
		button.TextWrapped = false;
		button.TextTruncate = Enum.TextTruncate.AtEnd;
		button.Size = new UDim2(1, 0, 0, 34);
		corner(button, 4);
		pad(button, 0, 8);
		button.Activated.Connect(onClick);
		return this.place(button);
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

// Formatting --------------------------------------------------------------------------------------------------------

function str(value: unknown): string {
	if (value === undefined) return "-";
	if (typeIs(value, "string")) return value === "" ? "-" : value;
	if (typeIs(value, "number") || typeIs(value, "boolean")) return tostring(value);
	const [ok, json] = pcall(() => HttpService.JSONEncode(value));
	return ok ? json : tostring(value);
}

function duration(seconds: unknown): string {
	if (!typeIs(seconds, "number")) return "-";
	const total = math.max(0, math.floor(seconds));
	const hours = math.floor(total / 3600);
	const minutes = math.floor((total % 3600) / 60);
	if (hours > 0) return "%dh %02dm %02ds".format(hours, minutes, total % 60);
	if (minutes > 0) return "%dm %02ds".format(minutes, total % 60);
	return `${total}s`;
}

function utc(unix: unknown): string {
	if (!typeIs(unix, "number")) return str(unix);
	return `${DateTime.fromUnixTimestamp(unix).FormatUniversalTime("YYYY-MM-DD HH:mm:ss", "en-us")} UTC`;
}

function seconds(value: unknown): string {
	return typeIs(value, "number") ? "%.2f s".format(value) : "-";
}

function ms(value: unknown): string {
	return typeIs(value, "number") ? `${math.floor(value * 1000)} ms` : "-";
}

function swapText(ok: boolean, reply: unknown): [string, Color3] {
	if (!ok) return [`Failed: ${str(reply)}`, COLORS.bad];
	if (!typeIs(reply, "table")) return ["Done", COLORS.good];
	const report = reply as SwapReport;
	if (report.ok) return [report.generation !== undefined ? `Running ${report.generation}` : "Done", COLORS.good];
	if (report.queued) return ["Queued behind another swap", COLORS.warn];
	return [`Failed: ${report.error ?? "unknown error"}`, COLORS.bad];
}

function statLine(stat: LeafStats, previous: [number, number, number] | undefined, now: number): string {
	let line = `in ${stat.inbound}  out ${stat.outbound}  rejected ${stat.rejected}  errors ${stat.errors}`;
	if (previous) {
		const elapsed = now - previous[2];
		if (elapsed > 0) {
			line += `  (${"%.1f".format((stat.inbound - previous[0]) / elapsed)}/s in, ${"%.1f".format(
				(stat.outbound - previous[1]) / elapsed,
			)}/s out)`;
		}
	}
	return line;
}

function spawnIn(trove: Trove, callback: () => void) {
	trove.add(task.spawn(callback));
}

/** Runs `callback` now and every `interval` seconds until `trove` is cleaned. Errors are logged, not fatal. */
function every(trove: Trove, interval: number, callback: () => void) {
	spawnIn(trove, () => {
		while (true) {
			const [ok, err] = pcall(callback);
			if (!ok) $warn(`[devtools] refresh failed: ${err}`);
			task.wait(interval);
		}
	});
}

// The menu ----------------------------------------------------------------------------------------------------------

interface Ui {
	gui: ScreenGui;
	toggle: TextButton;
	window: Frame;
	content: ScrollingFrame;
	tabButtons: Map<TabName, TextButton>;
}

interface Waiter {
	thread: thread;
	timeout: thread;
}

/**
 * Starts the dev menu for this client generation. Everything it creates or connects lives in `trove`, so a swap
 * removes it; the open state and tab survive the swap through the kernel persist store.
 */
export function startDevtoolsClient(kernel: ClientKernel, dispatcher: ClientDispatcher, trove: Trove) {
	const state = kernel.persist(PERSIST_KEY, () => ({ open: false, tab: "Artifact" as string }));

	// Requests ------------------------------------------------------------------------------------------------------
	// Random start: a response addressed to the previous generation can't match one of ours after a swap.
	let nextId = math.random(1, 2 ** 30);
	const waiters = new Map<number, Waiter>();

	const resume = (id: number, ok: boolean, result: unknown) => {
		const waiter = waiters.get(id);
		if (!waiter) return;
		waiters.delete(id);
		if (coroutine.status(waiter.timeout) === "suspended") task.cancel(waiter.timeout);
		// The waiting thread is gone if its tab closed meanwhile.
		if (coroutine.status(waiter.thread) === "suspended") task.spawn(waiter.thread, ok, result);
	};

	/** Sends one dev op and yields until the server answers (or 15 s pass). Call from a spawned thread. */
	const call = (op: string, payload?: unknown): [ok: boolean, result: unknown] => {
		nextId += 1;
		const id = nextId;
		const thread = coroutine.running();
		const timeout = task.delay(REQUEST_TIMEOUT, () => resume(id, false, "the server didn't answer in time"));
		waiters.set(id, { thread, timeout });
		kernel.send(DEV_REQUEST, id, op, payload);
		const [ok, result] = coroutine.yield() as LuaTuple<[boolean, unknown]>;
		return [ok === true, result];
	};

	dispatcher.setRaw(DEV_RESPONSE, (id, ok, result) => {
		if (typeIs(id, "number")) resume(id, ok === true, result);
	});
	trove.add(() => {
		dispatcher.removeRaw(DEV_RESPONSE);
		for (const [, waiter] of waiters) {
			if (coroutine.status(waiter.timeout) === "suspended") task.cancel(waiter.timeout);
		}
		waiters.clear();
	});

	// Tabs ------------------------------------------------------------------------------------------------------------

	const renderArtifact = ({ page, trove: tabTrove }: TabContext) => {
		page.section("Client");
		page.field("Artifact", kernel.artifact.id);
		page.field("Generation", `#${kernel.generation}`);
		page.field("Branch", str(kernel.branch));
		page.field("Channel", str(kernel.channel));
		page.field("Kernel", `${kernel.kernelVersion} (API ${kernel.kernelApi})`);
		page.section("Client modules");
		if (runningModules.size() === 0) page.text("None", COLORS.dim);
		for (const running of runningModules) {
			const init = running.initSeconds !== undefined ? `init ${ms(running.initSeconds)}` : "no onInit";
			const deps = running.dependencies.size() > 0 ? `, needs ${running.dependencies.join(", ")}` : "";
			page.field(running.name, init + deps);
		}
		const server = page.group();
		server.text("Loading server...", COLORS.dim);
		spawnIn(tabTrove, () => {
			const [ok, reply] = call("status");
			server.clear();
			if (!ok || !typeIs(reply, "table")) {
				server.text(`Server: ${str(reply)}`, COLORS.bad);
				return;
			}
			const { artifact, modules, server: status } = reply as StatusReply;
			server.section("Server artifact");
			server.field("Id", str(artifact.id));
			server.field("Channel", str(artifact.channel));
			server.field("Branch", str(artifact.branch));
			server.field("Commit", str(artifact.commit));
			server.field("Commit hash", str(artifact.commitHash));
			server.field("Asset id", str(artifact.assetId));
			server.field("Seq", str(artifact.seq));
			server.field("Built", utc(artifact.builtAt));
			server.section("Server generation");
			server.field("Generation", status.generation ? `${status.generation.name} (#${status.generation.number})` : "-");
			server.field("Kernel", `${status.kernelVersion} (API ${status.kernelApi})`);
			server.section("Server modules");
			if (modules.size() === 0) server.text("None", COLORS.dim);
			for (const mod of modules) {
				const init = mod.initMs !== undefined ? `init ${mod.initMs} ms` : "no onInit";
				const deps = mod.dependencies.size() > 0 ? `, needs ${mod.dependencies.join(", ")}` : "";
				server.field(mod.name, init + deps);
			}
		});
	};

	const renderServer = ({ page, trove: tabTrove }: TabContext) => {
		page.text("Loading...", COLORS.dim);
		every(tabTrove, REFRESH, () => {
			const [ok, reply] = call("status");
			page.clear();
			if (!ok || !typeIs(reply, "table")) {
				page.text(str(reply), COLORS.bad);
				return;
			}
			const status = (reply as StatusReply).server;
			page.section("Server");
			page.field("Type", status.serverType);
			page.field("Job", str(status.jobId));
			page.field("Place version", str(status.placeVersion));
			page.field("Branch", `${str(status.branch)} (${str(status.channel)})`);
			page.field("Uptime", duration(status.uptime));
			if (status.generation) {
				page.field("Generation", status.generation.name);
				page.field("Generation uptime", duration(status.generation.uptime));
			}
			page.field("Players", `${status.players}/${status.maxPlayers}`);
			page.field("Memory", typeIs(status.memoryMb, "number") ? "%.0f MB".format(status.memoryMb) : "-");
			page.field("Lua heap", typeIs(status.luaHeapKb, "number") ? "%.1f MB".format(status.luaHeapKb / 1024) : "-");
			page.field("Registry seq", str(status.appliedSeq));
			if (status.registryError !== undefined) page.field("Registry error", status.registryError, COLORS.bad);

			page.section("Last deploy message");
			const message = status.lastMessage;
			if (message) {
				page.field("Artifact", str(message.data.i ?? message.data.a));
				page.field("Branch", str(message.data.b));
				page.field("Latency", message.sentMs !== undefined ? `${message.receivedMs - message.sentMs} ms` : "-");
				page.field("Received", utc(math.floor(message.receivedMs / 1000)));
			} else {
				page.text("None since boot", COLORS.dim);
			}

			page.section("Swaps");
			const history = status.history ?? [];
			if (history.size() === 0) page.text("None", COLORS.dim);
			for (let index = history.size() - 1; index >= 0; index--) {
				const entry = history[index];
				page.field(
					entry.name,
					`${entry.reason}, ${entry.at}, load ${seconds(entry.loadSeconds)}, swap ${ms(entry.swapSeconds)}`,
				);
			}
		});
	};

	let logRealm: "server" | "client" = "server";
	const renderLogs = ({ page, trove: tabTrove, content }: TabContext) => {
		const bar = page.buttons();
		const rows = page.group(2);
		const shown = new Array<TextLabel>();
		let since = 0;
		let epoch = 0;

		const realmButtons = new Map<string, TextButton>();
		const highlight = () => {
			for (const [realm, button] of realmButtons) {
				button.BackgroundColor3 = realm === logRealm ? COLORS.accent : COLORS.button;
				button.TextColor3 = realm === logRealm ? COLORS.dark : COLORS.text;
			}
		};
		const fetch = () => {
			const realm = logRealm;
			const myEpoch = epoch;
			let entries: LogEntry[];
			if (realm === "client") {
				entries = kernel.logs(since, 200);
			} else {
				const [ok, reply] = call("logs", since);
				if (myEpoch !== epoch) return;
				if (!ok || !typeIs(reply, "table")) {
					rows.text(`Logs: ${str(reply)}`, COLORS.bad);
					return;
				}
				entries = reply as LogEntry[];
			}
			for (const entry of entries) {
				if (entry.i <= since) continue;
				since = entry.i;
				const line = `${os.date("%H:%M:%S", entry.t)}  ${entry.text.sub(1, 600)}`;
				shown.push(rows.text(line, LOG_COLORS[entry.kind] ?? COLORS.text, true));
			}
			while (shown.size() > MAX_LOG_ROWS) shown.shift()?.Destroy();
		};
		const selectRealm = (realm: "server" | "client") => {
			logRealm = realm;
			epoch += 1;
			since = 0;
			shown.clear();
			rows.clear();
			highlight();
			spawnIn(tabTrove, fetch);
		};
		realmButtons.set("server", addButton(bar, "Server", () => selectRealm("server")));
		realmButtons.set("client", addButton(bar, "Client", () => selectRealm("client")));
		highlight();

		// Newest at the bottom: follow new lines unless the player scrolled up.
		let follow = true;
		const bottom = () => math.max(0, content.AbsoluteCanvasSize.Y - content.AbsoluteWindowSize.Y);
		tabTrove.connect(content.GetPropertyChangedSignal("CanvasPosition"), () => {
			follow = content.CanvasPosition.Y >= bottom() - 30;
		});
		tabTrove.connect(content.GetPropertyChangedSignal("AbsoluteCanvasSize"), () => {
			if (follow) content.CanvasPosition = new Vector2(0, bottom());
		});
		every(tabTrove, REFRESH, fetch);
	};

	let dexRealm: "client" | "server" = "client";
	let dexPath = new Array<string>();
	const renderDex = ({ page, trove: tabTrove }: TabContext) => {
		const bar = page.buttons();
		const pathLabel = page.text("", COLORS.dim, true);
		const note = page.text("", COLORS.dim);
		const body = page.group(4);
		let epoch = 0;

		const canEdit = () => dexRealm === "client" || kernel.channel === "dev";
		const setNote = (text: string, color = COLORS.dim) => {
			note.Text = text;
			note.TextColor3 = color;
			note.Visible = text !== "";
		};
		setNote("");

		const realmButtons = new Map<string, TextButton>();
		const highlight = () => {
			for (const [realm, button] of realmButtons) {
				button.BackgroundColor3 = realm === dexRealm ? COLORS.accent : COLORS.button;
				button.TextColor3 = realm === dexRealm ? COLORS.dark : COLORS.text;
			}
		};

		let load: () => void;
		const navigate = (path: string[]) => {
			dexPath = path;
			setNote("");
			load();
		};

		const draw = (children: DexNode[], properties: DexProperty[]) => {
			body.clear();
			body.section(`Children (${children.size()})`);
			for (const node of children) {
				const count = node.children > 0 ? ` (${node.children})` : "";
				body.link(`${node.name}   ${node.className}${count}`, () => navigate([...dexPath, node.name]));
			}
			body.section("Properties");
			const editable = canEdit();
			for (const property of properties) {
				const kind = property.kind;
				if (editable && (kind === "string" || kind === "number" || kind === "boolean")) {
					body.editable(property.name, property.value, (text) => spawnIn(tabTrove, () => edit(property.name, text)));
				} else {
					body.field(property.name, property.value);
				}
			}
			if (editable && dexPath.size() >= 2) {
				const actions = body.buttons();
				let armed = false;
				const destroyButton = addButton(
					actions,
					"Delete",
					() => {
						if (!armed) {
							armed = true;
							destroyButton.Text = "Confirm delete";
							return;
						}
						spawnIn(tabTrove, destroy);
					},
					COLORS.bad,
				);
			}
		};

		const edit = (name: string, text: string) => {
			if (dexRealm === "client") {
				const instance = resolvePath(dexPath);
				if (!instance) return setNote("Not found", COLORS.bad);
				const [ok, err] = setProperty(instance, name, text);
				setNote(ok ? `Set ${name}` : `Failed: ${err}`, ok ? COLORS.good : COLORS.bad);
			} else {
				const [ok, reply] = call("dex.set", { path: [...dexPath], name, value: text });
				setNote(ok ? `Set ${name}` : `Failed: ${str(reply)}`, ok ? COLORS.good : COLORS.bad);
			}
			load();
		};

		const destroy = () => {
			const path = [...dexPath];
			let ok: boolean;
			let reply: unknown;
			if (dexRealm === "client") {
				const instance = resolvePath(path);
				[ok, reply] = instance ? pcall(() => instance.Destroy()) : [false, "not found"];
			} else {
				[ok, reply] = call("dex.destroy", path);
			}
			if (!ok) return setNote(`Failed: ${str(reply)}`, COLORS.bad);
			path.pop();
			navigate(path);
			setNote("Deleted", COLORS.good);
		};

		load = () => {
			epoch += 1;
			const myEpoch = epoch;
			const realm = dexRealm;
			const path = [...dexPath];
			pathLabel.Text = ["game", ...path].join(" / ");
			spawnIn(tabTrove, () => {
				let children: DexNode[];
				let properties: DexProperty[];
				if (realm === "client") {
					const instance = resolvePath(path);
					if (!instance) {
						setNote("Not found", COLORS.bad);
						body.clear();
						return;
					}
					children = listChildren(instance);
					properties = listProperties(instance);
				} else {
					const [childrenOk, childrenReply] = call("dex.children", path);
					if (myEpoch !== epoch) return;
					if (!childrenOk) {
						setNote(`Failed: ${str(childrenReply)}`, COLORS.bad);
						body.clear();
						return;
					}
					const [propertiesOk, propertiesReply] = call("dex.props", path);
					if (myEpoch !== epoch) return;
					children = childrenReply as DexNode[];
					properties = propertiesOk ? (propertiesReply as DexProperty[]) : [];
				}
				draw(children, properties);
			});
		};

		const selectRealm = (realm: "client" | "server") => {
			if (realm !== dexRealm) dexPath = [];
			dexRealm = realm;
			highlight();
			setNote("");
			load();
		};
		realmButtons.set("client", addButton(bar, "Client", () => selectRealm("client")));
		realmButtons.set("server", addButton(bar, "Server", () => selectRealm("server")));
		addButton(bar, "Up", () => {
			if (dexPath.size() === 0) return;
			const path = [...dexPath];
			path.pop();
			navigate(path);
		});
		addButton(bar, "Refresh", () => load());
		highlight();
		load();
	};

	const netHistory = new Map<string, [number, number, number]>();
	const renderNetwork = ({ page, trove: tabTrove }: TabContext) => {
		page.text("Loading...", COLORS.dim);
		const addStats = (realm: string, stats: NetStat[]) => {
			page.section(realm === "server" ? "Server" : "Client");
			if (stats.size() === 0) page.text("No traffic yet", COLORS.dim);
			const now = os.clock();
			for (const stat of stats) {
				const key = `${realm}:${stat.path}`;
				const line = statLine(stat, netHistory.get(key), now);
				netHistory.set(key, [stat.inbound, stat.outbound, now]);
				page.field(stat.path, line, stat.rejected > 0 || stat.errors > 0 ? COLORS.warn : COLORS.text);
			}
		};
		every(tabTrove, REFRESH, () => {
			const [ok, reply] = call("net");
			const client = new Array<NetStat>();
			for (const [path, stat] of dispatcher.stats) client.push({ path, ...stat });
			client.sort((a, b) => a.inbound + a.outbound > b.inbound + b.outbound);
			page.clear();
			if (ok && typeIs(reply, "table")) addStats("server", reply as NetStat[]);
			else page.text(`Server: ${str(reply)}`, COLORS.bad);
			addStats("client", client);
		});
	};

	const renderBranch = ({ page, trove: tabTrove }: TabContext) => {
		const bar = page.buttons();
		const result = page.text("", COLORS.dim);
		result.Visible = false;
		const list = page.group(8);
		list.text("Loading...", COLORS.dim);

		const run = (label: string, op: string, payload?: unknown) =>
			spawnIn(tabTrove, () => {
				result.Visible = true;
				result.Text = `${label}...`;
				result.TextColor3 = COLORS.dim;
				const [ok, reply] = call(op, payload);
				const [text, color] = swapText(ok, reply);
				result.Text = text;
				result.TextColor3 = color;
			});
		addButton(bar, "Reload", () => run("Reloading", "reload"));
		addButton(bar, "Rollback", () => run("Rolling back", "rollback"));

		spawnIn(tabTrove, () => {
			const [statusOk, statusReply] = call("status");
			const [branchesOk, branchesReply] = call("branches");
			list.clear();
			if (!branchesOk || !typeIs(branchesReply, "table")) {
				list.text(`Branches: ${str(branchesReply)}`, COLORS.bad);
				return;
			}
			const status = statusOk && typeIs(statusReply, "table") ? (statusReply as StatusReply).server : undefined;
			const serverType = status?.serverType;
			const canSwitch = serverType === "private" || serverType === "reserved" || serverType === "studio";
			const branches = branchesReply as BranchInfo[];
			list.section("Branches");
			if (branches.size() === 0) list.text("None", COLORS.dim);
			for (const branch of branches) {
				const current = status !== undefined && branch.name === status.branch;
				const card = list.group(4);
				const title = card.text(`${branch.name}${current ? "  (this server)" : ""}`, COLORS.text);
				title.Font = Enum.Font.BuilderSansBold;
				card.text(`${branch.channel}  ${str(branch.artifactId)}  ${str(branch.commit)}`, COLORS.dim, true);
				const actions = card.buttons();
				if (canSwitch && !current) addButton(actions, "Switch here", () => run(`Switching to ${branch.name}`, "switch", branch.name));
				addButton(actions, "New server", () => run(`Opening a server on ${branch.name}`, "newServer", branch.name));
			}
		});
	};

	const renderState = ({ page, trove: tabTrove }: TabContext) => {
		const drawSide = (target: Page, title: string, summary: StateSummary) => {
			target.section(`${title} modules`);
			if (summary.modules.size() === 0) target.text("None", COLORS.dim);
			for (const mod of summary.modules) {
				const hooks = mod.hooks.size() > 0 ? mod.hooks.join(", ") : "no hooks";
				const deps = mod.dependencies.size() > 0 ? `; needs ${mod.dependencies.join(", ")}` : "";
				target.field(mod.name, `${hooks}${deps}`);
			}
			target.section(`${title} persist`);
			if (summary.persist.size() === 0) target.text("None", COLORS.dim);
			for (const entry of summary.persist) {
				target.field(entry.key, `${entry.entries} entries  ${entry.preview}`);
			}
		};
		const server = page.group();
		const client = page.group();
		every(tabTrove, REFRESH, () => {
			const [ok, reply] = call("state");
			server.clear();
			if (ok && typeIs(reply, "table")) drawSide(server, "Server", reply as StateSummary);
			else server.text(`Server: ${str(reply)}`, COLORS.bad);
			client.clear();
			drawSide(client, "Client", describeState());
		});
	};

	let claudeDraft = "";
	let attachPath = false;
	let attachErrors = false;
	const renderClaude = ({ page, trove: tabTrove }: TabContext) => {
		page.field("Branch", str(kernel.branch));
		page.field("Channel", str(kernel.channel));
		if (kernel.channel !== "dev") {
			page.text(claudeError("prod_channel"), COLORS.dim);
			return;
		}
		const sessionLine = page.text("Checking session...", COLORS.dim);
		const composer = page.group(6);
		composer.frame.Visible = false;
		const list = page.group(8);

		const box = composer.input("Describe a change", 120, true);
		box.Text = claudeDraft;
		tabTrove.connect(box.GetPropertyChangedSignal("Text"), () => (claudeDraft = box.Text));
		const toggles = composer.buttons();
		const paintToggle = (button: TextButton, on: boolean) => {
			button.BackgroundColor3 = on ? COLORS.info : COLORS.button;
			button.TextColor3 = on ? COLORS.dark : COLORS.text;
		};
		const pathToggle = addButton(toggles, "Dex path", () => {
			attachPath = !attachPath;
			paintToggle(pathToggle, attachPath);
		});
		const errorsToggle = addButton(toggles, "Errors", () => {
			attachErrors = !attachErrors;
			paintToggle(errorsToggle, attachErrors);
		});
		paintToggle(pathToggle, attachPath);
		paintToggle(errorsToggle, attachErrors);
		const actions = composer.buttons();
		const result = composer.text("", COLORS.dim);
		result.Visible = false;
		const showResult = (text: string, color: Color3) => {
			result.Text = text;
			result.TextColor3 = color;
			result.Visible = text !== "";
		};

		let requests = new Array<ClaudeRequestView>();
		let sending = false;

		const replace = (updated: ClaudeRequestView) => {
			const index = requests.findIndex((request) => request.id === updated.id);
			if (index === -1) requests.unshift(updated);
			else requests[index] = updated;
		};

		let drawList: () => void;
		const cancel = (id: string) =>
			spawnIn(tabTrove, () => {
				const [ok, reply] = call("claude.cancel", id);
				const answer = (typeIs(reply, "table") ? reply : {}) as ClaudeReply;
				if (ok && answer.ok === true && answer.request) replace(answer.request);
				else showResult(claudeError(ok ? answer.error : reply), COLORS.bad);
				drawList();
			});

		drawList = () => {
			list.clear();
			if (requests.size() === 0) return;
			list.section("Requests");
			for (const request of requests) {
				const card = list.group(2);
				const color = CLAUDE_STATE_COLORS[request.state] ?? COLORS.text;
				const title = card.text(`${request.state.upper()}  ${request.prompt}`, color);
				title.Font = Enum.Font.BuilderSansBold;
				const details = new Array<string>();
				if (!request.mine) details.push(`by ${request.by}`);
				if (request.summary !== undefined) details.push(request.summary);
				if (request.commit !== undefined) details.push(`commit ${request.commit}`);
				if (request.artifactId !== undefined) details.push(request.artifactId);
				if (request.error !== undefined) details.push(request.error);
				if (details.size() > 0) card.text(details.join("  "), COLORS.dim);
				const log = request.log ?? [];
				for (let index = math.max(0, log.size() - 3); index < log.size(); index++) {
					card.text(log[index], COLORS.dim, true);
				}
				if (request.mine && !request.finished) addButton(card.buttons(), "Cancel", () => cancel(request.id), COLORS.bad);
			}
		};

		const refreshSession = () => {
			const [ok, reply] = call("claude.session");
			if (!ok || !typeIs(reply, "table")) {
				sessionLine.Text = `Failed: ${str(reply)}`;
				sessionLine.TextColor3 = COLORS.bad;
				return;
			}
			const session = reply as ClaudeSessionView;
			if (!session.available) {
				sessionLine.Text = claudeError("not_connected");
				sessionLine.TextColor3 = COLORS.warn;
			} else if (!session.allowed) {
				sessionLine.Text = `Session ${session.label}: ${claudeError("not_allowed")}`;
				sessionLine.TextColor3 = COLORS.warn;
			} else {
				sessionLine.Text = `Session ${session.label} on ${str(session.branch)}`;
				sessionLine.TextColor3 = COLORS.good;
			}
			composer.frame.Visible = session.available && session.allowed;
			requests = session.requests;
			drawList();
		};

		const pollActive = () => {
			let polled = 0;
			for (const request of [...requests]) {
				if (request.finished || polled >= 3) continue;
				polled += 1;
				const [ok, reply] = call("claude.status", request.id);
				const answer = (typeIs(reply, "table") ? reply : {}) as ClaudeReply;
				if (ok && answer.ok === true && answer.request) replace(answer.request);
			}
			if (polled > 0) drawList();
		};

		const lastClientErrors = (): string[] => {
			const errors = new Array<string>();
			for (const entry of kernel.logs(undefined, 300)) {
				if (entry.kind === "error") errors.push(entry.text.sub(1, 500));
			}
			return errors.filter((_, index) => index >= errors.size() - 5);
		};

		const send = () => {
			const prompt = (box.Text.match("^%s*(.-)%s*$")[0] as string | undefined) ?? "";
			if (prompt === "") return showResult(claudeError("empty"), COLORS.warn);
			showResult("Sending...", COLORS.dim);
			const request: ClaudePromptRequest = { prompt: prompt.sub(1, 4000), errors: attachErrors };
			if (attachPath) request.path = `${dexRealm} ${["game", ...dexPath].join("/")}`;
			if (attachErrors) request.clientErrors = lastClientErrors();
			const [ok, reply] = call("claude.prompt", request);
			const answer = (typeIs(reply, "table") ? reply : {}) as ClaudeReply;
			if (ok && answer.ok === true && answer.request) {
				showResult("Sent", COLORS.good);
				box.Text = "";
				replace(answer.request);
				drawList();
			} else {
				showResult(claudeError(ok ? answer.error : reply), COLORS.bad);
			}
		};
		addButton(
			actions,
			"Send",
			() => {
				if (sending) return;
				sending = true;
				spawnIn(tabTrove, () => {
					const [ok, err] = pcall(send);
					sending = false;
					if (!ok) showResult(`Failed: ${err}`, COLORS.bad);
				});
			},
			COLORS.accent,
		);

		// The session every 10 s; active requests every 2.5 s in between (only while this tab is open).
		let tick = 0;
		every(tabTrove, CLAUDE_POLL, () => {
			if (tick % 4 === 0) refreshSession();
			else pollActive();
			tick += 1;
		});
	};

	const RENDER: Record<TabName, (tab: TabContext) => void> = {
		Artifact: renderArtifact,
		Server: renderServer,
		Logs: renderLogs,
		Dex: renderDex,
		Network: renderNetwork,
		State: renderState,
		Branch: renderBranch,
		Claude: renderClaude,
	};

	// Window ----------------------------------------------------------------------------------------------------------

	let ui: Ui | undefined;
	let tabTrove: Trove | undefined;
	let isOpen = false;
	let dev = false;

	const selectTab = (name: TabName) => {
		if (!ui || !tabTrove) return;
		tabTrove.clean();
		state.tab = name;
		for (const [tab, button] of ui.tabButtons) {
			button.BackgroundColor3 = tab === name ? COLORS.accent : COLORS.header;
			button.TextColor3 = tab === name ? COLORS.dark : COLORS.text;
		}
		ui.content.CanvasPosition = Vector2.zero;
		const page = Page.mount(ui.content);
		tabTrove.add(page.frame);
		const [ok, err] = pcall(() => RENDER[name]({ page, trove: tabTrove!, content: ui!.content }));
		if (!ok) {
			$warn(`[devtools] ${name} tab failed: ${err}`);
			page.text(`This tab failed: ${err}`, COLORS.bad);
		}
	};

	const close = () => {
		if (!ui || !isOpen) return;
		isOpen = false;
		state.open = false;
		const closing = tabTrove;
		popOut(ui.window, () => {
			if (!isOpen) closing?.clean();
		});
	};

	let open: () => void;
	const build = (): Ui => {
		const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui");
		const gui = trove.add(
			make("ScreenGui", {
				Name: "TypeTorchDev",
				ResetOnSpawn: false,
				DisplayOrder: 100,
				IgnoreGuiInset: true,
				ZIndexBehavior: Enum.ZIndexBehavior.Sibling,
			}),
		);
		tabTrove = trove.extend();

		const toggle = style(make("TextButton", { Name: "Toggle", AutoButtonColor: true, Visible: false }, gui), "DEV", 16);
		toggle.Font = Enum.Font.BuilderSansBold;
		toggle.TextXAlignment = Enum.TextXAlignment.Center;
		toggle.TextColor3 = COLORS.dark;
		toggle.BackgroundColor3 = COLORS.accent;
		toggle.Size = UDim2.fromOffset(60, 36);
		toggle.Position = UDim2.fromOffset(12, 70);
		corner(toggle, 8);
		toggle.Activated.Connect(() => (isOpen ? close() : open()));

		const window = make(
			"Frame",
			{
				Name: "Window",
				Active: true,
				Visible: false,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromScale(0.5, 0.5),
				Size: UDim2.fromScale(0.62, 0.7),
				BackgroundColor3: COLORS.window,
				BorderSizePixel: 0,
				ClipsDescendants: true,
			},
			gui,
		);
		make("UISizeConstraint", { MinSize: new Vector2(360, 280), MaxSize: new Vector2(900, 640) }, window);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, window);
		corner(window, 10);

		const header = make(
			"Frame",
			{ Name: "Header", BackgroundColor3: COLORS.header, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, HEADER) },
			window,
		);
		const title = style(make("TextLabel", { BackgroundTransparency: 1 }, header), "TypeTorch", 18, COLORS.accent);
		title.Font = Enum.Font.BuilderSansBold;
		title.TextWrapped = false;
		title.Size = new UDim2(0, 96, 1, 0);
		title.Position = UDim2.fromOffset(14, 0);
		const subtitle = style(
			make("TextLabel", { BackgroundTransparency: 1 }, header),
			`${kernel.artifact.id} #${kernel.generation}`,
			14,
			COLORS.dim,
			Enum.Font.Code,
		);
		subtitle.TextWrapped = false;
		subtitle.TextTruncate = Enum.TextTruncate.AtEnd;
		subtitle.Size = new UDim2(1, -170, 1, 0);
		subtitle.Position = UDim2.fromOffset(114, 0);
		const closeButton = style(make("TextButton", { AutoButtonColor: true }, header), "X", 16);
		closeButton.Font = Enum.Font.BuilderSansBold;
		closeButton.TextXAlignment = Enum.TextXAlignment.Center;
		closeButton.BackgroundColor3 = COLORS.button;
		closeButton.AnchorPoint = new Vector2(1, 0.5);
		closeButton.Position = new UDim2(1, -8, 0.5, 0);
		closeButton.Size = UDim2.fromOffset(34, 34);
		corner(closeButton, 6);
		closeButton.Activated.Connect(close);

		const tabs = scrolling(window, {
			Name: "Tabs",
			Position: UDim2.fromOffset(0, HEADER),
			Size: new UDim2(0, TAB_WIDTH, 1, -HEADER),
			ScrollBarThickness: 0,
		});
		verticalList(tabs, 4);
		pad(tabs, 8, 8);
		const tabButtons = new Map<TabName, TextButton>();
		TABS.forEach((name, index) => {
			const button = style(make("TextButton", { AutoButtonColor: true }), name, 15, COLORS.text, Enum.Font.BuilderSansMedium);
			button.BackgroundColor3 = COLORS.header;
			button.TextWrapped = false;
			button.Size = new UDim2(1, 0, 0, 36);
			button.LayoutOrder = index;
			corner(button, 6);
			pad(button, 0, 10);
			button.Parent = tabs;
			button.Activated.Connect(() => selectTab(name));
			tabButtons.set(name, button);
		});

		const content = scrolling(window, {
			Name: "Content",
			Position: UDim2.fromOffset(TAB_WIDTH, HEADER),
			Size: new UDim2(1, -TAB_WIDTH, 1, -HEADER),
		});
		pad(content, 10, 10);

		gui.Parent = playerGui;
		return { gui, toggle, window, content, tabButtons };
	};

	open = () => {
		if (!dev) return;
		if (!ui) ui = build();
		if (isOpen) return;
		isOpen = true;
		state.open = true;
		popIn(ui.window);
		selectTab(TABS.includes(state.tab as TabName) ? (state.tab as TabName) : "Artifact");
	};

	const setDev = (value: boolean) => {
		if (value === dev) return;
		dev = value;
		if (dev) {
			if (!ui) ui = build();
			ui.toggle.Visible = true;
			// Reopen after a swap if the menu was open in the previous generation.
			if (state.open) open();
		} else if (ui) {
			const wasOpen = state.open;
			close();
			state.open = wasOpen;
			ui.toggle.Visible = false;
		}
	};

	const refreshDev = () => {
		const [ok, info] = pcall(() => kernel.devStatus());
		setDev(ok && typeIs(info, "table") && info.dev === true);
	};

	every(trove, REFRESH, refreshDev);
	trove.add(
		kernel.onKernelEvent((name) => {
			if (name !== "dev-open") return;
			refreshDev();
			open();
		}),
	);
	trove.connect(UserInputService.InputBegan, (input, processed) => {
		if (processed || input.KeyCode !== Enum.KeyCode.D || !dev) return;
		const ctrl =
			UserInputService.IsKeyDown(Enum.KeyCode.LeftControl) || UserInputService.IsKeyDown(Enum.KeyCode.RightControl);
		const shift =
			UserInputService.IsKeyDown(Enum.KeyCode.LeftShift) || UserInputService.IsKeyDown(Enum.KeyCode.RightShift);
		if (!ctrl || !shift) return;
		if (isOpen) close();
		else open();
	});
}
