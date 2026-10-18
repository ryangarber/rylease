import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defineStep } from "../define.ts";
import { z } from "../options.ts";
import { loadPackageJson, versionOf } from "../utils/package-json.ts";

const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/**
 * Publishes the package to npm, after earlier steps wrote the new version to
 * `package.json`. Lifecycle scripts like `prepublishOnly` run as usual.
 */
export const npmPublish = defineStep({
	type: "release",
	name: "npm-publish",
	description:
		"Publishes the package to the npm registry with `npm` or `pnpm publish`.",
	options: {
		path: z
			.string()
			.default(".")
			.describe("The package's directory, relative to the working directory."),
		client: z
			.enum(["npm", "pnpm"])
			.optional()
			.describe(
				"Defaults to the `packageManager` in package.json, then `pnpm` if there's a `pnpm-lock.yaml`, then `npm`.",
			),
		tag: z
			.string()
			.optional()
			.describe("The dist-tag; defaults to `publishConfig.tag`, or `latest`."),
		access: z
			.enum(["public", "restricted"])
			.optional()
			.describe("Defaults to `publishConfig.access`."),
		provenance: z
			.boolean()
			.default(false)
			.describe(
				"Publishes with a provenance statement; needs `id-token: write`.",
			),
		registry: z
			.string()
			.optional()
			.describe("Defaults to `publishConfig.registry`, or the npm registry."),
		token: z
			.string()
			.optional()
			.describe(
				"Defaults to `NPM_TOKEN` or `NODE_AUTH_TOKEN`; without one, the client's own auth is used, e.g. trusted publishing.",
			),
	},
	run: async ({ env, version, options }) => {
		const dir = resolve(env.cwd, options.path);
		const manifest = join(options.path, "package.json");
		const json = await loadPackageJson(join(dir, "package.json"));
		const name = typeof json.name === "string" ? json.name : undefined;
		if (!name) throw new Error(`${manifest} has no 'name'`);
		if (json.private === true) {
			throw new Error(`${manifest} is private; npm won't publish it`);
		}
		const publishConfig = (json.publishConfig ?? {}) as Record<string, unknown>;
		const registry =
			options.registry ??
			(typeof publishConfig.registry === "string"
				? publishConfig.registry
				: DEFAULT_REGISTRY);
		const client = options.client ?? (await detectClient(dir, json));
		const tag =
			options.tag ??
			(typeof publishConfig.tag === "string" ? publishConfig.tag : "latest");
		const target = `${name}@${version} to ${registry} as ${tag}`;
		const output = { name, version, client, tag, registry };

		if (env.dryRun) {
			return {
				output: { ...output, published: false },
				reason: `would ${client} publish ${target}`,
			};
		}

		// Never publish a version other than the one being released, e.g. when
		// no earlier step wrote it to package.json.
		const current = versionOf(json, manifest);
		if (current !== version) {
			throw new Error(
				`${manifest} is at ${current}, not ${version}; write it first (write-package-json)`,
			);
		}

		const args = ["publish", "--registry", registry, "--tag", tag];
		if (options.access) args.push("--access", options.access);
		if (options.provenance) args.push("--provenance");
		// rylease commits and tags the release itself.
		if (client === "pnpm") args.push("--no-git-checks");

		const token =
			options.token ?? process.env.NPM_TOKEN ?? process.env.NODE_AUTH_TOKEN;
		await withToken(token, registry, (env) =>
			exec(client, args, { cwd: dir, env }),
		);
		return {
			output: { ...output, published: true },
			reason: `published ${target}`,
		};
	},
});

async function detectClient(
	dir: string,
	json: Record<string, unknown>,
): Promise<"npm" | "pnpm"> {
	if (typeof json.packageManager === "string") {
		return json.packageManager.startsWith("pnpm@") ? "pnpm" : "npm";
	}
	// The lockfile may be at a workspace root above the package.
	for (let current = dir; ; current = dirname(current)) {
		if (await exists(join(current, "pnpm-lock.yaml"))) return "pnpm";
		if (await exists(join(current, "package-lock.json"))) return "npm";
		if (dirname(current) === current) return "npm";
	}
}

function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

/**
 * Runs `run` with an environment that authenticates to the registry with the
 * token, if there is one: a copy of the user's npmrc with the token's key
 * added, which both npm and pnpm read. The token itself stays in the
 * environment, never on disk.
 */
async function withToken<T>(
	token: string | undefined,
	registry: string,
	run: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
	if (!token) return run(process.env);
	const userconfig =
		process.env.NPM_CONFIG_USERCONFIG ??
		process.env.npm_config_userconfig ??
		join(homedir(), ".npmrc");
	const existing = await readFile(userconfig, "utf8").catch(() => "");
	const dir = await mkdtemp(join(tmpdir(), "rylease-npmrc-"));
	try {
		const npmrc = join(dir, ".npmrc");
		await writeFile(
			npmrc,
			`${existing.trimEnd()}\n${authKey(registry)}=\${RYLEASE_NPM_TOKEN}\n`.trimStart(),
		);
		const { npm_config_userconfig: _, ...env } = process.env;
		return await run({
			...env,
			NPM_CONFIG_USERCONFIG: npmrc,
			RYLEASE_NPM_TOKEN: token,
		});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** The npmrc key of a registry's token, e.g. `//registry.npmjs.org/:_authToken`. */
function authKey(registry: string): string {
	const url = new URL(registry);
	const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
	return `//${url.host}${path}:_authToken`;
}

function exec(
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ ...options, maxBuffer: 64 * 1024 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr.trim() || error.message;
					reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
				} else {
					resolve(stdout.trim());
				}
			},
		);
	});
}
