# HANDOFF - release-kit

## Current state (2026-11-04): start here

### What this is

The owner's release tooling: Conventional Commits drive the version, the tag, `CHANGELOG.md` and the GitHub Release notes (plain "New / Fixed / Faster / Safer" style by default).
Repos use it as a dev dependency, `github:n8watkins/release-kit#vX.Y.Z`, plus reusable workflows (the required check is named "check / check").
Latest release: v2.6.0 (2026-11-03): the rollout bot, stale-file detection (`apply --check`), version files for pyproject.toml and uv.lock; see [CHANGELOG.md](../CHANGELOG.md).
How kit updates reach a repo, with and without the GitHub App, is in [UPGRADES.md](UPGRADES.md); how update pull requests merge is in [AUTO_MERGE.md](AUTO_MERGE.md).
A private sandbox, `n8watkins/release-kit-sandbox`, has the kit vendored for trying the guard and the alarm against real GitHub (issue #2 there shows every kind of report).
The November 2026 review is in [REVIEW_2026-11.md](REVIEW_2026-11.md), and the planned work and the owner's steps are in [ROADMAP.md](ROADMAP.md).

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

1. Cut the next release when the owner asks; its rollout is the first with the lock fix, and needs the owner's approval for each wave.
2. Install the App on the disabled adopters and enable them in `adopters.json`, then drop the kit's Dependabot entries (open problem 2).
3. Fix open problem 1, then re-run `apply` in tl-dw and voicedock.
