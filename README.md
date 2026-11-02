# release-kit

[![CI](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml)

Releases that explain themselves, from commits that are checked as they are written.

release-kit sets up a whole release process in a GitHub repo with one command:

- **Commit messages are checked**, by a `commit-msg` hook and by a CI check on every pushed commit and every pull request title (a squash merge commits the title), so the history follows [Conventional Commits](https://www.conventionalcommits.org) before release time, not after.
- **Versions follow SemVer**, picked from the commits: a breaking change is major, a feature is minor, anything else is a patch.
- **Release notes are written for users**, under the headings New, Fixed, Faster and Safer, from `feat`, `fix`, `perf` and `security` commits; chores, docs and bot commits stay out.
- **A tag publishes a GitHub Release** through a workflow that checks the tag against every version file, runs the repo's checks again, and checksums any files it ships.
- **An optional release train** releases on a schedule, but only when something a user would notice has landed.
- **A weekly security scan** checks every lock file against [OSV.dev](https://osv.dev) and fails on malicious packages and high or critical vulnerabilities.
- **Agents get the rules too**: apply writes a short section into `AGENTS.md` (and `CLAUDE.md` when the repo has one), so coding agents write commits the check accepts.

It has no runtime dependencies: plain Node scripts and GitHub Actions workflows, with every third-party action pinned to a commit SHA.
The rules and the reasoning behind them are in [STANDARD.md](STANDARD.md).

## Who it is for

- Solo developers and small teams with several apps or sites on GitHub who want every repo to release the same way.
- Repos where coding agents write many of the commits, and a rule only holds if a hook and CI enforce it.
- Projects whose release notes are read by users (a changelog page, a build log, an app's "what's new"), not only by developers.

It is a poor fit today for monorepos with several independently versioned packages, for projects that need to publish to npm or another registry as part of the release, and for repos without a `package.json` (see [Limits](#limits)).

## How it compares

| | release-kit | semantic-release | release-please | changesets |
|---|---|---|---|---|
| Version comes from | Conventional Commits | Conventional Commits | Conventional Commits | Changeset files written per change |
| Checks commit messages | Yes, hook and CI | No (add commitlint) | No | Not applicable |
| When it releases | `npm run release`, or a scheduled train when there is user-facing work | Every push to a release branch | When the release PR is merged | When the version PR is merged |
| Notes | Plain headings for users, `Release-note:` rewording | Developer changelog | Developer changelog | Written by hand |
| Monorepos | No | Community add-on | Yes | Yes |
| Publishes to npm | No | Yes | No | Yes |
| Agent instructions and a dependency scan | Yes | No | No | No |

A longer, sourced comparison (including release-it, git-cliff, auto and the deprecated standard-version) is in [docs/REVIEW_2026-11.md](docs/REVIEW_2026-11.md#3-competitor-comparison).

## Quick start

In the repo you want to release (it needs a `package.json` and a `package-lock.json`):

```bash
npx --allow-git=root github:n8watkins/release-kit .   # npm 12 needs --allow-git; or: node path/to/release-kit/apply.mjs .
npm install                                          # installs the pinned kit (apply allowed it in .npmrc)
git diff                                             # review what it added
git add -A && git commit -m "chore: adopt release-kit"
npm run release -- --baseline                        # tag the version the repo is already at
git push && git push origin vX.Y.Z                   # the baseline tag is verified, not published
```

**npm 12:** npm 12 refuses git dependencies by default, so `npm install` and `npm ci` stop with `EALLOWGIT`, and the kit is a git dependency.
In package mode apply adds this line to the repo's `.npmrc` (and leaves an `allow-git=all` the repo already has alone):

```ini
allow-git=root
```

`root` is the narrowest setting that works: it allows git dependencies listed in the repo's own `package.json`, and none pulled in by other packages.
npm 10 and 11 accept the line too, so it is safe on every runner.
A repo that adopted the kit before apply did this gets it by re-running `npx release-kit apply .`.

From then on:

```bash
npm run release -- --dry-run      # preview the next version and the notes
npm run release -- --push         # check, bump, changelog, commit, tag and push; the workflow publishes
npm run release -- --plan         # what the release train would do now
```

If the repo squash-merges pull requests, make the pull request title the squash commit's message (apply prints the `gh` command; see [template/RELEASING.md](template/RELEASING.md#pull-requests)): the title is what lands on main, and CI checks it.

## How upgrades reach your repos

Each repo installs the kit as a dev dependency pinned to a release tag, `"release-kit": "github:n8watkins/release-kit#vX.Y.Z"`, and its workflows call the kit's workflows at the same tag.

- **Version bumps arrive by Dependabot.** apply writes `.github/dependabot.yml` so a new kit release opens update PRs for the dev dependency (npm) and for the workflow pins (github-actions), and the repo's CI tests them before they are merged.
  Today that is one PR for the dev dependency plus one per kit workflow; merge them together.
- **`npm run release:check` warns** when the installed kit is behind the newest release, or when the workflows pin a different version than the one installed.
- **New files need a re-run of apply.** Dependabot can change a version, not add a file, so when a kit release adds or changes a file apply writes (for example `security.yml` in v2.1.0), run this in each repo after the update lands:

  ```bash
  npx release-kit apply .
  ```

Planned, not built yet:

- A rollout workflow in release-kit that runs apply against every adopting repo on each release and opens one PR per repo through a GitHub App.
- One grouped Dependabot PR per kit release instead of several.

The design for these is in [docs/REVIEW_2026-11.md](docs/REVIEW_2026-11.md#6-roadmap).

## What apply adds

- In package mode (the default), the `release-kit` dev dependency and `.github/dependabot.yml`; in the other modes, `scripts/release-kit/` with the release, notes and commit-check scripts.
- `.github/workflows/release.yml`, `commits.yml` and `security.yml`, plus `release-train.yml` with `--train`.
- `.githooks/commit-msg` (or `.husky/commit-msg` in a husky repo), switched on by the `prepare` script.
  A repo whose hooks are run by something else (lefthook, pre-commit, simple-git-hooks, its own `core.hooksPath` or `.git/hooks`) keeps them: apply prints the line to add to its commit-msg hook instead.
- `.release.json`: other files that carry the version (`versionFiles`; it detects `manifest.json`, and for a Tauri app `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, plus `app/package.json` and its lock when the app lives in `app/`), the workflow mode (`workflows`: `package`, `reusable` or `vendored`) and the train's schedule (`train`).
  Optional keys: `node` (the Node version for the workflows, else `.nvmrc` or `.node-version`, else 22), `timeZone` for changelog dates (for example `"America/Los_Angeles"`), `branches` (the branches `npm run release` cuts releases from, default `["main", "master"]`), `notes` (see below) and `lanes` (`docs` and `fullFor`, see [CI lanes](#ci-lanes)).
- In package mode, `allow-git=root` in `.npmrc`, so npm 12 installs the kit (see the npm 12 note above).
- `package.json` scripts: `release` (an existing `release` script is left alone unless `--force`), `release:check` (composed from whichever of lint, typecheck, test and build the repo has), `prepare`.
- `RELEASING.md`, and a short section in `AGENTS.md` / `CLAUDE.md` so agents follow the rules.

If the repo ships files, add a `release:artifacts` script that writes them into `release-artifacts/` (for a WXT extension: `wxt zip && cp .output/*.zip release-artifacts/`); the Release workflow checksums and attaches them.

### Options

| Option | What it does |
|---|---|
| `--train` | Adds the release train (`.github/workflows/release-train.yml`): every week it releases whatever user-facing work landed, and "Run workflow" releases now. |
| `--schedule "<cron>"` | When the train runs, in UTC (default `"0 16 * * 1"`, Mondays 16:00). Implies `--train`. |
| `--train-checks <a.yml,b.yml>` | Workflows the train runs on its release commit before moving `main` to it: the ones whose checks branch protection requires. |
| `--no-train` | Removes the train. |
| `--package` | The default: the kit is a dev dependency, run from `node_modules`. |
| `--reusable` | The workflows call the kit's, but the scripts are copied into `scripts/release-kit/`. |
| `--vendored` | Full copies of the workflows and the scripts. |
| `--kit-ref <ref>` | Pin a commit SHA (or another tag) instead of this kit's version tag. |
| `--force` | Replace a workflow with the same name that the kit didn't write. |

The choices are saved in `.release.json`, so re-running apply to upgrade keeps them.

### Package, reusable and vendored modes

In package mode nothing of the kit is copied into the repo: `npm run release` runs `release-kit release`, and the commit-msg hook runs `release-kit commit-msg` from `node_modules` (before `npm install` it lets commits through with a note; CI checks every commit anyway).
The `release-kit` command also runs `notes`, `train`, `protect`, `check`, `verify`, `lanes` and `apply`.

Package and reusable mode write short callers of the kit's workflows, for example:

```yaml
jobs:
  release:
    permissions:
      contents: write
    uses: n8watkins/release-kit/.github/workflows/release.yml@vX.Y.Z  # the installed kit version
```

The called workflow fetches the kit's scripts at the same ref, so the pin decides everything that runs in CI.
The repo's workflows need only `contents: read` by default; the release and train callers grant `contents: write` (and `actions: write` for the train) to that one job.
In reusable mode the scripts are also copied into `scripts/release-kit/` for the local hook and `npm run release`; re-run apply to upgrade those.
Vendored mode copies the full workflows and scripts: everything that runs is in the repo, and an upgrade is a re-run of apply (`scripts/release-kit/VERSION` shows which kit version it runs).

## Release notes people want to read

The notes come from `feat`, `fix`, `perf` and `security` subjects, so write those for users: what they can now do, or what works better.

- A `Release-note: <plain sentence>` line in the commit body rewords a change for the notes; `Release-note: skip` leaves one out.
- `npm run release -- --summary "Dark mode, and a faster homepage."` opens the release with a line in your words.
- The notes use the headings New, Fixed, Faster and Safer and leave out scope labels; `.release.json` `"notes": { "style": "classic" }` keeps the commit-type headings (Features, Fixes) and scopes, and `headings` and `scopes` tune them one by one.
- The GitHub Release shows exactly the section written to `CHANGELOG.md`, and `(#12)` links to its pull request.

See [template/RELEASING.md](template/RELEASING.md) for examples.

## The release train

With `--train`, a scheduled workflow cuts releases so nobody has to remember:

1. It finds the commits on `main` since the last `vX.Y.Z` tag.
   With no feature, fix, security or performance change, `revert:` commit or breaking change among them, it stops: nothing to release.
2. It runs `npm run release:check` on that exact commit.
3. As `github-actions[bot]` it makes the release commit and tag, exactly like `npm run release -- <version>`.
4. With `train.checks` in `.release.json` (`--train-checks ci.yml,commits.yml`), it pushes that commit to a temporary `release-train/vX.Y.Z` branch, starts each listed workflow there and waits for it to pass.
5. It pushes `main` and the tag in one atomic push, then makes sure the Release workflow runs on the tag.

GitHub starts no workflow for a tag or commit pushed with a workflow's own `GITHUB_TOKEN`, so the train starts the checks and the Release workflow itself with `workflow_dispatch`; each workflow in `train.checks` needs `workflow_dispatch:` in its `on:`.
The same rule means the train can't loop.

GitHub doesn't count checks from `workflow_dispatch` runs toward branch protection, so on a protected `main` the push needs a deploy key the protection lets through.
`npx release-kit protect` (`node scripts/release-kit/protect.mjs` in a vendored repo) sets that up once: a ruleset with the required checks that deploy keys (and admins) may bypass, the deploy key, and the `RELEASE_TRAIN_KEY` secret (see [RELEASING.md](RELEASING.md)).
Note that a ruleset's deploy-key bypass applies to every write deploy key on the repo, not only the train's.

"Run workflow" on the train takes a bump (`auto`, `patch`, `minor`, `major`) and a dry-run switch.
It needs a release tag to start from, so baseline a new repo first.

## CI lanes

A pull request that only edits docs, or only updates the kit, doesn't need the repo's full CI.
The kit ships a reusable `changes.yml` workflow that classifies a pull request's diff into a lane (`docs`, `kit`, `deps` or `full`), and `npx release-kit verify`, the one-minute check a kit-only update runs instead of the full suite.
A repo's `ci.yml` calls `changes.yml` first, runs each of its jobs with a job-level `if:` on the lane, and requires only one always-running "CI result" job.
Pushes to main, manual runs and anything the classifier doesn't recognise run everything.

Never use workflow-level `paths` filters for this: a required check from a skipped workflow is never reported, and the pull request waits forever.
[docs/CI_LANES.md](docs/CI_LANES.md) explains the lanes, the settings and the pitfall, and [docs/examples/ci.yml](docs/examples/ci.yml) is a ready-to-copy `ci.yml`.

## Auto-merge for updates

The kit's reusable `auto-merge.yml` merges release-kit updates and Dependabot patch and minor updates (security ones included) on their own once CI passes; a major update always waits for a person.
It turns on GitHub's auto-merge only when the base branch requires status checks, because without one GitHub would merge before CI finishes.
A repo that can't require checks (a private repo on GitHub Free) gets a "merge when green" fallback that merges once every check on the pull request has passed.
[docs/AUTO_MERGE.md](docs/AUTO_MERGE.md) has the policy and the setup, and [docs/examples/auto-merge.yml](docs/examples/auto-merge.yml) is the workflow to copy.

## Security scan

`security.yml` scans every lock file in the repo (npm, pnpm, yarn, bun, Cargo, uv, poetry, pip, Go) against OSV.dev every Monday and on any pull request that changes a lock file.
OSV also lists malicious packages, which Dependabot alerts don't cover, so the two complement each other.

- **It fails** on a malicious package (an OSV `MAL-` entry) or a high or critical vulnerability (CVSS 7.0 or more, or rated HIGH or CRITICAL by its advisory).
- **It warns** on everything else, as annotations on the run.
- **To accept a finding on purpose**, add an `[[IgnoredVulns]]` entry (`id`, `ignoreUntil`, `reason`) to `osv-scanner.toml` next to the lock file.
- OSV-Scanner is a pinned release, checked against its published SHA-256 before it runs.
- Don't make "Security scan" a required status check: it only runs on pull requests that change a lock file, and GitHub leaves a required check from a skipped workflow waiting forever.

## When a Release run fails

Fix the cause, then use **Re-run failed jobs** on the run: the workflow is safe to run again, and a release a failed run already created is finished instead of duplicated.
When the fix is in the workflow itself, or the run is older than its 14-day build artifacts, use Actions, Release, "Run workflow" from `main` with the tag in the "tag" box.
If the release already has files that differ from the new build, the run stops rather than replace files people may have downloaded.
Every job has a timeout, so a hung check fails within 30 minutes instead of GitHub's default 6 hours.
Don't move or re-push a tag that is already on GitHub.

## Backfilling past milestones

Tag a past commit with the version its `package.json` had, and publish it as a release:

```bash
npm run release -- --baseline <commit> --publish
git push origin vX.Y.Z
```

## Limits

- One version per repo: no monorepo or per-package releases.
- npm only: apply needs a `package.json`, and the workflows install with `npm ci`, so a pnpm, yarn or bun repo needs a `package-lock.json` too (apply warns).
- It publishes GitHub Releases, not packages: publishing to npm or another registry is up to the repo.
- Release files get SHA-256 checksums, but no signatures or provenance attestations yet.
- The kit is installed from GitHub, not from the npm registry, so npm 12 needs the `allow-git=root` line apply writes (see the quick start).

## This repo follows it too

The kit uses its own standard: commits are checked by the same hook and workflow, and releases are cut with `npm run release`.
`scripts/release-kit` and `.githooks` are links into `template/`.
`.github/workflows/` holds the shipped workflows, because that is where other repos call them; a test fails if they drift from the template.
The kit's copy of the train has no schedule: the kit is released by hand.

## Developing the kit

```bash
npm run hooks   # once after cloning: turns on the commit-msg hook
npm test        # unit tests, end-to-end runs against throwaway repos, workflow checks (actionlint too, if installed)
```

The kit has no `prepare` script on purpose: npm runs a git dependency's `prepare` in every adopting repo, and npm 12 holds install scripts back with a warning.

Release kit changes with `npm run release` like any other repo.
When a release changes what apply writes (a new workflow, a workflow input, the hook), re-run `npx release-kit apply .` in each repo after the update lands.

## License

MIT.
