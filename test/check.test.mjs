// apply --check: a dry run that compares what apply would write at this kit
// version with what the repo has, and the warnings release-kit check and
// release-kit verify give from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, KIT_VERSION, attempt, makeRepo, run, tmp } from './helpers.mjs'

const check = (repo, ...args) => attempt(KIT, 'node', ['apply.mjs', repo, '--check', ...args])
const status = (repo) => run(repo, 'git', ['status', '--porcelain'])
const v = KIT_VERSION.replaceAll('.', '\\.')

/** A repo apply has run in, with everything committed. */
function applied(name, setup = () => {}) {
  const repo = makeRepo(tmp(name))
  setup(repo)
  run(KIT, 'node', ['apply.mjs', repo])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  return repo
}

test('apply --check exits 0 on a repo that has every file apply writes, and writes nothing', () => {
  const repo = applied('check-clean')
  const result = check(repo)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, new RegExp(`release-kit v${v}: .* has every file apply writes, up to date`))
  assert.equal(status(repo), '')
})

test('apply --check exits 1 and lists a file apply would add, change or remove, without writing it', () => {
  const repo = applied('check-drift')
  rmSync(join(repo, '.github/workflows/security.yml'))
  const autoMerge = join(repo, '.github/workflows/auto-merge.yml')
  writeFileSync(autoMerge, readFileSync(autoMerge, 'utf8').replace('dependabot[bot],', ''))
  // A leftover copy of the scripts, which package mode runs from node_modules instead.
  mkdirSync(join(repo, 'scripts/release-kit'), { recursive: true })
  writeFileSync(join(repo, 'scripts/release-kit/release.mjs'), '// old copy\n')
  const before = status(repo)

  const result = check(repo)
  assert.equal(result.status, 1)
  assert.match(result.stdout, new RegExp(`^release-kit v${v} adds or changes 3 files; run npx release-kit apply \\.$`, 'm'))
  assert.match(result.stdout, /^ {2}added {3}\.github\/workflows\/security\.yml$/m)
  assert.match(result.stdout, /^ {2}changed \.github\/workflows\/auto-merge\.yml$/m)
  assert.match(result.stdout, /^ {2}removed scripts\/release-kit\/release\.mjs$/m)
  assert.equal(status(repo), before, '--check changed the repo')

  const json = check(repo, '--json')
  assert.equal(json.status, 1)
  const report = JSON.parse(json.stdout)
  assert.equal(report.check, true)
  assert.deepEqual(report.files, { added: ['.github/workflows/security.yml'], changed: ['.github/workflows/auto-merge.yml'], removed: ['scripts/release-kit/release.mjs'] })

  // Running apply clears it.
  run(KIT, 'node', ['apply.mjs', repo])
  assert.equal(check(repo).status, 0)
})

test('apply --check counts a hook that lost its executable bit, as apply would restore it', () => {
  const repo = applied('check-mode')
  chmodSync(join(repo, '.githooks/commit-msg'), 0o644)
  const result = check(repo)
  assert.equal(result.status, 1)
  assert.match(result.stdout, /adds or changes 1 file;/)
  assert.match(result.stdout, /changed \.githooks\/commit-msg/)
})

test("apply --check ignores what apply deliberately leaves alone: a repo's own release.yml, dependabot.yml and hooks path", () => {
  const repo = applied('check-kept', (dir) => {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true })
    writeFileSync(join(dir, '.github/workflows/release.yml'), 'name: Release\non: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx release-kit release\n')
    writeFileSync(join(dir, '.github/dependabot.yml'), 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n    schedule:\n      interval: weekly\n')
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    pkg.scripts.prepare = 'git config core.hooksPath tools/hooks || true'
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
  })
  // apply kept all three: the repo's own files, and no .githooks.
  assert.match(readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8'), /^name: Release/)
  assert.match(readFileSync(join(repo, '.github/dependabot.yml'), 'utf8'), /^version: 2/)
  assert.throws(() => readFileSync(join(repo, '.githooks/commit-msg')))

  const result = check(repo)
  assert.equal(result.status, 0, result.stdout)
  assert.match(result.stdout, /up to date/)
})

test('release-kit check warns when the files are behind, and is quiet once apply has run', () => {
  const repo = applied('check-warn')
  const kitCheck = () => attempt(repo, 'node', [join(KIT, 'bin/release-kit.mjs'), 'check'])
  const clean = kitCheck()
  assert.equal(clean.status, 0)
  assert.match(clean.stdout, /up to date/)
  assert.doesNotMatch(clean.stderr, /adds or changes/)

  rmSync(join(repo, '.github/workflows/security.yml'))
  const behind = kitCheck()
  assert.equal(behind.status, 0, 'check warns, never fails')
  assert.match(behind.stderr, new RegExp(`release-kit: release-kit v${v} adds or changes 1 file; run npx release-kit apply \\. \\(added \\.github/workflows/security\\.yml\\)`))
})

test('release-kit verify warns about files that are behind, with an annotation in CI, and still passes', () => {
  const repo = applied('check-verify')
  run(repo, 'mkdir', ['-p', 'node_modules/.bin'])
  run(repo, 'ln', ['-s', KIT, 'node_modules/release-kit'])
  const lock = { name: 'demo', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'demo', version: '1.0.0' }, 'node_modules/release-kit': { version: KIT_VERSION, resolved: `git+ssh://git@github.com/n8watkins/release-kit.git#${'a'.repeat(40)}`, dev: true } } }
  writeFileSync(join(repo, 'package-lock.json'), JSON.stringify(lock, null, 2))
  const summary = join(tmp('check-summary'), 'summary.md')
  const verify = () => attempt(repo, 'node', [join(KIT, 'bin/release-kit.mjs'), 'verify'], { ACTIONLINT: join(repo, 'no-actionlint'), GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary })

  const clean = verify()
  assert.equal(clean.status, 0, clean.stderr)
  assert.match(clean.stdout, /files ok/)

  rmSync(join(repo, '.github/workflows/security.yml'))
  const behind = verify()
  assert.equal(behind.status, 0, behind.stderr)
  assert.match(behind.stderr, /files: warning: release-kit v.* adds or changes 1 file; run npx release-kit apply \./)
  assert.match(behind.stdout, /^::warning title=release-kit files are behind::release-kit v.* adds or changes 1 file/m)
  assert.match(readFileSync(summary, 'utf8'), /release-kit files are behind[\s\S]*added \.github\/workflows\/security\.yml/)
})

test('apply --check rejects a repo without a package.json, like apply', () => {
  const result = check(tmp('check-empty'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /the repo needs a package\.json/)
})
