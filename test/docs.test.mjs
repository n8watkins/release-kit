// The docs say what the code does: key claims are read from the code (or from
// what apply actually writes) and looked up in the docs, so a change to one
// without the other fails here instead of going quietly stale.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KIT, makeRepo, run, tmp } from './helpers.mjs'
import { TYPES } from '../template/scripts/release-kit/conventional.mjs'

const read = (path) => readFileSync(join(KIT, path), 'utf8')
const DOCS = ['README.md', 'STANDARD.md', 'RELEASING.md', 'template/RELEASING.md', 'AGENTS.md', 'template/AGENTS.release.md', ...readdirSync(join(KIT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)]
const MODES = ['package', 'reusable', 'vendored']
/** The text of the README section under `heading`, up to the next heading of the same level or higher. */
const section = (doc, heading) => {
  const at = doc.indexOf(`\n${heading}\n`)
  assert.notEqual(at, -1, `no "${heading}" section`)
  const level = heading.match(/^#+/)[0].length
  const next = doc.slice(at + heading.length + 2).search(new RegExp(`^#{1,${level}} `, 'm'))
  return doc.slice(at, next === -1 ? undefined : at + heading.length + 2 + next)
}

test('the docs name the workflow mode apply really defaults to, and no other', () => {
  const repo = makeRepo(tmp('docs-default'))
  run(KIT, 'node', ['apply.mjs', repo])
  const mode = JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')).workflows
  assert.ok(MODES.includes(mode))
  const capital = mode[0].toUpperCase() + mode.slice(1)
  assert.match(read('README.md'), new RegExp(`In ${mode} mode \\(the default\\)`))
  assert.match(read('README.md'), new RegExp(`\\| \`--${mode}\` \\| The default`))
  assert.match(read('STANDARD.md'), new RegExp(`\\*\\*${capital}\\*\\* \\(the default\\)`))
  // A dated review quotes what the docs said on its day; it is a record, not a claim.
  for (const doc of DOCS.filter((d) => !/REVIEW_/.test(d))) {
    for (const other of MODES.filter((m) => m !== mode)) {
      assert.doesNotMatch(read(doc), new RegExp(`${other}\\**\\)?\\s*\\(the default\\)|\`--${other}\` \\| The default`, 'i'), `${doc} calls ${other} the default`)
    }
  }
})

test('the README lists every workflow the kit ships, and STANDARD.md every workflow mode', () => {
  const shipped = readdirSync(join(KIT, 'template/.github/workflows'))
  const adds = section(read('README.md'), '## What apply adds')
  for (const name of shipped) assert.match(adds, new RegExp(`\`(\\.github/workflows/)?${name.replace('.', '\\.')}\``), `README "What apply adds" doesn't list ${name}`)
  // And nothing it no longer ships.
  for (const [, name] of adds.matchAll(/`(?:\.github\/workflows\/)?([\w-]+\.yml)`/g)) {
    // dependabot.yml and a private repo's auto-merge.yml are written by apply itself, not copied.
    if (!['dependabot.yml', 'auto-merge.yml'].includes(name)) assert.ok(shipped.includes(name), `README lists ${name}, which the kit doesn't ship`)
  }
  for (const mode of MODES) assert.match(read('STANDARD.md'), new RegExp(`\\*\\*${mode[0].toUpperCase()}${mode.slice(1)}\\*\\*`), mode)
})

test('every command of the release-kit CLI is in the README', () => {
  const bin = read('bin/release-kit.mjs')
  const usage = /release \| commit-msg \| [^`']+/.exec(bin)[0]
  const commands = usage.split('|').map((c) => c.trim().split(' ')[0])
  const readme = read('README.md')
  const line = /The `release-kit` command also runs ([^\n]+)/.exec(readme)?.[1] ?? ''
  for (const command of commands) {
    if (command === 'release' || command === 'commit-msg') continue
    assert.ok(line.includes(`\`${command}\``), `README's command list doesn't mention ${command}`)
  }
})

test('the agent instructions and RELEASING.md list exactly the commit types the check accepts', () => {
  const types = Object.keys(TYPES)
  const snippet = read('template/AGENTS.release.md')
  const listed = /with type one of ([a-z, ]+)\./.exec(snippet)[1].split(', ')
  assert.deepEqual(listed.sort(), [...types].sort())
  for (const doc of ['template/RELEASING.md', 'STANDARD.md']) {
    for (const type of types) assert.match(read(doc), new RegExp(`\`${type}\``), `${doc} doesn't mention ${type}`)
  }
  // This repo follows the kit: its own AGENTS.md block is the shipped one.
  assert.ok(read('AGENTS.md').includes(snippet.trim()), "AGENTS.md's release-kit block drifted from template/AGENTS.release.md")
})

test('every .release.json key the code reads is documented in the README', () => {
  const code = ['apply.mjs', ...readdirSync(join(KIT, 'template/scripts/release-kit')).map((f) => `template/scripts/release-kit/${f}`)].map(read).join('\n')
  const keys = new Set([...code.matchAll(/(?<![\w.-])config\??\.(\w+)/g)].map((m) => m[1]))
  const readme = read('README.md')
  for (const key of keys) assert.match(readme, new RegExp(`[\`"]${key}[\`"]`), `.release.json "${key}" is not in the README`)
  // The Node version the workflows fall back to.
  const fallback = /then node=(\d+); fi/.exec(read('template/.github/workflows/release.yml'))[1]
  assert.match(readme, new RegExp(`\`\\.node-version\`, else ${fallback}\\)`))
})

test('relative links in the docs point at files that exist', () => {
  for (const doc of DOCS) {
    for (const [, target] of read(doc).matchAll(/\]\(((?!https?:|#|mailto:)[^)#\s]+)(?:#[^)]*)?\)/g)) {
      assert.ok(existsSync(join(KIT, dirname(doc), target)), `${doc} links to ${target}, which doesn't exist`)
    }
  }
})

test('the docs use plain hyphens, never an em dash', () => {
  const files = [...DOCS, 'apply.mjs', 'bin/release-kit.mjs', ...['template/.github/workflows', '.github/workflows', 'reusable', 'template/scripts/release-kit'].flatMap((dir) => readdirSync(join(KIT, dir)).map((f) => `${dir}/${f}`))]
  for (const file of files) assert.ok(!read(file).includes('—'), `${file} has an em dash`)
})
