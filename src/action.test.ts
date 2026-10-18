import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./action.ts";
import { git } from "./utils/git.ts";

let root: string;
let output: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "rylease-action-"));
	const cwd = join(root, "project");
	output = join(root, "output");
	await writeFile(output, "");
	await git(root, "init", "-b", "main", cwd);
	await git(cwd, "config", "user.name", "Test");
	await git(cwd, "config", "user.email", "test@example.com");
	await git(cwd, "config", "commit.gpgsign", "false");
	await writeFile(
		join(cwd, "package.json"),
		JSON.stringify({ name: "demo", version: "1.0.0" }),
	);
	await git(cwd, "add", "-A");
	await git(cwd, "commit", "-m", "chore: init");
	await git(cwd, "commit", "--allow-empty", "-m", "fix: a bug");
	await git(cwd, "commit", "--allow-empty", "-m", "docs: words");
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(root, { recursive: true, force: true });
});

const env = (steps?: string) => ({
	GITHUB_WORKSPACE: root,
	GITHUB_OUTPUT: output,
	"INPUT_WORKING-DIRECTORY": "project",
	"INPUT_DRY-RUN": "true",
	...(steps === undefined ? {} : { INPUT_STEPS: steps }),
});

async function outputs(): Promise<Record<string, string>> {
	const text = await readFile(output, "utf8");
	const result: Record<string, string> = {};
	for (const [, name = "", delimiter, value = ""] of text.matchAll(
		/^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm,
	)) {
		expect(delimiter).toMatch(/^rylease_/);
		result[name] = value;
	}
	return result;
}

describe("action", () => {
	it("runs the conventional preset by default and sets outputs", async () => {
		vi.stubEnv("GITHUB_REPOSITORY", "me/demo");
		expect(await main(env(), null)).toBe(0);
		expect(await outputs()).toEqual({
			status: "released",
			released: "true",
			"previous-version": "1.0.0",
			version: "1.0.1",
			kind: "patch",
			notes: expect.stringMatching(
				/^## Bug Fixes\n\n- a bug \(\[[0-9a-f]{7}\]\(https:\/\/github\.com\/me\/demo\/commit\/[0-9a-f]{40}\)\)\n\n## Other\n\n- words \(\[[0-9a-f]{7}\]\(.+\)\)$/,
			),
		});
	});

	it("passes options from the steps input", async () => {
		const steps = [
			"- uses: conventional",
			"  with:",
			"    github-release: false",
			"    conventional-kind:",
			"      types: { fix: none, docs: none }",
		].join("\n");
		expect(await main(env(steps), null)).toBe(0);
		expect(await outputs()).toMatchObject({
			status: "unchanged",
			released: "false",
			kind: "none",
		});
	});

	it("runs release steps for the version input", async () => {
		const steps = "- uses: github-release\n  with: { repo: me/demo }";
		expect(
			await main(
				{ ...env(steps), INPUT_VERSION: "3.0.0", INPUT_NOTES: "Hi" },
				null,
			),
		).toBe(0);
		expect(await outputs()).toEqual({
			status: "released",
			released: "true",
			"previous-version": "3.0.0",
			version: "3.0.0",
			kind: "patch",
			notes: "Hi",
		});
	});

	it("writes a summary of the release, unless told not to", async () => {
		const summary = join(root, "summary.md");
		await writeFile(summary, "");
		vi.stubEnv("GITHUB_REPOSITORY", "me/demo");
		expect(await main({ ...env(), GITHUB_STEP_SUMMARY: summary }, null)).toBe(
			0,
		);
		expect(await readFile(summary, "utf8")).toMatch(
			/^### rylease dry run · \*\*1\.0\.0\*\* → \*\*1\.0\.1\*\* \(patch\) · would release\n/,
		);

		await writeFile(summary, "");
		expect(
			await main(
				{ ...env(), GITHUB_STEP_SUMMARY: summary, INPUT_SUMMARY: "false" },
				null,
			),
		).toBe(0);
		expect(await readFile(summary, "utf8")).toBe("");

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		expect(
			await main(
				{ ...env("- uses: nope"), GITHUB_STEP_SUMMARY: summary },
				null,
			),
		).toBe(1);
		expect(await readFile(summary, "utf8")).toMatch(
			/^### ❌ rylease · invalid input\n\n- steps\[0\]\.uses: unknown step/,
		);
	});

	it("fails with annotations for invalid input", async () => {
		const write = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		expect(await main(env("- uses: semver\n  with: { shift: 1 }"), null)).toBe(
			1,
		);
		expect(await main(env("- [unclosed"), null)).toBe(1);
		expect(write.mock.calls.map(([text]) => text)).toEqual([
			'::error::steps[0].with: Unrecognized key: "shift"\n',
			expect.stringMatching(/^::error::steps: invalid YAML: /),
		]);
		expect(await readFile(output, "utf8")).toBe("");
	});
});
