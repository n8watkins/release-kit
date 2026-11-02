#!/usr/bin/env node
// Protects a repo's release flow with two GitHub rulesets:
//
//   node scripts/release-kit/protect.mjs [--dry-run] [--checks "CI result,check / check"]
//                                        [--admin-bypass] [--rotate-key] [--no-train-key]
//
// Run it as a repo admin, in the repo, with the gh CLI signed in.
//
//   "release-kit: branches"      the default branch and the release branches in
//                                .release.json "branches": no deletion, no force
//                                push, changes only through a pull request (no
//                                approvals needed), and the repo's CI checks must
//                                pass.
//   "release-kit: release tags"  refs/tags/v*: anyone with write access may
//                                create one, nobody may delete or move one.
//
// The required checks are --checks, else .release.json "protect.checks", else
// the ones the ruleset already requires, else
// the GitHub Actions checks that passed on each of the last few merged pull
// requests (a job skipped on some pull requests, like the auto-merge job, is
// left out), else the ones classic branch protection requires.
//
// Nobody bypasses the branch rules, admins included (--admin-bypass lets
// admins through), so an agent signed in as the owner can't push to main
// either. Releases still work:
//
//   npm run release -- --push   the push of the release commit is rejected, so
//                               release.mjs opens a release pull request, merges
//                               it once its checks pass, and tags the merged
//                               commit (see release.mjs).
//   the release train           with a train in .release.json, a write deploy key
//                               "release-kit train" may bypass the branch rules;
//                               its private half is only in the Actions secret
//                               RELEASE_TRAIN_KEY, and the train pushes with it
//                               only after train.checks pass on the release
//                               commit. Made once; --rotate-key replaces it.
//
// Classic branch protection on those branches is removed last (the rulesets
// replace it, and a deploy key can't bypass it), so the branch is never
// unprotected. Rulesets need a public repo, or GitHub Pro for a private one.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMain } from './git.mjs'

export const KEY_TITLE = 'release-kit train'
export const SECRET = 'RELEASE_TRAIN_KEY'
export const BRANCH_RULESET = 'release-kit: branches'
export const TAG_RULESET = 'release-kit: release tags'
// The name protect.mjs used before v2.3.0, for a ruleset on the default branch only.
const LEGACY_RULESET = /^release-kit: protect /
export const GITHUB_ACTIONS_APP = 15368
const ADMIN_ROLE = 5
// How many merged pull requests the required checks are read from.
const SAMPLE = 5

/**
 * The ruleset for the default branch and `branches` (other release branches).
 *   checks        [{ context, integration_id? }]; no integration_id accepts the check from any app
 *   mergeMethods  the repo's allowed merge methods (merge, squash, rebase)
 *   deployKey     let the release train's deploy key through
 *   adminBypass   let repository admins through
 */
export function branchRuleset({ branches = [], checks = [], mergeMethods = ['merge', 'squash', 'rebase'], deployKey = false, adminBypass = false } = {}) {
  const rules = [
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: [...mergeMethods],
      },
    },
  ]
  if (checks.length) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        do_not_enforce_on_create: false,
        required_status_checks: checks.map(({ context, integration_id }) => (integration_id ? { context, integration_id } : { context })),
      },
    })
  }
  return {
    name: BRANCH_RULESET,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH', ...branches.map((b) => `refs/heads/${b}`)], exclude: [] } },
    bypass_actors: [
      ...(deployKey ? [{ actor_type: 'DeployKey', bypass_mode: 'always' }] : []),
      ...(adminBypass ? [{ actor_id: ADMIN_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'always' }] : []),
    ],
    rules,
  }
}

/** The ruleset for release tags: created freely, never deleted or moved. */
export function tagRuleset() {
  return {
    name: TAG_RULESET,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [],
    rules: [{ type: 'deletion' }, { type: 'update' }, { type: 'non_fast_forward' }],
  }
}

// The always-running job a CI with lanes requires instead of its other jobs (docs/CI_LANES.md).
export const AGGREGATE = 'CI result'

/**
 * The checks to require, from the check runs of recent merged pull requests
 * (one array of { name, app: { id }, conclusion, check_suite: { id } } per
 * pull request): the GitHub Actions checks that passed on every one of them.
 * In a workflow with a "CI result" job, only that job counts: the others are
 * skipped by lane, and it stands for them.
 */
export function requiredChecksFrom(pulls) {
  const passed = (runs) => {
    const aggregated = new Set(runs.filter((r) => r.name === AGGREGATE).map((r) => r.check_suite?.id).filter(Boolean))
    return new Set(runs
      .filter((r) => r.app?.id === GITHUB_ACTIONS_APP && r.conclusion === 'success')
      .filter((r) => r.name === AGGREGATE || !aggregated.has(r.check_suite?.id))
      .map((r) => r.name))
  }
  const sets = pulls.map(passed).filter((s) => s.size)
  if (!sets.length) return []
  return [...sets[0]].filter((name) => sets.every((s) => s.has(name))).sort().map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP }))
}

/**
 * Whether a workflow runs on only some pull requests: its pull_request
 * trigger has a paths or paths-ignore filter, or it is an auto-merge
 * workflow (its job is skipped on people's pull requests). A branches filter
 * doesn't count: the pull requests into the protected branch all match it.
 */
export function onlySometimes(workflow) {
  if (/^name:\s*["']?auto-merge/im.test(workflow)) return true
  const trigger = /^ {2}pull_request(?:_target)?:[^\n]*\n((?: {4,}.*\n|\s*\n)*)/m.exec(`${workflow}\n`)?.[1] ?? ''
  return /^ {4}(paths|paths-ignore):/m.test(trigger)
}

/** The parts of a ruleset protect.mjs sets, in a form two rulesets can be compared in. */
function shape(set) {
  const params = (rule, keys) => Object.fromEntries(keys.map((k) => [k, rule.parameters?.[k]]))
  const rules = {}
  for (const rule of set.rules ?? []) {
    if (rule.type === 'pull_request') {
      const p = params(rule, ['required_approving_review_count', 'dismiss_stale_reviews_on_push', 'require_code_owner_review', 'require_last_push_approval', 'required_review_thread_resolution'])
      rules.pull_request = { ...p, allowed_merge_methods: [...(rule.parameters?.allowed_merge_methods ?? ['merge', 'squash', 'rebase'])].sort() }
    } else if (rule.type === 'required_status_checks') {
      rules.required_status_checks = (rule.parameters?.required_status_checks ?? []).map((c) => `${c.context}${c.integration_id ? ` (app ${c.integration_id})` : ''}`).sort()
    } else rules[rule.type] = true
  }
  return {
    enforcement: set.enforcement,
    targets: [...(set.conditions?.ref_name?.include ?? [])].sort(),
    excluded: [...(set.conditions?.ref_name?.exclude ?? [])].sort(),
    bypass: (set.bypass_actors ?? []).map((a) => `${a.actor_type}${a.actor_type === 'DeployKey' ? '' : `:${a.actor_id}`}:${a.bypass_mode}`).sort(),
    rules,
  }
}

/** How the live ruleset differs from the wanted one, in words; [] when it matches. */
export function drift(live, wanted) {
  const [a, b] = [shape(live), shape(wanted)]
  const out = []
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y)
  if (a.enforcement !== b.enforcement) out.push(`enforcement is ${a.enforcement}, not ${b.enforcement}`)
  if (!same(a.targets, b.targets) || !same(a.excluded, b.excluded)) out.push(`it covers ${a.targets.join(', ') || 'nothing'}${a.excluded.length ? ` except ${a.excluded.join(', ')}` : ''}, not ${b.targets.join(', ')}`)
  if (!same(a.bypass, b.bypass)) out.push(`bypass is ${a.bypass.join(', ') || 'nobody'}, not ${b.bypass.join(', ') || 'nobody'}`)
  for (const type of new Set([...Object.keys(a.rules), ...Object.keys(b.rules)])) {
    if (!(type in b.rules)) out.push(`it has a ${type} rule the standard doesn't`)
    else if (!(type in a.rules)) out.push(`the ${type} rule is missing`)
    else if (type === 'required_status_checks' && !same(a.rules[type], b.rules[type])) out.push(`required checks are ${a.rules[type].join(', ')}, not ${b.rules[type].join(', ')}`)
    else if (!same(a.rules[type], b.rules[type])) out.push(`the ${type} rule differs: ${JSON.stringify(a.rules[type])}, not ${JSON.stringify(b.rules[type])}`)
  }
  return out
}

/** A gh-backed GitHub API client; `timeout` in ms. */
export function client({ timeout = 60_000 } = {}) {
  const gh = (args, input) => execFileSync('gh', args, { encoding: 'utf8', input, timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const api = (path, { method = 'GET', body } = {}) => {
    const out = gh(['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body))
    return out ? JSON.parse(out) : null
  }
  /** GET that answers null for a 404 (no protection, no such thing). */
  const maybe = (path) => {
    try {
      return api(path)
    } catch (error) {
      if (/HTTP 404|Not Found|not protected/i.test(error.stderr ?? '')) return null
      throw error
    }
  }
  return { gh, api, maybe }
}

/** The required checks a live ruleset has, as [{ context, integration_id? }]. */
const liveChecks = (set) => (set?.rules ?? []).find((r) => r.type === 'required_status_checks')?.parameters?.required_status_checks ?? []

const readConfig = () => (existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')) : {})
const splitChecks = (list) => list.map((context) => String(context).trim()).filter(Boolean).map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP }))

/** Rulesets need a public repo or GitHub Pro: the API answers 403 with "Upgrade to GitHub Pro". */
export const NOT_AVAILABLE = /Upgrade to GitHub Pro|make this repository public/i

/**
 * Everything protect would do, read from GitHub without changing anything.
 * Returns { repo, branch, wanted: { branches, tags }, existing, checksFrom, ... }.
 */
export function plan({ api, maybe }, repo, { checks: checksFlag, adminBypass = false, trainKey = true, rotateKey = false, discover = true } = {}) {
  const config = readConfig()
  const info = api(`repos/${repo}`)
  const branch = info.default_branch
  const rulesets = api(`repos/${repo}/rulesets?includes_parents=false`) ?? []
  const extra = []
  const missing = []
  for (const b of Array.isArray(config.branches) ? config.branches : []) {
    if (typeof b !== 'string' || !b || b === branch || extra.includes(b)) continue
    if (maybe(`repos/${repo}/branches/${encodeURIComponent(b)}`)) extra.push(b)
    else missing.push(b)
  }

  const classic = maybe(`repos/${repo}/branches/${encodeURIComponent(branch)}/protection`)
  const listed = rulesets.find((r) => r.name === BRANCH_RULESET) ?? rulesets.find((r) => LEGACY_RULESET.test(r.name) && r.target === 'branch')
  const existingBranches = listed ? api(`repos/${repo}/rulesets/${listed.id}`) : null
  let checks
  let checksFrom
  if (checksFlag) {
    checks = splitChecks(checksFlag)
    checksFrom = '--checks'
  } else if (Array.isArray(config.protect?.checks)) {
    checks = splitChecks(config.protect.checks)
    checksFrom = '.release.json "protect.checks"'
  } else if (liveChecks(existingBranches).length) {
    checks = liveChecks(existingBranches)
    checksFrom = `the "${existingBranches.name}" ruleset as it is (--checks changes them)`
  } else if (!discover) {
    checks = []
    checksFrom = 'nothing'
  } else {
    const pulls = (api(`repos/${repo}/pulls?state=closed&base=${encodeURIComponent(branch)}&sort=updated&direction=desc&per_page=50`) ?? [])
      .filter((p) => p.merged_at)
      .sort((x, y) => y.merged_at.localeCompare(x.merged_at))
    const sampled = []
    for (const pull of pulls) {
      if (sampled.length === SAMPLE) break
      const runs = api(`repos/${repo}/commits/${pull.head.sha}/check-runs?per_page=100`)?.check_runs ?? []
      if (runs.some((r) => r.app?.id === GITHUB_ACTIONS_APP)) sampled.push({ number: pull.number, runs })
    }
    // A workflow that runs only on some pull requests can't be required:
    // where it doesn't run, its check never reports and the pull request
    // waits forever (the security scan runs only when a lock file changes).
    const workflowOf = new Map()
    const conditional = new Map()
    const isConditional = (suite) => {
      if (!suite) return false
      if (!workflowOf.has(suite)) workflowOf.set(suite, api(`repos/${repo}/actions/runs?check_suite_id=${suite}&per_page=1`)?.workflow_runs?.[0]?.path ?? null)
      const path = workflowOf.get(suite)
      if (!path) return false
      if (!conditional.has(path)) {
        const content = maybe(`repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(branch)}`)?.content
        conditional.set(path, onlySometimes(content ? Buffer.from(content, 'base64').toString('utf8') : ''))
      }
      return conditional.get(path)
    }
    checks = requiredChecksFrom(sampled.map((s) => s.runs.filter((r) => r.app?.id === GITHUB_ACTIONS_APP && !isConditional(r.check_suite?.id))))
    checksFrom = sampled.length ? `the checks that passed on each of the last ${sampled.length} merged pull requests (${sampled.map((s) => `#${s.number}`).join(', ')})` : 'no merged pull request with GitHub Actions checks'
    if (!checks.length && classic?.required_status_checks?.checks?.length) {
      checks = classic.required_status_checks.checks.map(({ context, app_id }) => ({ context, integration_id: app_id ?? undefined }))
      checksFrom = 'classic branch protection'
    }
  }

  const train = Boolean(config.train) && trainKey
  const quietly = (read, fallback) => {
    try {
      return read()
    } catch {
      return fallback
    }
  }
  // Admin-only reads: without them the key is simply made again.
  const keys = train ? quietly(() => api(`repos/${repo}/keys`) ?? [], []) : []
  const secret = train ? quietly(() => maybe(`repos/${repo}/actions/secrets/${SECRET}`), null) : null
  const makeKey = train && (rotateKey || !secret || !keys.some((k) => k.title === KEY_TITLE && !k.read_only))
  const mergeMethods = [info.allow_merge_commit && 'merge', info.allow_squash_merge && 'squash', info.allow_rebase_merge && 'rebase'].filter(Boolean)
  const wanted = {
    branches: branchRuleset({ branches: extra, checks, mergeMethods, deployKey: train, adminBypass }),
    tags: tagRuleset(),
  }
  const tagsListed = rulesets.find((r) => r.name === TAG_RULESET)
  const existing = { branches: existingBranches, tags: tagsListed ? api(`repos/${repo}/rulesets/${tagsListed.id}`) : null }
  const others = rulesets.filter((r) => r.id !== existing.branches?.id && r.id !== existing.tags?.id)
  return { repo, branch, extra, missing, classic, checks, checksFrom, train, makeKey, keys, wanted, existing, others }
}

/**
 * Warnings for `release-kit check`: the repo's rulesets differ from what
 * protect would set. Never throws; [] when gh can't tell (not installed,
 * signed out, offline, or rulesets not available for the repo).
 */
export function protectionWarnings({ repo, timeout = 10_000 } = {}) {
  try {
    const github = client({ timeout })
    repo ??= github.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
    const rulesets = github.api(`repos/${repo}/rulesets?includes_parents=false`) ?? []
    const kit = rulesets.find((r) => r.name === BRANCH_RULESET || LEGACY_RULESET.test(r.name))
    const tags = rulesets.find((r) => r.name === TAG_RULESET)
    if (!kit && !tags) return [`${repo} has no release-kit rulesets: npx release-kit protect --dry-run shows what it would set`]
    // The checks are compared with .release.json's, or kept as they are:
    // picking them is protect's job. An admin bypass someone chose is kept too.
    const live = kit ? github.api(`repos/${repo}/rulesets/${kit.id}`) : null
    const result = plan(github, repo, { adminBypass: (live?.bypass_actors ?? []).some((a) => a.actor_type === 'RepositoryRole'), discover: false })
    const warnings = []
    for (const key of ['branches', 'tags']) {
      const name = result.wanted[key].name
      if (!result.existing[key]) warnings.push(`${repo} has no "${name}" ruleset`)
      else for (const d of drift(result.existing[key], result.wanted[key])) warnings.push(`${repo} ruleset "${result.existing[key].name}": ${d}`)
    }
    if (warnings.length) warnings.push('npx release-kit protect --dry-run shows the fix, and npx release-kit protect applies it')
    return warnings
  } catch {
    return []
  }
}

function describe(set) {
  const s = shape(set)
  const rules = Object.entries(s.rules).map(([type, value]) => {
    if (type === 'required_status_checks') return `required checks: ${value.join(', ')}`
    if (type === 'pull_request') return `pull request only (${value.required_approving_review_count} approvals; ${value.allowed_merge_methods.join(', ')})`
    return { deletion: 'no deletion', non_fast_forward: 'no force push', update: 'no update' }[type] ?? type
  })
  return [`    on ${set.conditions.ref_name.include.join(', ')}`, `    ${rules.join('; ')}`, `    bypass: ${s.bypass.join(', ') || 'nobody'}`].join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const fail = (message) => {
    console.error(`protect: ${message}`)
    process.exit(1)
  }
  const at = args.indexOf('--checks')
  const checksFlag = at === -1 ? undefined : (args[at + 1] ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  if (at !== -1 && !checksFlag.length) fail('--checks needs check names, like "CI result,check / check"')
  const github = client()

  let repo
  try {
    repo = readConfig().repository ?? github.gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  } catch (error) {
    fail(`could not read the repo with gh (signed in? run it inside the repo): ${error.stderr?.trim() || error.message}`)
  }

  let p
  try {
    p = plan(github, repo, { checks: checksFlag, adminBypass: args.includes('--admin-bypass'), trainKey: !args.includes('--no-train-key'), rotateKey: args.includes('--rotate-key') })
  } catch (error) {
    if (NOT_AVAILABLE.test(error.stderr ?? '')) fail(`${repo} can't have rulesets: GitHub offers them on public repos, and on private ones only with GitHub Pro, Team or Enterprise`)
    fail(error.stderr?.trim() || error.message)
  }

  console.log(`protect: ${repo} (default branch ${p.branch})${dryRun ? ', dry run: nothing changes' : ''}`)
  const actions = []
  for (const key of ['branches', 'tags']) {
    const wanted = p.wanted[key]
    const live = p.existing[key]
    const changes = live ? drift(live, wanted) : []
    const action = !live ? 'create' : changes.length || live.name !== wanted.name ? 'update' : 'unchanged'
    console.log(`  ruleset "${wanted.name}": ${action}${live && live.name !== wanted.name ? ` (now "${live.name}")` : ''}`)
    console.log(describe(wanted))
    for (const c of changes) console.log(`    was: ${c}`)
    if (action !== 'unchanged') actions.push({ key, action, wanted, live })
  }
  console.log(`  required checks from ${p.checksFrom}${p.checks.length ? '' : ': none, so pull requests merge without waiting for CI (pass --checks to name them)'}`)
  if (p.missing.length) console.log(`  .release.json branches not on GitHub, so not protected yet: ${p.missing.join(', ')} (rerun once they exist)`)
  if (p.train) console.log(`  release train: deploy key "${KEY_TITLE}" and secret ${SECRET}: ${p.makeKey ? 'new' : 'kept (--rotate-key replaces them)'}`)
  if (p.classic) console.log(`  classic branch protection on ${p.branch}: removed after the rulesets are active`)
  for (const other of p.others) console.log(`  another ruleset, left alone: "${other.name}" (${other.target}, ${other.enforcement})`)
  console.log(`  releases: npm run release -- --push opens a release pull request and tags it once merged${p.train ? '; the train pushes with its deploy key' : ''}`)
  if (dryRun) return

  // 1. The rulesets, before anything is taken away.
  for (const { action, wanted, live } of actions) {
    if (action === 'create') github.api(`repos/${repo}/rulesets`, { method: 'POST', body: wanted })
    else github.api(`repos/${repo}/rulesets/${live.id}`, { method: 'PUT', body: wanted })
  }

  // 2. The train's key: only its public half is left on this machine, and only briefly.
  if (p.makeKey) {
    const dir = mkdtempSync(join(tmpdir(), 'release-kit-key-'))
    try {
      const file = join(dir, 'key')
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_TITLE, '-f', file])
      for (const key of p.keys) if (key.title === KEY_TITLE) github.api(`repos/${repo}/keys/${key.id}`, { method: 'DELETE' })
      github.api(`repos/${repo}/keys`, { method: 'POST', body: { title: KEY_TITLE, key: readFileSync(`${file}.pub`, 'utf8').trim(), read_only: false } })
      github.gh(['secret', 'set', SECRET, '--repo', repo], readFileSync(file, 'utf8'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // 3. Classic protection would still reject the deploy key.
  if (p.classic) github.api(`repos/${repo}/branches/${encodeURIComponent(p.branch)}/protection`, { method: 'DELETE' })
  console.log('protect: done')
}

if (isMain(import.meta.url)) main()
