# release-kit

[![CI](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml)

Releases that explain themselves, from commits that are checked as they are written.

release-kit sets up a whole release process in a GitHub repo with one command:

- **Commit messages are checked**, by a `commit-msg` hook and by a CI check on every pushed commit and every pull request title (a squash merge commits the title), so the history follows [Conventional Commits](https://www.conventionalcommits.org) before release time, not after.
- **Versions follow SemVer**, picked from the commits: a breaking change is major, a feature is minor, anything else is a patch.
  Below 1.0 a breaking change is a minor bump, and 1.0.0 is only ever cut on purpose (`npm run release -- --stable`).
- **Release notes are written for users**, under the headings New, Fixed, Faster and Safer, from `feat`, `fix`, `perf` and `security` commits; chores, docs and bot commits stay out.
- **A tag publishes a GitHub Release** through a workflow that checks the tag against every version file, runs the repo's checks again, and checksums any files it ships.
- **An optional release train** releases on a schedule, but only when something a user would notice has landed.
- **A weekly security scan** checks every lock file against [OSV.dev](https://osv.dev) and fails on malicious packages and high or critical vulnerabilities.
- **Agents get the rules too**: apply writes a short section into `AGENTS.md` (and `CLAUDE.md` when the repo has one), so coding agents write commits the check accepts.
- **Direct pushes are stopped and reported**, even in a private repo on GitHub Free, which has no rulesets: a pre-push guard blocks pushes to `main`, force pushes and moved release tags before they leave the machine, and a Direct push alarm reports any that get through ([docs/PRIVATE_REPOS.md](docs/PRIVATE_REPOS.md)).

It has no runtime dependencies: plain Node scripts and GitHub Actions workflows, with every third-party action pinned to a commit SHA.
The rules and the reasoning behind them are in [STANDARD.md](STANDARD.md).

## Who it is for

- Solo developers and small teams with several apps or sites on GitHub who want every repo to release the same way.
- Repos where coding agents write many of the commits, and a rule only holds if a hook and CI enforce it.
- Projects whose release notes are read by users (a changelog page, a build log, an app's "what's new"), not only by developers.

It is a poor fit today for monorepos with several independently versioned packages, for projects that need to publish to npm or another registry as part of the release, and for repos without a `package.json` (see [Limits](#limits)).

## Do I need the GitHub App?

No.
The kit is a package each repo installs; the GitHub App only powers the optional [rollout bot](#the-rollout-bot), which serves the maintainer's own repos.
Without it, Dependabot opens one pull request per kit release that moves the version, and when a release adds or changes files you run `npx release-kit apply .` in the repo.
The full answer, with a side-by-side table, is in [docs/UPGRADES.md](docs/UPGRADES.md).

## How it compares

| | release-kit | semantic-release | release-please | changesets |
|---|---|---|---|---|
| Version comes from | Conventional Commits | Conventional Commits | Conventional Commits | Changeset files written per change |
| Checks commit messages | Yes: a hook, CI on every commit, and pull request titles | No (add commitlint) | No | Not applicable |
| When it releases | `npm run release`, or a scheduled train when there is user-facing work | Every push to a release branch | When the release PR is merged | When the version PR is merged |
| Notes | Plain headings for users, `Release-note:` rewording | Developer changelog | Developer changelog | Written by hand |
| Agent instructions | Writes and keeps a block in AGENTS.md / CLAUDE.md | No | No | No |
| Dependency scan | OSV, blocks malicious and high-severity packages | No | No | No |
| Runtime dependencies | None | Many | Many | Many |
| Reviewable release PR | Planned | No | Yes | Yes |
| Pre-releases | Planned | Yes | Yes | Yes |
| Monorepos | Planned, not soon | Community add-on | Yes | Yes |
| Publishes to npm | No | Yes | No | Yes |
| Provenance / signed artifacts | Checksums today; attestations planned | Via npm provenance | No | Via npm provenance |

### What it does differently

- **Commit messages are enforced, not trusted.** A `commit-msg` hook rejects a bad message as it is written, CI checks every pushed commit (including ones that skipped the hook), and pull request titles are checked because a squash merge commits them.
  The other tools read whatever history they find; matching this means wiring commitlint and a hook manager yourself.
- **Agents get the rules.** apply writes and maintains a short block in `AGENTS.md` (and `CLAUDE.md`) with the commit and release rules, in words a coding agent follows, so the commits an agent writes pass the check.
- **Notes for users.** `feat`, `fix`, `perf` and `security` subjects become plain "New, Fixed, Faster, Safer" notes, a `Release-note:` line rewords a technical subject, and chores, docs and bot commits stay out.
- **A release train that only ships user-facing work.** On a schedule it releases what landed, but a week of chores and docs releases nothing, and it runs the required checks on the exact release commit first.
- **Security in the same kit, with nothing to install.** A weekly OSV scan blocks malicious packages (which Dependabot alerts don't cover) and high or critical vulnerabilities, every workflow's hardening is enforced by tests, and the kit itself has zero runtime dependencies.
- **Upgrades that stay in step.** One grouped Dependabot pull request per kit release, a one-minute `release-kit verify` lane for it, and an auto-merge policy that merges patch and minor updates once CI passes and never a major.

### Where it is behind

- **No registry publishing:** it makes GitHub Releases and attaches files; publishing to npm is up to the repo.
- **Not on the npm registry itself:** it installs as a git dependency, which npm 12 only allows through the `.npmrc` line apply writes, and which carries no provenance (publishing with trusted publishing is planned).
- **One version per repo:** no monorepo support.
- **npm only:** pnpm, yarn and bun repos need a `package-lock.json` too (support is planned).
- **No reviewable release PR or pre-release channels yet** (both planned).
- **Upgrades that add files** reach the repos the rollout bot's GitHub App is installed on by pull request; any other repo needs a re-run of apply.
- **One maintainer.**

The plans are in [docs/ROADMAP.md](docs/ROADMAP.md).
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

- **Version bumps arrive by Dependabot, as one pull request.** apply writes `.github/dependabot.yml` with a Dependabot [multi-ecosystem group](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/configuring-multi-ecosystem-updates) named `release-kit`, so a new kit release opens a single PR that moves the dev dependency (npm) and every workflow pin (github-actions) together, and the repo's CI tests it before it is merged.
  Its commits read `build(deps): ...` in every repo.
  A `dependabot.yml` the kit wrote before is upgraded by re-running apply; a repo's own `dependabot.yml` is left alone, and apply says how to add the group.
  The kit is excluded from Dependabot's default 3-day cooldown: with the cooldown, Dependabot skips the newest tags of a git dependency and proposes the newest older one, even below the installed version (repos on v2.2.0 got "bump release-kit from v2.2.0 to v2.0.1").
  So a release reaches each repo's PR queue within a day, and the auto-merge policy refuses any downgrade as a second line of defense.
- **Every other dependency stays current too.** The same `dependabot.yml` has a second npm and github-actions entry for everything but the kit: weekly version updates, patch and minor in one pull request that merges on its own once CI passes, majors in another that waits for a person, after a 3-day cooldown (7 for an npm major).
  Security updates are never blocked: Dependabot opens one as soon as an alert appears, for direct and transitive dependencies alike ([docs/UPGRADES.md](docs/UPGRADES.md#everything-else-dependabot-updates)).
- **`npm run release:check` warns** when the installed kit is behind the newest release, when the workflows pin a different version than the one installed, or when the files differ from what apply writes at the installed version ("release-kit vX.Y.Z adds or changes N files; run npx release-kit apply ."); `npx release-kit apply --check .` is the same comparison as a command that exits 1, and a kit-only pull request's `release-kit verify` shows it as a warning ([docs/UPGRADES.md](docs/UPGRADES.md#without-the-app)).
- **New files arrive from the rollout bot.** Dependabot can change a version, not add a file, so when a kit release adds or changes a file apply writes (for example `security.yml` in v2.1.0), apply has to run in each repo.
  The rollout bot does that: see [The rollout bot](#the-rollout-bot).
  In a repo the bot doesn't cover, run this after the update lands:

  ```bash
  npx release-kit apply .
  ```

### The rollout bot

On every published release, `.github/workflows/rollout.yml` in release-kit runs apply in each adopter and opens one pull request per repo, `ci: update release-kit to vX.Y.Z` from the branch `release-kit/update`.

- **Who gets it:** the repos in [adopters.json](adopters.json) with `"enabled": true`, each with the branch to target, its visibility, its wave and how its pull requests merge (`auto-merge`, `merge-when-green` or `person`).
  A repo the bot's GitHub App isn't installed on stays listed with `"enabled": false` and the reason.
- **In waves:** the canary repo first, then the public repos, then the private ones; a wave starts only when the one before it succeeded, so a red canary stops the rollout.
- **No clicks for a patch or minor release:** after the canary wave, a gate waits up to an hour for the canary's update pull request to pass its checks and merge, and only then do the other waves start.
  A failed check, a pull request closed without merging, or the timeout stops the rollout.
- **The owner's approval for a major release:** each wave first waits for one click in the `rollout-major` environment, since a major update waits for a person to merge it anyway.
- **Failures reach the owner:** when anything in a real rollout fails, a last job opens an issue labeled `release-kit: rollout` in release-kit (or comments on the open one), naming each failed job, which names its repo, with a link to its log.
- **The key stays put:** the App's ID and key live in the `rollout` environment, which only `main` and `v*` tags may use; `rollout-major` holds only the required reviewer.
- **Per repo:** a token scoped to that one repo (`actions/create-github-app-token`, pinned by SHA), apply from the kit checked out at the tag (`apply.mjs --json`), `npm install --package-lock-only --ignore-scripts` for the new pin (with `allow-git=root`, so npm 12 accepts the kit as a git dependency), and the pull request: what apply added, changed and removed, the notes it left for a person, how the pull request merges, and the release notes.
  A repo with its own `dependabot.yml` keeps it; apply's notes in the pull request say what to add.
  A rerun updates the same pull request.
- **Merging:** pull requests opened with an App token run CI like any other, and the `auto-merge.yml` apply writes lists the bot (`release-kit-bot-n8watkins[bot]`) next to Dependabot, so its update merges under the same policy.
- **By hand:** Actions, Rollout, "Run workflow" takes a tag, an optional list of repos and a dry-run switch (on by default), which shows each pull request in the run summary and pushes nothing.
  A dry run that names a disabled adopter checks it too, which shows whether the App is installed there.

Whether a repo needs it, and the App's setup steps, are in [docs/UPGRADES.md](docs/UPGRADES.md).
Its design is in [docs/ROADMAP.md](docs/ROADMAP.md#8-the-rollout-bot), along with npm publishing, signed releases, pre-releases and the other planned work.

## What apply adds

- In package mode (the default), the `release-kit` dev dependency and `.github/dependabot.yml`; in the other modes, `scripts/release-kit/` with the release, notes and commit-check scripts.
- `.github/workflows/release.yml`, `commits.yml`, `security.yml` and `direct-push.yml` (the [Direct push alarm](docs/PRIVATE_REPOS.md#the-direct-push-alarm)), plus `release-train.yml` with `--train`, and `auto-merge.yml` ([auto-merge for update pull requests](docs/AUTO_MERGE.md)).
  The Release and train jobs carry a fork guard, `if: github.repository == 'owner/repo'`, so a fork that pushes a tag or runs the train publishes nothing; apply names the repo from `.release.json` `repository`, else the `upstream` or `origin` remote (`--repository owner/repo` sets it), and keeps the guard on every rerun.
- `.githooks/commit-msg` and `.githooks/pre-push` (or `.husky/commit-msg` and `.husky/pre-push` in a husky repo), switched on by the `prepare` script.
  The pre-push hook is the [pre-push guard](docs/PRIVATE_REPOS.md#the-pre-push-guard).
  A repo whose hooks are run by something else (lefthook, pre-commit, simple-git-hooks, its own `core.hooksPath` or `.git/hooks`), or that has a pre-push hook of its own, keeps them: apply prints the lines to add instead.
- `.release.json`: other files that carry the version (`versionFiles`; it detects `manifest.json`, and for a Tauri app `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, plus `app/package.json` and its lock when the app lives in `app/`, and for a Python project `pyproject.toml` and `uv.lock`), the workflow mode (`workflows`: `package`, `reusable` or `vendored`) and the train's schedule (`train`).
  A `versionFiles` entry is a path whose kind comes from its name: a JSON file's top-level `version`, `package-lock.json`, `Cargo.toml` (its `[package]` version) and `Cargo.lock`, `pyproject.toml` (its `[project]` version only, never `[tool.*]` tables) and `uv.lock` (the project's own entry: the one with source editable or virtual `"."`, found by the project's name, or the only such entry when the lock still has an old name).
  Any other file takes `{ "path": "src/app/__init__.py", "pattern": "__version__ = \"(.*)\"" }`: a regular expression with exactly one capture group, the version, which must match the file exactly once (`^` and `$` match at each line); only the captured text changes.
  A release and the tag check stop, before changing anything, on a malformed entry, a pattern that matches nowhere or more than once, or a listed `pyproject.toml` whose `uv.lock` beside it isn't listed; apply warns about each.
  Optional keys: `stable` (`true` lets a `0.y.z` repo reach 1.0.0, so a breaking change bumps major again; see [Versions before 1.0](#versions-before-10)), `node` (the Node version for the workflows, else `.nvmrc` or `.node-version`, else 22), `timeZone` for changelog dates (for example `"America/Los_Angeles"`), `branches` (the branches `npm run release` cuts releases from, default `["main", "master"]`; the Commit messages workflow checks pushes to them too), `notes` (see below), `lanes` (`docs` and `fullFor`, see [CI lanes](#ci-lanes)), `repository` (`owner/repo`, the one repo whose Release and train jobs run; apply fills it in), `protect` (`{ "checks": [...] }`, the required checks for `release-kit protect`), `visibility` (`"public"` or `"private"`; apply fills it in from gh) and the settings whose defaults depend on it: `security` (`{ "onPullRequest": false }` scans lock-file pull requests or not), `attest` (artifact attestations, once built) and `autoMerge` (`false` stops apply writing `auto-merge.yml`); see [docs/PRIVATE_REPOS.md](docs/PRIVATE_REPOS.md#settings-for-private-repos).
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
| `--repository <owner/repo>` | The upstream repo, the only one whose Release and train jobs run (default: `.release.json` `repository`, else the `upstream` or `origin` remote). |
| `--visibility <public\|private>` | Whether the repo is public or private, when gh can't tell (default: what `gh repo view` says, else `.release.json` `visibility`). A private repo gets the private defaults. |
| `--force` | Replace a workflow with the same name that the kit didn't write. |
| `--json` | Print the report as JSON: the files added, changed and removed, what was done, and the notes (the rollout bot reads it). |
| `--check` | A dry run that writes nothing: print each file apply would add, change or remove, and exit 1 when any differs, 0 when the repo is current. Files apply leaves alone (a workflow, `dependabot.yml` or hooks of the repo's own) don't count. |

The choices are saved in `.release.json`, so re-running apply to upgrade keeps them.

### Package, reusable and vendored modes

In package mode nothing of the kit is copied into the repo: `npm run release` runs `release-kit release`, and the commit-msg hook runs `release-kit commit-msg` from `node_modules` (before `npm install` it lets commits through with a note; CI checks every commit anyway).
The `release-kit` command also runs `notes`, `train`, `protect`, `check`, `verify`, `lanes`, `pre-push` (the guard), `install-guard` (the guard in a repo without the kit), `alarm` (the Direct push alarm's check) and `apply`.

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

## Versions before 1.0

Most projects sit at `0.y.z` for a long time, and SemVer lets anything change there.
So below 1.0 the kit bumps like this, and never reaches 1.0.0 on its own:

| Commits since the last release | `0.13.2` goes to | `1.4.2` goes to |
|---|---|---|
| A breaking change (`feat!:`, `BREAKING CHANGE:`) | `0.14.0` | `2.0.0` |
| A feature | `0.14.0` | `1.5.0` |
| Anything else | `0.13.3` | `1.4.3` |

- `npm run release -- --stable` cuts 1.0.0: the deliberate step to "ready for people who aren't the author".
- An explicit `major`, or an exact `1.x` version, from `0.y.z` is refused without `--stable`, and so is the release train's "Run workflow" with `major`.
- `.release.json` `"stable": true` turns plain SemVer on for a `0.y.z` repo: a breaking change then bumps major, and the train may cut 1.0.0.


With `--train`, a scheduled workflow cuts releases so nobody has to remember:

1. It finds the commits on `main` since the last `vX.Y.Z` tag.
   With no feature, fix, security or performance change, `revert:` commit or breaking change among them, it stops: nothing to release.
2. It runs `npm run release:check` on that exact commit.
3. As `github-actions[bot]` it makes the release commit and tag, exactly like `npm run release -- <version>`.
4. With `train.checks` in `.release.json` (`--train-checks ci.yml,commits.yml`), it pushes that commit to a temporary `release-train/vX.Y.Z` branch, starts each listed workflow there and waits for it to pass.
5. It pushes `main` and the tag in one atomic push, then makes sure the Release workflow runs on the tag.

GitHub starts no workflow for a tag or commit pushed with a workflow's own `GITHUB_TOKEN`, so the train starts the checks and the Release workflow itself with `workflow_dispatch`; each workflow in `train.checks` needs `workflow_dispatch:` in its `on:`.
The same rule means the train can't loop.

GitHub doesn't count checks from `workflow_dispatch` runs toward branch protection, so on a protected `main` the push needs a deploy key the branch's rules let through.
In a repo with a train, `npx release-kit protect` (see [Protecting the release flow](#protecting-the-release-flow)) makes that key once, stores it as the `RELEASE_TRAIN_KEY` secret, and lets deploy keys bypass the branch rules.
Note that a ruleset's deploy-key bypass applies to every write deploy key on the repo, not only the train's.

"Run workflow" on the train takes a bump (`auto`, `patch`, `minor`, `major`) and a dry-run switch.
It needs a release tag to start from, so baseline a new repo first.

## Protecting the release flow

`npx release-kit protect` (`node scripts/release-kit/protect.mjs` in a vendored repo) sets up two GitHub rulesets that match how the kit releases, using the gh CLI's sign-in; `--dry-run` prints the plan first.

| Ruleset | On | Rules |
|---|---|---|
| `release-kit: branches` | The default branch, and the other branches in `.release.json` `branches` | No deletion, no force push, changes only through a pull request (0 approvals), the repo's CI checks must pass |
| `release-kit: release tags` | `refs/tags/v*` | No deletion, no update: a release tag is created once and never moved |

- **Required checks** are `--checks "CI result,check / check"`, or `.release.json` `protect.checks`, or the ones the ruleset already requires, or else the GitHub Actions checks that passed on the latest merged pull request (only `CI result` from a workflow that has one, and none from a workflow with a `paths` filter, which doesn't run on every pull request).
- **Nobody bypasses the branch rules by default, admins included**, so an agent using the owner's sign-in can't push to `main` either.
- **`npm run release -- --push` still works:** when the push of the release commit is rejected, it opens a `release/vX.Y.Z` pull request, merges it once the checks that gate the merge pass (the required ones, or every GitHub Actions check when none are required; a failing Vercel deploy or another app's status is reported and ignored), and tags the merged commit; if a gating check fails it closes the pull request and tags nothing.
- **The release train** pushes with its deploy key, the one bypass (only in a repo with a train).
- **The trade-off:** a release takes as long as the pull request's checks, instead of one push.
  `--admin-bypass` lets admins push straight to the branch instead, at the cost of letting anything signed in as an admin do the same.
- **Drift:** `npm run release:check` (through `release-kit check`) warns when the rulesets no longer match, whenever gh can read them.
- **A private repo on GitHub Free** can't have rulesets, so there `protect` sets up the free safeguards instead: the pre-push guard, the Direct push alarm and merge when green, and it says plainly what GitHub still lets through.
  [docs/PRIVATE_REPOS.md](docs/PRIVATE_REPOS.md) has the details.

[RELEASING.md](RELEASING.md#protecting-the-branch-and-the-tags) has the details.

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
apply writes the workflow, and `release-kit protect` allows auto-merge on the repo when it requires checks.
[docs/AUTO_MERGE.md](docs/AUTO_MERGE.md) has the policy and the setup, and [docs/examples/auto-merge.yml](docs/examples/auto-merge.yml) is the workflow for a repo without the kit.

## Security scan

`security.yml` scans every lock file in the repo (npm, pnpm, yarn, bun, Cargo, uv, poetry, pip, Go) against OSV.dev every Monday and on any pull request that changes a lock file (in a private repo, weekly only unless `.release.json` says `"security": { "onPullRequest": true }`).
OSV also lists malicious packages, which Dependabot alerts don't cover, so the two complement each other.

- **It fails** on a malicious package (an OSV `MAL-` entry) or a high or critical vulnerability (CVSS 7.0 or more, or rated HIGH or CRITICAL by its advisory).
- **It warns** on everything else, as annotations on the run.
- **To accept a finding on purpose**, add an `[[IgnoredVulns]]` entry (`id`, `ignoreUntil`, `reason`) to `osv-scanner.toml` next to the lock file.
- OSV-Scanner is a pinned release, checked against its published SHA-256 before it runs.
- Don't make "Security scan" a required status check: it only runs on pull requests that change a lock file, and GitHub leaves a required check from a skipped workflow waiting forever.

## zizmor

[zizmor](https://docs.zizmor.sh/) flags the kit's callers for pinning a version tag (`unpinned-uses`) and `auto-merge.yml` for its `workflow_run` trigger (`dangerous-triggers`).
Both are expected: [docs/ZIZMOR.md](docs/ZIZMOR.md) has a config to copy that allows tag pins for n8watkins/release-kit only, and explains why the `workflow_run` use is safe.
apply doesn't write it, since zizmor reads one config file and a repo's own would have to be rewritten.

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
When a release changes what apply writes (a new workflow, a workflow input, the hook), the rollout bot opens the update in each enabled adopter once the owner approves the run; re-run `npx release-kit apply .` by hand in any other repo.

## License

MIT.
