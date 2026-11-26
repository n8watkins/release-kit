// The auto-merge policy: which update pull requests merge on their own, and
// how (GitHub auto-merge where checks are required, merge-when-green where
// they can't be).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, makeRepo, run, tmp } from './helpers.mjs'
import { DEFAULT_HOLD, HOLD_LABEL, REVIEW_LABEL, WAIT_LABEL, addedActionRefs, alreadyMergeable, autoMergePolicy, checksState, classifyUpdate, decide, dependabotUpdates, dependabotVersions, heldBy, holdComment, kitVersion, majorOf, matchesHold, reviewComment, semverChange, versionChange, waitComment, waitFor } from '../template/scripts/release-kit/automerge.mjs'

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
  assert.deepEqual(dependabotUpdates(DEPENDABOT), [{ name: 'release-kit', type: 'minor', version: '2.2.0' }, { name: 'n8watkins/release-kit', type: 'minor', version: '2.2.0' }])
  assert.deepEqual(dependabotUpdates(DEPENDABOT.replaceAll('\n', '\r\n')).length, 2)
  // A security update of a dependency whose version jumps a major.
  assert.deepEqual(dependabotUpdates('fix: bump x\n\n---\nupdated-dependencies:\n- dependency-name: next\n  dependency-type: direct:production\n  update-type: version-update:semver-major\n...\n'), [{ name: 'next', type: 'major', version: null }])
  assert.deepEqual(dependabotUpdates('chore: no metadata'), [])
  // A scoped package name is quoted in the YAML (net_trailers #74): the name is read without the quotes,
  // so it matches its "Updates `@libsql/client` from A to B" line and the review comment shows both versions.
  const scoped = 'build(deps): bump the npm-minor-patch group\n\nUpdates `@libsql/client` from 0.17.0 to 0.18.0\n\n---\nupdated-dependencies:\n- dependency-name: "@libsql/client"\n  dependency-version: 0.18.0\n  dependency-type: direct:production\n  update-type: version-update:semver-minor\n  dependency-group: npm-minor-patch\n...\n'
  assert.deepEqual(dependabotUpdates(scoped), [{ name: '@libsql/client', type: 'minor', version: '0.18.0' }])
  const update = classifyUpdate({ dependabot: true, messages: [scoped] })
  assert.deepEqual(update.belowOne, ['@libsql/client'])
  assert.match(reviewComment(update), /\| @libsql\/client \| 0\.17\.0 \| 0\.18\.0 \|/)
  assert.equal(semverChange('2.1.0', 'v2.1.3'), 'patch')
  assert.equal(semverChange('v2.1.0', '2.2.0'), 'minor')
  assert.equal(semverChange('2.9.9', '3.0.0'), 'major')
  assert.equal(semverChange('2.1.0', 'main'), null)
  // Dependabot's cooldown once proposed v2.2.0 -> v2.0.1 for a git dependency.
  assert.equal(semverChange('v2.2.0', 'v2.0.1'), 'downgrade')
  assert.equal(semverChange('2.0.0', '1.2.0'), 'downgrade')
  assert.equal(semverChange('2.2.0', '2.2.0'), null)
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
  assert.match(decide({ pr: pr(), update: { type: 'downgrade', what: 'release-kit' }, repo: protectedRepo, event: 'pull_request' }).reason, /older version/)
  assert.equal(decide({ pr: pr(), update: { type: 'downgrade', what: 'release-kit' }, repo: freePrivate, event: 'workflow_run', checks: 'green' }).action, 'skip')
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
  // Required checks but auto-merge not allowed (open-ping#101): the fallback merges it when green.
  const noAutoMerge = { requiredChecks: true, allowAutoMerge: false }
  assert.match(decide({ pr: pr(), update: minor, repo: noAutoMerge, event: 'pull_request' }).reason, /allow_auto_merge=true\); the merge-when-green fallback/)
  assert.equal(decide({ pr: pr(), update: minor, repo: noAutoMerge, event: 'workflow_run', checks: 'green' }).action, 'merge')
  assert.match(decide({ pr: pr(), update: minor, repo: noAutoMerge, event: 'workflow_run', checks: 'pending' }).reason, /still running/)
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

// Opened ten days ago unless a test says otherwise, so the minor wait (3 days by default) is over.
const DAYS_AGO = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

function automerge({ summary, event = 'pull_request', from = '2.1.0', to = '2.2.0', rules = [], allowAutoMerge = true, runs = [], payload, commits, body = null, headRef = 'dependabot/npm_and_yarn/release-kit', labels = [], comments = [], createdAt = DAYS_AGO(10), autoMerge = null, config, author = 'dependabot[bot]', files, open } = {}) {
  const dir = tmp('automerge')
  writeFileSync(join(dir, 'gh'), FAKE_GH, { mode: 0o755 })
  const state = {
    'repos/o/r/pulls/7/commits': commits ?? [{ commit: { message: DEPENDABOT.replaceAll('semver-minor', semverChange(from, to) ? `semver-${semverChange(from, to)}` : 'semver-minor') } }],
    'repos/o/r/issues/7/comments': comments,
    'repos/o/r/issues/7/labels': [],
    'repos/o/r/pulls/7/files': files ?? [],
    'repos/o/r/pulls/7': { number: 7, state: 'open', draft: false, auto_merge: autoMerge, created_at: createdAt, body, labels: labels.map((name) => ({ name })), user: { login: author }, head: { ref: headRef, sha: 'h'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { allow_auto_merge: allowAutoMerge } } },
    'repos/o/r/pulls?state=open': open ?? [{ number: 7, user: { login: author }, head: { ref: headRef } }, { number: 8, user: { login: 'n8watkins' }, head: { ref: 'feature' } }],
    ...(config ? { 'repos/o/r/contents/.release.json?ref=main': { content: b64(JSON.stringify(config)) } } : {}),
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
    ...(summary ? { GITHUB_STEP_SUMMARY: summary } : {}),
  })
  const calls = readFileSync(join(dir, 'log'), 'utf8').split('\n')
  const merges = calls.filter((line) => line.startsWith('pr merge') && !line.includes('--disable-auto'))
  const writes = calls.filter((line) => /^api -X (POST|DELETE) /.test(line))
  const disabled = calls.filter((line) => line.includes('--disable-auto'))
  return { ...result, merges, writes, disabled, calls }
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

// n8watkins/pivot#19: a multi-ecosystem group pull request whose Dependabot
// metadata has no update-type line. The versions are only in the prose.
const fixture = (name) => readFileSync(join(KIT, 'test/fixtures/automerge', name), 'utf8')
const PIVOT_19 = { body: fixture('pivot-19-body.txt'), commits: JSON.parse(fixture('pivot-19-commits.json')), headRef: 'dependabot/release_kit-0d65bea298', from: '2.5.2', to: '2.5.2' }

test('end to end: a Dependabot pull request without update-type is classified from the versions it names (pivot#19)', () => {
  const required = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI result' }] } }]
  const summary = join(tmp('automerge-summary'), 'summary.md')
  const pull = automerge({ ...PIVOT_19, rules: required, summary })
  assert.equal(pull.status, 0, pull.stderr)
  assert.match(pull.stdout, /auto-merge on for #7: vitest is a patch update/)
  assert.match(readFileSync(summary, 'utf8'), /\| vitest \| patch \| 4\.1\.10 to 4\.1\.11 \(the versions Dependabot names\) \|/)
  assert.deepEqual(pull.merges, [`pr merge 7 --repo o/r --auto --squash --match-head-commit ${'h'.repeat(40)}`])

  const green = automerge({ ...PIVOT_19, event: 'workflow_run', runs: [{ name: 'CI result', status: 'completed', conclusion: 'success' }] })
  assert.equal(green.status, 0, green.stderr)
  assert.deepEqual(green.merges, [`pr merge 7 --repo o/r --squash --match-head-commit ${'h'.repeat(40)}`])
})

test('end to end: an update whose versions cannot be read stays for a person, with the reason in the job summary', () => {
  const required = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI result' }] } }]
  const summary = join(tmp('automerge-summary'), 'summary.md')
  const sha = (c) => c.repeat(40)
  const message = `build(deps): bump actions/cache from ${sha('a')} to ${sha('b')}\n\nBumps [actions/cache](https://github.com/actions/cache) from ${sha('a')} to ${sha('b')}.\n\n---\nupdated-dependencies:\n- dependency-name: actions/cache\n  dependency-version: ${sha('b')}\n  dependency-type: direct:production\n...\n`
  const run = automerge({ commits: [{ commit: { message } }], from: '2.5.2', to: '2.5.2', rules: required, summary })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(run.merges, [])
  assert.match(run.stdout, /left for a person: could not tell what kind of update this is \(actions\/cache: pinned to commit SHAs with no version/)
  assert.match(readFileSync(summary, 'utf8'), /left for a person[\s\S]*\| actions\/cache \| unknown \| pinned to commit SHAs/)
})

// Dependabot commit messages and descriptions without the update-type line.
const meta = (...entries) => `---\nupdated-dependencies:\n${entries.map(([name, type]) => `- dependency-name: ${name}\n  dependency-version: 1.0.0\n  dependency-type: direct:production\n${type ? `  update-type: version-update:semver-${type}\n` : ''}`).join('')}...\n\nSigned-off-by: dependabot[bot] <support@github.com>`
const classify = (messages, body = '', kit) => classifyUpdate({ dependabot: true, messages, body, kit })

test('versionChange: semver levels, prereleases, downgrades and versions that cannot be compared', () => {
  assert.deepEqual(versionChange('4.1.10', '4.1.11'), { type: 'patch', why: '4.1.10 to 4.1.11' })
  assert.equal(versionChange('v1.2.3', 'v1.3.0').type, 'minor')
  assert.equal(versionChange('1.9.9', '2.0.0').type, 'major')
  assert.equal(versionChange('1.0.0+build.1', '1.0.1+build.2').type, 'patch')
  // A move to a prerelease promises no compatibility; its release counts as the line's change.
  assert.match(versionChange('1.2.3', '2.0.0-beta.1').why, /2\.0\.0-beta\.1 is a prerelease/)
  assert.equal(versionChange('2.0.0-beta.1', '2.0.0-beta.2').type, null)
  assert.equal(versionChange('2.0.0-rc.1', '2.0.0').type, 'major')
  assert.equal(versionChange('1.3.0-rc.1', '1.3.0').type, 'minor')
  assert.equal(versionChange('1.3.1-rc.1', '1.3.1').type, 'patch')
  assert.equal(versionChange('1.2.3', '1.2.4-rc.1').type, null)
  assert.equal(versionChange('2.0.0', '2.0.0-rc.1').type, 'downgrade')
  assert.equal(versionChange('1.0.0-beta.2', '1.0.0-beta.10').type, null, 'still a prerelease, not a downgrade')
  assert.equal(versionChange('1.0.0-beta.10', '1.0.0-beta.2').type, 'downgrade')
  assert.equal(versionChange('1.0.0-alpha', '1.0.0-alpha.1').type, null)
  assert.equal(versionChange('1.0.0-alpha.1', '1.0.0-alpha').type, 'downgrade')
  assert.equal(versionChange('1.0.0-rc.1', '1.0.0-beta.1').type, 'downgrade')
  assert.equal(versionChange('3.1.0', '3.0.9').type, 'downgrade')
  assert.match(versionChange('v4', 'v5').why, /not semantic versions \(v4 to v5\)/)
  assert.match(versionChange('11bd719', '08c6903').why, /commit SHAs with no version/)
  assert.match(versionChange('1.0.0', '1.0.0').why, /no version change/)
})

test('dependabotVersions: single, grouped, table, multi-directory and SHA-pinned lines', () => {
  assert.deepEqual(dependabotVersions('Bumps [vitest](https://github.com/vitest-dev/vitest/tree/HEAD/packages/vitest) from 4.1.10 to 4.1.11.\r\n'), [{ name: 'vitest', from: '4.1.10', to: '4.1.11' }])
  assert.deepEqual(dependabotVersions('Bumps lodash from 4.17.20 to 4.17.21.'), [{ name: 'lodash', from: '4.17.20', to: '4.17.21' }])
  const group = 'Bumps the npm group with 2 updates in the / directory: [a](u) and [@s/b](u).\n\nUpdates `a` from 1.0.0 to 1.0.1\n- [Release notes](u)\n\nUpdates `@s/b` from 2.0.0 to 2.1.0 in /web\n'
  assert.deepEqual(dependabotVersions(group), [{ name: 'a', from: '1.0.0', to: '1.0.1' }, { name: '@s/b', from: '2.0.0', to: '2.1.0' }])
  assert.deepEqual(dependabotVersions('| Package | From | To |\n| --- | --- | --- |\n| [next](u) | `15.0.0` | `15.1.0` |\n'), [{ name: 'next', from: '15.0.0', to: '15.1.0' }])
  const sha = 'Bumps [actions/checkout](https://github.com/actions/checkout) from 11bd71901bbe5b1630ceea73d27597364c9af683 (v4.2.2) to 08c6903cd8c0fde910a37f88322edcfb5dd907a8 (v5.0.0).'
  assert.deepEqual(dependabotVersions(sha), [{ name: 'actions/checkout', from: 'v4.2.2', to: 'v5.0.0' }])
  assert.deepEqual(dependabotVersions('Bumps [actions/cache](u) from 1bd1e32 to 5a3ec84.'), [{ name: 'actions/cache', from: '1bd1e32', to: '5a3ec84' }])
  assert.deepEqual(dependabotVersions('Updates the requirements on [x](u) to permit the latest version.\nBumps the npm group with 3 updates: [a](u), [b](u) and [c](u).'), [])
})

test('classifyUpdate: without update-type, each dependency is read from its versions and the group takes the biggest', () => {
  // A single update.
  const single = classify([`build(deps): bump next from 15.0.0 to 15.0.3\n\nBumps [next](u) from 15.0.0 to 15.0.3.\n\n${meta(['next'])}`])
  assert.deepEqual([single.type, single.what], ['patch', 'next'])
  // A group: minor wins over patch, and one major makes the group major.
  const grouped = (bVersion) => classify([`build(deps): bump the npm group with 2 updates\n\nBumps the npm group with 2 updates: [a](u) and [b](u).\n\nUpdates \`a\` from 1.0.0 to 1.0.1\n\nUpdates \`b\` from 2.0.0 to ${bVersion}\n\n${meta(['a'], ['b'])}`])
  assert.equal(grouped('2.1.0').type, 'minor')
  assert.equal(grouped('3.0.0').type, 'major')
  // A multi-ecosystem group: an npm entry with update-type next to an actions entry without one, read from the description.
  const multi = classify([`chore(deps): bump the release-kit group across 2 directories\n\n${meta(['release-kit', 'minor'], ['actions/setup-node'])}`], 'Updates `actions/setup-node` from 7.0.0 to 7.1.0\n')
  assert.deepEqual([multi.type, multi.what], ['minor', 'release-kit, actions/setup-node'])
  const multiMajor = classify([meta(['release-kit', 'patch'], ['actions/setup-node'])], 'Updates `actions/setup-node` from 6.4.0 to 7.0.0\n')
  assert.equal(multiMajor.type, 'major')
  // SHA-pinned actions: a version next to the SHA counts, SHAs alone don't.
  assert.equal(classify([meta(['actions/checkout'])], 'Bumps [actions/checkout](u) from 11bd719 (v4.2.2) to 08c6903 (v4.3.0).').type, 'minor')
  const shaOnly = classify([meta(['actions/cache'])], 'Bumps [actions/cache](u) from 1bd1e32 to 5a3ec84.')
  assert.deepEqual([shaOnly.type, shaOnly.why], [null, 'actions/cache: pinned to commit SHAs with no version (1bd1e32 to 5a3ec84)'])
  // Prereleases and versions that are not semver stay for a person.
  assert.match(classify([meta(['react'])], 'Bumps [react](u) from 19.0.0 to 19.1.0-canary.1.').why, /react: 19\.1\.0-canary\.1 is a prerelease/)
  assert.match(classify([meta(['node'])], 'Bumps node from 22-alpine to 24-alpine.').why, /node: not semantic versions/)
  // A downgrade in the text is still refused, and a dependency with no line at all is unknown.
  assert.equal(classify([meta(['x'])], 'Bumps [x](u) from 2.2.0 to 2.0.1.').type, 'downgrade')
  assert.match(classify([meta(['a'], ['b'])], 'Updates `a` from 1.0.0 to 1.0.1\n').why, /b has no update-type and no "from A to B" line/)
  // Commit messages win over a stale description; no metadata at all falls back to the lines themselves.
  assert.equal(classify([`Bumps [x](u) from 1.0.0 to 1.0.1.\n\n${meta(['x'])}`], 'Bumps [x](u) from 1.0.0 to 2.0.0.').type, 'patch')
  assert.equal(classify(['Bumps [x](u) from 1.0.0 to 1.1.0.']).type, 'minor')
  assert.deepEqual([classify(['chore: nothing']).type, classify(['chore: nothing']).why], [null, 'no version change found'])
  // update-type, where present, is still what counts, and the kit pin's downgrade refusal stays.
  assert.equal(classify([meta(['x', 'patch'])], 'Bumps [x](u) from 1.0.0 to 2.0.0.').type, 'patch')
  assert.equal(classify([meta(['release-kit', 'minor'])], '', ['2.2.0', '2.0.1']).type, 'downgrade')
  assert.equal(classifyUpdate({ kit: ['2.1.0', '2.2.0'] }).type, 'minor')
})

test('a pull request whose required checks already passed is merged directly, since GitHub refuses auto-merge on it (voicedock, v2.7.0)', () => {
  assert.equal(alreadyMergeable({ stderr: 'GraphQL: Pull request Pull request is in unstable status (enablePullRequestAutoMerge)\n' }), true)
  assert.equal(alreadyMergeable(new Error('GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)')), true)
  assert.equal(alreadyMergeable({ stderr: 'GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)' }), false)
  assert.equal(alreadyMergeable({ stderr: 'Pull request is in blocked status' }), false)
  assert.equal(alreadyMergeable(undefined), false)
  // main merges directly only after that refusal, still matching the head commit.
  const source = readFileSync(join(KIT, 'template/scripts/release-kit/automerge.mjs'), 'utf8')
  assert.match(source, /if \(!alreadyMergeable\(error\)\) throw error\n(?: {8}\/\/.*\n)* {8}gh\('pr', 'merge', String\(number\), '--repo', repoName, `--\$\{method\}`, '--match-head-commit', raw\.head\.sha\)/)
})

// Below 1.0.0 SemVer lets a minor update break (and release-kit's own pre-1.0
// rule ships breaking changes as minors), so a 0.x minor waits for a person.
// A Dependabot commit as Dependabot writes it, for one dependency or a group.
const bump = (...deps) => {
  const one = deps.length === 1
  const lines = deps.map(([name, from, to]) => (one ? `Bumps [${name}](u) from ${from} to ${to}.` : `Updates \`${name}\` from ${from} to ${to}`))
  const entries = deps.map(([name, from, to]) => `- dependency-name: ${name}\n  dependency-version: ${to}\n  dependency-type: direct:production\n  update-type: version-update:semver-${semverChange(from, to)}\n`)
  return `build(deps): bump ${one ? deps[0][0] : 'the npm-minor-patch group'}\n\n${lines.join('\n\n')}\n\n---\nupdated-dependencies:\n${entries.join('')}...\n\nSigned-off-by: dependabot[bot] <support@github.com>`
}

test('classifyUpdate: a minor update below 1.0.0 is marked for review, a patch below 1.0.0 and a minor from 1.0.0 on are not', () => {
  assert.equal(majorOf('v0.13.2'), 0)
  assert.equal(majorOf('1.0.0'), 1)
  assert.equal(majorOf('v4'), null)
  // 0.x patch: auto.
  const patch = classify([bump(['zod-lite', '0.13.1', '0.13.2'])])
  assert.deepEqual([patch.type, patch.belowOne], ['patch', []])
  // 0.x minor: review, with the versions it read.
  const zeroMinor = classify([bump(['zod-lite', '0.13.2', '0.14.0'])])
  assert.deepEqual([zeroMinor.type, zeroMinor.belowOne], ['minor', ['zod-lite']])
  assert.deepEqual([zeroMinor.parts[0].from, zeroMinor.parts[0].to], ['0.13.2', '0.14.0'])
  assert.match(zeroMinor.parts[0].why, /its update-type \(0\.13\.2 to 0\.14\.0\), below 1\.0\.0/)
  // 1.x minor: auto, as before.
  const oneMinor = classify([bump(['next', '1.4.0', '1.5.0'])])
  assert.deepEqual([oneMinor.type, oneMinor.belowOne], ['minor', []])
  // A group with a mixed set: one 0.x minor makes the whole group wait.
  const mixed = classify([bump(['a', '0.4.1', '0.4.2'], ['b', '2.0.0', '2.1.0'], ['c', '0.2.0', '0.3.0'])])
  assert.deepEqual([mixed.type, mixed.belowOne], ['minor', ['c']])
  // Without a "from A to B" line, dependency-version alone tells, since a minor keeps the major.
  assert.deepEqual(classify(['---\nupdated-dependencies:\n- dependency-name: x\n  dependency-version: 0.5.0\n  update-type: version-update:semver-minor\n...\n']).belowOne, ['x'])
  // Without the update-type, the versions Dependabot names.
  assert.deepEqual(classify([meta(['x'])], 'Bumps [x](u) from 0.1.0 to 0.2.0.').belowOne, ['x'])
  // A minor update with no version at all might be below 1.0.0, so it can't be read.
  const blind = classify(['---\nupdated-dependencies:\n- dependency-name: actions/thing\n  dependency-version: ' + 'b'.repeat(40) + '\n  update-type: version-update:semver-minor\n...\n'])
  assert.equal(blind.type, null)
  assert.match(blind.why, /actions\/thing: a minor update with no readable version .* might be below 1\.0\.0/)
})

test('decide: a minor update below 1.0.0 is left for a person to review, on both events', () => {
  const zero = { type: 'minor', what: 'a, c', belowOne: ['c'] }
  for (const [repo, event] of [[protectedRepo, 'pull_request'], [freePrivate, 'workflow_run']]) {
    const decision = decide({ pr: pr(), update: zero, repo, event, checks: 'green' })
    assert.equal(decision.action, 'review')
    assert.match(decision.reason, /c is below 1\.0\.0, where a minor update may break \(SemVer\): a person reviews/)
  }
  assert.match(decide({ pr: pr(), update: { ...zero, belowOne: ['b', 'c'] }, repo: protectedRepo, event: 'pull_request' }).reason, /b, c are below 1\.0\.0/)
  // A major in the same group still reads as the major; patches and 1.x minors still merge.
  assert.match(decide({ pr: pr(), update: { ...zero, type: 'major' }, repo: protectedRepo, event: 'pull_request' }).reason, /major update/)
  assert.equal(decide({ pr: pr(), update: { type: 'minor', what: 'next', belowOne: [] }, repo: protectedRepo, event: 'pull_request' }).action, 'enable')
  assert.equal(decide({ pr: pr(), update: { type: 'patch', what: 'a', belowOne: [] }, repo: freePrivate, event: 'workflow_run', checks: 'green' }).action, 'merge')
  // A draft or a pull request from someone else is skipped as before, not labeled.
  assert.equal(decide({ pr: pr({ draft: true }), update: zero, repo: protectedRepo, event: 'pull_request' }).action, 'skip')
  const comment = reviewComment(classify([bump(['a', '0.4.1', '0.4.2'], ['c', '0.2.0', '0.3.0'])]))
  assert.match(comment, /^<!-- release-kit: 0\.x minor -->\n/)
  assert.match(comment, /\| c \| 0\.2\.0 \| 0\.3\.0 \|/)
  assert.doesNotMatch(comment, /\| a \|/)
})

test('end to end: 0.x patch and 1.x minor merge on their own; a 0.x minor or a group with one is labeled and explained once', () => {
  const required = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI result' }] } }]
  const enable = [`pr merge 7 --repo o/r --auto --squash --match-head-commit ${'h'.repeat(40)}`]
  const run = (deps, more = {}) => automerge({ commits: [{ commit: { message: bump(...deps) } }], from: '2.5.2', to: '2.5.2', rules: required, ...more })

  const zeroPatch = run([['zod-lite', '0.13.1', '0.13.2']])
  assert.equal(zeroPatch.status, 0, zeroPatch.stderr)
  assert.deepEqual([zeroPatch.merges, zeroPatch.writes], [enable, []])

  const oneMinor = run([['zod', '3.4.0', '3.5.0']])
  assert.deepEqual([oneMinor.merges, oneMinor.writes], [enable, []])

  const zeroMinor = run([['zod-lite', '0.13.2', '0.14.0']])
  assert.equal(zeroMinor.status, 0, zeroMinor.stderr)
  assert.deepEqual(zeroMinor.merges, [])
  assert.match(zeroMinor.stdout, /::notice title=Auto-merge::#7 left for a person, labeled "needs-review: 0\.x minor": zod-lite is below 1\.0\.0/)
  assert.equal(zeroMinor.writes[0], `api -X POST -f labels[]=${REVIEW_LABEL} repos/o/r/issues/7/labels`)
  assert.match(zeroMinor.writes[1], /^api -X POST -f body=<!-- release-kit: 0\.x minor -->/)

  // The mixed group, on the merge-when-green fallback with green checks.
  const summary = join(tmp('automerge-summary'), 'summary.md')
  const group = run([['a', '0.4.1', '0.4.2'], ['b', '2.0.0', '2.1.0'], ['c', '0.2.0', '0.3.0']], { rules: [], event: 'workflow_run', runs: [{ name: 'CI result', status: 'completed', conclusion: 'success' }], summary })
  assert.equal(group.status, 0, group.stderr)
  assert.deepEqual(group.merges, [])
  assert.equal(group.writes.length, 2)
  assert.match(readFileSync(summary, 'utf8'), /\| c \| minor \| its update-type \(0\.2\.0 to 0\.3\.0\), below 1\.0\.0 \(Dependabot metadata\) \|/)

  // A later run finds the label and the comment there already and writes neither again.
  const again = run([['zod-lite', '0.13.2', '0.14.0']], { labels: [REVIEW_LABEL], comments: [{ body: reviewComment(classify([bump(['zod-lite', '0.13.2', '0.14.0'])])) }] })
  assert.deepEqual([again.merges, again.writes], [[], []])

  // A label left from an earlier version of the pull request goes once it may merge.
  const cleared = run([['zod-lite', '0.13.1', '0.13.2']], { labels: [REVIEW_LABEL] })
  assert.deepEqual(cleared.merges, enable)
  assert.deepEqual(cleared.writes, [`api -X DELETE repos/o/r/issues/7/labels/${encodeURIComponent(REVIEW_LABEL)}`])
})

// The tightened policy (F5): a minor update waits a few days, held packages
// and actions not pinned to a commit SHA wait for a person, and a scheduled
// run merges what has waited long enough.
const REQUIRED = [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'CI result' }] } }]
const ENABLE = [`pr merge 7 --repo o/r --auto --squash --match-head-commit ${'h'.repeat(40)}`]
const MERGE = [`pr merge 7 --repo o/r --squash --match-head-commit ${'h'.repeat(40)}`]
const GREEN = [{ name: 'CI result', status: 'completed', conclusion: 'success' }]
const deps = (list, more = {}) => automerge({ commits: [{ commit: { message: bump(...list) } }], from: '2.5.2', to: '2.5.2', rules: REQUIRED, ...more })

test('autoMergePolicy: safe defaults, the repo\'s settings, and every setting it cannot use named', () => {
  const defaults = autoMergePolicy(undefined)
  assert.deepEqual([defaults.minorWaitDays, defaults.patchWaitDays, defaults.problems], [3, 0, []])
  assert.deepEqual(defaults.hold, DEFAULT_HOLD)
  for (const name of ['next', '@opennextjs/cloudflare', 'wrangler', '@cloudflare/workers-types']) assert.ok(defaults.hold.some((p) => matchesHold(name, p)), name)
  assert.ok(!defaults.hold.some((p) => matchesHold('nextra', p)), 'a prefix only matches a pattern that ends in *')
  assert.deepEqual(autoMergePolicy(false).hold, DEFAULT_HOLD)

  const own = autoMergePolicy({ minorWaitDays: 0, patchWaitDays: 2, hold: ['my-sdk', '@acme/*'], unhold: ['vite', '@vitejs/*'] })
  assert.deepEqual([own.minorWaitDays, own.patchWaitDays, own.problems], [0, 2, []])
  assert.ok(own.hold.includes('my-sdk') && own.hold.includes('@acme/*') && own.hold.includes('next'))
  assert.ok(!own.hold.includes('vite'))

  // Bad values keep the safe default, and say so.
  const bad = autoMergePolicy({ minorWaitDays: -1, patchWaitDays: '2', hold: 'next', unhold: ['lodash'], waitDays: 3 })
  assert.deepEqual([bad.minorWaitDays, bad.patchWaitDays], [3, 0])
  assert.deepEqual(bad.hold, DEFAULT_HOLD)
  assert.equal(bad.problems.length, 5)
  assert.match(bad.problems.join('\n'), /"autoMerge\.waitDays" is not a setting[\s\S]*minorWaitDays" must be a whole number of days from 0 to 90, not -1; using 3[\s\S]*unhold" names "lodash", which the kit doesn't hold[\s\S]*"autoMerge\.hold" must be a list/)
  assert.match(autoMergePolicy(['next']).problems[0], /"autoMerge" must be false or an object/)
})

test('decide: a minor update waits out its days, a held package or an unpinned action waits for a person', () => {
  const policy = autoMergePolicy(undefined)
  const now = Date.parse('2026-11-25T12:00:00Z')
  const opened = (days) => new Date(now - days * 86_400_000).toISOString()
  const update = (type, names) => ({ type, what: names.join(', '), parts: names.map((name) => ({ name, type, from: '1.0.0', to: type === 'minor' ? '1.1.0' : '1.0.1' })), belowOne: [] })
  const go = (u, more = {}) => {
    const p = pr({ createdAt: opened(1), ...more })
    return decide({ pr: p, update: u, repo: protectedRepo, event: 'pull_request', held: heldBy({ pr: p, update: u, policy, actionRefs: more.actionRefs }), wait: waitFor({ pr: p, update: u, policy, now }), now })
  }
  const waiting = go(update('minor', ['zod']))
  assert.equal(waiting.action, 'wait')
  assert.equal(new Date(waiting.until).toISOString(), '2026-11-27T12:00:00.000Z')
  assert.match(waiting.reason, /zod is a minor update, which merges on its own only once its pull request has been open 3 days/)
  assert.equal(go(update('minor', ['zod']), { createdAt: opened(3) }).action, 'enable')
  // Patches merge on green; a Dependabot kit update waits the minor wait even as a patch.
  assert.equal(go(update('patch', ['zod'])).action, 'enable')
  assert.equal(go(update('patch', ['release-kit'])).action, 'wait')
  // An opening time that can't be read never skips the wait.
  assert.equal(go(update('minor', ['zod']), { createdAt: undefined }).action, 'wait')
  // The rollout bot's kit update is governed by the rollout's soak, not this wait.
  const kit = { type: 'minor', what: 'release-kit', parts: [{ name: 'release-kit', type: 'minor' }] }
  const bot = pr({ author: 'release-kit-bot[bot]', headRef: 'release-kit/update', createdAt: opened(0) })
  assert.equal(waitFor({ pr: bot, update: kit, policy, now }), null)
  assert.equal(decide({ pr: bot, update: kit, repo: protectedRepo, event: 'pull_request', bots: ['dependabot[bot]', 'release-kit-bot[bot]'], held: heldBy({ pr: bot, update: kit, policy }), now }).action, 'enable')

  // A held package holds the whole group, even a patch, even after the wait.
  const held = go(update('patch', ['zod', 'next']), { createdAt: opened(30) })
  assert.equal(held.action, 'review')
  assert.deepEqual(held.labels, [HOLD_LABEL])
  assert.match(held.reason, /it updates next, which waits for a person \(held for a person\): a person reviews and merges it/)
  const scoped = go(update('minor', ['@opennextjs/cloudflare']))
  assert.match(scoped.reason, /@opennextjs\/cloudflare, which waits for a person \(held for a person \(@opennextjs\/\*\)\)/)
  // A 0.x minor that is also held gets both labels.
  const both = { ...update('minor', ['wrangler']), belowOne: ['wrangler'] }
  assert.deepEqual(go(both).labels, [REVIEW_LABEL, HOLD_LABEL])

  // GitHub Actions updates: pinned to commit SHAs they may merge; a tag, or refs that can't be read, wait for a person.
  const actions = update('minor', ['actions/cache'])
  const branch = 'dependabot/github_actions/actions-minor-patch-1a2b'
  assert.equal(go(actions, { headRef: branch, createdAt: opened(5), actionRefs: [{ action: 'actions/cache', ref: 'a'.repeat(40) }] }).action, 'enable')
  assert.match(go(actions, { headRef: branch, createdAt: opened(5), actionRefs: [{ action: 'actions/cache', ref: 'v4.3.0' }] }).reason, /actions\/cache, which waits for a person \(a GitHub Action pinned to a tag or branch, not a commit SHA\)/)
  assert.equal(go(actions, { headRef: branch, createdAt: opened(5), actionRefs: null }).action, 'review')
  assert.equal(go(actions, { headRef: branch, createdAt: opened(5), actionRefs: [] }).action, 'review')

  // A scheduled look again acts like pull_request where checks are required, else like workflow_run.
  const old = pr({ createdAt: opened(5) })
  const u = update('minor', ['zod'])
  assert.equal(decide({ pr: old, update: u, repo: protectedRepo, event: 'schedule', now }).action, 'enable')
  assert.equal(decide({ pr: old, update: u, repo: freePrivate, event: 'schedule', checks: 'green', now }).action, 'merge')
  assert.equal(decide({ pr: old, update: u, repo: freePrivate, event: 'schedule', checks: 'pending', now }).action, 'skip')
})

test('addedActionRefs reads the uses: lines a pull request adds, and gives up when a patch is missing', () => {
  const patch = '@@ -1 +1 @@\n-      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.0\n+      - uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.3.0\n+    uses: "owner/x@v2"\n context'
  assert.deepEqual(addedActionRefs([{ filename: '.github/workflows/ci.yml', patch }, { filename: 'src/a.js', patch: '+uses: no@v1' }]), [
    { action: 'actions/cache', ref: '5a3ec84eff668545956fd18022155c47e93e2684' },
    { action: 'owner/x', ref: 'v2' },
  ])
  assert.equal(addedActionRefs([{ filename: '.github/workflows/ci.yml' }]), null)
})

test('end to end: a fresh minor update waits, labeled and explained once, and merges once it has waited (or the repo says 0)', () => {
  const fresh = deps([['zod', '3.4.0', '3.5.0']], { createdAt: DAYS_AGO(1) })
  assert.equal(fresh.status, 0, fresh.stderr)
  assert.deepEqual(fresh.merges, [])
  assert.match(fresh.stdout, /::notice title=Auto-merge::#7 is waiting, labeled "auto-merge: waiting": zod is a minor update/)
  assert.equal(fresh.writes[0], `api -X POST -f labels[]=${WAIT_LABEL} repos/o/r/issues/7/labels`)
  assert.equal(fresh.writes[1], 'api -X POST -f body=<!-- release-kit: waiting -->')
  const until = Date.parse('2026-11-27T12:00:00Z')
  assert.match(waitComment({ type: 'minor' }, { days: 3, until }), /^<!-- release-kit: waiting -->\n\*\*Auto-merge is waiting\.\*\* This minor update merges on its own once the pull request has been open 3 days, from 2026-11-27 12:00 UTC, and its checks pass\.\n[\s\S]*Merge it by hand to skip the wait/)
  assert.equal(fresh.writes.length, 2)
  // Turned on by an earlier kit version: auto-merge is switched off while it waits.
  assert.equal(deps([['zod', '3.4.0', '3.5.0']], { createdAt: DAYS_AGO(1), autoMerge: { enabled_by: {} } }).disabled.length, 1)
  // Already labeled and explained: nothing written again.
  const again = deps([['zod', '3.4.0', '3.5.0']], { createdAt: DAYS_AGO(1), labels: [WAIT_LABEL], comments: [{ body: '<!-- release-kit: waiting -->' }] })
  assert.deepEqual([again.merges, again.writes], [[], []])
  // Waited long enough: it merges, and the label goes.
  const ready = deps([['zod', '3.4.0', '3.5.0']], { labels: [WAIT_LABEL] })
  assert.deepEqual(ready.merges, ENABLE)
  assert.deepEqual(ready.writes, [`api -X DELETE repos/o/r/issues/7/labels/${encodeURIComponent(WAIT_LABEL)}`])
  // A patch merges on green, unless the repo says to wait for those too; minorWaitDays 0 turns the wait off.
  assert.deepEqual(deps([['zod', '3.4.0', '3.4.1']], { createdAt: DAYS_AGO(0) }).merges, ENABLE)
  assert.deepEqual(deps([['zod', '3.4.0', '3.4.1']], { createdAt: DAYS_AGO(0), config: { autoMerge: { patchWaitDays: 2 } } }).merges, [])
  assert.deepEqual(deps([['zod', '3.4.0', '3.5.0']], { createdAt: DAYS_AGO(0), config: { autoMerge: { minorWaitDays: 0 } } }).merges, ENABLE)
  // A .release.json that can't be read keeps the safe defaults, with a warning.
  const unreadable = deps([['zod', '3.4.0', '3.5.0']], { createdAt: DAYS_AGO(0), config: { autoMerge: { minorWaitDays: 'none' } } })
  assert.deepEqual(unreadable.merges, [])
  assert.match(unreadable.stdout, /::warning title=Auto-merge::\.release\.json "autoMerge\.minorWaitDays" must be a whole number/)
})

test('end to end: a group with a held package waits for a person as a whole, with a comment naming it', () => {
  const summary = join(tmp('automerge-summary'), 'summary.md')
  const held = deps([['zod', '3.4.0', '3.4.1'], ['next', '15.1.0', '15.1.2']], { autoMerge: { enabled_by: {} }, summary })
  assert.equal(held.status, 0, held.stderr)
  assert.deepEqual(held.merges, [])
  assert.equal(held.disabled.length, 1, 'auto-merge turned on earlier is switched off')
  assert.match(held.stdout, /#7 left for a person, labeled "needs-review: held dependency": it updates next, which waits for a person/)
  assert.equal(held.writes[0], `api -X POST -f labels[]=${HOLD_LABEL} repos/o/r/issues/7/labels`)
  assert.equal(held.writes[1], 'api -X POST -f body=<!-- release-kit: held -->')
  const policy = autoMergePolicy(undefined)
  const update = classifyUpdate({ dependabot: true, messages: [bump(['zod', '3.4.0', '3.4.1'], ['next', '15.1.0', '15.1.2'])] })
  const comment = holdComment(heldBy({ pr: pr(), update, policy }))
  assert.match(comment, /^<!-- release-kit: held -->\n\*\*Auto-merge left this for a person\.\*\*[\s\S]*\| next \| 15\.1\.0 \| 15\.1\.2 \| held for a person \|/)
  assert.doesNotMatch(comment, /\| zod \|/)
  assert.match(readFileSync(summary, 'utf8'), /needs-review: held dependency/)
  // The repo's own list adds to the defaults, and unhold takes a default out.
  assert.deepEqual(deps([['my-sdk', '1.0.0', '1.0.1']], { config: { autoMerge: { hold: ['my-sdk'] } } }).merges, [])
  assert.deepEqual(deps([['next', '15.1.0', '15.1.2']], { config: { autoMerge: { unhold: ['next'] } } }).merges, ENABLE)
  // On the merge-when-green fallback too.
  const green = deps([['wrangler', '4.1.0', '4.1.1']], { rules: [], event: 'workflow_run', runs: GREEN })
  assert.deepEqual(green.merges, [])
  assert.match(green.stdout, /held dependency/)
})

test('end to end: a GitHub Actions update merges only when every action it changes is pinned to a commit SHA', () => {
  const headRef = 'dependabot/github_actions/actions-minor-patch-1a2b'
  const patch = (ref) => [{ filename: '.github/workflows/ci.yml', patch: `@@ -1 +1 @@\n-      - uses: actions/cache@${'0'.repeat(40)} # v4.2.0\n+      - uses: actions/cache@${ref} # v4.3.0\n` }]
  const pinned = deps([['actions/cache', '4.2.0', '4.3.0']], { headRef, files: patch('5'.repeat(40)) })
  assert.deepEqual(pinned.merges, ENABLE)
  const tagged = deps([['actions/cache', '4.2.0', '4.3.0']], { headRef, files: [{ filename: '.github/workflows/ci.yml', patch: '-      - uses: actions/cache@v4.2.0\n+      - uses: actions/cache@v4.3.0\n' }] })
  assert.deepEqual(tagged.merges, [])
  assert.match(tagged.stdout, /actions\/cache, which waits for a person \(a GitHub Action pinned to a tag or branch, not a commit SHA\)/)
  assert.match(holdComment([{ name: 'actions/cache', from: null, to: 'v4.3.0', why: 'a GitHub Action pinned to a tag or branch, not a commit SHA' }]), /\| actions\/cache \| \? \| v4\.3\.0 \| a GitHub Action pinned to a tag or branch, not a commit SHA \|/)
  // No patch to read: held, never guessed.
  assert.deepEqual(deps([['actions/cache', '4.2.0', '4.3.0']], { headRef, files: [{ filename: '.github/workflows/ci.yml' }] }).merges, [])
})

test('end to end: a scheduled run looks again at every open update pull request and merges the ones that waited long enough', () => {
  const sched = deps([['zod', '3.4.0', '3.5.0']], { event: 'schedule' })
  assert.equal(sched.status, 0, sched.stderr)
  assert.deepEqual(sched.merges, ENABLE)
  // Only update pull requests are looked at: #8 is a person's.
  assert.ok(!sched.calls.some((line) => /pulls\/8\b/.test(line)))
  const fresh = deps([['zod', '3.4.0', '3.5.0']], { event: 'schedule', createdAt: DAYS_AGO(1) })
  assert.deepEqual(fresh.merges, [])
  assert.match(fresh.stdout, /is waiting/)
  // Without required checks it merges once every check passed, as on workflow_run.
  assert.deepEqual(deps([['zod', '3.4.0', '3.5.0']], { event: 'schedule', rules: [], runs: GREEN }).merges, MERGE)
  assert.deepEqual(deps([['zod', '3.4.0', '3.5.0']], { event: 'workflow_dispatch', rules: [], runs: [{ name: 'CI result', status: 'in_progress', conclusion: null }] }).merges, [])
  const none = deps([['zod', '3.4.0', '3.5.0']], { event: 'schedule', open: [] })
  assert.match(none.stdout, /no open update pull requests/)
})

test('apply writes an auto-merge.yml that looks again every day, and check flags one written before that', () => {
  const repo = makeRepo(tmp('automerge-apply'))
  run(KIT, 'node', ['apply.mjs', repo])
  const path = join(repo, '.github/workflows/auto-merge.yml')
  const workflow = readFileSync(path, 'utf8')
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: "37 7 \* \* \*" # release-kit: look again at waiting update pull requests\n {2}workflow_dispatch:\n/m)
  assert.match(workflow, /\n {6}\|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\n/)
  // A repo still on the auto-merge.yml of an older kit: check names the file apply would change.
  writeFileSync(path, workflow.replace(/ {2}schedule:\n.*\n {2}workflow_dispatch:\n/, ''))
  const check = attempt(repo, 'node', [join(KIT, 'apply.mjs'), '.', '--check', '--json'])
  assert.equal(check.status, 1)
  assert.deepEqual(JSON.parse(check.stdout).files.changed, ['.github/workflows/auto-merge.yml'])
  // apply names an autoMerge setting it can't use, and keeps the safe default.
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')), autoMerge: { minorWaitDays: 'soon' } }))
  assert.match(run(KIT, 'node', ['apply.mjs', repo]), /! \.release\.json "autoMerge\.minorWaitDays" must be a whole number of days from 0 to 90, not "soon"; using 3/)
})
