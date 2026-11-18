import { Players, ReplicatedStorage, RunService } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { generationScope } from "../typetorch";

/**
 * plans/36: the `replay` namespace. A game marks what the extended recording follows (no CollectionService tags, nothing
 * placed by hand: a virtual list in the framework):
 *
 *   replay.track(boss, "boss");                 // one model (or part); returns a cleanup
 *   replay.trackChildren(workspace.Mobs, "zombie"); // every Model with a Humanoid / Animator added under it
 *   replay.setAfk(player, true);                // server: the game's own AFK flag (extended streams pause until the next input)
 *   replay.active();                            // client: whether the extended streams record me now
 *
 * Client tracks are the client's own (client-drawn mobs). Server tracks reach every client through the framework's own
 * replicated list (a folder of ObjectValues in ReplicatedStorage, `TypeTorchReplay`: the instance ref and the kind; no
 * game remotes), so an instance that streams in later still arrives. The lists belong to this framework copy, i.e. to
 * one generation: a hot swap drops them with the generation and the game's new code registers again (as remoteDebug
 * declarations do). Cleanups are plain functions (trove-friendly) and safe to call twice.
 */

export interface ReplayApi {
	/** Follow `instance` (a Model or BasePart) as `kind` (1-32 of letters, digits, `_ - .`). Returns a cleanup. */
	track(instance: Instance, kind: string): () => void;
	/** Follow every Model with a Humanoid, Animator or AnimationController under `container`, until it leaves. */
	trackChildren(container: Instance, kind: string): () => void;
	/**
	 * Server (or the client for its own player): the game's AFK flag. Turning it on pauses the extended streams until the
	 * player's next input (a flag left on while they play doesn't stop the recording); turning it on again pauses again.
	 */
	setAfk(player: Player, afk: boolean): void;
	/** Client: the extended streams record this player now (dry runs included). The server: always false. */
	active(): boolean;
}

export interface ReplayEntry {
	instance: PVInstance;
	kind: string;
	/** Index in `trackedEntries` (swap-remove). */
	index: number;
}

export const REPLAY_MIRROR = "TypeTorchReplay";
export const REPLAY_AFK_ATTRIBUTE = "TTReplayAfk";
/** Tracked instances at most (more are refused with a warning). */
export const REPLAY_TRACKED_MAX = 2000;

// This framework copy belongs to one generation, so these are that generation's.
/** Client: what the extended recorder follows (its own tracks, the server's, and trackChildren's). Server: unused. */
export const trackedEntries = new Array<ReplayEntry>();
const byInstance = new Map<Instance, ReplayEntry>();
let localAfk = false;
let activeNow = false;
let mirror: Folder | undefined;
let warnedFull = false;

/** `^[%w_%-%.]+$`, 1-32 characters. */
export function validReplayKind(kind: unknown): kind is string {
	return typeIs(kind, "string") && kind.size() >= 1 && kind.size() <= 32 && kind.match("^[%w_%-%.]+$")[0] !== undefined;
}

function isServer(): boolean {
	const [ok, server] = pcall(() => RunService.IsServer());
	return ok && server === true;
}

/** The recorder's switch for `active()`. */
export function setReplayActive(active: boolean) {
	activeNow = active;
}

/** The game's AFK flag for the local player: replay.setAfk(LocalPlayer, ...) here, or the server's attribute. */
export function replayAfkFlag(): boolean {
	if (localAfk) return true;
	const player = Players.LocalPlayer;
	return player !== undefined && player.GetAttribute(REPLAY_AFK_ATTRIBUTE) === true;
}

/** Adds to the client's list (no checks); the cleanup removes it if it is still this entry. */
function addEntry(instance: PVInstance, kind: string): () => void {
	const existing = byInstance.get(instance);
	if (existing) {
		existing.kind = kind;
		return () => removeEntry(existing);
	}
	if (trackedEntries.size() >= REPLAY_TRACKED_MAX) {
		if (!warnedFull) {
			warnedFull = true;
			warn(`[replay] at most ${REPLAY_TRACKED_MAX} tracked instances: more are ignored`);
		}
		return () => {};
	}
	const entry: ReplayEntry = { instance, kind, index: trackedEntries.size() };
	trackedEntries.push(entry);
	byInstance.set(instance, entry);
	return () => removeEntry(entry);
}

function removeEntry(entry: ReplayEntry) {
	if (byInstance.get(entry.instance) !== entry) return;
	byInstance.delete(entry.instance);
	const last = trackedEntries[trackedEntries.size() - 1];
	trackedEntries[entry.index] = last;
	last.index = entry.index;
	trackedEntries.pop();
}

/** The server's mirror folder (created on first use, destroyed with the generation); undefined outside one. */
function mirrorFolder(): Folder | undefined {
	if (mirror && mirror.Parent === ReplicatedStorage) return mirror;
	const scope = generationScope();
	if (!scope) return undefined;
	const folder = new Instance("Folder");
	folder.Name = REPLAY_MIRROR;
	folder.Parent = ReplicatedStorage;
	mirror = folder;
	scope.trove.add(() => {
		if (mirror === folder) mirror = undefined;
		folder.Destroy();
	});
	return folder;
}

function mirrorValue(instance: Instance, kind: string, children: boolean): () => void {
	const folder = mirrorFolder();
	if (!folder) return () => {};
	const value = new Instance("ObjectValue");
	value.Name = kind;
	if (children) value.SetAttribute("children", true);
	value.Value = instance;
	value.Parent = folder;
	return () => value.Destroy();
}

/** Has a Humanoid, Animator or AnimationController somewhere inside. */
function animated(model: Instance): boolean {
	return (
		model.FindFirstChildWhichIsA("Humanoid", true) !== undefined ||
		model.FindFirstChildWhichIsA("AnimationController", true) !== undefined ||
		model.FindFirstChildWhichIsA("Animator", true) !== undefined
	);
}

/** Client: tracks every animated Model under `container` (now and as they come) until the cleanup. */
function trackChildrenHere(container: Instance, kind: string): () => void {
	const cleanups = new Map<Instance, () => void>();
	const waiting = new Map<Instance, RBXScriptConnection>();
	const add = (child: Instance) => {
		if (!child.IsA("Model") || cleanups.has(child) || waiting.has(child)) return;
		if (animated(child)) {
			cleanups.set(child, addEntry(child, kind));
			return;
		}
		// Rigs often get their Humanoid / AnimationController after the model is parented: wait for one.
		const connection = child.DescendantAdded.Connect((descendant) => {
			if (!descendant.IsA("Humanoid") && !descendant.IsA("AnimationController") && !descendant.IsA("Animator")) return;
			connection.Disconnect();
			waiting.delete(child);
			if (child.Parent === container) cleanups.set(child, addEntry(child, kind));
		});
		waiting.set(child, connection);
	};
	const remove = (child: Instance) => {
		waiting.get(child)?.Disconnect();
		waiting.delete(child);
		const cleanup = cleanups.get(child);
		if (cleanup) {
			cleanups.delete(child);
			cleanup();
		}
	};
	const added = container.ChildAdded.Connect(add);
	const removed = container.ChildRemoved.Connect(remove);
	for (const child of container.GetChildren()) add(child);
	let done = false;
	return () => {
		if (done) return;
		done = true;
		added.Disconnect();
		removed.Disconnect();
		for (const [, connection] of waiting) connection.Disconnect();
		waiting.clear();
		for (const [, cleanup] of cleanups) cleanup();
		cleanups.clear();
	};
}

/**
 * Client: follows the server's tracks (every `TypeTorchReplay` folder, so a swap's old and new folders both work) into
 * the list, until `trove` ends.
 */
export function watchServerTracks(trove: Trove) {
	const watchValue = (value: Instance, folderTrove: Trove) => {
		if (!value.IsA("ObjectValue")) return;
		const valueTrove = folderTrove.extend();
		let cleanup: (() => void) | undefined;
		const update = () => {
			cleanup?.();
			cleanup = undefined;
			const target = value.Value;
			if (!target || !validReplayKind(value.Name)) return;
			if (value.GetAttribute("children") === true) cleanup = trackChildrenHere(target, value.Name);
			else if (target.IsA("PVInstance")) cleanup = addEntry(target, value.Name);
		};
		valueTrove.add(() => {
			cleanup?.();
			cleanup = undefined;
		});
		// A ref to an instance not streamed in yet is nil until it arrives.
		valueTrove.connect(value.GetPropertyChangedSignal("Value"), update);
		valueTrove.connect(value.AncestryChanged, () => {
			if (!value.Parent) folderTrove.remove(valueTrove);
		});
		update();
	};
	const watchFolder = (folder: Instance) => {
		if (folder.Name !== REPLAY_MIRROR || !folder.IsA("Folder")) return;
		const folderTrove = trove.extend();
		folderTrove.connect(folder.ChildAdded, (child) => watchValue(child, folderTrove));
		folderTrove.connect(folder.AncestryChanged, () => {
			if (!folder.Parent) trove.remove(folderTrove);
		});
		for (const child of folder.GetChildren()) watchValue(child, folderTrove);
	};
	trove.connect(ReplicatedStorage.ChildAdded, watchFolder);
	for (const child of ReplicatedStorage.GetChildren()) watchFolder(child);
}

function checkKind(what: string, kind: unknown) {
	if (!validReplayKind(kind)) error(`${what}: kind must be 1-32 of letters, digits, _ - . (got ${tostring(kind)})`, 3);
}

export const replay: ReplayApi = {
	track(instance, kind) {
		const what = "replay.track";
		checkKind(what, kind);
		if (!typeIs(instance, "Instance") || !instance.IsA("PVInstance")) error(`${what}: pass a Model or a BasePart`, 2);
		if (isServer()) {
			const unmirror = mirrorValue(instance, kind, false);
			let done = false;
			const destroying = instance.Destroying.Connect(() => cleanup());
			const cleanup = () => {
				if (done) return;
				done = true;
				destroying.Disconnect();
				unmirror();
			};
			return cleanup;
		}
		const untrack = addEntry(instance, kind);
		const destroying = instance.Destroying.Connect(() => untrack());
		return () => {
			destroying.Disconnect();
			untrack();
		};
	},

	trackChildren(container, kind) {
		const what = "replay.trackChildren";
		checkKind(what, kind);
		if (!typeIs(container, "Instance")) error(`${what}: pass a container instance`, 2);
		// The server mirrors the container once; each client tracks its children (what it has streamed in).
		if (isServer()) return mirrorValue(container, kind, true);
		return trackChildrenHere(container, kind);
	},

	setAfk(player, afk) {
		if (!typeIs(player, "Instance") || !player.IsA("Player")) error("replay.setAfk: pass a Player", 2);
		if (isServer()) {
			player.SetAttribute(REPLAY_AFK_ATTRIBUTE, afk === true ? true : undefined);
			return;
		}
		if (player === Players.LocalPlayer) localAfk = afk === true;
	},

	active() {
		return activeNow;
	},
};
