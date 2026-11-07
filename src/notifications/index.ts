import type { Trove } from "@rbxts/trove";
import type { ServerKernel } from "../kernel";
import { setNotificationsFactory } from "../typetorch";
import type { Notifications } from "./api";
import { NotifyClient } from "./client";
import { NotifyServer } from "./server";

/**
 * Binds `TypeTorch.notifications()` to this generation (runtime/start.ts, after the network is up and before any
 * module loads). The server half always starts: it verifies launch data on join (open / open_bad / played rows,
 * onOpen) and queues presence while the settings record carries `backend.notify`. The client half starts at once too, to
 * resume a prompt a swap interrupted.
 */
export function bindNotifications(realm: "server" | "client", kernel: unknown, trove: Trove) {
	let core: Notifications | undefined;
	const make = (): Notifications => {
		if (!core) core = realm === "server" ? new NotifyServer(kernel as ServerKernel, trove.extend()) : new NotifyClient(trove.extend());
		return core;
	};
	setNotificationsFactory(make);
	trove.add(() => setNotificationsFactory(undefined));
	// A failure costs the notifications (warned), never the generation; notifications() tries again.
	const [ok, err] = pcall(make);
	if (!ok) warn(`[TypeTorch] notifications didn't start: ${err}`);
}
