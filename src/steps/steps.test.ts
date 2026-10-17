import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
	Change,
	Environment,
	StepDefinition,
	StepInput,
	StepResults,
	StepType,
} from "../types.ts";
import { classify } from "../utils/conventional.ts";
import { conventionalKind } from "./conventional-kind.ts";
import { conventionalNotes } from "./conventional-notes.ts";
import { prependChangelog } from "./prepend-changelog.ts";
import { semver } from "./semver.ts";

function run<T extends StepType>(
	step: StepDefinition<T>,
	results: StepResults[T],
	env: Partial<Environment> = {},
) {
	const input = {
		...results,
		env: { cwd: "/", branch: "main", dryRun: false, ...env },
		context: undefined,
		history: [],
	} as StepInput<T>;
	return step.run(input);
}

const change = (title: string, description?: string): Change => ({
	title,
	...(description ? { description } : {}),
	reason: "commit abc1234",
});

describe("conventionalKind", () => {
	it.each([
		[change("feat!: x"), "major", "'feat!' in title (commit abc1234)"],
		[change("fix(api)!: x"), "major", "'fix(api)!' in title (commit abc1234)"],
		[
			change("fix: x", "BREAKING CHANGE: y"),
			"major",
			"'BREAKING' in description (commit abc1234)",
		],
		[change("feat(ui): x"), "minor", "'feat(ui)' in title (commit abc1234)"],
		[
			change("chore(deps): x"),
			"patch",
			"'chore(deps)' in title (commit abc1234)",
		],
		[{ reason: "issue #1" }, "patch", "untyped change (issue #1)"],
	] as const)("classifies %o as %s", (input, kind, reason) => {
		expect(classify(input)).toEqual({ kind, reason });
	});

	it("maps types and scopes to kinds", async () => {
		const step = conventionalKind({
			types: { docs: "none", chore: "none", "chore(deps)": "patch" },
			fallback: "none",
		});
		const kind = async (...titles: string[]) =>
			(
				await run(step, {
					previousVersion: "1.0.0",
					changes: titles.map((title) => change(title)),
				})
			).kind;
		expect(await kind("docs: a", "chore: b", "untyped")).toBe("none");
		expect(await kind("docs: a", "chore(deps): b")).toBe("patch");
		expect(await kind("docs: a", "feat: b")).toBe("minor");
		expect(await kind("docs!: a")).toBe("major");
		expect(
			await run(step, {
				previousVersion: "1.0.0",
				changes: [change("docs: a")],
			}),
		).toEqual({
			kind: "none",
			reason: "'docs' in title (commit abc1234)",
		});
	});

	it("takes the highest kind, and none without changes", async () => {
		const step = conventionalKind();
		const base = { previousVersion: "1.0.0" };
		expect(
			await run(step, {
				...base,
				changes: [change("fix: a"), change("feat: b"), change("chore: c")],
			}),
		).toEqual({ kind: "minor", reason: "'feat' in title (commit abc1234)" });
		expect(await run(step, { ...base, changes: [] })).toEqual({
			kind: "none",
			reason: "no changes",
		});
	});
});

describe("semver", () => {
	it.each([
		["1.2.3", "major", "2.0.0", "'major' from 1.2.3"],
		["1.2.3", "minor", "1.3.0", "'minor' from 1.2.3"],
		["1.2.3", "patch", "1.2.4", "'patch' from 1.2.3"],
		["0.4.2", "major", "0.5.0", "'major' from 0.4.2 (pre-1.0: bumps minor)"],
		["0.4.2", "minor", "0.4.3", "'minor' from 0.4.2 (pre-1.0: bumps patch)"],
		["0.4.2", "patch", "0.4.3", "'patch' from 0.4.2 (pre-1.0: bumps patch)"],
	] as const)(
		"%s + %s → %s",
		async (previousVersion, kind, version, reason) => {
			expect(
				await run(semver(), { previousVersion, changes: [], kind }),
			).toEqual({ version, reason });
		},
	);
});

describe("semver without shifting pre-1.0 bumps", () => {
	it("bumps 0.x like any other version", async () => {
		expect(
			await run(semver({ shiftPreMajor: false }), {
				previousVersion: "0.4.2",
				changes: [],
				kind: "major",
			}),
		).toEqual({ version: "1.0.0", reason: "'major' from 0.4.2" });
	});
});

describe("conventionalNotes", () => {
	it("uses custom sections, and can leave out the rest", async () => {
		const output = await run(
			conventionalNotes({
				sections: [{ title: "Dependencies", types: ["chore(deps)", "build"] }],
				other: false,
			}),
			{
				previousVersion: "1.0.0",
				kind: "patch",
				version: "1.0.1",
				changes: [
					change("chore(deps): bump a"),
					change("feat: b"),
					change("build: c"),
				],
			},
		);
		expect(output.notes).toBe("## Dependencies\n\n- **deps:** bump a\n- c");
		expect(output.reason).toBe("patch release; dependencies: 2");
	});

	it("groups changes into breaking changes, types and other", async () => {
		const output = await run(conventionalNotes(), {
			previousVersion: "1.0.0",
			kind: "major",
			version: "2.0.0",
			changes: [
				change("feat(api)!: drop node 18"),
				change("fix: handle nulls"),
				change("perf: faster"),
				change("revert: undo thing"),
				change("chore(deps): bump vitest"),
				change("fix: old api", "BREAKING CHANGE: gone"),
				change("feat: add thing"),
				{ description: "Untitled change\nmore", reason: "issue #3" },
			],
		});
		expect(output.notes).toBe(
			[
				"## Breaking Changes",
				"",
				"- **api:** drop node 18",
				"- old api",
				"",
				"## Features",
				"",
				"- add thing",
				"",
				"## Bug Fixes",
				"",
				"- handle nulls",
				"",
				"## Performance Improvements",
				"",
				"- faster",
				"",
				"## Reverts",
				"",
				"- undo thing",
				"",
				"## Other",
				"",
				"- **deps:** bump vitest",
				"- Untitled change",
			].join("\n"),
		);
		expect(output.reason).toBe(
			"major release; breaking changes: 2, features: 1, bug fixes: 1, performance improvements: 1, reverts: 1, other: 2",
		);
	});

	it("can mark breaking changes in their own section instead", async () => {
		const output = await run(conventionalNotes({ breaking: false }), {
			previousVersion: "1.0.0",
			kind: "major",
			version: "2.0.0",
			changes: [change("feat(api)!: drop node 18"), change("feat: add thing")],
		});
		expect(output.notes).toBe(
			"## Features\n\n- **api:** drop node 18 **(breaking)**\n- add thing",
		);
	});

	it("links changes to their source", async () => {
		const linked: Change = {
			...change("fix: handle nulls"),
			link: { label: "abc1234", url: "https://example.com/c/abc1234" },
		};
		const input = {
			previousVersion: "1.0.0",
			kind: "patch" as const,
			version: "1.0.1",
			changes: [linked, change("fix: unlinked")],
		};
		expect((await run(conventionalNotes(), input)).notes).toBe(
			"## Bug Fixes\n\n- handle nulls ([abc1234](https://example.com/c/abc1234))\n- unlinked",
		);
		expect((await run(conventionalNotes({ links: false }), input)).notes).toBe(
			"## Bug Fixes\n\n- handle nulls\n- unlinked",
		);
	});
});

describe("prependChangelog", () => {
	it("prepends to an existing changelog", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "rylease-"));
		try {
			await writeFile(join(cwd, "CHANGELOG.md"), "# v1.0.0\n\n- old\n");
			const step = prependChangelog({ heading: "# v{version}" });
			const output = await run(
				step,
				{
					previousVersion: "1.0.0",
					changes: [],
					kind: "minor",
					version: "1.1.0",
					notes: "- new",
					releases: [],
				},
				{ cwd },
			);
			expect(output.reason).toBe("prepended to CHANGELOG.md");
			expect(await readFile(join(cwd, "CHANGELOG.md"), "utf8")).toBe(
				"# v1.1.0\n\n- new\n\n# v1.0.0\n\n- old\n",
			);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
