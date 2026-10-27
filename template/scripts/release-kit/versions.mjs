// Reading and setting the version in the files that carry it, by kind:
//   - JSON (package.json, manifest.json, tauri.conf.json): the top-level "version";
//   - package-lock.json: "version" and the root package's packages[""].version,
//     the two places npm keeps it;
//   - Cargo.toml: the `version` of its [package] table;
//   - Cargo.lock: the version of the package named in the Cargo.toml beside it.
// Edits are made in place on the text, so formatting and the rest of the file
// are left exactly as they were.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const VERSION_LINE = /^(version\s*=\s*")([^"]*)(")/m

/** The [package] table of a Cargo.toml: from its header to the next table. */
function packageTable(text) {
  const start = text.search(/^\[package\]\s*$/m)
  if (start === -1) return null
  const rest = text.slice(start + 1)
  const next = rest.search(/^\[/m)
  return { start, end: next === -1 ? text.length : start + 1 + next }
}

function cargoTomlVersion(text, path) {
  const table = packageTable(text)
  const match = table && VERSION_LINE.exec(text.slice(table.start, table.end))
  if (!match) throw new Error(`${path} has no version in its [package] table`)
  return match[2]
}

function setCargoTomlVersion(text, path, version) {
  cargoTomlVersion(text, path)
  const { start, end } = packageTable(text)
  return text.slice(0, start) + text.slice(start, end).replace(VERSION_LINE, (_, before, _old, after) => `${before}${version}${after}`) + text.slice(end)
}

/** The crate a Cargo.lock belongs to: the [package] name of the Cargo.toml beside it. */
function crateName(lockPath) {
  const toml = readFileSync(join(dirname(lockPath), 'Cargo.toml'), 'utf8')
  const table = packageTable(toml)
  const match = table && /^name\s*=\s*"([^"]+)"/m.exec(toml.slice(table.start, table.end))
  if (!match) throw new Error(`${lockPath}: the Cargo.toml beside it has no [package] name`)
  return match[1]
}

/** The `[[package]]` entry of `name` in a Cargo.lock, as a regex match on its name and version lines. */
function lockEntry(text, path, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`^(\\[\\[package\\]\\]\\r?\\nname = "${escaped}"\\r?\\nversion = ")([^"]*)(")`, 'm').exec(text)
  if (!match) throw new Error(`${path} has no package "${name}"`)
  return match
}

/** The version a file carries, read from `text` (default: the file on disk). */
export function readVersion(path, text = readFileSync(path, 'utf8')) {
  const file = basename(path)
  if (file === 'Cargo.toml') return cargoTomlVersion(text, path)
  if (file === 'Cargo.lock') return lockEntry(text, path, crateName(path))[2]
  return JSON.parse(text).version
}

/** Sets the version in a file, changing nothing else. */
export function setVersion(path, version) {
  const file = basename(path)
  const text = readFileSync(path, 'utf8')
  let next
  if (file === 'Cargo.toml') {
    next = setCargoTomlVersion(text, path, version)
  } else if (file === 'Cargo.lock') {
    const match = lockEntry(text, path, crateName(path))
    next = text.slice(0, match.index) + `${match[1]}${version}${match[3]}` + text.slice(match.index + match[0].length)
  } else {
    const json = JSON.parse(text)
    json.version = version
    if (file === 'package-lock.json' && json.packages?.['']) json.packages[''].version = version
    const indent = /^[ \t]+(?=")/m.exec(text)?.[0] ?? '  '
    next = `${JSON.stringify(json, null, indent)}\n`
  }
  writeFileSync(path, next)
}
