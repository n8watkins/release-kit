// Small git helpers for the release scripts.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { RELEASE_TAG, compareVersions } from './conventional.mjs'

export { isBot } from './conventional.mjs'

// A repo adopting the kit without a baseline can have years of history in one
// `git log`; Node's default 1 MB output buffer would cut it off.
const MAX_OUTPUT = 1024 * 1024 * 1024

export const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** True when `ref` names a commit. Never treats `ref` as an option. */
export function isCommit(ref) {
  try {
    git('rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`)
    return true
  } catch {
    return false
  }
}

/** True when commit `a` is on `b`'s history. */
export function isAncestor(a, b) {
  try {
    git('merge-base', '--is-ancestor', a, b)
    return true
  } catch {
    return false
  }
}

/** Every vX.Y.Z tag in the repo, highest version first. Other v* tags are ignored. */
export function releaseTags(...args) {
  return git('tag', '--list', ...args, 'v[0-9]*')
    .split('\n')
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort((a, b) => compareVersions(b.slice(1), a.slice(1)))
}

/**
 * The highest vX.Y.Z tag on `ref`'s history, or null for a repo with none.
 * Highest by version, not nearest by distance, so a stray old tag on a
 * recent commit, or a prerelease tag, can't make a release relist old work.
 */
export function previousTag(ref = 'HEAD') {
  if (!isCommit(ref)) return null
  return releaseTags('--merged', git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`))[0] ?? null
}

/** Commits in `from..to` (all of `to` when from is null), oldest first. */
export function commitsBetween(from, to = 'HEAD') {
  const SEP = '\u001e'
  const END = '\u001f'
  const range = from ? `${from}..${to}` : to
  const out = git('log', '--reverse', '--no-merges', `--format=%H${SEP}%an${SEP}%B${END}`, '--end-of-options', range, '--')
  return out
    .split(END)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash, author, message] = chunk.split(SEP)
      return { hash, author, message: message.replace(/\r\n?/g, '\n').trim() }
    })
}

/** True when the module at `url` is the script node was started with (through a symlink too). */
export function isMain(url) {
  return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
}

/** The GitHub address of `origin` (https://github.com/owner/repo), or undefined for any other remote. */
export function repoUrl() {
  try {
    const url = git('remote', 'get-url', 'origin')
    const match = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)
    return match ? `https://github.com/${match[1]}` : undefined
  } catch {
    return undefined
  }
}
