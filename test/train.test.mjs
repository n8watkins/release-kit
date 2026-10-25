// End to end: the release train's steps, run the way its workflow runs them,
// against a throwaway repo and a bare "GitHub" remote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, bot, commit, makeRepo, outputs, run, tmp } from './helpers.mjs'

const SCRIPTS = 'scripts/release-kit'

/** A repo that adopted the kit with the train, baselined at 1.1.0, pushed to a bare remote. */
function adopted() {
  const root = tmp('train')
  run(root, 'git', ['init', '-q', '--bare', '-b', 'main', 'remote.git'])
  const dev = makeRepo(join(root, 'dev'), { version: '1.1.0' })
  run(KIT, 'node', ['apply.mjs', dev, '--train'])
  run(dev, 'git', ['add', '-A'])
  run(dev, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  run(dev, 'node', [`${SCRIPTS}/release.mjs`, '--baseline'])
  run(dev, 'git', ['remote', 'add', 'origin', join(root, 'remote.git')])
  run(dev, 'git', ['push', '-q', '--atomic', 'origin', 'main', 'v1.1.0'])
  return { root, dev, remote: join(root, 'remote.git') }
}

/** What the workflow's checkout gives a job: a fresh full clone on main. */
function checkout(root, remote, name) {
  const dir = join(root, name)
  run(root, 'git', ['clone', '-q', remote, dir])
  return dir
}

const plan = (dir, bump) => {
  const result = attempt(dir, 'node', [`${SCRIPTS}/release.mjs`, '--plan', ...(bump ? [bump] : [])])
  return { ...result, out: result.status === 0 ? outputs(result.stdout) : null }
}

/** The cut job: the planned commit on main, the bot's identity, release.mjs <version> --push. */
function cut(dir, { sha, version }) {
  run(dir, 'git', ['switch', '-q', '--force-create', 'main', sha])
  run(dir, 'git', ['config', 'user.name', 'github-actions[bot]'])
  run(dir, 'git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
  return attempt(dir, 'node', [`${SCRIPTS}/release.mjs`, version, '--push'], bot)
}

test('a week of chores releases nothing; a fix releases a patch; the next run finds nothing (no loop)', () => {
  const { root, dev, remote } = adopted()

  commit(dev, 'docs: explain the build')
  commit(dev, 'chore: tidy')
  run(dev, 'git', ['push', '-q', 'origin', 'main'])
  const quiet = plan(checkout(root, remote, 'week1'))
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.equal(quiet.out.release, 'false')
  assert.match(quiet.out.reason, /2 commits since the last release, none user-facing/)
  assert.equal(quiet.out.since, 'v1.1.0')
  assert.equal(quiet.out.version, undefined)

  commit(dev, 'fix(nav): keep the menu open')
  run(dev, 'git', ['push', '-q', 'origin', 'main'])
  const week2 = checkout(root, remote, 'week2')
  const planned = plan(week2)
  assert.equal(planned.status, 0, planned.stderr)
  assert.deepEqual({ ...planned.out, sha: undefined }, {
    release: 'true', reason: '1 user-facing of 3 commits', since: 'v1.1.0', sha: undefined, commits: '3', bump: 'patch', version: '1.1.1', tag: 'v1.1.1',
  })
  assert.equal(planned.out.sha, run(week2, 'git', ['rev-parse', 'HEAD']).trim())

  const pushed = cut(checkout(root, remote, 'cut2'), planned.out)
  assert.equal(pushed.status, 0, pushed.stderr)
  assert.match(run(root, 'git', ['--git-dir', remote, 'tag', '--list']), /^v1\.1\.0\nv1\.1\.1$/m)
  const head = run(root, 'git', ['--git-dir', remote, 'log', '-1', '--format=%an|%s', 'main']).trim()
  assert.equal(head, 'github-actions[bot]|chore(release): v1.1.1')
  // The tag is on the release commit, which sits on the planned commit.
  assert.equal(run(root, 'git', ['--git-dir', remote, 'rev-parse', 'v1.1.1^{commit}']).trim(), run(root, 'git', ['--git-dir', remote, 'rev-parse', 'main']).trim())
  assert.equal(run(root, 'git', ['--git-dir', remote, 'rev-parse', 'main~1']).trim(), planned.out.sha)

  // The Release workflow's view of the new tag: it matches package.json, and the notes list the fix only.
  const release = checkout(root, remote, 'release')
  run(release, 'git', ['checkout', '-q', 'v1.1.1'])
  assert.match(run(release, 'node', [`${SCRIPTS}/release.mjs`, '--verify-tag', 'v1.1.1']), /matches package\.json/)
  assert.equal(run(release, 'node', [`${SCRIPTS}/notes.mjs`, '--to', 'v1.1.1']), '### Fixes\n\n- **nav:** Keep the menu open\n')
  assert.match(readFileSync(join(release, 'CHANGELOG.md'), 'utf8'), /^# Changelog\n\n## 1\.1\.1 - \d{4}-\d{2}-\d{2}\n\n### Fixes\n\n- \*\*nav:\*\* Keep the menu open\n/)

  // The commit check, on the next push that includes the bot's release commit, passes.
  const next = checkout(root, remote, 'next')
  commit(next, 'feat: a new page')
  assert.equal(attempt(next, 'node', [`${SCRIPTS}/commit-msg.mjs`, '--range', 'v1.1.0..HEAD']).status, 0)

  // Straight after the release, the train finds nothing: its own commit doesn't count.
  const after = plan(checkout(root, remote, 'week3'))
  assert.equal(after.out.release, 'false')
  assert.equal(after.out.reason, 'no commits since the last release')
  assert.equal(after.out.since, 'v1.1.1')
})

test('if main moves between the plan and the cut, the push is rejected and nothing is tagged', () => {
  const { root, dev, remote } = adopted()
  commit(dev, 'feat: a')
  run(dev, 'git', ['push', '-q', 'origin', 'main'])
  const planned = plan(checkout(root, remote, 'plan'))
  assert.equal(planned.out.version, '1.2.0')
  const cutDir = checkout(root, remote, 'cut')
  commit(dev, 'fix: landed during the checks')
  run(dev, 'git', ['push', '-q', 'origin', 'main'])

  const pushed = cut(cutDir, planned.out)
  assert.notEqual(pushed.status, 0)
  assert.doesNotMatch(run(root, 'git', ['--git-dir', remote, 'tag', '--list']), /v1\.2\.0/)
  assert.equal(run(root, 'git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'main']).trim(), 'fix: landed during the checks')
})

test('an explicit bump from "Run workflow" releases even without user-facing work', () => {
  const { root, dev, remote } = adopted()
  commit(dev, 'docs: a')
  run(dev, 'git', ['push', '-q', 'origin', 'main'])
  const dir = checkout(root, remote, 'plan')
  assert.equal(plan(dir).out.release, 'false')
  assert.deepEqual([plan(dir, 'minor').out.release, plan(dir, 'minor').out.version], ['true', '1.2.0'])
  assert.equal(plan(dir, 'auto').out.release, 'false')
  const bad = plan(dir, 'huge')
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /unknown bump "huge"/)
})

test('the train refuses to guess: no tag, a moved tag, a stray version or a side branch stop it', () => {
  // No release tag yet.
  const fresh = makeRepo(tmp('notag'))
  run(KIT, 'node', ['apply.mjs', fresh, '--train'])
  run(fresh, 'git', ['add', '-A'])
  run(fresh, 'git', ['commit', '-q', '-m', 'feat: everything'])
  const none = plan(fresh)
  assert.notEqual(none.status, 0)
  assert.match(none.stderr, /no release tag yet.*--baseline/)
  assert.equal(none.stdout, '')

  // The tag for package.json's version was moved off main.
  const { dev } = adopted()
  run(dev, 'git', ['switch', '-q', '-c', 'side'])
  commit(dev, 'chore: elsewhere')
  run(dev, 'git', ['tag', '-f', '-a', 'v1.1.0', '-m', 'v1.1.0'])
  run(dev, 'git', ['switch', '-q', 'main'])
  commit(dev, 'fix: a')
  const moved = plan(dev)
  assert.notEqual(moved.status, 0)
  assert.match(moved.stderr, /tag v1\.1\.0 exists but is not on main's history/)
  // A manual release stops on it too.
  assert.match(attempt(dev, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run']).stderr, /is not on main's history/)
  run(dev, 'git', ['tag', '-f', '-a', 'v1.1.0', '-m', 'v1.1.0', 'main~1'])
  assert.equal(plan(dev).out.version, '1.1.1')

  // package.json was bumped by hand past the last tag: a manual release warns, the train stops.
  run(dev, 'npm', ['version', '1.4.0', '--no-git-tag-version'])
  run(dev, 'git', ['commit', '-q', '-am', 'chore: bump by hand'])
  assert.match(plan(dev).stderr, /package\.json is 1\.4\.0 but the newest release tag on main is v1\.1\.0/)
  const manual = attempt(dev, 'node', [`${SCRIPTS}/release.mjs`, '--dry-run'])
  assert.equal(manual.status, 0)
  assert.match(manual.stderr, /warning: package\.json is 1\.4\.0/)
  assert.match(manual.stdout, /1\.4\.0 -> 1\.4\.1/)

  // Only main or master.
  run(dev, 'git', ['switch', '-q', '-c', 'feature'])
  assert.match(plan(dev).stderr, /releases are cut from main or master, not "feature"/)
})
