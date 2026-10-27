#!/usr/bin/env node
// Release notes from Conventional Commits: features, fixes, performance and
// breaking changes since the previous tag. Docs, chores, tests and bot commits
// stay out, so the notes read like a changelog, not a git log.
//
//   node scripts/release-kit/notes.mjs [--from <ref>] [--to <ref>] [--version x.y.z]
//
// For a tag the kit made, it prints the notes the release wrote into the tag
// (the CHANGELOG.md section, summary and wording included), so the GitHub
// Release always matches the changelog. For anything else it renders them
// from the commits.
import { existsSync, readFileSync } from 'node:fs'
import { NOTE_SECTIONS, RELEASE_TAG, parse, sectionFor } from './conventional.mjs'
import { commitsBetween, git, isBot, isMain, previousTag, repoUrl as originUrl } from './git.mjs'

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

// Plain headings for people who don't read commit types: the default style.
const PLAIN_HEADINGS = {
  'Breaking changes': 'Breaking changes',
  Features: 'New',
  Fixes: 'Fixed',
  Security: 'Safer',
  Performance: 'Faster',
  Reverts: 'Reverted',
}

/**
 * How the notes are worded, from .release.json "notes":
 *   - "style": "plain" (the default) uses plain headings (New, Fixed, Faster, Safer) and hides
 *     scopes; "classic" keeps the commit-type headings (Features, Fixes, ...) and shows scopes;
 *   - "headings": { "Features": "What's new", ... } renames any section;
 *   - "scopes": "show" (the default), "hide", or { "a11y": "Accessibility", "ci": false } to rename or drop them.
 */
export function noteStyle(config = {}) {
  const plain = config.style !== 'classic'
  return {
    headings: { ...(plain ? PLAIN_HEADINGS : {}), ...(config.headings ?? {}) },
    scopes: config.scopes ?? (plain ? 'hide' : 'show'),
  }
}

function scopeLabel(scope, scopes) {
  if (!scope || scopes === 'hide') return ''
  if (scopes && typeof scopes === 'object' && scope in scopes) {
    const label = scopes[scope]
    return label ? `**${label}:** ` : ''
  }
  return `**${scope}:** `
}

/**
 * Markdown notes for `commits`.
 *   heading  "## 1.2.0 - 2026-10-23" (optional)
 *   summary  a line or two the releaser wrote, shown first (optional)
 *   repoUrl  https://github.com/owner/repo: links "(#12)" to its pull request
 *   commitLinks  link each commit without a pull request number to itself (default true with repoUrl)
 *   style    from noteStyle()
 */
export function renderNotes(commits, { heading, summary, repoUrl, commitLinks = true, style = noteStyle() } = {}) {
  const sections = new Map(NOTE_SECTIONS.map((s) => [s, []]))
  for (const commit of commits) {
    if (isBot(commit.author ?? '')) continue
    const parsed = parse(commit.message)
    const section = sectionFor(parsed)
    if (!section) continue
    let text = capitalize(parsed.note ?? parsed.subject)
    if (repoUrl) text = text.replace(/\(#(\d+)\)$/, (_, n) => `([#${n}](${repoUrl}/pull/${n}))`)
    const link = commitLinks && repoUrl && commit.hash && !/\(#\d+\)$/.test(parsed.note ?? parsed.subject)
      ? ` ([${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash}))`
      : ''
    sections.get(section).push(`- ${scopeLabel(parsed.scope, style.scopes)}${text}${link}`)
  }
  const body = [...sections]
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => `### ${style.headings[title] ?? title}\n\n${lines.join('\n')}`)
    .join('\n\n')
  const content = [summary?.trim(), body || (summary ? '' : '_Maintenance release: no user-facing changes._')].filter(Boolean).join('\n\n')
  return heading ? `${heading}\n\n${content}\n` : `${content}\n`
}

/**
 * The notes a release wrote into its annotated tag, without the tag's title
 * line and the changelog heading, or null when the tag carries none (a
 * lightweight tag, a baseline, or one made before the kit).
 */
export function notesFromTag(tag) {
  let message
  try {
    message = git('tag', '--list', '--format=%(contents)', tag).replace(/\r\n?/g, '\n')
  } catch {
    return null
  }
  const [title, ...rest] = message.split('\n')
  if (title.trim() !== tag) return null
  const body = rest.join('\n').replace(/^\n+/, '')
  // A kit release section starts with its "## x.y.z - date" heading.
  const heading = /^## \d+\.\d+\.\d+\b[^\n]*\n+/.exec(body)
  if (!heading) return null
  return `${body.slice(heading[0].length).trimEnd()}\n`
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// Run as a command (resolving links, so a symlinked scripts/ folder works too).
if (isMain(import.meta.url)) {
  const to = arg('to') ?? 'HEAD'
  const version = arg('version')
  const fromTag = !arg('from') && !version && RELEASE_TAG.test(to) ? notesFromTag(to) : null
  if (fromTag) {
    process.stdout.write(fromTag)
  } else {
    // For a tag, start from the tag before it, not the tag itself.
    const from = arg('from') ?? previousTag(`${to}^`)
    const config = existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')) : {}
    const ci = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
      : undefined
    process.stdout.write(renderNotes(commitsBetween(from, to), {
      heading: version ? `## ${version}` : undefined,
      repoUrl: ci ?? originUrl(),
      commitLinks: Boolean(ci),
      style: noteStyle(config.notes),
    }))
  }
}
