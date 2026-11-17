import { GuiService, Players, RunService, UserInputService, Workspace } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import {
	EXT_NONE,
	EXT_STRINGS_SOFT_MAX,
	ExtWriter,
	LookSlot,
	newUiValues,
	packQuat,
	quatOf,
	RigKind,
	UiClass,
	UiField,
	yawByte,
	type UiValues,
} from "./ext-codec";
import { CHUNK_SECONDS, EXT_CHUNK_TARGET_BYTES } from "./protocol";
import { replayAfkFlag, setReplayActive, trackedEntries, watchServerTracks } from "./replay";
import type { DeviceKind, ExtendedSettings } from "./schema";

/**
 * plans/36: the extended recorder (tt-ext-1). Runs next to the tt-rec-1 Recorder in sessions the server picked (the
 * `tt_extended_recording` experiment's "on" arm, recorded, eligible) and ends with it. Streams: View, Afk, Anchor,
 * my Rig / Pose (R6 and R15) and Animator, other players' characters and tracked models (Spawn / Look / Move / Gone and
 * their animations, culled to `entRadius` / `entMax`), and the PlayerGui tree (UiNode / UiProps / UiGone).
 *
 * Cost first: one Heartbeat handler; poses, entities and the View run once a tick (`hz`), animations come from signals
 * (AnimationPlayed, Stopped; only playing tracks are read for AdjustSpeed / AdjustWeight), and the UI tree is polled and
 * diffed in time slices of `uiBudgetMs` per frame (0.6 of it on phones and tablets): one DescendantAdded / Removing pair
 * per ScreenGui for structure and no per-instance Changed connections. Under 30 fps the UI rate halves, under 20 it
 * pauses. Buffers and lists are reused; os.clock() measures every frame's work for the tech row (xb, xms, xmax, xui).
 */

/** Persisted across client swaps (ClientStore.ext). */
export interface ExtClientState {
	started: boolean;
	ended: boolean;
	/** Next chunk index (tt-ext-1's own counter). */
	chunk: number;
	/** Chunk bytes built so far (the client cap). */
	bytes: number;
}

export interface ExtStats {
	/** Chunk bytes built per second over the period. */
	xb: number;
	/** Recorder ms per second. */
	xms: number;
	/** The worst single frame's recorder ms. */
	xmax: number;
	/** Visible UI nodes now. */
	xui: number;
}

/** Chunk bytes a session builds at most (the server's cap is the same). */
export const EXT_CLIENT_MAX_BYTES = 2097152;
const MOVE_KEEPALIVE = 5;
const MOVE_EPSILON = 1 / 8;
/** Cosine of half of ~2 degrees: a joint whose rotation changed less is not re-sent. */
const POSE_DOT = 0.99985;
const AFK_MOVE = 0.5;
const UI_NODES_MAX = 4000;
/** UI fields read only on every SLOW_PASSES-th pass per node (fonts, alignment, slices, strokes, corners, gradients). */
const SLOW_PASSES = 4;
const IGNORED_GUIS = new Set(["Freecam", "BubbleChat", "Chat", "ProximityPrompts", "RbxCameraUI"]);

const R6_JOINTS = ["RootJoint", "Neck", "Left Shoulder", "Right Shoulder", "Left Hip", "Right Hip"];
const R15_JOINTS = [
	"Root",
	"Waist",
	"Neck",
	"LeftShoulder",
	"LeftElbow",
	"LeftWrist",
	"RightShoulder",
	"RightElbow",
	"RightWrist",
	"LeftHip",
	"LeftKnee",
	"LeftAnkle",
	"RightHip",
	"RightKnee",
	"RightAnkle",
];

interface TrackState {
	track: AnimationTrack;
	id: number;
	speedQ: number;
	weightQ: number;
	stopped: RBXScriptConnection;
}

/** Animation logging for one entity (0 = me): its Animator's signals while it is recorded. */
interface AnimState {
	entity: number;
	animator?: Animator;
	played?: RBXScriptConnection;
	moved?: RBXScriptConnection;
	tracks: Map<AnimationTrack, TrackState>;
	list: TrackState[];
	nextTrack: number;
	retryAt: number;
}

interface EntState {
	instance: PVInstance;
	kind: string;
	/** bit 0 has a Humanoid, bit 1 another player's character. */
	flags: number;
	/** 0 = not spawned. */
	id: number;
	x: number;
	y: number;
	z: number;
	yaw: number;
	lastMoveAt: number;
	cx: number;
	cy: number;
	cz: number;
	cyaw: number;
	dist: number;
	seenTick: number;
	selTick: number;
	anim: AnimState;
}

interface UiNodeState {
	instance: GuiBase2d;
	id: number;
	cls: number;
	screen: boolean;
	text: boolean;
	image: boolean;
	parentId: number;
	/** The nearest node above (undefined for a ScreenGui). */
	parentNode?: UiNodeState;
	order: number;
	/** Index of the last descendant in `uiNodes`. */
	last: number;
	zIndex: number;
	sortKey: number;
	stroke?: UIStroke;
	corner?: UICorner;
	gradient?: UIGradient;
	/** Sent (a UiNode) in this segment and not gone since. */
	sent: boolean;
	visibleNow: boolean;
	seen: number;
	v: UiValues;
}

function quant(value: number, scale: number): number {
	return math.floor(value * scale + 0.5);
}

function classOf(instance: Instance): number {
	if (instance.IsA("ScreenGui")) return UiClass.ScreenGui;
	if (instance.IsA("TextLabel")) return UiClass.TextLabel;
	if (instance.IsA("TextButton")) return UiClass.TextButton;
	if (instance.IsA("TextBox")) return UiClass.TextBox;
	if (instance.IsA("ImageLabel")) return UiClass.ImageLabel;
	if (instance.IsA("ImageButton")) return UiClass.ImageButton;
	if (instance.IsA("ScrollingFrame")) return UiClass.ScrollingFrame;
	if (instance.IsA("ViewportFrame")) return UiClass.ViewportFrame;
	if (instance.IsA("CanvasGroup")) return UiClass.CanvasGroup;
	if (instance.IsA("VideoFrame")) return UiClass.VideoFrame;
	return UiClass.Frame;
}

function xAlignOf(alignment: Enum.TextXAlignment): number {
	if (alignment === Enum.TextXAlignment.Left) return 0;
	if (alignment === Enum.TextXAlignment.Right) return 2;
	return 1;
}

function yAlignOf(alignment: Enum.TextYAlignment): number {
	if (alignment === Enum.TextYAlignment.Top) return 0;
	if (alignment === Enum.TextYAlignment.Bottom) return 2;
	return 1;
}

export class ExtRecorder {
	private readonly trove: Trove;
	private readonly writer = new ExtWriter();
	private chunkStart = os.clock();
	private done = false;
	/** The first Keyframe was written (an AFK start never starts the streams). */
	private begun = false;
	private paused = false;
	private keyframeAt = 0;
	private lastActive = os.clock();
	/** The player's last key / click / tap / gamepad button / stick input (motion doesn't count). */
	private lastInput = -math.huge;
	/** The game's AFK flag at the last tick, and when it last turned on. */
	private flagWas = false;
	private flagAt = 0;
	private rootX = 0;
	private rootY = 0;
	private rootZ = 0;
	private readonly tickEvery: number;
	private tickAccumulated = 0;
	private tick = 0;
	private readonly budget: number;

	// Counters (tech row).
	private statBytes = 0;
	private statMs = 0;
	private statMax = 0;
	private statSince = os.clock();
	private frames = 0;
	private fpsSince = os.clock();
	private fps = 60;

	// View.
	private viewW = -1;
	private viewH = -1;
	private viewInset = -1;
	private viewFov = -1;
	private viewAt = 0;

	// Me: Rig / Pose (entity 0) and my Animator.
	private character?: Model;
	private characterTrove?: Trove;
	private rigKind = RigKind.None;
	private readonly joints = new Array<Motor6D>();
	private readonly jointNames = new Array<string>();
	private readonly jointQ = new Array<number>();
	private readonly posePacked = new Array<number>();
	private rigDirty = false;
	private rigSent = false;
	private readonly myAnim: AnimState = { entity: 0, tracks: new Map(), list: [], nextTrack: 0, retryAt: 0 };

	// Entities.
	private readonly entities = new Map<Instance, EntState>();
	private readonly candidates = new Array<EntState>();
	private readonly spawned = new Array<EntState>();
	private readonly moving = new Array<EntState>();
	private readonly freeIds = new Array<number>();
	private readonly byDistance = (a: EntState, b: EntState) => a.dist < b.dist;
	private readonly lookColors = new Array<number>();
	private readonly lookSlots = new Array<number>();
	private readonly lookTexts = new Array<string>();

	// UI.
	private playerGui?: Instance;
	private readonly uiMap = new Map<Instance, UiNodeState>();
	private readonly uiNodes = new Array<UiNodeState>();
	private readonly uiFreeIds = new Array<number>();
	private uiNextId = 0;
	private uiDirty = true;
	private uiStamp = 0;
	private uiCursor = 0;
	private uiPassActive = false;
	private uiPasses = 0;
	private uiNextPassAt = 0;
	private uiVisible = 0;
	private uiVisibleCounting = 0;
	private uiOrder = 0;
	private readonly uiScreenTroves = new Map<Instance, Trove>();

	constructor(
		parent: Trove,
		private readonly state: ExtClientState,
		private readonly dials: ExtendedSettings,
		device: DeviceKind,
		private readonly send: (chunk: number, age: number, n: number, data: buffer, last: boolean, why: string) => void,
	) {
		this.trove = parent.extend();
		this.tickEvery = 1 / math.clamp(dials.hz, 1, 10);
		this.budget = (dials.uiBudgetMs * (device === "phone" || device === "tablet" ? 0.6 : 1)) / 1000;
		for (let id = 255; id >= 1; id--) this.freeIds.push(id);
		state.started = true;
		this.trove.add(() => setReplayActive(false));
	}

	private at(): number {
		return (os.clock() - this.chunkStart) * 1000;
	}

	private writing(): boolean {
		return this.begun && !this.paused && !this.done;
	}

	// Lifecycle --------------------------------------------------------------------------------------------------------

	start(playerGui: Instance | undefined) {
		const trove = this.trove;
		const player = Players.LocalPlayer;
		if (this.dials.streams.ent) watchServerTracks(trove.extend());
		trove.connect(UserInputService.InputBegan, () => {
			this.lastActive = os.clock();
			this.lastInput = this.lastActive;
		});
		trove.connect(UserInputService.InputChanged, (input) => {
			const code = input.KeyCode;
			if ((code === Enum.KeyCode.Thumbstick1 || code === Enum.KeyCode.Thumbstick2) && input.Position.Magnitude > 0.25) {
				this.lastActive = os.clock();
				this.lastInput = this.lastActive;
			}
		});
		trove.connect(player.CharacterAdded, (character) => this.watchCharacter(character));
		if (player.Character) this.watchCharacter(player.Character);
		if (playerGui && this.dials.streams.ui) this.watchGui(playerGui);
		trove.connect(RunService.Heartbeat, (dt) => this.frame(dt));
	}

	/** Sends the current chunk (when it has records, or it's the last) and starts the next. */
	rotate(last: boolean, why: string) {
		if (this.done) return;
		if (this.writer.records === 0 && !last) {
			this.chunkStart = os.clock();
			return;
		}
		const records = this.writer.records;
		const age = math.floor(this.at());
		const data = this.writer.take(last);
		const size = buffer.len(data);
		this.statBytes += size;
		this.state.bytes += size;
		this.chunkStart = os.clock();
		if (this.dials.dryRun) return;
		this.send(this.state.chunk, age, records, data, last, why);
		this.state.chunk += 1;
	}

	finish(why: string) {
		if (this.done) return;
		this.rotate(true, why);
		this.done = true;
		this.state.ended = true;
		setReplayActive(false);
		this.trove.destroy();
	}

	/** A hot swap: entities end here (the next generation starts with a Keyframe) and the chunk goes now. */
	swapOut() {
		if (this.done) return;
		if (this.writing()) {
			const at = this.at();
			for (const ent of this.spawned) this.writer.gone(at, ent.id);
		}
		this.rotate(false, "swap");
	}

	/** Counters since the last call (the client tech row); undefined once it ended and the period after is empty. */
	takeStats(): ExtStats | undefined {
		if (this.done && this.statBytes === 0 && this.statMs === 0) return undefined;
		const now = os.clock();
		const elapsed = math.max(now - this.statSince, 0.001);
		const stats: ExtStats = {
			xb: math.floor(this.statBytes / elapsed + 0.5),
			xms: math.floor((this.statMs * 1000 * 100) / elapsed + 0.5) / 100,
			xmax: math.floor(this.statMax * 1000 * 100 + 0.5) / 100,
			xui: this.uiVisible,
		};
		this.statBytes = 0;
		this.statMs = 0;
		this.statMax = 0;
		this.statSince = now;
		return stats;
	}

	// The frame --------------------------------------------------------------------------------------------------------

	private frame(dt: number) {
		if (this.done) return;
		const started = os.clock();
		debug.profilebegin("TT.ext");
		this.frames += 1;
		if (started - this.fpsSince >= 1) {
			this.fps = this.frames / (started - this.fpsSince);
			this.frames = 0;
			this.fpsSince = started;
		}
		this.tickAccumulated += dt;
		if (this.tickAccumulated >= this.tickEvery) {
			this.tickAccumulated = 0;
			this.onTick(started);
		}
		if (this.writing() && this.dials.streams.ui) {
			debug.profilebegin("TT.ext.ui");
			this.uiFrame(started);
			debug.profileend();
		}
		if (this.writer.size() >= EXT_CHUNK_TARGET_BYTES || (started - this.chunkStart >= CHUNK_SECONDS && this.writer.records > 0)) this.rotate(false, "");
		else if (started - this.chunkStart >= CHUNK_SECONDS) this.chunkStart = started;
		if (this.state.bytes >= EXT_CLIENT_MAX_BYTES) this.finish("cap");
		debug.profileend();
		const cost = os.clock() - started;
		this.statMs += cost;
		if (cost > this.statMax) this.statMax = cost;
	}

	private onTick(now: number) {
		const camera = Workspace.CurrentCamera;
		this.tick += 1;
		this.checkAfk(now);
		if (!this.writing()) return;
		if (now - this.keyframeAt >= this.dials.uiKeyframeSeconds || this.writer.segmentStrings() >= EXT_STRINGS_SOFT_MAX) {
			this.keyframe(now);
			return;
		}
		if (this.dials.streams.view) this.viewTick(now, false);
		if (this.dials.streams.pose) {
			debug.profilebegin("TT.ext.pose");
			this.poseTick(false);
			this.adjustTick(this.myAnim);
			debug.profileend();
		}
		if (this.dials.streams.ent && camera) {
			debug.profilebegin("TT.ext.ent");
			this.entityTick(camera, now);
			debug.profileend();
		}
	}

	/**
	 * AFK: no input for afkSeconds and the character not moving, or the game's flag from when it turned on until the
	 * player's next input. The flag pauses, input resumes (plans/36), so a toggle the player left on while they play
	 * (gnome's AFK button, pressed by a console's first gamepad A) doesn't end the recording; setting it again pauses again.
	 */
	private checkAfk(now: number) {
		const root = this.character?.FindFirstChild("HumanoidRootPart");
		if (root && root.IsA("BasePart")) {
			const position = root.CFrame;
			const dx = position.X - this.rootX;
			const dy = position.Y - this.rootY;
			const dz = position.Z - this.rootZ;
			if (dx * dx + dy * dy + dz * dz > AFK_MOVE * AFK_MOVE) {
				this.rootX = position.X;
				this.rootY = position.Y;
				this.rootZ = position.Z;
				this.lastActive = now;
			}
		}
		const flag = replayAfkFlag();
		if (flag && !this.flagWas) this.flagAt = now;
		this.flagWas = flag;
		const afk = (flag && this.lastInput <= this.flagAt) || now - this.lastActive >= this.dials.afkSeconds;
		if (!this.begun) {
			if (afk) return;
			this.begun = true;
			this.keyframe(now);
			setReplayActive(true);
			return;
		}
		if (afk === this.paused) return;
		this.paused = afk;
		this.writer.afk(this.at(), afk);
		setReplayActive(!afk);
		// Back from AFK: a Keyframe (what changed meanwhile is all re-sent).
		if (!afk) this.keyframe(now);
	}

	/** A new segment: the full state (View, Anchor, Rig + Pose, entities with their looks and playing animations, UI). */
	private keyframe(now: number) {
		const writer = this.writer;
		this.keyframeAt = now;
		// A Keyframe starts its chunk (header flag bit 1), so a reader can start at that chunk.
		this.rotate(false, "");
		writer.keyframe(this.at());
		const camera = Workspace.CurrentCamera;
		if (camera) {
			const view = camera.CFrame;
			writer.anchor(this.at(), math.floor(view.X), math.floor(view.Y), math.floor(view.Z));
		}
		if (this.dials.streams.view) this.viewTick(now, true);
		if (this.dials.streams.pose) {
			this.rigSent = false;
			this.poseTick(true);
			this.replayAnims(this.myAnim);
		}
		if (this.dials.streams.ent) {
			for (const ent of this.spawned) {
				this.writeSpawn(ent);
				this.replayAnims(ent.anim);
			}
		}
		if (this.dials.streams.ui) {
			for (const node of this.uiNodes) node.sent = false;
			this.uiCursor = 0;
			this.uiPassActive = true;
			this.uiVisibleCounting = 0;
		}
	}

	// View -------------------------------------------------------------------------------------------------------------

	private viewTick(now: number, force: boolean) {
		const camera = Workspace.CurrentCamera;
		if (!camera) return;
		const size = camera.ViewportSize;
		const w = math.floor(size.X + 0.5);
		const h = math.floor(size.Y + 0.5);
		const [inset] = GuiService.GetGuiInset();
		const top = math.floor(inset.Y + 0.5);
		const fov = math.floor(camera.FieldOfView + 0.5);
		if (!force && w === this.viewW && h === this.viewH && top === this.viewInset && fov === this.viewFov && now - this.viewAt < 1) return;
		this.viewW = w;
		this.viewH = h;
		this.viewInset = top;
		this.viewFov = fov;
		this.viewAt = now;
		this.writer.view(this.at(), w, h, top, fov, math.min(255, math.floor(this.fps + 0.5)));
	}

	// Me: Rig, Pose, Animator ------------------------------------------------------------------------------------------

	private watchCharacter(character: Model) {
		if (this.characterTrove) this.trove.remove(this.characterTrove);
		const characterTrove = this.trove.extend();
		this.characterTrove = characterTrove;
		this.character = character;
		this.rigDirty = true;
		this.stopAnims(this.myAnim);
		characterTrove.add(() => this.stopAnims(this.myAnim));
		if (!this.dials.streams.pose) return;
		const motorChanged = (descendant: Instance) => {
			if (descendant.IsA("Motor6D")) this.rigDirty = true;
		};
		characterTrove.connect(character.DescendantAdded, motorChanged);
		characterTrove.connect(character.DescendantRemoving, motorChanged);
		characterTrove.connect(character.AncestryChanged, () => {
			if (!character.Parent && this.character === character) {
				this.character = undefined;
				this.rigDirty = true;
			}
		});
	}

	/**
	 * Re-reads the Motor6Ds: the standard R6 / R15 names first (in their order), then the rest (a weapon's joint; at most
	 * 32 in all). The Humanoid's RigType says R6 or R15; no Humanoid is "other".
	 */
	private scanRig() {
		this.rigDirty = false;
		this.rigSent = false;
		this.joints.clear();
		this.jointNames.clear();
		this.jointQ.clear();
		const character = this.character;
		this.rigKind = RigKind.None;
		if (!character) return;
		const humanoid = character.FindFirstChildOfClass("Humanoid");
		let standard: string[] | undefined;
		if (humanoid) {
			if (humanoid.RigType === Enum.HumanoidRigType.R6) {
				this.rigKind = RigKind.R6;
				standard = R6_JOINTS;
			} else {
				this.rigKind = RigKind.R15;
				standard = R15_JOINTS;
			}
		}
		const motors = new Array<Motor6D>();
		for (const descendant of character.GetDescendants()) if (descendant.IsA("Motor6D")) motors.push(descendant);
		if (motors.size() === 0) {
			this.rigKind = RigKind.None;
			return;
		}
		const used = new Set<Motor6D>();
		if (standard) {
			for (const name of standard) {
				for (const motor of motors) {
					if (motor.Name === name && !used.has(motor)) {
						used.add(motor);
						this.joints.push(motor);
						break;
					}
				}
			}
		} else this.rigKind = RigKind.Other;
		for (const motor of motors) {
			if (this.joints.size() >= 32) break;
			if (used.has(motor)) continue;
			this.joints.push(motor);
		}
		for (const motor of this.joints) {
			this.jointNames.push(motor.Name);
			this.jointQ.push(0, 0, 0, 0);
		}
	}

	private poseTick(force: boolean) {
		if (this.rigDirty) this.scanRig();
		const writer = this.writer;
		const at = this.at();
		if (!this.rigSent) {
			writer.rig(at, 0, this.rigKind, this.jointNames, this.jointNames.size());
			this.rigSent = true;
			force = true;
		}
		const count = this.joints.size();
		if (count === 0) return;
		let mask = 0;
		let changed = 0;
		const q = this.jointQ;
		const packed = this.posePacked;
		for (let index = 0; index < count; index++) {
			const motor = this.joints[index];
			if (!motor.Parent) {
				this.rigDirty = true;
				continue;
			}
			const [, , , r00, r01, r02, r10, r11, r12, r20, r21, r22] = motor.Transform.GetComponents();
			const [x, y, z, w] = quatOf(r00, r01, r02, r10, r11, r12, r20, r21, r22);
			const base = index * 4;
			const dot = math.abs(x * q[base] + y * q[base + 1] + z * q[base + 2] + w * q[base + 3]);
			if (!force && dot >= POSE_DOT) continue;
			q[base] = x;
			q[base + 1] = y;
			q[base + 2] = z;
			q[base + 3] = w;
			mask += 2 ** index;
			packed[changed] = packQuat(x, y, z, w);
			changed += 1;
		}
		if (changed > 0) writer.pose(at, 0, mask, packed, changed);
		if (this.dials.streams.pose && this.character) this.ensureAnimator(this.myAnim, this.character);
	}

	// Animations -------------------------------------------------------------------------------------------------------

	/** Finds the model's Animator (Humanoid or AnimationController) and follows its tracks; re-found if the rig changes. */
	private ensureAnimator(anim: AnimState, model: Instance) {
		if (anim.animator && anim.animator.IsDescendantOf(model)) return;
		const now = os.clock();
		if (anim.animator === undefined && now < anim.retryAt) return;
		anim.retryAt = now + 1;
		this.stopAnims(anim);
		const animator = model.FindFirstChildWhichIsA("Animator", true);
		if (!animator) return;
		anim.animator = animator;
		anim.played = animator.AnimationPlayed.Connect((track) => this.onPlayed(anim, track));
		for (const track of animator.GetPlayingAnimationTracks()) this.onPlayed(anim, track);
	}

	private onPlayed(anim: AnimState, track: AnimationTrack) {
		if (this.done || anim.tracks.has(track)) return;
		const id = anim.nextTrack;
		anim.nextTrack = (anim.nextTrack + 1) % 65536;
		const entry: TrackState = {
			track,
			id,
			speedQ: quant(track.Speed, 100),
			weightQ: quant(math.clamp(track.WeightTarget, 0, 1), 255),
			stopped: track.Stopped.Connect(() => {
				if (anim.tracks.get(track) !== entry) return;
				entry.stopped.Disconnect();
				anim.tracks.delete(track);
				const index = anim.list.indexOf(entry);
				if (index >= 0) anim.list.unorderedRemove(index);
				if (this.writing() && this.animRecorded(anim)) this.writer.animStop(this.at(), anim.entity, entry.id);
			}),
		};
		anim.tracks.set(track, entry);
		anim.list.push(entry);
		if (this.writing() && this.animRecorded(anim)) this.writePlay(anim, entry);
	}

	/** Entity 0 always (with the pose stream); others while they are spawned. */
	private animRecorded(anim: AnimState): boolean {
		return anim.entity === 0 ? this.dials.streams.pose : anim.entity > 0;
	}

	private writePlay(anim: AnimState, entry: TrackState) {
		const track = entry.track;
		const animation = track.Animation;
		this.writer.animPlay(
			this.at(),
			anim.entity,
			entry.id,
			animation ? animation.AnimationId : "",
			track.Speed,
			track.WeightTarget,
			track.Looped,
			math.min(track.TimePosition, 655),
		);
	}

	/** At a Keyframe or a spawn: an AnimPlay for every track still playing. */
	private replayAnims(anim: AnimState) {
		for (const entry of anim.list) {
			if (entry.track.IsPlaying) this.writePlay(anim, entry);
		}
	}

	/** AdjustSpeed / AdjustWeight: one read each per playing track per tick. */
	private adjustTick(anim: AnimState) {
		for (const entry of anim.list) {
			const track = entry.track;
			const speedQ = quant(track.Speed, 100);
			const weightQ = quant(math.clamp(track.WeightTarget, 0, 1), 255);
			if (speedQ === entry.speedQ && weightQ === entry.weightQ) continue;
			entry.speedQ = speedQ;
			entry.weightQ = weightQ;
			this.writer.animAdjust(this.at(), anim.entity, entry.id, track.Speed, track.WeightTarget);
		}
	}

	private stopAnims(anim: AnimState) {
		anim.played?.Disconnect();
		anim.played = undefined;
		anim.animator = undefined;
		for (const entry of anim.list) entry.stopped.Disconnect();
		anim.list.clear();
		anim.tracks.clear();
	}

	// Entities ---------------------------------------------------------------------------------------------------------

	private entityOf(instance: PVInstance, kind: string, flags: number): EntState {
		let ent = this.entities.get(instance);
		if (!ent) {
			ent = {
				instance,
				kind,
				flags,
				id: 0,
				x: 0,
				y: 0,
				z: 0,
				yaw: 0,
				lastMoveAt: 0,
				cx: 0,
				cy: 0,
				cz: 0,
				cyaw: 0,
				dist: 0,
				seenTick: 0,
				selTick: 0,
				anim: { entity: -1, tracks: new Map(), list: [], nextTrack: 0, retryAt: 0 },
			};
			this.entities.set(instance, ent);
		}
		ent.kind = kind;
		return ent;
	}

	/** Reads the pivot; a candidate when within entRadius of the camera. */
	private consider(ent: EntState, camX: number, camY: number, camZ: number, radius2: number) {
		ent.seenTick = this.tick;
		const instance = ent.instance;
		if (!instance.IsDescendantOf(Workspace)) return;
		const [x, y, z, , , r02, , , , , , r22] = instance.GetPivot().GetComponents();
		const dx = x - camX;
		const dy = y - camY;
		const dz = z - camZ;
		const dist = dx * dx + dy * dy + dz * dz;
		if (dist > radius2) return;
		ent.cx = x;
		ent.cy = y;
		ent.cz = z;
		ent.cyaw = math.atan2(r02, r22);
		ent.dist = dist;
		this.candidates.push(ent);
	}

	private entityTick(camera: Camera, now: number) {
		const [camX, camY, camZ] = camera.CFrame.GetComponents();
		const radius2 = this.dials.entRadius * this.dials.entRadius;
		const candidates = this.candidates;
		candidates.clear();
		const me = this.character;
		for (const player of Players.GetPlayers()) {
			if (player === Players.LocalPlayer) continue;
			const character = player.Character;
			if (!character) continue;
			this.consider(this.entityOf(character, "player", 2), camX, camY, camZ, radius2);
		}
		for (const entry of trackedEntries) {
			if (entry.instance === me) continue;
			const ent = this.entityOf(entry.instance, entry.kind, 0);
			if (ent.seenTick === this.tick) continue;
			this.consider(ent, camX, camY, camZ, radius2);
		}
		const entMax = this.dials.entMax;
		if (candidates.size() > entMax) candidates.sort(this.byDistance);
		const selected = math.min(candidates.size(), entMax);
		const writer = this.writer;
		// Gone first (frees ids), then spawns and moves.
		for (let index = 0; index < selected; index++) candidates[index].selTick = this.tick;
		for (let index = this.spawned.size() - 1; index >= 0; index--) {
			const ent = this.spawned[index];
			if (ent.selTick === this.tick) continue;
			writer.gone(this.at(), ent.id);
			this.despawn(ent);
			this.spawned.unorderedRemove(index);
		}
		const moving = this.moving;
		moving.clear();
		let fits = true;
		for (let index = 0; index < selected; index++) {
			const ent = candidates[index];
			if (ent.id === 0) {
				const id = this.freeIds.pop();
				if (id === undefined) continue;
				ent.id = id;
				ent.anim.entity = id;
				ent.x = ent.cx;
				ent.y = ent.cy;
				ent.z = ent.cz;
				ent.yaw = ent.cyaw;
				ent.lastMoveAt = now;
				this.spawned.push(ent);
				this.writeSpawn(ent);
				this.ensureAnimator(ent.anim, ent.instance);
				continue;
			}
			const dx = math.abs(ent.cx - ent.x);
			const dy = math.abs(ent.cy - ent.y);
			const dz = math.abs(ent.cz - ent.z);
			if (dx < MOVE_EPSILON && dy < MOVE_EPSILON && dz < MOVE_EPSILON && yawByte(ent.cyaw) === yawByte(ent.yaw) && now - ent.lastMoveAt < MOVE_KEEPALIVE) {
				continue;
			}
			moving.push(ent);
			if (!writer.fits(ent.cx, ent.cy, ent.cz)) fits = false;
		}
		if (moving.size() > 0) {
			if (!fits) writer.anchor(this.at(), math.floor(camX), math.floor(camY), math.floor(camZ));
			const count = math.min(moving.size(), 255);
			writer.moveBegin(this.at(), count);
			for (let index = 0; index < count; index++) {
				const ent = moving[index];
				writer.moveEntry(ent.id, ent.cx, ent.cy, ent.cz, ent.cyaw);
				ent.x = ent.cx;
				ent.y = ent.cy;
				ent.z = ent.cz;
				ent.yaw = ent.cyaw;
				ent.lastMoveAt = now;
			}
		}
		for (const ent of this.spawned) {
			this.ensureAnimator(ent.anim, ent.instance);
			this.adjustTick(ent.anim);
		}
		// Forget entities no longer tracked (every ~10 s).
		if (this.tick % 32 === 0) {
			for (const [instance, ent] of this.entities) {
				if (ent.id === 0 && this.tick - ent.seenTick > 8) this.entities.delete(instance);
			}
		}
	}

	private despawn(ent: EntState) {
		this.freeIds.push(ent.id);
		ent.id = 0;
		ent.anim.entity = -1;
		this.stopAnims(ent.anim);
	}

	/** Spawn, and for a tracked model with a Humanoid its Look (clothing and body colours). */
	private writeSpawn(ent: EntState) {
		const instance = ent.instance;
		const writer = this.writer;
		const at = this.at();
		let flags = ent.flags;
		const humanoid = instance.FindFirstChildOfClass("Humanoid");
		if (humanoid) flags = flags | 1;
		let sx = 0;
		let sy = 0;
		let sz = 0;
		if (instance.IsA("Model")) {
			const size = instance.GetExtentsSize();
			sx = size.X;
			sy = size.Y;
			sz = size.Z;
		} else if (instance.IsA("BasePart")) {
			const size = instance.Size;
			sx = size.X;
			sy = size.Y;
			sz = size.Z;
		}
		writer.spawn(at, ent.id, ent.kind, flags, ent.x, ent.y, ent.z, ent.yaw, sx, sy, sz);
		// Other players stay the default avatar (owner): no look.
		if (!humanoid || (ent.flags & 2) !== 0) return;
		const slots = this.lookSlots;
		const texts = this.lookTexts;
		let count = 0;
		const shirt = instance.FindFirstChildOfClass("Shirt");
		if (shirt && shirt.ShirtTemplate !== "") {
			slots[count] = LookSlot.Shirt;
			texts[count] = shirt.ShirtTemplate;
			count += 1;
		}
		const pants = instance.FindFirstChildOfClass("Pants");
		if (pants && pants.PantsTemplate !== "") {
			slots[count] = LookSlot.Pants;
			texts[count] = pants.PantsTemplate;
			count += 1;
		}
		const graphic = instance.FindFirstChildOfClass("ShirtGraphic");
		if (graphic && graphic.Graphic !== "") {
			slots[count] = LookSlot.ShirtGraphic;
			texts[count] = graphic.Graphic;
			count += 1;
		}
		const face = instance.FindFirstChild("Head")?.FindFirstChild("face");
		if (face && face.IsA("Decal") && face.Texture !== "") {
			slots[count] = LookSlot.Face;
			texts[count] = face.Texture;
			count += 1;
		}
		const body = instance.FindFirstChildOfClass("BodyColors");
		let colors: number[] | undefined;
		if (body) {
			colors = this.lookColors;
			const list = [body.HeadColor3, body.TorsoColor3, body.LeftArmColor3, body.RightArmColor3, body.LeftLegColor3, body.RightLegColor3];
			for (let index = 0; index < 6; index++) {
				colors[index * 3] = quant(list[index].R, 255);
				colors[index * 3 + 1] = quant(list[index].G, 255);
				colors[index * 3 + 2] = quant(list[index].B, 255);
			}
		}
		if (count > 0 || colors) writer.look(at, ent.id, colors, slots, texts, count);
	}

	// UI ---------------------------------------------------------------------------------------------------------------

	private watchGui(playerGui: Instance) {
		this.playerGui = playerGui;
		const markDirty = () => {
			this.uiDirty = true;
		};
		const watchScreen = (gui: Instance) => {
			if (!gui.IsA("ScreenGui") || this.uiScreenTroves.has(gui)) return;
			const screenTrove = this.trove.extend();
			this.uiScreenTroves.set(gui, screenTrove);
			// Structure only: one pair per ScreenGui; properties are polled.
			screenTrove.connect(gui.DescendantAdded, markDirty);
			screenTrove.connect(gui.DescendantRemoving, markDirty);
			this.uiDirty = true;
		};
		this.trove.connect(playerGui.ChildAdded, watchScreen);
		this.trove.connect(playerGui.ChildRemoved, (gui) => {
			const screenTrove = this.uiScreenTroves.get(gui);
			if (screenTrove) {
				this.uiScreenTroves.delete(gui);
				this.trove.remove(screenTrove);
			}
			this.uiDirty = true;
		});
		for (const child of playerGui.GetChildren()) watchScreen(child);
	}

	private skippedScreen(gui: Instance): boolean {
		const name = gui.Name;
		return IGNORED_GUIS.has(name) || name.sub(1, 9) === "TypeTorch";
	}

	private nodeFor(instance: GuiBase2d): UiNodeState | undefined {
		let node = this.uiMap.get(instance);
		if (node) return node;
		if (this.uiMap.size() >= UI_NODES_MAX) return undefined;
		const id = this.uiFreeIds.pop() ?? this.uiNextId;
		if (id >= EXT_NONE) return undefined;
		if (id === this.uiNextId) this.uiNextId += 1;
		const cls = classOf(instance);
		node = {
			instance,
			id,
			cls,
			screen: cls === UiClass.ScreenGui,
			text: cls === UiClass.TextLabel || cls === UiClass.TextButton || cls === UiClass.TextBox,
			image: cls === UiClass.ImageLabel || cls === UiClass.ImageButton,
			parentId: EXT_NONE,
			order: 0,
			last: 0,
			zIndex: 0,
			sortKey: 0,
			sent: false,
			visibleNow: false,
			seen: 0,
			v: newUiValues(),
		};
		this.uiMap.set(instance, node);
		return node;
	}

	/** Depth-first: GuiObject children in draw order (ZIndex, then child order) under `parent`. */
	private visit(instance: Instance, parent: UiNodeState, global: boolean) {
		const guis = new Array<UiNodeState>();
		const children = instance.GetChildren();
		for (let index = 0; index < children.size(); index++) {
			const child = children[index];
			if (child.IsA("GuiObject")) {
				const node = this.nodeFor(child);
				if (!node) continue;
				node.zIndex = child.ZIndex;
				node.sortKey = node.zIndex * 65536 + index;
				guis.push(node);
			} else if (child.IsA("UIStroke")) parent.stroke = child;
			else if (child.IsA("UICorner")) parent.corner = child;
			else if (child.IsA("UIGradient")) parent.gradient = child;
			else if (child.IsA("Folder") || child.IsA("Configuration")) this.visit(child, parent, global);
		}
		if (!global) guis.sort((a, b) => a.sortKey < b.sortKey);
		for (const node of guis) {
			node.seen = this.uiStamp;
			node.parentId = parent.id;
			node.parentNode = parent;
			node.stroke = undefined;
			node.corner = undefined;
			node.gradient = undefined;
			this.uiNodes.push(node);
			if (!global) {
				node.order = this.uiOrder;
				this.uiOrder += 1;
			}
			this.visit(node.instance, node, global);
			node.last = this.uiNodes.size() - 1;
		}
	}

	/** Rebuilds the node list after structure changes; nodes that left get a UiGone. */
	private rebuild() {
		this.uiDirty = false;
		this.uiStamp += 1;
		this.uiNodes.clear();
		this.uiOrder = 0;
		const playerGui = this.playerGui;
		if (playerGui) {
			const screens = new Array<ScreenGui>();
			for (const child of playerGui.GetChildren()) if (child.IsA("ScreenGui") && !this.skippedScreen(child)) screens.push(child);
			screens.sort((a, b) => a.DisplayOrder < b.DisplayOrder);
			for (const gui of screens) {
				const node = this.nodeFor(gui);
				if (!node) continue;
				node.seen = this.uiStamp;
				node.parentId = EXT_NONE;
				node.parentNode = undefined;
				node.order = this.uiOrder;
				node.zIndex = gui.DisplayOrder;
				this.uiOrder += 1;
				const first = this.uiNodes.size();
				this.uiNodes.push(node);
				const global = gui.ZIndexBehavior === Enum.ZIndexBehavior.Global;
				this.visit(gui, node, global);
				node.last = this.uiNodes.size() - 1;
				if (global) {
					// Global: every GuiObject of this ScreenGui by ZIndex, then tree order.
					const ranked = new Array<UiNodeState>();
					for (let index = first + 1; index <= node.last; index++) {
						const item = this.uiNodes[index];
						item.sortKey = item.zIndex * 65536 + index;
						ranked.push(item);
					}
					ranked.sort((a, b) => a.sortKey < b.sortKey);
					for (const item of ranked) {
						item.order = this.uiOrder;
						this.uiOrder += 1;
					}
				}
			}
		}
		const at = this.at();
		for (const [instance, node] of this.uiMap) {
			if (node.seen === this.uiStamp) continue;
			if (node.sent && this.writing()) this.writer.uiGone(at, node.id);
			this.uiMap.delete(instance);
			this.uiFreeIds.push(node.id);
		}
	}

	private uiFrame(now: number) {
		if (!this.uiPassActive) {
			// Fps safety: under 30 the rate halves, under 20 the UI pauses.
			if (this.fps < 20 || now < this.uiNextPassAt) return;
			this.uiNextPassAt = now + this.tickEvery * (this.fps < 30 ? 2 : 1);
			if (this.uiDirty) this.rebuild();
			this.uiPassActive = true;
			this.uiCursor = 0;
			this.uiPasses += 1;
			this.uiVisibleCounting = 0;
		}
		const deadline = os.clock() + this.budget;
		const nodes = this.uiNodes;
		const writer = this.writer;
		while (this.uiCursor < nodes.size()) {
			const node = nodes[this.uiCursor];
			const instance = node.instance;
			let visible = false;
			if (instance.Parent !== undefined) {
				if (node.screen) visible = (instance as ScreenGui).Enabled;
				else {
					// The parent comes earlier in the list (depth-first), so its visibleNow is this pass's.
					const parent = node.parentNode;
					visible = parent !== undefined && parent.visibleNow && (instance as GuiObject).Visible;
				}
			}
			node.visibleNow = visible;
			if (!visible) {
				// Hidden: it and every descendant sent go; the subtree is skipped.
				if (node.sent) {
					writer.uiGone(this.at(), node.id);
					node.sent = false;
				}
				for (let index = this.uiCursor + 1; index <= node.last; index++) {
					const child = nodes[index];
					child.visibleNow = false;
					if (child.sent) {
						writer.uiGone(this.at(), child.id);
						child.sent = false;
					}
				}
				this.uiCursor = math.max(node.last, this.uiCursor) + 1;
			} else {
				this.uiVisibleCounting += 1;
				const slow = !node.sent || (this.uiPasses + node.id) % SLOW_PASSES === 0;
				let mask = this.readFast(node);
				if (slow) mask = mask | this.readSlow(node);
				if (!node.sent) {
					node.sent = true;
					node.v.parent = node.parentId;
					if (!node.screen) node.v.order = node.order;
					writer.uiNode(this.at(), node.id, node.parentId, node.cls, this.nodeMask(node), node.v);
				} else {
					if (node.v.order !== node.order) {
						node.v.order = node.order;
						mask = mask | UiField.Order;
					}
					if (node.v.parent !== node.parentId) {
						node.v.parent = node.parentId;
						mask = mask | UiField.Parent;
					}
					if (mask !== 0) writer.uiProps(this.at(), node.id, mask, node.v);
				}
				this.uiCursor += 1;
			}
			// The rest next frame (the chunk is cut at the frame's end when it is full).
			if (os.clock() >= deadline || writer.size() >= EXT_CHUNK_TARGET_BYTES) return;
		}
		this.uiPassActive = false;
		this.uiVisible = this.uiVisibleCounting;
	}

	/** The fields a UiNode carries: those of its class; rotation, clip, stroke, corner, gradient, slices only when set. */
	private nodeMask(node: UiNodeState): number {
		const v = node.v;
		if (node.screen) return UiField.Rect | UiField.Order;
		let mask = UiField.Rect | UiField.Order | UiField.Background;
		if (v.rot !== 0) mask = mask | UiField.Rotation;
		if (node.text) mask = mask | UiField.Text | UiField.TextStyle;
		if (node.image) {
			mask = mask | UiField.Image | UiField.ImageStyle;
			if (v.ioX + v.ioY + v.isX + v.isY + v.sx0 + v.sy0 + v.sx1 + v.sy1 !== 0) mask = mask | UiField.ImageRect;
		}
		if (v.kW !== 0) mask = mask | UiField.Stroke;
		if (v.corner !== 0) mask = mask | UiField.Corner;
		if (v.clip !== 0) mask = mask | UiField.Clip;
		if (v.gradN !== 0) mask = mask | UiField.Gradient;
		return mask;
	}

	/** Every pass: rect, rotation, background, text and its colour / size, image and its colour. Returns changed bits. */
	private readFast(node: UiNodeState): number {
		const v = node.v;
		let mask = 0;
		const instance = node.instance;
		const position = instance.AbsolutePosition;
		const size = instance.AbsoluteSize;
		const x = math.floor(position.X + 0.5);
		const y = math.floor(position.Y + 0.5);
		const w = math.floor(size.X + 0.5);
		const h = math.floor(size.Y + 0.5);
		if (x !== v.x || y !== v.y || w !== v.w || h !== v.h) {
			v.x = x;
			v.y = y;
			v.w = w;
			v.h = h;
			mask = UiField.Rect;
		}
		if (node.screen) {
			const order = math.clamp((instance as ScreenGui).DisplayOrder, 0, 65535);
			if (order !== v.order) {
				v.order = order;
				mask = mask | UiField.Order;
			}
			node.order = order;
			return mask;
		}
		const gui = instance as GuiObject;
		const rot = quant(gui.AbsoluteRotation, 10);
		if (rot !== v.rot) {
			v.rot = rot;
			mask = mask | UiField.Rotation;
		}
		const background = gui.BackgroundColor3;
		const bgR = quant(background.R, 255);
		const bgG = quant(background.G, 255);
		const bgB = quant(background.B, 255);
		const bgT = quant(gui.BackgroundTransparency, 255);
		if (bgR !== v.bgR || bgG !== v.bgG || bgB !== v.bgB || bgT !== v.bgT) {
			v.bgR = bgR;
			v.bgG = bgG;
			v.bgB = bgB;
			v.bgT = bgT;
			mask = mask | UiField.Background;
		}
		if (node.text) {
			const label = instance as TextLabel;
			const text = label.Text;
			if (text !== v.text) {
				v.text = text;
				mask = mask | UiField.Text;
			}
			const color = label.TextColor3;
			const tR = quant(color.R, 255);
			const tG = quant(color.G, 255);
			const tB = quant(color.B, 255);
			const tT = quant(label.TextTransparency, 255);
			const tSize = math.clamp(math.floor((label.TextScaled ? label.TextBounds.Y : label.TextSize) + 0.5), 0, 255);
			if (tR !== v.tR || tG !== v.tG || tB !== v.tB || tT !== v.tT || tSize !== v.tSize) {
				v.tR = tR;
				v.tG = tG;
				v.tB = tB;
				v.tT = tT;
				v.tSize = tSize;
				mask = mask | UiField.TextStyle;
			}
		} else if (node.image) {
			const image = instance as ImageLabel;
			const source = image.Image;
			if (source !== v.image) {
				v.image = source;
				mask = mask | UiField.Image;
			}
			const color = image.ImageColor3;
			const iR = quant(color.R, 255);
			const iG = quant(color.G, 255);
			const iB = quant(color.B, 255);
			const iT = quant(image.ImageTransparency, 255);
			if (iR !== v.iR || iG !== v.iG || iB !== v.iB || iT !== v.iT) {
				v.iR = iR;
				v.iG = iG;
				v.iB = iB;
				v.iT = iT;
				mask = mask | UiField.ImageStyle;
			}
		}
		return mask;
	}

	/** Every SLOW_PASSES-th pass (and for a new node): fonts, alignment, slices, stroke, corner, clip, gradient, ZIndex. */
	private readSlow(node: UiNodeState): number {
		if (node.screen) {
			const order = (node.instance as ScreenGui).DisplayOrder;
			if (order !== node.zIndex) this.uiDirty = true;
			return 0;
		}
		const v = node.v;
		let mask = 0;
		const gui = node.instance as GuiObject;
		if (gui.ZIndex !== node.zIndex) this.uiDirty = true;
		if (node.text) {
			const label = gui as TextLabel;
			const font = label.FontFace;
			const family = font.Family;
			const weight = font.Weight.Value;
			const xAlign = xAlignOf(label.TextXAlignment);
			const yAlign = yAlignOf(label.TextYAlignment);
			const flags = (label.TextScaled ? 1 : 0) + (label.TextWrapped ? 2 : 0) + (label.RichText ? 4 : 0);
			const stroke = label.TextStrokeColor3;
			const sT = quant(label.TextStrokeTransparency, 255);
			const sR = quant(stroke.R, 255);
			const sG = quant(stroke.G, 255);
			const sB = quant(stroke.B, 255);
			if (family !== v.family || weight !== v.weight || xAlign !== v.xAlign || yAlign !== v.yAlign || flags !== v.tFlags || sT !== v.sT || sR !== v.sR || sG !== v.sG || sB !== v.sB) {
				v.family = family;
				v.weight = weight;
				v.xAlign = xAlign;
				v.yAlign = yAlign;
				v.tFlags = flags;
				v.sT = sT;
				v.sR = sR;
				v.sG = sG;
				v.sB = sB;
				mask = mask | UiField.TextStyle;
			}
		} else if (node.image) {
			const image = gui as ImageLabel;
			const scaleType = image.ScaleType.Value;
			if (scaleType !== v.scaleType) {
				v.scaleType = scaleType;
				mask = mask | UiField.ImageStyle;
			}
			const offset = image.ImageRectOffset;
			const rectSize = image.ImageRectSize;
			const slice = image.SliceCenter;
			const ioX = quant(offset.X, 1);
			const ioY = quant(offset.Y, 1);
			const isX = quant(rectSize.X, 1);
			const isY = quant(rectSize.Y, 1);
			const sx0 = quant(slice.Min.X, 1);
			const sy0 = quant(slice.Min.Y, 1);
			const sx1 = quant(slice.Max.X, 1);
			const sy1 = quant(slice.Max.Y, 1);
			if (ioX !== v.ioX || ioY !== v.ioY || isX !== v.isX || isY !== v.isY || sx0 !== v.sx0 || sy0 !== v.sy0 || sx1 !== v.sx1 || sy1 !== v.sy1) {
				v.ioX = ioX;
				v.ioY = ioY;
				v.isX = isX;
				v.isY = isY;
				v.sx0 = sx0;
				v.sy0 = sy0;
				v.sx1 = sx1;
				v.sy1 = sy1;
				mask = mask | UiField.ImageRect;
			}
		}
		// Stroke: a UIStroke on the border, else the classic border.
		let kR = 0;
		let kG = 0;
		let kB = 0;
		let kT = 0;
		let kW = 0;
		const stroke = node.stroke;
		if (stroke && stroke.Parent === gui && stroke.Enabled && (!node.text || stroke.ApplyStrokeMode === Enum.ApplyStrokeMode.Border)) {
			const color = stroke.Color;
			kR = quant(color.R, 255);
			kG = quant(color.G, 255);
			kB = quant(color.B, 255);
			kT = quant(stroke.Transparency, 255);
			kW = math.clamp(quant(stroke.Thickness, 4), 0, 255);
		} else if (gui.BorderSizePixel > 0) {
			const color = gui.BorderColor3;
			kR = quant(color.R, 255);
			kG = quant(color.G, 255);
			kB = quant(color.B, 255);
			kT = quant(gui.BackgroundTransparency, 255);
			kW = math.clamp(gui.BorderSizePixel * 4, 0, 255);
		}
		if (kR !== v.kR || kG !== v.kG || kB !== v.kB || kT !== v.kT || kW !== v.kW) {
			v.kR = kR;
			v.kG = kG;
			v.kB = kB;
			v.kT = kT;
			v.kW = kW;
			mask = mask | UiField.Stroke;
		}
		const corner = node.corner;
		let radius = 0;
		if (corner && corner.Parent === gui) {
			const udim = corner.CornerRadius;
			radius = math.clamp(math.floor(udim.Scale * math.min(v.w, v.h) + udim.Offset + 0.5), 0, 255);
		}
		if (radius !== v.corner) {
			v.corner = radius;
			mask = mask | UiField.Corner;
		}
		const clip = node.cls === UiClass.ScrollingFrame || node.cls === UiClass.CanvasGroup || gui.ClipsDescendants ? 1 : 0;
		if (clip !== v.clip) {
			v.clip = clip;
			mask = mask | UiField.Clip;
		}
		const gradient = node.gradient;
		if (gradient && gradient.Parent === gui && gradient.Enabled) {
			const keypoints = gradient.Color.Keypoints;
			const n = math.min(keypoints.size(), 20);
			const rotation = math.floor(gradient.Rotation + 0.5);
			let changed = n !== v.gradN || rotation !== v.gradRot;
			const grad = v.grad;
			for (let index = 0; index < n; index++) {
				const point = keypoints[index];
				const t = quant(point.Time, 255);
				const r = quant(point.Value.R, 255);
				const g = quant(point.Value.G, 255);
				const b = quant(point.Value.B, 255);
				const base = index * 4;
				if (grad[base] !== t || grad[base + 1] !== r || grad[base + 2] !== g || grad[base + 3] !== b) {
					changed = true;
					grad[base] = t;
					grad[base + 1] = r;
					grad[base + 2] = g;
					grad[base + 3] = b;
				}
			}
			if (changed) {
				v.gradN = n;
				v.gradRot = rotation;
				mask = mask | UiField.Gradient;
			}
		} else if (v.gradN !== 0) {
			v.gradN = 0;
			v.gradRot = 0;
			mask = mask | UiField.Gradient;
		}
		return mask;
	}
}
