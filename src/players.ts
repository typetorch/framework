import { Players } from "@rbxts/services";
import { Trove } from "@rbxts/trove";

/**
 * Calls `callback` for every player: the ones already in the server (a generation swap doesn't re-fire PlayerAdded)
 * and every one who joins later. Each call gets a trove that is cleaned when the player leaves or `trove` is cleaned.
 * Use this instead of Players.PlayerAdded.
 */
export function observePlayers(trove: Trove, callback: (player: Player, playerTrove: Trove) => void) {
	const troves = new Map<Player, Trove>();
	const add = (player: Player) => {
		if (troves.has(player) || player.Parent === undefined) return;
		const playerTrove = trove.extend();
		troves.set(player, playerTrove);
		task.spawn(callback, player, playerTrove);
	};
	trove.connect(Players.PlayerAdded, add);
	trove.connect(Players.PlayerRemoving, (player) => {
		const playerTrove = troves.get(player);
		if (!playerTrove) return;
		troves.delete(player);
		trove.remove(playerTrove);
	});
	for (const player of Players.GetPlayers()) add(player);
}
