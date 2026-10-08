import type { Trove } from "@rbxts/trove";
import type { BudgetRow, BudgetSnapshot } from "../kernel";
import { COLORS, corner, make, Page, style } from "./widgets";

/**
 * Dev menu Server > Budget (kernel 0.4.0, problem 25): what TypeTorch spends of this server's DataStore, MemoryStore,
 * HTTP and MessagingService limits in the last minute (bars against Roblox's limits for the player count), who spends
 * it (kernel, devtools, analytics, game), the DataStore budget left (shared with the game's own requests), and memory.
 * Minimal text: bars and numbers. Older kernels: one line.
 */

const REFRESH = 3;
const KINDS: ReadonlyArray<[kind: keyof BudgetSnapshot["kinds"], title: string]> = [
	["datastore", "DataStore"],
	["memorystore", "MemoryStore"],
	["http", "HTTP"],
	["messaging", "Messaging"],
];
const CALLER_SHORT: Record<string, string> = { kernel: "kernel", devtools: "devtools", analytics: "analytics", game: "game", framework: "framework" };

/** What the tab needs from client.ts's TabContext. */
export interface BudgetTab {
	readonly page: Page;
	readonly trove: Trove;
}

export interface BudgetTabOptions {
	/** Sends one dev op and yields for the reply. */
	call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
}

function number(value: number): string {
	if (value >= 10000) return `${math.floor(value / 1000)}k`;
	if (value % 1 !== 0) return "%.1f".format(value);
	return tostring(value);
}

/** One bar: name, a fill of used / limit (green, amber past half, red past 80%), "used/limit". */
function bar(target: Page, name: string, used: number, limit: number, note?: string) {
	const row = target.place(make("Frame", { BackgroundTransparency: 1, Size: new UDim2(1, 0, 0, 24) }));
	const label = style(make("TextLabel", { BackgroundTransparency: 1 }, row), name, 14, COLORS.dim);
	label.Size = new UDim2(0.24, -6, 1, 0);
	label.TextWrapped = false;
	label.TextTruncate = Enum.TextTruncate.AtEnd;
	const track = make("Frame", { BackgroundColor3: COLORS.row, BorderSizePixel: 0, Position: UDim2.fromScale(0.24, 0.25), Size: UDim2.fromScale(0.44, 0.5) }, row);
	corner(track, 4);
	const fraction = limit > 0 ? math.clamp(used / limit, 0, 1) : 0;
	const color = fraction < 0.5 ? COLORS.good : fraction < 0.8 ? COLORS.warn : COLORS.bad;
	// A fill, not a tween: progress fills are the one place Size changes (game UI rules).
	const fill = make("Frame", { BackgroundColor3: color, BorderSizePixel: 0, Size: UDim2.fromScale(used > 0 ? math.max(fraction, 0.02) : 0, 1) }, track);
	corner(fill, 4);
	const value = style(make("TextLabel", { BackgroundTransparency: 1 }, row), `${number(used)}/${number(limit)}${note ?? ""}`, 13, COLORS.text, Enum.Font.Code);
	value.Position = UDim2.fromScale(0.7, 0);
	value.Size = UDim2.fromScale(0.3, 1);
	value.TextWrapped = false;
	value.TextTruncate = Enum.TextTruncate.AtEnd;
}

function callersLine(callers: Partial<Record<string, number>>): string | undefined {
	const parts = new Array<string>();
	for (const [caller, value] of pairs(callers)) {
		if (value !== undefined && value > 0) parts.push(`${CALLER_SHORT[caller] ?? caller} ${number(value)}`);
	}
	parts.sort();
	return parts.size() > 0 ? parts.join("  ") : undefined;
}

function draw(target: Page, snapshot: BudgetSnapshot) {
	target.text(`${snapshot.players} players, per minute`, COLORS.dim);
	for (const [kind, title] of KINDS) {
		const entry = snapshot.kinds[kind];
		if (entry === undefined) continue;
		target.section(title);
		for (const row of entry.rows as BudgetRow[]) {
			bar(target, row.name, row.used, row.limit, row.left !== undefined ? `  left ${number(math.floor(row.left))}` : undefined);
		}
		const who = callersLine(entry.callers as Partial<Record<string, number>>);
		if (who !== undefined) target.text(who, COLORS.dim, true);
	}
	target.section("Memory");
	const memory = snapshot.memory;
	if (memory.total !== undefined) target.field("Total", "%.0f MB".format(memory.total));
	if (memory.luaHeap !== undefined) target.field("LuaHeap", "%.1f MB".format(memory.luaHeap));
	target.field("Lua VM", "%.1f MB".format(memory.heapKb / 1024));
	for (const tag of memory.tags ?? []) {
		if (tag.name !== "LuaHeap" && tag.mb >= 1) target.field(tag.name, "%.0f MB".format(tag.mb), COLORS.dim);
	}
	if (snapshot.generations.size() > 0) {
		target.section("Generations");
		for (const generation of snapshot.generations) {
			target.field(generation.name, `${generation.modules} modules${generation.running ? "" : ", stopping"}`, generation.running ? COLORS.text : COLORS.dim);
		}
	}
	if (snapshot.detail.size() > 0) {
		target.section("Top");
		let shown = 0;
		for (const row of snapshot.detail) {
			if (shown >= 8 || row.perMinute <= 0) break;
			shown += 1;
			target.field(`${row.caller} ${row.op}`, `${number(row.perMinute)}/min  (${row.kind})`, COLORS.dim);
		}
	}
}

export function renderBudgetTab(tab: BudgetTab, options: BudgetTabOptions) {
	const { page, trove } = tab;
	const body = page.group();
	body.text("Loading...", COLORS.dim);
	let alive = true;
	trove.add(() => {
		alive = false;
	});
	trove.add(
		task.spawn(() => {
			while (alive) {
				const [ok, reply] = options.call("budget");
				if (!alive) break;
				body.clear();
				const answer = (typeIs(reply, "table") ? reply : {}) as { supported?: boolean; budget?: BudgetSnapshot };
				if (!ok) body.text(tostring(reply), COLORS.bad);
				else if (answer.supported !== true || answer.budget === undefined || answer.budget.missing === true) body.text("Needs kernel 0.4.0", COLORS.dim);
				else draw(body, answer.budget);
				task.wait(REFRESH);
			}
		}),
	);
}
