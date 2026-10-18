import { defineStep } from "../define.ts";
import { z } from "../options.ts";
import { canUploadArtifacts, uploadFiles } from "../utils/artifact.ts";
import { formatSize, resolveFiles } from "../utils/files.ts";
import { fill } from "../utils/template.ts";
import { plural } from "../utils/text.ts";

/**
 * Keeps files as an artifact of the workflow run; with `dryRunArtifact`, in
 * dry runs too, e.g. to keep what a dry run built.
 */
export const githubArtifact = defineStep({
	type: "release",
	name: "github-artifact",
	description:
		"Uploads files as a workflow artifact. Only works in the GitHub Action.",
	options: {
		name: z
			.string()
			.describe(
				"The artifact's name, unique in the run; `{version}` is filled in.",
			),
		files: z
			.array(z.string())
			.min(1)
			.describe(
				"Paths, globs or directories, relative to the working directory unless absolute; each must match.",
			),
		dryRunArtifact: z
			.boolean()
			.default(false)
			.describe("Upload in dry runs too."),
		retentionDays: z
			.number()
			.int()
			.min(1)
			.optional()
			.describe("Defaults to the repository's setting."),
	},
	run: async ({ env, version, options }) => {
		const name = fill(options.name, { version });
		const files = await resolveFiles(env.cwd, options.files);
		const listed = `${plural(files.length, "file")} as artifact ${name}`;
		if (env.dryRun && !(options.dryRunArtifact && canUploadArtifacts())) {
			return {
				output: { name, id: null, files: [] },
				reason: `would upload ${listed}${options.dryRunArtifact ? " (outside GitHub Actions)" : ""}`,
			};
		}
		const uploaded = await uploadFiles(name, files, options.retentionDays);
		return {
			output: { name, id: uploaded.id, files: uploaded.files },
			reason: `uploaded ${plural(files.length, "file")} (${formatSize(uploaded.size)}) as artifact ${name}`,
		};
	},
});
