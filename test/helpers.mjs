// Throwaway repos for the end-to-end tests.
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const KIT = new URL('..', import.meta.url).pathname
export const KIT_VERSION = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version

const identity = (name = 'T', email = 't@t') => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email })
// Keep the user's git config (hooks, signing, templates) out of the tests.
const ENV = { ...process.env, ...identity(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
delete ENV.GITHUB_OUTPUT
delete ENV.GITHUB_STEP_SUMMARY

export const run = (cwd, cmd, args, env = {}) => execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1024 ** 3, env: { ...ENV, ...env } })
export const attempt = (cwd, cmd, args, env = {}, input = undefined) => spawnSync(cmd, args, { cwd, input, encoding: 'utf8', maxBuffer: 1024 ** 3, env: { ...ENV, ...env } })
export const bot = identity('github-actions[bot]', '41898282+github-actions[bot]@users.noreply.github.com')

export const tmp = (name) => mkdtempSync(join(tmpdir(), `release-kit-${name}-`))

/** A git repo with a package.json at `version` and one "Initial commit". */
export function makeRepo(dir, { version = '1.0.0', scripts = { build: 'echo build' } } = {}) {
  mkdirSync(dir, { recursive: true })
  run(dir, 'git', ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version, scripts }, null, 2))
  run(dir, 'git', ['add', '-A'])
  run(dir, 'git', ['commit', '-q', '-m', 'Initial commit'])
  return dir
}

let counter = 0
/** Commit a new file with `message`. */
export function commit(dir, message, env) {
  counter += 1
  writeFileSync(join(dir, `change-${counter}.txt`), String(counter))
  run(dir, 'git', ['add', '-A'], env)
  run(dir, 'git', ['commit', '-q', '-m', message], env)
}

/** key=value lines (as written to $GITHUB_OUTPUT) to an object. */
export const outputs = (text) => Object.fromEntries(text.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
