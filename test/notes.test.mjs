// Release notes that read like patch notes: the Release-note trailer, plain
// headings and scopes, a summary, pull request links, and the GitHub Release
// matching the changelog through the tag.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse, userFacing } from '../template/scripts/release-kit/conventional.mjs'
import { noteStyle, renderNotes } from '../template/scripts/release-kit/notes.mjs'
import { KIT, commit, makeRepo, run, tmp } from './helpers.mjs'

const c = (message, author = 'Nathan') => ({ hash: 'a'.repeat(40), author, message })

test('a Release-note trailer rewords a change, and "skip" keeps it out', () => {
  const reworded = parse('fix(ui): debounce resize observer in marquee\n\nRelease-note: The logo strip no longer stutters when you resize the window')
  assert.equal(reworded.note, 'The logo strip no longer stutters when you resize the window')
  assert.equal(parse('fix: flaky webkit test\n\nRelease-note: skip').skip, true)
  assert.equal(parse('fix: a\n\nrelease-note: none').skip, true)
  assert.equal(userFacing([c('fix: flaky webkit test\n\nRelease-note: skip')]).length, 0)
  // A breaking change is always listed, whatever the trailer says.
  assert.equal(userFacing([c('feat!: drop the old config\n\nRelease-note: skip')]).length, 1)

  const notes = renderNotes([
    c('fix(ui): debounce resize observer in marquee\n\nRelease-note: the logo strip no longer stutters when you resize the window'),
    c('fix: flaky webkit test\n\nRelease-note: skip'),
  ])
  assert.equal(notes, '### Fixed\n\n- The logo strip no longer stutters when you resize the window\n')
})

test('the plain style (the default) uses plain headings and hides scopes; scopes can be renamed or dropped', () => {
  const commits = [c('feat(popup): add dark mode'), c('fix(a11y): bigger tap targets'), c('perf: lazy load charts'), c('security: pin actions')]
  assert.equal(
    renderNotes(commits, { style: noteStyle({ style: 'plain' }) }),
    '### New\n\n- Add dark mode\n\n### Fixed\n\n- Bigger tap targets\n\n### Safer\n\n- Pin actions\n\n### Faster\n\n- Lazy load charts\n',
  )
  const mapped = renderNotes(commits.slice(0, 2), {
    style: noteStyle({ style: 'classic', headings: { Features: "What's new" }, scopes: { a11y: 'Accessibility', popup: false } }),
  })
  assert.equal(mapped, "### What's new\n\n- Add dark mode\n\n### Fixes\n\n- **Accessibility:** Bigger tap targets\n")
  // A repo that sets nothing gets the plain style; "classic" keeps commit-type headings and scopes.
  assert.equal(renderNotes(commits), renderNotes(commits, { style: noteStyle({ style: 'plain' }) }))
  assert.match(renderNotes(commits, { style: noteStyle({ style: 'classic' }) }), /### Features\n\n- \*\*popup:\*\* Add dark mode/)
})

test('a summary leads the notes, and pull request numbers link to their PRs', () => {
  const notes = renderNotes([c('feat: owner round 10 (#61)'), c('fix: a')], {
    summary: 'Dark mode, and a faster homepage.',
    repoUrl: 'https://github.com/o/r',
    commitLinks: false,
  })
  assert.equal(notes, 'Dark mode, and a faster homepage.\n\n### New\n\n- Owner round 10 ([#61](https://github.com/o/r/pull/61))\n\n### Fixed\n\n- A\n')
  // A release with only a summary still says something.
  assert.equal(renderNotes([c('chore: deps')], { summary: 'Security updates.' }), 'Security updates.\n')
})

test('release --summary and .release.json notes reach the changelog, the tag and the GitHub Release notes', () => {
  const repo = makeRepo(tmp('notes'), { version: '1.0.0' })
  run(KIT, 'node', ['apply.mjs', repo, '--vendored', '--vendored'])
  const config = JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8'))
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ ...config, notes: { style: 'plain' } }, null, 2))
  run(repo, 'git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  run(repo, 'node', ['scripts/release-kit/release.mjs', '--baseline'])
  commit(repo, 'feat(popup): add dark mode (#7)')
  commit(repo, 'fix: flaky test\n\nRelease-note: skip')

  // The summary's text is never taken for the bump.
  run(repo, 'node', ['scripts/release-kit/release.mjs', '--summary', 'Dark mode is here.'])
  const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /## 1\.1\.0 - \d{4}-\d{2}-\d{2}\n\nDark mode is here\.\n\n### New\n\n- Add dark mode \(\[#7\]\(https:\/\/github\.com\/o\/r\/pull\/7\)\)\n/)
  assert.doesNotMatch(changelog, /flaky/)

  // The Release workflow's notes are the tag's, so they match the changelog exactly.
  const published = run(repo, 'node', ['scripts/release-kit/notes.mjs', '--to', 'v1.1.0'])
  assert.equal(published, 'Dark mode is here.\n\n### New\n\n- Add dark mode ([#7](https://github.com/o/r/pull/7))\n')

  // A tag the kit didn't write is rendered from the commits, as before.
  commit(repo, 'fix: later')
  run(repo, 'git', ['tag', 'v1.1.1'])
  assert.equal(run(repo, 'node', ['scripts/release-kit/notes.mjs', '--to', 'v1.1.1']), '### Fixed\n\n- Later\n')
})

test('apply finds an extension manifest in extension/, skips a web-app manifest, and flags a mismatch', () => {
  const repo = makeRepo(tmp('ext'), { version: '1.0.0' })
  mkdirSync(join(repo, 'extension'))
  writeFileSync(join(repo, 'extension/manifest.json'), JSON.stringify({ manifest_version: 3, name: 'x', version: '0.9.0' }, null, 2))
  mkdirSync(join(repo, 'public'))
  writeFileSync(join(repo, 'public/manifest.json'), JSON.stringify({ name: 'site', version: '1.0.0', display: 'standalone' }, null, 2))
  const out = run(KIT, 'node', ['apply.mjs', repo, '--vendored', '--vendored'])
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')).versionFiles, ['extension/manifest.json'])
  assert.match(out, /extension\/manifest\.json has version 0\.9\.0 but package\.json has 1\.0\.0/)
})
