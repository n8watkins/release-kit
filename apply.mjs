#!/usr/bin/env node
// Applies the release kit to a repo (or updates it to this kit version).
//
//   node apply.mjs <path/to/repo> [--force]
//
// Kit-owned files (scripts/release-kit/, the two workflows, the hook,
// RELEASING.md) are overwritten on every run, so re-running upgrades a repo.
// A workflow with the same name that the kit didn't write is left alone
// unless --force. package.json scripts and agent instructions are merged,
// never replaced.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'template')
const MARKER = 'release-kit'

const repo = process.argv[2]
const force = process.argv.includes('--force')
if (!repo || !existsSync(join(repo, 'package.json'))) {
  console.error('usage: node apply.mjs <path/to/repo> [--force]   (the repo needs a package.json)')
  process.exit(1)
}

const done = []
const skipped = []
const read = (p) => readFileSync(join(repo, p), 'utf8')
const write = (p, content) => {
  mkdirSync(dirname(join(repo, p)), { recursive: true })
  writeFileSync(join(repo, p), content)
}

// 1. Kit-owned files.
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(path)
    else yield path
  }
}
for (const source of walk(TEMPLATE)) {
  const path = relative(TEMPLATE, source)
  if (path === 'AGENTS.release.md') continue
  const target = join(repo, path)
  if (existsSync(target) && path.startsWith('.github/') && !read(path).includes(MARKER) && !force) {
    skipped.push(`${path} exists and isn't from the kit (rerun with --force to replace it)`)
    continue
  }
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  if (path.startsWith('.githooks/')) chmodSync(target, 0o755)
  done.push(path)
}
write('scripts/release-kit/VERSION', `${KIT_VERSION}\n`)

// The workflows use npm ci and npm caching, which need a lock file.
if (!existsSync(join(repo, 'package-lock.json'))) {
  skipped.push('no package-lock.json: run npm install and commit it, or the Release workflow fails at setup')
}

// 2. Files that also carry the version.
if (!existsSync(join(repo, '.release.json'))) {
  const candidates = ['manifest.json', 'src/manifest.json', 'public/manifest.json', 'src-tauri/tauri.conf.json', 'app/src-tauri/tauri.conf.json']
  const versionFiles = candidates.filter((p) => {
    try {
      return typeof JSON.parse(read(p)).version === 'string'
    } catch {
      return false
    }
  })
  write('.release.json', `${JSON.stringify({ versionFiles }, null, 2)}\n`)
  done.push(`.release.json (versionFiles: ${versionFiles.join(', ') || 'none'})`)
}

// 3. package.json scripts.
const pkg = JSON.parse(read('package.json'))
pkg.scripts ??= {}
const scripts = pkg.scripts
scripts.release = 'node scripts/release-kit/release.mjs'
if (!scripts['release:check']) {
  const checks = ['lint', scripts.typecheck ? 'typecheck' : 'type-check', 'test', 'build'].filter((s) => scripts[s])
  scripts['release:check'] = checks.length ? checks.map((s) => (s === 'test' ? 'npm test' : `npm run ${s}`)).join(' && ') : 'echo "release:check: define lint/test/build checks" && exit 1'
  done.push(`release:check = ${scripts['release:check']}`)
}
const usesHusky = existsSync(join(repo, '.husky'))
if (usesHusky) {
  write('.husky/commit-msg', 'node scripts/release-kit/commit-msg.mjs "$1"\n')
  chmodSync(join(repo, '.husky/commit-msg'), 0o755)
  done.push('.husky/commit-msg (the repo uses husky)')
} else {
  const hook = 'git config core.hooksPath .githooks || true'
  if (!scripts.prepare) scripts.prepare = hook
  else if (!scripts.prepare.includes('core.hooksPath')) scripts.prepare = `${scripts.prepare} && (${hook})`
  try {
    execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.githooks'])
  } catch {
    skipped.push('could not set core.hooksPath now; it is set on the next npm install')
  }
}
write('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
done.push('package.json scripts: release, release:check, prepare')

// 4. Agent instructions.
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

console.log(`release-kit ${KIT_VERSION} applied to ${repo}\n`)
for (const line of done) console.log(`  + ${line}`)
for (const line of skipped) console.log(`  ! ${line}`)
console.log(`
Next:
  1. Review the diff (git -C ${repo} diff) and commit it: chore: adopt release-kit ${KIT_VERSION}
  2. Preview the first release: npm run release -- --dry-run
  3. Cut it: npm run release -- --push`)
