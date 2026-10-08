import type { BudgetCaller, BudgetKind, ServerKernel } from "./kernel";

/**
 * Kernel 0.4.0 (problem 25): counts one of the framework's own DataStore / MemoryStore / HTTP / MessagingService requests
 * for the budget view (dev menu Server > Budget, the heartbeat's `bu`). `op`: a category (read, write, list, remove,
 * publish, subscribe; MemoryStore: units) or a label (an HTTP target). Server only; older kernels: nothing. Never throws.
 */
export function countBudget(kernel: ServerKernel | undefined, caller: BudgetCaller, kind: BudgetKind, op: string, n = 1) {
	if (kernel === undefined || !typeIs((kernel as unknown as Record<string, unknown>).budgetCount, "function")) return;
	pcall(() => kernel.budgetCount!(caller, kind, op, n));
}
