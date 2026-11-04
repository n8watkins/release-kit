# zizmor on a repo with the kit

[zizmor](https://docs.zizmor.sh/) audits GitHub Actions workflows.
On a repo on the kit it reports these findings in the files apply writes, all expected:

| Finding | Where | Why it shows up |
|---|---|---|
| `unpinned-uses` | `release.yml`, `commits.yml`, `security.yml`, `direct-push.yml`, `auto-merge.yml` (and `release-train.yml`) | In package and reusable mode they call the kit's workflows at a version tag, like `n8watkins/release-kit/.github/workflows/release.yml@v2.5.2`, and zizmor wants a commit SHA. |
| `dangerous-triggers` | `auto-merge.yml` | The merge-when-green fallback runs on `workflow_run`. |
| `dependabot-cooldown` (a warning) | `.github/dependabot.yml`, package mode | The kit's Dependabot entries exclude the kit from the cooldown on purpose: with one, Dependabot skips the newest tag and can propose an older one. Every other dependency is in entries with a cooldown (3 days, and 7 for an npm major). |

Vendored mode copies the kit's full workflows into the repo, so zizmor audits them like the repo's own; of the findings above, the `auto-merge.yml` one applies there too.

## The recommended config

Put this in `.github/zizmor.yml`, or merge its two entries into the repo's own zizmor config:

```yaml
# zizmor configuration (https://docs.zizmor.sh/configuration/).
rules:
  unpinned-uses:
    config:
      policies:
        # The release-kit callers pin a version tag: release tags in
        # n8watkins/release-kit are never moved or deleted (a tag ruleset).
        "n8watkins/release-kit/*": ref-pin
        "*": hash-pin
  dangerous-triggers:
    ignore:
      # The kit's merge-when-green fallback: it runs no pull request code
      # (see docs/ZIZMOR.md in n8watkins/release-kit).
      - auto-merge.yml
```

Every other action stays held to a commit SHA, as before.
With zizmor 1.31.1 this leaves no findings in the callers package and reusable mode write; the `dependabot-cooldown` warning stays, and is safe to leave.

## Why a tag pin for the kit is fine

- The kit's release tags are protected by a ruleset on n8watkins/release-kit: a `vX.Y.Z` tag is never moved or deleted, so `@v2.5.2` names one commit for good.
- The called workflows fetch the kit's scripts at the same commit as the workflow file (`job.workflow_sha`), so the tag decides everything that runs.
- Dependabot and the rollout bot move the pin to each new release, which they do by tag.

A repo that wants SHA pins anyway can run `npx release-kit apply . --kit-ref <commit SHA>`; apply then writes the SHA with the version as a comment, and zizmor needs no `unpinned-uses` policy.

## Why `workflow_run` in auto-merge.yml is safe

zizmor flags every `workflow_run` trigger because the usual way to misuse it is to check out and run a pull request's code with the base repo's token and secrets.
`auto-merge.yml` does neither:

- **No pull request code runs.** The called workflow checks out only the kit's own scripts, at the pinned commit, and reads the pull request through the API.
- **It acts only on update pull requests.** The job runs only for a `workflow_run` started by a `pull_request` event that succeeded, on a Dependabot or `release-kit/` branch; the policy then checks the author is one of the update bots, so a fork's pull request named `release-kit/...` is left alone.
- **It merges only what it judged.** The merge passes `--match-head-commit`, so a push after the checks ran stops it, and a major update always waits for a person.
- **The token is scoped to the job:** `contents: write` and `pull-requests: write` to merge, and read access to checks and statuses. No secrets are passed.

[AUTO_MERGE.md](AUTO_MERGE.md) has the whole policy.

## Why apply doesn't write the config

zizmor reads a single config file (`.github/zizmor.yml` or `zizmor.yml`), so the kit's entries would have to be merged into the repo's own one, as solara has.
Rewriting someone's YAML, with its comments and its own rules, isn't something apply can do cleanly, and writing a zizmor config into a repo that doesn't run zizmor would only add a stray file.
So the config lives here, to copy once.
