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
}

export interface ClaudeSessionView {
	available: boolean;
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
}
