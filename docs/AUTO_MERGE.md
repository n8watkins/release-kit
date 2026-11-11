# Auto-merge

Update pull requests that CI has already tested shouldn't wait for a person to press a button.
The kit's reusable `auto-merge.yml` merges them on their own, within a strict policy.

## The policy

- **What may merge on its own:** release-kit updates, and Dependabot patch and minor updates, including Dependabot security updates, except a minor update of a dependency below 1.0.0.
- **What never does:** a major update of anything, a minor update of a dependency below 1.0.0 (a 0.x minor), a downgrade, an update whose kind can't be read, a draft, and any pull request that isn't from an update bot.
- **Why a 0.x minor waits:** under SemVer anything may change before 1.0.0, so a minor update of a `0.y.z` dependency (0.13.2 to 0.14.0) can break, and the kit's own pre-1.0 rule ships breaking changes as minors.
  A patch update below 1.0.0 (0.13.1 to 0.13.2) still merges on its own, as does a minor update from 1.0.0 on.
  The pull request gets the label `needs-review: 0.x minor` (created in the repo the first time) and one comment listing each such dependency with its old and new version; review it and merge it by hand.
  A grouped pull request with even one 0.x minor in it waits as a whole, so a weekly `npm-minor-patch` group with one stays open until you merge it.
  If Dependabot later rebases the pull request into one that may merge on its own, the label is taken off again.
- **Who counts as an update bot:** `dependabot[bot]`, plus any author listed in the `bots` input, whose pull requests must also come from a `release-kit/` branch; the `auto-merge.yml` apply writes lists the rollout bot, `release-kit-bot-n8watkins[bot]`.
- **How the kind is read:** the release-kit pin in `package.json` on both sides of the pull request, and the `update-type` of each dependency in Dependabot's `updated-dependencies` metadata in its commit messages.
  Each dependency's old and new version come from the "from A to B" lines below, with the metadata's `dependency-version` as the new version when there is no such line.
  This is the same metadata `dependabot/fetch-metadata` reads (its `update-type`, `previous-version` and `new-version` outputs), read here for every dependency in a group, and on `workflow_run` too, where that action has no pull request to read.
  A minor update keeps the major version, so either version tells whether it is below 1.0.0; a minor update with neither version readable (a commit SHA alone) waits for a person, since it might be one.
  A grouped pull request takes the biggest change in it, so a group with one major update waits for a person.
  The `dependabot.yml` apply writes keeps majors in groups of their own (`npm-major`, `actions-major`), so the weekly patch and minor groups (`npm-minor-patch`, `actions-minor-patch`) still merge on their own ([UPGRADES.md](UPGRADES.md#everything-else-dependabot-updates)).
- **When `update-type` is missing:** Dependabot sometimes leaves it out (a multi-ecosystem group pull request did), so the policy reads the old and new version Dependabot names instead and compares them with semver.
  It takes them from the commit messages first, then the pull request description: `Bumps [x](https://...) from A to B` for one dependency, and "Updates x from A to B" lines (the name in backticks) or the package table for each dependency in a group.
  A GitHub Action pinned to a commit SHA counts only when a version is written next to the SHA.
  What stays for a person, with the reason in the notice and the job summary: commit SHAs with no version, versions that aren't semver (`v4`, `22-alpine`), a move to a prerelease, a downgrade, and a dependency with neither an `update-type` nor a "from A to B" line.
  A prerelease's own release (2.0.0-rc.1 to 2.0.0) counts as the change its release line makes, here a major.
- **The job summary** lists each dependency, the kind of update it is, its versions, whether it is below 1.0.0 and where that was read from.
- **Only metadata is read**, through the GitHub API; no pull request code runs in the job that holds the write token.

## How it merges

GitHub's auto-merge merges a pull request once its required checks pass.
Without a required check it merges as soon as it is turned on, before CI has finished, so the kit turns it on only when the base branch requires status checks (through a ruleset or branch protection).

| The repo | What happens |
|---|---|
| Requires status checks and allows auto-merge | On `pull_request`, auto-merge is turned on; GitHub merges once the required checks pass |
| Requires status checks, auto-merge not allowed | A notice with the command to allow it, `gh api -X PATCH repos/{owner}/{repo} -F allow_auto_merge=true`; until then the merge-when-green fallback merges it |
| Requires no status checks | A notice on `pull_request`; the merge-when-green fallback merges it instead |

### Merge when green, for repos that can't require checks

A private repo on GitHub Free has no rulesets and no branch protection, so it can't require checks and GitHub's auto-merge can't be used safely.
(The other free safeguards for such repos, the pre-push guard and the Direct push alarm, are in [PRIVATE_REPOS.md](PRIVATE_REPOS.md); apply writes this workflow for a private repo by itself.)
For such repos, and for a repo that requires checks but doesn't allow auto-merge, the same workflow runs on `workflow_run`: each time one of the repo's pull request workflows finishes, it looks at every check on the pull request's head commit, and merges (with `--match-head-commit`, so a newer push is never merged unchecked) only when all of them have finished and passed.
It reacts to finished workflows instead of polling, so it costs one short job per finished workflow, not a job that waits.
List every workflow that runs on pull requests under `workflow_run`, so a check that finishes last still triggers a look.
Turn it off with `fallback: false`.

### Dependabot proposes an older kit

Dependabot waits 3 days before proposing a new release (its default cooldown).
For a git dependency like the kit it then proposes the newest tag outside that window, even when that tag is older than the one installed: a repo on v2.2.0 got "bump release-kit from v2.2.0 to v2.0.1" a day after v2.1.0 and v2.2.0 came out.
The `dependabot.yml` apply writes since v2.3.0 excludes the kit from the cooldown, so the newest tag is always the candidate and no downgrade is proposed.
The policy also refuses to merge a downgrade, as a second line of defense: close such a pull request (Dependabot then ignores that version) and rerun `npx release-kit apply .` to get the current `dependabot.yml`.
A pull request's own `pull_request` run uses the kit version it moves to, so for a downgrade to a kit older than v2.3.0 only the `workflow_run` fallback, which runs from the default branch, applies the check.

## Setting it up

1. `npx release-kit apply .` writes `.github/workflows/auto-merge.yml` in every repo, public or private, pinned to the installed kit version (since v2.5.0; before that, only in a private repo).
   `"autoMerge": false` in `.release.json` stops it (then delete the file).
   A repo without the kit can copy [examples/auto-merge.yml](examples/auto-merge.yml) and set the kit version.
2. In a repo that can require checks, require the checks that cover all of CI (the one aggregate check, for example "CI result", see [CI_LANES.md](CI_LANES.md), or every CI job) with `npx release-kit protect`.
   GitHub's auto-merge waits only for required checks, so a CI job left out of them could fail and the update would still merge.
   When protect requires checks it also allows auto-merge on the repo; by hand that is:

   ```sh
   gh api -X PATCH repos/{owner}/{repo} -F allow_auto_merge=true
   ```

3. Dependabot's own pull requests run with a read-only token unless the workflow asks for more, which the example does (`contents: write` and `pull-requests: write`, for that one job; `pull-requests: write` also covers the label and the comment on a 0.x minor).
   The merge-when-green fallback also reads the pull request's checks, so the job asks for `checks: read` and `statuses: read` too: without them a private repo's token gets a 403 ("Resource not accessible by integration") and nothing merges.
   An `auto-merge.yml` from before v2.5.2 lacks them: rerun `npx release-kit apply .`, or add the two lines by hand.

The inputs:

| Input | Default | What it does |
|---|---|---|
| `fallback` | `true` | Merge when green on `workflow_run` where the base branch requires no checks |
| `merge-method` | `squash` | `squash`, `merge` or `rebase` |
| `bots` | `dependabot[bot]` | Comma-separated authors whose update pull requests may merge on their own |
