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
- **An optional release train.** A repo that deploys every merge still needs someone to remember to release. The train releases on a schedule, but only when there is something to tell a user about.

## The rules

### Commits

- Conventional Commits: `type(scope): subject`, header at most 100 characters.
- Types: `feat`, `fix`, `perf`, `security` (these reach the release notes), and `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- `feat` and `fix` only for changes a user would notice. They are the public record.
- Subjects that reach the notes are written as patch notes, for users, not developers. A `Release-note:` body line rewords one for the notes, and `Release-note: skip` keeps one out.
- Breaking changes: `!` after the type, or a `BREAKING CHANGE:` footer.
- Merge, revert, fixup and bot commits pass the check; bot commits never reach the notes.
- `security` isn't in the Conventional Commits spec, but these repos already used it for hardening a user should hear about, so it has its own notes section and a patch bump.

### Versions

- SemVer, `vX.Y.Z` tags, the version in `package.json` (plus any `.release.json` `versionFiles`: JSON files such as an extension `manifest.json` or `tauri.conf.json`, `package-lock.json`, a `Cargo.toml` and its `Cargo.lock`). `apply.mjs` finds them on the first run and warns when one disagrees with `package.json`.
- Before 1.0, minor carries features and patch carries fixes.
- 1.0.0 means ready for people who aren't the author.
- The bump comes from the commits unless forced: breaking means major, a feature means minor, otherwise patch.

### Releases

- `npm run release -- --push` from a clean main that isn't behind origin: `release:check`, bump, changelog section, `chore(release): vX.Y.Z` commit, annotated tag, one atomic push of the branch and the tag. A rejected push undoes the commit and the tag.
- Changelog dates are in the repo's `.release.json` `timeZone` (the machine's zone if unset).
- The tag runs the Release workflow: version check, `npm run release:check`, optional artifacts with checksums, GitHub Release with the notes the release wrote into the tag (the same section as `CHANGELOG.md`), download-and-verify.
- `--summary "<text>"` opens a release with a line in the releaser's words, and `.release.json` `notes` sets how the notes read (the default reads New, Fixed, Faster, Safer with no scopes; `"style": "classic"` keeps commit-type headings and scopes).
- A failed Release run is retried by running the Release workflow on the tag; a pushed tag is never moved or re-pushed.
- Release when something worth telling a user about has landed.
- The previous release is the highest `vX.Y.Z` tag on the branch's history. Other tags (`v2.0.0-beta`, `vnext`) are ignored, and a version tag that isn't on the branch (moved, or made elsewhere) stops the release.

### The release train (opt-in)

Repos that ship continuously (a website deploying every merge) turn it on with `apply.mjs --train`.

- It runs on a schedule (default Mondays 16:00 UTC, set per repo in `.release.json`) and from "Run workflow".
- It releases only when a `feat`, `fix`, `perf`, `security`, revert or breaking change has landed since the last tag, with the bump those commits call for. A quiet week releases nothing.
- From "Run workflow" a bump can be forced, and a dry run shows the plan and the notes.
- It runs `release:check` on the exact commit before tagging it, so a red main is never released.
- It never guesses: no release tag yet, a moved tag or a `package.json` that doesn't match the last tag stops it.
- GitHub doesn't start workflows from pushes made with a workflow's own token. So the train, as `github-actions[bot]`, pushes its release commit to a temporary branch, starts the workflows listed in `.release.json` `train.checks` there with `workflow_dispatch` (the one trigger that token may use) and waits for them, then pushes `main` and the tag together and makes sure the Release workflow runs on the tag. The full CI runs on exactly what is released.
- Branch protection doesn't count those `workflow_dispatch` checks, so a protected `main` gets a ruleset that one deploy key may bypass, and the train pushes with that key (`RELEASE_TRAIN_KEY`, set up by `npx release-kit protect`). The train still pushes only after `train.checks` pass.
- The train runs only on a schedule or by hand, so nothing it pushes starts it again. The commit check skips bot commits anyway.
- If main moves while it runs, or a check fails, nothing is released.

### Workflows

- Third-party actions pinned to commit SHAs; every workflow reads by default, and only the jobs that publish, push or start a workflow get `contents: write` or `actions: write`.
- Tag names, branch names and commit messages reach a shell only through environment variables, and a tag only after it is checked to be a plain `vX.Y.Z`.
- Two ways to carry them, chosen per repo and kept on upgrade (`.release.json` `workflows`):
  - **Vendored** (the default): the full workflows are copied into the repo. Nothing outside the repo runs.
  - **Reusable** (`apply.mjs --reusable`): the repo's workflows are short callers of `n8watkins/release-kit/.github/workflows/<file>.yml@vX.Y.Z`. The steps and the scripts they run come from the kit at that exact ref, so an upgrade is a one-line change per workflow (or a Dependabot PR). Pin a commit SHA instead of a tag with `--kit-ref <sha>`.
- The workflows use the Node version in `.release.json` `node`, else `.nvmrc` or `.node-version`, else 22.

### What each repo provides

| Script | Required | What it does |
|---|---|---|
| `release:check` | yes | The repo's checks: whichever of lint, types, tests and build it has (`apply.mjs` composes it from them), or anything the repo prefers. |
| `release:artifacts` | no | Writes shippable files (an extension zip, an installer) into `release-artifacts/`. |

## Adopting it in a repo

See README.md.
In short: `node apply.mjs <repo>` (add `--train` for scheduled releases), `npm install`, commit, `npm run release -- --baseline`, push the tag.
Every repo installs the kit as a dev dependency pinned to a release tag (package mode), and its workflows call the kit's at the same tag.

## Changing the standard

Edit this kit, run its tests (`npm test`) and release it with `npm run release`.
Dependabot then opens update PRs in every repo (the dev dependency and the workflow pins), and each repo's CI tests the new kit before it is merged.
`npm run release:check` warns in any repo still behind the newest kit.
When a release changes what `apply.mjs` writes, re-run `npx release-kit apply .` in each repo once the update lands.
The kit's own `.github/workflows/` are the shipped workflows (the train without a schedule), because reusable-mode repos call them there; a test fails if they drift.
