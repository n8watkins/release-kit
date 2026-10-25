# Agent instructions

<!-- release-kit -->
## Commits and releases

- Write every commit message as a Conventional Commit: `type(scope): subject`, with type one of feat, fix, perf, refactor, docs, test, build, ci, chore, style, revert. A hook and a CI check reject anything else; see RELEASING.md.
- Use `feat` and `fix` only for changes a user would notice: they become the release notes and the public build log.
- Don't bump versions, edit CHANGELOG.md or create tags by hand: `npm run release` does all three.
<!-- /release-kit -->