# Auto-merge

Update pull requests that CI has already tested shouldn't wait for a person to press a button.
The kit's reusable `auto-merge.yml` merges them on their own, within a strict policy.

## The policy

- **What may merge on its own:** release-kit updates, and Dependabot patch and minor updates, including Dependabot security updates.
- **What never does:** a major update of anything, an update whose kind can't be read, a draft, and any pull request that isn't from an update bot.
- **Who counts as an update bot:** `dependabot[bot]`, plus any author listed in the `bots` input (for example the rollout bot's `release-kit-bot[bot]`), whose pull requests must also come from a `release-kit/` branch.
- **How the kind is read:** the release-kit pin in `package.json` on both sides of the pull request, and Dependabot's own `updated-dependencies` metadata in its commit messages.
  A grouped pull request takes the biggest change in it, so a group with one major update waits for a person.
- **Only metadata is read**, through the GitHub API; no pull request code runs in the job that holds the write token.

## How it merges

GitHub's auto-merge merges a pull request once its required checks pass.
Without a required check it merges as soon as it is turned on, before CI has finished, so the kit turns it on only when the base branch requires status checks (through a ruleset or branch protection).

| The repo | What happens |
|---|---|
| Requires status checks and allows auto-merge | On `pull_request`, auto-merge is turned on; GitHub merges once the required checks pass |
| Requires status checks, auto-merge not allowed | A notice with the command to allow it: `gh api -X PATCH repos/{owner}/{repo} -F allow_auto_merge=true` |
| Requires no status checks | A notice on `pull_request`; the merge-when-green fallback merges it instead |

### Merge when green, for repos that can't require checks

A private repo on GitHub Free has no rulesets and no branch protection, so it can't require checks and GitHub's auto-merge can't be used safely.
For such repos the same workflow runs on `workflow_run`: each time one of the repo's pull request workflows finishes, it looks at every check on the pull request's head commit, and merges (with `--match-head-commit`, so a newer push is never merged unchecked) only when all of them have finished and passed.
It reacts to finished workflows instead of polling, so it costs one short job per finished workflow, not a job that waits.
List every workflow that runs on pull requests under `workflow_run`, so a check that finishes last still triggers a look.
Turn it off with `fallback: false`.

## Setting it up

1. Copy [examples/auto-merge.yml](examples/auto-merge.yml) to `.github/workflows/auto-merge.yml` and set the kit version.
2. In a repo that can require checks, require the one aggregate check (for example "CI result", see [CI_LANES.md](CI_LANES.md)) with a ruleset, or `npx release-kit protect --checks "CI result"`, and allow auto-merge:

   ```sh
   gh api -X PATCH repos/{owner}/{repo} -F allow_auto_merge=true
   ```

3. Dependabot's own pull requests run with a read-only token unless the workflow asks for more, which the example does (`contents: write` and `pull-requests: write`, for that one job).

The inputs:

| Input | Default | What it does |
|---|---|---|
| `fallback` | `true` | Merge when green on `workflow_run` where the base branch requires no checks |
| `merge-method` | `squash` | `squash`, `merge` or `rebase` |
| `bots` | `dependabot[bot]` | Comma-separated authors whose update pull requests may merge on their own |
