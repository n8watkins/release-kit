# Upgrades: do I need the GitHub App?

No.
release-kit is a package each repo installs, and the GitHub App behind the rollout bot is optional.
Without it, Dependabot moves the version and you run one command when a release adds files.
With it, the bot runs that command for you in every repo it covers and opens a pull request.

## What a kit release changes

A release can change two things in a repo that uses the kit:

- **The version.** The `release-kit` dev dependency in `package.json` and the `@vX.Y.Z` pins on the kit's reusable workflows.
- **The files apply writes.** A new workflow (`security.yml` in v2.1.0, `auto-merge.yml` in every repo since v2.5.0), a fix to one the kit wrote before, or a new line in `.npmrc`.

Dependabot can change a version, not add or rewrite a file.
That is the whole reason the App exists.

## Without the App

1. **Dependabot opens one pull request per kit release.**
   apply writes `.github/dependabot.yml` with a multi-ecosystem group named `release-kit`, so one pull request, `build(deps): ...`, moves the dev dependency and every workflow pin together, and the repo's CI tests it.
   The kit is excluded from Dependabot's 3-day cooldown, so the pull request shows up within a day of the release.
   A repo with its own `dependabot.yml` keeps it: apply leaves it alone and says what to add, and until then the kit arrives as separate npm and github-actions pull requests (or not at all, if that file doesn't cover them).
2. **`auto-merge.yml` merges it.**
   apply writes this workflow in every repo, and it merges a patch or minor kit update once the required checks pass, or once every check passes in a repo that can't require checks (merge when green).
   A major update or a downgrade waits for you.
   The policy is in [AUTO_MERGE.md](AUTO_MERGE.md).
3. **When the release adds or changes files, you run apply.**
   After the Dependabot update lands, in each repo:

   ```bash
   npx release-kit apply .
   git diff
   ```

   `npx release-kit` runs the installed kit, which is now the new version, so apply writes what that version ships.
   Commit the result through a pull request.
4. **`npm run release:check` warns when a repo is behind.**
   In package mode it starts with `release-kit check`, which warns (and never fails) when:
   - the installed kit is older than the newest release tag;
   - a workflow pins a different kit version than the one installed;
   - a file is missing a fix the kit knows about (a `release.yml` without the fork guard, a `dependabot.yml` without the cooldown exclusion);
   - and a few repo settings, like visibility and branch protection.

   It does not compare your files with what the new apply would write.
   Once Dependabot's update has landed, it says "up to date" even when that release added a file, so read the release notes, or just run apply after every kit update.

## With the App

On every published release (pre-releases are skipped), [`.github/workflows/rollout.yml`](../.github/workflows/rollout.yml) in release-kit does step 3 for you:

- **Who:** every repo in [adopters.json](../adopters.json) with `"enabled": true`.
- **In waves:** the canary repo, then the public repos, then the private ones.
  A wave starts only when every repo in the waves before it succeeded, so a red canary stops the rollout.
- **With your approval:** each wave waits in the protected `rollout` environment for one click, up to three per release.
- **Per repo:** apply from the kit at the tag, the lock file updated, and one pull request, `ci: update release-kit to vX.Y.Z` from the branch `release-kit/update`.
  Its description lists what apply added, changed and removed, anything it left for a person, how it merges, and the release notes.
  A rerun updates the same pull request.
- **Merging:** the same `auto-merge.yml`, which lists the bot (`release-kit-bot-n8watkins[bot]`) next to Dependabot, so a patch or minor update merges on its own and a major waits.
  Each adopter's `merge` field says which way that repo merges: `auto-merge`, `merge-when-green` or `person`.

Dependabot's pull request still arrives too, for now: apply keeps writing the Dependabot entries until a real rollout has reached every adopter, and the repos without the App rely on them ([ROADMAP.md, item 8](ROADMAP.md#8-the-rollout-bot)).

To try it without pushing anything: Actions, Rollout, "Run workflow", with a tag and dry run on (the default).
Each pull request shows up in the run summary instead.

### Why an App and not a personal token

- **A personal token can write to every repo it covers, for as long as it lives.**
  Stored as a secret, it is a standing key to all of them.
- **The App's tokens are short-lived and scoped to one repo.**
  Each job mints its own for that one adopter, with only contents, pull requests and workflows access, read-only in a dry run, and it expires within the hour.
  The App's private key sits in the `rollout` environment, behind your approval.
- **The pull requests are the bot's, not yours.**
  The auto-merge policy merges only pull requests from update bots, so one opened with your token would never merge on its own.

## Who it is for

The bot runs inside the release-kit repo, from its `adopters.json`, with an App that is installed only on the owner's account.
So it serves the maintainer's own repos.
A listed repo with `"enabled": false` and "Needs the App installed" gets Dependabot only until the App is installed on it.

Anyone else using the kit (from git today, from npm once [roadmap item 1](ROADMAP.md#1-publish-release-kit-to-npm-with-provenance) ships) uses Dependabot plus apply.
Running the same automation for your own repos isn't supported yet.
A copy of `rollout.yml` with your own App and adopters list would open the pull requests, but they wouldn't merge on their own: apply writes `release-kit-bot-n8watkins[bot]` into every `auto-merge.yml` as the only bot besides Dependabot, and rewrites the file on each run.

## Side by side

| | Without the App | With the App |
|---|---|---|
| Version pins | Dependabot's pull request | Dependabot's pull request, and the bot's |
| New or changed files | You run `npx release-kit apply .` in each repo | The bot's pull request, one per repo |
| Merging | `auto-merge.yml`: patch and minor on their own, major waits | The same policy |
| Your part | Merge majors, run apply when a release adds files | Approve each wave, merge majors |
| Setup | Nothing beyond apply | The App, its installs and the `rollout` environment |
| Available to | Anyone | Repos in release-kit's `adopters.json` |

## Setting up the App

**Done 2026-11-02:** the App (ID 5590953) is installed on the first adopters, and the `rollout` environment holds its ID and key.
The steps stay here as the record of the setup.

### Adding an adopter

1. Install the App on the repo: the App's settings, Install App, the account, then add the repo under "Only select repositories".
2. In `adopters.json`, add the repo (or set `"enabled": true` and remove its `reason`), with its branch, visibility, wave and merge policy.
3. Check it with a dry run of Rollout for that repo.

### The first setup

1. Create the App at <https://github.com/settings/apps/new>:
   - GitHub App name: `release-kit bot (n8watkins)`; homepage URL: `https://github.com/n8watkins/release-kit`.
   - Webhook: uncheck "Active" (the bot is driven by the workflow, not by events).
   - Repository permissions: **Contents: Read and write** (push the update branch), **Pull requests: Read and write** (open and update the PR), **Workflows: Read and write** (change files under `.github/workflows/`), **Metadata: Read-only** (required).
     Nothing else, and no account or organization permissions.
   - Where can this GitHub App be installed: "Only on this account".
2. On the App's page, note the **App ID**, then "Generate a private key" and keep the downloaded `.pem` file until step 4.
3. "Install App", choose "Only select repositories", and pick the adopters: n8builds-web, n8builds-admin, dev-portfolio, open-ping, scribe, voicedock, portfolio-rank, tl-dw.
4. In release-kit, Settings, Environments, create `rollout`:
   - Required reviewers: yourself, so every rollout waits for one click.
   - Deployment branches and tags: `main` and the tag pattern `v*` only.
   - Environment variable `RELEASE_KIT_BOT_APP_ID` = the App ID; environment secret `RELEASE_KIT_BOT_KEY` = the full contents of the `.pem` file.
   Then delete the `.pem` file from the computer.
5. Rotate the key yearly from the App's page (generate a new one, update the secret, delete the old one).
