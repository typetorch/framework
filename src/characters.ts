import { Players } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { observePlayers } from "./players";

/**
 * Follows one player's characters: `callback` runs for the current character (a swap doesn't re-fire CharacterAdded)
 * and every later one, each with its own trove, cleaned when that character goes (a respawn, CharacterRemoving, the
 * model leaving the game) or when `playerTrove` is cleaned. Callbacks run in their own thread; if one yields and its
 * character goes meanwhile, whatever it added to the trove after that is cleaned when it returns.
 */
function followCharacters(player: Player, playerTrove: Trove, callback: (character: Model, characterTrove: Trove) => void) {
	let current: Model | undefined;
	let currentTrove: Trove | undefined;
	const finish = (character: Model) => {
		const characterTrove = currentTrove;
		if (character !== current || !characterTrove) return;
		current = undefined;
		currentTrove = undefined;
		playerTrove.remove(characterTrove);
	};
	const begin = (character: Model) => {
		if (character === current) return;
		if (current) finish(current);
		const characterTrove = playerTrove.extend();
		let closed = false;
		characterTrove.add(() => {
			closed = true;
		});
		current = character;
		currentTrove = characterTrove;
		characterTrove.connect(character.AncestryChanged, () => {
			if (!character.IsDescendantOf(game)) finish(character);
		});
		task.spawn(() => {
			const [ok, trace] = xpcall(
				() => callback(character, characterTrove),
				(err: unknown) => debug.traceback(tostring(err), 2),
			);
			if (closed) characterTrove.clean();
			if (!ok) error(tostring(trace), 0);
		});
	};
	playerTrove.connect(player.CharacterAdded, begin);
	playerTrove.connect(player.CharacterRemoving, finish);
	const character = player.Character;
	if (character) begin(character);
}

/**
 * Calls `callback` for every character of every player: the ones already spawned when it is called (a generation swap
 * doesn't re-fire CharacterAdded) and every later spawn. `characterTrove` is cleaned when that character goes (respawn,
 * removal, the player leaving) or `trove` is cleaned, so put the character's connections and effects in it. Use this
 * instead of `player.CharacterAdded` or `@rbxts/observers`' observeCharacter.
 *
 * ```ts
 * observeCharacters(this.trove, (player, character, characterTrove) => {
 * 	const humanoid = character.WaitForChild("Humanoid") as Humanoid;
 * 	characterTrove.connect(humanoid.Died, () => this.onDied(player));
 * });
 * ```
 */
export function observeCharacters(
	trove: Trove,
	callback: (player: Player, character: Model, characterTrove: Trove) => void,
) {
	observePlayers(trove, (player, playerTrove) =>
		followCharacters(player, playerTrove, (character, characterTrove) => callback(player, character, characterTrove)),
	);
}

/**
 * Client only: `observeCharacters` for the local player. Replays the current character (after a swap too), then every
 * respawn; `characterTrove` is cleaned when that character goes or `trove` is cleaned.
 */
export function observeLocalCharacter(trove: Trove, callback: (character: Model, characterTrove: Trove) => void) {
	const player = Players.LocalPlayer;
	assert(player, "observeLocalCharacter is client-only (on the server, use observeCharacters)");
	followCharacters(player, trove.extend(), callback);
}
