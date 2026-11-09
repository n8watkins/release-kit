// releases.json: every release as data, checked against the published JSON
// Schema, written and committed by the release, attached by the Release
// workflow, and the Atom feed made from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addReleases, documentProblems, emptyDocument, releaseEntry, releasesConfig, renderFeed, SCHEMA_URL } from '../template/scripts/release-kit/releases.mjs'
import { releaseCommitProblem } from '../template/scripts/release-kit/guard.mjs'
import { KIT, attempt, commit, makeRepo, run, tmp } from './helpers.mjs'

const SCHEMA = JSON.parse(readFileSync(join(KIT, 'schema/releases.v1.json'), 'utf8'))
const SCRIPTS = 'scripts/release-kit'

/**
 * The part of JSON Schema 2020-12 that schema/releases.v1.json uses (type,
 * const, enum, required, properties, items, $ref into $defs, pattern,
 * minimum, minLength), so the test checks documents against the published
 * schema itself, with no dependency. Returns the problems found.
 */
function validate(value, schema, root = schema, path = '$') {
  if (schema.$ref) return validate(value, root.$defs[schema.$ref.replace('#/$defs/', '')], root, path)
  const problems = []
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
  if (schema.type) {
    const types = [schema.type].flat()
    const actual = typeOf(value)
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return [`${path}: ${actual}, not ${types.join(' or ')}`]
  }
  if ('const' in schema && value !== schema.const) problems.push(`${path}: not ${schema.const}`)
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: "${value}" not in ${schema.enum.join(', ')}`)
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${path}: "${value}" doesn't match ${schema.pattern}`)
    if (schema.minLength && value.length < schema.minLength) problems.push(`${path}: too short`)
  }
  if (typeof value === 'number' && 'minimum' in schema && value < schema.minimum) problems.push(`${path}: below ${schema.minimum}`)
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}: no ${key}`)
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in value) problems.push(...validate(value[key], sub, root, `${path}.${key}`))
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => problems.push(...validate(item, schema.items, root, `${path}[${i}]`)))
  return problems
}

const c = (message, hash = 'a'.repeat(40)) => ({ hash, author: 'Nathan', message })

test('a release entry has every key, its notes are structured, and the document matches the published schema', () => {
  const entry = releaseEntry({
    version: '0.14.0',
    date: '2026-11-09',
    time: '2026-11-09T18:00:00Z',
    previous: 'v0.13.2',
    summary: 'Settings in one place.',
    repoUrl: 'https://github.com/o/r',
    commits: [
      c('fix(ui): the popup keeps its size (#41)', 'b'.repeat(40)),
      c('feat!: settings live in one file now (#40)'),
      c('docs: readme'),
      c('perf: faster start\n\nRelease-note: opens about a second faster'),
    ],
  })
  assert.deepEqual(entry, {
    version: '0.14.0',
    tag: 'v0.14.0',
    date: '2026-11-09',
    time: '2026-11-09T18:00:00Z',
    url: 'https://github.com/o/r/releases/tag/v0.14.0',
    previous: 'v0.13.2',
    summary: 'Settings in one place.',
    breaking: true,
    notes: [
      { section: 'breaking', type: 'feat', scope: null, text: 'Settings live in one file now', breaking: true, pr: 40, prUrl: 'https://github.com/o/r/pull/40', commit: 'a'.repeat(40), commitUrl: `https://github.com/o/r/commit/${'a'.repeat(40)}` },
      { section: 'fixed', type: 'fix', scope: 'ui', text: 'The popup keeps its size', breaking: false, pr: 41, prUrl: 'https://github.com/o/r/pull/41', commit: 'b'.repeat(40), commitUrl: `https://github.com/o/r/commit/${'b'.repeat(40)}` },
      { section: 'faster', type: 'perf', scope: null, text: 'Opens about a second faster', breaking: false, pr: null, prUrl: null, commit: 'a'.repeat(40), commitUrl: `https://github.com/o/r/commit/${'a'.repeat(40)}` },
    ],
    source: 'release',
    unattributed: 0,
  })
  const older = releaseEntry({ version: '0.13.2', date: '2026-11-01', commits: [c('fix: a')] })
  const doc = addReleases(addReleases(emptyDocument('o/r'), [older]), [entry])
  assert.deepEqual(doc.releases.map((r) => r.version), ['0.14.0', '0.13.2'])
  assert.equal(doc.$schema, SCHEMA_URL)
  assert.equal(SCHEMA.$id, SCHEMA_URL, 'the documents point at the schema file this repo publishes')
  assert.deepEqual(validate(doc, SCHEMA), [])
  assert.deepEqual(documentProblems(doc), [])
  // A maintenance release, with no repo URL, is still valid.
  const bare = addReleases(emptyDocument(null), [releaseEntry({ version: '1.0.1', date: '2026-01-01', commits: [c('chore: a')] })])
  assert.deepEqual(validate(bare, SCHEMA), [])
  assert.deepEqual(bare.releases[0].notes, [])
  // The schema and the code's own check catch the same mistakes.
  const broken = structuredClone(doc)
  broken.releases[0].notes[0].section = 'misc'
  broken.releases[1].date = 'yesterday'
  assert.equal(validate(broken, SCHEMA).length, 2)
  assert.equal(documentProblems(broken).length, 2)
  // Every key the code writes is in the schema, so the schema stays complete.
  assert.deepEqual(Object.keys(entry).sort(), SCHEMA.$defs.release.required.sort())
  assert.deepEqual(Object.keys(entry.notes[0]).sort(), SCHEMA.$defs.note.required.sort())
})

test('.release.json "releases" turns the file off, or the feed on, and nothing else', () => {
  assert.deepEqual(releasesConfig(undefined), { json: true, feed: false })
  assert.deepEqual(releasesConfig(false), { json: false, feed: false })
  assert.deepEqual(releasesConfig({ feed: true }), { json: true, feed: true })
  assert.throws(() => releasesConfig({ path: 'x' }), /unknown keys: path/)
  assert.throws(() => releasesConfig('yes'), /must be true, false/)
  assert.throws(() => releasesConfig({ feed: 'yes' }), /feed" must be true or false/)
})

test('the feed is Atom, made only from the data, so the same releases.json always makes the same feed', () => {
  const doc = addReleases(emptyDocument('o/r'), [
    releaseEntry({ version: '1.1.0', date: '2026-11-09', time: '2026-11-09T18:00:00Z', repoUrl: 'https://github.com/o/r', commits: [c('feat: <b>bold</b> & more (#3)')] }),
    releaseEntry({ version: '1.0.0', date: '2026-11-01', repoUrl: 'https://github.com/o/r', commits: [c('chore: a')] }),
  ])
  const feed = renderFeed(doc)
  assert.equal(feed, renderFeed(structuredClone(doc)))
  assert.match(feed, /^<\?xml version="1\.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/)
  assert.match(feed, /<updated>2026-11-09T18:00:00Z<\/updated>/)
  assert.equal(feed.match(/<entry>/g).length, 2)
  assert.match(feed, /<id>https:\/\/github\.com\/o\/r\/releases\/tag\/v1\.1\.0<\/id>/)
  // Escaped twice: once as HTML text, once as the XML content.
  assert.match(feed, /&lt;h3&gt;New&lt;\/h3&gt;&lt;ul&gt;&lt;li&gt;&amp;lt;b&amp;gt;bold&amp;lt;\/b&amp;gt; &amp;amp; more/)
  assert.match(feed, /<updated>2026-11-01T00:00:00Z<\/updated>/)
  assert.match(feed, /Maintenance release/)
  assert.match(renderFeed(doc, { notes: { style: 'classic' } }), /&lt;h3&gt;Features&lt;\/h3&gt;/)
})

test('a release writes releases.json (and the feed) into its commit, newest first, and the guard accepts that commit', () => {
  const repo = makeRepo(tmp('releases'), { version: '0.4.0' })
  run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  run(repo, 'git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--baseline'])
  commit(repo, 'feat(popup): add dark mode (#7)')
  commit(repo, 'docs: readme')

  assert.match(run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run']), /releases\.json gets v0\.5\.0/)
  assert.ok(!existsSync(join(repo, 'releases.json')), 'a dry run writes nothing')
  run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--summary', 'Dark mode.'])
  assert.deepEqual(run(repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(), ['CHANGELOG.md', 'package.json', 'releases.json'])
  let doc = JSON.parse(readFileSync(join(repo, 'releases.json'), 'utf8'))
  assert.equal(doc.repository, 'o/r')
  assert.equal(doc.releases.length, 1)
  const [first] = doc.releases
  assert.equal(first.tag, 'v0.5.0')
  assert.equal(first.previous, 'v0.4.0')
  assert.equal(first.summary, 'Dark mode.')
  assert.equal(first.source, 'release')
  assert.match(first.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  assert.equal(first.date, /## 0\.5\.0 - (\S+)/.exec(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'))[1], 'the same day as the changelog')
  assert.deepEqual(first.notes.map((n) => [n.section, n.scope, n.text, n.pr]), [['new', 'popup', 'Add dark mode', 7]])
  assert.match(first.notes[0].commit, /^[0-9a-f]{40}$/)

  // The guard lets the release commit through with releases.json in it.
  const files = run(repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n')
  assert.equal(releaseCommitProblem({ subject: 'chore(release): v0.5.0', parents: 1, files, version: '0.5.0' }), null)

  // With the feed on, the next release writes both, and keeps the older entry.
  const config = JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8'))
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ ...config, releases: { feed: true } }, null, 2))
  run(repo, 'git', ['commit', '-q', '-am', 'chore: a release feed'])
  commit(repo, 'fix: the popup remembers its tab')
  run(repo, 'node', [`${SCRIPTS}/release.mjs`])
  assert.deepEqual(run(repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(), ['CHANGELOG.md', 'package.json', 'releases.json', 'releases.xml'])
  doc = JSON.parse(readFileSync(join(repo, 'releases.json'), 'utf8'))
  assert.deepEqual(doc.releases.map((r) => r.version), ['0.5.1', '0.5.0'])
  assert.deepEqual(validate(doc, SCHEMA), [])
  assert.equal(readFileSync(join(repo, 'releases.xml'), 'utf8'), renderFeed(doc))
  assert.match(run(repo, 'node', [`${SCRIPTS}/releases.mjs`, '--check']), /releases\.json is valid \(2 releases\)/)

  // The Release workflow attaches them for a tag the file has, and only then.
  const out = mkdtempSync(join(tmpdir(), 'release-kit-attach-'))
  assert.match(run(repo, 'node', [`${SCRIPTS}/releases.mjs`, '--attach', 'v0.5.1', '--dir', out]), /attaching releases\.json and releases\.xml/)
  assert.equal(readFileSync(join(out, 'releases.json'), 'utf8'), readFileSync(join(repo, 'releases.json'), 'utf8'))
  const none = mkdtempSync(join(tmpdir(), 'release-kit-attach-'))
  assert.match(run(repo, 'node', [`${SCRIPTS}/releases.mjs`, '--attach', 'v0.4.0', '--dir', none]), /has no entry for it/)
  assert.ok(!existsSync(join(none, 'releases.json')))
  assert.equal(attempt(repo, 'node', [`${SCRIPTS}/releases.mjs`, '--attach', 'v1;id']).status, 1)

  // "releases": false writes neither.
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ ...config, releases: false }, null, 2))
  run(repo, 'git', ['commit', '-q', '-am', 'chore: no releases file'])
  commit(repo, 'fix: b')
  run(repo, 'node', [`${SCRIPTS}/release.mjs`])
  assert.deepEqual(run(repo, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort(), ['CHANGELOG.md', 'package.json'])
})

test('a releases.json the kit can not read stops the release before anything changes', () => {
  const repo = makeRepo(tmp('releases-bad'), { version: '1.0.0' })
  run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--baseline'])
  for (const [text, why] of [['{ nope', /not valid JSON/], ['{"schemaVersion": 2, "releases": []}', /schemaVersion 2.*update release-kit/], ['{"schemaVersion": 1}', /no "releases" list/]]) {
    writeFileSync(join(repo, 'releases.json'), text)
    run(repo, 'git', ['add', '-A'])
    run(repo, 'git', ['commit', '-q', '-m', 'chore: a bad releases.json'])
    commit(repo, 'fix: a')
    const head = run(repo, 'git', ['rev-parse', 'HEAD'])
    const result = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`])
    assert.equal(result.status, 1)
    assert.match(result.stderr, why)
    assert.equal(run(repo, 'git', ['rev-parse', 'HEAD']), head, 'nothing was committed')
    assert.equal(run(repo, 'git', ['status', '--porcelain']), '', 'nothing was changed')
  }
})

test('the Release workflow attaches releases.json before the files are checksummed', () => {
  const workflow = readFileSync(join(KIT, 'template/.github/workflows/release.yml'), 'utf8')
  const attach = workflow.indexOf('releases.mjs" --attach "$TAG" --dir release-artifacts')
  assert.ok(attach > 0)
  assert.ok(attach < workflow.indexOf('sha256sum -- *'), 'attached before SHA256SUMS.txt is written, so the checksums cover it')
  assert.ok(JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).files.includes('schema'), 'the schema ships with the package')
})
