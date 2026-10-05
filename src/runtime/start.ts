import { Players, RunService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $print, $warn } from "rbxts-transform-debug";
import { bindHotAssets } from "../assets/hot-asset";
import { syncHotAssets } from "../assets/sync";
import { startDevtoolsClient } from "../devtools/client";
import { startDevtoolsServer } from "../devtools/server";
import type { ClientKernel, ServerKernel, SwapOutInfo } from "../kernel";
import type {
	BuildInfo,
	ModuleContext,
	OnInit,
	OnPhysics,
	OnPlayerAdded,
	OnRender,
	OnStart,
	OnStop,
	OnTick,
} from "../module";
import { ClientDispatcher, ServerDispatcher, setClientDispatcher, setServerDispatcher } from "../net/runtime";
import { observePlayers } from "../players";
import { Reflect } from "../reflection/reflect";
import { bindTypeTorch, startedTypeTorch, swapOutTypeTorch, TypeTorch, unbindTypeTorch } from "../typetorch";
import { persistKeys, RegisteredModule, registered, runningModules } from "./registry";

export interface StartOptions {
	/** Folders whose ModuleScripts are required (recursively) so their @Service / @Controller classes register. */
	modules: Instance[];
	/** The game's compiled-in build info (its generated build.ts). */
	build?: BuildInfo;
	/** Include the in-game dev menu (only devs ever see it). Default true. */
	devtools?: boolean;
}

function has(instance: object, method: string): boolean {
	return typeIs((instance as Record<string, unknown>)[method], "function");
}

function requireAll(folders: Instance[]) {
	for (const folder of folders) {
		if (folder.IsA("ModuleScript")) require(folder);
		for (const descendant of folder.GetDescendants()) {
			if (descendant.IsA("ModuleScript")) require(descendant);
		}
	}
}

function dependenciesOf(ctor: object): object[] {
	// Written by @typetorch/transformer on classes decorated with @Service / @Controller (constructor parameter ids).
	const ids = Reflect.getOwnMetadata<string[]>(ctor, "typetorch:parameters") ?? [];
	return ids.map((id) => {
		const dependency = Reflect.idToObj.get(id);
		assert(dependency, `${tostring(ctor)} needs ${id}, which is not a loaded @Service/@Controller`);
		return dependency;
	});
}

/** Dependencies first; ties broken by loadOrder, then name. A cycle is a startup error that names it. */
function order(modules: RegisteredModule[]): RegisteredModule[] {
	const byCtor = new Map<object, RegisteredModule>();
	for (const mod of modules) byCtor.set(mod.ctor, mod);
	const sorted = [...modules].sort((a, b) => {
		const orderA = a.config.loadOrder ?? 0;
		const orderB = b.config.loadOrder ?? 0;
		return orderA !== orderB ? orderA < orderB : tostring(a.ctor) < tostring(b.ctor);
	});
	const result = new Array<RegisteredModule>();
	const state = new Map<object, "visiting" | "done">();
	const visit = (mod: RegisteredModule, path: string[]) => {
		const current = state.get(mod.ctor);
		if (current === "done") return;
		if (current === "visiting") error(`dependency cycle: ${[...path, tostring(mod.ctor)].join(" -> ")}`);
		state.set(mod.ctor, "visiting");
		for (const dependency of dependenciesOf(mod.ctor)) {
			const dependencyModule = byCtor.get(dependency);
			assert(dependencyModule, `${tostring(mod.ctor)} needs ${tostring(dependency)}, which runs on the other realm`);
			visit(dependencyModule, [...path, tostring(mod.ctor)]);
		}
		state.set(mod.ctor, "done");
		result.push(mod);
	};
	for (const mod of sorted) visit(mod, []);
	return result;
}

/** The generation's stop function. The kernel (0.2.2+) passes what replaces it; older kernels pass nothing. */
export type StopGeneration = (info?: SwapOutInfo) => void;

function start(realm: "server" | "client", kernel: ServerKernel | ClientKernel, options: StartOptions): StopGeneration {
	const startedAt = os.clock();
	const root = new Trove();
	persistKeys.clear();
	// Before anything else, so module top-level code, devtools and modules can use TypeTorch.
	bindTypeTorch(realm, kernel, options.build ?? {}, root);
	bindHotAssets(root);
	const context: ModuleContext = {
		realm,
		artifact: kernel.artifact,
		branch: kernel.branch,
		channel: kernel.channel,
		generation: kernel.generation,
		build: options.build ?? {},
		kernel,
		persist<T extends object>(key: string, init: () => T): T {
			return TypeTorch.persist(key, init);
		},
	};

	let stopNetwork: () => void;
	/** Devtools client hook, run once every module has started (e.g. the reload sound). */
	let onStarted: (() => void) | undefined;
	if (realm === "server") {
		const serverKernel = kernel as ServerKernel;
		const dispatcher = new ServerDispatcher(serverKernel);
		setServerDispatcher(dispatcher);
		serverKernel.onMessage(dispatcher.dispatch);
		root.connect(Players.PlayerRemoving, (player) => dispatcher.forget(player));
		if (options.devtools !== false) startDevtoolsServer(serverKernel, dispatcher, root.extend());
		stopNetwork = () => setServerDispatcher(undefined);
	} else {
		const clientKernel = kernel as ClientKernel;
		const dispatcher = new ClientDispatcher(clientKernel);
		setClientDispatcher(dispatcher);
		clientKernel.onMessage(dispatcher.dispatch);
		if (options.devtools !== false) onStarted = startDevtoolsClient(clientKernel, dispatcher, root.extend()).started;
		stopNetwork = () => {
			dispatcher.stop();
			setClientDispatcher(undefined);
		};
	}

	// Hot assets (plans/13): the place matches this artifact's asset manifest before any module loads. Yields up to 8 s
	// when versions change, never throws; loads still running after that swap in later (hotAsset().changed).
	if (realm === "server") syncHotAssets(kernel as ServerKernel, root);

	requireAll(options.modules);
	const ordered = order(registered.filter((mod) => mod.realm === realm));
	const instances = new Map<object, object>();
	runningModules.clear();

	const stopModules = () => {
		for (let index = runningModules.size() - 1; index >= 0; index--) {
			const running = runningModules[index];
			if (has(running.instance, "onStop")) {
				const [ok, err] = pcall(() => (running.instance as OnStop).onStop());
				if (!ok) $warn(`${running.name}.onStop threw: ${err}`);
			}
			root.remove(running.trove);
		}
		runningModules.clear();
	};

	const [initialized, initError] = pcall(() => {
		for (const mod of ordered) {
			const dependencies = dependenciesOf(mod.ctor);
			const ctor = mod.ctor as new (...args: unknown[]) => object;
			const instance = new ctor(...dependencies.map((dependency) => instances.get(dependency)!));
			const trove = root.extend();
			(instance as { trove: Trove }).trove = trove;
			(instance as { ctx: ModuleContext }).ctx = context;
			instances.set(mod.ctor, instance);
			runningModules.push({
				name: tostring(mod.ctor),
				instance,
				trove,
				dependencies: dependencies.map((dependency) => tostring(dependency)),
				loadOrder: mod.config.loadOrder ?? 0,
			});
		}
		for (const running of runningModules) {
			if (!has(running.instance, "onInit")) continue;
			const initStarted = os.clock();
			(running.instance as OnInit).onInit();
			running.initSeconds = os.clock() - initStarted;
		}
	});
	if (!initialized) {
		stopModules();
		stopNetwork();
		unbindTypeTorch();
		root.destroy();
		error(`TypeTorch ${realm} failed to start: ${initError}`, 0);
	}

	for (const running of runningModules) {
		const instance = running.instance;
		if (has(instance, "onTick")) running.trove.connect(RunService.Heartbeat, (dt) => (instance as OnTick).onTick(dt));
		if (has(instance, "onPhysics")) running.trove.connect(RunService.PreSimulation, (dt) => (instance as OnPhysics).onPhysics(dt));
		if (realm === "client" && has(instance, "onRender")) {
			running.trove.connect(RunService.RenderStepped, (dt) => (instance as OnRender).onRender(dt));
		}
		if (has(instance, "onPlayerAdded")) {
			observePlayers(running.trove, (player, playerTrove) => (instance as OnPlayerAdded).onPlayerAdded(player, playerTrove));
		}
		// In the module trove, so a soft stop also ends an onStart that is still running (e.g. a loop).
		if (has(instance, "onStart")) running.trove.add(task.spawn(() => (instance as OnStart).onStart()));
	}

	onStarted?.();
	startedTypeTorch();

	$print(
		`TypeTorch ${realm} started ${runningModules.size()} modules in ${math.floor((os.clock() - startedAt) * 1000)} ms (artifact ${kernel.artifact.id}, generation ${kernel.generation})`,
	);

	return (info?: SwapOutInfo) => {
		// TypeTorch.onSwapOut first, while every module still runs (so they can save into persist).
		swapOutTypeTorch(info);
		stopModules();
		stopNetwork();
		unbindTypeTorch();
		root.destroy();
	};
}

/** Call from the game's `src/server/boot.ts`: `export function boot(kernel) { return startServer(kernel, {...}) }`. */
export function startServer(kernel: ServerKernel, options: StartOptions): StopGeneration {
	return start("server", kernel, options);
}

/** Call from the game's `src/client/boot.ts`. */
export function startClient(kernel: ClientKernel, options: StartOptions): StopGeneration {
	return start("client", kernel, options);
}
