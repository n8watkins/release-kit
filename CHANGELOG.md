# Changelog

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

