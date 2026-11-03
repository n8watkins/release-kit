#!/usr/bin/env node
// The auto-merge policy (.github/workflows/auto-merge.yml): merge release-kit
// updates and Dependabot patch and minor updates (security ones included) on
// their own once CI passes, and never a major update.
//
//   node scripts/release-kit/automerge.mjs [--fallback true|false] [--method squash|merge|rebase] [--bots "dependabot[bot],my-app[bot]"]
//
// Reads the event from GITHUB_EVENT_NAME and GITHUB_EVENT_PATH, and asks the
// GitHub API (gh, with GH_TOKEN) about the pull request and the repo. Only
// metadata is read: no pull request code runs. Each Dependabot dependency's
// kind comes from the update-type in its commit metadata or, when that line is
// missing, from the "from A to B" versions Dependabot names (classifyUpdate).
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
import { appendFileSync, readFileSync } from 'node:fs'
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

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const SHA = /^[0-9a-f]{7,40}$/

/** Semver precedence of two prerelease tags (undefined for a release): negative when a is lower, 0, or positive. */
function comparePrerelease(a, b) {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const [x, y] = [a.split('.'), b.split('.')]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    if (x[i] === y[i]) continue
    const [m, n] = [/^\d+$/.test(x[i]), /^\d+$/.test(y[i])]
    if (m && n) return Number(x[i]) - Number(y[i])
    if (m !== n) return m ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}

/**
 * What moving from one version to another is: { type, why }, where type is
 * patch, minor, major or "downgrade", or null with `why` saying what stops it
 * being read (not semantic versions, commit SHAs, no change, or a move to a
 * prerelease, which promises no compatibility).
 */
export function versionChange(from, to) {
  const [a, b] = [SEMVER.exec(from ?? ''), SEMVER.exec(to ?? '')]
  if (!a || !b) {
    if (SHA.test(from ?? '') || SHA.test(to ?? '')) return { type: null, why: `pinned to commit SHAs with no version (${from} to ${to})` }
    return { type: null, why: `not semantic versions (${from ?? 'none'} to ${to ?? 'none'})` }
  }
  const [x, y] = [a.slice(1, 4).map(Number), b.slice(1, 4).map(Number)]
  const core = x.findIndex((n, i) => n !== y[i])
  const order = core === -1 ? comparePrerelease(b[4], a[4]) : y[core] - x[core]
  if (order < 0) return { type: 'downgrade', why: `${from} to ${to} is a downgrade` }
  if (order === 0) return { type: null, why: `no version change (${from} to ${to})` }
  if (b[4] !== undefined) return { type: null, why: `${to} is a prerelease` }
  // A prerelease to its own release (2.0.0-rc.1 to 2.0.0) is the change the release line makes.
  const at = core !== -1 ? core : y[1] === 0 && y[2] === 0 ? 0 : y[2] === 0 ? 1 : 2
  return { type: UPDATE_TYPES[2 - at], why: `${from} to ${to}` }
}

/**
 * patch, minor or major between two semantic versions (with or without a "v"),
 * "downgrade" when `to` is lower, or null (see versionChange).
 */
export const semverChange = (from, to) => versionChange(from, to).type

/**
 * The "from A to B" lines Dependabot writes in a commit message or pull
 * request body: "Bumps [x](url) from A to B." for one dependency, "Updates `x`
 * from A to B" for each one in a group, and the "| [x](url) | `A` | `B` |"
 * table of a large group. A version written as a commit SHA keeps a version
 * next to it in parentheses when there is one. Returns [{ name, from, to }].
 */
export function dependabotVersions(text) {
  const found = []
  const version = (token, note) => (SHA.test(token) && note && SEMVER.test(note.trim()) ? note.trim() : token)
  const name = '(?:\\[([^\\]]+)\\]\\([^)]*\\)|`([^`]+)`|(\\S+))'
  const ver = '`?([^\\s`()]+?)`?(?:\\s+\\(([^)]*)\\))?'
  const line = new RegExp(`^(?:Bumps|Updates)\\s+${name}\\s+from\\s+${ver}\\s+to\\s+${ver}(?:\\s+in\\s+\\S+)?\\.?\\s*$`, 'gm')
  // A table row names its package as a link, which leaves out the header and divider rows.
  const row = new RegExp(`^\\|\\s*\\[([^\\]]+)\\]\\([^)]*\\)()()\\s*\\|\\s*${ver}\\s*\\|\\s*${ver}\\s*\\|\\s*$`, 'gm')
  const normal = (text ?? '').replace(/\r\n?/g, '\n')
  for (const pattern of [line, row]) {
    for (const m of normal.matchAll(pattern)) {
      if (/^(the|from)$/i.test(m[3] ?? '')) continue
      found.push({ name: m[1] ?? m[2] ?? m[3], from: version(m[4], m[5]), to: version(m[6], m[7]) })
    }
  }
  return found
}

/**
 * What a pull request updates: { type, what, why, parts }.
 *   kit         [from, to]: the release-kit pin on the base and head side
 *   dependabot  whether Dependabot opened it
 *   messages    its commit messages; body: its description
 * Each Dependabot dependency is read from the update-type in its metadata, or,
 * when that line is missing, from the "from A to B" versions Dependabot names
 * (commit messages first, then the description). A group takes its biggest
 * change; any downgrade makes it a downgrade, anything unreadable makes the
 * type null with `why` saying what.
 */
export function classifyUpdate({ kit = [null, null], dependabot = false, messages = [], body = '' }) {
  const parts = []
  if (kit[0] !== kit[1]) parts.push({ name: 'release-kit', ...versionChange(kit[0], kit[1]), source: 'the package.json pin' })
  if (dependabot) {
    const fromCommits = messages.flatMap(dependabotVersions)
    const named = [...fromCommits, ...dependabotVersions(body)]
    const read = (v, source) => ({ name: v.name, ...versionChange(v.from, v.to), source })
    const metadata = messages.flatMap(dependabotUpdates)
    for (const entry of metadata) {
      if (entry.type) {
        parts.push({ name: entry.name, type: entry.type, why: 'its update-type', source: 'Dependabot metadata' })
        continue
      }
      const versions = named.find((v) => v.name === entry.name)
      parts.push(versions ? read(versions, 'the versions Dependabot names') : { name: entry.name, type: null, why: `${entry.name} has no update-type and no "from A to B" line` })
    }
    if (!metadata.length) {
      for (const v of fromCommits.length ? fromCommits : dependabotVersions(body)) parts.push(read(v, 'the versions Dependabot names'))
    }
  }
  const what = [...new Set(parts.map((p) => p.name))].join(', ')
  const downgrade = parts.find((p) => p.type === 'downgrade')
  if (downgrade) return { type: 'downgrade', what, why: `${downgrade.name}: ${downgrade.why}`, parts }
  if (!parts.length) return { type: null, what, why: 'no version change found', parts }
  const unknown = parts.find((p) => !p.type)
  if (unknown) return { type: null, what, why: unknown.why.startsWith(unknown.name) ? unknown.why : `${unknown.name}: ${unknown.why}`, parts }
  return { type: UPDATE_TYPES[Math.max(...parts.map((p) => UPDATE_TYPES.indexOf(p.type)))], what, why: '', parts }
}

/** The version a release-kit dev dependency spec pins (github:o/release-kit#v1.2.3), or null. */
export const kitVersion = (spec) => /#v?(\d+\.\d+\.\d+)$/.exec(spec ?? '')?.[1] ?? null

/**
 * What to do with a pull request.
 *   pr        { author, headRef, state, draft, autoMerge }
 *   update    { type: 'patch' | 'minor' | 'major' | 'downgrade' | null, what: text, why: text }
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
  if (!update.type) return skip(`could not tell what kind of update this is (${update.why || update.what || 'no version change found'})`)
  if (update.type === 'downgrade') return skip(`${update.what} would move to an older version (${update.why || 'a downgrade'}): close it (see "Dependabot proposes an older kit" in docs/AUTO_MERGE.md)`)
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
  // A notice on the run, and the same line plus how each dependency was read in the job summary.
  const notice = (text, parts = []) => {
    console.log(`::notice title=Auto-merge::${text.replace(/\r?\n/g, ' ')}`)
    if (!process.env.GITHUB_STEP_SUMMARY) return
    const rows = parts.map((p) => `| ${p.name} | ${p.type ?? 'unknown'} | ${p.why}${p.source ? ` (${p.source})` : ''} |`.replaceAll('\n', ' '))
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## Auto-merge', '', text, '', ...(rows.length ? ['| Dependency | Update | Read from |', '|---|---|---|', ...rows, ''] : [])].join('\n') + '\n')
  }

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
  const messages = pr.author === 'dependabot[bot]' ? api(`repos/${repoName}/pulls/${number}/commits?per_page=100`).map((c) => c.commit.message) : []
  const update = classifyUpdate({ kit: [pinAt(raw.base.sha), pinAt(raw.head.sha)], dependabot: pr.author === 'dependabot[bot]', messages, body: raw.body ?? '' })

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

  const decision = decide({ pr, update, repo, event, fallback, bots, checks })
  if (decision.action === 'enable') {
    gh('pr', 'merge', String(number), '--repo', repoName, '--auto', `--${method}`, '--match-head-commit', raw.head.sha)
    notice(`auto-merge on for #${number}: ${decision.reason}`, update.parts)
  } else if (decision.action === 'merge') {
    gh('pr', 'merge', String(number), '--repo', repoName, `--${method}`, '--match-head-commit', raw.head.sha)
    notice(`merged #${number}: ${decision.reason}`, update.parts)
  } else {
    notice(`#${number} left for a person: ${decision.reason}`, update.parts)
  }
}

if (isMain(import.meta.url)) main()
