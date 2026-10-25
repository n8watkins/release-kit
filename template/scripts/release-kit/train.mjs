#!/usr/bin/env node
// The release train's cut, run by .github/workflows/release-train.yml on the
// commit it planned and checked:
//
//   node scripts/release-kit/train.mjs --version x.y.z [--release-workflow release.yml]
//
// 1. Commits "chore(release): vX.Y.Z" and tags it (release.mjs, no push).
// 2. When .release.json lists train.checks (the workflows whose checks guard
//    main), pushes the release commit to a temporary release-train/vX.Y.Z
//    branch, starts each of them there and waits for them to pass: a commit
//    that fails them is never released. The train starts them itself because
//    pushes made with the workflow's GITHUB_TOKEN start no workflows
//    (workflow_dispatch is the exception).
// 3. Pushes main and the tag in one atomic push. If main moved meanwhile the
//    push is rejected and nothing is released. Branch protection doesn't
//    count checks from runs started with workflow_dispatch, so a protected
//    main only accepts the push from the train's deploy key (protect.mjs),
//    which the checkout sets up when the RELEASE_TRAIN_KEY secret exists.
// 4. Makes sure the Release workflow runs on the tag: a tag pushed with the
//    deploy key starts it by itself; one pushed with the token doesn't, so the
//    train starts it.
//
// Needs the gh CLI with GH_TOKEN (contents: write, actions: write), and
// RELEASE_TRAIN_KEY=true when origin pushes with the deploy key.
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVersion } from './conventional.mjs'
import { git } from './git.mjs'

const args = process.argv.slice(2)
const valueOf = (name) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const fail = (message) => {
  console.error(`train: ${message}`)
  process.exit(1)
}
const WORKFLOW_FILE = /^[\w.-]+\.ya?ml$/
const POLL_MS = Number(process.env.RELEASE_KIT_POLL_MS ?? 10_000)
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const summary = (line) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)

const version = valueOf('version')
if (!isVersion(version)) fail(`--version needs an x.y.z version, not "${version ?? ''}"`)
const tag = `v${version}`
const releaseWorkflow = valueOf('release-workflow') ?? 'release.yml'
const config = existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')) : {}
const checks = config.train?.checks ?? []
for (const file of [releaseWorkflow, ...checks]) {
  if (typeof file !== 'string' || !WORKFLOW_FILE.test(file)) fail(`"${file}" is not a workflow file name, like ci.yml`)
}
const repo = process.env.GITHUB_REPOSITORY
if (!repo) fail('GITHUB_REPOSITORY is not set (this runs in the release train workflow)')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const withKey = process.env.RELEASE_TRAIN_KEY === 'true'

const gh = (...ghArgs) => execFileSync('gh', [...ghArgs, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** Starts `workflow` on `ref`; returns why it couldn't, or null. */
function start(workflow, ref) {
  try {
    gh('workflow', 'run', workflow, '--ref', ref)
    return null
  } catch (error) {
    const reason = error.stderr?.trim() || error.message
    return `could not start ${workflow} on ${ref}: ${reason}${/workflow_dispatch/i.test(reason) ? `\n  add "workflow_dispatch:" to the "on:" of .github/workflows/${workflow}` : ''}`
  }
}

/** The run of `workflow` on `ref` for `sha` started by `event`, once GitHub lists it. */
function findRun(workflow, ref, sha, { event = 'workflow_dispatch', attempts = 60 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const runs = JSON.parse(gh('run', 'list', '--workflow', workflow, '--branch', ref, '--event', event, '--json', 'databaseId,headSha,url', '--limit', '20') || '[]')
    const found = runs.find((run) => run.headSha === sha)
    if (found) return found
    sleep(POLL_MS / 2)
  }
  return null
}

// 1. The release commit and tag, locally.
const release = join(dirname(fileURLToPath(import.meta.url)), 'release.mjs')
const cut = spawnSync(process.execPath, [release, version], { stdio: 'inherit' })
if (cut.status !== 0) fail('could not cut the release')
const sha = git('rev-parse', 'HEAD')
const undo = () => {
  git('tag', '--delete', tag)
  git('reset', '--hard', 'HEAD~1')
}

// 2. The required checks, on the release commit.
if (checks.length) {
  const temp = `release-train/${tag}`
  git('push', '--quiet', '--force', 'origin', `HEAD:refs/heads/${temp}`)
  let failed = null
  try {
    for (const workflow of checks) failed ??= start(workflow, temp)
    for (const workflow of failed ? [] : checks) {
      const run = findRun(workflow, temp, sha)
      if (!run) {
        failed = `${workflow} never started on ${temp}`
        break
      }
      console.log(`train: waiting for ${workflow}: ${run.url}`)
      const watched = spawnSync('gh', ['run', 'watch', String(run.databaseId), '--repo', repo, '--exit-status', '--interval', String(Math.max(1, Math.round(POLL_MS / 1000)))], { stdio: ['ignore', 'ignore', 'inherit'] })
      if (watched.status !== 0) {
        failed = `${workflow} failed on the release commit: ${run.url}`
        break
      }
      summary(`- ${workflow} passed on the release commit: ${run.url}`)
    }
  } finally {
    try {
      git('push', '--quiet', 'origin', '--delete', temp)
    } catch {
      console.error(`train: could not delete the branch ${temp}; delete it by hand`)
    }
  }
  if (failed) {
    undo()
    fail(`${failed}\n  nothing was released; fix main and run the release train again`)
  }
}

// 3. main and the tag together.
try {
  git('push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`)
} catch (error) {
  undo()
  const why = withKey
    ? `did ${branch} move, or does the ruleset on ${branch} leave the train's deploy key off its bypass list?`
    : `did ${branch} move? If ${branch} is protected: GitHub doesn't count checks from runs the train starts, so give the train a deploy key that may bypass the protection (node scripts/release-kit/protect.mjs, see RELEASING.md)`
  fail(`the push was rejected (${why}); nothing was released:\n${error.stderr?.trim() || error.message}`)
}
console.log(`train: pushed ${tag}${withKey ? ' with the deploy key' : ''}`)

// 4. Publish. The tag is out, so a failure here is fixed by running the
// Release workflow on the tag by hand.
const byPush = withKey && findRun(releaseWorkflow, tag, sha, { event: 'push', attempts: 24 })
let url = byPush?.url
if (byPush) {
  console.log(`train: the tag started ${releaseWorkflow}: ${url}`)
} else {
  const notStarted = start(releaseWorkflow, tag)
  if (notStarted) fail(`${notStarted}\n  ${tag} is pushed; run the Release workflow on it by hand (Run workflow, Use workflow from: ${tag})`)
  url = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/workflows/${releaseWorkflow}`
  console.log(`train: started ${releaseWorkflow} on ${tag}: ${url}`)
}
summary(`Cut ${tag}. The [Release workflow](${url}) publishes it.`)
