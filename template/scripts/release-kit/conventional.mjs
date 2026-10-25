// Conventional Commits parsing shared by the commit check, the release notes
// and the release command. No dependencies, so every repo runs the same code.

export const TYPES = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
  // Not in the Conventional Commits spec, but these repos use it for
  // hardening a user would want to know about (a checksum, a tighter CSP).
  security: 'Security',
  refactor: null,
  docs: null,
  test: null,
  build: null,
  ci: null,
  chore: null,
  style: null,
  revert: 'Reverts',
}

// Sections that appear in release notes, in this order.
export const NOTE_SECTIONS = ['Breaking changes', 'Features', 'Fixes', 'Security', 'Performance', 'Reverts']

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s][^()]*)\))?(?<bang>!)?: (?<subject>\S.*)$/
const MAX_HEADER = 100

/** The only tags the kit makes or reads: vX.Y.Z, nothing before or after. */
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * Line endings, a byte-order mark (Windows editors) and leading blank lines
 * (git drops them) never change the meaning.
 */
const normalize = (message) => message.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/^\s*\n/, '')

/** Parse a commit message. Returns null when the header is not conventional. */
export function parse(message) {
  const [header = '', ...rest] = normalize(message).split('\n')
  const match = HEADER.exec(header.trim())
  if (!match || !(match.groups.type in TYPES)) return null
  const body = rest.join('\n')
  return {
    type: match.groups.type,
    scope: match.groups.scope ?? null,
    subject: match.groups.subject.trim(),
    breaking: Boolean(match.groups.bang) || /^BREAKING[ -]CHANGE: /m.test(body),
  }
}

/** Messages git or tools write for us, which the check lets through. */
export function isExempt(message) {
  return /^(Merge |Revert "|fixup! |squash! |amend! )/.test(message) || /^Initial commit\b/.test(message)
}

/** Why a commit message fails the standard, or null when it passes. */
export function lint(message) {
  const header = normalize(message).split('\n')[0].trim()
  if (!header) return 'empty commit message'
  if (isExempt(header)) return null
  if (header.length > MAX_HEADER) return `header is ${header.length} characters; keep it to ${MAX_HEADER}`
  const parsed = parse(message)
  if (parsed) return null
  const type = /^([A-Za-z]+)[(:!]/.exec(header)?.[1]
  if (type && !(type.toLowerCase() in TYPES)) {
    return `unknown type "${type}"; use one of: ${Object.keys(TYPES).join(', ')}`
  }
  return 'expected "type(scope): subject", for example "feat: add dark mode" or "fix(popup): keep the last tab"'
}

/** The release-notes section a commit belongs in, or null to leave it out. */
export function sectionFor(parsed) {
  if (!parsed) return null
  if (parsed.breaking) return 'Breaking changes'
  return TYPES[parsed.type]
}

export const isVersion = (value) => typeof value === 'string' && VERSION.test(value)

/** Negative, zero or positive, like a sort comparator, for two x.y.z versions. */
export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** The next version after `current` for a bump of `kind` (or an explicit x.y.z). */
export function nextVersion(current, kind) {
  if (!isVersion(current)) throw new Error(`package.json version "${current}" is not x.y.z`)
  if (/^\d+\.\d+\.\d+$/.test(kind)) {
    if (!isVersion(kind)) throw new Error(`"${kind}" is not a valid x.y.z version`)
    if (compareVersions(kind, current) <= 0) throw new Error(`${kind} is not higher than the current ${current}`)
    return kind
  }
  const [major, minor, patch] = current.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump "${kind}"; use patch, minor, major or x.y.z`)
}

/** Commits written by bots (Dependabot, GitHub Actions): checked for nothing, left out of the notes. */
export function isBot(author) {
  return /\[bot\]$|^dependabot|^github-actions/i.test(author ?? '')
}

/** The bump the commits call for: major for breaking, minor for features, else patch. */
export function suggestedBump(commits) {
  const parsed = commits.filter((c) => !isBot(c.author)).map((c) => parse(c.message)).filter(Boolean)
  if (parsed.some((p) => p.breaking)) return 'major'
  if (parsed.some((p) => p.type === 'feat')) return 'minor'
  return 'patch'
}

/** Commits that reach the release notes: a feature, fix, security or performance change, revert or breaking change by a person. */
export function userFacing(commits) {
  return commits.filter((c) => !isBot(c.author) && sectionFor(parse(c.message)))
}

/**
 * What the release train should do now. `bump` is "auto" (release only when
 * there are user-facing commits, with the bump they call for) or an explicit
 * patch, minor, major or x.y.z (release if there is any commit at all).
 * Returns { release, reason, bump?, version? }.
 */
export function planRelease({ current, commits, bump = 'auto' }) {
  const count = (n) => `${n} commit${n === 1 ? '' : 's'}`
  if (!commits.length) return { release: false, reason: 'no commits since the last release' }
  if (bump === 'auto') {
    const shown = userFacing(commits)
    if (!shown.length) {
      return { release: false, reason: `${count(commits.length)} since the last release, none user-facing (feat, fix, perf, security)` }
    }
    const kind = suggestedBump(commits)
    return { release: true, reason: `${shown.length} user-facing of ${count(commits.length)}`, bump: kind, version: nextVersion(current, kind) }
  }
  return { release: true, reason: `${bump} requested, ${count(commits.length)}`, bump, version: nextVersion(current, bump) }
}
