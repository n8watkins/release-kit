// protect.mjs against a fake gh: what it asks GitHub to do, in what order,
// and that the private key ends up only in the secret.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, attempt, tmp } from './helpers.mjs'
import { ruleset } from '../template/scripts/release-kit/protect.mjs'

const FAKE_GH = `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const env = process.env
const input = args.includes('--input') || args[0] === 'secret' ? readFileSync(0, 'utf8') : ''
appendFileSync(env.FAKE_GH_LOG, JSON.stringify({ args, input }) + '\\n')
const say = (value) => process.stdout.write(JSON.stringify(value))
if (args[0] === 'repo') process.stdout.write('o/r main')
else if (args[0] === 'api') {
  const [method, path] = [args[2], args[3]]
  if (method !== 'GET') say({})
  else if (path === 'repos/o/r/branches/main/protection') {
    if (env.FAKE_NO_CLASSIC) { console.error('gh: Branch not protected (HTTP 404)'); process.exit(1) }
    say({ required_status_checks: { checks: [{ context: 'CI result', app_id: 15368 }, { context: 'check', app_id: null }] } })
  } else if (path.startsWith('repos/o/r/rulesets')) say(env.FAKE_RULESET ? [{ id: 42, name: 'release-kit: protect main' }] : [])
  else if (path === 'repos/o/r/keys') say([{ id: 7, title: 'release-kit train' }, { id: 8, title: 'someone else' }])
}
`

function protect(args = [], env = {}) {
  const dir = tmp('protect')
  const bin = tmp('protect-bin')
  const scratch = tmp('protect-tmp')
  writeFileSync(join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  const log = join(bin, 'log')
  writeFileSync(log, '')
  const result = attempt(dir, 'node', [join(KIT, 'template/scripts/release-kit/protect.mjs'), ...args], {
    PATH: `${bin}:${process.env.PATH}`, FAKE_GH_LOG: log, TMPDIR: scratch, ...env,
  })
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { ...result, calls, leftovers: readdirSync(scratch) }
}

const writes = (calls) => calls.filter(({ args }) => args[0] === 'secret' || (args[0] === 'api' && args[2] !== 'GET'))
const describe = ({ args }) => (args[0] === 'secret' ? `secret ${args[2]}` : `${args[2]} ${args[3]}`)

test('it moves classic protection to a ruleset the deploy key bypasses, never leaving main unprotected', () => {
  const result = protect()
  assert.equal(result.status, 0, result.stderr)
  const done = writes(result.calls)
  assert.deepEqual(done.map(describe), [
    'POST repos/o/r/rulesets',
    'DELETE repos/o/r/keys/7',
    'POST repos/o/r/keys',
    'secret RELEASE_TRAIN_KEY',
    'DELETE repos/o/r/branches/main/protection',
  ])
  // The ruleset carries the classic required checks over, with their app.
  assert.deepEqual(JSON.parse(done[0].input), ruleset('main', [{ context: 'CI result', integration_id: 15368 }, { context: 'check' }]))
  assert.deepEqual(JSON.parse(done[0].input).rules.at(-1).parameters.required_status_checks, [
    { context: 'CI result', integration_id: 15368 },
    { context: 'check' }, // any app, as classic protection had it
  ])
  // A write key whose private half went only to the secret, and nothing left on disk.
  const key = JSON.parse(done[2].input)
  assert.equal(key.title, 'release-kit train')
  assert.equal(key.read_only, false)
  assert.match(key.key, /^ssh-ed25519 \S+ release-kit train$/)
  assert.match(done[3].input, /^-----BEGIN OPENSSH PRIVATE KEY-----\n/)
  assert.ok(!result.calls.some(({ input }) => input.includes('PRIVATE KEY') && input !== done[3].input))
  assert.deepEqual(result.leftovers, [])
  assert.match(result.stdout, /protect: done/)
})

test('the ruleset blocks deletion and force pushes, and lets the deploy key and admins through', () => {
  const set = ruleset('main', [{ context: 'CI result' }])
  assert.equal(set.name, 'release-kit: protect main')
  assert.deepEqual(set.conditions.ref_name.include, ['refs/heads/main'])
  assert.deepEqual(set.rules.map((rule) => rule.type), ['deletion', 'non_fast_forward', 'required_status_checks'])
  assert.deepEqual(set.bypass_actors, [
    { actor_type: 'DeployKey', bypass_mode: 'always' },
    { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
  ])
  assert.deepEqual(ruleset('main', [], { adminBypass: false }).bypass_actors, [{ actor_type: 'DeployKey', bypass_mode: 'always' }])
  assert.deepEqual(ruleset('main', []).rules.map((rule) => rule.type), ['deletion', 'non_fast_forward'])
})

test('a rerun updates its ruleset and replaces its key; --checks and --no-admin-bypass are honored', () => {
  const result = protect(['--checks', 'CI result, check', '--no-admin-bypass'], { FAKE_RULESET: '1', FAKE_NO_CLASSIC: '1' })
  assert.equal(result.status, 0, result.stderr)
  const done = writes(result.calls)
  assert.deepEqual(done.map(describe), ['PUT repos/o/r/rulesets/42', 'DELETE repos/o/r/keys/7', 'POST repos/o/r/keys', 'secret RELEASE_TRAIN_KEY'])
  assert.deepEqual(JSON.parse(done[0].input), ruleset('main', [{ context: 'CI result', integration_id: 15368 }, { context: 'check', integration_id: 15368 }], { adminBypass: false }))
})

test('--dry-run only reads', () => {
  const result = protect(['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(writes(result.calls), [])
  assert.match(result.stdout, /ruleset "release-kit: protect main" \(create\), required checks: CI result, check/)
  assert.match(result.stdout, /then remove classic branch protection from main/)
})
