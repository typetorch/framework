import { DataStoreService, HttpService, MemoryStoreService, MessagingService, Players } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $print, $warn } from "rbxts-transform-debug";
import type { LogEntry, ServerKernel } from "../kernel";
import type { ServerDispatcher } from "../net/runtime";
import {
	CLAUDE_TOOL_REQUEST,
	CLAUDE_TOOL_RESPONSE,
	capLogText,
	findTool,
	formatLogHistory,
	inspectTool,
	loadstringAvailable,
	playerList,
	runLuau,
	toJson,
} from "./claude-tools";
import type {
	ClaudeApproval,
	ClaudeConversation,
	ClaudeConversationSummary,
	ClaudeEvent,
	ClaudeEventKind,
	ClaudeEventsReply,
	ClaudeFileChange,
	ClaudeMessage,
	ClaudeMode,
	ClaudePromptRequest,
	ClaudeProposal,
	ClaudeRequestView,
	ClaudeSessionView,
	ClaudeToolboxOptions,
	DevOp,
} from "./protocol";
import { CLAUDE_IMAGE_CHUNK, cleanAttachmentIds, cleanCrop, cleanImageMeta, decodeImageChunk } from "./claude-images";
import { ToolboxGate, cleanTiles, insertsFor, newToolboxStore, removeToolboxInsert, toolboxInsert, type ToolboxAsk, type ToolboxStore } from "./toolbox-server";
import { CODE_ALPHABET, CODE_LENGTH, CODE_SECRET_LENGTH, codeFingerprint, sha256 } from "./sha256";

/**
 * Game side of `typetorch remote-claude` (plans/11). A dev's machine announces a session over MessagingService; this
 * server keeps it only when its effective channel is "dev" and its branch is the session branch, and forwards prompts.
 *
 * AUTH (pairing, no Roblox Secrets Store): a dev pastes the pairing code printed by typetorch-dev-server into the
 * Claude tab (op `claude.pair`). The server trades it at `POST {url}/v1/token` `{grant: "code", sid, user, job,
 * branch, code}` for `{access_token, expires_in, refresh_token, refresh_expires_in}`. The refresh token is kept per
 * user in the kernel persist store (server memory; survives the swaps Claude's own deploys cause) and traded for new
 * access tokens with `{grant: "refresh", sid, user, job, branch, refresh_token}`. Without either: `needs_pairing`.
 *
 * SECRECY: the session URL, the pairing code and every token stay in server memory. They are never sent to a client,
 * never printed (server logs reach dev clients through the Logs tab) and never put in attributes. HTTP failures are
 * reported as short codes only, because Roblox error text can contain the URL.
 *
 * CHAT: prompts belong to conversations on the dev machine (a follow-up resumes the same Claude Code session). The
 * client polls "claude.events" about once a second while a prompt runs; replies are re-checked here field by field
 * (types, lengths, counts) before they reach a client. "claude.conversations" / "claude.conversation" reopen a chat
 * after a swap or a rejoin; the dev machine only shows a user their own conversations.
 *
 * GAME TOOLS: Claude's game tools (run_luau, game_logs, inspect, find, game_status) act on the server that sent the
 * prompt. The dev machine publishes a wake message on TypeTorch/tool {v, s, j, x, u} (no code); this server also
 * polls GET /v1/game/pending while a dev's prompt runs. A request is served only when: this server's effective channel
 * is "dev", j is this server's JobId, s is the session, u is in the session's users, is in this server, is still a
 * dev and is paired here. The request itself is fetched with that user's token (the dev machine checks user AND job).
 *
 * TRANSPORT (2026-10-04): one HTTP long-poll per paired dev, GET /v1/game/poll?since=<cursor> (held up to 20 s by the
 * dev machine), carries the streamed events of the prompts this server sent plus the tool requests for this JobId.
 * It runs only while the dev is here, paired, and has a run going or the Claude tab open; it backs off with jitter on
 * errors and stops with the session or the generation. "claude.events" answers from what the poll brought (falling
 * back to GET /v1/prompts/:id?since for anything the cache doesn't hold). The wake message on TypeTorch/tool is only for
 * when no poll is open.
 * run_luau needs the dev's approval in their chat (or "always" for that chat) and LoadStringEnabled; every run is
 * logged (description and outcome, never the code) and the last 20 are kept.
 *
 * TOOLBOX (plans/14): claude.prompt forwards `toolbox: true` only when the dev picked "Toolbox" in the "+" menu for that
 * message, and records the prompt id (ToolboxGate). A toolbox_insert request is served only for such a prompt and only
 * for an asset id that a toolbox_results event of the conversation carried through this server; each insert shows its
 * own approval card (Insert / Deny, no "always"; claude.approve with {anchor, keepScripts}); toolbox-server.ts loads,
 * sanitizes and places it. "claude.toolboxRemove" removes an insert (its inserter only).
 *
 * TUNNEL BINDING (security audit H1). Announcements come from MessagingService or the MemoryStore share, and anything
 * that can run code in this universe can write both, so every announcement goes through onMessage's checks:
 *   - the URL must be exactly https://<name>.trycloudflare.com;
 *   - a session id is bound to the first URL heard for it; a later message with another URL is ignored (the dev
 *     server starts a new session id after a tunnel restart, and the dev pairs again);
 *   - a different session id replaces the current one only when the current one expired or has no pairing here;
 *   - "closed" counts only with the matching session id and URL.
 * Tokens are bound to the URL they came from (Pairing.url, the cached access token's URL) and only ever sent to it.
 * A pairing code's last 4 symbols are an HMAC of the tunnel hostname keyed by the rest of the code (sha256.ts
 * codeFingerprint): claude.pair refuses a code whose fingerprint doesn't match the session URL, so a code never goes to
 * a URL it wasn't printed for.
 *
 * TOKENS (audit M5): codes are single use on the dev machine, and every refresh returns a new refresh token (the old
 * one dies; reusing it revokes the pairing). The refresh tokens live in the kernel persist store, which any code of
 * this generation can reach through the kernel; run_luau gets no kernel and no persist (claude-tools.ts), and code
 * serving one user only ever reads that user's pairing (tokenFor, authed).
 *
 * MODES AND DEPLOYS: claude.prompt sends mode "live" (default: run_luau with approval, no file edits) or "code" (file
 * edits; read-only game tools). A code run that changed files waits for Deploy / Discard: op "claude.deploy" passes
 * the requester's decision to the dev machine, which checks it is the requester.
 *
 * LOGS: "My logs" (the client's log history, sent by the client) and "Server logs" (this server's kernel log ring) go
 * to the dev machine as untrusted context, about 64 KB each, newest kept; the dev machine keeps them for that run only.
 *
 * AUDIT (audit M4): every run_luau decision leaves a best-effort DataStore record "TypeTorch"
 * audit/<yyyy-mm-dd>/<JobId>/<n>: who, when, description, SHA-256 of the code and the outcome. Never the code.
 */

const TOPIC = "TypeTorch/remote-claude";
const PERSIST_KEY = "remoteClaude";
const MAX_PROMPT = 4000;
const MAX_CONTEXT_BYTES = 12 * 1024;
const MAX_PATH = 1024;
const RATE_WINDOW = 600;
const RATE_MAX = 10;
const MAX_RECORDS = 20;
const VISIBLE_RECORDS = 10;
const TOKEN_MARGIN = 60;
const MAX_CODE = 64;
const MAX_TOKEN = 4096;
/** Pairing attempts per user per minute (the dev-server limits too). */
const PAIR_MAX = 5;
const PAIR_WINDOW = 60;
const FINISHED_STATES = new Set(["deployed", "discarded", "answered", "failed", "cancelled", "lost"]);
const EVENT_KINDS = new Set<string>(["assistant_text", "tool_use", "tool_result", "status", "error", "deploy_proposal", "image", "toolbox_results"]);
const PROPOSAL_STATUSES = new Set<string>(["pending", "deploying", "awaiting_approval", "deployed", "discarded", "expired", "rejected", "approval_expired", "failed"]);
const MAX_PROPOSAL_FILES = 50;
/** Session ids remembered with their URL (a sid is bound to the first URL heard for it). */
const MAX_BOUND_SIDS = 50;
/** The kernel registry DataStore; run_luau audit records go under audit/. */
const AUDIT_STORE = "TypeTorch";
/** Lines read from the kernel log ring for "Server logs" (the ring holds 500). */
const SERVER_LOG_LINES = 500;
/** Events relayed per "claude.events" reply (the dev machine pages at 300). */
const MAX_EVENTS = 300;
const MAX_EVENT_TEXT = 4000;
/** Characters of event text in one "claude.conversation" reply; older messages lose their events past it. */
const CONVERSATION_TEXT_BUDGET = 120_000;
const MAX_MESSAGES = 30;
const MAX_CONVERSATIONS = 20;
const TOOL_TOPIC = "TypeTorch/tool";
/** A dev's chat counts as open this long after its last claude.* op. */
const CHAT_OPEN_WINDOW = 20;
/** Runs older than this don't keep the poll going. */
const RUN_WINDOW = 30 * 60;
/** Events kept per prompt in the poll cache. */
const CACHE_EVENTS = 3000;
const APPROVAL_SECONDS = 60;
const CLIENT_TOOL_TIMEOUT = 10;
const MAX_EXEC_LOG = 20;
const LOADSTRING_HELP =
	"loadstring is unavailable on this server: the kernel place needs ServerScriptService.LoadStringEnabled (republish the TypeTorch kernel 0.2 place)";

interface Session {
	sid: string;
	branch: string;
	users: number[];
	url: string;
	exp: number;
}

interface RequestRecord {
	id: string;
	sid: string;
	user: number;
	by: string;
	prompt: string;
	state: string;
	finished: boolean;
	createdAt: number;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	log?: string[];
	/** Added with chats: records from older generations lack it. */
	conversationId?: string;
}

/** A user's refresh token for one session. Server memory only. */
interface Pairing {
	sid: string;
	/** The tunnel URL the token came from; it is only ever sent there. Pairings from before H1 lack it (dropped). */
	url?: string;
	token: string;
	/** Unix time; 0 = no expiry given. */
	exp: number;
}

/** Kept in the kernel persist store, so it survives swaps (including the one Claude's own deploy causes). */
interface Store {
	session?: Session;
	requests: RequestRecord[];
	/** userId -> unix times of accepted prompts (rate limit). */
	sent: Map<number, number[]>;
	/** userId -> refresh token from pairing (added later: stores from older generations lack it). */
	pairings?: Map<number, Pairing>;
	/** "<userId>:<conversationId>" -> true: run_luau runs without asking in that chat (added later). */
	alwaysRun?: Map<string, boolean>;
	/** The last run_luau runs: who, what, outcome (never the code). Added later. */
	execs?: { at: number; user: number; description: string; ok: boolean; error?: string }[];
	/** Session id -> the first URL heard for it (security audit H1). Added later. */
	boundUrls?: Map<string, string>;
	/** run_luau audit records written by this server (the <n> of audit/<date>/<JobId>/<n>). Added later. */
	auditSeq?: number;
	/** Creator Store gate (prompts sent with the Toolbox chip, relayed result ids) and inserts (plans/14). Added later. */
	toolbox?: ToolboxStore;
}

/** What the dev's server-side tools need from the devtools server. */
export interface ClaudeToolDeps {
	dispatcher: ServerDispatcher;
	/** The player's client logs (Logs > Others path): [ok, entries or error]. */
	clientLogs: (target: Player, since: number) => [ok: boolean, result: unknown];
}

type Failure = { ok: false; error: string };
type HttpResult = { ok: true; data: unknown } | Failure;

function fail(code: string): Failure {
	return { ok: false, error: code };
}

function matches(text: string, pattern: string): boolean {
	return text.match(pattern)[0] !== undefined;
}

function shortString(value: unknown, max: number): string | undefined {
	return typeIs(value, "string") ? value.sub(1, max) : undefined;
}

function shortNumber(value: unknown): number | undefined {
	return typeIs(value, "number") && value === value && value !== math.huge && value !== -math.huge ? value : undefined;
}

/** Dev-server prompt ids are 22 base64url characters; conversation ids too. */
function isServerId(value: unknown): value is string {
	return typeIs(value, "string") && value.size() === 22 && matches(value, "^[%w_%-]+$");
}

/** Items of a JSON array (or nothing), in order. */
function listOf(value: unknown): unknown[] {
	return typeIs(value, "table") ? (value as unknown[]) : [];
}

function cleanEvent(raw: unknown): ClaudeEvent | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const data = raw as Record<string, unknown>;
	const index = shortNumber(data.i);
	const kind = data.kind;
	const text = data.text;
	if (index === undefined || !typeIs(kind, "string") || !EVENT_KINDS.has(kind) || !typeIs(text, "string")) return undefined;
	const event: ClaudeEvent = { i: index, kind: kind as ClaudeEventKind, text: text.sub(1, MAX_EVENT_TEXT) };
	const tool = shortString(data.tool, 40);
	if (tool !== undefined) event.tool = tool;
	const target = shortString(data.target, 200);
	if (target !== undefined) event.target = target;
	const block = shortNumber(data.block);
	if (block !== undefined) event.block = block;
	const state = shortString(data.state, 20);
	if (state !== undefined) event.state = state;
	const detail = shortString(data.detail, 2000);
	if (detail !== undefined) event.detail = detail;
	const ref = data.ref;
	if (typeIs(ref, "string") && ref.size() <= 64 && matches(ref, "^[%w_%-]+$")) event.ref = ref;
	const commit = data.commit;
	if (typeIs(commit, "string") && commit.size() <= 40 && matches(commit, "^%x+$")) event.commit = commit;
	const files = cleanFiles(data.files);
	if (files !== undefined) event.files = files;
	const expiresAt = shortNumber(data.expiresAt);
	if (expiresAt !== undefined) event.expiresAt = expiresAt;
	if (kind === "image") {
		// An image Claude showed: without a valid meta there is nothing to fetch, so the event is dropped.
		const image = cleanImageMeta(data.image);
		if (!image) return undefined;
		event.image = image;
		event.text = event.text.sub(1, 200);
	}
	if (kind === "toolbox_results") {
		// Creator Store result cards: strangers' text, re-checked field by field (toolbox-server.ts cleanTile).
		const tiles = cleanTiles(data.tiles);
		if (!tiles) return undefined;
		event.tiles = tiles;
		event.text = event.text.sub(1, 120);
	}
	return event;
}

function cleanFiles(raw: unknown): ClaudeFileChange[] | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const files = new Array<ClaudeFileChange>();
	for (const item of listOf(raw)) {
		if (files.size() >= MAX_PROPOSAL_FILES || !typeIs(item, "table")) continue;
		const file = item as Record<string, unknown>;
		const path = shortString(file.path, 160);
		const added = shortNumber(file.added);
		const removed = shortNumber(file.removed);
		if (path !== undefined && added !== undefined && removed !== undefined) files.push({ path, added: math.floor(added), removed: math.floor(removed) });
	}
	return files;
}

/** A proposal from the dev machine, field by field. */
function cleanProposal(raw: unknown): ClaudeProposal | undefined {
	if (!typeIs(raw, "table")) return undefined;
	const data = raw as Record<string, unknown>;
	const status = data.status;
	const commit = data.commit;
	const expiresAt = shortNumber(data.expiresAt);
	if (!typeIs(status, "string") || !PROPOSAL_STATUSES.has(status) || !typeIs(commit, "string") || !matches(commit, "^%x+$") || expiresAt === undefined) {
		return undefined;
	}
	const approvalId = data.approvalId;
	return {
		status: status as ClaudeProposal["status"],
		approvalId: typeIs(approvalId, "string") && approvalId.size() === 8 && matches(approvalId, "^%x+$") ? approvalId : undefined,
		commit: commit.sub(1, 40),
		expiresAt,
		files: cleanFiles(data.files) ?? [],
		error: shortString(data.error, 300),
	};
}

/** The ids of a message's attachments ([{id, width, height}] from the dev machine). */
function attachmentIdsOf(raw: unknown): string[] | undefined {
	const ids = new Array<string>();
	for (const item of listOf(raw)) {
		const id = typeIs(item, "table") ? (item as { id?: unknown }).id : undefined;
		if (typeIs(id, "string") && id.size() === 32 && matches(id, "^%x+$") && ids.size() < 4) ids.push(id);
	}
	return ids.size() > 0 ? ids : undefined;
}

function cleanMode(raw: unknown): ClaudeMode | undefined {
	return raw === "live" || raw === "code" ? raw : undefined;
}

function cleanEvents(raw: unknown, max: number): ClaudeEvent[] {
	const events = new Array<ClaudeEvent>();
	for (const item of listOf(raw)) {
		if (events.size() >= max) break;
		const event = cleanEvent(item);
		if (event) events.push(event);
	}
	return events;
}

function isFinished(state: string | undefined, finishedAt: unknown): boolean {
	return (state !== undefined && FINISHED_STATES.has(state)) || finishedAt !== undefined;
}

/** Only a Cloudflare Quick Tunnel origin: https://<name>.trycloudflare.com, nothing else (security audit H1). */
function cleanUrl(value: unknown): string | undefined {
	if (!typeIs(value, "string") || value.size() > 200) return undefined;
	return matches(value, "^https://[a-z0-9%-]+%.trycloudflare%.com$") ? value : undefined;
}

/** "abc-def.trycloudflare.com" from a cleaned URL. */
function hostOf(url: string): string {
	return url.sub(9);
}

/** Uppercase, spaces and dashes removed; undefined unless it is 24 symbols of the code alphabet. */
function normalizeCode(raw: string): string | undefined {
	const code = raw.upper().gsub("[%s%-]", "")[0];
	if (code.size() !== CODE_LENGTH) return undefined;
	for (let index = 1; index <= code.size(); index++) {
		if (CODE_ALPHABET.find(code.sub(index, index), 1, true)[0] === undefined) return undefined;
	}
	return code;
}

function httpError(status: number): string {
	if (status === 400) return "bad_request";
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 413) return "too_large";
	if (status === 423) return "code_busy";
	if (status === 429) return "remote_rate_limited";
	if (status >= 500) return "remote_error";
	return `http_${status}`;
}

function decode(body: string): unknown {
	if (body === "") return undefined;
	const [ok, data] = pcall(() => HttpService.JSONDecode(body));
	return ok ? data : undefined;
}

function encodedSize(value: unknown): number {
	const [ok, json] = pcall(() => HttpService.JSONEncode(value));
	return ok ? json.size() : math.huge;
}

export function registerRemoteClaude(kernel: ServerKernel, trove: Trove, ops: Map<string, DevOp>, deps?: ClaudeToolDeps) {
	const store = kernel.persist<Store>(PERSIST_KEY, () => ({ requests: [], sent: new Map(), pairings: new Map() }));
	if (store.pairings === undefined) store.pairings = new Map();
	const pairings = store.pairings;
	if (store.toolbox === undefined) store.toolbox = newToolboxStore();
	const toolboxStore = store.toolbox;
	/** Gate 2 of plans/14: prompts this server sent with the Toolbox chip, and the ids their searches returned. */
	const toolboxGate = new ToolboxGate(toolboxStore);
	/** Remembers the asset ids of relayed toolbox_results events for the prompt's conversation. */
	const noteToolboxResults = (conversationId: string | undefined, promptId: string, events: ClaudeEvent[]) => {
		for (const event of events) {
			if (event.kind !== "toolbox_results" || !event.tiles) continue;
			toolboxGate.rememberResults(conversationId ?? promptId, event.tiles.map((tile) => tile.id));
		}
	};
	/** The player's toolbox inserts for a prompt still in the server (the inserted cards with Remove). */
	const toolboxInsertsFor = (player: Player, promptId: string) => {
		const list = insertsFor(toolboxStore, player.UserId, promptId);
		return list.size() > 0 ? list : undefined;
	};
	/** run_luau snippets waiting for a player's approval (set up in the game tools section below). */
	let approvalsFor: (player: Player) => ClaudeApproval[] | undefined = () => undefined;
	/** What the long-poll brought per prompt: contiguous events from `start`, and the prompt's latest fields. */
	interface PromptCache {
		start: number;
		events: ClaudeEvent[];
		fields?: Record<string, unknown>;
	}
	const cache = new Map<string, PromptCache>();
	/** userId -> os.clock() of their last claude.* op (the chat is open). */
	const lastSeen = new Map<number, number>();
	// userId -> [access token, expires at (unix), the URL it came from]. Generation memory only: never persisted, sent
	// or printed, and only ever sent to that URL.
	const tokens = new Map<number, [string, number, string]>();
	if (store.boundUrls === undefined) store.boundUrls = new Map();
	const boundUrls = store.boundUrls;
	// Pairings from before tunnel binding have no URL: they can't be checked, so they go (the dev pairs again).
	for (const [userId, pairing] of pairings) if (pairing.url === undefined) pairings.delete(userId);
	const exchanging = new Set<number>();
	// userId -> unix times of pairing attempts (generation memory).
	const pairAttempts = new Map<number, number[]>();

	/** Drops tokens of other sessions (a new session invalidates every pairing). */
	const forgetOtherSessions = (sid: string | undefined) => {
		tokens.clear();
		for (const [userId, pairing] of pairings) {
			if (pairing.sid !== sid) pairings.delete(userId);
		}
	};

	const usable = (session: Session | undefined): session is Session =>
		session !== undefined && kernel.channel === "dev" && session.branch === kernel.branch;

	// A session for another branch (the server switched branches) or a prod-channel generation is dropped.
	if (store.session && !usable(store.session)) store.session = undefined;
	// A session kept by an older generation: only a tunnel URL, and its sid stays bound to that URL.
	if (store.session && cleanUrl(store.session.url) === undefined) store.session = undefined;
	if (store.session && !boundUrls.has(store.session.sid)) boundUrls.set(store.session.sid, store.session.url);

	const activeSession = (): Session | undefined => {
		const session = store.session;
		return usable(session) && session.exp > os.time() ? session : undefined;
	};

	// Session messages ----------------------------------------------------------------------------------------------
	// The last announcement per branch, in MemoryStore until it expires (at most ANNOUNCE TTL, 120 s). Same checks
	// as a broadcast on read (onMessage); MemoryStore is writable by game servers like MessagingService is.
	const discovery = () => MemoryStoreService.GetHashMap("TypeTorchClaude");
	const shareSession = (announcement: Record<string, unknown>) => {
		const ttl = (announcement.exp as number) - os.time();
		if (ttl < 5) return;
		task.spawn(() => {
			const [ok, err] = pcall(() => discovery().SetAsync(`session/${kernel.branch}`, announcement, math.min(ttl, 300)));
			if (!ok) $warn(`[remote-claude] could not share the session: ${err}`);
		});
	};
	/** True when some user of this server holds a pairing for session sid. */
	const pairedTo = (sid: string) => {
		for (const [, pairing] of pairings) if (pairing.sid === sid) return true;
		return false;
	};
	let warnedUrlChange = false;
	// Every announcement (broadcast or MemoryStore share) goes through here: see TUNNEL BINDING in the header.
	const onMessage = (raw: unknown, fromBroadcast = true) => {
		let data = raw;
		if (typeIs(raw, "string")) data = decode(raw);
		if (!typeIs(data, "table")) return;
		const message = data as Record<string, unknown>;
		const sid = message.s;
		if (message.v !== 1 || !typeIs(sid, "string") || !matches(sid, "^[0-9a-f]+$") || sid.size() !== 32) return;
		const url = cleanUrl(message.url);
		if (message.closed === true) {
			// Only the session's own URL can close it.
			if (store.session?.sid === sid && url !== undefined && store.session.url === url) {
				store.session = undefined;
				forgetOtherSessions(undefined);
			}
			return;
		}
		const branch = message.b;
		const exp = message.exp;
		if (!typeIs(branch, "string") || branch.size() > 64 || !typeIs(exp, "number") || url === undefined) return;
		// Only dev-channel servers on the session branch keep it; everyone else drops it unread.
		if (kernel.channel !== "dev" || branch !== kernel.branch || exp <= os.time()) return;
		if (!typeIs(message.u, "table")) return;
		// A session id keeps the first URL heard for it: a re-announcement with another URL is ignored, never followed.
		const bound = boundUrls.get(sid);
		if (bound !== undefined && bound !== url) {
			if (!warnedUrlChange) {
				warnedUrlChange = true;
				$warn(`[remote-claude] ignored an announcement that changes the URL of session ${sid.sub(1, 8)} (a tunnel restart gets a new session id)`);
			}
			return;
		}
		// Another session id doesn't push out a live session that devs here are paired with.
		const current = store.session;
		if (current !== undefined && current.sid !== sid && current.exp > os.time() && pairedTo(current.sid)) return;
		const users = new Array<number>();
		for (const [, user] of pairs(message.u as object)) {
			if (typeIs(user, "number") && user > 0 && user % 1 === 0 && users.size() < 100) users.push(user);
		}
		if (bound === undefined) {
			if (boundUrls.size() >= MAX_BOUND_SIDS) {
				// Keep only the current session's binding; old sessions are long gone.
				for (const [known] of boundUrls) if (known !== current?.sid) boundUrls.delete(known);
			}
			boundUrls.set(sid, url);
		}
		if (store.session?.sid !== sid) forgetOtherSessions(sid);
		const fresh = store.session?.sid !== sid || store.session.exp !== exp;
		store.session = { sid, branch, users, url, exp };
		// Share it, so a server that starts between announcements (every 60 s) finds the session at once.
		if (fresh && fromBroadcast) shareSession({ v: 1, s: sid, b: branch, u: users, url, exp });
	};

	if (kernel.channel === "dev") {
		let stopped = false;
		let connection: RBXScriptConnection | undefined;
		trove.add(() => {
			stopped = true;
			connection?.Disconnect();
		});
		// Not in the trove: a cancelled SubscribeAsync would leave a subscription nobody can disconnect.
		task.spawn(() => {
			const [ok, result] = pcall(() =>
				MessagingService.SubscribeAsync(TOPIC, (message) => {
					if (!stopped) onMessage(message.Data);
				}),
			);
			if (!ok) {
				$warn(`[remote-claude] session messages unavailable: ${result}`);
				return;
			}
			if (stopped) result.Disconnect();
			else connection = result;
		});
		// A new server: take the last shared announcement instead of waiting up to a minute for the next one.
		if (activeSession() === undefined) {
			task.spawn(() => {
				const [ok, value] = pcall(() => discovery().GetAsync(`session/${kernel.branch}`));
				if (ok && value !== undefined && !stopped && activeSession() === undefined) onMessage(value, false);
			});
		}
	}
	// Until the first announcement could have arrived, "no session" means "still looking", not "not running".
	const searchUntil = os.clock() + 75;

	// HTTP ------------------------------------------------------------------------------------------------------------
	const send = (
		session: Session,
		method: "GET" | "POST",
		path: string,
		headers: Record<string, string>,
		body?: unknown,
	): [sent: boolean, status: number, data: unknown] => {
		const request: RequestAsyncRequest = { Url: `${session.url}${path}`, Method: method, Headers: headers };
		if (body !== undefined) request.Body = HttpService.JSONEncode(body);
		const [ok, response] = pcall(() => HttpService.RequestAsync(request));
		// Never log or return the error text: it can contain the URL.
		if (!ok) return [false, 0, undefined];
		return [true, response.StatusCode, decode(response.Body)];
	};

	/**
	 * `POST /v1/token` (no Authorization header; the grant carries the credential). Stores the access token and, when
	 * the reply has one, the (rotated) refresh token. Returns [ok, access token or error code, HTTP status].
	 */
	const grant = (
		session: Session,
		userId: number,
		body: Record<string, unknown>,
	): [ok: boolean, tokenOrError: string, status: number] => {
		const [sent, status, data] = send(
			session,
			"POST",
			"/v1/token",
			{ "Content-Type": "application/json" },
			{ ...body, sid: session.sid, user: userId, job: game.JobId, branch: session.branch },
		);
		if (!sent) return [false, "unreachable", 0];
		if (status !== 200) return [false, httpError(status), status];
		const reply = (typeIs(data, "table") ? data : {}) as Record<string, unknown>;
		const token = reply.access_token;
		const expiresIn = reply.expires_in;
		if (!typeIs(token, "string") || token.size() > MAX_TOKEN || !typeIs(expiresIn, "number")) {
			return [false, "bad_reply", status];
		}
		tokens.set(userId, [token, os.time() + expiresIn, session.url]);
		// Every grant returns a new refresh token (rotation): the old one is dead now, so it is replaced at once.
		const refresh = reply.refresh_token;
		if (typeIs(refresh, "string") && refresh.size() <= MAX_TOKEN) {
			const refreshIn = reply.refresh_expires_in;
			pairings.set(userId, { sid: session.sid, url: session.url, token: refresh, exp: typeIs(refreshIn, "number") ? os.time() + refreshIn : 0 });
		}
		return [true, token, status];
	};

	const pairingFor = (session: Session, userId: number): Pairing | undefined => {
		const pairing = pairings.get(userId);
		if (!pairing) return undefined;
		// Bound to the session and the URL it came from: a token never goes anywhere else.
		if (pairing.sid !== session.sid || pairing.url !== session.url || (pairing.exp !== 0 && pairing.exp <= os.time())) {
			pairings.delete(userId);
			return undefined;
		}
		return pairing;
	};

	/** The cached access token when it is still good and was issued by this session's URL. */
	const cachedToken = (session: Session, userId: number): string | undefined => {
		const cached = tokens.get(userId);
		if (cached && cached[2] === session.url && cached[1] - TOKEN_MARGIN > os.time()) return cached[0];
		return undefined;
	};

	const isPaired = (session: Session, userId: number): boolean => {
		if (cachedToken(session, userId) !== undefined) return true;
		return pairingFor(session, userId) !== undefined;
	};

	/** Cached access token, else the refresh grant, else `needs_pairing`. */
	const tokenFor = (session: Session, userId: number): [ok: boolean, tokenOrError: string] => {
		while (exchanging.has(userId)) task.wait(0.1);
		const cached = cachedToken(session, userId);
		if (cached !== undefined) return [true, cached];
		tokens.delete(userId);
		const pairing = pairingFor(session, userId);
		if (!pairing) return [false, "needs_pairing"];
		exchanging.add(userId);
		const [ok, tokenOrError, status] = grant(session, userId, { grant: "refresh", refresh_token: pairing.token });
		exchanging.delete(userId);
		if (ok) return [true, tokenOrError];
		if (status === 401 || status === 403) {
			// Revoked or expired on the dev machine: pair again.
			pairings.delete(userId);
			return [false, "needs_pairing"];
		}
		return [false, tokenOrError];
	};

	/** An authenticated call as `userId`. Re-exchanges the token once after a 401. */
	const authed = (session: Session, userId: number, method: "GET" | "POST", path: string, body?: unknown): HttpResult => {
		for (let attempt = 1; attempt <= 2; attempt++) {
			const [tokenOk, token] = tokenFor(session, userId);
			if (!tokenOk) return fail(token);
			const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-TT-Job": game.JobId };
			if (method === "POST") {
				headers["X-TT-Nonce"] = HttpService.GenerateGUID(false);
				headers["X-TT-Timestamp"] = tostring(os.time());
			}
			if (body !== undefined) headers["Content-Type"] = "application/json";
			const [sent, status, data] = send(session, method, path, headers, body);
			if (!sent) return fail("unreachable");
			if (status === 401 && attempt === 1) {
				tokens.delete(userId);
				continue;
			}
			if (status >= 200 && status < 300) return { ok: true, data };
			return fail(httpError(status));
		}
		return fail("unauthorized");
	};

	// Records ---------------------------------------------------------------------------------------------------------
	const view = (record: RequestRecord, player: Player): ClaudeRequestView => ({
		conversationId: record.conversationId,
		id: record.id,
		state: record.state,
		prompt: record.prompt,
		by: record.by,
		mine: record.user === player.UserId,
		finished: record.finished,
		summary: record.summary,
		commit: record.commit,
		artifactId: record.artifactId,
		error: record.error,
		log: record.log,
	});

	const find = (session: Session, id: unknown): RequestRecord | undefined => {
		if (!typeIs(id, "string") || id.size() > 64 || !matches(id, "^[%w_%-]+$")) return undefined;
		return store.requests.find((record) => record.id === id && record.sid === session.sid);
	};

	const apply = (record: RequestRecord, data: unknown) => {
		if (!typeIs(data, "table")) return;
		const reply = data as Record<string, unknown>;
		record.state = shortString(reply.state, 20) ?? record.state;
		record.summary = shortString(reply.summary, 300) ?? record.summary;
		record.commit = shortString(reply.commit, 64) ?? record.commit;
		record.artifactId = shortString(reply.artifactId, 128) ?? record.artifactId;
		record.error = shortString(reply.error, 300) ?? record.error;
		if (typeIs(reply.log, "table")) {
			const log = new Array<string>();
			for (const [, line] of pairs(reply.log as object)) {
				if (typeIs(line, "string") && log.size() < 20) log.push(line.sub(1, 200));
			}
			record.log = log;
		}
		record.finished = isFinished(record.state, reply.finishedAt);
	};

	const refresh = (session: Session, record: RequestRecord, userId: number): HttpResult => {
		const result = authed(session, userId, "GET", `/v1/prompts/${record.id}`);
		if (result.ok) apply(record, result.data);
		else if (result.error === "not_found") {
			record.state = "lost";
			record.finished = true;
		}
		return result;
	};

	// Ops -------------------------------------------------------------------------------------------------------------
	ops.set("claude.session", (player): ClaudeSessionView => {
		lastSeen.set(player.UserId, os.clock());
		const session = activeSession();
		if (!session) {
			return { available: false, searching: os.clock() < searchUntil, allowed: false, branch: kernel.branch, label: "", requests: [] };
		}
		const allowed = session.users.includes(player.UserId);
		const requests = new Array<ClaudeRequestView>();
		if (allowed) {
			for (let index = store.requests.size() - 1; index >= 0 && requests.size() < VISIBLE_RECORDS; index--) {
				const record = store.requests[index];
				if (record.sid === session.sid) requests.push(view(record, player));
			}
		}
		return {
			available: true,
			allowed,
			paired: allowed && isPaired(session, player.UserId),
			branch: session.branch,
			label: session.sid.sub(1, 8),
			requests,
		};
	});

	// Pairing: trade the code printed by typetorch-dev-server for this player's tokens. The code is never logged.
	ops.set("claude.pair", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = activeSession();
		if (!session) return fail("not_connected");
		if (!session.users.includes(player.UserId)) return fail("not_allowed");
		const raw = typeIs(payload, "table") ? (payload as { code?: unknown }).code : payload;
		if (!typeIs(raw, "string") || raw.size() > MAX_CODE * 2) return fail("bad_code");
		const now = os.time();
		const attempts = (pairAttempts.get(player.UserId) ?? []).filter((at) => now - at < PAIR_WINDOW);
		if (attempts.size() >= PAIR_MAX) return fail("rate_limited");
		attempts.push(now);
		pairAttempts.set(player.UserId, attempts);
		const code = normalizeCode(raw);
		if (code === undefined) return fail("bad_code");
		// The code's last 4 symbols fingerprint the tunnel it was printed for (security audit H1): a code for another URL
		// is never sent anywhere, so a re-announced or spoofed session can't collect it.
		if (codeFingerprint(code.sub(1, CODE_SECRET_LENGTH), hostOf(session.url)) !== code.sub(CODE_SECRET_LENGTH + 1)) {
			$warn(`[remote-claude] ${player.Name} entered a pairing code for another tunnel; it was not sent`);
			return fail("code_mismatch");
		}
		while (exchanging.has(player.UserId)) task.wait(0.1);
		exchanging.add(player.UserId);
		const [ok, tokenOrError, status] = grant(session, player.UserId, { grant: "code", code });
		exchanging.delete(player.UserId);
		if (ok) {
			pairAttempts.delete(player.UserId);
			return { ok: true };
		}
		if (status === 400 || status === 401 || status === 404) return fail("bad_code");
		if (status === 403) return fail("not_allowed");
		if (status === 429) return fail("rate_limited");
		return fail(tokenOrError);
	});

	ops.set("claude.unpair", (player) => {
		tokens.delete(player.UserId);
		pairings.delete(player.UserId);
		return { ok: true };
	});

	ops.set("claude.prompt", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = activeSession();
		if (!session) return fail("not_connected");
		if (!session.users.includes(player.UserId)) return fail("not_allowed");

		const request = (typeIs(payload, "string") ? { prompt: payload } : payload) as Partial<ClaudePromptRequest>;
		if (!typeIs(request, "table") || !typeIs(request.prompt, "string")) return fail("bad_request");
		const conversationId = request.conversationId;
		if (conversationId !== undefined && !isServerId(conversationId)) return fail("bad_request");
		const prompt = request.prompt.match("^%s*(.-)%s*$")[0] as string;
		if (prompt === "") return fail("empty");
		if (prompt.size() > MAX_PROMPT) return fail("too_long");

		const mode: ClaudeMode = cleanMode(request.mode) ?? "live";
		// One active request per user (re-checked against the dev machine, so a stale record can't block forever). A code
		// change waiting for Deploy / Discard doesn't block: the dev machine refuses what can't run next to it.
		for (const record of store.requests) {
			if (record.sid !== session.sid || record.user !== player.UserId || record.finished || record.state === "proposed") continue;
			refresh(session, record, player.UserId);
			if (!record.finished) return fail("busy");
		}
		const now = os.time();
		const recent = (store.sent.get(player.UserId) ?? []).filter((at) => now - at < RATE_WINDOW);
		if (recent.size() >= RATE_MAX) return fail("rate_limited");

		// Screenshots from claude.attach (the dev machine checks they are this user's and unused).
		const attachments = cleanAttachmentIds(request.attachments);
		if (attachments === undefined) return fail("bad_request");

		type Logs = { client?: string; server?: string; player?: { name: string; text: string } };
		const context: { path?: string; artifact?: string; logs?: Logs } = { artifact: kernel.artifact.id.sub(1, 128) };
		if (typeIs(request.path, "string")) context.path = request.path.sub(1, MAX_PATH);
		if (encodedSize(context) > MAX_CONTEXT_BYTES) return fail("context_too_large");
		// "My logs" (from the client, capped again here), "Server logs" (this server's log ring) and "Player logs" (another
		// player's client logs, asked from that client like Logs > Others): untrusted context, about 64 KB each, newest
		// kept. They can hold other players' names and chat: they are never printed here.
		const logs: Logs = {};
		if (typeIs(request.clientLogs, "string") && request.clientLogs !== "") logs.client = capLogText(request.clientLogs);
		if (request.serverLogs === true) logs.server = formatLogHistory(kernel.logs(undefined, SERVER_LOG_LINES));
		if (request.playerLogs !== undefined) {
			const target = typeIs(request.playerLogs, "number") ? Players.GetPlayerByUserId(request.playerLogs) : undefined;
			if (!target) return fail("player_gone");
			if (!deps) return fail("player_logs_unavailable");
			const [logsOk, entries] = deps.clientLogs(target, 0);
			if (!logsOk || !typeIs(entries, "table")) return fail("player_logs_failed");
			logs.player = { name: target.Name, text: formatLogHistory(entries as LogEntry[]) };
		}
		if (logs.client !== undefined || logs.server !== undefined || logs.player !== undefined) context.logs = logs;

		recent.push(now);
		store.sent.set(player.UserId, recent);
		const body: { prompt: string; mode: ClaudeMode; context: typeof context; conversationId?: string; attachments?: string[]; toolbox?: boolean } = { prompt, mode, context };
		if (conversationId !== undefined) body.conversationId = conversationId;
		if (attachments.size() > 0) body.attachments = attachments;
		// The dev picked "Toolbox" in the "+" menu for this message (one message only; the client clears the chip).
		const toolbox = request.toolbox === true;
		if (toolbox) body.toolbox = true;
		const result = authed(session, player.UserId, "POST", "/v1/prompts", body);
		if (!result.ok) {
			// The dev machine forgot the chat (it restarted): the client starts a new one.
			if (result.error === "not_found" && conversationId !== undefined) return fail("conversation_gone");
			if (result.error === "conflict") return fail("busy");
			// A screenshot that expired (unsent for 30 min) or was already used.
			if (result.error === "bad_request" && attachments.size() > 0) return fail("attachment_gone");
			return result;
		}
		const reply = (typeIs(result.data, "table") ? result.data : {}) as { id?: unknown; state?: unknown; conversationId?: unknown };
		const id = reply.id;
		if (!typeIs(id, "string") || id.size() > 64 || !matches(id, "^[%w_%-]+$")) return fail("bad_reply");
		const record: RequestRecord = {
			id,
			sid: session.sid,
			user: player.UserId,
			by: player.Name,
			prompt: prompt.sub(1, 160),
			state: shortString(reply.state, 20) ?? "queued",
			finished: false,
			createdAt: now,
			conversationId: isServerId(reply.conversationId) ? reply.conversationId : undefined,
		};
		store.requests.push(record);
		while (store.requests.size() > MAX_RECORDS) store.requests.shift();
		// Only prompts sent with the chip may insert (a toolbox_insert for any other prompt id is refused unloaded).
		if (toolbox) toolboxGate.allowPrompt(id);
		return { ok: true, request: view(record, player) };
	});

	// The requester's Deploy / Discard for a code change (the dev machine checks the requester and the proposal).
	ops.set("claude.deploy", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = chatSession(player);
		if (isFailure(session)) return session;
		const request = (typeIs(payload, "table") ? payload : {}) as { id?: unknown; decision?: unknown };
		const decision = request.decision;
		if (!isServerId(request.id) || (decision !== "deploy" && decision !== "discard")) return fail("bad_request");
		lastSeen.set(player.UserId, os.clock());
		const result = authed(session, player.UserId, "POST", `/v1/prompts/${request.id}/deploy`, { decision });
		if (!result.ok) return result.error === "conflict" ? fail("already_decided") : result.error === "forbidden" ? fail("not_yours") : result;
		return { ok: true };
	});

	ops.set("claude.status", (player, payload) => {
		const session = activeSession();
		if (!session) return fail("not_connected");
		if (!session.users.includes(player.UserId)) return fail("not_allowed");
		const record = find(session, payload);
		if (!record) return fail("not_found");
		if (!record.finished) {
			const result = refresh(session, record, player.UserId);
			if (!result.ok && result.error !== "not_found") return result;
		}
		return { ok: true, request: view(record, player) };
	});

	ops.set("claude.cancel", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = activeSession();
		if (!session) return fail("not_connected");
		const record = find(session, payload);
		if (!record) return fail("not_found");
		// Only the requester cancels from the game; the dev at the terminal can cancel anything.
		if (record.user !== player.UserId) return fail("not_yours");
		if (record.finished) return { ok: true, request: view(record, player) };
		const result = authed(session, player.UserId, "POST", `/v1/prompts/${record.id}/cancel`);
		if (!result.ok) return result;
		refresh(session, record, player.UserId);
		return { ok: true, request: view(record, player) };
	});
	// Chat ------------------------------------------------------------------------------------------------------------
	const chatSession = (player: Player): Session | Failure => {
		const session = activeSession();
		if (!session) return fail("not_connected");
		if (!session.users.includes(player.UserId)) return fail("not_allowed");
		return session;
	};
	const isFailure = (value: Session | Failure): value is Failure => (value as Failure).ok === false;

	// {id, since} → the prompt's state and its events i >= since (any allowed user of the session may read; the dev
	// machine decides). Polled about once a second per open chat while a prompt runs.
	ops.set("claude.events", (player, payload): ClaudeEventsReply => {
		const session = chatSession(player);
		if (isFailure(session)) return session;
		const request = (typeIs(payload, "table") ? payload : {}) as { id?: unknown; since?: unknown };
		const id = request.id;
		if (!isServerId(id)) return fail("bad_request");
		const since = math.clamp(math.floor(shortNumber(request.since) ?? 0), 0, 9_999_999);
		lastSeen.set(player.UserId, os.clock());
		const cached = cache.get(id);
		if (cached && cached.fields && since >= cached.start && since <= cached.start + cached.events.size()) {
			const events = new Array<ClaudeEvent>();
			for (let index = since - cached.start; index < cached.events.size() && events.size() < MAX_EVENTS; index++) events.push(cached.events[index]);
			const fields = cached.fields;
			const state = shortString(fields.state, 20) ?? "queued";
			const record = find(session, id);
			if (record) apply(record, fields);
			const nextIndex = since + events.size();
			return {
				ok: true,
				id,
				state,
				finished: isFinished(state, fields.finishedAt) && nextIndex >= cached.start + cached.events.size(),
				conversationId: isServerId(fields.conversationId) ? fields.conversationId : undefined,
				summary: shortString(fields.summary, 300),
				commit: shortString(fields.commit, 64),
				artifactId: shortString(fields.artifactId, 128),
				runError: shortString(fields.error, 300),
				costUsd: shortNumber(fields.costUsd),
				mode: cleanMode(fields.mode),
				proposal: cleanProposal(fields.proposal),
				events,
				next: nextIndex,
				more: nextIndex < cached.start + cached.events.size(),
				approvals: approvalsFor(player),
				inserts: toolboxInsertsFor(player, id),
			};
		}
		const result = authed(session, player.UserId, "GET", `/v1/prompts/${id}?since=${since}`);
		if (!result.ok) {
			if (result.error !== "not_found") return result;
			const lost = find(session, id);
			if (lost) {
				lost.state = "lost";
				lost.finished = true;
			}
			return { ok: true, id, state: "lost", finished: true, events: [], next: since };
		}
		const reply = (typeIs(result.data, "table") ? result.data : {}) as Record<string, unknown>;
		const record = find(session, id);
		if (record) apply(record, reply);
		// The poll cache has events but no fields yet (no state change since it started): take them from here.
		const partial = cache.get(id);
		if (partial && partial.fields === undefined) partial.fields = reply;
		const state = shortString(reply.state, 20) ?? "queued";
		const nextIndex = shortNumber(reply.next);
		const events = cleanEvents(reply.events, MAX_EVENTS);
		noteToolboxResults(isServerId(reply.conversationId) ? reply.conversationId : record?.conversationId, id, events);
		return {
			ok: true,
			id,
			state,
			finished: isFinished(state, reply.finishedAt),
			conversationId: isServerId(reply.conversationId) ? reply.conversationId : undefined,
			summary: shortString(reply.summary, 300),
			commit: shortString(reply.commit, 64),
			artifactId: shortString(reply.artifactId, 128),
			runError: shortString(reply.error, 300),
			costUsd: shortNumber(reply.costUsd),
			mode: cleanMode(reply.mode),
			proposal: cleanProposal(reply.proposal),
			events,
			next: nextIndex !== undefined ? math.max(since, math.floor(nextIndex)) : since,
			more: reply.more === true,
			approvals: approvalsFor(player),
			inserts: toolboxInsertsFor(player, id),
		};
	});

	// The player's own conversations on the dev machine, latest first.
	ops.set("claude.conversations", (player) => {
		lastSeen.set(player.UserId, os.clock());
		const session = chatSession(player);
		if (isFailure(session)) return session;
		const result = authed(session, player.UserId, "GET", "/v1/conversations");
		if (!result.ok) return result;
		const reply = (typeIs(result.data, "table") ? result.data : {}) as { conversations?: unknown };
		const conversations = new Array<ClaudeConversationSummary>();
		for (const item of listOf(reply.conversations)) {
			if (conversations.size() >= MAX_CONVERSATIONS || !typeIs(item, "table")) continue;
			const data = item as Record<string, unknown>;
			const id = data.id;
			if (!isServerId(id)) continue;
			conversations.push({
				id,
				title: shortString(data.title, 80) ?? "chat",
				updatedAt: shortNumber(data.updatedAt) ?? 0,
				prompts: shortNumber(data.prompts) ?? 0,
				state: shortString(data.state, 20),
			});
		}
		return { ok: true, conversations };
	});

	// One of the player's conversations with its messages (replay after a swap or a rejoin). Text is capped per reply:
	// the newest messages keep their events, older ones past the budget keep only their prompt and fields.
	ops.set("claude.conversation", (player, payload) => {
		const session = chatSession(player);
		if (isFailure(session)) return session;
		if (!isServerId(payload)) return fail("bad_request");
		const result = authed(session, player.UserId, "GET", `/v1/conversations/${payload}`);
		if (!result.ok) return result.error === "not_found" ? fail("conversation_gone") : result;
		const reply = (typeIs(result.data, "table") ? result.data : {}) as Record<string, unknown>;
		const raw = listOf(reply.messages);
		const messages = new Array<ClaudeMessage>();
		let budget = CONVERSATION_TEXT_BUDGET;
		for (let index = raw.size() - 1; index >= 0 && messages.size() < MAX_MESSAGES; index--) {
			const item = raw[index];
			if (!typeIs(item, "table")) continue;
			const data = item as Record<string, unknown>;
			const id = data.id;
			const prompt = data.prompt;
			if (!isServerId(id) || !typeIs(prompt, "string")) continue;
			const state = shortString(data.state, 20) ?? "queued";
			let events = cleanEvents(data.events, 400);
			noteToolboxResults(payload, id, events);
			let size = 0;
			for (const event of events) size += event.text.size();
			if (size > budget) events = [];
			else budget -= size;
			messages.unshift({
				id,
				prompt: prompt.sub(1, MAX_PROMPT),
				state,
				mode: cleanMode(data.mode),
				proposal: cleanProposal(data.proposal),
				finished: isFinished(state, data.finishedAt),
				summary: shortString(data.summary, 300),
				commit: shortString(data.commit, 64),
				artifactId: shortString(data.artifactId, 128),
				error: shortString(data.error, 300),
				costUsd: shortNumber(data.costUsd),
				events,
				attachments: attachmentIdsOf(data.attachments),
				next: math.max(0, math.floor(shortNumber(data.next) ?? 0)),
			});
		}
		const conversation: ClaudeConversation = { id: payload, title: shortString(reply.title, 80) ?? "chat", messages };
		return { ok: true, conversation };
	});

	// Images (spike S11, claude-images.ts) ------------------------------------------------------------------------------
	/** userId -> unix times of screenshot requests (the dev machine limits too). */
	const attachTimes = new Map<number, number[]>();
	const imageTimes = new Map<number, number[]>();
	/** Players with an image transfer running (one at a time each). */
	const imageBusy = new Set<number>();
	const allow = (times: Map<number, number[]>, userId: number, max: number, window: number): boolean => {
		const now = os.time();
		const recent = (times.get(userId) ?? []).filter((at) => now - at < window);
		if (recent.size() >= max) return false;
		recent.push(now);
		times.set(userId, recent);
		return true;
	};

	// The screenshot the dev's client just took: {captureTime, localId?, crop?} (the dev machine picks up the file Roblox
	// wrote on its PC: only this user's, the closest time) or {assetId, crop?} (the upload fallback, downloaded there).
	ops.set("claude.attach", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = chatSession(player);
		if (isFailure(session)) return session;
		lastSeen.set(player.UserId, os.clock());
		const request = (typeIs(payload, "table") ? payload : {}) as { captureTime?: unknown; localId?: unknown; assetId?: unknown; crop?: unknown };
		const crop = request.crop === undefined ? undefined : cleanCrop(request.crop);
		if (request.crop !== undefined && crop === undefined) return fail("bad_request");
		let path: string;
		let body: Record<string, unknown>;
		const assetId = request.assetId;
		const captureTime = request.captureTime;
		if (assetId !== undefined) {
			if (!typeIs(assetId, "number") || assetId < 1 || assetId % 1 !== 0 || assetId >= 2 ** 53) return fail("bad_request");
			path = "/v1/attachments/asset";
			body = { assetId, crop };
		} else {
			if (!typeIs(captureTime, "number") || captureTime % 1 !== 0 || captureTime < 1e12 || captureTime >= 1e13) return fail("bad_request");
			path = "/v1/attachments/capture";
			body = { captureTime, placeId: game.PlaceId, crop };
			const localId = request.localId;
			if (typeIs(localId, "string") && localId.size() <= 128 && matches(localId, "^[%w%._:/{}%-]+$")) body.localId = localId;
		}
		if (!allow(attachTimes, player.UserId, 8, 60)) return fail("rate_limited");
		const result = authed(session, player.UserId, "POST", path, body);
		if (!result.ok) {
			if (result.error === "not_found") return fail("no_capture");
			if (result.error === "http_422") return fail("bad_image");
			if (result.error === "remote_error") return fail(assetId !== undefined ? "download_failed" : "remote_error");
			return result;
		}
		const reply = (typeIs(result.data, "table") ? result.data : {}) as { id?: unknown; width?: unknown; height?: unknown };
		const id = reply.id;
		if (!typeIs(id, "string") || id.size() !== 32 || !matches(id, "^%x+$")) return fail("bad_reply");
		return { ok: true, id, width: shortNumber(reply.width) ?? 0, height: shortNumber(reply.height) ?? 0 };
	});

	// An image Claude showed: fetched from the dev machine in chunks and pushed only to this player (CLAUDE_IMAGE_CHUNK,
	// paced). The dev machine serves it only to the prompt's requester on this server (the token's user and job).
	ops.set("claude.image", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = chatSession(player);
		if (isFailure(session)) return session;
		const id = typeIs(payload, "table") ? (payload as { id?: unknown }).id : payload;
		if (!typeIs(id, "string") || id.size() !== 32 || !matches(id, "^%x+$")) return fail("bad_request");
		if (imageBusy.has(player.UserId)) return fail("busy");
		if (!allow(imageTimes, player.UserId, 30, 600)) return fail("rate_limited");
		lastSeen.set(player.UserId, os.clock());
		const first = authed(session, player.UserId, "GET", `/v1/images/${id}?chunk=0`);
		if (!first.ok) return first.error === "not_found" ? fail("image_gone") : first;
		const chunk0 = decodeImageChunk(first.data, id, 0);
		if (!chunk0) return fail("bad_reply");
		const meta = chunk0.meta;
		imageBusy.add(player.UserId);
		task.spawn(() => {
			pcall(() => {
				kernel.send(player, CLAUDE_IMAGE_CHUNK, id, 0, meta.chunks, chunk0.data);
				for (let index = 1; index < meta.chunks; index++) {
					if (player.Parent === undefined) break;
					const fetched = authed(session, player.UserId, "GET", `/v1/images/${id}?chunk=${index}`);
					const chunk = fetched.ok ? decodeImageChunk(fetched.data, id, index) : undefined;
					if (!chunk) break;
					kernel.send(player, CLAUDE_IMAGE_CHUNK, id, index, meta.chunks, chunk.data);
					task.wait(0.03);
				}
			});
			imageBusy.delete(player.UserId);
		});
		return { ok: true, id, width: meta.width, height: meta.height, chunks: meta.chunks };
	});
	// Game tools ------------------------------------------------------------------------------------------------------
	if (store.alwaysRun === undefined) store.alwaysRun = new Map();
	if (store.execs === undefined) store.execs = [];
	const alwaysRun = store.alwaysRun;
	const execs = store.execs;
	const handled = new Set<string>();
	interface PendingApproval {
		userId: number;
		approval: ClaudeApproval;
		expiresAt: number;
		thread: thread;
		timeout: thread;
	}
	const pendingApprovals = new Map<string, PendingApproval>();

	approvalsFor = (player: Player): ClaudeApproval[] | undefined => {
		const list = new Array<ClaudeApproval>();
		for (const [, pending] of pendingApprovals) {
			if (pending.userId !== player.UserId) continue;
			list.push({ ...pending.approval, expiresIn: math.max(0, math.floor(pending.expiresAt - os.clock())) });
		}
		return list.size() > 0 ? list : undefined;
	};

	const settleApproval = (id: string, decision: string, options?: ClaudeToolboxOptions) => {
		const pending = pendingApprovals.get(id);
		if (!pending) return;
		pendingApprovals.delete(id);
		if (coroutine.status(pending.timeout) === "suspended") task.cancel(pending.timeout);
		if (coroutine.status(pending.thread) === "suspended") task.spawn(pending.thread, decision, options);
	};

	/** Shows an approval card in the dev's chat; yields until they answer or APPROVAL_SECONDS pass ("timeout"). */
	const ask = (userId: number, approval: Omit<ClaudeApproval, "expiresIn">): LuaTuple<[string, ClaudeToolboxOptions | undefined]> => {
		const thread = coroutine.running();
		const timeout = task.delay(APPROVAL_SECONDS, () => settleApproval(approval.id, "timeout"));
		pendingApprovals.set(approval.id, { userId, approval: { ...approval, expiresIn: APPROVAL_SECONDS }, expiresAt: os.clock() + APPROVAL_SECONDS, thread, timeout });
		// coroutine.yield returns the resumed values as a tuple: pack them.
		const [decision, options] = coroutine.yield() as LuaTuple<[string, ClaudeToolboxOptions | undefined]>;
		return $tuple(decision, options);
	};

	/** run_luau: "once" | "always" | "deny" | "timeout". */
	const askApproval = (userId: number, approval: Omit<ClaudeApproval, "expiresIn">): string => ask(userId, { ...approval, kind: "luau" })[0];

	/** A toolbox insert card (plans/14): "insert" | "deny" | "timeout", with the card's options. Never "always". */
	const askToolbox = (userId: number, card: ToolboxAsk) =>
		ask(userId, { id: card.id, kind: "toolbox", description: card.description, code: "", conversationId: card.conversationId, toolbox: card.toolbox });

	ops.set("claude.approve", (player, payload) => {
		const request = (typeIs(payload, "table") ? payload : {}) as { id?: unknown; decision?: unknown; options?: unknown };
		const id = request.id;
		const decision = request.decision;
		if (!typeIs(id, "string") || !typeIs(decision, "string")) return fail("bad_request");
		const pending = pendingApprovals.get(id);
		if (!pending || pending.userId !== player.UserId) return fail("not_found");
		if (pending.approval.kind === "toolbox") {
			// Each insert is its own decision: Insert or Deny only, never "once"/"always".
			if (decision !== "insert" && decision !== "deny") return fail("bad_request");
			const raw = (typeIs(request.options, "table") ? request.options : {}) as { anchor?: unknown; keepScripts?: unknown };
			settleApproval(id, decision, { anchor: raw.anchor !== false, keepScripts: raw.keepScripts === true });
			return { ok: true };
		}
		if (!["once", "always", "deny"].includes(decision)) return fail("bad_request");
		if (decision === "always" && pending.approval.conversationId !== undefined) {
			alwaysRun.set(`${player.UserId}:${pending.approval.conversationId}`, true);
		}
		settleApproval(id, decision);
		return { ok: true };
	});

	// The inserted card's Remove: only the dev who inserted it, only on a dev-channel server.
	ops.set("claude.toolboxRemove", (player, payload) => {
		const request = (typeIs(payload, "table") ? payload : {}) as { insertId?: unknown };
		if (!kernel.isDev(player)) return fail("not_allowed");
		return removeToolboxInsert(player, request.insertId, toolboxStore, kernel.channel);
	});

	// Client-realm requests to the dev's own client (inspect / find on their DataModel).
	let nextClientRequest = math.random(1, 2 ** 30);
	const pendingClient = new Map<number, { target: Player; thread: thread; timeout: thread }>();
	const finishClient = (id: number, ok: boolean, result: unknown) => {
		const pending = pendingClient.get(id);
		if (!pending) return;
		pendingClient.delete(id);
		if (coroutine.status(pending.timeout) === "suspended") task.cancel(pending.timeout);
		if (coroutine.status(pending.thread) === "suspended") task.spawn(pending.thread, ok, result);
	};
	const askClient = (target: Player, tool: string, args: unknown): [ok: boolean, result: unknown] => {
		nextClientRequest += 1;
		const id = nextClientRequest;
		const thread = coroutine.running();
		const timeout = task.delay(CLIENT_TOOL_TIMEOUT, () => finishClient(id, false, "no reply from the developer's client"));
		pendingClient.set(id, { target, thread, timeout });
		kernel.send(target, CLAUDE_TOOL_REQUEST, id, tool, args);
		// coroutine.yield returns the resumed values as a tuple, not a table: pack them (indexing the tuple failed live).
		const [ok, result] = coroutine.yield() as LuaTuple<[boolean, unknown]>;
		return [ok, result];
	};
	if (deps) {
		deps.dispatcher.setRaw(CLAUDE_TOOL_RESPONSE, (player, id, ok, result) => {
			if (!typeIs(id, "number")) return;
			const pending = pendingClient.get(id);
			// Only the asked player may answer, and only once.
			if (!pending || pending.target !== player) return;
			finishClient(id, ok === true, typeIs(result, "string") ? result.sub(1, 60_000) : "bad reply");
		});
		trove.add(() => {
			deps.dispatcher.removeRaw(CLAUDE_TOOL_RESPONSE);
			for (const [id] of pendingClient) finishClient(id, false, "server swapped");
			for (const [id] of pendingApprovals) settleApproval(id, "timeout");
		});
	}

	const formatLogs = (entries: LogEntry[], filter: string | undefined, limit: number): string => {
		const lines = new Array<string>();
		const needle = filter?.lower();
		for (const entry of entries) {
			if (needle !== undefined && entry.text.lower().find(needle, 1, true)[0] === undefined) continue;
			lines.push(`#${entry.i} ${entry.kind} ${entry.text.sub(1, 600)}`);
		}
		const from = math.max(0, lines.size() - limit);
		const shown = new Array<string>();
		for (let index = from; index < lines.size(); index++) shown.push(lines[index]);
		return shown.size() > 0 ? shown.join("\n") : "(no matching lines)";
	};

	type ToolAnswer = { ok: boolean; output?: string[]; returned?: string; error?: string; data?: string; ms?: number; denied?: boolean };

	/**
	 * A durable record of one run_luau decision (security audit M4), best effort: DataStore "TypeTorch" key
	 * audit/<yyyy-mm-dd>/<JobId>/<n> (UTC date, "studio" for Studio's empty JobId, n counts up per server across swaps).
	 * Who, when, where, the description, the SHA-256 of the code and the outcome: never the code itself.
	 */
	const audit = (
		player: Player,
		run: { description: string; code: string; outcome: "ok" | "error" | "denied" | "timeout"; error?: string; ms?: number; requestId: string; conversationId?: string },
	) => {
		store.auditSeq = (store.auditSeq ?? 0) + 1;
		const key = `audit/${os.date("!%Y-%m-%d")}/${game.JobId !== "" ? game.JobId : "studio"}/${store.auditSeq}`;
		const record = {
			v: 1,
			at: os.time(),
			user: player.UserId,
			name: player.Name,
			place: game.PlaceId,
			job: game.JobId,
			branch: kernel.branch,
			artifact: kernel.artifact.id,
			session: store.session?.sid.sub(1, 8),
			request: run.requestId.sub(1, 64),
			conversation: run.conversationId,
			description: run.description,
			sha256: sha256(run.code),
			bytes: run.code.size(),
			outcome: run.outcome,
			error: run.error?.sub(1, 200),
			ms: run.ms,
		};
		task.spawn(() => {
			const [ok, err] = pcall(() => DataStoreService.GetDataStore(AUDIT_STORE).SetAsync(key, record));
			if (!ok) $warn(`[claude] run_luau audit record not saved (${key}): ${err}`);
		});
	};

	/** Runs one tool for the requesting dev. */
	const runTool = (player: Player, request: Record<string, unknown>): ToolAnswer => {
		const tool = request.tool;
		const args = (typeIs(request.args, "table") ? request.args : {}) as Record<string, unknown>;
		const realm = args.realm === "client" ? "client" : "server";
		if (tool === "game_status") {
			const status = kernel.status();
			return {
				ok: true,
				data: toJson({
					artifact: kernel.artifact.id,
					generation: status.generation?.name,
					branch: kernel.branch,
					channel: kernel.channel,
					serverType: kernel.serverType,
					placeVersion: status.placeVersion,
					uptime: math.floor(status.uptime),
					kernel: status.kernelVersion,
					requester: player.UserId,
					players: playerList(),
				}),
			};
		}
		if (tool === "game_logs") {
			const since = typeIs(args.since, "number") ? args.since : undefined;
			const limit = typeIs(args.limit, "number") ? math.clamp(math.floor(args.limit), 1, 500) : 100;
			const filter = typeIs(args.filter, "string") ? args.filter.sub(1, 100) : undefined;
			if (realm === "server") return { ok: true, data: formatLogs(kernel.logs(since, 500), filter, limit) };
			if (!deps) return { ok: false, error: "client logs are not available here" };
			const [ok, result] = deps.clientLogs(player, since ?? 0);
			if (!ok) return { ok: false, error: tostring(result) };
			return { ok: true, data: formatLogs(result as LogEntry[], filter, limit) };
		}
		if (tool === "inspect" || tool === "find") {
			if (realm === "client") {
				if (!deps) return { ok: false, error: "the client realm is not available here" };
				const [ok, result] = askClient(player, tool, args);
				return ok ? { ok: true, data: result as string } : { ok: false, error: tostring(result) };
			}
			const [ok, result] = pcall(() => (tool === "inspect" ? inspectTool(args) : findTool(args)));
			return ok ? { ok: true, data: result } : { ok: false, error: tostring(result) };
		}
		if (tool === "screenshot") {
			// The requester's own client takes it (dev menu hidden for that frame) and answers with the capture time; the
			// dev machine picks the file up on its PC. No pixels pass through here.
			if (!deps) return { ok: false, error: "screenshots are not available here" };
			const [ok, result] = askClient(player, "screenshot", {});
			if (!ok) return { ok: false, error: tostring(result).sub(1, 200) };
			const shot = (typeIs(result, "string") ? decode(result) : undefined) as { captureTime?: unknown; localId?: unknown } | undefined;
			if (!typeIs(shot, "table") || !typeIs(shot.captureTime, "number")) return { ok: false, error: "the client sent no capture" };
			const localId = typeIs(shot.localId, "string") && shot.localId.size() <= 128 && matches(shot.localId, "^[%w%._:/{}%-]+$") ? shot.localId : undefined;
			return { ok: true, data: HttpService.JSONEncode({ captureTime: math.floor(shot.captureTime), localId, placeId: game.PlaceId }) };
		}
		if (tool === "toolbox_insert") {
			// Creator Store insert (plans/14): chip-gated prompt, id from this conversation's relayed search, dev channel,
			// a per-insert approval card (no "always"), load into nothing, sanitize, then parent (toolbox-server.ts).
			return toolboxInsert(player, request, {
				gate: toolboxGate,
				store: toolboxStore,
				channel: () => kernel.channel,
				ask: (target, card) => askToolbox(target.UserId, card),
				stillAllowed: (target) => target.Parent !== undefined && kernel.isDev(target) && kernel.channel === "dev",
			});
		}
		if (tool === "run_luau") {
			const code = request.args !== undefined && typeIs(args.code, "string") ? args.code : "";
			const description = shortString(request.description, 120) ?? "luau";
			const timeoutSeconds = typeIs(args.timeoutSeconds, "number") ? math.clamp(args.timeoutSeconds, 1, 30) : 10;
			if (code === "") return { ok: false, error: "no code" };
			if (!loadstringAvailable()) return { ok: false, error: LOADSTRING_HELP };
			const conversationId = isServerId(request.conversationId) ? request.conversationId : undefined;
			const id = typeIs(request.id, "string") ? request.id : HttpService.GenerateGUID(false);
			const always = conversationId !== undefined && alwaysRun.get(`${player.UserId}:${conversationId}`) === true;
			if (!always) {
				const decision = askApproval(player.UserId, { id, description, code, conversationId });
				if (decision !== "once" && decision !== "always") {
					$print(`[claude] run_luau for ${player.Name} denied (${decision}): ${description}`);
					audit(player, { description, code, outcome: decision === "timeout" ? "timeout" : "denied", requestId: id, conversationId });
					return { ok: false, denied: true, error: decision === "timeout" ? "no answer within 60 s" : "denied", output: [] };
				}
			}
			// The requester may have left or lost dev access while deciding.
			if (player.Parent === undefined || !kernel.isDev(player) || kernel.channel !== "dev") return { ok: false, error: "the developer is no longer a dev in this server" };
			// Only `player`: no kernel, no persist store (refresh tokens live there), and a guarded game (claude-tools.ts).
			const result = runLuau(code, { player }, timeoutSeconds);
			$print(`[claude] run_luau for ${player.Name}: ${description} -> ${result.ok ? "ok" : "error"} (${result.ms} ms)`);
			execs.push({ at: os.time(), user: player.UserId, description, ok: result.ok, error: result.error?.sub(1, 200) });
			while (execs.size() > MAX_EXEC_LOG) execs.shift();
			audit(player, { description, code, outcome: result.ok ? "ok" : "error", error: result.error, ms: result.ms, requestId: id, conversationId });
			return result;
		}
		return { ok: false, error: `unknown tool ${tostring(tool).sub(1, 40)}` };
	};

	/** Runs one tool request and posts the answer (once per id). */
	const answerRequest = (session: Session, player: Player, request: Record<string, unknown>) => {
		const requestId = request.id;
		if (!typeIs(requestId, "string") || requestId.size() !== 32 || !matches(requestId, "^%x+$") || handled.has(requestId)) return;
		handled.add(requestId);
		const [ok, answer] = pcall(() => runTool(player, request));
		const body: ToolAnswer = ok ? answer : { ok: false, error: tostring(answer).sub(1, 2000) };
		authed(session, player.UserId, "POST", "/v1/game/tool-result", { output: [], ...body, id: requestId });
	};

	/** Serves one game-tool request id from a wake message (no poll was open). */
	const serveToolRequest = (session: Session, player: Player, requestId: string) => {
		if (handled.has(requestId)) return;
		const fetched = authed(session, player.UserId, "GET", `/v1/game/requests/${requestId}`);
		if (!fetched.ok || !typeIs(fetched.data, "table")) return;
		answerRequest(session, player, fetched.data as Record<string, unknown>);
	};

	/** Who may use the game tools here right now: the session's user, in this server, a dev, paired here. */
	const toolPlayer = (session: Session, userId: number): Player | undefined => {
		if (kernel.channel !== "dev" || !session.users.includes(userId)) return undefined;
		const player = Players.GetPlayerByUserId(userId);
		if (!player || !kernel.isDev(player) || !isPaired(session, userId)) return undefined;
		return player;
	};

	/** The poll runs while the dev has a run going here or the Claude tab open. */
	const wantsPoll = (session: Session, userId: number): boolean => {
		const seen = lastSeen.get(userId);
		if (seen !== undefined && os.clock() - seen < CHAT_OPEN_WINDOW) return true;
		const now = os.time();
		for (const record of store.requests) {
			if (record.sid === session.sid && record.user === userId && !record.finished && now - record.createdAt < RUN_WINDOW) return true;
		}
		return false;
	};

	/** Applies one long-poll reply: events into the cache, prompt fields, tool requests. */
	const applyPoll = (session: Session, player: Player, data: Record<string, unknown>) => {
		if (data.reset === true) {
			// The dev machine restarted or the cursor fell behind: reads fall back to HTTP until new events arrive.
			cache.clear();
		}
		for (const item of listOf(data.items)) {
			if (!typeIs(item, "table")) continue;
			const entry = item as Record<string, unknown>;
			if (entry.type === "event" && isServerId(entry.promptId)) {
				const event = cleanEvent(entry.event);
				if (!event) continue;
				if (event.kind === "toolbox_results") noteToolboxResults(find(session, entry.promptId)?.conversationId, entry.promptId, [event]);
				let cached = cache.get(entry.promptId);
				if (cached && event.i !== cached.start + cached.events.size()) {
					// A gap: drop it (reads fall back to HTTP for this prompt).
					cache.delete(entry.promptId);
					cached = undefined;
					continue;
				}
				if (!cached) {
					cached = { start: event.i, events: [] };
					cache.set(entry.promptId, cached);
				}
				if (cached.events.size() < CACHE_EVENTS) cached.events.push(event);
				else cache.delete(entry.promptId);
			} else if (entry.type === "prompt" && typeIs(entry.prompt, "table")) {
				const fields = entry.prompt as Record<string, unknown>;
				if (!isServerId(fields.id)) continue;
				const cached = cache.get(fields.id);
				if (cached) cached.fields = fields;
				const record = find(session, fields.id);
				if (record) apply(record, fields);
			}
		}
		for (const request of listOf(data.requests)) {
			if (typeIs(request, "table")) task.spawn(answerRequest, session, player, request as Record<string, unknown>);
		}
	};

	// One poll thread per dev (at most), started by the manager below.
	const polling = new Set<number>();
	const pollLoop = (userId: number, isStopped: () => boolean) => {
		polling.add(userId);
		let cursor: number | undefined;
		let failures = 0;
		while (!isStopped()) {
			const session = activeSession();
			const player = session ? toolPlayer(session, userId) : undefined;
			if (!session || !player || !wantsPoll(session, userId)) break;
			const result = authed(session, userId, "GET", cursor === undefined ? "/v1/game/poll" : `/v1/game/poll?since=${cursor}`);
			if (isStopped()) break;
			if (!result.ok || !typeIs(result.data, "table")) {
				failures += 1;
				if (result.ok === false && (result.error === "needs_pairing" || result.error === "not_allowed")) break;
				// Backoff with jitter: 1, 2, 4 ... 30 s.
				task.wait(math.min(30, 2 ** math.min(failures - 1, 5)) * (0.5 + math.random()));
				continue;
			}
			failures = 0;
			const data = result.data as Record<string, unknown>;
			const nextCursor = shortNumber(data.cursor);
			pcall(applyPoll, session, player, data);
			if (nextCursor !== undefined) cursor = math.floor(nextCursor);
		}
		polling.delete(userId);
	};

	if (kernel.channel === "dev") {
		let stopped = false;
		let toolConnection: RBXScriptConnection | undefined;
		trove.add(() => {
			stopped = true;
			toolConnection?.Disconnect();
		});
		// Wake messages (fast path).
		task.spawn(() => {
			const [ok, result] = pcall(() =>
				MessagingService.SubscribeAsync(TOOL_TOPIC, (message) => {
					if (stopped) return;
					const data = (typeIs(message.Data, "string") ? decode(message.Data) : message.Data) as Record<string, unknown> | undefined;
					if (!typeIs(data, "table") || data.v !== 1 || data.j !== game.JobId) return;
					const session = activeSession();
					const userId = data.u;
					const id = data.x;
					if (!session || data.s !== session.sid || !typeIs(userId, "number") || !typeIs(id, "string") || id.size() !== 32) return;
					const player = toolPlayer(session, userId);
					if (player) task.spawn(serveToolRequest, session, player, id);
				}),
			);
			if (!ok) {
				$warn(`[remote-claude] tool messages unavailable: ${result}`);
				return;
			}
			if (stopped) result.Disconnect();
			else toolConnection = result;
		});
		// The poll manager: starts a dev's long-poll when they need one (run going or chat open), once per dev.
		trove.add(
			task.spawn(() => {
				while (!stopped) {
					task.wait(1);
					const session = activeSession();
					if (!session) continue;
					for (const userId of session.users) {
						if (polling.has(userId) || !wantsPoll(session, userId) || !toolPlayer(session, userId)) continue;
						task.spawn(pollLoop, userId, () => stopped);
					}
				}
			}),
		);
	}
}
