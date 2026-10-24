#!/usr/bin/env node
// Checks commit messages against Conventional Commits.
//
//   node scripts/release-kit/commit-msg.mjs <file>          (the commit-msg hook)
//   node scripts/release-kit/commit-msg.mjs --range a..b    (CI: every commit in a range)
import { readFileSync } from 'node:fs'
import { lint } from './conventional.mjs'
import { commitsBetween, isBot } from './git.mjs'

const rangeAt = process.argv.indexOf('--range')
const failures = []

if (rangeAt !== -1) {
  const [from, to] = process.argv[rangeAt + 1].split('..')
  for (const commit of commitsBetween(from || null, to || 'HEAD')) {
    if (isBot(commit.author)) continue
    const problem = lint(commit.message)
    if (problem) failures.push(`${commit.hash.slice(0, 7)} "${commit.message.split('\n')[0]}": ${problem}`)
  }
} else {
  const message = readFileSync(process.argv[2], 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
  const problem = lint(message)
  if (problem) failures.push(problem)
}

if (failures.length) {
  console.error('Commit message check failed (see RELEASING.md):')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
