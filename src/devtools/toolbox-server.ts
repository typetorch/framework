import { AssetService, CollectionService, HttpService, Workspace } from "@rbxts/services";
import { $print, $warn } from "rbxts-transform-debug";
import type { ClaudeRefusal } from "./claude-access";
import { resolveGamePath, toJson } from "./claude-tools";
import type { ClaudeToolboxApproval, ClaudeToolboxInsert, ClaudeToolboxOptions, ClaudeToolboxTile, ClaudeToolboxType } from "./protocol";
import { leftovers, sanitizeAsset, scanAsset, type AssetScan } from "./toolbox-sanitize";

// @rbxts/types declares the SecurityCapabilities type and its constructor interface, but not the global value.
declare const SecurityCapabilities: SecurityCapabilitiesConstructor;

/**
 * Creator Store inserts into the requesting dev's live server (plans/14 "toolbox_insert"), run by claude.ts for a
 * game-tool request of the dev machine. Server only.
 *
 *   1. only where the requesting dev may use Claude (claude-access.ts: dev rules, or an owner on a public server an
 *      owner switched to a dev branch); prod servers never get runtime third-party content from a chat;
 *   2. the prompt must be one this server forwarded with the "Toolbox" chip (ToolboxGate.isAllowed), and the asset id
 *      must be in a toolbox_results event this server relayed for the conversation (ToolboxGate.fromSearch);
 *   3. load into nothing: Models and MeshParts through AssetService:LoadAssetAsync (sandboxed, no capabilities; needs
 *      "Allow Loading Third Party Assets"), Decals as a Decal on a board, Audio as a stopped Sound;
 *   4. scan, then a per-insert approval card for the requesting dev (Insert / Deny, no "always"; 60 s → deny) with the
 *      dev machine's snapshot (name, creator, verified, votes) and this server's own scan (found, removes, warnings);
 *   5. sanitize (toolbox-sanitize.ts; strict unless the dev ticked "Keep scripts"), check nothing forbidden is left,
 *      anchor, place on the ground in front of the requester (or at a position, or under a Workspace path), then
 *      parent into Workspace.TypeTorchToolbox, tagged TypeTorchToolbox with TTAssetId / TTInsertId / TTInsertedBy.
 * Inserts live outside the generation mounts: they survive swaps until the server closes. Nothing is saved.
 */

export const TOOLBOX_FOLDER = "TypeTorchToolbox";
export const TOOLBOX_TAG = "TypeTorchToolbox";
export const THIRD_PARTY_HINT =
	'If "Allow Loading Third Party Assets" is off, the owner turns it on in Studio > File > Experience Settings > Security (it applies to every server of the experience, prod too).';

const LIMITS = {
	instances: 5000,
	triangles: 200_000,
	highPoly: 50_000,
	studs: 1024,
	loadSeconds: 20,
	keepList: 12,
	perPrompt: 3,
	prompts: 200,
	conversations: 50,
	idsPerConversation: 300,
	inserts: 50,
	coordinate: 100_000,
} as const;
const TYPES = new ReadonlySet<string>(["Model", "MeshPart", "Decal", "Audio"]);
/**
 * The capability set kept scripts run with ("Keep scripts", spike T4): no network, data stores, players or loading.
 * Built only when used (inside a pcall), so a missing enum item can't break loading this module.
 */
const keptCapabilities = () => [
	Enum.SecurityCapability.RunServerScript,
	Enum.SecurityCapability.Basic,
	Enum.SecurityCapability.Physics,
	Enum.SecurityCapability.Animation,
	Enum.SecurityCapability.Audio,
	Enum.SecurityCapability.CreateInstances,
];

/** What claude.ts posts back for a game tool. */
export type ToolboxAnswer = { ok: boolean; output?: string[]; error?: string; data?: string; ms?: number; denied?: boolean };

// The gate ------------------------------------------------------------------------------------------------------------

/** Kept in the kernel persist store (plain data), so it survives swaps. */
export interface ToolboxStore {
	/** Prompt ids this server forwarded with the Toolbox chip → unix time. */
	prompts: Map<string, number>;
	/** Conversation id (or prompt id) → asset ids from its relayed toolbox_results → unix time. */
	results: Map<string, Map<number, number>>;
	/** Inserts made here (for Remove and the inserted cards). */
	inserts: (ClaudeToolboxInsert & { user: number; promptId: string; at: number })[];
}

export function newToolboxStore(): ToolboxStore {
	return { prompts: new Map(), results: new Map(), inserts: [] };
}

function oldestKey<K>(map: Map<K, number>): K | undefined {
	let oldest: K | undefined;
	let at = math.huge;
	for (const [key, time] of map) {
		if (time < at) {
			at = time;
			oldest = key;
		}
	}
	return oldest;
}

/** Gate 2 (plans/14): prompts forwarded with the chip, and the ids their searches returned. */
export class ToolboxGate {
	constructor(private readonly store: ToolboxStore) {}

	/** claude.prompt forwarded this prompt with `toolbox: true`. */
	allowPrompt(promptId: string): void {
		this.store.prompts.set(promptId, os.time());
		while (this.store.prompts.size() > LIMITS.prompts) {
			const key = oldestKey(this.store.prompts);
			if (key === undefined) break;
			this.store.prompts.delete(key);
		}
	}

	isAllowed(promptId: unknown): boolean {
		return typeIs(promptId, "string") && this.store.prompts.has(promptId);
	}

	/** A toolbox_results event this server relayed for a prompt of `conversationId`. */
	rememberResults(conversationId: string, ids: number[]): void {
		const now = os.time();
		let known = this.store.results.get(conversationId);
		if (!known) {
			known = new Map();
			this.store.results.set(conversationId, known);
			while (this.store.results.size() > LIMITS.conversations) {
				let oldest: string | undefined;
				let at = math.huge;
				for (const [key, ids_] of this.store.results) {
					let newest = 0;
					for (const [, time] of ids_) newest = math.max(newest, time);
					if (newest < at && key !== conversationId) {
						at = newest;
						oldest = key;
					}
				}
				if (oldest === undefined) break;
				this.store.results.delete(oldest);
			}
		}
		for (const id of ids) known.set(id, now);
		while (known.size() > LIMITS.idsPerConversation) {
			const key = oldestKey(known);
			if (key === undefined) break;
			known.delete(key);
		}
	}

	fromSearch(conversationId: string, id: number): boolean {
		return this.store.results.get(conversationId)?.has(id) === true;
	}
}

// Wire data -----------------------------------------------------------------------------------------------------------

const clean = (value: unknown, max: number): string | undefined => {
	if (!typeIs(value, "string")) return undefined;
	const text = value.gsub("%c", " ")[0].gsub("%s+", " ")[0];
	return text.sub(1, max);
};
const count = (value: unknown): number | undefined => (typeIs(value, "number") && value === value && value >= 0 && value < 1e12 ? math.floor(value) : undefined);
const assetIdOf = (value: unknown): number | undefined =>
	typeIs(value, "number") && value === value && value >= 1 && value < 2 ** 53 && value === math.floor(value) ? value : undefined;

/** One result tile from the dev machine, field by field. */
export function cleanTile(raw: unknown): ClaudeToolboxTile | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const data = raw as Record<string, unknown>;
	const id = assetIdOf(data.id);
	const name = clean(data.name, 60);
	if (id === undefined || !typeIs(data.type, "string") || !TYPES.has(data.type) || name === undefined) return undefined;
	const creatorRaw = data.creator;
	const creator = typeIs(creatorRaw, "table") ? clean((creatorRaw as { name?: unknown }).name, 40) : clean(creatorRaw, 40);
	const verified = typeIs(creatorRaw, "table") ? (creatorRaw as { verified?: unknown }).verified === true : data.verified === true;
	const tile: ClaudeToolboxTile = { id, type: data.type as ClaudeToolboxType, name, creator: creator ?? "?", verified };
	const scripts = count(data.scripts);
	if (scripts !== undefined) tile.scripts = scripts;
	const upPercent = count(data.upPercent);
	if (upPercent !== undefined) tile.upPercent = math.min(100, upPercent);
	const voteCount = count(data.voteCount);
	if (voteCount !== undefined) tile.voteCount = voteCount;
	const triangles = count(data.triangles);
	if (triangles !== undefined) tile.triangles = triangles;
	const seconds = count(data.seconds);
	if (seconds !== undefined) tile.seconds = seconds;
	return tile;
}

/** The tiles of a toolbox_results event (at most 10). */
export function cleanTiles(raw: unknown): ClaudeToolboxTile[] | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const tiles = new Array<ClaudeToolboxTile>();
	for (const item of raw as unknown[]) {
		if (tiles.size() >= 10) break;
		const tile = cleanTile(item);
		if (tile) tiles.push(tile);
	}
	return tiles;
}

interface InsertArgs {
	id: number;
	type: ClaudeToolboxType;
	place: "front" | "position" | "parent";
	position?: Vector3;
	parent?: string;
	name?: string;
	anchor: boolean;
	reason?: string;
	/** The dev machine's snapshot (its own search data, never Claude's text). */
	asset: ClaudeToolboxTile;
	meshId?: number;
	textureId?: number;
}

/** toolbox_insert args from the dev machine; a string is the error. */
export function parseInsertArgs(raw: unknown): InsertArgs | string {
	if (!typeIs(raw, "table")) return "bad arguments";
	const args = raw as Record<string, unknown>;
	const id = assetIdOf(args.id);
	const snapshotRaw = args.asset;
	const asset = cleanTile(snapshotRaw);
	if (id === undefined || !asset || asset.id !== id) return "bad asset";
	if (args.type !== asset.type) return "bad asset type";
	const place = args.place === undefined ? "front" : args.place;
	if (place !== "front" && place !== "position" && place !== "parent") return "bad place";
	const parsed: InsertArgs = { id, type: asset.type, place, anchor: args.anchor !== false, asset };
	if (place === "position") {
		const p = args.position;
		if (!typeIs(p, "table")) return "bad position";
		const [x, y, z] = [(p as unknown[])[0], (p as unknown[])[1], (p as unknown[])[2]];
		if (!typeIs(x, "number") || !typeIs(y, "number") || !typeIs(z, "number")) return "bad position";
		parsed.position = new Vector3(
			math.clamp(x, -LIMITS.coordinate, LIMITS.coordinate),
			math.clamp(y, -LIMITS.coordinate, LIMITS.coordinate),
			math.clamp(z, -LIMITS.coordinate, LIMITS.coordinate),
		);
	}
	if (place === "parent") {
		const parent = clean(args.parent, 500);
		if (parent === undefined || parent === "") return "bad parent";
		parsed.parent = parent;
	}
	const name = clean(args.name, 60);
	if (name !== undefined && name !== "") parsed.name = name;
	const reason = clean(args.reason, 120);
	if (reason !== undefined && reason !== "") parsed.reason = reason;
	if (typeIs(snapshotRaw, "table")) {
		const snapshot = snapshotRaw as Record<string, unknown>;
		parsed.meshId = assetIdOf(snapshot.meshId);
		parsed.textureId = assetIdOf(snapshot.textureId);
	}
	return parsed;
}

// Loading --------------------------------------------------------------------------------------------------------------

/** A LoadAssetAsync error → a short code plus what to do. */
export function loadError(message: string): string {
	const text = message.lower();
	if (text.find("third", 1, true)[0] !== undefined || text.find("allowinsertfreeassets", 1, true)[0] !== undefined || text.find("free asset", 1, true)[0] !== undefined) {
		return `third_party_off: this server may not load other creators' assets. ${THIRD_PARTY_HINT}`;
	}
	if (text.find("moderat", 1, true)[0] !== undefined) return "moderated: Roblox moderated this asset; pick another one.";
	if (text.find("not found", 1, true)[0] !== undefined || text.find("does not exist", 1, true)[0] !== undefined || text.find("invalid", 1, true)[0] !== undefined) {
		return "not_found: Roblox could not find this asset.";
	}
	if (text.find("authoriz", 1, true)[0] !== undefined || text.find("permission", 1, true)[0] !== undefined || text.find("access", 1, true)[0] !== undefined) {
		return `not_authorized: Roblox refused to load this asset here (${message.sub(1, 120)}). ${THIRD_PARTY_HINT}`;
	}
	return `load_failed: ${message.sub(1, 160)}. ${THIRD_PARTY_HINT}`;
}

/** Runs a yielding load with a deadline; a late result is destroyed. */
function loadWithin(seconds: number, load: () => Instance | undefined): [ok: true, root: Instance] | [ok: false, error: string] {
	let done = false;
	let result: [boolean, unknown] | undefined;
	let gaveUp = false;
	task.spawn(() => {
		const [ok, value] = pcall(load);
		done = true;
		if (gaveUp) {
			if (ok && typeIs(value, "Instance")) value.Destroy();
			return;
		}
		result = [ok, value];
	});
	const deadline = os.clock() + seconds;
	while (!done && os.clock() < deadline) task.wait(0.05);
	if (!done || result === undefined) {
		gaveUp = true;
		return [false, `timeout: the load took over ${seconds} s.`];
	}
	const [ok, value] = result;
	if (!ok) return [false, loadError(tostring(value))];
	if (!typeIs(value, "Instance")) return [false, "not_found: the load returned nothing."];
	return [true, value];
}

/** The default loader: a Model holding the asset (sandboxed, no capabilities). */
function loadAsset(id: number): Instance | undefined {
	return AssetService.LoadAssetAsync(id);
}

/** MeshPart fallback when LoadAssetAsync refuses (spike T2: may work by id without the third-party setting). */
function meshPartById(meshId: number, textureId: number | undefined): Instance {
	const part = AssetService.CreateMeshPartAsync(Content.fromUri(`rbxassetid://${meshId}`));
	if (textureId !== undefined) part.TextureID = `rbxassetid://${textureId}`;
	const model = new Instance("Model");
	part.Parent = model;
	return model;
}

/** A Decal on a 4×4 board (or on `onto`). */
function decalBoard(name: string, textureId: number, onto?: BasePart): Instance {
	const decal = new Instance("Decal");
	decal.Name = name;
	decal.Texture = `rbxassetid://${textureId}`;
	decal.Face = Enum.NormalId.Front;
	if (onto) return decal;
	const board = new Instance("Part");
	board.Name = name;
	board.Size = new Vector3(4, 4, 0.2);
	board.Anchored = true;
	board.Material = Enum.Material.SmoothPlastic;
	board.Color = Color3.fromRGB(235, 235, 235);
	decal.Parent = board;
	return board;
}

// Placement ------------------------------------------------------------------------------------------------------------

function rootPartOf(player: Player): BasePart | undefined {
	const root = player.Character?.FindFirstChild("HumanoidRootPart");
	return root && root.IsA("BasePart") ? root : undefined;
}

/** The ground height under `point` (a ray down from 60 studs above), ignoring the requester and the asset. */
function groundBelow(point: Vector3, ignore: Instance[]): number | undefined {
	const params = new RaycastParams();
	params.FilterType = Enum.RaycastFilterType.Exclude;
	params.FilterDescendantsInstances = ignore;
	const hit = Workspace.Raycast(point.add(new Vector3(0, 60, 0)), new Vector3(0, -400, 0), params);
	return hit?.Position.Y;
}

/** Bounding box of a PVInstance (Model or BasePart). */
function boxOf(instance: PVInstance): [CFrame, Vector3] {
	if (instance.IsA("Model")) {
		const [cframe, size] = instance.GetBoundingBox();
		return [cframe, size];
	}
	if (instance.IsA("BasePart")) return [instance.CFrame, instance.Size];
	return [instance.GetPivot(), Vector3.zero];
}

/**
 * Moves `instance` so the bottom center of its box sits at `target` (y = the ground there, or target.Y), turned to face
 * `faceFrom` when given (boards face the requester).
 */
function placeAt(instance: PVInstance, target: Vector3, ignore: Instance[], useGround: boolean, faceFrom?: Vector3): void {
	if (faceFrom) {
		const flat = new Vector3(faceFrom.X, target.Y, faceFrom.Z);
		if (flat.sub(target).Magnitude > 0.1) instance.PivotTo(CFrame.lookAt(target, flat));
		else instance.PivotTo(new CFrame(target));
	}
	const [box, size] = boxOf(instance);
	const ground = useGround ? groundBelow(target, ignore) : undefined;
	const bottomY = ground ?? target.Y;
	const delta = new Vector3(target.X - box.Position.X, bottomY - (box.Position.Y - size.Y / 2), target.Z - box.Position.Z);
	instance.PivotTo(instance.GetPivot().add(delta));
}

function toolboxFolder(): Folder {
	const existing = Workspace.FindFirstChild(TOOLBOX_FOLDER);
	if (existing && existing.IsA("Folder")) return existing;
	const folder = new Instance("Folder");
	folder.Name = TOOLBOX_FOLDER;
	folder.Parent = Workspace;
	return folder;
}

// The insert -----------------------------------------------------------------------------------------------------------

export interface ToolboxAsk {
	id: string;
	description: string;
	conversationId?: string;
	toolbox: ClaudeToolboxApproval;
}

export interface ToolboxInsertDeps {
	gate: ToolboxGate;
	store: ToolboxStore;
	/** Why `player` may not use Claude here (claude-access.ts), or undefined. */
	refusal: (player: Player) => ClaudeRefusal | undefined;
	/** Shows the approval card to the requesting dev and yields: "insert" | "deny" | "timeout", with the card's options. */
	ask: (player: Player, card: ToolboxAsk) => LuaTuple<[decision: string, options: ClaudeToolboxOptions | undefined]>;
	/** The requester is still in this server, still a dev, and still allowed to use Claude here. */
	stillAllowed: (player: Player) => boolean;
	/** Tests and spikes: replaces AssetService:LoadAssetAsync. */
	load?: (id: number) => Instance | undefined;
}

const isServerId = (value: unknown): value is string => typeIs(value, "string") && value.size() === 22 && value.match("^[%w_%-]+$")[0] !== undefined;

function warningsFor(args: InsertArgs, scan: AssetScan | undefined): string[] {
	const warnings = new Array<string>();
	if (!args.asset.verified) warnings.push("Unverified creator");
	if (scan && args.asset.scripts !== undefined && args.asset.scripts !== scan.scripts) warnings.push(`Listing says ${args.asset.scripts} scripts, found ${scan.scripts}`);
	if ((args.asset.triangles ?? 0) > LIMITS.highPoly) warnings.push(`${math.floor((args.asset.triangles ?? 0) / 1000)}k triangles`);
	if (scan && scan.instances > 1000) warnings.push(`${scan.instances} instances`);
	if (scan && scan.tools > 0) warnings.push("Tools become plain models");
	return warnings;
}

/**
 * Runs one toolbox_insert game request for `player` (the requester; claude.ts already checked session, pairing and
 * dev access). Yields for the load and the approval.
 */
export function toolboxInsert(player: Player, request: Record<string, unknown>, deps: ToolboxInsertDeps): ToolboxAnswer {
	const started = os.clock();
	const refused = deps.refusal(player);
	if (refused !== undefined) {
		return { ok: false, error: `${refused}: inserts happen only where this developer may use Claude (dev rules, or an owner on a public server an owner switched to a dev branch).` };
	}
	const promptId = request.promptId;
	if (!isServerId(promptId) || !deps.gate.isAllowed(promptId)) {
		return { ok: false, error: "toolbox_not_selected: Toolbox is not selected for this message. Ask the developer to pick Toolbox in the + menu and send again." };
	}
	const args = parseInsertArgs(request.args);
	if (typeIs(args, "string")) return { ok: false, error: args };
	const conversationId = isServerId(request.conversationId) ? request.conversationId : promptId;
	if (!deps.gate.fromSearch(conversationId, args.id)) {
		return { ok: false, error: `not_from_search: ${args.id} isn't in this conversation's search results on this server; search again.` };
	}
	if ((args.asset.triangles ?? 0) > LIMITS.triangles) return { ok: false, error: "too_large: over 200k triangles." };
	let made = 0;
	for (const insert of deps.store.inserts) if (insert.promptId === promptId) made += 1;
	if (made >= LIMITS.perPrompt) return { ok: false, error: `too_many: at most ${LIMITS.perPrompt} inserts per message.` };

	// Where it goes.
	let target: Instance | undefined;
	if (args.place === "parent") {
		target = resolveGamePath(args.parent ?? "");
		if (!target || !(target === Workspace || target.IsDescendantOf(Workspace))) return { ok: false, error: "bad_parent: parent must be an instance under Workspace." };
	}
	const decalOnto = args.type === "Decal" && target && target.IsA("BasePart") ? target : undefined;
	const goesTo = args.place === "position" ? "at the given position" : args.place === "parent" ? `under ${target!.GetFullName().sub(1, 60)}` : "in front of you";
	const label = args.name ?? args.asset.name;

	// Load into nothing.
	let root: Instance;
	let note: string | undefined;
	if (args.type === "Model" || args.type === "MeshPart") {
		const load = deps.load ?? loadAsset;
		let [ok, value] = loadWithin(LIMITS.loadSeconds, () => load(args.id));
		if (!ok && args.type === "MeshPart" && args.meshId !== undefined) {
			// Spike T2: a mesh by id may work without the third-party setting.
			const meshId = args.meshId;
			const [meshOk, mesh] = loadWithin(LIMITS.loadSeconds, () => meshPartById(meshId, args.textureId));
			if (meshOk) {
				note = `loaded the mesh by id (${value as string})`.sub(1, 200);
				[ok, value] = [true, mesh];
			}
		}
		if (!ok) {
			$warn(`[claude] toolbox_insert ${args.id} for ${player.Name}: ${value as string}`);
			return { ok: false, error: value as string, ms: math.floor((os.clock() - started) * 1000) };
		}
		root = value as Instance;
	} else if (args.type === "Decal") {
		if (args.textureId === undefined) return { ok: false, error: "no_texture: the search result has no image id." };
		root = decalBoard(label, args.textureId, decalOnto);
	} else {
		const sound = new Instance("Sound");
		sound.Name = label;
		sound.SoundId = `rbxassetid://${args.id}`;
		sound.Volume = 0.5;
		root = sound;
	}

	// Look at what actually loaded (not what the listing claims).
	const isLoaded = args.type === "Model" || args.type === "MeshPart";
	const scan = isLoaded ? scanAsset(root, LIMITS.keepList) : undefined;
	if (scan && scan.instances > LIMITS.instances) {
		root.Destroy();
		return { ok: false, error: `too_large: ${scan.instances} instances (over ${LIMITS.instances}).` };
	}
	if (isLoaded && root.IsA("PVInstance")) {
		const [boxOk, measured] = pcall(() => boxOf(root)[1]);
		const size = boxOk ? measured : Vector3.zero;
		if (size.X > LIMITS.studs || size.Y > LIMITS.studs || size.Z > LIMITS.studs) {
			root.Destroy();
			return { ok: false, error: `too_large: ${math.floor(size.X)} x ${math.floor(size.Y)} x ${math.floor(size.Z)} studs (over ${LIMITS.studs}).` };
		}
	}
	const card: ClaudeToolboxApproval = { asset: args.asset, goesTo, warnings: warningsFor(args, scan) };
	if (scan) {
		card.found = { instances: scan.instances, parts: scan.parts, meshParts: scan.meshParts, scripts: scan.scripts };
		card.removes = { scripts: scan.scripts, remotes: scan.remotes + scan.bindables, other: scan.sideEffects + scan.interactions };
		if (scan.keepableCount > 0) card.keepable = scan.keepable;
	}
	if (args.reason !== undefined) card.reason = args.reason;
	if (note !== undefined) card.warnings.push("Mesh only (setting off?)");

	const approvalId = typeIs(request.id, "string") ? request.id : HttpService.GenerateGUID(false);
	const [decision, options] = deps.ask(player, { id: approvalId, description: `Insert ${args.type} ${args.id}`, conversationId: request.conversationId as string | undefined, toolbox: card });
	if (decision !== "insert") {
		root.Destroy();
		$print(`[claude] toolbox_insert ${args.id} for ${player.Name} ${decision === "timeout" ? "timed out" : "denied"}`);
		return { ok: false, denied: true, error: decision === "timeout" ? "no answer within 60 s" : "denied", output: [] };
	}
	if (!deps.stillAllowed(player) || deps.refusal(player) !== undefined) {
		root.Destroy();
		return { ok: false, error: "the developer may no longer use Claude in this server" };
	}
	const anchor = options ? options.anchor : args.anchor;
	const keepScripts = options?.keepScripts === true && scan !== undefined && scan.keepableCount > 0;

	// Sanitize, then check (strict: no script at all).
	const report = isLoaded ? sanitizeAsset(root, { keepScripts, anchor }) : undefined;
	if (isLoaded && leftovers(root, keepScripts) > 0) {
		root.Destroy();
		return { ok: false, error: "sanitize_failed: something forbidden was left after sanitizing; nothing was inserted." };
	}
	let capabilities: string | undefined;
	if (keepScripts && report && report.kept.scripts > 0) {
		// Sandboxed stays true; kept scripts get only the fixed safe set (spike T4 verifies what it blocks).
		const [ok, err] = pcall(() => {
			root.Sandboxed = true;
			root.Capabilities = new SecurityCapabilities(...keptCapabilities());
		});
		capabilities = ok ? "RunServerScript, Basic, Physics, Animation, Audio, CreateInstances" : `none (${tostring(err).sub(1, 80)}): kept scripts can't run`;
	}

	// Name, tag, place, parent.
	const insertId = HttpService.GenerateGUID(false).gsub("-", "")[0].lower().sub(1, 16);
	const shown = root;
	shown.Name = label;
	shown.SetAttribute("TTAssetId", args.id);
	shown.SetAttribute("TTInsertId", insertId);
	shown.SetAttribute("TTInsertedBy", player.UserId);
	CollectionService.AddTag(shown, TOOLBOX_TAG);
	const rootPart = rootPartOf(player);
	const character = player.Character;
	const ignore: Instance[] = [shown];
	if (character) ignore.push(character);
	const [placed, placeError] = pcall(() => {
		if (decalOnto || !shown.IsA("PVInstance")) return;
		if (args.place === "position" && args.position) {
			placeAt(shown, args.position, ignore, false);
		} else if (rootPart) {
			const [, size] = boxOf(shown);
			const look = new Vector3(rootPart.CFrame.LookVector.X, 0, rootPart.CFrame.LookVector.Z);
			const forward = look.Magnitude > 0.01 ? look.Unit : new Vector3(0, 0, -1);
			const front = rootPart.Position.add(forward.mul(math.max(size.X, size.Z) / 2 + 6));
			placeAt(shown, front, ignore, true, args.type === "Decal" ? rootPart.Position : undefined);
		}
	});
	if (!placed) $warn(`[claude] toolbox_insert ${args.id}: placement failed (${placeError}); left where it loaded`);
	shown.Parent = decalOnto ?? (args.place === "parent" && target ? target : toolboxFolder());
	const path = shown.GetFullName();
	deps.store.inserts.push({ insertId, assetId: args.id, name: label, path: path.sub(1, 200), user: player.UserId, promptId, at: os.time() });
	while (deps.store.inserts.size() > LIMITS.inserts) deps.store.inserts.shift();
	const ms = math.floor((os.clock() - started) * 1000);
	$print(`[claude] toolbox_insert ${args.id} for ${player.Name} -> ${path}${keepScripts ? " (scripts kept)" : ""}`);
	const reply: Record<string, unknown> = { ok: true, insertId, path, ms };
	if (scan && report) {
		reply.found = card.found;
		reply.removed = report.removed;
		if (keepScripts) reply.kept = { scripts: report.kept.scripts, capabilities };
		if (report.toolsConverted > 0) reply.toolsConverted = report.toolsConverted;
	}
	if (shown.IsA("PVInstance")) {
		const [boxOk, size] = pcall(() => boxOf(shown)[1]);
		if (boxOk) reply.size = [math.floor(size.X * 10) / 10, math.floor(size.Y * 10) / 10, math.floor(size.Z * 10) / 10];
	}
	if (note !== undefined) reply.note = note;
	return { ok: true, data: toJson(reply), ms };
}

/** The inserts this player made for a prompt that are still in the server (the inserted cards). */
export function insertsFor(store: ToolboxStore, userId: number, promptId: string): ClaudeToolboxInsert[] {
	const list = new Array<ClaudeToolboxInsert>();
	for (const insert of store.inserts) {
		if (insert.user !== userId || insert.promptId !== promptId || !findInsert(insert.insertId)) continue;
		list.push({ insertId: insert.insertId, assetId: insert.assetId, name: insert.name, path: insert.path });
	}
	return list;
}

function findInsert(insertId: string): Instance | undefined {
	for (const instance of CollectionService.GetTagged(TOOLBOX_TAG)) {
		if (instance.GetAttribute("TTInsertId") === insertId) return instance;
	}
	return undefined;
}

/** Op "claude.toolboxRemove": only the dev who inserted it, only where they may use Claude (`refusal` undefined). */
export function removeToolboxInsert(player: Player, insertId: unknown, store: ToolboxStore, refusal: ClaudeRefusal | undefined): { ok: boolean; error?: string } {
	if (refusal !== undefined) return { ok: false, error: refusal };
	if (!typeIs(insertId, "string") || insertId.size() > 32 || insertId.match("^%x+$")[0] === undefined) return { ok: false, error: "bad_request" };
	const record = store.inserts.find((insert) => insert.insertId === insertId);
	if (!record || record.user !== player.UserId) return { ok: false, error: "not_found" };
	const instance = findInsert(insertId);
	if (instance) instance.Destroy();
	$print(`[claude] toolbox insert ${insertId} (${record.assetId}) removed by ${player.Name}`);
	return { ok: true };
}
