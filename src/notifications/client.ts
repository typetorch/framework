import { ExperienceNotificationService } from "@rbxts/services";
import type { Trove } from "@rbxts/trove";
import { $warn } from "rbxts-transform-debug";
import { maybeClientDispatcher } from "../net/runtime";
import { TypeTorch } from "../typetorch";
import type { Notifications, NotifyOpen, OptInResult } from "./api";
import { CHANNEL, isWhere, type OptInRow, type WantOptions } from "./protocol";

/**
 * The client half of TypeTorch notifications (plans/29): Roblox's opt-in prompt with its rows. CanPromptOptInAsync
 * (pcall, 10 s deadline) → PromptOptIn → OptInPromptClosed (120 s deadline); one prompt at a time, once per session.
 * The state lives in persist, so a swap mid-prompt neither prompts again nor loses the close row: the next generation
 * picks the open prompt up (resume). Rows go to the server, which checks them and writes them (never a raw client row).
 */

const PERSIST_KEY = "__typetorch/notify-client.v1";
const CHECK_DEADLINE = 10;
const CLOSE_DEADLINE = 120;

interface PromptState {
	/** idle → checking → shown → done. Once out of idle, never again this session. */
	phase: "idle" | "checking" | "shown" | "done";
	where: string;
	/** os.clock() when the prompt was shown (the client process survives swaps, so the clock does too). */
	shownAt: number;
}

function newState(): PromptState {
	return { phase: "idle", where: "", shownAt: 0 };
}

export class NotifyClient implements Notifications {
	private readonly state: PromptState;
	private stopped = false;
	private waiting = false;
	private closeSeen = false;
	private closeConnection?: RBXScriptConnection;

	constructor(private readonly trove: Trove) {
		this.state = TypeTorch.persist(PERSIST_KEY, newState);
		trove.add(() => {
			this.stopped = true;
		});
		const state = this.state;
		// A swap stopped the last generation mid-check: its answer is lost (the check is counted as an error).
		if (state.phase === "checking") {
			state.phase = "done";
			this.send({ name: "optin_check", where: state.where, can: false, err: "swap" });
		}
		// Mid-prompt: wait for the close here (the prompt stays on screen across the swap).
		if (state.phase === "shown") task.spawn(() => this.waitForClose());
	}

	want(_user: Player | number, _kind: string, _options?: WantOptions): boolean {
		$warn("[notifications] want() is server-only");
		return false;
	}

	drop(_user: Player | number, _kind: string, _key?: string, _why?: string): boolean {
		$warn("[notifications] drop() is server-only");
		return false;
	}

	onOpen(_callback: (player: Player, open: NotifyOpen) => void): () => void {
		$warn("[notifications] onOpen() is server-only (the launch data is verified on the server)");
		return () => {};
	}

	private send(row: OptInRow) {
		const dispatcher = maybeClientDispatcher();
		if (!dispatcher || this.stopped) return;
		pcall(() => dispatcher.kernel.send(CHANNEL, "optin", row));
	}

	/** Listens for OptInPromptClosed (before PromptOptIn, so a fast close isn't missed). */
	private listenClose() {
		if (this.closeConnection) return;
		this.closeConnection = this.trove.add(
			ExperienceNotificationService.OptInPromptClosed.Connect(() => {
				this.closeSeen = true;
			}),
		);
	}

	/** Waits for OptInPromptClosed (or the deadline) and sends optin_closed once. */
	private waitForClose() {
		if (this.waiting) return;
		this.waiting = true;
		this.listenClose();
		const state = this.state;
		const deadline = state.shownAt + CLOSE_DEADLINE;
		while (!this.closeSeen && os.clock() < deadline && !this.stopped) task.wait(0.1);
		this.closeConnection?.Disconnect();
		this.closeConnection = undefined;
		this.waiting = false;
		// Stopped by a swap: the next generation resumes (the phase stays "shown").
		if (this.stopped || state.phase !== "shown") return;
		state.phase = "done";
		const secs = math.max(0, math.floor(os.clock() - state.shownAt));
		this.send({ name: "optin_closed", where: state.where, secs, err: this.closeSeen ? undefined : "timeout" });
	}

	promptOptIn(where: string): OptInResult {
		if (!isWhere(where)) {
			$warn(`[notifications] promptOptIn(where): where must be 1-32 of [a-zA-Z0-9_]`);
			return "error";
		}
		const state = this.state;
		if (state.phase === "checking" || state.phase === "shown") return "busy";
		if (state.phase === "done") return "already";
		state.phase = "checking";
		state.where = where;

		const check: { done: boolean; ok?: boolean; can?: boolean; err?: string } = { done: false };
		task.spawn(() => {
			const [ok, result] = pcall(() => ExperienceNotificationService.CanPromptOptInAsync());
			check.ok = ok;
			if (ok) check.can = result === true;
			else check.err = tostring(result).sub(1, 64);
			check.done = true;
		});
		const deadline = os.clock() + CHECK_DEADLINE;
		while (!check.done && os.clock() < deadline && !this.stopped) task.wait(0.1);
		if (this.stopped) return "error";
		if (!check.done || !check.ok) {
			state.phase = "done";
			this.send({ name: "optin_check", where, can: false, err: check.done ? check.err : "timeout" });
			return "error";
		}
		this.send({ name: "optin_check", where, can: check.can === true });
		if (!check.can) {
			state.phase = "done";
			return "unavailable";
		}

		this.listenClose();
		state.shownAt = os.clock();
		state.phase = "shown";
		const [shownOk, problem] = pcall(() => ExperienceNotificationService.PromptOptIn());
		if (!shownOk) {
			state.phase = "done";
			$warn(`[notifications] PromptOptIn failed: ${tostring(problem).sub(1, 120)}`);
			return "error";
		}
		this.send({ name: "optin_shown", where });
		this.waitForClose();
		return "shown";
	}
}
