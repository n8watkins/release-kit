# release-kit

[![CI](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/n8watkins/release-kit/actions/workflows/ci.yml)

The n8 release standard as a kit: Conventional Commits, SemVer tags, and GitHub Releases published by a workflow, with notes written from the commits.
No dependencies: plain Node scripts and two GitHub Actions workflows, copied into each repo.

The rules and the reasoning are in [STANDARD.md](STANDARD.md).

## Adopt it in a repo (about five minutes)

```bash
cd path/to/your-repo
npx --allow-git=root github:n8watkins/release-kit .   # npm 12 needs --allow-git; or: node path/to/release-kit/apply.mjs .
git diff                                   # review what it added
git add -A && git commit -m "chore: adopt release-kit 1.0.0"
npm run release -- --baseline              # tag the version it's already at
git push && git push origin vX.Y.Z         # the tag is verified, not published
```

From then on:

```bash
npm run release -- --dry-run               # preview the next version and notes
npm run release -- --push                  # release it
```

What `apply.mjs` adds or changes:

- `scripts/release-kit/`: the release, notes and commit-check scripts.
- `.github/workflows/release.yml` and `commits.yml`.
- `.githooks/commit-msg` (or `.husky/commit-msg` in a husky repo), switched on by the `prepare` script.
- `.release.json`: other files that carry the version (it detects `manifest.json` and `tauri.conf.json`).
- `package.json` scripts: `release`, `release:check` (composed from lint, typecheck, test and build), `prepare`.
- `RELEASING.md`, and a short section in `AGENTS.md` / `CLAUDE.md` so agents follow the rules.

If the repo ships files, add a `release:artifacts` script that writes them into `release-artifacts/` (for a WXT extension: `wxt zip && cp .output/*.zip release-artifacts/`).

## Backfilling past milestones

Tag a past commit with the version its `package.json` had, and publish it as a release:

```bash
npm run release -- --baseline <commit> --publish
git push origin vX.Y.Z
```

## This repo follows it too

The kit uses its own standard: commits are checked by the same hook and workflow, and releases are cut with `npm run release`.
`scripts/release-kit` and `.githooks` are links into `template/`, and a test fails if `.github/workflows/` drifts from the template.

## Developing the kit

```bash
npm test        # unit tests and an end-to-end run against a throwaway repo
```

Release kit changes with `npm run release` like any other repo, then re-run `apply.mjs` on each repo to upgrade it (each repo's `scripts/release-kit/VERSION` shows which kit version it runs).

## License

MIT.
