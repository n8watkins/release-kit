#!/usr/bin/env node
// The auto-merge policy (.github/workflows/auto-merge.yml): merge release-kit
// updates and Dependabot patch and minor updates (security ones included) on
// their own once CI passes, and never a major update.
//
//   node scripts/release-kit/automerge.mjs [--fallback true|false] [--method squash|merge|rebase] [--bots "dependabot[bot],my-app[bot]"]
//
// Reads the event from GITHUB_EVENT_NAME and GITHUB_EVENT_PATH, and asks the
// GitHub API (gh, with GH_TOKEN) about the pull request and the repo. Only
// metadata is read: no pull request code runs.
//
//   pull_request   When the base branch requires status checks and the repo
//                  allows auto-merge, it turns on GitHub's auto-merge, which
//                  merges once the required checks pass. Without required
//                  checks auto-merge would merge before CI finishes, so it
//                  skips with a notice.
//   workflow_run   The "merge when green" fallback, for repos that can't
//                  require checks (a private repo on GitHub Free has no
//                  rulesets or branch protection): when a listed workflow
//                  completes, it merges the pull request once every check on
//                  its head commit has finished and passed.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isMain } from './git.mjs'

export const UPDATE_TYPES = ['patch', 'minor', 'major']
const KIT_BRANCH = 'release-kit/'

/** The update types in a Dependabot commit message's "updated-dependencies" metadata. */
export function dependabotUpdates(message) {
  const block = /^updated-dependencies:\n([\s\S]*?)^\.\.\.$/m.exec(message.replace(/\r\n?/g, '\n'))?.[1] ?? ''
  const updates = []
  for (const entry of block.split(/^- /m).slice(1)) {
    const name = /dependency-name:\s*(\S+)/.exec(entry)?.[1]
    const type = /update-type:\s*version-update:semver-(patch|minor|major)/.exec(entry)?.[1]
    if (name) updates.push({ name, type: type ?? null })
  }
  return updates
}

/**
 * patch, minor or major between two x.y.z versions (with or without a "v"),
 * "downgrade" when `to` is lower, or null.
 */
export function semverChange(from, to) {
  const parse = (v) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v ?? '')?.slice(1).map(Number)
  const [a, b] = [parse(from), parse(to)]
  if (!a || !b) return null
  const lower = b.findIndex((n, i) => n !== a[i])
  if (lower !== -1 && b[lower] < a[lower]) return 'downgrade'
  if (a[0] !== b[0]) return 'major'
  if (a[1] !== b[1]) return 'minor'
  if (a[2] !== b[2]) return 'patch'
  return null
}

/** The version a release-kit dev dependency spec pins (github:o/release-kit#v1.2.3), or null. */
export const kitVersion = (spec) => /#v?(\d+\.\d+\.\d+)$/.exec(spec ?? '')?.[1] ?? null

/**
 * What to do with a pull request.
 *   pr        { author, headRef, state, draft, autoMerge }
 *   update    { type: 'patch' | 'minor' | 'major' | null, what: text }
 *   repo      { requiredChecks, allowAutoMerge }
 *   event     'pull_request' or 'workflow_run'
 *   checks    'green' | 'pending' | 'red' (workflow_run only)
 * Returns { action: 'enable' | 'merge' | 'skip', reason }.
 */
export function decide({ pr, update, repo, event, fallback = true, bots = ['dependabot[bot]'], checks }) {
  const skip = (reason) => ({ action: 'skip', reason })
  if (pr.state !== 'open' || pr.draft) return skip('the pull request is not open, or is a draft')
  const dependabot = pr.author === 'dependabot[bot]'
  if (!bots.includes(pr.author)) return skip(`${pr.author} is not one of the update bots (${bots.join(', ')})`)
  if (!dependabot && !pr.headRef.startsWith(KIT_BRANCH)) return skip(`${pr.author}'s pull request is not a release-kit update (branch ${KIT_BRANCH}...)`)
  if (!update.type) return skip(`could not tell what kind of update this is (${update.what || 'no version change found'})`)
  if (update.type === 'downgrade') return skip(`${update.what} would move to an older version: close it (see "Dependabot proposes an older kit" in docs/AUTO_MERGE.md)`)
  if (update.type === 'major') return skip(`${update.what} is a major update: a person reviews and merges it`)
  if (event === 'pull_request') {
    if (!repo.requiredChecks) {
      return skip(`the base branch requires no status checks, so auto-merge would merge before CI finishes${fallback ? '; the merge-when-green fallback merges it once every check passes' : ''}`)
    }
    if (!repo.allowAutoMerge) return skip('the repo does not allow auto-merge: gh api -X PATCH repos/{owner}/{repo} -F allow_auto_merge=true')
    if (pr.autoMerge) return skip('auto-merge is already on')
    return { action: 'enable', reason: `${update.what} is a ${update.type} update; GitHub merges it once the required checks pass` }
  }
  if (event === 'workflow_run') {
    if (repo.requiredChecks) return skip('the base branch requires checks, so GitHub auto-merge handles it')
    if (!fallback) return skip('the merge-when-green fallback is off')
    if (checks === 'pending') return skip('checks are still running; the next completed workflow tries again')
    if (checks === 'red') return skip('a check failed')
    return { action: 'merge', reason: `${update.what} is a ${update.type} update and every check passed` }
  }
  return skip(`nothing to do on a ${event} event`)
}

/**
 * Whether every check on a commit has finished and passed. `runs` are check
 * runs ({ name, status, conclusion }), `statuses` the combined commit status
 * ({ state, total_count }); `ignore` names this workflow's own job.
 */
export function checksState(runs, statuses = { state: 'success', total_count: 0 }, ignore = []) {
  const others = runs.filter((run) => !ignore.includes(run.name))
  if (!others.length && !statuses.total_count) return 'pending'
  if (others.some((run) => run.status !== 'completed') || (statuses.total_count && statuses.state === 'pending')) {
    if (others.some((run) => run.status === 'completed' && !['success', 'neutral', 'skipped'].includes(run.conclusion))) return 'red'
    return 'pending'
  }
  if (others.some((run) => !['success', 'neutral', 'skipped'].includes(run.conclusion))) return 'red'
  if (statuses.total_count && statuses.state !== 'success') return 'red'
  return 'green'
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (name, fallback) => {
    const at = args.indexOf(`--${name}`)
    return at === -1 || args[at + 1] === undefined || args[at + 1] === '' ? fallback : args[at + 1]
  }
  const fallback = valueOf('fallback', 'true') !== 'false'
  const method = valueOf('method', 'squash')
  if (!['squash', 'merge', 'rebase'].includes(method)) throw new Error(`--method must be squash, merge or rebase, not "${method}"`)
  const bots = valueOf('bots', 'dependabot[bot]').split(',').map((b) => b.trim()).filter(Boolean)
  const repoName = process.env.GITHUB_REPOSITORY
  const event = process.env.GITHUB_EVENT_NAME
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const gh = (...ghArgs) => execFileSync('gh', ghArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const api = (path) => JSON.parse(gh('api', '-H', 'Accept: application/vnd.github+json', path))
  const tryApi = (path, fallbackValue) => {
    try {
      return api(path)
    } catch {
      return fallbackValue
    }
  }
  const notice = (text) => console.log(`::notice title=Auto-merge::${text.replace(/\r?\n/g, ' ')}`)

  // The pull request.
  let number = payload.pull_request?.number
  if (event === 'workflow_run') {
    const run = payload.workflow_run ?? {}
    if (run.event !== 'pull_request') return notice(`a ${run.event} run is not a pull request's; nothing to merge`)
    number = run.pull_requests?.[0]?.number
      ?? tryApi(`repos/${repoName}/commits/${run.head_sha}/pulls`, []).find((p) => p.state === 'open' && p.head.sha === run.head_sha)?.number
  }
  if (!number) return notice('no open pull request for this run')
  const raw = api(`repos/${repoName}/pulls/${number}`)
  const pr = { author: raw.user.login, headRef: raw.head.ref, state: raw.state, draft: raw.draft, autoMerge: Boolean(raw.auto_merge) }

  // What it updates: the release-kit pin in package.json, and Dependabot's metadata.
  const fileAt = (path, ref) => {
    const content = tryApi(`repos/${repoName}/contents/${path}?ref=${ref}`, null)?.content
    return content ? Buffer.from(content, 'base64').toString('utf8') : null
  }
  const pinAt = (ref) => {
    try {
      return kitVersion(JSON.parse(fileAt('package.json', ref) ?? '{}').devDependencies?.['release-kit'])
    } catch {
      return null
    }
  }
  const parts = []
  const [fromKit, toKit] = [pinAt(raw.base.sha), pinAt(raw.head.sha)]
  if (fromKit !== toKit) parts.push({ name: 'release-kit', type: semverChange(fromKit, toKit) })
  if (pr.author === 'dependabot[bot]') {
    for (const commit of api(`repos/${repoName}/pulls/${number}/commits?per_page=100`)) parts.push(...dependabotUpdates(commit.commit.message))
  }
  const unknown = parts.find((p) => !p.type)
  const type = parts.some((p) => p.type === 'downgrade') ? 'downgrade'
    : !parts.length || unknown ? null : UPDATE_TYPES[Math.max(...parts.map((p) => UPDATE_TYPES.indexOf(p.type)))]
  const what = [...new Set(parts.map((p) => p.name))].join(', ')

  // The repo: does the base branch require checks, and is auto-merge allowed?
  const rules = tryApi(`repos/${repoName}/rules/branches/${encodeURIComponent(raw.base.ref)}`, [])
  const branch = tryApi(`repos/${repoName}/branches/${encodeURIComponent(raw.base.ref)}`, {})
  const classic = branch.protection?.required_status_checks
  const requiredChecks = rules.some((rule) => rule.type === 'required_status_checks')
    || Boolean(classic && ((classic.contexts ?? []).length || (classic.checks ?? []).length))
  const repo = { requiredChecks, allowAutoMerge: Boolean(raw.base.repo?.allow_auto_merge ?? tryApi(`repos/${repoName}`, {}).allow_auto_merge) }

  let checks
  if (event === 'workflow_run' && !requiredChecks && fallback) {
    const runs = api(`repos/${repoName}/commits/${raw.head.sha}/check-runs?per_page=100`).check_runs
    const statuses = api(`repos/${repoName}/commits/${raw.head.sha}/status`)
    checks = checksState(runs, statuses, ['Auto-merge', 'auto-merge / Auto-merge'])
  }

  const decision = decide({ pr, update: { type, what }, repo, event, fallback, bots, checks })
  if (decision.action === 'enable') {
    gh('pr', 'merge', String(number), '--repo', repoName, '--auto', `--${method}`, '--match-head-commit', raw.head.sha)
    notice(`auto-merge on for #${number}: ${decision.reason}`)
  } else if (decision.action === 'merge') {
    gh('pr', 'merge', String(number), '--repo', repoName, `--${method}`, '--match-head-commit', raw.head.sha)
    notice(`merged #${number}: ${decision.reason}`)
  } else {
    notice(`#${number} left for a person: ${decision.reason}`)
  }
}

if (isMain(import.meta.url)) main()
