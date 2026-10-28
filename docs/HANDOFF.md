# HANDOFF - release-kit

## Current state and open work (2026-10-27): start here

### What this is

The owner's release tooling: Conventional Commits drive the version, the tag, `CHANGELOG.md` and the GitHub Release notes (plain "New / Fixed / Faster / Safer" style by default).
Repos use it as a dev dependency, `github:n8watkins/release-kit#vX.Y.Z`, kept current by Dependabot, plus reusable workflows (the required check is named "check / check").
Latest release: v2.0.1.

### Who uses it

- On it: n8builds-web, dev-portfolio, n8builds-admin, open-ping, tl-dw, scribe (app), portfolio-rank, piper-tts.
- Not yet: Solara (a next step in its handoff); TubeVault has it only on its review branch `review/tube-vault-v0.3.81`, and who owns its changelog is undecided.

### Open problems

1. **`npm ci` fails on npm 12 in adopting repos.**
   npm 12 blocks git dependencies by default, so `npm ci` stops with `EALLOWGIT` (and empties `node_modules`) in any repo that depends on `github:n8watkins/release-kit`.
   Seen in tl-dw on 2026-10-27; CI is fine today only because it runs an older npm.
   The README covers `--allow-git` for running `apply` with npx, but not for adopters' own installs.
   Options: publish to npm (or GitHub Packages) so it's no longer a git dependency, or have `apply` add an `.npmrc` with the right `allow-git` setting and document it.
   Fix this before CI images move to npm 12, or every adopter's CI breaks.
2. **A stale `core.hooksPath` silently skips the commit-msg hook.**
   `apply` keeps a repo's own hook manager when `core.hooksPath` is set; in tl-dw it pointed at a folder that no longer existed, so `apply` treated it as another manager and installed no hook (and no `prepare` script), while `RELEASING.md` claims a local hook runs.
   piper-tts has the same pattern (a custom hooks folder).
   `apply` should check the path exists and warn, or install the hook when it doesn't.

### Next

1. Fix open problem 1, then cut a release and let Dependabot roll it out.
2. Fix open problem 2, then re-run `apply` in tl-dw and piper-tts.
3. Adopt it in Solara; settle TubeVault's changelog owner with the owner.
