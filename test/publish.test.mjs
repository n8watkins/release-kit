// The Release workflow's publish step, which a retried run must finish
// instead of failing on "release already exists".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, tmp } from './helpers.mjs'
import { publishPlan } from '../template/scripts/release-kit/publish.mjs'

const SUMS = 'abc  app.zip\n'

test('publishPlan: create, finish, replace an unverified upload, or refuse to swap published files', () => {
  const local = { assets: ['SHA256SUMS.txt', 'app.zip'], sums: SUMS }
  assert.deepEqual(publishPlan(null, local), { action: 'create', upload: ['SHA256SUMS.txt', 'app.zip'], clobber: false })
  // Same files already published (the run failed after uploading): nothing to upload.
  assert.deepEqual(publishPlan({ assets: ['SHA256SUMS.txt', 'app.zip'], sums: SUMS }, local), { action: 'update', upload: [], clobber: false })
  // The checksum list made it, one file didn't.
  assert.deepEqual(publishPlan({ assets: ['SHA256SUMS.txt'], sums: SUMS }, local), { action: 'update', upload: ['app.zip'], clobber: false })
  // Files but no checksum list: an upload that stopped half way, never verified.
  assert.deepEqual(publishPlan({ assets: ['app.zip'], sums: null }, local), { action: 'update', upload: ['SHA256SUMS.txt', 'app.zip'], clobber: true })
  // A release with no files, rerun for a repo that ships none.
  assert.deepEqual(publishPlan({ assets: [], sums: null }, { assets: [], sums: null }), { action: 'update', upload: [], clobber: false })
  // Published files that differ from this build are never swapped.
  assert.match(publishPlan({ assets: ['SHA256SUMS.txt', 'app.zip'], sums: 'def  app.zip\n' }, local).error, /different files than this build/)
  assert.match(publishPlan({ assets: ['SHA256SUMS.txt', 'app.zip'], sums: SUMS }, { assets: [], sums: null }).error, /this run built none/)
})

// A fake gh that keeps one release in a JSON file.
const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const { basename, join } = require('node:path')
const args = process.argv.slice(2).filter((a, i, all) => a !== '--repo' && all[i - 1] !== '--repo')
const env = process.env
appendFileSync(env.FAKE_GH_LOG, args.map((a) => (a.includes('/') ? basename(a) : a)).join(' ') + '\\n')
const state = existsSync(env.FAKE_GH_STATE) ? JSON.parse(readFileSync(env.FAKE_GH_STATE, 'utf8')) : null
const save = (s) => writeFileSync(env.FAKE_GH_STATE, JSON.stringify(s))
const files = (from) => args.slice(from).filter((a) => !a.startsWith('--') && a.includes('/'))
const [cmd, sub, tag] = args
if (cmd !== 'release') process.exit(2)
if (sub === 'view') {
  if (!state) { console.error('release not found'); process.exit(1) }
  console.log(JSON.stringify({ assets: Object.keys(state.assets).map((name) => ({ name })) }))
} else if (sub === 'create') {
  if (state) { console.error('a release with the same tag name already exists: ' + tag); process.exit(1) }
  const assets = {}
  for (const f of files(3)) assets[basename(f)] = readFileSync(f, 'utf8')
  save({ notes: readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'), assets })
} else if (sub === 'edit') {
  save({ ...state, notes: readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8') })
} else if (sub === 'upload') {
  for (const f of files(3)) {
    if (state.assets[basename(f)] !== undefined && !args.includes('--clobber')) { console.error('asset under the same name already exists'); process.exit(1) }
    state.assets[basename(f)] = readFileSync(f, 'utf8')
  }
  save(state)
} else if (sub === 'download') {
  const name = args[args.indexOf('--pattern') + 1]
  writeFileSync(join(args[args.indexOf('--dir') + 1], name), state.assets[name])
}
`

function setup() {
  const dir = tmp('publish')
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  mkdirSync(join(dir, 'release-artifacts'))
  writeFileSync(join(dir, 'release-artifacts/app.zip'), 'zip-1')
  writeFileSync(join(dir, 'release-artifacts/SHA256SUMS.txt'), 'sum-1  app.zip\n')
  writeFileSync(join(dir, 'release-notes.md'), '### New\n\n- A\n')
  const env = { PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: join(dir, 'log'), FAKE_GH_STATE: join(dir, 'state.json'), GITHUB_REPOSITORY: 'o/r' }
  writeFileSync(env.FAKE_GH_LOG, '')
  const publish = (tag = 'v1.2.0') => attempt(dir, 'node', [join(KIT, 'template/scripts/release-kit/publish.mjs'), '--tag', tag], env)
  const state = () => JSON.parse(readFileSync(env.FAKE_GH_STATE, 'utf8'))
  const log = () => readFileSync(env.FAKE_GH_LOG, 'utf8').trim().split('\n')
  return { dir, publish, state, log }
}

test('a rerun of publish finishes the release instead of failing on "already exists"', () => {
  const { dir, publish, state, log } = setup()
  const first = publish()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /created the release v1\.2\.0 with 2 files/)
  assert.deepEqual(state().assets, { 'SHA256SUMS.txt': 'sum-1  app.zip\n', 'app.zip': 'zip-1' })

  // Re-run failed jobs, after a fix to the notes: the same files, new notes.
  writeFileSync(join(dir, 'release-notes.md'), '### New\n\n- A, reworded\n')
  const again = publish()
  assert.equal(again.status, 0, again.stderr)
  assert.match(again.stdout, /already existed; notes refreshed, no files to upload/)
  assert.equal(state().notes, '### New\n\n- A, reworded\n')
  assert.ok(!log().some((line) => line.startsWith('release upload')))

  // A rebuild with different files never replaces what was published.
  writeFileSync(join(dir, 'release-artifacts/app.zip'), 'zip-2')
  writeFileSync(join(dir, 'release-artifacts/SHA256SUMS.txt'), 'sum-2  app.zip\n')
  const different = publish()
  assert.notEqual(different.status, 0)
  assert.match(different.stderr, /v1\.2\.0: the release already has different files than this build/)
  assert.equal(state().assets['app.zip'], 'zip-1')
})

test('an upload a crashed run left half done is replaced, and a bad tag is refused before gh runs', () => {
  const { dir, publish, state, log } = setup()
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ notes: '', assets: { 'app.zip': 'zip-partial' } }))
  const result = publish()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /2 files uploaded \(replacing an unverified upload\)/)
  assert.deepEqual(state().assets, { 'SHA256SUMS.txt': 'sum-1  app.zip\n', 'app.zip': 'zip-1' })
  assert.equal(log().at(-1), 'release upload v1.2.0 SHA256SUMS.txt app.zip --clobber')

  const bad = publish('v1.2.0;id')
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /is not a release tag/)
})
