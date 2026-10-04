import { HttpService, MessagingService, RunService } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import type { ServerKernel } from "../kernel";
import type { ClaudePromptRequest, ClaudeRequestView, ClaudeSessionView, DevOp } from "./protocol";

/**
 * Game side of `typetorch remote-claude` (plans/11). A dev's machine announces a session over MessagingService; this
 * server keeps it only when its effective channel is "dev" and its branch is the session branch, exchanges the
 * Secrets Store secret for a short-lived JWT per user, and forwards prompts.
 *
 * SECRECY: the session URL and every token stay in server memory. They are never sent to a client, never printed
 * (server logs reach dev clients through the Logs tab) and never put in attributes. HTTP failures are reported as
 * short codes only, because Roblox error text can contain the URL.
 */

const TOPIC = "TypeTorch/remote-claude";
const SECRET_NAME = "typetorch_remote_claude";
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
const FINISHED_STATES = new Set(["deployed", "failed", "cancelled"]);

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
}

/** Kept in the kernel persist store, so it survives swaps (including the one Claude's own deploy causes). */
interface Store {
	session?: Session;
	requests: RequestRecord[];
	/** userId -> unix times of accepted prompts (rate limit). */
	sent: Map<number, number[]>;
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

export function registerRemoteClaude(kernel: ServerKernel, trove: Trove, ops: Map<string, DevOp>) {
	const store = kernel.persist<Store>(PERSIST_KEY, () => ({ requests: [], sent: new Map() }));
	// userId -> [access token, expires at (unix)]. Generation memory only: never persisted, sent or printed.
	const tokens = new Map<number, [string, number]>();
	const exchanging = new Set<number>();

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
				tokens.clear();
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
		if (store.session?.sid !== sid) tokens.clear();
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
		headers: Record<string, string | Secret>,
		body?: unknown,
	): [sent: boolean, status: number, data: unknown] => {
		const request: RequestAsyncRequest = { Url: `${session.url}${path}`, Method: method, Headers: headers };
		if (body !== undefined) request.Body = HttpService.JSONEncode(body);
		const [ok, response] = pcall(() => HttpService.RequestAsync(request));
		// Never log or return the error text: it can contain the URL.
		if (!ok) return [false, 0, undefined];
		return [true, response.StatusCode, decode(response.Body)];
	};

	const tokenFor = (session: Session, userId: number): [ok: boolean, tokenOrError: string] => {
		while (exchanging.has(userId)) task.wait(0.1);
		const cached = tokens.get(userId);
		if (cached && cached[1] - TOKEN_MARGIN > os.time()) return [true, cached[0]];
		const [secretOk, secret] = pcall(() => HttpService.GetSecret(SECRET_NAME));
		if (!secretOk) return [false, "no_secret"];
		exchanging.add(userId);
		const [sent, status, data] = send(
			session,
			"POST",
			"/v1/token",
			{ Authorization: (secret as Secret).AddPrefix("Bearer "), "Content-Type": "application/json" },
			{ sid: session.sid, user: userId, job: game.JobId, branch: session.branch },
		);
		exchanging.delete(userId);
		if (!sent) return [false, "unreachable"];
		if (status !== 200) return [false, httpError(status)];
		const reply = (typeIs(data, "table") ? data : {}) as { access_token?: unknown; expires_in?: unknown };
		const token = reply.access_token;
		const expiresIn = reply.expires_in;
		if (!typeIs(token, "string") || token.size() > 4096 || !typeIs(expiresIn, "number")) return [false, "bad_reply"];
		tokens.set(userId, [token, os.time() + expiresIn]);
		return [true, token];
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
		record.finished = FINISHED_STATES.has(record.state) || reply.finishedAt !== undefined;
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
		return { available: true, allowed, branch: session.branch, label: session.sid.sub(1, 8), requests };
	});

	ops.set("claude.prompt", (player, payload) => {
		if (kernel.channel !== "dev") return fail("prod_channel");
		const session = activeSession();
		if (!session) return fail("not_connected");
		if (!session.users.includes(player.UserId)) return fail("not_allowed");

		const request = (typeIs(payload, "string") ? { prompt: payload } : payload) as Partial<ClaudePromptRequest>;
		if (!typeIs(request, "table") || !typeIs(request.prompt, "string")) return fail("bad_request");
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
		const result = authed(session, player.UserId, "POST", "/v1/prompts", { prompt, context });
		if (!result.ok) return result;
		const reply = (typeIs(result.data, "table") ? result.data : {}) as { id?: unknown; state?: unknown };
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
}
