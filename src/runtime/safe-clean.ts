import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";

/** The parts of @rbxts/trove 1.x that `trove.clean()` uses; read so one throwing cleanup can't skip the rest. */
interface TroveTrack {
	obj: unknown;
	cleanup: unknown;
}
interface TroveInternals {
	objects?: TroveTrack[];
	cleaning?: boolean;
	cleanupObj?: (self: TroveInternals, track: TroveTrack) => void;
}

/**
 * `trove.clean()`, but every object is cleaned in its own pcall: a cleanup that throws warns (`<label> cleanup threw`)
 * and the rest still run. `trove.clean()` stops at the first error and leaves the trove stuck "cleaning", so one
 * `trove.remove(x)` inside a cleanup ("Cannot call trove.remove() while cleaning") used to abort the whole generation
 * stop: later modules' troves, the network and the dev menu stayed alive. Child troves (`trove.extend()`) are swept the
 * same way. Falls back to a pcalled `trove.clean()` for a trove it doesn't recognize.
 */
export function cleanTrove(trove: Trove, label: string) {
	const internals = trove as unknown as TroveInternals;
	const objects = internals.objects;
	const cleanupObj = internals.cleanupObj;
	if (!typeIs(objects, "table") || !typeIs(cleanupObj, "function")) {
		const [ok, err] = pcall(() => trove.clean());
		if (!ok) $warn(`${label} cleanup threw: ${err}`);
		return;
	}
	// Already being cleaned further up the stack (a cleanup that cleans its own trove): leave it to that clean.
	if (internals.cleaning === true) return;
	internals.cleaning = true;
	const troveClass = getmetatable(trove);
	for (const track of objects) {
		const obj = track.obj;
		const [ok, err] = pcall(() => {
			if (typeIs(obj, "table") && getmetatable(obj) === troveClass) cleanTrove(obj as Trove, label);
			else cleanupObj(internals, track);
		});
		if (!ok) $warn(`${label} cleanup threw: ${err}`);
	}
	table.clear(objects);
	internals.cleaning = false;
}

/** Runs one step of a generation stop; a step that throws warns and the stop goes on. */
export function stopStep(label: string, step: () => void) {
	const [ok, err] = pcall(step);
	if (!ok) $warn(`TypeTorch stop: ${label} threw: ${err}`);
}
