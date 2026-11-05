import { Players } from "@rbxts/services";
import type { ArtifactEntry, BranchInfo, ClientKernel, DevInfo, KernelStatus, SwitchRequest } from "../kernel";
import { normalRole, rulesOf } from "../kernel";
import type { AdminPlayer, AdminPlayersReply, AdminServer, AdminServersReply } from "./admin-server";
import { errorText, succeeded, type PlayerFocus } from "./admin-ui";
import { requestSwitch, switchOffered, type PickerContext } from "./build-actions";
import { setClaudeDraft } from "./claude-ui";
import { CommandRegistry, type Command } from "./commands";
import type { PaneActions, SplitDir } from "./layout";
import { branchOffers, buildOffers, confirmText, devBranchOffer, playerActions, type ServerOffer } from "./palette-rules";
import type { PickItem, WindowManager } from "./panes";
import { COLORS, copyText } from "./widgets";

/**
 * The dev menu's commands for the command palette (devtools/palette.ts, devtools/commands.ts), registered by client.ts.
 * Groups, in listing order:
 * - Pages: open any page in the focused pane (Shift+Enter: in a split); singletons focus their pane (panes.ts).
 * - Panes: Split right / down, Open in new window, Close pane, Dock all windows (the window manager's own operations).
 * - Server: Switch to dev branch (the dev branch's Branch-tab offer, pinned), Reload, Rollback (the Branch tab's ops),
 *   New server (Manage > Servers, owners).
 * - Branches / Builds: one per Branch-tab row with a button, same rules and words (palette-rules.ts, build-actions.ts).
 * - Servers: Join a listed server (Manage > Servers' Join, owners).
 * - Players: find a player by name, display name or UserId; open them in Manage > Players, or its Kick / Ban cards;
 *   Player: Teleport to / Bring / Respawn (Manage > Players' menu, its permissions; owners).
 * - Copy: job id, artifact id, commit, branch, place version (the copy popup: Roblox has no clipboard API).
 * - Claude: "Ask Claude: <query>" puts the query in the Claude tab's draft.
 * Everything that swaps what runs on this server is two-step. The kernel and the server re-check every request.
 */

/** Seconds before the palette reads status, branches and builds again on open. */
const FACTS_TTL = 15;
/** Manage > Servers' list is cached 15 s by the server; read it no faster. */
const SERVERS_TTL = 20;

/** What the dynamic commands need from the server (op "status", "branches", "artifacts", owners: "admin.servers"). */
export interface PaletteFacts {
	status?: KernelStatus;
	you?: DevInfo;
	experiments: boolean;
	branches?: BranchInfo[];
	artifacts?: ArtifactEntry[];
	servers?: AdminServer[];
	/** Owners: Manage > Players' list (what each player allows). */
	players?: AdminPlayer[];
}

export interface PaletteContext {
	/** The viewer is an owner (cosmetic: the server re-checks Manage ops). */
	owner: boolean;
	/** What the focused pane allows; undefined while the menu is closed. */
	pane?: PaneActions & { windows: number };
	facts?: PaletteFacts;
}

export interface PaletteDeps {
	readonly kernel: ClientKernel;
	readonly call: (op: string, payload?: unknown) => [ok: boolean, result: unknown];
	readonly wm: () => WindowManager | undefined;
	/** The page picker's pages (owner-only pages only for owners). */
	readonly pages: () => PickItem[];
	readonly owner: () => boolean;
	readonly playerFocus: PlayerFocus;
	/** client.ts: the line after a swap op, and after a teleport op. */
	readonly swapText: (ok: boolean, reply: unknown) => [string, Color3];
	readonly serverText: (ok: boolean, reply: unknown) => [string, Color3];
	/** The palette's status line and redraw. */
	readonly report: (text: string, color: Color3) => void;
	readonly refresh: () => void;
}

export interface PaletteCommands {
	readonly registry: CommandRegistry<PaletteContext>;
	readonly context: () => PaletteContext;
	/** The palette opened: read the server facts again when they are old. */
	readonly load: () => void;
}

/** Extra search words per player action ("tp" finds Teleport to). */
const ACTION_WORDS = { tp: ["tp", "goto", "teleport"], bring: ["bring", "summon", "tp here"], respawn: ["respawn", "reset", "reload character"] };

function players(count: number): string {
	return `${count} player${count === 1 ? "" : "s"}`;
}

export function paletteCommands(deps: PaletteDeps): PaletteCommands {
	const { kernel, call } = deps;
	const registry = new CommandRegistry<PaletteContext>();
	let facts: PaletteFacts | undefined;
	let factsAt = -math.huge;
	let serversAt = -math.huge;
	let loading = false;
	/** One server action at a time (like the Branch tab). */
	let busy = false;

	const loadFacts = (force = false) => {
		if (loading || (!force && os.clock() - factsAt < FACTS_TTL)) return;
		loading = true;
		task.spawn(() => {
			const [statusOk, statusReply] = call("status");
			const [branchesOk, branchesReply] = call("branches");
			const [artifactsOk, artifactsReply] = call("artifacts");
			const fresh: PaletteFacts = { experiments: false, servers: facts?.servers, players: facts?.players };
			if (statusOk && typeIs(statusReply, "table")) {
				const reply = statusReply as { server?: KernelStatus; you?: DevInfo; facts?: { experiments?: boolean } };
				fresh.status = reply.server;
				fresh.you = reply.you;
				fresh.experiments = reply.facts?.experiments === true;
			}
			if (branchesOk && typeIs(branchesReply, "table")) fresh.branches = branchesReply as BranchInfo[];
			const artifacts = (typeIs(artifactsReply, "table") ? artifactsReply : {}) as { supported?: boolean; list?: ArtifactEntry[] };
			if (artifactsOk && artifacts.supported === true) fresh.artifacts = artifacts.list ?? [];
			if (deps.owner()) {
				const [playersOk, playersReply] = call("admin.players");
				if (playersOk && typeIs(playersReply, "table")) fresh.players = (playersReply as AdminPlayersReply).players;
			} else fresh.players = undefined;
			if (deps.owner() && os.clock() - serversAt >= SERVERS_TTL) {
				const [serversOk, serversReply] = call("admin.servers");
				if (serversOk && typeIs(serversReply, "table")) {
					fresh.servers = (serversReply as AdminServersReply).servers;
					serversAt = os.clock();
				}
			}
			facts = fresh;
			factsAt = os.clock();
			loading = false;
			deps.refresh();
		});
	};

	const context = (): PaletteContext => ({ owner: deps.owner(), pane: deps.wm()?.focusedActions(), facts });

	/** The Branch tab's rules context, from the last facts (undefined: status unknown, no branch or build commands). */
	const pickerOf = (ctx: PaletteContext): PickerContext | undefined => {
		const status = ctx.facts?.status;
		if (status === undefined) return undefined;
		const you = ctx.facts!.you;
		const [switchKernel] = switchOffered(kernel);
		return {
			serverType: status.serverType,
			signedOnly: status.signedOnly === true,
			isOwner: you?.dev === true && normalRole(you.role) === "owner",
			switchKernel,
			experiments: ctx.facts!.experiments,
		};
	};

	/** Runs one server op (one at a time) and reports its line; swaps re-read the facts. */
	const act = (label: string, op: string, payload: unknown, teleport: boolean) => {
		if (busy) return deps.report("Busy with the last action", COLORS.warn);
		busy = true;
		deps.report(`${label}...`, COLORS.dim);
		task.spawn(() => {
			const [ok, reply] = call(op, payload);
			busy = false;
			const [text, color] = teleport ? deps.serverText(ok, reply) : deps.swapText(ok, reply);
			deps.report(text, color);
			if (!teleport) loadFacts(true);
		});
	};
	/** Kernel 0.3.4: the owner switches this server or loads a build here from their own client. */
	const ownerSwitch = (label: string, request: SwitchRequest) => {
		if (busy) return deps.report("Busy with the last action", COLORS.warn);
		busy = true;
		deps.report(`${label}...`, COLORS.dim);
		task.spawn(() => {
			const reply = requestSwitch(kernel, request);
			busy = false;
			if (reply.ok) deps.report(reply.generation !== undefined ? `Running ${reply.generation}` : "Done", COLORS.good);
			else deps.report(`Failed: ${reply.error ?? "unknown error"}`, COLORS.bad);
			loadFacts(true);
		});
	};
	/** A Manage op on one player (Manage > Players' menu): its busy line, then its done line or the error. */
	const manage = (busyText: string, op: string, userId: number, doneText: string) => {
		if (busy) return deps.report("Busy with the last action", COLORS.warn);
		busy = true;
		deps.report(`${busyText}...`, COLORS.dim);
		task.spawn(() => {
			const [ok, reply] = call(op, { userId });
			busy = false;
			if (succeeded(ok, reply)) deps.report(doneText, COLORS.good);
			else deps.report(`Failed: ${errorText(reply)}`, COLORS.bad);
		});
	};
	const playersHere = (ctx: PaletteContext) => ctx.facts?.status?.players ?? Players.GetPlayers().size();
	const report = (problem: string | undefined) => {
		if (problem !== undefined) deps.report(problem, COLORS.warn);
	};

	// Pages ---------------------------------------------------------------------------------------------------------
	registry.addSource(() =>
		deps.pages().map(
			(item): Command<PaletteContext> => ({
				id: `page:${item.key}`,
				title: item.group !== undefined ? `${item.group}: ${item.title}` : item.title,
				group: "Pages",
				keywords: [item.key, item.group ?? "", "open", "tab"],
				run: (_, how) => {
					const wm = deps.wm();
					if (!wm) return;
					if (how.split) report(wm.splitFocused("row", item.key));
					else wm.open(item.key);
				},
			}),
		),
	);

	// Panes ---------------------------------------------------------------------------------------------------------
	type PaneFacts = PaneActions & { windows: number };
	const paneCommand = (
		id: string,
		title: string,
		keywords: string[],
		can: (pane: PaneFacts) => boolean,
		apply: (wm: WindowManager) => string | undefined,
	) =>
		registry.add({
			id,
			title,
			group: "Panes",
			keywords,
			when: (ctx) => ctx.pane !== undefined && can(ctx.pane),
			run: () => {
				const wm = deps.wm();
				if (wm) report(apply(wm));
			},
		});
	const split = (dir: SplitDir) => (wm: WindowManager) => wm.splitFocused(dir);
	paneCommand("pane.splitRight", "Split right", ["pane", "side by side", "column"], (pane) => pane.right, split("row"));
	paneCommand("pane.splitDown", "Split down", ["pane", "stack", "row"], (pane) => pane.down, split("column"));
	paneCommand("pane.popOut", "Open pane in new window", ["pop out", "float", "detach"], (pane) => pane.window, (wm) => wm.popOutFocused());
	paneCommand("pane.close", "Close pane", ["remove"], (pane) => pane.close, (wm) => wm.closeFocused());
	paneCommand("pane.dockAll", "Dock all windows", ["windows", "attach", "merge"], (pane) => pane.windows > 0, (wm) => wm.dockAll());

	// Server: Switch to dev branch, the Branch tab's Reload and Rollback, Manage > Servers' New server -------------
	registry.addSource((ctx) => {
		const [, dev] = devShortcut(ctx);
		if (dev === undefined) return [];
		const command = offerCommand(dev, "Server", false);
		command.keywords = [...(command.keywords ?? []), "dev", "branch", "switch"];
		return [command];
	});
	registry.add({
		id: "server.reload",
		title: "Reload this server",
		group: "Server",
		keywords: ["branch", "head", "latest", "swap", "hot"],
		keepOpen: true,
		confirm: (ctx) => `Reload this server (${players(playersHere(ctx))}) to its branch head?`,
		run: () => act("Reloading", "reload", undefined, false),
	});
	registry.add({
		id: "server.rollback",
		title: "Roll back this server",
		group: "Server",
		keywords: ["rollback", "previous", "undo", "swap"],
		keepOpen: true,
		confirm: (ctx) => `Roll this server (${players(playersHere(ctx))}) back to the previous generation?`,
		run: () => act("Rolling back", "rollback", undefined, false),
	});
	registry.add({
		id: "server.new",
		title: "New server on this branch",
		group: "Server",
		hint: "moves only you",
		keywords: ["reserved", "teleport", "fresh", "join"],
		keepOpen: true,
		when: (ctx) => ctx.owner,
		run: () => act("Opening a server", "admin.newServer", undefined, true),
	});

	// Branches and builds: the Branch tab's rows with a button -----------------------------------------------------
	const offerCommand = (offer: ServerOffer, group: string, searchOnly: boolean): Command<PaletteContext> => ({
		id: offer.id,
		title: offer.title,
		group,
		hint: offer.kind === "joinBranch" || offer.kind === "joinBuild" ? "moves only you" : undefined,
		keywords: [offer.branch, offer.build?.artifactId ?? "", offer.build?.commit ?? "", offer.kind === "pin" || offer.kind === "loadHere" ? "load pin" : "switch"],
		searchOnly,
		keepOpen: true,
		confirm: offer.confirm ? (ctx) => confirmText(offer, playersHere(ctx)) : undefined,
		run: () => {
			const build = offer.build;
			if (offer.kind === "switch") ownerSwitch(`Switching to ${offer.branch}`, { branch: offer.branch });
			else if (offer.kind === "switchStored") act(`Switching to ${offer.branch}`, "switch", offer.branch, false);
			else if (offer.kind === "joinBranch") act(`Moving you to a ${offer.branch} server`, "newServer", offer.branch, true);
			else if (build === undefined) return;
			else if (offer.kind === "loadHere") ownerSwitch(`Loading ${offer.title}`, { assetId: build.assetId });
			else if (offer.kind === "pin") act(`Loading ${offer.title}`, "pin", offer.pin ?? build.assetId, false);
			else act(`Moving you to a server on ${offer.title}`, "newServer", { branch: build.branch, assetId: build.assetId }, true);
		},
	});
	const devShortcut = (ctx: PaletteContext): [ServerOffer[], ServerOffer | undefined] => {
		const picker = pickerOf(ctx);
		const branches = ctx.facts?.branches;
		if (picker === undefined || branches === undefined) return [[], undefined];
		const offers = branchOffers(picker, ctx.facts!.status?.branch, branches);
		return [offers, devBranchOffer(offers, branches)];
	};
	registry.addSource((ctx) => {
		const [offers, dev] = devShortcut(ctx);
		// The dev branch shows once, as the Server group's shortcut.
		return offers.filter((offer) => offer.branch !== dev?.branch).map((offer) => offerCommand(offer, "Branches", false));
	});
	registry.addSource((ctx) => {
		const picker = pickerOf(ctx);
		const artifacts = ctx.facts?.artifacts;
		if (picker === undefined || artifacts === undefined) return [];
		const prodRules = ctx.facts?.status !== undefined && rulesOf(ctx.facts.status) === "prod";
		return buildOffers(picker, artifacts, prodRules).map((offer) => offerCommand(offer, "Builds", true));
	});

	// Servers: Manage > Servers' Join (owners) -----------------------------------------------------------------------
	registry.addSource((ctx) => {
		if (!ctx.owner) return [];
		const list = new Array<Command<PaletteContext>>();
		for (const server of ctx.facts?.servers ?? []) {
			if (server.here || !server.joinable) continue;
			const short = server.jobId.sub(1, 8);
			list.push({
				id: `server.join:${server.jobId}`,
				title: `Join server ${short}`,
				group: "Servers",
				hint: `${server.branch ?? server.type}  ${server.players}/${server.maxPlayers}`,
				keywords: [server.jobId, server.branch ?? "", server.type, server.artifact ?? ""],
				searchOnly: true,
				keepOpen: true,
				run: () => act(`Joining ${short}`, "admin.join", { jobId: server.jobId }, true),
			});
		}
		return list;
	});

	// Players: Manage > Players (owners) -----------------------------------------------------------------------------
	registry.addSource((ctx) => {
		if (!ctx.owner) return [];
		const list = new Array<Command<PaletteContext>>();
		const show = (userId: number, action?: "kick" | "ban") => {
			deps.playerFocus.request(userId, action);
			deps.wm()?.open("Manage/Players");
		};
		for (const player of Players.GetPlayers()) {
			const userId = player.UserId;
			const name = `${player.DisplayName} (@${player.Name})`;
			const keywords = [player.Name, player.DisplayName, tostring(userId)];
			list.push({ id: `player.open:${userId}`, title: name, group: "Players", hint: tostring(userId), keywords, searchOnly: true, run: () => show(userId) });
			if (player === Players.LocalPlayer) continue;
			list.push({ id: `player.kick:${userId}`, title: `Kick ${name}`, group: "Players", keywords, searchOnly: true, run: () => show(userId, "kick") });
			list.push({ id: `player.ban:${userId}`, title: `Ban ${name}`, group: "Players", keywords, searchOnly: true, run: () => show(userId, "ban") });
		}
		// Teleport to / Bring / Respawn: Manage > Players' permissions, for players still here.
		for (const data of ctx.facts?.players ?? []) {
			const player = Players.GetPlayerByUserId(data.userId);
			if (player === undefined) continue;
			const keywords = [player.Name, player.DisplayName, tostring(data.userId), "player"];
			const you = player === Players.LocalPlayer;
			for (const action of playerActions(data.can, player.DisplayName, you)) {
				list.push({
					id: `player.${action.key}:${data.userId}`,
					title: action.title,
					group: "Players",
					keywords: [...keywords, ...ACTION_WORDS[action.key]],
					// Respawn me lists on an empty query; the others need a name.
					searchOnly: !you,
					keepOpen: true,
					run: () => manage(action.busy, action.op, data.userId, action.done),
				});
			}
		}
		return list;
	});

	// Copy: the copy popup (a selected read-only TextBox) ------------------------------------------------------------
	const copyCommand = (id: string, title: string, keywords: string[], value: () => string | undefined) =>
		registry.add({
			id,
			title,
			group: "Copy",
			keywords: ["copy", ...keywords],
			when: () => {
				const text = value();
				return text !== undefined && text !== "";
			},
			run: () => {
				const text = value();
				if (text !== undefined) copyText(text);
			},
		});
	copyCommand("copy.jobId", "Copy job id", ["server", "jobid"], () => (game.JobId !== "" ? game.JobId : undefined));
	copyCommand("copy.artifact", "Copy artifact id", ["build"], () => kernel.artifact.id);
	copyCommand("copy.commit", "Copy commit", ["sha", "hash"], () => kernel.artifact.commitHash ?? kernel.artifact.commit);
	copyCommand("copy.branch", "Copy branch", [], () => facts?.status?.branch ?? kernel.branch ?? kernel.artifact.branch);
	copyCommand("copy.placeVersion", "Copy place version", ["place"], () => tostring(game.PlaceVersion));

	// Claude ----------------------------------------------------------------------------------------------------------
	registry.addSource((_, query) => {
		const text = (query.match("^%s*(.-)%s*$")[0] as string | undefined) ?? "";
		if (text === "") return [];
		return [
			{
				id: "claude.ask",
				title: `Ask Claude: ${text}`,
				group: "Claude",
				fallback: true,
				run: () => {
					setClaudeDraft(kernel, text);
					deps.wm()?.open("Claude");
				},
			},
		];
	});

	return { registry, context, load: () => loadFacts(false) };
}
