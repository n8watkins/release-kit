#!/usr/bin/env node
// The kit's one command, for a repo that installs release-kit as a dev
// dependency (apply.mjs's default "package" mode):
//
//   release-kit release [...]     cut a release (npm run release)
//   release-kit commit-msg <file> check a commit message (the commit-msg hook)
//   release-kit notes [...]       print release notes for a range
//   release-kit releases --check  check releases.json against its schema
//   release-kit backfill [...]    releases.json entries (and missing GitHub Release
//                                 notes) for older tags; a dry run unless --write
//   release-kit train [...]       the release train's last step (CI)
//   release-kit protect [...]     branch and tag rulesets for the release flow
//                                 (and the train's deploy key); in a private repo
//                                 on GitHub Free, the free safeguards instead
//   release-kit pre-push          the pre-push guard (the pre-push hook)
//   release-kit install-guard [<repo>]
//                                 the pre-push guard in one clone of a repo
//                                 that doesn't use the kit
//   release-kit alarm [...]       the Direct push alarm (CI)
//   release-kit check             warn when this kit is behind the newest release,
//                                 the files differ from what apply writes, or the
//                                 repo's rulesets drifted from protect's
//   release-kit verify            the fast check a kit-only update runs: the kit
//                                 installs, every pin agrees, the workflows lint,
//                                 and the notes render (fails on any problem); it
//                                 also warns when the files differ from what apply
//                                 writes (never fails on that)
//   release-kit lanes [...]       which CI lane a change needs (lanes.mjs)
//   release-kit apply <repo> [...] apply or upgrade the kit in a repo
//   release-kit <repo> [...]      the same as apply
//
// Each runs in the current directory, which should be the repo's root.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { protectionWarnings } from '../template/scripts/release-kit/protect.mjs'
import { detectVisibility } from '../template/scripts/release-kit/settings.mjs'

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(KIT, 'template', 'scripts', 'release-kit')
const kitPackage = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'))
const KIT_REPO = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(kitPackage.repository?.url ?? '')?.[1] ?? 'n8watkins/release-kit'
const SCRIPT_COMMANDS = new Set(['release', 'commit-msg', 'notes', 'releases', 'backfill', 'train', 'protect', 'lanes', 'alarm'])

const [command, ...rest] = process.argv.slice(2)

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const parse = (v) => v.replace(/^v/, '').split('.').map(Number)
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Warns (never fails) when the installed kit is behind its newest release, or the workflows pin another version. */
function check() {
  const installed = kitPackage.version
  const warnings = []
  if (!process.env.RELEASE_KIT_OFFLINE) {
    const out = spawnSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${KIT_REPO}.git`, 'v*'], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const tags = out.status === 0 ? out.stdout.split('\n').map((l) => l.split('refs/tags/')[1]).filter((t) => /^v\d+\.\d+\.\d+$/.test(t ?? '')) : []
    const latest = tags.reduce((best, t) => (!best || newer(t, best) ? t : best), null)
    if (latest && newer(latest, installed)) {
      warnings.push(`release-kit ${installed} is installed, but ${latest} is out: npm install -D "release-kit@github:${KIT_REPO}#${latest}" (Dependabot opens this update on its own)`)
    }
  }
  warnings.push(...pinMismatches(installed))
  warnings.push(...branchGaps())
  warnings.push(...staleFiles())
  warnings.push(...applyDrift())
  const config = existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')) : {}
  warnings.push(...visibilityGaps(config))
  // The rulesets, or in a private repo on GitHub Free the free safeguards, when
  // gh can read them (it can't in CI without a token: then nothing is said).
  if (!process.env.RELEASE_KIT_OFFLINE) {
    warnings.push(...protectionWarnings({ repo: typeof config.repository === 'string' ? config.repository : undefined }))
  }
  for (const w of warnings) console.warn(`release-kit: ${w}`)
  if (!warnings.length) console.log(`release-kit ${installed}: up to date`)
}

/** .release.json "visibility" against GitHub, and what a private repo is missing to keep its minutes down. */
function visibilityGaps(config) {
  const out = []
  const live = typeof config.repository === 'string' ? detectVisibility(config.repository, { timeout: 8000 }) : null
  if (live && live !== config.visibility) out.push(`${config.repository} is ${live} on GitHub, but .release.json says ${config.visibility ?? 'nothing'}: rerun npx release-kit apply . to switch to the ${live} defaults`)
  const dir = '.github/workflows'
  if ((live ?? config.visibility) === 'private' && existsSync(dir)) {
    const texts = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8'))
    if (!texts.some((t) => /\/\.github\/workflows\/changes\.yml@/.test(t))) out.push('a private repo pays for runner minutes, and its CI runs in full for a kit-only update: adopt the CI lanes (docs/CI_LANES.md in release-kit) so those take the one-minute kit lane')
  }
  return out
}

/** Workflows that call the kit at another version than the one installed. */
function pinMismatches(installed) {
  const out = []
  const dir = '.github/workflows'
  if (!existsSync(dir)) return out
  const pin = new RegExp(`${KIT_REPO.replace('/', '\\/')}\\/\\.github\\/workflows\\/[\\w.-]+@(v\\d+\\.\\d+\\.\\d+)`)
  for (const file of readdirSync(dir).sort()) {
    const found = pin.exec(readFileSync(join(dir, file), 'utf8'))?.[1]
    if (found && found !== `v${installed}`) out.push(`${dir}/${file} calls release-kit ${found}, but ${installed} is installed: rerun npx release-kit apply . to line them up`)
  }
  return out
}

/**
 * Files an older apply wrote that miss a fix a rerun of apply brings. A
 * workflow counts only when apply owns it, by apply's own rule: it starts with
 * a "# release-kit" comment. A repo's own release.yml (a Tauri build, say)
 * that only mentions the kit is the repo's, and apply never touches it.
 */
function staleFiles() {
  const out = []
  for (const name of ['release.yml', 'release-train.yml']) {
    const path = `.github/workflows/${name}`
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    if (text.startsWith('# release-kit') && !text.includes('# release-kit: fork guard')) out.push(`${path} has no fork guard, so a fork that pushes a tag publishes a release: rerun npx release-kit apply .`)
  }
  const dependabot = '.github/dependabot.yml'
  if (existsSync(dependabot)) {
    const text = readFileSync(dependabot, 'utf8')
    const kits = text.startsWith('# release-kit:')
    const entries = (text.split(/^updates:$/m)[1] ?? '').split(/\n(?=\s*-\s*package-ecosystem:)/)
    if (kits && !/cooldown:\s*\n\s*exclude:[^\n]*release-kit/.test(text)) out.push(`${dependabot} lets Dependabot's cooldown propose older kit versions (a downgrade): rerun npx release-kit apply .`)
    // Kit 2.3.0 to 2.3.2 put commit-message on the grouped updates, which Dependabot rejects.
    if (kits && entries.some((e) => /^ {4}multi-ecosystem-group:/m.test(e) && /^ {4}commit-message:/m.test(e))) out.push(`${dependabot} is rejected by Dependabot (commit-message belongs on the multi-ecosystem group), so no kit updates arrive: rerun npx release-kit apply .`)
    // Kit 2.0.0 to 2.7.0 allowed only the kit, which Dependabot also applies to security updates.
    if (kits && /^[ \t]+-?[ \t]*allow:/m.test(text)) out.push(`${dependabot} allows only the kit, so Dependabot opens no security updates and no updates for any other dependency: rerun npx release-kit apply .`)
  }
  return out
}

/**
 * The files `apply --check` says this kit version would add, change or remove:
 * one warning, or none when the repo has what apply writes. Files apply leaves
 * alone (a repo's own workflow, dependabot.yml or hooks) never count, since
 * apply doesn't write them.
 */
function applyDrift() {
  if (!existsSync('package.json')) return []
  const out = spawnSync(process.execPath, [join(KIT, 'apply.mjs'), '.', '--check', '--json'], { encoding: 'utf8', timeout: 60000 })
  let report
  try {
    report = JSON.parse(out.stdout)
  } catch {
    return [`could not compare the files with what apply writes: ${(out.stderr || out.stdout || String(out.error ?? '')).trim().split('\n')[0]}`]
  }
  const files = Object.entries(report.files).flatMap(([kind, paths]) => paths.map((p) => `${kind} ${p}`))
  if (!files.length) return []
  return [`release-kit v${report.version} adds or changes ${files.length} file${files.length === 1 ? '' : 's'}; run npx release-kit apply . (${files.join(', ')})`]
}

/** Branches releases are cut from (.release.json "branches") whose pushes commits.yml doesn't check. */
function branchGaps() {
  const commits = '.github/workflows/commits.yml'
  const branches = existsSync('.release.json') ? JSON.parse(readFileSync('.release.json', 'utf8')).branches : undefined
  if (!Array.isArray(branches) || !existsSync(commits)) return []
  const line = /^ {4}branches: \[(.*)\]$/m.exec(readFileSync(commits, 'utf8'))?.[1]
  if (line === undefined) return []
  const pushed = line.split(',').map((b) => b.trim().replace(/^'(.*)'$/, '$1').replaceAll("''", "'").replace(/\\(.)/g, '$1'))
  const missing = branches.filter((b) => typeof b === 'string' && !pushed.includes(b))
  return missing.length ? [`${commits} doesn't check pushes to ${missing.join(', ')}, a branch releases are cut from: rerun npx release-kit apply . to add it`] : []
}

/**
 * The fast check for a pull request that only updates the kit: everything
 * the update could break, without the repo's own build and tests.
 */
function verify() {
  const installed = kitPackage.version
  const results = []
  const step = (name, problems, detail = '') => results.push({ name, problems, detail })
  const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)

  // 1. The kit installs: package.json, the lock and node_modules agree, and npm 12 may fetch it.
  const install = []
  const spec = readJson('package.json')?.devDependencies?.['release-kit']
  const ref = /#(.+)$/.exec(spec ?? '')?.[1]
  if (!spec) install.push('package.json has no release-kit dev dependency (package mode)')
  else if (/^v\d+\.\d+\.\d+$/.test(ref ?? '') && ref !== `v${installed}`) install.push(`package.json pins release-kit ${ref}, but ${installed} is installed: run npm install`)
  const locked = readJson('package-lock.json')?.packages?.['node_modules/release-kit']
  if (spec && !locked) install.push('package-lock.json has no release-kit entry: run npm install and commit the lock')
  else if (locked && locked.version !== installed) install.push(`package-lock.json has release-kit ${locked.version}, but ${installed} is installed: run npm install and commit the lock`)
  else if (locked && /^[0-9a-f]{40}$/.test(ref ?? '') && !String(locked.resolved).endsWith(`#${ref}`)) install.push(`package-lock.json resolves release-kit to ${locked.resolved}, not ${ref}`)
  const npmrc = existsSync('.npmrc') ? readFileSync('.npmrc', 'utf8') : ''
  if (spec && !/^[ \t]*allow-git[ \t]*=[ \t]*(root|all)[ \t]*$/m.test(npmrc)) install.push('.npmrc does not allow git dependencies, so npm 12 refuses to install the kit: rerun npx release-kit apply .')
  step('install', install, `release-kit ${installed}`)

  // 2. Every workflow pins the version that is installed.
  step('pins', pinMismatches(installed))

  // 3. The workflows lint, when actionlint is installed.
  // ACTIONLINT names another binary (tests use it).
  const lint = spawnSync(process.env.ACTIONLINT || 'actionlint', ['-ignore', 'property "workflow_(repository|sha)" is not defined'], { encoding: 'utf8' })
  if (lint.error) step('workflows', [], `skipped: actionlint is not installed (${lint.error.code})`)
  else step('workflows', lint.status === 0 ? [] : [`actionlint:\n${`${lint.stdout}${lint.stderr}`.trim()}`], 'actionlint')

  // 4. The release scripts load and render the notes since the last release.
  const notes = spawnSync(process.execPath, [join(SCRIPTS, 'notes.mjs')], { encoding: 'utf8' })
  step('notes', notes.status === 0 ? [] : [`notes failed:\n${(notes.stderr || notes.stdout).trim()}`], 'notes since the last release render')

  let failed = false
  for (const { name, problems, detail } of results) {
    if (problems.length) {
      failed = true
      for (const problem of problems) console.error(`release-kit verify: ${name}: ${problem}`)
    } else console.log(`release-kit verify: ${name} ok${detail ? ` (${detail})` : ''}`)
  }

  // 5. The files match what apply writes at this version. A warning, never a
  // failure: a Dependabot kit update moves only the version, and must still
  // merge (the merge-when-green fallback waits for every check to pass). The
  // rollout bot's pull request, or a rerun of apply, brings the files.
  const drift = applyDrift()
  if (!drift.length) console.log('release-kit verify: files ok (every file apply writes is up to date)')
  for (const warning of drift) {
    console.warn(`release-kit verify: files: warning: ${warning}`)
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::warning title=release-kit files are behind::${warning.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### release-kit files are behind\n\n${warning}\n\nThis check passes anyway; the rollout bot's pull request, or running \`npx release-kit apply .\` and committing the result, clears it.\n`)
  }
  process.exit(failed ? 1 : 0)
}

if (command === 'check') check()
else if (command === 'verify') verify()
else if (command === 'pre-push') run(join(SCRIPTS, 'guard.mjs'), rest)
else if (command === 'install-guard') run(join(SCRIPTS, 'guard.mjs'), ['--install', ...rest])
else if (SCRIPT_COMMANDS.has(command)) run(join(SCRIPTS, `${command}.mjs`), rest)
else if (command === 'apply') run(join(KIT, 'apply.mjs'), rest)
else if (command && !command.startsWith('-')) run(join(KIT, 'apply.mjs'), [command, ...rest])
else {
  console.error(`release-kit ${kitPackage.version}: release | commit-msg | notes | releases | backfill | train | protect | check | verify | lanes | pre-push | install-guard | alarm | apply <repo>`)
  process.exit(command ? 1 : 0)
}
