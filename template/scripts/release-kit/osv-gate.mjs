#!/usr/bin/env node
// Decides whether an OSV-Scanner report should fail the build.
//
//   osv-scanner scan source --recursive --format json . > osv.json
//   node scripts/release-kit/osv-gate.mjs osv.json
//
// Blocks on a malicious package (an OSV "MAL-" entry, which Dependabot alerts
// don't cover) or a high or critical vulnerability (CVSS 7.0 or more, or
// rated HIGH or CRITICAL by its advisory). Everything else is listed as a
// warning: moderate advisories in dev-only tooling often wait weeks for an
// upstream release, and a check that is always red gets ignored.
// To accept a finding on purpose, add it to osv-scanner.toml in the repo
// (an [[IgnoredVulns]] entry with id, ignoreUntil and reason).
import { readFileSync } from 'node:fs'
import { isMain } from './git.mjs'

const HIGH = 7

/** One finding per vulnerability group (OSV groups aliases of the same issue). */
export function findings(report) {
  const out = []
  for (const result of report.results ?? []) {
    const source = result.source?.path ?? ''
    for (const entry of result.packages ?? []) {
      const pkg = entry.package ?? {}
      const vulns = entry.vulnerabilities ?? []
      const groups = entry.groups?.length ? entry.groups : vulns.map((v) => ({ ids: [v.id] }))
      for (const group of groups) {
        const ids = group.ids ?? []
        const members = vulns.filter((v) => ids.includes(v.id))
        // OSV leaves max_severity empty when no advisory gives a score.
        const score = group.max_severity === undefined || group.max_severity === '' ? NaN : Number(group.max_severity)
        const rated = members.map((v) => String(v.database_specific?.severity ?? '').toUpperCase())
        const malicious = ids.some((id) => id.startsWith('MAL-'))
        const high = (Number.isFinite(score) && score >= HIGH) || rated.some((r) => r === 'HIGH' || r === 'CRITICAL')
        out.push({
          source,
          name: pkg.name,
          version: pkg.version,
          ecosystem: pkg.ecosystem,
          ids,
          score: Number.isFinite(score) ? score : null,
          summary: members.find((v) => v.summary)?.summary ?? '',
          malicious,
          blocking: malicious || high,
        })
      }
    }
  }
  return out
}

/** GitHub annotation text: no newlines, and the characters annotations reserve escaped. */
const clean = (text) => String(text).replace(/%/g, '%25').replace(/\r?\n/g, ' ')

export function gate(report, log = console.log) {
  const all = findings(report)
  const blocking = all.filter((f) => f.blocking)
  for (const f of all) {
    const what = `${f.name} ${f.version} (${f.ecosystem}): ${f.ids.join(', ')}${f.score === null ? '' : ` [${f.score}]`}${f.malicious ? ' MALICIOUS PACKAGE' : ''} ${f.summary}`.trim()
    log(`::${f.blocking ? 'error' : 'warning'} title=${f.blocking ? 'Blocking' : 'Known'} vulnerability in ${clean(f.source.split('/').pop() || 'a lockfile')}::${clean(what)}`)
  }
  log(all.length === 0
    ? 'OSV: no known vulnerabilities.'
    : `OSV: ${all.length} known ${all.length === 1 ? 'vulnerability' : 'vulnerabilities'}, ${blocking.length} blocking (malicious, or high or critical).`)
  return blocking.length === 0
}

// isMain resolves symlinks and decodes the URL, so the gate also runs through
// the scripts/release-kit link and from paths with spaces.
if (isMain(import.meta.url)) {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: osv-gate.mjs <osv-scanner json report>')
    process.exit(2)
  }
  const text = readFileSync(file, 'utf8').trim()
  // OSV-Scanner writes nothing (or an empty object) when there are no lockfiles.
  process.exit(gate(text ? JSON.parse(text) : {}) ? 0 : 1)
}
