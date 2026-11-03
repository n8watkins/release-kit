// The CI lane classifier, against real diffs: the fixtures' lock files are
// what npm wrote for a release-kit bump, a dev dependency bump and a
// dependency bump.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, makeRepo, outputs, run, tmp } from './helpers.mjs'
import { classify, globToRegExp } from '../template/scripts/release-kit/lanes.mjs'

const FIXTURES = join(KIT, 'test/fixtures/lanes')
const fixture = (name, path) => readFileSync(join(FIXTURES, name, path), 'utf8')
const LANES = join(KIT, 'template/scripts/release-kit/lanes.mjs')

/** A repo at the base fixture, with a branch that adds the `name` fixture on top; returns its lane outputs. */
function lanesFor(name, { event = 'pull_request' } = {}) {
  const repo = makeRepo(tmp(`lanes-${name}`))
  cpSync(join(FIXTURES, 'base'), repo, { recursive: true })
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: base'])
  const base = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  run(repo, 'git', ['switch', '-q', '-c', 'change'])
  cpSync(join(FIXTURES, name), repo, { recursive: true })
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', `chore: ${name}`])
  // main moves on meanwhile: the classifier diffs from the merge base, not the base tip.
  run(repo, 'git', ['switch', '-q', 'main'])
  run(repo, 'git', ['commit', '-q', '--allow-empty', '-m', 'chore: elsewhere'])
  const tip = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  const head = run(repo, 'git', ['rev-parse', 'change']).trim()
  const result = attempt(repo, 'node', [LANES, '--event', event, '--base', tip, '--head', head])
  assert.equal(result.status, 0, result.stderr)
  return { ...outputs(result.stdout), log: result.stderr, base }
}

test('a release-kit update (the dev dependency, its lock entries and the workflow pins) runs the kit lane', () => {
  const out = lanesFor('kit-update')
  assert.deepEqual({ ...out, log: undefined, base: undefined }, { lane: 'kit', docs: 'false', kit: 'true', checks: 'false', full: 'false', ci: 'false', log: undefined, base: undefined })
  assert.match(out.log, /kit {2}package-lock\.json: the release-kit dev dependency/)
  assert.match(out.log, /kit {2}\.github\/workflows\/commits\.yml: a kit-owned workflow/)
})

test('a dev dependency bump runs the checks but not the full suite', () => {
  const out = lanesFor('dev-dependency')
  assert.equal(out.lane, 'deps')
  assert.equal(out.checks, 'true')
  assert.equal(out.full, 'false')
  assert.equal(out.kit, 'false')
  assert.match(out.log, /package-lock\.json: dev packages: typescript/)
})

test('a dependency that ships runs everything', () => {
  const out = lanesFor('prod-dependency')
  assert.equal(out.lane, 'full')
  assert.match(out.log, /package\.json: changes dependencies/)
  assert.match(out.log, /package-lock\.json: (the root entry's dependencies|non-dev packages: ms)/)
})

test('docs only skip the checks; docs with code run everything; a CI file sets ci', () => {
  const docs = lanesFor('docs')
  assert.deepEqual([docs.lane, docs.docs, docs.checks], ['docs', 'true', 'false'])
  assert.equal(lanesFor('mixed').lane, 'full')
  const ci = lanesFor('ci-file')
  assert.deepEqual([ci.lane, ci.ci, ci.full], ['full', 'true', 'true'])
})

test('a push, a manual run, or a base that cannot be found runs everything', () => {
  for (const event of ['push', 'workflow_dispatch', 'schedule']) {
    const out = lanesFor('docs', { event })
    assert.equal(out.lane, 'full', event)
    assert.match(out.log, new RegExp(`a ${event} run checks everything`))
  }
  const repo = makeRepo(tmp('lanes-nobase'))
  const missing = attempt(repo, 'node', [LANES, '--event', 'pull_request', '--base', 'f'.repeat(40), '--head', 'HEAD'])
  assert.equal(missing.status, 0)
  assert.equal(outputs(missing.stdout).lane, 'full')
  assert.match(missing.stderr, /could not classify the change/)
  assert.equal(outputs(attempt(repo, 'node', [LANES, '--event', 'pull_request', '--base', '$(id)']).stdout).lane, 'full')
})

test('classify: fullFor, the lanes settings, a workflow that only borrows the kit\'s name, and edge cases', () => {
  const lock = (name) => ({ path: 'package-lock.json', base: fixture('base', 'package-lock.json'), head: fixture(name, 'package-lock.json') })
  const pkg = (name) => ({ path: 'package.json', base: fixture('base', 'package.json'), head: fixture(name, 'package.json') })
  // A dev dependency the repo lists in lanes.fullFor (its bundler, its test runner) runs everything.
  assert.equal(classify([pkg('dev-dependency'), lock('dev-dependency')], { lanes: { fullFor: ['typescript'] } }).lane, 'full')
  // A release-kit bump in a subfolder's package.json is just a dev dependency there.
  assert.equal(classify([{ ...pkg('kit-update'), path: 'app/package.json' }]).lane, 'deps')
  // Changing the classifier's own settings runs everything; other kit settings don't.
  const config = (lanes) => JSON.stringify({ versionFiles: [], ...(lanes ? { lanes } : {}) })
  assert.equal(classify([{ path: '.release.json', base: config(), head: config({ docs: ['site/**'] }) }]).lane, 'full')
  assert.equal(classify([{ path: '.release.json', base: config(), head: JSON.stringify({ versionFiles: ['manifest.json'] }) }]).lane, 'kit')
  // A repo workflow named like a kit one, without the kit's marker, is the repo's own.
  assert.equal(classify([{ path: '.github/workflows/release.yml', base: 'name: Release\n', head: 'name: Release 2\n' }]).ci, true)
  // lanes.docs widens the docs lane.
  assert.equal(classify([{ path: 'site/content/post.yml', base: 'a', head: 'b' }], { lanes: { docs: ['site/content/**'] } }).lane, 'docs')
  // Nothing changed, an unreadable lock, a new or deleted package.json: run everything.
  assert.equal(classify([]).lane, 'full')
  assert.equal(classify([{ path: 'package-lock.json', base: '{', head: '{}' }]).lane, 'full')
  assert.equal(classify([{ path: 'package.json', base: null, head: '{}' }]).lane, 'full')
  assert.equal(classify([{ path: '.github/dependabot.yml', base: 'a', head: 'b' }]).lane, 'kit')
  // The hooks apply writes, the pre-push guard included (v2.4.0 added it).
  for (const path of ['.githooks/commit-msg', '.githooks/pre-push', '.husky/pre-push']) assert.equal(classify([{ path, base: null, head: '# release-kit' }]).lane, 'kit', path)
  // The auto-merge workflow and the Direct push alarm apply writes: added or re-pinned, they are kit files;
  // a hand-copied auto-merge.yml without the marker is the repo's own.
  for (const name of ['auto-merge.yml', 'direct-push.yml']) {
    const path = `.github/workflows/${name}`
    assert.equal(classify([{ path, base: null, head: '# release-kit: x\n' }]).lane, 'kit', `${name} added`)
    assert.equal(classify([{ path, base: '# release-kit: x\n@v2.4.0\n', head: '# release-kit: x\n@v2.5.0\n' }]).lane, 'kit', `${name} re-pinned`)
  }
  assert.equal(classify([{ path: '.github/workflows/auto-merge.yml', base: 'name: Auto-merge\n', head: 'name: Auto-merge\n# v2\n' }]).lane, 'full')
})

test('globs match paths the way the docs lane needs', () => {
  assert.ok(globToRegExp('**/*.md').test('README.md'))
  assert.ok(globToRegExp('**/*.md').test('docs/a/b.md'))
  assert.ok(!globToRegExp('**/*.md').test('README.mdx'))
  assert.ok(globToRegExp('docs/**').test('docs/img/a.png'))
  assert.ok(!globToRegExp('docs/**').test('src/docs.js'))
  assert.ok(globToRegExp('LICENSE.*').test('LICENSE.txt'))
  assert.ok(!globToRegExp('a.b').test('aXb'))
})
