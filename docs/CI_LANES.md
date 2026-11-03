# CI lanes

A pull request that only edits Markdown, or only moves the release-kit pin, cannot break a browser test or a Windows build.
CI lanes let a repo skip those checks for such changes, while every push to main and every release still runs everything.

release-kit ships two pieces:

- **`changes.yml`**, a reusable workflow that classifies a pull request's diff and outputs lane flags.
- **`release-kit verify`**, the fast check a kit-only update runs instead of the repo's full CI.

The pattern around them (one workflow, job-level `if:` conditions, one aggregate result job) is in [examples/ci.yml](examples/ci.yml), ready to copy.

## The lanes

A change gets the most demanding lane that any of its files needs.

| Lane | When | What usually runs |
|---|---|---|
| `docs` | Only Markdown, `docs/`, `LICENSE`, issue and pull request templates, and the `.release.json` `lanes.docs` globs | Nothing beyond the commit check |
| `kit` | Only the `release-kit` dev dependency (its `package.json` entry and its lock entries), the kit's own workflows, hooks (commit-msg and the pre-push guard) and `.release.json` settings, and `.github/dependabot.yml` | `release-kit verify`, about a minute |
| `deps` | Only `devDependencies` and the lock entries npm marks `"dev"`, and none listed in `.release.json` `lanes.fullFor` | Install, lint, types, unit tests, build |
| `full` | Anything else | Everything, including E2E tests and OS matrices |

`changes.yml` outputs:

| Output | Meaning |
|---|---|
| `lane` | `docs`, `kit`, `deps` or `full` |
| `docs` | `"true"` when only docs changed |
| `kit` | `"true"` when a kit-owned file changed: run `release-kit verify` |
| `checks` | `"true"` for `deps` and `full`: install, lint, types, unit tests, build |
| `full` | `"true"` for `full`: everything |
| `ci` | `"true"` when a workflow or other CI file the kit doesn't own changed, for example to run actionlint |

It fails toward running everything.
A push, a manual or scheduled run, a pull request whose base can't be found, an empty diff, a file it doesn't recognise, an unreadable lock file, a change to its own `lanes` settings, and any error all give `full`.
It reads `package.json` and `package-lock.json` on both sides of the diff and compares them as data, not as text, so it can tell "only the release-kit entry changed" from anything else.
The job summary lists every changed file with its lane and the reason.

### Settings

In `.release.json`:

```json
{
  "lanes": {
    "docs": ["site/content/**"],
    "fullFor": ["typescript", "vite", "@playwright/test"]
  }
}
```

- `docs`: more globs for the docs lane (`**` matches any depth, `*` stays within a folder).
- `fullFor`: dev dependencies whose update must run everything, such as the compiler, the bundler or the E2E runner.

## One workflow, one required check

```yaml
jobs:
  changes:
    uses: n8watkins/release-kit/.github/workflows/changes.yml@vX.Y.Z
  checks:
    needs: changes
    if: needs.changes.outputs.checks == 'true'
    # ...
  result:
    name: CI result
    if: always()
    needs: [changes, checks]
    # passes when every needed job succeeded or was skipped by its lane
```

1. **`changes`** always runs and classifies the diff.
2. **Lane jobs** are the repo's own checks, each with a job-level `if:` on a lane output.
3. **`result`** has `if: always()` and `needs:` on every other job.
   It fails when any of them failed or was cancelled, and passes when they succeeded or were skipped on purpose.
   Make it the only required status check: `npx release-kit protect --checks "CI result"`, or the repo's ruleset.

### Why not path filters

When a whole workflow is skipped by `paths`, `paths-ignore`, `branches` or a commit-message filter, GitHub never creates its checks.
A branch rule that requires one of those checks then leaves the pull request "Waiting for status to be reported" forever, and it can't be merged.
GitHub's own troubleshooting page says not to put path or branch filters on a required workflow.

A job skipped by a job-level `if:` is different: it reports "skipped", which counts as passing.
That is why the lanes live in job conditions inside one workflow, and why the one required check is a job that always runs.

The kit's `security.yml` uses a `pull_request` `paths` filter (it only scans when a lock file changes), so never make "Security scan" a required check.

## `release-kit verify`

What a kit-only update can break, checked without the repo's own build and tests:

1. **Install**: `package.json`, `package-lock.json` and `node_modules` agree on the kit version, and `.npmrc` lets npm 12 fetch the kit as a git dependency.
2. **Pins**: every workflow calls the kit at the installed version.
3. **Workflows**: actionlint passes, when actionlint is installed (it is skipped, and says so, when it isn't).
4. **Notes**: the release scripts load and render the notes since the last release.

It exits 1 on any problem, so a kit update that would break releases fails its pull request.
A Dependabot update of the dev dependency alone, with the workflow pins left behind, fails the pins step on purpose: the `release-kit` multi-ecosystem group apply writes into `dependabot.yml` keeps them in one pull request.

## Costs

Standard runners are free in public repos.
In a private repo every job rounds up to a whole minute, so a kit-only pull request in the `kit` lane costs about two minutes (`changes`, `kit`, `result`) instead of the full suite.
