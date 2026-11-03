#!/usr/bin/env node
// The Direct push alarm (.github/workflows/direct-push.yml): after the fact,
// on GitHub, it reports what the pre-push guard (guard.mjs) and rulesets stop
// up front, for repos where neither can be relied on (a private repo on
// GitHub Free has no rulesets, and the guard only runs where it is installed).
//
//   node scripts/release-kit/alarm.mjs [--branches main,master] [--allow-paths "reports/**"] [--dry-run]
//
// Reads the event from GITHUB_EVENT_NAME and GITHUB_EVENT_PATH and asks the
// GitHub API (gh, with GH_TOKEN) about it; no repo code is checked out or run.
//
//   push to a protected branch   (the default branch, main, master, --branches,
//                                and .release.json "branches")
//       a force push is reported; so is every pushed commit that didn't come
//       from a merged pull request (commits/{sha}/pulls), except the kit's own
//       release commits (chore(release): vX.Y.Z changing only the version files
//       and CHANGELOG.md, with that version: what npm run release -- --push and
//       the release train push) and commits that change only --allow-paths
//   push that moves a v* tag, or deletes a protected branch or a v* tag
//       reported
//
// A report fails the job, so the run shows red, and opens (or comments on) one
// issue labeled "release-kit: direct push"; GitHub emails the repo's watchers
// about the issue and the pusher about the failed run. --dry-run prints the
// findings without touching issues.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { isMain } from './git.mjs'
import { globToRegExp } from './lanes.mjs'
import { LABEL, protectedBranches, releaseCommitProblem } from './guard.mjs'

const ZERO = /^0+$/
// One page of the compare API: up to 100 commits are checked.
const MAX_COMMITS = 100
const short = (sha) => String(sha).slice(0, 7)

/**
 * The findings for one push or delete event, and notes on what was allowed.
 *   eventName   push or delete
 *   event       the webhook payload
 *   branches    protected branches besides the default branch, main and master
 *   allowPaths  globs: a commit that changes only these is not reported
 *   api         { pulls(sha), commit(sha), file(path, ref), compare(base, head) }
 *   wait        (attempt) => void, between looks for a pull request GitHub
 *               hasn't linked to a just-merged commit yet
 */
export function review({ eventName, event, branches = [], allowPaths = [], api, wait = () => {}, attempts = 4 }) {
  const findings = []
  const notes = []
  const who = event.pusher?.name || event.sender?.login || 'someone'
  const protectedList = protectedBranches({ defaultBranch: event.repository?.default_branch, branches })
  const allowed = allowPaths.map(globToRegExp)

  if (eventName === 'delete') {
    if (event.ref_type === 'tag' && event.ref?.startsWith('v')) findings.push(`${event.sender?.login ?? who} deleted the release tag ${event.ref}`)
    else if (event.ref_type === 'branch' && protectedList.includes(event.ref)) findings.push(`${event.sender?.login ?? who} deleted the protected branch ${event.ref}`)
    return { findings, notes }
  }
  if (eventName !== 'push') return { findings, notes: [`nothing to check on a ${eventName} event`] }

  const tag = /^refs\/tags\/(v.*)$/.exec(event.ref ?? '')?.[1]
  const branch = /^refs\/heads\/(.+)$/.exec(event.ref ?? '')?.[1]
  const [created, deleted] = [ZERO.test(event.before ?? ''), event.deleted || ZERO.test(event.after ?? '')]
  if (tag) {
    if (deleted) findings.push(`${who} deleted the release tag ${tag}`)
    else if (!created) findings.push(`${who} moved the release tag ${tag} from ${short(event.before)} to ${short(event.after)}`)
    else notes.push(`a new tag ${tag}`)
    return { findings, notes }
  }
  if (!branch || !protectedList.includes(branch)) return { findings, notes: [`${event.ref} is not a protected branch`] }
  if (deleted) {
    findings.push(`${who} deleted the protected branch ${branch}`)
    return { findings, notes }
  }
  if (event.forced) findings.push(`${who} force pushed ${branch} from ${short(event.before)} to ${short(event.after)}, rewriting its history`)
  if (created) {
    notes.push(`${branch} was created`)
    return { findings, notes }
  }

  const compared = api.compare(event.before, event.after)
  const commits = compared.commits ?? []
  if ((compared.total_commits ?? commits.length) > commits.length) notes.push(`${compared.total_commits} commits were pushed; the first ${commits.length} were checked`)
  const pending = new Map(commits.map((c) => [c.sha, c]))
  for (let attempt = 0; attempt < attempts && pending.size; attempt++) {
    if (attempt) wait(attempt)
    for (const sha of [...pending.keys()]) {
      const merged = (api.pulls(sha) ?? []).find((p) => p.merged_at)
      if (merged) pending.delete(sha)
    }
  }
  for (const [sha, listed] of pending) {
    const detail = api.commit(sha)
    const subject = (detail.commit?.message ?? listed.commit?.message ?? '').split('\n')[0]
    const files = (detail.files ?? []).map((f) => f.filename)
    const readJson = (path) => {
      try {
        return JSON.parse(api.file(path, sha) ?? 'null')
      } catch {
        return null
      }
    }
    const release = /^chore\(release\): /.test(subject)
      ? releaseCommitProblem({ subject, parents: (detail.parents ?? []).length, files, version: readJson('package.json')?.version, versionFiles: readJson('.release.json')?.versionFiles ?? [] })
      : 'not a release commit'
    if (!release) {
      notes.push(`${short(sha)} is the release commit "${subject}"`)
      continue
    }
    if (allowed.length && files.length && files.every((f) => allowed.some((re) => re.test(f)))) {
      notes.push(`${short(sha)} "${subject}" changes only allowed paths`)
      continue
    }
    const author = detail.commit?.author?.name ?? listed.commit?.author?.name ?? 'unknown'
    findings.push(`${who} pushed ${short(sha)} "${subject}" (by ${author}) straight to ${branch}: it came from no merged pull request`)
  }
  return { findings, notes }
}

/** The issue text: a body for a new issue, or a comment on the open one. */
export function report({ findings, notes, runUrl, repo }) {
  return [
    `**Direct push alarm** in [this run](${runUrl}):`,
    '',
    ...findings.map((f) => `- ${f}`),
    ...(notes.length ? ['', '<details><summary>Also seen, and allowed</summary>', '', ...notes.map((n) => `- ${n}`), '', '</details>'] : []),
    '',
    `Protected branches in ${repo} take changes only through pull requests, and release tags never move.`,
    'Check the change above was meant; to undo one, open a pull request that reverts it.',
    'The pre-push guard stops these before they leave a machine where it is installed (`npx release-kit apply .`, or `npx release-kit install-guard` in a repo without the kit); see release-kit docs/PRIVATE_REPOS.md.',
  ].join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (name) => {
    const at = args.indexOf(`--${name}`)
    return at === -1 ? '' : (args[at + 1] ?? '')
  }
  const list = (text) => text.split(',').map((s) => s.trim()).filter(Boolean)
  const dryRun = args.includes('--dry-run')
  const repo = process.env.GITHUB_REPOSITORY
  const eventName = process.env.GITHUB_EVENT_NAME
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
  const retryMs = Number(process.env.RELEASE_KIT_ALARM_RETRY_MS ?? 10_000)
  if (event.repository?.fork) return console.log('alarm: a fork; nothing to check')

  const gh = (ghArgs, input) => execFileSync('gh', ghArgs, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] })
  const get = (path) => JSON.parse(gh(['api', '-H', 'Accept: application/vnd.github+json', path]))
  const send = (method, path, body) => JSON.parse(gh(['api', '-X', method, '-H', 'Accept: application/vnd.github+json', path, '--input', '-'], JSON.stringify(body)) || 'null')
  const maybe = (path) => {
    try {
      return get(path)
    } catch {
      return null
    }
  }
  const file = (path, ref) => {
    const content = maybe(`repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)?.content
    return content ? Buffer.from(content, 'base64').toString('utf8') : null
  }
  const api = {
    pulls: (sha) => maybe(`repos/${repo}/commits/${sha}/pulls?per_page=100`) ?? [],
    commit: (sha) => get(`repos/${repo}/commits/${sha}`),
    file,
    compare: (base, head) => get(`repos/${repo}/compare/${base}...${head}?per_page=${MAX_COMMITS}`),
  }
  // Release branches from .release.json on the default branch, besides --branches.
  let releaseBranches = []
  try {
    releaseBranches = JSON.parse(file('.release.json', event.repository?.default_branch ?? 'HEAD') ?? '{}').branches ?? []
  } catch {}
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const { findings, notes } = review({
    eventName, event, api,
    branches: [...list(valueOf('branches')), ...(Array.isArray(releaseBranches) ? releaseBranches : [])],
    allowPaths: list(valueOf('allow-paths')),
    wait: (attempt) => sleep(retryMs * attempt),
  })

  const summary = (line) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`)
  for (const note of notes) console.log(`alarm: ok: ${note}`)
  if (!findings.length) {
    summary(`No direct push: every change came through a merged pull request or the release flow.${notes.length ? `\n\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}`)
    return console.log('alarm: nothing to report')
  }
  const runUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`
  const text = report({ findings, notes, runUrl, repo })
  summary(text)
  for (const f of findings) console.log(`::error title=Direct push alarm::${f.replace(/\r?\n/g, ' ')}`)
  if (dryRun) {
    console.log(`alarm: dry run, no issue opened:\n${text}`)
  } else {
    try {
      send('POST', `repos/${repo}/labels`, { name: LABEL, color: 'b60205', description: 'A change reached a protected branch or release tag without a pull request' })
    } catch {}
    const open = maybe(`repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=1`)?.[0]
    if (open) {
      send('POST', `repos/${repo}/issues/${open.number}/comments`, { body: text })
      console.log(`alarm: commented on #${open.number}`)
    } else {
      const issue = send('POST', `repos/${repo}/issues`, { title: 'Direct push to a protected branch or release tag', body: text, labels: [LABEL] })
      console.log(`alarm: opened #${issue?.number}`)
    }
  }
  process.exitCode = 1
}

if (isMain(import.meta.url)) main()
