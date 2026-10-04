/**
 * @typetorch/framework: hot-swappable modules (DI, lifecycle, troves), guarded networking and the in-game dev menu.
 * Ships inside every artifact, so each generation runs its own fresh copy.
 */

export { Module } from "./module";
export type {
	BuildInfo,
	ModuleContext,
	OnInit,
	OnPhysics,
	OnPlayerAdded,
	OnRender,
	OnStart,
	OnStop,
	OnTick,
} from "./module";
export { Controller, Service } from "./decorators";
export type { ModuleConfig } from "./decorators";
export { startClient, startServer } from "./runtime/start";
export type { StartOptions } from "./runtime/start";
export { observePlayers } from "./players";
export { createNetwork, setNetworkLimits } from "./net";
export type {
	ClientNetwork,
	ClientReceiver,
	ClientSender,
	GuardTree,
	LeafLimits,
	Network,
	ProperReturns,
	ServerNetwork,
	ServerReceiver,
	ServerSender,
} from "./net";
export type {
	ArtifactInfo,
	BranchInfo,
	Channel,
	ClientKernel,
	DevInfo,
	GenerationHistoryEntry,
	Kernel,
	KernelStatus,
	LogEntry,
	ServerKernel,
	ServerType,
	SwapReport,
} from "./kernel";
export { bump, isRealFrame, observeElement, popIn, popOut, PopupQueue } from "./ui";
