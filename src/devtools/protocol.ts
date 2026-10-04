/** Dev menu wire format (raw channels on the kernel transport; plans/10). */
export const DEV_REQUEST = "__tt/dev";
export const DEV_RESPONSE = "__tt/devres";

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
