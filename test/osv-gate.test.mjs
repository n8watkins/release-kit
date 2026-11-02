// The security scan's gate: which OSV findings fail the build.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findings, gate } from '../template/scripts/release-kit/osv-gate.mjs'

const report = (packages) => ({ results: [{ source: { path: '/repo/package-lock.json' }, packages }] })
const pkg = (name, vulns, groups) => ({ package: { name, version: '1.0.0', ecosystem: 'npm' }, vulnerabilities: vulns, groups })

test('a moderate advisory is a warning, not a failure', () => {
  const lines = []
  const ok = gate(report([pkg('minimatch', [{ id: 'GHSA-1', summary: 'ReDoS', database_specific: { severity: 'MODERATE' } }], [{ ids: ['GHSA-1'], max_severity: '6.9' }])]), (l) => lines.push(l))
  assert.equal(ok, true)
  assert.match(lines[0], /^::warning /)
  assert.match(lines.at(-1), /1 known vulnerability, 0 blocking/)
})

test('a high CVSS score or a HIGH or CRITICAL rating blocks', () => {
  assert.equal(gate(report([pkg('next', [{ id: 'GHSA-2' }], [{ ids: ['GHSA-2'], max_severity: '7.5' }])]), () => {}), false)
  assert.equal(gate(report([pkg('zip', [{ id: 'GHSA-3', database_specific: { severity: 'CRITICAL' } }], [{ ids: ['GHSA-3'], max_severity: '' }])]), () => {}), false)
})

test('a malicious package blocks even with no score', () => {
  const [f] = findings(report([pkg('evil-pkg', [{ id: 'MAL-2026-1', summary: 'Malicious code in evil-pkg' }], [{ ids: ['MAL-2026-1'] }])]))
  assert.equal(f.malicious, true)
  assert.equal(f.blocking, true)
})

test('aliases of one issue count once, and a report without groups still works', () => {
  const grouped = findings(report([pkg('a', [{ id: 'GHSA-4' }, { id: 'CVE-4' }], [{ ids: ['GHSA-4', 'CVE-4'], max_severity: '5.0' }])]))
  assert.equal(grouped.length, 1)
  assert.equal(findings(report([pkg('b', [{ id: 'GHSA-5' }, { id: 'GHSA-6' }])])).length, 2)
})

test('an empty report passes', () => {
  const lines = []
  assert.equal(gate({}, (l) => lines.push(l)), true)
  assert.deepEqual(lines, ['OSV: no known vulnerabilities.'])
})

test('annotation text stays on one line', () => {
  const lines = []
  gate(report([pkg('c', [{ id: 'GHSA-7', summary: 'two\nlines 100%', database_specific: { severity: 'LOW' } }], [{ ids: ['GHSA-7'] }])]), (l) => lines.push(l))
  assert.equal(lines[0].split('\n').length, 1)
  assert.match(lines[0], /100%25/)
})
