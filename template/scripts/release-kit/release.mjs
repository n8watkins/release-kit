#!/usr/bin/env node
// Cuts a release: bumps the version everywhere it lives, writes the changelog
// section from the commits, commits "chore(release): vX.Y.Z" and makes an
// annotated tag. Pushing the tag runs .github/workflows/release.yml.
//
//   npm run release -- [patch|minor|major|x.y.z] [--dry-run] [--push]
//   npm run release -- --verify-tag v1.2.3     (CI: the tag matches every version file)
//   npm run release -- --baseline [commit] [--publish]
//       Tags the version package.json had at that commit (default HEAD). Use it
//       when adopting the kit, so the first release starts from here instead of
//       listing the whole history, and to backfill past milestones. Baseline
//       tags make no GitHub Release unless --publish.
//
// With no bump given, it picks one from the commits: major for a breaking
// change, minor for a feature, otherwise patch.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { nextVersion, suggestedBump } from './conventional.mjs'
import { commitsBetween, git, previousTag } from './git.mjs'
import { renderNotes } from './notes.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// Other files that carry the version (an extension manifest, tauri.conf.json),
// listed in .release.json as { "versionFiles": ["path/to/file.json"] }.
const config = existsSync('.release.json') ? readJson('.release.json') : {}
const versionFiles = config.versionFiles ?? []
const BASELINE_MARKER = 'release-kit baseline'

function versions() {
  const found = { 'package.json': readJson('package.json').version }
  for (const path of versionFiles) found[path] = readJson(path).version
  return found
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

// --- CI: verify a tag ---------------------------------------------------
const verifyAt = args.indexOf('--verify-tag')
if (verifyAt !== -1) {
  const tag = args[verifyAt + 1]
  const found = versions()
  const wrong = Object.entries(found).filter(([, v]) => `v${v}` !== tag)
  if (wrong.length) {
    fail(`tag ${tag} does not match: ${wrong.map(([file, v]) => `${file} has ${v}`).join(', ')}`)
  }
  console.log(`release: ${tag} matches ${Object.keys(found).join(', ')}`)
  process.exit(0)
}

// --- Baseline: tag the version a repo is already at -----------------------
const baselineAt = args.indexOf('--baseline')
if (baselineAt !== -1) {
  const ref = args[baselineAt + 1] && !args[baselineAt + 1].startsWith('--') ? args[baselineAt + 1] : 'HEAD'
  const version = JSON.parse(git('show', `${ref}:package.json`)).version
  const tag = `v${version}`
  if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`)
  const publish = flag('publish')
  // The workflow reads this marker and skips publishing.
  const note = publish ? 'Backfilled release.' : `${BASELINE_MARKER}: tagged when adopting release-kit; no GitHub Release.`
  git('tag', '-a', tag, git('rev-parse', ref), '-m', `${tag}\n\n${note}`)
  console.log(`release: tagged ${tag} at ${ref}${publish ? '' : ' as a baseline (no GitHub Release)'}`)
  console.log(`release: push it with  git push origin ${tag}`)
  process.exit(0)
}

// --- Cut a release --------------------------------------------------------
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes; commit or stash them first')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (!['main', 'master'].includes(branch)) fail(`releases are cut from main or master, not "${branch}"`)

const current = readJson('package.json').version
const since = previousTag()
const commits = commitsBetween(since)
if (!commits.length) fail(`nothing to release: no commits since ${since}`)

const kind = args.find((a) => !a.startsWith('--')) ?? suggestedBump(commits)
const version = nextVersion(current, kind)
const tag = `v${version}`
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`)

const date = new Date().toISOString().slice(0, 10)
const section = renderNotes(commits, { heading: `## ${version} - ${date}` })

console.log(`release: ${current} -> ${version} (${kind}), ${commits.length} commits since ${since ?? 'the start'}\n`)
console.log(section)
if (flag('dry-run')) process.exit(0)

// package.json and package-lock.json, the way npm does it.
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'ignore' })
for (const path of versionFiles) {
  const json = readJson(path)
  json.version = version
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
}

const TITLE = '# Changelog'
const existing = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8') : `${TITLE}\n`
const rest = existing.startsWith(TITLE) ? existing.slice(TITLE.length).replace(/^\n+/, '') : existing
writeFileSync('CHANGELOG.md', `${TITLE}\n\n${section}\n${rest}`.replace(/\n{3,}/g, '\n\n'))

const files = ['package.json', 'CHANGELOG.md', ...versionFiles]
if (existsSync('package-lock.json')) files.push('package-lock.json')
git('add', ...files)
git('commit', '-m', `chore(release): ${tag}`)
git('tag', '-a', tag, '-m', `${tag}\n\n${section}`)
console.log(`release: committed and tagged ${tag}`)

if (flag('push')) {
  git('push', 'origin', branch)
  git('push', 'origin', tag)
  console.log(`release: pushed ${tag}; the Release workflow publishes it`)
} else {
  console.log(`release: push with  git push origin ${branch} && git push origin ${tag}`)
}
