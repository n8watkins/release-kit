# Roadmap

Designs for what comes next, with a difficulty for each item and the exact steps only the owner can take.
Nothing here is built yet, except items 7, 8 and 9, which stay here as a record of their design: item 7 shipped in v2.4.0, and items 8 and 9 are on main for the next release.
What is built is in the [README](../README.md); the reasoning behind the order is in the [November 2026 review](REVIEW_2026-11.md#6-roadmap).

Difficulty is for one developer working with an agent, including tests and docs: **S** is under a day, **M** one to three days, **L** a week or more.

| Item | Difficulty | Needs the owner |
|---|---|---|
| [1. Publish release-kit to npm with provenance](#1-publish-release-kit-to-npm-with-provenance) | M | Yes: npm account, 2FA, trusted publisher |
| [2. Signed releases: artifact attestations](#2-signed-releases-artifact-attestations) | S | No |
| [3. Pre-releases](#3-pre-releases) | M | No |
| [4. A reviewable release PR mode](#4-a-reviewable-release-pr-mode) | M | No |
| [5. pnpm, yarn and bun](#5-pnpm-yarn-and-bun) | M | No |
| [6. Monorepos](#6-monorepos) | L | No |
| [7. Per-repo settings: public and private repos](#7-per-repo-settings-public-and-private-repos) | Done in v2.4.0 | No |
| [8. The rollout bot](#8-the-rollout-bot) | Done, next release | Done: GitHub App, environment |
| [9. Stale-file detection without the App](#9-stale-file-detection-without-the-app) | Done, next release (v2.6.0) | No |
| [10. A rollout bot for outside users](#10-a-rollout-bot-for-outside-users) | M, for v3 | No; each adopter sets up their own App |
| [Owner steps for what is already built](#owner-steps-for-what-is-already-built) | - | Yes |

## 1. Publish release-kit to npm with provenance

**Why.** Adopters install the kit from a git tag today.
npm 12 refuses git dependencies unless `.npmrc` allows them, a tag can be moved by anyone with write access, and a git dependency carries no provenance.
A registry package removes all three: `npm ci` needs no `allow-git`, versions are immutable, and npm shows which workflow run built each version.

**Design.**

- The package name: `release-kit` and `@n8watkins/release-kit` are both free on the registry today.
  The unscoped name matches the repo, the `release-kit` command and every doc, so it is the recommendation; publish a first version soon to hold it.
- package.json drops `"private": true` and keeps the `files` list it already has, so only `apply.mjs`, `bin/`, `template/`, `reusable/` and the docs ship.
  The kit keeps zero runtime dependencies.
- A `publish` job in the kit's own release workflow, after the GitHub Release: `npm publish` with npm's trusted publishing (OIDC), so no npm token exists anywhere.
  The job gets `id-token: write` and runs in a `npm` environment that only `v*` tags may use.
  Trusted publishing creates the provenance attestation by itself; it needs npm 11.5.1 or newer and Node 22.14 or newer in the job.
- apply writes `"release-kit": "^X.Y.Z"` (or an exact `X.Y.Z`; exact keeps the pin and the workflows in step) instead of `github:n8watkins/release-kit#vX.Y.Z`, and stops writing `allow-git` for repos that move.
  It moves a repo from the git spec to the registry spec on the next apply, and Dependabot's npm ecosystem keeps working unchanged.
- The reusable workflows stay pinned by tag in the repo, as they are today; only the dev dependency moves to the registry.
- `release-kit verify` checks the lock's `integrity` field once the kit comes from the registry.

**Owner steps.**

1. Create or sign in to the npm account at <https://www.npmjs.com/signup>, and turn on two-factor authentication with a security key or an authenticator app (Account, Two-Factor Authentication, "Authorization and writes").
2. Reserve the name with a first manual publish from a clean checkout of a release tag:

   ```sh
   git checkout vX.Y.Z
   npm publish --access public   # asks for the 2FA code
   ```

   npm only lets you add a trusted publisher to a package that exists.
3. On npmjs.com, open the package, Settings, Trusted Publisher, "GitHub Actions", and enter: organization or user `n8watkins`, repository `release-kit`, workflow filename `release.yml`, environment `npm`.
4. In the same Settings page, set Publishing access to "Require two-factor authentication and disallow tokens", so only the trusted workflow can publish.
5. On GitHub, release-kit, Settings, Environments, create `npm` with deployment branches and tags limited to the tag pattern `v*`.
6. Merge the PR that adds the `publish` job; the next release publishes with provenance, and `npm view release-kit --json` shows it.

## 2. Signed releases: artifact attestations

**Why.** Adopters' release files get SHA-256 checksums today, which prove a download is intact but not who built it.
A build provenance attestation proves the file came from that repo's Release workflow at that commit.

**Design.**

- In the Release workflow's publish job, after the files are uploaded, `actions/attest-build-provenance` (pinned by SHA) attests every file in `release-artifacts/`, using `SHA256SUMS.txt` as the subject list.
- The job gets `id-token: write` and `attestations: write`; the verify job stays read-only.
- Opt-out with `.release.json` `"attest": false`; on by default for public repos.
  Artifact attestations in private repos need GitHub Enterprise Cloud, so the kit skips them there with a notice (see item 7).
- The release notes gain a line telling users how to check a file: `gh attestation verify <file> --repo <owner>/<repo>`.
- The publish idempotency from #14 carries over: a re-run attests again, which is harmless.

**Owner steps.** None.

## 3. Pre-releases

**Why.** Some repos want a `v1.3.0-beta.1` for testers before `v1.3.0`.

**Design.**

- `npm run release -- --pre beta` cuts `X.Y.Z-beta.N`: the next stable version from the commits, with the next free number for that channel.
  `npm run release` with no `--pre` from a pre-release cuts the stable `X.Y.Z`.
- `RELEASE_TAG` gains an optional `-<channel>.<n>` part; every place that reads tags (previous tag, `--verify-tag`, the workflows' tag check) is updated, and the notes of a stable release cover everything since the previous stable one.
- The Release workflow publishes a pre-release tag as a GitHub pre-release (`--prerelease`), never as "Latest".
- The release train never cuts pre-releases.
- `.release.json` `"prerelease": ["beta", "rc"]` lists the allowed channels.

**Owner steps.** None.

## 4. A reviewable release PR mode

**Why.** release-please and changesets let a person read the next version and changelog in a pull request before it ships.

**Design.**

- `.release.json` `"train": { "mode": "pr" }` makes the train open or update one pull request from `release/next` instead of tagging: the bumped version files and the new CHANGELOG.md section, with the notes as the description.
- Editing the CHANGELOG.md section in the PR is how a person rewords the notes; the tag carries the merged text, as releases already do.
- Merging it (title `chore(release): vX.Y.Z`) triggers a small `tag-on-merge` job that tags the merge commit and starts the Release workflow.
- The PR is opened with the rollout bot's App token (item 8) or a deploy key, because a PR opened with `GITHUB_TOKEN` runs no CI.
- The existing direct mode stays the default.

**Owner steps.** None beyond item 8's App, if the repo wants CI on the release PR.

## 5. pnpm, yarn and bun

**Why.** apply needs `package-lock.json`, and the workflows run `npm ci`.

**Design.**

- apply detects the package manager from `packageManager` in package.json, then the lock file, and saves it in `.release.json` `"packageManager"`.
- The workflows run one "Install" step that picks `npm ci`, `pnpm install --frozen-lockfile` (with `pnpm/action-setup`, pinned), `yarn install --immutable` (Corepack), or `bun install --frozen-lockfile` (`oven-sh/setup-bun`, pinned), and the matching `setup-node` cache.
- `release.mjs` bumps the version with the repo's manager, and the CI lanes classifier learns the other lock formats; until it does, a change to them is `full`.
- `allow-git` is npm-only; pnpm and yarn need nothing for the kit once it is on the registry (item 1).

**Owner steps.** None.

## 6. Monorepos

**Why.** One version per repo does not fit several independently released packages.

**Design.**

- `.release.json` `"packages": ["packages/*"]`: each package has its own version, tags `<name>@X.Y.Z`, and CHANGELOG.md.
- A commit belongs to the packages whose folders it touches; the scope can name one explicitly.
- Bumps are per package; a package that depends on a bumped workspace package gets a patch.
- The train releases every package with user-facing work, one tag each, in one push.
- This is the largest item and no adopter needs it today, so it waits for one that does.

**Owner steps.** None.

## 7. Per-repo settings: public and private repos

**Done in v2.4.0**, as designed below, together with the free safeguards for private repos on GitHub Free (the pre-push guard, the Direct push alarm, and `protect` setting them up): see [PRIVATE_REPOS.md](PRIVATE_REPOS.md).
Where the build differs from the design: the security scan's job decides from the event's `github.event.repository.private` (free, before a runner starts) rather than from `.release.json`, which apply's caller overrides with the `pull-requests` input; the `attest` setting is read once attestations (item 2) exist; and the kit lane needs no new setting, since CI lanes already give every repo one, so `release-kit check` recommends them to a private repo that hasn't adopted them.

**Why.** Standard runners are free in public repos and billed per minute, rounded up per job, in private ones.
A private repo should skip work that costs minutes without protecting anything.

**Design.**

- `.release.json` `"visibility": "public" | "private"`, detected by apply from `gh repo view --json visibility` when gh is signed in, and otherwise asked for with a note (`--visibility`).
- Private repos get, by default: the security scan weekly only (not on every lock-file PR, since Dependabot alerts cover those), no artifact attestations (they need Enterprise Cloud), and the CI lanes' `kit` lane for kit-only updates.
- Each setting can be overridden: `"security": { "onPullRequest": true }`, `"attest": true`.
- The workflows read the settings in the job that decides, so one workflow file serves both kinds of repo.

**Owner steps.** None.

## 8. The rollout bot

**Done**, as designed below, for the next release: `adopters.json`, `.github/workflows/rollout.yml` (with `rollout-wave.yml` for each wave), `scripts/rollout.mjs` and `apply --json`; the README has [how it works](../README.md#the-rollout-bot).
Where the build differs from the design:

- apply runs from the kit checked out at the tag (`node kit/apply.mjs`), not through `npx release-kit@<tag>`: the same code, without npm fetching a git dependency, which npm 12 refuses without `--allow-git`.
- Each wave is one job per repo in the `rollout` environment.
  Until v2.8.0 the environment required the owner's approval for each wave (three clicks for a full rollout).
  Since then a patch or minor release gates itself: the public and private waves wait for the canary's update pull request to pass its checks and merge, a failure opens a `release-kit: rollout` issue, and only a major release waits for a click in `rollout-major` before each wave.
- A later wave waits for every repo in the earlier waves, not only the canary: a red public repo also holds back the private one.
- `adopters.json` also lists each repo's visibility, a `note` for the pull request, and the repos the App isn't installed on, with `"enabled": false` and the reason.
- apply writes the bot's login (`release-kit-bot-n8watkins[bot]`) into the `bots` input of the `auto-merge.yml` it writes, so the bot's update pull requests merge like Dependabot's.
- apply no longer counts a repo's own workflow that mentions release-kit as the kit's (it replaced Scribe's `release.yml`); the bot depends on that, so roll out a release that has the fix, not v2.5.2 or older.
- Not yet: apply still writes the Dependabot entries for the kit.
  The design drops them "once the bot is live"; that waits until a real rollout has reached every adopter, and until the repos the App isn't installed on are covered, since Dependabot is their only source of kit updates.

**Why.** Dependabot can bump a version but cannot add a file, so every kit release that adds or changes what apply writes needs a manual `npx release-kit apply .` in each of the 8 adopters.
v2.1.0's `security.yml` reached none of them that way.

**Design.**

- A GitHub App, "release-kit bot", owned by the owner's account and installed only on the adopter repos.
- `adopters.json` in release-kit lists each repo with its default branch, its merge policy (auto-merge, merge when green, or a person), and its wave (canary, public, private).
- `.github/workflows/rollout.yml` in release-kit runs on `release: published` and on demand.
  It has a matrix over the adopters; each job runs in the protected `rollout` environment, mints a token scoped to that one repo with `actions/create-github-app-token` (pinned by SHA), checks the repo out, runs `npx release-kit@<tag> apply .` (or the git spec until item 1), runs `npm install --package-lock-only`, and opens or updates one pull request from the branch `release-kit/update` whose description is the release notes plus apply's report.
- apply gains `--json`, so the bot can say exactly what changed and the PR description lists added, changed and removed files.
- Waves run in order: the canary repo first, then the public repos, then the private one, and a red canary stops the rollout.
- PRs opened with an App token run CI normally, unlike PRs opened with `GITHUB_TOKEN`, and the auto-merge policy already accepts the bot's `release-kit/` branch (pass its login in the `bots` input).
- Once the bot is live, apply stops writing the npm and github-actions Dependabot entries for the kit, so there is one source of kit PRs, not two.

**Owner steps.** Done 2026-11-02: the App (ID 5590953) is installed on the eight adopters, and the `rollout` environment holds its ID and key.
What stays with the owner: approving each rollout's waves, and installing the App on another adopter before setting it to `"enabled": true` in `adopters.json`.
The setup steps, and the steps for adding an adopter, are in [UPGRADES.md](UPGRADES.md#setting-up-the-app).

## 9. Stale-file detection without the App

**Done**, as designed below, for the next release (v2.6.0): `apply --check`, the warning in `release-kit check` and step 5 of `release-kit verify`; [UPGRADES.md](UPGRADES.md#without-the-app) has how it works.
Where the build differs from the design: a dry run also counts a hook whose executable bit a real run would restore.

**Why.** Without the App, a kit release that adds or changes a file reaches a repo only when someone runs `npx release-kit apply .`.
Dependabot's update moves the version, `release:check` then says "up to date", and the new file never arrives unless someone reads the release notes ([UPGRADES.md](UPGRADES.md#without-the-app), step 4).
The kit already knows exactly what apply would write at the installed version, so it can say when the repo differs.

**Design.**

- `release-kit apply --check .`: a dry run of apply at the installed kit version that writes nothing and compares what apply would write with what the repo has.
  It prints each file that would be added, changed or removed, and exits 1 when anything differs and 0 when the repo is current.
- It respects what apply deliberately leaves alone: a repo's own `release.yml` or other workflow the kit didn't write, a repo's own `dependabot.yml`, and hooks a custom hooks path or a hook manager owns (#46).
  apply doesn't write those, so the dry run doesn't count them.
- `release-kit check`, and so `npm run release:check`, runs the same comparison and warns: "release-kit vX.Y.Z adds or changes N files; run npx release-kit apply .", with the list.
- The kit lane's `release-kit verify` runs it too, so an adopter's pull request that bumps the kit pin without running apply shows it in CI.
  A warning, not a failure: a Dependabot kit update must not wait forever for a person, and a failing check would also stop the merge-when-green fallback, which waits for every check.
  `apply --check` stays available as a hard gate for a repo that wants one.
- The rollout bot's pull request is apply's output, so it is clean by construction.

**Owner steps.** None.

## 10. A rollout bot for outside users

**Targeted for v3**, with the npm publish (item 1), after v2.6.0.

**Why.** The rollout bot (item 8) runs only inside release-kit, from its `adopters.json`, with an App installed on the owner's account.
Anyone else using the kit gets Dependabot plus apply, and a copy of `rollout.yml` doesn't help them: the pull requests it opens wouldn't merge on their own, because apply writes `release-kit-bot-n8watkins[bot]` into every `auto-merge.yml` as the only bot besides Dependabot ([UPGRADES.md](UPGRADES.md#who-it-is-for)).

**Design.**

- The rollout workflow becomes reusable: an adopter calls it from a repo of their own (for example `<owner>/release-kit-rollout`) with their own `adopters.json`, their own App's ID and key in their own `rollout` environment, and the kit version to roll out.
  The waves, the approvals and the pull request stay as they are today.
- The auto-merge policy trusts a configured bot identity: `.release.json` `"rolloutBot": "<app-slug>[bot]"`, which apply writes into the `bots` input of `auto-merge.yml` instead of `release-kit-bot-n8watkins[bot]`, and keeps on every rerun.
  The default stays the owner's bot, so nothing changes for the current adopters.
- apply runs from the registry package at the tag (item 1), so the reusable workflow doesn't need to check out release-kit at a git tag.
- A documented setup in UPGRADES.md: create the App with the same four permissions, install it on your repos, create the environment, write `adopters.json`, set `rolloutBot` in each repo, and do a dry run.

**Owner steps.** None for the owner; each outside adopter creates and installs their own App.

## Owner steps for what is already built

These need a person with admin rights on each repo; the kit cannot do them.

### Squash merges use the pull request title

The Commit messages workflow checks pull request titles (#15), and squash merges should commit them.
In each adopter and in release-kit:

```sh
gh api -X PATCH repos/n8watkins/<repo> -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY
```

### Required checks on scribe, voicedock, portfolio-rank and tl-dw

**Done 2026-11-02.**
Each repo has a "main: required checks" ruleset and allows auto-merge.
Required checks: scribe `check / check`, CLI, Desktop frontend, Desktop backend (Windows) and MCP server (Rust dependency audit stays optional, since a new advisory would block unrelated pull requests); voicedock `check / check` and test; portfolio-rank `check / check` and typecheck; tl-dw `check / check` and verify.
When a repo adopts the CI lanes pattern, replace its list with `CI result`.
The steps below stay as the recipe for new adopters.

Rulesets are available on GitHub Free for public repos.

1. Best: adopt the CI lanes pattern ([CI_LANES.md](CI_LANES.md)) so each repo has one always-running `CI result` job, then require only that.
2. Until then, require the checks that run on every pull request without a path filter.
   Today those are `check / check` (the kit's commit check) in all four, plus `test` in voicedock and `verify` in tl-dw; scribe's other jobs and portfolio-rank's CI should be checked for path filters before they are required.
   For each repo, with its check names:

   ```sh
   gh api -X POST repos/n8watkins/<repo>/rulesets --input - <<'JSON'
   {
     "name": "main: required checks",
     "target": "branch",
     "enforcement": "active",
     "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
     "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
     "rules": [
       { "type": "deletion" },
       { "type": "non_fast_forward" },
       { "type": "required_status_checks", "parameters": {
           "strict_required_status_checks_policy": false,
           "required_status_checks": [{ "context": "check / check" }] } }
     ]
   }
   JSON
   ```

   A repo with the release train uses `npx release-kit protect --checks "check / check"` instead, which also sets up the train's deploy key.
3. Allow auto-merge in each:

   ```sh
   gh api -X PATCH repos/n8watkins/<repo> -F allow_auto_merge=true
   ```

4. Never require "Security scan": it only runs when a lock file changes, so a required check from it would wait forever on every other pull request.

### After the next kit release

Re-run `npx release-kit apply .` in each adopter (or let the rollout bot do it, item 8): it adds `security.yml`, the `.npmrc` line for npm 12, the grouped Dependabot config and the pull request title check, and then add `auto-merge.yml` and the CI lanes from the examples where wanted.
