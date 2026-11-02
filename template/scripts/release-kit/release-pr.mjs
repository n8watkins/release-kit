// A release through a pull request, for a branch whose rules accept changes
// only through pull requests (npx release-kit protect sets that up).
//
// release.mjs has made the release commit locally. This pushes it to a
// release/vX.Y.Z branch, opens a pull request, waits for its checks, merges
// it, checks that the merged commit has exactly the release commit's files,
// and only then tags the merged commit and pushes the tag. If the checks fail
// or time out, the pull request is closed, its branch deleted, and the local
// release commit undone, so a rerun starts clean.
import { execFileSync } from 'node:child_process'
import { git } from './git.mjs'

const FAILED = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const MERGEABLE = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])

/** A push rejected by a ruleset or branch protection, not by a network or auth problem. */
export const RULE_REJECTION = /GH013|rule violations|must be made through a pull request|protected branch hook declined|Protected branch update failed/i

/**
 * What a pull request's checks say: 'failed', 'pending' or 'passed'.
 * `rollup` is gh's statusCheckRollup: check runs ({ status, conclusion }) and
 * commit statuses ({ state }).
 */
export function rollupState(rollup = []) {
  if (rollup.some((c) => FAILED.has(c.conclusion) || FAILED.has(c.state))) return 'failed'
  if (rollup.some((c) => (c.status !== undefined && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state))) return 'pending'
  return 'passed'
}

/**
 * Whether to merge now: 'merge', 'wait', or a reason to give up.
 * `waited` is how long the pull request has been open, in seconds: a pull
 * request with no checks yet gets `grace` seconds for its workflows to start.
 */
export function readiness({ state, mergeStateStatus, statusCheckRollup }, waited, grace = 60) {
  if (state !== 'OPEN') return `the pull request is ${String(state).toLowerCase()}`
  if (mergeStateStatus === 'DIRTY') return 'the pull request has conflicts'
  const checks = rollupState(statusCheckRollup)
  if (checks === 'failed') return 'a check failed'
  if (checks === 'pending' || (!statusCheckRollup?.length && waited < grace)) return 'wait'
  return MERGEABLE.has(mergeStateStatus) ? 'merge' : 'wait'
}

const sleep = (seconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)

export function releaseThroughPullRequest({ branch, tag, section, timeoutMinutes = 30 }) {
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const poll = Number(process.env.RELEASE_KIT_PR_POLL ?? 10)
  const grace = Number(process.env.RELEASE_KIT_PR_GRACE ?? 60)
  const releaseSha = git('rev-parse', 'HEAD')
  const head = `release/${tag}`
  const title = `chore(release): ${tag}`
  const say = (text) => console.log(`release: ${text}`)
  const undo = () => {
    try {
      git('tag', '--delete', tag)
    } catch {}
    git('reset', '--hard', 'HEAD~1')
  }
  const giveUp = (number, reason) => {
    try {
      gh('pr', 'close', String(number), '--delete-branch', '--comment', `Closed by npm run release: ${reason}. Nothing was tagged; fix the cause and release again.`)
    } catch {}
    undo()
    throw new Error(`${reason}, so release pull request #${number} was closed and the release commit undone; nothing was tagged`)
  }

  // The tag is made again on the merged commit.
  git('tag', '--delete', tag)
  try {
    git('push', 'origin', `HEAD:refs/heads/${head}`)
  } catch (error) {
    git('reset', '--hard', 'HEAD~1')
    throw new Error(`could not push ${head}: ${error.stderr?.trim() || error.message}`)
  }
  const body = [
    `The release commit for ${tag}, made by \`npm run release -- --push\`.`,
    `${branch} accepts changes only through pull requests, so the release goes through one; once its checks pass it is merged and the merged commit is tagged ${tag}.`,
    '',
    '<details><summary>Release notes</summary>',
    '',
    section,
    '</details>',
  ].join('\n')
  let url
  try {
    url = gh('pr', 'create', '--base', branch, '--head', head, '--title', title, '--body', body)
  } catch (error) {
    try {
      git('push', 'origin', '--delete', head)
    } catch {}
    git('reset', '--hard', 'HEAD~1')
    throw new Error(`could not open the release pull request: ${error.stderr?.trim() || error.message}`)
  }
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1])
  say(`${branch} takes changes only through pull requests: opened ${url}, waiting for its checks (up to ${timeoutMinutes} minutes)`)

  const started = Date.now()
  for (;;) {
    const waited = (Date.now() - started) / 1000
    let pr
    try {
      pr = JSON.parse(gh('pr', 'view', String(number), '--json', 'state,mergeStateStatus,statusCheckRollup'))
    } catch (error) {
      pr = { state: 'OPEN', mergeStateStatus: 'UNKNOWN', statusCheckRollup: [] }
      console.error(`release: could not read #${number} (${error.stderr?.trim() || error.message}); trying again`)
    }
    const next = readiness(pr, waited, grace)
    if (next === 'merge') break
    if (next !== 'wait') giveUp(number, next)
    if (waited > timeoutMinutes * 60) giveUp(number, `its checks didn't pass within ${timeoutMinutes} minutes (--pr-timeout <minutes> waits longer)`)
    sleep(poll)
  }

  const allowed = JSON.parse(gh('repo', 'view', '--json', 'squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed'))
  const method = allowed.squashMergeAllowed ? 'squash' : allowed.mergeCommitAllowed ? 'merge' : 'rebase'
  const message = method === 'rebase' ? [] : ['--subject', title, '--body', `The ${tag} release commit: version and changelog.`]
  try {
    gh('pr', 'merge', String(number), `--${method}`, '--match-head-commit', releaseSha, ...message)
  } catch (error) {
    giveUp(number, `merging failed (${error.stderr?.trim() || error.message})`)
  }
  const merged = gh('pr', 'view', String(number), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid')
  git('fetch', '--quiet', 'origin', `refs/heads/${branch}`)
  try {
    git('push', 'origin', '--delete', head)
  } catch {}

  // The merged commit must hold exactly what was released: if branch moved
  // while the checks ran, it also holds work the notes don't list.
  if (git('rev-parse', `${merged}^{tree}`) !== git('rev-parse', `${releaseSha}^{tree}`)) {
    throw new Error(`#${number} merged as ${merged.slice(0, 12)}, but ${branch} had moved meanwhile, so that commit has more than the release; ${tag} was not tagged.
  Tag it by hand once you have checked the notes cover it:  git tag -a --cleanup=verbatim ${tag} ${merged} (notes from CHANGELOG.md), then git push origin ${tag}`)
  }
  git('tag', '-a', '--cleanup=verbatim', tag, merged, '-m', `${tag}\n\n${section}`)
  git('push', 'origin', `refs/tags/${tag}`)
  // The local branch moves to the merged commit: same files, so nothing is lost.
  git('reset', '--keep', merged)
  say(`merged #${number} and pushed ${tag}; the Release workflow publishes it`)
}
