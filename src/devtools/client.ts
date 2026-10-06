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
	KeyRow,
	KeyTrust,
	LogEntry,
	NewServerReport,
	SwapReport,
	SwitchRequest,
	Verified,
} from "../kernel";
import { normalRole } from "../kernel";
import {
	branchAction,
	branchLabel,
	buildAction,
	buildLabel,
	buildName,
	PickerContext,
	requestSwitch,
	showCliNote,
	switchedText,
	switchOffered,
	viewerIsOwner,
} from "./build-actions";
import type { ClientDispatcher, LeafStats } from "../net/runtime";
import { runningModules } from "../runtime/registry";
import { bump, popIn, popOut } from "../ui";
import { ExplorerPersist, mountExplorer } from "./explorer";
import {
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
import { CLAUDE_IMAGE_CHUNK, ImageInbox, takeScreenshot } from "./claude-images";
import { CLAUDE_TOOL_REQUEST, CLAUDE_TOOL_RESPONSE, findTool, formatLogHistory, inspectTool } from "./claude-tools";
import { renderClaudeChat } from "./claude-ui";
import { adminTabs, migrateControl } from "./admin-ui";
import { renderNetworkInspector } from "./network-inspector";
import { renderAssetsTab } from "./assets-ui";
import { renderStateTab, StateExplorerPersist } from "./state-ui";
import { describeState } from "./state";
import type { ArtifactNotes } from "./artifact-notes";
import { badgeLevel, checkHealth, HealthIssue, HealthLevel, ServerFacts } from "./health";
import { NEEDS_KERNEL_AB } from "./ab";
import {
	addButton,
	spacer,
	ArmState,
	armLock,
	newArmState,
	chevron,
	buttonRow,
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
	shortDuration,
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
const MAX_LOG_ROWS = 300;
const HEADER = 46;
const TAB_WIDTH = 116;
/** Gap between the body (right of the tabs) and the window's right and bottom borders. */
const BODY_MARGIN = 8;
/** Artifact rows shown per branch before "Show all". */
const ARTIFACTS_PER_BRANCH = 6;
/** Artifact tab: seconds between updates of its "Running", "Server up" and "Built ... ago" texts. */
const TIMES_REFRESH = 5;
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

/** Short text for the "logs.player" errors of devtools/server.ts. */
const OTHER_LOG_ERRORS: Record<string, string> = {
	no_reply: "No reply from that player",
	not_in_server: "That player left",
	rate_limited: "Slow down",
};

/** Logs > Upload ("logs.upload", claude.ts): one short line per error code. */
const UPLOAD_ERRORS: Record<string, string> = {
	needs_pairing: "Pair in the Claude tab first",
	not_connected: "Pair in the Claude tab first",
	not_allowed: "Pair in the Claude tab first",
	prod_channel: "Dev servers only",
	rate_limited: "Slow down",
	player_gone: "That player left",
	no_reply: "No reply from that player",
	player_logs_failed: "No reply from that player",
	too_large: "Too large",
	unreachable: "Dev PC unreachable",
	disabled: "Dev-server too old",
};
/** The client's own logs for Logs > Upload: about 256 KB, newest kept (the server caps it again). */
const CLIENT_UPLOAD_BYTES = 256 * 1024;

const TABS = ["Artifact", "Modules", "Server", "Manage", "Logs", "Dex", "Network", "Claude"] as const;
type TabName = (typeof TABS)[number];
/** Tabs with sub-tabs (a segmented bar on top of the content); the first one is the default. */
const SUBTABS: Partial<Record<TabName, readonly string[]>> = { Modules: ["Overview", "State", "Assets"], Server: ["Status", "Branch"], Manage: ["Players", "Servers", "Bans"], Network: ["Packets", "Stats"] };

interface StatusReply {
	server: KernelStatus;
	artifact: ArtifactInfo;
	modules: ModuleSummary[];
	you: DevInfo;
	/** Missing on frameworks before the health checks. */
	facts?: ServerFacts;
}

/** How often a dev's client re-checks server health for the badge while the menu is closed. */
const HEALTH_INTERVAL = 30;
const ISSUE_COLORS: Record<HealthLevel, Color3> = { error: COLORS.bad, warn: COLORS.warn, info: COLORS.info };

/** A small round status dot on `parent` (created once, then recolored or hidden). */
function paintDot(parent: GuiObject, level: HealthLevel | undefined, position: UDim2, anchor: Vector2) {
	let dot = parent.FindFirstChild("Badge") as Frame | undefined;
	if (!dot) {
		dot = make("Frame", { Name: "Badge", BorderSizePixel: 0, Size: UDim2.fromOffset(9, 9), ZIndex: 3 }, parent);
		make("UICorner", { CornerRadius: new UDim(1, 0) }, dot);
		make("UIStroke", { Color: COLORS.window, Thickness: 1.5 }, dot);
	}
	dot.Position = position;
	dot.AnchorPoint = anchor;
	dot.Visible = level !== undefined;
	if (level) dot.BackgroundColor3 = ISSUE_COLORS[level];
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
	/** Sidebar groups left open (they stay open until their header is clicked again). */
	openGroups?: string[];
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

/** Roblox's verified badge: a private-use character (U+E000) that Roblox fonts draw as the badge. */
const VERIFIED_BADGE = utf8.char(0xe000);

/**
 * Kernel 0.3: one verified badge per signature of a deploy that checks out (two when the main and the fallback key
 * both do, one for either alone), as RichText; "" for unsigned or unverified deploys and on older kernels.
 */
function verifiedBadges(verified: Verified | undefined): string {
	if (!typeIs(verified, "table")) return "";
	const count = (verified.main === true ? 1 : 0) + (verified.fallback === true ? 1 : 0);
	return count > 0 ? ` <font color="${hex(COLORS.info)}">${VERIFIED_BADGE.rep(count)}</font>` : "";
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
	if (!ok) return [reply === NEEDS_KERNEL_AB ? "Needs kernel 0.2.3" : `Failed: ${str(reply)}`, COLORS.bad];
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
	// Sidebar groups stay open until their own header is clicked again; opening another tab doesn't collapse them.
	if (state.openGroups === undefined) state.openGroups = [];
	const openGroups = new Set<string>(state.openGroups);
	const saveOpenGroups = () => {
		const list = new Array<string>();
		for (const group of openGroups) list.push(group);
		state.openGroups = list;
	};

	// Health badge: a dot on the DEV button and the Server tab while the server has warnings or errors (health.ts).
	// Fed by the Status page and, while the menu is closed, by a slow poll.
	let healthLevel: HealthLevel | undefined;
	let paintBadges = () => {};
	const setHealth = (issues: HealthIssue[]) => {
		healthLevel = badgeLevel(issues);
		paintBadges();
	};
	// Before sub-tabs, Branch was a top-level tab.
	if (state.tab === "Branch") {
		state.tab = "Server";
		subs.Server = "Branch";
	}
	if (state.tab === "State") {
		state.tab = "Modules";
		subs.Modules = "State";
	}
	// Framework 0.3.2: the Admin group is Manage (owners only).
	if (state.tab === "Admin") state.tab = "Manage";
	const oldSubs = subs as Record<string, string | undefined>;
	const adminSub = oldSubs.Admin;
	if (adminSub !== undefined) {
		subs.Manage = adminSub;
		oldSubs.Admin = undefined;
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
	// Claude's client-realm tools (inspect / find on this client's DataModel). The server asks only the dev who sent the prompt.
	dispatcher.setRaw(CLAUDE_TOOL_REQUEST, (id, tool, args) => {
		if (!typeIs(id, "number") || !typeIs(tool, "string")) return;
		const input = (typeIs(args, "table") ? args : {}) as Record<string, unknown>;
		// find yields while it walks (and a screenshot waits for the capture), so it runs in its own thread.
		task.spawn(() => {
			const [ok, result] = pcall(() => {
				if (tool === "inspect") return inspectTool(input);
				if (tool === "find") return findTool(input);
				if (tool === "screenshot") {
					// What the dev sees, without the dev menu; only the capture time leaves this client (the dev machine
					// picks the file up on its PC).
					const devGui = Players.LocalPlayer.FindFirstChildOfClass("PlayerGui")?.FindFirstChild("TypeTorchDev");
					const taken = takeScreenshot(devGui !== undefined && devGui.IsA("ScreenGui") ? [devGui] : []);
					if (!taken.ok) error(taken.error, 0);
					return HttpService.JSONEncode({ captureTime: taken.value.captureTime, localId: taken.value.localId });
				}
				return error("unknown tool", 0);
			});
			kernel.send(CLAUDE_TOOL_RESPONSE, id, ok, tostring(result));
		});
	});
	// Images Claude showed: chunks pushed by the server for this dev only, joined by the Claude tab.
	const imageInbox = new ImageInbox();
	dispatcher.setRaw(CLAUDE_IMAGE_CHUNK, (id, index, count, data) => imageInbox.push(id, index, count, data));
	trove.add(() => {
		dispatcher.removeRaw(DEV_RESPONSE);
		dispatcher.removeRaw(DEVLOGS_REQUEST);
		dispatcher.removeRaw(CLAUDE_TOOL_REQUEST);
		dispatcher.removeRaw(CLAUDE_IMAGE_CHUNK);
		imageInbox.clear();
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

	/** One public key: its fingerprint (and a tag); tapping the row copies the full base64. */
	const keyRow = (target: Page, key: KeyRow, extra: string, color = COLORS.text) => {
		const row = target.row(`<font color="${hex(color)}"><b>${escapeRich(key.fingerprint)}</b></font>${extra}`, escapeRich(`${key.key.sub(1, 16)}...`));
		const hit = make("TextButton", { Name: "Copy", Text: "", AutoButtonColor: false, BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: 0 }, row);
		hit.Activated.Connect(() => copyText(key.key, row));
	};

	const drawSigning = (target: Page, keys: KeyTrust) => {
		const modeText = keys.mode === "key asset" ? "Root Key" : keys.mode === "fallback only" ? "Fallback Key only" : "No keys";
		const modeColor = keys.mode === "key asset" ? COLORS.good : keys.mode === "fallback only" || !keys.signedOnly ? COLORS.warn : COLORS.bad;
		target.field("Mode", modeText, modeColor);
		target.field("This server", keys.signedOnly ? "Signed deploys only" : "Unsigned allowed (dev)");
		const assetText = keys.keyAssetId !== undefined ? `${keys.keyAssetId}${keys.version !== undefined ? `  v${keys.version}` : ""}` : "-";
		target.field("Root Key asset", assetText);
		target.field("Loaded", keys.loaded ? utc(keys.loadedAt) : "Never", keys.loaded ? COLORS.text : COLORS.warn);
		if (keys.lastError !== undefined) {
			const when = keys.lastErrorAt !== undefined ? `  ${utc(keys.lastErrorAt)}` : "";
			target.field("Last error", `${keys.lastError}${when}`, keys.lastReadOk === false ? COLORS.warn : COLORS.dim);
		}
		if (keys.configError !== undefined) target.field("Setup", keys.configError, COLORS.bad);
		const change = keys.lastChange;
		if (change) {
			const fingerprints = `${change.before.publicKeys.join(" ")} > ${change.after.publicKeys.join(" ")}`;
			target.field(change.hinted ? "Rotated" : "Changed", `${utc(change.at)}  ${fingerprints}${change.hinted ? "" : "  (no rekey hint)"}`, change.hinted ? COLORS.warn : COLORS.bad);
		}
		const rejected = keys.rejected;
		target.field("Rejected", rejected.total > 0 ? `${rejected.total}  ${rejected.last?.why ?? ""}` : "0", rejected.total > 0 ? COLORS.warn : COLORS.text);
		target.text("Root Key", COLORS.dim);
		if (keys.publicKeys.size() === 0) target.text("None", keys.loaded ? COLORS.bad : COLORS.dim);
		for (const key of keys.publicKeys) keyRow(target, key, key.revoked === true ? tag("REVOKED", COLORS.bad) : "");
		if (keys.revokedKeys.size() > 0) {
			target.text("Revoked", COLORS.dim);
			for (const key of keys.revokedKeys) keyRow(target, key, "", COLORS.dim);
		}
		target.text("Fallback Key", COLORS.dim);
		const fallback = keys.fallback;
		if (fallback) keyRow(target, fallback, fallback.revoked ? tag("REVOKED", COLORS.bad) : "", fallback.revoked ? COLORS.bad : COLORS.text);
		else target.text("None", keys.signedOnly ? COLORS.warn : COLORS.dim);
		// The unsigned heads kernel deploy vouched for (BootstrapHeads), and whether this server has a trusted head at all.
		const bootstrap = keys.bootstrap;
		if (bootstrap !== undefined && next(bootstrap)[0] !== undefined) {
			target.text("Bootstrap heads", COLORS.dim);
			for (const [branch, head] of pairs(bootstrap)) {
				target.field(branch, `#${head.seq}  ${head.artifactId ?? `asset-${head.assetId}`}`);
			}
		}
		if (keys.unverified === true) target.field("Head", "Unverified (boot fail-safe)", COLORS.bad);
		else if (keys.noTrustedHead === true) target.field("Head", "No trusted prod head", COLORS.bad);
	};

	// Modules > Overview: one realm at a time (Server | Client toolbar, like Logs), refreshed every REFRESH s: each module
	// in load order with its init time, lifecycle hooks and dependencies. Server data comes from the "state" op, client
	// data from this client (describeState). Modules > State is the state explorer (state-ui.ts).
	let modulesRealm: "server" | "client" = "server";
	const renderModulesView = (tab: TabContext, draw: (target: Page, summary: StateSummary) => void) => {
		const bar = tab.toolbar();
		const buttons = new Map<string, TextButton>();
		const body = tab.page.group();
		const refresh = () => {
			for (const [realm, button] of buttons) paintSelected(button, realm === modulesRealm);
			if (modulesRealm === "client") {
				body.clear();
				draw(body, describeState());
				return;
			}
			const [ok, reply] = call("state");
			if (modulesRealm !== "server") return;
			body.clear();
			if (ok && typeIs(reply, "table")) draw(body, reply as StateSummary);
			else body.text(`Failed: ${str(reply)}`, COLORS.bad);
		};
		const pick = (realm: "server" | "client") => {
			modulesRealm = realm;
			spawnIn(tab.trove, refresh);
		};
		buttons.set("server", addButton(bar, "Server", () => pick("server")));
		buttons.set("client", addButton(bar, "Client", () => pick("client")));
		every(tab.trove, REFRESH, refresh);
	};
	const renderModulesOverview = (tab: TabContext) =>
		renderModulesView(tab, (target, summary) => {
			const modules = [...summary.modules];
			modules.sort((a, b) => (a.loadOrder ?? 0) < (b.loadOrder ?? 0));
			if (modules.size() === 0) target.text("None", COLORS.dim);
			for (const mod of modules) {
				const parts = new Array<string>();
				parts.push(mod.initMs !== undefined ? `init ${mod.initMs} ms` : "no onInit");
				if (mod.hooks.size() > 0) parts.push(mod.hooks.join(", "));
				if (mod.dependencies.size() > 0) parts.push(`needs ${mod.dependencies.join(", ")}`);
				target.field(mod.name, parts.join("  ·  "));
			}
		});
	// Modules > State: the live state explorer (state-ui.ts); open nodes, pages, filter and Auto survive swaps.
	const stateExplorer = kernel.persist("typetorch/state-explorer", (): StateExplorerPersist => ({}));
	const renderModulesState = (tab: TabContext) =>
		renderStateTab(tab, {
			call,
			realm: () => modulesRealm,
			setRealm: (realm) => {
				modulesRealm = realm;
			},
			persist: stateExplorer,
		});

	const renderArtifact = ({ page, trove: tabTrove }: TabContext) => {
		page.section("Client");
		page.field("Artifact", kernel.artifact.id);
		page.field("Generation", `#${kernel.generation}`);
		// How long this client generation has run (kernel 0.2.2+ `start`), in Manage > Servers' words ("12m", "3h 04m").
		const clientStarted = kernel.start?.startedAt;
		const clientRunning = page.field("Running", "-");
		page.field("Branch", str(kernel.branch));
		page.field("Channel", str(kernel.channel));
		page.field("Kernel", `${kernel.kernelVersion} (API ${kernel.kernelApi})`);
		/** The server's times as of the status reply (os.clock() then); the loop below adds the time since. */
		let serverTimes: { at: number; generation?: number; server?: number; builtAt?: number; running: TextBox; up: TextBox; built: TextBox } | undefined;
		/** "2026-10-05 17:51:37 UTC (8m ago)". */
		const builtText = (builtAt: number) => `${utc(builtAt)} (${shortDuration(DateTime.now().UnixTimestamp - builtAt)} ago)`;
		/** Text only, no re-layout: called every TIMES_REFRESH s while the tab is open. */
		const paintTimes = () => {
			clientRunning.Text = clientStarted !== undefined ? shortDuration(os.time() - clientStarted) : "-";
			const times = serverTimes;
			if (!times) return;
			const since = os.clock() - times.at;
			times.running.Text = times.generation !== undefined ? shortDuration(times.generation + since) : "-";
			times.up.Text = times.server !== undefined ? shortDuration(times.server + since) : "-";
			if (times.builtAt !== undefined) times.built.Text = builtText(times.builtAt);
		};
		paintTimes();
		spawnIn(tabTrove, () => {
			while (true) {
				task.wait(TIMES_REFRESH);
				paintTimes();
			}
		});
		const server = page.group();
		server.text("Loading server...", COLORS.dim);
		const signing = page.group();
		spawnIn(tabTrove, () => {
			const [ok, reply] = call("status");
			server.clear();
			if (!ok || !typeIs(reply, "table")) {
				server.text(`Server: ${str(reply)}`, COLORS.bad);
				return;
			}
			const { artifact, server: status } = reply as StatusReply;
			server.section("Server artifact");
			const idBox = server.field("Id", str(artifact.id));
			const idBadges = verifiedBadges(status.generation?.artifact.verified);
			if (idBadges !== "") {
				idBox.RichText = true;
				idBox.Text = escapeRich(str(artifact.id)) + idBadges;
			}
			server.field("Channel", str(artifact.channel));
			server.field("Branch", str(artifact.branch));
			server.field("Commit", str(artifact.commit));
			server.field("Commit hash", str(artifact.commitHash));
			server.field("Asset id", str(artifact.assetId));
			server.field("Seq", str(artifact.seq));
			const builtAt = typeIs(artifact.builtAt, "number") ? artifact.builtAt : undefined;
			const built = server.field("Built", builtAt !== undefined ? builtText(builtAt) : utc(artifact.builtAt));
			server.section("Server generation");
			server.field("Generation", status.generation ? `${status.generation.name} (#${status.generation.number})` : "-");
			const running = server.field("Running", "-");
			const up = server.field("Server up", "-");
			serverTimes = {
				at: os.clock(),
				generation: typeIs(status.generation?.uptime, "number") ? status.generation.uptime : undefined,
				server: typeIs(status.uptime, "number") ? status.uptime : undefined,
				builtAt,
				running,
				up,
				built,
			};
			paintTimes();
			server.field("Kernel", `${status.kernelVersion}${status.kernelBuild !== undefined ? `@${status.kernelBuild}` : ""} (API ${status.kernelApi})`);
		});
		// Signing (kernel 0.3): the trust state, compact; tap a key row for its full base64.
		spawnIn(tabTrove, () => {
			const [ok, reply] = call("keys");
			signing.clear();
			signing.section("Signing");
			const keysReply = (typeIs(reply, "table") ? reply : {}) as { supported?: boolean; keys?: KeyTrust };
			if (!ok) signing.text(`Failed: ${str(reply)}`, COLORS.bad);
			else if (keysReply.supported !== true || keysReply.keys === undefined) signing.text("Signing needs kernel 0.3", COLORS.dim);
			else drawSigning(signing, keysReply.keys);
		});
	};

	// Server > Status
	const renderServer = (tab: TabContext) => {
		const { page, trove: tabTrove } = tab;
		// "Migrate" on the kernel-update issue (admin-ui.ts): moves everyone to a fresh server on the new kernel.
		const migrateButton = migrateControl(tab, { kernel, call });
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
			const issues = checkHealth(status, (reply as StatusReply).facts);
			setHealth(issues);
			if (issues.size() > 0) {
				body.section("Attention");
				for (const issue of issues) {
					body.field(issue.title, issue.detail, ISSUE_COLORS[issue.level]);
					if (issue.action === "migrate") migrateButton(body, status);
				}
			}
			body.section("Server");
			body.field("Type", status.serverType);
			body.field("Job", str(status.jobId));
			body.field("Place version", str(status.placeVersion));
			body.field("Branch", `${str(status.branch)} (${str(status.channel)})`);
			// Kernel 0.3.4: who switched this server (or loaded a build here), one dim line.
			const switchedLine = switchedText(status.switched, os.time());
			if (switchedLine !== undefined) body.text(switchedLine, COLORS.dim);
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
			body.field("Kernel", `${status.kernelVersion}${status.kernelBuild !== undefined ? `@${status.kernelBuild}` : ""} (API ${status.kernelApi})`);
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
		// Upload: one line with the outcome, until the next upload or 10 s.
		const uploadNote = page.text("", COLORS.good);
		uploadNote.Visible = false;
		let uploadShown = 0;
		const setUpload = (text: string, color: Color3) => {
			uploadShown += 1;
			const mine = uploadShown;
			uploadNote.Text = text;
			uploadNote.TextColor3 = color;
			uploadNote.Visible = true;
			bump(uploadNote);
			tabTrove.add(
				task.delay(10, () => {
					if (mine === uploadShown) uploadNote.Visible = false;
				}),
			);
		};
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
				// The kernel's own notes (info lines starting "[TypeTorch] ", e.g. kernel 0.3.5's "no ConfigService registry
				// (optional)") are dim: nothing to act on.
				const kernelNote = entry.kind === "info" && entry.text.sub(1, 12) === "[TypeTorch] ";
				shown.push(rows.text(line, kernelNote ? COLORS.dim : LOG_COLORS[entry.kind] ?? COLORS.text, true));
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
		// Upload the shown logs to the paired dev PC (<repo>/.typetorch/logs/), no Claude involved: the Claude tab's
		// pairing, op "logs.upload" (claude.ts). Server: this server's log ring; Client: this client's; Others: the
		// picked player's client logs (the Logs > Others path).
		spacer(bar);
		let uploading = false;
		const uploadButton = addButton(bar, "Upload", () => {
			if (uploading) return;
			let payload: Record<string, unknown>;
			if (logRealm === "server") payload = { kind: "server" };
			else if (logRealm === "client") {
				payload = {
					kind: "client",
					text: formatLogHistory(kernel.logs(undefined, 1000), CLIENT_UPLOAD_BYTES),
					artifact: `${kernel.artifact.id}#${kernel.generation}`,
				};
			} else if (logPlayer !== undefined) payload = { kind: "player", userId: logPlayer };
			else {
				setUpload("Pick a player", COLORS.dim);
				return;
			}
			uploading = true;
			uploadButton.Text = "Uploading...";
			spawnIn(tabTrove, () => {
				const [ok, reply] = call("logs.upload", payload);
				uploading = false;
				uploadButton.Text = "Upload";
				const answer = (typeIs(reply, "table") ? reply : {}) as { ok?: boolean; error?: unknown; lines?: unknown };
				if (ok && answer.ok === true) {
					setUpload(`Saved on the dev PC (${typeIs(answer.lines, "number") ? answer.lines : "?"} lines)`, COLORS.good);
					return;
				}
				const code = ok ? answer.error : reply;
				setUpload(typeIs(code, "string") ? UPLOAD_ERRORS[code] ?? `Failed: ${code}` : "Failed", COLORS.bad);
			});
		});
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
			/** The kernel has A/B experiment pins (0.2.3+). */
			experiments?: boolean;
		}
		let data: Picker | undefined;
		const expanded = new Set<string>();
		/** Two-tap state per row (kept across redraws). */
		const arms = new Map<string, ArmState>();
		const armOf = (key: string) => {
			let state = arms.get(key);
			if (!state) {
				state = newArmState();
				arms.set(key, state);
			}
			return state;
		};
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
		/** Kernel 0.3.4: the owner switches THIS server or loads a build here from their own client (a swap restarts this menu). */
		const ownerSwitch = (label: string, request: SwitchRequest, unlock: () => void) => {
			setResult(`${label}...`, COLORS.dim);
			spawnIn(tabTrove, () => {
				const reply = requestSwitch(kernel, request);
				if (reply.ok) setResult(reply.generation !== undefined ? `Running ${reply.generation}` : "Done", COLORS.good);
				else {
					setResult(`Failed: ${reply.error ?? "unknown error"}`, COLORS.bad);
					unlock();
				}
				load();
			});
		};
		addButton(bar, "Reload", () => act("Reloading", "reload"));
		addButton(bar, "Rollback", () => act("Rolling back", "rollback"));

		// Tapping an artifact row anywhere but its button expands what changed (artifact.info: the asset description).
		const notes = new Map<number, ArtifactNotes | string>();
		const notesText = (value: ArtifactNotes | string): string => {
			const dim = (text: string) => `<font size="14" color="${hex(COLORS.dim)}">${escapeRich(text)}</font>`;
			if (typeIs(value, "string")) return dim(value);
			const lines = new Array<string>();
			for (const change of value.changes) lines.push(`<font size="14">- ${escapeRich(change)}</font>`);
			if (lines.size() === 0) lines.push(dim("No change notes for this build"));
			const id = value.identity;
			const sources = new Array<string>();
			if (id.commit !== undefined) sources.push(`template ${id.commit.sub(1, 7)}`);
			if (id.framework !== undefined) sources.push(`framework ${id.framework}`);
			if (id.kernel !== undefined) sources.push(`kernel ${id.kernel}`);
			if (id.built !== undefined) sources.push(`built ${id.built}`);
			if (sources.size() > 0) lines.push(dim(sources.join("  ")));
			return lines.join("\n");
		};
		const expandable = (row: Frame, assetId: number) => {
			const label = row.FindFirstChildWhichIsA("TextLabel");
			if (!label) return;
			// Under the label and the action button (ZIndex 0), so the button keeps its own clicks.
			const hit = make("TextButton", { Name: "Expand", Text: "", AutoButtonColor: false, BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: 0 }, row);
			const base = label.Text;
			let open = false;
			const show = (extra?: string) => (label.Text = open && extra !== undefined ? `${base}\n${extra}` : base);
			hit.Activated.Connect(() => {
				open = !open;
				if (!open) return show();
				const cached = notes.get(assetId);
				if (cached !== undefined) return show(notesText(cached));
				show(notesText("Loading..."));
				spawnIn(tabTrove, () => {
					const [ok, reply] = call("artifact.info", assetId);
					const value = ok && typeIs(reply, "table") ? (reply as ArtifactNotes) : `Unavailable: ${str(reply)}`;
					notes.set(assetId, value);
					show(notesText(value));
				});
			});
		};

		draw = () => {
			if (!data) return;
			body.clear();
			const status = data.status;
			const serverType = status?.serverType;
			const isPublic = serverType === "public";
			const isOwner = data.you?.dev === true && normalRole(data.you.role) === "owner";
			const running = status?.generation?.artifact;
			const [switchKernel] = switchOffered(kernel);
			const ctx: PickerContext = {
				serverType,
				signedOnly: status?.signedOnly === true,
				isOwner,
				switchKernel,
				experiments: data.experiments === true,
			};
			const players = status?.players ?? 0;
			const playersText = `${players} player${players === 1 ? "" : "s"}`;

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
				const runningBox = body.field("Running", artifactText);
				const runningBadges = verifiedBadges(running?.verified);
				if (runningBadges !== "") {
					runningBox.RichText = true;
					runningBox.Text = escapeRich(artifactText) + runningBadges;
				}
				const pinned = status.pinned === true;
				const pinText = status.experiment !== undefined ? "A/B experiment, until the next deploy" : pinned ? "yes, until the next deploy" : "no";
				body.field("Pinned", pinText, pinned ? COLORS.warn : COLORS.text);
				// Kernel 0.3.4: who switched this server (or loaded a build here), one dim line.
				const switchedLine = switchedText(status.switched, os.time());
				if (switchedLine !== undefined) body.text(switchedLine, COLORS.dim);
			} else {
				body.text("Status unavailable", COLORS.bad);
			}

			// Branch picker (build-actions.ts): "Switch" moves THIS server (on public servers the owner's switch, kernel 0.3.4,
			// for this server's lifetime; the stored switch on private/reserved/Studio servers); "Join" moves only you to a
			// reserved server on that branch (everyone else on public servers).
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
				const action = branchAction(ctx, current);
				if (action === undefined) {
					body.row(title, detail);
				} else if (action === "join") {
					body.row(title, detail, {
						label: branchLabel(action),
						color: COLORS.accent,
						onClick: () => act(`Moving you to a ${branch.name} server`, "newServer", branch.name),
					});
				} else if (action === "stored") {
					body.row(title, detail, {
						label: branchLabel(action),
						color: COLORS.accent,
						onClick: () => act(`Switching to ${branch.name}`, "switch", branch.name),
					});
				} else {
					const row = body.row(title, detail, { label: branchLabel(action), color: COLORS.accent, onClick: () => {} });
					const button = row.FindFirstChildWhichIsA("TextButton");
					if (button) {
						armLock(
							button,
							armOf(`branch:${branch.name}`),
							{ label: branchLabel(action), color: COLORS.accent },
							"Switching...",
							() => setResult(`Switch this server (${playersText}) to ${branch.name}?`, COLORS.warn),
							(unlock) => ownerSwitch(`Switching to ${branch.name}`, { branch: branch.name }, unlock),
						);
					}
				}
			}

			// Build picker: newest first, grouped by branch.
			body.section("Builds");
			const artifacts = data.artifacts;
			if (artifacts === undefined) {
				body.text(data.artifactsNote ?? "Unavailable", COLORS.dim);
				return;
			}
			if (artifacts.size() === 0) body.text("None yet", COLORS.dim);
			// Kernels before 0.3.4: a prod server takes only CLI-signed pins, so nothing loads in place there.
			if (showCliNote(ctx)) body.text("Use the CLI: typetorch pin", COLORS.dim);
			const abInPlace = ctx.serverType === "public" && isOwner && ctx.experiments && !ctx.signedOnly;
			if (ctx.serverType === "public" && isOwner && !ctx.experiments && !ctx.signedOnly && !switchKernel) {
				body.text("A/B needs kernel 0.2.3", COLORS.dim);
			}
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
					title += verifiedBadges(entry.verified);
					if (entry.running) {
						const how = status?.experiment !== undefined ? "RUNNING, A/B" : status?.pinned === true ? "RUNNING, PINNED" : "RUNNING";
						title += tag(how, COLORS.good);
					}
					if (entry.live) title += tag("LIVE", COLORS.info);
					if (entry.rollout !== undefined) title += tag(`${entry.rollout}%`, COLORS.info);
					if (entry.rollback) title += tag("ROLLBACK", COLORS.warn);
					const detail = escapeRich(`${entry.artifactId ?? `asset-${entry.assetId}`}  ${ago(entry.at)}`);
					const action = buildAction(ctx, entry);
					if (action === undefined) {
						expandable(body.row(title, detail), entry.assetId);
						return;
					}
					if (action === "here") {
						// Kernel 0.3.4: the owner loads it on THIS server (a pin; two taps; everyone stays).
						const row = body.row(title, detail, { label: buildLabel(action), color: COLORS.accent, onClick: () => {} });
						const button = row.FindFirstChildWhichIsA("TextButton");
						if (button) {
							armLock(
								button,
								armOf(`build:${entry.assetId}`),
								{ label: buildLabel(action), color: COLORS.accent },
								"Loading...",
								() => setResult(`Load ${buildName(entry)} on this server (${playersText})?`, COLORS.warn),
								(unlock) => ownerSwitch(`Loading ${short}`, { assetId: entry.assetId }, unlock),
							);
						}
						expandable(row, entry.assetId);
						return;
					}
					if (action === "join") {
						// Moves only you to a reserved server pinned to this build.
						const moveRow = body.row(title, detail, {
							label: buildLabel(action),
							color: COLORS.accent,
							onClick: () =>
								act(`Moving you to a server on ${short}`, "newServer", { branch: entry.branch, assetId: entry.assetId }),
						});
						expandable(moveRow, entry.assetId);
						return;
					}
					// "pin": private/reserved/Studio servers, or an A/B experiment on a public server before kernel 0.3.4.
					// A dev-channel build on a prod-channel server: a dark "Dev channel" button, so it isn't loaded by mistake.
					const crossChannel = status?.channel === "prod" && entry.channel === "dev";
					let armed = !isPublic && !crossChannel; // public server or cross-channel: tap twice
					const loadRow = body.row(title, detail, {
						label: crossChannel ? "Dev channel" : buildLabel(action),
						color: crossChannel ? undefined : COLORS.accent,
						onClick: (button) => {
							if (!armed) {
								armed = true;
								button.Text = "Confirm";
								if (isPublic) setResult(`Everyone on this server runs ${short}`, COLORS.warn);
								return;
							}
							act(`Loading ${short}`, "pin", abInPlace ? { assetId: entry.assetId, experiment: true } : entry.assetId);
						},
					});
					expandable(loadRow, entry.assetId);
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
				if (statusOk && typeIs(statusReply, "table")) fresh.experiments = (statusReply as StatusReply).facts?.experiments === true;
				data = fresh;
				draw();
			});
		};
		load();
	};

	// Claude: a Claude Code style chat (devtools/claude-ui.ts); "Dex path" sends the explorer's selection.
	const renderClaude = (tab: TabContext) => renderClaudeChat(tab, { kernel, call, dexSelection: () => dexSelection, copyText, imageInbox });

	/** Keys: a tab name, or "Tab/Sub" for tabs with sub-tabs. */
	const RENDER: Record<string, (tab: TabContext) => void> = {
		Artifact: renderArtifact,
		"Modules/Overview": renderModulesOverview,
		"Modules/State": renderModulesState,
		"Modules/Assets": (tab) =>
			renderAssetsTab(tab, {
				call,
				realm: () => modulesRealm,
				setRealm: (realm) => {
					modulesRealm = realm;
				},
			}),
		"Server/Status": renderServer,
		"Server/Branch": renderBranch,
		...adminTabs({ kernel, call }),
		Logs: renderLogs,
		Dex: renderDex,
		"Network/Packets": (tab) => renderNetworkInspector(tab, { kernel, dispatcher, call }),
		"Network/Stats": renderNetwork,
		Claude: renderClaude,
	};

	// Window ----------------------------------------------------------------------------------------------------------

	let ui: Ui | undefined;
	let tabTrove: Trove | undefined;
	let isOpen = false;
	let dev = false;
	/** This player is an owner (framework 0.3.2: the Manage group shows only for owners). */
	let owner = false;

	/** Group headers' expand state and the active sub-tab (from state.tab and subs). */
	const paintGroups = () => {
		if (!ui) return;
		for (const [tab, group] of ui.groups) {
			const expanded = openGroups.has(tab);
			group.frame.Visible = expanded && (tab !== "Manage" || owner);
			group.collapsed.Visible = !expanded;
			group.expanded.Visible = expanded;
			for (const [child, button] of group.children) {
				const active = tab === state.tab && child === subs[tab];
				button.BackgroundTransparency = active ? 0 : 1;
				button.TextColor3 = active ? COLORS.dark : COLORS.dim;
				button.Font = active ? Enum.Font.BuilderSansBold : Enum.Font.BuilderSansMedium;
			}
		}
	};

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
		// Sidebar: plain tabs fill when selected; a group header only tints (its active child fills). Groups stay open
		// until their own header is clicked again (paintGroups).
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
		if (tabSubs) {
			openGroups.add(name);
			saveOpenGroups();
		}
		paintGroups();
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
			// The header toggles its group: opening shows its last sub-tab, closing never changes the page.
			button.Activated.Connect(() => {
				if (openGroups.has(name)) {
					openGroups.delete(name);
					saveOpenGroups();
					paintGroups();
				} else {
					selectTab(name, subs[name] ?? children[0]);
				}
			});
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
		const remembered = TABS.includes(state.tab as TabName) ? (state.tab as TabName) : "Artifact";
		selectTab(remembered === "Manage" && !owner ? "Artifact" : remembered);
	};

	const setDev = (value: boolean) => {
		if (value === dev) return;
		dev = value;
		if (dev) {
			if (!ui) ui = build();
			ui.toggle.Visible = true;
			paintBadges();
			// Reopen after a swap if the menu was open in the previous generation.
			if (state.open) open();
		} else if (ui) {
			const wasOpen = state.open;
			close();
			state.open = wasOpen;
			ui.toggle.Visible = false;
		}
	};

	/** Framework 0.3.2: the Manage group shows only for owners (the server re-checks every Manage op). */
	const paintOwner = () => {
		if (!ui) return;
		const button = ui.tabButtons.get("Manage");
		if (button) button.Visible = owner;
		paintGroups();
		if (!owner && isOpen && state.tab === "Manage") selectTab("Artifact");
	};

	const refreshDev = () => {
		const [ok, info] = pcall(() => kernel.devStatus());
		setDev(ok && typeIs(info, "table") && info.dev === true);
		const nowOwner = viewerIsOwner(kernel);
		if (nowOwner !== owner || (ui && ui.tabButtons.get("Manage")?.Visible !== owner)) {
			owner = nowOwner;
			paintOwner();
		}
	};

	paintBadges = () => {
		if (!ui) return;
		paintDot(ui.toggle, healthLevel, UDim2.fromOffset(-2, -2), new Vector2(0, 0));
		const serverTab = ui.tabButtons.get("Server");
		if (serverTab) paintDot(serverTab, healthLevel, new UDim2(1, -18, 0.5, 0), new Vector2(1, 0.5));
	};
	// The Status page refreshes health while it's open; otherwise poll slowly (status is an in-memory kernel read).
	every(trove, HEALTH_INTERVAL, () => {
		if (!dev || (isOpen && state.tab === "Server")) return;
		const [ok, reply] = call("status");
		if (ok && typeIs(reply, "table")) setHealth(checkHealth((reply as StatusReply).server, (reply as StatusReply).facts));
	});

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
