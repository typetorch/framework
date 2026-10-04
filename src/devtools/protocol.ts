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
