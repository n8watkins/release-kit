// protect.mjs against a fake gh: what it asks GitHub to do, in what order,
// that it reads the required checks from recent pull requests, and that the
// train's private key ends up only in the secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, tmp } from './helpers.mjs'
import { BRANCH_RULESET, TAG_RULESET, branchRuleset, drift, protectionWarnings, requiredChecksFrom, tagRuleset } from '../template/scripts/release-kit/protect.mjs'

const ACTIONS = { id: 15368 }
const run = (name, conclusion = 'success', app = ACTIONS) => ({ name, conclusion, status: 'completed', app })
// Three merged pull requests: the auto-merge job is skipped on people's pull
// requests and the security scan runs only when a lock file changes, so
// neither is on every one; #1 has only a third-party check.
const PULLS = [
  { number: 3, merged_at: '2026-11-03T00:00:00Z', head: { sha: 'c3' } },
  { number: 4, merged_at: null, head: { sha: 'c4' } },
  { number: 2, merged_at: '2026-11-02T00:00:00Z', head: { sha: 'c2' } },
  { number: 1, merged_at: '2026-11-01T00:00:00Z', head: { sha: 'c1' } },
]
const RUNS = {
  c3: [run('CI result'), run('check / check'), run('auto-merge / Auto-merge', 'skipped'), run('osv / OSV-Scanner')],
  c2: [run('CI result'), run('check / check'), run('auto-merge / Auto-merge', 'success')].concat([run('Vercel', 'success', { id: 8329 })]),
  c1: [run('Vercel', 'success', { id: 8329 })],
}

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const env = process.env
const state = JSON.parse(env.FAKE_STATE)
const input = args.includes('--input') || args[0] === 'secret' ? readFileSync(0, 'utf8') : ''
appendFileSync(env.FAKE_GH_LOG, JSON.stringify({ args, input }) + '\\n')
const say = (value) => process.stdout.write(JSON.stringify(value))
const missing = () => { console.error('gh: Not Found (HTTP 404)'); process.exit(1) }
if (args[0] === 'repo') process.stdout.write('o/r')
else if (args[0] === 'secret') {}
else if (args[0] === 'api') {
  const method = args[args.indexOf('-X') + 1]
  const path = args.find((a, i) => i > 0 && /^repos\\//.test(a))
  if (method !== 'GET') say({ id: 99 })
  else if (path.startsWith('repos/o/r/rulesets') && state.private) { console.error('gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'); process.exit(1) }
  else if (path === 'repos/o/r') say({ default_branch: 'main', allow_squash_merge: true, allow_merge_commit: false, allow_rebase_merge: false })
  else if (path.startsWith('repos/o/r/rulesets?')) say((state.rulesets ?? []).map(({ id, name, target, enforcement }) => ({ id, name, target, enforcement })))
  else if (path.startsWith('repos/o/r/rulesets/')) say(state.rulesets.find((r) => String(r.id) === path.split('/').pop()))
  else if (path === 'repos/o/r/branches/main/protection') state.classic ? say(state.classic) : (console.error('gh: Branch not protected (HTTP 404)'), process.exit(1))
  else if (path.startsWith('repos/o/r/branches/')) (state.branches ?? []).includes(decodeURIComponent(path.split('/').pop())) ? say({}) : missing()
  else if (path.startsWith('repos/o/r/pulls?')) say(state.pulls ?? [])
  else if (/^repos\\/o\\/r\\/commits\\/\\w+\\/check-runs/.test(path)) say({ check_runs: (state.runs ?? {})[path.split('/')[4]] ?? [] })
  else if (path === 'repos/o/r/keys') say(state.keys ?? [])
  else if (path === 'repos/o/r/actions/secrets/RELEASE_TRAIN_KEY') state.secret ? say({ name: 'RELEASE_TRAIN_KEY' }) : missing()
  else missing()
}
`

function fakeGh(state) {
  const bin = tmp('protect-bin')
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const log = join(bin, 'log')
  writeFileSync(log, '')
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_STATE: JSON.stringify(state) }
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { env, calls }
}

function protect(args = [], state = {}, config = {}) {
  const dir = tmp('protect')
  writeFileSync(join(dir, '.release.json'), JSON.stringify(config))
  const scratch = tmp('protect-tmp')
  const gh = fakeGh({ pulls: PULLS, runs: RUNS, ...state })
  const result = attempt(dir, 'node', [join(KIT, 'template/scripts/release-kit/protect.mjs'), ...args], { ...gh.env, TMPDIR: scratch })
  return { ...result, calls: gh.calls(), leftovers: readdirSync(scratch) }
}

const writes = (calls) => calls.filter(({ args }) => args[0] === 'secret' || (args[0] === 'api' && args[args.indexOf('-X') + 1] !== 'GET'))
const describe = ({ args }) => (args[0] === 'secret' ? `secret ${args[2]}` : `${args[args.indexOf('-X') + 1]} ${args.find((a) => a.startsWith('repos/'))}`)
const CHECKS = [{ context: 'CI result', integration_id: 15368 }, { context: 'check / check', integration_id: 15368 }]

test('the required checks are the GitHub Actions checks that passed on every recent merged pull request', () => {
  assert.deepEqual(requiredChecksFrom([RUNS.c3, RUNS.c2]), CHECKS)
  // A pull request with no Actions checks says nothing either way.
  assert.deepEqual(requiredChecksFrom([RUNS.c3, RUNS.c1]), requiredChecksFrom([RUNS.c3]))
  assert.deepEqual(requiredChecksFrom([]), [])
  // A CI with lanes: its "CI result" job stands for the jobs in the same workflow run.
  const suite = (name, id, conclusion) => ({ ...run(name, conclusion), check_suite: { id } })
  const lanes = [suite('CI result', 1), suite('E2E (webkit 1/2)', 1), suite('Lint', 1), suite('check / check', 2)]
  assert.deepEqual(requiredChecksFrom([lanes]).map((c) => c.context), ['CI result', 'check / check'])
})

test('the rulesets: the default and release branches take pull requests only, release tags never move', () => {
  const set = branchRuleset({ branches: ['review/v1'], checks: CHECKS, mergeMethods: ['squash'] })
  assert.equal(set.name, BRANCH_RULESET)
  assert.deepEqual(set.conditions.ref_name.include, ['~DEFAULT_BRANCH', 'refs/heads/review/v1'])
  assert.deepEqual(set.rules.map((rule) => rule.type), ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'])
  assert.equal(set.rules[2].parameters.required_approving_review_count, 0)
  assert.deepEqual(set.rules[2].parameters.allowed_merge_methods, ['squash'])
  // Nobody bypasses it unless asked: not admins, and the deploy key only with a train.
  assert.deepEqual(set.bypass_actors, [])
  assert.deepEqual(branchRuleset({ deployKey: true, adminBypass: true }).bypass_actors, [
    { actor_type: 'DeployKey', bypass_mode: 'always' },
    { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
  ])
  assert.deepEqual(branchRuleset().rules.map((rule) => rule.type), ['deletion', 'non_fast_forward', 'pull_request'])
  const tags = tagRuleset()
  assert.equal(tags.name, TAG_RULESET)
  assert.deepEqual(tags.conditions.ref_name.include, ['refs/tags/v*'])
  assert.deepEqual(tags.rules.map((rule) => rule.type), ['deletion', 'update', 'non_fast_forward'])
  assert.deepEqual(tags.bypass_actors, [])
})

test('drift: what GitHub adds is ignored, what differs is named', () => {
  const wanted = branchRuleset({ checks: CHECKS, mergeMethods: ['squash'] })
  // GitHub answers with ids and extra parameters protect doesn't set.
  const live = structuredClone({ ...wanted, id: 1, source: 'o/r' })
  live.rules[2].parameters.required_reviewers = []
  live.rules[2].parameters.require_extra_approval_for_unattributed_changes = false
  assert.deepEqual(drift(live, wanted), [])
  live.bypass_actors = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]
  live.rules = live.rules.filter((rule) => rule.type !== 'pull_request')
  live.rules.at(-1).parameters.required_status_checks = [{ context: 'test' }]
  assert.deepEqual(drift(live, wanted), [
    'bypass is RepositoryRole:5:always, not nobody',
    'required checks are test, not CI result (app 15368), check / check (app 15368)',
    'the pull_request rule is missing',
  ])
})

test('--dry-run reads the plan, checks and all, and changes nothing', () => {
  const result = protect(['--dry-run'], { branches: ['review/v1'] }, { branches: ['main', 'review/v1', 'gone'] })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(writes(result.calls), [])
  assert.match(result.stdout, /ruleset "release-kit: branches": create\n {4}on ~DEFAULT_BRANCH, refs\/heads\/review\/v1\n {4}no deletion; no force push; pull request only \(0 approvals; squash\); required checks: CI result \(app 15368\), check \/ check \(app 15368\)\n {4}bypass: nobody/)
  assert.match(result.stdout, /ruleset "release-kit: release tags": create/)
  assert.match(result.stdout, /required checks from the checks that passed on each of the last 2 merged pull requests \(#3, #2\)/)
  assert.match(result.stdout, /not on GitHub, so not protected yet: gone/)
  assert.match(result.stdout, /npm run release -- --push opens a release pull request/)
})

test('a repo without a train gets both rulesets and nothing else', () => {
  const done = protect([], { branches: ['review/v1'] }, { branches: ['review/v1'] })
  assert.equal(done.status, 0, done.stderr)
  const w = writes(done.calls)
  assert.deepEqual(w.map(describe), ['POST repos/o/r/rulesets', 'POST repos/o/r/rulesets'])
  assert.deepEqual(JSON.parse(w[0].input), branchRuleset({ branches: ['review/v1'], checks: CHECKS, mergeMethods: ['squash'] }))
  assert.deepEqual(JSON.parse(w[1].input), tagRuleset())
  assert.match(done.stdout, /protect: done/)
})

test('with a train it adds the deploy key and its bypass, then moves off classic protection, never leaving main unprotected', () => {
  const classic = { required_status_checks: { checks: [{ context: 'old', app_id: null }] } }
  const result = protect([], { classic, keys: [{ id: 7, title: 'release-kit train', read_only: false }, { id: 8, title: 'someone else' }] }, { train: { schedule: '0 16 * * 1' } })
  assert.equal(result.status, 0, result.stderr)
  const done = writes(result.calls)
  assert.deepEqual(done.map(describe), [
    'POST repos/o/r/rulesets',
    'POST repos/o/r/rulesets',
    'DELETE repos/o/r/keys/7',
    'POST repos/o/r/keys',
    'secret RELEASE_TRAIN_KEY',
    'DELETE repos/o/r/branches/main/protection',
  ])
  assert.deepEqual(JSON.parse(done[0].input).bypass_actors, [{ actor_type: 'DeployKey', bypass_mode: 'always' }])
  // A write key whose private half went only to the secret, and nothing left on disk.
  const key = JSON.parse(done[3].input)
  assert.equal(key.title, 'release-kit train')
  assert.equal(key.read_only, false)
  assert.match(key.key, /^ssh-ed25519 \S+ release-kit train$/)
  assert.match(done[4].input, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/)
  assert.ok(!result.calls.some(({ input }) => input.includes('PRIVATE KEY') && input !== done[4].input))
  assert.deepEqual(result.leftovers, [])
})

test('a rerun changes only what drifted: the legacy ruleset is renamed in place, a working key is kept', () => {
  const legacy = { ...branchRuleset({ checks: CHECKS, mergeMethods: ['squash'], deployKey: true, adminBypass: true }), id: 42, name: 'release-kit: protect main' }
  const tags = { id: 43, ...tagRuleset() }
  const state = { rulesets: [legacy, tags, { id: 50, name: 'Mine', target: 'branch', enforcement: 'active' }], keys: [{ id: 7, title: 'release-kit train', read_only: false }], secret: true }
  const result = protect([], state, { train: {} })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(writes(result.calls).map(describe), ['PUT repos/o/r/rulesets/42'])
  assert.deepEqual(JSON.parse(writes(result.calls)[0].input), branchRuleset({ checks: CHECKS, mergeMethods: ['squash'], deployKey: true }))
  assert.match(result.stdout, /"release-kit: branches": update \(now "release-kit: protect main"\)/)
  assert.match(result.stdout, /was: bypass is DeployKey:always, RepositoryRole:5:always, not DeployKey:always/)
  assert.match(result.stdout, /"release-kit: release tags": unchanged/)
  assert.match(result.stdout, /kept \(--rotate-key replaces them\)/)
  assert.match(result.stdout, /another ruleset, left alone: "Mine"/)
})

test('a rerun keeps the checks the ruleset already requires instead of reading them again', () => {
  const live = { ...branchRuleset({ checks: [{ context: 'CI result', integration_id: 15368 }], mergeMethods: ['squash'] }), id: 42 }
  const result = protect(['--dry-run'], { rulesets: [live] })
  assert.match(result.stdout, /required checks from the "release-kit: branches" ruleset as it is \(--checks changes them\)/)
  assert.match(result.stdout, /"release-kit: branches": unchanged/)
  assert.ok(!result.calls.some(({ args }) => args.some((a) => a.startsWith('repos/o/r/pulls'))))
})

test('--checks, .release.json protect.checks and --admin-bypass are honored', () => {
  const flagged = protect(['--checks', 'build, test', '--admin-bypass'])
  assert.equal(flagged.status, 0, flagged.stderr)
  const set = JSON.parse(writes(flagged.calls)[0].input)
  assert.deepEqual(set.rules.at(-1).parameters.required_status_checks, [{ context: 'build', integration_id: 15368 }, { context: 'test', integration_id: 15368 }])
  assert.deepEqual(set.bypass_actors, [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }])
  // The recent pull requests aren't read when the checks are named.
  assert.ok(!flagged.calls.some(({ args }) => args.some((a) => a.startsWith('repos/o/r/pulls'))))
  const configured = protect(['--dry-run'], {}, { protect: { checks: ['lint'] } })
  assert.match(configured.stdout, /required checks: lint \(app 15368\)/)
  assert.match(configured.stdout, /required checks from .release.json "protect.checks"/)
})

test('a private repo on GitHub Free is told why, before anything changes', () => {
  const result = protect([], { private: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /can't have rulesets: GitHub offers them on public repos/)
  assert.deepEqual(writes(result.calls), [])
})

test('check warns when the rulesets drift, and stays quiet when gh cannot tell', () => {
  const dir = tmp('protect-check')
  writeFileSync(join(dir, '.release.json'), '{}')
  const live = { id: 42, ...branchRuleset({ checks: CHECKS, mergeMethods: ['squash'] }) }
  const warn = (state) => {
    const gh = fakeGh(state)
    const saved = { cwd: process.cwd(), env: { ...process.env } }
    try {
      process.chdir(dir)
      Object.assign(process.env, gh.env)
      return protectionWarnings({ repo: 'o/r' })
    } finally {
      process.chdir(saved.cwd)
      process.env = saved.env
    }
  }
  assert.deepEqual(warn({ rulesets: [live, { id: 43, ...tagRuleset() }] }), [])
  assert.deepEqual(warn({ rulesets: [] }), ['o/r has no release-kit rulesets: npx release-kit protect --dry-run shows what it would set'])
  const loosened = structuredClone(live)
  loosened.rules = loosened.rules.filter((rule) => rule.type !== 'non_fast_forward')
  assert.deepEqual(warn({ rulesets: [loosened] }), [
    'o/r ruleset "release-kit: branches": the non_fast_forward rule is missing',
    'o/r has no "release-kit: release tags" ruleset',
    'npx release-kit protect --dry-run shows the fix, and npx release-kit protect applies it',
  ])
  assert.deepEqual(warn({ private: true }), [])
})
