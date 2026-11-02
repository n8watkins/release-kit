# HANDOFF - release-kit

## Current state (2026-11-02): start here

### What this is

The owner's release tooling: Conventional Commits drive the version, the tag, `CHANGELOG.md` and the GitHub Release notes (plain "New / Fixed / Faster / Safer" style by default).
Repos use it as a dev dependency, `github:n8watkins/release-kit#vX.Y.Z`, kept current by Dependabot, plus reusable workflows (the required check is named "check / check").
Latest release: v2.2.0.
The November 2026 review is in [REVIEW_2026-11.md](REVIEW_2026-11.md), and the planned work and the owner's steps are in [ROADMAP.md](ROADMAP.md).

### Who uses it

- On it: n8builds-web, n8builds-admin (private), dev-portfolio, open-ping, scribe, voicedock (was piper-tts), portfolio-rank, tl-dw.
- Not yet: Solara (a next step in its handoff); TubeVault has it only on its review branch `review/tube-vault-v0.3.81`, and who owns its changelog is undecided.

### Open problems

1. **npm 12 refuses git dependencies (`EALLOWGIT`).**
   Fixed in v2.2.0: apply writes `allow-git=root` to `.npmrc` in package mode.
   Each adopter needs one `npx release-kit apply .` after the next kit release.
2. **A stale `core.hooksPath` silently skips the commit-msg hook.**
   `apply` keeps a repo's own hook manager when `core.hooksPath` is set; in tl-dw it pointed at a folder that no longer existed, so `apply` treated it as another manager and installed no hook (and no `prepare` script).
   `apply` should check the path exists and warn, or install the hook when it doesn't.

### Next

1. Cut the next kit release, then re-run `npx release-kit apply .` in every adopter (it adds `security.yml` and the `.npmrc` line).
2. Fix open problem 2, then re-run `apply` in tl-dw and voicedock.
3. Adopt it in Solara; settle TubeVault's changelog owner with the owner.
