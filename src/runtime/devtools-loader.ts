import { Players } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import type { ClientKernel, ServerKernel } from "../kernel";
import type { ClientDispatcher, ServerDispatcher } from "../net/runtime";
import { TypeTorch } from "../typetorch";
import { sweepStaleMenus } from "./dev-gui";

/**
 * Loads the devtools, and only for those who get them. Kernel 0.5.6+ leaves `devtools` off the shared client tree of a
 * framework that has devtools/on-demand.ts, and sets ON_DEMAND_ATTRIBUTE on the generation's trees. Then the server
 * clones the folder into each dev's PlayerGui (which replicates to its owner only), and that dev's client copies it
 * back to its place in its own tree, so the compiled relative imports and the module cache work as usual. On an older
 * kernel the attribute is missing and the folder is in the tree as before.
 *
 * The devtools are never imported statically outside this file's dynamic imports: TS.import waits on a missing child
 * forever. A failure here costs a dev the menu, with a warning, and never the generation.
 */
const ON_DEMAND_ATTRIBUTE = "DevtoolsOnDemand";
const COPY_NAME = "TypeTorchDevtools";
const COPY_GENERATION = "Generation";
const COPY_INSTANCES = "Instances";
/** Devtools modules only servers require: left out of a dev's copy. scripts/check-devtools-split.mjs checks the list. */
const SERVER_ONLY = ["access", "admin-server", "artifact-notes", "claude", "explorer-server", "network-server", "remote-debug", "server", "sha256", "toolbox-sanitize", "toolbox-server"];
/** Seconds a dev's client waits for its copy to finish replicating. */
const REPLICATION_TIMEOUT = 60;

const frameworkRoot = () => script.Parent!.Parent!;

/** This generation's tree: the same name on the server and the client (kernel: `<artifact>#<n>`). */
const generationTree = () => script.FindFirstAncestor("include")?.Parent;

function shareWithDevs(devtools: Instance, generation: string, trove: Trove) {
	const copies = new Map<Player, Instance>();
	const give = (player: Player) => {
		const [ok, problem] = pcall(() => {
			if (copies.has(player) || !TypeTorch.isDev(player)) return;
			const playerGui = player.WaitForChild("PlayerGui", 30);
			if (!playerGui) error("no PlayerGui after 30 s");
			if (copies.has(player) || player.Parent === undefined) return;
			const copy = devtools.Clone();
			for (const name of SERVER_ONLY) copy.FindFirstChild(name)?.Destroy();
			copy.Name = COPY_NAME;
			copy.SetAttribute(COPY_GENERATION, generation);
			copy.SetAttribute(COPY_INSTANCES, copy.GetDescendants().size());
			copies.set(player, copy);
			trove.add(copy);
			copy.Parent = playerGui;
		});
		if (!ok) warn(`[TypeTorch] no devtools for ${player.Name}: ${problem}`);
	};
	trove.connect(Players.PlayerAdded, (player) => give(player));
	trove.connect(Players.PlayerRemoving, (player) => copies.delete(player));
	trove.add(
		TypeTorch.onPlayerDevChanged((player, info) => {
			if (info.dev) {
				give(player);
				return;
			}
			const copy = copies.get(player);
			if (copy) {
				copies.delete(player);
				trove.remove(copy);
			}
		}),
	);
	for (const player of Players.GetPlayers()) trove.add(task.spawn(give, player));
}

export function loadDevtoolsServer(kernel: ServerKernel, dispatcher: ServerDispatcher, trove: Trove) {
	const [ok, problem] = pcall(() => {
		const { startDevtoolsServer } = import("../devtools/server").expect();
		startDevtoolsServer(kernel, dispatcher, trove.extend());
		const tree = generationTree();
		const devtools = frameworkRoot().FindFirstChild("devtools");
		if (tree?.GetAttribute(ON_DEMAND_ATTRIBUTE) === true && devtools) shareWithDevs(devtools, tree.Name, trove);
	});
	if (!ok) warn(`[TypeTorch] devtools failed to start, the game goes on without them: ${problem}`);
}

/** Starts the client's devtools now or when its copy arrives. Returns the "every module has started" hook. */
export function loadDevtoolsClient(kernel: ClientKernel, dispatcher: ClientDispatcher, trove: Trove): () => void {
	const playerGui = Players.LocalPlayer.FindFirstChildOfClass("PlayerGui");
	if (playerGui) sweepStaleMenus(playerGui, kernel.generation);

	let alive = true;
	trove.add(() => {
		alive = false;
	});
	let onStarted: (() => void) | undefined;
	let modulesStarted = false;
	const runStarted = () => {
		if (!onStarted || !modulesStarted) return;
		const [ok, problem] = pcall(onStarted);
		if (!ok) warn(`[TypeTorch] devtools: ${problem}`);
	};
	const begin = () => {
		const [ok, result] = pcall(() => {
			const { startDevtoolsClient } = import("../devtools/client").expect();
			return startDevtoolsClient(kernel, dispatcher, trove.extend());
		});
		if (!ok) {
			warn(`[TypeTorch] devtools failed to start, the game goes on without them: ${result}`);
			return;
		}
		onStarted = (result as { started: () => void }).started;
		runStarted();
	};

	const tree = generationTree();
	if (tree?.GetAttribute(ON_DEMAND_ATTRIBUTE) !== true || frameworkRoot().FindFirstChild("devtools")) {
		begin();
	} else {
		let taken = false;
		const take = (copy: Instance) => {
			if (taken || copy.Name !== COPY_NAME || copy.GetAttribute(COPY_GENERATION) !== tree.Name) return;
			taken = true;
			const expected = copy.GetAttribute(COPY_INSTANCES);
			const deadline = os.clock() + REPLICATION_TIMEOUT;
			while (alive && typeIs(expected, "number") && copy.GetDescendants().size() < expected) {
				if (os.clock() > deadline) {
					warn("[TypeTorch] the devtools copy didn't finish replicating: no dev menu until the next generation");
					return;
				}
				task.wait(0.1);
			}
			if (!alive) return;
			// A clone, so a retry of this generation on a fresh tree (kernel client) still finds the original.
			const [ok, problem] = pcall(() => {
				const placed = copy.Clone();
				placed.Name = "devtools";
				placed.Parent = frameworkRoot();
			});
			if (ok) begin();
			else warn(`[TypeTorch] devtools copy failed: ${problem}`);
		};
		trove.add(
			task.spawn(() => {
				const gui = Players.LocalPlayer.WaitForChild("PlayerGui");
				trove.connect(gui.ChildAdded, take);
				for (const child of gui.GetChildren()) take(child);
			}),
		);
	}

	return () => {
		modulesStarted = true;
		runStarted();
	};
}
