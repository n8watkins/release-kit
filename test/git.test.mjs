// End to end: the git edge cases, against throwaway repos.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, commit, makeRepo, run, tmp } from './helpers.mjs'

const SCRIPTS = 'scripts/release-kit'
const applied = (options) => {
  const repo = makeRepo(tmp('git'), options)
  run(KIT, 'node', ['apply.mjs', repo])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  return repo
}

test('the previous release is the highest vX.Y.Z on the branch, whatever else is tagged', () => {
  const repo = applied({ version: '2.0.0' })
  run(repo, 'git', ['tag', 'v1.9.0', 'HEAD~1'])
  commit(repo, 'feat: a')
  run(repo, 'git', ['tag', '-a', 'v2.0.0', '-m', 'v2.0.0', 'HEAD~1'])
  run(repo, 'git', ['tag', 'v1.0.0']) // a stray old tag on the newest commit: git describe would pick it
  run(repo, 'git', ['tag', 'v3.0.0-beta.1'])
  run(repo, 'git', ['tag', 'vnext'])
  run(repo, 'git', ['switch', '-q', '-c', 'side'])
  commit(repo, 'feat: elsewhere')
  run(repo, 'git', ['tag', 'v9.0.0'])
  run(repo, 'git', ['switch', '-q', 'main'])
  const dry = run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run'])
  assert.match(dry, /2\.0\.0 -> 2\.1\.0 \(minor\), 1 commits since v2\.0\.0/)
  assert.equal(run(repo, 'node', [`${SCRIPTS}/notes.mjs`]), '### Features\n\n- A\n')
})

test('a long history without a tag (more than 1 MB of git log) still lists every commit', () => {
  const repo = makeRepo(tmp('long'))
  // 3000 commits with 500-byte bodies, written in one go with git fast-import.
  const body = 'x'.repeat(500)
  let stream = ''
  for (let i = 1; i <= 3000; i++) {
    const message = `${i % 3 ? 'docs' : 'fix'}: change ${i}\n\n${body}\n`
    stream += `commit refs/heads/main\ncommitter T <t@t> ${1700000000 + i} +0000\ndata ${Buffer.byteLength(message)}\n${message}${i === 1 ? 'from refs/heads/main^0\n' : ''}M 644 inline n.txt\ndata ${String(i).length}\n${i}\n`
  }
  const proc = attempt(repo, 'git', ['fast-import', '--quiet'], {}, stream)
  assert.equal(proc.status, 0)
  run(KIT, 'node', ['apply.mjs', repo])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  const dry = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run'])
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stderr, /no release tag yet/)
  assert.match(dry.stdout, /1\.0\.0 -> 1\.0\.1 \(patch\), 3002 commits since the start/)
  assert.equal(dry.stdout.match(/^- Change \d+$/gm).length, 1000)
  assert.equal(attempt(repo, 'node', [`${SCRIPTS}/commit-msg.mjs`, '--range', '..HEAD']).status, 0)
})

test('tag names and refs are checked before git or the shell sees them', () => {
  const repo = applied()
  for (const tag of ['v1.0.0$(touch pwned)', 'v1.0.0;id', '--help', 'v1.0.0-beta']) {
    const result = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--verify-tag', tag])
    assert.notEqual(result.status, 0, tag)
    assert.match(result.stderr, /is not a release tag/, tag)
  }
  const missing = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--verify-tag'])
  assert.match(missing.stderr, /is not a release tag/)
  // A baseline ref that looks like an option is a ref, not an option.
  const option = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--baseline', '-p'])
  assert.notEqual(option.status, 0)
  assert.match(option.stderr, /"-p" is not a commit/)
  // A version that isn't x.y.z never becomes a tag.
  const odd = makeRepo(tmp('odd'), { version: '1.0.0-rc.1' })
  run(KIT, 'node', ['apply.mjs', odd])
  assert.match(attempt(odd, 'node', [`${SCRIPTS}/release.mjs`, '--baseline']).stderr, /has version "1\.0\.0-rc\.1", not x\.y\.z/)
  assert.equal(run(odd, 'git', ['tag', '--list']), '')
})

test('the hook accepts CRLF and BOM messages, and git commit -v', () => {
  const repo = applied()
  writeFileSync(join(repo, 'x.txt'), 'x')
  run(repo, 'git', ['add', 'x.txt'])
  writeFileSync(join(repo, '.msg'), '﻿feat: written on Windows\r\n\r\nA body.\r\n')
  run(repo, 'git', ['commit', '-q', '-F', '.msg'])
  // An editor that leaves git commit -v's diff below the scissors line.
  writeFileSync(join(repo, 'y.txt'), 'Added a line')
  run(repo, 'git', ['add', 'y.txt'])
  const editor = join(repo, '.git', 'editor.sh')
  writeFileSync(editor, '#!/bin/sh\nprintf "fix: verbose commit\\n%s" "$(cat "$1")" > "$1.new" && mv "$1.new" "$1"\n', { mode: 0o755 })
  run(repo, 'git', ['commit', '-q', '-v'], { GIT_EDITOR: editor })
  // git keeps the BOM in the stored message; the notes don't show it.
  assert.match(run(repo, 'git', ['log', '-2', '--format=%s']), /^fix: verbose commit\n\uFEFF?feat: written on Windows\n$/)
  assert.equal(run(repo, 'node', [`${SCRIPTS}/notes.mjs`, '--from', 'HEAD~2']), '### Features\n\n- Written on Windows\n\n### Fixes\n\n- Verbose commit\n')
  // A Windows line ending doesn't let a bad message through.
  writeFileSync(join(repo, 'z.txt'), 'z')
  run(repo, 'git', ['add', 'z.txt'])
  writeFileSync(join(repo, '.msg'), 'Added a thing\r\n')
  const rejected = attempt(repo, 'git', ['commit', '-q', '-F', '.msg'])
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Commit message check failed/)
})

test('only a real baseline tag is skipped by the Release workflow', () => {
  const repo = applied({ version: '1.0.0' })
  run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--baseline'])
  assert.equal(run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--tag-kind', 'v1.0.0']), 'baseline=true\n')
  // A release whose notes mention the phrase is still a release.
  commit(repo, 'fix: say "release-kit baseline: tagged when adopting" in the docs')
  commit(repo, 'docs: x\n\nrelease-kit baseline: tagged when adopting release-kit; no GitHub Release.')
  run(repo, 'node', [`${SCRIPTS}/release.mjs`])
  assert.match(run(repo, 'git', ['tag', '-l', '--format=%(contents)', 'v1.0.1']), /release-kit baseline/)
  assert.equal(run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--tag-kind', 'v1.0.1']), 'baseline=false\n')
  assert.match(attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--tag-kind', 'v1;id']).stderr, /not a release tag/)
})

test('the changelog date is in .release.json timeZone', () => {
  for (const timeZone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const repo = applied()
    writeFileSync(join(repo, '.release.json'), JSON.stringify({ versionFiles: [], timeZone }))
    run(repo, 'git', ['commit', '-q', '-am', 'chore: set the time zone'])
    commit(repo, 'fix: a')
    const expected = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    assert.match(run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run']), new RegExp(`## 1\\.0\\.1 - ${expected}\\n`), timeZone)
  }
  const bad = applied()
  writeFileSync(join(bad, '.release.json'), JSON.stringify({ versionFiles: [], timeZone: 'Mars/Olympus' }))
  run(bad, 'git', ['commit', '-q', '-am', 'chore: set the time zone'])
  assert.match(attempt(bad, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run']).stderr, /timeZone "Mars\/Olympus" is not a time zone/)
})

test('--push checks origin and release:check first, and undoes the release if the push fails', () => {
  const root = tmp('push')
  run(root, 'git', ['init', '-q', '--bare', '-b', 'main', 'remote.git'])
  const remote = join(root, 'remote.git')
  const repo = applied({ version: '1.0.0', scripts: { build: 'echo build' } })
  run(repo, 'git', ['remote', 'add', 'origin', remote])
  run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--baseline'])
  run(repo, 'git', ['push', '-q', '--atomic', 'origin', 'main', 'v1.0.0'])
  const state = () => [run(repo, 'git', ['rev-parse', 'HEAD']).trim(), run(repo, 'git', ['tag', '--list']).trim(), JSON.parse(run(repo, 'git', ['show', 'HEAD:package.json'])).version]

  // Behind origin: stop before committing anything.
  const other = join(root, 'other')
  run(root, 'git', ['clone', '-q', remote, other])
  commit(other, 'fix: from elsewhere')
  run(other, 'git', ['push', '-q', 'origin', 'main'])
  commit(repo, 'fix: local')
  const before = state()
  const behind = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--push'])
  assert.notEqual(behind.status, 0)
  assert.match(behind.stderr, /main is behind origin\/main; pull/)
  assert.deepEqual(state(), before)
  run(repo, 'git', ['pull', '-q', '--rebase', 'origin', 'main'])

  // A failing release:check: nothing is committed or tagged.
  const pkg = JSON.parse(run(repo, 'cat', ['package.json']))
  pkg.scripts['release:check'] = 'exit 3'
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2))
  run(repo, 'git', ['commit', '-q', '-am', 'chore: a check that fails'])
  const red = state()
  const failing = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--push'])
  assert.match(failing.stderr, /release:check failed; nothing was committed or tagged/)
  assert.deepEqual(state(), red)

  // The remote rejects the push: the release commit and tag are undone.
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch" >&2\nexit 1\n', { mode: 0o755 })
  const rejected = attempt(repo, 'node', [`${SCRIPTS}/release.mjs`, '--push', '--no-check'])
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /the push was rejected, so the release commit and v1\.0\.1 were undone/)
  assert.match(rejected.stderr, /protected branch/)
  assert.deepEqual(state(), red)
  assert.equal(run(repo, 'git', ['status', '--porcelain']), '')
  // And the rerun works once the remote accepts it.
  run(repo, 'rm', [join(remote, 'hooks', 'pre-receive')])
  assert.match(run(repo, 'node', [`${SCRIPTS}/release.mjs`, '--push', '--no-check']), /pushed v1\.0\.1/)
})
