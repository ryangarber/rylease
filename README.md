# rylease

A release pipeline that doesn't fight you.

Everything is a **step**: a small, named, strictly typed function that does one auditable thing and says why. Steps run in a fixed order of phases. Each one receives the environment, your own context, and the outputs of every step before it.

```
previous-version → release-changes → release-kind → release-version → release-notes → release
```

Every step declares its options once, and they work the same in a workflow file as in TypeScript.

## GitHub Actions

```yaml
permissions:
  contents: write
steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0 # full history is needed to find the previous release
  - uses: ryangarber/rylease@v1
```

That runs the bundled `conventional` preset. To configure it, or add more steps, use `steps`: a YAML list where each entry is a name, or a map of one name to its options.

```yaml
  - uses: ryangarber/rylease@v1
    with:
      steps: |
        - conventional:
            github-release: { draft: true }
            conventional-kind:
              types: { docs: none, chore: none, "chore(deps)": patch }
            prepend-changelog: false
        - ./.github/release/announce.ts:
            channel: "#releases"
```

```
rylease release · main · /home/runner/work/project/project

  ✔ previous-version  read-package-json     16ms  1.0.0 in package.json, set in 0d92bfa
  ✔ previous-version  read-git-tag           4ms  tag v1.0.0 at 0d92bfa
  ✔ release-changes   conventional-commits  12ms  3 changes in 2 commits since 0d92bfa
  ✔ release-kind      conventional-kind     <1ms  'feat' in title (commit 3a7a7e3)
  ✔ release-version   semver                <1ms  'minor' from 1.0.0
  ✔ release-notes     conventional-notes    <1ms  minor release; features: 1, fixes: 1, other: 1
  ✔ release           write-package-json    <1ms  wrote 1.1.0 to package.json
  ✔ release           git-commit            92ms  committed 5be1c2a, tagged v1.1.0 and pushed to origin
  ✔ release           github-release       410ms  created release v1.1.0: https://github.com/me/project/releases/tag/v1.1.0
  ✔ release           announce             130ms  announced 1.1.0 in #releases

  1.0.0 → 1.1.0 (minor) · released
```

- **Names** can be a bundled step or preset, a path to a file (`./release/announce.ts`, its default export), or an installed package (`some-package`, or `some-package#namedExport`). `.ts` files run as they are; they can `import { defineStep, z } from "rylease"` without installing it.
- **Presets** take options for each of their steps by name. `false` leaves a step out, for instance to replace it with your own. Listing a step that a preset already has is an error, so nothing runs twice by accident.
- **Options** are checked before anything runs. A typo fails the job with its exact location, e.g. `steps[0].conventional.semver: Unrecognized key: "shift"`.

| Input | Default | |
|---|---|---|
| `steps` | `- conventional` | The steps, as above. |
| `dry-run` | `false` | Runs every step without side effects; each reports what it would do. |
| `working-directory` | `.` | The project to release, e.g. a package in a monorepo. |
| `token` | `${{ github.token }}` | Used when `GITHUB_TOKEN` isn't set. |

Outputs: `status` (`released`, `unchanged` or `failed`), `released` (`true`/`false`), `previous-version`, `version`, `kind` and `notes`.

## TypeScript

The same release, as a script:

```ts
// release.ts
import { defineRelease, steps } from "rylease";

await defineRelease({
	steps: [
		...steps.conventional({
			"github-release": { draft: true },
			"conventional-kind": { types: { docs: "none", chore: "none" } },
			"prepend-changelog": false,
		}),
		announce({ channel: "#releases" }),
	],
})
	.run({ dryRun: process.argv.includes("--dry-run") })
	.catch(() => {
		process.exitCode = 1; // the failure has already been printed
	});
```

## Steps

| Type | Receives (plus `env`, `context`, `history`) | Returns |
|---|---|---|
| `previous-version` | `previousVersion?`, `previousRef?` | `{ version, ref?, reason }` |
| `release-changes` | `previousVersion`, `previousRef?`, `changes?` | `{ changes: { title?, description?, reason }[], reason }` |
| `release-kind` | … `changes`, `kind?` | `{ kind: "major" \| "minor" \| "patch" \| "none", reason }` |
| `release-version` | … `kind` (never `"none"`), `version?` | `{ version, reason }` |
| `release-notes` | … `version`, `notes?` | `{ notes, reason }` |
| `release` | … `notes`, `releases` (results of earlier `release` steps) | `{ output, files?, reason }` |

- **Order.** Steps are sorted by type. Steps of the same type keep the order you gave them.
- **Chaining.** When several steps share a type, each later one receives the current value as an optional input (e.g. `notes?`). Whatever it returns replaces that value. `release` outputs accumulate instead.
- **One source of truth.** A step takes what it needs from earlier phases and never works it out again. `ref` is the commit of the previous release, and changes are collected from there. `files` lists what a `release` step changed, and `git-commit` commits exactly those.
- **Nothing to release.** If the final `release-kind` is `"none"`, the remaining steps are skipped.
- **Dry run.** Steps get `env.dryRun`. Steps with side effects must do nothing and explain what they *would* have done.
- **Audit.** `run()` resolves to a report with a record (type, name, status, duration, reason, output) for every step. On failure it rejects with a `ReleaseError` whose `.report` holds the same records.

### Custom steps

`defineStep` declares a step and its options, as a [zod](https://zod.dev) shape. The result is a factory: call it with options to get a step. Options are typed from the shape, and validated on every call, whether they come from TypeScript or from a workflow file. Use `.default()` for optional options, and `.describe()` to document them.

```ts
// .github/release/announce.ts
import { defineStep, z } from "rylease";

export default defineStep({
	type: "release",
	name: "announce",
	description: "Posts the release to Slack.",
	options: {
		channel: z.string().describe("Where to post."),
		mention: z.boolean().default(false),
	},
	run: async ({ version, env, options }) => {
		if (env.dryRun) return { output: null, reason: `would announce in ${options.channel}` };
		await postToSlack(options.channel, `Released ${version}`);
		return { output: null, reason: `announced ${version} in ${options.channel}` };
	},
});
```

Steps that run git can use `git(env.cwd, ...args)`, which resolves with its trimmed output and fails with git's own error, or `tryGit`, which resolves with `undefined` instead of failing.

`definePreset({ name, steps })` bundles factories, like `steps.conventional`, and takes options per step by name.

Steps given inline to `defineRelease` are plain `{ type, name, run }` objects, typed from their `type`.

### Context

`context` holds whatever state you want to share between inline steps, and its type is yours. It is the only place for arbitrary state, and the bundled steps never touch it.

```ts
defineRelease<{ slackTs?: string }>({
	context: {},
	steps: [
		...steps.conventional(),
		{
			type: "release",
			name: "announce",
			run: async ({ version, context, env }) => {
				if (env.dryRun) return { output: null, reason: "would announce" };
				context.slackTs = await postToSlack(`Released ${version}`);
				return { output: context.slackTs, reason: "posted to #releases" };
			},
		},
	],
});
```

## Bundled steps

`conventional` runs all of these, in this order. Each is also exported on its own (`steps.readPackageJson`, …).

<!-- options:start -->
#### `read-package-json` · `previous-version`

Reads `version` from `package.json`, and the commit that set it as the ref.

| Option | Type | Default | |
|---|---|---|---|
| `path` | `string` | `package.json` | Relative to the working directory. |

#### `read-git-tag` · `previous-version`

Points the ref at the tag of the version read before it; on its own, reads the highest tagged version.

| Option | Type | Default | |
|---|---|---|---|
| `tag` | `string` | `v{version}` | The tag of a version. |

#### `conventional-commits` · `release-changes`

Collects each conventional section (`feat:`, `fix(x)!:` …) of every commit since the previous version's ref.

No options.

#### `conventional-kind` · `release-kind`

`!` or `BREAKING` → major; otherwise by conventional type (`feat` → minor, anything else → patch). The highest kind wins.

| Option | Type | Default | |
|---|---|---|---|
| `types` | `{ [key]: major \| minor \| patch \| none }` | `{}` | Kinds by `type` or `type(scope)`, on top of `feat: minor`, e.g. `{ docs: none, chore(deps): patch }`. |
| `fallback` | `major \| minor \| patch \| none` | `patch` | The kind of any other change, untyped ones included. |

#### `semver` · `release-version`

Bumps the previous version by the kind: `MAJOR.minor.patch`, or `0.MAJOR.minorOrPatch` before 1.0.0.

| Option | Type | Default | |
|---|---|---|---|
| `shiftPreMajor` | `boolean` | `true` | Before 1.0.0, bump major changes as minor and minor changes as patch. |

#### `conventional-notes` · `release-notes`

A `## Features` and a `## Fixes` section, then `## Other` for everything else.

| Option | Type | Default | |
|---|---|---|---|
| `sections` | `{ title: string, types: string[] }[]` | `[{ title: Features, types: [feat] }, { title: Fixes, types: [fix] }]` | Sections in order; a change goes in the first that lists its type. |
| `other` | `string \| false` | `Other` | The section for remaining changes; `false` leaves them out. |

#### `write-package-json` · `release`

Writes the new version to `package.json`, keeping its formatting.

| Option | Type | Default | |
|---|---|---|---|
| `path` | `string` | `package.json` | Relative to the working directory. |

#### `prepend-changelog` · `release`

Prepends a heading and the notes to `CHANGELOG.md`, creating it if needed.

| Option | Type | Default | |
|---|---|---|---|
| `path` | `string` | `CHANGELOG.md` | Relative to the working directory. |
| `heading` | `string` | `# v{version} ({date})` | `{version}` and `{date}` (YYYY-MM-DD) are filled in. |

#### `git-commit` · `release`

Commits the files earlier release steps changed, tags the commit and pushes both.

| Option | Type | Default | |
|---|---|---|---|
| `files` | `string[]` | `[]` | More files to commit, relative to the working directory. |
| `message` | `string` | `chore(release): v{version}` | The commit and tag message; `{version}`, `{major}`, `{minor}` and `{patch}` are filled in. |
| `tag` | `string \| false` | `v{version}` | The tag, with the same placeholders; it must be new. `false` skips tagging. |
| `move` | `string[]` | `[]` | Tags to create or move to the release, e.g. `v{major}`; force-pushed. |
| `push` | `string \| false` | `origin` | The remote to push to; `false` skips pushing. |

#### `github-release` · `release`

Creates a GitHub release with the notes. Needs a token with `contents: write`.

| Option | Type | Default | |
|---|---|---|---|
| `tag` | `string` | `v{version}` | The release's tag; created at HEAD if it doesn't exist. |
| `title` | `string` |  | `{version}` is filled in; defaults to the tag. |
| `draft` | `boolean` | `false` |  |
| `prerelease` | `boolean` | `false` |  |
| `repo` | `string` |  | `owner/repo`; defaults to `GITHUB_REPOSITORY` or the `origin` remote. |
| `token` | `string` |  | Defaults to `GITHUB_TOKEN` or `GH_TOKEN`. |
<!-- options:end -->
