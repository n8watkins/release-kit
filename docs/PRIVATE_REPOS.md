# Private repos on GitHub Free

GitHub Free gives a private repo no rulesets and no branch protection, so nothing on GitHub stops a push straight to `main`, a force push, or a moved release tag.
release-kit can't change that, but it can make those mistakes hard to make and impossible to miss, at no cost beyond a few runner minutes.

| Safeguard | When it acts | Where |
|---|---|---|
| [The pre-push guard](#the-pre-push-guard) | Before anything leaves the machine | Every clone where the hook is installed |
| [The Direct push alarm](#the-direct-push-alarm) | Right after the push, on GitHub | Every push, from any machine |
| [Merge when green](#merge-when-green) | When an update pull request's checks pass | Dependabot and release-kit update pull requests |
| [Fewer paid minutes](#settings-for-private-repos) | Every run | The security scan and CI lanes |

Public repos get the guard and the alarm too: the guard catches mistakes before GitHub's rules reject them, and the alarm reports an admin bypass.

## Setting it up

In a repo on the kit, one command:

```sh
npx release-kit protect
```

On a public repo (or a private one with GitHub Pro) it writes the rulesets.
On a private repo on GitHub Free the rulesets API answers "Upgrade to GitHub Pro", so protect sets up the free safeguards instead: it runs `apply --visibility private` to add whichever is missing, lists each one, and says plainly what GitHub still lets through.
Commit the files apply writes through a pull request; the workflows work once they are on the default branch.

`npm run release:check` (through `release-kit check`) warns when one goes missing, and when `.release.json` `visibility` no longer matches GitHub.

## The pre-push guard

A `pre-push` hook (`.githooks/pre-push`, or `.husky/pre-push` in a husky repo) that apply installs beside the commit-msg hook and the `prepare` script switches on.
It runs `release-kit pre-push`, which reads the refs git is about to push and stops the push, with nothing sent, when it would:

- push commits straight to a protected branch: the remote's default branch, `main`, `master`, and the release branches in `.release.json` `branches`;
- force push or delete a protected branch;
- move or delete a `v*` tag that is already on the remote.

It lets through pushing, force pushing and deleting any other branch, creating a new tag, creating a protected branch the remote doesn't have yet, and pushes from GitHub Actions (the alarm covers CI).
The message says what to do instead: push a branch and open a pull request, revert through a pull request, or cut a new release.

### The release flow

`npm run release -- --push` pushes the release commit and its tag to `main` in one push, so the guard has to tell it from a direct push.
It lets the push through only when both hold:

1. `release.mjs` set `RELEASE_KIT_RELEASE` to the tag it is pushing, which nothing else does; and
2. the push adds exactly one commit, and that commit is a release commit: its subject is `chore(release): vX.Y.Z`, it has one parent, `package.json` in it has version `X.Y.Z`, and it changes nothing but `package.json`, `package-lock.json`, `CHANGELOG.md` and the `.release.json` `versionFiles`.

A release commit can't carry a code change past the guard, and a hand-made one is still blocked.
When the release would push other commits too (work not yet on the remote), the guard blocks it, and `npm run release` goes through a release pull request instead, exactly as it does on a repo with rulesets: it pushes `release/vX.Y.Z`, opens the pull request, merges it once its checks pass, and tags the merged commit.
The release train runs in GitHub Actions, where the guard stands aside; it also sets `RELEASE_KIT_RELEASE`.

### Before npm install

In package mode the hook runs the kit from `node_modules`.
Until `npm install` has run, a short fallback in the hook still blocks a push to `main` or `master` and a moved or deleted `v*` tag.

### The override

For an emergency, and only then:

```sh
RELEASE_KIT_ALLOW_DIRECT_PUSH=1 git push origin main
```

The push goes through, the guard appends a line (time, author email, remote, refs and reasons) to `.git/release-kit/direct-push.log`, and the Direct push alarm on GitHub still reports it.
`git push --no-verify` skips every hook, the guard included; the alarm still reports that push too.

### Repos without the kit

`release-kit install-guard` installs the guard in one clone of any git repo, with no `package.json` needed:

```sh
npx --allow-git=root github:n8watkins/release-kit#vX.Y.Z install-guard   # or: node path/to/release-kit/bin/release-kit.mjs install-guard <repo>
```

It copies the guard's three scripts into `.git/release-kit/guard/` and writes `.git/hooks/pre-push` (or the hook in the clone's `core.hooksPath`).
Nothing is committed, so each clone runs it once, and a rerun upgrades it.
It refuses to replace a `pre-push` hook it didn't write, and says how to add the guard to it.

### A repo with its own hooks

A repo whose hooks are run by lefthook, pre-commit, simple-git-hooks, its own `core.hooksPath` or `.git/hooks`, or that has a `pre-push` hook of its own, keeps them: apply prints the line to add (`npx --no-install release-kit pre-push "$@"`, which needs git's stdin passed through).

## The Direct push alarm

`.github/workflows/direct-push.yml` runs on every push to a protected branch and on every `v*` tag push or deletion.
It reads the push through the GitHub API with the workflow's own token; no pushed code is checked out or run.

- **A force push** (`github.event.forced`) is reported.
- **Each pushed commit** must have come from a merged pull request: `GET repos/{owner}/{repo}/commits/{sha}/pulls` must list one with `merged_at`.
  GitHub sometimes links a just-merged commit a few seconds late, so it looks up to four times, about a minute in all, before it reports a commit.
- **Release commits pass**, by the same content test the guard uses (subject, one parent, the version in `package.json`, and only the version files and `CHANGELOG.md` changed).
  That covers `npm run release -- --push` on an unprotected branch and the release train, whether it pushed with its deploy key or not, without trusting who pushed: a deploy key push names no person, and a commit's author can be anyone.
- **A moved or deleted release tag**, and **a deleted protected branch**, are reported.

A report fails the run, so it shows red on the commit and GitHub emails the pusher, and it opens one issue labeled `release-kit: direct push`, or comments on the open one, with the details and a link to the run.
GitHub emails the repo's watchers about the issue; the kit has no other notification channel.
Close the issue once each report is understood.

The caller apply writes passes the release branches as the `branches` input.
A repo where a bot commits generated files straight to `main` on purpose names those paths in `allow-paths` (globs), and a direct push whose commits change only those paths is listed as allowed, not reported:

```yaml
jobs:
  alarm:
    permissions:
      contents: read
      pull-requests: read
      issues: write
    uses: n8watkins/release-kit/.github/workflows/direct-push.yml@vX.Y.Z
    with:
      allow-paths: "reports/**,editions/**"
```

A repo without the kit can use this caller as its whole setup: the called workflow fetches the kit's scripts at the pinned tag.

What it can't see: a push made with a workflow's `GITHUB_TOKEN` starts no workflow, so a bot that pushes that way is invisible to it (and to every other workflow).

## Merge when green

A private repo can't require checks, so GitHub's own auto-merge would merge an update pull request before CI finishes.
apply writes `.github/workflows/auto-merge.yml` (in every repo since v2.5.0): the [auto-merge policy](AUTO_MERGE.md) with its merge-when-green fallback, which merges a release-kit update or a Dependabot patch or minor update only once every check on its head commit has finished and passed.
Its `workflow_run` trigger lists every workflow in the repo that runs on pull requests, read when apply runs; rerun `npx release-kit apply .` after adding one.

## Settings for private repos

Standard runners are free in public repos and billed per minute, rounded up per job, in private ones.
`.release.json` `"visibility": "public" | "private"` records which a repo is: apply asks gh (`gh repo view --json visibility`) on every run, `--visibility` sets it by hand, and when gh can't tell (not signed in, offline) apply says so and the repo keeps the public defaults, which run more, never less.

| Setting | Public default | Private default | Override in `.release.json` |
|---|---|---|---|
| Security scan on lock-file pull requests | On | Off: weekly only, since Dependabot alerts cover pull requests | `"security": { "onPullRequest": true }` |
| Artifact attestations (planned, [roadmap item 2](ROADMAP.md#2-signed-releases-artifact-attestations)) | On | Off: private repos need GitHub Enterprise Cloud for them | `"attest": true` |
| Auto-merge for update pull requests ([AUTO_MERGE.md](AUTO_MERGE.md)) | `auto-merge.yml` written: GitHub auto-merge on the required checks | `auto-merge.yml` written: merge when green | `"autoMerge": false` (then delete the file) |
| CI lanes | Opt-in | `release-kit check` recommends them | [CI_LANES.md](CI_LANES.md) |

One workflow file serves both kinds of repo: the security scan's job decides from the event (`github.event.repository.private`), before a runner starts, so a skipped scan costs nothing; the override reaches it as the `pull-requests` input apply writes into the caller.

## What GitHub does not enforce, even so

- Anyone with write access can still push straight to the default branch, force push it or delete a branch: the guard stops that only on machines where it is installed, and the alarm reports it afterwards.
- A release tag can still be moved or deleted on GitHub: the guard and the alarm cover it the same way.
- A person can still merge a pull request whose checks failed: only update pull requests wait for green.
- Pushes made with a workflow's `GITHUB_TOKEN` start no workflow, so the alarm never sees them.

GitHub Pro (or making the repo public) brings real rulesets; rerun `npx release-kit protect` then.
