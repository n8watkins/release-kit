// End to end: apply the kit to a throwaway repo, then commit and release in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KIT = new URL('..', import.meta.url).pathname
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
const attempt = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })

test('apply, then the hook, the release command and tag verification all work', () => {
  const repo = mkdtempSync(join(tmpdir(), 'release-kit-'))
  run(repo, 'git', ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '0.1.0', scripts: { lint: 'echo lint', build: 'echo build' } }, null, 2))
  writeFileSync(join(repo, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'demo', version: '0.1.0' }, null, 2))
  writeFileSync(join(repo, 'AGENTS.md'), '# Agents\n\n- Be nice.\n')
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'Initial commit'])

  const applied = run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  const kitVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.match(applied, new RegExp(`release-kit ${kitVersion.replaceAll('.', '\\.')} applied`))
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['release:check'], 'npm run lint && npm run build')
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')).versionFiles, ['manifest.json'])
  assert.match(readFileSync(join(repo, 'AGENTS.md'), 'utf8'), /- Be nice\.[\s\S]*<!-- release-kit -->/)
  // Re-applying replaces the snippet instead of adding a second one.
  run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.equal(readFileSync(join(repo, 'AGENTS.md'), 'utf8').match(/<!-- release-kit -->/g).length, 1)

  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit 1.0.0'])

  // Baseline: tag the version the repo is already at, marked so the workflow
  // skips publishing it; the first release then starts from here.
  assert.match(run(repo, 'node', ['scripts/release-kit/release.mjs', '--baseline']), /tagged v0\.1\.0 at HEAD as a baseline/)
  assert.match(run(repo, 'git', ['tag', '-l', '--format=%(contents)', 'v0.1.0']), /release-kit baseline/)

  // The hook rejects a plain-sentence message.
  writeFileSync(join(repo, 'a.txt'), 'a')
  run(repo, 'git', ['add', 'a.txt'])
  const rejected = attempt(repo, 'git', ['commit', '-q', '-m', 'Added a thing'])
  assert.notEqual(rejected.status, 0)
  assert.match(rejected.stderr, /Commit message check failed/)
  run(repo, 'git', ['commit', '-q', '-m', 'feat: add a thing'])
  writeFileSync(join(repo, 'b.txt'), 'b')
  run(repo, 'git', ['add', 'b.txt'])
  run(repo, 'git', ['commit', '-q', '-m', 'docs: explain the thing'])

  const dry = run(repo, 'node', ['scripts/release-kit/release.mjs', '--dry-run'])
  assert.match(dry, /0\.1\.0 -> 0\.2\.0 \(minor\), 2 commits since v0\.1\.0/)
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '0.1.0')

  run(repo, 'node', ['scripts/release-kit/release.mjs'])
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version, '0.2.0')
  assert.equal(JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8')).version, '0.2.0')
  assert.equal(run(repo, 'git', ['tag', '--list']).trim(), 'v0.1.0\nv0.2.0')
  assert.equal(run(repo, 'git', ['log', '-1', '--format=%s']).trim(), 'chore(release): v0.2.0')
  const changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8')
  assert.match(changelog, /^# Changelog\n\n## 0\.2\.0 - \d{4}-\d{2}-\d{2}\n\n### New\n\n- Add a thing/)
  assert.doesNotMatch(changelog, /explain the thing/)

  // CI's checks: the tag matches every version file; the range check passes.
  assert.match(run(repo, 'node', ['scripts/release-kit/release.mjs', '--verify-tag', 'v0.2.0']), /matches package\.json, manifest\.json/)
  const mismatch = attempt(repo, 'node', ['scripts/release-kit/release.mjs', '--verify-tag', 'v0.3.0'])
  assert.notEqual(mismatch.status, 0)
  assert.match(mismatch.stderr, /does not match/)
  assert.equal(attempt(repo, 'node', ['scripts/release-kit/commit-msg.mjs', '--range', 'HEAD~3..HEAD']).status, 0)
  // Notes for the tag, as the workflow builds them.
  assert.match(run(repo, 'node', ['scripts/release-kit/notes.mjs', '--to', 'v0.2.0']), /### New\n\n- Add a thing/)

  // Run through a symlinked scripts folder (as this kit runs itself), the notes still print.
  run(repo, 'ln', ['-s', 'scripts/release-kit', 'linked-kit'])
  assert.match(run(repo, 'node', ['linked-kit/notes.mjs', '--to', 'v0.2.0']), /### New/)
  run(repo, 'rm', ['linked-kit'])

  // Nothing new to release.
  const empty = attempt(repo, 'node', ['scripts/release-kit/release.mjs'])
  assert.match(empty.stderr, /nothing to release/)
  assert.ok(existsSync(join(repo, 'RELEASING.md')))
})

test('--push sends the release commit and its tag to the remote in one push', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-kit-push-'))
  run(root, 'git', ['init', '-q', '--bare', 'remote.git'])
  const repo = join(root, 'work')
  run(root, 'git', ['init', '-q', '-b', 'main', 'work'])
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.2.0', scripts: { build: 'echo build' } }, null, 2))
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'Initial commit'])
  run(repo, 'git', ['remote', 'add', 'origin', join(root, 'remote.git')])
  run(repo, 'git', ['push', '-q', '-u', 'origin', 'main'])
  run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'chore: adopt release-kit'])
  writeFileSync(join(repo, 'fix.txt'), 'x')
  run(repo, 'git', ['add', 'fix.txt'])
  run(repo, 'git', ['commit', '-q', '-m', 'fix: a thing'])

  assert.match(run(repo, 'node', ['scripts/release-kit/release.mjs', '--push']), /pushed v1\.2\.1/)
  assert.match(run(repo, 'git', ['ls-remote', '--tags', 'origin']), /refs\/tags\/v1\.2\.1/)
  assert.equal(run(repo, 'git', ['ls-remote', 'origin', 'main']).split('\t')[0], run(repo, 'git', ['rev-parse', 'HEAD']).trim())
})

test('a husky repo gets its hook in .husky and no .githooks folder', () => {
  const repo = mkdtempSync(join(tmpdir(), 'release-kit-husky-'))
  run(repo, 'git', ['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { prepare: 'husky', build: 'echo b' } }, null, 2))
  run(repo, 'mkdir', ['.husky'])
  const out = run(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.ok(existsSync(join(repo, '.husky/commit-msg')))
  assert.ok(!existsSync(join(repo, '.githooks')))
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.prepare, 'husky')
  assert.doesNotMatch(out, /prepare/)
})

test('--train adds the release train on its schedule, and re-running keeps it until --no-train', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-train'))
  const train = join(repo, '.github/workflows/release-train.yml')
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.ok(!existsSync(train), 'the train is opt-in')

  assert.match(quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--train']), /vendored mode, release train "0 16 \* \* 1"/)
  assert.match(readFileSync(train, 'utf8'), /^ {4}- cron: "0 16 \* \* 1" # release-kit: schedule$/m)
  assert.equal(readFileSync(train, 'utf8'), readFileSync(join(KIT, 'template/.github/workflows/release-train.yml'), 'utf8'))

  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--schedule', '30 15 * * FRI'])
  assert.match(readFileSync(train, 'utf8'), /- cron: "30 15 \* \* FRI" # release-kit: schedule/)
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')), { versionFiles: [], workflows: 'vendored', train: { schedule: '30 15 * * FRI' } })
  // An upgrade with no options keeps the train and its schedule.
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.match(readFileSync(train, 'utf8'), /- cron: "30 15 \* \* FRI"/)

  for (const bad of ['0 16 * * 1" ; echo', '0 16 * *', '0 16 * * 1\n']) {
    const result = attempt(KIT, 'node', ['apply.mjs', repo, '--vendored', '--schedule', bad])
    assert.notEqual(result.status, 0, bad)
    assert.match(result.stderr, /is not a five-field cron schedule/)
  }

  assert.match(quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--no-train']), /release-train\.yml removed/)
  assert.ok(!existsSync(train))
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')), { versionFiles: [], workflows: 'vendored' })
})

test('--reusable writes callers of the pinned kit workflows, and --vendored switches back', async () => {
  const { KIT_VERSION, makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-reusable'))
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ versionFiles: ['manifest.json'], node: '24' }))
  writeFileSync(join(repo, 'manifest.json'), JSON.stringify({ version: '1.0.0' }))
  const workflow = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8')

  quiet(KIT, 'node', ['apply.mjs', repo, '--reusable', '--train'])
  assert.match(workflow('commits.yml'), new RegExp(`^ {4}uses: n8watkins/release-kit/\\.github/workflows/commits\\.yml@v${KIT_VERSION.replaceAll('.', '\\.')}$`, 'm'))
  assert.match(workflow('release.yml'), /uses: n8watkins\/release-kit\/\.github\/workflows\/release\.yml@v/)
  assert.match(workflow('release-train.yml'), /- cron: "0 16 \* \* 1"[\s\S]*uses: n8watkins\/release-kit\/\.github\/workflows\/release-train\.yml@v/)
  assert.doesNotMatch(workflow('release.yml'), /npm ci/)
  // The scripts still come along: the hook and npm run release run locally.
  assert.ok(existsSync(join(repo, 'scripts/release-kit/release.mjs')))
  // Choices and settings the repo already had are kept.
  assert.deepEqual(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')), { versionFiles: ['manifest.json'], node: '24', workflows: 'reusable', train: { schedule: '0 16 * * 1' } })

  const sha = 'b'.repeat(40)
  quiet(KIT, 'node', ['apply.mjs', repo, '--kit-ref', sha])
  assert.match(workflow('commits.yml'), new RegExp(`commits\\.yml@${sha} # release-kit ${KIT_VERSION.replaceAll('.', '\\.')}$`, 'm'))
  assert.notEqual(attempt(KIT, 'node', ['apply.mjs', repo, '--kit-ref', 'v1;id']).status, 0)

  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.equal(workflow('release.yml'), readFileSync(join(KIT, 'template/.github/workflows/release.yml'), 'utf8'))
  assert.ok(existsSync(join(repo, '.github/workflows/release-train.yml')))
  assert.equal(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')).workflows, 'vendored')
})

test("a workflow the kit didn't write is left alone unless --force", async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-own'))
  run(repo, 'mkdir', ['-p', '.github/workflows'])
  writeFileSync(join(repo, '.github/workflows/release.yml'), 'name: Mine\n')
  assert.match(quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--train']), /release\.yml exists and isn't from the kit/)
  assert.equal(readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8'), 'name: Mine\n')
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--force'])
  assert.match(readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8'), /release-kit/)
  const usage = attempt(KIT, 'node', ['apply.mjs', repo, '--reusable', '--vendored'])
  assert.match(usage.stderr, /pick one of --package, --reusable and --vendored/)
})

test("apply leaves other hook managers and an existing release script alone, and says so", async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  for (const setup of [
    (repo) => writeFileSync(join(repo, 'lefthook.yml'), 'pre-commit: {}\n'),
    (repo) => writeFileSync(join(repo, '.pre-commit-config.yaml'), 'repos: []\n'),
    (repo) => writeFileSync(join(repo, '.git/hooks/pre-commit'), '#!/bin/sh\n', { mode: 0o755 }),
    (repo) => quiet(repo, 'git', ['config', 'core.hooksPath', '.config/hooks']),
  ]) {
    const repo = makeRepo(tmp('apply-hooks'))
    setup(repo)
    const out = quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
    assert.match(out, /so the kit's hook is not installed: add {2}node scripts\/release-kit\/commit-msg\.mjs "\$1"/)
    assert.ok(!existsSync(join(repo, '.githooks')))
    assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.prepare, undefined)
    assert.notEqual(attempt(repo, 'git', ['config', '--local', 'core.hooksPath']).stdout.trim(), '.githooks')
  }

  const repo = makeRepo(tmp('apply-script'), { scripts: { release: 'semantic-release', build: 'echo b' } })
  writeFileSync(join(repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  const out = quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.match(out, /already has a "release" script \(semantic-release\); left alone/)
  assert.match(out, /pnpm-lock\.yaml but no package-lock\.json: the workflows install with npm ci/)
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.release, 'semantic-release')
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--force'])
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.release, 'node scripts/release-kit/release.mjs')
})

test('--train-checks lists the workflows the train runs on its release commit, and upgrades keep them', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-checks'))
  const config = () => JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8'))
  assert.match(quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--train-checks', 'ci.yml, commits.yml']), /now: ci\.yml, commits\.yml/)
  assert.deepEqual(config().train, { schedule: '0 16 * * 1', checks: ['ci.yml', 'commits.yml'] })
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored', '--schedule', '0 9 * * 5'])
  assert.deepEqual(config().train, { schedule: '0 9 * * 5', checks: ['ci.yml', 'commits.yml'] })
  assert.match(attempt(KIT, 'node', ['apply.mjs', repo, '--vendored', '--train-checks', 'ci.yml;id']).stderr, /takes workflow file names/)
})

test('package mode (the default): the kit is a dev dependency, run from node_modules, and kept current by Dependabot', async () => {
  const { KIT_VERSION, makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-package'), { scripts: { lint: 'echo lint' } })
  // A repo applied before package mode existed: copied scripts and no mode saved.
  run(repo, 'mkdir', ['-p', 'scripts/release-kit'])
  writeFileSync(join(repo, 'scripts/release-kit/VERSION'), '1.0.0\n')
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ versionFiles: [] }))

  const out = quiet(KIT, 'node', ['apply.mjs', repo])
  assert.match(out, /package mode/)
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.equal(pkg.devDependencies['release-kit'], `github:n8watkins/release-kit#v${KIT_VERSION}`)
  assert.equal(pkg.scripts.release, 'release-kit release')
  assert.equal(pkg.scripts['release:check'], 'release-kit check && npm run lint')
  assert.ok(!existsSync(join(repo, 'scripts/release-kit')), 'the copied scripts are gone')
  assert.equal(JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8')).workflows, 'package')
  const commits = readFileSync(join(repo, '.github/workflows/commits.yml'), 'utf8')
  assert.match(commits, new RegExp(`uses: n8watkins/release-kit/\\.github/workflows/commits\\.yml@v${KIT_VERSION.replaceAll('.', '\\.')}$`, 'm'))
  const dependabot = readFileSync(join(repo, '.github/dependabot.yml'), 'utf8')
  assert.match(dependabot, /package-ecosystem: npm[\s\S]*dependency-name: release-kit/)
  assert.match(dependabot, /package-ecosystem: github-actions[\s\S]*dependency-name: n8watkins\/release-kit\*/)
  assert.match(readFileSync(join(repo, 'RELEASING.md'), 'utf8'), /npx release-kit protect/)

  // Before npm install the hook lets a commit through with a note; after it, it checks.
  const hook = attempt(repo, 'sh', ['.githooks/commit-msg', '/dev/null'])
  assert.equal(hook.status, 0)
  assert.match(hook.stderr, /not installed yet/)
  run(repo, 'mkdir', ['-p', 'node_modules/.bin'])
  run(repo, 'ln', ['-s', KIT, 'node_modules/release-kit'])
  run(repo, 'ln', ['-s', '../release-kit/bin/release-kit.mjs', 'node_modules/.bin/release-kit'])
  writeFileSync(join(repo, 'msg'), 'Added stuff\n')
  assert.notEqual(attempt(repo, 'sh', ['.githooks/commit-msg', 'msg']).status, 0)
  writeFileSync(join(repo, 'msg'), 'feat: add stuff\n')
  assert.equal(attempt(repo, 'sh', ['.githooks/commit-msg', 'msg']).status, 0)

  // The CLI runs the release from node_modules, with the plain notes by default.
  run(repo, 'git', ['add', '-A'])
  run(repo, 'git', ['commit', '-q', '-m', 'feat: add stuff'])
  const dry = run(repo, 'node', ['node_modules/.bin/release-kit', 'release', '--dry-run', '--no-check'])
  assert.match(dry, /### New\n\n- Add stuff/)

  // check warns (and never fails) when the workflows pin another version than the one installed.
  writeFileSync(join(repo, '.github/workflows/commits.yml'), commits.replace(`@v${KIT_VERSION}`, '@v0.0.1'))
  const check = spawnSync('node', ['node_modules/.bin/release-kit', 'check'], { cwd: repo, encoding: 'utf8', env: { ...process.env, RELEASE_KIT_OFFLINE: '1' } })
  assert.equal(check.status, 0)
  assert.match(check.stderr, /commits\.yml calls release-kit v0\.0\.1, but .* is installed/)

  // --vendored switches back: scripts copied, the dependency and the check dropped.
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  const back = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.equal(back.devDependencies['release-kit'], undefined)
  assert.equal(back.scripts.release, 'node scripts/release-kit/release.mjs')
  assert.equal(back.scripts['release:check'], 'npm run lint')
  assert.ok(existsSync(join(repo, 'scripts/release-kit/release.mjs')))
})

test("package mode: the kit's own .githooks isn't mistaken for another hook manager, and dependabot.yml must cover the root", async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-rerun'))
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ versionFiles: [], workflows: 'vendored' }))
  quiet(KIT, 'node', ['apply.mjs', repo])
  // Re-applying (now in package mode) with core.hooksPath already .githooks rewrites the hook.
  const out = quiet(KIT, 'node', ['apply.mjs', repo, '--package'])
  assert.doesNotMatch(out, /has its own hooks/)
  assert.match(readFileSync(join(repo, '.githooks/commit-msg'), 'utf8'), /node_modules\/\.bin\/release-kit/)

  run(repo, 'mkdir', ['-p', '.github'])
  writeFileSync(join(repo, '.github/dependabot.yml'), 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /app\n  - package-ecosystem: github-actions\n    directory: /\n')
  assert.match(quiet(KIT, 'node', ['apply.mjs', repo]), /has no npm entry for directory "\/"/)
  writeFileSync(join(repo, '.github/dependabot.yml'), 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: "github-actions"\n    directory: "/"\n')
  assert.doesNotMatch(quiet(KIT, 'node', ['apply.mjs', repo]), /dependabot\.yml has no/)
})
