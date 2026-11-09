#!/usr/bin/env node
// Backfill: releases.json entries (and, if asked, GitHub Release notes) for
// release tags made before the kit wrote them, rebuilt from the commits
// between each tag and the one before it.
//
//   npx release-kit backfill [--since vX.Y.Z] [--verbose] [--json] [--no-github]
//       A dry run (the default): prints the plan, writes nothing.
//   npx release-kit backfill --write
//       Adds the planned releases to releases.json (and releases.xml when the
//       feed is on). Commit the result through a pull request.
//   npx release-kit backfill --edit-releases
//       Also fills in GitHub Release notes, only where a release has none or
//       only GitHub's generated "What's Changed" list. Needs gh, signed in
//       with write access. A release with notes someone wrote is never touched,
//       and no release is created for a tag that has none.
//
// It is careful with messy early history:
//   - a tag already in releases.json is kept as it is;
//   - a baseline tag (npm run release -- --baseline) is a marker, not a
//     release, and is skipped;
//   - a tag whose history holds a higher release tag (tags made out of order)
//     is skipped, since its range can't be told;
//   - commits that aren't Conventional Commits can't be sorted into notes:
//     they are counted in the entry's "unattributed", so a reader knows the
//     notes may be short, and listed with --verbose;
//   - bot commits, merges and git's own messages are left out, as at release.
// Pull request numbers come from a "(#12)" at the end of the subject, else,
// with gh, from GitHub's list of pull requests that merged the commit.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions, isBot, isExempt, parse } from './conventional.mjs'
import { commitsBetween, git, isBaseline, isCommit, isMain, previousTag, releaseTags, repoUrl } from './git.mjs'
import { noteItems, noteStyle, notesFromTag, renderNotes } from './notes.mjs'
import { RELEASES_FILE, readDocument, releaseEntry, releasesConfig, slugOf, writeReleaseFiles } from './releases.mjs'

// Headings the kit writes, plain and classic: a body with one has kit notes.
const KIT_HEADING = /^#{2,4}\s+(Breaking changes|New|Fixed|Faster|Safer|Reverted|Features|Fixes|Performance|Security|Reverts)\s*$/m
// Lines of GitHub's generated release notes, and nothing a person wrote.
const GENERATED_LINE = /^(## What's Changed|## New Contributors|\* .+ by @[\w-]+(\[bot\])? in https:\/\/\S+|\* @[\w-]+ made their first contribution in https:\/\/\S+|\*\*Full Changelog\*\*: \S+)$/

/**
 * What a GitHub Release's body holds:
 *   none       no release for the tag
 *   draft      a draft (left alone)
 *   kit        the kit's notes
 *   empty      nothing, or only a "Full Changelog" link
 *   generated  only GitHub's generated "What's Changed" list
 *   written    anything else: someone wrote it, so it is kept
 */
export function bodyKind(release) {
  if (!release) return 'none'
  if (release.draft) return 'draft'
  const body = (release.body ?? '').replace(/\r\n?/g, '\n').trim()
  if (KIT_HEADING.test(body) || /^_Maintenance release: no user-facing changes\._$/m.test(body)) return 'kit'
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.every((l) => /^\*\*Full Changelog\*\*: \S+$/.test(l))) return 'empty'
  if (lines.every((l) => GENERATED_LINE.test(l))) return 'generated'
  return 'written'
}

/** Release bodies backfill may replace: nothing a person wrote. */
export const EDITABLE = ['empty', 'generated']

/** Splits a range's commits into the ones the notes can use and the ones they can't. */
export function attribute(commits) {
  const usable = []
  const unattributed = []
  for (const commit of commits) {
    if (isBot(commit.author)) continue
    const header = commit.message.split('\n')[0]
    if (isExempt(header)) continue
    if (parse(commit.message)) usable.push(commit)
    else unattributed.push(commit)
  }
  return { usable, unattributed }
}

/** The summary line a kit-made tag's notes open with, if any. */
export function summaryFromNotes(notes) {
  if (!notes) return null
  const lead = notes.split(/^### /m)[0].trim()
  return lead && !/^_Maintenance release/.test(lead) ? lead : null
}

/** The Markdown notes backfill writes into a GitHub Release. */
export function backfilledBody({ usable, unattributed, summary, previous, repo, style, keepLink }) {
  const notes = renderNotes(usable, { summary, repoUrl: repo, commitLinks: true, style }).trimEnd()
  const since = previous ? `since ${previous}` : 'up to this tag'
  const footer = [`_Notes backfilled by release-kit from the commits ${since}._`]
  if (unattributed) footer.push(`_${unattributed} commit${unattributed === 1 ? '' : 's'} in this release ${unattributed === 1 ? "doesn't" : "don't"} follow Conventional Commits and ${unattributed === 1 ? "isn't" : "aren't"} listed._`)
  return `${[notes, footer.join('\n'), keepLink].filter(Boolean).join('\n\n')}\n`
}

const day = (iso, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

/**
 * The plan for every release tag. `github` is null (unknown) or
 * { releases: Map(tag -> { body, draft }), pullOf(sha) -> number | null }.
 */
export function plan({ doc, tags, since, config = {}, github = null, origin }) {
  const have = new Set(doc.releases.map((r) => r.tag))
  const style = noteStyle(config.notes)
  const out = []
  for (const tag of [...tags].sort((a, b) => compareVersions(a.slice(1), b.slice(1)))) {
    const version = tag.slice(1)
    if (since && compareVersions(version, since.slice(1)) < 0) continue
    const item = { tag, version, action: 'skip', reason: '', github: github ? bodyKind(github.releases.get(tag)) : 'unknown', edit: false }
    out.push(item)
    if (!isCommit(tag)) {
      item.reason = 'not a commit'
      continue
    }
    if (isBaseline(tag)) {
      item.reason = 'baseline tag: a version marker, not a release'
      continue
    }
    const previous = previousTag(`${tag}^`)
    if (previous && compareVersions(previous.slice(1), version) >= 0) {
      item.reason = `${previous} is on its history, so its changes can't be told apart (tags made out of order)`
      continue
    }
    const { usable, unattributed } = attribute(commitsBetween(previous, tag))
    const items = noteItems(usable)
    // A release already in releases.json keeps its entry; its GitHub notes may still be missing.
    const kept = have.has(tag)
    if (github && !kept) for (const note of items) if (note.pr === null && note.hash) note.pr = github.pullOf(note.hash)
    const time = new Date(Number(git('for-each-ref', '--format=%(creatordate:unix)', `refs/tags/${tag}`)) * 1000).toISOString().replace(/\.\d+Z$/, 'Z')
    const summary = summaryFromNotes(notesFromTag(tag))
    const entry = releaseEntry({ version, date: day(time, config.timeZone), time, previous, summary, items, repoUrl: origin, source: 'backfill', unattributed: unattributed.length })
    Object.assign(item, {
      action: kept ? 'keep' : 'add',
      reason: kept ? `already in ${RELEASES_FILE}` : entry.notes.length ? '' : unattributed.length ? 'no notes: none of its commits follow Conventional Commits' : 'no user-facing changes',
      previous,
      entry,
      unattributedSubjects: unattributed.map((c) => c.message.split('\n')[0]),
    })
    if (EDITABLE.includes(item.github) && entry.notes.length) {
      const keepLink = /^\*\*Full Changelog\*\*: \S+$/m.exec(github.releases.get(tag).body ?? '')?.[0]
      item.edit = true
      item.body = backfilledBody({ usable, unattributed: unattributed.length, summary, previous, repo: origin, style, keepLink })
    }
  }
  return out
}

/** gh, reading what backfill needs from GitHub; null when gh can't (not installed, signed out, offline). */
function githubFor(slug) {
  const GH = process.env.RELEASE_KIT_GH || 'gh'
  const gh = (...args) => execFileSync(GH, args, { encoding: 'utf8', maxBuffer: 1024 ** 3, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (!slug || process.env.RELEASE_KIT_OFFLINE) return null
  let lines
  try {
    lines = gh('api', '--paginate', `repos/${slug}/releases?per_page=100`, '--jq', '.[] | {tag: .tag_name, body, draft}').split('\n').filter(Boolean)
  } catch (error) {
    console.error(`backfill: can't read ${slug}'s releases with gh (${(error.stderr || error.message).trim().split('\n')[0]}); planning without GitHub`)
    return null
  }
  const releases = new Map(lines.map((line) => JSON.parse(line)).map((r) => [r.tag, r]))
  const pulls = new Map()
  let looked = 0
  return {
    releases,
    pullOf(sha) {
      if (!pulls.has(sha)) {
        if (++looked % 25 === 0) console.error(`backfill: looked up ${looked} commits' pull requests`)
        let number = null
        try {
          const found = gh('api', `repos/${slug}/commits/${sha}/pulls`, '--jq', '[.[] | select(.merged_at != null) | .number] | sort | .[0]').trim()
          number = /^\d+$/.test(found) ? Number(found) : null
        } catch {}
        pulls.set(sha, number)
      }
      return pulls.get(sha)
    },
    edit(tag, body) {
      const dir = mkdtempSync(join(tmpdir(), 'release-kit-backfill-'))
      try {
        writeFileSync(join(dir, 'notes.md'), body)
        gh('release', 'edit', tag, '--repo', slug, '--notes-file', join(dir, 'notes.md'))
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}

const GITHUB_LABEL = {
  unknown: 'GitHub: not checked',
  none: 'GitHub: no release (not created)',
  draft: 'GitHub: draft (kept)',
  kit: 'GitHub: has kit notes',
  empty: 'GitHub: empty',
  generated: "GitHub: generated \"What's Changed\"",
  written: 'GitHub: written notes (kept)',
}

function main() {
  const args = process.argv.slice(2)
  const flag = (name) => args.includes(`--${name}`)
  const valueOf = (name) => {
    const at = args.indexOf(`--${name}`)
    return at === -1 ? undefined : args[at + 1]
  }
  const fail = (message) => {
    console.error(`backfill: ${message}`)
    process.exit(1)
  }
  const known = new Set(['since', 'write', 'edit-releases', 'json', 'verbose', 'no-github'])
  for (const [i, a] of args.entries()) {
    if (a.startsWith('--') && !known.has(a.slice(2))) fail(`unknown option ${a}`)
    if (!a.startsWith('--') && args[i - 1] !== '--since') fail(`unexpected argument "${a}"`)
  }
  const since = valueOf('since')
  if (flag('since') && !/^v\d+\.\d+\.\d+$/.test(since ?? '')) fail('--since needs a release tag, like --since v0.5.0')
  if (flag('edit-releases') && flag('no-github')) fail('--edit-releases needs GitHub; drop --no-github')

  const config = existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')) : {}
  let wanted
  try {
    wanted = releasesConfig(config.releases)
  } catch (error) {
    fail(error.message)
  }
  if (!wanted.json && flag('write')) fail('.release.json "releases" is false, so there is no releases.json to write')
  const origin = repoUrl()
  const repository = typeof config.repository === 'string' ? config.repository : slugOf(origin)
  const site = origin ?? (repository ? `https://github.com/${repository}` : undefined)
  let doc
  try {
    doc = readDocument(repository)
  } catch (error) {
    fail(error.message)
  }
  const github = flag('no-github') ? null : githubFor(repository)
  if (flag('edit-releases') && !github) fail(`--edit-releases needs gh signed in with access to ${repository ?? 'the repo'}`)

  const tags = releaseTags()
  const items = plan({ doc, tags, since, config, github, origin: site })
  const adding = items.filter((i) => i.action === 'add')
  const editing = items.filter((i) => i.edit)

  if (flag('json')) {
    console.log(JSON.stringify({ repository, tags: items.map(({ entry, body, unattributedSubjects, ...rest }) => ({ ...rest, notes: entry?.notes.length ?? null, unattributed: entry?.unattributed ?? null, entry: entry ?? null })) }, null, 2))
  } else {
    console.log(`backfill: ${repository ?? 'this repo'}: ${tags.length} release tag${tags.length === 1 ? '' : 's'}${since ? ` (from ${since})` : ''}, ${doc.releases.length} already in ${RELEASES_FILE}`)
    const width = Math.max(...items.map((i) => i.tag.length), 4)
    for (const item of items) {
      const what = item.action === 'add'
        ? `add   ${item.entry.date}  ${String(item.entry.notes.length).padStart(3)} note${item.entry.notes.length === 1 ? ' ' : 's'}${item.entry.unattributed ? `, ${item.entry.unattributed} unattributed` : ''}${item.reason ? ` (${item.reason})` : ''}`
        : `${item.action.padEnd(5)} ${item.reason}`
      const gh = item.entry ? `  [${GITHUB_LABEL[item.github]}${item.edit ? ': notes will be filled in' : ''}]` : ''
      console.log(`  ${item.tag.padEnd(width)}  ${what}${gh}`)
      if (flag('verbose') && item.action === 'add') {
        for (const note of item.entry.notes) console.log(`      ${note.section.padEnd(8)} ${note.text}${note.pr ? ` (#${note.pr})` : ''}`)
        for (const subject of item.unattributedSubjects) console.log(`      ?        ${subject}`)
      }
    }
  }

  const summary = []
  if (flag('write') && adding.length) {
    let written
    try {
      written = writeReleaseFiles(adding.map((i) => i.entry), { config, repository })
    } catch (error) {
      fail(error.message)
    }
    summary.push(`wrote ${adding.length} release${adding.length === 1 ? '' : 's'} into ${written.join(' and ')}; commit ${written.length === 1 ? 'it' : 'them'} through a pull request`)
  }
  if (flag('edit-releases')) {
    for (const item of editing) {
      try {
        github.edit(item.tag, item.body)
      } catch (error) {
        fail(`could not edit the release ${item.tag}: ${(error.stderr || error.message).trim()}`)
      }
    }
    summary.push(`filled in the notes of ${editing.length} GitHub Release${editing.length === 1 ? '' : 's'}`)
  }
  if (!flag('write') && !flag('edit-releases')) {
    summary.push(`dry run, nothing written: --write adds ${adding.length} release${adding.length === 1 ? '' : 's'} to ${RELEASES_FILE}${github ? `, --edit-releases fills in ${editing.length} GitHub Release${editing.length === 1 ? '' : 's'} with no notes or only generated ones` : ''}`)
  }
  for (const line of summary) (flag('json') ? console.error : console.log)(`backfill: ${line}`)
}

if (isMain(import.meta.url)) main()
