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
import { bindTypeTorch, closeTypeTorch, startedTypeTorch, swapOutTypeTorch, TypeTorch, unbindTypeTorch } from "../typetorch";
import { addModuleInstance, createLazy, isLazyTypeId, LAZY_PARAMETER, nameOfId, setModulePhase } from "./dependency";
import { bindPlayerStates, playerState as openPlayerState } from "./player-state";
import { persistKeys, RegisteredModule, registered, runningModules } from "./registry";
import { cleanTrove, stopStep } from "./safe-clean";

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

/** One constructor parameter: a module injected now, or a `Lazy<T>` resolved on first use (no start-order edge). */
type Parameter =
	| { readonly kind: "module"; readonly ctor: object }
	| { readonly kind: "lazy"; readonly ctor: object; readonly id: string };

function parametersOf(ctor: object): Parameter[] {
	// Written by @typetorch/transformer on classes decorated with @Service / @Controller (constructor parameter ids);
	// 0.2.1+ writes `lazy:<id>` for a parameter typed Lazy<T>.
	const ids = Reflect.getOwnMetadata<string[]>(ctor, "typetorch:parameters") ?? [];
	return ids.map((id, index): Parameter => {
		if (id.sub(1, LAZY_PARAMETER.size()) === LAZY_PARAMETER) {
			const target = id.sub(LAZY_PARAMETER.size() + 1);
			const dependency = Reflect.idToObj.get(target);
			assert(dependency, `${tostring(ctor)} takes Lazy<${nameOfId(target)}> (${target}), which is not a loaded @Service/@Controller`);
			return { kind: "lazy", ctor: dependency, id: target };
		}
		if (isLazyTypeId(id)) {
			error(
				`${tostring(ctor)}: constructor parameter ${index + 1} is a Lazy<T>, but this build's @typetorch/transformer doesn't record T (Lazy constructor parameters need 0.2.1 or later). Use a field instead: \`private readonly team = Lazy<TeamService>()\``,
				0,
			);
		}
		const dependency = Reflect.idToObj.get(id);
		assert(dependency, `${tostring(ctor)} needs ${id}, which is not a loaded @Service/@Controller`);
		return { kind: "module", ctor: dependency };
	});
}

/** "dependency cycle: A -> B -> A. Break it: ..." (only the cycle, not the path that led to it). */
function cycleError(path: string[], name: string): never {
	const from = path.indexOf(name);
	const cycle = path.filter((_, index) => index >= from);
	cycle.push(name);
	const closer = cycle[cycle.size() - 2];
	error(
		`dependency cycle: ${cycle.join(" -> ")}. Break it: ${closer} can take ${name} as Lazy<${name}> (a constructor parameter, or a field \`= Lazy<${name}>()\`; resolved on first use, so the start order ignores it), or call Dependency<${name}>() inside a method`,
		0,
	);
}

/**
 * Dependencies first; ties broken by loadOrder, then name. Lazy parameters add no edge. A cycle is a startup error that
 * names it and says how to break it.
 */
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
		if (current === "visiting") cycleError(path, tostring(mod.ctor));
		state.set(mod.ctor, "visiting");
		for (const parameter of parametersOf(mod.ctor)) {
			const dependencyModule = byCtor.get(parameter.ctor);
			const what = parameter.kind === "lazy" ? `Lazy<${tostring(parameter.ctor)}>` : tostring(parameter.ctor);
			assert(dependencyModule, `${tostring(mod.ctor)} needs ${what}, which runs on the other realm`);
			if (parameter.kind === "module") visit(dependencyModule, [...path, tostring(mod.ctor)]);
		}
		state.set(mod.ctor, "done");
		result.push(mod);
	};
	for (const mod of sorted) visit(mod, []);
	return result;
}

/** The generation's stop function. The kernel (0.2.2+) passes what replaces it; older kernels pass nothing. */
export type StopGeneration = (info?: SwapOutInfo) => void;

/**
 * Kernel 0.3.2+ (plans/12 P-F1): reports a failed lifecycle hook to the kernel. A failed onStart inside the health
 * window (30 s from ready) rolls the server back to its last known good artifact, and the kernel prints the error.
 * Returns false when the kernel can't take it (older kernels, clients), so the caller raises it as before.
 */
function reportToKernel(kernel: ServerKernel | ClientKernel, kind: string, module: string, message: string): boolean {
	if (!typeIs((kernel as unknown as Record<string, unknown>).reportError, "function")) return false;
	const [ok, taken] = pcall(() => (kernel as ServerKernel).reportError!({ kind, module, message }));
	return ok && taken === true;
}

function start(realm: "server" | "client", kernel: ServerKernel | ClientKernel, options: StartOptions): StopGeneration {
	const startedAt = os.clock();
	const root = new Trove();
	persistKeys.clear();
	// Dependency<T>() / Lazy<T> fail with "isn't constructed yet" until every module is constructed.
	setModulePhase("loading", realm);
	// Before anything else, so module top-level code, devtools and modules can use TypeTorch.
	bindTypeTorch(realm, kernel, options.build ?? {}, root);
	bindHotAssets(root);
	bindPlayerStates(root, <T extends object>(key: string, init: () => T) => TypeTorch.persist(key, init));
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
		playerState<T>(key: string, init: (player: Player) => T) {
			return openPlayerState(key, init);
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
		// Kernel 0.3.2: the server dropped a message of this generation: fail pending requests now (P-N1).
		if (typeIs((clientKernel as unknown as Record<string, unknown>).onResync, "function")) {
			clientKernel.onResync!(() => dispatcher.resync());
		}
		// The server queues what it sends this player until this (0.3.0).
		dispatcher.hello();
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
			// Object by object, each pcalled: a cleanup that throws (e.g. trove.remove inside a cleanup) can't skip the
			// rest of this module, the modules after it, or the rest of the stop.
			cleanTrove(running.trove, running.name);
			stopStep(`${running.name} trove`, () => root.remove(running.trove));
		}
		runningModules.clear();
		setModulePhase("stopped");
	};
	/** Every step runs even when an earlier one throws (each warns), so a bad cleanup can't keep a dead generation alive. */
	const stopGeneration = () => {
		stopStep("stopping modules", stopModules);
		stopStep("stopping the network", stopNetwork);
		stopStep("unbinding TypeTorch", unbindTypeTorch);
		cleanTrove(root, "TypeTorch generation");
		stopStep("destroying the generation trove", () => root.destroy());
	};

	setModulePhase("constructing");
	const [initialized, initError] = pcall(() => {
		for (const mod of ordered) {
			const parameters = parametersOf(mod.ctor);
			const ctor = mod.ctor as new (...args: unknown[]) => object;
			const instance = new ctor(
				...parameters.map((parameter) => (parameter.kind === "lazy" ? createLazy(parameter.id) : instances.get(parameter.ctor)!)),
			);
			const trove = root.extend();
			(instance as { trove: Trove }).trove = trove;
			(instance as { ctx: ModuleContext }).ctx = context;
			instances.set(mod.ctor, instance);
			addModuleInstance(mod.ctor, instance);
			runningModules.push({
				name: tostring(mod.ctor),
				instance,
				trove,
				dependencies: parameters.map((parameter) =>
					parameter.kind === "lazy" ? `${tostring(parameter.ctor)} (lazy)` : tostring(parameter.ctor),
				),
				loadOrder: mod.config.loadOrder ?? 0,
			});
		}
		// Every module exists: Dependency<T>(), TypeTorch.module<T>() and Lazy<T>.get() work from here (onInit on).
		setModulePhase("ready");
		for (const running of runningModules) {
			if (!has(running.instance, "onInit")) continue;
			const initStarted = os.clock();
			(running.instance as OnInit).onInit();
			running.initSeconds = os.clock() - initStarted;
		}
	});
	if (!initialized) {
		stopGeneration();
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
		// In the module trove, so a soft stop also ends an onStart that is still running (e.g. a loop). Kernel 0.3.2: a
		// throwing onStart is reported (the kernel rolls the server back inside the health window); older kernels and
		// clients get the error raised in its thread as before.
		if (has(instance, "onStart")) {
			const name = running.name;
			running.trove.add(
				task.spawn(() => {
					const [ok, trace] = xpcall(
						() => (instance as OnStart).onStart(),
						(err: unknown) => debug.traceback(tostring(err), 2),
					);
					if (ok) return;
					const text = tostring(trace);
					if (realm === "server" && reportToKernel(kernel, "onStart", name, text)) return;
					error(`${name}.onStart failed: ${text}`, 0);
				}),
			);
		}
	}

	// Kernel 0.3.2: a real shutdown runs every module's onStop too (reverse order; the kernel gives it up to 20 s),
	// then the built-ins' close hooks (the analytics engine's last flush). onSwapOut doesn't run: nothing replaces this
	// generation.
	if (realm === "server" && typeIs((kernel as unknown as Record<string, unknown>).onClose, "function")) {
		(kernel as ServerKernel).onClose!(() => {
			stopModules();
			closeTypeTorch();
		});
	}

	onStarted?.();
	startedTypeTorch();

	$print(
		`TypeTorch ${realm} started ${runningModules.size()} modules in ${math.floor((os.clock() - startedAt) * 1000)} ms (artifact ${kernel.artifact.id}, generation ${kernel.generation})`,
	);

	return (info?: SwapOutInfo) => {
		// TypeTorch.onSwapOut first, while every module still runs (so they can save into persist).
		stopStep("onSwapOut", () => swapOutTypeTorch(info));
		stopGeneration();
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
