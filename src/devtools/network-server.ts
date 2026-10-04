import { Players } from "@rbxts/services";
import { Trove } from "@rbxts/trove";
import type { ServerKernel } from "../kernel";
import { PacketPage, PacketRecord, PacketTap, summarize } from "../net/inspect";
import type { ServerDispatcher } from "../net/runtime";
import type { DevOp } from "./protocol";

/** Seconds after a dev's last poll before their capture ends. */
const IDLE_STOP = 60;
/** How often idle watchers are swept. */
const SWEEP = 5;
/** Polls closer together than this are refused (the inspector polls once a second). */
const MIN_POLL = 0.5;
/** Packets per poll reply at most (the newest; older ones count as skipped). */
const PAGE = 200;

/**
 * Server half of the network inspector (dev menu Network > Packets). Payloads hold other players' data, so every op
 * re-checks dev status here (on top of the dev menu's own check), and capture runs only on a dev's request:
 *
 * - `net.packets {since, userId?}`: starts or keeps this dev's capture and returns the packets after `since`
 *   (a PacketPage; `userId` keeps one player's packets plus broadcasts);
 * - `net.packet <i>`: one packet with its full, pretty-printed arguments;
 * - `net.stop`: ends this dev's capture.
 *
 * The tap is attached while at least one dev watches. A dev stops watching 60 s after their last poll, when they leave
 * or lose dev status; when nobody watches, the tap detaches and its packets are dropped. Prod-channel servers allow
 * it: everything here is read-only.
 */
export function registerNetworkOps(kernel: ServerKernel, dispatcher: ServerDispatcher, trove: Trove, ops: Map<string, DevOp>) {
	const tap = new PacketTap();
	/** Dev -> os.clock() of their last poll. */
	const watchers = new Map<Player, number>();
	let sweeper: thread | undefined;

	const requireDev = (player: Player) => {
		if (!kernel.isDev(player)) error("not a dev", 0);
	};

	const stop = () => {
		if (dispatcher.tap === tap) dispatcher.tap = undefined;
		// Payloads hold other players' data: keep nothing once nobody watches.
		tap.clear();
	};

	const unwatch = (player: Player) => {
		if (watchers.delete(player) && watchers.size() === 0) stop();
	};

	const sweep = () => {
		const now = os.clock();
		for (const [player, last] of watchers) {
			if (now - last > IDLE_STOP || player.Parent !== Players || !kernel.isDev(player)) watchers.delete(player);
		}
		if (watchers.size() === 0) stop();
	};

	const watch = (player: Player) => {
		watchers.set(player, os.clock());
		dispatcher.tap = tap;
		if (sweeper !== undefined) return;
		sweeper = task.spawn(() => {
			while (watchers.size() > 0) {
				task.wait(SWEEP);
				sweep();
			}
			sweeper = undefined;
		});
	};

	ops.set("net.packets", (player, payload) => {
		requireDev(player);
		const request = (typeIs(payload, "table") ? payload : {}) as { since?: unknown; userId?: unknown };
		const since =
			typeIs(request.since, "number") && request.since >= 0 && request.since % 1 === 0 && request.since < 2 ** 52
				? request.since
				: 0;
		const userId = typeIs(request.userId, "number") ? request.userId : undefined;
		const last = watchers.get(player);
		if (last !== undefined && os.clock() - last < MIN_POLL) error("rate_limited", 0);
		watch(player);
		const filter =
			userId !== undefined ? (record: PacketRecord) => record.userId === userId || record.player === "all" : undefined;
		const [records, cursor, skipped] = tap.since(since, PAGE, filter);
		const page: PacketPage = {
			session: tap.session,
			packets: records.map(summarize),
			next: cursor,
			skipped,
			dropped: tap.dropped,
			channel: kernel.channel,
		};
		return page;
	});

	ops.set("net.packet", (player, payload) => {
		requireDev(player);
		assert(typeIs(payload, "number"), "bad id");
		const record = tap.get(payload);
		if (!record) error("gone", 0);
		return record;
	});

	ops.set("net.stop", (player) => {
		requireDev(player);
		unwatch(player);
		return true;
	});

	trove.connect(Players.PlayerRemoving, unwatch);
	trove.add(() => {
		if (sweeper !== undefined && coroutine.status(sweeper) === "suspended") task.cancel(sweeper);
		sweeper = undefined;
		watchers.clear();
		stop();
	});
}
