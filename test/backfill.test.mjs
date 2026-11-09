// backfill: releases.json entries and missing GitHub Release notes for older
// tags, from the commits, against a repo with messy early history and a fake
// gh that records what it was asked to change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attribute, bodyKind, summaryFromNotes } from '../template/scripts/release-kit/backfill.mjs'
import { BASELINE_NOTE } from '../template/scripts/release-kit/git.mjs'
import { addReleases, documentProblems, emptyDocument, releaseEntry, serialize } from '../template/scripts/release-kit/releases.mjs'
import { KIT, attempt, bot, commit, makeRepo, run, tmp } from './helpers.mjs'

const BACKFILL = join(KIT, 'template/scripts/release-kit/backfill.mjs')

test('GitHub Release bodies: only empty and generated ones may be replaced', () => {
  assert.equal(bodyKind(undefined), 'none')
  assert.equal(bodyKind({ draft: true, body: '' }), 'draft')
  assert.equal(bodyKind({ body: '' }), 'empty')
  assert.equal(bodyKind({ body: null }), 'empty')
  assert.equal(bodyKind({ body: '**Full Changelog**: https://github.com/o/r/compare/v1.0.0...v1.1.0' }), 'empty')
  assert.equal(bodyKind({ body: "## What's Changed\r\n* feat: x by @n8watkins in https://github.com/o/r/pull/2\r\n* fix: y by @dependabot[bot] in https://github.com/o/r/pull/3\r\n\r\n## New Contributors\r\n* @n8watkins made their first contribution in https://github.com/o/r/pull/2\r\n\r\n**Full Changelog**: https://github.com/o/r/commits/v0.7.0" }), 'generated')
  assert.equal(bodyKind({ body: '### New\n\n- Dark mode' }), 'kit')
  assert.equal(bodyKind({ body: '## Features\n\n- Dark mode' }), 'kit')
  assert.equal(bodyKind({ body: '_Maintenance release: no user-facing changes._' }), 'kit')
  assert.equal(bodyKind({ body: "## What's Changed\n* feat: x by @n8 in https://github.com/o/r/pull/2\n\nThanks to everyone who tested the beta!" }), 'written')
  assert.equal(bodyKind({ body: 'First public build. Windows only for now.' }), 'written')
})

test('commits that are not Conventional Commits are counted, never guessed; bots and git messages are left out', () => {
  const c = (message, author = 'N') => ({ hash: 'a'.repeat(40), author, message })
  const { usable, unattributed } = attribute([
    c('Initial commit'),
    c('Add the settings screen'),
    c('reliability: recover when the mic is unplugged'),
    c('feat: dark mode'),
    c('docs: readme'),
    c('Merge pull request #4 from n8/x'),
    c('feat: sync', 'github-actions[bot]'),
  ])
  assert.deepEqual(usable.map((x) => x.message), ['feat: dark mode', 'docs: readme'])
  assert.deepEqual(unattributed.map((x) => x.message), ['Add the settings screen', 'reliability: recover when the mic is unplugged'])
  assert.equal(summaryFromNotes('Dark mode is here.\n\n### New\n\n- Dark mode\n'), 'Dark mode is here.')
  assert.equal(summaryFromNotes('### New\n\n- Dark mode\n'), null)
  assert.equal(summaryFromNotes('_Maintenance release: no user-facing changes._\n'), null)
  assert.equal(summaryFromNotes(null), null)
})

/** A fake gh: releases from `releases`, pull requests from `pulls`, edits appended to `log`. */
function fakeGh(dir, { releases, pulls }) {
  const log = join(dir, 'gh.log')
  const script = join(dir, 'fake-gh.mjs')
  writeFileSync(script, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
const releases = ${JSON.stringify(releases)}
const pulls = ${JSON.stringify(pulls)}
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
if (args[0] === 'api' && args[1] === '--paginate') {
  for (const r of releases) console.log(JSON.stringify(r))
} else if (args[0] === 'api') {
  const sha = /commits\\/([0-9a-f]+)\\/pulls/.exec(args[1])[1]
  console.log(pulls[sha] ?? 'null')
} else if (args[0] === 'release' && args[1] === 'edit') {
  appendFileSync(${JSON.stringify(log)}, 'BODY ' + args[2] + ' ' + JSON.stringify(readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8')) + '\\n')
} else process.exit(1)
`)
  chmodSync(script, 0o755)
  return { env: { RELEASE_KIT_GH: script, RELEASE_KIT_OFFLINE: '' }, log }
}

function messyRepo() {
  const repo = makeRepo(tmp('backfill'), { version: '0.1.0' })
  run(repo, 'git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'])
  commit(repo, 'Add the settings screen')
  run(repo, 'git', ['tag', 'v0.1.0'])
  commit(repo, 'fix: the popup keeps its size (#3)')
  commit(repo, 'Update readme')
  run(repo, 'git', ['tag', 'v0.1.1'])
  commit(repo, 'chore: adopt release-kit')
  run(repo, 'git', ['tag', '-a', 'v0.2.0', '-m', `v0.2.0\n\n${BASELINE_NOTE}`])
  commit(repo, 'feat!: settings live in one file now')
  commit(repo, 'fix(deps): bump x', bot)
  run(repo, 'git', ['tag', '-a', '--cleanup=verbatim', 'v0.3.0', '-m', 'v0.3.0\n\n## 0.3.0 - 2026-11-01\n\nOne settings file.\n\n### Breaking changes\n\n- Settings live in one file now\n'])
  commit(repo, 'feat: dark mode')
  run(repo, 'git', ['tag', 'v0.2.5'])
  return repo
}

const RELEASES = [
  { tag: 'v0.1.0', body: 'First build, by hand.', draft: false },
  { tag: 'v0.1.1', body: '', draft: false },
  { tag: 'v0.3.0', body: "## What's Changed\n* feat!: settings by @n8 in https://github.com/o/r/pull/9\n\n**Full Changelog**: https://github.com/o/r/compare/v0.1.1...v0.3.0", draft: false },
]

test('backfill plans every tag as a dry run, skips what it can not attribute, and writes only when asked', () => {
  const repo = messyRepo()
  const sha = run(repo, 'git', ['rev-list', '-n1', 'v0.3.0^']).trim()
  const gh = fakeGh(repo, { releases: RELEASES, pulls: { [sha]: 9 } })

  const dry = run(repo, 'node', [BACKFILL, '--verbose'], gh.env)
  assert.match(dry, /o\/r: 5 release tags, 0 already in releases\.json/)
  assert.match(dry, /v0\.1\.0 +add +\d{4}-\d{2}-\d{2} +0 notes, 1 unattributed \(no notes: none of its commits follow Conventional Commits\) +\[GitHub: written notes \(kept\)\]/)
  assert.match(dry, /\? +Add the settings screen/)
  assert.match(dry, /v0\.1\.1 +add .* 1 note , 1 unattributed +\[GitHub: empty: notes will be filled in\]/)
  assert.match(dry, /v0\.2\.0 +skip +baseline tag/)
  assert.match(dry, /v0\.2\.5 +skip +v0\.3\.0 is on its history/)
  assert.match(dry, /v0\.3\.0 +add .* 1 note  +\[GitHub: generated "What's Changed": notes will be filled in\]/)
  assert.match(dry, /breaking Settings live in one file now \(#9\)/, 'the pull request number came from GitHub')
  assert.match(dry, /dry run, nothing written: --write adds 3 releases to releases\.json, --edit-releases fills in 2 GitHub Releases/)
  assert.ok(!existsSync(join(repo, 'releases.json')))
  assert.doesNotMatch(readFileSync(gh.log, 'utf8'), /"release","edit"/, 'a dry run edits nothing')

  const json = JSON.parse(run(repo, 'node', [BACKFILL, '--json', '--since', 'v0.1.1'], gh.env))
  assert.deepEqual(json.tags.map((t) => [t.tag, t.action]), [['v0.1.1', 'add'], ['v0.2.0', 'skip'], ['v0.2.5', 'skip'], ['v0.3.0', 'add']])
  const v030 = json.tags.find((t) => t.tag === 'v0.3.0').entry
  assert.equal(v030.summary, 'One settings file.', "a kit-made tag's summary is kept")
  assert.equal(v030.previous, 'v0.2.0', 'like a release, the range starts at the baseline, so adoption-time work stays out')

  // An entry already there is kept exactly as it was.
  const kept = releaseEntry({ version: '0.1.1', date: '2026-01-01', commits: [], source: 'release' })
  writeFileSync(join(repo, 'releases.json'), serialize(addReleases(emptyDocument('o/r'), [kept])))
  run(repo, 'node', [BACKFILL, '--write'], gh.env)
  const doc = JSON.parse(readFileSync(join(repo, 'releases.json'), 'utf8'))
  assert.deepEqual(documentProblems(doc), [])
  assert.deepEqual(doc.releases.map((r) => [r.version, r.source, r.unattributed]), [['0.3.0', 'backfill', 0], ['0.1.1', 'release', 0], ['0.1.0', 'backfill', 1]])
  assert.deepEqual(doc.releases[1], kept)
  assert.deepEqual(doc.releases[0].notes.map((n) => [n.section, n.text, n.pr, n.prUrl]), [['breaking', 'Settings live in one file now', 9, 'https://github.com/o/r/pull/9']])
  assert.doesNotMatch(readFileSync(gh.log, 'utf8'), /"release","edit"/, '--write edits no release')

  // Running it again adds nothing.
  assert.match(run(repo, 'node', [BACKFILL], gh.env), /--write adds 0 releases/)
})

test('backfill --edit-releases fills in only empty and generated GitHub Release notes, kept entries included', () => {
  const repo = messyRepo()
  const gh = fakeGh(repo, { releases: RELEASES, pulls: {} })
  const kept = releaseEntry({ version: '0.1.1', date: '2026-01-01', commits: [], source: 'release' })
  writeFileSync(join(repo, 'releases.json'), serialize(addReleases(emptyDocument('o/r'), [kept])))
  run(repo, 'node', [BACKFILL, '--edit-releases'], gh.env)
  const bodies = readFileSync(gh.log, 'utf8').split('\n').filter((l) => l.startsWith('BODY ')).map((l) => [l.split(' ')[1], JSON.parse(l.slice(l.indexOf(' ', 5) + 1))])
  assert.deepEqual(bodies.map(([tag]) => tag), ['v0.1.1', 'v0.3.0'], 'never v0.1.0, whose notes a person wrote')
  const [[, first], [, second]] = bodies
  assert.match(first, /^### Fixed\n\n- The popup keeps its size \(\[#3\]\(https:\/\/github\.com\/o\/r\/pull\/3\)\)\n\n_Notes backfilled by release-kit from the commits since v0\.1\.0\._\n_1 commit in this release doesn't follow Conventional Commits and isn't listed\._\n$/)
  assert.match(second, /^One settings file\.\n\n### Breaking changes\n\n- Settings live in one file now \(\[[0-9a-f]{7}\]/)
  assert.match(second, /\n\n\*\*Full Changelog\*\*: https:\/\/github\.com\/o\/r\/compare\/v0\.1\.1\.\.\.v0\.3\.0\n$/, 'the compare link stays')
  assert.ok(!existsSync(join(repo, 'releases.json')) || JSON.parse(readFileSync(join(repo, 'releases.json'), 'utf8')).releases.length === 1, '--edit-releases alone writes no releases.json')
})

test('backfill refuses what it can not do safely', () => {
  const repo = messyRepo()
  assert.match(attempt(repo, 'node', [BACKFILL, '--edit-releases']).stderr, /--edit-releases needs gh signed in/)
  assert.match(attempt(repo, 'node', [BACKFILL, '--edit-releases', '--no-github']).stderr, /needs GitHub; drop --no-github/)
  assert.match(attempt(repo, 'node', [BACKFILL, '--since', '0.1']).stderr, /--since needs a release tag/)
  assert.match(attempt(repo, 'node', [BACKFILL, '--force']).stderr, /unknown option --force/)
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ releases: false }))
  assert.match(attempt(repo, 'node', [BACKFILL, '--write']).stderr, /"releases" is false/)
  writeFileSync(join(repo, '.release.json'), '{}')
  writeFileSync(join(repo, 'releases.json'), '{"schemaVersion": 9, "releases": []}')
  assert.match(attempt(repo, 'node', [BACKFILL]).stderr, /schemaVersion 9/)
})

test('a vendored repo gets backfill.mjs, and its RELEASING.md names it, since npx release-kit is not installed there', () => {
  const repo = makeRepo(tmp('backfill-vendored'))
  run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.ok(existsSync(join(repo, 'scripts/release-kit/backfill.mjs')))
  const releasing = readFileSync(join(repo, 'RELEASING.md'), 'utf8')
  assert.match(releasing, /`node scripts\/release-kit\/backfill\.mjs` adds release tags/)
  assert.doesNotMatch(releasing, /npx release-kit (backfill|protect)/)
})
