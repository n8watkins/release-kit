#!/usr/bin/env node
// The Release workflow's publish step: creates the GitHub Release for a tag,
// or, when a run is retried and the release already exists, finishes it
// instead of failing.
//
//   node scripts/release-kit/publish.mjs --tag vX.Y.Z [--notes release-notes.md] [--assets release-artifacts]
//
// Safe to run again ("Re-run failed jobs", or "Run workflow" with the tag):
//   - no release yet: create it with the notes and every file;
//   - a release with the same files (its SHA256SUMS.txt equals this build's):
//     upload only the files it is missing, and refresh the notes;
//   - a release a crashed run left half-uploaded (files but no SHA256SUMS.txt,
//     so nothing was ever verified): upload every file again, replacing them;
//   - a release whose published files differ from this build: stop. Someone
//     may already have downloaded them, so the kit never swaps them silently;
//     delete the release's files (or the release) to publish this build.
//
// Needs the gh CLI with GH_TOKEN (contents: write) and GITHUB_REPOSITORY.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RELEASE_TAG } from './conventional.mjs'
import { isMain } from './git.mjs'

const SUMS = 'SHA256SUMS.txt'

/**
 * What to do for a tag, from what GitHub has and what this run built.
 *   remote  null when there is no release, else { assets: [names], sums: text or null }
 *   local   { assets: [names], sums: text or null }
 * Returns { action: 'create' | 'update', upload: [names], clobber } or { error }.
 */
export function publishPlan(remote, local) {
  if (!remote) return { action: 'create', upload: local.assets, clobber: false }
  const missing = local.assets.filter((name) => !remote.assets.includes(name))
  if (remote.sums !== null) {
    if (local.sums === null) return { error: `the release already has files (${remote.assets.join(', ')}), but this run built none` }
    if (remote.sums.trim() !== local.sums.trim()) {
      return { error: `the release already has different files than this build (${SUMS} differs); delete its files, or the release, to publish this build` }
    }
    return { action: 'update', upload: missing, clobber: false }
  }
  // Files without a checksum list: a run that stopped mid-upload, never verified.
  if (remote.assets.length && !local.assets.length) return { error: `the release already has files (${remote.assets.join(', ')}), but this run built none` }
  return { action: 'update', upload: local.assets, clobber: remote.assets.length > 0 }
}

function main() {
  const args = process.argv.slice(2)
  const valueOf = (name, fallback) => {
    const at = args.indexOf(`--${name}`)
    return at === -1 ? fallback : args[at + 1]
  }
  const fail = (message) => {
    console.error(`publish: ${message}`)
    process.exit(1)
  }
  const tag = valueOf('tag')
  if (!tag || !RELEASE_TAG.test(tag)) fail(`"${tag ?? ''}" is not a release tag; release tags look like v1.2.3`)
  const notes = valueOf('notes', 'release-notes.md')
  const dir = valueOf('assets', 'release-artifacts')
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) fail('GITHUB_REPOSITORY is not set (this runs in the Release workflow)')
  if (!existsSync(notes)) fail(`no notes file at ${notes}`)

  const gh = (...ghArgs) => execFileSync('gh', [...ghArgs, '--repo', repo], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const local = existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith('.')).sort() : []
  const localSums = local.includes(SUMS) ? readFileSync(join(dir, SUMS), 'utf8') : null

  let remote = null
  const view = spawnSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'assets'], { encoding: 'utf8' })
  if (view.status === 0) {
    const assets = JSON.parse(view.stdout).assets.map((asset) => asset.name)
    let sums = null
    if (assets.includes(SUMS)) {
      const scratch = mkdtempSync(join(tmpdir(), 'release-kit-publish-'))
      gh('release', 'download', tag, '--pattern', SUMS, '--dir', scratch)
      sums = readFileSync(join(scratch, SUMS), 'utf8')
      rmSync(scratch, { recursive: true, force: true })
    }
    remote = { assets, sums }
  } else if (!/release not found|HTTP 404/i.test(view.stderr)) {
    fail(`could not look up the release for ${tag}: ${view.stderr.trim()}`)
  }

  const plan = publishPlan(remote, { assets: local, sums: localSums })
  if (plan.error) fail(`${tag}: ${plan.error}`)
  const paths = plan.upload.map((name) => join(dir, name))
  if (plan.action === 'create') {
    gh('release', 'create', tag, ...paths, '--title', tag, '--notes-file', notes, '--verify-tag')
    console.log(`publish: created the release ${tag}${paths.length ? ` with ${paths.length} file${paths.length === 1 ? '' : 's'}` : ''}`)
    return
  }
  gh('release', 'edit', tag, '--title', tag, '--notes-file', notes)
  if (paths.length) gh('release', 'upload', tag, ...paths, ...(plan.clobber ? ['--clobber'] : []))
  console.log(`publish: the release ${tag} already existed; notes refreshed, ${paths.length ? `${paths.length} file${paths.length === 1 ? '' : 's'} uploaded${plan.clobber ? ' (replacing an unverified upload)' : ''}` : 'no files to upload'}`)
}

if (isMain(import.meta.url)) main()
