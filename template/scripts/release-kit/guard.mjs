#!/usr/bin/env node
// The pre-push guard: what server-side rules would stop, stopped before it
// leaves the machine. It matters most in a private repo on GitHub Free, which
// can have no rulesets or branch protection, but runs in every repo.
//
//   release-kit pre-push <remote> <url>     (the pre-push hook; git passes the
//                                            refs being pushed on stdin)
//
// Blocked:
//   - pushing commits straight to the default branch, main, master or a
//     release branch (.release.json "branches"): changes land through pull requests
//   - force pushing or deleting one of those branches
//   - deleting or moving a release tag that is already on the remote (v*)
// Allowed:
//   - pushing, force pushing and deleting any other branch
//   - creating a new tag, and creating a protected branch the remote doesn't have yet
//   - the kit's release flow: npm run release -- --push pushes exactly one
//     release commit (chore(release): vX.Y.Z, changing only the version files
//     CHANGELOG.md and releases.json, with the version it names) and sets RELEASE_KIT_RELEASE
//     to its tag; both must hold
//   - anything in GitHub Actions (the server-side alarm, direct-push.yml, covers CI)
//
// The emergency override, RELEASE_KIT_ALLOW_DIRECT_PUSH=1 git push ..., lets
// the push through and logs it to .git/release-kit/direct-push.log; the
// Direct push alarm on GitHub still reports it.
//
//   release-kit install-guard [<repo>]
//
// installs the guard in one clone of a repo that doesn't use the kit (no
// package.json, or not adopted yet): a copy of these scripts in
// .git/release-kit/guard/ and a pre-push hook in the clone's hooks folder.
// Nothing is committed, so each clone runs it once; rerun it to upgrade.
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { git, isMain } from './git.mjs'

export const OVERRIDE = 'RELEASE_KIT_ALLOW_DIRECT_PUSH'
export const RELEASE_ENV = 'RELEASE_KIT_RELEASE'
export const RELEASE_SUBJECT = /^chore\(release\): v(\d+\.\d+\.\d+)$/
export const LABEL = 'release-kit: direct push'
const ZERO = /^0+$/
const TAG = /^refs\/tags\/(v.*)$/
const BRANCH = /^refs\/heads\/(.+)$/
// The files a release commit may change, besides .release.json versionFiles.
const RELEASE_FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md', 'releases.json', 'releases.xml']

/**
 * Why a commit is not a kit release commit, or null when it is one.
 *   subject       its first line
 *   parents       how many parents it has
 *   files         the paths it changes
 *   version       package.json's version in it
 *   versionFiles  .release.json versionFiles in it (paths, or { path, pattern })
 * A commit that passes changes nothing but the version, the changelog and releases.json,
 * so it is safe to land without a pull request whoever made it.
 */
export function releaseCommitProblem({ subject, parents, files, version, versionFiles = [] }) {
  const named = RELEASE_SUBJECT.exec(subject ?? '')?.[1]
  if (!named) return `its subject "${subject}" is not chore(release): vX.Y.Z`
  if (parents !== 1) return `it has ${parents} parents, not 1`
  if (version !== named) return `package.json says ${version ?? 'nothing'}, not ${named}`
  const allowed = new Set([...RELEASE_FILES, ...versionFiles.map((f) => (typeof f === 'string' ? f : f?.path)).filter((f) => typeof f === 'string')])
  const other = files.filter((f) => !allowed.has(f))
  if (other.length) return `it changes ${other.join(', ')}, which a release commit doesn't`
  return null
}

/** The branches that take changes only through pull requests. */
export function protectedBranches({ defaultBranch, branches = [] } = {}) {
  return [...new Set([defaultBranch, 'main', 'master', ...(Array.isArray(branches) ? branches : [])].filter((b) => typeof b === 'string' && b))]
}

/** The refs git hands the pre-push hook on stdin. */
export function parseUpdates(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/)
    return { localRef, localSha, remoteRef, remoteSha }
  })
}

/**
 * What to do with one ref update: { verdict: 'allow' | 'block', ref, reason }.
 *   facts.protected       protected branch names
 *   facts.isAncestor      (a, b) => whether a is on b's history
 *   facts.newCommits      (from, to) => the shas in from..to
 *   facts.releaseProblem  (sha) => releaseCommitProblem for that commit
 *   facts.releaseEnv      the RELEASE_KIT_RELEASE tag, if set
 */
export function judge({ localSha, remoteRef, remoteSha }, facts) {
  const allow = (reason) => ({ verdict: 'allow', ref: remoteRef, reason })
  const block = (reason) => ({ verdict: 'block', ref: remoteRef, reason })
  const deleting = ZERO.test(localSha)
  const creating = ZERO.test(remoteSha)
  const tag = TAG.exec(remoteRef)?.[1]
  if (tag) {
    if (creating) return allow(`a new tag ${tag}`)
    if (deleting) return block(`it deletes the release tag ${tag}, which is already on the remote`)
    if (localSha !== remoteSha) return block(`it moves the release tag ${tag}, which is already on the remote`)
    return allow(`${tag} is unchanged`)
  }
  const branch = BRANCH.exec(remoteRef)?.[1]
  if (!branch || !facts.protected.includes(branch)) return allow(branch ? `${branch} is not a protected branch` : 'not a branch or a tag')
  if (deleting) return block(`it deletes ${branch}`)
  if (creating) return allow(`${branch} is new on the remote`)
  if (localSha === remoteSha) return allow(`${branch} is unchanged`)
  if (!facts.isAncestor(remoteSha, localSha)) return block(`it force pushes ${branch}, rewriting history already on the remote (or the remote has commits you haven't fetched)`)
  const commits = facts.newCommits(remoteSha, localSha)
  if (commits.length === 1) {
    const problem = facts.releaseProblem(commits[0])
    if (!problem) {
      const tagName = RELEASE_SUBJECT.exec(facts.subject(commits[0]))[1]
      if (facts.releaseEnv === `v${tagName}`) return allow(`the release commit for v${tagName}, from npm run release`)
      return block(`it pushes the release commit for v${tagName} by hand: release with npm run release -- --push`)
    }
  }
  return block(`it pushes ${commits.length} commit${commits.length === 1 ? '' : 's'} straight to ${branch}`)
}

/** What to do instead, for the blocked updates. */
export function advice(blocked) {
  const lines = []
  if (blocked.some((b) => /straight to|by hand/.test(b.reason))) {
    lines.push('Changes reach a protected branch through a pull request: push a branch and open one.',
      '  git switch -c my-change && git push -u origin my-change && gh pr create --fill',
      '  (then put the local branch back where the remote has it: git switch - && git reset --keep @{upstream})')
  }
  if (blocked.some((b) => /force pushes|deletes (?!the release tag)/.test(b.reason))) {
    lines.push('A protected branch is never rewritten or deleted: undo a change with git revert, through a pull request.')
  }
  if (blocked.some((b) => /release tag/.test(b.reason))) {
    lines.push('A published release tag never moves: cut a new release instead (npm run release).')
  }
  return lines
}

export const HOOK_MARKER = '# release-kit: pre-push guard'

/**
 * Installs the guard in the clone at `dir` without the kit: returns what it
 * did, or throws when the clone already has a pre-push hook of its own.
 */
export function installStandalone(dir) {
  const inRepo = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const common = resolve(dir, inRepo('rev-parse', '--git-common-dir'))
  const hooks = resolve(dir, inRepo('rev-parse', '--git-path', 'hooks'))
  const hook = join(hooks, 'pre-push')
  if (existsSync(hook) && !readFileSync(hook, 'utf8').includes(HOOK_MARKER)) {
    throw new Error(`${hook} is a pre-push hook of its own: add  node "${join(common, 'release-kit/guard/guard.mjs')}" "$@"  to it after running this with that hook moved away`)
  }
  const target = join(common, 'release-kit', 'guard')
  mkdirSync(target, { recursive: true })
  const here = dirname(fileURLToPath(import.meta.url))
  for (const file of ['guard.mjs', 'git.mjs', 'conventional.mjs']) copyFileSync(join(here, file), join(target, file))
  mkdirSync(hooks, { recursive: true })
  writeFileSync(hook, `#!/bin/sh
${HOOK_MARKER}, installed by release-kit install-guard (rerun it to upgrade).
# Blocks pushing straight to, force pushing or deleting the protected branches,
# and moving or deleting a release tag; RELEASE_KIT_ALLOW_DIRECT_PUSH=1 overrides, logged.
exec node "$(git rev-parse --path-format=absolute --git-common-dir)/release-kit/guard/guard.mjs" "$@"
`)
  chmodSync(hook, 0o755)
  return { hook, scripts: target }
}

function main() {
  if (process.argv[2] === '--install') {
    try {
      const { hook, scripts } = installStandalone(resolve(process.argv[3] ?? '.'))
      console.log(`release-kit: pre-push guard installed: ${hook} runs ${scripts}/guard.mjs`)
      return 0
    } catch (error) {
      console.error(`release-kit: ${error.stderr?.trim() || error.message}`)
      return 1
    }
  }
  const [remote = '', url = ''] = process.argv.slice(2)
  if (process.env.GITHUB_ACTIONS === 'true') return 0
  const updates = parseUpdates(readFileSync(0, 'utf8'))
  if (!updates.length) return 0

  const root = git('rev-parse', '--show-toplevel')
  const readJson = (text) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const config = readJson(existsSync(join(root, '.release.json')) ? readFileSync(join(root, '.release.json'), 'utf8') : '{}') ?? {}
  let defaultBranch
  try {
    defaultBranch = git('symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`).slice(remote.length + 1)
  } catch {}
  const at = (sha, path) => {
    try {
      return git('show', `${sha}:${path}`)
    } catch {
      return null
    }
  }
  const facts = {
    protected: protectedBranches({ defaultBranch, branches: config.branches }),
    isAncestor: (a, b) => {
      try {
        git('merge-base', '--is-ancestor', a, b)
        return true
      } catch {
        return false
      }
    },
    newCommits: (from, to) => git('rev-list', `${from}..${to}`).split('\n').filter(Boolean),
    subject: (sha) => git('log', '-1', '--format=%s', sha),
    releaseProblem: (sha) => releaseCommitProblem({
      subject: git('log', '-1', '--format=%s', sha),
      parents: git('rev-list', '--parents', '-n', '1', sha).split(' ').length - 1,
      files: git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha).split('\n').filter(Boolean),
      version: readJson(at(sha, 'package.json') ?? '')?.version,
      versionFiles: readJson(at(sha, '.release.json') ?? '')?.versionFiles ?? [],
    }),
    releaseEnv: process.env[RELEASE_ENV],
  }
  const verdicts = updates.map((u) => judge(u, facts))
  const blocked = verdicts.filter((v) => v.verdict === 'block')
  if (!blocked.length) return 0

  if (process.env[OVERRIDE] === '1') {
    const dir = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'release-kit')
    mkdirSync(dir, { recursive: true })
    const log = join(dir, 'direct-push.log')
    let who = ''
    try {
      who = /<([^>]*)>/.exec(git('var', 'GIT_AUTHOR_IDENT'))?.[1] ?? ''
    } catch {}
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), who, remote, url, allowed: blocked.map(({ ref, reason }) => ({ ref, reason })) })}\n`)
    console.error(`release-kit: ${OVERRIDE}=1, so this push goes through although ${blocked.map((b) => `${b.ref}: ${b.reason}`).join('; ')}.`)
    console.error(`release-kit: logged to ${log}; the Direct push alarm on GitHub still reports it.`)
    return 0
  }

  console.error('release-kit: push blocked, nothing was sent:')
  for (const b of blocked) console.error(`  ${b.ref}: ${b.reason}`)
  console.error('')
  for (const line of advice(blocked)) console.error(line)
  console.error(`Emergency only: ${OVERRIDE}=1 git push ... lets it through, logged in .git/release-kit/direct-push.log and reported by the Direct push alarm.`)
  return 1
}

if (isMain(import.meta.url)) process.exitCode = main()
