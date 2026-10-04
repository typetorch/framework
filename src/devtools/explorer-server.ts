import { Players } from "@rbxts/services";
import { $print } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import { EXPLORER_OPS, Handler, Registry, explorerHandlers } from "./explorer/core";

/**
 * Server half of the explorer: registers the "explorer.*" dev ops. Each dev gets their own id registry (created on
 * their first request, dropped when they leave). The devtools dispatcher has already checked that the player is a dev;
 * every change is re-checked here against the effective channel ("dev" only) and logged.
 * Returns a cleanup function (put it in the devtools trove).
 */
export function registerExplorerOps(
	register: (op: string, handler: (player: Player, payload: unknown) => unknown) => void,
	kernel: ServerKernel,
): () => void {
	const sessions = new Map<Player, Record<string, Handler>>();
	const sessionOf = (player: Player) => {
		let handlers = sessions.get(player);
		if (!handlers) {
			handlers = explorerHandlers(
				new Registry(),
				() => kernel.channel === "dev",
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
