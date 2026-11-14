import type { Trove } from "@rbxts/trove";
import type { DevExperiment, DevExperimentsReply } from "../analytics/dev-control";
import { addButton, COLORS, escapeRich, Page, paintSelected } from "./widgets";

/**
 * Dev menu Server > Experiments (analytics/dev-control.ts): the analytics experiments the game asked about for you,
 * the variant you're in and why (random, forced by the settings, or your own pick), a button per variant to pick it for
 * yourself, and Clear. Your pick is stored with your analytics record (it follows you to every server), stamped
 * `forced` (left out of the results), and the game sees it the next time it asks for your variant (usually your next
 * join). Devs where the dev-only tools are open to them, owners everywhere; the server re-checks every request.
 */

/** What the tab needs from client.ts's TabContext. */
export interface ExperimentsTab {
	readonly page: Page;
	readonly trove: Trove;
}

export interface ExperimentsTabOptions {
	/** Sends one dev op and yields for the reply. */
	call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
	/** A short text for an error code of the ops (access refusals, rate_limited), else undefined. */
	errorText: (code: string) => string | undefined;
}

/** Op "exp.list" / "exp.set" replies. */
export interface ExperimentsReply extends Partial<DevExperimentsReply> {
	supported?: boolean;
}

const HOW_TEXT: Record<NonNullable<DevExperiment["how"]>, string> = {
	dev: "your pick",
	settings: "forced by the settings",
	random: "random",
};

/** The line under an experiment's name: "you: long (your pick)", "stopped: everyone gets short", ... */
export function experimentLine(entry: DevExperiment): string {
	if (entry.variants === undefined) {
		return entry.override !== undefined ? `your pick: ${entry.override} (the game hasn't asked yet)` : "the game hasn't asked for your variant yet";
	}
	if (!entry.active && entry.how !== "dev") return `stopped: you get ${entry.variant ?? entry.variants[0]} (the control)`;
	const how = entry.how !== undefined ? HOW_TEXT[entry.how] : "random";
	const ignored = entry.override !== undefined && entry.override !== entry.variant ? `; your pick ${entry.override} isn't one of its variants` : "";
	return `you: ${entry.variant ?? "?"} (${how}${ignored})`;
}

export function renderExperimentsTab(tab: ExperimentsTab, options: ExperimentsTabOptions) {
	const { page, trove } = tab;
	page.text("Pick a variant for yourself. It follows you to every server, is marked forced (left out of the results), and the game sees it the next time it asks (usually your next join).", COLORS.dim);
	const status = page.text("", COLORS.dim);
	const body = page.group();
	let alive = true;
	let busy = false;
	trove.add(() => {
		alive = false;
	});
	const say = (text: string, color: Color3) => {
		status.Text = text;
		status.TextColor3 = color;
	};
	const failure = (reply: unknown) => {
		const text = tostring(reply);
		return options.errorText(text) ?? text;
	};

	const draw = (list: DevExperiment[]) => {
		body.clear();
		if (list.size() === 0) {
			body.text("No experiments yet: none the game asked about for you, none in the settings.", COLORS.dim);
			return;
		}
		for (const entry of list) {
			body.row(escapeRich(entry.name), escapeRich(experimentLine(entry)));
			if (entry.variants === undefined && entry.override === undefined) continue;
			const buttons = body.buttons();
			for (const variant of entry.variants ?? []) {
				const button = addButton(buttons, variant, () => change(entry.name, variant));
				paintSelected(button, entry.override === variant);
			}
			if (entry.override !== undefined) addButton(buttons, "Clear", () => change(entry.name, undefined), COLORS.row);
		}
	};

	const load = () => {
		const [ok, reply] = options.call("exp.list");
		if (!alive) return;
		const answer = (typeIs(reply, "table") ? reply : {}) as ExperimentsReply;
		if (!ok) {
			body.clear();
			body.text(failure(reply), COLORS.bad);
		} else if (answer.supported !== true) {
			body.clear();
			body.text("Analytics isn't running on this server.", COLORS.dim);
		} else draw(answer.experiments ?? []);
	};

	const change = (name: string, variant: string | undefined) => {
		if (busy) return;
		busy = true;
		say(variant !== undefined ? `Picking ${variant}...` : "Clearing...", COLORS.dim);
		task.spawn(() => {
			const [ok, reply] = options.call("exp.set", variant !== undefined ? { name, variant } : { name });
			busy = false;
			if (!alive) return;
			const answer = (typeIs(reply, "table") ? reply : {}) as ExperimentsReply;
			if (!ok) return say(`Failed: ${failure(reply)}`, COLORS.bad);
			draw(answer.experiments ?? []);
			if (answer.saved === false) say("Set for this server only: it couldn't be saved (try again to keep it).", COLORS.warn);
			else say(variant !== undefined ? `You get ${variant} of ${name}. Rejoin to see it if the game asked already.` : `Cleared: ${name} picks for you again.`, COLORS.good);
		});
	};

	body.text("Loading...", COLORS.dim);
	trove.add(task.spawn(load));
}
