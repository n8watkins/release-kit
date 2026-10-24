// Small git helpers for the release scripts.
import { execFileSync } from 'node:child_process'

export const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** The newest v* tag reachable from `ref`, or null for a repo with none. */
export function previousTag(ref = 'HEAD') {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', ref)
  } catch {
    return null
  }
}

/** Commits in `from..to` (all of `to` when from is null), oldest first. */
export function commitsBetween(from, to = 'HEAD') {
  const SEP = '\u001e'
  const END = '\u001f'
  const range = from ? `${from}..${to}` : to
  const out = git('log', '--reverse', '--no-merges', `--format=%H${SEP}%an${SEP}%B${END}`, range)
  return out
    .split(END)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, author, message] = chunk.split(SEP)
      return { hash, author, message: message.trim() }
    })
}

export function isBot(author) {
  return /\[bot\]$|^dependabot|^github-actions/i.test(author)
}
