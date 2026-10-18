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
  - uses: ryangarber/rylease@v2
```

That runs the bundled `conventional` preset. To configure it, or add more steps, use `steps`: a list shaped like a workflow's. Each entry `uses` a step or preset, gives it options `with`, and may run only `if` an expression holds.

```yaml
  - uses: ryangarber/rylease@v2
    with:
      steps: |
        - uses: conventional
          with:
            github-release: { draft: true }
            conventional-kind:
              types: { docs: none, chore: none, "chore(deps)": patch }
            prepend-changelog: false
        - uses: ./.github/release/announce.ts
          if: "!dryRun && kind != 'patch'"
          with:
            channel: "#releases"
```

```
rylease release · main · /home/runner/work/project/project

  ✔ previous-version  read-package-json     16ms  1.0.0 in package.json, set in 0d92bfa
  ✔ previous-version  read-git-tag           4ms  tag v1.0.0 at 0d92bfa
  ✔ release-changes   conventional-commits  12ms  3 changes in 2 commits since 0d92bfa
  ✔ release-kind      conventional-kind     <1ms  'feat' in title (commit 3a7a7e3)
  ✔ release-version   semver                <1ms  'minor' from 1.0.0
  ✔ release-notes     conventional-notes    <1ms  minor release; features: 1, bug fixes: 1, other: 1
  ✔ release           write-package-json    <1ms  wrote 1.1.0 to package.json
  ✔ release           git-commit            92ms  committed 5be1c2a, tagged v1.1.0 and pushed to origin
  ✔ release           github-release       410ms  created release v1.1.0: https://github.com/me/project/releases/tag/v1.1.0
  ✔ release           announce             130ms  announced 1.1.0 in #releases

  1.0.0 → 1.1.0 (minor) · released
```

- **`uses`** names a bundled step or preset, a path to a file (`./release/announce.ts`, its default export), or an installed package (`some-package`, or `some-package#namedExport`). `.ts` files run as they are; they can `import { defineStep, z } from "rylease"` without installing it.
- **`with`** holds the options. A preset takes options for each of its steps by name, and `false` leaves a step out, for instance to replace it with your own, or to list it again with an `if`. Listing a step that a preset already has is an error, so nothing runs twice by accident.
- **`if`** runs the step only when an expression holds; see [Conditions](#conditions). On a preset, it applies to each of its steps.
- **Options** are checked before anything runs. A typo fails the job with its exact location, e.g. `steps[0].with.semver: Unrecognized key: "shift"`.

| Input | Default | |
|---|---|---|
| `steps` | `- uses: conventional` | The steps, as above. |
| `dry-run` | `false` | Runs every step without side effects; each reports what it would do. |
| `version` | | A version that's already been released, e.g. by an earlier job: only the `release` steps run, for it. |
| `notes` | | The release notes, along with `version`. |
| `working-directory` | `.` | The project to release, e.g. a package in a monorepo. |
| `summary` | `true` | Writes the release, a row per step and the notes to the job's summary page. |
| `token` | `${{ github.token }}` | Used when `GITHUB_TOKEN` isn't set. |

Outputs: `status` (`released`, `unchanged` or `failed`), `released` (`true`/`false`), `previous-version`, `version`, `kind` and `notes`.

### Conditions

`if` is evaluated just before the step would run, so it can depend on what earlier steps did:

```yaml
- uses: npm-publish
  if: "!dryRun && !startsWith(version, '0.')"
- uses: ./release/announce.ts
  if: kind == 'major' || contains(notes, 'security')
- uses: ./release/link.ts
  if: steps.github-release.output.url != null
```

| Name | |
|---|---|
| `dryRun`, `branch`, `cwd` | The run's environment. |
| `previousVersion`, `previousRef`, `changes`, `kind`, `version`, `notes` | The release so far; a value is `null` until its phase has run. |
| `steps.<name>` | Each step that ran before: its `type`, `status` (`ok` or `skipped`), `reason` and `output`. |

Expressions are written like GitHub's: `'strings'` (`''` for a quote), numbers, `true`, `false` and `null`; `.name` and `['name']`; `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `&&`, `||` and parentheses; and `contains(text or list, value)`, `startsWith(text, prefix)` and `endsWith(text, suffix)`. Comparisons are exact, and case-sensitive. An `if` starting with `!` needs quotes in YAML.

GitHub fills in `${{ ... }}` in `steps` before rylease reads it, so `if: ${{ github.event_name == 'workflow_dispatch' }}` works too and becomes `if: true` or `if: false`. If conditions skip every step of a phase, the next phase fails, since it has nothing to go on.

In TypeScript, a condition is a function of what the step receives: `when(steps.npmPublish(), ({ env }) => !env.dryRun)`.

### Publishing to npm

Add `npm-publish` after `conventional`. It publishes with `pnpm` or `npm`, whichever the project uses, so lifecycle scripts like `prepublishOnly` run as usual. Install dependencies first, and set up pnpm if the project uses it.

```yaml
permissions:
  contents: write
  id-token: write # for trusted publishing, or provenance
steps:
  - uses: actions/checkout@v7
    with:
      fetch-depth: 0
  - uses: pnpm/setup@v3 # installs dependencies too
  - uses: ryangarber/rylease@v2
    with:
      steps: |
        - uses: conventional
        - uses: npm-publish
    env:
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }} # not needed with trusted publishing
```

It publishes the version that `write-package-json` wrote, after the release is committed, tagged and pushed, and refuses to publish any other.

### Uploading builds to the release

Jobs that build after the release, say one per platform, can each upload their files to it. Pass the version (and notes) the release job worked out, and only the `release` steps run. Here the `release` job passes on rylease's `released`, `version` and `notes` outputs, and whether it was a dry run, as its own outputs:

```yaml
  build:
    needs: release
    if: needs.release.outputs.released == 'true'
    strategy:
      matrix:
        os: [macos-latest, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: v${{ needs.release.outputs.version }}
      - run: npm ci && npm run build
      - uses: ryangarber/rylease@v2
        with:
          version: ${{ needs.release.outputs.version }}
          notes: ${{ needs.release.outputs.notes }}
          dry-run: ${{ needs.release.outputs.dry-run }}
          steps: |
            - uses: github-release-assets
              with:
                files: ["dist/app-*"]
                dryRunArtifact: true
```

`github-release-assets` uploads to the release that `github-release` created, or creates it if no job has yet. When several jobs race to, the losers wait for the winner's release and use it. Failed requests and uploads are retried, and an upload that failed halfway is cleared first. With `dryRunArtifact`, a dry run keeps the files as a workflow artifact instead, so a dry run of the whole pipeline leaves every build to download. `github-artifact` does the same for any files, in a dry run or not.

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

`markdownSummary(report)` renders a report as the Markdown the action writes to the job summary.

## Steps

| Type | Receives (plus `env`, `context`, `history`) | Returns |
|---|---|---|
| `previous-version` | `previousVersion?`, `previousRef?` | `{ version, ref?, reason }` |
| `release-changes` | `previousVersion`, `previousRef?`, `changes?` | `{ changes: { title?, description?, reason, link? }[], reason }` |
| `release-kind` | … `changes`, `kind?` | `{ kind: "major" \| "minor" \| "patch" \| "none", reason }` |
| `release-version` | … `kind` (never `"none"`), `version?` | `{ version, reason }` |
| `release-notes` | … `version`, `notes?` | `{ notes, reason }` |
| `release` | … `notes`, `releases` (results of earlier `release` steps) | `{ output, files?, reason }` |

- **Order.** Steps are sorted by type. Steps of the same type keep the order you gave them.
- **Chaining.** When several steps share a type, each later one receives the current value as an optional input (e.g. `notes?`). Whatever it returns replaces that value. `release` outputs accumulate instead.
- **One source of truth.** A step takes what it needs from earlier phases and never works it out again. `ref` is the commit of the previous release, and changes are collected from there. `files` lists what a `release` step changed, and `git-commit` commits exactly those.
- **Nothing to release.** If the final `release-kind` is `"none"`, the remaining steps are skipped.
- **Dry run.** Steps get `env.dryRun`. Steps with side effects must do nothing and explain what they *would* have done. The one exception is `dryRunArtifact`, which keeps files as an artifact of the workflow run, which only that run sees.
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

`## Breaking Changes`, `## Features`, `## Bug Fixes`, `## Performance Improvements` and `## Reverts` sections, then `## Other` for everything else.

| Option | Type | Default | |
|---|---|---|---|
| `sections` | `{ title: string, types: string[] }[]` | `[{ title: Features, types: [feat] }, { title: Bug Fixes, types: [fix] }, { title: Performance Improvements, types: [perf] }, { title: Reverts, types: [revert] }]` | Sections in order; a change goes in the first that lists its type. |
| `breaking` | `string \| false` | `Breaking Changes` | The first section, for breaking changes of any type; `false` marks them **(breaking)** in their own section instead. |
| `other` | `string \| false` | `Other` | The section for remaining changes; `false` leaves them out. |
| `links` | `boolean` | `true` | Link each change to its source, e.g. its commit. |

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

Creates a GitHub release with the notes, unless the tag already has one. Needs a token with `contents: write`.

| Option | Type | Default | |
|---|---|---|---|
| `tag` | `string` | `v{version}` | The release's tag; created at HEAD if it doesn't exist. |
| `title` | `string` |  | `{version}` is filled in; defaults to the tag. |
| `draft` | `boolean` | `false` |  |
| `prerelease` | `boolean` | `false` |  |
| `repo` | `string` |  | `owner/repo`; defaults to `GITHUB_REPOSITORY` or the `origin` remote. |
| `token` | `string` |  | Defaults to `GITHUB_TOKEN` or `GH_TOKEN`. |

### More steps

These aren't in `conventional`; list them after it.

#### `github-artifact` · `release`

Uploads files as a workflow artifact. Only works in the GitHub Action.

| Option | Type | Default | |
|---|---|---|---|
| `name` | `string` | required | The artifact's name, unique in the run; `{version}` is filled in. |
| `files` | `string[]` | required | Paths, globs or directories, relative to the working directory unless absolute; each must match. |
| `dryRunArtifact` | `boolean` | `false` | Upload in dry runs too. |
| `retentionDays` | `integer` |  | Defaults to the repository's setting. |

#### `github-release-assets` · `release`

Uploads files to the GitHub release, creating it (with the notes) if no other job has yet.

| Option | Type | Default | |
|---|---|---|---|
| `files` | `string[]` | required | Paths or globs, relative to the working directory unless absolute; each must match. |
| `clobber` | `boolean` | `true` | Replace assets of the same name. |
| `dryRunArtifact` | `boolean` | `false` | In dry runs, keep the files as a workflow artifact instead; only in the GitHub Action. |
| `artifactName` | `string` |  | Unique in the run; `{version}` is filled in. Defaults to the asset's name, or for several, a name made from theirs. |
| `tag` | `string` | `v{version}` | The release's tag; created at HEAD if it doesn't exist. |
| `title` | `string` |  | `{version}` is filled in; defaults to the tag. |
| `draft` | `boolean` | `false` |  |
| `prerelease` | `boolean` | `false` |  |
| `repo` | `string` |  | `owner/repo`; defaults to `GITHUB_REPOSITORY` or the `origin` remote. |
| `token` | `string` |  | Defaults to `GITHUB_TOKEN` or `GH_TOKEN`. |

#### `npm-publish` · `release`

Publishes the package to the npm registry with `npm` or `pnpm publish`.

| Option | Type | Default | |
|---|---|---|---|
| `path` | `string` | `.` | The package's directory, relative to the working directory. |
| `client` | `npm \| pnpm` |  | Defaults to the `packageManager` in package.json, then `pnpm` if there's a `pnpm-lock.yaml`, then `npm`. |
| `tag` | `string` |  | The dist-tag; defaults to `publishConfig.tag`, or `latest`. |
| `access` | `public \| restricted` |  | Defaults to `publishConfig.access`. |
| `provenance` | `boolean` | `false` | Publishes with a provenance statement; needs `id-token: write`. |
| `registry` | `string` |  | Defaults to `publishConfig.registry`, or the npm registry. |
| `token` | `string` |  | Defaults to `NPM_TOKEN` or `NODE_AUTH_TOKEN`; without one, the client's own auth is used, e.g. trusted publishing. |
<!-- options:end -->
