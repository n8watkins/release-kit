#!/usr/bin/env node
// Cuts a release: bumps the version everywhere it lives, writes the changelog
// section from the commits, commits "chore(release): vX.Y.Z" and makes an
// annotated tag. Pushing the tag runs .github/workflows/release.yml.
//
//   npm run release -- [patch|minor|major|x.y.z] [--summary "<text>"] [--dry-run] [--push] [--no-check]
//       --summary puts a line or two, in your words, at the top of the notes.
//       --push first checks the branch is up to date with origin and runs
//       npm run release:check (skip it with --no-check), so a tag is only
//       pushed for a commit that passes; if the push fails, the release
//       commit and tag are undone.
//   npm run release -- --plan [auto|patch|minor|major|x.y.z]
//       What the release train would do now, without changing anything:
//       key=value lines for $GITHUB_OUTPUT on stdout, a summary on stderr.
//       With "auto" (the default) it releases only when a feature, fix,
//       performance change or breaking change landed since the last tag.
//   npm run release -- --verify-tag v1.2.3     (CI: the tag matches every version file)
//   npm run release -- --tag-kind v1.2.3       (CI: baseline=true for a --baseline tag)
//   npm run release -- --baseline [commit] [--publish]
//       Tags the version package.json had at that commit (default HEAD). Use it
//       when adopting the kit, so the first release starts from here instead of
//       listing the whole history, and to backfill past milestones. Baseline
//       tags make no GitHub Release unless --publish.
//
// With no bump given, it picks one from the commits: major for a breaking
// change, minor for a feature, otherwise patch.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { RELEASE_TAG, isVersion, nextVersion, planRelease, suggestedBump } from './conventional.mjs'
import { commitsBetween, git, isAncestor, isCommit, previousTag, releaseTags, repoUrl } from './git.mjs'
import { noteStyle, renderNotes } from './notes.mjs'
import { readVersion, setVersion } from './versions.mjs'

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

// Other files that carry the version (an extension manifest, tauri.conf.json,
// a Cargo.toml and its Cargo.lock, a package.json and package-lock.json in a
// subfolder), listed in .release.json as { "versionFiles": ["path/to/file"] }.
// versions.mjs knows how each kind keeps it.
const config = existsSync('.release.json') ? readJson('.release.json') : {}
const versionFiles = config.versionFiles ?? []
// The whole line a baseline tag's message carries, and nothing else does: a
// release tag's message is its changelog section, whose lines are headings
// or "- " items.
const BASELINE_NOTE = 'release-kit baseline: tagged when adopting release-kit; no GitHub Release.'
const BRANCHES = ['main', 'master']

function versions() {
  const found = { 'package.json': readJson('package.json').version }
  for (const path of versionFiles) found[path] = readVersion(path)
  return found
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

/** The value after `--name`, when it isn't another flag. */
function valueOf(name) {
  const at = args.indexOf(`--${name}`)
  const value = at === -1 ? undefined : args[at + 1]
  return value && !value.startsWith('--') ? value : undefined
}

// --- CI: verify a tag ---------------------------------------------------
if (flag('verify-tag')) {
  const tag = valueOf('verify-tag')
  if (!tag || !RELEASE_TAG.test(tag)) fail(`"${tag ?? ''}" is not a release tag; release tags look like v1.2.3`)
  const found = versions()
  const wrong = Object.entries(found).filter(([, v]) => `v${v}` !== tag)
  if (wrong.length) {
    fail(`tag ${tag} does not match: ${wrong.map(([file, v]) => `${file} has ${v}`).join(', ')}`)
  }
  console.log(`release: ${tag} matches ${Object.keys(found).join(', ')}`)
  process.exit(0)
}

// --- CI: is a tag a baseline? ----------------------------------------------
if (flag('tag-kind')) {
  const tag = valueOf('tag-kind')
  if (!tag || !RELEASE_TAG.test(tag)) fail(`"${tag ?? ''}" is not a release tag; release tags look like v1.2.3`)
  const message = git('tag', '--list', '--format=%(contents)', tag).replace(/\r\n?/g, '\n')
  console.log(`baseline=${message.split('\n').some((line) => line.trim() === BASELINE_NOTE)}`)
  process.exit(0)
}

// --- Baseline: tag the version a repo is already at -----------------------
if (flag('baseline')) {
  const ref = valueOf('baseline') ?? 'HEAD'
  if (!isCommit(ref)) fail(`"${ref}" is not a commit`)
  const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`)
  const version = JSON.parse(git('show', `${commit}:package.json`)).version
  if (!isVersion(version)) fail(`package.json at ${ref} has version "${version}", not x.y.z`)
  const tag = `v${version}`
  if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`)
  const publish = flag('publish')
  // The workflow reads this marker and skips publishing.
  const note = publish ? 'Backfilled release.' : BASELINE_NOTE
  git('tag', '-a', tag, commit, '-m', `${tag}\n\n${note}`)
  console.log(`release: tagged ${tag} at ${ref}${publish ? '' : ' as a baseline (no GitHub Release)'}`)
  console.log(`release: push it with  git push origin ${tag}`)
  process.exit(0)
}

// --- What is there to release? --------------------------------------------
// `strict` (the release train) turns every warning into a failure: an
// unattended run should stop rather than guess.
function state({ strict }) {
  const warn = strict ? fail : (message) => console.error(`release: warning: ${message}`)
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
  if (!BRANCHES.includes(branch)) fail(`releases are cut from main or master, not "${branch}"`)
  const current = readJson('package.json').version
  if (!isVersion(current)) fail(`package.json version "${current}" is not x.y.z`)

  const since = previousTag()
  const own = `v${current}`
  if (since !== own) {
    if (releaseTags().includes(own)) {
      // The tag for the current version exists but isn't on this branch: it was moved, or cut elsewhere.
      fail(`tag ${own} exists but is not on ${branch}'s history (was it moved or made on another branch?); fix the tag before releasing`)
    }
    if (!since) {
      warn(`no release tag yet: the first release lists the whole history (run npm run release -- --baseline first to start from here)`)
    } else {
      warn(`package.json is ${current} but the newest release tag on ${branch} is ${since}`)
    }
  }
  return { branch, current, since, commits: commitsBetween(since) }
}

// --- The release train's decision -----------------------------------------
if (flag('plan')) {
  const bump = valueOf('plan') ?? 'auto'
  if (!['auto', 'patch', 'minor', 'major'].includes(bump) && !/^\d+\.\d+\.\d+$/.test(bump)) {
    fail(`unknown bump "${bump}"; use auto, patch, minor, major or x.y.z`)
  }
  const { current, since, commits } = state({ strict: true })
  let plan
  try {
    plan = planRelease({ current, commits, bump })
  } catch (error) {
    fail(error.message)
  }
  const out = { release: plan.release, reason: plan.reason, since, sha: git('rev-parse', 'HEAD'), commits: commits.length }
  if (plan.release) Object.assign(out, { bump: plan.bump, version: plan.version, tag: `v${plan.version}` })
  console.error(`release: ${plan.release ? `${current} -> ${plan.version} (${plan.bump})` : 'nothing to release'}: ${plan.reason} since ${since}`)
  for (const [key, value] of Object.entries(out)) console.log(`${key}=${value}`)
  process.exit(0)
}

// --- Cut a release --------------------------------------------------------
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes; commit or stash them first')
const { branch, current, since, commits } = state({ strict: false })
if (!commits.length) fail(`nothing to release: no commits since ${since}`)

const push = flag('push') && !flag('dry-run')
if (push) {
  // Behind origin, the release would be rejected after it was committed and
  // tagged; find out first.
  try {
    git('fetch', '--quiet', 'origin', `refs/heads/${branch}`)
  } catch (error) {
    fail(`could not fetch origin ${branch}: ${error.stderr?.trim() || error.message}`)
  }
  const remote = git('rev-parse', 'FETCH_HEAD')
  if (remote !== git('rev-parse', 'HEAD') && !isAncestor(remote, 'HEAD')) {
    fail(`${branch} is behind origin/${branch}; pull (git pull --rebase) and try again`)
  }
}

const summary = valueOf('summary')
if (flag('summary') && !summary) fail('--summary needs the text, in quotes: --summary "Dark mode is here."')
// The bump is the one bare argument that isn't --summary's text.
const kind = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--summary') ?? suggestedBump(commits)
let version
try {
  version = nextVersion(current, kind)
} catch (error) {
  fail(error.message)
}
const tag = `v${version}`
if (git('tag', '--list', tag)) fail(`tag ${tag} already exists`)

// The changelog date in .release.json "timeZone" (an IANA name such as
// America/Los_Angeles), or this machine's zone. CI runs in UTC, so a repo
// released by the release train sets it.
let date
try {
  date = new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
} catch {
  fail(`.release.json timeZone "${config.timeZone}" is not a time zone, like America/Los_Angeles`)
}
const section = renderNotes(commits, {
  heading: `## ${version} - ${date}`,
  summary,
  // Pull request numbers link to their PRs; the changelog skips commit hashes.
  repoUrl: repoUrl(),
  commitLinks: false,
  style: noteStyle(config.notes),
})

console.log(`release: ${current} -> ${version} (${kind}), ${commits.length} commit${commits.length === 1 ? '' : 's'} since ${since ?? 'the start'}\n`)
console.log(section)
if (flag('dry-run')) process.exit(0)

if (push && !flag('no-check')) {
  console.log('release: npm run release:check')
  const check = spawnSync('npm', ['run', 'release:check'], { stdio: 'inherit' })
  if (check.status !== 0) fail('release:check failed; nothing was committed or tagged')
}

// package.json and package-lock.json, the way npm does it.
execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { stdio: 'ignore' })
for (const path of versionFiles) setVersion(path, version)

const TITLE = '# Changelog'
const existing = existsSync('CHANGELOG.md') ? readFileSync('CHANGELOG.md', 'utf8').replace(/\r\n?/g, '\n') : `${TITLE}\n`
const rest = existing.startsWith(TITLE) ? existing.slice(TITLE.length).replace(/^\n+/, '') : existing
writeFileSync('CHANGELOG.md', `${TITLE}\n\n${section}\n${rest}`.replace(/\n{3,}/g, '\n\n'))

const files = ['package.json', 'CHANGELOG.md', ...versionFiles]
if (existsSync('package-lock.json')) files.push('package-lock.json')
git('add', '--', ...files)
git('commit', '-m', `chore(release): ${tag}`)
// Verbatim: git would otherwise drop the notes' headings as # comments.
git('tag', '-a', '--cleanup=verbatim', tag, '-m', `${tag}\n\n${section}`)
console.log(`release: committed and tagged ${tag}`)

if (push) {
  // One atomic push: the branch and the tag land together or not at all.
  try {
    git('push', '--atomic', 'origin', branch, `refs/tags/${tag}`)
  } catch (error) {
    // Nothing reached origin: undo the release commit and tag, so a rerun starts clean.
    git('tag', '--delete', tag)
    git('reset', '--hard', 'HEAD~1')
    fail(`the push was rejected, so the release commit and ${tag} were undone:\n${error.stderr?.trim() || error.message}`)
  }
  console.log(`release: pushed ${tag}; the Release workflow publishes it`)
} else {
  console.log(`release: push with  git push --atomic origin ${branch} ${tag}`)
}
