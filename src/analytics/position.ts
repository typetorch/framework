/**
 * Event positions: the props `px`, `py`, `pz` (studs, rounded to 0.1) of a player's character root, added to game-code
 * events that ask for them (`track(..., { position })`, or an event name in the `positions` lists). The backend's map
 * layers read exactly these keys.
 *
 * Pure: no imports and no services (one property read per event, nothing per frame), so it also runs offline under
 * Lune (scripts/test-analytics.luau).
 */

function finite(value: number): boolean {
	return value === value && value !== math.huge && value !== -math.huge;
}

/** `value` rounded to 0.1. */
export function roundTenth(value: number): number {
	return math.floor(value * 10 + 0.5) / 10;
}

/**
 * The position of the player's character root (Humanoid root part: the model's PrimaryPart, else `HumanoidRootPart`),
 * or undefined when there is no player, character, root part or finite position. Never throws.
 */
export function characterPosition(player: Player | undefined): Vector3 | undefined {
	if (player === undefined) return undefined;
	const [ok, position] = pcall(() => {
		const character = player.Character;
		if (!character) return undefined;
		const root = character.PrimaryPart ?? character.FindFirstChild("HumanoidRootPart");
		if (!root || !root.IsA("BasePart")) return undefined;
		return root.Position;
	});
	if (!ok || !typeIs(position, "Vector3")) return undefined;
	if (!finite(position.X) || !finite(position.Y) || !finite(position.Z)) return undefined;
	return position;
}

/**
 * `props` with `px`, `py`, `pz` from `position` (a shallow copy: the game's table is never changed). Unchanged when
 * there is no position, the props aren't a table, or the game set any of `px`, `py`, `pz` itself.
 */
export function withPosition(props: object | undefined, position: Vector3 | undefined): object | undefined {
	if (position === undefined) return props;
	if (props !== undefined && !typeIs(props, "table")) return props;
	const source = (props ?? {}) as Record<string, unknown>;
	if (source.px !== undefined || source.py !== undefined || source.pz !== undefined) return props;
	const result: Record<string, unknown> = {};
	for (const [key, value] of pairs(source)) result[key as string] = value;
	result.px = roundTenth(position.X);
	result.py = roundTenth(position.Y);
	result.pz = roundTenth(position.Z);
	return result;
}
