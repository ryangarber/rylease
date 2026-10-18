import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StepInput } from "../types.ts";
import { npmPublish } from "./npm-publish.ts";

/** A registry that accepts every publish and records it. */
let server: Server;
let registry: string;
const published: { url: string; authorization?: string; tag?: string }[] = [];

beforeAll(async () => {
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => {
			body += chunk;
		});
		request.on("end", () => {
			if (request.method === "PUT") {
				const tags = (JSON.parse(body) as { "dist-tags": object })["dist-tags"];
				published.push({
					url: request.url ?? "",
					...(request.headers.authorization && {
						authorization: request.headers.authorization,
					}),
					...(Object.keys(tags)[0] && { tag: Object.keys(tags)[0] }),
				});
			}
			response.writeHead(request.method === "PUT" ? 201 : 404, {
				"content-type": "application/json",
			});
			response.end("{}");
		});
	});
	await new Promise<void>((resolve) => server.listen(0, resolve));
	registry = `http://localhost:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
	server.close();
});

async function withPackage(
	json: Record<string, unknown>,
	test: (cwd: string) => Promise<void>,
): Promise<void> {
	const cwd = await mkdtemp(join(tmpdir(), "rylease-"));
	try {
		await writeFile(join(cwd, "package.json"), JSON.stringify(json));
		await test(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function run(step: ReturnType<typeof npmPublish>, cwd: string, dryRun = false) {
	return step.run({
		previousVersion: "1.0.0",
		changes: [],
		kind: "minor",
		version: "1.1.0",
		notes: "",
		releases: [],
		env: { cwd, branch: "main", dryRun },
		context: undefined,
		history: [],
	} as StepInput<"release">);
}

describe("npmPublish", () => {
	it.each(["npm", "pnpm"] as const)(
		"publishes with %s and the token",
		async (client) => {
			await withPackage(
				{ name: `@me/${client}`, version: "1.1.0" },
				async (cwd) => {
					const output = await run(
						npmPublish({ client, registry, tag: "next", token: "secret" }),
						cwd,
					);
					expect(output.reason).toBe(
						`published @me/${client}@1.1.0 to ${registry} as next`,
					);
					expect(published.at(-1)).toEqual({
						url: `/@me%2f${client}`,
						authorization: "Bearer secret",
						tag: "next",
					});
				},
			);
		},
		60_000,
	);

	it("reads publishConfig and detects the client", async () => {
		await withPackage(
			{
				name: "pkg",
				version: "1.0.0",
				packageManager: "pnpm@12.0.0",
				publishConfig: { registry, tag: "beta" },
			},
			async (cwd) => {
				expect(await run(npmPublish(), cwd, true)).toEqual({
					output: {
						name: "pkg",
						version: "1.1.0",
						client: "pnpm",
						tag: "beta",
						registry,
						published: false,
					},
					reason: `would pnpm publish pkg@1.1.0 to ${registry} as beta`,
				});
			},
		);
	});

	it("refuses to publish another version", async () => {
		await withPackage({ name: "pkg", version: "1.0.0" }, async (cwd) => {
			await expect(run(npmPublish({ registry }), cwd)).rejects.toThrow(
				"package.json is at 1.0.0, not 1.1.0",
			);
		});
	});

	it("refuses private packages", async () => {
		await withPackage(
			{ name: "pkg", version: "1.1.0", private: true },
			async (cwd) => {
				await expect(run(npmPublish(), cwd, true)).rejects.toThrow(
					"package.json is private",
				);
			},
		);
	});
});
