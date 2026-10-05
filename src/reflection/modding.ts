/**
 * TypeTorch runtime kit: Modding.
 *
 * Decorator factories and the macro marker types that `@typetorch/transformer` recognises. A function becomes a user
 * macro with the JSDoc tag `@metadata macro`; its optional trailing parameters typed with the types below are filled
 * in at compile time:
 *
 * ```ts
 * /** @metadata macro *\/
 * export function guardOf<T>(guard?: Modding.Generic<T, "guard">) { return guard!; }
 * guardOf<{ x: number }>(); // compiles to guardOf(t.interface({ x = t.number }))
 * ```
 *
 * The marker properties (`_typetorch_*`) only exist in the type system. Their names are what the transformer matches,
 * so these types must stay exactly as they are.
 *
 * Adapted from Flamework's Modding (MIT, Copyright (c) 2021 Flamework).
 */
import type { t } from "@rbxts/t";
import { Reflect } from "./reflect";

export type Constructor<T = object> = new (...args: never[]) => T;
export type AbstractConstructor<T = object> = abstract new (...args: never[]) => T;

interface BaseDescriptor {
	/** The id of the decorator (from its declaration, e.g. `@typetorch/framework:decorators@Service`). */
	id: string;

	/** The object this decorator is attached to. */
	object: AbstractConstructor;

	/** The constructor this decorator is attached to, unless abstract. */
	constructor?: Constructor;
}

export interface ClassDescriptor extends BaseDescriptor {}
export interface MethodDescriptor extends PropertyDescriptor {}
export interface PropertyDescriptor extends BaseDescriptor {
	property: string;
	isStatic: boolean;
}

type TSDecorator<T> = T & { /** @hidden */ _typetorch_decorator: never };
type ClassDecorator = TSDecorator<(ctor: defined) => never>;
type MethodDecorator = TSDecorator<(target: defined, propertyKey: string, descriptor: defined) => never>;
type PropertyDecorator = TSDecorator<(target: defined, propertyKey: string) => never>;
type DecoratorWithMetadata<T, P> = T & { /** @hidden */ _typetorch_parameters: P };
type Decorator<P extends readonly unknown[], D> = DecoratorWithMetadata<
	P extends { length: 0 } ? ((...args: P) => D) & D : (...args: P) => D,
	P
>;

export namespace Modding {
	/**
	 * Registers a class decorator. The transformer replaces `@Decorator(args)` with
	 * `Reflect.decorate(Class, "<decorator id>", Decorator, [args])`, which calls `func` when the class's module loads.
	 *
	 * Ask for class metadata with JSDoc on the decorator's declaration, e.g.
	 * `@metadata typetorch:parameters injectable` writes the constructor's dependency ids.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Class",
		func: (descriptor: ClassDescriptor, config: T) => void,
	): Decorator<T, ClassDecorator>;

	/**
	 * Registers a method decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Method",
		func: (descriptor: MethodDescriptor, config: T) => void,
	): Decorator<T, MethodDecorator>;

	/**
	 * Registers a property decorator.
	 */
	export function createDecorator<T extends readonly unknown[] = void[]>(
		kind: "Property",
		func: (descriptor: PropertyDescriptor, config: T) => void,
	): Decorator<T, PropertyDecorator>;

	export function createDecorator(
		_kind: "Method" | "Property" | "Class",
		func: (...args: never[]) => void,
	): Decorator<void[], ClassDecorator | MethodDecorator | PropertyDecorator> {
		return {
			func: (descriptor: PropertyDescriptor, config: unknown[]) => {
				defineDecoratorMetadata(descriptor, config);
				func(descriptor as never, config as never);
			},
		} as never;
	}

	/**
	 * Registers a class decorator that only records metadata.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Class",
	): Decorator<T, ClassDecorator>;

	/**
	 * Registers a method decorator that only records metadata.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Method",
	): Decorator<T, MethodDecorator>;

	/**
	 * Registers a property decorator that only records metadata.
	 */
	export function createMetaDecorator<T extends readonly unknown[] = void[]>(
		kind: "Property",
	): Decorator<T, PropertyDecorator>;

	export function createMetaDecorator(
		_kind: "Method" | "Property" | "Class",
	): Decorator<void[], ClassDecorator | MethodDecorator | PropertyDecorator> {
		return {
			func: (descriptor: PropertyDescriptor, config: unknown[]) => {
				defineDecoratorMetadata(descriptor, config);
			},
		} as never;
	}

	/**
	 * The arguments a decorator was applied with, by decorator id (`typetorch:decorators.<id>` metadata).
	 */
	export function getDecoratorArguments<A extends readonly unknown[] = unknown[]>(
		object: object,
		id: string,
		property?: string,
	): A | undefined {
		return Reflect.getOwnMetadata<{ arguments: A }>(object, `typetorch:decorators.${id}`, property)?.arguments;
	}

	/**
	 * Fills in compile-time metadata about `T`:
	 * - `"guard"`: a `t` type guard generated from the type;
	 * - `"id"`: the type's stable id (`<module>@<Name>`, or `<package>:<module>@<Name>` for package declarations);
	 * - `"text"`: the type as a string.
	 */
	export type Generic<T, M extends keyof GenericMetadata<T>> = GenericMetadata<T>[M] & {
		/** @hidden */ _typetorch_macro_generic: [T, M];
	};

	/**
	 * Several kinds of {@link Generic} metadata about one type, as an object (`{ id, guard }`).
	 */
	export type GenericMany<T, M extends keyof GenericMetadata<T>> = Modding.Many<{ [k in M]: Generic<T, k> }>;

	/**
	 * An object, tuple or array whose leaves are macro types (or literals); the transformer builds the whole value.
	 * Mapped and recursive types work, e.g. one guard per method of a nested interface:
	 *
	 * ```ts
	 * type GuardTree<T> = {
	 * 	[K in keyof T]: T[K] extends (...args: infer A) => unknown ? Modding.Generic<A, "guard"> : GuardTree<T[K]>;
	 * };
	 * function createNetwork<T>(guards?: Modding.Many<GuardTree<T>>) {}
	 * ```
	 */
	export type Many<T> = T & {
		/** @hidden */ _typetorch_macro_many: T;
	};

	/**
	 * Fills in compile-time metadata about the call site.
	 */
	export type Caller<M extends keyof CallerMetadata> = CallerMetadata[M] & {
		/** @hidden */ _typetorch_macro_caller: M;
	};

	/**
	 * Several kinds of {@link Caller} metadata, as an object.
	 */
	export type CallerMany<M extends keyof CallerMetadata> = Modding.Many<{ [k in M]: Caller<k> }>;

	/**
	 * The labels of a tuple (for example parameter names via `Parameters<F>`), under {@link Many}.
	 */
	export type TupleLabels<T extends readonly unknown[]> =
		| (string[] & { /** @hidden */ _typetorch_macro_tuple_labels: T })
		| undefined;

	function defineDecoratorMetadata(descriptor: PropertyDescriptor, config: unknown[]) {
		const propertyKey = descriptor.isStatic ? `static:${descriptor.property}` : descriptor.property;
		Reflect.defineMetadata(
			descriptor.object,
			`typetorch:decorators.${descriptor.id}`,
			{
				arguments: config,
			},
			propertyKey,
		);

		let decoratorList = Reflect.getOwnMetadata<string[]>(descriptor.object, `typetorch:decorators`, propertyKey);
		if (!decoratorList) {
			Reflect.defineMetadata(descriptor.object, "typetorch:decorators", (decoratorList = []), propertyKey);
		}

		decoratorList.push(descriptor.id);
	}

	interface CallerMetadata {
		/** The starting line of the expression. */
		line: number;

		/** The char at the start of the expression relative to the starting line. */
		character: number;

		/** The width of the expression, including multiline statements. */
		width: number;

		/** A unique identifier for this exact call site (random per compile). */
		uuid: string;

		/** The source text of the expression. */
		text: string;
	}

	interface GenericMetadata<T> {
		/** The id of the type. */
		id: string;

		/** A string equivalent of the type. */
		text: string;

		/** A generated guard for the type. */
		guard: t.check<T>;
	}
}
