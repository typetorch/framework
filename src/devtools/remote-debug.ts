import type { RemoteDebugCaller, ServerKernel } from "../kernel";
import type { LeafStats } from "../net/runtime";
import { assetReport } from "../assets/sync";
import { runningModules } from "../runtime/registry";
import { explorerHandlers, Handler, Registry } from "./explorer/core";
import type { ModuleSummary, NetStat } from "./protocol";
import { describeState, stateRoots } from "./state";
import { inspectState, parseStateRequest, StateRoot } from "./state-inspect";

/**
 * Framework 0.5.0 (plans/25): REMOTE DEBUG, the framework's half. The owner reads a fleet server from the backend's
 * explorer (/servers/<JobId>); the KERNEL polls the backend, checks the op against its allow-list, the rate and that the
 * caller is an owner, then hands the ops that need the running generation to the handler installed here
 * (`kernel.onRemoteDebug`, kernel 0.5.0+). The answer is JSON-encoded and scrubbed of secrets by the kernel.
 *
 * v1 is READ-ONLY, the same readers as the dev menu with the same limits:
 *   modules        the running modules (Modules tab) and the persist summary (Modules > State's roots)
 *   state          Modules > State: { queries } (state-inspect.ts: raw reads, no metamethod or function ever runs,
 *                  12 queries a call, a per-caller token bucket); owners only, like the dev menu on prod rules
 *   assets         Modules > Assets: the last hot-asset sync
 *   network        Network: per-remote counters (no packet capture: it holds other players' data and needs a live watch)
 *   dex.children   read-only Dex: { nodes: [{ id, offset?, limit? }] } (8 nodes, 200 rows each at most)
 *   dex.props      { id }: one instance's properties, attributes and tags
 * The explorer core runs with `canEdit = () => false`, and set / attr / rename / destroy are not ops at all.
 */

/** The ops answered here (the kernel's RD_FRAMEWORK_OPS). Anything else: "unknown op". */
export const REMOTE_DEBUG_OPS = ["modules", "state", "assets", "network", "dex.children", "dex.props"];
/** Dex: nodes per call and rows per node at most (smaller than the dev menu's: every answer crosses the internet). */
export const REMOTE_DEX_NODES = 8;
export const REMOTE_DEX_ROWS = 200;
/** Dex id registries kept (one per caller; the oldest goes). */
const CALLERS_MAX = 4;
/** Modules > State queries per caller: a burst, then this many per second (like the dev menu). */
const INSPECT_BURST = 36;
const INSPECT_RATE = 12;

export interface RemoteDebugDeps {
	/** The server dispatcher's per-remote counters (Network). */
	netStats?: () => ReadonlyMap<string, LeafStats>;
	/** Modules > State's roots (tests pass their own). */
	roots?: () => StateRoot[];
	clock?: () => number;
}

function callerKey(caller: RemoteDebugCaller): string {
	return caller.kind === "roblox" ? `roblox:${caller.userId}` : "token";
}

/** The handler the kernel calls: (op, args, caller) -> answer, or throws a short reason. */
export function remoteDebugHandler(deps: RemoteDebugDeps = {}): (op: string, args: unknown, caller: RemoteDebugCaller) => unknown {
	const clock = deps.clock ?? os.clock;
	const roots = deps.roots ?? stateRoots;
	const dex = new Map<string, Record<string, Handler>>();
	const dexOrder = new Array<string>();
	const inspectBudget = new Map<string, { tokens: number; at: number }>();

	const dexOf = (key: string) => {
		let handlers = dex.get(key);
		if (!handlers) {
			handlers = explorerHandlers(new Registry(), () => false);
			dex.set(key, handlers);
			dexOrder.push(key);
			while (dexOrder.size() > CALLERS_MAX) dex.delete(dexOrder.shift()!);
		}
		return handlers;
	};
	const takeInspect = (key: string, cost: number): boolean => {
		const now = clock();
		const budget = inspectBudget.get(key) ?? { tokens: INSPECT_BURST, at: now };
		budget.tokens = math.min(INSPECT_BURST, budget.tokens + (now - budget.at) * INSPECT_RATE);
		budget.at = now;
		inspectBudget.set(key, budget);
		if (budget.tokens < cost) return false;
		budget.tokens -= cost;
		return true;
	};
	const record = (args: unknown) => (typeIs(args, "table") ? (args as Record<string, unknown>) : {});

	const ops: Record<string, (args: Record<string, unknown>, caller: RemoteDebugCaller) => unknown> = {
		modules: () => {
			const modules = runningModules.map(
				(running): ModuleSummary => ({
					name: running.name,
					dependencies: running.dependencies,
					loadOrder: running.loadOrder,
					initMs: running.initSeconds !== undefined ? math.floor(running.initSeconds * 1000) : undefined,
				}),
			);
			return { modules, state: describeState() };
		},
		state: (args, caller) => {
			const queries = parseStateRequest(args);
			if (typeIs(queries, "string")) error(queries, 0);
			for (const query of queries) if (query.side !== "server") error("bad_side", 0);
			if (!takeInspect(callerKey(caller), queries.size())) error("rate_limited", 0);
			const list = roots();
			return queries.map((query) => inspectState(list, query));
		},
		assets: () => assetReport(),
		network: () => {
			const stats = new Array<NetStat>();
			const source = deps.netStats?.();
			if (source) for (const [path, stat] of source) stats.push({ path, inbound: stat.inbound, outbound: stat.outbound, rejected: stat.rejected, errors: stat.errors });
			stats.sort((a, b) => a.inbound + a.outbound > b.inbound + b.outbound);
			return { remotes: stats, supported: source !== undefined };
		},
		"dex.children": (args, caller) => {
			const nodes = args.nodes;
			if (!typeIs(nodes, "table")) error("bad nodes", 0);
			const list = new Array<{ id: unknown; offset?: unknown; limit?: unknown }>();
			for (const [index, node] of pairs(nodes as object)) {
				if (!typeIs(index, "number") || list.size() >= REMOTE_DEX_NODES) error(`at most ${REMOTE_DEX_NODES} nodes`, 0);
				if (!typeIs(node, "table")) error("bad node", 0);
				const n = node as { id?: unknown; offset?: unknown; limit?: unknown };
				const limit = typeIs(n.limit, "number") ? math.clamp(n.limit, 1, REMOTE_DEX_ROWS) : REMOTE_DEX_ROWS;
				list.push({ id: n.id, offset: n.offset, limit });
			}
			return dexOf(callerKey(caller)).children({ nodes: list });
		},
		"dex.props": (args, caller) => dexOf(callerKey(caller)).props({ id: args.id }),
	};

	return (op, args, caller) => {
		// The kernel checked this already; checked again so the handler stays owner-only wherever it is called from.
		if (!typeIs(caller, "table") || caller.owner !== true) error("owners_only", 0);
		const handler = ops[op];
		if (!handler) error(`unknown op ${op}`, 0);
		return handler(record(args), caller);
	};
}

/**
 * Installs the handler on kernels that have the hook (0.5.0+); older kernels never poll, so there is nothing to do.
 * Returns whether it was installed.
 */
export function registerRemoteDebug(kernel: ServerKernel, deps: RemoteDebugDeps = {}): boolean {
	const api = kernel as unknown as Record<string, unknown>;
	if (!typeIs(api.onRemoteDebug, "function")) return false;
	kernel.onRemoteDebug!(remoteDebugHandler(deps));
	return true;
}
