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
//   --package            (the default) release-kit is a dev dependency pinned to a
//                        tag: the hook and npm run release run it from node_modules,
//                        the workflows call the kit at the same tag, and Dependabot
//                        opens an update PR when the kit releases
//   --reusable           workflows call one pinned copy in the release-kit repo;
//                        the scripts are copied into scripts/release-kit/
//   --vendored           workflows carry the steps; the scripts are copied
//   --kit-ref <ref>      the release-kit tag or commit to pin (default vX.Y.Z of this kit)
//   --repository <owner/repo>
//                        the upstream repo, the only one whose Release and
//                        train workflows run (default: .release.json
//                        "repository", else the upstream or origin remote)
//   --visibility <public|private>
//                        whether the repo is public or private (default: what gh
//                        says, else .release.json "visibility"); a private repo
//                        skips work that costs runner minutes
//   --force              replace workflows with the same name the kit didn't write
//   --json               print the report as JSON (the files added, changed and
//                        removed, what was done, and the notes), for the rollout bot
//   --check              a dry run that writes nothing: print each file apply would
//                        add, change or remove, and exit 1 when any differs (0 when
//                        the repo has what this kit version writes); with --json,
//                        the same report as JSON
//
// The choices are saved in .release.json, so re-running with no options keeps
// them (a repo applied before package mode existed moves to it). Kit-owned
// files (scripts/release-kit/, the workflows, the hook, RELEASING.md) are
// overwritten on every run, so re-running upgrades a repo.
// package.json scripts and agent instructions are merged, never replaced.
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryIn, entryLabel, entryProblem, readVersion, versionFilesProblems } from './template/scripts/release-kit/versions.mjs'
import { VISIBILITIES, detectVisibility } from './template/scripts/release-kit/settings.mjs'

const KIT = dirname(fileURLToPath(import.meta.url))
const kitPackage = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'))
const KIT_VERSION = kitPackage.version
const KIT_REPO = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(kitPackage.repository?.url ?? '')?.[1] ?? 'n8watkins/release-kit'
// The rollout bot (adopters.json, .github/workflows/rollout.yml): the GitHub
// App that opens a release-kit/update pull request in each repo on a release.
const ROLLOUT_BOT = 'release-kit-bot-n8watkins[bot]'
const TEMPLATE = join(KIT, 'template')
const REUSABLE = join(KIT, 'reusable')
const MARKER = 'release-kit'
const DEFAULT_SCHEDULE = '0 16 * * 1'
const SCHEDULE_LINE = /- cron: "[^"\n]*" # release-kit: schedule/
// The push trigger of commits.yml: main and master, plus the branches releases
// are cut from (.release.json "branches"), so release commits get checked too.
const BRANCHES_LINE = /^( {4}branches: )\[main, master\]$/m
// The fork guard on the Release and train jobs: only the upstream repo publishes.
const FORK_GUARD_LINE = /^( {4})if: .* # release-kit: fork guard$/m
const SLUG = /^[\w.-]+\/[\w.-]+$/
// The Direct push alarm's release branches (reusable caller), and its delete filter (vendored copy).
const ALARM_BRANCHES_LINE = /^( {6}branches: )"[^"\n]*"( # release-kit: branches)$/m
const ALARM_DELETE_FILTER = "format(',main,master,{0},'"
// The security scan's pull request setting: the caller's input, or the vendored copy's default.
const SECURITY_LINE = /^( {6}pull-requests: )\S+( # release-kit: security on pull requests)$/m
const NPMRC_NOTE = '# release-kit: npm 12 installs git dependencies (the kit is one) only when allowed.'

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
  console.error('usage: node apply.mjs <path/to/repo> [--train] [--schedule "<cron>"] [--train-checks <a.yml,b.yml>] [--no-train] [--package | --reusable | --vendored] [--kit-ref <ref>] [--repository <owner/repo>] [--visibility public|private] [--force] [--json] [--check]')
  process.exit(1)
}

const valued = new Set(['--schedule', '--kit-ref', '--train-checks', '--repository', '--visibility'])
const repo = argv.find((a, i) => !a.startsWith('--') && !valued.has(argv[i - 1]))
if (!repo || !existsSync(join(repo, 'package.json'))) usage('the repo needs a package.json')
const force = has('force')
if (['package', 'reusable', 'vendored'].filter(has).length > 1) usage('pick one of --package, --reusable and --vendored')
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
const repositoryFlag = valueOf('repository')
if (repositoryFlag !== undefined && !SLUG.test(repositoryFlag)) usage(`--repository takes owner/repo, not "${repositoryFlag}"`)
const visibilityFlag = valueOf('visibility')
if (visibilityFlag !== undefined && !VISIBILITIES.includes(visibilityFlag)) usage(`--visibility takes public or private, not "${visibilityFlag}"`)

const done = []
const skipped = []
// --check: a dry run. Every write goes to `pending` instead of the disk, and
// every read of the repo sees it, so the run decides exactly what a real one
// would, and the result is compared with the disk at the end.
const dryRun = has('check')
// Path -> { content, mode } (mode: the permissions apply sets, if any), or null when removed.
const pending = new Map()
// What each file held before apply first touched it (null: it didn't exist),
// so --json can say exactly which files were added, changed and removed.
const before = new Map()
function record(p) {
  if (before.has(p)) return
  const target = join(repo, p)
  before.set(p, existsSync(target) ? readFileSync(target) : null)
}
const exists = (p) => (pending.has(p) ? pending.get(p) !== null : existsSync(join(repo, p)))
const read = (p) => (pending.get(p)?.content.toString('utf8') ?? readFileSync(join(repo, p), 'utf8'))
/** Writes a repo file (with `mode`, its permissions, when given), or in a dry run records it. */
function write(p, content, mode) {
  if (dryRun) {
    pending.set(p, { content: Buffer.from(content), mode })
    return
  }
  record(p)
  mkdirSync(dirname(join(repo, p)), { recursive: true })
  writeFileSync(join(repo, p), content)
  if (mode !== undefined) chmodSync(join(repo, p), mode)
}
function remove(p) {
  if (dryRun) {
    pending.set(p, null)
    return
  }
  record(p)
  rmSync(join(repo, p))
}
/** The file names in a repo folder, as apply has left it so far. */
function list(dir) {
  const names = new Set(existsSync(join(repo, dir)) ? readdirSync(join(repo, dir)) : [])
  for (const [p, file] of pending) if (dirname(p) === dir) file === null ? names.delete(basename(p)) : names.add(basename(p))
  return [...names].sort()
}

// 0. The repo's choices, saved in .release.json.
const hadConfig = exists('.release.json')
const config = hadConfig ? JSON.parse(read('.release.json')) : {}
for (const mode of ['package', 'reusable', 'vendored']) if (has(mode)) config.workflows = mode
// Repos applied before package mode existed had no setting (vendored): they move to it.
if (!['package', 'reusable', 'vendored'].includes(config.workflows)) config.workflows = 'package'
if (has('no-train')) delete config.train
else if (has('train') || schedule !== undefined || trainChecks) {
  config.train = { ...config.train, schedule: schedule ?? config.train?.schedule ?? DEFAULT_SCHEDULE }
  if (trainChecks) config.train.checks = trainChecks
}
// The upstream repo: the only one whose Release and train jobs run, so a fork
// that pushes a tag or runs the train publishes nothing. Saved, so a rerun in
// a fork's clone still names the upstream.
if (repositoryFlag) config.repository = repositoryFlag
else if (typeof config.repository !== 'string' || !SLUG.test(config.repository)) {
  delete config.repository
  const found = upstreamRepository()
  if (found) config.repository = found
  else skipped.push('could not tell which GitHub repo this is (no upstream or origin remote on github.com): the Release workflow skips forks instead; rerun with --repository owner/repo to name it')
}
// Public or private: --visibility, else what gh says now, else what was saved.
// Unknown, the repo runs with the public defaults (more checks, never fewer).
if (visibilityFlag) config.visibility = visibilityFlag
else {
  const found = detectVisibility(config.repository)
  if (found && config.visibility && found !== config.visibility) done.push(`.release.json visibility: ${config.visibility} -> ${found} (GitHub says so)`)
  if (found) config.visibility = found
  else if (!VISIBILITIES.includes(config.visibility)) {
    delete config.visibility
    skipped.push(`could not tell whether ${config.repository ?? 'the repo'} is public or private (gh isn't installed or signed in, or no GitHub repo): rerun with --visibility private or --visibility public; until then it gets the public defaults`)
  }
}
const forkGuard = config.repository ? `github.repository == '${config.repository}'` : '${{ !github.event.repository.fork }}'
const packaged = config.workflows === 'package'
// Package mode calls the kit's workflows at the pinned tag, like reusable mode.
const reusable = config.workflows !== 'vendored'
const train = config.train ? { schedule: config.train.schedule ?? DEFAULT_SCHEDULE, checks: config.train.checks ?? [] } : null
const pushBranches = [...new Set(['main', 'master', ...(Array.isArray(config.branches) ? config.branches : []).filter((b) => typeof b === 'string' && b)])]
// A branch name as a YAML flow item and a GitHub branch filter: plain when it
// can be, else single-quoted with the filter's pattern characters escaped.
const branchFilter = (b) => /^[\w./-]+$/.test(b) ? b : `'${b.replace(/[*?+[\]!\\]/g, '\\$&').replaceAll("'", "''")}'`

// Files that also carry the version, detected on the first run.
if (!hadConfig) {
  // A Tauri app keeps it in tauri.conf.json, Cargo.toml and Cargo.lock too;
  // one in a subfolder (app/) has its own package.json and lock there as well.
  const tauri = ['src-tauri', 'app/src-tauri'].flatMap((dir) => ['tauri.conf.json', 'Cargo.toml', 'Cargo.lock'].map((f) => `${dir}/${f}`))
  // A browser extension's manifest.json, at the root or in the folder it is
  // loaded from; a website's web-app manifest (no manifest_version) isn't one.
  const manifests = ['manifest.json', 'src/manifest.json', 'public/manifest.json', 'extension/manifest.json']
  // A Python project's pyproject.toml ([project] version), and its uv.lock.
  const python = ['pyproject.toml', 'uv.lock']
  const candidates = [...manifests, ...tauri, 'app/package.json', 'app/package-lock.json', ...python]
  config.versionFiles = candidates.filter(carriesVersion)
  done.push(`.release.json (versionFiles: ${config.versionFiles.join(', ') || 'none'})`)
  function carriesVersion(p) {
    // A subfolder's package files count only beside a Tauri app there.
    if (p.startsWith('app/package') && !existsSync(join(repo, 'app/src-tauri/tauri.conf.json'))) return false
    // A uv.lock beside a pyproject.toml that carries the version is listed
    // whenever it is there, so a release bumps both; one apply can't read
    // gets its own warning below instead of being left out.
    if (p === 'uv.lock') return existsSync(join(repo, p)) && carriesVersion('pyproject.toml')
    try {
      if (manifests.includes(p) && !('manifest_version' in JSON.parse(read(p)))) return false
      return typeof readVersion(join(repo, p)) === 'string'
    } catch {
      return false
    }
  }
}
config.versionFiles ??= []
// Every entry must be well formed, and every version file must say what
// package.json says, or the first release or tag check fails.
for (const problem of versionFilesProblems(config.versionFiles, repo)) skipped.push(`.release.json versionFiles: ${problem}`)
const pkgVersion = JSON.parse(read('package.json')).version
for (const entry of Array.isArray(config.versionFiles) ? config.versionFiles : []) {
  if (entryProblem(entry)) continue
  let found
  try {
    found = readVersion(entryIn(repo, entry))
  } catch (error) {
    skipped.push(error.message.replaceAll(join(repo, '/'), ''))
    continue
  }
  if (found !== pkgVersion) skipped.push(`${entryLabel(entry)} has version ${found} but package.json has ${pkgVersion}: make them match before the first release, or the tag check fails`)
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
// Every workflow the kit has ever written starts with a "# release-kit" comment.
// A repo's own workflow that only mentions the kit (one that runs npx
// release-kit in a build, say) is the repo's, and stays.
const ownedByKit = (path) => exists(path) && read(path).startsWith(`# ${MARKER}`)
function writeWorkflow(path, content) {
  if (exists(path) && !ownedByKit(path) && !force) {
    skipped.push(`${path} exists and isn't from the kit (rerun with --force to replace it)`)
    return
  }
  write(path, content)
  done.push(path)
}

// The commit-msg hook in package mode: the kit from node_modules, skipped
// (with a note) until npm install has run; CI checks every commit either way.
const PACKAGE_HOOK = `# release-kit: reject commit messages that aren't Conventional Commits.
kit="$(git rev-parse --show-toplevel)/node_modules/.bin/release-kit"
if [ ! -x "$kit" ]; then
  echo "release-kit: not installed yet (npm install), so the commit message isn't checked here" >&2
  exit 0
fi
exec "$kit" commit-msg "$1"
`
// The pre-push guard in package mode: the kit from node_modules. Before npm
// install it still blocks the obvious (a push to main or master, a moved or
// deleted v* tag), without the release flow's exception.
const PACKAGE_PRE_PUSH = `# release-kit: pre-push guard. Blocks pushing straight to, force pushing or
# deleting the protected branches, and moving or deleting a release tag
# (release-kit pre-push; RELEASE_KIT_ALLOW_DIRECT_PUSH=1 overrides, logged).
kit="$(git rev-parse --show-toplevel)/node_modules/.bin/release-kit"
if [ -x "$kit" ]; then exec "$kit" pre-push "$@"; fi
[ "\${GITHUB_ACTIONS:-}" = true ] && exit 0
[ "\${RELEASE_KIT_ALLOW_DIRECT_PUSH:-}" = 1 ] && exit 0
blocked=
while read -r local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    refs/heads/main|refs/heads/master) blocked="$blocked $remote_ref" ;;
    refs/tags/v*) case "$remote_sha" in *[!0]*) blocked="$blocked $remote_ref" ;; esac ;;
  esac
done
if [ -n "$blocked" ]; then
  echo "release-kit: push blocked ($blocked): the kit isn't installed yet, so the pre-push guard can't check it. Run npm install, or push a branch and open a pull request." >&2
  exit 1
fi
`
const HOOKS = { 'commit-msg': PACKAGE_HOOK, 'pre-push': PACKAGE_PRE_PUSH }
const HOOK_LINES = {
  'commit-msg': packaged ? 'npx --no-install release-kit commit-msg "$1"' : 'node scripts/release-kit/commit-msg.mjs "$1"',
  'pre-push': packaged ? 'npx --no-install release-kit pre-push "$@"' : 'node scripts/release-kit/guard.mjs "$@"',
}
// A hook file the kit may write: missing, or one it wrote before.
const kitHook = (path) => !exists(path) || /^(#!.*\n)?# release-kit/.test(read(path))
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
        remove(path)
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
    content = content.replace(FORK_GUARD_LINE, `$1if: ${forkGuard} # release-kit: fork guard`)
    if (name === 'commits.yml' || name === 'direct-push.yml') content = content.replace(BRANCHES_LINE, `$1[${pushBranches.map(branchFilter).join(', ')}]`)
    if (name === 'direct-push.yml') {
      const extra = pushBranches.filter((b) => !['main', 'master'].includes(b))
      content = reusable
        ? content.replace(ALARM_BRANCHES_LINE, `$1${JSON.stringify(extra.join(','))}$2`)
        : content.replace(ALARM_DELETE_FILTER, `format(',${pushBranches.map((b) => b.replaceAll("'", "''")).join(',')},{0},'`)
    }
    if (name === 'security.yml') {
      const own = typeof config.security?.onPullRequest === 'boolean' ? String(config.security.onPullRequest) : 'auto'
      content = reusable ? content.replace(SECURITY_LINE, `$1${own}$2`) : content.replaceAll("(inputs.pull-requests || 'auto')", `(inputs.pull-requests || '${own}')`)
    }
    writeWorkflow(path, content)
    continue
  }
  // Package mode runs the scripts from node_modules instead of copies.
  if (packaged && path.startsWith('scripts/release-kit/')) continue
  const hook = path.startsWith('.githooks/')
  if (hook && !kitHook(path)) {
    skipped.push(`${path} is the repo's own, so the kit's ${path.slice(10)} hook is not installed: add  ${HOOK_LINES[path.slice(10)]}  to it`)
    continue
  }
  if (packaged && hook) write(path, `#!/bin/sh\n${HOOKS[path.slice(10)]}`, 0o755)
  // RELEASING.md names the kit's commands as package mode runs them.
  else if (!packaged && path === 'RELEASING.md') write(path, readFileSync(source, 'utf8').replaceAll('npx release-kit protect', 'node scripts/release-kit/protect.mjs').replaceAll('npx release-kit backfill', 'node scripts/release-kit/backfill.mjs'))
  // A copy, with the template's permissions (a hook is always executable).
  else write(path, readFileSync(source), hook ? 0o755 : statSync(source).mode & 0o777)
  done.push(path)
}
if (packaged) {
  if (existsSync(join(repo, 'scripts/release-kit'))) {
    for (const file of walk(join(repo, 'scripts/release-kit'))) remove(relative(repo, file))
    if (!dryRun) rmSync(join(repo, 'scripts/release-kit'), { recursive: true, force: true })
    done.push('scripts/release-kit/ removed (the kit now runs from node_modules)')
  }
} else {
  write('scripts/release-kit/VERSION', `${KIT_VERSION}\n`)
}
if (reusable) done.push(`workflows call ${KIT_REPO}@${kitRef}`)

// The repo's own workflows that call one of the kit's (a ci.yml calling
// changes.yml, say) move to the same version, as Dependabot's kit update would:
// otherwise verify flags them after every update that apply or the rollout bot
// makes. Only the version tag changes; a pin to a commit SHA stays.
if (reusable && /^v\d+\.\d+\.\d+$/.test(kitRef) && exists('.github/workflows')) {
  const pin = new RegExp(`(${KIT_REPO.replace(/[.]/g, '\\.')}/\\.github/workflows/[\\w.-]+\\.ya?ml)@v\\d+\\.\\d+\\.\\d+\\b`, 'g')
  for (const name of readdirSync(join(repo, '.github/workflows')).sort()) {
    const path = `.github/workflows/${name}`
    if (!/\.ya?ml$/.test(name) || ownedByKit(path)) continue
    const text = read(path)
    const next = text.replace(pin, `$1@${kitRef}`)
    if (next === text) continue
    write(path, next)
    done.push(`${path}: calls the kit at ${kitRef}`)
  }
}

// Update pull requests merge on their own once CI passes (docs/AUTO_MERGE.md):
// through GitHub's auto-merge where the branch requires checks, else (a private
// repo on GitHub Free) through the merge-when-green fallback.
if (config.autoMerge !== false) writeAutoMerge()

// The workflows use npm ci and npm caching, which need npm's lock file.
const otherLock = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].find(exists)
if (!exists('package-lock.json')) {
  skipped.push(otherLock
    ? `${otherLock} but no package-lock.json: the workflows install with npm ci, so the Release workflow fails at setup in a ${otherLock.split(/[-.]/)[0]} repo`
    : 'no package-lock.json: run npm install and commit it, or the Release workflow fails at setup')
}

// 2. package.json scripts.
pkg.scripts ??= {}
const scripts = pkg.scripts
const RELEASE = packaged ? 'release-kit release' : 'node scripts/release-kit/release.mjs'
const KIT_RELEASES = ['release-kit release', 'node scripts/release-kit/release.mjs']
if (scripts.release && !KIT_RELEASES.includes(scripts.release) && !force) {
  skipped.push(`package.json already has a "release" script (${scripts.release}); left alone, so npm run release won't run the kit (rerun with --force to replace it)`)
} else {
  scripts.release = RELEASE
}
if (!scripts['release:check']) {
  const checks = ['lint', scripts.typecheck ? 'typecheck' : 'type-check', 'test', 'build'].filter((s) => scripts[s])
  scripts['release:check'] = checks.length ? checks.map((s) => (s === 'test' ? 'npm test' : `npm run ${s}`)).join(' && ') : 'echo "release:check: define lint/test/build checks" && exit 1'
  done.push(`release:check = ${scripts['release:check']}`)
}
// Package mode: release:check also warns when the kit is behind its newest release.
const CHECK = 'release-kit check'
if (packaged && !scripts['release:check'].includes(CHECK)) scripts['release:check'] = `${CHECK} && ${scripts['release:check']}`
if (!packaged && scripts['release:check'].startsWith(`${CHECK} && `)) scripts['release:check'] = scripts['release:check'].slice(CHECK.length + 4)
if (packaged) {
  pkg.devDependencies ??= {}
  const spec = `github:${KIT_REPO}#${kitRef}`
  if (pkg.devDependencies['release-kit'] !== spec) {
    pkg.devDependencies['release-kit'] = spec
    pkg.devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).sort(([a], [b]) => a.localeCompare(b)))
    done.push(`devDependencies: release-kit ${spec} (run npm install to update the lock)`)
  }
  writeDependabot()
  writeNpmrc()
} else if (pkg.devDependencies?.['release-kit']) {
  delete pkg.devDependencies['release-kit']
  done.push('devDependencies: release-kit removed (copied scripts instead)')
}
// Copied scripts need no git dependency: drop the line package mode added.
if (!packaged && exists('.npmrc') && read('.npmrc').includes(`${NPMRC_NOTE}\nallow-git=root\n`)) {
  const rest = read('.npmrc').replace(`${NPMRC_NOTE}\nallow-git=root\n`, '')
  if (rest.trim()) write('.npmrc', rest)
  else remove('.npmrc')
  done.push('.npmrc: allow-git removed (no git dependency in this mode)')
}
if (usesHusky) {
  const vendoredHooks = { 'commit-msg': '# release-kit: reject commit messages that aren\'t Conventional Commits.\nnode scripts/release-kit/commit-msg.mjs "$1"\n', 'pre-push': '# release-kit: pre-push guard (scripts/release-kit/guard.mjs).\nnode scripts/release-kit/guard.mjs "$@"\n' }
  for (const name of ['commit-msg', 'pre-push']) {
    const path = `.husky/${name}`
    // commit-msg was always the kit's in a husky repo; a pre-push may be the repo's own.
    if (name === 'pre-push' && !kitHook(path)) {
      skipped.push(`${path} is the repo's own, so the kit's pre-push guard is not installed: add  ${HOOK_LINES[name]}  as its first line`)
      continue
    }
    write(path, packaged ? HOOKS[name] : vendoredHooks[name], 0o755)
    done.push(`${path} (the repo uses husky)`)
  }
} else if (hookManager) {
  // Pointing core.hooksPath at .githooks would switch the repo's own hooks off.
  skipped.push(`${hookManager}, so the kit's hooks are not installed: add  ${HOOK_LINES['commit-msg']}  to the commit-msg hook there (the CI check runs either way), and  ${HOOK_LINES['pre-push']}  to the pre-push hook (the pre-push guard)`)
} else {
  const hook = 'git config core.hooksPath .githooks || true'
  if (!scripts.prepare) scripts.prepare = hook
  else if (!scripts.prepare.includes('core.hooksPath')) scripts.prepare = `${scripts.prepare} && (${hook})`
  // A dry run changes nothing, git config included.
  if (!dryRun) {
    try {
      execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks'])
    } catch {
      skipped.push('could not set core.hooksPath now; it is set on the next npm install')
    }
  }
  done.push('package.json scripts: prepare (turns on .githooks)')
}
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
done.push('package.json scripts: release, release:check')

/**
 * The auto-merge workflow: it calls the kit's policy on pull_request (GitHub
 * auto-merge, where the branch requires checks) and, as the merge-when-green
 * fallback, whenever one of the repo's pull request workflows finishes (listed
 * by name under workflow_run).
 */
function autoMergeWorkflow(workflowNames, ref) {
  return `# release-kit: merge update pull requests once CI passes (docs/AUTO_MERGE.md in
# release-kit). A release-kit update or a Dependabot patch or minor update
# merges on its own, and a major update waits for a person. Where the branch
# requires checks, GitHub's auto-merge merges it once they pass (allow auto-merge
# on the repo: npx release-kit protect does); where it can't (a private repo on
# GitHub Free), the merge-when-green fallback merges it once every check on it
# has passed. workflow_run lists every workflow that runs on pull requests, so
# the one that finishes last still triggers a look; rerun npx release-kit
# apply . after adding one. "autoMerge": false in .release.json turns it off.
name: Auto-merge

on:
  pull_request:
  workflow_run:
    workflows: [${workflowNames.map((n) => JSON.stringify(n)).join(', ')}]
    types: [completed]

permissions:
  contents: read

jobs:
  auto-merge:
    # Only update pull requests, so other pull requests cost no runner time.
    if: >-
      (github.event_name == 'pull_request' && (github.event.pull_request.user.login == 'dependabot[bot]' || startsWith(github.head_ref, 'release-kit/')))
      || (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.conclusion == 'success'
          && (github.event.workflow_run.actor.login == 'dependabot[bot]' || startsWith(github.event.workflow_run.head_branch, 'release-kit/')))
    permissions:
      contents: write # merge the pull request
      pull-requests: write # turn on auto-merge
      checks: read # merge when green: read the checks on the pull request
      statuses: read
    uses: ${KIT_REPO}/.github/workflows/auto-merge.yml@${ref}
    with:
      # The rollout bot's release-kit/update pull requests merge like Dependabot's.
      bots: "dependabot[bot],${ROLLOUT_BOT}"
`
}

function writeAutoMerge() {
  const names = []
  for (const file of list('.github/workflows')) {
    if (!/\.ya?ml$/.test(file) || file === 'auto-merge.yml') continue
    const text = read(`.github/workflows/${file}`)
    const name = /^name:\s*["']?(.+?)["']?\s*$/m.exec(text)?.[1]
    // A pull_request trigger, in the on: block or an inline on: list.
    if (name && (/^ {2}pull_request(_target)?:/m.test(text) || /^on:.*\bpull_request\b/m.test(text))) names.push(name)
  }
  writeWorkflow('.github/workflows/auto-merge.yml', autoMergeWorkflow(names, /^[0-9a-f]{40}$/.test(kitRef) ? `${kitRef} # release-kit ${KIT_VERSION}` : kitRef))
}

/**
 * Package mode: Dependabot keeps the kit current, the dev dependency (npm) and
 * the workflow pins (github-actions), and keeps every other dependency current
 * too, with security updates. A repo with its own dependabot.yml keeps it; it
 * needs both ecosystems listed, nothing ignoring release-kit, and no allow
 * list (which would block security updates).
 */
function writeDependabot() {
  const path = '.github/dependabot.yml'
  const ours = `# release-kit: Dependabot for this repo, written by npx release-kit apply.
#
# Two entries per ecosystem, both for the repo root:
#
# 1. The kit. A new kit release arrives as one update PR (the dev dependency and
#    the workflow pins), daily. One multi-ecosystem group, so the npm and
#    github-actions updates land together: separate PRs would leave package.json
#    and the workflows on different kit versions. An entry in a multi-ecosystem
#    group updates only what its patterns name, so it covers the kit alone.
#    No cooldown for the kit: Dependabot's default 3-day cooldown skips the newest
#    tags, and for a git dependency it then proposes the newest older tag, even
#    one below the installed version (a downgrade).
# 2. Everything else, weekly: patch and minor updates in one PR per ecosystem,
#    which the kit's auto-merge merges once CI passes, and major updates in
#    another, which waits for a person. A cooldown (3 days, and 7 for an npm
#    major) lets a bad release be pulled before it reaches the repo. These
#    entries ignore the kit, which the first ones update.
#
# Security updates use neither allow nor groups here, so Dependabot opens one for
# any vulnerable dependency, direct or transitive, as soon as an alert appears
# (no cooldown). Don't add an allow list: Dependabot applies it to security
# updates too, and a dependency it leaves out gets none ("all versions were
# ignored").
version: 2
multi-ecosystem-groups:
  release-kit:
    schedule:
      interval: daily
    # On the group: Dependabot rejects commit-message on an update in a group.
    commit-message:
      prefix: build
      include: scope
updates:
  - package-ecosystem: npm
    directory: /
    patterns: ["release-kit"]
    multi-ecosystem-group: release-kit
    cooldown:
      exclude: ["release-kit"]
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: release-kit
    cooldown:
      default-days: 3
      semver-major-days: 7
    commit-message:
      prefix: build
      include: scope
    groups:
      npm-minor-patch:
        update-types: [minor, patch]
      npm-major:
        update-types: [major]
  - package-ecosystem: github-actions
    directory: /
    patterns: ["${KIT_REPO}*"]
    multi-ecosystem-group: release-kit
    cooldown:
      exclude: ["${KIT_REPO}*"]
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: ${KIT_REPO}*
    # Days per semver level are npm-only: Dependabot rejects them for github-actions.
    cooldown:
      default-days: 3
    commit-message:
      prefix: build
      include: scope
    groups:
      actions-minor-patch:
        update-types: [minor, patch]
      actions-major:
        update-types: [major]
`
  if (exists(path)) {
    const current = read(path)
    // The kit's own file (any version of it) is the kit's to upgrade.
    if (current.startsWith('# release-kit:')) {
      if (current !== ours) {
        write(path, ours)
        done.push(`${path} (one grouped PR per kit release, weekly grouped updates and security updates for every other dependency)`)
      }
      return
    }
    // An entry per ecosystem for the repo root, where the dev dependency and the workflows are.
    const entries = current.split(/\n(?=\s*-\s*package-ecosystem:)/)
    const atRoot = (ecosystem) =>
      entries.some((e) => new RegExp(`package-ecosystem:\\s*["']?${ecosystem}["']?`).test(e) && /directory:\s*["']?\/["']?\s*(\n|$)/.test(e))
    const missing = ['npm', 'github-actions'].filter((e) => !atRoot(e))
    if (missing.length) skipped.push(`${path} has no ${missing.join(' or ')} entry for directory "/": add one so kit releases arrive as update PRs`)
    else if (/release-kit/.test(current)) skipped.push(`${path} mentions release-kit: make sure it doesn't ignore it`)
    if (allowList(current)) skipped.push(`${path} is the repo's own and has an allow list: Dependabot applies it to security updates too, so a vulnerable dependency it leaves out gets no security update ("all versions were ignored"). Drop allow, and use ignore or groups to limit version updates`)
    if (!/cooldown:[\s\S]*exclude:[^\n]*release-kit/.test(current)) skipped.push(`${path} is the repo's own and doesn't exclude release-kit from Dependabot's default 3-day cooldown, which can propose a downgrade to an older kit tag: add cooldown: exclude: ["release-kit"] to the npm entry and ["${KIT_REPO}*"] to the github-actions entry`)
    if (!/multi-ecosystem-group:\s*["']?release-kit/.test(current)) skipped.push(`${path} is the repo's own, so kit releases arrive as separate npm and github-actions PRs: group them with a "release-kit" multi-ecosystem group (see README, "How upgrades reach your repos")`)
    return
  }
  write(path, ours)
  done.push(path)
}

/**
 * Whether a dependabot.yml has an allow list on any entry. Dependabot applies
 * allow to security updates too, so a dependency the list leaves out gets no
 * security update ("all versions were ignored").
 */
function allowList(text) {
  return /^[ \t]+-?[ \t]*allow:/m.test(text)
}

/**
 * Package mode: npm 12 refuses git dependencies unless .npmrc allows them
 * (EALLOWGIT), and the kit is one. "root" is the narrowest setting that works:
 * git dependencies listed in this package.json, and none pulled in by others.
 * Older npm versions accept the setting too.
 */
function writeNpmrc() {
  const path = '.npmrc'
  const current = exists(path) ? read(path) : ''
  const setting = /^[ \t]*allow-git[ \t]*=[ \t]*(\S*)[ \t]*$/m.exec(current)
  if (setting && ['root', 'all'].includes(setting[1])) return
  const line = `${NPMRC_NOTE}\nallow-git=root\n`
  if (setting) {
    write(path, current.replace(setting[0], 'allow-git=root'))
    done.push(`${path}: allow-git=${setting[1] || '(empty)'} -> root (npm 12 installs the kit only from an allowed git dependency)`)
  } else {
    write(path, current ? `${current.replace(/\n*$/, '\n')}${line}` : line)
    done.push(`${path}: allow-git=root (npm 12 installs git dependencies, like the kit, only when allowed)`)
  }
}

/**
 * owner/repo on GitHub: the "upstream" remote when there is one (a fork's
 * clone), else "origin", else package.json "repository"; or undefined.
 */
function upstreamRepository() {
  const slug = (url) => /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '')?.[1]
  for (const remote of ['upstream', 'origin']) {
    try {
      const found = slug(execFileSync('git', ['-C', repo, 'remote', 'get-url', remote], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
      if (found) return found
    } catch {}
  }
  const field = JSON.parse(read('package.json')).repository
  return slug(typeof field === 'string' ? field.replace(/^github:/, 'https://github.com/') : field?.url)
}

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
  // A prepare script that points core.hooksPath at the repo's own folder would
  // switch .githooks off again on the next npm install.
  const prepared = /core\.hooksPath\s+["']?([^\s"'|&;)]+)/.exec(pkg.scripts?.prepare ?? '')?.[1]
  if (prepared && !['.githooks', '.husky'].includes(prepared.replace(/\/$/, ''))) return `the prepare script sets core.hooksPath to ${prepared}`
  // Already the kit's own .githooks: nothing else to look for.
  if (hooksPath) return null
  try {
    const gitDir = execFileSync('git', ['-C', repo, 'rev-parse', '--git-path', 'hooks'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const hooks = readdirSync(resolve(repo, gitDir)).filter((name) => !name.endsWith('.sample'))
    if (hooks.length) return `.git/hooks has its own hooks (${hooks.join(', ')})`
  } catch {}
  return null
}

// 3. Agent instructions.
const snippet = readFileSync(join(TEMPLATE, 'AGENTS.release.md'), 'utf8')
const agentFiles = ['AGENTS.md', 'CLAUDE.md'].filter(exists)
for (const p of agentFiles.length ? agentFiles : ['AGENTS.md']) {
  const current = exists(p) ? read(p) : '# Agent instructions\n'
  const start = current.indexOf(`<!-- ${MARKER} -->`)
  const end = current.indexOf(`<!-- /${MARKER} -->`)
  const next = start !== -1 && end !== -1
    ? `${current.slice(0, start)}${snippet.trim()}${current.slice(end + `<!-- /${MARKER} -->`.length)}`
    : `${current.trimEnd()}\n${snippet}`
  write(p, next)
  done.push(`${p}: commit and release rules`)
}

/**
 * The files added, changed and removed: by this run, or in a dry run, the ones
 * a real run would touch. A dry run also counts a file whose content is right
 * but whose executable bit isn't, since a real run would change it.
 */
function fileChanges() {
  const files = { added: [], changed: [], removed: [] }
  const onDisk = (p) => (existsSync(join(repo, p)) ? readFileSync(join(repo, p)) : null)
  const executable = (mode) => (mode & 0o111) !== 0
  for (const p of [...(dryRun ? pending : before).keys()].sort()) {
    const [old, now] = dryRun ? [onDisk(p), pending.get(p)?.content ?? null] : [before.get(p), onDisk(p)]
    const mode = dryRun ? pending.get(p)?.mode : undefined
    if (old === null && now !== null) files.added.push(p)
    else if (old !== null && now === null) files.removed.push(p)
    else if (old !== null && (!old.equals(now) || (mode !== undefined && executable(mode) !== executable(statSync(join(repo, p)).mode)))) files.changed.push(p)
  }
  return files
}

if (has('json') || dryRun) {
  const files = fileChanges()
  const differs = Object.values(files).some((paths) => paths.length)
  if (has('json')) console.log(JSON.stringify({ version: KIT_VERSION, kitRef, repo, repository: config.repository ?? null, mode: config.workflows, train: train?.schedule ?? null, check: dryRun, files, done, notes: skipped }, null, 2))
  else if (!differs) console.log(`release-kit v${KIT_VERSION}: ${repo} has every file apply writes, up to date`)
  else {
    const count = files.added.length + files.changed.length + files.removed.length
    console.log(`release-kit v${KIT_VERSION} adds or changes ${count} file${count === 1 ? '' : 's'}; run npx release-kit apply .`)
    for (const [kind, paths] of Object.entries(files)) for (const p of paths) console.log(`  ${kind.padEnd(8)}${p}`)
  }
  process.exit(dryRun && differs ? 1 : 0)
}
console.log(`release-kit ${KIT_VERSION} applied to ${repo} (${config.workflows} mode${train ? `, release train "${train.schedule}"` : ''})\n`)
for (const line of done) console.log(`  + ${line}`)
for (const line of skipped) console.log(`  ! ${line}`)
console.log(`
Next:
  1. ${packaged ? `npm install (in ${repo}), then review` : 'Review'} the diff (git -C ${repo} diff) and commit it: chore: adopt release-kit ${KIT_VERSION}
  2. Preview the first release: npm run release -- --dry-run
  3. Cut it: npm run release -- --push
  4. A squash merge commits the pull request title, which the Commit messages check now checks too.
     Make the title (and the description, where Release-note: and BREAKING CHANGE: lines go) the squash default, in ${repo}:
     gh api -X PATCH repos/{owner}/{repo} -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY${train ? `\n  The release train needs a release tag to start from (npm run release -- --baseline on a new repo).\n  If main is protected by required checks, list the workflows that produce them: --train-checks ci.yml,commits.yml${train.checks.length ? ` (now: ${train.checks.join(', ')})` : ''}
  and give the train a deploy key that protection lets through: ${packaged ? 'npx release-kit protect' : 'node scripts/release-kit/protect.mjs'}` : ''}`)
