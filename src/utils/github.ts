import { z } from "../options.ts";
import { tryGit } from "./git.ts";
import { clock, retry, waitFor } from "./retry.ts";

/** `GITHUB_REPOSITORY`, or `owner/repo` from the `origin` remote. */
export async function detectRepo(cwd: string): Promise<string | undefined> {
	if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
	const url = await tryGit(cwd, "remote", "get-url", "origin");
	return url ? parseGitHubRepo(url) : undefined;
}

/** `git@github.com:o/r.git`, `https://github.com/o/r` and similar → `o/r`. */
export function parseGitHubRepo(url: string): string | undefined {
	return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** The `repo` option, or the repository being released. */
export async function releaseRepo(
	cwd: string,
	repo: string | undefined,
): Promise<string> {
	const found = repo ?? (await detectRepo(cwd));
	if (!found) {
		throw new Error(
			"couldn't determine the GitHub repository; set `repo` or GITHUB_REPOSITORY",
		);
	}
	return found;
}

/** Options of the steps that create a release, or find one. */
export const releaseOptions = {
	tag: z
		.string()
		.default("v{version}")
		.describe("The release's tag; created at HEAD if it doesn't exist."),
	title: z
		.string()
		.optional()
		.describe("`{version}` is filled in; defaults to the tag."),
	draft: z.boolean().default(false),
	prerelease: z.boolean().default(false),
	repo: z
		.string()
		.optional()
		.describe(
			"`owner/repo`; defaults to `GITHUB_REPOSITORY` or the `origin` remote.",
		),
	token: z
		.string()
		.optional()
		.describe("Defaults to `GITHUB_TOKEN` or `GH_TOKEN`."),
};

/** The token option, `GITHUB_TOKEN` or `GH_TOKEN`. */
export function githubToken(token: string | undefined): string {
	const found = token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
	if (!found) throw new Error("no token; set GITHUB_TOKEN or GH_TOKEN");
	return found;
}

class GitHubError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "GitHubError";
		this.status = status;
	}
}

/** Statuses worth another try: rate limits and server errors. */
function isTransient(error: unknown): boolean {
	if (error instanceof GitHubError) {
		return error.status === 429 || error.status >= 500;
	}
	// fetch rejects with a TypeError when the connection fails.
	return error instanceof TypeError;
}

interface RequestOptions {
	body?: unknown;
	/** Sends `body` as is, with this content type, instead of as JSON. */
	contentType?: string;
	/** Statuses that resolve instead of rejecting, e.g. `[404]`. */
	allow?: number[];
	/** Tries in all; defaults to 5. */
	attempts?: number;
}

export interface GitHubClient {
	readonly repo: string;
	/** `path` is relative to the repository's API URL, unless it's a full URL. */
	request<T>(
		method: string,
		path: string,
		options?: RequestOptions,
	): Promise<{ status: number; data: T }>;
}

/** A GitHub REST client for one repository that retries transient failures. */
export function githubClient(repo: string, token: string): GitHubClient {
	const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
	return {
		repo,
		request: (method, path, options = {}) =>
			retry(
				async () => {
					const url = /^https?:/.test(path)
						? path
						: `${apiUrl}/repos/${repo}${path}`;
					const response = await fetch(url, {
						method,
						headers: {
							accept: "application/vnd.github+json",
							authorization: `Bearer ${token}`,
							"x-github-api-version": "2022-11-28",
							...(options.body !== undefined && {
								"content-type": options.contentType ?? "application/json",
							}),
						},
						...(options.body !== undefined && {
							body:
								options.contentType === undefined
									? JSON.stringify(options.body)
									: (options.body as Uint8Array<ArrayBuffer>),
						}),
					});
					const text = await response.text();
					if (!response.ok && !options.allow?.includes(response.status)) {
						// GitHub asks to wait this long when rate limiting.
						const wait = Number(response.headers.get("retry-after"));
						if (response.status === 429 && wait > 0) {
							await clock.sleep(Math.min(wait, 60) * 1000);
						}
						throw new GitHubError(
							response.status,
							`GitHub responded ${response.status} to ${method} ${url}: ${text}`,
						);
					}
					return {
						status: response.status,
						data: (text ? JSON.parse(text) : null) as never,
					};
				},
				{ attempts: options.attempts ?? 5, retryIf: isTransient },
			),
	};
}

export interface ReleaseAsset {
	id: number;
	name: string;
	/** `uploaded`, or `starter` when an upload never finished. */
	state: string;
	size: number;
	browser_download_url: string;
}

export interface Release {
	id: number;
	tag_name: string;
	html_url: string;
	upload_url: string;
	draft: boolean;
}

/** The release of a tag, drafts included, or `undefined`. */
async function findRelease(
	client: GitHubClient,
	tag: string,
): Promise<Release | undefined> {
	const { status, data } = await client.request<Release>(
		"GET",
		`/releases/tags/${encodeURIComponent(tag)}`,
		{ allow: [404] },
	);
	if (status !== 404) return data;
	// Drafts have no tag yet, so only a listing finds them.
	const { data: releases } = await client.request<Release[]>(
		"GET",
		"/releases?per_page=100",
	);
	return releases.find((release) => release.tag_name === tag);
}

export interface NewRelease {
	tag: string;
	target: string;
	title: string;
	notes: string;
	draft: boolean;
	prerelease: boolean;
}

/**
 * Finds the release of a tag, or creates it. Other jobs may be doing the same
 * at once: when one of them wins, this waits until its release is visible and
 * uses that.
 */
export async function ensureRelease(
	client: GitHubClient,
	release: NewRelease,
): Promise<{ release: Release; created: boolean }> {
	const existing = await findRelease(client, release.tag);
	if (existing) return { release: existing, created: false };
	try {
		const { data } = await client.request<Release>("POST", "/releases", {
			body: {
				tag_name: release.tag,
				target_commitish: release.target,
				name: release.title,
				body: release.notes,
				draft: release.draft,
				prerelease: release.prerelease,
			},
		});
		return { release: data, created: true };
	} catch (error) {
		// 422: the tag already has a release, created since we looked.
		if (!(error instanceof GitHubError && error.status === 422)) throw error;
		const created = await waitFor(() => findRelease(client, release.tag), {
			attempts: 5,
		});
		if (!created) throw error;
		return { release: created, created: false };
	}
}

/** The name GitHub stores an asset under, e.g. `My App.zip` → `My.App.zip`. */
export function assetName(file: string): string {
	return file.replace(/[^\w.+@~-]/g, ".");
}

async function listAssets(
	client: GitHubClient,
	release: Release,
): Promise<ReleaseAsset[]> {
	const assets: ReleaseAsset[] = [];
	for (let page = 1; ; page++) {
		const { data } = await client.request<ReleaseAsset[]>(
			"GET",
			`/releases/${release.id}/assets?per_page=100&page=${page}`,
		);
		assets.push(...data);
		if (data.length < 100) return assets;
	}
}

/**
 * Uploads a file as an asset of the release, retrying failed uploads. An
 * asset of the same name is replaced if `clobber` is set, or if it's what's
 * left of an unfinished upload.
 */
export async function uploadAsset(
	client: GitHubClient,
	release: Release,
	asset: { name: string; content: Uint8Array },
	clobber: boolean,
): Promise<ReleaseAsset> {
	const name = assetName(asset.name);
	return retry(
		async () => {
			const existing = (await listAssets(client, release)).find(
				(other) => other.name === name,
			);
			if (existing) {
				if (existing.state === "uploaded" && !clobber) {
					throw new Error(
						`release ${release.tag_name} already has ${name}; set clobber to replace it`,
					);
				}
				await client.request("DELETE", `/releases/assets/${existing.id}`, {
					allow: [404],
				});
			}
			const url = new URL(release.upload_url.replace(/\{.*\}$/, ""));
			url.searchParams.set("name", asset.name);
			const { data } = await client.request<ReleaseAsset>("POST", url.href, {
				body: asset.content,
				contentType: "application/octet-stream",
				// Retried as a whole, after clearing what a failed upload left.
				attempts: 1,
			});
			return data;
		},
		{ attempts: 5, retryIf: isTransient },
	);
}
