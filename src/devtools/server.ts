import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import type { ServerDispatcher } from "../net/runtime";
import { runningModules } from "../runtime/registry";
import { registerRemoteClaude } from "./claude";
import { listChildren, listProperties, resolvePath, setProperty } from "./dex";
import { DEV_REQUEST, DEV_RESPONSE, DevOp, ModuleSummary, NetStat } from "./protocol";
import { describeState } from "./state";

function isStringArray(value: unknown): value is string[] {
	if (!typeIs(value, "table")) return false;
	let count = 0;
	for (const [key, item] of pairs(value as object)) {
		count += 1;
		if (!typeIs(key, "number") || !typeIs(item, "string") || (item as string).size() > 100) return false;
	}
	return count <= 40;
}

/**
 * Server half of the dev menu (plans/10). Every request is checked here: the player must be a dev (Studio, registry
 * member or dev badge, not revoked), and anything that changes the server needs the "dev" effective channel.
 * Prod-channel servers are read-only.
 */
export function startDevtoolsServer(kernel: ServerKernel, dispatcher: ServerDispatcher, trove: Trove) {
	const ops = new Map<string, DevOp>();
	const requireDevChannel = () => {
		if (kernel.channel !== "dev") error("read-only on prod-channel servers", 0);
	};
	const pathOf = (payload: unknown) => {
		assert(isStringArray(payload), "bad path");
		const instance = resolvePath(payload);
		assert(instance, "not found");
		return instance;
	};

	ops.set("status", (player) => {
		const modules = runningModules.map(
			(running): ModuleSummary => ({
				name: running.name,
				dependencies: running.dependencies,
				loadOrder: running.loadOrder,
				initMs: running.initSeconds !== undefined ? math.floor(running.initSeconds * 1000) : undefined,
			}),
		);
		return { server: kernel.status(), artifact: kernel.artifact, modules, you: kernel.devInfo(player) };
	});
	ops.set("logs", (_, payload) => kernel.logs(typeIs(payload, "number") ? payload : undefined, 200));
	ops.set("branches", () => kernel.branches());
	ops.set("reload", (player) => kernel.reload(player));
	ops.set("rollback", (player) => kernel.rollback(player));
	ops.set("switch", (player, payload) => {
		assert(typeIs(payload, "string") && payload.size() <= 64, "bad branch");
		return kernel.switchBranch(player, payload);
	});
	ops.set("newServer", (player, payload) => {
		assert(typeIs(payload, "string") && payload.size() <= 64, "bad branch");
		return kernel.newServer(player, payload);
	});
	ops.set("net", () => {
		const stats = new Array<NetStat>();
		for (const [path, stat] of dispatcher.stats) stats.push({ path, ...stat });
		stats.sort((a, b) => a.inbound + a.outbound > b.inbound + b.outbound);
		return stats;
	});
	ops.set("dex.children", (_, payload) => listChildren(pathOf(payload)));
	ops.set("dex.props", (_, payload) => listProperties(pathOf(payload)));
	ops.set("dex.set", (_, payload) => {
		requireDevChannel();
		const request = payload as { path: unknown; name: unknown; value: unknown };
		assert(typeIs(request, "table") && typeIs(request.name, "string") && typeIs(request.value, "string"), "bad edit");
		assert((request.value as string).size() <= 1000, "value too long");
		const [ok, err] = setProperty(pathOf(request.path), request.name as string, request.value as string);
		if (!ok) error(err ?? "edit failed", 0);
		return true;
	});
	ops.set("dex.destroy", (_, payload) => {
		requireDevChannel();
		const instance = pathOf(payload);
		assert(instance.Parent !== game, "can't destroy a service");
		instance.Destroy();
		return true;
	});
	ops.set("state", () => describeState());
	// Claude prompt (plans/11): claude.session / claude.prompt / claude.status / claude.cancel.
	registerRemoteClaude(kernel, trove, ops);

	const reply = (player: Player, id: unknown, ok: boolean, result: unknown) => kernel.send(player, DEV_RESPONSE, id, ok, result);

	dispatcher.setRaw(DEV_REQUEST, (player, id, op, payload) => {
		if (!typeIs(id, "number") || !typeIs(op, "string")) return;
		if (!kernel.isDev(player)) {
			reply(player, id, false, "not a dev");
			return;
		}
		const handler = ops.get(op);
		if (!handler) {
			reply(player, id, false, `unknown op ${op}`);
			return;
		}
		const [ok, result] = pcall(handler, player, payload);
		if (!ok) $warn(`[devtools] ${op} by ${player.Name}: ${result}`);
		reply(player, id, ok, result);
	});
	trove.add(() => dispatcher.removeRaw(DEV_REQUEST));
}
