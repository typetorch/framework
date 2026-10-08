/**
 * What a failed upload to the dev's analytics / fleet server means, and what to do about it. Shared by the analytics
 * engine's log line (at most one a minute) and the dev menu (Status > Analytics / Fleet API, the "Attention" list), so
 * both say the same thing.
 *
 * `HttpService.RequestAsync` throws a message with Roblox's HttpError name in it ("HttpError: NetFail"); a reply that
 * isn't 2xx has a status. The names that matter to a dev running the server on their own PC behind a Cloudflare quick
 * tunnel (`bun run local`):
 *
 *   NetFail        the connection broke mid-request (curl send/receive error, nothing usable came back): the server or
 *                  tunnel restarted, dropped it, or is overloaded. The usual one when the dev PC's tunnel flaps.
 *   DnsResolve     the host name doesn't resolve: the quick tunnel's URL died with its cloudflared (a new run gets a new
 *                  URL) and the settings still hold the old one.
 *   ConnectFail    nothing accepted the connection.
 *   TimedOut       it accepted but never answered.
 *   (HTTP 530/1033 a tunnel with nothing behind it, 502/504 a tunnel whose server is down, 401/403 a wrong token, 404 a
 *                  wrong path.)
 *
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-net-health.luau). Nothing here
 * ever sees or returns a token.
 */

export interface FailureHelp {
	/** What happened, in a few words ("the connection broke mid-request"). */
	reason: string;
	/** What to do about it, one or two sentences. */
	fix: string;
}

/** The Roblox HttpError name in an error message ("HttpError: NetFail" -> "NetFail"), or undefined. */
export function httpErrorName(message: string | undefined): string | undefined {
	if (message === undefined) return undefined;
	const [name] = message.match("HttpError:%s*(%w+)");
	return typeIs(name, "string") ? name : undefined;
}

const RUN_LOCAL = "run bun run local on the dev PC (it opens a new tunnel and updates these settings)";

/**
 * Help for a failed request. `status` is the HTTP status (0: no answer at all) and `message` the error text (from the
 * thrown HttpError, or "HTTP 530" style text for a status; either may be missing).
 */
export function describeFailure(status: number, message?: string): FailureHelp {
	if (status > 0) return describeStatus(status);
	const text = message ?? "";
	const name = httpErrorName(text);
	const lower = text.lower();
	if (lower.find("not enabled", 1, true)[0] !== undefined || lower.find("httpenabled", 1, true)[0] !== undefined) {
		return { reason: "HttpService is off for this place", fix: "turn on Game Settings > Security > Allow HTTP Requests (HttpService.HttpEnabled)." };
	}
	if (lower.find("exceeded limit", 1, true)[0] !== undefined || lower.find("too many requests", 1, true)[0] !== undefined) {
		return { reason: "Roblox's HTTP limit for this server is used up", fix: "a server may send 500 requests a minute in all; analytics sends about 10, so something else is using the rest." };
	}
	if (name === "NetFail") {
		return {
			reason: "NetFail: the connection broke mid-request",
			fix: `the dev PC's quick tunnel or server restarted, dropped it or is overloaded (a quick tunnel is for testing; use a real domain in production). Run typetorch doctor; if the address is stale, ${RUN_LOCAL}.`,
		};
	}
	if (name === "DnsResolve") {
		return { reason: "DnsResolve: the host name doesn't resolve", fix: `for a trycloudflare.com address the quick tunnel is gone and the URL changed: ${RUN_LOCAL}. Otherwise check the URL for typos (typetorch doctor).` };
	}
	if (name === "ConnectFail") {
		return { reason: "ConnectFail: nothing accepted the connection", fix: `the server or its tunnel is down, or the address or port is wrong. Run typetorch doctor; ${RUN_LOCAL} restarts both.` };
	}
	if (name === "TimedOut") {
		return { reason: "TimedOut: the server didn't answer in time", fix: "it is overloaded, asleep (the dev PC suspended?) or its tunnel is stuck. Run typetorch doctor." };
	}
	if (name === "SslConnectFail" || name === "SslVerificationFail") {
		return { reason: `${name}: the TLS certificate was refused`, fix: "use an address with a valid certificate (the Cloudflare tunnel, or Caddy on a VPS)." };
	}
	if (name === "InvalidUrl") {
		return { reason: "InvalidUrl: the address isn't a valid URL", fix: "set it again with typetorch settings set analytics - (typetorch doctor tests it)." };
	}
	if (name === "TooManyRedirects" || name === "InvalidRedirect") {
		return { reason: `${name}: the address redirects`, fix: "use the final address directly in the settings." };
	}
	if (name !== undefined) return { reason: `HttpError ${name}`, fix: "run typetorch doctor to test the address and token." };
	return { reason: text === "" ? "no answer" : text.sub(1, 120), fix: "run typetorch doctor to test the address and token." };
}

function describeStatus(status: number): FailureHelp {
	if (status === 530) return { reason: "HTTP 530: the tunnel has nothing behind it", fix: `the dev PC's tunnel or server stopped: ${RUN_LOCAL}.` };
	if (status === 502 || status === 504) return { reason: `HTTP ${status}: the server behind the tunnel doesn't answer`, fix: `start the analytics server again: ${RUN_LOCAL}.` };
	if (status === 401 || status === 403) {
		return {
			reason: `HTTP ${status}: the server refused the token`,
			fix: "put one of the server's TT_ANALYTICS_INGEST_TOKENS in the settings (typetorch fleet setup, typetorch settings set analytics -); typetorch doctor tests it.",
		};
	}
	if (status === 404) return { reason: "HTTP 404: no such address on the server", fix: `the URL is wrong (analytics ends in /v1/ingest) or the tunnel points at nothing. Run typetorch doctor; ${RUN_LOCAL}.` };
	if (status === 408) return { reason: "HTTP 408: the server timed out", fix: "it is overloaded; the engine retries with a growing pause." };
	if (status === 413) return { reason: "HTTP 413: the batch was too large", fix: "the engine splits it and sends again." };
	if (status === 429) return { reason: "HTTP 429: rate limited", fix: "too many requests for the server or tunnel; the engine retries with a growing pause." };
	if (status >= 500) return { reason: `HTTP ${status}: the server is failing`, fix: "check the analytics server's log." };
	return { reason: `HTTP ${status}`, fix: "run typetorch doctor to test the address and token." };
}

/** Help for a kernel Fleet sender error text: "HTTP 530", or an HttpError message (`status().fleet.lastError`). */
export function describeFleetError(lastError: string | undefined): FailureHelp | undefined {
	if (lastError === undefined) return undefined;
	const [code] = lastError.match("^HTTP (%d+)$");
	if (typeIs(code, "string")) return describeFailure(tonumber(code) ?? 0, lastError);
	return describeFailure(0, lastError);
}
