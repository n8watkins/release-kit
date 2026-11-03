// The pre-push guard: unit cases for its decisions, and end to end against a
// bare remote, the way a person or an agent pushes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, commit, makeRepo, run, tmp } from './helpers.mjs'
import { judge, protectedBranches, releaseCommitProblem } from '../template/scripts/release-kit/guard.mjs'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const Z = '0'.repeat(40)

test('a release commit changes only the version files and the changelog, to the version it names', () => {
  const ok = { subject: 'chore(release): v1.2.0', parents: 1, files: ['CHANGELOG.md', 'package.json', 'package-lock.json'], version: '1.2.0' }
  assert.equal(releaseCommitProblem(ok), null)
  assert.equal(releaseCommitProblem({ ...ok, files: [...ok.files, 'src-tauri/Cargo.toml'], versionFiles: ['src-tauri/Cargo.toml'] }), null)
  assert.match(releaseCommitProblem({ ...ok, files: [...ok.files, 'src/app.js'] }), /changes src\/app\.js/)
  assert.match(releaseCommitProblem({ ...ok, version: '1.1.0' }), /says 1\.1\.0, not 1\.2\.0/)
  assert.match(releaseCommitProblem({ ...ok, subject: 'chore(release): bump' }), /not chore\(release\): vX\.Y\.Z/)
  assert.match(releaseCommitProblem({ ...ok, parents: 2 }), /2 parents/)
})

test('the protected branches: the default branch, main, master and the release branches', () => {
  assert.deepEqual(protectedBranches({ defaultBranch: 'trunk', branches: ['review/v1'] }), ['trunk', 'main', 'master', 'review/v1'])
  assert.deepEqual(protectedBranches({}), ['main', 'master'])
})

test('judge: what is blocked and what goes through', () => {
  const facts = { protected: ['main'], isAncestor: () => true, newCommits: () => [B], subject: () => 'feat: x', releaseProblem: () => 'not one', releaseEnv: undefined }
  const verdict = (update, more = {}) => judge({ localSha: B, remoteSha: A, ...update }, { ...facts, ...more }).verdict
  assert.equal(verdict({ remoteRef: 'refs/heads/feature' }), 'allow')
  assert.equal(verdict({ remoteRef: 'refs/heads/feature', localSha: Z }), 'allow')
  assert.equal(verdict({ remoteRef: 'refs/heads/main' }), 'block')
  assert.equal(verdict({ remoteRef: 'refs/heads/main', localSha: Z }), 'block')
  assert.equal(verdict({ remoteRef: 'refs/heads/main', remoteSha: Z }), 'allow')
  assert.equal(verdict({ remoteRef: 'refs/heads/main' }, { isAncestor: () => false }), 'block')
  assert.equal(verdict({ remoteRef: 'refs/heads/main', localSha: A }), 'allow')
  assert.equal(verdict({ remoteRef: 'refs/tags/v1.0.0', remoteSha: Z }), 'allow')
  assert.equal(verdict({ remoteRef: 'refs/tags/v1.0.0' }), 'block')
  assert.equal(verdict({ remoteRef: 'refs/tags/v1.0.0', localSha: Z }), 'block')
  assert.equal(verdict({ remoteRef: 'refs/tags/other' }), 'allow', 'only v* tags are release tags')
  // The release commit: only with the release flow's marker, and alone.
  const release = { subject: () => 'chore(release): v1.1.0', releaseProblem: () => null }
  assert.equal(verdict({ remoteRef: 'refs/heads/main' }, release), 'block')
  assert.equal(verdict({ remoteRef: 'refs/heads/main' }, { ...release, releaseEnv: 'v1.1.0' }), 'allow')
  assert.equal(verdict({ remoteRef: 'refs/heads/main' }, { ...release, releaseEnv: 'v1.2.0' }), 'block')
  assert.equal(verdict({ remoteRef: 'refs/heads/main' }, { ...release, releaseEnv: 'v1.1.0', newCommits: () => [A, B] }), 'block')
})

/** A clone with the guard installed (install-guard), its bare origin, and a first push of main. */
function setup() {
  const origin = tmp('guard-origin')
  run(origin, 'git', ['init', '-q', '--bare', '-b', 'main'])
  const repo = makeRepo(tmp('guard-repo'), { scripts: { 'release:check': 'echo ok' } })
  run(repo, 'git', ['remote', 'add', 'origin', origin])
  const installed = attempt(repo, 'node', [join(KIT, 'bin/release-kit.mjs'), 'install-guard'])
  assert.equal(installed.status, 0, installed.stderr)
  assert.match(installed.stdout, /pre-push guard installed/)
  // Creating main on an empty remote is allowed.
  const first = attempt(repo, 'git', ['push', '-q', '-u', 'origin', 'main'])
  assert.equal(first.status, 0, first.stderr)
  run(repo, 'git', ['remote', 'set-head', 'origin', 'main'])
  const remoteMain = () => run(origin, 'git', ['rev-parse', 'main']).trim()
  return { origin, repo, remoteMain }
}

test('end to end: a push to main is blocked and nothing leaves; a feature branch goes through', () => {
  const { repo, remoteMain } = setup()
  const before = remoteMain()
  commit(repo, 'feat: straight to main')
  const pushed = attempt(repo, 'git', ['push', 'origin', 'main'])
  assert.notEqual(pushed.status, 0)
  assert.match(pushed.stderr, /push blocked, nothing was sent/)
  assert.match(pushed.stderr, /refs\/heads\/main: it pushes 1 commit straight to main/)
  assert.match(pushed.stderr, /gh pr create/)
  assert.match(pushed.stderr, /RELEASE_KIT_ALLOW_DIRECT_PUSH=1/)
  assert.equal(remoteMain(), before)

  run(repo, 'git', ['switch', '-q', '-c', 'feature'])
  assert.equal(attempt(repo, 'git', ['push', '-q', 'origin', 'feature']).status, 0)
  // Force pushing and deleting a feature branch are fine.
  run(repo, 'git', ['commit', '-q', '--amend', '-m', 'feat: reworded'])
  assert.equal(attempt(repo, 'git', ['push', '-q', '--force', 'origin', 'feature']).status, 0)
  assert.equal(attempt(repo, 'git', ['push', '-q', 'origin', '--delete', 'feature']).status, 0)
})

test('end to end: force pushing or deleting main, and moving or deleting a release tag, are blocked', () => {
  const { repo, origin, remoteMain } = setup()
  run(repo, 'git', ['commit', '-q', '--amend', '-m', 'chore: rewritten'])
  const forced = attempt(repo, 'git', ['push', '--force', 'origin', 'main'])
  assert.notEqual(forced.status, 0)
  assert.match(forced.stderr, /force pushes main/)
  assert.notEqual(attempt(repo, 'git', ['push', 'origin', '--delete', 'main']).status, 0)
  assert.ok(remoteMain())

  // A new tag is fine; moving or deleting it once it is out is not.
  run(repo, 'git', ['tag', 'v1.0.0', 'origin/main'])
  assert.equal(attempt(repo, 'git', ['push', '-q', 'origin', 'v1.0.0']).status, 0)
  run(repo, 'git', ['tag', '-f', 'v1.0.0', 'HEAD'])
  const moved = attempt(repo, 'git', ['push', '--force', 'origin', 'v1.0.0'])
  assert.notEqual(moved.status, 0)
  assert.match(moved.stderr, /moves the release tag v1\.0\.0/)
  assert.match(moved.stderr, /cut a new release instead/)
  assert.notEqual(attempt(repo, 'git', ['push', 'origin', ':refs/tags/v1.0.0']).status, 0)
  assert.equal(run(origin, 'git', ['rev-parse', 'v1.0.0']).trim(), remoteMain())
})

test('end to end: the override lets a push through and logs it; CI is left to the alarm', () => {
  const { repo, remoteMain } = setup()
  commit(repo, 'fix: hotfix')
  const forced = attempt(repo, 'git', ['push', '-q', 'origin', 'main'], { RELEASE_KIT_ALLOW_DIRECT_PUSH: '1' })
  assert.equal(forced.status, 0, forced.stderr)
  assert.match(forced.stderr, /RELEASE_KIT_ALLOW_DIRECT_PUSH=1, so this push goes through/)
  assert.equal(remoteMain(), run(repo, 'git', ['rev-parse', 'HEAD']).trim())
  const log = join(repo, '.git/release-kit/direct-push.log')
  assert.ok(existsSync(log))
  const entry = JSON.parse(readFileSync(log, 'utf8').trim().split('\n').pop())
  assert.equal(entry.who, 't@t')
  assert.equal(entry.allowed[0].ref, 'refs/heads/main')

  commit(repo, 'fix: from a workflow')
  assert.equal(attempt(repo, 'git', ['push', '-q', 'origin', 'main'], { GITHUB_ACTIONS: 'true' }).status, 0)
})

test('end to end: npm run release -- --push goes through the guard; a hand-made release commit does not', () => {
  const { repo, remoteMain } = setup()
  commit(repo, 'feat: something new')
  commit(repo, 'fix: a user-facing fix')
  // Merged through pull requests, as far as the remote knows.
  run(repo, 'git', ['push', '-q', '--no-verify', 'origin', 'main'])

  const released = attempt(repo, 'node', [join(KIT, 'template/scripts/release-kit/release.mjs'), '--push', '--no-check'])
  assert.equal(released.status, 0, released.stderr)
  assert.match(released.stdout, /pushed v1\.1\.0/)
  assert.equal(remoteMain(), run(repo, 'git', ['rev-parse', 'HEAD']).trim())

  // The same kind of commit, made by hand.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.1.1' }, null, 2))
  run(repo, 'git', ['commit', '-q', '-am', 'chore(release): v1.1.1'])
  const byHand = attempt(repo, 'git', ['push', 'origin', 'main'])
  assert.notEqual(byHand.status, 0)
  assert.match(byHand.stderr, /release commit for v1\.1\.1 by hand/)
})

test('install-guard leaves a pre-push hook of the repo\'s own alone', () => {
  const repo = makeRepo(tmp('guard-own'))
  writeFileSync(join(repo, '.git/hooks/pre-push'), '#!/bin/sh\nnpm test\n', { mode: 0o755 })
  const result = attempt(repo, 'node', [join(KIT, 'bin/release-kit.mjs'), 'install-guard'])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a pre-push hook of its own/)
  assert.equal(readFileSync(join(repo, '.git/hooks/pre-push'), 'utf8'), '#!/bin/sh\nnpm test\n')
})
