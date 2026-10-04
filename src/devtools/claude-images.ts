import { AssetService, CaptureService, GuiService, RunService, StarterGui, UserInputService, Workspace } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { bump, popIn, popOut } from "../ui";
import { COLORS, corner, make, style } from "./widgets";

/**
 * Images in the Claude tab (spike S11, plans/09).
 *
 * GAME → CLAUDE (screenshots):
 *   1. The dev's client takes a capture (`takeScreenshot`: CaptureService:TakeScreenshotCaptureAsync, falling back to
 *      CaptureScreenshot), with the dev menu hidden for that frame. The dev may crop it and draw marks on it
 *      (`openCropView`, Crop and Draw modes; normalized 0..1 coordinates of the full capture: only the numbers travel).
 *   2. Op `claude.attach` {captureTime, localId?, crop?, strokes?}: the game server checks the marks (`cleanStrokes`,
 *      caps and a JSON size limit) and asks the dev-server
 *      (POST /v1/attachments/capture, with game.PlaceId) to pick up the PNG Roblox wrote on the dev's PC
 *      (%LOCALAPPDATA%\Roblox\tmp-capture-storage\<userId>_<placeId>_<unixMs>.png). Only the requesting user's files,
 *      the closest time within 5 s. The dev-server draws the marks onto the full capture, then keeps a cropped,
 *      downscaled copy outside the worktree and deletes it after the run.
 *   3. Fallback when no file appears (the dev plays on another PC): `uploadCapture` (StartUploadCaptureAsync, polling
 *      CheckUploadCaptureStatusAsync; the save-to-gallery prompt when the engine asks for it), then op `claude.attach`
 *      {assetId, crop?, strokes?}; the dev-server downloads the asset with its Open Cloud key.
 *   The capture itself is shown only on this client (thumbnail chip and the user's bubble, marks drawn over them with
 *   Frames); its pixels never travel through the game server or MessagingService.
 *
 * CLAUDE → GAME (idea 1): an `image` event names an image Claude showed. Op `claude.image` {id} makes the game server
 * fetch it in chunks (GET /v1/images/:id?chunk=n) and push them to the requesting dev's client only, over the kernel
 * transport (CLAUDE_IMAGE_CHUNK, paced). The client joins the chunks (`ImageInbox`), decompresses them with
 * EncodingService (zstd) and draws them with EditableImage:WritePixelsBuffer. When the EditableImage can't be created
 * (the experience's "Allow Mesh / Image APIs" setting is off, the owner isn't ID-verified, or the memory budget is
 * used up) the chat shows one short dim line.
 *
 * BIG PICTURE: every image in the chat (the dev's screenshots, Claude's images, Creator Store thumbnails) opens in a
 * lightbox (`openLightbox`): fitted on a dark backdrop, wheel or pinch zoom, drag to pan.
 *
 * Images are untrusted data. Pixels and base64 are never printed.
 */

/** Server → client: image chunks for the requesting dev, (id, index, count, data: buffer). */
export const CLAUDE_IMAGE_CHUNK = "__tt/claude-img";
/** Attachments per message (the dev-server allows 4). */
export const MAX_ATTACHMENTS = 4;
/** The EditableImage maximum; the dev-server never sends bigger images. */
export const MAX_IMAGE_SIDE = 1024;
/** zstd bytes of one image (the dev-server keeps them under 2 MB). */
export const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
/** Chunks of one image (64 KB raw each). */
export const MAX_IMAGE_CHUNKS = 48;

/** A crop rectangle in normalized coordinates (0..1 from the top left of the capture). */
export interface Crop {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type StrokeColor = "red" | "yellow" | "white" | "black";

/**
 * A mark the dev drew on a capture (the crop view's Draw mode). `points` is flat (x0, y0, x1, y1, ...), normalized 0..1
 * from the top left of the FULL capture (not the crop); one point is a dot. `width` is the pen's thickness as a
 * fraction of the capture's height. The dev-server draws them onto the image before the crop (schema.ts parseStrokes,
 * images.ts drawStrokes there).
 */
export interface Stroke {
	color: StrokeColor;
	width: number;
	points: number[];
}

/** The pen colors, in the picker's order (the dev-server draws the same RGB values). */
export const STROKE_COLOR_ORDER: StrokeColor[] = ["red", "yellow", "white", "black"];
export const STROKE_COLORS: Record<StrokeColor, Color3> = {
	red: Color3.fromRGB(255, 59, 48),
	yellow: Color3.fromRGB(255, 214, 10),
	white: Color3.fromRGB(255, 255, 255),
	black: Color3.fromRGB(0, 0, 0),
};
/** Pen sizes: thin, medium, thick (fractions of the capture's height). */
export const PEN_WIDTHS = [0.006, 0.012, 0.022];
/** Strokes per capture. */
export const MAX_STROKES = 30;
/** Points per stroke. */
export const MAX_STROKE_POINTS = 400;
/** Points of all strokes of one capture. */
export const MAX_TOTAL_POINTS = 3000;
/** The thickest pen the servers accept. */
export const MAX_STROKE_WIDTH = 0.04;
/**
 * JSON bytes of one capture's strokes (the dev-server takes 160 KB bodies). 3000 points are about 42 KB at 4 decimals,
 * about 125 KB even if every number were printed with 17 digits, so a drawing within the caps always fits.
 */
export const MAX_STROKES_JSON = 144 * 1024;

/** An image Claude showed (event `image`). */
export interface ClaudeImageMeta {
	id: string;
	width: number;
	height: number;
	/** zstd bytes. */
	bytes: number;
	chunks: number;
}

/** A capture taken on this client. Display only: its pixels are never read by scripts. */
export interface TakenCapture {
	/** The capture object (TakeScreenshotCaptureAsync); needed for the upload fallback. */
	capture?: ScreenshotCapture;
	/** A temporary content id (CaptureScreenshot fallback). */
	contentId?: string;
	/** Unix ms on this PC's clock (the file name uses the same clock). */
	captureTime: number;
	localId?: string;
	/** Width / height of the captured view. */
	aspect: number;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };

function isHexId(value: unknown): value is string {
	return typeIs(value, "string") && value.size() === 32 && value.match("^%x+$")[0] !== undefined;
}

function finite(value: unknown): value is number {
	return typeIs(value, "number") && value === value && value !== math.huge && value !== -math.huge;
}

// Validation (server side; also used on the client for what the server relays) -----------------------------------------

/** `{x, y, w, h}` in 0..1, w and h > 0, inside the image; undefined otherwise. */
export function cleanCrop(raw: unknown): Crop | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const data = raw as Record<string, unknown>;
	const { x, y, w, h } = data;
	if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) return undefined;
	if (x < 0 || y < 0 || w <= 0 || h <= 0 || x > 1 || y > 1 || w > 1 || h > 1) return undefined;
	if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return undefined;
	// Rounded to 4 decimals: plenty for a crop, and the JSON stays short.
	const r = (n: number) => math.floor(n * 10_000 + 0.5) / 10_000;
	return { x: r(x), y: r(y), w: math.min(r(w), 1 - r(x)), h: math.min(r(h), 1 - r(y)) };
}

/** A table whose keys are exactly 1..n (n ≤ max), as a list; undefined otherwise. */
function cleanList(raw: unknown, max: number): unknown[] | undefined {
	if (!typeIs(raw, "table")) return undefined;
	let count = 0;
	for (const [key] of pairs(raw as object)) {
		count += 1;
		if (count > max || !typeIs(key, "number") || key % 1 !== 0 || key < 1) return undefined;
	}
	const list = raw as unknown[];
	for (let index = 0; index < count; index++) if (list[index] === undefined) return undefined;
	return list;
}

/**
 * The dev's marks for one capture: at most MAX_STROKES strokes of 1..MAX_STROKE_POINTS points, MAX_TOTAL_POINTS in
 * all, known colors, a width in (0, MAX_STROKE_WIDTH], every coordinate a finite number in 0..1 (rounded to 4
 * decimals). Missing = no strokes ([]); undefined when malformed. The caller also caps the JSON (MAX_STROKES_JSON).
 */
export function cleanStrokes(raw: unknown): Stroke[] | undefined {
	if (raw === undefined) return [];
	const items = cleanList(raw, MAX_STROKES);
	if (!items) return undefined;
	const strokes = new Array<Stroke>();
	let total = 0;
	for (const item of items) {
		if (!typeIs(item, "table")) return undefined;
		const { color, width, points } = item as { color?: unknown; width?: unknown; points?: unknown };
		if (!typeIs(color, "string") || !STROKE_COLOR_ORDER.includes(color as StrokeColor)) return undefined;
		if (!finite(width) || width <= 0 || width > MAX_STROKE_WIDTH) return undefined;
		const values = cleanList(points, MAX_STROKE_POINTS * 2);
		if (!values || values.size() < 2 || values.size() % 2 !== 0) return undefined;
		const clean = new Array<number>();
		for (const value of values) {
			if (!finite(value) || value < 0 || value > 1) return undefined;
			clean.push(math.floor(value * 10_000 + 0.5) / 10_000);
		}
		total += clean.size() / 2;
		if (total > MAX_TOTAL_POINTS) return undefined;
		strokes.push({ color: color as StrokeColor, width, points: clean });
	}
	return strokes;
}

/** Up to MAX_ATTACHMENTS distinct 32-hex ids, or undefined when malformed. */
export function cleanAttachmentIds(raw: unknown): string[] | undefined {
	if (raw === undefined) return [];
	if (!typeIs(raw, "table")) return undefined;
	const ids = new Array<string>();
	for (const [, id] of pairs(raw as object)) {
		if (!isHexId(id) || ids.includes(id)) return undefined;
		ids.push(id);
	}
	return ids.size() <= MAX_ATTACHMENTS ? ids : undefined;
}

/** The `image` field of an `image` event, field by field. */
export function cleanImageMeta(raw: unknown): ClaudeImageMeta | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const data = raw as Record<string, unknown>;
	const { id, width, height, bytes, chunks } = data;
	if (!isHexId(id) || !finite(width) || !finite(height) || !finite(bytes) || !finite(chunks)) return undefined;
	if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return undefined;
	if (bytes < 1 || bytes > MAX_IMAGE_BYTES || chunks < 1 || chunks > MAX_IMAGE_CHUNKS) return undefined;
	return { id, width: math.floor(width), height: math.floor(height), bytes: math.floor(bytes), chunks: math.floor(chunks) };
}

/** One GET /v1/images/:id?chunk=n reply: the meta and the chunk's bytes (base64 decoded), or undefined. */
export function decodeImageChunk(raw: unknown, id: string, index: number): { meta: ClaudeImageMeta; data: buffer } | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const reply = raw as Record<string, unknown>;
	const meta = cleanImageMeta({ id: reply.id, width: reply.width, height: reply.height, bytes: reply.bytes, chunks: reply.chunks });
	const data = reply.data;
	if (!meta || meta.id !== id || reply.chunk !== index || !typeIs(data, "string") || data.size() > 120 * 1024) return undefined;
	const encoding = game.GetService("EncodingService");
	const [ok, bytes] = pcall(() => encoding.Base64Decode(buffer.fromstring(data)));
	if (!ok || buffer.len(bytes) > 64 * 1024) return undefined;
	return { meta, data: bytes };
}

// Client: capture --------------------------------------------------------------------------------------------------

/** The input's position in the same space as `gui.AbsolutePosition` (InputObject positions exclude the top bar). */
export function pointerPosition(input: InputObject, gui: GuiObject): Vector2 {
	const screenGui = gui.FindFirstAncestorOfClass("ScreenGui");
	const inset = screenGui !== undefined && screenGui.IgnoreGuiInset ? GuiService.GetGuiInset()[0] : Vector2.zero;
	return new Vector2(input.Position.X, input.Position.Y).add(inset);
}

/**
 * Takes a screenshot of this client's view, with `hide` (the dev menu's ScreenGuis) off for that frame. Yields (call it
 * from a spawned thread). TakeScreenshotCaptureAsync first; CaptureScreenshot when it is missing or fails.
 */
export function takeScreenshot(hide: ScreenGui[] = [], timeout = 8): Outcome<TakenCapture> {
	const camera = Workspace.CurrentCamera;
	const view = camera !== undefined ? camera.ViewportSize : new Vector2(16, 9);
	const aspect = view.Y > 0 ? view.X / view.Y : 16 / 9;
	const restore = new Array<ScreenGui>();
	for (const gui of hide) {
		if (gui.Enabled) {
			gui.Enabled = false;
			restore.push(gui);
		}
	}
	if (restore.size() > 0) {
		RunService.RenderStepped.Wait();
		RunService.RenderStepped.Wait();
	}
	// Roblox hides the game's UI (PlayerGui) from captures by default; the dev wants to see it. The dev menu itself is
	// hidden above. Both knobs: ScreenshotHud.HidePlayerGuiForCaptures (restored after) and UICaptureMode = All on the
	// call (newer clients). Either may be missing on a client, so both are best effort.
	const hud = StarterGui.FindFirstChildOfClass("ScreenshotHud" as keyof Instances) as unknown as { HidePlayerGuiForCaptures?: boolean } | undefined;
	let hudBefore: boolean | undefined;
	pcall(() => {
		if (hud !== undefined && hud.HidePlayerGuiForCaptures !== false) {
			hudBefore = hud.HidePlayerGuiForCaptures;
			hud.HidePlayerGuiForCaptures = false;
		}
	});
	const [paramsOk, uiAll] = pcall(() => (Enum as unknown as Record<string, Record<string, EnumItem>>).UICaptureMode.All);
	const captureParams = paramsOk && uiAll !== undefined ? { UICaptureMode: uiAll } : undefined;
	const takeCapture = CaptureService.TakeScreenshotCaptureAsync as unknown as (
		self: CaptureService,
		onCaptured: (status: Enum.ScreenshotCaptureResult, capture?: ScreenshotCapture) => void,
		params?: object,
	) => void;
	let result: Outcome<TakenCapture> | undefined;
	const waitFor = (seconds: number) => {
		const deadline = os.clock() + seconds;
		while (result === undefined && os.clock() < deadline) task.wait(0.05);
	};
	const [started] = pcall(() =>
		takeCapture(CaptureService, (status: Enum.ScreenshotCaptureResult, capture?: ScreenshotCapture) => {
			if (result !== undefined) return;
			const [ok, taken] = pcall((): TakenCapture | undefined => {
				if (status !== Enum.ScreenshotCaptureResult.Success || capture === undefined) return undefined;
				return { capture, captureTime: capture.CaptureTime.UnixTimestampMillis, localId: capture.LocalId, aspect };
			});
			if (ok && taken !== undefined) result = { ok: true, value: taken };
			else result = { ok: false, error: status === Enum.ScreenshotCaptureResult.NoSpaceOnDevice ? "capture_no_space" : "capture_failed" };
		}, captureParams),
	);
	if (started) waitFor(timeout / 2);
	if (result === undefined || !result.ok) {
		// Older clients (or a failed capture): the classic API, a temporary content id and our own clock.
		const failed = result;
		result = undefined;
		const [classic] = pcall(() =>
			CaptureService.CaptureScreenshot((contentId) => {
				if (result === undefined) result = { ok: true, value: { contentId, captureTime: DateTime.now().UnixTimestampMillis, aspect } };
			}),
		);
		if (classic) waitFor(timeout / 2);
		if (result === undefined) result = failed;
	}
	for (const gui of restore) gui.Enabled = true;
	if (hudBefore !== undefined) pcall(() => (hud!.HidePlayerGuiForCaptures = hudBefore));
	return result ?? { ok: false, error: "capture_failed" };
}

/** A short error code from an UploadCaptureResult. */
function uploadError(status: unknown): string {
	if (status === Enum.UploadCaptureResult.NeedPermission) return "upload_permission";
	if (status === Enum.UploadCaptureResult.CaptureModerated) return "upload_moderated";
	if (status === Enum.UploadCaptureResult.UploadQuotaReached) return "upload_quota";
	return "upload_failed";
}

/**
 * The upload fallback: uploads the capture as an asset and returns its id. Yields up to `timeout` seconds. When the
 * engine says the capture must be in the gallery first, the dev is asked (once) to save it.
 */
export function uploadCapture(capture: ScreenshotCapture, timeout = 90, onSlow?: () => void): Outcome<number> {
	const deadline = os.clock() + timeout;
	const start = (): [status: unknown, token: unknown] => {
		let status: unknown;
		let token: unknown;
		const [ok] = pcall(() => {
			const [s, t] = CaptureService.StartUploadCaptureAsync(capture) as unknown as LuaTuple<[Enum.UploadCaptureResult, string]>;
			status = s;
			token = t;
		});
		return ok ? [status, token] : [undefined, undefined];
	};
	let [status, token] = start();
	if (status === Enum.UploadCaptureResult.CaptureNotInGallery) {
		// Consent: the dev saves it to their gallery (their choice), then the upload is tried once more.
		let saved: boolean | undefined;
		pcall(() =>
			CaptureService.PromptSaveCapturesToGallery([capture] as unknown as string[], (results) => {
				for (const [, accepted] of pairs(results as object)) saved = accepted === true;
				if (saved === undefined) saved = false;
			}),
		);
		while (saved === undefined && os.clock() < deadline) task.wait(0.1);
		if (saved !== true) return { ok: false, error: "upload_not_saved" };
		[status, token] = start();
	}
	if (status === undefined) {
		// No polling API: the one-shot upload (yields until done).
		let assetId: unknown;
		const [ok] = pcall(() => {
			const [s, id] = CaptureService.UploadCaptureAsync(capture) as unknown as LuaTuple<[Enum.UploadCaptureResult, number]>;
			status = s;
			assetId = id;
		});
		if (ok && status === Enum.UploadCaptureResult.Success && typeIs(assetId, "number") && assetId > 0) return { ok: true, value: assetId };
		return { ok: false, error: uploadError(status) };
	}
	if (!typeIs(token, "string") || token === "") return { ok: false, error: uploadError(status) };
	let slowShown = false;
	const started = os.clock();
	while (os.clock() < deadline) {
		let assetId: unknown;
		let check: unknown;
		pcall(() => {
			const [s, id] = CaptureService.CheckUploadCaptureStatusAsync(token as string) as unknown as LuaTuple<[Enum.UploadCaptureResult, number]>;
			check = s;
			assetId = id;
		});
		if (check === Enum.UploadCaptureResult.Success && typeIs(assetId, "number") && assetId > 0) return { ok: true, value: assetId };
		const pending = check === undefined || check === Enum.UploadCaptureResult.UploadPending || check === Enum.UploadCaptureResult.Success;
		if (!pending) return { ok: false, error: uploadError(check) };
		if (!slowShown && os.clock() - started > 10) {
			slowShown = true;
			onSlow?.();
		}
		task.wait(1);
	}
	return { ok: false, error: "upload_timeout" };
}

/** Shows a capture in an ImageLabel (display only). False when this client can't show it. */
export function showCapture(image: ImageLabel, taken: TakenCapture): boolean {
	const capture = taken.capture;
	if (capture !== undefined) {
		const [ok] = pcall(() => {
			image.ImageContent = Content.fromObject(capture);
		});
		if (ok) return true;
	}
	const id = taken.contentId ?? taken.localId;
	if (id !== undefined && id.match("^rbx")[0] !== undefined) {
		image.Image = id;
		return true;
	}
	return false;
}

const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };

// Marks: drawn with Frames over a GUI that shows the FULL capture --------------------------------------------------------

/** One stroke being drawn: `add` appends a point (normalized 0..1); `frame` holds its parts. */
export interface StrokeArt {
	frame: Frame;
	add: (x: number, y: number) => void;
}

/** A round joint where the stroke turns more than this (straight runs need none). */
const JOINT_TURN = math.rad(12);

/**
 * A stroke over `parent` (a GUI showing the whole capture, width / height = `aspect`): a Frame per segment, rotated
 * between consecutive points, and round dots at both ends and at sharp turns. Everything is in scale units of the
 * parent (lengths in its width, the thickness in its height), so it follows the parent's size, a UIScale zoom included.
 * `minPx` thickens small renders (thumbnails) so thin marks still show.
 */
export function strokeArt(parent: GuiObject, stroke: { color: StrokeColor; width: number }, aspect: number, minPx = 0, zIndex = parent.ZIndex): StrokeArt {
	const color = STROKE_COLORS[stroke.color] ?? STROKE_COLORS.red;
	const w = stroke.width;
	const frame = make("Frame", { Name: "Stroke", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: zIndex }, parent);
	const dot = (x: number, y: number) => {
		const part = make(
			"Frame",
			{ BackgroundColor3: color, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(x, y), Size: new UDim2(w / aspect, minPx, w, minPx), ZIndex: zIndex },
			frame,
		);
		make("UICorner", { CornerRadius: new UDim(0.5, 0) }, part);
		return part;
	};
	let lastX: number | undefined;
	let lastY = 0;
	let heading: number | undefined;
	let tip: Frame | undefined;
	const add = (x: number, y: number) => {
		if (lastX === undefined) {
			dot(x, y);
			lastX = x;
			lastY = y;
			return;
		}
		// In units of the parent's width: a step down of dy is dy / aspect widths.
		const dx = x - lastX;
		const dy = (y - lastY) / aspect;
		const length = math.sqrt(dx * dx + dy * dy);
		if (length < 1e-6) return;
		const angle = math.atan2(dy, dx);
		if (heading !== undefined) {
			let turn = math.abs(angle - heading);
			if (turn > math.pi) turn = 2 * math.pi - turn;
			if (turn > JOINT_TURN) dot(lastX, lastY);
		}
		make(
			"Frame",
			{
				BackgroundColor3: color,
				BorderSizePixel: 0,
				AnchorPoint: new Vector2(0.5, 0.5),
				Position: UDim2.fromScale((x + lastX) / 2, (y + lastY) / 2),
				Size: new UDim2(length, 0, w, minPx),
				Rotation: math.deg(angle),
				ZIndex: zIndex,
			},
			frame,
		);
		// The round end follows the newest point.
		tip ??= dot(x, y);
		tip.Position = UDim2.fromScale(x, y);
		lastX = x;
		lastY = y;
		heading = angle;
	};
	return { frame, add };
}

/**
 * All `strokes` over `parent` (a GUI showing the whole capture) in one holder Frame. Past `maxPoints` in all, every
 * k-th point is used (ends kept): small thumbnails don't need thousands of Frames.
 */
export function drawStrokes(parent: GuiObject, strokes: readonly Stroke[], aspect: number, maxPoints = math.huge, minPx = 0): Frame {
	const holder = make("Frame", { Name: "Marks", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: parent.ZIndex }, parent);
	let total = 0;
	for (const stroke of strokes) total += stroke.points.size() / 2;
	const step = total > maxPoints ? math.ceil(total / maxPoints) : 1;
	for (const stroke of strokes) {
		const art = strokeArt(holder, stroke, aspect, minPx);
		const count = stroke.points.size() / 2;
		for (let index = 0; index < count; index++) {
			if (index % step !== 0 && index !== count - 1) continue;
			art.add(stroke.points[index * 2], stroke.points[index * 2 + 1]);
		}
	}
	return holder;
}

/** The width / height of a capture's cropped area. */
export function cropAspect(taken: TakenCapture, crop: Crop | undefined): number {
	const c = crop ?? FULL;
	return (c.w * taken.aspect) / c.h;
}

/**
 * Fills `frame` (clipping, with the crop's aspect) with the capture's cropped area and its marks: the whole capture,
 * scaled and offset so only the crop shows, the marks drawn over it. False when this client can't show the capture.
 */
export function fillCapture(frame: GuiObject, taken: TakenCapture, crop: Crop | undefined, strokes?: readonly Stroke[], maxPoints = math.huge, minPx = 0): boolean {
	const c = crop ?? FULL;
	const image = make(
		"ImageLabel",
		{ BackgroundTransparency: 1, BorderSizePixel: 0, ScaleType: Enum.ScaleType.Stretch, Size: UDim2.fromScale(1 / c.w, 1 / c.h), Position: UDim2.fromScale(-c.x / c.w, -c.y / c.h), ZIndex: frame.ZIndex },
		frame,
	);
	const shown = showCapture(image, taken);
	if (strokes && strokes.size() > 0) drawStrokes(image, strokes, taken.aspect, maxPoints, minPx);
	return shown;
}

/**
 * A thumbnail of the capture's cropped area with its marks (simplified), `height` px tall. A camera mark stands in
 * when this client can't show the capture.
 */
export function captureThumb(taken: TakenCapture, crop: Crop | undefined, height: number, strokes?: readonly Stroke[]): Frame {
	const aspect = math.clamp(cropAspect(taken, crop), 0.3, 4);
	const frame = make("Frame", { BackgroundColor3: COLORS.dark, BorderSizePixel: 0, ClipsDescendants: true, Size: UDim2.fromOffset(math.floor(height * aspect + 0.5), height) });
	corner(frame, 6);
	if (!fillCapture(frame, taken, crop, strokes, 160, 1)) cameraMark(frame, COLORS.dim);
	return frame;
}

// Pointer positions --------------------------------------------------------------------------------------------------

/** What earlier presses learned: the inset offset an unambiguous press picked. */
export interface PointerCalibration {
	offset?: Vector2;
}

/**
 * Where a press on `hit` is, in AbsolutePosition space. An InputObject's position may or may not be shifted from that
 * space by the GUI inset (it depends on the ScreenGui's IgnoreGuiInset and the client), so the press is calibrated on
 * the button the engine itself says was pressed: of the two candidates, the raw position and the raw position plus
 * GuiService:GetGuiInset(), the one inside `hit`'s rectangle wins (and is remembered in `calibration`). When both fit,
 * the remembered choice, else the one nearer `hit`'s center; when neither does, the same, clamped into `hit`. Buttons
 * smaller than the inset (pressStrips) make "both fit" impossible.
 */
export function pressPoint(input: InputObject, hit: GuiObject, calibration: PointerCalibration): Vector2 {
	const raw = new Vector2(input.Position.X, input.Position.Y);
	const inset = GuiService.GetGuiInset()[0];
	const at = hit.AbsolutePosition;
	const size = hit.AbsoluteSize;
	const inside = (point: Vector2) => point.X >= at.X - 0.5 && point.X <= at.X + size.X + 0.5 && point.Y >= at.Y - 0.5 && point.Y <= at.Y + size.Y + 0.5;
	if (inset.Magnitude < 0.5) return raw;
	const center = at.add(size.div(2));
	const nearer = () => (raw.sub(center).Magnitude <= raw.add(inset).sub(center).Magnitude ? Vector2.zero : inset);
	const plain = inside(raw);
	const shifted = inside(raw.add(inset));
	let offset: Vector2;
	if (plain !== shifted) {
		offset = plain ? Vector2.zero : inset;
		calibration.offset = offset;
	} else offset = calibration.offset ?? nearer();
	const point = raw.add(offset);
	if (plain || shifted) return point;
	return new Vector2(math.clamp(point.X, at.X, at.X + size.X), math.clamp(point.Y, at.Y, at.Y + size.Y));
}

/**
 * A grid of invisible buttons covering `parent`, each smaller than the GUI inset in the inset's direction (rows when
 * the inset is vertical), so `pressPoint` on the pressed cell always has exactly one candidate inside. Rebuilt when
 * `parent` resizes. `onPress` gets every InputBegan on a cell.
 */
export function pressStrips(parent: GuiObject, trove: Trove, zIndex: number, onPress: (input: InputObject, cell: GuiObject) => void): Frame {
	const holder = make("Frame", { Name: "PressCells", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: zIndex }, parent);
	let built = "";
	const build = () => {
		if (holder.Parent === undefined) return;
		const inset = GuiService.GetGuiInset()[0];
		const size = parent.AbsoluteSize;
		const rows = inset.Y > 1 ? math.clamp(math.ceil(size.Y / (inset.Y * 0.8)), 1, 60) : 1;
		const columns = inset.X > 1 ? math.clamp(math.ceil(size.X / (inset.X * 0.8)), 1, 30) : 1;
		const key = `${rows}x${columns}`;
		if (key === built) return;
		built = key;
		for (const child of holder.GetChildren()) child.Destroy();
		for (let row = 0; row < rows; row++) {
			for (let column = 0; column < columns; column++) {
				const cell = make(
					"TextButton",
					{
						Text: "",
						AutoButtonColor: false,
						BackgroundTransparency: 1,
						BorderSizePixel: 0,
						Position: UDim2.fromScale(column / columns, row / rows),
						Size: UDim2.fromScale(1 / columns, 1 / rows),
						ZIndex: zIndex,
					},
					holder,
				);
				// The connection dies with the cell.
				cell.InputBegan.Connect((input) => onPress(input, cell));
			}
		}
	};
	build();
	trove.connect(parent.GetPropertyChangedSignal("AbsoluteSize"), () => task.defer(build));
	return holder;
}

/** Small icons drawn from Frames (no emojis, no image assets); returns a recolor function. */
export function glyph(parent: Instance, kind: "crop" | "pen" | "undo", color: Color3, zIndex = 1): (color: Color3) => void {
	const box = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(16, 16), ZIndex: zIndex }, parent);
	const fills = new Array<Frame>();
	const rings = new Array<UIStroke>();
	/** A bar by its center. */
	const bar = (cx: number, cy: number, w: number, h: number, rotation = 0) => {
		const part = make(
			"Frame",
			{ BackgroundColor3: color, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromOffset(cx, cy), Size: UDim2.fromOffset(w, h), Rotation: rotation, ZIndex: zIndex },
			box,
		);
		fills.push(part);
		return part;
	};
	if (kind === "crop") {
		// Two interlocking L corners.
		bar(5, 6, 2, 12);
		bar(10, 11, 12, 2);
		bar(6, 5, 12, 2);
		bar(11, 10, 2, 12);
	} else if (kind === "pen") {
		// A pencil leaning left: the body and its tip.
		bar(9.5, 6.5, 4, 12, 45);
		bar(3.6, 12.4, 3, 3, 45);
	} else {
		// Undo: a hook (the right half of a ring), a shaft to the left and an arrowhead.
		const clip = make("Frame", { BackgroundTransparency: 1, ClipsDescendants: true, Position: UDim2.fromOffset(8, 0), Size: UDim2.fromOffset(8, 16), ZIndex: zIndex }, box);
		const ring = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(-4, 4.5), Size: UDim2.fromOffset(8, 8), ZIndex: zIndex }, clip);
		make("UICorner", { CornerRadius: new UDim(0.5, 0) }, ring);
		rings.push(make("UIStroke", { Color: color, Thickness: 2, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, ring));
		bar(5.5, 3.5, 5, 2);
		bar(6.5, 13.5, 3, 2);
		bar(3.6, 1.9, 4.5, 2, -45);
		bar(3.6, 5.1, 4.5, 2, 45);
	}
	return (recolor: Color3) => {
		for (const part of fills) part.BackgroundColor3 = recolor;
		for (const ring of rings) ring.Color = recolor;
	};
}

/** A small camera drawn from Frames (no emojis, no image asset). */
export function cameraMark(parent: Instance, color: Color3): Frame {
	const box = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(16, 16) }, parent);
	const body = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(0, 4), Size: UDim2.fromOffset(16, 11) }, box);
	corner(body, 3);
	make("UIStroke", { Color: color, Thickness: 1.5 }, body);
	const lens = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(6, 6) }, body);
	corner(lens, 3);
	make("UIStroke", { Color: color, Thickness: 1.5 }, lens);
	make("Frame", { BackgroundColor3: color, BorderSizePixel: 0, Position: UDim2.fromOffset(4, 1), Size: UDim2.fromOffset(6, 3) }, box);
	return box;
}

/** A label whose trailing dots cycle ("Capturing", "Capturing.", ...) until `stop` is called or the label is gone. */
export function animateDots(target: TextLabel, text: string): () => void {
	let running = true;
	task.spawn(() => {
		let count = 0;
		while (running && target.Parent !== undefined) {
			target.Text = text + string.rep(".", count);
			count = (count + 1) % 4;
			task.wait(0.35);
		}
	});
	return () => {
		running = false;
	};
}

// Client: crop view ------------------------------------------------------------------------------------------------

/**
 * The crop view over `host`: the capture fitted in, with two modes (round buttons at the bottom left):
 *   - Crop: a selection that starts as the whole capture: drag a corner to resize it, drag inside to move it; Reset /
 *     Use full / Done.
 *   - Draw: freehand marks with mouse or touch: four colors and three pen sizes above the bar; Undo / Clear / Done.
 *     Marks are normalized to the FULL capture (not the crop) and show under the crop's shading.
 * A close button discards the capture. `done` gets the normalized crop (undefined = the whole capture) and the marks;
 * `cancel` runs when the dev discards it. Everything lives in `trove`.
 *
 * Coordinates: crop drags use the pointer's movement since the press, never absolute positions, so screen insets (top
 * bar, IgnoreGuiInset) can't shift anything. A pen stroke needs one absolute point, its start: the photo is covered by
 * a grid of invisible buttons smaller than the GUI inset (pressStrips), and `pressPoint` picks the inset candidate that
 * lies inside the button the engine reports as pressed. The rest of the stroke is that start plus the movement since
 * the press, all in AbsolutePosition space.
 */
export function openCropView(host: GuiObject, trove: Trove, taken: TakenCapture, done: (crop: Crop | undefined, strokes: Stroke[]) => void, cancel: () => void) {
	const own = trove.extend();
	const overlay = make(
		"Frame",
		{ Name: "CropView", Active: true, BackgroundColor3: COLORS.window, BackgroundTransparency: 0.04, BorderSizePixel: 0, Size: UDim2.fromScale(1, 1), ZIndex: 60 },
		host,
	);
	own.add(overlay);
	const area = make("Frame", { BackgroundTransparency: 1, Position: UDim2.fromOffset(10, 10), Size: new UDim2(1, -20, 1, -66), ZIndex: 60 }, overlay);
	const photo = make(
		"ImageLabel",
		{ Active: true, BackgroundColor3: COLORS.dark, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromScale(1, 1), ScaleType: Enum.ScaleType.Stretch, ZIndex: 61 },
		area,
	);
	make("UIAspectRatioConstraint", { AspectRatio: taken.aspect }, photo);
	if (!showCapture(photo, taken)) cameraMark(photo, COLORS.dim);
	// The marks sit under the crop's shading (ZIndex 61 < 62): outside the selection they dim like the photo.
	const marks = make("Frame", { Name: "Marks", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: 61 }, photo);

	// Outside the selection is dimmed by four frames; the selection has an outline, a drag area (moves it) and four
	// corner handles (resize it). It starts as the whole capture.
	const shade = () => make("Frame", { BackgroundColor3: Color3.fromRGB(0, 0, 0), BackgroundTransparency: 0.45, BorderSizePixel: 0, ZIndex: 62 }, photo);
	const [top, bottom, left, right] = [shade(), shade(), shade(), shade()];
	const outline = make("Frame", { BackgroundTransparency: 1, BorderSizePixel: 0, ZIndex: 63 }, photo);
	make("UIStroke", { Color: COLORS.accent, Thickness: 2 }, outline);
	const moveArea = make("TextButton", { Name: "Move", Text: "", AutoButtonColor: false, BackgroundTransparency: 1, BorderSizePixel: 0, ZIndex: 64 }, photo);
	const handles = new Array<TextButton>();
	for (let index = 0; index < 4; index++) {
		// A 32 px touch target around a 14 px dot.
		const handle = make("TextButton", { Name: "Handle", Text: "", AutoButtonColor: false, BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Size: UDim2.fromOffset(32, 32), ZIndex: 65 }, photo);
		const dot = make("Frame", { BackgroundColor3: COLORS.accent, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(14, 14), ZIndex: 66 }, handle);
		corner(dot, 7);
		handles.push(handle);
	}

	const MIN = 0.05;
	let rect: Crop = FULL;
	const paint = () => {
		const { x, y, w, h } = rect;
		top.Position = UDim2.fromScale(0, 0);
		top.Size = UDim2.fromScale(1, y);
		bottom.Position = UDim2.fromScale(0, y + h);
		bottom.Size = UDim2.fromScale(1, 1 - y - h);
		left.Position = UDim2.fromScale(0, y);
		left.Size = UDim2.fromScale(x, h);
		right.Position = UDim2.fromScale(x + w, y);
		right.Size = UDim2.fromScale(1 - x - w, h);
		outline.Position = UDim2.fromScale(x, y);
		outline.Size = UDim2.fromScale(w, h);
		moveArea.Position = UDim2.fromScale(x, y);
		moveArea.Size = UDim2.fromScale(w, h);
		const corners: [number, number][] = [
			[x, y],
			[x + w, y],
			[x, y + h],
			[x + w, y + h],
		];
		corners.forEach(([cx, cy], index) => (handles[index].Position = UDim2.fromScale(cx, cy)));
	};
	paint();

	// Marks: the strokes drawn so far and their Frames.
	const strokes = new Array<Stroke>();
	const arts = new Array<Frame>();
	let penColor: StrokeColor = "red";
	let penWidth = PEN_WIDTHS[1];
	let mode: "crop" | "draw" = "crop";
	const totalPoints = () => {
		let count = 0;
		for (const stroke of strokes) count += stroke.points.size() / 2;
		return count;
	};
	const round = (value: number) => math.floor(math.clamp(value, 0, 1) * 10_000 + 0.5) / 10_000;

	// Drag (Crop mode): a corner (index 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) or the whole selection.
	let drag: { corner?: number; start: Crop; from: Vector2; input: InputObject } | undefined;
	// Pen (Draw mode): the stroke being drawn, its start in AbsolutePosition space and the raw press position.
	let pen: { input: InputObject; from: Vector2; start: Vector2; last: Vector2; stroke: Stroke; art: StrokeArt } | undefined;
	const calibration: PointerCalibration = {};
	const isPointer = (input: InputObject) => input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
	const begin = (input: InputObject, cornerIndex?: number) => {
		if (!isPointer(input) || drag || pen || mode !== "crop") return;
		drag = { corner: cornerIndex, start: rect, from: new Vector2(input.Position.X, input.Position.Y), input };
	};
	handles.forEach((handle, index) => own.connect(handle.InputBegan, (input) => begin(input, index)));
	own.connect(moveArea.InputBegan, (input) => begin(input));

	let undoButton: TextButton | undefined;
	/** Adds a point (AbsolutePosition space) to the stroke being drawn. */
	const addPoint = (point: Vector2) => {
		if (!pen) return;
		const origin = photo.AbsolutePosition;
		const size = photo.AbsoluteSize;
		const x = round((point.X - origin.X) / math.max(1, size.X));
		const y = round((point.Y - origin.Y) / math.max(1, size.Y));
		pen.stroke.points.push(x, y);
		pen.art.add(x, y);
		pen.last = point;
	};
	const cells = pressStrips(photo, own, 67, (input, cell) => {
		if (!isPointer(input) || drag || pen || mode !== "draw") return;
		if (strokes.size() >= MAX_STROKES || totalPoints() >= MAX_TOTAL_POINTS) {
			// The limit: the Undo button pulses instead of a message.
			if (undoButton) bump(undoButton);
			return;
		}
		const start = pressPoint(input, cell, calibration);
		const stroke: Stroke = { color: penColor, width: penWidth, points: [] };
		strokes.push(stroke);
		const art = strokeArt(marks, stroke, taken.aspect);
		arts.push(art.frame);
		pen = { input, from: new Vector2(input.Position.X, input.Position.Y), start, last: start, stroke, art };
		addPoint(start);
	});
	cells.Visible = false;

	own.connect(UserInputService.InputChanged, (input) => {
		if (!drag && !pen) return;
		if (input.UserInputType !== Enum.UserInputType.MouseMovement && input.UserInputType !== Enum.UserInputType.Touch) return;
		if (pen) {
			if (pen.input.UserInputType === Enum.UserInputType.Touch && input !== pen.input) return;
			const point = pen.start.add(new Vector2(input.Position.X, input.Position.Y).sub(pen.from));
			// A point every 3 px or more; a full stroke just stops growing.
			if (point.sub(pen.last).Magnitude < 3) return;
			if (pen.stroke.points.size() / 2 >= MAX_STROKE_POINTS || totalPoints() >= MAX_TOTAL_POINTS) return;
			addPoint(point);
			return;
		}
		if (!drag) return;
		if (drag.input.UserInputType === Enum.UserInputType.Touch && input !== drag.input) return;
		const size = photo.AbsoluteSize;
		const dx = (input.Position.X - drag.from.X) / math.max(1, size.X);
		const dy = (input.Position.Y - drag.from.Y) / math.max(1, size.Y);
		const s = drag.start;
		if (drag.corner === undefined) {
			const nx = math.clamp(s.x + dx, 0, 1 - s.w);
			const ny = math.clamp(s.y + dy, 0, 1 - s.h);
			rect = { x: nx, y: ny, w: s.w, h: s.h };
		} else {
			let [x0, y0, x1, y1] = [s.x, s.y, s.x + s.w, s.y + s.h];
			const movesLeft = drag.corner === 0 || drag.corner === 2;
			const movesTop = drag.corner === 0 || drag.corner === 1;
			if (movesLeft) x0 = math.clamp(x0 + dx, 0, x1 - MIN);
			else x1 = math.clamp(x1 + dx, x0 + MIN, 1);
			if (movesTop) y0 = math.clamp(y0 + dy, 0, y1 - MIN);
			else y1 = math.clamp(y1 + dy, y0 + MIN, 1);
			rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
		}
		paint();
	});
	own.connect(UserInputService.InputEnded, (input) => {
		if (!isPointer(input)) return;
		if (pen && (pen.input.UserInputType !== Enum.UserInputType.Touch || input === pen.input)) pen = undefined;
		if (drag && (drag.input.UserInputType !== Enum.UserInputType.Touch || input === drag.input)) drag = undefined;
	});
	const isFull = (crop: Crop) => crop.x <= 0.001 && crop.y <= 0.001 && crop.w >= 0.999 && crop.h >= 0.999;
	const finished = () => strokes.filter((stroke) => stroke.points.size() > 0);

	const close = () => {
		popOut(overlay, () => own.destroy());
	};
	const bar = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 1), Position: new UDim2(0, 10, 1, -10), Size: new UDim2(1, -20, 0, 36), ZIndex: 60 }, overlay);
	// Left: the two mode buttons. Right: the current mode's actions and Done.
	const modes = make("Frame", { BackgroundTransparency: 1, Size: new UDim2(0, 0, 1, 0), AutomaticSize: Enum.AutomaticSize.X, ZIndex: 60 }, bar);
	make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) }, modes);
	const actions = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(1, 0), Position: UDim2.fromScale(1, 0), Size: new UDim2(0, 0, 1, 0), AutomaticSize: Enum.AutomaticSize.X, ZIndex: 60 }, bar);
	make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, HorizontalAlignment: Enum.HorizontalAlignment.Right, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) }, actions);
	const button = (text: string, order: number, color: Color3, textColor: Color3, onClick: () => void) => {
		const b = style(make("TextButton", { AutoButtonColor: true, LayoutOrder: order, ZIndex: 61 }), text, 14, textColor, Enum.Font.BuilderSansMedium);
		b.TextXAlignment = Enum.TextXAlignment.Center;
		b.TextWrapped = false;
		b.BackgroundColor3 = color;
		b.Size = UDim2.fromOffset(0, 36);
		b.AutomaticSize = Enum.AutomaticSize.X;
		corner(b, 8);
		make("UIPadding", { PaddingLeft: new UDim(0, 14), PaddingRight: new UDim(0, 14) }, b);
		b.Parent = actions;
		own.connect(b.Activated, onClick);
		return b;
	};
	const iconButton = (parent: Instance, kind: "crop" | "pen" | "undo", order: number, onClick: () => void) => {
		const b = make("TextButton", { AutoButtonColor: true, Text: "", BackgroundColor3: COLORS.button, BorderSizePixel: 0, Size: UDim2.fromOffset(36, 36), LayoutOrder: order, ZIndex: 61 }, parent);
		corner(b, 18);
		const recolor = glyph(b, kind, COLORS.text, 62);
		own.connect(b.Activated, onClick);
		return [b, recolor] as const;
	};
	const reset = button("Reset", 1, COLORS.button, COLORS.text, () => {
		rect = FULL;
		paint();
	});
	const useFull = button("Use full", 2, COLORS.button, COLORS.text, () => {
		const picked = finished();
		close();
		done(undefined, picked);
	});
	const [undo] = iconButton(actions, "undo", 3, () => {
		if (pen) return;
		const index = strokes.size() - 1;
		if (index < 0) return;
		arts[index].Destroy();
		arts.remove(index);
		strokes.remove(index);
	});
	undoButton = undo;
	const clear = button("Clear", 4, COLORS.button, COLORS.text, () => {
		if (pen) return;
		for (const art of arts) art.Destroy();
		arts.clear();
		strokes.clear();
	});
	button("Done", 5, COLORS.accent, COLORS.dark, () => {
		const picked = rect;
		const marked = finished();
		close();
		done(isFull(picked) ? undefined : cleanCrop(picked), marked);
	});

	// Draw mode's pen: four colors and three sizes, in a row above the bar.
	const tools = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 1), Position: new UDim2(0, 10, 1, -54), Size: new UDim2(1, -20, 0, 36), Visible: false, ZIndex: 60 }, overlay);
	make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, VerticalAlignment: Enum.VerticalAlignment.Center, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 4) }, tools);
	const swatchRings = new Map<StrokeColor, UIStroke>();
	const sizeButtons = new Array<TextButton>();
	const sizeDots = new Array<Frame>();
	const paintTools = () => {
		for (const [name, ring] of swatchRings) ring.Transparency = name === penColor ? 0 : 1;
		sizeButtons.forEach((b, index) => (b.BackgroundTransparency = PEN_WIDTHS[index] === penWidth ? 0 : 1));
		for (const dot of sizeDots) dot.BackgroundColor3 = STROKE_COLORS[penColor];
	};
	STROKE_COLOR_ORDER.forEach((name, index) => {
		const b = make("TextButton", { AutoButtonColor: false, Text: "", BackgroundTransparency: 1, Size: UDim2.fromOffset(36, 36), LayoutOrder: index, ZIndex: 61 }, tools);
		const swatch = make("Frame", { BackgroundColor3: STROKE_COLORS[name], BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(22, 22), ZIndex: 62 }, b);
		corner(swatch, 11);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, swatch);
		// The picked color: an accent ring around the swatch.
		const ringFrame = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(30, 30), ZIndex: 62 }, b);
		corner(ringFrame, 15);
		swatchRings.set(name, make("UIStroke", { Color: COLORS.accent, Thickness: 2, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, ringFrame));
		own.connect(b.Activated, () => {
			penColor = name;
			paintTools();
		});
	});
	make("Frame", { BackgroundColor3: COLORS.stroke, BorderSizePixel: 0, Size: UDim2.fromOffset(1, 22), LayoutOrder: 10, ZIndex: 61 }, tools);
	PEN_WIDTHS.forEach((width, index) => {
		const b = make("TextButton", { AutoButtonColor: false, Text: "", BackgroundColor3: COLORS.button, BackgroundTransparency: 1, BorderSizePixel: 0, Size: UDim2.fromOffset(36, 36), LayoutOrder: 11 + index, ZIndex: 61 }, tools);
		corner(b, 18);
		const side = 5 + index * 4;
		const dot = make("Frame", { BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(side, side), ZIndex: 62 }, b);
		corner(dot, side / 2);
		make("UIStroke", { Color: COLORS.stroke, Thickness: 1, ApplyStrokeMode: Enum.ApplyStrokeMode.Border }, dot);
		sizeButtons.push(b);
		sizeDots.push(dot);
		own.connect(b.Activated, () => {
			penWidth = width;
			paintTools();
		});
	});
	paintTools();

	let setMode: (picked: "crop" | "draw") => void = () => {};
	const [cropMode, recolorCrop] = iconButton(modes, "crop", 1, () => setMode("crop"));
	const [drawMode, recolorPen] = iconButton(modes, "pen", 2, () => setMode("draw"));
	setMode = (picked) => {
		if (drag || pen) return;
		mode = picked;
		const drawing = picked === "draw";
		cropMode.BackgroundColor3 = drawing ? COLORS.button : COLORS.accent;
		recolorCrop(drawing ? COLORS.text : COLORS.dark);
		drawMode.BackgroundColor3 = drawing ? COLORS.accent : COLORS.button;
		recolorPen(drawing ? COLORS.dark : COLORS.text);
		reset.Visible = !drawing;
		useFull.Visible = !drawing;
		undo.Visible = drawing;
		clear.Visible = drawing;
		tools.Visible = drawing;
		cells.Visible = drawing;
		moveArea.Interactable = !drawing;
		for (const handle of handles) handle.Interactable = !drawing;
		// The pen's row takes room above the bar.
		area.Size = new UDim2(1, -20, 1, drawing ? -110 : -66);
	};
	setMode("crop");

	// Discard: a round "x" at the top right.
	const discard = make(
		"TextButton",
		{ AutoButtonColor: true, Text: "", BackgroundColor3: COLORS.button, BorderSizePixel: 0, AnchorPoint: new Vector2(1, 0), Position: new UDim2(1, -14, 0, 14), Size: UDim2.fromOffset(32, 32), ZIndex: 68 },
		overlay,
	);
	corner(discard, 16);
	for (const angle of [45, -45]) {
		make("Frame", { BackgroundColor3: COLORS.text, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(14, 2), Rotation: angle, ZIndex: 69 }, discard);
	}
	own.connect(discard.Activated, () => {
		close();
		cancel();
	});
	paint();
	popIn(overlay);
}

// Client: Claude → game images ---------------------------------------------------------------------------------------

/** Collects pushed image chunks (CLAUDE_IMAGE_CHUNK) until an image is complete. At most 6 images in flight. */
export class ImageInbox {
	private readonly images = new Map<string, { count: number; parts: Map<number, buffer>; at: number }>();

	push(id: unknown, index: unknown, count: unknown, data: unknown) {
		if (!isHexId(id) || !finite(index) || !finite(count) || !typeIs(data, "buffer")) return;
		if (count < 1 || count > MAX_IMAGE_CHUNKS || index < 0 || index >= count || buffer.len(data) > 64 * 1024) return;
		let entry = this.images.get(id);
		if (!entry) {
			if (this.images.size() >= 6) {
				let oldest: string | undefined;
				let oldestAt = math.huge;
				for (const [key, value] of this.images) {
					if (value.at < oldestAt) {
						oldest = key;
						oldestAt = value.at;
					}
				}
				if (oldest !== undefined) this.images.delete(oldest);
			}
			entry = { count, parts: new Map(), at: os.clock() };
			this.images.set(id, entry);
		}
		if (entry.count === count) entry.parts.set(index, data);
	}

	/** Yields until image `id` is complete (or `timeout` seconds pass); returns its joined bytes once. */
	take(id: string, timeout = 60): buffer | undefined {
		const deadline = os.clock() + timeout;
		while (os.clock() < deadline) {
			const entry = this.images.get(id);
			if (entry && entry.parts.size() === entry.count) {
				this.images.delete(id);
				let total = 0;
				for (let index = 0; index < entry.count; index++) total += buffer.len(entry.parts.get(index)!);
				const joined = buffer.create(total);
				let offset = 0;
				for (let index = 0; index < entry.count; index++) {
					const part = entry.parts.get(index)!;
					buffer.copy(joined, offset, part);
					offset += buffer.len(part);
				}
				return joined;
			}
			task.wait(0.1);
		}
		this.images.delete(id);
		return undefined;
	}

	clear() {
		this.images.clear();
	}
}

/**
 * zstd RGBA8 → an EditableImage. Errors: "image_data" (the bytes don't decode to width × height × 4) or "image_api"
 * (the EditableImage can't be created: the experience setting, the owner's ID verification or the memory budget).
 */
export function editableFromZstd(data: buffer, width: number, height: number): Outcome<EditableImage> {
	if (buffer.len(data) > MAX_IMAGE_BYTES) return { ok: false, error: "image_data" };
	const encoding = game.GetService("EncodingService");
	const [ok, pixels] = pcall(() => encoding.DecompressBuffer(data, Enum.CompressionAlgorithm.Zstd));
	if (!ok || buffer.len(pixels) !== width * height * 4) return { ok: false, error: "image_data" };
	const [created, image] = pcall(() => AssetService.CreateEditableImage({ Size: new Vector2(width, height) }));
	if (!created || image === undefined) return { ok: false, error: "image_api" };
	const [written] = pcall(() => image.WritePixelsBuffer(Vector2.zero, new Vector2(width, height), pixels));
	if (!written) {
		image.Destroy();
		return { ok: false, error: "image_api" };
	}
	return { ok: true, value: image };
}

export interface LightboxOptions {
	/** Width / height of the image. */
	aspect: number;
	/** Fills the canvas (a clipping Frame with the image's aspect); false when this client can't show the image. */
	paint: (canvas: Frame) => boolean;
	/** The one dim line shown instead when `paint` returns false. */
	unavailable?: string;
	/** The GUI the lightbox covers (default `host`), placed over it in AbsolutePosition space. */
	cover?: GuiObject;
	/** Runs once when it closes (also when the tab closes). */
	onClosed?: () => void;
}

/** The lightbox zooms up to this many times the fitted size. */
const ZOOM_MAX = 6;

/**
 * Big picture mode: the image fitted on a dark backdrop over `cover` (the whole chat panel), parented to `host` (a
 * frame without a layout). Tap the backdrop, press Escape or the close button to close. Desktop: the mouse wheel zooms
 * (around the view's center) and dragging pans. Touch: pinch zooms, one finger pans. Pans use the pointer's movement
 * since the press, never absolute positions. It pops in and out through a UIScale; the zoom is a UIScale on the canvas
 * (no Size tweens). Everything lives in `trove`. Returns `close`.
 */
export function openLightbox(host: GuiObject, trove: Trove, options: LightboxOptions): () => void {
	const own = trove.extend();
	const cover = options.cover ?? host;
	const aspect = math.clamp(options.aspect, 0.05, 20);
	// Centered on its AnchorPoint, so the UIScale pop grows from the middle.
	const overlay = make("Frame", { Name: "Lightbox", Active: true, BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), ZIndex: 80 }, host);
	own.add(overlay);
	const place = () => {
		const size = cover.AbsoluteSize;
		const center = cover.AbsolutePosition.add(size.div(2)).sub(host.AbsolutePosition);
		overlay.Position = UDim2.fromOffset(center.X, center.Y);
		overlay.Size = UDim2.fromOffset(size.X, size.Y);
	};
	place();
	own.connect(cover.GetPropertyChangedSignal("AbsoluteSize"), place);
	own.connect(cover.GetPropertyChangedSignal("AbsolutePosition"), place);
	own.connect(host.GetPropertyChangedSignal("AbsolutePosition"), place);

	const backdrop = make(
		"TextButton",
		{ Name: "Backdrop", AutoButtonColor: false, Text: "", BackgroundColor3: Color3.fromRGB(0, 0, 0), BackgroundTransparency: 0.08, BorderSizePixel: 0, Size: UDim2.fromScale(1, 1), ZIndex: 80 },
		overlay,
	);
	const viewport = make("Frame", { Name: "Viewport", BackgroundTransparency: 1, ClipsDescendants: true, Position: UDim2.fromOffset(10, 10), Size: new UDim2(1, -20, 1, -20), ZIndex: 81 }, overlay);
	const canvas = make(
		"Frame",
		{ Name: "Canvas", BackgroundColor3: COLORS.dark, BorderSizePixel: 0, ClipsDescendants: true, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromScale(1, 1), ZIndex: 82 },
		viewport,
	);
	make("UIAspectRatioConstraint", { AspectRatio: aspect }, canvas);
	const zoomScale = make("UIScale", { Scale: 1 }, canvas);
	const [painted, shown] = pcall(() => options.paint(canvas));
	if (!painted || shown !== true) {
		canvas.Visible = false;
		const line = style(
			make("TextLabel", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: new UDim2(1, -40, 0, 20), ZIndex: 83 }, overlay),
			options.unavailable ?? "This image can't be shown here",
			14,
			COLORS.dim,
			Enum.Font.Code,
		);
		line.TextXAlignment = Enum.TextXAlignment.Center;
	}
	// The canvas's own button: drags on it pan (clicks on the image never close).
	const grab = make("TextButton", { Name: "Grab", AutoButtonColor: false, Text: "", BackgroundTransparency: 1, Size: UDim2.fromScale(1, 1), ZIndex: 90 }, canvas);

	let zoom = 1;
	let pan = Vector2.zero;
	/** The image's fitted size at zoom 1. */
	const fitted = () => {
		const view = viewport.AbsoluteSize;
		if (view.Y <= 0) return view;
		return view.X / view.Y > aspect ? new Vector2(view.Y * aspect, view.Y) : new Vector2(view.X, view.X / aspect);
	};
	/** Keeps the image covering the view once it is bigger than it (centered while smaller). */
	const apply = () => {
		const view = viewport.AbsoluteSize;
		const size = fitted().mul(zoom);
		const limit = new Vector2(math.max(0, (size.X - view.X) / 2), math.max(0, (size.Y - view.Y) / 2));
		pan = new Vector2(math.clamp(pan.X, -limit.X, limit.X), math.clamp(pan.Y, -limit.Y, limit.Y));
		canvas.Position = new UDim2(0.5, pan.X, 0.5, pan.Y);
		zoomScale.Scale = zoom;
	};
	/** Zooms around the view's center: the point there stays put. */
	const setZoom = (target: number) => {
		const clamped = math.clamp(target, 1, ZOOM_MAX);
		pan = pan.mul(clamped / zoom);
		zoom = clamped;
		apply();
	};
	own.connect(viewport.GetPropertyChangedSignal("AbsoluteSize"), apply);

	const isPointer = (input: InputObject) => input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
	const at = (input: InputObject) => new Vector2(input.Position.X, input.Position.Y);
	let drag: { input: InputObject; from: Vector2; start: Vector2 } | undefined;
	let pinching = false;
	let pinchedAt = -math.huge;
	own.connect(grab.InputBegan, (input) => {
		if (!isPointer(input) || drag || pinching) return;
		drag = { input, from: at(input), start: pan };
	});
	own.connect(UserInputService.InputChanged, (input) => {
		if (!drag || pinching) return;
		if (input.UserInputType !== Enum.UserInputType.MouseMovement && input.UserInputType !== Enum.UserInputType.Touch) return;
		if (drag.input.UserInputType === Enum.UserInputType.Touch && input !== drag.input) return;
		pan = drag.start.add(at(input).sub(drag.from));
		apply();
	});
	own.connect(UserInputService.InputEnded, (input) => {
		if (!drag || !isPointer(input)) return;
		if (drag.input.UserInputType === Enum.UserInputType.Touch && input !== drag.input) return;
		drag = undefined;
	});
	const wheel = (input: InputObject) => {
		if (input.UserInputType === Enum.UserInputType.MouseWheel) setZoom(zoom * (input.Position.Z > 0 ? 1.25 : 0.8));
	};
	own.connect(grab.InputChanged, wheel);
	own.connect(backdrop.InputChanged, wheel);
	// Pinch: the zoom at the pinch's start times its scale (the same event arriving twice is harmless).
	let pinchFrom = 1;
	const pinch = (scale: number, state: Enum.UserInputState) => {
		pinchedAt = os.clock();
		if (state === Enum.UserInputState.Begin) {
			pinching = true;
			drag = undefined;
			pinchFrom = zoom;
		} else if (state === Enum.UserInputState.Change) {
			if (!pinching) {
				pinching = true;
				drag = undefined;
				pinchFrom = zoom / math.max(scale, 0.01);
			}
			setZoom(pinchFrom * scale);
		} else pinching = false;
	};
	own.connect(grab.TouchPinch, (_positions, scale, _velocity, state) => pinch(scale, state));
	own.connect(backdrop.TouchPinch, (_positions, scale, _velocity, state) => pinch(scale, state));
	// Pinches over GUI only (processed), never one on the game view.
	own.connect(UserInputService.TouchPinch, (_positions, scale, _velocity, state, processed) => {
		if (processed) pinch(scale, state);
	});

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		options.onClosed?.();
		popOut(overlay, () => own.destroy());
	};
	own.add(() => {
		if (closed) return;
		closed = true;
		options.onClosed?.();
	});
	// A tap on the backdrop closes it (not a drag, not a finger of a pinch).
	let backdropPress: Vector2 | undefined;
	own.connect(backdrop.InputBegan, (input) => {
		if (isPointer(input)) backdropPress = at(input);
	});
	own.connect(backdrop.InputEnded, (input) => {
		const from = backdropPress;
		backdropPress = undefined;
		if (from === undefined || !isPointer(input) || pinching || os.clock() - pinchedAt < 0.5) return;
		if (at(input).sub(from).Magnitude <= 10) close();
	});
	own.connect(UserInputService.InputBegan, (input) => {
		if (input.KeyCode === Enum.KeyCode.Escape) close();
	});
	const closeButton = make(
		"TextButton",
		{ AutoButtonColor: true, Text: "", BackgroundColor3: COLORS.button, BorderSizePixel: 0, AnchorPoint: new Vector2(1, 0), Position: new UDim2(1, -10, 0, 10), Size: UDim2.fromOffset(36, 36), ZIndex: 95 },
		overlay,
	);
	corner(closeButton, 18);
	for (const angle of [45, -45]) {
		make("Frame", { BackgroundColor3: COLORS.text, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(14, 2), Rotation: angle, ZIndex: 96 }, closeButton);
	}
	own.connect(closeButton.Activated, close);
	apply();
	popIn(overlay);
	return close;
}
