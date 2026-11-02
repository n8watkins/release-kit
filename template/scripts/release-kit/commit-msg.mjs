#!/usr/bin/env node
// Checks commit messages against Conventional Commits.
//
//   node scripts/release-kit/commit-msg.mjs <file>          (the commit-msg hook)
//   node scripts/release-kit/commit-msg.mjs --range a..b    (CI: every commit in a range)
//   node scripts/release-kit/commit-msg.mjs --title <file>  (CI: a pull request title, which a
//                                                            squash merge makes the commit on main)
import { readFileSync } from 'node:fs'
import { lint } from './conventional.mjs'
import { commitsBetween, git, isBot, isMain } from './git.mjs'

/**
 * The message git will store, from the file the hook gets: git strips comment
 * lines and everything below the `git commit -v` scissors line only after the
 * hook runs.
 */
export function messageFromFile(raw, commentChar = '#') {
  const lines = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n')
  const scissors = lines.findIndex((line) => line === `${commentChar} ------------------------ >8 ------------------------`)
  return (scissors === -1 ? lines : lines.slice(0, scissors))
    .filter((line) => !line.startsWith(commentChar))
    .join('\n')
    .replace(/^\s*\n/, '')
}

function commentChar() {
  try {
    const value = git('config', 'core.commentChar')
    // "auto" picks a character git doesn't tell the hook about; '#' is its first choice.
    return value && value !== 'auto' ? value : '#'
  } catch {
    return '#'
  }
}

if (isMain(import.meta.url)) {
  const rangeAt = process.argv.indexOf('--range')
  const titleAt = process.argv.indexOf('--title')
  const failures = []

  if (titleAt !== -1) {
    // The title as typed: no comment stripping, a title can start with "#".
    const title = readFileSync(process.argv[titleAt + 1], 'utf8').replace(/\r?\n$/, '')
    const problem = title.includes('\n') ? 'a title is one line' : lint(title)
    if (problem) {
      console.error(`Pull request title check failed (a squash merge makes the title the commit message on main; see RELEASING.md):\n  - "${title}": ${problem}`)
      process.exit(1)
    }
  } else if (rangeAt !== -1) {
    const [from, to] = (process.argv[rangeAt + 1] ?? '').split('..')
    for (const commit of commitsBetween(from || null, to || 'HEAD')) {
      if (isBot(commit.author)) continue
      const problem = lint(commit.message)
      if (problem) failures.push(`${commit.hash.slice(0, 7)} "${commit.message.split('\n')[0]}": ${problem}`)
    }
  } else if (process.argv[2]) {
    const problem = lint(messageFromFile(readFileSync(process.argv[2], 'utf8'), commentChar()))
    if (problem) failures.push(problem)
  }

  if (failures.length) {
    console.error('Commit message check failed (see RELEASING.md):')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
}
