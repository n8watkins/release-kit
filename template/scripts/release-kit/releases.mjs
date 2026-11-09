#!/usr/bin/env node
// releases.json: every release as data, for programs (the n8builds.dev build
// log, a "what's new" screen, a feed reader) that would otherwise scrape the
// Markdown notes. npm run release adds the new release to it and commits it
// with CHANGELOG.md; the Release workflow attaches it to the GitHub Release.
// With .release.json "releases": { "feed": true } an Atom feed, releases.xml,
// is written from the same data.
//
// The format is the JSON Schema in release-kit's schema/releases.v1.json.
// Every key is always present (null when unknown), releases are newest first,
// and a change that would break a reader bumps schemaVersion.
//
//   node scripts/release-kit/releases.mjs --attach vX.Y.Z [--dir release-artifacts]
//       (the Release workflow) copies releases.json, and releases.xml when
//       there is one, into the release's files, when releases.json has vX.Y.Z.
//   node scripts/release-kit/releases.mjs --check
//       checks releases.json against the format, and that the feed matches it.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NOTE_SECTIONS, compareVersions, isVersion } from './conventional.mjs'
import { isMain } from './git.mjs'
import { SECTION_IDS, noteItems, noteStyle, plainText } from './notes.mjs'

export const SCHEMA_VERSION = 1
export const SCHEMA_URL = 'https://raw.githubusercontent.com/n8watkins/release-kit/main/schema/releases.v1.json'
export const RELEASES_FILE = 'releases.json'
export const FEED_FILE = 'releases.xml'
export const SECTIONS = NOTE_SECTIONS.map((s) => SECTION_IDS[s])
export const SOURCES = ['release', 'backfill']

/**
 * What .release.json "releases" asks for: { json, feed }.
 *   absent or true   releases.json, no feed
 *   false            neither
 *   { "feed": true } releases.json and releases.xml
 */
export function releasesConfig(value) {
  if (value === undefined || value === true) return { json: true, feed: false }
  if (value === false) return { json: false, feed: false }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const extra = Object.keys(value).filter((k) => k !== 'feed')
    if (extra.length) throw new Error(`.release.json "releases" has unknown keys: ${extra.join(', ')} (only "feed")`)
    if (value.feed !== undefined && typeof value.feed !== 'boolean') throw new Error('.release.json "releases.feed" must be true or false')
    return { json: true, feed: value.feed === true }
  }
  throw new Error('.release.json "releases" must be true, false or { "feed": true }')
}

/** "owner/repo" from https://github.com/owner/repo, or null. */
export const slugOf = (repoUrl) => /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/.exec(repoUrl ?? '')?.[1] ?? null

/**
 * One release, as releases.json stores it.
 *   version      x.y.z
 *   date         YYYY-MM-DD, the changelog's date
 *   time         ISO 8601 UTC instant the release was cut, or null
 *   previous     the release tag before it, or null
 *   summary      the releaser's lead line (--summary), or null
 *   commits      the commits since `previous` ({ hash, author, message })
 *   items        structured notes instead of commits (backfill passes these)
 *   repoUrl      https://github.com/owner/repo, for the links (optional)
 *   source       "release" (npm run release) or "backfill"
 *   unattributed commits in the range that could not be read as Conventional
 *                Commits (backfill of older history), so the notes may be short
 */
export function releaseEntry({ version, date, time = null, previous = null, summary = null, commits = [], items, repoUrl, source = 'release', unattributed = 0 }) {
  if (!isVersion(version)) throw new Error(`"${version}" is not an x.y.z version`)
  const tag = `v${version}`
  const notes = (items ?? noteItems(commits)).map((item) => ({
    section: SECTION_IDS[item.section] ?? item.section,
    type: item.type,
    scope: item.scope ?? null,
    text: plainText(item.text),
    breaking: Boolean(item.breaking),
    pr: item.pr ?? null,
    prUrl: item.pr && repoUrl ? `${repoUrl}/pull/${item.pr}` : null,
    commit: item.hash ?? null,
    commitUrl: item.hash && repoUrl ? `${repoUrl}/commit/${item.hash}` : null,
  }))
  // Notes in the order the sections read, commit order within each.
  notes.sort((a, b) => SECTIONS.indexOf(a.section) - SECTIONS.indexOf(b.section))
  return {
    version,
    tag,
    date,
    time,
    url: repoUrl ? `${repoUrl}/releases/tag/${tag}` : null,
    previous,
    summary: summary?.trim() || null,
    breaking: notes.some((n) => n.breaking),
    notes,
    source,
    unattributed,
  }
}

/** A releases.json with no releases yet. */
export const emptyDocument = (repository = null) => ({ $schema: SCHEMA_URL, schemaVersion: SCHEMA_VERSION, repository, releases: [] })

/** Parses releases.json text; throws on anything this kit can't safely add to. */
export function parseDocument(text) {
  let doc
  try {
    doc = JSON.parse(text)
  } catch (error) {
    throw new Error(`${RELEASES_FILE} is not valid JSON (${error.message})`)
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.releases)) throw new Error(`${RELEASES_FILE} has no "releases" list`)
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`${RELEASES_FILE} is schemaVersion ${doc.schemaVersion}, and this kit writes ${SCHEMA_VERSION}: ${doc.schemaVersion > SCHEMA_VERSION ? 'update release-kit' : 'it is malformed'}`)
  }
  return doc
}

/** `doc` with `entries` added (an entry for a version already there replaces it), newest first. */
export function addReleases(doc, entries, { repository } = {}) {
  const byVersion = new Map(doc.releases.map((r) => [r.version, r]))
  for (const entry of entries) byVersion.set(entry.version, entry)
  return {
    $schema: SCHEMA_URL,
    schemaVersion: SCHEMA_VERSION,
    repository: doc.repository ?? repository ?? null,
    releases: [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)),
  }
}

export const serialize = (doc) => `${JSON.stringify(doc, null, 2)}\n`

/** Problems with a releases.json document, by the schema's rules; empty when it is valid. */
export function documentProblems(doc) {
  const problems = []
  const where = (i, key) => `releases[${i}]${key ? `.${key}` : ''}`
  if (doc.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion is ${doc.schemaVersion}, not ${SCHEMA_VERSION}`)
  if (doc.repository !== null && !/^[\w.-]+\/[\w.-]+$/.test(doc.repository ?? '')) problems.push(`repository "${doc.repository}" is not owner/repo or null`)
  if (!Array.isArray(doc.releases)) return [...problems, 'releases is not a list']
  const seen = new Set()
  doc.releases.forEach((r, i) => {
    if (!isVersion(r.version)) problems.push(`${where(i, 'version')} "${r.version}" is not x.y.z`)
    if (seen.has(r.version)) problems.push(`${where(i)} repeats ${r.version}`)
    seen.add(r.version)
    if (i && isVersion(r.version) && isVersion(doc.releases[i - 1].version) && compareVersions(doc.releases[i - 1].version, r.version) <= 0) problems.push(`${where(i)} ${r.version} is out of order (newest first)`)
    if (r.tag !== `v${r.version}`) problems.push(`${where(i, 'tag')} is not v${r.version}`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date ?? '')) problems.push(`${where(i, 'date')} "${r.date}" is not YYYY-MM-DD`)
    if (!SOURCES.includes(r.source)) problems.push(`${where(i, 'source')} "${r.source}" is not ${SOURCES.join(' or ')}`)
    if (!Array.isArray(r.notes)) problems.push(`${where(i, 'notes')} is not a list`)
    for (const [j, n] of (r.notes ?? []).entries()) {
      if (!SECTIONS.includes(n.section)) problems.push(`${where(i, `notes[${j}].section`)} "${n.section}" is not one of ${SECTIONS.join(', ')}`)
      if (typeof n.text !== 'string' || !n.text) problems.push(`${where(i, `notes[${j}].text`)} is empty`)
    }
    if (typeof r.breaking !== 'boolean' || r.breaking !== (r.notes ?? []).some((n) => n.breaking)) problems.push(`${where(i, 'breaking')} doesn't match its notes`)
  })
  return problems
}

const escapeXml = (text) => String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c])

/** A release's notes as HTML, under the repo's headings. */
function releaseHtml(release, headings) {
  const parts = release.summary ? [`<p>${escapeXml(release.summary)}</p>`] : []
  const byId = Object.fromEntries(Object.entries(SECTION_IDS).map(([name, id]) => [id, name]))
  for (const id of SECTIONS) {
    const notes = release.notes.filter((n) => n.section === id)
    if (!notes.length) continue
    const name = byId[id]
    parts.push(`<h3>${escapeXml(headings[name] ?? name)}</h3>`, `<ul>${notes.map((n) => `<li>${escapeXml(n.text)}${n.prUrl ? ` (<a href="${escapeXml(n.prUrl)}">#${n.pr}</a>)` : ''}</li>`).join('')}</ul>`)
  }
  if (parts.length === 0) parts.push('<p>Maintenance release: no user-facing changes.</p>')
  return parts.join('')
}

const instant = (release) => release.time ?? `${release.date}T00:00:00Z`

/**
 * An Atom feed of the releases in `doc`, newest first. Its dates come from
 * the releases, not the clock, so the same releases.json always makes the
 * same feed.
 */
export function renderFeed(doc, { notes } = {}) {
  const repo = doc.repository
  const home = repo ? `https://github.com/${repo}/releases` : null
  const headings = noteStyle(notes).headings
  const releases = doc.releases
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(repo ? `${repo.split('/')[1]} releases` : 'Releases')}</title>`,
    `  <id>${escapeXml(home ?? 'urn:release-kit:releases')}</id>`,
    ...(home ? [`  <link rel="alternate" href="${escapeXml(home)}"/>`] : []),
    `  <updated>${escapeXml(releases.length ? instant(releases[0]) : '1970-01-01T00:00:00Z')}</updated>`,
    `  <author><name>${escapeXml(repo ? repo.split('/')[0] : 'release-kit')}</name></author>`,
    '  <generator uri="https://github.com/n8watkins/release-kit">release-kit</generator>',
  ]
  for (const release of releases) {
    lines.push(
      '  <entry>',
      `    <title>${escapeXml(release.tag)}</title>`,
      `    <id>${escapeXml(release.url ?? `urn:release-kit:${repo ?? 'repo'}:${release.tag}`)}</id>`,
      ...(release.url ? [`    <link rel="alternate" href="${escapeXml(release.url)}"/>`] : []),
      `    <updated>${escapeXml(instant(release))}</updated>`,
      `    <content type="html">${escapeXml(releaseHtml(release, headings))}</content>`,
      '  </entry>',
    )
  }
  lines.push('</feed>')
  return `${lines.join('\n')}\n`
}

/** Reads releases.json in the current directory, or an empty one. */
export function readDocument(repository) {
  return existsSync(RELEASES_FILE) ? parseDocument(readFileSync(RELEASES_FILE, 'utf8')) : emptyDocument(repository)
}

/**
 * Writes releases.json (and the feed, when asked) with `entries` added.
 * Returns the paths written, for the release commit.
 */
export function writeReleaseFiles(entries, { config = {}, repository } = {}) {
  const wanted = releasesConfig(config.releases)
  if (!wanted.json) return []
  const doc = addReleases(readDocument(repository), entries, { repository })
  const problems = documentProblems(doc)
  if (problems.length) throw new Error(`${RELEASES_FILE} would be invalid: ${problems.join('; ')}`)
  writeFileSync(RELEASES_FILE, serialize(doc))
  if (!wanted.feed) return [RELEASES_FILE]
  writeFileSync(FEED_FILE, renderFeed(doc, { notes: config.notes }))
  return [RELEASES_FILE, FEED_FILE]
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (name) => {
    const at = args.indexOf(`--${name}`)
    return at === -1 ? undefined : args[at + 1]
  }
  const fail = (message) => {
    console.error(`releases: ${message}`)
    process.exit(1)
  }
  if (args.includes('--attach')) {
    const tag = valueOf('attach')
    const dir = valueOf('dir') ?? 'release-artifacts'
    if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) fail(`"${tag ?? ''}" is not a release tag`)
    if (!existsSync(RELEASES_FILE)) {
      console.log(`releases: no ${RELEASES_FILE} at ${tag}; nothing to attach`)
      return
    }
    let doc
    try {
      doc = parseDocument(readFileSync(RELEASES_FILE, 'utf8'))
    } catch (error) {
      fail(error.message)
    }
    if (!doc.releases.some((r) => r.tag === tag)) {
      console.log(`releases: ${RELEASES_FILE} at ${tag} has no entry for it (a release made before the kit wrote one); not attached`)
      return
    }
    mkdirSync(dir, { recursive: true })
    const files = [RELEASES_FILE, ...(existsSync(FEED_FILE) ? [FEED_FILE] : [])]
    for (const file of files) copyFileSync(file, join(dir, file))
    console.log(`releases: attaching ${files.join(' and ')}`)
    return
  }
  if (args.includes('--check')) {
    if (!existsSync(RELEASES_FILE)) fail(`no ${RELEASES_FILE} here`)
    let doc
    try {
      doc = parseDocument(readFileSync(RELEASES_FILE, 'utf8'))
    } catch (error) {
      fail(error.message)
    }
    const problems = documentProblems(doc)
    if (existsSync(FEED_FILE)) {
      const config = existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')) : {}
      if (readFileSync(FEED_FILE, 'utf8') !== renderFeed(doc, { notes: config.notes })) problems.push(`${FEED_FILE} doesn't match ${RELEASES_FILE}`)
    }
    if (problems.length) fail(problems.join('\n  '))
    console.log(`releases: ${RELEASES_FILE} is valid (${doc.releases.length} release${doc.releases.length === 1 ? '' : 's'})`)
    return
  }
  fail('use --attach vX.Y.Z [--dir release-artifacts] or --check')
}

if (isMain(import.meta.url)) main()
