# The n8 release standard

How every n8builds project names commits, numbers versions and publishes releases.
`apply.mjs` sets it up in a repo; `template/RELEASING.md` is the per-repo version of these rules.

## Why

- **One standard, many repos.** Seven build repos had four commit styles and one had releases. Readers (and the n8builds.dev build log) couldn't tell a shipped feature from a README edit.
- **Releases are the story.** A GitHub Release with notes is the clearest public record of progress: it feeds the build log, shows up on the repo page, and gives a visitor a reason to trust the project is alive.
- **Agents write most commits.** A rule only holds if a hook and CI enforce it, and if the agent instructions say it.

## Where it comes from

Scribe's release pipeline (`n8watkins/scribe`, `.github/workflows/release.yml`) was the reference.
What it does well, and the standard keeps:

1. A `v*` tag push is the only trigger, so a release is always a deliberate act.
2. Before anything ships, the tag must equal the version in every version file (Scribe checks package.json, tauri.conf.json and Cargo.toml).
3. The full checks (audit, lint, tests, build) run again on the tagged commit.
4. Shipped files get SHA-256 checksums, and after upload the release is downloaded and checked against them.
5. Least privilege: the workflow reads by default, and only the final publish job can write.
6. Third-party actions are pinned to commit SHAs, not moving tags.
7. A concurrency group stops two runs for the same tag racing.

What the standard changes:

- **Notes come from commits, not a hand-kept file.** Scribe's `CHANGELOG.md` stops at 0.6.0 while its releases reached 0.8.0, and its generated notes depend on pull requests. The other repos commit straight to main, so the kit generates notes from Conventional Commits and writes the same section to `CHANGELOG.md` at release time. The changelog can't drift.
- **Generic, not per-app.** Scribe's build steps (Rust, Vulkan, MSI installers, smoke installs) are Scribe's. The standard keeps the shape and moves the app-specific part behind two npm scripts: `release:check` and the optional `release:artifacts`. Scribe keeps its own workflow; it already meets the standard.
- **Enforced at commit time.** A `commit-msg` hook and a CI check, so the history is clean before release time, not cleaned up at it.
- **Baselines for adoption.** Repos with years of untagged history start from a baseline tag, so the first release lists only new work.

## The rules

### Commits

- Conventional Commits: `type(scope): subject`, header at most 100 characters.
- Types: `feat`, `fix`, `perf` (these reach the release notes), and `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- `feat` and `fix` only for changes a user would notice. They are the public record.
- Breaking changes: `!` after the type, or a `BREAKING CHANGE:` footer.
- Merge, revert, fixup and bot commits pass the check; bot commits never reach the notes.

### Versions

- SemVer, `vX.Y.Z` tags, the version in `package.json` (plus any `.release.json` `versionFiles`).
- Before 1.0, minor carries features and patch carries fixes.
- 1.0.0 means ready for people who aren't the author.
- The bump comes from the commits unless forced: breaking means major, a feature means minor, otherwise patch.

### Releases

- `npm run release -- --push` from a clean main: bump, changelog section, `chore(release): vX.Y.Z` commit, annotated tag, push.
- The tag runs the Release workflow: version check, `npm run release:check`, optional artifacts with checksums, GitHub Release with the generated notes, download-and-verify.
- Release when something worth telling a user about has landed; there is no schedule.

### What each repo provides

| Script | Required | What it does |
|---|---|---|
| `release:check` | yes | Lint, types, tests, build. `apply.mjs` composes it from the scripts the repo has. |
| `release:artifacts` | no | Writes shippable files (an extension zip, an installer) into `release-artifacts/`. |

## Adopting it in a repo

See README.md.
In short: `node apply.mjs <repo>`, commit, `npm run release -- --baseline`, push the tag.

## Changing the standard

Edit this kit, bump `VERSION`, run its tests (`npm test`), and re-run `apply.mjs` on each repo.
Kit-owned files are replaced; each repo's `scripts/release-kit/VERSION` shows which kit version it runs.
