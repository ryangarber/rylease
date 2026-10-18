import { describe, expect, it } from "vitest";
import type { ReleaseReport } from "./engine.ts";
import { markdownProblems, markdownSummary } from "./summary.ts";

const report = (overrides: Partial<ReleaseReport> = {}): ReleaseReport => ({
	env: { cwd: "/p", branch: "main", dryRun: false },
	status: "released",
	previousVersion: "1.0.0",
	kind: "minor",
	version: "1.1.0",
	notes: "## Features\n\n- a",
	releases: [],
	records: [
		{
			type: "release-version",
			name: "semver",
			status: "ok",
			durationMs: 0.4,
			reason: "'minor' from 1.0.0",
		},
		{
			type: "release",
			name: "announce",
			status: "skipped",
			durationMs: 0,
			reason: "`a | b` is false\nreally",
		},
	],
	...overrides,
});

describe("markdownSummary", () => {
	it("shows the release, its steps and its notes", () => {
		expect(markdownSummary(report())).toBe(
			[
				"### rylease · **1.0.0** → **1.1.0** (minor) · released",
				"",
				"On `main`.",
				"",
				"| | Type | Step | Time | |",
				"|:-:|---|---|--:|---|",
				"| ✅ | `release-version` | `semver` | <1ms | 'minor' from 1.0.0 |",
				"| ⚪ | `release` | `announce` |  | `a \\| b` is false<br>really |",
				"",
				"<details open><summary>Release notes</summary>",
				"",
				"## Features",
				"",
				"- a",
				"",
				"</details>",
				"",
				"",
			].join("\n"),
		);
	});

	it("says when it's a dry run, or nothing was released, or it failed", () => {
		const dry = markdownSummary(
			report({ env: { cwd: "/", branch: "dev", dryRun: true } }),
		);
		expect(dry).toMatch(
			/^### rylease dry run · \*\*1\.0\.0\*\* → \*\*1\.1\.0\*\* \(minor\) · would release\n\nOn `dev`, without side effects\.\n/,
		);
		expect(markdownSummary(report({ status: "unchanged" }))).toMatch(
			/^### rylease · \*\*1\.0\.0\*\* · nothing to release\n/,
		);
		const failed = markdownSummary(report({ status: "failed" }));
		expect(failed).toMatch(/^### ❌ rylease · release failed\n/);
		expect(failed).not.toContain("Release notes");
		expect(markdownProblems(["steps[0].uses: <nope>"])).toBe(
			"### ❌ rylease · invalid input\n\n- steps[0].uses: &lt;nope>\n\n",
		);
	});
});
