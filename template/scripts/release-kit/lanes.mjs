#!/usr/bin/env node
// Which CI lane a change needs, so a pull request that only edits docs or only
// moves the release-kit pin skips the expensive checks.
//
//   node scripts/release-kit/lanes.mjs --event pull_request --base <sha> --head <sha>
//
// Prints key=value lines for $GITHUB_OUTPUT:
//   lane    docs | kit | deps | full: the most demanding lane any changed file needs
//   docs    true when only docs changed
//   kit     true when a kit-owned file changed: run `release-kit verify`
//   checks  true for deps and full: install, lint, types, unit tests, build
//   full    true for full: everything, including E2E and OS matrices
//   ci      true when a workflow or other CI file the kit doesn't own changed
//
// It fails toward running everything: a push, a manual or scheduled run, a
// missing base, an unknown file or any error is "full". The lanes:
//   docs  Markdown, docs/, LICENSE, issue and pull request templates, and the
//         .release.json "lanes.docs" globs
//   kit   only the release-kit dev dependency (package.json and its lock
//         entries), the kit's own workflows, hook and .release.json settings,
//         and .github/dependabot.yml
//   deps  only devDependencies (package.json and lock entries npm marks
//         "dev"), and none listed in .release.json "lanes.fullFor"
//   full  anything else
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { isMain } from './git.mjs'

export const LANES = ['docs', 'kit', 'deps', 'full']
const rank = (lane) => LANES.indexOf(lane)
const KIT_WORKFLOWS = ['commits.yml', 'release.yml', 'release-train.yml', 'security.yml']
const KIT_FILES = ['.github/dependabot.yml', '.githooks/commit-msg', '.husky/commit-msg', '.githooks/pre-push', '.husky/pre-push']
const DOCS = ['**/*.md', '**/*.mdx', 'docs/**', 'LICENSE', 'LICENSE.*', '.github/ISSUE_TEMPLATE/**', '.github/PULL_REQUEST_TEMPLATE*', '.github/pull_request_template.md']

/** A glob ("**" any depth, "*" within a path segment) as a RegExp. */
export function globToRegExp(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i++
      if (glob[i + 1] === '/') {
        i++
        out += '(?:.*/)?'
      } else out += '.*'
    } else if (c === '*') out += '[^/]*'
    else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

const json = (text) => {
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const without = (object, ...keys) => Object.fromEntries(Object.entries(object ?? {}).filter(([k]) => !keys.includes(k)))
/** Keys whose values differ between two objects. */
const changedKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => !same(a?.[k], b?.[k]))
const packageName = (lockPath) => lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length)

/** package.json: which lane a change to it needs. */
function packageJsonLane(base, head, { root, fullFor }) {
  const [a, b] = [json(base), json(head)]
  if (!a || !b) return { lane: 'full', why: 'added, removed or not valid JSON' }
  const outside = changedKeys(without(a, 'devDependencies'), without(b, 'devDependencies'))
  if (outside.length) return { lane: 'full', why: `changes ${outside.join(', ')}` }
  const dev = changedKeys(a.devDependencies, b.devDependencies)
  if (!dev.length) return { lane: 'docs', why: 'formatting only' }
  if (root && same(dev, ['release-kit'])) return { lane: 'kit', why: 'the release-kit dev dependency' }
  const forced = dev.filter((name) => fullFor.includes(name))
  if (forced.length) return { lane: 'full', why: `${forced.join(', ')} (lanes.fullFor)` }
  return { lane: 'deps', why: `devDependencies: ${dev.join(', ')}` }
}

/** package-lock.json: which lane a change to it needs, from the packages npm marks "dev". */
function lockLane(base, head, { root, fullFor }) {
  const [a, b] = [json(base), json(head)]
  if (!a?.packages || !b?.packages) return { lane: 'full', why: 'added, removed, or not a lockfileVersion 2+ lock' }
  const outside = changedKeys(without(a, 'packages'), without(b, 'packages'))
  if (outside.length) return { lane: 'full', why: `changes ${outside.join(', ')}` }
  const rootEntry = changedKeys(without(a.packages[''], 'devDependencies'), without(b.packages[''], 'devDependencies'))
  if (rootEntry.length) return { lane: 'full', why: `the root entry's ${rootEntry.join(', ')}` }
  const changed = changedKeys(without(a.packages, ''), without(b.packages, ''))
  const devRoot = changedKeys(a.packages['']?.devDependencies, b.packages['']?.devDependencies)
  const names = [...new Set([...changed.map(packageName), ...devRoot])]
  if (!names.length) return { lane: 'docs', why: 'formatting only' }
  // npm marks dev-only packages "dev": true; anything else (prod, optional, peer) ships.
  const ships = (entry) => entry !== undefined && entry.dev !== true
  const prod = changed.filter((path) => ships(a.packages[path]) || ships(b.packages[path]))
  if (prod.length) return { lane: 'full', why: `non-dev packages: ${prod.map(packageName).join(', ')}` }
  if (root && same(names, ['release-kit'])) return { lane: 'kit', why: 'the release-kit dev dependency' }
  const forced = names.filter((name) => fullFor.includes(name))
  if (forced.length) return { lane: 'full', why: `${forced.join(', ')} (lanes.fullFor)` }
  return { lane: 'deps', why: `dev packages: ${names.join(', ')}` }
}

/** .release.json: kit settings, except the lanes config, which changes this classifier. */
function releaseJsonLane(base, head) {
  const [a, b] = [json(base) ?? {}, json(head) ?? {}]
  if (json(head) === undefined) return { lane: 'full', why: 'not valid JSON' }
  if (!same(a.lanes, b.lanes)) return { lane: 'full', why: 'the lanes settings changed' }
  return { lane: 'kit', why: 'release-kit settings' }
}

/**
 * Classifies one changed file. `file` is { path, base, head }: the contents
 * before and after (null when the file didn't exist), read only for the
 * files whose lane depends on what changed in them.
 */
export function classifyFile(file, config = {}) {
  const { path } = file
  const fullFor = config.lanes?.fullFor ?? []
  const docs = [...DOCS, ...(config.lanes?.docs ?? [])]
  const name = path.split('/').pop()
  if (path === '.release.json') return { ...releaseJsonLane(file.base, file.head), ci: false }
  if (name === 'package.json') return { ...packageJsonLane(file.base, file.head, { root: path === name, fullFor }), ci: false }
  if (name === 'package-lock.json') return { ...lockLane(file.base, file.head, { root: path === name, fullFor }), ci: false }
  if (KIT_FILES.includes(path)) return { lane: 'kit', why: 'a kit-owned file', ci: false }
  if (path.startsWith('.github/workflows/')) {
    const workflow = path.slice('.github/workflows/'.length)
    // The kit's own workflows start with its marker; a repo's ci.yml doesn't.
    const owned = (text) => text === null || /^# release-kit\b/.test(text)
    if (KIT_WORKFLOWS.includes(workflow) && owned(file.base) && owned(file.head) && (file.base ?? file.head) !== null) {
      return { lane: 'kit', why: 'a kit-owned workflow', ci: false }
    }
    return { lane: 'full', why: 'a workflow the kit does not own', ci: true }
  }
  if (path.startsWith('.github/actions/') || path === '.github/CODEOWNERS' || name === 'action.yml' || name === 'action.yaml') {
    return { lane: 'full', why: 'CI configuration', ci: true }
  }
  if (docs.some((glob) => globToRegExp(glob).test(path))) return { lane: 'docs', why: 'docs', ci: false }
  return { lane: 'full', why: 'not docs, a kit file or a dev dependency', ci: false }
}

/** The lane flags for a set of changed files (see the header). */
export function classify(files, config = {}) {
  const reasons = files.map((file) => ({ path: file.path, ...classifyFile(file, config) }))
  // No files (an empty diff) proves nothing: run everything.
  const lane = reasons.length ? LANES[Math.max(...reasons.map((r) => rank(r.lane)))] : 'full'
  return flags(lane, { kit: reasons.some((r) => r.lane === 'kit'), ci: reasons.some((r) => r.ci), reasons })
}

export function flags(lane, { kit = lane === 'kit', ci = false, reasons = [] } = {}) {
  return { lane, docs: lane === 'docs', kit: kit || lane === 'kit', checks: rank(lane) >= rank('deps'), full: lane === 'full', ci, reasons }
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (name) => {
    const at = args.indexOf(`--${name}`)
    return at === -1 ? '' : (args[at + 1] ?? '')
  }
  const event = valueOf('event')
  const base = valueOf('base')
  const head = valueOf('head') || 'HEAD'
  const git = (...gitArgs) => execFileSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 1024 ** 3, stdio: ['ignore', 'pipe', 'pipe'] })
  const show = (ref, path) => {
    try {
      return git('show', `${ref}:${path}`)
    } catch {
      return null
    }
  }
  let result
  let why
  if (!['pull_request', 'pull_request_target', 'merge_group'].includes(event)) {
    result = flags('full')
    why = `a ${event || 'local'} run checks everything`
  } else {
    try {
      if (!/^[0-9a-f]{7,40}$/.test(base)) throw new Error(`no base commit ("${base}")`)
      const from = git('merge-base', '--end-of-options', base, head).trim()
      const paths = git('diff', '--name-only', '--no-renames', '-z', from, head, '--').split('\0').filter(Boolean)
      const config = json(show(head, '.release.json')) ?? {}
      const files = paths.map((path) => ({
        path,
        base: show(from, path),
        head: show(head, path),
      }))
      result = classify(files, config)
      why = `${paths.length} changed file${paths.length === 1 ? '' : 's'}`
    } catch (error) {
      result = flags('full')
      why = `could not classify the change (${error.message.split('\n')[0]}), so everything runs`
    }
  }
  const { reasons, ...out } = result
  for (const [key, value] of Object.entries(out)) console.log(`${key}=${value}`)
  const lines = [`lanes: ${out.lane} (${why})`, ...reasons.map((r) => `  ${r.lane.padEnd(4)} ${r.path}: ${r.why}`)]
  console.error(lines.join('\n'))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### CI lane: ${out.lane}\n\n${why}.\n\n${reasons.map((r) => `- \`${r.path}\`: ${r.lane}, ${r.why}`).join('\n')}\n`)
  }
}

if (isMain(import.meta.url)) main()
