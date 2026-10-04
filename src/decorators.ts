import { Modding } from "@flamework/core";
import { ModuleConfig, registered } from "./runtime/registry";

export type { ModuleConfig };

/**
 * A server module. Constructor parameters (other services) are injected; the runtime starts it in dependency order and
 * stops it in reverse on every generation swap.
 *
 * The JSDoc tag makes rbxts-transformer-flamework write the constructor's dependency ids (`flamework:parameters`),
 * the same way Flamework's own @Service does (spike S8).
 *
 * @metadata flamework:implements flamework:parameters injectable
 */
export const Service = Modding.createDecorator<[config?: ModuleConfig]>("Class", (descriptor, [config]) => {
	registered.push({ ctor: descriptor.object, realm: "server", config: config ?? {} });
});

/**
 * A client module. Same contract as @Service.
 *
 * @metadata flamework:implements flamework:parameters injectable
 */
export const Controller = Modding.createDecorator<[config?: ModuleConfig]>("Class", (descriptor, [config]) => {
	registered.push({ ctor: descriptor.object, realm: "client", config: config ?? {} });
});
