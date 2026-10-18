import { performance } from "node:perf_hooks";
import { defaultReporter, type Reporter } from "./reporter.ts";
import {
	type Change,
	type ChangesOutput,
	type Environment,
	KINDS,
	type Kind,
	type KindOutput,
	type NotesOutput,
	PHASES,
	type PreviousVersionOutput,
	type ReleaseKind,
	type ReleaseOutput,
	type ReleaseResult,
	type Step,
	type StepOutputs,
	type StepRecord,
	type StepType,
} from "./types.ts";
import { tryGit } from "./utils/git.ts";
import { parseVersion } from "./utils/semver.ts";

export interface RunOptions {
	/** Defaults to `process.cwd()`. */
	cwd?: string;
	/** Defaults to the CI branch or the checked-out git branch. */
	branch?: string;
	/** Defaults to `false`. */
	dryRun?: boolean;
	/** Defaults to pretty output on stdout; pass `null` for silence. */
	reporter?: Reporter | null;
	/**
	 * A release that's already been worked out, e.g. by an earlier job: only
	 * the `release` steps run, for this version, and every other step is
	 * skipped.
	 */
	release?: GivenRelease;
}

export interface GivenRelease {
	version: string;
	/** Defaults to none. */
	notes?: string;
	/** Defaults to the version itself. */
	previousVersion?: string;
	/** Defaults to the difference between the versions, or `patch`. */
	kind?: ReleaseKind;
}

export type ReleaseStatus = "released" | "unchanged" | "failed";

export interface ReleaseReport {
	env: Environment;
	status: ReleaseStatus;
	records: StepRecord[];
	previousVersion?: string;
	previousRef?: string;
	kind?: Kind;
	version?: string;
	notes?: string;
	releases: ReleaseResult[];
	error?: unknown;
}

export class ReleaseError extends Error {
	readonly report: ReleaseReport;

	constructor(message: string, report: ReleaseReport, options?: ErrorOptions) {
		super(message, options);
		this.name = "ReleaseError";
		this.report = report;
	}
}

const KIND_PHASE = phaseIndex("release-kind");

function phaseIndex(type: StepType): number {
	return PHASES.indexOf(type);
}

/** Phases that must have at least one step for a release to be possible. */
const REQUIRED_PHASES = PHASES.filter((type) => type !== "release");

/** What each phase produces, where later phases read it. */
const PHASE_VALUES = {
	"previous-version": "previousVersion",
	"release-changes": "changes",
	"release-kind": "kind",
	"release-version": "version",
	"release-notes": "notes",
	release: "releases",
} as const satisfies Record<StepType, keyof State>;

interface State {
	previousVersion: string | undefined;
	previousRef: string | undefined;
	changes: Change[] | undefined;
	kind: Kind | undefined;
	version: string | undefined;
	notes: string | undefined;
	releases: ReleaseResult[];
}

/** Stable sort of steps by phase; steps of the same type keep their order. */
export function sortSteps<S extends { type: StepType }>(
	steps: readonly S[],
): S[] {
	return [...steps].sort((a, b) => phaseIndex(a.type) - phaseIndex(b.type));
}

export async function runRelease<Ctx>(
	steps: readonly Step<Ctx>[],
	context: Ctx,
	options: RunOptions = {},
): Promise<ReleaseReport> {
	const cwd = options.cwd ?? process.cwd();
	const env: Environment = {
		cwd,
		branch: options.branch ?? (await detectBranch(cwd)),
		dryRun: options.dryRun ?? false,
	};
	const reporter =
		options.reporter === undefined ? defaultReporter() : options.reporter;
	const given = options.release;
	const ordered = sortSteps(steps);

	const state: State = {
		previousVersion: undefined,
		previousRef: undefined,
		changes: undefined,
		kind: undefined,
		version: undefined,
		notes: undefined,
		releases: [],
	};
	if (given) {
		const previousVersion = given.previousVersion ?? given.version;
		Object.assign(state, {
			previousVersion,
			changes: [],
			kind: given.kind ?? difference(previousVersion, given.version),
			version: given.version,
			notes: given.notes ?? "",
		});
	}
	const records: StepRecord[] = [];
	const report = (status: ReleaseStatus, error?: unknown): ReleaseReport => ({
		env,
		status,
		records,
		releases: state.releases,
		...definedOnly({
			previousVersion: state.previousVersion,
			previousRef: state.previousRef,
			kind: state.kind,
			version: state.version,
			notes: state.notes,
			error,
		}),
	});
	const skipRest = (from: number, reason: string) => {
		for (const step of ordered.slice(from)) {
			const record: StepRecord = {
				type: step.type,
				name: step.name,
				status: "skipped",
				durationMs: 0,
				reason,
			};
			records.push(record);
			reporter?.step?.(record);
		}
	};

	reporter?.start?.(env, ordered);

	const missing = given
		? []
		: REQUIRED_PHASES.filter(
				(type) => !ordered.some((step) => step.type === type),
			);
	if (missing.length > 0) {
		const error = new Error(`no step provided for: ${missing.join(", ")}`);
		const result = report("failed", error);
		reporter?.finish?.(result);
		throw new ReleaseError(error.message, result, { cause: error });
	}

	for (const [index, step] of ordered.entries()) {
		if (given && step.type !== "release") {
			const record: StepRecord = {
				type: step.type,
				name: step.name,
				status: "skipped",
				durationMs: 0,
				reason: `releasing the given ${given.version}`,
			};
			records.push(record);
			reporter?.step?.(record);
			continue;
		}
		// Past the kind phase, a `none` kind means there's nothing to release.
		if (state.kind === "none" && phaseIndex(step.type) > KIND_PHASE) {
			skipRest(index, "no release-worthy changes");
			const result = report("unchanged");
			reporter?.finish?.(result);
			return result;
		}

		const input = {
			...definedOnly({
				previousVersion: state.previousVersion,
				previousRef: state.previousRef,
				changes: state.changes,
				kind: state.kind,
				version: state.version,
				notes: state.notes,
			}),
			releases: [...state.releases],
			env: { ...env },
			context,
			history: [...records],
		};

		const start = performance.now();
		let output: StepOutputs[StepType];
		try {
			// Conditions may have skipped every step of an earlier phase.
			for (const type of PHASES.slice(0, phaseIndex(step.type))) {
				if (state[PHASE_VALUES[type]] === undefined) {
					throw new Error(
						`no '${type}' step ran, so it has no ${PHASE_VALUES[type]}`,
					);
				}
			}
			const condition = step.if as ((input: unknown) => boolean) | undefined;
			if (condition && !condition(input)) {
				const source = (condition as { source?: string }).source;
				const record: StepRecord = {
					type: step.type,
					name: step.name,
					status: "skipped",
					durationMs: performance.now() - start,
					reason: source ? `\`${source}\` is false` : "its condition is false",
				};
				records.push(record);
				reporter?.step?.(record);
				continue;
			}
			// `input` holds every value the step's phase requires, since every
			// earlier phase is guaranteed to have run at least one step.
			const run = step.run as (input: unknown) => unknown;
			output = validateOutput(step.type, await run(input));
		} catch (error) {
			const record: StepRecord = {
				type: step.type,
				name: step.name,
				status: "failed",
				durationMs: performance.now() - start,
				reason: errorMessage(error),
				error,
			};
			records.push(record);
			reporter?.step?.(record);
			skipRest(index + 1, `'${step.type}' step '${step.name}' failed`);
			const result = report("failed", error);
			reporter?.finish?.(result);
			throw new ReleaseError(
				`${step.type} step '${step.name}' failed: ${record.reason}`,
				result,
				{ cause: error },
			);
		}

		const record = {
			type: step.type,
			name: step.name,
			status: "ok",
			durationMs: performance.now() - start,
			reason: output.reason,
			output,
		} as StepRecord;
		records.push(record);
		reporter?.step?.(record);
		apply(state, step, output);
	}

	const result = report(state.kind === "none" ? "unchanged" : "released");
	reporter?.finish?.(result);
	return result;
}

/** `major`, `minor` or `patch`: the highest part that differs. */
function difference(from: string, to: string): ReleaseKind {
	const a = parseVersion(from);
	const b = parseVersion(to);
	if (a.major !== b.major) return "major";
	if (a.minor !== b.minor) return "minor";
	return "patch";
}

function apply(
	state: State,
	step: { type: StepType; name: string },
	output: StepOutputs[StepType],
) {
	const value = output as Partial<
		PreviousVersionOutput &
			ChangesOutput &
			KindOutput &
			NotesOutput &
			ReleaseOutput
	>;
	switch (step.type) {
		case "previous-version":
			state.previousVersion = value.version;
			state.previousRef = value.ref;
			break;
		case "release-changes":
			state.changes = value.changes;
			break;
		case "release-kind":
			state.kind = value.kind;
			break;
		case "release-version":
			state.version = value.version;
			break;
		case "release-notes":
			state.notes = value.notes;
			break;
		case "release":
			state.releases.push({
				name: step.name,
				output: value.output,
				files: value.files ?? [],
			});
			break;
	}
}

/** Guards against untyped (e.g. plain JS) steps returning malformed output. */
function validateOutput<T extends StepType>(
	type: T,
	value: unknown,
): StepOutputs[T] {
	const fail = (problem: string): never => {
		throw new TypeError(`invalid output: ${problem}`);
	};
	if (typeof value !== "object" || value === null) {
		return fail("expected an object");
	}
	const output = value as Record<string, unknown>;
	if (typeof output.reason !== "string" || output.reason.trim() === "") {
		fail("'reason' must be a non-empty string");
	}
	switch (type) {
		case "previous-version":
		case "release-version":
			if (typeof output.version !== "string" || output.version === "") {
				fail("'version' must be a non-empty string");
			}
			if (
				type === "previous-version" &&
				output.ref !== undefined &&
				(typeof output.ref !== "string" || output.ref === "")
			) {
				fail("'ref' must be a non-empty string when present");
			}
			break;
		case "release-changes":
			if (
				!Array.isArray(output.changes) ||
				!output.changes.every(
					(change: unknown) =>
						typeof change === "object" &&
						change !== null &&
						typeof (change as Change).reason === "string",
				)
			) {
				fail("'changes' must be an array of changes, each with a 'reason'");
			}
			break;
		case "release-kind":
			if (!(KINDS as readonly unknown[]).includes(output.kind)) {
				fail(`'kind' must be one of ${KINDS.join(", ")}`);
			}
			break;
		case "release-notes":
			if (typeof output.notes !== "string") {
				fail("'notes' must be a string");
			}
			break;
		case "release":
			if (!("output" in output)) {
				fail("'output' is required (use null for none)");
			}
			if (
				output.files !== undefined &&
				!(
					Array.isArray(output.files) &&
					output.files.every((file) => typeof file === "string")
				)
			) {
				fail("'files' must be an array of paths when present");
			}
			break;
	}
	return value as StepOutputs[T];
}

async function detectBranch(cwd: string): Promise<string> {
	const fromCi = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
	if (fromCi) return fromCi;
	return (await tryGit(cwd, "rev-parse", "--abbrev-ref", "HEAD")) ?? "unknown";
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Drops `undefined` properties, for `exactOptionalPropertyTypes`. */
function definedOnly<T extends object>(
	object: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
	return Object.fromEntries(
		Object.entries(object).filter(([, value]) => value !== undefined),
	) as { [K in keyof T]?: Exclude<T[K], undefined> };
}
