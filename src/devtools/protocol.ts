import type { ClaudeImageMeta } from "./claude-images";

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
	/**
	 * Framework 0.4.1: why this player may not use Claude here (access.ts DevRefusal: "dev_branch_only",
	 * "owner_switch_only", "owners_only"); absent when they may.
	 */
	refused?: string;
}

/** live: act on this server (run_luau with approval), no file edits; code: edit the branch, deploy after approval. */
export type ClaudeMode = "live" | "code";

/** What the client sends with op "claude.prompt". */
export interface ClaudePromptRequest {
	prompt: string;
	/** Default "live". */
	mode?: ClaudeMode;
	/** Selected dex instance, e.g. "server game/Workspace/Coins". */
	path?: string;
	/** "My logs": the client's log history as text (newest kept, about 64 KB; the server caps it again). */
	clientLogs?: string;
	/** "Server logs": attach this server's log history (gathered on the server). */
	serverLogs?: boolean;
	/** Screenshots from op "claude.attach" (ids from the dev machine, at most 4). */
	attachments?: string[];
	/** "Player logs": the UserId of a player in this server whose client logs go with the message (fetched on the server). */
	playerLogs?: number;
	/**
	 * "Toolbox": the dev picked it in the "+" menu for this message, so Claude may search the Creator Store (and insert,
	 * with approval, in Live mode). One message only: the chip clears after the send (plans/14).
	 */
	toolbox?: boolean;
	/** Continue this conversation (Claude resumes its session); absent = a new chat. */
	conversationId?: string;
}

export type ClaudeToolboxType = "Model" | "MeshPart" | "Decal" | "Audio";

/** A Creator Store asset as the dev machine's search saw it (strangers' text, already cleaned and re-checked here). */
export interface ClaudeToolboxTile {
	id: number;
	type: ClaudeToolboxType;
	name: string;
	creator: string;
	verified: boolean;
	/** Models: the listing's script count. */
	scripts?: number;
	upPercent?: number;
	voteCount?: number;
	triangles?: number;
	/** Audio: length in seconds. */
	seconds?: number;
}

/** What a toolbox_insert approval card shows: the dev machine's snapshot plus this server's own scan of the load. */
export interface ClaudeToolboxApproval {
	asset: ClaudeToolboxTile;
	/** What the loaded asset holds (Models / MeshParts; absent for Decals and Audio). */
	found?: { instances: number; parts: number; meshParts: number; scripts: number };
	/** What the strict sanitizer removes (default). */
	removes?: { scripts: number; remotes: number; other: number };
	/** Server scripts that "Keep scripts" would keep (names and paths only: game code can't read Script.Source). */
	keepable?: string[];
	/** Where it goes, in a few words ("in front of you"). */
	goesTo: string;
	/** Claude's reason: context, not an instruction. */
	reason?: string;
	/** Short warnings: "Unverified creator", "Listing says 0 scripts, found 2", "High poly". */
	warnings: string[];
}

/** Op "claude.approve" options for a toolbox insert (ignored for run_luau). */
export interface ClaudeToolboxOptions {
	anchor: boolean;
	/** Off by default; keeps server scripts sandboxed with a fixed safe capability set (spike T4). */
	keepScripts: boolean;
}

/** Op "claude.toolboxRemove" {insertId}: removes an insert the requesting dev made (the inserted card's Remove). */
export interface ClaudeToolboxRemoveRequest {
	insertId: string;
}

/**
 * Terminal states: deployed | discarded | committed | answered | failed | cancelled (plus "lost" when the dev machine
 * forgot it). "proposed" (a code change waits for Deploy / Discard) and "building" are not terminal.
 */
export type ClaudeEventKind = "assistant_text" | "tool_use" | "tool_result" | "status" | "error" | "deploy_proposal" | "image" | "toolbox_results";

/** One changed file of a deploy proposal (-1 lines = binary). */
export interface ClaudeFileChange {
	path: string;
	added: number;
	removed: number;
}

/**
 * A code change waiting for (or past) the requesting dev's Deploy / Discard. After Deploy, "awaiting_approval" while the
 * deploy waits for `typetorch approve <approvalId>` on the dev's PC; then "deployed", "rejected" or "approval_expired".
 */
export interface ClaudeProposal {
	status: "pending" | "deploying" | "awaiting_approval" | "deployed" | "discarded" | "expired" | "rejected" | "approval_expired" | "failed";
	/** The dev machine's short proposal id (8 hex) while it waits for approval. */
	approvalId?: string;
	commit: string;
	/** Unix seconds. */
	expiresAt: number;
	files: ClaudeFileChange[];
	error?: string;
}

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
	/** tool_use / tool_result: the tool_use id that pairs a result with its call. */
	ref?: string;
	/** deploy_proposal: the commit, the changed files and when it expires (unix s). */
	commit?: string;
	files?: ClaudeFileChange[];
	expiresAt?: number;
	/** image: an image Claude showed (op "claude.image" fetches it to this client). */
	image?: ClaudeImageMeta;
	/** toolbox_results: the Creator Store results Claude got (at most 10 tiles). */
	tiles?: ClaudeToolboxTile[];
}

/**
 * A run_luau snippet (kind "luau", the default) or a toolbox insert (kind "toolbox": Insert / Deny only, no "always")
 * waiting for the requesting dev's approval (shown in their chat).
 */
export interface ClaudeApproval {
	id: string;
	kind?: "luau" | "toolbox";
	description: string;
	/** run_luau: the snippet; "" for a toolbox insert. */
	code: string;
	conversationId?: string;
	/** Seconds left before it is denied automatically. */
	expiresIn: number;
	toolbox?: ClaudeToolboxApproval;
}

/** A toolbox insert this dev made (the inserted card's Remove; op "claude.toolboxRemove"). */
export interface ClaudeToolboxInsert {
	insertId: string;
	assetId: number;
	name: string;
	path: string;
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
	/** run_luau snippets and toolbox inserts waiting for this player's approval. */
	approvals?: ClaudeApproval[];
	/** Toolbox inserts this player made for this prompt that are still in the server. */
	inserts?: ClaudeToolboxInsert[];
	mode?: ClaudeMode;
	/** A code change waiting for (or past) Deploy / Discard. */
	proposal?: ClaudeProposal;
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
	mode?: ClaudeMode;
	proposal?: ClaudeProposal;
	finished: boolean;
	summary?: string;
	commit?: string;
	artifactId?: string;
	error?: string;
	costUsd?: number;
	events: ClaudeEvent[];
	/** The ids of the screenshots sent with it. */
	attachments?: string[];
	next: number;
}

export interface ClaudeConversation {
	id: string;
	title: string;
	messages: ClaudeMessage[];
}
