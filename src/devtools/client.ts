import { HttpService, Players, ReplicatedStorage, SoundService, UserInputService, Workspace } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type {
	ArtifactEntry,
	ArtifactInfo,
	BranchInfo,
	ClientKernel,
	DevInfo,
	KernelStatus,
	LogEntry,
	NewServerReport,
	SwapReport,
} from "../kernel";
import type { ClientDispatcher, LeafStats } from "../net/runtime";
import { runningModules } from "../runtime/registry";
import { bump, popIn, popOut } from "../ui";
import { ExplorerPersist, mountExplorer } from "./explorer";
import {
	ClaudePromptRequest,
	ClaudeRequestView,
	ClaudeSessionView,
	DEV_REQUEST,
	DEV_RESPONSE,
	DEVLOGS_MAX_BYTES,
	DEVLOGS_MAX_ENTRIES,
	DEVLOGS_REQUEST,
	DEVLOGS_RESPONSE,
	DexNode,
	DexProperty,
	ModuleSummary,
	NetStat,
	StateSummary,
} from "./protocol";
import { describeState } from "./state";
import {
	addButton,
	chevron,
	buttonRow,
	COLORS,
	corner,
	fixedRow,
	escapeRich,
	make,
	pad,
	Page,
	paintSelected,
	playerSelector,
	scrolling,
	searchBox,
	sideButton,
	SIDE_BUTTON,
	style,
	tag,
	upButton,
	verticalList,
} from "./widgets";

/**
 * Client half of the dev menu (plans/10), built in code. Only devs see it: the toggle button, Ctrl+Shift+D and
 * `/tt dev` all check the server's last word on dev status, and the server re-checks every request anyway.
 * Prod-channel servers are read-only (the server enforces it; the UI only hides edit controls).
 *
 * Every client (dev or not) also answers the server's DEVLOGS_REQUEST with its recent logs, so a dev can read another
 * player's client logs (Logs > Others). Only the server can ask, and it only asks for devs.
 */

const REQUEST_TIMEOUT = 15;
const REFRESH = 2;
/** Logs > Others polls slower (the server allows one request per dev every 2 s). */
const OTHER_LOGS_REFRESH = 4;
const CLAUDE_POLL = 2.5;
const MAX_LOG_ROWS = 300;
const HEADER = 46;
const TAB_WIDTH = 116;
/** Gap between the body (right of the tabs) and the window's right and bottom borders. */
const BODY_MARGIN = 8;
/** Artifact rows shown per branch before "Show all". */
const ARTIFACTS_PER_BRANCH = 6;
const PERSIST_KEY = "typetorch/devtools";
/** Played after a hot swap on dev-channel servers (ships with the client: no upload, no moderation). */
const RELOAD_SOUND = "rbxasset://sounds/electronicpingshort.wav";

// Window geometry (pixels).
const MIN_SIZE = new Vector2(360, 280);
const DEFAULT_MAX = new Vector2(900, 640);
const SCREEN_MARGIN = 8;
const GRIP = 24;
const DOUBLE_TAP = 0.35;

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
	needs_pairing: "Pair first: paste the pairing code",
	bad_code: "Wrong or expired code",
	not_allowed: "Not on the session's user list",
	prod_channel: "Prompts work on dev-channel servers only.",
	busy: "Wait for your running request",
	rate_limited: "Too many tries, wait a bit",
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

/** Short text for the "logs.player" errors of devtools/server.ts. */
const OTHER_LOG_ERRORS: Record<string, string> = {
	no_reply: "No reply from that player",
	not_in_server: "That player left",
	rate_limited: "Slow down",
};

interface ClaudeReply {
	ok?: boolean;
	error?: string;
	request?: ClaudeRequestView;
}

const TABS = ["Artifact", "Server", "Logs", "Dex", "Network", "State", "Claude"] as const;
type TabName = (typeof TABS)[number];
/** Tabs with sub-tabs (a segmented bar on top of the content); the first one is the default. */
const SUBTABS: Partial<Record<TabName, readonly string[]>> = { Server: ["Status", "Branch"] };

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
	/** A button row pinned above the scrolling content (sticky toolbar), removed with the tab. */
	readonly toolbar: () => Frame;
	/** A bar pinned under the scrolling content, removed with the tab. */
	readonly footer: () => Page;
}

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/** What survives swaps (kernel persist store). Fields after `tab` were added later: older stores lack them. */
interface MenuState {
	open: boolean;
	tab: string;
	/** tab -> selected sub-tab */
	sub?: Record<string, string>;
	/** Window rectangle in pixels; undefined = the centered default. */
	window?: Rect;
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

function serverText(ok: boolean, reply: unknown): [string, Color3] {
	if (!ok) return [`Failed: ${str(reply)}`, COLORS.bad];
	const report = (typeIs(reply, "table") ? reply : {}) as NewServerReport;
	if (report.ok) return ["Teleporting...", COLORS.good];
	return [`Failed: ${report.error ?? "unknown error"}`, COLORS.bad];
}

/** "5m ago" from an ISO time. */
function ago(iso: unknown): string {
	if (!typeIs(iso, "string")) return "-";
	const [ok, time] = pcall(() => DateTime.fromIsoDate(iso));
	if (!ok || time === undefined) return iso;
	const elapsed = math.max(0, DateTime.now().UnixTimestamp - time.UnixTimestamp);
	if (elapsed < 60) return "just now";
	if (elapsed < 3600) return `${math.floor(elapsed / 60)}m ago`;
	if (elapsed < 86400) return `${math.floor(elapsed / 3600)}h ago`;
	return `${math.floor(elapsed / 86400)}d ago`;
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

/** The newest log entries that fit the reply caps (DEVLOGS_MAX_ENTRIES, DEVLOGS_MAX_BYTES), oldest first. */
function shareableLogs(entries: LogEntry[]): LogEntry[] {
	const picked = new Array<LogEntry>();
	let bytes = 0;
	for (let index = entries.size() - 1; index >= 0 && picked.size() < DEVLOGS_MAX_ENTRIES; index--) {
		const entry = entries[index];
		const text = entry.text.sub(1, 600);
		bytes += text.size() + 32;
		if (bytes > DEVLOGS_MAX_BYTES) break;
		picked.push({ i: entry.i, t: entry.t, kind: entry.kind, text });
	}
	const ordered = new Array<LogEntry>();
	for (let index = picked.size() - 1; index >= 0; index--) ordered.push(picked[index]);
	return ordered;
}

// The menu ----------------------------------------------------------------------------------------------------------

interface Ui {
	gui: ScreenGui;
	toggle: TextButton;
	window: Frame;
	/** Right of the tab list: [sub-tabs] [toolbar] [content] [footer], top to bottom. */
	body: Frame;
	content: ScrollingFrame;
	tabButtons: Map<TabName, TextButton>;
	/** Sidebar groups (tabs with sub-tabs): children shown indented under the tab while it is selected. */
	groups: Map<TabName, SidebarGroup>;
}

interface SidebarGroup {
	frame: Frame;
	collapsed: Frame;
	expanded: Frame;
	children: Map<string, TextButton>;
}

interface Waiter {
	thread: thread;
	timeout: thread;
}

export interface DevtoolsClient {
	/** Call once the client generation is up (all modules started). */
	readonly started: () => void;
}

/**
 * Starts the dev menu for this client generation. Everything it creates or connects lives in `trove`, so a swap
 * removes it; the open state, tab, sub-tab, window rectangle and options survive the swap through the kernel persist
 * store.
 */
export function startDevtoolsClient(kernel: ClientKernel, dispatcher: ClientDispatcher, trove: Trove): DevtoolsClient {
	const state = kernel.persist<MenuState>(PERSIST_KEY, () => ({ open: false, tab: "Artifact" }));
	if (state.sub === undefined) state.sub = {};
	const subs = state.sub;
	// Before sub-tabs, Branch was a top-level tab.
	if (state.tab === "Branch") {
		state.tab = "Server";
		subs.Server = "Branch";
	}

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
	// Every client answers the server's log requests (Logs > Others on a dev's menu). Never shown, never logged.
	dispatcher.setRaw(DEVLOGS_REQUEST, (id, since) => {
		if (!typeIs(id, "number")) return;
		const entries = kernel.logs(typeIs(since, "number") ? since : undefined, DEVLOGS_MAX_ENTRIES);
		kernel.send(DEVLOGS_RESPONSE, id, shareableLogs(entries));
	});
	trove.add(() => {
		dispatcher.removeRaw(DEV_RESPONSE);
		dispatcher.removeRaw(DEVLOGS_REQUEST);
		for (const [, waiter] of waiters) {
			if (coroutine.status(waiter.timeout) === "suspended") task.cancel(waiter.timeout);
		}
		waiters.clear();
	});

	// Reload sound --------------------------------------------------------------------------------------------------
	const effectiveChannel = (): unknown => {
		if (kernel.channel !== undefined) return kernel.channel;
		return ReplicatedStorage.FindFirstChild("TypeTorch")?.GetAttribute("Channel");
	};

	/** After a hot swap (client generation > 1) on a dev-channel server, for devs. No setting. */
	const playReloadSound = () => {
		if (kernel.generation <= 1 || effectiveChannel() !== "dev") return;
		const [ok, info] = pcall(() => kernel.devStatus());
		if (!ok || !typeIs(info, "table") || info.dev !== true) return;
		const sound = trove.add(make("Sound", { Name: "TypeTorchReload", SoundId: RELOAD_SOUND, Volume: 0.5 }));
		sound.Parent = SoundService;
		SoundService.PlayLocalSound(sound);
		trove.add(task.delay(4, () => trove.remove(sound)));
	};

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

	// Server > Status
	const renderServer = ({ page, trove: tabTrove }: TabContext) => {
		const body = page.group();
		body.text("Loading...", COLORS.dim);
		every(tabTrove, REFRESH, () => {
			const [ok, reply] = call("status");
			body.clear();
			if (!ok || !typeIs(reply, "table")) {
				body.text(str(reply), COLORS.bad);
				return;
			}
			const status = (reply as StatusReply).server;
			body.section("Server");
			body.field("Type", status.serverType);
			body.field("Job", str(status.jobId));
			body.field("Place version", str(status.placeVersion));
			body.field("Branch", `${str(status.branch)} (${str(status.channel)})`);
			if (status.pinned !== undefined) body.field("Pinned", status.pinned ? "yes" : "no", status.pinned ? COLORS.warn : COLORS.text);
			body.field("Uptime", duration(status.uptime));
			if (status.generation) {
				body.field("Generation", status.generation.name);
				body.field("Generation uptime", duration(status.generation.uptime));
			}
			body.field("Players", `${status.players}/${status.maxPlayers}`);
			body.field("Memory", typeIs(status.memoryMb, "number") ? "%.0f MB".format(status.memoryMb) : "-");
			body.field("Lua heap", typeIs(status.luaHeapKb, "number") ? "%.1f MB".format(status.luaHeapKb / 1024) : "-");
			body.field("Registry seq", str(status.appliedSeq));
			body.field("Kernel", `${status.kernelVersion} (API ${status.kernelApi})`);
			if (status.registryError !== undefined) body.field("Registry error", status.registryError, COLORS.bad);

			body.section("Last deploy message");
			const message = status.lastMessage;
			if (message) {
				body.field("Artifact", str(message.data.i ?? message.data.a));
				body.field("Branch", str(message.data.b));
				body.field("Latency", message.sentMs !== undefined ? `${message.receivedMs - message.sentMs} ms` : "-");
				body.field("Received", utc(math.floor(message.receivedMs / 1000)));
			} else {
				body.text("None since boot", COLORS.dim);
			}

			body.section("Swaps");
			const history = status.history ?? [];
			if (history.size() === 0) body.text("None", COLORS.dim);
			for (let index = history.size() - 1; index >= 0; index--) {
				const entry = history[index];
				body.field(
					entry.name,
					`${entry.reason}, ${entry.at}, load ${seconds(entry.loadSeconds)}, swap ${ms(entry.swapSeconds)}`,
				);
			}
		});
	};

	let logRealm: "server" | "client" | "other" = "server";
	/** UserId whose client logs Logs > Others shows. */
	let logPlayer: number | undefined;
	const renderLogs = ({ page, trove: tabTrove, content, toolbar }: TabContext) => {
		const bar = toolbar();
		const heading = page.text("", COLORS.accent);
		heading.Font = Enum.Font.BuilderSansBold;
		heading.Visible = false;
		const note = page.text("", COLORS.bad);
		note.Visible = false;
		const picker = page.group(4);
		const rows = page.group(2);
		const shown = new Array<TextLabel>();
		let since = 0;
		let epoch = 0;
		let lastOther = -math.huge;
		let pickerTrove: Trove | undefined;

		const setNote = (text: string) => {
			note.Text = text;
			note.Visible = text !== "";
		};
		const realmButtons = new Map<string, TextButton>();
		const highlight = () => {
			for (const [realm, button] of realmButtons) paintSelected(button, realm === logRealm);
		};
		const showHeading = () => {
			if (logRealm !== "other" || logPlayer === undefined) {
				heading.Visible = false;
				return;
			}
			const target = Players.GetPlayerByUserId(logPlayer);
			heading.Text = `Logs: ${target ? target.DisplayName : `user ${logPlayer}`}`;
			heading.Visible = true;
		};
		const reset = () => {
			epoch += 1;
			since = 0;
			lastOther = -math.huge;
			shown.clear();
			rows.clear();
			setNote("");
		};

		const fetch = () => {
			const realm = logRealm;
			const myEpoch = epoch;
			let entries: LogEntry[];
			if (realm === "client") {
				entries = kernel.logs(since, 200);
			} else if (realm === "server") {
				const [ok, reply] = call("logs", since);
				if (myEpoch !== epoch) return;
				if (!ok || !typeIs(reply, "table")) {
					setNote(`Logs: ${str(reply)}`);
					return;
				}
				entries = reply as LogEntry[];
			} else {
				if (logPlayer === undefined || os.clock() - lastOther < OTHER_LOGS_REFRESH) return;
				lastOther = os.clock();
				const [ok, reply] = call("logs.player", { userId: logPlayer, since });
				if (myEpoch !== epoch) return;
				if (!ok || !typeIs(reply, "table")) {
					setNote(typeIs(reply, "string") ? OTHER_LOG_ERRORS[reply] ?? `Failed: ${reply}` : "Failed");
					return;
				}
				entries = reply as LogEntry[];
			}
			setNote("");
			for (const entry of entries) {
				if (entry.i <= since) continue;
				since = entry.i;
				const line = `${os.date("%H:%M:%S", entry.t)}  ${entry.text.sub(1, 600)}`;
				shown.push(rows.text(line, LOG_COLORS[entry.kind] ?? COLORS.text, true));
			}
			while (shown.size() > MAX_LOG_ROWS) shown.shift()?.Destroy();
		};

		const closePicker = () => {
			pickerTrove?.clean();
			picker.clear();
		};
		const openPicker = () => {
			closePicker();
			pickerTrove = tabTrove.extend();
			picker.text("Pick a player", COLORS.dim);
			playerSelector(picker, pickerTrove, {
				exclude: (player) => player === Players.LocalPlayer,
				selected: logPlayer,
				emptyText: "No other players",
				onSelect: (player) => {
					logPlayer = player.UserId;
					closePicker();
					reset();
					showHeading();
					spawnIn(tabTrove, fetch);
				},
			});
		};

		const selectRealm = (realm: "server" | "client" | "other") => {
			logRealm = realm;
			reset();
			closePicker();
			if (realm === "other") {
				// The selector opens every time "Others" is pressed; the list is empty until a player is picked.
				logPlayer = undefined;
				openPicker();
			}
			showHeading();
			highlight();
			spawnIn(tabTrove, fetch);
		};
		realmButtons.set("server", addButton(bar, "Server", () => selectRealm("server")));
		realmButtons.set("client", addButton(bar, "Client", () => selectRealm("client")));
		realmButtons.set("other", addButton(bar, "Others", () => selectRealm("other")));
		highlight();
		showHeading();
		if (logRealm === "other" && logPlayer === undefined) openPicker();

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

	// Dex = the explorer (devtools/explorer). dexSelection feeds the Claude tab's "Dex path" context.
	let dexSelection: string | undefined;
	const explorerState = kernel.persist("typetorch/explorer", (): ExplorerPersist => ({}));
	const renderDex = ({ trove: tabTrove, content }: TabContext) => {
		// The explorer scrolls by itself (virtualized tree), so it takes the content's place for this tab.
		const host = tabTrove.add(
			make("Frame", { Name: "Explorer", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), LayoutOrder: 3 }),
		);
		make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, host);
		pad(host, 8, 10);
		host.Parent = content.Parent;
		content.Visible = false;
		tabTrove.add(() => {
			content.Visible = true;
		});
		tabTrove.add(
			mountExplorer(host, {
				request: (op, payload) =>
					new Promise((resolve, reject) => {
						// Promise executors run in their own thread, so the yielding call() is fine here.
						const [ok, result] = call(op, payload);
						if (ok) resolve(result);
						else reject(result);
					}),
				canEdit: (realm) => realm === "client" || kernel.channel === "dev",
				trove: tabTrove,
				persist: explorerState,
				onSelect: (realm, path) => {
					dexSelection = path !== undefined ? `${realm} ${path}` : undefined;
				},
			}),
		);
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

	// Server > Branch: this server, the branch picker, the artifact picker; Reload / Rollback in a sticky footer.
	const renderBranch = ({ page, trove: tabTrove, footer }: TabContext) => {
		const foot = footer();
		const bar = foot.buttons();
		const result = foot.place(
			style(make("TextLabel", { BackgroundTransparency: 1 }), "", 14, COLORS.dim, Enum.Font.BuilderSansMedium),
		);
		result.TextWrapped = false;
		result.TextTruncate = Enum.TextTruncate.AtEnd;
		result.Size = new UDim2(1, 0, 0, 18);
		const setResult = (text: string, color: Color3) => {
			result.Text = text;
			result.TextColor3 = color;
			bump(result);
		};

		const body = page.group(6);
		body.text("Loading...", COLORS.dim);

		interface Picker {
			status?: KernelStatus;
			you?: DevInfo;
			branches: BranchInfo[];
			branchesError?: string;
			artifacts?: ArtifactEntry[];
			/** Why the artifact list is missing (kernel 0.1.0, or an error). */
			artifactsNote?: string;
		}
		let data: Picker | undefined;
		const expanded = new Set<string>();
		let busy = false;
		let epoch = 0;
		let load: () => void;
		let draw: () => void;

		/** Runs one action op (one at a time); a successful swap restarts this menu in the new generation. */
		const act = (label: string, op: string, payload?: unknown) => {
			if (busy) return;
			busy = true;
			setResult(`${label}...`, COLORS.dim);
			spawnIn(tabTrove, () => {
				const [ok, reply] = call(op, payload);
				busy = false;
				const [text, color] = op === "newServer" ? serverText(ok, reply) : swapText(ok, reply);
				setResult(text, color);
				if (op !== "newServer") load();
			});
		};
		addButton(bar, "Reload", () => act("Reloading", "reload"));
		addButton(bar, "Rollback", () => act("Rolling back", "rollback"));

		draw = () => {
			if (!data) return;
			body.clear();
			const status = data.status;
			const serverType = status?.serverType;
			const isPublic = serverType === "public";
			const isAdmin = data.you?.role === "owner" || data.you?.role === "admin";
			const running = status?.generation?.artifact;

			// This server.
			body.section("This server");
			if (status) {
				body.field("Type", serverType ?? "-");
				body.field("Branch", str(status.branch));
				body.field("Channel", str(status.channel));
				let artifactText = str(running?.id);
				if (running?.commit !== undefined && artifactText.find(running.commit, 1, true)[0] === undefined) {
					artifactText += `  ${running.commit}`;
				}
				body.field("Running", artifactText);
				const pinned = status.pinned === true;
				body.field("Pinned", pinned ? "yes, until the next deploy" : "no", pinned ? COLORS.warn : COLORS.text);
			} else {
				body.text("Status unavailable", COLORS.bad);
			}

			// Branch picker: switch here (private/reserved/studio) or open a reserved server (public).
			body.section("Branches");
			if (data.branchesError !== undefined) body.text(`Failed: ${data.branchesError}`, COLORS.bad);
			else if (data.branches.size() === 0) body.text("None", COLORS.dim);
			for (const branch of data.branches) {
				const current = status !== undefined && branch.name === status.branch;
				let title = `<b>${escapeRich(branch.name)}</b>`;
				if (current) title += tag("CURRENT", COLORS.accent);
				const parts = [branch.channel as string];
				if (branch.seq !== undefined) parts.push(`#${branch.seq}`);
				parts.push(branch.commit ?? branch.artifactId ?? "-");
				if (branch.deployedAt !== undefined) parts.push(ago(branch.deployedAt));
				const detail = escapeRich(parts.join("  "));
				if (serverType === undefined || (current && !isPublic)) {
					body.row(title, detail);
				} else if (isPublic) {
					body.row(title, detail, {
						label: "Open server",
						onClick: () => act(`Opening a server on ${branch.name}`, "newServer", branch.name),
					});
				} else {
					body.row(title, detail, {
						label: "Switch",
						color: COLORS.accent,
						onClick: () => act(`Switching to ${branch.name}`, "switch", branch.name),
					});
				}
			}

			// Artifact picker: newest first, grouped by branch.
			body.section("Artifacts");
			const artifacts = data.artifacts;
			if (artifacts === undefined) {
				body.text(data.artifactsNote ?? "Unavailable", COLORS.dim);
				return;
			}
			if (artifacts.size() === 0) body.text("None yet", COLORS.dim);
			const order = new Array<string>();
			const groups = new Map<string, ArtifactEntry[]>();
			for (const entry of artifacts) {
				let group = groups.get(entry.branch);
				if (!group) {
					group = [];
					groups.set(entry.branch, group);
					order.push(entry.branch);
				}
				group.push(entry);
			}
			for (const branchName of order) {
				const group = groups.get(branchName)!;
				const heading = body.text(`${branchName}  (${group[0].channel})`, COLORS.text);
				heading.Font = Enum.Font.BuilderSansBold;
				const showAll = expanded.has(branchName);
				group.forEach((entry, index) => {
					if (!showAll && index >= ARTIFACTS_PER_BRANCH) return;
					const short = entry.commit ?? entry.artifactId ?? `asset ${entry.assetId}`;
					let title = `<b>${entry.seq !== undefined ? `#${entry.seq}  ` : ""}${escapeRich(short)}</b>`;
					if (entry.running) title += tag(status?.pinned === true ? "RUNNING, PINNED" : "RUNNING", COLORS.good);
					if (entry.live) title += tag("LIVE", COLORS.info);
					if (entry.rollback) title += tag("ROLLBACK", COLORS.warn);
					const detail = escapeRich(`${entry.artifactId ?? `asset-${entry.assetId}`}  ${ago(entry.at)}`);
					if (entry.running || serverType === undefined) {
						body.row(title, detail);
						return;
					}
					// Mirrors the kernel's rules (it re-checks): any dev loads on private/reserved/studio servers; on a
					// public server only owner/admin, and only prod-channel artifacts. Otherwise open a reserved server
					// pinned to it.
					const canLoad = !isPublic || (isAdmin && entry.channel === "prod");
					if (canLoad) {
						let armed = !isPublic; // a public server swaps every player: tap twice
						body.row(title, detail, {
							label: "Load",
							color: COLORS.accent,
							onClick: (button) => {
								if (!armed) {
									armed = true;
									button.Text = "Confirm";
									return;
								}
								act(`Loading ${short}`, "pin", entry.assetId);
							},
						});
					} else {
						body.row(title, detail, {
							label: "Open server",
							onClick: () =>
								act(`Opening a server on ${short}`, "newServer", { branch: entry.branch, assetId: entry.assetId }),
						});
					}
				});
				if (!showAll && group.size() > ARTIFACTS_PER_BRANCH) {
					body.link(`Show all ${group.size()}`, () => {
						expanded.add(branchName);
						draw();
					});
				}
			}
		};

		load = () => {
			epoch += 1;
			const myEpoch = epoch;
			spawnIn(tabTrove, () => {
				const [statusOk, statusReply] = call("status");
				const [branchesOk, branchesReply] = call("branches");
				const [artifactsOk, artifactsReply] = call("artifacts");
				if (myEpoch !== epoch) return;
				const fresh: Picker = { branches: [] };
				if (statusOk && typeIs(statusReply, "table")) {
					fresh.status = (statusReply as StatusReply).server;
					fresh.you = (statusReply as StatusReply).you;
				}
				if (branchesOk && typeIs(branchesReply, "table")) fresh.branches = branchesReply as BranchInfo[];
				else fresh.branchesError = str(branchesReply);
				const reply = (typeIs(artifactsReply, "table") ? artifactsReply : {}) as {
					supported?: boolean;
					list?: ArtifactEntry[];
				};
				if (!artifactsOk) fresh.artifactsNote = `Failed: ${str(artifactsReply)}`;
				else if (reply.supported !== true) fresh.artifactsNote = "Kernel 0.2 needed for artifacts";
				else fresh.artifacts = reply.list ?? [];
				data = fresh;
				draw();
			});
		};
		load();
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

		// Every row here is a fixed-height Frame with a scale-sized left part and a fixed-width button pinned right
		// (fixedRow + sideButton): nothing can reach past the content's right edge at any window size.
		const sideGap = -(SIDE_BUTTON + 8);

		// Row 1: session status (one line) + Unpair once paired.
		const sessionRow = page.place(fixedRow());
		const sessionLine = style(
			make("TextLabel", { BackgroundTransparency: 1 }, sessionRow),
			"Checking session...",
			15,
			COLORS.dim,
			Enum.Font.BuilderSansMedium,
		);
		sessionLine.TextWrapped = false;
		sessionLine.TextTruncate = Enum.TextTruncate.AtEnd;
		sessionLine.Size = UDim2.fromScale(1, 1);
		const unpairButton = sideButton(sessionRow, "Unpair");
		unpairButton.Visible = false;
		const showUnpair = (visible: boolean) => {
			unpairButton.Visible = visible;
			sessionLine.Size = new UDim2(1, visible ? sideGap : 0, 1, 0);
		};
		const hint = page.text("", COLORS.dim);
		hint.Visible = false;

		// Pairing (allowed, not paired yet): a masked code box. A TextBox can't mask, so its real text is invisible
		// (TextTransparency 1) under a label that shows one dot per character.
		const pairing = page.group(6);
		pairing.frame.Visible = false;
		const codeRow = pairing.place(fixedRow());
		const codeBox = style(make("TextBox", { ClearTextOnFocus: false }, codeRow), "", 15, COLORS.text, Enum.Font.Code);
		codeBox.TextTransparency = 1;
		codeBox.PlaceholderText = "";
		codeBox.TextWrapped = false;
		codeBox.ClipsDescendants = true;
		codeBox.BackgroundColor3 = COLORS.row;
		codeBox.Size = new UDim2(1, sideGap, 1, 0);
		corner(codeBox, 6);
		pad(codeBox, 0, 8);
		const mask = style(make("TextLabel", { BackgroundTransparency: 1, Interactable: false }, codeBox), "", 15, COLORS.dim, Enum.Font.Code);
		mask.Size = UDim2.fromScale(1, 1);
		mask.TextWrapped = false;
		mask.TextTruncate = Enum.TextTruncate.AtEnd;
		const paintMask = () => {
			const length = math.min(codeBox.Text.size(), 64);
			mask.Text = length > 0 ? string.rep("•", length) : "Pairing code";
			mask.TextColor3 = length > 0 ? COLORS.text : COLORS.dim;
		};
		paintMask();
		tabTrove.connect(codeBox.GetPropertyChangedSignal("Text"), paintMask);
		const pairButton = sideButton(codeRow, "Pair", COLORS.accent, COLORS.dark);
		pairing.text("Paste the pairing code printed by typetorch-dev-server", COLORS.dim);
		const pairResult = pairing.text("", COLORS.dim);
		pairResult.Visible = false;
		const showPairResult = (text: string, color: Color3) => {
			pairResult.Text = text;
			pairResult.TextColor3 = color;
			pairResult.Visible = text !== "";
		};

		// Composer (paired): prompt, then [Dex path] [Errors] ... [Send].
		const composer = page.group(6);
		composer.frame.Visible = false;
		const list = page.group(8);

		const box = composer.input("Describe a change", 110, true);
		box.Text = claudeDraft;
		tabTrove.connect(box.GetPropertyChangedSignal("Text"), () => (claudeDraft = box.Text));
		// Row: [Dex path] [Errors] on the left (half of the left part each, capped), Send pinned right.
		const actions = composer.place(fixedRow());
		const toggles = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, sideGap, 1, 0) }, actions);
		make(
			"UIListLayout",
			{ FillDirection: Enum.FillDirection.Horizontal, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) },
			toggles,
		);
		const toggle = (text: string, order: number, onClick: () => void) => {
			const button = style(make("TextButton", { AutoButtonColor: true }), text, 15, COLORS.text, Enum.Font.BuilderSansMedium);
			button.TextXAlignment = Enum.TextXAlignment.Center;
			button.TextWrapped = false;
			button.TextTruncate = Enum.TextTruncate.AtEnd;
			button.Size = new UDim2(0.5, -3, 1, 0);
			button.LayoutOrder = order;
			make("UISizeConstraint", { MaxSize: new Vector2(130, math.huge) }, button);
			corner(button, 6);
			pad(button, 0, 6);
			button.Parent = toggles;
			button.Activated.Connect(onClick);
			return button;
		};
		const pathToggle = toggle("Dex path", 1, () => {
			attachPath = !attachPath;
			paintSelected(pathToggle, attachPath, COLORS.info);
		});
		const errorsToggle = toggle("Errors", 2, () => {
			attachErrors = !attachErrors;
			paintSelected(errorsToggle, attachErrors, COLORS.info);
		});
		paintSelected(pathToggle, attachPath, COLORS.info);
		paintSelected(errorsToggle, attachErrors, COLORS.info);
		const sendButton = sideButton(actions, "Send", COLORS.accent, COLORS.dark);
		const result = composer.text("", COLORS.dim);
		result.Visible = false;
		const showResult = (text: string, color: Color3) => {
			result.Text = text;
			result.TextColor3 = color;
			result.Visible = text !== "";
		};

		let requests = new Array<ClaudeRequestView>();
		let sending = false;
		let pairingBusy = false;

		const replace = (updated: ClaudeRequestView) => {
			const index = requests.findIndex((request) => request.id === updated.id);
			if (index === -1) requests.unshift(updated);
			else requests[index] = updated;
		};

		let drawList: () => void;
		let refreshSession: () => void;
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
				if (request.mine && !request.finished) {
					sideButton(card.place(fixedRow()), "Cancel", COLORS.bad, COLORS.dark).Activated.Connect(() => cancel(request.id));
				}
			}
		};

		refreshSession = () => {
			const [ok, reply] = call("claude.session");
			if (!ok || !typeIs(reply, "table")) {
				sessionLine.Text = `Failed: ${str(reply)}`;
				sessionLine.TextColor3 = COLORS.bad;
				return;
			}
			const session = reply as ClaudeSessionView;
			const paired = session.paired === true;
			let hintText = "";
			if (!session.available) {
				sessionLine.Text = "Not connected";
				sessionLine.TextColor3 = COLORS.warn;
				hintText = "Start `typetorch remote-claude` on this branch";
			} else if (!session.allowed) {
				sessionLine.Text = `Connected · ${session.label} · not allowed`;
				sessionLine.TextColor3 = COLORS.warn;
				hintText = "You are not on the session's user list";
			} else if (!paired) {
				sessionLine.Text = `Connected · ${session.label} · not paired`;
				sessionLine.TextColor3 = COLORS.warn;
			} else {
				sessionLine.Text = `Connected · ${session.label} · ${str(session.branch)}`;
				sessionLine.TextColor3 = COLORS.good;
			}
			hint.Text = hintText;
			hint.Visible = hintText !== "";
			const usable = session.available && session.allowed;
			pairing.frame.Visible = usable && !paired;
			composer.frame.Visible = usable && paired;
			showUnpair(usable && paired);
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

		// The code goes to the server once and is cleared at once; it is never logged.
		const pair = () => {
			const code = (codeBox.Text.match("^%s*(.-)%s*$")[0] as string | undefined) ?? "";
			codeBox.Text = "";
			if (code === "") return showPairResult("Paste a code first", COLORS.warn);
			showPairResult("Pairing...", COLORS.dim);
			const [ok, reply] = call("claude.pair", { code });
			const answer = (typeIs(reply, "table") ? reply : {}) as ClaudeReply;
			if (ok && answer.ok === true) {
				showPairResult("", COLORS.dim);
				showResult("Paired", COLORS.good);
				refreshSession();
			} else {
				showPairResult(claudeError(ok ? answer.error : reply), COLORS.bad);
			}
		};
		const startPair = () => {
			if (pairingBusy) return;
			pairingBusy = true;
			spawnIn(tabTrove, () => {
				const [ok, err] = pcall(pair);
				pairingBusy = false;
				if (!ok) showPairResult(`Failed: ${err}`, COLORS.bad);
			});
		};
		pairButton.Activated.Connect(startPair);
		tabTrove.connect(codeBox.FocusLost, (enterPressed) => {
			if (enterPressed) startPair();
		});
		unpairButton.Activated.Connect(() =>
			spawnIn(tabTrove, () => {
				call("claude.unpair");
				showResult("", COLORS.dim);
				refreshSession();
			}),
		);

		const send = () => {
			const prompt = (box.Text.match("^%s*(.-)%s*$")[0] as string | undefined) ?? "";
			if (prompt === "") return showResult(claudeError("empty"), COLORS.warn);
			showResult("Sending...", COLORS.dim);
			const request: ClaudePromptRequest = { prompt: prompt.sub(1, 4000), errors: attachErrors };
			if (attachPath && dexSelection !== undefined) request.path = dexSelection;
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
				// The dev machine dropped this pairing: show the code box again.
				if (ok && answer.error === "needs_pairing") refreshSession();
			}
		};
		sendButton.Activated.Connect(() => {
			if (sending) return;
			sending = true;
			spawnIn(tabTrove, () => {
				const [ok, err] = pcall(send);
				sending = false;
				if (!ok) showResult(`Failed: ${err}`, COLORS.bad);
			});
		});

		// The session every 10 s; active requests every 2.5 s in between (only while this tab is open).
		let tick = 0;
		every(tabTrove, CLAUDE_POLL, () => {
			if (tick % 4 === 0) refreshSession();
			else pollActive();
			tick += 1;
		});
	};

	/** Keys: a tab name, or "Tab/Sub" for tabs with sub-tabs. */
	const RENDER: Record<string, (tab: TabContext) => void> = {
		Artifact: renderArtifact,
		"Server/Status": renderServer,
		"Server/Branch": renderBranch,
		Logs: renderLogs,
		Dex: renderDex,
		Network: renderNetwork,
		State: renderState,
		Claude: renderClaude,
	};

	// Window ----------------------------------------------------------------------------------------------------------

	let ui: Ui | undefined;
	let tabTrove: Trove | undefined;
	let isOpen = false;
	let dev = false;

	const selectTab = (name: TabName, sub?: string) => {
		if (!ui || !tabTrove) return;
		tabTrove.clean();
		state.tab = name;
		const body = ui.body;
		const tabSubs = SUBTABS[name];
		let key: string = name;
		let chosen: string | undefined;
		if (tabSubs) {
			chosen = sub ?? subs[name];
			if (chosen === undefined || !tabSubs.includes(chosen)) chosen = tabSubs[0];
			subs[name] = chosen;
			key = `${name}/${chosen}`;
		}
		// Sidebar: plain tabs fill when selected; a group header only tints (its active child fills); only the
		// selected group is expanded.
		for (const [tab, button] of ui.tabButtons) {
			const selected = tab === name;
			if (ui.groups.has(tab)) {
				button.BackgroundColor3 = selected ? COLORS.row : COLORS.header;
				button.TextColor3 = selected ? COLORS.accent : COLORS.text;
			} else {
				button.BackgroundColor3 = selected ? COLORS.accent : COLORS.header;
				button.TextColor3 = selected ? COLORS.dark : COLORS.text;
			}
		}
		for (const [tab, group] of ui.groups) {
			const expanded = tab === name;
			group.frame.Visible = expanded;
			group.collapsed.Visible = !expanded;
			group.expanded.Visible = expanded;
			for (const [child, button] of group.children) {
				const active = expanded && child === chosen;
				button.BackgroundTransparency = active ? 0 : 1;
				button.TextColor3 = active ? COLORS.dark : COLORS.dim;
				button.Font = active ? Enum.Font.BuilderSansBold : Enum.Font.BuilderSansMedium;
			}
		}
		ui.content.CanvasPosition = Vector2.zero;
		const page = Page.mount(ui.content);
		pad(page.frame, 10, 10);
		tabTrove.add(page.frame);
		const toolbar = () => {
			const row = tabTrove!.add(buttonRow());
			row.Name = "Toolbar";
			row.LayoutOrder = 2;
			pad(row, 6, 10);
			row.Parent = body;
			return row;
		};
		const footer = () => {
			const frame = tabTrove!.add(
				make("Frame", {
					Name: "Footer",
					BackgroundTransparency: 1,
					Size: UDim2.fromScale(1, 0),
					AutomaticSize: Enum.AutomaticSize.Y,
					LayoutOrder: 4,
				}),
			);
			pad(frame, 8, 10);
			const footerPage = Page.mount(frame, 4);
			frame.Parent = body;
			return footerPage;
		};
		const render = RENDER[key];
		const [ok, err] = pcall(() => render({ page, trove: tabTrove!, content: ui!.content, toolbar, footer }));
		if (!ok) {
			$warn(`[devtools] ${key} tab failed: ${err}`);
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

		// Offset-sized and centered on its AnchorPoint, so UIScale pops grow from the middle; placed by applyRect.
		const window = make(
			"Frame",
			{
				Name: "Window",
				Active: true,
				Visible: false,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromScale(0.5, 0.5),
				Size: UDim2.fromOffset(MIN_SIZE.X, MIN_SIZE.Y),
				BackgroundColor3: COLORS.window,
				BorderSizePixel: 0,
				ClipsDescendants: true,
			},
			gui,
		);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, window);
		corner(window, 10);

		const header = make(
			"Frame",
			{ Name: "Header", Active: true, BackgroundColor3: COLORS.header, BorderSizePixel: 0, Size: new UDim2(1, 0, 0, HEADER) },
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

		// Sidebar (script-free ScrollingFrame): tabs, and for tabs with sub-tabs an indented group of children right
		// under them (visible while that tab is selected). Clicking a group header opens its first child.
		const tabs = scrolling(window, {
			Name: "Tabs",
			Position: UDim2.fromOffset(0, HEADER),
			Size: new UDim2(0, TAB_WIDTH, 1, -HEADER),
			ScrollBarThickness: 3,
		});
		verticalList(tabs, 4);
		pad(tabs, 8, 8);
		const tabButtons = new Map<TabName, TextButton>();
		const groups = new Map<TabName, SidebarGroup>();
		TABS.forEach((name, index) => {
			const button = style(make("TextButton", { AutoButtonColor: true }), name, 15, COLORS.text, Enum.Font.BuilderSansMedium);
			button.BackgroundColor3 = COLORS.header;
			button.TextWrapped = false;
			button.TextTruncate = Enum.TextTruncate.AtEnd;
			button.Size = new UDim2(1, 0, 0, 36);
			button.LayoutOrder = index * 2;
			corner(button, 6);
			pad(button, 0, 10);
			button.Parent = tabs;
			tabButtons.set(name, button);
			const children = SUBTABS[name];
			if (!children) {
				button.Activated.Connect(() => selectTab(name));
				return;
			}
			button.Activated.Connect(() => selectTab(name, children[0]));
			// Expand indicator: a thin chevron drawn from Frames (right = collapsed, down = expanded).
			const icon = make(
				"Frame",
				{
					BackgroundTransparency: 1,
					AnchorPoint: new Vector2(1, 0.5),
					Position: UDim2.fromScale(1, 0.5),
					Size: UDim2.fromOffset(12, 12),
				},
				button,
			);
			const collapsed = chevron(icon, "right", COLORS.dim, 2);
			const expanded = chevron(icon, "down", COLORS.dim, 2);
			expanded.Visible = false;
			const frame = make(
				"Frame",
				{
					Name: `${name}Group`,
					BackgroundTransparency: 1,
					Size: UDim2.fromScale(1, 0),
					AutomaticSize: Enum.AutomaticSize.Y,
					LayoutOrder: index * 2 + 1,
					Visible: false,
				},
				tabs,
			);
			verticalList(frame, 2);
			make("UIPadding", { PaddingLeft: new UDim(0, 14) }, frame);
			const childButtons = new Map<string, TextButton>();
			children.forEach((child, childIndex) => {
				const childButton = style(make("TextButton", { AutoButtonColor: true }), child, 14, COLORS.dim, Enum.Font.BuilderSansMedium);
				childButton.BackgroundColor3 = COLORS.accent;
				childButton.BackgroundTransparency = 1;
				childButton.TextWrapped = false;
				childButton.TextTruncate = Enum.TextTruncate.AtEnd;
				childButton.Size = new UDim2(1, 0, 0, 32);
				childButton.LayoutOrder = childIndex;
				corner(childButton, 6);
				pad(childButton, 0, 10);
				childButton.Parent = frame;
				childButton.Activated.Connect(() => selectTab(name, child));
				childButtons.set(child, childButton);
			});
			groups.set(name, { frame, collapsed, expanded, children: childButtons });
		});

		// Right of the tabs: [sub-tabs] [toolbar] [content] [footer]. The bars come and go with the tab; the content
		// takes whatever height is left (UIFlexItem Fill), so toolbars and footers stay put while it scrolls.
		const body = make(
			"Frame",
			{
				Name: "Body",
				BackgroundTransparency: 1,
				Position: UDim2.fromOffset(TAB_WIDTH, HEADER),
				Size: new UDim2(1, -TAB_WIDTH, 1, -HEADER),
			},
			window,
		);
		verticalList(body, 0);
		// Right/bottom margin, so scrollbars, buttons and fields never touch the window border.
		make("UIPadding", { PaddingRight: new UDim(0, BODY_MARGIN), PaddingBottom: new UDim(0, BODY_MARGIN) }, body);
		// No UIPadding on the ScrollingFrame itself: it shifts scale-width children without shrinking them, so they
		// overflow the right edge. selectTab pads the Page inside it instead.
		const content = scrolling(body, { Name: "Content", Size: UDim2.fromScale(1, 1), LayoutOrder: 3 });
		make("UIFlexItem", { FlexMode: Enum.UIFlexMode.Fill }, content);

		// Resize grip (bottom-right, touch-sized): two diagonal strokes.
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
			window,
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

		gui.Parent = playerGui;

		// Placement: drag by the header, resize by the grip, double-tap the header to reset. Saved across swaps.
		const viewport = (): Vector2 => {
			if (gui.AbsoluteSize.X > 0 && gui.AbsoluteSize.Y > 0) return gui.AbsoluteSize;
			return Workspace.CurrentCamera?.ViewportSize ?? new Vector2(1280, 720);
		};
		const limits = (): [min: Vector2, max: Vector2] => {
			const view = viewport();
			const max = new Vector2(math.max(200, view.X - SCREEN_MARGIN * 2), math.max(160, view.Y - SCREEN_MARGIN * 2));
			return [new Vector2(math.min(MIN_SIZE.X, max.X), math.min(MIN_SIZE.Y, max.Y)), max];
		};
		const defaultRect = (): Rect => {
			const view = viewport();
			const [min, max] = limits();
			const w = math.clamp(view.X * 0.62, min.X, math.max(min.X, math.min(DEFAULT_MAX.X, max.X)));
			const h = math.clamp(view.Y * 0.7, min.Y, math.max(min.Y, math.min(DEFAULT_MAX.Y, max.Y)));
			return { x: (view.X - w) / 2, y: (view.Y - h) / 2, w, h };
		};
		let rect = defaultRect();
		/** Clamps to the screen (size within limits, header on screen) and places the window. */
		const applyRect = (wanted: Rect, save: boolean) => {
			const view = viewport();
			const [min, max] = limits();
			const w = math.clamp(wanted.w, min.X, max.X);
			const h = math.clamp(wanted.h, min.Y, max.Y);
			const x = math.clamp(wanted.x, 0, math.max(0, view.X - w));
			const y = math.clamp(wanted.y, 0, math.max(0, view.Y - HEADER));
			rect = { x, y, w, h };
			window.Size = UDim2.fromOffset(w, h);
			window.Position = UDim2.fromOffset(x + w / 2, y + h / 2);
			if (save) state.window = { x, y, w, h };
		};
		const place = () => {
			if (state.window) applyRect(state.window, true);
			else applyRect(defaultRect(), false);
		};
		place();
		trove.connect(gui.GetPropertyChangedSignal("AbsoluteSize"), place);

		let drag: { kind: "move" | "resize"; input: InputObject; start: Vector3; from: Rect } | undefined;
		let lastHeaderTap = 0;
		const isPointer = (input: InputObject) =>
			input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
		const begin = (kind: "move" | "resize", input: InputObject) => {
			if (!isPointer(input) || input.UserInputState !== Enum.UserInputState.Begin) return;
			if (kind === "move") {
				const now = os.clock();
				if (now - lastHeaderTap < DOUBLE_TAP) {
					lastHeaderTap = 0;
					drag = undefined;
					state.window = undefined;
					applyRect(defaultRect(), false);
					return;
				}
				lastHeaderTap = now;
			}
			drag = { kind, input, start: input.Position, from: { ...rect } };
		};
		trove.connect(header.InputBegan, (input) => begin("move", input));
		trove.connect(grip.InputBegan, (input) => begin("resize", input));
		trove.connect(UserInputService.InputChanged, (input) => {
			if (!drag) return;
			const mouseMove =
				input.UserInputType === Enum.UserInputType.MouseMovement &&
				drag.input.UserInputType === Enum.UserInputType.MouseButton1;
			if (!mouseMove && input !== drag.input) return;
			const delta = input.Position.sub(drag.start);
			const from = drag.from;
			if (drag.kind === "move") applyRect({ x: from.x + delta.X, y: from.y + delta.Y, w: from.w, h: from.h }, true);
			else applyRect({ x: from.x, y: from.y, w: from.w + delta.X, h: from.h + delta.Y }, true);
		});
		trove.connect(UserInputService.InputEnded, (input) => {
			if (!drag) return;
			const mouseUp =
				input.UserInputType === Enum.UserInputType.MouseButton1 &&
				drag.input.UserInputType === Enum.UserInputType.MouseButton1;
			if (mouseUp || input === drag.input) drag = undefined;
		});

		return { gui, toggle, window, body, content, tabButtons, groups };
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

	return {
		started: () => {
			const [ok, err] = pcall(() => playReloadSound());
			if (!ok) $warn(`[devtools] reload sound failed: ${err}`);
		},
	};
}
