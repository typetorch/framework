import { CollectionService, Players, ReplicatedStorage, RunService, TweenService, Workspace } from "@rbxts/services";
import { Trove } from "@rbxts/trove";

/**
 * The UI workflow (plans/02, from cecot / hopeful-river): layouts are plain instances with CollectionService tags
 * ("Element:<Area>.<Name>"), helpers own behaviour through observers + troves, state lives in charm atoms.
 *
 * `isRealFrame` dedupes copies of a tagged element: only the live one counts.
 *  - under the local player (PlayerGui) -> yes
 *  - in Workspace (SurfaceGui / BillboardGui / parts) -> yes
 *  - in CoreGui while not running (UI Labs stories) -> yes
 *  - anything in ReplicatedStorage (TypeTorch payload templates, asset caches) or StarterGui -> no
 */
export function isRealFrame(instance: Instance): boolean {
	if (instance.IsDescendantOf(ReplicatedStorage)) return false;
	const player = Players.LocalPlayer;
	if (player && instance.IsDescendantOf(player)) return true;
	if (instance.IsDescendantOf(Workspace)) return true;
	if (!RunService.IsRunning()) {
		const [ok, inCoreGui] = pcall(() => instance.IsDescendantOf(game.GetService("CoreGui" as keyof Services)));
		return ok && inCoreGui;
	}
	return false;
}

/**
 * observeTag + isRealFrame + a trove per element. `callback` runs for every live element with `tag` (existing ones
 * included) and gets an `elementTrove` that is cleaned when the element loses the tag, stops being "real", or `trove`
 * is cleaned. Put per-element connections in `elementTrove`, not in the helper's long-lived trove.
 */
export function observeElement<T extends Instance = Instance>(
	trove: Trove,
	tag: string,
	callback: (instance: T, elementTrove: Trove) => void,
) {
	const troves = new Map<Instance, Trove>();
	const remove = (instance: Instance) => {
		const elementTrove = troves.get(instance);
		if (!elementTrove) return;
		troves.delete(instance);
		trove.remove(elementTrove);
	};
	const add = (instance: Instance) => {
		if (troves.has(instance) || !isRealFrame(instance)) return;
		const elementTrove = trove.extend();
		troves.set(instance, elementTrove);
		elementTrove.connect(instance.AncestryChanged, () => {
			if (!isRealFrame(instance)) remove(instance);
		});
		task.spawn(callback, instance as T, elementTrove);
	};
	trove.connect(CollectionService.GetInstanceAddedSignal(tag), add);
	trove.connect(CollectionService.GetInstanceRemovedSignal(tag), remove);
	for (const instance of CollectionService.GetTagged(tag)) add(instance);
}

function scaleOf(gui: GuiObject): UIScale {
	let scale = gui.FindFirstChildOfClass("UIScale");
	if (!scale) {
		scale = new Instance("UIScale");
		scale.Parent = gui;
	}
	return scale;
}

/** Pop in through a UIScale (never tween Size: it re-layouts the whole tree every frame). */
export function popIn(gui: GuiObject) {
	const scale = scaleOf(gui);
	scale.Scale = 0.6;
	gui.Visible = true;
	TweenService.Create(scale, new TweenInfo(0.18, Enum.EasingStyle.Back, Enum.EasingDirection.Out), { Scale: 1 }).Play();
}

/** Pop out through a UIScale, then hide. */
export function popOut(gui: GuiObject, done?: () => void) {
	const scale = scaleOf(gui);
	const tween = TweenService.Create(scale, new TweenInfo(0.12, Enum.EasingStyle.Back, Enum.EasingDirection.In), {
		Scale: 0.6,
	});
	tween.Completed.Once((state) => {
		// A popIn started mid-way overrides this tween (Cancelled): stay visible.
		if (state !== Enum.PlaybackState.Completed) return;
		gui.Visible = false;
		scale.Scale = 1;
		done?.();
	});
	tween.Play();
}

/** A quick scale bump for a value that changed (a counter, a badge). */
export function bump(gui: GuiObject) {
	const scale = scaleOf(gui);
	scale.Scale = 1.15;
	TweenService.Create(scale, new TweenInfo(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { Scale: 1 }).Play();
}

/**
 * One modal at a time (user UI rule): `show(done)` runs when it's this popup's turn; call `done` when it closes and the
 * next one shows. Don't enqueue popups with nothing meaningful to say.
 */
export class PopupQueue {
	private readonly queue = new Array<(done: () => void) => void>();
	private busy = false;

	enqueue(show: (done: () => void) => void) {
		this.queue.push(show);
		this.next();
	}

	private next() {
		if (this.busy) return;
		const show = this.queue.shift();
		if (!show) return;
		this.busy = true;
		let finished = false;
		show(() => {
			if (finished) return;
			finished = true;
			this.busy = false;
			this.next();
		});
	}
}
