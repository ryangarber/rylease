import { type ReleaseReport, type RunOptions, runRelease } from "./engine.ts";
import {
	type Empty,
	OptionsError,
	type OptionsInput,
	type OptionsShape,
	type OptionsValue,
	parseOptions,
} from "./options.ts";
import type {
	Step,
	StepCondition,
	StepDefinition,
	StepInput,
	StepOutputs,
	StepType,
} from "./types.ts";

export type ReleaseConfig<Ctx> = {
	/** Steps to run; they're ordered by type, keeping their order within a type. */
	steps: readonly Step<Ctx>[];
} & (undefined extends Ctx
	? {
			/** Shared, mutable state passed to every step. */
			context?: Ctx;
		}
	: {
			/** Shared, mutable state passed to every step. */
			context: Ctx;
		});

export interface Release<Ctx> {
	readonly steps: readonly Step<Ctx>[];
	run(options?: RunOptions): Promise<ReleaseReport>;
}

/**
 * Defines a release pipeline. Pass a custom context type to type the `context`
 * every step receives: `defineRelease<{ slackTs?: string }>({ context: {}, steps })`.
 */
export function defineRelease<Ctx = undefined>(
	config: ReleaseConfig<Ctx>,
): Release<Ctx> {
	return {
		steps: config.steps,
		run: (options) => runRelease(config.steps, config.context as Ctx, options),
	};
}

export interface StepFactoryDefinition<
	T extends StepType,
	N extends string,
	S extends OptionsShape,
> {
	type: T;
	/** Identifies the step in reports and in workflow `steps`, e.g. `read-git-tag`. */
	name: N;
	/** One line on what the step does, for generated docs. */
	description?: string;
	/** A zod shape; use `.default()` for optional options and `.describe()` to document them. */
	options?: S;
	run: (
		input: StepInput<T> & { options: OptionsValue<S> },
	) => StepOutputs[T] | Promise<StepOutputs[T]>;
}

/** Creates a configured step; the options argument is optional when every option is. */
export interface StepFactory<
	T extends StepType = StepType,
	N extends string = string,
	S extends OptionsShape = OptionsShape,
> {
	(
		...options: Empty extends OptionsInput<S>
			? [options?: OptionsInput<S>]
			: [options: OptionsInput<S>]
	): StepDefinition<T>;
	readonly type: T;
	readonly name: N;
	readonly description: string | undefined;
	readonly options: S;
}

/** Any step factory, whatever its type, name or options. */
export interface AnyStepFactory {
	// biome-ignore lint/suspicious/noExplicitAny: options are checked at runtime
	(options?: any): Step;
	readonly type: StepType;
	readonly name: string;
	readonly description: string | undefined;
	readonly options: OptionsShape;
}

/** What a factory accepts, e.g. `FactoryOptions<typeof gitCommit>`. */
export type FactoryOptions<F extends AnyStepFactory> = OptionsInput<
	F["options"]
>;

/**
 * Defines a reusable step whose options are declared as a zod shape. The
 * result is a factory: call it with options to get a step. Its options are
 * validated on every call, so they're just as safe when they come from a
 * workflow file.
 *
 * ```ts
 * export const header = defineStep({
 *   type: "release-notes",
 *   name: "header",
 *   options: { text: z.string().default("Released by rylease") },
 *   run: ({ notes, options }) => ({ notes: `> ${options.text}\n\n${notes}`, reason: "added header" }),
 * });
 * header({ text: "Hi" });
 * ```
 */
export function defineStep<
	T extends StepType,
	const N extends string,
	S extends OptionsShape = Empty,
>(definition: StepFactoryDefinition<T, N, S>): StepFactory<T, N, S> {
	const shape = (definition.options ?? {}) as S;
	const factory = (options?: unknown): StepDefinition<T> => {
		const parsed = parseOptions(shape, options, definition.name);
		return {
			type: definition.type,
			name: definition.name,
			run: (input) =>
				definition.run({
					...input,
					options: parsed,
				} as unknown as StepInput<T> & {
					options: OptionsValue<S>;
				}),
		};
	};
	return Object.defineProperties(factory, {
		type: { value: definition.type, enumerable: true },
		name: { value: definition.name, enumerable: true },
		description: { value: definition.description, enumerable: true },
		options: { value: shape, enumerable: true },
	}) as unknown as StepFactory<T, N, S>;
}

/** Options for each step of a preset, by name; `false` leaves a step out. */
export type PresetOptions<F extends readonly AnyStepFactory[]> = {
	[K in F[number] as K["name"]]?: FactoryOptions<K> | false;
};

/** A named list of step factories that's configured, and used, as one. */
export interface Preset<
	N extends string = string,
	F extends readonly AnyStepFactory[] = readonly AnyStepFactory[],
> {
	(options?: PresetOptions<F>): Step[];
	readonly name: N;
	readonly description: string | undefined;
	readonly steps: F;
}

/**
 * Bundles step factories under one name. Calling the preset creates every
 * step, passing each its options by name:
 * `conventional({ "github-release": false, semver: { shiftPreMajor: false } })`.
 */
export function definePreset<
	const N extends string,
	const F extends readonly AnyStepFactory[],
>(definition: { name: N; description?: string; steps: F }): Preset<N, F> {
	const names = definition.steps.map((step) => step.name);
	const preset = (options: Record<string, unknown> = {}): Step[] => {
		const unknown = Object.keys(options).filter((key) => !names.includes(key));
		if (unknown.length > 0) {
			throw new OptionsError(
				unknown.map(
					(key) =>
						`${definition.name}: '${key}' isn't one of its steps (${names.join(", ")})`,
				),
			);
		}
		return definition.steps.flatMap((factory) => {
			const value = options[factory.name];
			if (value === false) return [];
			try {
				return [(factory as (options: unknown) => Step)(value)];
			} catch (error) {
				// Point at the option inside the preset, e.g. `conventional.semver.x`.
				throw error instanceof OptionsError
					? new OptionsError(
							error.issues.map((issue) => `${definition.name}.${issue}`),
						)
					: error;
			}
		});
	};
	return Object.defineProperties(preset, {
		name: { value: definition.name, enumerable: true },
		description: { value: definition.description, enumerable: true },
		steps: { value: definition.steps, enumerable: true },
	}) as unknown as Preset<N, F>;
}

/**
 * Makes a step run only when `condition` holds, on top of any condition it
 * already has: `when(steps.npmPublish(), ({ env }) => !env.dryRun)`.
 */
export function when<T extends StepType, Ctx = unknown>(
	step: StepDefinition<T, Ctx>,
	condition: StepCondition<T, Ctx>,
): StepDefinition<T, Ctx> {
	const own = step.if;
	const source = condition.source ?? "its condition";
	const combined: StepCondition<T, Ctx> = own
		? Object.assign(
				(input: StepInput<T, Ctx>) => condition(input) && own(input),
				{ source: `${source} && ${own.source ?? "its own condition"}` },
			)
		: condition;
	return { ...step, if: combined };
}
