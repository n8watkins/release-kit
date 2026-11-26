// The rollout bot: adopters.json, the waves, the pull request it opens, and
// apply --json, which tells it what changed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { BRANCH, DEFER_JOB, ISSUE_LABEL, failureReport, filesFromStatus, heldReport, isMajorRelease, laterWaves, linkReleaseNotes, mergeState, parseAdopters, pendingSoak, planWaves, prBody, prTitle, soakState, updateLock } from '../scripts/rollout.mjs'
import { KIT, attempt, makeRepo, run, tmp } from './helpers.mjs'
import { execFileSync } from 'node:child_process'

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
  // A dry run that names a disabled adopter checks it (read-only), to see whether the App is installed there.
  const check = planWaves(adopters, ['later'], { dryRun: true })
  assert.deepEqual([check.public.map((a) => a.repo), check.skipped], [['acme/later'], []])
  // Without names, a dry run still covers only the enabled ones.
  assert.deepEqual(planWaves(adopters, [], { dryRun: true }).skipped.map((s) => s.repo), ['acme/later'])
})

test('a release is a major when its major differs from the highest release below it', () => {
  const tags = ['v1.0.0', 'v1.4.2', 'v2.0.0', 'v2.7.0', 'v2.7.1', 'v2.8.0-rc.1', 'baseline', 'v3.0.0']
  assert.equal(isMajorRelease('v2.7.2', tags), false)
  assert.equal(isMajorRelease('v2.8.0', tags), false)
  assert.equal(isMajorRelease('v3.0.0', tags), true)
  assert.equal(isMajorRelease('v2.0.0', tags), true)
  // A later tag doesn't count, and the first release ever is a major.
  assert.equal(isMajorRelease('v1.4.2', tags), false)
  assert.equal(isMajorRelease('v1.0.0', tags), true)
  assert.equal(isMajorRelease('v0.1.0', []), true)
  assert.throws(() => isMajorRelease('main', tags), /not a release tag/)
})

test('the canary gate passes once the branch pins the tag, and fails on a closed pull request, a red check or no pull request', () => {
  const base = { tag: 'v2.7.2', adopter: { repo: 'acme/canary', branch: 'main' } }
  const pr = (over = {}) => ({ number: 7, state: 'open', merged: false, url: 'https://github.com/acme/canary/pull/7', ...over })
  // Merged: the branch pins the tag, with or without a pull request (apply had nothing to change).
  assert.equal(mergeState({ ...base, pin: '2.7.2', pr: pr({ state: 'closed', merged: true }) }).state, 'merged')
  assert.equal(mergeState({ ...base, pin: '2.7.2', pr: null }).state, 'merged')
  assert.equal(mergeState({ ...base, pin: '2.7.2', pr: pr({ state: 'closed' }) }).state, 'merged')
  // Dependabot moved the pin first, but the bot's pull request (the lock, apply's files) is still open.
  assert.equal(mergeState({ ...base, pin: '2.7.2', pr: pr(), checks: 'pending' }).state, 'pending')
  assert.equal(mergeState({ ...base, pin: '2.7.2', pr: pr(), checks: 'red' }).state, 'failed')
  // Still going: open and checks running, green but not merged yet, or unreadable checks.
  for (const checks of ['pending', 'green', null]) assert.equal(mergeState({ ...base, pin: '2.7.1', pr: pr(), checks }).state, 'pending', String(checks))
  // Merged a moment ago, the branch not read yet.
  assert.equal(mergeState({ ...base, pin: '2.7.1', pr: pr({ state: 'closed', merged: true }) }).state, 'pending')
  // Stops the rollout.
  const red = mergeState({ ...base, pin: '2.7.1', pr: pr(), checks: 'red', failed: ['CI result', 'osv / osv'] })
  assert.deepEqual([red.state, red.why], ['failed', 'a check failed on https://github.com/acme/canary/pull/7: CI result, osv / osv'])
  assert.match(mergeState({ ...base, pin: '2.7.1', pr: pr({ state: 'closed' }) }).why, /closed without merging/)
  assert.equal(mergeState({ ...base, pin: '2.7.1', pr: pr({ state: 'closed' }) }).state, 'failed')
  assert.match(mergeState({ ...base, pin: '2.7.1', pr: null }).why, /no update pull request for v2\.7\.2, and main pins release-kit 2\.7\.1/)
  assert.match(mergeState({ ...base, pin: null, pr: null }).why, /pins no release-kit version/)
})

test('wait-merge reads the canary through gh: passes on the pin, stops on a red check, and times out', () => {
  const dir = tmp('rollout-wait')
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *contents/package.json*) echo "$FAKE_PKG" ;;',
    '  *pulls\\?*) echo "$FAKE_PULLS" ;;',
    '  *check-runs*) echo "$FAKE_RUNS" ;;',
    '  */status) echo \'{"state":"success","total_count":0}\' ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 })
  const pkg = (v) => JSON.stringify({ content: Buffer.from(JSON.stringify({ devDependencies: { 'release-kit': `github:n8watkins/release-kit#v${v}` } })).toString('base64') })
  const pulls = JSON.stringify([
    { number: 3, title: prTitle('v2.7.1'), state: 'closed', merged_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/acme/canary/pull/3', head: { sha: 'a'.repeat(40) } },
    { number: 4, title: prTitle('v2.7.2'), state: 'open', merged_at: null, html_url: 'https://github.com/acme/canary/pull/4', head: { sha: 'b'.repeat(40) } },
  ])
  const runs = (conclusion) => JSON.stringify({ check_runs: [{ name: 'CI result', status: 'completed', conclusion }, { name: 'auto-merge / Auto-merge', status: 'completed', conclusion: 'success' }] })
  const go = (over) => attempt(KIT, 'node', ['scripts/rollout.mjs', 'wait-merge', '--adopter', JSON.stringify({ repo: 'acme/canary', owner: 'acme', name: 'canary', branch: 'main' }), '--tag', 'v2.7.2', '--timeout-minutes', '0', '--interval-seconds', '0'],
    { PATH: `${dir}:${process.env.PATH}`, FAKE_PKG: pkg('2.7.1'), FAKE_PULLS: pulls, FAKE_RUNS: runs('success'), ...over })
  const merged = go({ FAKE_PKG: pkg('2.7.2'), FAKE_PULLS: pulls.replace('"state":"open","merged_at":null', '"state":"closed","merged_at":"2026-11-04T00:00:00Z"') })
  assert.equal(merged.status, 0, merged.stderr)
  assert.match(merged.stdout, /acme\/canary: main pins release-kit v2\.7\.2 \(https:\/\/github\.com\/acme\/canary\/pull\/4 merged\)/)
  // The pin alone (Dependabot moved it) doesn't pass while the bot's pull request is open.
  const early = go({ FAKE_PKG: pkg('2.7.2') })
  assert.equal(early.status, 1)
  assert.match(early.stderr, /not merged after 0 minutes \(https:\/\/github\.com\/acme\/canary\/pull\/4 is open, checks green\)/)
  const red = go({ FAKE_RUNS: runs('failure') })
  assert.equal(red.status, 1)
  assert.match(red.stderr, /acme\/canary: a check failed on https:\/\/github\.com\/acme\/canary\/pull\/4: CI result/)
  const slow = go({})
  assert.equal(slow.status, 1)
  assert.match(slow.stderr, /not merged after 0 minutes \(https:\/\/github\.com\/acme\/canary\/pull\/4 is open, checks green\)/)
})

test('a failed rollout reports each failed job, with its log, in the rollout issue', () => {
  const body = failureReport({
    tag: 'v2.7.2',
    runUrl: 'https://github.com/n8watkins/release-kit/actions/runs/1',
    jobs: [
      { name: 'Plan the waves', conclusion: 'success', html_url: 'u0' },
      { name: 'Canary / portfolio-rank', conclusion: 'success', html_url: 'u1' },
      { name: 'Canary merged / portfolio-rank', conclusion: 'failure', html_url: 'u2' },
      { name: 'Public / scribe', conclusion: 'timed_out', html_url: 'u3' },
      { name: 'Private', conclusion: 'skipped', html_url: 'u4' },
      { name: 'Report a failure', conclusion: null, html_url: 'u5' },
    ],
  })
  assert.match(body, /^The rollout of v2\.7\.2 stopped: \[the run\]\(https:\/\/github\.com\/n8watkins\/release-kit\/actions\/runs\/1\)\./)
  assert.match(body, /^- \*\*Canary merged \/ portfolio-rank\*\*: failure, \[log\]\(u2\)$/m)
  assert.match(body, /^- \*\*Public \/ scribe\*\*: timed out, \[log\]\(u3\)$/m)
  assert.doesNotMatch(body, /portfolio-rank\*\*: success|Private|Plan the waves/)
  assert.match(failureReport({ tag: 'v2.7.2', runUrl: 'r', jobs: [] }), /No job failed outright/)
  assert.equal(ISSUE_LABEL, 'release-kit: rollout')
})

test('plan prints the waves and writes them as step outputs', () => {
  const dir = tmp('rollout-plan')
  writeFileSync(join(dir, 'adopters.json'), file([adopter({ wave: 'canary' }), adopter({ repo: 'acme/web' })]))
  writeFileSync(join(dir, 'out'), '')
  writeFileSync(join(dir, 'summary'), '')
  const env = { GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary') }
  run(KIT, 'node', ['scripts/rollout.mjs', 'plan', '--tag', 'v9.9.9', '--tags', 'v9.0.0,v9.9.8', '--adopters', join(dir, 'adopters.json')], env)
  const raw = () => Object.fromEntries(readFileSync(join(dir, 'out'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  const out = Object.fromEntries(Object.entries(raw()).map(([k, v]) => [k, ['later', 'canary-owner', 'canary-names'].includes(k) ? v : JSON.parse(v)]))
  assert.deepEqual(out.canary.map((a) => a.repo), ['acme/app'])
  assert.deepEqual(out.public.map((a) => a.repo), ['acme/web'])
  assert.deepEqual(out.private, [])
  assert.equal(out.major, false)
  assert.match(readFileSync(join(dir, 'summary'), 'utf8'), /\*\*canary\*\*: acme\/app/)
  // A real patch or minor rollout soaks on the canary: the later waves are deferred.
  assert.equal(out.later, 'deferred')
  assert.equal(out['soak-hours'], 24)
  assert.deepEqual(out.canaries.map((a) => a.repo), ['acme/app'])
  assert.deepEqual([out['canary-owner'], out['canary-names']], ['acme', 'app'])
  assert.match(readFileSync(join(dir, 'summary'), 'utf8'), /no approval; once the canary's update pull request has merged, the public and private waves wait for the 24-hour soak, and the hourly resume \(rollout-resume\.yml\) starts them/)
  // The later waves' own run leaves the canary out and checks the soak; skip-soak runs them now.
  writeFileSync(join(dir, 'out'), '')
  run(KIT, 'node', ['scripts/rollout.mjs', 'plan', '--tag', 'v9.9.9', '--tags', 'v9.0.0,v9.9.8', '--adopters', join(dir, 'adopters.json'), '--stage', 'later'], env)
  assert.deepEqual([raw().canary, raw().later, JSON.parse(raw().canaries).length], ['[]', 'check', 1])
  writeFileSync(join(dir, 'out'), '')
  run(KIT, 'node', ['scripts/rollout.mjs', 'plan', '--tag', 'v9.9.9', '--tags', 'v9.0.0,v9.9.8', '--adopters', join(dir, 'adopters.json'), '--skip-soak'], env)
  assert.equal(raw().later, 'now')
  writeFileSync(join(dir, 'out'), '')
  run(KIT, 'node', ['scripts/rollout.mjs', 'plan', '--tag', 'v10.0.0', '--tags', 'v9.9.9', '--adopters', join(dir, 'adopters.json')], env)
  assert.match(readFileSync(join(dir, 'out'), 'utf8'), /^major=true$/m)
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

test('the rollout workflow runs the waves in order, gates a patch or minor on the canary merging, and waits for the owner only on a major', () => {
  const main = read('.github/workflows/rollout.yml')
  const wave = read('.github/workflows/rollout-wave.yml')
  assert.match(main, /^ {2}release:\n {4}types: \[published\]$/m)
  for (const input of ['tag', 'repos', 'dry_run']) assert.match(main, new RegExp(`^ {6}${input}:$`, 'm'))
  // Dry run is the default for a manual run; a release rolls out for real.
  assert.match(main, /dry_run:\n(?: {8}.*\n)*? {8}default: true/)
  assert.match(main, /DRY_RUN: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.dry_run \}\}/)
  // canary, then the gate, then public, then private; a failed wave or gate stops the ones after it.
  assert.match(main, /^ {2}canary:\n(?: {4}.*\n)*? {4}needs: plan$/m)
  assert.match(main, /^ {2}canary-merged:\n(?: {4}.*\n)*? {4}needs: \[plan, canary\]$/m)
  assert.match(main, /^ {2}public:\n(?: {4}.*\n)*? {4}needs: \[plan, canary, canary-merged, soak\]$/m)
  assert.match(main, /^ {2}private:\n(?: {4}.*\n)*? {4}needs: \[plan, canary, canary-merged, soak, public\]$/m)
  assert.equal(main.match(/needs\.canary\.result == 'success' \|\| needs\.canary\.result == 'skipped'/g).length, 2)
  assert.equal(main.match(/needs\.canary-merged\.result == 'success' \|\| needs\.canary-merged\.result == 'skipped'/g).length, 2)
  assert.match(main, /needs\.public\.result == 'success' \|\| needs\.public\.result == 'skipped'/)
  // The gate: only after a real canary, not in a dry run or a major, and with a timeout.
  const gate = main.slice(main.indexOf('\n  canary-merged:\n'), main.indexOf('\n  public:\n'))
  assert.match(gate, /needs\.canary\.result == 'success'\n {6}&& needs\.plan\.outputs\.dry-run != 'true' && needs\.plan\.outputs\.major != 'true'/)
  assert.match(gate, /^ {4}environment: rollout$/m)
  assert.match(gate, /permission-contents: read\n {10}permission-pull-requests: read\n/)
  assert.match(gate, /node scripts\/rollout\.mjs wait-merge --adopter "\$ADOPTER" --tag "\$TAG" --timeout-minutes 60/)
  assert.match(gate, /^ {4}timeout-minutes: 75$/m)
  // Every wave call passes the secrets on, and says whether this is a major.
  assert.equal(main.match(/uses: \.\/\.github\/workflows\/rollout-wave\.yml/g).length, 3)
  assert.equal(main.match(/uses: \.\/\.github\/workflows\/rollout-wave\.yml\n(?: {4}#.*\n)* {4}secrets: inherit\n/g).length, 3)
  assert.equal(main.match(/^ {6}major: \$\{\{ needs\.plan\.outputs\.major == 'true' \}\}$/gm).length, 3)
  // A failure in a real rollout opens or updates the rollout issue.
  const report = main.slice(main.indexOf('\n  report:\n'))
  assert.match(report, /needs: \[plan, canary, canary-merged, defer, soak, public, private\]/)
  assert.match(report, /if: failure\(\) && !\(github\.event_name == 'workflow_dispatch' && inputs\.dry_run\)/)
  assert.match(report, /issues: write/)
  assert.match(report, /node scripts\/rollout\.mjs report --tag "\$TAG" --run-id "\$RUN_ID"/)
  // A major waits in rollout-major, which holds no secrets, before each wave's jobs.
  assert.match(wave, /^ {2}approve:\n {4}name: .*\n {4}if: inputs\.major\n(?: {4}.*\n)*? {4}environment: rollout-major$/m)
  assert.match(wave, /^ {2}update:\n(?: {4}.*\n)*? {4}needs: approve\n(?: {4}#.*\n)* {4}if: \$\{\{ !cancelled\(\) && \(needs\.approve\.result == 'success' \|\| needs\.approve\.result == 'skipped'\) \}\}$/m)
  // Each job: the environment with the key, a token for its one repo, read-only in a dry run.
  assert.match(wave, /^ {4}environment: rollout$/m)
  assert.match(wave, /uses: actions\/create-github-app-token@[0-9a-f]{40} # v\d/)
  assert.match(wave, /app-id: \$\{\{ vars\.RELEASE_KIT_BOT_APP_ID \}\}\n {10}private-key: \$\{\{ secrets\.RELEASE_KIT_BOT_KEY \}\}/)
  assert.match(wave, /repositories: \$\{\{ matrix\.adopter\.name \}\}/)
  assert.match(wave, /permission-contents: \$\{\{ inputs\.dry-run && 'read' \|\| 'write' \}\}/)
  assert.match(wave, /fail-fast: false/)
  // apply comes from the tag being rolled out.
  assert.match(wave, /ref: refs\/tags\/\$\{\{ inputs\.tag \}\}\n {10}path: kit/)
  // The plan passes --dry-run on, so a dry run can check a disabled adopter.
  assert.match(main, /if \[ "\$DRY_RUN" = "true" \]; then set -- "\$@" --dry-run; fi\n {10}node scripts\/rollout\.mjs plan "\$@"/)
})

test('a release the Release workflow publishes starts one real rollout, in this repo only', () => {
  const start = read('.github/workflows/rollout-start.yml')
  const main = read('.github/workflows/rollout.yml')
  assert.match(start, /^ {2}workflow_run:\n {4}workflows: \[Release\]\n {4}types: \[completed\]$/m)
  assert.match(start, /if: github\.repository == 'n8watkins\/release-kit' && github\.event\.workflow_run\.conclusion == 'success'/)
  assert.match(start, /^ {6}actions: write/m)
  // release.yml is also the reusable workflow adopters call: it must not ask for actions: write.
  assert.doesNotMatch(read('.github/workflows/release.yml'), /actions: write|rollout/)
  // The run name carries the tag, so a tag that already rolled out is found.
  assert.match(main, /^run-name: Rollout \$\{\{ inputs\.tag \|\| github\.event\.release\.tag_name \}\}\$\{\{ inputs\.stage == 'later' && ' \(later waves\)' \|\| '' \}\}\$\{\{ inputs\.dry_run && ' \(dry run\)' \|\| '' \}\}$/m)

  // The step's script, run against a stand-in gh.
  const lines = start.split('\n')
  const at = lines.findIndex((line) => /^ {8}run: \|$/.test(line))
  const script = lines.slice(at + 1).filter((line) => line.trim()).map((line) => line.slice(10)).join('\n')
  const dir = tmp('rollout-start')
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/sh',
    'case "$1 $2" in',
    '  "api "*) echo "$FAKE_PUBLISHED" ;;',
    '  "release view") echo "$FAKE_KIND" ;;',
    '  "run list") printf "%b" "$FAKE_TITLES" ;;',
    '  "workflow run") echo "$*" >> "$FAKE_LOG" ;;',
    'esac',
  ].join('\n'), { mode: 0o755 })
  const go = (over) => {
    const log = join(dir, `log-${Math.random()}`)
    writeFileSync(log, '')
    const env = { PATH: `${dir}:${process.env.PATH}`, GITHUB_REPOSITORY: 'n8watkins/release-kit', RUN_ID: '1', TAG: 'v2.7.0', FAKE_PUBLISHED: '1', FAKE_KIND: 'release', FAKE_TITLES: 'Rollout v2.6.0\\nRollout v2.7.0 (dry run)\\n', FAKE_LOG: log, ...over }
    const result = attempt(dir, 'sh', ['-ec', script], env)
    assert.equal(result.status, 0, result.stderr)
    return { started: readFileSync(log, 'utf8').trim(), notice: result.stdout }
  }
  assert.equal(go({}).started, 'workflow run rollout.yml -R n8watkins/release-kit -f tag=v2.7.0 -f dry_run=false')
  for (const [over, why] of [
    [{ TAG: 'main' }, /not a release tag/],
    [{ TAG: 'v2.7.0-rc.1' }, /not a release tag/],
    [{ FAKE_PUBLISHED: '0' }, /published no release/],
    [{ FAKE_KIND: 'pre-release' }, /is a pre-release/],
    [{ FAKE_TITLES: 'Rollout v2.7.0\\n' }, /already has a rollout/],
  ]) {
    const { started, notice } = go(over)
    assert.equal(started, '', JSON.stringify(over))
    assert.match(notice, why)
  }
})

test("the lock file moves to the kit at the new tag, not only package.json's pin (v2.6.0 rollout)", () => {
  // The kit as a git dependency with two tags, served from disk.
  const dir = tmp('rollout-lock')
  const kit = join(dir, 'kit')
  mkdirSync(kit)
  run(kit, 'git', ['init', '-q', '-b', 'main'])
  for (const version of ['1.0.0', '1.1.0']) {
    writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: 'release-kit', version }))
    run(kit, 'git', ['add', '-A'])
    run(kit, 'git', ['commit', '-q', '-m', version])
    run(kit, 'git', ['tag', `v${version}`])
  }
  const app = join(dir, 'app')
  mkdirSync(app)
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', npm_config_cache: join(dir, 'npm-cache') }
  const manifest = (tag) => `{\n    "name": "app",\n    "version": "1.0.0",\n    "devDependencies": {\n        "release-kit": "git+file://${kit}#${tag}"\n    }\n}\n`
  writeFileSync(join(app, 'package.json'), manifest('v1.0.0'))
  execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app, env: { ...env, npm_config_allow_git: 'root' }, stdio: 'ignore' })
  const locked = () => JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8')).packages['node_modules/release-kit'].version
  assert.equal(locked(), '1.0.0')

  // apply moves the pin; npm 10 and 11 alone would keep the lock on 1.0.0.
  writeFileSync(join(app, 'package.json'), manifest('v1.1.0'))
  updateLock(app, 'v1.1.0', env)
  assert.equal(locked(), '1.1.0')
  assert.equal(readFileSync(join(app, 'package.json'), 'utf8'), manifest('v1.1.0'), "package.json stays apply's, byte for byte")
  // A lock that still doesn't match the tag stops the rollout for that repo.
  assert.throws(() => updateLock(app, 'v1.2.0', env), /lock file has release-kit 1.1.0 after npm install, not v1.2.0/)
})

// The soak (F6): a patch or minor kit release runs on the canary for
// adopters.json "soakHours" before the public and private waves get it, and
// only while the canary stays healthy.
test('adopters.json soakHours: 24 by default, 0 turns the soak off, anything else is refused', () => {
  assert.equal(parseAdopters(file([adopter()])).soakHours, 24)
  assert.equal(parseAdopters(JSON.stringify({ bot: 'b[bot]', soakHours: 0, adopters: [adopter()] })).soakHours, 0)
  for (const bad of [-1, 1.5, '24', 1000]) {
    assert.throws(() => parseAdopters(JSON.stringify({ bot: 'b[bot]', soakHours: bad, adopters: [adopter()] })), /"soakHours" must be a whole number of hours from 0 to 720/, String(bad))
  }
  assert.throws(() => parseAdopters(JSON.stringify({ bot: 'b[bot]', soak: 24, adopters: [adopter()] })), /unknown key "soak"/)
  // The repo's own file states it at the top.
  assert.equal(JSON.parse(read('adopters.json')).soakHours, 24)
})

test('laterWaves: a real patch or minor rollout defers the later waves to after the soak; a dry run, a major or skip_soak runs them now', () => {
  const canary = [adopter({ wave: 'canary' })]
  assert.equal(laterWaves({ canary }), 'deferred')
  assert.equal(laterWaves({ canary, dryRun: true }), 'now')
  assert.equal(laterWaves({ canary, major: true }), 'now')
  assert.equal(laterWaves({ canary, skipSoak: true }), 'now')
  assert.equal(laterWaves({ canary, soakHours: 0 }), 'now')
  // Without the canary in the run there is nothing to soak.
  assert.equal(laterWaves({ canary: [] }), 'now')
  assert.equal(laterWaves({ canary, stage: 'later' }), 'check')
  assert.equal(laterWaves({ canary, stage: 'later', skipSoak: true }), 'now')
  assert.throws(() => laterWaves({ stage: 'soon' }), /--stage must be auto or later/)
})

test('soakState: ready only once the soak is over, the branch still pins the tag and every check on its head passed', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  const base = { tag: 'v2.11.0', adopter: { repo: 'acme/canary', branch: 'main' }, pin: '2.11.0', soakHours: 24, now }
  const pr = (mergedAt) => ({ url: 'https://github.com/acme/canary/pull/9', merged: true, mergedAt })
  const head = (checks, failed = []) => ({ sha: 'c'.repeat(40), date: '2026-11-26T00:00:00Z', checks, failed })
  const ready = soakState({ ...base, pr: pr('2026-11-25T11:00:00Z'), head: head('green') })
  assert.deepEqual(ready.state, 'ready')
  assert.match(ready.why, /acme\/canary main has run v2\.11\.0 since 2026-11-25 11:00 UTC \(24-hour soak over\), and every check on cccccccccccc passed/)
  const early = soakState({ ...base, pr: pr('2026-11-26T01:00:00Z'), head: head('green') })
  assert.deepEqual([early.state, early.why], ['waiting', 'acme/canary main took v2.11.0 at 2026-11-26 01:00 UTC; the 24-hour soak ends at 2026-11-27 01:00 UTC'])
  // A red check stops it at once, soak or not; so does a pin that moved away.
  const red = soakState({ ...base, pr: pr('2026-11-26T01:00:00Z'), head: head('red', ['CI result']) })
  assert.deepEqual([red.state, red.why], ['unhealthy', 'a check failed on acme/canary main (cccccccccccc) after the update: CI result'])
  assert.match(soakState({ ...base, pin: '2.10.1', pr: pr('2026-11-25T01:00:00Z'), head: head('green') }).why, /pins release-kit 2\.10\.1, not v2\.11\.0: was the update reverted\?/)
  // The pin moved without the bot's pull request merging: the gate's time stands in.
  assert.equal(soakState({ ...base, pr: null, gateTime: '2026-11-25T10:00:00Z', head: head('green') }).state, 'ready')
  assert.match(soakState({ ...base, pr: null, head: head('green') }).why, /can't tell when acme\/canary main took v2\.11\.0/)
  // Checks still running or never reported: wait, and after a day more, say so.
  assert.equal(soakState({ ...base, pr: pr('2026-11-25T11:00:00Z'), head: head('pending') }).state, 'waiting')
  const stuck = soakState({ ...base, pr: pr('2026-11-24T00:00:00Z'), head: head('none') })
  assert.deepEqual([stuck.state, stuck.why], ['unhealthy', "the soak is over, but on acme/canary main's head commit (cccccccccccc) no check has reported a day later"])
  assert.equal(soakState({ ...base, soakHours: 0, pr: pr('2026-11-26T11:59:00Z'), head: head('green') }).state, 'ready')
})

test('pendingSoak finds the newest rollout that deferred its later waves and has not started them', () => {
  const runs = [
    { id: 1, display_title: 'Rollout v2.10.0', status: 'completed', conclusion: 'success', created_at: '2026-11-01T00:00:00Z' },
    { id: 2, display_title: 'Rollout v2.11.0 (dry run)', status: 'completed', conclusion: 'success', created_at: '2026-11-25T00:00:00Z' },
    { id: 3, display_title: 'Rollout v2.11.0', status: 'completed', conclusion: 'success', created_at: '2026-11-25T01:00:00Z' },
    { id: 4, display_title: 'Rollout soak', status: 'completed', conclusion: 'success', created_at: '2026-11-25T02:00:00Z' },
  ]
  const jobs = {
    3: [
      { name: 'Plan the waves', conclusion: 'success', completed_at: '2026-11-25T01:01:00Z' },
      { name: 'Canary merged / portfolio-rank', conclusion: 'success', completed_at: '2026-11-25T01:20:00Z' },
      { name: DEFER_JOB, conclusion: 'success', completed_at: '2026-11-25T01:21:00Z' },
    ],
  }
  const jobsOf = (id) => jobs[id] ?? []
  assert.deepEqual(pendingSoak(runs, jobsOf), { tag: 'v2.11.0', runId: 3, gateTime: '2026-11-25T01:20:00Z' })
  // Already started, still running, failed, or a run that deferred nothing: none.
  assert.match(pendingSoak([...runs, { id: 5, display_title: 'Rollout v2.11.0 (later waves)', status: 'in_progress' }], jobsOf).why, /later waves of v2\.11\.0 already started/)
  assert.match(pendingSoak([{ ...runs[2], status: 'in_progress', conclusion: null }], jobsOf).why, /still running/)
  assert.match(pendingSoak([{ ...runs[2], conclusion: 'failure' }], jobsOf).why, /ended in failure, so its later waves don't start on their own/)
  assert.match(pendingSoak([runs[2]], () => []).why, /deferred nothing/)
  // A newer release supersedes an older one still waiting.
  assert.match(pendingSoak([...runs, { id: 6, display_title: 'Rollout v2.12.0', status: 'in_progress' }], jobsOf).why, /rollout of v2\.12\.0 is still running/)
  assert.match(pendingSoak([], jobsOf).why, /no real rollout run yet/)
})

test('soak-check and pending read GitHub through gh, and held opens the rollout issue once', () => {
  const dir = tmp('rollout-soak')
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_LOG, args.join(' ') + '\\n')
const state = JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8'))
const path = args.find((a) => a.startsWith('repos/')) ?? args.slice(0, 2).join(' ')
const hit = Object.entries(state).find(([prefix]) => path.startsWith(prefix))
if (!hit) { console.error('HTTP 404: ' + path); process.exit(1) }
process.stdout.write(typeof hit[1] === 'string' ? hit[1] : JSON.stringify(hit[1]))
`, { mode: 0o755 })
  const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000).toISOString()
  const canary = { repo: 'acme/canary', owner: 'acme', name: 'canary', branch: 'main' }
  const pkg = (v) => ({ content: Buffer.from(JSON.stringify({ devDependencies: { 'release-kit': `github:n8watkins/release-kit#v${v}` } })).toString('base64') })
  const state = (over = {}) => ({
    'repos/acme/canary/contents/package.json': pkg('2.11.0'),
    'repos/acme/canary/pulls?': [{ number: 9, title: prTitle('v2.11.0'), state: 'closed', merged_at: hoursAgo(30), html_url: 'https://github.com/acme/canary/pull/9', head: { sha: 'a'.repeat(40) } }],
    'repos/acme/canary/commits/main': { sha: 'c'.repeat(40), commit: { committer: { date: hoursAgo(30) } } },
    [`repos/acme/canary/commits/${'c'.repeat(40)}/check-runs`]: { check_runs: [{ name: 'CI result', status: 'completed', conclusion: 'success' }] },
    [`repos/acme/canary/commits/${'c'.repeat(40)}/status`]: { state: 'success', total_count: 0 },
    ...over,
  })
  const go = (args, s) => {
    writeFileSync(join(dir, 'state.json'), JSON.stringify(s))
    writeFileSync(join(dir, 'log'), '')
    writeFileSync(join(dir, 'out'), '')
    const result = attempt(KIT, 'node', ['scripts/rollout.mjs', ...args], { PATH: `${dir}:${process.env.PATH}`, FAKE_STATE: join(dir, 'state.json'), FAKE_LOG: join(dir, 'log'), GITHUB_OUTPUT: join(dir, 'out'), GITHUB_REPOSITORY: 'n8watkins/release-kit' })
    return { ...result, out: Object.fromEntries(readFileSync(join(dir, 'out'), 'utf8').trim().split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])), log: readFileSync(join(dir, 'log'), 'utf8') }
  }
  const check = (s, more = []) => go(['soak-check', '--tag', 'v2.11.0', '--canaries', JSON.stringify([canary]), '--soak-hours', '24', ...more], s)

  const ready = check(state())
  assert.equal(ready.status, 0, ready.stderr)
  assert.equal(ready.out.state, 'ready')
  const early = check(state({ 'repos/acme/canary/pulls?': [{ number: 9, title: prTitle('v2.11.0'), state: 'closed', merged_at: hoursAgo(2), html_url: 'u', head: { sha: 'a'.repeat(40) } }] }))
  assert.equal(early.out.state, 'waiting')
  // The later waves' own run fails its soak job unless ready.
  const required = check(state({ 'repos/acme/canary/pulls?': [{ number: 9, title: prTitle('v2.11.0'), state: 'closed', merged_at: hoursAgo(2), html_url: 'u', head: { sha: 'a'.repeat(40) } }] }), ['--require-ready'])
  assert.equal(required.status, 1)
  assert.match(required.stderr, /the later waves of v2\.11\.0 don't start yet: .*soak ends at .*\(or run with skip_soak for an urgent fix\)/)
  const red = check(state({ [`repos/acme/canary/commits/${'c'.repeat(40)}/check-runs`]: { check_runs: [{ name: 'E2E', status: 'completed', conclusion: 'failure' }] } }))
  assert.deepEqual([red.out.state, red.out.why], ['unhealthy', `a check failed on acme/canary main (${'c'.repeat(12)}) after the update: E2E`])

  // pending: the rollout runs and their jobs, through release-kit's token.
  const runs = { workflow_runs: [{ id: 3, display_title: 'Rollout v2.11.0', status: 'completed', conclusion: 'success', created_at: hoursAgo(30) }] }
  const jobs = { jobs: [{ name: 'Canary merged / canary', conclusion: 'success', completed_at: hoursAgo(29) }, { name: DEFER_JOB, conclusion: 'success', completed_at: hoursAgo(29) }] }
  const pend = go(['pending'], { 'repos/n8watkins/release-kit/actions/workflows/rollout.yml/runs': runs, 'repos/n8watkins/release-kit/actions/runs/3/jobs': jobs })
  assert.equal(pend.status, 0, pend.stderr)
  assert.equal(pend.out.tag, 'v2.11.0')
  assert.equal(pend.out['soak-hours'], '24')
  assert.equal(pend.out['canary-owner'], 'n8watkins')
  assert.equal(pend.out['canary-names'], 'portfolio-rank')
  const nothing = go(['pending'], { 'repos/n8watkins/release-kit/actions/workflows/rollout.yml/runs': { workflow_runs: [] } })
  assert.equal(nothing.out.tag, '')

  // held: one issue per tag, never a second.
  const issue = go(['held', '--tag', 'v2.11.0', '--why', 'a check failed'], { 'issue list': '[]', 'label create': '', 'issue create': 'https://github.com/n8watkins/release-kit/issues/1' })
  assert.equal(issue.status, 0, issue.stderr)
  assert.match(issue.log, /^issue create -R n8watkins\/release-kit --title Rollout of v2\.11\.0 held: the canary is not healthy --label release-kit: rollout --body The later waves of v2\.11\.0 \(public, private\) are held: a check failed\./m)
  const again = go(['held', '--tag', 'v2.11.0', '--why', 'a check failed'], { 'issue list': JSON.stringify([{ number: 1, title: 'Rollout of v2.11.0 held: the canary is not healthy' }]) })
  assert.doesNotMatch(again.log, /issue create/)
  assert.match(heldReport({ tag: 'v2.11.0', why: 'x' }), /run Rollout for v2\.11\.0 with stage `later`, dry run off and `skip_soak` on/)
})

test('the rollout defers its later waves to the hourly resume, which starts them after the soak; skip_soak and a major run them at once', () => {
  const main = read('.github/workflows/rollout.yml')
  const resume = read('.github/workflows/rollout-resume.yml')
  for (const input of ['stage', 'skip_soak']) assert.match(main, new RegExp(`^ {6}${input}:$`, 'm'))
  assert.match(main, /skip_soak:\n(?: {8}.*\n)*? {8}default: false/)
  // The defer job ends a real patch or minor run once the canary merged; the resume finds it by name.
  const defer = main.slice(main.indexOf('\n  defer:\n'), main.indexOf('\n  soak:\n'))
  assert.match(defer, new RegExp(`name: ${DEFER_JOB}\n`))
  assert.match(defer, /needs\.canary-merged\.result == 'success' && needs\.plan\.outputs\.later == 'deferred'/)
  // The later waves' own run checks the soak first, with a read-only token for the canary.
  const soak = main.slice(main.indexOf('\n  soak:\n'), main.indexOf('\n  public:\n'))
  assert.match(soak, /if: needs\.plan\.outputs\.later == 'check'/)
  assert.match(soak, /permission-contents: read\n {10}permission-pull-requests: read\n/)
  assert.match(soak, /soak-check --tag "\$TAG" --canaries "\$CANARIES" --soak-hours "\$HOURS" --require-ready/)
  // Neither later wave runs in a deferred run, nor after a soak that isn't over.
  assert.equal(main.match(/needs\.plan\.outputs\.later != 'deferred'/g).length, 2)
  assert.equal(main.match(/needs\.soak\.result == 'success' \|\| needs\.soak\.result == 'skipped'/g).length, 2)
  // The resume: hourly, only in release-kit, and it starts Rollout for real with stage later.
  assert.match(resume, /^ {2}schedule:\n {4}- cron: "23 \* \* \* \*"$/m)
  assert.match(resume, /if: github\.repository == 'n8watkins\/release-kit'/)
  assert.match(resume, /node scripts\/rollout\.mjs pending\n/)
  assert.match(resume, /gh workflow run rollout\.yml -R "\$GITHUB_REPOSITORY" -f tag="\$TAG" -f stage=later -f dry_run=false/)
  assert.match(resume, /if: steps\.soak\.outputs\.state == 'ready'/)
  assert.match(resume, /if: steps\.soak\.outputs\.state == 'unhealthy'\n(?: {8}.*\n)*? {8}run: node scripts\/rollout\.mjs held --tag "\$TAG" --why "\$WHY"/)
  // rollout-start still finds a tag that already rolled out by its exact name: the later waves' run is another name.
  assert.match(read('.github/workflows/rollout-start.yml'), /grep -Fqx "Rollout \$TAG"/)
})
