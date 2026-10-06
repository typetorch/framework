import { CollectionService } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { isLiveCopy, numberAttribute } from "../assets/dom";
import { ATTR_ID, ATTR_VERSION, keyOfTag } from "../assets/manifest";
import type { AssetSource, AssetStatus, AssetSyncReport } from "../assets/manifest";
import { addButton, COLORS, escapeRich, hex, Page, paintSelected, tag } from "./widgets";

/**
 * Dev menu Modules > Assets (plans/10, hot assets plans/13), with a Server | Client toolbar like Overview and State.
 * Server: the last AssetSync of this generation (op "assets"): manifest, sync time, and per key its source (kept,
 * baked, loaded, failed), version and last error. Client: the live copies this client sees (replicated keys only).
 */

const REFRESH = 2;
const MAX_ROWS = 200;

const SOURCE_COLORS: Record<AssetSource, Color3> = {
	kept: COLORS.text,
	baked: COLORS.info,
	loaded: COLORS.good,
	failed: COLORS.bad,
	loading: COLORS.warn,
};

/** What the tab needs from client.ts's TabContext. */
export interface AssetsTab {
	readonly page: Page;
	readonly trove: Trove;
	readonly toolbar: () => Frame;
}

export interface AssetsTabOptions {
	/** Sends one dev op and yields for the reply. */
	call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
	/** The Modules group's realm (shared with Overview and State). */
	realm: () => "server" | "client";
	setRealm: (realm: "server" | "client") => void;
	/**
	 * The "assets" op as a feed shared by every Assets pane (client.ts): one request per tick however many panes show
	 * the server realm. Without it, the tab polls on its own.
	 */
	feed?: {
		// A method, not a function property: roblox-ts calls a property with `.`, which hands PollFeed.watch the trove as
		// `self` ("attempt to index nil with nil" in feeds.ts).
		watch(trove: Trove, listener: (value: { ok: boolean; reply: unknown }) => void): void;
	};
}

function statusRow(target: Page, status: AssetStatus) {
	const title = `<b>${escapeRich(status.key)}</b>${tag(status.source.upper(), SOURCE_COLORS[status.source] ?? COLORS.text)}${
		status.late === true ? tag("LATE", COLORS.warn) : ""
	}`;
	const parts = [`id ${status.id}`, status.n !== undefined ? `v${status.n}` : `ver ${status.wanted}`];
	if (!status.live) parts.push("none live");
	else if (status.version !== status.wanted) parts.push(`live ver ${status.version ?? "-"}`);
	if (status.ms !== undefined) parts.push(`${status.ms} ms`);
	let detail = escapeRich(parts.join("  "));
	if (status.error !== undefined) detail += `\n<font color="${hex(COLORS.bad)}">${escapeRich(status.error)}</font>`;
	target.row(title, detail);
}

function drawServer(target: Page, report: AssetSyncReport) {
	if (report.manifest === "none" && report.errors.size() === 0) {
		target.text("No hot assets in this artifact", COLORS.dim);
	} else {
		const ok = report.manifest === "ok";
		target.field("Manifest", ok ? `${report.entries.size()} keys${report.from !== undefined ? `  (${report.from})` : ""}` : report.manifest, ok ? COLORS.text : COLORS.warn);
		const sync = report.running ? "Running" : report.ms !== undefined ? `${report.ms} ms${report.timedOut === true ? "  timed out" : ""}` : "-";
		target.field("Sync", sync, report.timedOut === true ? COLORS.warn : COLORS.text);
		for (const why of report.errors) target.text(why, COLORS.warn);
		let shown = 0;
		for (const status of report.entries) {
			shown += 1;
			if (shown > MAX_ROWS) break;
			statusRow(target, status);
		}
	}
	if (report.unmanaged.size() > 0) {
		target.section("Not in manifest");
		target.text(report.unmanaged.join(", "), COLORS.dim);
	}
}

function drawClient(target: Page) {
	const rows = new Array<{ key: string; copies: Instance[] }>();
	for (const name of CollectionService.GetAllTags()) {
		const key = keyOfTag(name);
		if (key === undefined) continue;
		const copies = CollectionService.GetTagged(name).filter(isLiveCopy);
		if (copies.size() > 0) rows.push({ key, copies });
		if (rows.size() >= MAX_ROWS) break;
	}
	rows.sort((a, b) => a.key < b.key);
	if (rows.size() === 0) target.text("No hot assets here", COLORS.dim);
	for (const { key, copies } of rows) {
		const live = copies[copies.size() - 1];
		const title = `<b>${escapeRich(key)}</b>${copies.size() > 1 ? tag(`${copies.size()} COPIES`, COLORS.warn) : ""}`;
		const id = numberAttribute(live, ATTR_ID);
		const version = numberAttribute(live, ATTR_VERSION);
		target.row(title, escapeRich(`id ${id ?? "-"}  ver ${version ?? "-"}  ${live.GetFullName()}`));
	}
}

export function renderAssetsTab(tab: AssetsTab, options: AssetsTabOptions) {
	const bar = tab.toolbar();
	const buttons = new Map<string, TextButton>();
	const body = tab.page.group();
	const drawReply = (ok: boolean, reply: unknown) => {
		body.clear();
		if (ok && typeIs(reply, "table")) drawServer(body, reply as AssetSyncReport);
		else body.text(`Failed: ${tostring(reply)}`, COLORS.bad);
	};
	let realmTrove: Trove | undefined;
	/** (Re)starts the source for the pane's realm: the client's own copies, or the server's report (shared feed). */
	const start = () => {
		if (realmTrove) tab.trove.remove(realmTrove);
		const mine = tab.trove.extend();
		realmTrove = mine;
		for (const [realm, button] of buttons) paintSelected(button, realm === options.realm());
		const feed = options.feed;
		if (options.realm() === "server" && feed) {
			feed.watch(mine, ({ ok, reply }) => drawReply(ok, reply));
			return;
		}
		mine.add(
			task.spawn(() => {
				while (true) {
					const [ok, err] = pcall(() => {
						if (options.realm() === "client") {
							body.clear();
							drawClient(body);
							return;
						}
						const [fine, reply] = options.call("assets");
						if (options.realm() === "server") drawReply(fine, reply);
					});
					if (!ok) $warn(`[devtools] assets refresh failed: ${err}`);
					task.wait(REFRESH);
				}
			}),
		);
	};
	const pick = (realm: "server" | "client") => {
		options.setRealm(realm);
		start();
	};
	buttons.set("server", addButton(bar, "Server", () => pick("server")));
	buttons.set("client", addButton(bar, "Client", () => pick("client")));
	start();
}
