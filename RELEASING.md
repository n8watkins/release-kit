# Releasing

This repo follows the n8 release standard (release-kit).
Commits use Conventional Commits, versions follow SemVer, and a pushed `vX.Y.Z` tag publishes a GitHub Release.

## Commit messages

```
type(scope): subject
```

- `feat`: something a user can see or do that they couldn't before.
- `fix`: a bug fix a user would notice.
- `perf`: faster or lighter, same behavior.
- `security`: hardening a user would want to know about (a checksum, a tighter policy).
- `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`: everything else; these stay out of the release notes.
- Add `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` line in the body for a breaking change.
- The scope is optional: `fix(popup): ...`.
- Write the subject as a change, lowercase, no trailing period: `feat: add dark mode`, not `Added dark mode.`.

The `commit-msg` hook checks this locally, and the Commit messages workflow checks every pushed commit.

## Cutting a release

```bash
npm run release -- --dry-run   # preview the version and the notes
npm run release -- --push      # check, bump, changelog, commit, tag, push
```

- With no bump given it picks one: major for a breaking change, minor for a feature, otherwise patch.
- Force one with `npm run release -- minor` (or `patch`, `major`, or an exact `1.4.0`).
- It bumps `package.json`, `package-lock.json` and any file listed in `.release.json` `versionFiles`, adds a section to `CHANGELOG.md`, commits `chore(release): vX.Y.Z` and tags it.
- With `--push` it first makes sure `main` isn't behind `origin/main` and runs `npm run release:check` (skip that with `--no-check`), so a tag is only pushed for a commit that passes. If the push is rejected, the release commit and tag are undone.
- The changelog date is today in `.release.json` `timeZone` (for example `"America/Los_Angeles"`), or in the machine's time zone; set it when the release train cuts releases, because CI runs in UTC.
- Edit the new `CHANGELOG.md` section before pushing if a line needs rewording (`git commit --amend`, then move the tag with `git tag -f -a vX.Y.Z`).
  Never move a tag after it is pushed: the next release would start from the wrong place, and the kit stops when it finds one moved.

Pushing the tag runs `.github/workflows/release.yml`:

1. The tag must be a plain `vX.Y.Z` and match every version file.
2. The repo's checks, `npm run release:check`, must pass.
3. `npm run release:artifacts`, if defined, writes shippable files into `release-artifacts/`; they get SHA-256 checksums.
4. The GitHub Release is created with the generated notes and the files, and the uploaded files are re-downloaded and checked.

If a Release run fails after the tag is pushed (a flaky check, an outage), fix the cause and run the Release workflow again on the tag: Actions, Release, "Run workflow", and pick the tag under "Use workflow from".
Don't delete and re-push the tag.

## The release train

If this repo has `.github/workflows/release-train.yml` (added by `apply.mjs --train`), releases also happen on a schedule.
Its schedule is in `.release.json` (`train.schedule`, a cron line in UTC).

- On each run it looks at the commits on `main` since the last tag.
- When at least one is user-facing (`feat`, `fix`, `perf`, `security`, a revert or a breaking change), it runs `npm run release:check` on that commit, then makes the release commit and tag with the bump the commits call for, exactly like `npm run release`.
- If `.release.json` lists `train.checks` (workflow files, such as the ones whose checks branch protection requires on `main`), it pushes the release commit to a temporary `release-train/vX.Y.Z` branch, runs each of them there and waits for them to pass, then deletes the branch. Each of those workflows needs `workflow_dispatch:` in its `on:`.
- Then it pushes `main` and the tag in one atomic push and starts the Release workflow on the tag.
- When there are only docs, chores, tests or refactors, it releases nothing.
- "Run workflow" on the Release train runs it now; pick a bump to force one (it then releases any commits, user-facing or not), or tick "dry run" to see the plan and the notes without cutting anything.
- The release commit and tag are pushed by `github-actions[bot]` with the workflow's own token, which starts no other workflow by itself; that is why the train starts `train.checks` and the Release workflow explicitly, and why it can't trigger itself.
- No secret is needed: a commit whose required checks have passed may be pushed to a protected `main` with that token (as long as protection doesn't also require a pull request).
- If `main` moves while it runs, or a check fails, nothing is released and the release commit is thrown away; run it again, or let the next scheduled run pick it up.
- It stops instead of guessing when there is no release tag yet (run `npm run release -- --baseline` first), when the last tag isn't on `main`, or when `package.json` doesn't match the last tag.

Preview what it would do with `npm run release -- --plan`.
Releasing by hand still works at any time; the train just finds less to do.

## Baselines and backfills

- `npm run release -- --baseline` tags the version this repo is already at, without a GitHub Release, so the first real release lists only new work.
- `npm run release -- --baseline <commit> --publish` tags a past milestone with the version its `package.json` had, and publishes it.

## When to release

- Release when something worth telling a user about has landed: a feature, a fix they would notice, or a batch of either.
- With the release train on, that happens on its schedule without anyone remembering to; release by hand when something shouldn't wait.
- Before 1.0, minor versions carry features and patch versions carry fixes.
- Version 1.0.0 means "ready for people who aren't me".
