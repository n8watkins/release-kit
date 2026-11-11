// The secret scan (commits.yml, job "secrets"): gitleaks over the commits a
// pull request or push adds, with the kit's extra rules. The leaks below are
// built from pieces, so this file never trips the scan itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'
import { KIT, makeRepo, run, tmp } from './helpers.mjs'

const read = (path) => readFileSync(join(KIT, path), 'utf8')
const commits = read('template/.github/workflows/commits.yml')
const job = commits.split(/^ {2}secrets:\n/m)[1]

const R2 = '.r2.cloudflare' + 'storage.com'
const ACCOUNT = 'f'.repeat(32)
const BUCKET = 'hushkey-' + 'backup-nathan-2026'

/** The shell script of the step called `name` in the secrets job. */
function stepScript(name) {
  const lines = job.split('\n')
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  assert.notEqual(at, -1, `no step "${name}"`)
  const runAt = lines.findIndex((line, i) => i > at && /^\s+run: \|$/.test(line))
  const indent = lines[runAt + 1].search(/\S/)
  const script = []
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) >= indent); i++) script.push(lines[i].slice(indent))
  return script.join('\n')
}

test('the secret scan is a pinned, checksummed gitleaks that skips title edits and redacts what it finds', () => {
  assert.ok(job, 'commits.yml has a secrets job')
  assert.match(job, /^ {4}if: github\.event\.action != 'edited'$/m)
  assert.match(job, /^ {10}GITLEAKS_VERSION: \d+\.\d+\.\d+$/m)
  assert.match(job, /^ {10}GITLEAKS_SHA256: [0-9a-f]{64}$/m)
  assert.match(job, /sha256sum --check/)
  const scan = stepScript('Scan the new commits for secrets')
  assert.match(scan, /--redact/)
  assert.match(scan, /--config "\$RELEASE_KIT\/gitleaks\.toml"/)
  assert.match(scan, /--log-opts="\$range"/)
})

// gitleaks itself: the pinned, checksummed release the scan job installs,
// installed here by that job's own "Install gitleaks" step, so the tests run
// the same binary wherever npm test runs (CI, the release's verify job, a
// laptop). The step downloads the linux x64 build; elsewhere the tests use a
// gitleaks on PATH, and skip, saying why, without one.
const linux = platform() === 'linux' && arch() === 'x64'
const onPath = spawnSync('sh', ['-c', 'command -v gitleaks'], { encoding: 'utf8' }).stdout.trim()
const skip = !linux && !onPath && `the scan step installs the linux x64 gitleaks; on ${platform()} ${arch()}, put gitleaks ${job.match(/GITLEAKS_VERSION: (\S+)/)[1]} on PATH to run this test`

let installed
/** A directory holding a `gitleaks`, as the scan step finds it in $RUNNER_TEMP. */
function gitleaksDir() {
  if (installed) return installed
  installed = tmp('gitleaks-bin')
  if (!linux) {
    symlinkSync(onPath, join(installed, 'gitleaks'))
    return installed
  }
  const env = (name) => job.match(new RegExp(`${name}: (\\S+)`))[1]
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', stepScript('Install gitleaks')], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: installed, GITLEAKS_VERSION: env('GITLEAKS_VERSION'), GITLEAKS_SHA256: env('GITLEAKS_SHA256') },
  })
  assert.equal(result.status, 0, `the "Install gitleaks" step failed:\n${result.stdout}${result.stderr}`)
  return installed
}

/** Run the scan step in `repo` on the commits after `base`. */
function scan(repo, base) {
  const head = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  return spawnSync('bash', ['-e', '-c', stepScript('Scan the new commits for secrets')], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TEMP: gitleaksDir(), RELEASE_KIT: join(KIT, 'template/scripts/release-kit'), BASE: base, BEFORE: '', HEAD_SHA: head },
  })
}

function add(repo, name, content) {
  mkdirSync(join(repo, name, '..'), { recursive: true })
  writeFileSync(join(repo, name), content)
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', `chore: add ${name}`])
  return run(repo, 'git', ['rev-parse', 'HEAD']).trim()
}

test('the scan fails on an R2 endpoint or a hushkey backup bucket in a new commit', { skip }, () => {
  for (const leak of [`https://${ACCOUNT}${R2}`, `https://${ACCOUNT}.eu${R2}`, `bucket = "${BUCKET}"`]) {
    const repo = makeRepo(tmp('secrets-leak'))
    const base = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
    add(repo, 'config.toml', `${leak}\n`)
    const result = scan(repo, base)
    assert.equal(result.status, 1, `${leak}\n${result.stdout}${result.stderr}`)
    const log = result.stdout + result.stderr
    assert.ok(!log.includes(ACCOUNT) && !log.includes(BUCKET), `the log repeats the leak:\n${log}`)
  }
})

test('the scan passes placeholders and documentation', { skip }, () => {
  const repo = makeRepo(tmp('secrets-placeholder'))
  const base = run(repo, 'git', ['rev-parse', 'HEAD']).trim()
  add(repo, 'docs.md', [
    `https://<ACCOUNT_ID>${R2}`,
    `https://\${ACCOUNT_ID}${R2}`,
    `https://your-account-id${R2}`,
    'Buckets are named hushkey-' + 'backup-*, like hushkey-' + 'backup-<name>.',
    '',
  ].join('\n'))
  const result = scan(repo, base)
  assert.equal(result.status, 0, result.stdout + result.stderr)
})

test('the scan reads only the new commits: a leak already in history does not fail it', { skip }, () => {
  const repo = makeRepo(tmp('secrets-history'))
  const base = add(repo, 'old.toml', `endpoint = "https://${ACCOUNT}${R2}"\n`)
  add(repo, 'README.md', 'Nothing secret here.\n')
  const result = scan(repo, base)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  // With no usable base (a new branch, a force push), it scans the last commit only.
  assert.equal(scan(repo, '0'.repeat(40)).status, 0)
  add(repo, 'new.toml', `bucket = "${BUCKET}"\n`)
  assert.equal(scan(repo, '0'.repeat(40)).status, 1)
})
