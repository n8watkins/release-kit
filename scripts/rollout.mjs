#!/usr/bin/env node
// The rollout bot (docs/ROADMAP.md, item 8): after a kit release, run apply in
// every adopter and open one pull request each. .github/workflows/rollout.yml
// runs it; it is not shipped to adopters.
//
//   node scripts/rollout.mjs plan --tag vX.Y.Z [--repos a,b] [--adopters adopters.json]
//       [--tags v1.0.0,v1.1.0] [--dry-run]
//       check adopters.json and print the waves (canary, public, private) and
//       whether the tag is a major release (against --tags, or the kit repo's
//       tags) as JSON; in GitHub Actions, also as step outputs for the jobs
//   node scripts/rollout.mjs update --adopter '<json>' --tag vX.Y.Z --kit <dir>
//       --target <dir> [--notes <file>] [--dry-run]
//       in one adopter's checkout: run the kit's apply (from <dir>, the kit at
//       the tag), update the lock file, and open or update the pull request
//       from release-kit/update (GH_TOKEN: the App's token for that repo);
//       --dry-run prints the pull request instead of pushing anything
//   node scripts/rollout.mjs wait-merge --adopter '<json>' --tag vX.Y.Z
//       [--timeout-minutes 60] [--interval-seconds 30]
//       the gate after the canary: wait until the adopter's branch pins the
//       tag (its update pull request merged), and fail as soon as that pull
//       request is closed unmerged or a check on it fails, or at the timeout
//   node scripts/rollout.mjs report --tag vX.Y.Z --run-id <id>
//       after a failed rollout: open or comment on the issue labeled
//       "release-kit: rollout" in release-kit, naming each failed job
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checksState, kitVersion } from './release-kit/automerge.mjs'

export const WAVES = ['canary', 'public', 'private']
export const MERGE_POLICIES = ['auto-merge', 'merge-when-green', 'person']
export const BRANCH = 'release-kit/update'
const KIT_REPO = 'n8watkins/release-kit'
const SLUG = /^[\w.-]+\/[\w.-]+$/
const TAG = /^v\d+\.\d+\.\d+$/
export const ISSUE_LABEL = 'release-kit: rollout'
// GitHub refuses a pull request description longer than 65536 characters.
const BODY_LIMIT = 60000

/**
 * adopters.json, checked: every problem is reported at once.
 * @returns {{ bot: string, adopters: Array<{ repo: string, name: string, owner: string, branch: string, visibility: string, wave: string, merge: string, enabled: boolean, reason?: string, note?: string }> }}
 */
export function parseAdopters(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new Error(`adopters.json is not valid JSON: ${error.message}`)
  }
  const problems = []
  if (typeof data?.bot !== 'string' || !/^[\w-]+\[bot\]$/.test(data.bot)) problems.push('"bot" must be the App\'s login, like my-app[bot]')
  if (!Array.isArray(data?.adopters) || !data.adopters.length) problems.push('"adopters" must be a non-empty list')
  const seen = new Set()
  const adopters = (Array.isArray(data?.adopters) ? data.adopters : []).map((a, i) => {
    const where = `adopters[${i}]${typeof a?.repo === 'string' ? ` (${a.repo})` : ''}`
    if (typeof a !== 'object' || a === null) {
      problems.push(`${where} must be an object`)
      return null
    }
    if (typeof a.repo !== 'string' || !SLUG.test(a.repo)) problems.push(`${where}: "repo" must be owner/name`)
    else if (seen.has(a.repo.toLowerCase())) problems.push(`${where}: listed twice`)
    else seen.add(a.repo.toLowerCase())
    // The branch the pull request targets; checked out and pushed through git, so no surprises.
    if (typeof a.branch !== 'string' || !/^[\w.][\w./-]*$/.test(a.branch) || a.branch.includes('..')) problems.push(`${where}: "branch" must be the branch to target, like main`)
    if (!['public', 'private'].includes(a.visibility)) problems.push(`${where}: "visibility" must be public or private`)
    if (!WAVES.includes(a.wave)) problems.push(`${where}: "wave" must be one of ${WAVES.join(', ')}`)
    // The public and private waves hold what their names say; the canary can be either.
    else if (a.wave !== 'canary' && ['public', 'private'].includes(a.visibility) && a.wave !== a.visibility) problems.push(`${where}: a ${a.visibility} repo belongs in the ${a.visibility} wave (or the canary), not ${a.wave}`)
    if (!MERGE_POLICIES.includes(a.merge)) problems.push(`${where}: "merge" must be one of ${MERGE_POLICIES.join(', ')}`)
    if (typeof a.enabled !== 'boolean') problems.push(`${where}: "enabled" must be true or false`)
    else if (!a.enabled && (typeof a.reason !== 'string' || !a.reason.trim())) problems.push(`${where}: a disabled adopter needs a "reason"`)
    for (const key of ['reason', 'note']) if (a[key] !== undefined && typeof a[key] !== 'string') problems.push(`${where}: "${key}" must be text`)
    const known = new Set(['repo', 'branch', 'visibility', 'wave', 'merge', 'enabled', 'reason', 'note'])
    for (const key of Object.keys(a)) if (!known.has(key)) problems.push(`${where}: unknown key "${key}"`)
    const [owner, name] = typeof a.repo === 'string' ? a.repo.split('/') : []
    return { ...a, owner, name }
  })
  if (problems.length) throw new Error(`adopters.json:\n  - ${problems.join('\n  - ')}`)
  return { bot: data.bot, adopters }
}

/**
 * The waves for one rollout, in order: the enabled adopters, narrowed to
 * `repos` (names or owner/name; empty means all). Naming a disabled adopter
 * skips it with its reason, except in a dry run, which checks it read-only (a
 * repo the App isn't installed on yet fails there, at the token); naming one
 * that isn't listed is an error.
 */
export function planWaves(adopters, repos = [], { dryRun = false } = {}) {
  const wanted = repos.map((r) => r.trim().toLowerCase()).filter(Boolean)
  const matches = (a, r) => a.repo.toLowerCase() === r || a.name.toLowerCase() === r
  const unknown = wanted.filter((r) => !adopters.some((a) => matches(a, r)))
  if (unknown.length) throw new Error(`not in adopters.json: ${unknown.join(', ')}`)
  const picked = wanted.length ? adopters.filter((a) => wanted.some((r) => matches(a, r))) : adopters
  const plan = Object.fromEntries(WAVES.map((w) => [w, []]))
  plan.skipped = []
  for (const a of picked) {
    if (!a.enabled && !(dryRun && wanted.length)) {
      plan.skipped.push({ repo: a.repo, reason: a.reason })
      continue
    }
    plan[a.wave].push({ repo: a.repo, owner: a.owner, name: a.name, branch: a.branch, visibility: a.visibility, merge: a.merge, note: a.note ?? '' })
  }
  return plan
}

/** `(#12)` in the kit's notes is a release-kit pull request, not one in the adopter. */
export function linkReleaseNotes(notes, kitRepo = KIT_REPO) {
  return notes.replace(/(^|[^\w/#&-])#(\d+)\b/g, `$1${kitRepo}#$2`)
}

/** `git status --porcelain` to added, changed and removed paths. */
export function filesFromStatus(status) {
  const files = { added: [], changed: [], removed: [] }
  for (const line of status.split('\n').filter(Boolean)) {
    const code = line.slice(0, 2)
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1]
    path = path.replace(/^"(.*)"$/, '$1')
    if (code.includes('?') || code.includes('A')) files.added.push(path)
    else if (code.includes('D')) files.removed.push(path)
    else files.changed.push(path)
  }
  for (const list of Object.values(files)) list.sort()
  return files
}

const MERGE_TEXT = {
  'auto-merge': 'The repo requires checks and allows auto-merge, so its auto-merge workflow turns on GitHub\'s auto-merge for this pull request: it merges once the required checks pass. A major kit update waits for a person.',
  'merge-when-green': 'The repo requires no checks, so its auto-merge workflow merges this pull request once every check on it has passed (merge when green). A major kit update waits for a person.',
  person: 'A person reviews and merges this pull request.',
}

/** The pull request's title. */
export const prTitle = (tag) => `ci: update release-kit to ${tag}`

/**
 * The pull request's description: what apply changed, its notes, how the
 * pull request merges, and the release notes.
 */
export function prBody({ tag, adopter, files, notes = [], releaseNotes = '', runUrl = '', kitRepo = KIT_REPO }) {
  const list = (paths) => paths.map((p) => `- \`${p}\``).join('\n')
  const sections = [
    `Updates [release-kit](https://github.com/${kitRepo}) to [${tag}](https://github.com/${kitRepo}/releases/tag/${tag}) by running \`release-kit apply\` and updating the lock file.`,
    `The rollout bot (${kitRepo}'s \`rollout.yml\`${runUrl ? `, [this run](${runUrl})` : ''}) opened it, and the next kit release overwrites the \`${BRANCH}\` branch, so make other fixes on \`${adopter.branch}\`.`,
  ]
  const changed = [['Added', files.added], ['Changed', files.changed], ['Removed', files.removed]].filter(([, paths]) => paths.length)
  sections.push(`## What changed\n\n${changed.length ? changed.map(([label, paths]) => `${label}:\n\n${list(paths)}`).join('\n\n') : 'Nothing: the repo is already on this version.'}`)
  if (notes.length) sections.push(`## Needs a look\n\napply left these for a person:\n\n${notes.map((n) => `- ${n}`).join('\n')}`)
  sections.push(`## How it merges\n\n${MERGE_TEXT[adopter.merge] ?? MERGE_TEXT.person}${adopter.note ? `\n\n${adopter.note}` : ''}`)
  const header = sections.join('\n\n')
  let notesText = linkReleaseNotes(releaseNotes.trim(), kitRepo) || '(The release has no notes.)'
  const room = BODY_LIMIT - header.length - 200
  if (notesText.length > room) notesText = `${notesText.slice(0, Math.max(room, 0))}\n\n(Cut short: the full notes are on the release page.)`
  return `${header}\n\n## Release notes for ${tag}\n\n${notesText}\n`
}

/**
 * Whether `tag` starts a new major version: its major differs from the one of
 * the highest release tag below it (or there is none). A major rollout waits
 * for the owner in the `rollout-major` environment; a patch or minor one
 * gates itself on the canary.
 */
export function isMajorRelease(tag, tags = []) {
  const parse = (t) => (TAG.test(t) ? t.slice(1).split('.').map(Number) : null)
  const me = parse(tag)
  if (!me) throw new Error(`"${tag}" is not a release tag like v2.6.0`)
  const below = tags.map(parse).filter((v) => v && (v[0] - me[0] || v[1] - me[1] || v[2] - me[2]) < 0)
  if (!below.length) return true
  below.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])
  return below[0][0] !== me[0]
}

/**
 * Where the canary's update stands, for the gate after the canary wave.
 *   pin     the release-kit version the adopter's branch pins now (or null)
 *   pr      the newest update pull request for the tag ({ number, state,
 *           merged, url }), or null
 *   checks  'green' | 'pending' | 'red' | null (unreadable) for its head commit
 *   failed  the names of its failed checks
 * Returns { state: 'merged' | 'pending' | 'failed', why }.
 */
export function mergeState({ tag, adopter, pin, pr, checks, failed = [] }) {
  const version = tag.replace(/^v/, '')
  if (pin === version) return { state: 'merged', why: `${adopter.branch} pins release-kit ${tag}${pr?.merged ? ` (${pr.url} merged)` : ''}` }
  if (!pr) return { state: 'failed', why: `no update pull request for ${tag}, and ${adopter.branch} pins ${pin ? `release-kit ${pin}` : 'no release-kit version'}` }
  if (pr.merged) return { state: 'pending', why: `${pr.url} merged; waiting for ${adopter.branch} to pin ${tag}` }
  if (pr.state !== 'open') return { state: 'failed', why: `${pr.url} was closed without merging` }
  if (checks === 'red') return { state: 'failed', why: `a check failed on ${pr.url}${failed.length ? `: ${failed.join(', ')}` : ''}` }
  return { state: 'pending', why: `${pr.url} is open, checks ${checks ?? 'unreadable'}` }
}

/**
 * The issue text for a failed rollout: which jobs failed (a wave's job is
 * named for its adopter), with links, and what to do next.
 *   jobs  the run's jobs ({ name, conclusion, html_url })
 */
export function failureReport({ tag, runUrl, jobs }) {
  const failed = jobs.filter((j) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(j.conclusion))
  const lines = failed.length
    ? failed.map((j) => `- **${j.name}**: ${j.conclusion.replace('_', ' ')}, [log](${j.html_url})`)
    : ['- No job failed outright: open the run to see what stopped it.']
  return [
    `The rollout of ${tag} stopped: [the run](${runUrl}).`,
    '',
    ...lines,
    '',
    'The waves after a failure did not run, so those adopters are still on the previous kit.',
    `Fix the cause (the adopter's update pull request, from \`${BRANCH}\`, or the kit itself), then run Rollout again for ${tag} with dry run off, or release a fix.`,
    'Close this issue once the rollout is through.',
  ].join('\n')
}

// --- the command line -------------------------------------------------------

function args(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) out._.push(a)
    else if (a === '--dry-run') out['dry-run'] = true
    else {
      if (argv[i + 1] === undefined) throw new Error(`${a} needs a value`)
      out[a.slice(2)] = argv[++i]
    }
  }
  return out
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}
function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
}

function plan(opts) {
  if (!TAG.test(opts.tag ?? '')) throw new Error(`--tag must be a release tag like v2.6.0, not "${opts.tag ?? ''}"`)
  const file = opts.adopters ?? fileURLToPath(new URL('../adopters.json', import.meta.url))
  const { adopters } = parseAdopters(readFileSync(file, 'utf8'))
  const dryRun = Boolean(opts['dry-run'])
  const waves = planWaves(adopters, (opts.repos ?? '').split(','), { dryRun })
  // The release tags, to tell a major from a patch or minor.
  const tags = opts.tags !== undefined
    ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : execFileSync('git', ['ls-remote', '--tags', '--refs', `https://github.com/${process.env.GITHUB_REPOSITORY || KIT_REPO}.git`], { encoding: 'utf8' })
      .split('\n').map((line) => line.split('refs/tags/')[1]).filter(Boolean)
  waves.major = isMajorRelease(opts.tag, tags)
  for (const wave of WAVES) output(wave, JSON.stringify(waves[wave]))
  output('major', String(waves.major))
  const lines = [`## Rollout of ${opts.tag}${dryRun ? ' (dry run)' : ''}`, '']
  lines.push(waves.major
    ? `A major release: each wave waits for the owner's approval in the \`rollout-major\` environment.`
    : 'A patch or minor release: no approval; the public and private waves start once the canary\'s update pull request has merged.')
  lines.push('')
  for (const wave of WAVES) lines.push(`- **${wave}**: ${waves[wave].map((a) => a.repo).join(', ') || 'none'}`)
  for (const s of waves.skipped) lines.push(`- skipped ${s.repo}: ${s.reason}`)
  summary(lines.join('\n'))
  console.log(JSON.stringify(waves, null, 2))
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** gh api, parsed; null when the call fails (a 404, or a token that may not read it). */
function ghApi(path) {
  try {
    return JSON.parse(execFileSync('gh', ['api', '-H', 'Accept: application/vnd.github+json', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 ** 2 }))
  } catch {
    return null
  }
}

/** One look at the adopter: the pin on its branch, its update pull request, and that pull request's checks. */
function lookAtAdopter(adopter, tag) {
  const manifest = ghApi(`repos/${adopter.repo}/contents/package.json?ref=${encodeURIComponent(adopter.branch)}`)
  let pin = null
  try {
    const pkg = JSON.parse(Buffer.from(manifest?.content ?? '', 'base64').toString('utf8') || '{}')
    pin = kitVersion(pkg.devDependencies?.['release-kit'] ?? pkg.dependencies?.['release-kit'])
  } catch {}
  const pulls = ghApi(`repos/${adopter.repo}/pulls?state=all&head=${encodeURIComponent(`${adopter.owner}:${BRANCH}`)}&base=${encodeURIComponent(adopter.branch)}&sort=created&direction=desc&per_page=20`) ?? []
  const raw = pulls.find((p) => p.title === prTitle(tag))
  const pr = raw ? { number: raw.number, state: raw.state, merged: Boolean(raw.merged_at), url: raw.html_url, sha: raw.head.sha } : null
  let checks = null
  let failed = []
  if (pr && pr.state === 'open') {
    // Reading checks needs no App permission on a public repo; on a private one
    // it may be refused, and then only the merge or the timeout decides.
    const runs = ghApi(`repos/${adopter.repo}/commits/${pr.sha}/check-runs?per_page=100`)?.check_runs
    const statuses = ghApi(`repos/${adopter.repo}/commits/${pr.sha}/status`)
    if (runs) {
      checks = checksState(runs, statuses ?? undefined)
      failed = runs.filter((r) => r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion)).map((r) => r.name)
    }
  }
  return { pin, pr, checks, failed }
}

function waitMerge(opts) {
  const adopter = JSON.parse(opts.adopter ?? 'null')
  if (!adopter || !SLUG.test(adopter.repo ?? '')) throw new Error('--adopter must be one adopter from the plan, as JSON')
  if (!TAG.test(opts.tag ?? '')) throw new Error(`--tag must be a release tag like v2.6.0, not "${opts.tag ?? ''}"`)
  const timeout = Number(opts['timeout-minutes'] ?? 60) * 60_000
  const interval = Number(opts['interval-seconds'] ?? 30) * 1000
  const deadline = Date.now() + timeout
  let last = ''
  for (;;) {
    const result = mergeState({ tag: opts.tag, adopter, ...lookAtAdopter(adopter, opts.tag) })
    if (result.why !== last) console.log(`${adopter.repo}: ${result.why}`)
    last = result.why
    if (result.state === 'merged') {
      summary(`### Canary ${adopter.repo}\n\nMerged: ${result.why}. The next waves start.`)
      return
    }
    if (result.state === 'failed') throw new Error(`${adopter.repo}: ${result.why}`)
    if (Date.now() + interval > deadline) throw new Error(`${adopter.repo}: not merged after ${opts['timeout-minutes'] ?? 60} minutes (${result.why})`)
    pause(interval)
  }
}

function report(opts) {
  if (!TAG.test(opts.tag ?? '')) throw new Error(`--tag must be a release tag like v2.6.0, not "${opts.tag ?? ''}"`)
  const repo = process.env.GITHUB_REPOSITORY || KIT_REPO
  const runId = opts['run-id']
  if (!/^\d+$/.test(runId ?? '')) throw new Error('--run-id must be the rollout run\'s id')
  const gh = (...list) => execFileSync('gh', list, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] })
  const jobs = JSON.parse(gh('api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`)).flatMap((page) => page.jobs)
  const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${runId}`
  const body = failureReport({ tag: opts.tag, runUrl, jobs })
  console.log(body)
  const title = `Rollout of ${opts.tag} stopped`
  // The label may not exist yet; creating it twice is harmless.
  try {
    gh('label', 'create', ISSUE_LABEL, '-R', repo, '--color', 'B60205', '--description', 'A kit rollout that stopped and needs a look')
  } catch {}
  const open = JSON.parse(gh('issue', 'list', '-R', repo, '--label', ISSUE_LABEL, '--state', 'open', '--json', 'number,title', '--limit', '50'))
  const same = open.find((i) => i.title === title) ?? open[0]
  if (same) {
    gh('issue', 'comment', String(same.number), '-R', repo, '--body', `**${title}**\n\n${body}`)
    console.log(`commented on #${same.number}`)
  } else {
    console.log(gh('issue', 'create', '-R', repo, '--title', title, '--label', ISSUE_LABEL, '--body', body).trim())
  }
  summary(`## Rollout of ${opts.tag} stopped\n\n${body}`)
}

/**
 * The lock file, for the kit pin apply just wrote. npm 10 and 11 keep a git
 * dependency's locked commit when only its tag changes in package.json, so a
 * plain `npm install --package-lock-only` left v2.6.0's rollout locked to the
 * old kit and Dependabot opened a lock-only pull request after it. Naming the
 * kit makes npm resolve it again. package.json stays apply's, byte for byte.
 * npm 12 refuses git dependencies (EALLOWGIT) unless allowed; apply writes
 * allow-git=root to .npmrc, and the environment says the same for npm runs
 * that don't read it. No scripts run.
 */
export function updateLock(target, tag, env = process.env) {
  const manifest = join(target, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  const pkg = JSON.parse(before)
  const spec = pkg.devDependencies?.['release-kit'] ?? pkg.dependencies?.['release-kit']
  const args = ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']
  if (spec) args.push(`release-kit@${spec}`)
  execFileSync('npm', args, { cwd: target, stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, npm_config_allow_git: 'root' } })
  writeFileSync(manifest, before)
  if (!spec) return
  const locked = JSON.parse(readFileSync(join(target, 'package-lock.json'), 'utf8')).packages?.['node_modules/release-kit']?.version
  if (locked !== tag.replace(/^v/, '')) throw new Error(`the lock file has release-kit ${locked ?? '(none)'} after npm install, not ${tag}`)
}

function update(opts) {
  const adopter = JSON.parse(opts.adopter ?? 'null')
  if (!adopter || !SLUG.test(adopter.repo ?? '')) throw new Error('--adopter must be one adopter from the plan, as JSON')
  if (!TAG.test(opts.tag ?? '')) throw new Error(`--tag must be a release tag like v2.6.0, not "${opts.tag ?? ''}"`)
  const dryRun = Boolean(opts['dry-run'])
  const kit = resolve(opts.kit)
  const target = resolve(opts.target)
  const sh = (cmd, list, extra = {}) => execFileSync(cmd, list, { cwd: target, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2, ...extra })

  // The repo as GitHub sees it now: warn when adopters.json is out of date.
  const repoInfo = JSON.parse(sh('gh', ['api', `repos/${adopter.repo}`]))
  if (repoInfo.default_branch !== adopter.branch) console.log(`::warning::${adopter.repo}: adopters.json targets ${adopter.branch}, but the default branch is ${repoInfo.default_branch}`)
  if (repoInfo.visibility !== adopter.visibility) console.log(`::warning::${adopter.repo}: adopters.json says ${adopter.visibility}, but GitHub says ${repoInfo.visibility}`)
  if (!existsSync(join(target, 'package.json'))) throw new Error(`${adopter.repo} has no package.json on ${adopter.branch}: set "enabled": false in adopters.json`)

  // apply from the kit at the tag. --json since the rollout bot; an older apply
  // ignores the flag and prints its text report, and git status says what changed.
  const applied = spawnSync(process.execPath, [join(kit, 'apply.mjs'), target, '--json'], { cwd: target, encoding: 'utf8', maxBuffer: 64 * 1024 ** 2 })
  if (applied.status !== 0) throw new Error(`apply failed in ${adopter.repo}:\n${applied.stderr}${applied.stdout}`)
  let report = null
  try {
    report = JSON.parse(applied.stdout)
  } catch {}
  const notes = report?.notes ?? applied.stdout.split('\n').filter((l) => l.startsWith('  ! ')).map((l) => l.slice(4))
  console.log(report ? JSON.stringify(report, null, 2) : applied.stdout)

  const config = existsSync(join(target, '.release.json')) ? JSON.parse(readFileSync(join(target, '.release.json'), 'utf8')) : {}
  if ((config.workflows ?? 'package') === 'package' && existsSync(join(target, 'package-lock.json'))) updateLock(target, opts.tag)

  const status = sh('git', ['status', '--porcelain', '--untracked-files=all'])
  const files = filesFromStatus(status)
  // apply's own lists are exact; the lock file comes from npm, so git adds it.
  if (report?.files) for (const key of Object.keys(files)) files[key] = [...new Set([...report.files[key], ...files[key]])].sort()
  const releaseNotes = opts.notes && existsSync(opts.notes) ? readFileSync(opts.notes, 'utf8') : ''
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''
  const body = prBody({ tag: opts.tag, adopter, files, notes, releaseNotes, runUrl })
  const title = prTitle(opts.tag)

  if (!status.trim()) {
    console.log(`${adopter.repo} is already on ${opts.tag}: nothing to open`)
    summary(`### ${adopter.repo}\n\nAlready on ${opts.tag}: nothing to open.`)
    return
  }
  console.log(sh('git', ['diff', '--stat']))
  if (dryRun) {
    console.log(`Dry run: would open or update "${title}" in ${adopter.repo} from ${BRANCH} into ${adopter.branch}:\n\n${body}`)
    summary(`### ${adopter.repo} (dry run)\n\nWould open or update **${title}** from \`${BRANCH}\` into \`${adopter.branch}\`.\n\n<details><summary>Description</summary>\n\n${body}\n</details>`)
    return
  }

  // Commit as the App's bot user, so the commit and the pull request are its.
  const bot = opts.bot
  if (!/^[\w-]+\[bot\]$/.test(bot ?? '')) throw new Error('--bot must be the App\'s login, like my-app[bot]')
  const id = sh('gh', ['api', `users/${encodeURIComponent(bot)}`, '--jq', '.id']).trim()
  const identity = { GIT_AUTHOR_NAME: bot, GIT_AUTHOR_EMAIL: `${id}+${bot}@users.noreply.github.com`, GIT_COMMITTER_NAME: bot, GIT_COMMITTER_EMAIL: `${id}+${bot}@users.noreply.github.com` }
  sh('git', ['switch', '-C', BRANCH])
  sh('git', ['add', '-A'])
  // The adopter's own hooks don't run here: CI checks the commit message.
  sh('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', `${title}\n\nRelease-note: skip`], { env: { ...process.env, ...identity } })
  // The token goes in a header, never in the remote URL or the log.
  const auth = Buffer.from(`x-access-token:${process.env.GH_TOKEN}`).toString('base64')
  console.log(`::add-mask::${auth}`)
  sh('git', ['-c', `http.extraheader=AUTHORIZATION: basic ${auth}`, 'push', '--force', `https://github.com/${adopter.repo}.git`, `HEAD:refs/heads/${BRANCH}`], { stdio: ['ignore', 'inherit', 'inherit'] })
  const bodyFile = join(target, '..', `rollout-body-${adopter.name}.md`)
  writeFileSync(bodyFile, body)
  const open = JSON.parse(sh('gh', ['pr', 'list', '-R', adopter.repo, '--head', BRANCH, '--base', adopter.branch, '--state', 'open', '--json', 'number,url']))
  let url
  if (open.length) {
    sh('gh', ['pr', 'edit', String(open[0].number), '-R', adopter.repo, '--title', title, '--body-file', bodyFile])
    url = open[0].url
    console.log(`updated ${url}`)
  } else {
    url = sh('gh', ['pr', 'create', '-R', adopter.repo, '--base', adopter.branch, '--head', BRANCH, '--title', title, '--body-file', bodyFile]).trim().split('\n').pop()
    console.log(`opened ${url}`)
  }
  summary(`### ${adopter.repo}\n\n${open.length ? 'Updated' : 'Opened'} ${url}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = args(process.argv.slice(2))
    const command = opts._[0]
    if (command === 'plan') plan(opts)
    else if (command === 'update') update(opts)
    else if (command === 'wait-merge') waitMerge(opts)
    else if (command === 'report') report(opts)
    else throw new Error('usage: node scripts/rollout.mjs plan --tag vX.Y.Z [--repos a,b] [--tags v1,v2] [--dry-run] | update --adopter <json> --tag vX.Y.Z --kit <dir> --target <dir> [--notes <file>] [--bot <login>] [--dry-run] | wait-merge --adopter <json> --tag vX.Y.Z [--timeout-minutes 60] [--interval-seconds 30] | report --tag vX.Y.Z --run-id <id>')
  } catch (error) {
    console.error(`rollout: ${error.message}`)
    process.exit(1)
  }
}
