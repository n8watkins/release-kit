// release-kit verify: the fast check a kit-only update runs instead of the
// repo's full CI, against an applied repo with the kit linked into node_modules.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, KIT_VERSION, attempt, makeRepo, run, tmp } from './helpers.mjs'

function applied() {
  const repo = makeRepo(tmp('verify'))
  run(KIT, 'node', ['apply.mjs', repo])
  run(repo, 'mkdir', ['-p', 'node_modules/.bin'])
  run(repo, 'ln', ['-s', KIT, 'node_modules/release-kit'])
  run(repo, 'ln', ['-s', '../release-kit/bin/release-kit.mjs', 'node_modules/.bin/release-kit'])
  // What npm install writes for the pinned kit.
  const lock = { name: 'demo', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'demo', version: '1.0.0', devDependencies: { 'release-kit': `github:n8watkins/release-kit#v${KIT_VERSION}` } }, 'node_modules/release-kit': { version: KIT_VERSION, resolved: 'git+ssh://git@github.com/n8watkins/release-kit.git#' + 'a'.repeat(40), dev: true } } }
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(lock, null, 2))
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  // No actionlint unless the test names one.
  const verify = (env = {}) => attempt(repo, 'node', ['node_modules/.bin/release-kit', 'verify'], { ACTIONLINT: join(repo, 'no-actionlint'), ...env })
  return { repo, verify }
}

test('verify passes on a repo where the kit installs, every pin agrees and the notes render', () => {
  const { verify } = applied()
  const result = verify()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`install ok \\(release-kit ${KIT_VERSION.replaceAll('.', '\\.')}\\)`))
  assert.match(result.stdout, /pins ok/)
  assert.match(result.stdout, /notes ok/)
})

test('verify fails on a stale lock, a lagging workflow pin, a missing .npmrc line or a failing actionlint', () => {
  const { repo, verify } = applied()
  const lockPath = join(repo, 'package-lock.json')
  const lock = readFileSync(lockPath, 'utf8')
  writeFileSync(lockPath, lock.replace(`"version": "${KIT_VERSION}",\n      "resolved"`, '"version": "0.0.1",\n      "resolved"'))
  assert.match(verify().stderr, /install: package-lock\.json has release-kit 0\.0\.1, but .* is installed/)
  writeFileSync(lockPath, lock)

  const commits = join(repo, '.github/workflows/commits.yml')
  const workflow = readFileSync(commits, 'utf8')
  writeFileSync(commits, workflow.replace(`@v${KIT_VERSION}`, '@v0.0.1'))
  const skew = verify()
  assert.equal(skew.status, 1)
  assert.match(skew.stderr, /pins: \.github\/workflows\/commits\.yml calls release-kit v0\.0\.1/)
  writeFileSync(commits, workflow)

  writeFileSync(join(repo, '.npmrc'), '')
  assert.match(verify().stderr, /install: \.npmrc does not allow git dependencies/)
  run(KIT, 'node', ['apply.mjs', repo])

  // A fake actionlint that finds a problem.
  const bin = tmp('lint')
  writeFileSync(join(bin, 'actionlint'), '#!/bin/sh\necho ".github/workflows/ci.yml:3:1: unexpected key"\nexit 1\n', { mode: 0o755 })
  const lint = verify({ ACTIONLINT: join(bin, 'actionlint') })
  assert.equal(lint.status, 1)
  assert.match(lint.stderr, /workflows: actionlint:\n\.github\/workflows\/ci\.yml:3:1: unexpected key/)
  assert.match(verify().stdout, /workflows ok \(skipped: actionlint is not installed \(ENOENT\)\)/)
})
