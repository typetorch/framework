import { branchAction, branchLabel, buildAction, buildLabel, buildName, buildTitle, pinPayload, swapsServer, type PickerContext } from "./build-actions";

/**
 * Which server and branch commands the command palette (devtools/palette.ts) offers, as pure functions over the same
 * rules the Branch tab uses (devtools/build-actions.ts): one offer per branch row and per build row that has a button
 * there, with the same words. Tested under Lune (scripts/test-commands.luau). The kernel re-checks every request.
 */

/** A branch as the palette needs it (BranchInfo). */
export interface BranchFact {
	name: string;
}

/** A build as the palette needs it (ArtifactEntry). */
export interface BuildFact {
	seq?: number;
	commit?: string;
	artifactId?: string;
	assetId: number;
	branch: string;
	channel: string;
	running?: boolean;
}

/**
 * - "switch": the owner switches THIS server (kernel.requestSwitch { branch }); "switchStored": the private/reserved
 *   server's own switch (op "switch"); "joinBranch": move only you to a reserved server on it (op "newServer" branch).
 * - "loadHere": the owner loads the build here (requestSwitch { assetId }); "pin": the dev pin (op "pin",
 *   build-actions pinPayload); "joinBuild": move only you to a reserved server on it (op "newServer" { branch, assetId }).
 */
export type OfferKind = "switch" | "switchStored" | "joinBranch" | "loadHere" | "pin" | "joinBuild";

export interface ServerOffer {
	kind: OfferKind;
	/** Stable command id ("branch.switch:dev", "build.load:123"). */
	id: string;
	/** "Switch to dev", "Join #36  4363e8c", "Load here #36  4363e8c". */
	title: string;
	branch: string;
	build?: BuildFact;
	/** It swaps what runs on this server: two-step (build-actions swapsServer). */
	confirm: boolean;
	/** The "pin" payload (build-actions pinPayload). */
	pin?: number | { assetId: number; experiment: true };
	/** A dev-channel build on a prod-rules server (the Branch tab's dark "Dev channel" button): say so when arming. */
	crossChannel?: boolean;
}

/**
 * The branch offers: every branch whose Branch-tab row has a button (`branchAction`), in list order. `current` is this
 * server's branch (no button on it).
 */
export function branchOffers(ctx: PickerContext, current: string | undefined, branches: BranchFact[]): ServerOffer[] {
	const offers = new Array<ServerOffer>();
	for (const branch of branches) {
		const action = branchAction(ctx, current !== undefined && branch.name === current);
		if (action === undefined) continue;
		const kind: OfferKind = action === "here" ? "switch" : action === "stored" ? "switchStored" : "joinBranch";
		offers.push({
			kind,
			id: `branch.${kind}:${branch.name}`,
			title: action === "join" ? `Join a ${branch.name} server` : `${branchLabel(action)} to ${branch.name}`,
			branch: branch.name,
			confirm: swapsServer(action),
		});
	}
	return offers;
}

/**
 * The build offers: every build whose Branch-tab row has a button (`buildAction`), in list order. `prodRules`: this
 * server enforces prod rules (a dev-channel build there is "cross channel").
 */
export function buildOffers(ctx: PickerContext, builds: BuildFact[], prodRules: boolean): ServerOffer[] {
	const offers = new Array<ServerOffer>();
	for (const build of builds) {
		const action = buildAction(ctx, { running: build.running === true, channel: build.channel });
		if (action === undefined) continue;
		const kind: OfferKind = action === "here" ? "loadHere" : action === "pin" ? "pin" : "joinBuild";
		const offer: ServerOffer = {
			kind,
			id: `build.${kind}:${build.assetId}`,
			title: `${buildLabel(action)} ${buildTitle(build)}`,
			branch: build.branch,
			build,
			confirm: swapsServer(action),
		};
		if (kind === "pin") {
			offer.pin = pinPayload(ctx, build.assetId);
			offer.crossChannel = prodRules && build.channel === "dev";
		}
		offers.push(offer);
	}
	return offers;
}

/** The armed line of a two-step offer: what will happen, and to how many players. */
export function confirmText(offer: ServerOffer, players: number): string {
	const who = `${players} player${players === 1 ? "" : "s"}`;
	if (offer.kind === "switch" || offer.kind === "switchStored") return `Switch this server (${who}) to ${offer.branch}?`;
	const name = offer.build !== undefined ? buildName(offer.build) : offer.branch;
	if (offer.crossChannel === true) return `Load dev build ${name} on this prod server (${who})?`;
	return `Load ${name} on this server (${who})?`;
}
