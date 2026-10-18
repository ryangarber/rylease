import { describe, expect, it } from "vitest";
import {
	compileExpression,
	type ExpressionContext,
	expressionContext,
} from "./expression.ts";
import type { StepInput } from "./types.ts";

const context: ExpressionContext = {
	dryRun: false,
	branch: "release/2",
	cwd: "/",
	previousVersion: "1.4.0",
	kind: "minor",
	version: "1.5.0",
	changes: [{ reason: "commit a" }],
	steps: {
		"github-release": { status: "ok", output: { url: "https://x/1" } },
		semver: { status: "skipped" },
	},
};

const evaluate = (source: string) => compileExpression(source)(context);

describe("compileExpression", () => {
	it.each([
		["true", true],
		["null", null],
		["'it''s'", "it's"],
		["1.5", 1.5],
		["dryRun", false],
		["!dryRun", true],
		["kind == 'minor'", true],
		["kind != 'minor' || version", "1.5.0"],
		["dryRun && version", false],
		["notes == null", true],
		["!(kind == 'major') && version >= '1.5.0'", true],
		["changes[0].reason", "commit a"],
		["steps.github-release.output.url", "https://x/1"],
		["steps['semver'].status == 'skipped'", true],
		["steps.missing.status", undefined],
		["startsWith(branch, 'release/') && endsWith(version, '.0')", true],
		["contains(branch, 'lease') && !contains(changes, 'x')", true],
		["1 < 2 && 'b' > 'a' && 1 < 'b'", false],
	])("%s → %o", (source, value) => {
		expect(evaluate(source)).toEqual(value);
	});

	it.each([
		["", "empty expression"],
		["kind ==", "unexpected end"],
		["kind = 'x'", "unexpected '=' at 6"],
		["(dryRun", "unexpected end"],
		["dryRun dryRun", "unexpected 'dryRun'"],
		["github.ref", "unknown name 'github'"],
		["format('x')", "unknown function 'format'"],
	])("rejects %o", (source, message) => {
		expect(() => compileExpression(source)).toThrow(message);
	});
});

describe("expressionContext", () => {
	it("reads what the step would receive", () => {
		const input = {
			previousVersion: "1.0.0",
			changes: [],
			kind: "patch",
			version: "1.0.1",
			notes: "n",
			releases: [],
			env: { cwd: "/p", branch: "main", dryRun: true },
			context: undefined,
			history: [
				{
					type: "release",
					name: "github-release",
					status: "ok",
					durationMs: 1,
					reason: "created",
					output: { output: { url: "u" }, reason: "created" },
				},
			],
		} as StepInput<"release">;
		expect(expressionContext(input)).toEqual({
			dryRun: true,
			branch: "main",
			cwd: "/p",
			previousVersion: "1.0.0",
			changes: [],
			kind: "patch",
			version: "1.0.1",
			notes: "n",
			steps: {
				"github-release": {
					type: "release",
					status: "ok",
					reason: "created",
					output: { url: "u" },
				},
			},
		});
	});
});
