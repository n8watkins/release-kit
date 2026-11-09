# HANDOFF - release-kit

## Current state (2026-11-04): start here

### What this is

The owner's release tooling: Conventional Commits drive the version, the tag, `CHANGELOG.md` and the GitHub Release notes (plain "New / Fixed / Faster / Safer" style by default).
Repos use it as a dev dependency, `github:n8watkins/release-kit#vX.Y.Z`, plus reusable workflows (the required check is named "check / check").
Latest release: v2.6.0 (2026-11-03): the rollout bot, stale-file detection (`apply --check`), version files for pyproject.toml and uv.lock; see [CHANGELOG.md](../CHANGELOG.md).
How kit updates reach a repo, with and without the GitHub App, is in [UPGRADES.md](UPGRADES.md); how update pull requests merge is in [AUTO_MERGE.md](AUTO_MERGE.md).
A private sandbox, `n8watkins/release-kit-sandbox`, has the kit vendored for trying the guard and the alarm against real GitHub (issue #2 there shows every kind of report).
The November 2026 review is in [REVIEW_2026-11.md](REVIEW_2026-11.md), and the planned work and the owner's steps are in [ROADMAP.md](ROADMAP.md).

### v2.9.0 (2026-11-09)

- The pre-1.0 rule: below 1.0 a breaking change bumps minor, and 1.0.0 needs `--stable` or `"stable": true` (#75).
- `releases.json`, schema `schema/releases.v1.json`, written in every release commit and attached to the GitHub Release; an optional Atom feed (#76).
  The n8builds.dev build log can read it instead of scraping release bodies (`lib/build-log.ts` there still scrapes; switching it is n8builds-web work).
- `release-kit backfill` for older tags, dry run by default (#77); release-kit's own file was backfilled in #80.
- The pull request title check counts the ` (#N)` a squash merge adds (#78), after #76's 104-character header failed the Commit messages check on main (that red run on 2ede208 stays).
- Design note, not built: [BEYOND_NPM.md](BEYOND_NPM.md) recommends one standalone CLI with thin wrappers (#79).

### Who uses it

- The rollout bot covers the eight repos the App is installed on, as listed in [adopters.json](../adopters.json): portfolio-rank (canary), n8builds-web, dev-portfolio, open-ping, scribe, voicedock, tl-dw, and n8builds-admin (private).
- Listed but `"enabled": false` until the App is installed on them, so Dependabot plus apply is their only source of kit updates: tube-vault (default branch `review/tube-vault-v0.3.81`), relink, strollz, keysready, vibelog, pivot, cutelyaskme, feelium, fitflow7, pr-post, solara, devguard, pass-env.
- pr-post-private (private, no package.json) has only the Direct push alarm caller (with `allow-paths` for the report routine) and the guard installed by `release-kit install-guard` in the owner's WSL clone.

### v2.6.0 rollout (2026-11-04)

- Release-kit run 41747177018 opened `ci: update release-kit to v2.6.0` in all eight adopters, and all eight merged.
- open-ping #101 and n8builds-admin #35 were merged by hand:
  - open-ping requires checks (branch protection) but doesn't allow auto-merge, a case the v2.6.0 policy left for a person on both events. On main now, the merge-when-green fallback covers it.
  - n8builds-admin #35 was the PR that added the bot to `bots`; the fallback runs from main's `auto-merge.yml`, which still listed only Dependabot. A one-time bootstrap: main lists the bot now.
- The bot moved the package.json pin but left `package-lock.json` on the old kit commit (npm 10 keeps a git dependency's locked commit when only its tag changes).
  Dependabot then opened a lock-only "Bump the release-kit group" pull request in seven repos, and auto-merge refused each one ("pinned to commit SHAs with no version").
  Six were merged by hand on 2026-11-04 (dev-portfolio #54, n8builds-admin #36, tl-dw #32, open-ping #102, portfolio-rank #30, voicedock #27); n8builds-web #149 merges once its E2E finishes.
  scribe has its own `dependabot.yml` and got no such pull request; scribe #92 fixes its lock by hand.
  On main, the rollout names the kit to npm and fails a repo whose lock doesn't end up on the tag.

### Dependabot for every dependency (2026-11-04)

- The kit's `dependabot.yml` from 2.0.0 to 2.7.0 had `allow: release-kit`, which Dependabot also applies to security updates: tube-vault (minimatch) and cutelyaskme (glob, minimatch) had every security update fail with "all versions were ignored", and no adopter got version updates for anything but the kit.
- The fix writes two entries per ecosystem: the kit-only entry in the `release-kit` multi-ecosystem group (unchanged behavior), and a weekly entry for everything else with `*-minor-patch` and `*-major` groups, a cooldown and `ignore: release-kit`.
- Learned in `n8watkins/release-kit-sandbox` (PRs #3 to #12 there), from the job definitions in the Dependabot Updates logs:
  - An entry in a multi-ecosystem group updates only what its `patterns` name; its own `groups` and `schedule` are never used (dependabot-core skips ungrouped dependencies in a multi-ecosystem job).
  - A second entry for the same ecosystem and directory, outside the group, is accepted and gets its own weekly job.
  - Security jobs take the first npm entry's settings (the kit's, with no allow and no ignore), carry no groups, and open one PR per vulnerable dependency.
  - Dependabot rejects `cooldown.semver-*-days` for github-actions; the SchemaStore schema doesn't catch it, only Dependabot's `.github/dependabot.yml` check on the default branch does.
- The sandbox's own `auto-merge.yml` is still the v2.3.3 one without `checks: read`, so its merge-when-green fallback fails with a 403; re-apply the kit there before relying on it.

### Rollouts gate themselves (2026-11-04)

- The owner asked for routine releases to need no clicks.
  `rollout.yml` now runs canary, then "Canary merged" (`scripts/rollout.mjs wait-merge`: up to an hour for the canary's branch to pin the tag; a red check or a pull request closed unmerged fails it at once), then public, then private.
- A major release (its major differs from the highest earlier tag, `isMajorRelease`) skips that gate and instead waits before each wave for a click in the `rollout-major` environment, which holds no secrets; the waves still run in `rollout` for the App key.
- Any failure in a real rollout runs "Report a failure", which opens or comments on an issue labeled `release-kit: rollout` in release-kit.
- A dry run that names a disabled adopter now checks it, which shows whether the App is installed there.
- The `rollout` environment's required reviewer comes off only after this is released; `rollout-major` keeps the owner as required reviewer.

### Unreleased on main

- #59: the App key reaches every rollout wave.
- #60: the rollout starts on its own after the Release workflow publishes.
- #61: a uv.lock's own entry is found by its source when the name is stale.
- #62: `check` flags a missing fork guard only in workflows apply owns.
- #63: devguard and pass-env listed as adopters, disabled until the App is installed.
- The rollout updates the lock file to the new kit; auto-merge's merge-when-green fallback also merges in a repo that requires checks but doesn't allow auto-merge.

### Open problems

1. **A stale `core.hooksPath` silently skips the kit's hooks** (now the pre-push guard too).
   `apply` keeps a repo's own hook manager when `core.hooksPath` is set; in tl-dw it pointed at a folder that no longer existed, so `apply` treated it as another manager and installed no hook (and no `prepare` script).
   `apply` should check the path exists and warn, or install the hook when it doesn't.
2. **Two sources of kit pull requests.**
   apply still writes the kit's Dependabot entries, so every adopter the bot covers also gets Dependabot's kit update.
   The roadmap drops them once the bot has reached every adopter and the disabled ones are covered ([ROADMAP.md, item 8](ROADMAP.md#8-the-rollout-bot)).

### Next

1. Watch the first rollout without approvals (the release after the gate) and close any `release-kit: rollout` issue it opens once handled.
2. Install the App on the disabled adopters and enable them in `adopters.json`, then drop the kit's Dependabot entries (open problem 2).
3. Fix open problem 1, then re-run `apply` in tl-dw and voicedock.
