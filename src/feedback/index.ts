import type { Trove } from "@rbxts/trove";
import { setFeedbackFactory } from "../typetorch";
import type { Feedback } from "./api";
import { FeedbackServer } from "./server";

/**
 * Binds `TypeTorch.feedback()` to this generation (runtime/start.ts, before any module loads). Server only: on a
 * client `feedback()` throws (the client never writes this kind; send the player's answer through your own network).
 */
export function bindFeedback(realm: "server" | "client", trove: Trove) {
	if (realm !== "server") return;
	let core: Feedback | undefined;
	setFeedbackFactory(() => {
		if (!core) core = new FeedbackServer();
		return core;
	});
	trove.add(() => setFeedbackFactory(undefined));
}
