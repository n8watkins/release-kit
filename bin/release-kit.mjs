#!/usr/bin/env node
// The kit's one command, for a repo that installs release-kit as a dev
// dependency (apply.mjs's default "package" mode):
//
//   release-kit release [...]     cut a release (npm run release)
//   release-kit commit-msg <file> check a commit message (the commit-msg hook)
//   release-kit notes [...]       print release notes for a range
//   release-kit train [...]       the release train's last step (CI)
//   release-kit protect [...]     set up the ruleset and deploy key for the train
//   release-kit check             warn when this kit is behind the newest release
//   release-kit apply <repo> [...] apply or upgrade the kit in a repo
//   release-kit <repo> [...]      the same as apply
//
// Each runs in the current directory, which should be the repo's root.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPTS = join(KIT, 'template', 'scripts', 'release-kit')
const kitPackage = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'))
const KIT_REPO = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(kitPackage.repository?.url ?? '')?.[1] ?? 'n8watkins/release-kit'
const SCRIPT_COMMANDS = new Set(['release', 'commit-msg', 'notes', 'train', 'protect'])

const [command, ...rest] = process.argv.slice(2)

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

const parse = (v) => v.replace(/^v/, '').split('.').map(Number)
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

/** Warns (never fails) when the installed kit is behind its newest release, or the workflows pin another version. */
function check() {
  const installed = kitPackage.version
  const warnings = []
  if (!process.env.RELEASE_KIT_OFFLINE) {
    const out = spawnSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${KIT_REPO}.git`, 'v*'], {
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    const tags = out.status === 0 ? out.stdout.split('\n').map((l) => l.split('refs/tags/')[1]).filter((t) => /^v\d+\.\d+\.\d+$/.test(t ?? '')) : []
    const latest = tags.reduce((best, t) => (!best || newer(t, best) ? t : best), null)
    if (latest && newer(latest, installed)) {
      warnings.push(`release-kit ${installed} is installed, but ${latest} is out: npm install -D "release-kit@github:${KIT_REPO}#${latest}" (Dependabot opens this update on its own)`)
    }
  }
  // The reusable workflows should pin the same version as package.json.
  const dir = '.github/workflows'
  if (existsSync(dir)) {
    const pin = new RegExp(`${KIT_REPO.replace('/', '\\/')}\\/\\.github\\/workflows\\/[\\w.-]+@(v\\d+\\.\\d+\\.\\d+)`)
    for (const file of readdirSync(dir)) {
      const found = pin.exec(readFileSync(join(dir, file), 'utf8'))?.[1]
      if (found && found !== `v${installed}`) warnings.push(`${dir}/${file} calls release-kit ${found}, but ${installed} is installed: rerun npx release-kit apply . to line them up`)
    }
  }
  for (const w of warnings) console.warn(`release-kit: ${w}`)
  if (!warnings.length) console.log(`release-kit ${installed}: up to date`)
}

if (command === 'check') check()
else if (SCRIPT_COMMANDS.has(command)) run(join(SCRIPTS, `${command}.mjs`), rest)
else if (command === 'apply') run(join(KIT, 'apply.mjs'), rest)
else if (command && !command.startsWith('-')) run(join(KIT, 'apply.mjs'), [command, ...rest])
else {
  console.error(`release-kit ${kitPackage.version}: release | commit-msg | notes | train | protect | check | apply <repo>`)
  process.exit(command ? 1 : 0)
}
