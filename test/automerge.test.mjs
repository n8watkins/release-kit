// The auto-merge policy: which update pull requests merge on their own, and
// how (GitHub auto-merge where checks are required, merge-when-green where
// they can't be).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, tmp } from './helpers.mjs'
import { checksState, decide, dependabotUpdates, kitVersion, semverChange } from '../template/scripts/release-kit/automerge.mjs'

// A Dependabot commit message as Dependabot writes it (a grouped update).
const DEPENDABOT = `build(deps): bump the release-kit group with 2 updates

Bumps the release-kit group with 2 updates: [release-kit](https://github.com/n8watkins/release-kit) and [n8watkins/release-kit](https://github.com/n8watkins/release-kit).

---
updated-dependencies:
- dependency-name: release-kit
  dependency-version: 2.2.0
  dependency-type: direct:development
  update-type: version-update:semver-minor
  dependency-group: release-kit
- dependency-name: n8watkins/release-kit
  dependency-version: 2.2.0
  dependency-type: direct:production
  update-type: version-update:semver-minor
  dependency-group: release-kit
...

Signed-off-by: dependabot[bot] <support@github.com>`

test('Dependabot metadata, version changes and kit pins are read the way Dependabot and npm write them', () => {
  assert.deepEqual(dependabotUpdates(DEPENDABOT), [{ name: 'release-kit', type: 'minor' }, { name: 'n8watkins/release-kit', type: 'minor' }])
  assert.deepEqual(dependabotUpdates(DEPENDABOT.replaceAll('\n', '\r\n')).length, 2)
  // A security update of a dependency whose version jumps a major.
  assert.deepEqual(dependabotUpdates('fix: bump x\n\n---\nupdated-dependencies:\n- dependency-name: next\n  dependency-type: direct:production\n  update-type: version-update:semver-major\n...\n'), [{ name: 'next', type: 'major' }])
  assert.deepEqual(dependabotUpdates('chore: no metadata'), [])
  assert.equal(semverChange('2.1.0', 'v2.1.3'), 'patch')
  assert.equal(semverChange('v2.1.0', '2.2.0'), 'minor')
  assert.equal(semverChange('2.9.9', '3.0.0'), 'major')
  assert.equal(semverChange('2.1.0', 'main'), null)
  assert.equal(kitVersion('github:n8watkins/release-kit#v2.1.0'), '2.1.0')
  assert.equal(kitVersion('github:n8watkins/release-kit#' + 'a'.repeat(40)), null)
})

const pr = (more = {}) => ({ author: 'dependabot[bot]', headRef: 'dependabot/npm_and_yarn/release-kit-2.2.0', state: 'open', draft: false, autoMerge: false, ...more })
const minor = { type: 'minor', what: 'release-kit' }
const protectedRepo = { requiredChecks: true, allowAutoMerge: true }
const freePrivate = { requiredChecks: false, allowAutoMerge: false }

test('decide: auto-merge for patch and minor updates where checks are required, never a major', () => {
  assert.equal(decide({ pr: pr(), update: minor, repo: protectedRepo, event: 'pull_request' }).action, 'enable')
  assert.equal(decide({ pr: pr(), update: { type: 'patch', what: 'next' }, repo: protectedRepo, event: 'pull_request' }).action, 'enable')
  assert.match(decide({ pr: pr(), update: { type: 'major', what: 'release-kit' }, repo: protectedRepo, event: 'pull_request' }).reason, /major update: a person reviews/)
  assert.match(decide({ pr: pr(), update: { type: null, what: 'release-kit' }, repo: protectedRepo, event: 'pull_request' }).reason, /could not tell/)
  // The rollout bot's pull requests count only from its release-kit/ branch.
  const bots = ['dependabot[bot]', 'release-kit-bot[bot]']
  assert.equal(decide({ pr: pr({ author: 'release-kit-bot[bot]', headRef: 'release-kit/update' }), update: minor, repo: protectedRepo, event: 'pull_request', bots }).action, 'enable')
  assert.match(decide({ pr: pr({ author: 'release-kit-bot[bot]', headRef: 'feature' }), update: minor, repo: protectedRepo, event: 'pull_request', bots }).reason, /not a release-kit update/)
  assert.match(decide({ pr: pr({ author: 'n8watkins' }), update: minor, repo: protectedRepo, event: 'pull_request' }).reason, /not one of the update bots/)
  assert.equal(decide({ pr: pr({ draft: true }), update: minor, repo: protectedRepo, event: 'pull_request' }).action, 'skip')
  assert.match(decide({ pr: pr({ autoMerge: true }), update: minor, repo: protectedRepo, event: 'pull_request' }).reason, /already on/)
})

test('decide: no required checks means no GitHub auto-merge; the fallback merges when green instead', () => {
  assert.match(decide({ pr: pr(), update: minor, repo: freePrivate, event: 'pull_request' }).reason, /requires no status checks, so auto-merge would merge before CI finishes; the merge-when-green fallback/)
  assert.match(decide({ pr: pr(), update: minor, repo: { requiredChecks: true, allowAutoMerge: false }, event: 'pull_request' }).reason, /allow_auto_merge=true/)
  assert.equal(decide({ pr: pr(), update: minor, repo: freePrivate, event: 'workflow_run', checks: 'green' }).action, 'merge')
  assert.match(decide({ pr: pr(), update: minor, repo: freePrivate, event: 'workflow_run', checks: 'pending' }).reason, /still running/)
  assert.match(decide({ pr: pr(), update: minor, repo: freePrivate, event: 'workflow_run', checks: 'red' }).reason, /a check failed/)
  assert.match(decide({ pr: pr(), update: minor, repo: freePrivate, event: 'workflow_run', checks: 'green', fallback: false }).reason, /fallback is off/)
  assert.match(decide({ pr: pr(), update: minor, repo: protectedRepo, event: 'workflow_run', checks: 'green' }).reason, /GitHub auto-merge handles it/)
  assert.equal(decide({ pr: pr(), update: { type: 'major', what: 'x' }, repo: freePrivate, event: 'workflow_run', checks: 'green' }).action, 'skip')
})

test('checksState: green only when every other check finished and passed', () => {
  const run = (name, status, conclusion = null) => ({ name, status, conclusion })
  assert.equal(checksState([run('CI result', 'completed', 'success'), run('e2e', 'completed', 'skipped')]), 'green')
  assert.equal(checksState([run('CI result', 'in_progress')]), 'pending')
  assert.equal(checksState([run('CI result', 'in_progress'), run('lint', 'completed', 'failure')]), 'red')
  assert.equal(checksState([run('CI result', 'completed', 'cancelled')]), 'red')
  assert.equal(checksState([]), 'pending', 'nothing ran yet')
  assert.equal(checksState([run('Auto-merge', 'in_progress')], undefined, ['Auto-merge']), 'pending')
  assert.equal(checksState([run('CI result', 'completed', 'success'), run('Auto-merge', 'in_progress')], undefined, ['Auto-merge']), 'green')
  assert.equal(checksState([run('CI result', 'completed', 'success')], { state: 'failure', total_count: 1 }), 'red')
  assert.equal(checksState([run('CI result', 'completed', 'success')], { state: 'pending', total_count: 1 }), 'pending')
})

// The script against a fake gh that answers the API calls it makes.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n')
if (args[0] === 'pr') process.exit(0)
const path = args[args.length - 1]
const answer = Object.entries(state).find(([prefix]) => path.startsWith(prefix))
if (!answer) { console.error('HTTP 404: ' + path); process.exit(1) }
process.stdout.write(JSON.stringify(answer[1]))
`
const b64 = (text) => Buffer.from(text).toString('base64')
const pkg = (version) => ({ content: b64(JSON.stringify({ devDependencies: { 'release-kit': `github:n8watkins/release-kit#v${version}` } })) })

function automerge({ event = 'pull_request', from = '2.1.0', to = '2.2.0', rules = [], allowAutoMerge = true, runs = [], payload } = {}) {
  const dir = tmp('automerge')
  writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
  const state = {
    'repos/o/r/pulls/7/commits': [{ commit: { message: DEPENDABOT.replaceAll('semver-minor', semverChange(from, to) ? `semver-${semverChange(from, to)}` : 'semver-minor') } }],
    'repos/o/r/pulls/7': { number: 7, state: 'open', draft: false, auto_merge: null, user: { login: 'dependabot[bot]' }, head: { ref: 'dependabot/npm_and_yarn/release-kit', sha: 'h'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { allow_auto_merge: allowAutoMerge } } },
    [`repos/o/r/contents/package.json?ref=${'b'.repeat(40)}`]: pkg(from),
    [`repos/o/r/contents/package.json?ref=${'h'.repeat(40)}`]: pkg(to),
    'repos/o/r/rules/branches/main': rules,
    'repos/o/r/branches/main': { protected: false },
    [`repos/o/r/commits/${'h'.repeat(40)}/check-runs`]: { check_runs: runs },
    [`repos/o/r/commits/${'h'.repeat(40)}/status`]: { state: 'pending', total_count: 0 },
  }
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  writeFileSync(join(dir, 'log'), '')
  writeFileSync(join(dir, 'event.json'), JSON.stringify(payload ?? (event === 'pull_request' ? { pull_request: { number: 7 } } : { workflow_run: { event: 'pull_request', head_sha: 'h'.repeat(40), pull_requests: [{ number: 7 }] } })))
  const result = attempt(dir, 'node', [join(KIT, 'template/scripts/release-kit/automerge.mjs')], {
    PATH: `${dir}:${process.env.PATH}`, FAKE_GH_STATE: join(dir, 'state.json'), FAKE_GH_LOG: join(dir, 'log'),
    GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: join(dir, 'event.json'),
  })
  const merges = readFileSync(join(dir, 'log'), 'utf8').split('\n').filter((line) => line.startsWith('pr merge'))
  return { ...result, merges }
}

test('end to end: a minor kit update on a repo that requires checks gets auto-merge, a major does not', () => {
  const required = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI result' }] } }]
  const minorRun = automerge({ rules: required })
  assert.equal(minorRun.status, 0, minorRun.stderr)
  assert.deepEqual(minorRun.merges, [`pr merge 7 --repo o/r --auto --squash --match-head-commit ${'h'.repeat(40)}`])
  assert.match(minorRun.stdout, /::notice title=Auto-merge::auto-merge on for #7: release-kit, n8watkins\/release-kit is a minor update/)

  const major = automerge({ rules: required, to: '3.0.0' })
  assert.deepEqual(major.merges, [])
  assert.match(major.stdout, /left for a person: .* is a major update/)
})

test('end to end: with no required checks it skips with a notice, and merges on workflow_run once checks are green', () => {
  const pull = automerge()
  assert.equal(pull.status, 0, pull.stderr)
  assert.deepEqual(pull.merges, [])
  assert.match(pull.stdout, /requires no status checks/)

  const pending = automerge({ event: 'workflow_run', runs: [{ name: 'CI result', status: 'in_progress', conclusion: null }] })
  assert.deepEqual(pending.merges, [])
  assert.match(pending.stdout, /still running/)

  const green = automerge({ event: 'workflow_run', runs: [{ name: 'CI result', status: 'completed', conclusion: 'success' }] })
  assert.equal(green.status, 0, green.stderr)
  assert.deepEqual(green.merges, [`pr merge 7 --repo o/r --squash --match-head-commit ${'h'.repeat(40)}`])

  const push = automerge({ event: 'workflow_run', payload: { workflow_run: { event: 'push', head_sha: 'h'.repeat(40) } } })
  assert.deepEqual(push.merges, [])
  assert.match(push.stdout, /a push run is not a pull request's/)
})
