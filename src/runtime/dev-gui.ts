/** The dev menu's ScreenGui name, and the attribute with the generation that built it. */
export const DEV_GUI_NAME = "TypeTorchDev";
export const DEV_GUI_GENERATION = "TypeTorchGeneration";

/**
 * Destroys menus an older generation left behind, so a leaked menu goes away. Lives outside devtools: a player who has
 * since lost dev access gets no devtools, and still needs this.
 */
export function sweepStaleMenus(playerGui: Instance, generation: number) {
	for (const child of playerGui.GetChildren()) {
		if (child.Name !== DEV_GUI_NAME || !child.IsA("ScreenGui")) continue;
		const built = child.GetAttribute(DEV_GUI_GENERATION);
		if (typeIs(built, "number") && built >= generation) continue;
		pcall(() => child.Destroy());
	}
}
