import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RELEASE_TAG, compareVersions, lint, nextVersion, parse, planRelease, suggestedBump, userFacing } from '../template/scripts/release-kit/conventional.mjs'
import { messageFromFile } from '../template/scripts/release-kit/commit-msg.mjs'
import { renderNotes } from '../template/scripts/release-kit/notes.mjs'

test('accepts conventional messages, including ones from these repos', () => {
  for (const message of [
    'feat: add dark mode',
    'fix(tube-vault): only [INFO]-tag the summary when title-tagging is on',
    'build(tube-vault): v0.3.80',
    'docs: record verified 1.0.0 release status',
    'feat!: drop Google auth',
    'chore(release): v1.2.0',
    'Merge pull request #7 from n8watkins/dependabot/x',
    'Revert "feat: add dark mode"',
  ]) {
    assert.equal(lint(message), null, message)
  }
})

test('rejects plain-sentence and malformed messages with a reason', () => {
  assert.match(lint('Lower first-sentence latency: small first chunk'), /unknown type|expected/)
  assert.match(lint('Drop Google auth - GitHub-only'), /expected "type\(scope\): subject"/)
  assert.match(lint('feature: add thing'), /unknown type "feature"/)
  assert.match(lint('feat:no space'), /expected/)
  assert.match(lint(`feat: ${'x'.repeat(120)}`), /keep it to 100/)
  assert.match(lint(''), /empty/)
})

test('detects breaking changes from ! or the footer', () => {
  assert.equal(parse('feat!: new config format').breaking, true)
  assert.equal(parse('refactor: move files\n\nBREAKING CHANGE: paths changed').breaking, true)
  assert.equal(parse('feat: add').breaking, false)
})

test('bumps versions and suggests the bump from the commits', () => {
  assert.equal(nextVersion('0.3.9', 'patch'), '0.3.10')
  assert.equal(nextVersion('0.3.9', 'minor'), '0.4.0')
  assert.equal(nextVersion('0.3.9', 'major'), '1.0.0')
  assert.equal(nextVersion('0.3.9', '2.0.0'), '2.0.0')
  assert.throws(() => nextVersion('0.3.9', 'huge'))
  assert.equal(suggestedBump([{ message: 'fix: a' }, { message: 'docs: b' }]), 'patch')
  assert.equal(suggestedBump([{ message: 'fix: a' }, { message: 'feat: b' }]), 'minor')
  assert.equal(suggestedBump([{ message: 'feat!: a' }]), 'major')
})

test('notes keep user-facing changes, grouped, and drop chores, docs and bots', () => {
  const notes = renderNotes([
    { hash: 'a'.repeat(40), author: 'Nathan', message: 'feat(popup): add dark mode' },
    { hash: 'b'.repeat(40), author: 'Nathan', message: 'fix: keep the last tab open' },
    { hash: 'c'.repeat(40), author: 'Nathan', message: 'docs: update README' },
    { hash: 'd'.repeat(40), author: 'github-actions[bot]', message: 'feat: sync portfolios from upstream' },
    { hash: 'e'.repeat(40), author: 'Nathan', message: 'Lower first-sentence latency' },
  ], { heading: '## 1.1.0 - 2026-10-23', repoUrl: 'https://github.com/o/r' })
  assert.match(notes, /^## 1\.1\.0 - 2026-10-23/)
  assert.match(notes, /### New\n\n- Add dark mode \(\[aaaaaaa\]/)
  assert.match(notes, /### Fixed\n\n- Keep the last tab open/)
  assert.doesNotMatch(notes, /README|sync portfolios|latency/)
  assert.match(renderNotes([{ hash: 'x', author: 'N', message: 'chore: deps' }]), /Maintenance release/)
})

test('CRLF line endings and a byte-order mark change nothing', () => {
  assert.equal(lint('﻿feat: add dark mode\r\n\r\nbody\r\n'), null)
  assert.equal(lint('fix: a\r\n'), null)
  assert.equal(parse('﻿fix(ui): keep the tab\r\n').subject, 'keep the tab')
  assert.equal(parse('refactor: move\r\n\r\nBREAKING CHANGE: paths changed\r\n').breaking, true)
  assert.equal(parse('feat: a\r\rb').subject, 'a')
  assert.match(lint('﻿Added a thing\r\n'), /expected/)
})

test('the hook reads the message git will store, not the raw file', () => {
  assert.equal(messageFromFile('feat: a\n# Please enter the commit message\n'), 'feat: a\n')
  assert.equal(messageFromFile('﻿feat: a\r\n\r\n# comment\r\n'), 'feat: a\n\n')
  assert.equal(messageFromFile('\n\nfix: b\n'), 'fix: b\n')
  // git commit -v: the diff below the scissors line is not part of the message.
  const verbose = 'fix: b\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+Added a line\n'
  assert.equal(lint(messageFromFile(verbose)), null)
  assert.doesNotMatch(messageFromFile(verbose), /diff/)
  // core.commentChar
  assert.equal(messageFromFile('feat: a\n; note\n#notacomment', ';'), 'feat: a\n#notacomment')
})

test('release tags are exactly vX.Y.Z', () => {
  for (const tag of ['v0.1.0', 'v1.10.0', 'v12.0.3']) assert.ok(RELEASE_TAG.test(tag), tag)
  for (const tag of ['1.2.3', 'v1.2', 'v1.2.3-beta.1', 'v01.2.3', 'v1.2.3$(id)', 'v1.2.3;rm', 'v1.2.3\n', 'v1.2.3 ']) {
    assert.ok(!RELEASE_TAG.test(tag), JSON.stringify(tag))
  }
})

test('versions compare numerically and explicit versions must move forward', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0)
  assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
  assert.throws(() => nextVersion('1.2.0', '1.1.9'), /not higher/)
  assert.throws(() => nextVersion('1.2.0', '1.2.0'), /not higher/)
  assert.throws(() => nextVersion('1.2.0', '01.3.0'), /not a valid/)
  assert.throws(() => nextVersion('1.2.0-beta', 'patch'), /not x\.y\.z/)
})

test('bot commits neither bump the version nor count as user-facing', () => {
  const botFeat = { author: 'github-actions[bot]', message: 'feat: sync portfolios' }
  assert.equal(suggestedBump([botFeat, { author: 'N', message: 'fix: a' }]), 'patch')
  assert.deepEqual(userFacing([botFeat, { author: 'dependabot[bot]', message: 'fix(deps): bump x' }]), [])
})

test('the release train plans a release only for user-facing work', () => {
  const c = (message, author = 'N') => ({ author, message })
  assert.deepEqual(planRelease({ current: '1.1.0', commits: [] }), { release: false, reason: 'no commits' })
  const chores = planRelease({ current: '1.1.0', commits: [c('docs: a'), c('chore: b'), c('test: c'), c('chore(release): v1.1.0', 'github-actions[bot]')] })
  assert.equal(chores.release, false)
  assert.match(chores.reason, /4 commits, none user-facing/)
  assert.deepEqual(planRelease({ current: '1.1.0', commits: [c('docs: a'), c('fix: b')] }), { release: true, reason: '1 user-facing of 2 commits', bump: 'patch', version: '1.1.1' })
  assert.equal(planRelease({ current: '1.1.0', commits: [c('perf: a')] }).version, '1.1.1')
  assert.equal(planRelease({ current: '1.1.0', commits: [c('fix: a'), c('feat(ui): b')] }).version, '1.2.0')
  assert.equal(planRelease({ current: '1.1.0', commits: [c('refactor!: drop the old API')] }).version, '2.0.0')
  assert.equal(planRelease({ current: '0.4.2', commits: [c('feat: a')] }).version, '0.5.0')
  assert.equal(planRelease({ current: '1.1.0', commits: [c('feat: a', 'dependabot[bot]')] }).release, false)
  // An explicit bump releases any commits, user-facing or not.
  assert.deepEqual(planRelease({ current: '1.1.0', commits: [c('docs: a')], bump: 'minor' }), { release: true, reason: 'minor requested, 1 commit', bump: 'minor', version: '1.2.0' })
  assert.equal(planRelease({ current: '1.1.0', commits: [], bump: 'major' }).release, false)
  assert.throws(() => planRelease({ current: '1.1.0', commits: [c('fix: a')], bump: 'huge' }), /unknown bump/)
})

test('leading blank lines are dropped, as git drops them', () => {
  assert.equal(lint('\n\nfeat: a'), null)
  assert.equal(lint('\r\n  \nfix: b\n'), null)
  assert.equal(parse('\n\nfix(ui): b').scope, 'ui')
  assert.match(lint('\n\n'), /empty/)
})

test('security commits pass the check and get their own section', () => {
  assert.equal(lint('security: verify every model download with SHA-256'), null)
  const notes = renderNotes([
    { hash: 'a', author: 'N', message: 'security: verify downloads' },
    { hash: 'b', author: 'N', message: 'fix: a' },
    { hash: 'c', author: 'N', message: 'perf: b' },
  ])
  assert.equal(notes, '### Fixed\n\n- A\n\n### Safer\n\n- Verify downloads\n\n### Faster\n\n- B\n')
  assert.equal(suggestedBump([{ message: 'security: a' }]), 'patch')
  assert.equal(planRelease({ current: '1.0.0', commits: [{ author: 'N', message: 'security: a' }] }).version, '1.0.1')
})
