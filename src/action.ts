import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { defineRelease } from "./define.ts";
import { errorMessage, ReleaseError, type ReleaseReport } from "./engine.ts";
import { OptionsError } from "./options.ts";
import { prettyReporter, type Reporter } from "./reporter.ts";
import { markdownProblems, markdownSummary } from "./summary.ts";
import { resolveWorkflowSteps } from "./workflow.ts";

export * from "./index.ts";

/**
 * Runs the GitHub Action: reads its inputs from `INPUT_*`, runs the release
 * and writes its outputs to `GITHUB_OUTPUT`. Resolves with the exit code.
 */
export async function main(
	env: NodeJS.ProcessEnv = process.env,
	reporter: Reporter | null = prettyReporter({
		...(env.GITHUB_ACTIONS === "true" && { color: true }),
	}),
): Promise<number> {
	const input = (name: string) => env[`INPUT_${name.toUpperCase()}`] ?? "";
	let summary = true;
	let report: ReleaseReport;
	try {
		summary = parseBoolean("summary", input("summary") || "true");
		const cwd = resolve(
			env.GITHUB_WORKSPACE ?? process.cwd(),
			input("working-directory") || ".",
		);
		const token = input("token");
		if (token && !env.GITHUB_TOKEN && !env.GH_TOKEN) {
			process.env.GITHUB_TOKEN = token;
		}
		const steps = await resolveWorkflowSteps(
			parseSteps(input("steps") || "- uses: conventional"),
			{ cwd },
		);
		const version = input("version");
		report = await defineRelease({ steps }).run({
			cwd,
			dryRun: parseBoolean("dry-run", input("dry-run") || "false"),
			reporter,
			...(version && { release: { version, notes: input("notes") } }),
		});
	} catch (error) {
		let issues: readonly string[];
		if (error instanceof ReleaseError) {
			// The reporter has printed the details.
			issues = [error.message];
			if (summary) await writeSummary(env, markdownSummary(error.report));
		} else {
			issues =
				error instanceof OptionsError ? error.issues : [errorMessage(error)];
			if (summary) await writeSummary(env, markdownProblems(issues));
		}
		for (const issue of issues) annotate(issue);
		return 1;
	}

	if (summary) await writeSummary(env, markdownSummary(report));
	await setOutputs(env.GITHUB_OUTPUT, {
		status: report.status,
		released: String(report.status === "released"),
		"previous-version": report.previousVersion ?? "",
		version: report.version ?? "",
		kind: report.kind ?? "",
		notes: report.notes ?? "",
	});
	return 0;
}

/** Appends to the job summary, the Markdown GitHub shows on the run's page. */
async function writeSummary(env: NodeJS.ProcessEnv, markdown: string) {
	if (env.GITHUB_STEP_SUMMARY)
		await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
}

function parseSteps(text: string): unknown {
	try {
		return parse(text);
	} catch (error) {
		throw new OptionsError([`steps: invalid YAML: ${errorMessage(error)}`]);
	}
}

function parseBoolean(name: string, value: string): boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new OptionsError([`${name}: expected true or false, got '${value}'`]);
}

function annotate(message: string) {
	const escaped = message
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
	process.stdout.write(`::error::${escaped}\n`);
}

async function setOutputs(
	file: string | undefined,
	outputs: Record<string, string>,
) {
	if (!file) return;
	const delimiter = `rylease_${randomUUID()}`;
	const text = Object.entries(outputs)
		.map(([name, value]) => `${name}<<${delimiter}\n${value}\n${delimiter}\n`)
		.join("");
	await appendFile(file, text);
}

/**
 * Lets custom step files `import { defineStep, z } from "rylease"` without
 * installing it: the import resolves to this very module.
 */
function provideSelf() {
	registerHooks({
		resolve: (specifier, context, next) =>
			specifier === "rylease"
				? { url: import.meta.url, shortCircuit: true }
				: next(specifier, context),
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	provideSelf();
	// Not awaited: custom steps import this module, so it must finish evaluating.
	void main().then((code) => {
		process.exitCode = code;
	});
}
