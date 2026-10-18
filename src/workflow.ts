import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AnyStepFactory, type Preset, when } from "./define.ts";
import {
	compileExpression,
	ExpressionError,
	expressionContext,
} from "./expression.ts";
import { OptionsError } from "./options.ts";
import * as presets from "./presets/index.ts";
import * as steps from "./steps/index.ts";
import {
	PHASES,
	type Step,
	type StepDefinition,
	type StepInput,
	type StepType,
} from "./types.ts";

const builtins = new Map<string, AnyStepFactory | Preset>(
	[...Object.values(steps), ...Object.values(presets)].map((item) => [
		item.name,
		item,
	]),
);

export interface WorkflowOptions {
	/** Paths and packages are resolved from here. */
	cwd: string;
}

/**
 * Turns workflow `steps` (already parsed from YAML) into steps. Each entry
 * names what it `uses`, passes it options `with`, and may run only `if` an
 * expression holds:
 *
 * ```yaml
 * - uses: conventional              # a bundled preset or step
 *   with:
 *     github-release: false
 * - uses: ./release/announce.ts     # a file's default export
 *   if: "!dryRun && kind != 'patch'"
 *   with:
 *     channel: "#releases"
 * - uses: some-package#slackNotes   # a package's named export
 * ```
 */
export async function resolveWorkflowSteps(
	entries: unknown,
	options: WorkflowOptions,
): Promise<Step[]> {
	if (!Array.isArray(entries)) {
		throw new OptionsError(["steps: expected a list of steps"]);
	}
	const parsed = entries.map((entry, index) => parseEntry(entry, index));
	const steps: Step[] = [];
	// Which preset each step came from, to catch steps configured twice.
	const fromPreset = new Map<string, string>();
	const explicit: { name: string; at: string }[] = [];

	for (const { uses, with: value, condition, at } of parsed) {
		const target = await load(uses, `${at}.uses`, options.cwd);
		let created: Step[];
		try {
			if (isPreset(target)) {
				created = target(value as never);
				for (const step of created) fromPreset.set(step.name, target.name);
			} else {
				created = [target(value)];
				explicit.push({ name: target.name, at });
			}
		} catch (error) {
			if (!(error instanceof OptionsError)) throw error;
			// Issues start with the step's or preset's name; point at `with`.
			throw new OptionsError(
				error.issues.map(
					(issue) =>
						`${at}.with${issue.startsWith(target.name) ? issue.slice(target.name.length) : `: ${issue}`}`,
				),
			);
		}
		steps.push(
			...created.map((step) =>
				condition
					? (when(step as StepDefinition<StepType>, condition) as Step)
					: step,
			),
		);
	}

	const twice = explicit.flatMap(({ name, at }) => {
		const preset = fromPreset.get(name);
		return preset
			? [
					`${at}.uses: '${name}' is already in '${preset}'; configure it there (with: { ${name}: ... }), or set it to false there to replace it`,
				]
			: [];
	});
	if (twice.length > 0) throw new OptionsError(twice);
	return steps;
}

const ENTRY_KEYS = ["uses", "with", "if"];

function parseEntry(
	entry: unknown,
	index: number,
): { uses: string; with: unknown; condition?: Condition; at: string } {
	const at = `steps[${index}]`;
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		throw new OptionsError([
			`${at}: expected a map with 'uses', and optionally 'with' and 'if'`,
		]);
	}
	const fields = entry as Record<string, unknown>;
	const unknown = Object.keys(fields).filter(
		(key) => !ENTRY_KEYS.includes(key),
	);
	if (unknown.length > 0) {
		throw new OptionsError(
			unknown.map(
				(key) => `${at}.${key}: unknown key; use ${ENTRY_KEYS.join(", ")}`,
			),
		);
	}
	if (typeof fields.uses !== "string" || fields.uses === "") {
		throw new OptionsError([
			`${at}.uses: expected the name of a step or preset`,
		]);
	}
	if (
		fields.with != null &&
		(typeof fields.with !== "object" || Array.isArray(fields.with))
	) {
		throw new OptionsError([`${at}.with: expected a map of options`]);
	}
	const condition = parseCondition(fields.if, `${at}.if`);
	return {
		uses: fields.uses,
		with: fields.with ?? undefined,
		...(condition && { condition }),
		at,
	};
}

type Condition = { (input: StepInput<StepType>): boolean; source: string };

/**
 * `if:` is a rylease expression, or a boolean, e.g. what GitHub made of
 * `${{ ... }}` before rylease ran.
 */
function parseCondition(value: unknown, at: string): Condition | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "boolean") {
		return Object.assign(() => value, { source: String(value) });
	}
	if (typeof value !== "string") {
		throw new OptionsError([`${at}: expected an expression or a boolean`]);
	}
	try {
		const evaluate = compileExpression(value);
		return Object.assign(
			(input: StepInput<StepType>) =>
				Boolean(evaluate(expressionContext(input))),
			{ source: value },
		);
	} catch (error) {
		if (!(error instanceof ExpressionError)) throw error;
		throw new OptionsError([`${at}: ${error.message} in \`${value}\``]);
	}
}

async function load(
	name: string,
	path: string,
	cwd: string,
): Promise<AnyStepFactory | Preset> {
	const builtin = builtins.get(name);
	if (builtin) return builtin;

	const [specifier = name, exportName = "default"] = name.split("#");
	const isPath = /^\.{0,2}\//.test(specifier);
	let url: string;
	try {
		url = isPath
			? pathToFileURL(resolve(cwd, specifier)).href
			: pathToFileURL(
					createRequire(join(cwd, "package.json")).resolve(specifier),
				).href;
	} catch {
		throw new OptionsError([
			`${path}: unknown step; use one of ${[...builtins.keys()].join(", ")}, a path like ./steps/x.ts, or an installed package`,
		]);
	}

	const module = (await import(url)) as Record<string, unknown>;
	const target = module[exportName];
	if (isFactory(target) || isPreset(target)) return target;
	throw new OptionsError([
		`${path}: export '${exportName}' of ${specifier} isn't a step made with defineStep or a preset made with definePreset`,
	]);
}

function isFactory(value: unknown): value is AnyStepFactory {
	if (typeof value !== "function") return false;
	const factory = value as Partial<AnyStepFactory>;
	return (
		(PHASES as readonly unknown[]).includes(factory.type) &&
		typeof factory.options === "object"
	);
}

function isPreset(value: unknown): value is Preset {
	return (
		typeof value === "function" &&
		Array.isArray((value as Partial<Preset>).steps)
	);
}
