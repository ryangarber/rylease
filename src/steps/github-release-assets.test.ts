import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { defineRelease } from "../define.ts";
import type { StepDefinition } from "../types.ts";
import { git } from "../utils/git.ts";
import { clock } from "../utils/retry.ts";
import { githubArtifact } from "./github-artifact.ts";
import { githubRelease } from "./github-release.ts";
import { githubReleaseAssets } from "./github-release-assets.ts";

interface Asset {
	id: number;
	name: string;
	state: string;
	size: number;
	content: string;
}

interface Release {
	id: number;
	tag_name: string;
	draft: boolean;
	body: string;
	assets: Asset[];
}

/** Just enough of GitHub's API, and of the artifact service, to release to. */
const github = {
	releases: [] as Release[],
	requests: [] as string[],
	/** Fail this many upload attempts with a 502, leaving a `starter` asset. */
	failUploads: 0,
	/** Answer the next create with a 422, as if another job had just won. */
	raceCreate: false,
	artifacts: new Map<string, { content?: Buffer; hash?: string }>(),
};

let server: Server;
let base: string;
let cwd: string;
let nextId = 1;

function json(
	response: import("node:http").ServerResponse,
	status: number,
	body: unknown,
) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

const view = (release: Release) => ({
	id: release.id,
	tag_name: release.tag_name,
	draft: release.draft,
	html_url: `https://github.com/me/demo/releases/tag/${release.tag_name}`,
	upload_url: `${base}/uploads/${release.id}/assets{?name,label}`,
});

beforeAll(async () => {
	server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const body = Buffer.concat(chunks);
			const url = new URL(request.url ?? "/", base);
			const route = `${request.method} ${url.pathname}`;
			github.requests.push(route);

			const match1 = /^GET \/repos\/me\/demo\/releases\/tags\/(.+)$/.exec(
				route,
			);
			if (match1) {
				const match = match1;
				const release = github.releases.find(
					(r) =>
						r.tag_name === decodeURIComponent(match?.[1] ?? "") && !r.draft,
				);
				return release
					? json(response, 200, view(release))
					: json(response, 404, {});
			}
			if (route === "GET /repos/me/demo/releases") {
				return json(response, 200, github.releases.map(view));
			}
			if (route === "POST /repos/me/demo/releases") {
				const input = JSON.parse(body.toString()) as Record<string, unknown>;
				const release: Release = {
					id: nextId++,
					tag_name: String(input.tag_name),
					draft: Boolean(input.draft),
					body: String(input.body),
					assets: [],
				};
				github.releases.push(release);
				if (github.raceCreate) {
					github.raceCreate = false;
					return json(response, 422, { message: "already_exists" });
				}
				return json(response, 201, view(release));
			}
			const match2 = /^GET \/repos\/me\/demo\/releases\/(\d+)\/assets$/.exec(
				route,
			);
			if (match2) {
				const match = match2;
				const release = github.releases.find(
					(r) => r.id === Number(match?.[1]),
				);
				return json(
					response,
					200,
					(release?.assets ?? []).map(({ content: _, ...asset }) => asset),
				);
			}
			const match3 = /^DELETE \/repos\/me\/demo\/releases\/assets\/(\d+)$/.exec(
				route,
			);
			if (match3) {
				const match = match3;
				for (const release of github.releases) {
					release.assets = release.assets.filter(
						(a) => a.id !== Number(match?.[1]),
					);
				}
				response.writeHead(204).end();
				return;
			}
			const match4 = /^POST \/uploads\/(\d+)\/assets$/.exec(route);
			if (match4) {
				const match = match4;
				const release = github.releases.find(
					(r) => r.id === Number(match?.[1]),
				);
				const name = (url.searchParams.get("name") ?? "").replaceAll(" ", ".");
				if (!release) return json(response, 404, {});
				if (release.assets.some((a) => a.name === name)) {
					return json(response, 422, { message: "already_exists" });
				}
				const asset: Asset = {
					id: nextId++,
					name,
					state: "uploaded",
					size: body.length,
					content: body.toString(),
				};
				release.assets.push(asset);
				if (github.failUploads > 0) {
					github.failUploads--;
					asset.state = "starter";
					return json(response, 502, {});
				}
				const { content: _, ...view } = asset;
				return json(response, 201, {
					...view,
					browser_download_url: `https://github.com/download/${name}`,
				});
			}

			// The artifact service, and the storage it signs uploads for.
			const twirp = "/twirp/github.actions.results.api.v1.ArtifactService/";
			if (route === `POST ${twirp}CreateArtifact`) {
				const input = JSON.parse(body.toString()) as { name: string };
				github.artifacts.set(input.name, {});
				return json(response, 200, {
					ok: true,
					signed_upload_url: `${base}/blob/${encodeURIComponent(input.name)}?sig=1`,
				});
			}
			const match5 = /^PUT \/blob\/(.+)$/.exec(route);
			if (match5) {
				const match = match5;
				const artifact = github.artifacts.get(
					decodeURIComponent(match[1] ?? ""),
				);
				if (!artifact || request.headers["x-ms-blob-type"] !== "BlockBlob") {
					return json(response, 400, {});
				}
				artifact.content = body;
				response.writeHead(201).end();
				return;
			}
			if (route === `POST ${twirp}FinalizeArtifact`) {
				const input = JSON.parse(body.toString()) as {
					name: string;
					hash: string;
				};
				const artifact = github.artifacts.get(input.name);
				if (!artifact) return json(response, 404, {});
				artifact.hash = input.hash;
				return json(response, 200, { ok: true, artifact_id: "42" });
			}
			json(response, 404, { route });
		});
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
	server.close();
});

beforeEach(async () => {
	github.releases = [];
	github.requests = [];
	github.failUploads = 0;
	github.raceCreate = false;
	github.artifacts.clear();
	vi.spyOn(clock, "sleep").mockResolvedValue();
	vi.stubEnv("GITHUB_API_URL", base);
	vi.stubEnv("GITHUB_REPOSITORY", "me/demo");
	vi.stubEnv("GITHUB_TOKEN", "token");
	vi.stubEnv("ACTIONS_RESULTS_URL", "");
	vi.stubEnv("ACTIONS_RUNTIME_TOKEN", "");
	cwd = await mkdtemp(join(tmpdir(), "rylease-assets-"));
	await git(cwd, "init", "-q");
	await git(
		cwd,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@e",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	await mkdir(join(cwd, "dist", "nested"), { recursive: true });
	await writeFile(join(cwd, "dist", "app linux"), "linux");
	await writeFile(join(cwd, "dist", "app.exe"), "windows");
	await writeFile(join(cwd, "dist", "nested", "latest.json"), "{}");
});

afterEach(async () => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	await rm(cwd, { recursive: true, force: true });
});

/** Runs steps for an already worked-out release, as a later job would. */
function release(steps: StepDefinition<"release">[], dryRun = false) {
	return defineRelease({ steps }).run({
		cwd,
		dryRun,
		reporter: null,
		release: { version: "1.2.0", notes: "Notes." },
	});
}

const assetsOf = (tag: string) =>
	github.releases
		.filter((r) => r.tag_name === tag)
		.flatMap((r) => r.assets.map((a) => `${a.name}=${a.content}`));

describe("githubReleaseAssets", () => {
	it("creates the release when there's none yet", async () => {
		const report = await release([
			githubReleaseAssets({ files: ["dist/app*"] }),
		]);
		expect(report.status).toBe("released");
		expect(report.records[0]?.reason).toBe(
			"uploaded app.linux (5 B) and app.exe (7 B) to new release v1.2.0: https://github.com/me/demo/releases/tag/v1.2.0",
		);
		expect(github.releases).toMatchObject([
			{ tag_name: "v1.2.0", body: "Notes." },
		]);
		expect(assetsOf("v1.2.0")).toEqual(["app.linux=linux", "app.exe=windows"]);
	});

	it("uploads to an existing release, replacing assets of the same name", async () => {
		await release([githubRelease()]);
		await release([githubReleaseAssets({ files: ["dist/app.exe"] })]);
		await writeFile(join(cwd, "dist", "app.exe"), "windows 2");
		const report = await release([
			githubReleaseAssets({ files: ["dist/app.exe", "dist/nested"] }),
		]);
		expect(report.records[0]?.reason).toMatch(/to existing release v1\.2\.0/);
		expect(github.releases).toHaveLength(1);
		expect(assetsOf("v1.2.0")).toEqual(["app.exe=windows 2", "latest.json={}"]);
	});

	it("can refuse to replace assets", async () => {
		await release([githubReleaseAssets({ files: ["dist/app.exe"] })]);
		await expect(
			release([
				githubReleaseAssets({ files: ["dist/app.exe"], clobber: false }),
			]),
		).rejects.toThrow(
			"release v1.2.0 already has app.exe; set clobber to replace it",
		);
	});

	it("uses the release another job created at the same time", async () => {
		github.raceCreate = true;
		const report = await release([
			githubReleaseAssets({ files: ["dist/app.exe"] }),
		]);
		expect(report.records[0]?.reason).toMatch(/to existing release v1\.2\.0/);
		expect(github.releases).toHaveLength(1);
		expect(assetsOf("v1.2.0")).toEqual(["app.exe=windows"]);
	});

	it("finds draft releases", async () => {
		await release([githubRelease({ draft: true })]);
		await release([githubReleaseAssets({ files: ["dist/app.exe"] })]);
		expect(github.releases).toHaveLength(1);
		expect(assetsOf("v1.2.0")).toEqual(["app.exe=windows"]);
	});

	it("retries failed uploads, clearing what they left", async () => {
		github.failUploads = 2;
		await release([githubReleaseAssets({ files: ["dist/app.exe"] })]);
		expect(assetsOf("v1.2.0")).toEqual(["app.exe=windows"]);
		expect(clock.sleep).toHaveBeenCalledTimes(2);
	});

	it("fails on a pattern that matches nothing, even in a dry run", async () => {
		await expect(
			release(
				[githubReleaseAssets({ files: ["dist/app.exe", "dist/*.dmg"] })],
				true,
			),
		).rejects.toThrow("no files match 'dist/*.dmg'");
	});

	it("only says what it would upload in a dry run", async () => {
		const report = await release(
			[githubReleaseAssets({ files: ["dist/app.exe"], tag: "{version}" })],
			true,
		);
		expect(report.records[0]?.reason).toBe(
			"would upload app.exe (7 B) to release 1.2.0 on me/demo",
		);
		expect(github.requests).toEqual([]);
	});

	it("can keep the files as an artifact in a dry run", async () => {
		useArtifactService();
		const report = await release(
			[githubReleaseAssets({ files: ["dist/app*"], dryRunArtifact: true })],
			true,
		);
		expect(report.records[0]?.reason).toMatch(
			/^would upload app\.linux \(5 B\) and app\.exe \(7 B\) to release v1\.2\.0 on me\/demo; kept them as artifact release-assets-[0-9a-f]{8}$/,
		);
		expect(github.releases).toEqual([]);
		const [[name, artifact] = []] = [...github.artifacts];
		expect(await unzip(artifact?.content)).toEqual({
			"app linux": "linux",
			"app.exe": "windows",
		});
		expect(name).toMatch(/^release-assets-/);
	});

	it("skips the artifact outside GitHub Actions", async () => {
		const report = await release(
			[githubReleaseAssets({ files: ["dist/app.exe"], dryRunArtifact: true })],
			true,
		);
		expect(report.records[0]?.reason).toBe(
			"would upload app.exe (7 B) to release v1.2.0 on me/demo (no artifact app.exe outside GitHub Actions)",
		);
	});
});

describe("githubArtifact", () => {
	it("uploads files as a zip, relative to their common directory", async () => {
		useArtifactService();
		const report = await release([
			githubArtifact({
				name: "build-{version}",
				files: ["dist/app.exe", "dist/nested"],
			}),
		]);
		expect(report.records[0]?.reason).toBe(
			"uploaded 2 files (9 B) as artifact build-1.2.0",
		);
		const artifact = github.artifacts.get("build-1.2.0");
		expect(artifact?.hash).toBe(
			`sha256:${createHash("sha256")
				.update(artifact?.content ?? "")
				.digest("hex")}`,
		);
		expect(await unzip(artifact?.content)).toEqual({
			"app.exe": "windows",
			"nested/latest.json": "{}",
		});
	});

	it("uploads in dry runs only with dryRunArtifact", async () => {
		useArtifactService();
		const step = (dryRunArtifact: boolean) =>
			githubArtifact({
				name: "build",
				files: ["dist/app.exe"],
				dryRunArtifact,
			});
		expect((await release([step(false)], true)).records[0]?.reason).toBe(
			"would upload 1 file as artifact build",
		);
		expect(github.artifacts.size).toBe(0);
		await release([step(true)], true);
		expect(github.artifacts.get("build")?.hash).toMatch(/^sha256:/);
	});

	it("fails outside GitHub Actions", async () => {
		await expect(
			release([githubArtifact({ name: "build", files: ["dist/app.exe"] })]),
		).rejects.toThrow("no artifact service");
	});
});

function useArtifactService() {
	const claims = { scp: "Actions.GenericRead:1 Actions.Results:run-1:job-1" };
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	vi.stubEnv("ACTIONS_RESULTS_URL", `${base}/`);
	vi.stubEnv("ACTIONS_RUNTIME_TOKEN", `header.${payload}.signature`);
}

/** Extracts a zip with the system's `unzip`, checking it's well formed. */
async function unzip(
	content: Buffer | undefined,
): Promise<Record<string, string>> {
	const dir = await mkdtemp(join(tmpdir(), "rylease-unzip-"));
	try {
		const file = join(dir, "artifact.zip");
		await writeFile(file, content ?? "");
		const run = promisify(execFile);
		await run("unzip", ["-q", file, "-d", join(dir, "out")]);
		const { stdout } = await run("unzip", ["-Z1", file]);
		const files: Record<string, string> = {};
		for (const name of stdout.trim().split("\n")) {
			files[name] = await readFile(join(dir, "out", name), "utf8");
		}
		return files;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
