// The Direct push alarm: what it reports for each kind of push, and end to
// end against a fake gh, that it fails the run and opens or updates one issue.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, tmp } from './helpers.mjs'
import { review } from '../template/scripts/release-kit/alarm.mjs'

const sha = (c) => c.repeat(40)
const repository = { default_branch: 'main' }
const push = (more) => ({ ref: 'refs/heads/main', before: sha('a'), after: sha('c'), forced: false, deleted: false, pusher: { name: 'n8' }, repository, ...more })
const RELEASE = { commit: { message: 'chore(release): v1.2.0', author: { name: 'github-actions[bot]' } }, parents: [{}], files: [{ filename: 'package.json' }, { filename: 'package-lock.json' }, { filename: 'CHANGELOG.md' }] }

/** A fake API: commits b and c, with their pull requests and contents. */
function fakeApi({ pulls = {}, commits = {}, files = {} } = {}) {
  const asked = []
  return {
    asked,
    pulls: (s) => (asked.push(`pulls ${s[0]}`), pulls[s] ?? []),
    commit: (s) => commits[s] ?? { commit: { message: `feat: commit ${s[0]}`, author: { name: 'Nathan' } }, parents: [{}], files: [{ filename: 'src/app.js' }] },
    file: (path, ref) => files[`${ref}:${path}`] ?? null,
    compare: () => ({ total_commits: 2, commits: [{ sha: sha('b') }, { sha: sha('c') }] }),
  }
}

test('commits that came from merged pull requests raise nothing', () => {
  const api = fakeApi({ pulls: { [sha('b')]: [{ number: 1, merged_at: 'x' }], [sha('c')]: [{ number: 2, merged_at: 'x' }] } })
  assert.deepEqual(review({ eventName: 'push', event: push(), api }).findings, [])
})

test('a commit pushed straight to main is reported, after a few looks for a late pull request link', () => {
  const api = fakeApi({ pulls: { [sha('b')]: [{ number: 1, merged_at: 'x' }], [sha('c')]: [{ number: 3, merged_at: null }] } })
  let waits = 0
  const { findings } = review({ eventName: 'push', event: push(), api, wait: () => waits++ })
  assert.equal(findings.length, 1)
  assert.match(findings[0], /n8 pushed ccccccc "feat: commit c" \(by Nathan\) straight to main: it came from no merged pull request/)
  assert.equal(waits, 3)
  assert.equal(api.asked.filter((a) => a === 'pulls b').length, 1)
})

test('the release commit from npm run release or the train passes; a fake one does not', () => {
  const files = { [`${sha('c')}:package.json`]: '{"version":"1.2.0"}' }
  const merged = { [sha('b')]: [{ merged_at: 'x' }] }
  const ok = review({ eventName: 'push', event: push(), api: fakeApi({ pulls: merged, commits: { [sha('c')]: RELEASE }, files }) })
  assert.deepEqual(ok.findings, [])
  assert.match(ok.notes.join('\n'), /release commit "chore\(release\): v1\.2\.0"/)
  const sneaky = { ...RELEASE, files: [...RELEASE.files, { filename: 'src/app.js' }] }
  assert.equal(review({ eventName: 'push', event: push(), api: fakeApi({ pulls: merged, commits: { [sha('c')]: sneaky }, files }) }).findings.length, 1)
  const wrongVersion = { [`${sha('c')}:package.json`]: '{"version":"1.1.0"}' }
  assert.equal(review({ eventName: 'push', event: push(), api: fakeApi({ pulls: merged, commits: { [sha('c')]: RELEASE }, files: wrongVersion }) }).findings.length, 1)
})

test('a force push, a moved or deleted release tag and a deleted protected branch are reported', () => {
  const merged = fakeApi({ pulls: { [sha('b')]: [{ merged_at: 'x' }], [sha('c')]: [{ merged_at: 'x' }] } })
  assert.match(review({ eventName: 'push', event: push({ forced: true }), api: merged }).findings[0], /force pushed main from aaaaaaa to ccccccc/)
  assert.match(review({ eventName: 'push', event: push({ ref: 'refs/tags/v1.0.0' }), api: merged }).findings[0], /moved the release tag v1\.0\.0/)
  assert.deepEqual(review({ eventName: 'push', event: push({ ref: 'refs/tags/v1.0.0', before: sha('0') }), api: merged }).findings, [])
  assert.match(review({ eventName: 'push', event: push({ ref: 'refs/tags/v1.0.0', after: sha('0'), deleted: true }), api: merged }).findings[0], /deleted the release tag/)
  assert.match(review({ eventName: 'delete', event: { ref: 'v1.0.0', ref_type: 'tag', sender: { login: 'n8' }, repository }, api: merged }).findings[0], /n8 deleted the release tag v1\.0\.0/)
  assert.match(review({ eventName: 'delete', event: { ref: 'review/v1', ref_type: 'branch', sender: { login: 'n8' }, repository }, branches: ['review/v1'], api: merged }).findings[0], /deleted the protected branch review\/v1/)
  assert.deepEqual(review({ eventName: 'delete', event: { ref: 'feature', ref_type: 'branch', repository }, api: merged }).findings, [])
  // Other branches are not looked at.
  assert.deepEqual(review({ eventName: 'push', event: push({ ref: 'refs/heads/feature', forced: true }), api: fakeApi() }).findings, [])
  // A release branch from .release.json is protected too.
  assert.equal(review({ eventName: 'push', event: push({ ref: 'refs/heads/review/v1' }), branches: ['review/v1'], api: fakeApi() }).findings.length, 2)
})

test('commits that change only --allow-paths pass (a bot that commits generated files)', () => {
  const report = { commit: { message: 'report: weekly', author: { name: 'Claude' } }, parents: [{}], files: [{ filename: 'reports/a/2026-11-02.md' }] }
  const api = fakeApi({ commits: { [sha('b')]: report, [sha('c')]: report } })
  assert.deepEqual(review({ eventName: 'push', event: push(), allowPaths: ['reports/**'], api }).findings, [])
  assert.equal(review({ eventName: 'push', event: push(), allowPaths: ['editions/**'], api }).findings.length, 2)
})

// End to end, against a fake gh.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const state = JSON.parse(readFileSync(process.env.FAKE_GH_STATE, 'utf8'))
const input = args.includes('--input') ? readFileSync(0, 'utf8') : ''
const method = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET'
const path = args.find((a) => a.startsWith('repos/'))
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ method, path, input }) + '\\n')
if (method === 'POST') { process.stdout.write(JSON.stringify({ number: 41 })); process.exit(0) }
const answer = Object.entries(state).find(([prefix]) => path.startsWith(prefix))
if (!answer) { console.error('gh: Not Found (HTTP 404)'); process.exit(1) }
process.stdout.write(JSON.stringify(answer[1]))
`

function alarm({ event = push(), eventName = 'push', openIssue = null, args = [] } = {}) {
  const dir = tmp('alarm')
  writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    [`repos/o/r/compare/${sha('a')}...${sha('c')}`]: { total_commits: 1, commits: [{ sha: sha('c') }] },
    [`repos/o/r/commits/${sha('c')}/pulls`]: [],
    [`repos/o/r/commits/${sha('c')}`]: { commit: { message: 'fix: quick one', author: { name: 'Nathan' } }, parents: [{}], files: [{ filename: 'src/a.js' }] },
    'repos/o/r/issues?': openIssue ? [openIssue] : [],
  }))
  writeFileSync(join(dir, 'log'), '')
  writeFileSync(join(dir, 'event.json'), JSON.stringify(event))
  const result = attempt(dir, 'node', [join(KIT, 'template/scripts/release-kit/alarm.mjs'), ...args], {
    PATH: `${dir}:${process.env.PATH}`, FAKE_GH_STATE: join(dir, 'state.json'), FAKE_GH_LOG: join(dir, 'log'),
    GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_RUN_ID: '7', RELEASE_KIT_ALARM_RETRY_MS: '1',
  })
  const calls = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return { ...result, writes: calls.filter((c) => c.method !== 'GET') }
}

test('end to end: a direct push fails the run and opens an issue labeled "release-kit: direct push"', () => {
  const result = alarm()
  assert.equal(result.status, 1)
  assert.match(result.stdout, /::error title=Direct push alarm::n8 pushed ccccccc "fix: quick one"/)
  assert.deepEqual(result.writes.map((w) => `${w.method} ${w.path}`), ['POST repos/o/r/labels', 'POST repos/o/r/issues'])
  const issue = JSON.parse(result.writes[1].input)
  assert.deepEqual(issue.labels, ['release-kit: direct push'])
  assert.match(issue.body, /actions\/runs\/7/)
})

test('end to end: a second report comments on the open issue; a dry run touches nothing; a fork is skipped', () => {
  const again = alarm({ openIssue: { number: 12 } })
  assert.equal(again.status, 1)
  assert.deepEqual(again.writes.map((w) => `${w.method} ${w.path}`), ['POST repos/o/r/labels', 'POST repos/o/r/issues/12/comments'])
  const dry = alarm({ args: ['--dry-run'] })
  assert.equal(dry.status, 1)
  assert.deepEqual(dry.writes, [])
  assert.match(dry.stdout, /dry run, no issue opened/)
  const fork = alarm({ event: push({ repository: { ...repository, fork: true } }) })
  assert.equal(fork.status, 0)
  const tag = alarm({ event: push({ ref: 'refs/tags/v2.0.0', before: sha('0') }) })
  assert.equal(tag.status, 0, tag.stdout)
  assert.match(tag.stdout, /nothing to report/)
})
