import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { retry } from "./retry.ts";
import { zip } from "./zip.ts";

const SERVICE = "twirp/github.actions.results.api.v1.ArtifactService";

/** Whether this is a job that can upload workflow artifacts. */
export function canUploadArtifacts(): boolean {
	return Boolean(
		process.env.ACTIONS_RESULTS_URL && process.env.ACTIONS_RUNTIME_TOKEN,
	);
}

/** The job's artifact service, from what the runner gives JavaScript actions. */
function service() {
	const url = process.env.ACTIONS_RESULTS_URL;
	const token = process.env.ACTIONS_RUNTIME_TOKEN;
	if (!url || !token) {
		throw new Error(
			"no artifact service; workflow artifacts can only be uploaded by the rylease action in a GitHub Actions job",
		);
	}
	// The token's scope names the run and job to attach artifacts to.
	const payload = JSON.parse(
		Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
	) as { scp?: string };
	const scope = payload.scp
		?.split(" ")
		.find((scope) => scope.startsWith("Actions.Results:"));
	const [, run, job] = scope?.split(":") ?? [];
	if (!run || !job) throw new Error("the runtime token names no job");
	return {
		ids: { workflow_run_backend_id: run, workflow_job_run_backend_id: job },
		call: async <T>(method: string, body: object): Promise<T> => {
			const response = await fetch(
				`${new URL(url).origin}/${SERVICE}/${method}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(body),
				},
			);
			const text = await response.text();
			if (!response.ok) {
				throw new Error(
					`artifact service responded ${response.status} to ${method}: ${text}`,
				);
			}
			return JSON.parse(text) as T;
		},
	};
}

/** Uploads a zip as a workflow artifact; resolves with its id. */
async function uploadArtifact(
	name: string,
	content: Buffer,
	retentionDays?: number,
): Promise<string> {
	const { ids, call } = service();
	const created = await call<{ ok: boolean; signed_upload_url: string }>(
		"CreateArtifact",
		{
			...ids,
			name,
			version: 4,
			...(retentionDays !== undefined && {
				expires_at: new Date(
					Date.now() + retentionDays * 86_400_000,
				).toISOString(),
			}),
		},
	);
	if (!created.ok) throw new Error(`couldn't create artifact '${name}'`);

	await retry(
		async () => {
			const response = await fetch(created.signed_upload_url, {
				method: "PUT",
				headers: {
					"x-ms-blob-type": "BlockBlob",
					"x-ms-version": "2020-10-02",
					"content-type": "application/zip",
				},
				body: content,
			});
			if (!response.ok) {
				throw new Error(
					`artifact storage responded ${response.status}: ${await response.text()}`,
				);
			}
		},
		{ attempts: 5 },
	);

	const finalized = await call<{ ok: boolean; artifact_id: string }>(
		"FinalizeArtifact",
		{
			...ids,
			name,
			size: String(content.length),
			hash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		},
	);
	if (!finalized.ok) throw new Error(`couldn't finalize artifact '${name}'`);
	return finalized.artifact_id;
}

/**
 * Zips files as a workflow artifact, with paths relative to their closest
 * common directory, as `actions/upload-artifact` does.
 */
export async function uploadFiles(
	name: string,
	files: readonly string[],
	retentionDays?: number,
): Promise<{ id: string; files: string[]; size: number }> {
	const root = files.map(dirname).reduce(commonDirectory);
	const entries = await Promise.all(
		files.map(async (file) => ({
			name: relative(root, file).split(sep).join("/"),
			content: await readFile(file),
		})),
	);
	const sizes = await Promise.all(
		files.map(async (file) => (await stat(file)).size),
	);
	const id = await uploadArtifact(name, await zip(entries), retentionDays);
	return {
		id,
		files: entries.map((entry) => entry.name),
		size: sizes.reduce((sum, bytes) => sum + bytes, 0),
	};
}

function commonDirectory(a: string, b: string): string {
	const left = a.split(sep);
	const right = b.split(sep);
	let length = 0;
	while (length < left.length && left[length] === right[length]) length++;
	return left.slice(0, length).join(sep) || sep;
}
