// End to end: npm run release -- --push on a branch that takes changes only
// through pull requests. A bare remote rejects pushes to main the way a
// GitHub ruleset does, and a fake gh opens, checks and squash-merges the
// release pull request in that remote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, commit, makeRepo, run, tmp } from './helpers.mjs'
import { judge, readiness, requiredChecks, timeoutReason } from '../template/scripts/release-kit/release-pr.mjs'

const SCRIPTS = 'scripts/release-kit'

// Rejects any update of main, like a ruleset with a pull_request rule.
const PRE_RECEIVE = `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo "error: GH013: Repository rule violations found for refs/heads/main." >&2
    echo "- Changes must be made through a pull request." >&2
    exit 1
  fi
done
`

// The fake gh plays a scenario (FAKE_SCENARIO, a JSON file): the branch rules,
// and frames of what the head commit's checks say, one frame per poll (the
// last one repeats). It answers the REST calls with what their --jq filters
// would print, and gh pr view with the matching statusCheckRollup too.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const env = process.env
const dir = env.FAKE_DIR
appendFileSync(dir + '/log', JSON.stringify(args) + '\\n')
const remote = (...a) => execFileSync('git', ['--git-dir', env.FAKE_REMOTE, ...a], { encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' } }).trim()
const say = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
const scenario = JSON.parse(readFileSync(env.FAKE_SCENARIO, 'utf8'))
const views = existsSync(dir + '/views') ? Number(readFileSync(dir + '/views', 'utf8')) : 0
const frame = scenario.frames[Math.min(Math.max(views - 1, 0), scenario.frames.length - 1)]
const lines = (items = []) => say(items.map((item) => JSON.stringify(item)).join('\\n'))
const [a, b] = args
if (a === 'pr' && b === 'create') {
  writeFileSync(dir + '/head', args[args.indexOf('--head') + 1])
  say('https://github.com/o/r/pull/7\\n')
} else if (a === 'pr' && b === 'view' && args.includes('mergeCommit')) {
  say(readFileSync(dir + '/merged', 'utf8'))
} else if (a === 'pr' && b === 'view') {
  writeFileSync(dir + '/views', String(views + 1))
  const now = scenario.frames[Math.min(views, scenario.frames.length - 1)]
  const rollup = [
    ...(now.checks ?? []).filter((c) => c.kind === 'run').map((c) => ({ __typename: 'CheckRun', name: c.name, status: c.status.toUpperCase(), conclusion: (c.conclusion ?? '').toUpperCase() })),
    ...(now.checks ?? []).filter((c) => c.kind === 'status').map((c) => ({ __typename: 'StatusContext', context: c.context, state: c.state.toUpperCase() })),
  ]
  say({ state: 'OPEN', mergeStateStatus: now.mss, statusCheckRollup: rollup })
} else if (a === 'api' && /\\/rules\\/branches\\//.test(b)) {
  if (scenario.rules === 'error') { console.error('gh: Not Found (HTTP 404)'); process.exit(1) }
  say(scenario.rules ?? [])
} else if (a === 'api' && /\\/branches\\/[^/]+$/.test(b)) {
  say(scenario.classic ? { protection: { required_status_checks: scenario.classic } } : { protected: false })
} else if (a === 'api' && /\\/check-runs/.test(b)) {
  lines((frame.checks ?? []).filter((c) => c.kind === 'run'))
} else if (a === 'api' && /\\/status\\b/.test(b)) {
  lines((frame.checks ?? []).filter((c) => c.kind === 'status'))
} else if (a === 'api' && /\\/actions\\/runs/.test(b)) {
  lines(frame.workflows)
} else if (a === 'repo' && b === 'view') {
  say({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false })
} else if (a === 'pr' && b === 'merge') {
  const head = 'refs/heads/' + readFileSync(dir + '/head', 'utf8')
  if (remote('rev-parse', head) !== args[args.indexOf('--match-head-commit') + 1]) { console.error('head moved'); process.exit(1) }
  // A main that moved meanwhile: the squash lands on a different tree.
  const tree = env.FAKE_MOVED ? remote('rev-parse', 'refs/heads/main^{tree}') : remote('rev-parse', head + '^{tree}')
  const merged = remote('commit-tree', tree, '-p', 'refs/heads/main', '-m', args[args.indexOf('--subject') + 1])
  remote('update-ref', 'refs/heads/main', merged)
  writeFileSync(dir + '/merged', merged)
} else if (a === 'pr' && b === 'close') {
  remote('update-ref', '-d', 'refs/heads/' + readFileSync(dir + '/head', 'utf8'))
} else {
  console.error('fake gh: unexpected ' + JSON.stringify(args)); process.exit(1)
}
`

// Check runs and commit statuses, the way the release reads them from the REST API.
const RUN = {
  queued: { status: 'queued', conclusion: null },
  pending: { status: 'in_progress', conclusion: null },
  success: { status: 'completed', conclusion: 'success' },
  skipped: { status: 'completed', conclusion: 'skipped' },
  failure: { status: 'completed', conclusion: 'failure' },
}
let ids = 0
const actions = (name, state) => ({ kind: 'run', id: ++ids, name, app: 'github-actions', appId: 15368, ...RUN[state] })
const appRun = (name, app, appId, state) => ({ kind: 'run', id: ++ids, name, app, appId, ...RUN[state] })
const status = (context, state, description) => ({ kind: 'status', context, state, description })
const workflow = (name, state) => ({ name, ...RUN[state] })
const frame = (mss, checks, workflows = []) => ({ mss, checks, workflows })
const requiring = (...contexts) => [
  { type: 'pull_request', parameters: {} },
  { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) } },
]
// The old FAKE_CHECKS shorthands: one GitHub Actions check, no required checks.
const ci = (state) => frame(state === 'success' ? 'CLEAN' : 'BLOCKED', [actions('CI result', state)], [workflow('CI', state)])
const SIMPLE = {
  green: { rules: [], frames: [ci('success')] },
  slow: { rules: [], frames: [ci('pending'), ci('pending'), ci('success')] },
  red: { rules: [], frames: [ci('failure')] },
  pending: { rules: [], frames: [ci('pending')] },
}

function setup() {
  const root = tmp('release-pr')
  run(root, 'git', ['init', '-q', '--bare', '-b', 'main', 'remote.git'])
  const remote = join(root, 'remote.git')
  const repo = makeRepo(join(root, 'repo'), { version: '1.0.0' })
  run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  run(repo, 'git', ['remote', 'add', 'origin', remote])
  run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--baseline'])
  run(repo, 'git', ['push', '-q', '--no-verify', '--atomic', 'origin', 'main', 'v1.0.0'])
  writeFileSync(join(remote, 'hooks', 'pre-receive'), PRE_RECEIVE, { mode: 0o755 })
  const bin = tmp('release-pr-bin')
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  writeFileSync(join(bin, 'log'), '')
  commit(repo, 'feat: dark mode')
  let runs = 0
  const release = (args, { FAKE_CHECKS = 'green', scenario = SIMPLE[FAKE_CHECKS], ...env } = {}) => {
    runs += 1
    const file = join(bin, `scenario-${runs}.json`)
    writeFileSync(file, JSON.stringify(scenario))
    rmSync(join(bin, 'views'), { force: true })
    return attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--push', '--no-check', ...args], {
      PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, FAKE_REMOTE: remote, FAKE_SCENARIO: file, RELEASE_KIT_PR_POLL: '0.05', RELEASE_KIT_PR_GRACE: '0', ...env,
    })
  }
  const gh = () => readFileSync(join(bin, 'log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const at = (ref) => attempt(repo, 'git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref]).stdout.trim()
  return { repo, remote, release, gh, at, views: () => Number(readFileSync(join(bin, 'views'), 'utf8')) }
}

test('the server\'s rules send the release through a pull request too, when only the release commit is pushed', () => {
  const { repo, release, at } = setup()
  // The feature is on the remote's main already (bypassing its pre-receive rule), so the guard lets the release commit through.
  run(repo, 'git', ['push', '-q', '--no-verify', `--receive-pack=git -c core.hooksPath=/dev/null receive-pack`, 'origin', 'main'])
  const result = release([])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /main rejected the push \(its rules want a pull request\), so the release goes through one/)
  assert.equal(at('refs/tags/v1.1.0^{commit}'), at('refs/heads/main'))
})

test('a rejected push releases through a pull request: merged once green, and the merged commit is tagged', () => {
  const { repo, release, gh, at } = setup()
  const result = release([], { FAKE_CHECKS: 'slow' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /the pre-push guard stopped the push \(it carries commits that main hasn't seen\), so the release goes through one/)
  assert.match(result.stdout, /opened https:\/\/github\.com\/o\/r\/pull\/7, waiting for its checks/)
  assert.match(result.stdout, /merged #7 and pushed v1\.1\.0/)
  const calls = gh()
  const create = calls.find((c) => c[1] === 'create')
  assert.deepEqual(create.slice(0, 8), ['pr', 'create', '--base', 'main', '--head', 'release/v1.1.0', '--title', 'chore(release): v1.1.0'])
  assert.match(create[9], /## 1\.1\.0 - [\s\S]*Dark mode/)
  assert.ok(calls.filter((c) => c[1] === 'view' && !c.includes('mergeCommit')).length >= 3, 'it waited for the pending check')
  const merge = calls.find((c) => c[1] === 'merge')
  assert.deepEqual(merge.slice(0, 4), ['pr', 'merge', '7', '--squash'])
  assert.equal(merge[merge.indexOf('--subject') + 1], 'chore(release): v1.1.0')

  // The tag is on the merged commit on origin's main, not the local one, and the local branch followed.
  const main = at('refs/heads/main')
  assert.equal(at('refs/tags/v1.1.0^{commit}'), main)
  assert.equal(run(repo, 'git', ['rev-parse', 'HEAD']).trim(), main)
  assert.match(run(repo, 'git', ['tag', '-l', '--format=%(contents)', 'v1.1.0']), /Dark mode/)
  assert.equal(at('refs/heads/release/v1.1.0'), '')
  assert.equal(JSON.parse(run(repo, 'git', ['show', `${main}:package.json`])).version, '1.1.0')
  assert.equal(run(repo, 'git', ['status', '--porcelain']), '')
  // The next release starts from that tag.
  commit(repo, 'fix: a typo')
  assert.match(run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run']), /1\.1\.0 -> 1\.1\.1 \(patch\), 1 commit since v1\.1\.0/)
})

test('a failing GitHub Actions check closes the release pull request and undoes the release, so nothing is tagged', () => {
  const { repo, release, gh, at } = setup()
  const before = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  const result = release(['--via-pr'], { FAKE_CHECKS: 'red' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /a GitHub Actions check failed: CI result \(GitHub Actions: failure\), so release pull request #7 was closed and the release commit undone; nothing was tagged/)
  // --via-pr went straight to the pull request.
  assert.doesNotMatch(result.stdout, /rejected the push/)
  assert.ok(gh().some((c) => c[1] === 'close' && c.includes('--delete-branch')))
  assert.equal(run(repo, 'git', ['rev-parse', 'HEAD']).trim(), before)
  assert.equal(run(repo, 'git', ['tag', '--list', 'v1.1.0']).trim(), '')
  assert.equal(at('refs/tags/v1.1.0'), '')
  assert.equal(at('refs/heads/release/v1.1.0'), '')
  // Checks that never finish give up too.
  const slow = release(['--pr-timeout', '0.001'], { FAKE_CHECKS: 'pending' })
  assert.match(slow.stderr, /its checks didn't pass within 0\.001 minutes/)
  assert.equal(run(repo, 'git', ['rev-parse', 'HEAD']).trim(), before)
})

test('if main moved while the checks ran, the merged commit is not tagged and the way out is printed', () => {
  const { release, at } = setup()
  const result = release([], { FAKE_MOVED: '1' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /main had moved meanwhile, so that commit has more than the release; v1\.1\.0 was not tagged/)
  assert.equal(at('refs/tags/v1.1.0'), '')
})

test('a dry run says which way --push will go', () => {
  const { repo } = setup()
  const dry = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run', '--push'], { PATH: `/nonexistent:${process.env.PATH}`, GH_TOKEN: '' })
  assert.match(dry.stdout, /--push would (push main and the tag|open a release pull request)/)
})

// n8watkins/fitflow7#13 and n8watkins/cutelyaskme#16: a Vercel deploy that
// hit its daily limit set a failing "Vercel" commit status while the required
// checks were still running, and the release gave up on it.
const FITFLOW7_RULES = requiring('check / check', 'verify')
const vercel = (state) => status('Vercel', state, state === 'failure' ? 'Deployment rate limited - retry in 24 hours.' : 'Deploying')

test('a failing check the rules don\'t require (a rate-limited Vercel deploy) is reported and ignored, and the release waits for the required ones', () => {
  const { release, at, views } = setup()
  const result = release([], {
    scenario: {
      rules: FITFLOW7_RULES,
      frames: [
        frame('BLOCKED', [vercel('failure'), actions('auto-merge', 'skipped'), actions('check / check', 'pending'), actions('verify', 'pending'), appRun('GitGuardian Security Checks', 'gitguardian', 46505, 'pending')]),
        frame('BLOCKED', [vercel('failure'), actions('auto-merge', 'skipped'), actions('check / check', 'success'), actions('verify', 'pending'), appRun('GitGuardian Security Checks', 'gitguardian', 46505, 'failure')]),
        frame('UNSTABLE', [vercel('failure'), actions('auto-merge', 'skipped'), actions('check / check', 'success'), actions('verify', 'success'), appRun('GitGuardian Security Checks', 'gitguardian', 46505, 'failure')]),
      ],
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /waiting for main's required checks: check \/ check, verify; other checks and commit statuses don't gate the release/)
  assert.match(result.stdout, /ignoring a failure that doesn't gate the merge: Vercel \(commit status: Deployment rate limited - retry in 24 hours\.\)/)
  assert.match(result.stdout, /ignoring a failure that doesn't gate the merge: GitGuardian Security Checks \(gitguardian: failure\)/)
  assert.equal(result.stdout.match(/ignoring a failure .*Vercel/g).length, 1, 'each ignored failure is reported once')
  assert.match(result.stdout, /checks passed: check \/ check, verify; ignored, since they don't gate the merge: GitGuardian Security Checks \(gitguardian: failure\), Vercel \(commit status: Deployment rate limited/)
  assert.ok(views() >= 3, 'it waited for verify')
  assert.equal(at('refs/tags/v1.1.0^{commit}'), at('refs/heads/main'))
})

test('a required check that fails closes the release pull request and undoes the release', () => {
  const { repo, release, gh, at } = setup()
  const before = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  const result = release(['--via-pr'], {
    scenario: { rules: FITFLOW7_RULES, frames: [frame('BLOCKED', [vercel('success'), actions('check / check', 'success'), actions('verify', 'failure')])] },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /a required check failed: verify \(GitHub Actions: failure\), so release pull request #7 was closed and the release commit undone; nothing was tagged/)
  const close = gh().find((c) => c[1] === 'close')
  assert.ok(close.includes('--delete-branch'))
  assert.match(close[close.indexOf('--comment') + 1], /a required check failed: verify/)
  assert.ok(!gh().some((c) => c[1] === 'merge'))
  assert.equal(run(repo, 'git', ['rev-parse', 'HEAD']).trim(), before)
  assert.equal(run(repo, 'git', ['status', '--porcelain']), '')
  assert.equal(at('refs/tags/v1.1.0'), '')
  assert.equal(at('refs/heads/release/v1.1.0'), '')
})

test('a required check that is pending, or hasn\'t reported yet, is waited for', () => {
  const { release, at, views } = setup()
  // cutelyaskme: "CI result" reports only once the jobs it gathers are done.
  const rules = requiring('CI result', 'check / check')
  const result = release([], {
    scenario: {
      rules,
      frames: [
        frame('BLOCKED', [vercel('failure'), actions('check / check', 'queued'), actions('What changed / What changed', 'success')]),
        frame('BLOCKED', [vercel('failure'), actions('check / check', 'success'), actions('Lint', 'queued')]),
        frame('BLOCKED', [vercel('failure'), actions('check / check', 'success'), actions('Lint', 'success'), actions('CI result', 'pending')]),
        // GitHub already says it can merge, but CI result is still running.
        frame('UNSTABLE', [vercel('failure'), actions('check / check', 'success'), actions('Lint', 'success'), actions('CI result', 'pending')]),
        frame('UNSTABLE', [vercel('failure'), actions('check / check', 'success'), actions('Lint', 'success'), actions('CI result', 'success')]),
      ],
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(views() >= 5, `it polled ${views()} times`)
  assert.match(result.stdout, /checks passed: CI result, check \/ check/)
  assert.equal(at('refs/tags/v1.1.0^{commit}'), at('refs/heads/main'))
})

test('a required check that never reports times out with its name, and nothing is tagged', () => {
  const { repo, release, at } = setup()
  const before = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  const result = release(['--pr-timeout', '0.002'], {
    scenario: { rules: requiring('CI result'), frames: [frame('BLOCKED', [actions('verify', 'success'), vercel('failure')])] },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /its checks didn't pass within 0\.002 minutes: the required check "CI result" never reported \(check that the workflow behind it runs on pull requests and that the name matches the branch rules\)/)
  assert.equal(run(repo, 'git', ['rev-parse', 'HEAD']).trim(), before)
  assert.equal(at('refs/tags/v1.1.0'), '')
  assert.equal(at('refs/heads/release/v1.1.0'), '')
})

test('without required checks (a private repo on GitHub Free), only GitHub Actions check runs gate the release, and it waits while any is pending', () => {
  const { release, at, views } = setup()
  const others = [vercel('failure'), appRun('GitGuardian Security Checks', 'gitguardian', 46505, 'failure')]
  const result = release([], {
    scenario: {
      rules: [],
      frames: [
        frame('UNSTABLE', [...others, actions('What changed', 'pending')], [workflow('CI', 'pending')]),
        // Every check run so far is done, but CI's workflow is about to add the jobs that need "What changed".
        frame('UNSTABLE', [...others, actions('What changed', 'success')], [workflow('CI', 'pending')]),
        frame('UNSTABLE', [...others, actions('What changed', 'success'), actions('Unit tests', 'queued')], [workflow('CI', 'pending')]),
        frame('UNSTABLE', [...others, actions('What changed', 'success'), actions('Unit tests', 'success')], [workflow('CI', 'success')]),
      ],
    },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /main requires no checks, so every GitHub Actions check gates the release; commit statuses and other apps' checks \(Vercel, GitGuardian, \.\.\.\) don't/)
  assert.ok(views() >= 4, `it polled ${views()} times`)
  assert.match(result.stdout, /checks passed: What changed, Unit tests; ignored, since they don't gate the merge: GitGuardian Security Checks \(gitguardian: failure\), Vercel \(commit status: Deployment rate limited - retry in 24 hours\.\)/)
  assert.equal(at('refs/tags/v1.1.0^{commit}'), at('refs/heads/main'))

  // There, a failing GitHub Actions job still stops the release; rules that can't be read count as none.
  const { release: again, at: atAgain } = setup()
  const red = again([], { scenario: { rules: 'error', frames: [frame('UNSTABLE', [vercel('success'), actions('Unit tests', 'failure')], [workflow('CI', 'success')])] } })
  assert.notEqual(red.status, 0)
  assert.match(red.stdout, /could not read main's rules \(gh: Not Found \(HTTP 404\)\), so only GitHub Actions checks gate the release/)
  assert.match(red.stderr, /a GitHub Actions check failed: Unit tests \(GitHub Actions: failure\), so release pull request #7 was closed/)
  assert.equal(atAgain('refs/tags/v1.1.0'), '')
})

test('judge: required checks match by name and app, the latest run of a name counts, and the rest only gets reported', () => {
  const required = requiredChecks(FITFLOW7_RULES, null)
  assert.deepEqual(required, [{ context: 'check / check', appId: 15368 }, { context: 'verify', appId: 15368 }])
  // Classic branch protection adds its checks, without duplicates.
  assert.deepEqual(requiredChecks([], { contexts: ['test', 'verify'], checks: [{ context: 'verify', app_id: 15368 }] }), [{ context: 'verify', appId: 15368 }, { context: 'test', appId: undefined }])
  assert.deepEqual(requiredChecks(null, null), [])

  // A "verify" from another app doesn't satisfy a check required from GitHub Actions.
  const impostor = judge({ required, checks: [actions('check / check', 'success'), appRun('verify', 'other', 1, 'success')] })
  assert.equal(impostor.state, 'pending')
  assert.deepEqual(impostor.missing, ['verify'])
  // A rerun that passed replaces the failed run before it.
  const rerun = judge({ required, checks: [actions('verify', 'failure'), actions('verify', 'success'), actions('check / check', 'skipped')] })
  assert.equal(rerun.state, 'passed')
  // A required commit status gates like a check run.
  const viaStatus = judge({ required: [{ context: 'Vercel' }], checks: [vercel('failure'), actions('verify', 'success')] })
  assert.equal(viaStatus.state, 'failed')
  assert.deepEqual(viaStatus.ignored, [])
  const none = judge({ required: [], checks: [vercel('failure')] })
  assert.equal(none.state, 'passed')
  assert.equal(none.ignored.length, 1)
})

test('readiness: merge only when the gating checks passed and GitHub says the pull request can merge', () => {
  const passed = { state: 'passed', mode: 'required', failed: [], missing: [], pending: [] }
  const actionsPassed = { ...passed, mode: 'actions' }
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN' }, passed, 1), 'merge')
  // UNSTABLE: a check that isn't required failed; it doesn't block the merge.
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'UNSTABLE' }, passed, 1), 'merge')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'BLOCKED' }, passed, 1), 'wait')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN' }, { ...passed, state: 'pending', pending: ['verify'] }, 1), 'wait')
  // Without required checks, workflows get the grace period to start.
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN' }, actionsPassed, 5), 'wait')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN' }, actionsPassed, 61), 'merge')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN' }, { ...passed, state: 'failed', failed: ['verify (GitHub Actions: failure)'] }, 1), 'a required check failed: verify (GitHub Actions: failure)')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'DIRTY' }, passed, 1), 'the pull request has conflicts')
  assert.equal(readiness({ state: 'CLOSED', mergeStateStatus: 'CLEAN' }, passed, 1), 'the pull request is closed')
  assert.match(timeoutReason({ mergeStateStatus: 'BLOCKED' }, passed, 30), /they passed, but GitHub still says it can't merge \(blocked\)/)
  assert.match(timeoutReason({}, { ...passed, pending: ['verify'] }, 30), /still waiting for verify/)
})
