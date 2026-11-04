// Reading and setting the version in the files that carry it. A .release.json
// versionFiles entry is a path, whose kind comes from its file name:
//   - JSON (package.json, manifest.json, tauri.conf.json): the top-level "version";
//   - package-lock.json: "version" and the root package's packages[""].version,
//     the two places npm keeps it;
//   - Cargo.toml: the `version` of its [package] table;
//   - Cargo.lock: the version of the package named in the Cargo.toml beside it;
//   - pyproject.toml: the `version` of its [project] table (PEP 621);
//   - uv.lock: the version of the project itself (its [[package]] with source
//     editable or virtual ".", named like the pyproject.toml beside it, or
//     the only such entry when the lock still has an old name);
// or { "path": "...", "pattern": "..." } for any other file: a regular
// expression with exactly one capture group, the version, that matches the
// file exactly once (^ and $ match at each line).
// Edits are made in place on the text, so formatting and the rest of the file
// are left exactly as they were.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// A TOML `version = "..."` (or '...') line; group 2 is the version.
const VERSION_LINE = /^([ \t]*version[ \t]*=[ \t]*(["']))([^"'\r\n]*)\2/m
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A versionFiles entry's path. */
export const entryPath = (entry) => (typeof entry === 'string' ? entry : entry?.path)

/** How an entry reads in messages: its path, and its pattern if it has one. */
export const entryLabel = (entry) => (typeof entry === 'string' ? entry : `${entry.path} (pattern ${entry.pattern})`)

/** An entry with its path under `root`. */
export const entryIn = (root, entry) => (typeof entry === 'string' ? join(root, entry) : { ...entry, path: join(root, entry.path) })

/** A pattern entry's regex, or why it isn't a usable one. */
function compile(pattern) {
  let regex
  try {
    regex = new RegExp(pattern, 'gmd')
  } catch (error) {
    return { problem: `pattern ${pattern} is not a valid regular expression (${error.message})` }
  }
  // An empty alternative matches anywhere, so the match shows every group.
  const groups = new RegExp(`${pattern}|`).exec('').length - 1
  if (groups !== 1) return { problem: `pattern ${pattern} must have exactly one capture group, the version, but has ${groups}` }
  return { regex }
}

/** Why a versionFiles entry is malformed, or null when it is fine. Doesn't read the file. */
export function entryProblem(entry) {
  if (typeof entry === 'string') return entry ? null : 'an empty path'
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${JSON.stringify(entry)} is neither a path nor { "path", "pattern" }`
  const extra = Object.keys(entry).filter((key) => key !== 'path' && key !== 'pattern')
  if (typeof entry.path !== 'string' || !entry.path) return `${JSON.stringify(entry)} has no "path"`
  if (typeof entry.pattern !== 'string' || !entry.pattern) return `${entry.path}: no "pattern"`
  if (extra.length) return `${entry.path}: unknown key${extra.length > 1 ? 's' : ''} ${extra.join(', ')} (an entry has only "path" and "pattern")`
  const { problem } = compile(entry.pattern)
  return problem ? `${entry.path}: ${problem}` : null
}

/**
 * Problems with a whole versionFiles list, read against the files under `root`:
 * malformed entries, and a pyproject.toml whose uv.lock beside it isn't listed
 * (a release would leave the lock saying the old version).
 */
export function versionFilesProblems(entries, root = '.') {
  if (!Array.isArray(entries)) return ['"versionFiles" must be a list']
  const problems = entries.map(entryProblem).filter(Boolean)
  const paths = new Set(entries.map(entryPath))
  for (const path of paths) {
    if (typeof path !== 'string' || basename(path) !== 'pyproject.toml') continue
    const lock = dirname(path) === '.' ? 'uv.lock' : `${dirname(path)}/uv.lock`
    if (!paths.has(lock) && existsSync(join(root, lock))) problems.push(`${path} is listed but the ${lock} beside it isn't: add "${lock}" so a release bumps both`)
  }
  return problems
}

/** A TOML table from its `[name]` header to the next table header. */
function table(text, name) {
  const start = text.search(new RegExp(`^[ \\t]*\\[[ \\t]*${escape(name)}[ \\t]*\\][ \\t]*(#[^\\r\\n]*)?\\r?$`, 'm'))
  return start === -1 ? null : { start, end: tableEnd(text, start) }
}

/** Where the table whose header line starts at `start` ends: at the next header, or the end of the text. */
function tableEnd(text, start) {
  const body = text.indexOf('\n', start) + 1
  if (body === 0) return text.length
  const next = text.slice(body).search(/^[ \t]*\[/m)
  return next === -1 ? text.length : body + next
}

/** The `version` line of a TOML table, as a match whose index is in the whole text. */
function tableVersion(text, path, name) {
  const range = table(text, name)
  const match = range && VERSION_LINE.exec(text.slice(range.start, range.end))
  if (!match) throw new Error(`${path} has no version in its [${name}] table`)
  match.index += range.start
  return match
}

/** The `name` of a TOML table in the file at `path`. */
function tableName(path, name, lockPath) {
  const text = readFileSync(path, 'utf8')
  const range = table(text, name)
  const match = range && /^[ \t]*name[ \t]*=[ \t]*(["'])([^"'\r\n]+)\1/m.exec(text.slice(range.start, range.end))
  if (!match) throw new Error(`${lockPath}: the ${basename(path)} beside it has no [${name}] name`)
  return match[2]
}

/** The `[[package]]` entry of `name` in a Cargo.lock, as a regex match on its name and version lines. */
function cargoLockEntry(text, path, name) {
  const match = new RegExp(`^(\\[\\[package\\]\\]\\r?\\nname = "${escape(name)}"\\r?\\nversion = ")([^"]*)(")`, 'm').exec(text)
  if (!match) throw new Error(`${path} has no package "${name}"`)
  return { index: match.index + match[1].length, version: match[2] }
}

// PEP 503: names compare lowercased, with runs of -, _ and . as one -.
const normalize = (name) => name.toLowerCase().replace(/[-_.]+/g, '-')

/**
 * The project's own `[[package]]` entry in a uv.lock: the one with source
 * editable or virtual ".", named like the project. When none has the
 * project's name (a lock written before the project was renamed, until the
 * next `uv lock`), the one entry with source "." is it.
 */
function uvLockEntry(text, path, name) {
  const headers = [...text.matchAll(/^\[\[package\]\][ \t]*\r?$/gm)].map((m) => m.index)
  const own = headers
    .map((start) => ({ start, block: text.slice(start, tableEnd(text, start)) }))
    .filter(({ block }) => /^source[ \t]*=[ \t]*\{[^}\r\n]*\b(editable|virtual)[ \t]*=[ \t]*"\."/m.test(block))
  const named = own.filter(({ block }) => normalize(/^name[ \t]*=[ \t]*"([^"]*)"/m.exec(block)?.[1] ?? '') === normalize(name))
  const entry = named[0] ?? (own.length === 1 ? own[0] : null)
  if (!entry) {
    const why = own.length ? `and ${own.length} entries have source editable or virtual ".", so it can't tell which is the project` : '(a [[package]] with source editable or virtual ".")'
    throw new Error(`${path} has no entry for the project "${name}" ${why}: run uv lock to update it`)
  }
  const match = VERSION_LINE.exec(entry.block)
  if (!match) throw new Error(`${path}: the entry for "${name}" has no version`)
  return { index: entry.start + match.index + match[1].length, version: match[3] }
}

/** The single match of a pattern entry in `text`, with where its version starts. */
function patternMatch(text, entry) {
  const { regex, problem } = compile(entry.pattern)
  if (problem) throw new Error(`${entry.path}: ${problem}`)
  const matches = [...text.matchAll(regex)]
  if (matches.length !== 1) {
    throw new Error(`${entry.path}: pattern ${entry.pattern} must match exactly once, but matches ${matches.length === 0 ? 'nowhere' : `${matches.length} times`}`)
  }
  const [match] = matches
  if (match[1] === undefined) throw new Error(`${entry.path}: pattern ${entry.pattern} matched, but its capture group took no part in the match`)
  return { index: match.indices[1][0], version: match[1] }
}

/** Where the version is in a file's text: its start index and the version itself. */
function locate(entry, text) {
  if (typeof entry !== 'string') return patternMatch(text, entry)
  const path = entry
  const file = basename(path)
  const toml = (name) => {
    const match = tableVersion(text, path, name)
    return { index: match.index + match[1].length, version: match[3] }
  }
  if (file === 'Cargo.toml') return toml('package')
  if (file === 'pyproject.toml') return toml('project')
  if (file === 'Cargo.lock') return cargoLockEntry(text, path, tableName(join(dirname(path), 'Cargo.toml'), 'package', path))
  if (file === 'uv.lock') return uvLockEntry(text, path, tableName(join(dirname(path), 'pyproject.toml'), 'project', path))
  return null
}

/** The version a file carries, read from `text` (default: the file on disk). `entry` is a path or { path, pattern }. */
export function readVersion(entry, text = readFileSync(entryPath(entry), 'utf8')) {
  const found = locate(entry, text)
  return found ? found.version : JSON.parse(text).version
}

/** Sets the version in a file, changing nothing else. `entry` is a path or { path, pattern }. */
export function setVersion(entry, version) {
  const path = entryPath(entry)
  const text = readFileSync(path, 'utf8')
  const found = locate(entry, text)
  let next
  if (found) {
    next = text.slice(0, found.index) + version + text.slice(found.index + found.version.length)
  } else {
    const json = JSON.parse(text)
    json.version = version
    if (basename(path) === 'package-lock.json' && json.packages?.['']) json.packages[''].version = version
    const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  '
    next = `${JSON.stringify(json, null, indent)}\n`
  }
  writeFileSync(path, next)
}
