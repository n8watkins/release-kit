#!/usr/bin/env node
// Release notes from Conventional Commits: features, fixes, performance and
// breaking changes since the previous tag. Docs, chores, tests and bot commits
// stay out, so the notes read like a changelog, not a git log.
//
//   node scripts/release-kit/notes.mjs [--from <ref>] [--to <ref>] [--version x.y.z]
import { NOTE_SECTIONS, parse, sectionFor } from './conventional.mjs'
import { commitsBetween, isBot, isMain, previousTag } from './git.mjs'

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

/** Markdown notes for `commits`; `heading` (e.g. "## 1.2.0 - 2026-10-23") is optional. */
export function renderNotes(commits, { heading, repoUrl } = {}) {
  const sections = new Map(NOTE_SECTIONS.map((s) => [s, []]))
  for (const commit of commits) {
    if (isBot(commit.author ?? '')) continue
    const parsed = parse(commit.message)
    const section = sectionFor(parsed)
    if (!section) continue
    const scope = parsed.scope ? `**${parsed.scope}:** ` : ''
    const link = repoUrl && commit.hash ? ` ([${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash}))` : ''
    sections.get(section).push(`- ${scope}${capitalize(parsed.subject)}${link}`)
  }
  const body = [...sections]
    .filter(([, lines]) => lines.length)
    .map(([title, lines]) => `### ${title}\n\n${lines.join('\n')}`)
    .join('\n\n')
  const content = body || '_Maintenance release: no user-facing changes._'
  return heading ? `${heading}\n\n${content}\n` : `${content}\n`
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

// Run as a command (resolving links, so a symlinked scripts/ folder works too).
if (isMain(import.meta.url)) {
  const to = arg('to') ?? 'HEAD'
  // For a tag, start from the tag before it, not the tag itself.
  const from = arg('from') ?? previousTag(`${to}^`)
  const version = arg('version')
  const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
    : undefined
  process.stdout.write(renderNotes(commitsBetween(from, to), {
    heading: version ? `## ${version}` : undefined,
    repoUrl,
  }))
}
