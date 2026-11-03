// A release through a pull request, for a branch whose rules accept changes
// only through pull requests (npx release-kit protect sets that up).
//
// release.mjs has made the release commit locally. This pushes it to a
// release/vX.Y.Z branch, opens a pull request, waits for its checks, merges
// it, checks that the merged commit has exactly the release commit's files,
// and only then tags the merged commit and pushes the tag. Only what gates the
// merge is judged: the branch's required checks, or, when it requires none,
// the GitHub Actions checks; a failing deploy preview or another app's status
// is reported and ignored. If a gating check fails or the wait times out, the
// pull request is closed, its branch deleted, and the local release commit
// undone, so a rerun starts clean.
import { execFileSync } from 'node:child_process'
import { git } from './git.mjs'

const MERGEABLE = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE'])
const PASSED = new Set(['success', 'neutral', 'skipped'])
/** The GitHub App that reports GitHub Actions jobs. */
const ACTIONS = 'github-actions'

/**
 * A push rejected by a ruleset or branch protection, or by the kit's pre-push
 * guard (guard.mjs: the release would carry unpushed commits along), not by a
 * network or auth problem.
 */
export const RULE_REJECTION = /GH013|rule violations|must be made through a pull request|protected branch hook declined|Protected branch update failed|release-kit: push blocked/i

/**
 * The checks that gate a merge into the branch, as [{ context, appId }]:
 * the required_status_checks of its effective rules (GET
 * repos/{o}/{r}/rules/branches/{branch}, which covers rulesets at every
 * level) and of classic branch protection. `rules` is null when they couldn't
 * be read.
 */
export function requiredChecks(rules, classic) {
  const found = new Map()
  const add = (context, appId) => {
    if (!context) return
    const key = `${context}\0${appId ?? ''}`
    if (!found.has(key)) found.set(key, { context, appId: appId ?? undefined })
  }
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule.type !== 'required_status_checks') continue
    for (const check of rule.parameters?.required_status_checks ?? []) add(check.context, check.integration_id)
  }
  for (const check of classic?.checks ?? []) add(check.context, check.app_id)
  for (const context of classic?.contexts ?? []) if (!(classic?.checks ?? []).some((c) => c.context === context)) add(context)
  return [...found.values()]
}

/** 'passed', 'pending' or 'failed', for a check run or a commit status as the REST API returns them. */
export function stateOf(check) {
  if (check.kind === 'status') return check.state === 'success' ? 'passed' : check.state === 'pending' ? 'pending' : 'failed'
  if (check.status !== 'completed') return 'pending'
  return PASSED.has(check.conclusion) ? 'passed' : 'failed'
}

const label = (check) => check.kind === 'status'
  ? `${check.context} (commit status${check.description ? `: ${check.description}` : ''})`
  : `${check.name} (${check.app === ACTIONS ? 'GitHub Actions' : check.app ?? 'check run'}${check.conclusion ? `: ${check.conclusion}` : ''})`

/**
 * Judges the release pull request's head commit by only what gates its merge.
 *
 * With required checks (`required`, from requiredChecks), each of them must
 * report and pass; one that hasn't reported yet is `missing` and waited for.
 * With none (a private repo on GitHub Free, say), the GitHub Actions check
 * runs are what gates it, and any workflow run still in flight is waited for
 * (a job that `needs` another gets its check run only once that one is done).
 * Commit statuses and other apps' check runs (Vercel, GitGuardian, ...) gate
 * only when the rules require them; their failures are listed in `ignored`.
 *
 * `checks` is [{ kind: 'run', id, name, app, appId, status, conclusion }] and
 * [{ kind: 'status', context, state, description }]; `workflows` is
 * [{ name, status, conclusion }] from the Actions runs API.
 */
export function judge({ required, checks: all = [], workflows = [] }) {
  // A rerun leaves the older check run behind: like GitHub, count the latest of each name.
  const latest = new Map()
  for (const c of all) {
    const key = c.kind === 'status' ? `status\0${c.context}` : `run\0${c.name}\0${c.appId ?? ''}`
    if (!latest.has(key) || (c.id ?? 0) > (latest.get(key).id ?? 0)) latest.set(key, c)
  }
  const checks = [...latest.values()]
  const gating = new Set()
  const result = { state: 'passed', mode: required.length ? 'required' : 'actions', waitingFor: [], failed: [], missing: [], pending: [], ignored: [] }
  if (required.length) {
    for (const want of required) {
      const reports = checks.filter((c) => c.kind === 'status'
        ? c.context === want.context
        : c.name === want.context && (!want.appId || c.appId === want.appId))
      reports.forEach((c) => gating.add(c))
      result.waitingFor.push(want.context)
      const states = reports.map(stateOf)
      if (!reports.length) result.missing.push(want.context)
      else if (states.includes('failed')) result.failed.push(label(reports.find((c) => stateOf(c) === 'failed')))
      else if (states.includes('pending')) result.pending.push(want.context)
    }
  } else {
    for (const run of checks.filter((c) => c.kind === 'run' && c.app === ACTIONS)) {
      gating.add(run)
      result.waitingFor.push(run.name)
      const state = stateOf(run)
      if (state === 'failed') result.failed.push(label(run))
      else if (state === 'pending') result.pending.push(run.name)
    }
    // Its jobs' check runs carry the verdict; a workflow still running may yet add jobs.
    for (const run of workflows) if (run.status !== 'completed') result.pending.push(`the ${run.name} workflow`)
  }
  result.ignored = checks.filter((c) => !gating.has(c) && stateOf(c) === 'failed').map(label)
  result.waitingFor = [...new Set(result.waitingFor)]
  if (result.failed.length) result.state = 'failed'
  else if (result.missing.length || result.pending.length) result.state = 'pending'
  return result
}

/**
 * Whether to merge now: 'merge', 'wait', or a reason to give up.
 * `verdict` is what judge() says of its checks. `waited` is how long the pull
 * request has been open, in seconds: without required checks, its workflows
 * get `grace` seconds to start before an all-green (or empty) set counts.
 */
export function readiness({ state, mergeStateStatus }, verdict, waited, grace = 60) {
  if (state !== 'OPEN') return `the pull request is ${String(state).toLowerCase()}`
  if (mergeStateStatus === 'DIRTY') return 'the pull request has conflicts'
  if (verdict.state === 'failed') {
    const what = verdict.mode === 'required' ? 'a required check' : 'a GitHub Actions check'
    return `${what} failed: ${verdict.failed.join(', ')}`
  }
  if (verdict.state === 'pending' || (verdict.mode === 'actions' && waited < grace)) return 'wait'
  return MERGEABLE.has(mergeStateStatus) ? 'merge' : 'wait'
}

/** Why a release pull request that never became ready timed out. */
export function timeoutReason({ mergeStateStatus }, verdict, minutes) {
  const more = '(--pr-timeout <minutes> waits longer)'
  if (verdict.missing.length) {
    const list = verdict.missing.map((c) => `"${c}"`).join(', ')
    return `its checks didn't pass within ${minutes} minutes: the required ${verdict.missing.length === 1 ? 'check' : 'checks'} ${list} never reported (check that the workflow behind ${verdict.missing.length === 1 ? 'it' : 'them'} runs on pull requests and that the name matches the branch rules) ${more}`
  }
  if (verdict.pending.length) return `its checks didn't pass within ${minutes} minutes: still waiting for ${verdict.pending.join(', ')} ${more}`
  return `its checks didn't pass within ${minutes} minutes: they passed, but GitHub still says it can't merge (${String(mergeStateStatus).toLowerCase()}) ${more}`
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

  // What gates the merge: the branch's required checks, read once.
  const slug = /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? '{owner}/{repo}'
  const api = (path, jq) => gh('api', path, ...(jq ? ['--paginate', '--jq', jq] : []))
  const lines = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  let rules = null
  try {
    rules = JSON.parse(api(`repos/${slug}/rules/branches/${encodeURIComponent(branch)}`))
  } catch (error) {
    say(`could not read ${branch}'s rules (${error.stderr?.trim().split('\n')[0] || error.message}), so only GitHub Actions checks gate the release`)
  }
  let classic = null
  try {
    classic = JSON.parse(api(`repos/${slug}/branches/${encodeURIComponent(branch)}`)).protection?.required_status_checks ?? null
  } catch {}
  const required = requiredChecks(rules, classic)
  say(required.length
    ? `waiting for ${branch}'s required checks: ${required.map((c) => c.context).join(', ')}; other checks and commit statuses don't gate the release`
    : `${branch} requires no checks, so every GitHub Actions check gates the release; commit statuses and other apps' checks (Vercel, GitGuardian, ...) don't`)

  const readChecks = () => {
    const runs = lines(api(`repos/${slug}/commits/${releaseSha}/check-runs?per_page=100`, '.check_runs[] | { kind: "run", id, name, app: .app.slug, appId: .app.id, status, conclusion }'))
    const statuses = lines(api(`repos/${slug}/commits/${releaseSha}/status?per_page=100`, '.statuses[] | { kind: "status", context, state, description }'))
    const workflows = required.length ? [] : lines(api(`repos/${slug}/actions/runs?head_sha=${releaseSha}&per_page=100`, '.workflow_runs[] | { name, status, conclusion }'))
    return judge({ required, checks: [...runs, ...statuses], workflows })
  }

  const started = Date.now()
  const told = new Set()
  let pr
  let verdict = judge({ required, checks: [] })
  for (;;) {
    const waited = (Date.now() - started) / 1000
    try {
      pr = JSON.parse(gh('pr', 'view', String(number), '--json', 'state,mergeStateStatus'))
      verdict = readChecks()
    } catch (error) {
      pr = { state: 'OPEN', mergeStateStatus: 'UNKNOWN' }
      console.error(`release: could not read #${number} or its checks (${error.stderr?.trim() || error.message}); trying again`)
    }
    for (const ignored of verdict.ignored.filter((c) => !told.has(c))) {
      told.add(ignored)
      say(`ignoring a failure that doesn't gate the merge: ${ignored}`)
    }
    const next = readiness(pr, verdict, waited, grace)
    if (next === 'merge') break
    if (next !== 'wait') giveUp(number, next)
    if (waited > timeoutMinutes * 60) giveUp(number, timeoutReason(pr, verdict, timeoutMinutes))
    sleep(poll)
  }
  say(verdict.waitingFor.length
    ? `checks passed: ${verdict.waitingFor.join(', ')}${verdict.ignored.length ? `; ignored, since they don't gate the merge: ${verdict.ignored.join(', ')}` : ''}`
    : `no GitHub Actions checks ran on #${number}${verdict.ignored.length ? `; ignored, since they don't gate the merge: ${verdict.ignored.join(', ')}` : ''}`)

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
