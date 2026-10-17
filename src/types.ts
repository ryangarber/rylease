/** Every step type, in the order the engine runs them. */
export const PHASES = [
	"previous-version",
	"release-changes",
	"release-kind",
	"release-version",
	"release-notes",
	"release",
] as const;

export type StepType = (typeof PHASES)[number];

export const KINDS = ["major", "minor", "patch", "none"] as const;

export type Kind = (typeof KINDS)[number];

/** A kind that actually produces a release; `none` stops the pipeline. */
export type ReleaseKind = Exclude<Kind, "none">;

/** A single, source-agnostic change (a commit section, an issue, a PR, ...). */
export interface Change {
	title?: string;
	description?: string;
	/** Where this change came from, e.g. `commit aefc3af`. */
	reason: string;
	/** Where to read more, e.g. `{ label: "aefc3af", url: ".../commit/aefc3af..." }`. */
	link?: { label: string; url: string };
}

export interface VersionOutput {
	version: string;
	/** e.g. `'major' from 1.2.3`. */
	reason: string;
}

export interface PreviousVersionOutput extends VersionOutput {
	/**
	 * The commit the previous version was released from, when known. Later
	 * steps (e.g. collecting changes) start from here; without it they look at
	 * all history.
	 */
	ref?: string;
}

export interface ChangesOutput {
	changes: Change[];
	/** e.g. `6 changes in 4 commits since 1a2b3c4`. */
	reason: string;
}

export interface KindOutput {
	kind: Kind;
	/** e.g. `'feat!' in title (commit aefc3af)`. */
	reason: string;
}

export interface NotesOutput {
	notes: string;
	/** e.g. `minor release, 3 features, 1 fix`. */
	reason: string;
}

export interface ReleaseOutput {
	output: unknown;
	/** Files the step changed (or would change in a dry run), relative to `cwd`. */
	files?: string[];
	/** e.g. `wrote 1.3.0 to package.json`. */
	reason: string;
}

/** What each step type must return. */
export interface StepOutputs {
	"previous-version": PreviousVersionOutput;
	"release-changes": ChangesOutput;
	"release-kind": KindOutput;
	"release-version": VersionOutput;
	"release-notes": NotesOutput;
	release: ReleaseOutput;
}

/** The output of a prior `release` step, as seen by later `release` steps. */
export interface ReleaseResult {
	name: string;
	output: unknown;
	files: readonly string[];
}

/**
 * What each step type receives from prior steps. Values from earlier phases are
 * always present; the value of a step's own phase is only present when an
 * earlier step of the same type already ran.
 */
export interface StepResults {
	"previous-version": {
		previousVersion?: string;
		previousRef?: string;
	};
	"release-changes": {
		previousVersion: string;
		previousRef?: string;
		changes?: Change[];
	};
	"release-kind": {
		previousVersion: string;
		previousRef?: string;
		changes: Change[];
		kind?: Kind;
	};
	"release-version": {
		previousVersion: string;
		previousRef?: string;
		changes: Change[];
		kind: ReleaseKind;
		version?: string;
	};
	"release-notes": {
		previousVersion: string;
		previousRef?: string;
		changes: Change[];
		kind: ReleaseKind;
		version: string;
		notes?: string;
	};
	release: {
		previousVersion: string;
		previousRef?: string;
		changes: Change[];
		kind: ReleaseKind;
		version: string;
		notes: string;
		releases: readonly ReleaseResult[];
	};
}

export interface Environment {
	/** Root directory of the project being released. */
	cwd: string;
	/** Current branch name. */
	branch: string;
	/** When set, steps must not cause side effects. */
	dryRun: boolean;
}

export type StepStatus = "ok" | "skipped" | "failed";

/** The audit record of a single step. */
export type StepRecord = {
	[T in StepType]: {
		type: T;
		name: string;
		status: StepStatus;
		durationMs: number;
		reason: string;
		output?: StepOutputs[T];
		error?: unknown;
	};
}[StepType];

export type StepInput<T extends StepType, Ctx = unknown> = StepResults[T] & {
	env: Environment;
	/** User-defined state shared by every step. Never used by bundled steps. */
	context: Ctx;
	/** Records of every step that ran before this one. */
	history: readonly StepRecord[];
};

export interface StepDefinition<T extends StepType, Ctx = unknown> {
	type: T;
	name: string;
	run: (input: StepInput<T, Ctx>) => StepOutputs[T] | Promise<StepOutputs[T]>;
}

/** Any step, discriminated by `type`. */
export type Step<Ctx = unknown> = {
	[T in StepType]: StepDefinition<T, Ctx>;
}[StepType];
