// The workflow files: the kit's own copies match what it ships, and every
// workflow follows the hardening rules (pinned actions, least privilege, no
// expressions inside shell scripts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KIT, makeRepo, run, tmp } from './helpers.mjs'

const read = (path) => readFileSync(join(KIT, path), 'utf8')
const dirs = ['template/.github/workflows', '.github/workflows', 'reusable']
const files = dirs.flatMap((dir) => readdirSync(join(KIT, dir)).map((name) => join(dir, name)))

test("the kit's own workflows are the ones it ships, so repos can call them", () => {
  for (const name of ['release.yml', 'commits.yml']) {
    assert.equal(read(`.github/workflows/${name}`), read(`template/.github/workflows/${name}`), `.github/workflows/${name} drifted from the template`)
  }
  // The train is the same file without a schedule: the kit doesn't release itself on one.
  const schedule = '  schedule:\n    - cron: "0 16 * * 1" # release-kit: schedule\n'
  const shipped = read('template/.github/workflows/release-train.yml')
  assert.ok(shipped.includes(schedule))
  assert.equal(read('.github/workflows/release-train.yml'), shipped.replace(schedule, '  # No schedule: this copy is the one other repos call; the kit releases itself by hand.\n'))
  // Every shipped workflow has a reusable caller, and can be called.
  assert.deepEqual(readdirSync(join(KIT, 'reusable')).sort(), readdirSync(join(KIT, 'template/.github/workflows')).sort())
  for (const name of readdirSync(join(KIT, 'template/.github/workflows'))) {
    assert.match(read(`template/.github/workflows/${name}`), /^ {2}workflow_call:$/m, name)
  }
})

test('third-party actions are pinned to commit SHAs', () => {
  for (const file of files) {
    for (const [, ref] of read(file).matchAll(/^\s*(?:- )?uses: (\S+)/gm)) {
      if (ref.startsWith('./') || ref.startsWith('KIT_REPO/')) continue
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}: ${ref}`)
    }
  }
})

test('workflows read by default and grant write only to the jobs that need it', () => {
  for (const file of files) {
    const text = read(file)
    assert.match(text, /^permissions:\n {2}contents: read\n\n/m, file)
    for (const [, block] of text.matchAll(/^ {4}permissions:\n((?: {6}.*\n)+)/gm)) {
      for (const line of block.trim().split('\n')) assert.match(line.trim(), /^(contents|actions): write(?: #.*)?$/, `${file}: ${line}`)
    }
  }
  assert.doesNotMatch(read('template/.github/workflows/commits.yml'), /: write/)
})

test('no ${{ }} expression is pasted into a shell script', () => {
  for (const file of files) {
    const lines = read(file).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(lines[i])
      if (!m) continue
      const script = [m[2]]
      const indent = m[1].length
      if (/^[|>]/.test(m[2])) {
        while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > indent)) script.push(lines[++i])
      }
      assert.doesNotMatch(script.join('\n'), /\$\{\{/, `${file}:${i + 1}`)
    }
  }
})

test('every job that runs the kit fetches its scripts the same way', () => {
  const step = /- name: Fetch the release-kit scripts\n[\s\S]*?persist-credentials: false\n/g
  const copies = ['commits.yml', 'release.yml', 'release-train.yml'].flatMap((name) => read(`template/.github/workflows/${name}`).match(step))
  assert.equal(copies.length, 4)
  assert.equal(new Set(copies).size, 1)
  assert.match(copies[0], /ref: \$\{\{ job\.workflow_sha \}\}/)
})

// actionlint (https://github.com/rhysd/actionlint) checks the workflows as
// apply.mjs writes them, when it is installed (CI installs it).
const actionlint = spawnSync('actionlint', ['--version']).status === 0
test('applied workflows pass actionlint', { skip: !actionlint && 'actionlint is not installed' }, () => {
  for (const options of [['--train'], ['--train', '--reusable'], ['--reusable', '--kit-ref', 'a'.repeat(40)]]) {
    const repo = makeRepo(tmp('lint'))
    run(KIT, 'node', ['apply.mjs', repo, ...(options.includes('--reusable') ? [] : ['--vendored']), ...options])
    const lint = spawnSync('actionlint', [
      // actionlint doesn't know the job context's workflow_* properties yet; GitHub documents them in the contexts reference.
      '-ignore', 'property "workflow_(repository|sha)" is not defined',
    ], { cwd: repo, encoding: 'utf8' })
    assert.equal(lint.status, 0, `${options.join(' ')}\n${lint.stdout}${lint.stderr}`)
  }
  const own = spawnSync('actionlint', ['-ignore', 'property "workflow_(repository|sha)" is not defined'], { cwd: KIT, encoding: 'utf8' })
  assert.equal(own.status, 0, own.stdout + own.stderr)
})

/** The shell script of the step called `name` in a shipped workflow. */
function stepScript(file, name) {
  const lines = read(file).split('\n')
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`)
  assert.notEqual(at, -1, `${file}: no step "${name}"`)
  const runAt = lines.findIndex((line, i) => i > at && /^\s+run: \|$/.test(line))
  const indent = lines[runAt + 1].search(/\S/)
  const script = []
  for (let i = runAt + 1; i < lines.length && (lines[i].trim() === '' || lines[i].search(/\S/) >= indent); i++) script.push(lines[i].slice(indent))
  return script.join('\n')
}

test('the workflows pick the Node version from the repo and the scripts from the right place', () => {
  const script = stepScript('template/.github/workflows/release.yml', 'Locate the release-kit scripts and the Node version')
  assert.equal(script, stepScript('template/.github/workflows/release-train.yml', 'Locate the release-kit scripts and the Node version'))
  const step = (files) => {
    const dir = tmp('node')
    for (const [name, content] of Object.entries(files)) {
      run(dir, 'mkdir', ['-p', join(dir, name, '..')])
      writeFileSync(join(dir, name), content)
    }
    const out = join(dir, '.out')
    const env = join(dir, '.env')
    writeFileSync(out, '')
    writeFileSync(env, '')
    const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_ENV: env, RUNNER_TEMP: dir } })
    assert.equal(result.status, 0, result.stderr)
    return { node: readFileSync(out, 'utf8').trim(), kit: readFileSync(env, 'utf8').trim() }
  }
  assert.deepEqual(step({}), { node: 'node=22', kit: 'RELEASE_KIT=scripts/release-kit' })
  assert.equal(step({ '.release.json': '{"node": 24}', '.nvmrc': '20\n' }).node, 'node=24')
  assert.equal(step({ '.release.json': '{"versionFiles": []}', '.nvmrc': 'v20.11.1\r\n' }).node, 'node=20.11.1')
  assert.equal(step({ '.node-version': '24.x' }).node, 'node=24.x')
  assert.equal(step({ '.nvmrc': 'lts/*' }).node, 'node=22')
  assert.equal(step({ '.release.json': '{"node": "24; rm -rf /"}' }).node, 'node=22')
  // Reusable mode: the kit's checkout moves out of the workspace, so the repo's lint never sees it.
  const fetched = step({ '.release-kit-source/template/scripts/release-kit/release.mjs': '' })
  assert.match(fetched.kit, /^RELEASE_KIT=.*\/release-kit$/)
  assert.ok(existsSync(join(fetched.kit.slice('RELEASE_KIT='.length), 'release.mjs')))
})
