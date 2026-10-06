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
// The runtime of @typetorch/transformer: generated code imports Reflect (and t) from here; games write user macros
// with Modding (`/** @metadata macro */ function f<T>(guard?: Modding.Generic<T, "guard">)`).
export { Modding, Reflect, t } from "./reflection";
export type { AbstractConstructor, ClassDescriptor, Constructor, MethodDescriptor, PropertyDescriptor } from "./reflection";
export { startClient, startServer } from "./runtime/start";
export type { StartOptions, StopGeneration } from "./runtime/start";
// Module lookup outside constructor injection (Flamework's Dependency<T>()), and Lazy<T> to break cycles.
export { Dependency, Lazy } from "./runtime/dependency";
export type { PlayerState } from "./runtime/player-state";
export { TypeTorch } from "./typetorch";
export type { BranchChange, TypeTorchApi, TypeTorchFeatures } from "./typetorch";
export type { MessageSource, MessagingApi, MessagingSubscribeOptions } from "./messaging";
export type { GameServer, ServerListOptions } from "./servers";
export type { LiveConfig, LiveConfigOptions } from "./settings";
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
	ArtifactEntry,
	ArtifactInfo,
	BranchInfo,
	Channel,
	ClientKernel,
	DevInfo,
	GameMessageMeta,
	GenerationHistoryEntry,
	GenerationStart,
	Kernel,
	KernelSettings,
	KernelStatus,
	LogEntry,
	MessageTarget,
	MessagingPublishOptions,
	MessagingPublishReport,
	MessagingStatus,
	NewServerReport,
	PendingUpdate,
	PreviousGeneration,
	Role,
	SettingsStatus,
	ServerKernel,
	ServerType,
	StartReason,
	SwapOutInfo,
	SwapReport,
} from "./kernel";
export { bump, isRealFrame, observeElement, popIn, popOut, PopupQueue } from "./ui";
export { hotAsset } from "./assets/hot-asset";
// Analytics (plans/16): optional, nothing runs until `new AnalyticsEngine()`.
export { AnalyticsEngine } from "./analytics/engine";
export type {
	AnalyticsOptions,
	AnalyticsProps,
	AnalyticsPurchase,
	AnalyticsSettings,
	AnalyticsStats,
	AnalyticsValue,
	DeployReport,
	DeviceKind,
	EventKind,
	EventRow,
	ExperimentOverride,
	FleetStatus,
	RecordingRow,
} from "./analytics/schema";
export type { HotAsset } from "./assets/hot-asset";
export type { AssetEntry, AssetSource, AssetStatus, AssetSyncReport } from "./assets/manifest";
