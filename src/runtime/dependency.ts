import type { Modding } from "../reflection/modding";
import { Reflect } from "../reflection/reflect";
import { registered } from "./registry";

/**
 * Module lookup outside constructor injection: `Dependency<T>()`, `TypeTorch.module<T>()` / `tryModule<T>()` and
 * `Lazy<T>` all resolve here, against the modules of the RUNNING generation.
 *
 * The framework ships inside every artifact, so each generation requires its own copy of this module: its phase and
 * instances belong to that generation only. An old generation's helper can never reach a new generation's module; after
 * its generation stopped, every lookup fails with a clear error.
 *
 * Lookups work once every module of the generation is constructed (from onInit on, and in onStart, onStop and later
 * code). Before that they fail even for a module that happens to be constructed already, so a build never depends on
 * the construction order.
 */

/** Where the running generation is: loading its ModuleScripts, constructing its modules, running, or stopped. */
export type ModulePhase = "idle" | "loading" | "constructing" | "ready" | "stopped";

let phase: ModulePhase = "idle";
let realm: "server" | "client" | undefined;
const instances = new Map<object, object>();

/** The prefix @typetorch/transformer (0.2.1+) writes for a constructor parameter typed `Lazy<T>`: `lazy:<id of T>`. */
export const LAZY_PARAMETER = "lazy:";

/** runtime/start.ts: this generation moves to `to`. "loading" starts a new run (and forgets any old instances). */
export function setModulePhase(to: ModulePhase, startRealm?: "server" | "client") {
	if (to === "loading") {
		instances.clear();
		realm = startRealm;
	}
	if (to === "stopped") instances.clear();
	phase = to;
}

/** runtime/start.ts: a module of this generation was constructed. */
export function addModuleInstance(ctor: object, instance: object) {
	instances.set(ctor, instance);
}

/** The class name in an id (`server/services/shop@ShopService` -> `ShopService`). */
export function nameOfId(id: string): string {
	const [name] = id.match("@([^@]+)$");
	return typeIs(name, "string") ? name : id;
}

/** Whether `id` is the id of this package's own `Lazy` (a `Lazy<T>` parameter compiled by a transformer that drops T). */
export function isLazyTypeId(id: string): boolean {
	return id.sub(1, 21) === "@typetorch/framework:" && nameOfId(id) === "Lazy";
}

/** Which realm a class runs on, from its registration or (not loaded here) the first folder of its id. */
function realmOf(id: string, ctor: object | undefined): "server" | "client" | undefined {
	if (ctor !== undefined) {
		for (const mod of registered) if (mod.ctor === ctor) return mod.realm;
	}
	const [first] = id.match("^([^/:@]+)/");
	return first === "server" || first === "client" ? first : undefined;
}

/**
 * The running instance of the module with this id, or the reason there is none. `call` is how the caller wrote it
 * (`Dependency<ShopService>()`), for the messages.
 */
function lookup(id: string | undefined, call: (name: string) => string): [instance: object] | [undefined, string] {
	if (!typeIs(id, "string")) {
		return [undefined, `${call("T")} got no type id: @typetorch/transformer must be in the tsconfig plugins (it fills it in)`];
	}
	const name = nameOfId(id);
	if (phase === "idle") {
		return [undefined, `${call(name)}: no TypeTorch generation is running here (edit mode, or before startServer/startClient)`];
	}
	if (phase === "loading") {
		return [
			undefined,
			`${name} isn't constructed yet: ${call(name)} ran while the modules were loading (module top-level code). Call it from onInit/onStart or later, not at the top level of a module, in a constructor or a field initializer`,
		];
	}
	if (phase === "constructing") {
		return [undefined, `${name} isn't constructed yet: call ${call(name)} from onInit/onStart or later, not from a constructor or field initializer`];
	}
	if (phase === "stopped") {
		return [
			undefined,
			`${call(name)}: the generation that ran ${name} has stopped (a swap replaced it). Code of an old generation must stop with it: keep it in a module trove`,
		];
	}
	const ctor = Reflect.idToObj.get(id);
	const instance = ctor !== undefined ? instances.get(ctor) : undefined;
	if (instance !== undefined) return [instance];
	const owner = realmOf(id, ctor);
	if (owner !== undefined && owner !== realm) {
		const kind = owner === "server" ? "a @Service: it runs on the server" : "a @Controller: it runs on the client";
		return [undefined, `${call(name)}: ${name} is ${kind}, not on the ${realm}`];
	}
	if (ctor !== undefined && registered.some((mod) => mod.ctor === ctor)) {
		return [
			undefined,
			`${call(name)}: ${name} wasn't constructed: it registered after this generation started (is its file under the folders passed to startServer/startClient?)`,
		];
	}
	return [
		undefined,
		`${call(name)}: ${name} (${id}) isn't a loaded @Service or @Controller (is its file under the folders passed to startServer/startClient?)`,
	];
}

/** The running module with this id; throws the reason otherwise. */
export function resolveModule(id: string | undefined, call: (name: string) => string): object {
	const [instance, reason] = lookup(id, call);
	if (instance === undefined) error(reason, 3);
	return instance;
}

/** The running module with this id, or undefined (a missing id is still an error: the build is wrong). */
export function tryResolveModule(id: string | undefined, call: (name: string) => string): object | undefined {
	const [instance, reason] = lookup(id, call);
	if (instance === undefined && !typeIs(id, "string")) error(reason, 3);
	return instance;
}

/**
 * The running module of type T, from anywhere: a method, a plain class a module built, a command handler. Flamework's
 * `Dependency<T>()`; `TypeTorch.module<T>()` is the same.
 *
 * ```ts
 * import type { CharacterController } from "../controllers/character.controller"; // `import type`: no require cycle
 * class SidebarHelper {
 * 	open() {
 * 		Dependency<CharacterController>().freeze();
 * 	}
 * }
 * ```
 *
 * - Works once every module is constructed: from onInit/onStart on. A call in a constructor, a field initializer or
 *   at the top level of a module throws `"ShopService isn't constructed yet: ..."`.
 * - Only this realm's modules (a @Service on the server, a @Controller on the client).
 * - Per generation: after a swap it returns the new generation's instance; the old generation's code gets an error.
 * - T is the class (an `import type` of it is enough). `@typetorch/transformer` fills in its id.
 *
 * @metadata macro
 */
export function Dependency<T>(id?: Modding.Generic<T, "id">): T {
	return resolveModule(id, (name) => `Dependency<${name}>()`) as T;
}

/**
 * A module resolved on first use instead of injected: what breaks a dependency cycle.
 *
 * - As a constructor parameter (`@typetorch/transformer` 0.2.1+): `constructor(private readonly team: Lazy<TeamService>)`.
 * - As a field (any transformer): `private readonly team = Lazy<TeamService>();`
 *
 * `this.team.get()` resolves from onInit/onStart on (in a constructor it throws), then keeps the instance. The start
 * order ignores lazy edges, so two modules may take each other lazily.
 */
export interface Lazy<T> {
	/** The module. From onInit/onStart on; throws before every module is constructed and after this generation stopped. */
	get(): T;
	/**
	 * Type-only marker read by @typetorch/transformer: a constructor parameter typed `Lazy<T>` records T's id. Never set
	 * at runtime.
	 *
	 * @hidden
	 */
	readonly _typetorch_lazy: T;
}

class LazyModule {
	private instance?: object;

	constructor(private readonly id: string | undefined) {}

	get(): object {
		const cached = this.instance;
		if (cached !== undefined && phase === "ready") return cached;
		const instance = resolveModule(this.id, (name) => `Lazy<${name}>.get()`);
		this.instance = instance;
		return instance;
	}
}

/** runtime/start.ts: the value of a `Lazy<T>` constructor parameter (`lazy:<id>` from the transformer). */
export function createLazy(id: string): Lazy<unknown> {
	return new LazyModule(id) as unknown as Lazy<unknown>;
}

/**
 * A `Lazy<T>` handle (see the interface): `private readonly team = Lazy<TeamService>()`. Nothing resolves until `get()`.
 *
 * @metadata macro
 */
export function Lazy<T>(id?: Modding.Generic<T, "id">): Lazy<T> {
	if (!typeIs(id, "string")) error(`Lazy<T>() got no type id: @typetorch/transformer must be in the tsconfig plugins (it fills it in)`, 2);
	return new LazyModule(id) as unknown as Lazy<T>;
}
