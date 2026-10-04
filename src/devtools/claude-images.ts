import { AssetService, CaptureService, GuiService, RunService, StarterGui, UserInputService, Workspace } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { popIn, popOut } from "../ui";
import { COLORS, corner, make, style } from "./widgets";

/**
 * Images in the Claude tab (spike S11, plans/09).
 *
 * GAME → CLAUDE (screenshots):
 *   1. The dev's client takes a capture (`takeScreenshot`: CaptureService:TakeScreenshotCaptureAsync, falling back to
 *      CaptureScreenshot), with the dev menu hidden for that frame. The dev may crop it (`openCropView`, normalized
 *      0..1 coordinates; only the numbers travel).
 *   2. Op `claude.attach` {captureTime, localId?, crop?}: the game server asks the dev-server
 *      (POST /v1/attachments/capture, with game.PlaceId) to pick up the PNG Roblox wrote on the dev's PC
 *      (%LOCALAPPDATA%\Roblox\tmp-capture-storage\<userId>_<placeId>_<unixMs>.png). Only the requesting user's files,
 *      the closest time within 5 s. The dev-server keeps a cropped, downscaled copy outside the worktree and deletes it
 *      after the run.
 *   3. Fallback when no file appears (the dev plays on another PC): `uploadCapture` (StartUploadCaptureAsync, polling
 *      CheckUploadCaptureStatusAsync; the save-to-gallery prompt when the engine asks for it), then op `claude.attach`
 *      {assetId, crop?}; the dev-server downloads the asset with its Open Cloud key.
 *   The capture itself is shown only on this client (thumbnail chip, the user's bubble); its pixels never travel
 *   through the game server or MessagingService.
 *
 * CLAUDE → GAME (idea 1): an `image` event names an image Claude showed. Op `claude.image` {id} makes the game server
 * fetch it in chunks (GET /v1/images/:id?chunk=n) and push them to the requesting dev's client only, over the kernel
 * transport (CLAUDE_IMAGE_CHUNK, paced). The client joins the chunks (`ImageInbox`), decompresses them with
 * EncodingService (zstd) and draws them with EditableImage:WritePixelsBuffer. When the EditableImage can't be created
 * (the experience's "Allow Mesh / Image APIs" setting is off, the owner isn't ID-verified, or the memory budget is
 * used up) the chat shows one short dim line.
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

/**
 * A thumbnail of the capture's cropped area, `height` px tall: the whole capture, scaled and offset inside a clipped
 * frame so that only the crop shows. A camera mark stands in when this client can't show the capture.
 */
export function captureThumb(taken: TakenCapture, crop: Crop | undefined, height: number): Frame {
	const c = crop ?? FULL;
	const aspect = math.clamp((c.w * taken.aspect) / c.h, 0.3, 4);
	const frame = make("Frame", { BackgroundColor3: COLORS.dark, BorderSizePixel: 0, ClipsDescendants: true, Size: UDim2.fromOffset(math.floor(height * aspect + 0.5), height) });
	corner(frame, 6);
	const image = make(
		"ImageLabel",
		{ BackgroundTransparency: 1, BorderSizePixel: 0, ScaleType: Enum.ScaleType.Stretch, Size: UDim2.fromScale(1 / c.w, 1 / c.h), Position: UDim2.fromScale(-c.x / c.w, -c.y / c.h) },
		frame,
	);
	if (!showCapture(image, taken)) cameraMark(frame, COLORS.dim);
	return frame;
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
 * The crop view over `host`: the capture fitted in with a selection that starts as the whole capture: drag a corner to
 * resize it, drag inside it to move it (mouse or touch); Reset / Use full / Done, plus a close button that discards the
 * capture. `done` gets the
 * normalized crop (undefined = the whole capture); `cancel` runs when the dev discards it. Everything lives in `trove`.
 */
export function openCropView(host: GuiObject, trove: Trove, taken: TakenCapture, done: (crop: Crop | undefined) => void, cancel: () => void) {
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

	// Outside the selection is dimmed by four frames; the selection has an outline, a drag area (moves it) and four
	// corner handles (resize it). It starts as the whole capture. Drags use the pointer's movement since the press,
	// never absolute positions, so screen insets (top bar, IgnoreGuiInset) can't shift anything.
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

	const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
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

	// Drag: a corner (index 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right) or the whole selection.
	let drag: { corner?: number; start: Crop; from: Vector2; input: InputObject } | undefined;
	const isPointer = (input: InputObject) => input.UserInputType === Enum.UserInputType.MouseButton1 || input.UserInputType === Enum.UserInputType.Touch;
	const begin = (input: InputObject, cornerIndex?: number) => {
		if (!isPointer(input) || drag) return;
		drag = { corner: cornerIndex, start: rect, from: new Vector2(input.Position.X, input.Position.Y), input };
	};
	handles.forEach((handle, index) => own.connect(handle.InputBegan, (input) => begin(input, index)));
	own.connect(moveArea.InputBegan, (input) => begin(input));
	own.connect(UserInputService.InputChanged, (input) => {
		if (!drag) return;
		if (input.UserInputType !== Enum.UserInputType.MouseMovement && input.UserInputType !== Enum.UserInputType.Touch) return;
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
		if (!drag || !isPointer(input)) return;
		if (drag.input.UserInputType === Enum.UserInputType.Touch && input !== drag.input) return;
		drag = undefined;
	});
	const isFull = (crop: Crop) => crop.x <= 0.001 && crop.y <= 0.001 && crop.w >= 0.999 && crop.h >= 0.999;

	const close = () => {
		popOut(overlay, () => own.destroy());
	};
	const bar = make("Frame", { BackgroundTransparency: 1, AnchorPoint: new Vector2(0, 1), Position: new UDim2(0, 10, 1, -10), Size: new UDim2(1, -20, 0, 36), ZIndex: 60 }, overlay);
	make("UIListLayout", { FillDirection: Enum.FillDirection.Horizontal, HorizontalAlignment: Enum.HorizontalAlignment.Right, SortOrder: Enum.SortOrder.LayoutOrder, Padding: new UDim(0, 6) }, bar);
	const button = (text: string, order: number, color: Color3, textColor: Color3, onClick: () => void) => {
		const b = style(make("TextButton", { AutoButtonColor: true, LayoutOrder: order, ZIndex: 61 }), text, 14, textColor, Enum.Font.BuilderSansMedium);
		b.TextXAlignment = Enum.TextXAlignment.Center;
		b.TextWrapped = false;
		b.BackgroundColor3 = color;
		b.Size = UDim2.fromOffset(0, 36);
		b.AutomaticSize = Enum.AutomaticSize.X;
		corner(b, 8);
		make("UIPadding", { PaddingLeft: new UDim(0, 14), PaddingRight: new UDim(0, 14) }, b);
		b.Parent = bar;
		own.connect(b.Activated, onClick);
		return b;
	};
	button("Reset", 1, COLORS.button, COLORS.text, () => {
		rect = FULL;
		paint();
	});
	button("Use full", 2, COLORS.button, COLORS.text, () => {
		close();
		done(undefined);
	});
	button("Done", 3, COLORS.accent, COLORS.dark, () => {
		const picked = rect;
		close();
		done(isFull(picked) ? undefined : cleanCrop(picked));
	});
	// Discard: a round "x" at the top right.
	const discard = make(
		"TextButton",
		{ AutoButtonColor: true, Text: "", BackgroundColor3: COLORS.button, BorderSizePixel: 0, AnchorPoint: new Vector2(1, 0), Position: new UDim2(1, -14, 0, 14), Size: UDim2.fromOffset(32, 32), ZIndex: 66 },
		overlay,
	);
	corner(discard, 16);
	for (const angle of [45, -45]) {
		make("Frame", { BackgroundColor3: COLORS.text, BorderSizePixel: 0, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: UDim2.fromOffset(14, 2), Rotation: angle, ZIndex: 67 }, discard);
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

/**
 * The enlarged view of an image over `host` (tap anywhere to close). `paint` puts the picture into the ImageLabel
 * (an EditableImage's content, or a capture).
 */
export function enlargeImage(host: GuiObject, trove: Trove, aspect: number, paint: (image: ImageLabel) => void) {
	const own = trove.extend();
	const overlay = make(
		"TextButton",
		{ Name: "ImageView", AutoButtonColor: false, Text: "", BackgroundColor3: Color3.fromRGB(0, 0, 0), BackgroundTransparency: 0.15, BorderSizePixel: 0, Size: UDim2.fromScale(1, 1), ZIndex: 70 },
		host,
	);
	own.add(overlay);
	const image = make(
		"ImageLabel",
		{ BackgroundTransparency: 1, AnchorPoint: new Vector2(0.5, 0.5), Position: UDim2.fromScale(0.5, 0.5), Size: new UDim2(1, -24, 1, -24), ScaleType: Enum.ScaleType.Stretch, ZIndex: 71 },
		overlay,
	);
	make("UIAspectRatioConstraint", { AspectRatio: aspect }, image);
	corner(image, 8);
	paint(image);
	own.connect(overlay.Activated, () => popOut(overlay, () => own.destroy()));
	popIn(overlay);
}
