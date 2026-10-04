import { HttpService, MessagingService, Players, RunService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $print, $warn } from "rbxts-transform-debug";
import type { LogEntry, ServerKernel } from "../kernel";
import type { ServerDispatcher } from "../net/runtime";
import {
	CLAUDE_TOOL_REQUEST,
	CLAUDE_TOOL_RESPONSE,
	findTool,
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
	ClaudeMessage,
	ClaudePromptRequest,
	ClaudeRequestView,
	ClaudeSessionView,
	DevOp,
} from "./protocol";

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
 * run_luau needs the dev's approval in their chat (or "always" for that chat) and LoadStringEnabled; every run is
 * logged (description and outcome, never the code) and the last 20 are kept.
 */

const TOPIC = "TypeTorch/remote-claude";
const PERSIST_KEY = "remoteClaude";
const MAX_PROMPT = 4000;
const MAX_CONTEXT_BYTES = 12 * 1024;
const MAX_PATH = 1024;
const MAX_ERRORS = 5;
const MAX_ERROR_CHARS = 500;
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
const FINISHED_STATES = new Set(["deployed", "answered", "failed", "cancelled", "lost"]);
const EVENT_KINDS = new Set<string>(["assistant_text", "tool_use", "tool_result", "status", "error"]);
/** Events relayed per "claude.events" reply (the dev machine pages at 300). */
const MAX_EVENTS = 300;
const MAX_EVENT_TEXT = 4000;
/** Characters of event text in one "claude.conversation" reply; older messages lose their events past it. */
const CONVERSATION_TEXT_BUDGET = 120_000;
const MAX_MESSAGES = 30;
const MAX_CONVERSATIONS = 20;
const TOOL_TOPIC = "TypeTorch/tool";
const TOOL_POLL = 2;
/** Prompts older than this are not polled for tool requests. */
const TOOL_POLL_WINDOW = 30 * 60;
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
	return event;
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

/** Host-only https URL; plain http to localhost only in Studio (dev-server without a tunnel). */
function cleanUrl(value: unknown): string | undefined {
	if (!typeIs(value, "string") || value.size() > 200) return undefined;
	const url = value.gsub("/+$", "")[0];
	if (matches(url, "^https://[%w%-%.]+$") || matches(url, "^https://[%w%-%.]+:%d+$")) return url;
	if (RunService.IsStudio() && (matches(url, "^http://localhost:%d+$") || matches(url, "^http://127%.0%.0%.1:%d+$"))) {
		return url;
	}
	return undefined;
}

function httpError(status: number): string {
	if (status === 400) return "bad_request";
	if (status === 401) return "unauthorized";
	if (status === 403) return "forbidden";
	if (status === 404) return "not_found";
	if (status === 409) return "conflict";
	if (status === 413) return "too_large";
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
	/** run_luau snippets waiting for a player's approval (set up in the game tools section below). */
	let approvalsFor: (player: Player) => ClaudeApproval[] | undefined = () => undefined;
	// userId -> [access token, expires at (unix)]. Generation memory only: never persisted, sent or printed.
	const tokens = new Map<number, [string, number]>();
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

	const activeSession = (): Session | undefined => {
		const session = store.session;
		return usable(session) && session.exp > os.time() ? session : undefined;
	};

	// Session messages ----------------------------------------------------------------------------------------------
	const onMessage = (raw: unknown) => {
		let data = raw;
		if (typeIs(raw, "string")) data = decode(raw);
		if (!typeIs(data, "table")) return;
		const message = data as Record<string, unknown>;
		const sid = message.s;
		if (message.v !== 1 || !typeIs(sid, "string") || !matches(sid, "^[0-9a-f]+$") || sid.size() !== 32) return;
		if (message.closed === true) {
			if (store.session?.sid === sid) {
				store.session = undefined;
				forgetOtherSessions(undefined);
			}
			return;
		}
		const branch = message.b;
		const exp = message.exp;
		const url = cleanUrl(message.url);
		if (!typeIs(branch, "string") || branch.size() > 64 || !typeIs(exp, "number") || url === undefined) return;
		// Only dev-channel servers on the session branch keep it; everyone else drops it unread.
		if (kernel.channel !== "dev" || branch !== kernel.branch || exp <= os.time()) return;
		if (!typeIs(message.u, "table")) return;
		const users = new Array<number>();
		for (const [, user] of pairs(message.u as object)) {
			if (typeIs(user, "number") && user > 0 && user % 1 === 0 && users.size() < 100) users.push(user);
		}
		if (store.session?.sid !== sid) forgetOtherSessions(sid);
		store.session = { sid, branch, users, url, exp };
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
	}

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
		tokens.set(userId, [token, os.time() + expiresIn]);
		const refresh = reply.refresh_token;
		if (typeIs(refresh, "string") && refresh.size() <= MAX_TOKEN) {
			const refreshIn = reply.refresh_expires_in;
			pairings.set(userId, { sid: session.sid, token: refresh, exp: typeIs(refreshIn, "number") ? os.time() + refreshIn : 0 });
		}
		return [true, token, status];
	};

	const pairingFor = (session: Session, userId: number): Pairing | undefined => {
		const pairing = pairings.get(userId);
		if (!pairing) return undefined;
		if (pairing.sid !== session.sid || (pairing.exp !== 0 && pairing.exp <= os.time())) {
			pairings.delete(userId);
			return undefined;
		}
		return pairing;
	};

	const isPaired = (session: Session, userId: number): boolean => {
		const cached = tokens.get(userId);
		if (cached && cached[1] - TOKEN_MARGIN > os.time()) return true;
		return pairingFor(session, userId) !== undefined;
	};

	/** Cached access token, else the refresh grant, else `needs_pairing`. */
	const tokenFor = (session: Session, userId: number): [ok: boolean, tokenOrError: string] => {
		while (exchanging.has(userId)) task.wait(0.1);
		const cached = tokens.get(userId);
		if (cached && cached[1] - TOKEN_MARGIN > os.time()) return [true, cached[0]];
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

	const lastServerErrors = (): string[] => {
		const errors = new Array<string>();
		for (const entry of kernel.logs(undefined, 300)) {
			if (entry.kind === "error") errors.push(`[server] ${entry.text.sub(1, MAX_ERROR_CHARS)}`);
		}
		const from = math.max(0, errors.size() - MAX_ERRORS);
		const result = new Array<string>();
		for (let index = from; index < errors.size(); index++) result.push(errors[index]);
		return result;
	};

	// Ops -------------------------------------------------------------------------------------------------------------
	ops.set("claude.session", (player): ClaudeSessionView => {
		const session = activeSession();
		if (!session) return { available: false, allowed: false, branch: kernel.branch, label: "", requests: [] };
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
		const code = raw.match("^%s*(.-)%s*$")[0] as string;
		if (code === "" || code.size() > MAX_CODE) return fail("bad_code");
		const now = os.time();
		const attempts = (pairAttempts.get(player.UserId) ?? []).filter((at) => now - at < PAIR_WINDOW);
		if (attempts.size() >= PAIR_MAX) return fail("rate_limited");
		attempts.push(now);
		pairAttempts.set(player.UserId, attempts);
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

		// One active request per user (re-checked against the dev machine, so a stale record can't block forever).
		for (const record of store.requests) {
			if (record.sid !== session.sid || record.user !== player.UserId || record.finished) continue;
			refresh(session, record, player.UserId);
			if (!record.finished) return fail("busy");
		}
		const now = os.time();
		const recent = (store.sent.get(player.UserId) ?? []).filter((at) => now - at < RATE_WINDOW);
		if (recent.size() >= RATE_MAX) return fail("rate_limited");

		const context: { path?: string; errors?: string[]; artifact?: string } = { artifact: kernel.artifact.id.sub(1, 128) };
		if (typeIs(request.path, "string")) context.path = request.path.sub(1, MAX_PATH);
		if (request.errors === true) {
			const errors = lastServerErrors();
			if (typeIs(request.clientErrors, "table")) {
				for (const [, line] of pairs(request.clientErrors as object)) {
					if (typeIs(line, "string") && errors.size() < MAX_ERRORS * 2) {
						errors.push(`[client] ${line.sub(1, MAX_ERROR_CHARS)}`);
					}
				}
			}
			if (errors.size() > 0) context.errors = errors;
		}
		if (encodedSize(context) > MAX_CONTEXT_BYTES) return fail("context_too_large");

		recent.push(now);
		store.sent.set(player.UserId, recent);
		const body: { prompt: string; context: typeof context; conversationId?: string } = { prompt, context };
		if (conversationId !== undefined) body.conversationId = conversationId;
		const result = authed(session, player.UserId, "POST", "/v1/prompts", body);
		if (!result.ok) {
			// The dev machine forgot the chat (it restarted): the client starts a new one.
			if (result.error === "not_found" && conversationId !== undefined) return fail("conversation_gone");
			if (result.error === "conflict") return fail("busy");
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
		return { ok: true, request: view(record, player) };
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
		const state = shortString(reply.state, 20) ?? "queued";
		const nextIndex = shortNumber(reply.next);
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
			events: cleanEvents(reply.events, MAX_EVENTS),
			next: nextIndex !== undefined ? math.max(since, math.floor(nextIndex)) : since,
			more: reply.more === true,
			approvals: approvalsFor(player),
		};
	});

	// The player's own conversations on the dev machine, latest first.
	ops.set("claude.conversations", (player) => {
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
			let size = 0;
			for (const event of events) size += event.text.size();
			if (size > budget) events = [];
			else budget -= size;
			messages.unshift({
				id,
				prompt: prompt.sub(1, MAX_PROMPT),
				state,
				finished: isFinished(state, data.finishedAt),
				summary: shortString(data.summary, 300),
				commit: shortString(data.commit, 64),
				artifactId: shortString(data.artifactId, 128),
				error: shortString(data.error, 300),
				costUsd: shortNumber(data.costUsd),
				events,
				next: math.max(0, math.floor(shortNumber(data.next) ?? 0)),
			});
		}
		const conversation: ClaudeConversation = { id: payload, title: shortString(reply.title, 80) ?? "chat", messages };
		return { ok: true, conversation };
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

	const settleApproval = (id: string, decision: string) => {
		const pending = pendingApprovals.get(id);
		if (!pending) return;
		pendingApprovals.delete(id);
		if (coroutine.status(pending.timeout) === "suspended") task.cancel(pending.timeout);
		if (coroutine.status(pending.thread) === "suspended") task.spawn(pending.thread, decision);
	};

	/** Asks the dev in their chat; yields until they answer or APPROVAL_SECONDS pass. "once" | "always" | "deny". */
	const askApproval = (userId: number, approval: Omit<ClaudeApproval, "expiresIn">): string => {
		const thread = coroutine.running();
		const timeout = task.delay(APPROVAL_SECONDS, () => settleApproval(approval.id, "timeout"));
		pendingApprovals.set(approval.id, { userId, approval: { ...approval, expiresIn: APPROVAL_SECONDS }, expiresAt: os.clock() + APPROVAL_SECONDS, thread, timeout });
		return coroutine.yield()[0] as string;
	};

	ops.set("claude.approve", (player, payload) => {
		const request = (typeIs(payload, "table") ? payload : {}) as { id?: unknown; decision?: unknown };
		const id = request.id;
		const decision = request.decision;
		if (!typeIs(id, "string") || !typeIs(decision, "string") || !["once", "always", "deny"].includes(decision)) return fail("bad_request");
		const pending = pendingApprovals.get(id);
		if (!pending || pending.userId !== player.UserId) return fail("not_found");
		if (decision === "always" && pending.approval.conversationId !== undefined) {
			alwaysRun.set(`${player.UserId}:${pending.approval.conversationId}`, true);
		}
		settleApproval(id, decision);
		return { ok: true };
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
		return coroutine.yield() as unknown as [boolean, unknown];
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
					return { ok: false, denied: true, error: decision === "timeout" ? "no answer within 60 s" : "denied", output: [] };
				}
			}
			// The requester may have left or lost dev access while deciding.
			if (player.Parent === undefined || !kernel.isDev(player) || kernel.channel !== "dev") return { ok: false, error: "the developer is no longer a dev in this server" };
			const result = runLuau(code, { player, kernel, persist: (key: string) => kernel.persist(key, () => ({})) }, timeoutSeconds);
			$print(`[claude] run_luau for ${player.Name}: ${description} -> ${result.ok ? "ok" : "error"} (${result.ms} ms)`);
			execs.push({ at: os.time(), user: player.UserId, description, ok: result.ok, error: result.error?.sub(1, 200) });
			while (execs.size() > MAX_EXEC_LOG) execs.shift();
			return result;
		}
		return { ok: false, error: `unknown tool ${tostring(tool).sub(1, 40)}` };
	};

	/** Serves one game-tool request id for `player` (from a wake message or the pending poll). */
	const serveToolRequest = (session: Session, player: Player, requestId: string) => {
		if (handled.has(requestId)) return;
		handled.add(requestId);
		const fetched = authed(session, player.UserId, "GET", `/v1/game/requests/${requestId}`);
		if (!fetched.ok || !typeIs(fetched.data, "table")) return;
		const request = fetched.data as Record<string, unknown>;
		const [ok, answer] = pcall(() => runTool(player, request));
		const body: ToolAnswer = ok ? answer : { ok: false, error: tostring(answer).sub(1, 2000) };
		authed(session, player.UserId, "POST", `/v1/game/requests/${requestId}/result`, { output: [], ...body });
	};

	/** Who may use the game tools here right now: the session's user, in this server, a dev, paired here. */
	const toolPlayer = (session: Session, userId: number): Player | undefined => {
		if (kernel.channel !== "dev" || !session.users.includes(userId)) return undefined;
		const player = Players.GetPlayerByUserId(userId);
		if (!player || !kernel.isDev(player) || !isPaired(session, userId)) return undefined;
		return player;
	};

	const pollPending = (session: Session, player: Player) => {
		const result = authed(session, player.UserId, "GET", "/v1/game/pending");
		if (!result.ok || !typeIs(result.data, "table")) return;
		for (const item of listOf((result.data as { requests?: unknown }).requests)) {
			const id = typeIs(item, "table") ? (item as { id?: unknown }).id : undefined;
			if (typeIs(id, "string") && id.size() === 32 && matches(id, "^%x+$")) task.spawn(serveToolRequest, session, player, id);
		}
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
		// Backup poll: while a dev's prompt from this server is running (messages can be lost).
		trove.add(
			task.spawn(() => {
				while (!stopped) {
					task.wait(TOOL_POLL);
					const session = activeSession();
					if (!session) continue;
					const users = new Set<number>();
					const now = os.time();
					for (const record of store.requests) {
						if (record.sid === session.sid && !record.finished && now - record.createdAt < TOOL_POLL_WINDOW) users.add(record.user);
					}
					for (const userId of users) {
						const player = toolPlayer(session, userId);
						if (player) pcall(pollPending, session, player);
					}
				}
			}),
		);
	}
}
