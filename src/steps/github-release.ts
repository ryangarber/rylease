import { defineStep } from "../define.ts";
import { git } from "../utils/git.ts";
import {
	ensureRelease,
	githubClient,
	githubToken,
	releaseOptions,
	releaseRepo,
} from "../utils/github.ts";
import { fill } from "../utils/template.ts";

/**
 * Creates a GitHub release for the version, with the notes as its body, or
 * finds the one another job already created.
 */
export const githubRelease = defineStep({
	type: "release",
	name: "github-release",
	description:
		"Creates a GitHub release with the notes, unless the tag already has one. Needs a token with `contents: write`.",
	options: releaseOptions,
	run: async ({ env, version, notes, options }) => {
		const tag = fill(options.tag, { version });
		const title =
			options.title === undefined ? tag : fill(options.title, { version });
		const repo = await releaseRepo(env.cwd, options.repo);
		if (env.dryRun) {
			return {
				output: { repo, tag, url: null },
				reason: `would create release ${tag} on ${repo}`,
			};
		}

		const client = githubClient(repo, githubToken(options.token));
		const { release, created } = await ensureRelease(client, {
			tag,
			target: await git(env.cwd, "rev-parse", "HEAD"),
			title,
			notes,
			draft: options.draft,
			prerelease: options.prerelease,
		});
		return {
			output: { repo, tag, id: release.id, url: release.html_url },
			reason: `${created ? "created" : "found existing"} release ${tag}: ${release.html_url}`,
		};
	},
});
