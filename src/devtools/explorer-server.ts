import { Players } from "@rbxts/services";
import { $print } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import { DevAccess } from "./access";
import { EXPLORER_OPS, Handler, Registry, explorerHandlers } from "./explorer/core";

/**
 * Server half of the explorer: registers the "explorer.*" dev ops. Each dev gets their own id registry (created on
 * their first request, dropped when they leave). The devtools dispatcher has already checked that the player is a dev;
 * every change is re-checked here against the dev-only tools' rule (access.ts: dev rules, or an owner on a public
 * server an owner switched to a dev branch) and logged.
 * Returns a cleanup function (put it in the devtools trove).
 */
export function registerExplorerOps(
	register: (op: string, handler: (player: Player, payload: unknown) => unknown) => void,
	kernel: ServerKernel,
	access = new DevAccess(kernel),
): () => void {
	const sessions = new Map<Player, Record<string, Handler>>();
	const sessionOf = (player: Player) => {
		let handlers = sessions.get(player);
		if (!handlers) {
			handlers = explorerHandlers(
				new Registry(),
				() => access.allows(player),
				(line) => $print(`[explorer] ${player.Name} (${player.UserId}): ${line}`),
			);
			sessions.set(player, handlers);
		}
		return handlers;
	};
	for (const op of EXPLORER_OPS) {
		register(`explorer.${op}`, (player, payload) => {
			// The dispatcher checks this too; re-checked so these ops stay dev-only wherever they are registered.
			if (player.Parent === undefined || !kernel.isDev(player)) error("not a dev", 0);
			return sessionOf(player)[op](payload);
		});
	}
	const leaving = Players.PlayerRemoving.Connect((player) => sessions.delete(player));
	return () => {
		leaving.Disconnect();
		sessions.clear();
	};
}
