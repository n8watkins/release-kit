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
- `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`: everything else; these stay out of the release notes.
- Add `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` line in the body for a breaking change.
- The scope is optional: `fix(popup): ...`.
- Write the subject as a change, lowercase, no trailing period: `feat: add dark mode`, not `Added dark mode.`.

The `commit-msg` hook checks this locally, and the Commit messages workflow checks every pushed commit.

## Cutting a release

```bash
npm run release -- --dry-run   # preview the version and the notes
npm run release -- --push      # bump, changelog, commit, tag, push
```

- With no bump given it picks one: major for a breaking change, minor for a feature, otherwise patch.
- Force one with `npm run release -- minor` (or `patch`, `major`, or an exact `1.4.0`).
- It bumps `package.json`, `package-lock.json` and any file listed in `.release.json` `versionFiles`, adds a section to `CHANGELOG.md`, commits `chore(release): vX.Y.Z` and tags it.
- Edit the new `CHANGELOG.md` section before pushing if a line needs rewording (`git commit --amend`, then move the tag with `git tag -f -a vX.Y.Z`).

Pushing the tag runs `.github/workflows/release.yml`:

1. The tag must match every version file.
2. `npm run release:check` (lint, types, tests, build) must pass.
3. `npm run release:artifacts`, if defined, writes shippable files into `release-artifacts/`; they get SHA-256 checksums.
4. The GitHub Release is created with the generated notes and the files, and the uploaded files are re-downloaded and checked.

## Baselines and backfills

- `npm run release -- --baseline` tags the version this repo is already at, without a GitHub Release, so the first real release lists only new work.
- `npm run release -- --baseline <commit> --publish` tags a past milestone with the version its `package.json` had, and publishes it.

## When to release

- Release when something worth telling a user about has landed: a feature, a fix they would notice, or a batch of either.
- Before 1.0, minor versions carry features and patch versions carry fixes.
- Version 1.0.0 means "ready for people who aren't me".
