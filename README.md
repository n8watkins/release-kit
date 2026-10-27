# release-kit

[![CI](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml)

The n8 release standard as a kit: Conventional Commits, SemVer tags, and GitHub Releases published by a workflow, with notes written from the commits.
No dependencies: plain Node scripts and GitHub Actions workflows, copied into each repo or called from this one.
An optional release train cuts releases on a schedule, only when there is user-facing work to ship.

The rules and the reasoning are in [STANDARD.md](STANDARD.md).

## Adopt it in a repo (about five minutes)

```bash
cd path/to/your-repo
npx --allow-git=root github:n8watkins/release-kit .   # npm 12 needs --allow-git; or: node path/to/release-kit/apply.mjs .
git diff                                   # review what it added
git add -A && git commit -m "chore: adopt release-kit"
npm run release -- --baseline              # tag the version it's already at
git push && git push origin vX.Y.Z         # the tag is verified, not published
```

From then on:

```bash
npm run release -- --dry-run               # preview the next version and notes
npm run release -- --push                  # release it
npm run release -- --plan                  # what the release train would do now
```

### Options

| Option | What it does |
|---|---|
| `--train` | Adds the release train (`.github/workflows/release-train.yml`): every week it releases whatever user-facing work landed, and "Run workflow" releases now. |
| `--schedule "<cron>"` | When the train runs, in UTC (default `"0 16 * * 1"`, Mondays 16:00). Implies `--train`. |
| `--train-checks <a.yml,b.yml>` | Workflows the train runs on its release commit before moving `main` to it: the ones whose checks branch protection requires. |
| `--no-train` | Removes the train. |
| `--reusable` | The workflows call `n8watkins/release-kit/.github/workflows/<file>.yml@vX.Y.Z` instead of carrying the steps. |
| `--kit-ref <ref>` | With `--reusable`, pin a commit SHA (or another tag) instead of this kit's version tag. |
| `--vendored` | Back to full copies of the workflows (the default). |
| `--force` | Replace a workflow with the same name that the kit didn't write. |

The choices are saved in `.release.json`, so re-running `apply.mjs` to upgrade keeps them.

### Vendored or reusable workflows

Vendored (the default) copies the full workflows into the repo: everything that runs is in the repo, and an upgrade is a re-run of `apply.mjs`.
Reusable writes short callers instead, for example:

```yaml
jobs:
  release:
    permissions:
      contents: write
    uses: n8watkins/release-kit/.github/workflows/release.yml@v1.1.0
```

The called workflow fetches the kit's scripts at the same ref, so the pin decides everything that runs in CI, and upgrading CI is a one-line change per workflow (Dependabot's `github-actions` updates do it).
The scripts are still copied into `scripts/release-kit/` for the local hook and `npm run release`; re-run `apply.mjs` to upgrade those.
The repo's own workflows call the kit's, so they need only `contents: read` by default; the release and train callers grant `contents: write` (and `actions: write` for the train) to that one job.

### The release train

With `--train`, a scheduled workflow cuts releases so nobody has to remember:

1. It finds the commits on `main` since the last `vX.Y.Z` tag. With no feature, fix, security or performance change, revert or breaking change among them, it stops: nothing to release.
2. It runs `npm run release:check` on that exact commit.
3. As `github-actions[bot]` it makes the release commit and tag, exactly like `npm run release -- <version>`: version bump, `CHANGELOG.md`, `chore(release): vX.Y.Z`, tag.
4. With `train.checks` in `.release.json` (`--train-checks ci.yml,commits.yml`), it pushes that commit to a temporary `release-train/vX.Y.Z` branch, starts each listed workflow there and waits for it to pass.
5. It pushes `main` and the tag in one atomic push, then makes sure the Release workflow runs on the tag, which publishes the GitHub Release as usual.

Why steps 4 and 5 start workflows explicitly: GitHub starts no workflow for a tag or commit pushed with a workflow's own `GITHUB_TOKEN`, so the pushes alone would check and publish nothing.
`workflow_dispatch` is the exception, and the train uses it; each workflow in `train.checks` needs `workflow_dispatch:` in its `on:`.
The same rule means the train can't loop; the commit check also skips bot commits.

On a `main` protected by required status checks, list the workflows that produce those checks in `train.checks`, so the release commit passes them before `main` moves to it.
GitHub doesn't count checks from `workflow_dispatch` runs toward protection, though, so the push itself needs a deploy key the protection lets through.
`node scripts/release-kit/protect.mjs` sets that up once: a ruleset with the required checks that the key (and admins) may bypass, the deploy key, and the `RELEASE_TRAIN_KEY` secret the train's checkout pushes with (see RELEASING.md).
A tag pushed with the key starts the Release workflow by itself; without the key, the train starts it.

"Run workflow" on the train takes a bump (`auto`, `patch`, `minor`, `major`) and a dry-run switch.
It needs a release tag to start from, so baseline a new repo first.

What `apply.mjs` adds or changes:

- `scripts/release-kit/`: the release, notes and commit-check scripts.
- `.github/workflows/release.yml` and `commits.yml`, plus `release-train.yml` with `--train`.
- `.githooks/commit-msg` (or `.husky/commit-msg` in a husky repo), switched on by the `prepare` script. A repo whose hooks are run by something else (lefthook, pre-commit, simple-git-hooks, its own `core.hooksPath` or `.git/hooks`) keeps them: apply prints the line to add to its commit-msg hook instead.
- `.release.json`: other files that carry the version (it detects `manifest.json`, and for a Tauri app `tauri.conf.json`, `Cargo.toml` and `Cargo.lock`, plus `app/package.json` and its lock when the app lives in `app/`; Cargo files and npm locks are edited in place), the workflow mode and the train's schedule. Optional: `node`, the Node version for the workflows (else `.nvmrc` or `.node-version`, else 22), and `timeZone` for changelog dates (for example `"America/Los_Angeles"`).
- `package.json` scripts: `release` (an existing `release` script is left alone unless `--force`), `release:check` (composed from whichever of lint, typecheck, test and build the repo has), `prepare`.
- `RELEASING.md`, and a short section in `AGENTS.md` / `CLAUDE.md` so agents follow the rules.

The workflows install with `npm ci`, so a pnpm, yarn or bun repo needs a `package-lock.json` too (apply warns).

If the repo ships files, add a `release:artifacts` script that writes them into `release-artifacts/` (for a WXT extension: `wxt zip && cp .output/*.zip release-artifacts/`).

## When a Release run fails

Fix the cause, then run the Release workflow on the tag: Actions, Release, "Run workflow", and pick the tag under "Use workflow from".
Don't move or re-push a tag that is already on GitHub.

## Backfilling past milestones

Tag a past commit with the version its `package.json` had, and publish it as a release:

```bash
npm run release -- --baseline <commit> --publish
git push origin vX.Y.Z
```

## This repo follows it too

The kit uses its own standard: commits are checked by the same hook and workflow, and releases are cut with `npm run release`.
`scripts/release-kit` and `.githooks` are links into `template/`.
`.github/workflows/` holds the shipped workflows, because that is where reusable-mode repos call them; a test fails if they drift from the template.
The kit's copy of the train has no schedule: the kit is released by hand.

## Developing the kit

```bash
npm test        # unit tests, end-to-end runs against throwaway repos, workflow checks (actionlint too, if installed)
```

Release kit changes with `npm run release` like any other repo, then re-run `apply.mjs` on each repo to upgrade it (each repo's `scripts/release-kit/VERSION` shows which kit version it runs).

## License

MIT.
