# Beyond npm

A design note, not built.
Written 2026-11-09 after the owner asked why the kit only installs through npm, and whether each ecosystem should get its own install.

## Where npm is assumed today

The kit's logic is plain Node with no dependencies, so "npm-only" is about packaging and a few hard-coded steps, not the code:

- **Install and pin:** package mode adds `"release-kit": "github:n8watkins/release-kit#vX.Y.Z"` to `package.json`, runs from `node_modules`, and Dependabot's npm ecosystem moves the pin.
  Reusable and vendored modes copy the scripts instead, but still need Node to run them.
- **The version's home:** `package.json` is always a version file; `.release.json` `versionFiles` adds `Cargo.toml`, `pyproject.toml` and others, but can't replace it.
- **The checks:** the Release workflow runs `npm ci`, `npm run release:check` and `npm run release:artifacts`.
- **The hooks:** turned on by the `prepare` script, which only npm runs.

So a Rust, Python or Go repo without a `package.json` can't adopt the kit at all, and one with a token `package.json` gets an npm install it doesn't need.

## The two options

### A. A package per ecosystem

Publish the kit to npm, PyPI, crates.io and so on, each native to its ecosystem.

- **For:** each repo installs and updates the kit the way it installs everything else, and Dependabot updates it in every ecosystem it supports.
- **Against:** either the kit is ported once per language (several implementations of the same rules, which drift), or every package bundles the Node scripts and still needs Node, which only moves the problem.
  Each package is also its own release pipeline, name to hold and provenance setup.
  The kit's point is one standard, and this splits it.

### B. One standalone CLI, with thin wrappers

Ship `release-kit` as a single binary per platform, from one codebase, and make every package a wrapper that pins and downloads it.

- **The binary** is built in the kit's own Release workflow and attached to the GitHub Release with `SHA256SUMS.txt` (and attestations, roadmap item 2).
  The first build compiles the existing Node scripts into one file (Node's single executable applications), so no rewrite is needed to start; a rewrite in a compiled language stays possible later if size or start-up time ever matters.
- **Installs:** the Homebrew tap the owner already runs (`n8watkins/homebrew-tap`), a winget manifest, and `curl -fsSL .../install.sh | sh` that checks the checksum.
- **Thin wrappers,** the pattern esbuild, Biome and Ruff use: an npm package with per-platform optional dependencies, a PyPI wheel per platform, and `cargo binstall` metadata.
  Each holds a version and the binary, nothing else, so there is still one implementation.
  Their only job is to give Dependabot a version it can move in that ecosystem.
- **CI needs no wrapper:** the reusable workflows fetch the binary at the tag they are pinned to and check it, so the workflow pin decides what runs in CI, as it does today.
- **The npm-shaped steps become settings:** `.release.json` names the version source (`package.json` stays the default) and the check and artifact commands (`"check": "cargo test"`), and the workflows run `npm ci` only when there is a `package.json`.
  Hooks are turned on by `release-kit apply` setting `core.hooksPath` itself, instead of the `prepare` script, and the commit-msg hook lets a commit through with a note when the binary isn't installed, as it does before `npm install` today; CI checks every commit anyway.
- **Updates:** Dependabot's github-actions ecosystem moves the workflow pins in every repo, whatever its language; the wrapper's ecosystem moves the local pin where there is one; `release-kit check` and the rollout bot cover the rest, as now.

## Recommendation

Option B: one standalone CLI, installable with Homebrew, winget or curl, with thin npm, pip and cargo wrappers that only carry the version.

- It keeps one implementation and one version line, which is what makes the kit a standard rather than a family of tools.
- It removes the real blocker, which is the hard-coded npm steps, not the install method: those become `.release.json` settings either way, and doing that first helps every option.
- The binary is a packaging change over the existing scripts, not a rewrite, and it brings the signing and provenance work (roadmap items 1 and 2) into one release pipeline instead of several.
- npm stays a first-class install: package mode keeps working, and the npm package becomes the first wrapper once it is on the registry (roadmap item 1).

Suggested order, each step useful by itself:

1. Make `package.json` optional: version source, check and artifact commands from `.release.json`; `npm ci` only when there is a `package.json`.
   Rust and Python repos can then adopt in reusable or vendored mode with Node from the runner.
2. Build and attach the binary in the kit's Release workflow, with checksums and attestations; publish the Homebrew formula, the winget manifest and the install script.
3. Make the reusable workflows run the pinned binary instead of checking out the scripts.
4. Add the wrappers: npm first (with roadmap item 1), then PyPI and crates.io when a repo in those ecosystems adopts the kit.
