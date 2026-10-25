// End to end: apply the kit to a throwaway repo, then commit and release in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KIT = new URL('..', import.meta.url).pathname
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
const attempt = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })

test('apply, then the hook, the release command and tag verification all work', () => {
  const repo = mkdtempSync(join(tmpdir(), 'release-kit-'))
  run(repo, 'git', ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0', scripts: { lint: 'echo lint', build: 'echo build' } }, null, 2))
  writeFileSync(join(repo, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'demo', version: '0.1.0' }, null, 2))
  writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n\n- Be nice.\n')
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'Initial commit'])

  const applied = run(KIT, 'node', ['apply.mjs', repo])
  assert.match(applied, /release-kit 1\.0\.0 applied/)
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['release:check'], 'npm run lint && npm run build')
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')).versionFiles, ['manifest.json'])
  assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /- Be nice\.[\s\S]*<!-- release-kit -->/)
  // Re-applying replaces the snippet instead of adding a second one.
  run(KIT, 'node', ['apply.mjs', repo])
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8').match(/<!-- release-kit -->/g).length, 1)

  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit 1.0.0'])

  // Baseline: tag the version the repo is already at, marked so the workflow
  // skips publishing it; the first release then starts from here.
  assert.match(run(repo, 'node', ['scripts/release-kit/release.mjs', '--baseline']), /tagged v0\.1\.0 at HEAD as a baseline/)
  assert.match(run(repo, 'git', ['tag', '-l', '--format=%(contents)', 'v0.1.0']), /release-kit baseline/)

  // The hook rejects a plain-sentence message.
  writeFileSync(join(repo, 'a.txt'), 'a')
  run(repo, 'git', ['add', 'a.txt'])
  const rejected = attempt(repo, 'git', ['commit', '-q', '-m', 'Added a thing'])
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Commit message check failed/)
  run(repo, 'git', ['commit', '-q', '-m', 'feat: add a thing'])
  writeFileSync(join(repo, 'b.txt'), 'b')
  run(repo, 'git', ['add', 'b.txt'])
  run(repo, 'git', ['commit', '-q', '-m', 'docs: explain the thing'])

  const dry = run(repo, 'node', ['scripts/release-kit/release.mjs', '--dry-run'])
  assert.match(dry, /0\.1\.0 -> 0\.2\.0 \(minor\), 2 commits since v0\.1\.0/)
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '0.1.0')

  run(repo, 'node', ['scripts/release-kit/release.mjs'])
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '0.2.0')
  assert.equal(JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8')).version, '0.2.0')
  assert.equal(run(repo, 'git', ['tag', '--list']).trim(), 'v0.1.0\nv0.2.0')
  assert.equal(run(repo, 'git', ['log', '-1', '--format=%s']).trim(), 'chore(release): v0.2.0')
  const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^# Changelog\n\n## 0\.2\.0 - \d{4}-\d{2}-\d{2}\n\n### Features\n\n- Add a thing/)
  assert.doesNotMatch(changelog, /explain the thing/)

  // CI's checks: the tag matches every version file; the range check passes.
  assert.match(run(repo, 'node', ['scripts/release-kit/release.mjs', '--verify-tag', 'v0.2.0']), /matches package\.json, manifest\.json/)
  const mismatch = attempt(repo, 'node', ['scripts/release-kit/release.mjs', '--verify-tag', 'v0.3.0'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /does not match/)
  assert.equal(attempt(repo, 'node', ['scripts/release-kit/commit-msg.mjs', '--range', 'HEAD~3..HEAD']).status, 0)
  // Notes for the tag, as the workflow builds them.
  assert.match(run(repo, 'node', ['scripts/release-kit/notes.mjs', '--to', 'v0.2.0']), /### Features\n\n- Add a thing/)

  // Run through a symlinked scripts folder (as this kit runs itself), the notes still print.
  run(repo, 'ln', ['-s', 'scripts/release-kit', 'linked-kit'])
  assert.match(run(repo, 'node', ['linked-kit/notes.mjs', '--to', 'v0.2.0']), /### Features/)
  run(repo, 'rm', ['linked-kit'])

  // Nothing new to release.
  const empty = attempt(repo, 'node', ['scripts/release-kit/release.mjs'])
  assert.match(empty.stderr, /nothing to release/)
  assert.ok(existsSync(join(repo, 'RELEASING.md')))
})
