import { defineStep } from "../define.ts";
import type { Change } from "../types.ts";
import { parseSections } from "../utils/conventional.ts";
import { assertFullHistory, git } from "../utils/git.ts";
import { detectRepo } from "../utils/github.ts";
import { plural } from "../utils/text.ts";

const COMMIT_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x1f";

/**
 * Collects every conventional section (`feat: ...`, `fix(x)!: ...`) in the
 * commits since the previous version's ref, or in all history without one.
 * When the working directory is a subdirectory of the repository, only commits
 * touching it count. Each change links to its commit when the GitHub repository
 * is known.
 */
export const conventionalCommits = defineStep({
	type: "release-changes",
	name: "conventional-commits",
	description:
		"Collects each conventional section (`feat:`, `fix(x)!:` …) of every commit since the previous version's ref.",
	run: async ({ env, previousRef }) => {
		const cwd = env.cwd;
		await assertFullHistory(cwd);
		const range = previousRef ? `${previousRef}..HEAD` : "HEAD";
		// In a subdirectory (e.g. a monorepo package), only its commits count.
		const prefix = await git(cwd, "rev-parse", "--show-prefix");
		const log = await git(
			cwd,
			"log",
			`--format=%H${FIELD_SEPARATOR}%B${COMMIT_SEPARATOR}`,
			range,
			...(prefix ? ["--", "."] : []),
		);
		const repo = await detectRepo(cwd);
		const server = process.env.GITHUB_SERVER_URL || "https://github.com";
		const changes: Change[] = [];
		let commits = 0;
		for (const entry of log.split(COMMIT_SEPARATOR)) {
			const [sha, message = ""] = entry.trim().split(FIELD_SEPARATOR);
			if (!sha) continue;
			commits++;
			const short = sha.slice(0, 7);
			const link = repo
				? { label: short, url: `${server}/${repo}/commit/${sha}` }
				: undefined;
			for (const section of parseSections(message)) {
				changes.push({
					...section,
					reason: `commit ${short}`,
					...(link && { link }),
				});
			}
		}
		const since = previousRef
			? `since ${previousRef.slice(0, 7)}`
			: "in all history";
		return {
			changes,
			reason: `${plural(changes.length, "change")} in ${plural(commits, "commit")} ${since}`,
		};
	},
});
