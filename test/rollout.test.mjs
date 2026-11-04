// The rollout bot: adopters.json, the waves, the pull request it opens, and
// apply --json, which tells it what changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BRANCH, filesFromStatus, linkReleaseNotes, parseAdopters, planWaves, prBody, prTitle } from '../scripts/rollout.mjs'
import { KIT, attempt, makeRepo, run, tmp } from './helpers.mjs'

const read = (path) => readFileSync(join(KIT, path), 'utf8')
const adopter = (over = {}) => ({ repo: 'acme/app', branch: 'main', visibility: 'public', wave: 'public', merge: 'auto-merge', enabled: true, ...over })
const file = (adopters, bot = 'release-kit-bot-n8watkins[bot]') => JSON.stringify({ bot, adopters })

test("the repo's adopters.json is valid, names the App's bot, and keeps the owner's rules", () => {
  const { bot, adopters } = parseAdopters(read('adopters.json'))
  // apply passes the same login to each repo's auto-merge workflow.
  assert.match(read('apply.mjs'), new RegExp(`const ROLLOUT_BOT = '${bot.replace(/[[\]]/g, '\\$&')}'`))
  const by = Object.fromEntries(adopters.map((a) => [a.name, a]))
  // The App is installed on these eight.
  const installed = ['n8builds-web', 'n8builds-admin', 'dev-portfolio', 'open-ping', 'scribe', 'voicedock', 'portfolio-rank', 'tl-dw']
  assert.deepEqual(adopters.filter((a) => a.enabled).map((a) => a.name).sort(), installed.sort())
  assert.equal(adopters.filter((a) => a.wave === 'canary' && a.enabled).length, 1)
  // tube-vault's release branch, never its frozen master.
  assert.equal(by['tube-vault'].branch, 'review/tube-vault-v0.3.81')
  assert.equal(by['n8builds-admin'].visibility, 'private')
  assert.equal(by['n8builds-admin'].merge, 'merge-when-green')
  assert.equal(by['pr-post-private'].enabled, false)
  for (const gone of ['source-engine', 'system-design-aid', 'keysready-archive']) assert.equal(by[gone], undefined, gone)
})

test('adopters.json problems are all reported at once', () => {
  assert.throws(() => parseAdopters('{'), /not valid JSON/)
  const error = (() => {
    try {
      parseAdopters(file([
        adopter(),
        adopter(),
        adopter({ repo: 'nope', branch: '', wave: 'later', merge: 'maybe', enabled: 'yes' }),
        adopter({ repo: 'acme/secret', visibility: 'private', wave: 'public' }),
        adopter({ repo: 'acme/off', enabled: false }),
        adopter({ repo: 'acme/typo', brnach: 'main' }),
        adopter({ repo: 'acme/dots', branch: 'a..b' }),
      ], 'robot'))
    } catch (e) {
      return e.message
    }
  })()
  for (const problem of [/"bot" must be/, /\(acme\/app\): listed twice/, /"repo" must be owner\/name/, /"branch" must be/, /"wave" must be one of canary, public, private/, /"merge" must be one of auto-merge, merge-when-green, person/, /"enabled" must be true or false/, /a private repo belongs in the private wave/, /\(acme\/off\): a disabled adopter needs a "reason"/, /unknown key "brnach"/, /\(acme\/dots\): "branch" must be/]) {
    assert.match(error, problem)
  }
  // The canary may be public or private.
  assert.doesNotThrow(() => parseAdopters(file([adopter({ visibility: 'private', wave: 'canary' })])))
})

test('waves run canary, public, private, and skip disabled adopters with their reason', () => {
  const { adopters } = parseAdopters(file([
    adopter({ repo: 'acme/web', wave: 'public' }),
    adopter({ repo: 'acme/admin', visibility: 'private', wave: 'private', merge: 'merge-when-green' }),
    adopter({ repo: 'acme/canary', wave: 'canary', note: 'first' }),
    adopter({ repo: 'acme/later', enabled: false, reason: 'Needs the App installed.' }),
    adopter({ repo: 'acme/vault', branch: 'review/v0.3', wave: 'public' }),
  ]))
  const all = planWaves(adopters)
  assert.deepEqual(Object.keys(all), ['canary', 'public', 'private', 'skipped'])
  assert.deepEqual(all.canary.map((a) => a.repo), ['acme/canary'])
  assert.deepEqual(all.public.map((a) => a.repo), ['acme/web', 'acme/vault'])
  assert.deepEqual(all.private.map((a) => a.repo), ['acme/admin'])
  assert.deepEqual(all.skipped, [{ repo: 'acme/later', reason: 'Needs the App installed.' }])
  // What each job needs: the repo split for the token, the branch to target.
  assert.deepEqual(all.public[1], { repo: 'acme/vault', owner: 'acme', name: 'vault', branch: 'review/v0.3', visibility: 'public', merge: 'auto-merge', note: '' })
  assert.equal(all.canary[0].note, 'first')
  // A filter by name or owner/name, any case; an unknown name is an error.
  const some = planWaves(adopters, ['WEB', 'acme/later', ' '])
  assert.deepEqual([some.canary, some.public.map((a) => a.repo), some.private], [[], ['acme/web'], []])
  assert.deepEqual(some.skipped.map((s) => s.repo), ['acme/later'])
  assert.throws(() => planWaves(adopters, ['web', 'ghost']), /not in adopters\.json: ghost/)
})

test('plan prints the waves and writes them as step outputs', () => {
  const dir = tmp('rollout-plan')
  writeFileSync(join(dir, 'adopters.json'), file([adopter({ wave: 'canary' }), adopter({ repo: 'acme/web' })]))
  writeFileSync(join(dir, 'out'), '')
  writeFileSync(join(dir, 'summary'), '')
  const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary') }
  run(KIT, 'node', ['scripts/rollout.mjs', 'plan', '--tag', 'v9.9.9', '--adopters', join(dir, 'adopters.json')], env)
  const out = Object.fromEntries(readFileSync(join(dir, 'out'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), JSON.parse(l.slice(l.indexOf('=') + 1))]))
  assert.deepEqual(out.canary.map((a) => a.repo), ['acme/app'])
  assert.deepEqual(out.public.map((a) => a.repo), ['acme/web'])
  assert.deepEqual(out.private, [])
  assert.match(readFileSync(join(dir, 'summary'), 'utf8'), /\*\*canary\*\*: acme\/app/)
  const bad = attempt(KIT, 'node', ['scripts/rollout.mjs', 'plan', '--tag', 'main', '--adopters', join(dir, 'adopters.json')])
  assert.notEqual(bad.status, 0)
  assert.match(bad.stderr, /--tag must be a release tag like v2\.6\.0/)
})

test("the pull request lists what apply changed, its notes, how it merges, and the kit's release notes", () => {
  const body = prBody({
    tag: 'v2.6.0',
    adopter: { repo: 'acme/vault', branch: 'review/v0.3', merge: 'merge-when-green', note: 'Private on GitHub Free.' },
    files: { added: ['.github/workflows/security.yml'], changed: ['package.json', 'package-lock.json'], removed: [] },
    notes: ['.github/dependabot.yml is the repo\'s own: add the group'],
    releaseNotes: '### Fixed\n\n- Merge when green works again (#43)\n- See n8watkins/release-kit#41, issue #7 and &#39;quotes&#39;\n',
    runUrl: 'https://github.com/n8watkins/release-kit/actions/runs/1',
  })
  assert.equal(prTitle('v2.6.0'), 'ci: update release-kit to v2.6.0')
  assert.match(body, /^Updates \[release-kit\]\(https:\/\/github\.com\/n8watkins\/release-kit\) to \[v2\.6\.0\]\(https:\/\/github\.com\/n8watkins\/release-kit\/releases\/tag\/v2\.6\.0\)/)
  assert.match(body, /\[this run\]\(https:\/\/github\.com\/n8watkins\/release-kit\/actions\/runs\/1\)/)
  assert.ok(body.includes(`overwrites the \`${BRANCH}\` branch, so make other fixes on \`review/v0.3\``))
  assert.match(body, /## What changed\n\nAdded:\n\n- `\.github\/workflows\/security\.yml`\n\nChanged:\n\n- `package\.json`\n- `package-lock\.json`\n\n## Needs a look/)
  assert.doesNotMatch(body, /Removed:/)
  assert.match(body, /## Needs a look\n\napply left these for a person:\n\n- \.github\/dependabot\.yml is the repo's own: add the group/)
  assert.match(body, /## How it merges\n\nThe repo requires no checks, so its auto-merge workflow merges this pull request once every check on it has passed \(merge when green\)\. A major kit update waits for a person\.\n\nPrivate on GitHub Free\./)
  // The kit's pull request numbers point at the kit, not at the adopter's own pull requests.
  assert.match(body, /## Release notes for v2\.6\.0\n\n### Fixed\n\n- Merge when green works again \(n8watkins\/release-kit#43\)\n- See n8watkins\/release-kit#41, issue n8watkins\/release-kit#7 and &#39;quotes&#39;\n$/)

  const nothing = prBody({ tag: 'v2.6.0', adopter: { merge: 'person' }, files: { added: [], changed: [], removed: [] } })
  assert.match(nothing, /Nothing: the repo is already on this version\./)
  assert.doesNotMatch(nothing, /Needs a look/)
  assert.match(nothing, /A person reviews and merges this pull request\./)
  assert.match(nothing, /\(The release has no notes\.\)/)
  // GitHub refuses descriptions over 65536 characters.
  const long = prBody({ tag: 'v2.6.0', adopter: { merge: 'auto-merge' }, files: { added: [], changed: ['a'], removed: [] }, releaseNotes: 'x'.repeat(100000) })
  assert.ok(long.length < 65536)
  assert.match(long, /Cut short: the full notes are on the release page\./)
})

test('the kit links and git status lines read the way the bot needs', () => {
  assert.equal(linkReleaseNotes('(#12) #3, owner/x#4, a#5, ##6, x-#7', 'k/r'), '(k/r#12) k/r#3, owner/x#4, a#5, ##6, x-#7')
  assert.deepEqual(filesFromStatus(' M package.json\n?? .npmrc\nA  .github/workflows/new.yml\n D old.yml\nR  a.yml -> b.yml\n M "with space.md"\n'), {
    added: ['.github/workflows/new.yml', '.npmrc'],
    changed: ['b.yml', 'package.json', 'with space.md'],
    removed: ['old.yml'],
  })
})

test('apply --json reports exactly the files it added, changed and removed, and its notes', () => {
  const repo = makeRepo(tmp('apply-json'))
  mkdirSync(join(repo, '.github'), { recursive: true })
  writeFileSync(join(repo, '.github/dependabot.yml'), 'version: 2\nupdates: []\n')
  const first = JSON.parse(run(KIT, 'node', ['apply.mjs', repo, '--json']))
  assert.equal(first.mode, 'package')
  assert.ok(first.files.added.includes('.github/workflows/release.yml'))
  assert.ok(first.files.added.includes('RELEASING.md'))
  assert.ok(first.files.changed.includes('package.json'))
  assert.deepEqual(first.files.removed, [])
  assert.ok(first.notes.some((n) => /dependabot\.yml has no npm or github-actions entry/.test(n)))
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  // A rerun that changes nothing reports nothing, though it rewrote the files.
  const again = JSON.parse(run(KIT, 'node', ['apply.mjs', repo, '--json']))
  assert.deepEqual(again.files, { added: [], changed: [], removed: [] })
  // Going vendored and back removes files, and says so.
  run(KIT, 'node', ['apply.mjs', repo, '--vendored', '--train'])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: vendor release-kit'])
  const back = JSON.parse(run(KIT, 'node', ['apply.mjs', repo, '--package', '--no-train', '--json']))
  assert.ok(back.files.removed.includes('.github/workflows/release-train.yml'))
  assert.ok(back.files.removed.includes('scripts/release-kit/release.mjs'))
  assert.equal(back.train, null)
})

test("apply's auto-merge workflow lets the rollout bot's pull requests merge like Dependabot's", () => {
  const repo = makeRepo(tmp('apply-bots'))
  run(KIT, 'node', ['apply.mjs', repo])
  const workflow = readFileSync(join(repo, '.github/workflows/auto-merge.yml'), 'utf8')
  assert.match(workflow, /^ {4}with:\n {6}# .*\n {6}bots: "dependabot\[bot\],release-kit-bot-n8watkins\[bot\]"$/m)
  // The job only starts for the bot's release-kit/ branch, which the policy requires of it.
  assert.match(workflow, /startsWith\(github\.head_ref, 'release-kit\/'\)/)
  assert.ok(BRANCH.startsWith('release-kit/'))
})

test('the rollout workflow runs the waves in order, each in the protected environment with a pinned App token', () => {
  const main = read('.github/workflows/rollout.yml')
  const wave = read('.github/workflows/rollout-wave.yml')
  assert.match(main, /^ {2}release:\n {4}types: \[published\]$/m)
  for (const input of ['tag', 'repos', 'dry_run']) assert.match(main, new RegExp(`^ {6}${input}:$`, 'm'))
  // Dry run is the default for a manual run; a release rolls out for real.
  assert.match(main, /dry_run:\n(?: {8}.*\n)*? {8}default: true/)
  assert.match(main, /DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run \}\}/)
  // canary, then public, then private; a failed wave stops the ones after it.
  assert.match(main, /^ {2}canary:\n(?: {4}.*\n)*? {4}needs: plan$/m)
  assert.match(main, /^ {2}public:\n(?: {4}.*\n)*? {4}needs: \[plan, canary\]$/m)
  assert.match(main, /^ {2}private:\n(?: {4}.*\n)*? {4}needs: \[plan, canary, public\]$/m)
  assert.match(main, /needs\.canary\.result == 'success' \|\| needs\.canary\.result == 'skipped'/)
  assert.match(main, /needs\.public\.result == 'success' \|\| needs\.public\.result == 'skipped'/)
  assert.equal(main.match(/uses: \.\/\.github\/workflows\/rollout-wave\.yml/g).length, 3)
  // Every wave call passes the secrets on: without them the App key is empty and every wave fails.
  assert.equal(main.match(/uses: \.\/\.github\/workflows\/rollout-wave\.yml\n(?: {4}#.*\n)* {4}secrets: inherit\n/g).length, 3)
  // Each job: the environment, a token for its one repo, read-only in a dry run.
  assert.match(wave, /^ {4}environment: rollout$/m)
  assert.match(wave, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d/)
  assert.match(wave, /app-id: \$\{\{ vars\.RELEASE_KIT_BOT_APP_ID \}\}\n {10}private-key: \$\{\{ secrets\.RELEASE_KIT_BOT_KEY \}\}/)
  assert.match(wave, /repositories: \$\{\{ matrix\.adopter\.name \}\}/)
  assert.match(wave, /permission-contents: \$\{\{ inputs\.dry-run && 'read' \|\| 'write' \}\}/)
  assert.match(wave, /fail-fast: false/)
  // apply comes from the tag being rolled out.
  assert.match(wave, /ref: refs\/tags\/\$\{\{ inputs\.tag \}\}\n {10}path: kit/)
})
