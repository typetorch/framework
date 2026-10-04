/** Dev menu wire format (raw channels on the kernel transport; plans/10). */
export const DEV_REQUEST = "__tt/dev";
export const DEV_RESPONSE = "__tt/devres";
/** Server -> any client: (requestId, since) asks for that client's recent logs (a dev's Logs > Others view). */
export const DEVLOGS_REQUEST = "__tt/devlogs-req";
/** Client -> server: (requestId, LogEntry[]) the answer; accepted only from the asked player for a pending id. */
export const DEVLOGS_RESPONSE = "__tt/devlogs-res";
/** What a client sends at most: its newest entries, capped by count and by text bytes. */
export const DEVLOGS_MAX_ENTRIES = 200;
export const DEVLOGS_MAX_BYTES = 48 * 1024;

export interface DexNode {
	name: string;
	className: string;
	children: number;
}

export interface DexProperty {
	name: string;
	value: string;
	/** "string" | "number" | "boolean" | other typeof() names; only the first three are editable. */
	kind: string;
}

export interface ModuleSummary {
	name: string;
	dependencies: string[];
	loadOrder: number;
	initMs?: number;
}

export interface NetStat {
	path: string;
	inbound: number;
	outbound: number;
	rejected: number;
	errors: number;
}

/** A dev menu op on the server: (acting player, request payload) -> reply. Throwing replies `ok = false`. */
export type DevOp = (player: Player, payload: unknown) => unknown;

export interface ModuleState extends ModuleSummary {
	/** Lifecycle hooks the module implements (onInit, onStart, ...). */
	hooks: string[];
}

export interface PersistSummary {
	key: string;
	kind: string;
	entries: number;
	preview: string;
}

export interface StateSummary {
	modules: ModuleState[];
	persist: PersistSummary[];
}

/** One remote-claude request as a dev client sees it (never the session URL or any token). */
export interface ClaudeRequestView {
	id: string;
	state: string;
	prompt: string;
	by: string;
	mine: boolean;
	finished: boolean;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	log?: string[];
	/** The conversation the prompt belongs to (dev-server chats). */
	conversationId?: string;
}

export interface ClaudeSessionView {
	available: boolean;
	/** No session yet, but the server started recently: the next announcement may still come (claude.ts). */
	searching?: boolean;
	allowed: boolean;
	/** The requesting player has tokens for this session (paired with the code printed by typetorch-dev-server). */
	paired?: boolean;
	branch?: string;
	/** First 8 characters of the session id. */
	label: string;
	requests: ClaudeRequestView[];
}

/** What the client sends with op "claude.prompt". */
export interface ClaudePromptRequest {
	prompt: string;
	/** Selected dex instance, e.g. "server game/Workspace/Coins". */
	path?: string;
	/** Attach the server's last errors. */
	errors?: boolean;
	/** The client's last errors. */
	clientErrors?: string[];
	/** Continue this conversation (Claude resumes its session); absent = a new chat. */
	conversationId?: string;
}

/** Terminal states: deployed | committed | answered | failed | cancelled (plus "lost" when the dev machine forgot it). */
export type ClaudeEventKind = "assistant_text" | "tool_use" | "tool_result" | "status" | "error";

/** One event of a prompt (dev-server GET /v1/prompts/:id?since=n), already redacted by the dev machine. */
export interface ClaudeEvent {
	i: number;
	kind: ClaudeEventKind;
	text: string;
	tool?: string;
	target?: string;
	/** assistant_text: chunks with the same block number form one text block. */
	block?: number;
	/** status: the new state. */
	state?: string;
	/** Game tools: the input (run_luau code) on tool_use, the full result on tool_result (capped). */
	detail?: string;
}

/** A run_luau snippet waiting for the requesting dev's approval (shown in their chat). */
export interface ClaudeApproval {
	id: string;
	description: string;
	code: string;
	conversationId?: string;
	/** Seconds left before it is denied automatically. */
	expiresIn: number;
}

/** Op "claude.events" {id, since} → the prompt's state and its events i >= since. */
export interface ClaudeEventsReply {
	ok: boolean;
	error?: string;
	id?: string;
	state?: string;
	finished?: boolean;
	conversationId?: string;
	summary?: string;
	commit?: string;
	artifactId?: string;
	/** Why the run failed (the op itself failed when ok = false; see error). */
	runError?: string;
	/** Claude Code's own estimate (runs use the dev's subscription, never per-token billing). */
	costUsd?: number;
	events?: ClaudeEvent[];
	/** Pass as `since` next time. */
	next?: number;
	/** Another page is ready now. */
	more?: boolean;
	/** run_luau snippets waiting for this player's approval. */
	approvals?: ClaudeApproval[];
}

export interface ClaudeConversationSummary {
	id: string;
	title: string;
	updatedAt: number;
	prompts: number;
	state?: string;
}

export interface ClaudeMessage {
	id: string;
	prompt: string;
	state: string;
	finished: boolean;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	costUsd?: number;
	events: ClaudeEvent[];
	next: number;
}

export interface ClaudeConversation {
	id: string;
	title: string;
	messages: ClaudeMessage[];
}
