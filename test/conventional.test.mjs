import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lint, nextVersion, parse, suggestedBump } from '../template/scripts/release-kit/conventional.mjs'
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
  assert.match(notes, /### Features\n\n- \*\*popup:\*\* Add dark mode \(\[aaaaaaa\]/)
  assert.match(notes, /### Fixes\n\n- Keep the last tab open/)
  assert.doesNotMatch(notes, /README|sync portfolios|latency/)
  assert.match(renderNotes([{ hash: 'x', author: 'N', message: 'chore: deps' }]), /Maintenance release/)
})
