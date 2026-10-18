import type { ReleaseReport } from "./engine.ts";
import type { Environment, StepRecord, StepType } from "./types.ts";

/** Receives progress from the engine; every hook is optional. */
export interface Reporter {
	start?(
		env: Environment,
		steps: readonly { type: StepType; name: string }[],
	): void;
	step?(record: StepRecord): void;
	finish?(report: ReleaseReport): void;
}

export interface PrettyReporterOptions {
	/** Defaults to writing to stdout. */
	write?: (text: string) => void;
	/** Defaults to `true` on a TTY unless `NO_COLOR` is set. */
	color?: boolean;
}

const ANSI = {
	bold: [1, 22],
	dim: [2, 22],
	red: [31, 39],
	green: [32, 39],
	yellow: [33, 39],
	magenta: [35, 39],
	cyan: [36, 39],
} as const;

type Style = keyof typeof ANSI;

/** Aligned, colored output: one row per step with type, name, duration and reason. */
export function prettyReporter(options: PrettyReporterOptions = {}): Reporter {
	const write =
		options.write ?? ((text: string) => void process.stdout.write(text));
	const color =
		options.color ??
		(process.env.FORCE_COLOR !== undefined ||
			(process.stdout.isTTY === true && process.env.NO_COLOR === undefined));
	const paint = (style: Style, text: string) =>
		color ? `\x1b[${ANSI[style][0]}m${text}\x1b[${ANSI[style][1]}m` : text;

	let typeWidth = 0;
	let nameWidth = 0;
	let dryRun = false;

	return {
		start(env, steps) {
			dryRun = env.dryRun;
			typeWidth = Math.max(0, ...steps.map((step) => step.type.length));
			nameWidth = Math.max(0, ...steps.map((step) => step.name.length));
			const mode = env.dryRun ? paint("yellow", "dry run") : "release";
			write(
				`\n${paint("bold", "rylease")} ${mode} ${paint("dim", "·")} ${paint("cyan", env.branch)} ${paint("dim", `· ${env.cwd}`)}\n\n`,
			);
		},
		step(record) {
			const icon = {
				ok: paint("green", "✔"),
				skipped: paint("dim", "○"),
				failed: paint("red", "✖"),
			}[record.status];
			const type = paint("magenta", record.type.padEnd(typeWidth));
			const name = paint("bold", record.name.padEnd(nameWidth));
			const duration = paint(
				"dim",
				(record.status === "skipped"
					? "-"
					: formatDuration(record.durationMs)
				).padStart(7),
			);
			const reason =
				record.status === "ok"
					? record.reason
					: paint(record.status === "failed" ? "red" : "dim", record.reason);
			write(`  ${icon} ${type}  ${name}  ${duration}  ${reason}\n`);
		},
		finish(report) {
			const from = report.previousVersion ?? "?";
			let summary: string;
			if (report.status === "failed") {
				summary = paint("red", "release failed");
			} else if (report.status === "unchanged") {
				summary = `${paint("bold", from)} ${paint("dim", "·")} nothing to release`;
			} else {
				const action = dryRun ? paint("yellow", "would release") : "released";
				const to = paint("green", paint("bold", report.version ?? "?"));
				// A given release may not say what it was released from.
				summary =
					from === report.version
						? `${to} ${paint("dim", "·")} ${action}`
						: `${paint("bold", from)} → ${to} ${paint("dim", `(${report.kind})`)} ${paint("dim", "·")} ${action}`;
			}
			write(`\n  ${summary}\n\n`);
		},
	};
}

export function defaultReporter(): Reporter {
	return prettyReporter();
}

export function formatDuration(ms: number): string {
	if (ms < 1) return "<1ms";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
}
