// The schemas for the files people edit by hand: .release.json and
// adopters.json. They name every key the code reads, and the real files (and
// what apply writes) match them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, makeRepo, run, tmp } from './helpers.mjs'
import { autoMergePolicy } from '../template/scripts/release-kit/automerge.mjs'

const read = (path) => readFileSync(join(KIT, path), 'utf8')
const config = JSON.parse(read('schema/release-config.v1.json'))
const adopters = JSON.parse(read('schema/adopters.v1.json'))

test('the .release.json schema names every key the code reads, and the autoMerge settings the policy takes', () => {
  const code = ['apply.mjs', ...readdirSync(join(KIT, 'template/scripts/release-kit')).map((f) => `template/scripts/release-kit/${f}`)].map(read).join('\n')
  const keys = new Set([...code.matchAll(/(?<![\w.-])config\??\.(\w+)/g)].map((m) => m[1]))
  // headings, scopes and style are read from config.notes by notes.mjs.
  for (const key of keys) assert.ok(key in config.properties || key in config.properties.notes.properties, `.release.json "${key}" is not in the schema`)
  const settings = config.properties.autoMerge.oneOf[1]
  assert.deepEqual(Object.keys(settings.properties).sort(), ['hold', 'minorWaitDays', 'patchWaitDays', 'unhold'])
  const defaults = autoMergePolicy(undefined)
  assert.equal(settings.properties.minorWaitDays.default, defaults.minorWaitDays)
  assert.equal(settings.properties.patchWaitDays.default, defaults.patchWaitDays)
  // Every key the policy accepts is in the schema, and nothing else is.
  const extra = autoMergePolicy({ x: 1 }).problems[0]
  assert.match(extra, /\(minorWaitDays, patchWaitDays, hold, unhold\)/)
})

test('the adopters.json schema has the keys rollout.mjs checks', () => {
  const rollout = read('scripts/rollout.mjs')
  const top = /\['\$schema', 'bot', 'soakHours', 'adopters'\]/.exec(rollout)
  assert.ok(top, 'rollout.mjs checks the top-level keys')
  assert.deepEqual(Object.keys(adopters.properties).sort(), ['$schema', 'adopters', 'bot', 'soakHours'])
  const known = /const known = new Set\(\[([^\]]+)\]\)/.exec(rollout)[1].split(',').map((k) => k.trim().replace(/'/g, ''))
  assert.deepEqual(Object.keys(adopters.properties.adopters.items.properties).sort(), known.sort())
  assert.equal(adopters.properties.soakHours.default, 24)
})

const checkJsonschema = spawnSync('check-jsonschema', ['--version']).status === 0
test('adopters.json and the .release.json apply writes validate against their schemas', { skip: !checkJsonschema && 'check-jsonschema is not installed' }, () => {
  const ok = (schema, file) => spawnSync('check-jsonschema', ['--schemafile', join(KIT, schema), file], { encoding: 'utf8' })
  const result = ok('schema/adopters.v1.json', join(KIT, 'adopters.json'))
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const repo = makeRepo(tmp('schema'))
  run(KIT, 'node', ['apply.mjs', repo, '--train'])
  const path = join(repo, '.release.json')
  const written = ok('schema/release-config.v1.json', path)
  assert.equal(written.status, 0, written.stdout + written.stderr)
  // A pass means something: a bad autoMerge value fails.
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), autoMerge: { minorWaitDays: -1 } }))
  assert.notEqual(ok('schema/release-config.v1.json', path).status, 0)
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), autoMerge: { minorWaitDays: 5, hold: ['@acme/*'], unhold: ['vite'] } }))
  assert.equal(ok('schema/release-config.v1.json', path).status, 0)
})
