// End to end: npm run release -- --push on a branch that takes changes only
// through pull requests. A bare remote rejects pushes to main the way a
// GitHub ruleset does, and a fake gh opens, checks and squash-merges the
// release pull request in that remote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, commit, makeRepo, run, tmp } from './helpers.mjs'
import { readiness, rollupState } from '../template/scripts/release-kit/release-pr.mjs'

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

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const args = process.argv.slice(2)
const env = process.env
const dir = env.FAKE_DIR
appendFileSync(dir + '/log', JSON.stringify(args) + '\\n')
const remote = (...a) => execFileSync('git', ['--git-dir', env.FAKE_REMOTE, ...a], { encoding: 'utf8', env: { ...env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'noreply@github.com', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@github.com' } }).trim()
const say = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v))
const [a, b] = args
if (a === 'pr' && b === 'create') {
  writeFileSync(dir + '/head', args[args.indexOf('--head') + 1])
  say('https://github.com/o/r/pull/7\\n')
} else if (a === 'pr' && b === 'view' && args.includes('mergeCommit')) {
  say(readFileSync(dir + '/merged', 'utf8'))
} else if (a === 'pr' && b === 'view') {
  const views = existsSync(dir + '/views') ? Number(readFileSync(dir + '/views', 'utf8')) + 1 : 1
  writeFileSync(dir + '/views', String(views))
  const checks = env.FAKE_CHECKS === 'slow' ? (views < 3 ? 'pending' : 'green') : env.FAKE_CHECKS
  const run = { pending: { status: 'IN_PROGRESS', conclusion: '' }, green: { status: 'COMPLETED', conclusion: 'SUCCESS' }, red: { status: 'COMPLETED', conclusion: 'FAILURE' } }[checks]
  say({ state: 'OPEN', mergeStateStatus: checks === 'green' ? 'CLEAN' : 'BLOCKED', statusCheckRollup: [{ __typename: 'CheckRun', name: 'CI result', ...run }] })
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
}
`

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
  const release = (args, env = {}) => attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--push', '--no-check', ...args], {
    PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: bin, FAKE_REMOTE: remote, FAKE_CHECKS: 'green', RELEASE_KIT_PR_POLL: '0.05', RELEASE_KIT_PR_GRACE: '0', ...env,
  })
  const gh = () => readFileSync(join(bin, 'log'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  const at = (ref) => attempt(repo, 'git', ['--git-dir', remote, 'rev-parse', '--verify', '--quiet', ref]).stdout.trim()
  return { repo, remote, release, gh, at }
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

test('a failing check closes the release pull request and undoes the release, so nothing is tagged', () => {
  const { repo, release, gh, at } = setup()
  const before = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  const result = release(['--via-pr'], { FAKE_CHECKS: 'red' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /a check failed, so release pull request #7 was closed and the release commit undone; nothing was tagged/)
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

test('readiness: merge only when every check passed and GitHub says the pull request can merge', () => {
  assert.equal(rollupState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passed')
  assert.equal(rollupState([{ status: 'QUEUED', conclusion: '' }]), 'pending')
  assert.equal(rollupState([{ state: 'PENDING' }]), 'pending')
  assert.equal(rollupState([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { status: 'COMPLETED', conclusion: 'TIMED_OUT' }]), 'failed')
  const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: green }, 1), 'merge')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'UNSTABLE', statusCheckRollup: green }, 1), 'merge')
  // Required checks that haven't reported yet keep it BLOCKED.
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'BLOCKED', statusCheckRollup: green }, 1), 'wait')
  // No checks yet: wait for workflows to start, then merge a repo that has none.
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }, 5), 'wait')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: [] }, 61), 'merge')
  assert.equal(readiness({ state: 'OPEN', mergeStateStatus: 'DIRTY', statusCheckRollup: green }, 1), 'the pull request has conflicts')
  assert.equal(readiness({ state: 'CLOSED', mergeStateStatus: 'CLEAN', statusCheckRollup: green }, 1), 'the pull request is closed')
})
