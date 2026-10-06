import { $warn } from "rbxts-transform-debug";
import { maybeClientDispatcher } from "../net/runtime";
import { generationScope } from "../typetorch";
import { ClientAnalytics } from "./client";
import type { AnalyticsOptions, AnalyticsProps, AnalyticsPurchase, AnalyticsStats } from "./schema";
import { ServerAnalytics } from "./server";

/**
 * TypeTorch analytics (plans/16): `new AnalyticsEngine(options?)` on the server and `new AnalyticsEngine()` on the
 * client. Nothing runs until one is created. Every engine created in a generation shares one core, which stops with
 * the generation; its unsent rows survive a hot swap in `persist`.
 *
 * The server sends rows to the sink in the settings (ConfigService key `TypeTorchAnalytics`, or `options.settings`).
 * The client sends everything through the server, never to the internet. See the README "Analytics" section and
 * src/analytics/SCHEMA.md.
 */

// The running generation's cores (each generation loads its own copy of this module).
let serverCore: ServerAnalytics | undefined;
let clientCore: ClientAnalytics | undefined;

function isPlayer(value: unknown): value is Player {
	return typeIs(value, "Instance") && value.IsA("Player");
}

/** Server-only calls made on the client: warned once each per generation; the server refuses these kinds from clients. */
const warnedServerOnly = new Set<string>();
function serverOnly(call: string) {
	if (warnedServerOnly.has(call)) return;
	warnedServerOnly.add(call);
	$warn(`[analytics] ${call}() is server-only (revenue and currency are server-authoritative): the client sends nothing`);
}

function currentServer(options: AnalyticsOptions): ServerAnalytics | undefined {
	if (serverCore) return serverCore;
	const scope = generationScope();
	if (!scope || !scope.server) return undefined;
	const trove = scope.trove.extend();
	const core = new ServerAnalytics(options, scope, trove);
	serverCore = core;
	trove.add(() => {
		if (serverCore === core) serverCore = undefined;
	});
	return core;
}

function currentClient(options: AnalyticsOptions): ClientAnalytics | undefined {
	if (clientCore) return clientCore;
	const scope = generationScope();
	const dispatcher = maybeClientDispatcher();
	if (!scope || !scope.client || !dispatcher) return undefined;
	const trove = scope.trove.extend();
	const core = new ClientAnalytics(options, dispatcher, trove);
	clientCore = core;
	trove.add(() => {
		if (clientCore === core) clientCore = undefined;
	});
	return core;
}

export class AnalyticsEngine {
	private readonly server?: ServerAnalytics;
	private readonly client?: ClientAnalytics;

	/**
	 * Starts the engine (or joins the one this generation already runs: the first engine's options win). Outside a
	 * running generation (edit mode, UI Labs stories) it does nothing and every call is a no-op.
	 */
	constructor(options: AnalyticsOptions = {}) {
		const scope = generationScope();
		if (!scope) return;
		if (scope.server) {
			const existing = serverCore !== undefined;
			this.server = currentServer(options);
			if (existing && options.settings !== undefined) $warn("[analytics] an engine already runs: its settings stay");
		} else {
			if (options.settings !== undefined) $warn("[analytics] settings are read on the server only; the client ignores them");
			this.client = currentClient(options);
		}
	}

	/** False when nothing is collected (edit mode, or the engine stopped with its generation). */
	isRunning(): boolean {
		return (this.server !== undefined && serverCore === this.server) || (this.client !== undefined && clientCore === this.client);
	}

	/** A custom event. Server: pass the player first (without one it is a server-only event). */
	track(name: string, props?: AnalyticsProps): void;
	track(player: Player, name: string, props?: AnalyticsProps): void;
	track(first: Player | string, second?: string | AnalyticsProps, third?: AnalyticsProps) {
		if (isPlayer(first)) {
			this.server?.track(first, "custom", second as string, third);
			this.client?.track("custom", second as string, third);
		} else {
			this.server?.track(undefined, "custom", first, second as AnalyticsProps | undefined);
			this.client?.track("custom", first, second as AnalyticsProps | undefined);
		}
	}

	/** A funnel step, e.g. `step("onboarding", 3, "opened_shop")`. Indexes start at 1 by convention. */
	step(funnel: string, index: number, name?: string): void;
	step(player: Player, funnel: string, index: number, name?: string): void;
	step(first: Player | string, second: string | number, third?: number | string, fourth?: string) {
		if (isPlayer(first)) {
			const props = { i: third as number, step: fourth };
			this.server?.track(first, "funnel", second as string, props);
			this.client?.track("funnel", second as string, props);
		} else {
			const props = { i: second as number, step: third as string | undefined };
			this.server?.track(undefined, "funnel", first, props);
			this.client?.track("funnel", first, props);
		}
	}

	/**
	 * A Robux purchase (log it once the receipt is granted). The event name is `kind` ("product" by default). Server
	 * only: revenue is server-authoritative, so on the client this warns once and sends nothing.
	 */
	purchase(purchase: AnalyticsPurchase): void;
	purchase(player: Player, purchase: AnalyticsPurchase): void;
	purchase(first: Player | AnalyticsPurchase, second?: AnalyticsPurchase) {
		if (this.client) {
			serverOnly("purchase");
			return;
		}
		const player = isPlayer(first) ? first : undefined;
		const info = (player ? second : first) as AnalyticsPurchase | undefined;
		if (!info || !typeIs(info.product, "number") || !typeIs(info.robux, "number")) {
			$warn("[analytics] purchase({ product, robux }) needs numbers");
			return;
		}
		const kind = typeIs(info.kind, "string") && info.kind !== "" ? info.kind : "product";
		const props = { product: info.product, robux: info.robux, where: info.where };
		this.server?.track(player, "purchase", kind, props);
	}

	/**
	 * Currency in (+) or out (-), e.g. `currency(player, "coins", 50, "round_reward")`. Server only: the economy is
	 * server-authoritative, so on the client this warns once and sends nothing.
	 */
	currency(name: string, delta: number, reason: string): void;
	currency(player: Player, name: string, delta: number, reason: string): void;
	currency(first: Player | string, second: string | number, third: number | string, fourth?: string) {
		if (this.client) {
			serverOnly("currency");
			return;
		}
		if (isPlayer(first)) {
			this.server?.track(first, "currency", second as string, { delta: third as number, reason: fourth });
		} else {
			this.server?.track(undefined, "currency", first, { delta: second as number, reason: third as string });
		}
	}

	/**
	 * What the player is doing ("round", "shopping"; undefined clears it): the `activity:` part of every later event's
	 * state. Server without a player: the default for every player without their own.
	 */
	state(activity: string | undefined): void;
	state(player: Player, activity: string | undefined): void;
	state(first: Player | string | undefined, second?: string) {
		if (isPlayer(first)) {
			this.server?.setActivity(first, second);
			this.client?.setActivity(second);
		} else {
			this.server?.setActivity(undefined, first);
			this.client?.setActivity(first);
		}
	}

	/**
	 * The screen the player sees, for UIs that aren't separate ScreenGuis (undefined clears it). Client: wins over the
	 * automatic screens. Server: needs the player.
	 */
	screen(name: string | undefined): void;
	screen(player: Player, name: string | undefined): void;
	screen(first: Player | string | undefined, second?: string) {
		if (isPlayer(first)) {
			const session = this.server?.sessionOf(first);
			if (session) this.server!.setScreen(session, second ?? "", "server");
			this.client?.setScreen(second);
		} else {
			this.client?.setScreen(first);
		}
	}

	/**
	 * The player's variant of experiment `name` (the first variant is the control). Deterministic per player, so they
	 * keep it in every session; splits and on/off come from the settings key, live. Stamped on the player's later events
	 * (column `exp`). May yield briefly (until the player's id is known). Server: needs the player; client: the local
	 * player.
	 */
	experiment(name: string, variants: string[]): string;
	experiment(player: Player, name: string, variants: string[]): string;
	experiment(first: Player | string, second: string | string[], third?: string[]): string {
		if (isPlayer(first)) {
			const variants = third ?? [];
			if (this.server) return this.server.experiment(first, second as string, variants);
			if (this.client) return this.client.experiment(second as string, variants);
			return variants[0] ?? "";
		}
		const variants = second as string[];
		if (this.client) return this.client.experiment(first, variants);
		if (this.server) $warn(`[analytics] experiment("${first}") on the server needs the player: experiment(player, name, variants)`);
		return variants[0] ?? "";
	}

	/** Send what is queued soon (server: within the HTTP budget; client: to the server now). */
	flush() {
		this.server?.flushSoon();
		this.client?.flush();
	}

	/** Server only: queue and sink counters (undefined on the client and in edit mode). */
	stats(): AnalyticsStats | undefined {
		return this.server?.stats();
	}
}
