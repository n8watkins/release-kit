// Conventional Commits parsing shared by the commit check, the release notes
// and the release command. No dependencies, so every repo runs the same code.

export const TYPES = {
  feat: 'Features',
  fix: 'Fixes',
  perf: 'Performance',
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
export const NOTE_SECTIONS = ['Breaking changes', 'Features', 'Fixes', 'Performance', 'Reverts']

const HEADER = /^(?<type>[a-z]+)(?:\((?<scope>[^()\s][^()]*)\))?(?<bang>!)?: (?<subject>\S.*)$/
const MAX_HEADER = 100

/** Parse a commit message. Returns null when the header is not conventional. */
export function parse(message) {
  const [header = '', ...rest] = message.replace(/\r/g, '').split('\n')
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
  const header = message.replace(/\r/g, '').split('\n')[0].trim()
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

/** The next version after `current` for a bump of `kind` (or an explicit x.y.z). */
export function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current)
  if (!m) throw new Error(`package.json version "${current}" is not x.y.z`)
  const [major, minor, patch] = m.slice(1).map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump "${kind}"; use patch, minor, major or x.y.z`)
}

/** The bump the commits call for: major for breaking, minor for features, else patch. */
export function suggestedBump(commits) {
  const parsed = commits.map((c) => parse(c.message)).filter(Boolean)
  if (parsed.some((p) => p.breaking)) return 'major'
  if (parsed.some((p) => p.type === 'feat')) return 'minor'
  return 'patch'
}
