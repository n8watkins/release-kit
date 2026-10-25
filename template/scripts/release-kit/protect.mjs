#!/usr/bin/env node
// Protects the default branch so the release train can still move it:
//
//   node scripts/release-kit/protect.mjs [--checks "CI result,check"] [--no-admin-bypass] [--dry-run]
//
// Run it once per repo, as an admin, with the gh CLI signed in. It
//
// 1. creates (or updates) the ruleset "release-kit: protect <branch>": no
//    deletion, no force push, and the required status checks (--checks, else
//    the ones classic branch protection requires now; --checks names must
//    come from GitHub Actions, as the kit's workflows do). A deploy key may
//    bypass it, and so may repository admins unless --no-admin-bypass;
// 2. makes a new SSH key, adds it as the repo's write deploy key "release-kit
//    train" (replacing an older one) and stores the private half as the
//    Actions secret RELEASE_TRAIN_KEY, then deletes it from this machine;
// 3. removes classic branch protection from the branch, which a deploy key
//    can't bypass. The ruleset is active before that, so the branch is never
//    unprotected.
//
// Why: branch protection doesn't count checks from runs started with
// workflow_dispatch, the only runs the train's GITHUB_TOKEN can start, so a
// protected branch rejects the train's push. The train still runs
// .release.json train.checks on its release commit and pushes only when they
// pass; the key lets that push through.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMain } from './git.mjs'

export const KEY_TITLE = 'release-kit train'
export const SECRET = 'RELEASE_TRAIN_KEY'
const GITHUB_ACTIONS_APP = 15368
const ADMIN_ROLE = 5

/** The ruleset for `branch`: `checks` are [{ context, integration_id? }]; no integration_id accepts the check from any app. */
export function ruleset(branch, checks, { adminBypass = true } = {}) {
  const rules = [{ type: 'deletion' }, { type: 'non_fast_forward' }]
  if (checks.length) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: checks.map(({ context, integration_id }) => (integration_id ? { context, integration_id } : { context })),
      },
    })
  }
  return {
    name: `release-kit: protect ${branch}`,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    bypass_actors: [
      { actor_type: 'DeployKey', bypass_mode: 'always' },
      ...(adminBypass ? [{ actor_id: ADMIN_ROLE, actor_type: 'RepositoryRole', bypass_mode: 'always' }] : []),
    ],
    rules,
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--checks')
  const dryRun = args.includes('--dry-run')
  const fail = (message) => {
    console.error(`protect: ${message}`)
    process.exit(1)
  }
  const gh = (ghArgs, input) => execFileSync('gh', ghArgs, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  const api = (path, { method = 'GET', body } = {}) => {
    const out = gh(['api', '-X', method, path, ...(body ? ['--input', '-'] : [])], body && JSON.stringify(body))
    return out ? JSON.parse(out) : null
  }
  /** GET that answers null for 404 (no protection, no such thing). */
  const maybe = (path) => {
    try {
      return api(path)
    } catch (error) {
      if (/HTTP 404|Not Found|not protected/i.test(error.stderr ?? '')) return null
      throw error
    }
  }

  let repo, branch
  try {
    ;[repo, branch] = gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef', '--jq', '.nameWithOwner + " " + .defaultBranchRef.name']).split(' ')
  } catch (error) {
    fail(`could not read the repo with gh (signed in? run it inside the repo): ${error.stderr?.trim() || error.message}`)
  }

  const classic = maybe(`repos/${repo}/branches/${branch}/protection`)
  const checks = at !== -1
    ? (args[at + 1] ?? '').split(',').map((context) => context.trim()).filter(Boolean).map((context) => ({ context, integration_id: GITHUB_ACTIONS_APP }))
    : (classic?.required_status_checks?.checks ?? []).map(({ context, app_id }) => ({ context, integration_id: app_id ?? undefined }))
  if (at !== -1 && !checks.length) fail('--checks needs check names, like "CI result,check"')
  if (classic?.required_pull_request_reviews) fail(`classic protection on ${branch} requires pull requests; this script only carries over required checks, so move that rule to a ruleset by hand first`)
  const wanted = ruleset(branch, checks, { adminBypass: !args.includes('--no-admin-bypass') })

  const existing = (api(`repos/${repo}/rulesets?includes_parents=false`) ?? []).find((r) => r.name === wanted.name)
  console.log(`protect: ${repo} ${branch}: ruleset "${wanted.name}" (${existing ? 'update' : 'create'}), required checks: ${checks.map((c) => c.context).join(', ') || 'none'}`)
  console.log(`protect: deploy key "${KEY_TITLE}" and secret ${SECRET} (new)${classic ? `; then remove classic branch protection from ${branch}` : ''}`)
  if (dryRun) process.exit(0)

  // 1. The ruleset, before anything is taken away.
  if (existing) api(`repos/${repo}/rulesets/${existing.id}`, { method: 'PUT', body: wanted })
  else api(`repos/${repo}/rulesets`, { method: 'POST', body: wanted })

  // 2. The key: only its public half is left on this machine, and only briefly.
  const dir = mkdtempSync(join(tmpdir(), 'release-kit-key-'))
  try {
    const file = join(dir, 'key')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', KEY_TITLE, '-f', file])
    for (const key of api(`repos/${repo}/keys`) ?? []) {
      if (key.title === KEY_TITLE) api(`repos/${repo}/keys/${key.id}`, { method: 'DELETE' })
    }
    api(`repos/${repo}/keys`, { method: 'POST', body: { title: KEY_TITLE, key: readFileSync(`${file}.pub`, 'utf8').trim(), read_only: false } })
    gh(['secret', 'set', SECRET, '--repo', repo], readFileSync(file, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 3. Classic protection would still reject the key.
  if (classic) api(`repos/${repo}/branches/${branch}/protection`, { method: 'DELETE' })
  console.log(`protect: done. The release train now pushes ${branch} and its tags with the deploy key.`)
}
