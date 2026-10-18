import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OptionsError } from "./options.ts";
import { resolveWorkflowSteps } from "./workflow.ts";

let cwd: string;

beforeAll(async () => {
	cwd = await mkdtemp(join(tmpdir(), "rylease-workflow-"));
	const rylease = JSON.stringify(join(import.meta.dirname, "index.ts"));
	await writeFile(
		join(cwd, "announce.ts"),
		`import { defineStep, definePreset, z } from ${rylease};

export const announce = defineStep({
	type: "release",
	name: "announce",
	options: { channel: z.string() },
	run: ({ options }) => ({ output: options.channel, reason: "announced" }),
});

export default announce;

export const both = definePreset({ name: "both", steps: [announce] });

export const notAStep = () => {};
`,
	);
});

afterAll(async () => {
	await rm(cwd, { recursive: true, force: true });
});

const names = async (entries: unknown) =>
	(await resolveWorkflowSteps(entries, { cwd })).map((step) => step.name);

async function problems(entries: unknown): Promise<readonly string[]> {
	const error = await resolveWorkflowSteps(entries, { cwd }).catch(
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(OptionsError);
	return (error as OptionsError).issues;
}

describe("resolveWorkflowSteps", () => {
	it("takes bundled steps and presets, with options", async () => {
		expect(
			await names([
				{ uses: "semver" },
				{ uses: "conventional-kind", with: null },
			]),
		).toEqual(["semver", "conventional-kind"]);
		expect(
			await names([
				{
					uses: "conventional",
					with: {
						"github-release": false,
						"read-git-tag": false,
						semver: { shiftPreMajor: false },
					},
				},
			]),
		).toEqual([
			"read-package-json",
			"conventional-commits",
			"conventional-kind",
			"semver",
			"conventional-notes",
			"write-package-json",
			"prepend-changelog",
			"git-commit",
		]);
	});

	it("loads steps and presets from files", async () => {
		const [step] = await resolveWorkflowSteps(
			[{ uses: "./announce.ts", with: { channel: "#releases" } }],
			{ cwd },
		);
		expect(step?.name).toBe("announce");
		expect(
			await names([
				{ uses: "./announce.ts#both", with: { announce: { channel: "x" } } },
			]),
		).toEqual(["announce"]);
	});

	it("makes steps, and every step of a preset, conditional", async () => {
		const [step] = await resolveWorkflowSteps(
			[{ uses: "semver", if: "!dryRun && startsWith(branch, 'release/')" }],
			{ cwd },
		);
		const input = (dryRun: boolean, branch: string) =>
			({
				env: { cwd, branch, dryRun },
				history: [],
				context: undefined,
			}) as never;
		expect(step?.if?.source).toBe("!dryRun && startsWith(branch, 'release/')");
		expect(step?.if?.(input(false, "release/2"))).toBe(true);
		expect(step?.if?.(input(true, "release/2"))).toBe(false);
		expect(step?.if?.(input(false, "main"))).toBe(false);

		const preset = await resolveWorkflowSteps(
			[{ uses: "conventional", if: false }],
			{ cwd },
		);
		expect(preset.map((s) => s.if?.(input(false, "main")))).toEqual(
			preset.map(() => false),
		);
	});

	it("reports problems with their path", async () => {
		expect(await problems({ semver: {} })).toEqual([
			"steps: expected a list of steps",
		]);
		expect(await problems(["semver"])).toEqual([
			"steps[0]: expected a map with 'uses', and optionally 'with' and 'if'",
		]);
		expect(await problems([{ semver: {} }])).toEqual([
			"steps[0].semver: unknown key; use uses, with, if",
		]);
		expect(await problems([{ uses: "semver", with: [] }])).toEqual([
			"steps[0].with: expected a map of options",
		]);
		expect(
			await problems([
				{ uses: "semver" },
				{ uses: "semver", with: { shift: true } },
			]),
		).toEqual(['steps[1].with: Unrecognized key: "shift"']);
		expect(
			await problems([
				{ uses: "conventional", with: { semver: { shiftPreMajor: 1 } } },
			]),
		).toEqual([
			"steps[0].with.semver.shiftPreMajor: Invalid input: expected boolean, received number",
		]);
		expect(
			await problems([{ uses: "conventional", with: { nope: false } }]),
		).toEqual([
			"steps[0].with: 'nope' isn't one of its steps (read-package-json, read-git-tag, conventional-commits, conventional-kind, semver, conventional-notes, write-package-json, prepend-changelog, git-commit, github-release)",
		]);
		expect(await problems([{ uses: "./announce.ts" }])).toEqual([
			"steps[0].with.channel: Invalid input: expected string, received undefined",
		]);
		expect(await problems([{ uses: "nope" }])).toEqual([
			expect.stringMatching(/^steps\[0\]\.uses: unknown step; use one of /),
		]);
		expect(await problems([{ uses: "./announce.ts#notAStep" }])).toEqual([
			"steps[0].uses: export 'notAStep' of ./announce.ts isn't a step made with defineStep or a preset made with definePreset",
		]);
		expect(await problems([{ uses: "semver", if: "version ==" }])).toEqual([
			"steps[0].if: unexpected end in `version ==`",
		]);
		expect(await problems([{ uses: "semver", if: "github.ref" }])).toEqual([
			expect.stringMatching(
				/^steps\[0\]\.if: unknown name 'github'; use dryRun, .+ in `github\.ref`$/,
			),
		]);
	});

	it("rejects a step that its preset already has", async () => {
		expect(
			await problems([{ uses: "conventional" }, { uses: "conventional-kind" }]),
		).toEqual([
			"steps[1].uses: 'conventional-kind' is already in 'conventional'; configure it there (with: { conventional-kind: ... }), or set it to false there to replace it",
		]);
		expect(
			await names([
				{ uses: "conventional", with: { "conventional-kind": false } },
				{ uses: "conventional-kind", if: "!dryRun" },
			]),
		).toContain("conventional-kind");
	});
});
