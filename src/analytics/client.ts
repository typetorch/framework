import {
	GuiService,
	Players,
	ProximityPromptService,
	RunService,
	Stats,
	TextChatService,
	UserInputService,
	VRService,
	Workspace,
} from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ClientDispatcher } from "../net/runtime";
import { TypeTorch } from "../typetorch";
import { observeElement } from "../ui";
import { EventKindCode, InputKind, pitchOf, RecWriter, yawOf } from "./codec";
import { assignVariant, isExperimentName, isVariantList } from "./experiments";
import {
	CHANNEL,
	CHUNK_SECONDS,
	CHUNK_TARGET_BYTES,
	CLIENT_BATCH_BYTES,
	CLIENT_BATCH_MAX,
	isEventName,
	type ClientEvent,
	type HelloInfo,
	type ServerHello,
} from "./protocol";
import { encodeProps, scrubNames } from "./props";
import type { AnalyticsOptions, DeviceKind, EventKind, ExperimentOverride } from "./schema";

/**
 * The client half of the analytics engine (plans/16): forwards the game's events to the server (never to the
 * internet), reports the device, client tech health and screens, and records the first-ever session when the server
 * asks for it. One per client generation, shared by every `new AnalyticsEngine()`.
 */

const CLIENT_KEY = "__typetorch/analytics-client.v1";
/** Events held while the server hasn't answered hello (oldest dropped). */
const HELD_MAX = 300;
const SEND_EVERY = 2;
/** The recording: seconds after the first input, and at most this long overall. */
const RECORD_AFTER_INPUT = 60;
const RECORD_MAX = 600;
const SAMPLE_EVERY = 0.1;
/** An unchanged sample is still written this often. */
const SAMPLE_KEEPALIVE = 5;
const ERRORS_EVERY = 30;
const ERRORS_PER_SESSION = 100;
/** ScreenGuis that aren't the game's screens. */
const IGNORED_GUIS = new Set(["TouchGui", "Freecam", "BubbleChat", "Chat", "ProximityPrompts", "RbxCameraUI"]);
/** A screen that closes and opens again within this many seconds (ResetOnSpawn) never left. */
const SCREEN_DEBOUNCE = 1;

interface RecordingClientState {
	started: boolean;
	ended: boolean;
	/** os.clock() when recording started / at the first input (the client process clock survives swaps). */
	startClock: number;
	firstInput?: number;
	/** Next chunk index. */
	chunk: number;
}

interface ClientStore {
	loadSent: boolean;
	errorsSent: number;
	rec: RecordingClientState;
}

type Held = [clock: number, kind: string, name: string, props: string];

function deviceInfo(): HelloInfo {
	const camera = Workspace.CurrentCamera;
	const viewport = camera ? camera.ViewportSize : new Vector2(0, 0);
	const vr = VRService.VREnabled;
	const [consoleOk, isConsole] = pcall(() => GuiService.IsTenFootInterface());
	let dev: DeviceKind = "unknown";
	if (vr) dev = "vr";
	else if (consoleOk && isConsole) dev = "console";
	else if (UserInputService.TouchEnabled && !UserInputService.KeyboardEnabled) {
		dev = math.min(viewport.X, viewport.Y) >= 600 ? "tablet" : "phone";
	} else if (UserInputService.KeyboardEnabled || UserInputService.MouseEnabled) dev = "desktop";
	const last = UserInputService.GetLastInputType();
	let input = "unknown";
	if (vr) input = "vr";
	else if (last === Enum.UserInputType.Touch) input = "touch";
	else if (last.Name.sub(1, 7) === "Gamepad") input = "gamepad";
	else if (last === Enum.UserInputType.Keyboard || last.Name.sub(1, 5) === "Mouse") input = "kbm";
	return {
		dev,
		input,
		w: math.floor(viewport.X),
		h: math.floor(viewport.Y),
		touch: UserInputService.TouchEnabled,
		kb: UserInputService.KeyboardEnabled,
		mouse: UserInputService.MouseEnabled,
		pad: UserInputService.GamepadEnabled,
		vr,
	};
}

/** `a/b/c`: the names from below `root` down to `instance` ("" when it isn't under `root`). */
function pathIn(instance: Instance, root: Instance): string {
	const parts = new Array<string>();
	let node: Instance | undefined = instance;
	while (node && node !== root) {
		parts.unshift(node.Name);
		node = node.Parent;
	}
	return node === root ? parts.join("/") : "";
}

/** A prompt's path from Workspace, with any player's character replaced by `<player>` (no names). */
function promptPath(prompt: Instance): string {
	const parts = new Array<string>();
	let node: Instance | undefined = prompt;
	while (node && node !== Workspace && node !== game) {
		if (node.IsA("Model") && Players.GetPlayerFromCharacter(node)) {
			parts.unshift("<player>");
			break;
		}
		parts.unshift(node.Name);
		node = node.Parent;
	}
	return parts.join("/");
}

function chatFocused(): boolean {
	const [ok, focused] = pcall(() => TextChatService.FindFirstChildOfClass("ChatInputBarConfiguration")?.IsFocused);
	return ok && focused === true;
}

/** Typing in a TextBox or the chat: keys are never recorded then. */
function typing(): boolean {
	return UserInputService.GetFocusedTextBox() !== undefined || chatFocused();
}

/**
 * Which screen the player sees: ScreenGuis in PlayerGui (Enabled), GuiObjects tagged `TTScreen` (Visible; name from a
 * `Name` attribute or the instance), and `screen()` from game code, which wins. The newest open one is current.
 */
class ScreenTracker {
	private readonly counts = new Map<string, number>();
	private readonly order = new Array<string>();
	private readonly closing = new Map<string, thread>();
	private manualScreen?: string;
	current = "";

	constructor(
		private readonly trove: Trove,
		private readonly changed: (to: string, from: string) => void,
		private readonly raw: (open: boolean, name: string) => void,
	) {}

	open(name: string) {
		const pending = this.closing.get(name);
		if (pending) {
			// Closed and opened again at once (a ResetOnSpawn ScreenGui): it never left.
			task.cancel(pending);
			this.closing.delete(name);
			return;
		}
		const count = this.counts.get(name) ?? 0;
		this.counts.set(name, count + 1);
		if (count > 0) return;
		this.order.push(name);
		this.raw(true, name);
		this.update();
	}

	close(name: string) {
		if ((this.counts.get(name) ?? 0) === 0 || this.closing.has(name)) return;
		const thread = task.delay(SCREEN_DEBOUNCE, () => {
			this.closing.delete(name);
			const count = (this.counts.get(name) ?? 1) - 1;
			if (count > 0) {
				this.counts.set(name, count);
				return;
			}
			this.counts.delete(name);
			const index = this.order.indexOf(name);
			if (index >= 0) this.order.remove(index);
			this.raw(false, name);
			this.update();
		});
		this.closing.set(name, thread);
		this.trove.add(thread);
	}

	manual(name: string | undefined) {
		this.manualScreen = name === "" ? undefined : name;
		this.update();
	}

	private update() {
		const top = this.manualScreen ?? this.order[this.order.size() - 1] ?? "";
		if (top === this.current) return;
		const from = this.current;
		this.current = top;
		this.changed(top, from);
	}

	watch(playerGui: Instance) {
		const watchGui = (gui: ScreenGui) => {
			const name = gui.Name;
			if (IGNORED_GUIS.has(name) || name.sub(1, 9) === "TypeTorch") return;
			const guiTrove = this.trove.extend();
			let isOpen = false;
			const update = () => {
				const want = gui.Enabled && gui.Parent === playerGui;
				if (want === isOpen) return;
				isOpen = want;
				if (want) this.open(name.sub(1, 64));
				else this.close(name.sub(1, 64));
			};
			guiTrove.connect(gui.GetPropertyChangedSignal("Enabled"), update);
			guiTrove.connect(gui.AncestryChanged, () => {
				update();
				if (gui.Parent !== playerGui) this.trove.remove(guiTrove);
			});
			update();
		};
		this.trove.connect(playerGui.ChildAdded, (child) => {
			if (child.IsA("ScreenGui")) watchGui(child);
		});
		for (const child of playerGui.GetChildren()) if (child.IsA("ScreenGui")) watchGui(child);

		observeElement(this.trove, "TTScreen", (instance, elementTrove) => {
			if (!instance.IsA("GuiObject")) return;
			const attribute = instance.GetAttribute("Name");
			const name = (typeIs(attribute, "string") && attribute !== "" ? attribute : instance.Name).sub(1, 64);
			let isOpen = false;
			const update = (want: boolean) => {
				if (want === isOpen) return;
				isOpen = want;
				if (want) this.open(name);
				else this.close(name);
			};
			elementTrove.connect(instance.GetPropertyChangedSignal("Visible"), () => update(instance.Visible));
			elementTrove.add(() => update(false));
			update(instance.Visible);
		});
	}
}

/**
 * The first-ever-session recorder (plans/16 section 3): character and camera about 10 times a second, inputs (never
 * while a TextBox or the chat has focus; text boxes only say "used box <path>"), buttons pressed and hovered, screens,
 * prompts, deaths and the game's own events, packed into tt-rec-1 chunks. Runs from the join until 60 s after the
 * first input (at most 10 minutes).
 */
class Recorder {
	private readonly trove: Trove;
	private writer = new RecWriter(SAMPLE_EVERY * 1000);
	private chunkStart = os.clock();
	private lastSample = 0;
	private lastWritten = 0;
	private lastKey = "";
	private lastScroll = 0;
	private readonly hovers = new Map<string, number>();
	private readonly sticks = new Map<Enum.KeyCode, boolean>();
	private done = false;

	constructor(
		parent: Trove,
		private readonly state: RecordingClientState,
		private readonly send: (chunk: number, age: number, n: number, data: buffer, last: boolean, why: string) => void,
	) {
		this.trove = parent.extend();
		if (!state.started) {
			state.started = true;
			state.startClock = os.clock();
		}
	}

	private at(): number {
		return (os.clock() - this.chunkStart) * 1000;
	}

	private firstInput() {
		if (this.state.firstInput === undefined) this.state.firstInput = os.clock();
	}

	/** Sends the current chunk (if it has anything, or it's the last) and starts a new one. */
	rotate(last: boolean, why: string) {
		if (this.done) return;
		if (this.writer.records > 0 || last) {
			const data = this.writer.finish(last);
			this.send(this.state.chunk, math.floor(this.at()), this.writer.samples, data, last, why);
			this.state.chunk += 1;
		}
		this.writer = new RecWriter(SAMPLE_EVERY * 1000);
		this.chunkStart = os.clock();
		this.lastKey = "";
	}

	finish(why: string) {
		if (this.done) return;
		this.rotate(true, why);
		this.done = true;
		this.state.ended = true;
		this.trove.destroy();
	}

	event(kind: EventKindCode, text?: string) {
		if (this.done) return;
		this.writer.event(this.at(), kind, text);
	}

	private sample() {
		const camera = Workspace.CurrentCamera;
		if (!camera) return;
		const view = camera.CFrame;
		const look = view.LookVector;
		const camPos = view.Position;
		const kyaw = yawOf(look.X, look.Z);
		const kpitch = pitchOf(look.Y);
		const root = Players.LocalPlayer.Character?.FindFirstChild("HumanoidRootPart");
		const now = os.clock();
		if (root && root.IsA("BasePart")) {
			const pos = root.Position;
			const facing = root.CFrame.LookVector;
			const cyaw = yawOf(facing.X, facing.Z);
			const key = `${math.floor(pos.X * 8)},${math.floor(pos.Y * 8)},${math.floor(pos.Z * 8)},${math.floor(cyaw * 40)},${math.floor(camPos.X * 4)},${math.floor(camPos.Y * 4)},${math.floor(camPos.Z * 4)},${math.floor(kyaw * 40)},${math.floor(kpitch * 40)}`;
			if (key === this.lastKey && now - this.lastWritten < SAMPLE_KEEPALIVE) return;
			this.lastKey = key;
			this.lastWritten = now;
			this.writer.sample(this.at(), pos.X, pos.Y, pos.Z, cyaw, camPos.X, camPos.Y, camPos.Z, kyaw, kpitch);
		} else {
			const key = `cam,${math.floor(camPos.X * 4)},${math.floor(camPos.Y * 4)},${math.floor(camPos.Z * 4)},${math.floor(kyaw * 40)},${math.floor(kpitch * 40)}`;
			if (key === this.lastKey && now - this.lastWritten < SAMPLE_KEEPALIVE) return;
			this.lastKey = key;
			this.lastWritten = now;
			this.writer.camera(this.at(), camPos.X, camPos.Y, camPos.Z, kyaw, kpitch);
		}
	}

	private pointer(kind: InputKind, code: number, input: InputObject, processed: boolean) {
		const camera = Workspace.CurrentCamera;
		const viewport = camera ? camera.ViewportSize : new Vector2(1, 1);
		const position = input.Position;
		this.writer.pointer(this.at(), kind, code, position.X / math.max(viewport.X, 1), position.Y / math.max(viewport.Y, 1), processed);
	}

	private onInput(input: InputObject, processed: boolean, began: boolean) {
		if (this.done) return;
		const kind = input.UserInputType;
		if (kind === Enum.UserInputType.Keyboard) {
			if (typing()) return;
			if (began) this.firstInput();
			this.writer.key(this.at(), began ? InputKind.KeyDown : InputKind.KeyUp, input.KeyCode.Value, processed);
		} else if (
			kind === Enum.UserInputType.MouseButton1 ||
			kind === Enum.UserInputType.MouseButton2 ||
			kind === Enum.UserInputType.MouseButton3
		) {
			if (began) this.firstInput();
			this.pointer(began ? InputKind.MouseDown : InputKind.MouseUp, kind.Value, input, processed);
		} else if (kind === Enum.UserInputType.Touch) {
			if (began) this.firstInput();
			this.pointer(began ? InputKind.TouchStart : InputKind.TouchEnd, 0, input, processed);
		} else if (kind.Name.sub(1, 7) === "Gamepad") {
			const code = input.KeyCode;
			if (code === Enum.KeyCode.Thumbstick1 || code === Enum.KeyCode.Thumbstick2) return;
			if (began) this.firstInput();
			this.writer.key(this.at(), began ? InputKind.PadDown : InputKind.PadUp, code.Value, processed);
		}
	}

	private onChanged(input: InputObject, processed: boolean) {
		if (this.done) return;
		const kind = input.UserInputType;
		if (kind === Enum.UserInputType.MouseWheel) {
			const now = os.clock();
			if (now - this.lastScroll < 0.2) return;
			this.lastScroll = now;
			// Position: the mouse (X, Y) and the wheel direction (Z).
			this.pointer(InputKind.Scroll, input.Position.Z > 0 ? 1 : 2, input, processed);
		} else if (kind.Name.sub(1, 7) === "Gamepad") {
			const code = input.KeyCode;
			if (code !== Enum.KeyCode.Thumbstick1 && code !== Enum.KeyCode.Thumbstick2) return;
			const magnitude = new Vector2(input.Position.X, input.Position.Y).Magnitude;
			const active = this.sticks.get(code) === true;
			if (!active && magnitude > 0.25) {
				this.sticks.set(code, true);
				this.firstInput();
				this.writer.key(this.at(), InputKind.StickStart, code.Value, processed);
			} else if (active && magnitude < 0.15) {
				this.sticks.set(code, false);
				this.writer.key(this.at(), InputKind.StickStop, code.Value, processed);
			}
		}
	}

	private watchButtons(playerGui: Instance) {
		const connections = new Map<Instance, RBXScriptConnection[]>();
		const watch = (button: Instance) => {
			if (!button.IsA("GuiButton") || connections.has(button)) return;
			const gui = button.FindFirstAncestorWhichIsA("ScreenGui");
			if (gui && gui.Name.sub(1, 9) === "TypeTorch") return;
			const list = [
				button.Activated.Connect(() => this.event(EventKindCode.Button, pathIn(button, playerGui))),
				button.MouseEnter.Connect(() => {
					const path = pathIn(button, playerGui);
					const now = os.clock();
					if (now - (this.hovers.get(path) ?? -math.huge) < 1) return;
					this.hovers.set(path, now);
					this.event(EventKindCode.Hover, path);
				}),
			];
			connections.set(button, list);
		};
		const unwatch = (button: Instance) => {
			const list = connections.get(button);
			if (!list) return;
			connections.delete(button);
			for (const connection of list) connection.Disconnect();
		};
		this.trove.connect(playerGui.DescendantAdded, watch);
		this.trove.connect(playerGui.DescendantRemoving, unwatch);
		this.trove.add(() => {
			for (const [, list] of connections) for (const connection of list) connection.Disconnect();
			connections.clear();
		});
		for (const descendant of playerGui.GetDescendants()) watch(descendant);
	}

	private watchCharacter(character: Model, spawned: boolean) {
		const characterTrove = this.trove.extend();
		if (spawned) this.event(EventKindCode.Spawned);
		characterTrove.add(
			task.spawn(() => {
				const humanoid = character.WaitForChild("Humanoid", 10);
				if (humanoid && humanoid.IsA("Humanoid")) characterTrove.connect(humanoid.Died, () => this.event(EventKindCode.Died));
			}),
		);
		characterTrove.connect(character.AncestryChanged, () => {
			if (!character.Parent) this.trove.remove(characterTrove);
		});
	}

	start(playerGui: Instance | undefined) {
		const trove = this.trove;
		let accumulated = 0;
		trove.connect(RunService.Heartbeat, (dt) => {
			if (this.done) return;
			accumulated += dt;
			if (accumulated < SAMPLE_EVERY) return;
			accumulated = 0;
			this.sample();
			const now = os.clock();
			if (this.state.firstInput !== undefined && now - this.state.firstInput >= RECORD_AFTER_INPUT) this.finish("window");
			else if (now - this.state.startClock >= RECORD_MAX) this.finish("cap");
			else if (now - this.chunkStart >= CHUNK_SECONDS || this.writer.size() >= CHUNK_TARGET_BYTES) this.rotate(false, "");
		});
		trove.connect(UserInputService.InputBegan, (input, processed) => this.onInput(input, processed, true));
		trove.connect(UserInputService.InputEnded, (input, processed) => this.onInput(input, processed, false));
		trove.connect(UserInputService.InputChanged, (input, processed) => this.onChanged(input, processed));
		trove.connect(UserInputService.TextBoxFocused, (box) => {
			const [ok, path] = pcall(() => (playerGui ? pathIn(box, playerGui) : ""));
			this.event(EventKindCode.TextBox, ok && path !== "" ? path : "<other>");
		});
		trove.connect(ProximityPromptService.PromptShown, (prompt) => this.event(EventKindCode.PromptShown, promptPath(prompt)));
		trove.connect(ProximityPromptService.PromptHidden, (prompt) => this.event(EventKindCode.PromptHidden, promptPath(prompt)));
		trove.connect(ProximityPromptService.PromptTriggered, (prompt) => this.event(EventKindCode.PromptTriggered, promptPath(prompt)));
		const player = Players.LocalPlayer;
		trove.connect(player.CharacterAdded, (character) => this.watchCharacter(character, true));
		if (player.Character) this.watchCharacter(player.Character, false);
		if (playerGui) this.watchButtons(playerGui);
		this.sample();
	}
}

export class ClientAnalytics {
	private readonly store: ClientStore;
	private hello?: ServerHello;
	private readonly held = new Array<Held>();
	private heldBytes = 0;
	private readonly experimentsSent = new Set<string>();
	private recorder?: Recorder;
	private screens?: ScreenTracker;
	private activity = "";
	private manualScreen = "";
	private stopped = false;
	private playerGui?: Instance;

	constructor(
		private readonly options: AnalyticsOptions,
		private readonly dispatcher: ClientDispatcher,
		private readonly trove: Trove,
	) {
		this.store = TypeTorch.persist<ClientStore>(CLIENT_KEY, () => ({
			loadSent: false,
			errorsSent: 0,
			rec: { started: false, ended: false, startClock: 0, chunk: 0 },
		}));
		trove.add(() => {
			this.stopped = true;
		});
		dispatcher.setRaw(CHANNEL, (op, payload) => {
			const [ok, err] = pcall(() => {
				if (op === "hi") this.onHello(payload);
			});
			if (!ok) $warn(`[analytics] server message failed: ${tostring(err).sub(1, 200)}`);
		});
		trove.add(() => dispatcher.removeRaw(CHANNEL));
		// A swap: what's held and the current chunk go now (onSwapOut runs before the generation stops).
		trove.add(
			TypeTorch.onSwapOut(() => {
				this.sendHeld();
				this.recorder?.rotate(false, "swap");
			}),
		);
		this.startSending();
		if (options.tech !== false) this.startTech();
		trove.add(
			task.spawn(() => {
				const playerGui = Players.LocalPlayer.WaitForChild("PlayerGui", 30);
				if (!playerGui || this.stopped) return;
				this.playerGui = playerGui;
				if (options.screens !== false) this.startScreens(playerGui);
			}),
		);
	}

	// Server link ------------------------------------------------------------------------------------------------------

	private sayHello() {
		const info = deviceInfo();
		if (!this.store.loadSent && TypeTorch.startInfo.kind === "boot" && TypeTorch.generation <= 1) {
			info.load = math.floor(time() * 10) / 10;
		}
		this.dispatcher.kernel.send(CHANNEL, "hello", info);
	}

	private onHello(payload: unknown) {
		if (!typeIs(payload, "table")) return;
		const raw = payload as Partial<ServerHello>;
		if (!typeIs(raw.pid, "string") || raw.pid === "") return;
		const exps: Record<string, ExperimentOverride> = typeIs(raw.exps, "table") ? (raw.exps as Record<string, ExperimentOverride>) : {};
		this.hello = {
			pid: raw.pid,
			newp: raw.newp === true,
			rec: raw.rec === true,
			tech: typeIs(raw.tech, "number") ? math.clamp(raw.tech, 15, 3600) : 60,
			exps,
		};
		this.store.loadSent = true;
		this.sendHeld();
		const state = this.store.rec;
		if (this.hello.rec && this.options.recording !== false && !this.recorder && !state.ended && !this.stopped) {
			const recorder = new Recorder(this.trove, state, (chunk, age, n, data, last, why) =>
				this.dispatcher.kernel.send(CHANNEL, "rec", chunk, age, n, data, last, why),
			);
			this.recorder = recorder;
			recorder.start(this.playerGui ?? Players.LocalPlayer.FindFirstChildOfClass("PlayerGui"));
			if (this.screens && this.screens.current !== "") recorder.event(EventKindCode.ScreenOpen, this.screens.current);
		}
	}

	private sendHeld() {
		if (!this.hello || this.held.size() === 0 || this.stopped) return;
		const now = os.clock();
		let batch = new Array<ClientEvent>();
		let bytes = 0;
		for (const [clock, kind, name, props] of this.held) {
			const size = props.size() + name.size() + 24;
			if (batch.size() >= CLIENT_BATCH_MAX || (batch.size() > 0 && bytes + size > CLIENT_BATCH_BYTES)) {
				this.dispatcher.kernel.send(CHANNEL, "ev", batch);
				batch = [];
				bytes = 0;
			}
			batch.push([math.clamp(math.floor((now - clock) * 1000), 0, 600000), kind, name, props]);
			bytes += size;
		}
		if (batch.size() > 0) this.dispatcher.kernel.send(CHANNEL, "ev", batch);
		this.held.clear();
		this.heldBytes = 0;
	}

	private startSending() {
		this.trove.add(
			task.spawn(() => {
				// Hello until the server answers (its engine may start later than this one): every 5 s for a minute, then
				// every 30 s.
				let tries = 0;
				while (!this.hello) {
					this.sayHello();
					tries += 1;
					task.wait(tries < 12 ? 5 : 30);
				}
			}),
		);
		this.trove.add(
			task.spawn(() => {
				while (true) {
					task.wait(SEND_EVERY);
					this.sendHeld();
				}
			}),
		);
	}

	/** Queues one event for the server (sent every 2 s, or at once when the batch is full). */
	push(kind: EventKind, name: string, props: string) {
		if (this.stopped) return;
		this.held.push([os.clock(), kind, name, props]);
		this.heldBytes += props.size() + name.size() + 24;
		while (this.held.size() > HELD_MAX) {
			const dropped = this.held.shift()!;
			this.heldBytes -= dropped[3].size() + dropped[2].size() + 24;
		}
		if (this.hello && (this.held.size() >= CLIENT_BATCH_MAX || this.heldBytes >= CLIENT_BATCH_BYTES)) this.sendHeld();
	}

	// Game code --------------------------------------------------------------------------------------------------------

	track(kind: EventKind, name: string, props?: object) {
		if (!isEventName(name)) {
			$warn(`[analytics] ${kind} event name must be 1-64 characters: ${tostring(name).sub(1, 80)}`);
			return;
		}
		this.push(kind, name, encodeProps(props));
		if (kind === "custom") this.recorder?.event(EventKindCode.Custom, name);
	}

	setActivity(activity: string | undefined) {
		const to = activity ?? "";
		if (to !== "" && !isEventName(to)) return;
		if (to === this.activity) return;
		const from = this.activity;
		this.activity = to;
		this.push("state", "activity", encodeProps({ to, from }));
	}

	setScreen(name: string | undefined) {
		if (name !== undefined && name !== "" && !isEventName(name)) return;
		if (this.screens) {
			this.screens.manual(name);
			return;
		}
		// Automatic screens off: only game code says.
		const to = name ?? "";
		if (to === this.manualScreen) return;
		const from = this.manualScreen;
		this.manualScreen = to;
		this.screenChanged(to, from);
	}

	/** May yield (up to 10 s) until the server sent this player's id. */
	experiment(name: string, variants: string[]): string {
		const control = variants[0] ?? "";
		if (!isExperimentName(name) || !isVariantList(variants)) {
			$warn(`[analytics] experiment("${tostring(name).sub(1, 64)}"): bad name or variants (1-16 distinct names)`);
			return control;
		}
		const deadline = os.clock() + 10;
		while (!this.hello && os.clock() < deadline && !this.stopped) task.wait(0.1);
		const hello = this.hello;
		if (!hello) return control;
		const assignment = assignVariant(hello.pid, name, variants, hello.exps[name]);
		if (!this.experimentsSent.has(name)) {
			this.experimentsSent.add(name);
			this.dispatcher.kernel.send(CHANNEL, "exp", name, variants);
		}
		return assignment.variant;
	}

	flush() {
		this.sendHeld();
	}

	// Collectors -------------------------------------------------------------------------------------------------------

	private screenChanged(to: string, from: string) {
		this.push("state", "screen", encodeProps({ to, from }));
	}

	private startScreens(playerGui: Instance) {
		const screens = new ScreenTracker(
			this.trove.extend(),
			(to, from) => this.screenChanged(to, from),
			(open, name) => this.recorder?.event(open ? EventKindCode.ScreenOpen : EventKindCode.ScreenClose, name),
		);
		this.screens = screens;
		screens.watch(playerGui);
	}

	private startTech() {
		let frames = 0;
		let since = os.clock();
		this.trove.connect(RunService.RenderStepped, () => {
			frames += 1;
		});
		const errors = new Map<string, number>();
		this.trove.add(
			TypeTorch.onLog((entry) => {
				if (entry.kind !== "error" || errors.size() >= 20) return;
				const text = entry.text.sub(1, 300);
				errors.set(text, (errors.get(text) ?? 0) + 1);
			}),
		);
		this.trove.add(
			task.spawn(() => {
				while (true) {
					task.wait(ERRORS_EVERY);
					let reported = 0;
					for (const [text, count] of errors) {
						if (reported >= 5 || this.store.errorsSent >= ERRORS_PER_SESSION) break;
						reported += 1;
						this.store.errorsSent += 1;
						this.push("tech", "error", encodeProps({ msg: scrubNames(text), n: count }));
					}
					errors.clear();
				}
			}),
		);
		this.trove.add(
			task.spawn(() => {
				while (true) {
					task.wait(this.hello?.tech ?? 60);
					const elapsed = math.max(os.clock() - since, 0.001);
					const fps = frames / elapsed;
					frames = 0;
					since = os.clock();
					const [pingOk, ping] = pcall(() => Players.LocalPlayer.GetNetworkPing());
					this.push(
						"tech",
						"client",
						encodeProps({
							fps: math.floor(fps + 0.5),
							mem: math.floor(Stats.GetTotalMemoryUsageMb() / 10 + 0.5) * 10,
							ping: pingOk ? math.floor(ping * 1000) : undefined,
						}),
					);
				}
			}),
		);
	}
}
