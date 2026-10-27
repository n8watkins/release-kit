#!/usr/bin/env node
// Applies the release kit to a repo (or updates it to this kit version).
//
//   node apply.mjs <path/to/repo> [options]
//
//   --train              also add the release train: a scheduled workflow that
//                        cuts a release when user-facing work has landed
//   --schedule "<cron>"  when the train runs (UTC; default "0 16 * * 1", Mondays 16:00)
//   --train-checks <a.yml,b.yml>
//                        workflows the train runs on its release commit before
//                        pushing it to main: the ones branch protection requires
//   --no-train           remove the release train
//   --reusable           workflows call one pinned copy in the release-kit repo
//                        instead of carrying the steps themselves
//   --vendored           workflows carry the steps (the default)
//   --kit-ref <ref>      the release-kit tag or commit --reusable pins (default vX.Y.Z of this kit)
//   --force              replace workflows with the same name the kit didn't write
//
// The choices are saved in .release.json, so re-running with no options keeps
// them. Kit-owned files (scripts/release-kit/, the workflows, the hook,
// RELEASING.md) are overwritten on every run, so re-running upgrades a repo.
// package.json scripts and agent instructions are merged, never replaced.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readVersion } from './template/scripts/release-kit/versions.mjs'

const KIT = dirname(fileURLToPath(import.meta.url))
const kitPackage = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'))
const KIT_VERSION = kitPackage.version
const KIT_REPO = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(kitPackage.repository?.url ?? '')?.[1] ?? 'n8watkins/release-kit'
const TEMPLATE = join(KIT, 'template')
const REUSABLE = join(KIT, 'reusable')
const MARKER = 'release-kit'
const DEFAULT_SCHEDULE = '0 16 * * 1'
const SCHEDULE_LINE = /- cron: "[^"\n]*" # release-kit: schedule/

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
function valueOf(name) {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) usage(`--${name} needs a value`)
  return value
}
function usage(problem) {
  if (problem) console.error(`apply: ${problem}`)
  console.error('usage: node apply.mjs <path/to/repo> [--train] [--schedule "<cron>"] [--train-checks <a.yml,b.yml>] [--no-train] [--reusable | --vendored] [--kit-ref <ref>] [--force]')
  process.exit(1)
}

const valued = new Set(['--schedule', '--kit-ref', '--train-checks'])
const repo = argv.find((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
if (!repo || !existsSync(join(repo, 'package.json'))) usage('the repo needs a package.json')
const force = has('force')
if (has('reusable') && has('vendored')) usage('pick one of --reusable and --vendored')
if (has('train') && has('no-train')) usage('pick one of --train and --no-train')
const schedule = valueOf('schedule')
const trainChecks = valueOf('train-checks')?.split(',').map((s) => s.trim()).filter(Boolean)
if (trainChecks?.some((file) => !/^[\w.-]+\.ya?ml$/.test(file))) usage(`--train-checks takes workflow file names, like ci.yml,commits.yml`)
if (trainChecks && has('no-train')) usage('--train-checks turns the train on; drop --no-train')
if (schedule !== undefined && has('no-train')) usage('--schedule turns the train on; drop --no-train')
// Five cron fields, nothing that could break out of the YAML string.
if (schedule !== undefined && !/^[\d*/,A-Za-z-]+( [\d*/,A-Za-z-]+){4}$/.test(schedule)) usage(`"${schedule}" is not a five-field cron schedule`)
const kitRef = valueOf('kit-ref') ?? `v${KIT_VERSION}`
if (!/^[\w./-]+$/.test(kitRef)) usage(`"${kitRef}" is not a tag, branch or commit`)

const done = []
const skipped = []
const read = (p) => readFileSync(join(repo, p), 'utf8')
const write = (p, content) => {
  mkdirSync(dirname(join(repo, p)), { recursive: true })
  writeFileSync(join(repo, p), content)
}

// 0. The repo's choices, saved in .release.json.
const hadConfig = existsSync(join(repo, '.release.json'))
const config = hadConfig ? JSON.parse(read('.release.json')) : {}
if (has('reusable')) config.workflows = 'reusable'
if (has('vendored')) delete config.workflows
if (has('no-train')) delete config.train
else if (has('train') || schedule !== undefined || trainChecks) {
  config.train = { ...config.train, schedule: schedule ?? config.train?.schedule ?? DEFAULT_SCHEDULE }
  if (trainChecks) config.train.checks = trainChecks
}
const reusable = config.workflows === 'reusable'
const train = config.train ? { schedule: config.train.schedule ?? DEFAULT_SCHEDULE, checks: config.train.checks ?? [] } : null

// Files that also carry the version, detected on the first run.
if (!hadConfig) {
  // A Tauri app keeps it in tauri.conf.json, Cargo.toml and Cargo.lock too;
  // one in a subfolder (app/) has its own package.json and lock there as well.
  const tauri = ['src-tauri', 'app/src-tauri'].flatMap((dir) => ['tauri.conf.json', 'Cargo.toml', 'Cargo.lock'].map((f) => `${dir}/${f}`))
  // A browser extension's manifest.json, at the root or in the folder it is
  // loaded from; a website's web-app manifest (no manifest_version) isn't one.
  const manifests = ['manifest.json', 'src/manifest.json', 'public/manifest.json', 'extension/manifest.json']
  const candidates = [...manifests, ...tauri, 'app/package.json', 'app/package-lock.json']
  config.versionFiles = candidates.filter((p) => {
    // A subfolder's package files count only beside a Tauri app there.
    if (p.startsWith('app/package') && !existsSync(join(repo, 'app/src-tauri/tauri.conf.json'))) return false
    try {
      if (manifests.includes(p) && !('manifest_version' in JSON.parse(read(p)))) return false
      return typeof readVersion(join(repo, p)) === 'string'
    } catch {
      return false
    }
  })
  done.push(`.release.json (versionFiles: ${config.versionFiles.join(', ') || 'none'})`)
}
config.versionFiles ??= []
// Every version file must say what package.json says, or the first tag check fails.
const pkgVersion = JSON.parse(read('package.json')).version
for (const p of config.versionFiles) {
  let found
  try {
    found = readVersion(join(repo, p))
  } catch (error) {
    skipped.push(`${p}: ${error.message}`)
    continue
  }
  if (found !== pkgVersion) skipped.push(`${p} has version ${found} but package.json has ${pkgVersion}: make them match before the first release, or the tag check fails`)
}
const { versionFiles, ...choices } = config
write('.release.json', `${JSON.stringify({ versionFiles, ...choices }, null, 2)}\n`)

// 1. Kit-owned files.
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}
const ownedByKit = (path) => existsSync(join(repo, path)) && read(path).includes(MARKER)
function writeWorkflow(path, content) {
  if (existsSync(join(repo, path)) && !ownedByKit(path) && !force) {
    skipped.push(`${path} exists and isn't from the kit (rerun with --force to replace it)`)
    return
  }
  write(path, content)
  done.push(path)
}

const usesHusky = existsSync(join(repo, '.husky'))
const pkg = JSON.parse(read('package.json'))
const hookManager = usesHusky ? null : otherHooks()
for (const source of walk(TEMPLATE)) {
  const path = relative(TEMPLATE, source)
  if (path === 'AGENTS.release.md') continue
  // A husky repo gets the hook in .husky/ instead (below); a repo with
  // another hook manager wires it in itself.
  if ((usesHusky || hookManager) && path.startsWith('.githooks/')) continue
  if (path.startsWith('.github/workflows/')) {
    const name = path.slice('.github/workflows/'.length)
    if (name === 'release-train.yml' && !train) {
      if (ownedByKit(path)) {
        rmSync(join(repo, path))
        done.push(`${path} removed (no release train)`)
      }
      continue
    }
    let content = reusable
      ? readFileSync(join(REUSABLE, name), 'utf8')
        .replaceAll('KIT_REPO', KIT_REPO)
        .replaceAll('@KIT_REF', /^[0-9a-f]{40}$/.test(kitRef) ? `@${kitRef} # release-kit ${KIT_VERSION}` : `@${kitRef}`)
      : readFileSync(source, 'utf8')
    if (train) content = content.replace(SCHEDULE_LINE, `- cron: "${train.schedule}" # release-kit: schedule`)
    writeWorkflow(path, content)
    continue
  }
  const target = join(repo, path)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  if (path.startsWith('.githooks/')) chmodSync(target, 0o755)
  done.push(path)
}
write('scripts/release-kit/VERSION', `${KIT_VERSION}\n`)
if (reusable) done.push(`workflows call ${KIT_REPO}@${kitRef}`)

// The workflows use npm ci and npm caching, which need npm's lock file.
const otherLock = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].find((p) => existsSync(join(repo, p)))
if (!existsSync(join(repo, 'package-lock.json'))) {
  skipped.push(otherLock
    ? `${otherLock} but no package-lock.json: the workflows install with npm ci, so the Release workflow fails at setup in a ${otherLock.split(/[-.]/)[0]} repo`
    : 'no package-lock.json: run npm install and commit it, or the Release workflow fails at setup')
}

// 2. package.json scripts.
pkg.scripts ??= {}
const scripts = pkg.scripts
const RELEASE = 'node scripts/release-kit/release.mjs'
if (scripts.release && scripts.release !== RELEASE && !force) {
  skipped.push(`package.json already has a "release" script (${scripts.release}); left alone, so npm run release won't run the kit (rerun with --force to replace it)`)
} else {
  scripts.release = RELEASE
}
if (!scripts['release:check']) {
  const checks = ['lint', scripts.typecheck ? 'typecheck' : 'type-check', 'test', 'build'].filter((s) => scripts[s])
  scripts['release:check'] = checks.length ? checks.map((s) => (s === 'test' ? 'npm test' : `npm run ${s}`)).join(' && ') : 'echo "release:check: define lint/test/build checks" && exit 1'
  done.push(`release:check = ${scripts['release:check']}`)
}
if (usesHusky) {
  write('.husky/commit-msg', 'node scripts/release-kit/commit-msg.mjs "$1"\n')
  chmodSync(join(repo, '.husky/commit-msg'), 0o755)
  done.push('.husky/commit-msg (the repo uses husky)')
} else if (hookManager) {
  // Pointing core.hooksPath at .githooks would switch the repo's own hooks off.
  skipped.push(`${hookManager}, so the kit's hook is not installed: add  node scripts/release-kit/commit-msg.mjs "$1"  to the commit-msg hook there (the CI check runs either way)`)
} else {
  const hook = 'git config core.hooksPath .githooks || true'
  if (!scripts.prepare) scripts.prepare = hook
  else if (!scripts.prepare.includes('core.hooksPath')) scripts.prepare = `${scripts.prepare} && (${hook})`
  try {
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks'])
  } catch {
    skipped.push('could not set core.hooksPath now; it is set on the next npm install')
  }
  done.push('package.json scripts: prepare (turns on .githooks)')
}
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
done.push('package.json scripts: release, release:check')

/** What already manages this repo's git hooks (other than the kit or husky), or null. */
function otherHooks() {
  const managers = { 'lefthook.yml': 'lefthook', '.lefthook.yml': 'lefthook', 'lefthook.yaml': 'lefthook', '.pre-commit-config.yaml': 'pre-commit', '.simple-git-hooks.json': 'simple-git-hooks', '.simple-git-hooks.js': 'simple-git-hooks', '.simple-git-hooks.cjs': 'simple-git-hooks' }
  const config = Object.keys(managers).find((p) => existsSync(join(repo, p)))
  if (config) return `the repo uses ${managers[config]} (${config})`
  if (pkg['simple-git-hooks'] || pkg.lefthook) return `the repo uses ${pkg.lefthook ? 'lefthook' : 'simple-git-hooks'} (package.json)`
  let hooksPath = ''
  try {
    hooksPath = execFileSync('git', ['-C', repo, 'config', '--local', 'core.hooksPath'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {}
  if (hooksPath && hooksPath.replace(/\/$/, '') !== '.githooks') return `core.hooksPath is already ${hooksPath}`
  try {
    const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const hooks = readdirSync(resolve(repo, gitDir)).filter((name) => !name.endsWith('.sample'))
    if (hooks.length) return `.git/hooks has its own hooks (${hooks.join(', ')})`
  } catch {}
  return null
}

// 3. Agent instructions.
const snippet = readFileSync(join(TEMPLATE, 'AGENTS.release.md'), 'utf8')
const agentFiles = ['AGENTS.md', 'CLAUDE.md'].filter((p) => existsSync(join(repo, p)))
for (const p of agentFiles.length ? agentFiles : ['AGENTS.md']) {
  const current = existsSync(join(repo, p)) ? read(p) : '# Agent instructions\n'
  const start = current.indexOf(`<!-- ${MARKER} -->`)
  const end = current.indexOf(`<!-- /${MARKER} -->`)
  const next = start !== -1 && end !== -1
    ? `${current.slice(0, start)}${snippet.trim()}${current.slice(end + `<!-- /${MARKER} -->`.length)}`
    : `${current.trimEnd()}\n${snippet}`
  write(p, next)
  done.push(`${p}: commit and release rules`)
}

console.log(`release-kit ${KIT_VERSION} applied to ${repo} (${reusable ? 'reusable' : 'vendored'} workflows${train ? `, release train "${train.schedule}"` : ''})\n`)
for (const line of done) console.log(`  + ${line}`)
for (const line of skipped) console.log(`  ! ${line}`)
console.log(`
Next:
  1. Review the diff (git -C ${repo} diff) and commit it: chore: adopt release-kit ${KIT_VERSION}
  2. Preview the first release: npm run release -- --dry-run
  3. Cut it: npm run release -- --push${train ? `\n  The release train needs a release tag to start from (npm run release -- --baseline on a new repo).\n  If main is protected by required checks, list the workflows that produce them: --train-checks ci.yml,commits.yml${train.checks.length ? ` (now: ${train.checks.join(', ')})` : ''}
  and give the train a deploy key that protection lets through: node scripts/release-kit/protect.mjs` : ''}`)
