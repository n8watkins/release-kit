// Per-repo settings that depend on whether the repo is public or private
// (.release.json "visibility", which apply detects with gh).
//
// Standard runners are free in public repos and billed per minute, rounded up
// per job, in private ones, so a private repo skips work that costs minutes
// without protecting anything. Every default can be overridden in .release.json:
//
//   "security": { "onPullRequest": true }   scan lock-file pull requests too
//   "attest": true                           artifact attestations (roadmap item 2)
import { execFileSync } from 'node:child_process'

export const VISIBILITIES = ['public', 'private']

/** "public", "private", or null when .release.json doesn't say. */
export function visibilityOf(config = {}) {
  return VISIBILITIES.includes(config.visibility) ? config.visibility : null
}

/**
 * The settings a repo runs with: its own choices, else the defaults for its
 * visibility. A repo whose visibility is unknown gets the public defaults,
 * which run more, never less.
 *   security.onPullRequest  the OSV scan on pull requests that change a lock file
 *                           (private: weekly only; Dependabot alerts cover the rest)
 *   attest                  artifact attestations, which private repos can only
 *                           have on GitHub Enterprise Cloud
 */
export function settings(config = {}) {
  const visibility = visibilityOf(config)
  const isPrivate = visibility === 'private'
  const own = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    visibility,
    security: { onPullRequest: own(config.security?.onPullRequest, !isPrivate) },
    attest: own(config.attest, !isPrivate),
  }
}

/**
 * The repo's visibility on GitHub with the gh CLI: "public" or "private"
 * ("internal" counts as private: it is billed like one), or null when gh
 * can't tell (not installed, signed out, offline, no such repo).
 */
export function detectVisibility(repo, { timeout = 15_000 } = {}) {
  if (!repo || process.env.RELEASE_KIT_OFFLINE) return null
  try {
    const out = execFileSync('gh', ['repo', 'view', repo, '--json', 'visibility', '--jq', '.visibility'], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] }).trim().toLowerCase()
    if (out === 'public') return 'public'
    if (out === 'private' || out === 'internal') return 'private'
  } catch {}
  return null
}
