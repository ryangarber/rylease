import type { ReleaseReport } from "./engine.ts";
import { formatDuration } from "./reporter.ts";

const ICONS = { ok: "✅", skipped: "⚪", failed: "❌" } as const;

/**
 * The report as Markdown, for GitHub's job summary: what happened, a row per
 * step, and the release notes.
 */
export function markdownSummary(report: ReleaseReport): string {
	const from = report.previousVersion ?? "?";
	const to = report.version ?? "?";
	const dryRun = report.env.dryRun;
	const versions =
		from === to ? `**${to}**` : `**${from}** → **${to}** (${report.kind})`;
	const headline = {
		released: `${versions} · ${dryRun ? "would release" : "released"}`,
		unchanged: `**${from}** · nothing to release`,
		failed: "release failed",
	}[report.status];
	const lines = [
		`### ${report.status === "failed" ? "❌ " : ""}rylease${dryRun ? " dry run" : ""} · ${headline}`,
		"",
		`On \`${report.env.branch}\`${dryRun ? ", without side effects" : ""}.`,
		"",
		"| | Type | Step | Time | |",
		"|:-:|---|---|--:|---|",
		...report.records.map(
			(record) =>
				`| ${ICONS[record.status]} | \`${record.type}\` | \`${record.name}\` | ${
					record.status === "skipped" ? "" : formatDuration(record.durationMs)
				} | ${cell(record.reason)} |`,
		),
	];
	if (report.status === "released" && report.notes?.trim()) {
		lines.push(
			"",
			"<details open><summary>Release notes</summary>",
			"",
			report.notes.trim(),
			"",
			"</details>",
		);
	}
	return `${lines.join("\n")}\n\n`;
}

/** Problems with the input itself, before any step ran. */
export function markdownProblems(issues: readonly string[]): string {
	return [
		"### ❌ rylease · invalid input",
		"",
		...issues.map((issue) => `- ${cell(issue)}`),
		"",
		"",
	].join("\n");
}

/** Text that stays inside one table cell or list item. */
function cell(text: string): string {
	return text
		.replaceAll("|", "\\|")
		.replaceAll("<", "&lt;")
		.replace(/\r?\n/g, "<br>");
}
