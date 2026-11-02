# Changelog

## 2.2.0 - 2026-11-02

### New

- A failed Release run can be re-run safely, and every job has a timeout ([#14](https://github.com/n8watkins/release-kit/pull/14))
- Pull request titles are checked, since a squash merge commits the title to main ([#15](https://github.com/n8watkins/release-kit/pull/15))
- CI lanes, so a docs or kit-only pull request skips the full suite, and release-kit verify ([#18](https://github.com/n8watkins/release-kit/pull/18))
- Auto-merge kit and Dependabot updates, never majors, with a merge-when-green fallback ([#19](https://github.com/n8watkins/release-kit/pull/19))

### Fixed

- The security gate fails the build when run through the scripts link ([#12](https://github.com/n8watkins/release-kit/pull/12))
- Npm 12 installs the kit, because apply allows it as a git dependency in .npmrc ([#13](https://github.com/n8watkins/release-kit/pull/13))
- Commit messages are checked on the branches releases are cut from ([#16](https://github.com/n8watkins/release-kit/pull/16))

## 2.1.0 - 2026-11-02

### New

- A weekly OSV security scan that blocks malicious and high-severity packages ([#9](https://github.com/n8watkins/release-kit/pull/9))
- Release from a long-lived branch other than main, listed in .release.json branches ([#10](https://github.com/n8watkins/release-kit/pull/10))

## 2.0.1 - 2026-10-27

### Fixed

- Re-applying keeps the kit's hook, and Dependabot must watch the repo root ([#7](https://github.com/n8watkins/release-kit/pull/7))

## 2.0.0 - 2026-10-27

Every repo now installs the kit as a dev dependency, so a new kit release arrives as a Dependabot update PR. Release notes read like patch notes by default: New, Fixed, Faster, Safer.

### New

- Version files beyond JSON (Cargo.toml, Cargo.lock, package-lock.json) ([#4](https://github.com/n8watkins/release-kit/pull/4))
- Patch-note release notes, and extension manifests found by apply ([#5](https://github.com/n8watkins/release-kit/pull/5))
- Install the kit as a dev dependency, kept current by Dependabot, with plain notes ([#6](https://github.com/n8watkins/release-kit/pull/6))

### Fixed

- Say "1 commit", not "1 commits" ([#3](https://github.com/n8watkins/release-kit/pull/3))

## 1.2.0 - 2026-10-25

### Features

- **train:** Push a protected main with a deploy key; protect.mjs sets it up (#2)

## 1.1.0 - 2026-10-25

### Features

- Opt-in release train and reusable workflows
- **train:** Run the required checks on the release commit before moving a protected main

### Fixes

- **release:** Safe tags and pushes, long histories, CRLF and blank-line messages
- **train:** Plan reasons read cleanly next to the tag they count from

## 1.0.3 - 2026-10-25

### Fixes

- **apply:** Husky repos get no .githooks folder; README covers npm 12's --allow-git

## 1.0.2 - 2026-10-25

### Fixes

- **release:** Push the branch and the tag in one atomic push

## 1.0.1 - 2026-10-25

### Fixes

- **notes:** Print notes when the scripts folder is a symlink

