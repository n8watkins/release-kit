// The commands' arguments, end to end: an option a command doesn't know, a
// typo of --dry-run above all, stops it before it reads or writes anything,
// and --help prints how to use it. Before this, `release-kit release --help`
// cut a real release (net_trailers, 2026-11-24).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, commit, makeRepo, run, tmp } from './helpers.mjs'

const BIN = join(KIT, 'bin/release-kit.mjs')
const SCRIPTS = join(KIT, 'template/scripts/release-kit')
const kit = (repo, ...args) => attempt(repo, 'node', [BIN, ...args])

/** A repo with a baseline tag and a feature to release: release has something to do. */
function ready() {
  const repo = makeRepo(tmp('cli'), { version: '1.6.0' })
  run(repo, 'node', [join(SCRIPTS, 'release.mjs'), '--baseline'])
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## 1.6.0\n\n- Written by hand.\n')
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'docs: the changelog so far'])
  commit(repo, 'feat: something new')
  return repo
}

/** Everything a release could change: HEAD, the tags, and the working tree. */
const snapshot = (repo) => ({
  head: run(repo, 'git', ['rev-parse', 'HEAD']).trim(),
  tags: run(repo, 'git', ['tag', '--list']),
  status: run(repo, 'git', ['status', '--porcelain']),
})

test('release with --help prints the usage and changes nothing', () => {
  const repo = ready()
  const before = snapshot(repo)
  for (const help of ['--help', '-h']) {
    const result = kit(repo, 'release', help)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^Cuts a release: bumps the version/, help)
    assert.match(result.stdout, /--dry-run/, help)
    assert.deepEqual(snapshot(repo), before, help)
  }
})

test('release with an option it does not know, a typo of --dry-run above all, stops before it writes anything', () => {
  const repo = ready()
  const before = snapshot(repo)
  for (const args of [['--dryrun'], ['--dry_run'], ['-n'], ['--push', '--dryrun'], ['--dry-run=true'], ['patch', 'minor'], ['--summary', 'Hi.', '--verbose']]) {
    const result = kit(repo, 'release', ...args)
    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.stderr, /^release: (unknown option|unexpected argument)/, args.join(' '))
    assert.match(result.stderr, /release --help lists what it takes/, args.join(' '))
    assert.deepEqual(snapshot(repo), before, args.join(' '))
  }
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '1.6.0')
  // The options it does know still work.
  const dry = kit(repo, 'release', '--dry-run', '--summary', 'Hi.')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /1\.6\.0 -> 1\.7\.0 \(minor\)/)
  assert.deepEqual(snapshot(repo), before)
})

test('every command prints its usage for --help and refuses an option it does not know', () => {
  const repo = ready()
  const before = snapshot(repo)
  const commands =['release', 'train', 'protect', 'backfill', 'notes', 'releases', 'lanes', 'alarm', 'commit-msg', 'apply', 'check', 'verify', 'install-guard']
  for (const command of commands) {
    const help = kit(repo, command, '--help')
    assert.equal(help.status, 0, `${command}: ${help.stderr}`)
    assert.ok(help.stdout.trim().length > 40, `${command} prints a usage`)
    const typo = kit(repo, command, '--bogus')
    assert.equal(typo.status, 1, command)
    assert.match(typo.stderr, /unknown option --bogus/, command)
  }
  // The workflows' own scripts too.
  for (const script of ['automerge.mjs', 'publish.mjs']) {
    const typo = attempt(repo, 'node', [join(SCRIPTS, script), '--bogus'])
    assert.equal(typo.status, 1, script)
    assert.match(typo.stderr, /unknown option --bogus/, script)
  }
  const top = kit(repo, '--help')
  assert.equal(top.status, 0)
  assert.match(top.stdout, /release-kit release \[\.\.\.\] {5}cut a release/)
  assert.deepEqual(snapshot(repo), before)
})

test('apply --dry-run (the dry run is --check) is refused instead of applying the kit', () => {
  const repo = makeRepo(tmp('cli-apply'))
  const result = kit(repo, 'apply', '.', '--dry-run')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /apply: unknown option --dry-run/)
  assert.equal(existsSync(join(repo, '.release.json')), false)
  assert.equal(run(repo, 'git', ['status', '--porcelain']), '')
})

test('with no release tag, release stops instead of releasing the whole history; a dry run warns, --whole-history releases it', () => {
  const repo = makeRepo(tmp('cli-untagged'), { version: '1.6.0' })
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## 1.6.0\n\n- Written by hand.\n')
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'docs: the changelog so far'])
  commit(repo, 'feat: something new')
  const before = snapshot(repo)

  const stopped = kit(repo, 'release')
  assert.equal(stopped.status, 1)
  assert.match(stopped.stderr, /no release tag yet, so the first release would list the whole history \(3 commits\): run npm run release -- --baseline first to start from here, or pass --whole-history/)
  assert.deepEqual(snapshot(repo), before)
  assert.match(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'), /^# Changelog\n\n## 1\.6\.0\n/)

  const dry = kit(repo, 'release', '--dry-run')
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stderr, /warning: no release tag yet/)
  assert.deepEqual(snapshot(repo), before)

  const whole = kit(repo, 'release', '--whole-history')
  assert.equal(whole.status, 0, whole.stderr)
  assert.doesNotMatch(whole.stderr, /no release tag yet/)
  assert.equal(run(repo, 'git', ['tag', '--list']).trim(), 'v1.7.0')
})

test('--baseline at a commit whose package.json has no version says how to tag it by hand, and that tag is a baseline', () => {
  const repo = makeRepo(tmp('cli-baseline'))
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2))
  run(repo, 'git', ['commit', '-q', '-am', 'chore: no version yet'])
  const old = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.7.0' }, null, 2))
  run(repo, 'git', ['commit', '-q', '-am', 'chore: a version'])

  const result = kit(repo, 'release', '--baseline', old)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /package\.json at [0-9a-f]+ has no version, not x\.y\.z/)
  const hint = /^ {2}(git tag -a vx\.y\.z .*)$/m.exec(result.stderr)?.[1]
  assert.ok(hint, result.stderr)
  assert.equal(run(repo, 'git', ['tag', '--list']), '')
  // The printed command, with the version filled in, makes a tag the kit reads as a baseline.
  run(repo, 'sh', ['-c', hint.replaceAll('vx.y.z', 'v1.6.0')])
  assert.equal(run(repo, 'node', [join(SCRIPTS, 'release.mjs'), '--tag-kind', 'v1.6.0']), 'baseline=true\n')
})
