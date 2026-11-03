# HANDOFF - release-kit

## Current state (2026-11-02): start here

### What this is

The owner's release tooling: Conventional Commits drive the version, the tag, `CHANGELOG.md` and the GitHub Release notes (plain "New / Fixed / Faster / Safer" style by default).
Repos use it as a dev dependency, `github:n8watkins/release-kit#vX.Y.Z`, kept current by Dependabot, plus reusable workflows (the required check is named "check / check").
Latest release: v2.4.0 (2026-11-02): the free safeguards for private repos on GitHub Free (pre-push guard, Direct push alarm, `visibility` settings, `protect` fallback); see [PRIVATE_REPOS.md](PRIVATE_REPOS.md).
A private sandbox, `n8watkins/release-kit-sandbox`, has the kit vendored for trying the guard and the alarm against real GitHub (issue #2 there shows every kind of report).
The November 2026 review is in [REVIEW_2026-11.md](REVIEW_2026-11.md), and the planned work and the owner's steps are in [ROADMAP.md](ROADMAP.md).

### Who uses it

- On it: n8builds-web, n8builds-admin (private), dev-portfolio, tl-dw, tube-vault (default branch `review/tube-vault-v0.3.81`), deadlink, strollz, keysready, vibelog, plus open-ping, scribe, voicedock (was piper-tts) and portfolio-rank.
- pr-post-private (private, no package.json) has only the Direct push alarm caller (with `allow-paths` for the report routine) and the guard installed by `release-kit install-guard` in the owner's WSL clone.
- Not yet: Solara (a next step in its handoff).

### Open problems

1. **npm 12 refuses git dependencies (`EALLOWGIT`).**
   Fixed in v2.2.0: apply writes `allow-git=root` to `.npmrc` in package mode.
   Each adopter needs one `npx release-kit apply .` after the next kit release.
2. **A stale `core.hooksPath` silently skips the kit's hooks** (now the pre-push guard too).
   `apply` keeps a repo's own hook manager when `core.hooksPath` is set; in tl-dw it pointed at a folder that no longer existed, so `apply` treated it as another manager and installed no hook (and no `prepare` script).
   `apply` should check the path exists and warn, or install the hook when it doesn't.

### Next

1. v2.4.0 was applied to n8builds-web, dev-portfolio, n8builds-admin, tl-dw, tube-vault, deadlink, strollz, keysready and vibelog by PR on 2026-11-02; open-ping, scribe, voicedock and portfolio-rank still need `npx release-kit apply .` (or the Dependabot bump plus a rerun of apply, which adds the guard and the alarm).
2. Fix open problem 2, then re-run `apply` in tl-dw and voicedock.
3. Adopt it in Solara; settle TubeVault's changelog owner with the owner.
