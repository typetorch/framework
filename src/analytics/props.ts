import { HttpService, Players } from "@rbxts/services";
import { PROPS_MAX_BYTES } from "./schema";

/** A JSON object text of `value` (the `props` column), at most PROPS_MAX_BYTES; larger becomes `{"_trunc":<bytes>}`. */
export function encodeProps(value: object | undefined): string {
	if (value === undefined || next(value)[0] === undefined) return "{}";
	const [ok, text] = pcall(() => HttpService.JSONEncode(value));
	if (!ok) return `{"_err":"encode"}`;
	if (text.sub(1, 1) !== "{") return text === "[]" ? "{}" : `{"value":${text}}`;
	if (text.size() > PROPS_MAX_BYTES) return `{"_trunc":${text.size()}}`;
	return text;
}

/** Escapes Lua pattern characters. */
function literal(text: string): string {
	return text.gsub("[%^%$%(%)%%%.%[%]%*%+%-%?]", "%%%0")[0];
}

/**
 * Text without the names of players in this server (error messages carry paths like `Players.Name.PlayerGui` or
 * `Workspace.Name.Head`). Usernames and display names are never collected.
 */
export function scrubNames(text: string): string {
	let result = text;
	for (const player of Players.GetPlayers()) {
		result = result.gsub(literal(player.Name), "<player>")[0];
		if (player.DisplayName !== player.Name && player.DisplayName.size() >= 3) {
			result = result.gsub(literal(player.DisplayName), "<player>")[0];
		}
	}
	return result;
}
