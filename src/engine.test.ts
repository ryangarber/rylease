import { describe, expect, it } from "vitest";
import { defineRelease, defineStep } from "./define.ts";
import { ReleaseError, type ReleaseReport } from "./engine.ts";
import { prettyReporter } from "./reporter.ts";
import type { Kind, Step, StepInput } from "./types.ts";

const options = { cwd: "/", branch: "main", reporter: null };

function basics(kind: Kind = "minor"): Step[] {
	return [
		{
			type: "previous-version",
			name: "fixed",
			run: () => ({ version: "1.0.0", reason: "hardcoded" }),
		},
		{
			type: "release-changes",
			name: "fixed",
			run: () => ({
				changes: [{ title: "feat: x", reason: "test" }],
				reason: "1 change",
			}),
		},
		{
			type: "release-kind",
			name: "fixed",
			run: () => ({ kind, reason: `always ${kind}` }),
		},
		{
			type: "release-version",
			name: "fixed",
			run: () => ({ version: "1.1.0", reason: "hardcoded" }),
		},
		{
			type: "release-notes",
			name: "fixed",
			run: () => ({ notes: "notes", reason: "hardcoded" }),
		},
	];
}

describe("runRelease", () => {
	it("runs steps by phase, chaining outputs of the same type", async () => {
		const header = defineStep({
			type: "release-notes",
			name: "header",
			run: ({ version, notes }) => ({
				notes: `# v${version}\n\n${notes}`,
				reason: "prepended header",
			}),
		});
		const seen: unknown[] = [];
		const publish = (name: string): Step => ({
			type: "release",
			name,
			run: ({ notes, releases }) => {
				seen.push({ notes, releases });
				return { output: name.toUpperCase(), reason: `published ${name}` };
			},
		});
		// Deliberately out of order: release steps first, header last.
		const release = defineRelease({
			steps: [publish("a"), publish("b"), ...basics(), header()],
		});
		const report = await release.run(options);

		expect(report.records.map((r) => `${r.type}:${r.name}`)).toEqual([
			"previous-version:fixed",
			"release-changes:fixed",
			"release-kind:fixed",
			"release-version:fixed",
			"release-notes:fixed",
			"release-notes:header",
			"release:a",
			"release:b",
		]);
		expect(seen).toEqual([
			{ notes: "# v1.1.0\n\nnotes", releases: [] },
			{
				notes: "# v1.1.0\n\nnotes",
				releases: [{ name: "a", output: "A", files: [] }],
			},
		]);
		expect(report).toMatchObject({
			status: "released",
			previousVersion: "1.0.0",
			kind: "minor",
			version: "1.1.0",
			notes: "# v1.1.0\n\nnotes",
			releases: [
				{ name: "a", output: "A", files: [] },
				{ name: "b", output: "B", files: [] },
			],
		});
	});

	it("passes env, history and a mutable context", async () => {
		const release = defineRelease<{ calls: string[] }>({
			context: { calls: [] },
			steps: [
				...basics(),
				{
					type: "release",
					name: "inspect",
					run: ({ env, context, history }) => {
						context.calls.push("inspect");
						return {
							output: { env, steps: history.length, calls: context.calls },
							reason: "inspected",
						};
					},
				},
			],
		});
		const report = await release.run({ ...options, dryRun: true });
		expect(report.releases[0]?.output).toEqual({
			env: { cwd: "/", branch: "main", dryRun: true },
			steps: 5,
			calls: ["inspect"],
		});
	});

	it("skips steps whose condition is false", async () => {
		const ran: string[] = [];
		const release = (
			name: string,
			condition?: (input: StepInput<"release">) => boolean,
		) => ({
			type: "release" as const,
			name,
			...(condition && {
				if: Object.assign(condition, { source: `${name}?` }),
			}),
			run: () => {
				ran.push(name);
				return { output: name, reason: `ran ${name}` };
			},
		});
		const report = await defineRelease({
			steps: [
				...basics(),
				release("a"),
				release("b", () => false),
				release("c", ({ releases }) => releases.some((r) => r.name === "a")),
			],
		}).run(options);
		expect(report.status).toBe("released");
		expect(ran).toEqual(["a", "c"]);
		expect(
			report.records.slice(-2).map((r) => `${r.status}: ${r.reason}`),
		).toEqual(["skipped: `b?` is false", "ok: ran c"]);
	});

	it("fails when conditions skip every step of a phase", async () => {
		const steps = basics().map((step) =>
			step.type === "release-version" ? { ...step, if: () => false } : step,
		) as Step[];
		await expect(defineRelease({ steps }).run(options)).rejects.toThrow(
			"release-notes step 'fixed' failed: no 'release-version' step ran, so it has no version",
		);
	});

	it("runs only release steps for a given release", async () => {
		const inputs: unknown[] = [];
		const report = await defineRelease({
			steps: [
				...basics(),
				{
					type: "release",
					name: "upload",
					run: ({ env: _, context: __, history: ___, ...input }) => {
						inputs.push(input);
						return { output: null, reason: "uploaded" };
					},
				},
			],
		}).run({ ...options, release: { version: "2.1.0", notes: "Notes." } });
		expect(report.status).toBe("released");
		expect(report.records.map((r) => `${r.status}: ${r.reason}`)).toEqual([
			...basics().map(() => "skipped: releasing the given 2.1.0"),
			"ok: uploaded",
		]);
		expect(inputs).toEqual([
			{
				previousVersion: "2.1.0",
				changes: [],
				kind: "patch",
				version: "2.1.0",
				notes: "Notes.",
				releases: [],
			},
		]);

		const minor = await defineRelease({ steps: [] }).run({
			...options,
			release: { version: "2.1.0", previousVersion: "2.0.3" },
		});
		expect(minor).toMatchObject({
			kind: "minor",
			notes: "",
			status: "released",
		});
	});

	it("stops after the kind phase when there is nothing to release", async () => {
		const report = await defineRelease({ steps: basics("none") }).run(options);
		expect(report.status).toBe("unchanged");
		expect(report.records.map((r) => r.status)).toEqual([
			"ok",
			"ok",
			"ok",
			"skipped",
			"skipped",
		]);
		expect(report.records.at(-1)?.reason).toBe("no release-worthy changes");
	});

	it("records failures and skips the remaining steps", async () => {
		const release = defineRelease({
			steps: [
				...basics(),
				{
					type: "release",
					name: "boom",
					run: () => {
						throw new Error("kaboom");
					},
				},
				{
					type: "release",
					name: "after",
					run: () => ({ output: null, reason: "unreachable" }),
				},
			],
		});
		const error = await release.run(options).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ReleaseError);
		const { report } = error as ReleaseError;
		expect(report.status).toBe("failed");
		expect(report.records.slice(-2)).toMatchObject([
			{ name: "boom", status: "failed", reason: "kaboom" },
			{
				name: "after",
				status: "skipped",
				reason: "'release' step 'boom' failed",
			},
		]);
	});

	it("rejects missing phases and malformed outputs", async () => {
		await expect(
			defineRelease({ steps: basics().slice(0, 2) }).run(options),
		).rejects.toThrow(
			"no step provided for: release-kind, release-version, release-notes",
		);

		const bad = { ...basics()[2], run: () => ({ kind: "huge", reason: "x" }) };
		const steps = basics();
		steps[2] = bad as unknown as Step;
		await expect(defineRelease({ steps }).run(options)).rejects.toThrow(
			"'kind' must be one of major, minor, patch, none",
		);

		steps[2] = basics()[2] as Step;
		steps[0] = {
			...basics()[0],
			run: () => ({ version: "1.0.0", ref: "", reason: "x" }),
		} as Step;
		await expect(defineRelease({ steps }).run(options)).rejects.toThrow(
			"'ref' must be a non-empty string when present",
		);
		steps[0] = basics()[0] as Step;
		const files = {
			type: "release",
			name: "files",
			run: () => ({ output: null, files: "a", reason: "x" }),
		};
		await expect(
			defineRelease({ steps: [...steps, files as unknown as Step] }).run(
				options,
			),
		).rejects.toThrow("'files' must be an array of paths when present");
	});

	it("prints every step with type, name, duration and reason", async () => {
		let output = "";
		await defineRelease({ steps: basics() }).run({
			...options,
			dryRun: true,
			reporter: prettyReporter({
				write: (text) => {
					output += text;
				},
				color: false,
			}),
		});
		const lines = output.split("\n");
		expect(lines[1]).toBe("rylease dry run · main · /");
		expect(lines[3]).toMatch(
			/^ {2}✔ previous-version {2}fixed {2}\s+(<1|\d+)ms {2}hardcoded$/,
		);
		expect(output).toContain("1.0.0 → 1.1.0 (minor) · would release");
	});

	it("reports through custom reporters", async () => {
		const reports: ReleaseReport[] = [];
		await defineRelease({ steps: basics() }).run({
			...options,
			reporter: { finish: (report) => reports.push(report) },
		});
		expect(reports).toHaveLength(1);
	});
});
