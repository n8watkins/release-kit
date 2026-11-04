// End to end: apply the kit to a throwaway repo, then commit and release in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KIT = new URL('..', import.meta.url).pathname
const run = (cwd, cmd, args) => execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RELEASE_KIT_OFFLINE: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })
const attempt = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RELEASE_KIT_OFFLINE: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } })

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

test("a repo's own workflow that runs the kit is still the repo's own", async () => {
  // Scribe's release.yml builds and signs the app and calls npx release-kit in
  // a step; apply 2.5.2 took the mention for its marker and replaced the file.
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-mentions'))
  run(repo, 'mkdir', ['-p', '.github/workflows'])
  const own = 'name: Release\n# release-kit owns the version; this file owns the build.\njobs:\n  build:\n    steps:\n      - run: npx --no-install release-kit release --verify-tag "$TAG"\n'
  writeFileSync(join(repo, '.github/workflows/release.yml'), own)
  writeFileSync(join(repo, '.github/workflows/release-train.yml'), own)
  assert.match(quiet(KIT, 'node', ['apply.mjs', repo]), /release\.yml exists and isn't from the kit/)
  assert.equal(readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8'), own)
  // Without --train, apply removes only a train it wrote.
  assert.equal(readFileSync(join(repo, '.github/workflows/release-train.yml'), 'utf8'), own)
  // Its own workflows, which start with the marker, are still upgraded.
  assert.match(readFileSync(join(repo, '.github/workflows/commits.yml'), 'utf8'), /^# release-kit/)
})

test("a prepare script that points core.hooksPath at the repo's own folder counts as a hook manager", async () => {
  // voicedock's prepare set core.hooksPath to tools/hooks: apply wrote .githooks,
  // and the next npm install switched it off again.
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-prepare'), { scripts: { prepare: 'git config core.hooksPath tools/hooks || true' } })
  const out = quiet(KIT, 'node', ['apply.mjs', repo])
  assert.match(out, /the prepare script sets core\.hooksPath to tools\/hooks, so the kit's hooks are not installed/)
  assert.equal(existsSync(join(repo, '.githooks')), false)
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts.prepare, 'git config core.hooksPath tools/hooks || true')
  // .githooks itself, or husky's folder, is the kit's to use.
  const kitFolder = makeRepo(tmp('apply-prepare-kit'), { scripts: { prepare: 'git config core.hooksPath .githooks || true' } })
  quiet(KIT, 'node', ['apply.mjs', kitFolder])
  assert.ok(existsSync(join(kitFolder, '.githooks/commit-msg')))
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
    assert.match(out, /so the kit's hooks are not installed: add {2}node scripts\/release-kit\/commit-msg\.mjs "\$1" {2}to the commit-msg hook there .*, and {2}node scripts\/release-kit\/guard\.mjs "\$@" {2}to the pre-push hook/)
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
  assert.match(out, /gh api -X PATCH repos\/\{owner\}\/\{repo\} -f squash_merge_commit_title=PR_TITLE -f squash_merge_commit_message=PR_BODY/)
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

test('package mode allows the kit as a git dependency in .npmrc (npm 12), and keeps what the repo set', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const npmrc = (repo) => readFileSync(join(repo, '.npmrc'), 'utf8')
  const note = '# release-kit: npm 12 installs git dependencies (the kit is one) only when allowed.\nallow-git=root\n'

  const fresh = makeRepo(tmp('npmrc'))
  assert.match(quiet(KIT, 'node', ['apply.mjs', fresh]), /\.npmrc: allow-git=root/)
  assert.equal(npmrc(fresh), note)
  quiet(KIT, 'node', ['apply.mjs', fresh])
  assert.equal(npmrc(fresh), note, 're-applying adds nothing')
  // Copied scripts need no git dependency, so switching modes takes the line back out.
  quiet(KIT, 'node', ['apply.mjs', fresh, '--vendored'])
  assert.ok(!existsSync(join(fresh, '.npmrc')))

  const own = makeRepo(tmp('npmrc-own'))
  writeFileSync(join(own, '.npmrc'), 'engine-strict=true')
  quiet(KIT, 'node', ['apply.mjs', own])
  assert.equal(npmrc(own), `engine-strict=true\n${note}`)
  quiet(KIT, 'node', ['apply.mjs', own, '--reusable'])
  assert.equal(npmrc(own), 'engine-strict=true\n')

  const none = makeRepo(tmp('npmrc-none'))
  writeFileSync(join(none, '.npmrc'), 'allow-git=none\nsave-exact=true\n')
  assert.match(quiet(KIT, 'node', ['apply.mjs', none]), /allow-git=none -> root/)
  assert.equal(npmrc(none), 'allow-git=root\nsave-exact=true\n')

  const all = makeRepo(tmp('npmrc-all'))
  writeFileSync(join(all, '.npmrc'), 'allow-git = all\n')
  assert.doesNotMatch(quiet(KIT, 'node', ['apply.mjs', all]), /\.npmrc/)
  assert.equal(npmrc(all), 'allow-git = all\n')
})

// The real install, with whatever npm is on the PATH (CI runs it with npm 12
// too): the kit as a git dependency, from a local clone so no network is needed.
test('an applied repo installs the kit as a git dependency, which npm 12 refuses without .npmrc', async () => {
  const { makeRepo, tmp, run: quiet, attempt: tryIt } = await import('./helpers.mjs')
  const npmMajor = Number(quiet(KIT, 'npm', ['--version']).split('.')[0])
  const root = tmp('install')
  // The kit as it is in this working tree, committed in a repo of its own.
  const kit = join(root, 'kit')
  cpSync(KIT, kit, { recursive: true, filter: (path) => !/\/(\.git|node_modules)$/.test(path) })
  quiet(kit, 'git', ['init', '-q'])
  quiet(kit, 'git', ['add', '-A'])
  quiet(kit, 'git', ['commit', '-q', '--no-verify', '-m', 'chore: the kit'])
  const repo = makeRepo(join(root, 'repo'))
  quiet(KIT, 'node', ['apply.mjs', repo])
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  pkg.devDependencies['release-kit'] = `git+file://${kit}`
  writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2))
  const install = () => tryIt(repo, 'npm', ['install', '--no-audit', '--no-fund'], { npm_config_cache: join(root, 'cache') })

  const installed = install()
  assert.equal(installed.status, 0, installed.stderr)
  // It runs from node_modules. The test's own git+file spec in package.json
  // differs from what apply writes, so check says so rather than "up to date".
  const checked = tryIt(repo, 'node', ['node_modules/.bin/release-kit', 'check'])
  assert.equal(checked.status, 0, checked.stderr)
  assert.match(checked.stderr, /release-kit v\d+\.\d+\.\d+ adds or changes 1 file; run npx release-kit apply \. \(changed package\.json\)/)
  // The kit itself runs no install script, which npm 12 would hold back and warn about.
  assert.doesNotMatch(installed.stderr, /install-scripts/)

  if (npmMajor >= 12) {
    run(repo, 'rm', ['-rf', '.npmrc', 'node_modules', 'package-lock.json'])
    const refused = install()
    assert.notEqual(refused.status, 0)
    assert.match(refused.stderr, /EALLOWGIT/)
  }
})

test('commits.yml checks pushes to the branches releases are cut from, and check warns when it does not', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-branches'))
  const workflow = () => readFileSync(join(repo, '.github/workflows/commits.yml'), 'utf8')
  const check = () => spawnSync('node', [join(KIT, 'bin/release-kit.mjs'), 'check'], { cwd: repo, encoding: 'utf8', env: { ...process.env, RELEASE_KIT_OFFLINE: '1' } })

  quiet(KIT, 'node', ['apply.mjs', repo, '--reusable'])
  assert.match(workflow(), /^ {4}branches: \[main, master\]$/m, 'without branches, main and master as before')

  writeFileSync(join(repo, '.release.json'), JSON.stringify({ versionFiles: [], workflows: 'reusable', branches: ['master', 'review/app-v0.3.81', "hot*fix's"] }))
  const stale = check()
  assert.equal(stale.status, 0)
  assert.match(stale.stderr, /commits\.yml doesn't check pushes to review\/app-v0\.3\.81, hot\*fix's, a branch releases are cut from/)

  quiet(KIT, 'node', ['apply.mjs', repo])
  assert.match(workflow(), /^ {4}branches: \[main, master, review\/app-v0\.3\.81, 'hot\\\*fix''s'\]$/m)
  assert.doesNotMatch(check().stderr, /doesn't check pushes/)

  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.match(workflow(), /^ {4}branches: \[main, master, review\/app-v0\.3\.81, 'hot\\\*fix''s'\]$/m, 'the vendored copy too')
})

test('package mode groups a kit release into one Dependabot PR, and upgrades the dependabot.yml an older kit wrote', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('dependabot'))
  const path = join(repo, '.github/dependabot.yml')
  run(repo, 'mkdir', ['-p', '.github'])
  // What kit 2.1.0 wrote: two ecosystems, two PRs per release.
  writeFileSync(path, '# release-kit: a new kit release arrives as update PRs (the dev dependency and the workflow pins).\nversion: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n')
  assert.match(quiet(KIT, 'node', ['apply.mjs', repo]), /dependabot\.yml \(one grouped PR per kit release\)/)
  const grouped = readFileSync(path, 'utf8')
  assert.match(grouped, /^multi-ecosystem-groups:\n {2}release-kit:\n {4}schedule:\n {6}interval: daily$/m)
  assert.equal(grouped.match(/^ {4}multi-ecosystem-group: release-kit$/gm).length, 2)
  assert.match(grouped, /package-ecosystem: npm\n {4}directory: \/\n {4}patterns: \["release-kit"\]/)
  assert.match(grouped, /package-ecosystem: github-actions\n {4}directory: \/\n {4}patterns: \["n8watkins\/release-kit\*"\]/)
  // Dependabot's default cooldown made it propose older kit tags (v2.2.0 -> v2.0.1): the kit is exempt.
  assert.match(grouped, /patterns: \["release-kit"\][\s\S]*?\n {4}cooldown:\n {6}exclude: \["release-kit"\]\n/)
  assert.match(grouped, /patterns: \["n8watkins\/release-kit\*"\][\s\S]*?\n {4}cooldown:\n {6}exclude: \["n8watkins\/release-kit\*"\]\n/)
  // Dependabot rejects the whole file when an update in a multi-ecosystem group sets commit-message:
  // "commit-message should only be set on the associated multi-ecosystem group".
  assert.match(grouped, /^ {2}release-kit:\n {4}schedule:\n {6}interval: daily\n(?: {4}#.*\n)? {4}commit-message:\n {6}prefix: build\n {6}include: scope\nupdates:/m)
  const entries = grouped.split(/^updates:$/m)[1]
  assert.doesNotMatch(entries, /commit-message|schedule:/)
  const again = quiet(KIT, 'node', ['apply.mjs', repo])
  assert.doesNotMatch(again, /\.github\/dependabot\.yml/, 're-applying changes nothing')

  // The repo's own dependabot.yml is left alone, with a note on grouping.
  writeFileSync(path, 'version: 2\nupdates:\n  - package-ecosystem: npm\n    directory: /\n  - package-ecosystem: github-actions\n    directory: /\n')
  const own = quiet(KIT, 'node', ['apply.mjs', repo])
  assert.match(own, /is the repo's own, so kit releases arrive as separate npm and github-actions PRs/)
  assert.match(own, /doesn't exclude release-kit from Dependabot's default 3-day cooldown/)
  assert.doesNotMatch(readFileSync(path, 'utf8'), /multi-ecosystem/)
})

test('the Release and train jobs run only in the upstream repo, named from .release.json or the remotes, on every rerun', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('fork-guard'))
  const workflow = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8')
  const config = () => JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8'))
  const guard = (slug) => new RegExp(`^ {4}if: github\\.repository == '${slug}' # release-kit: fork guard$`, 'm')

  // No GitHub remote: the jobs skip any fork instead, and apply says how to name the repo.
  assert.match(quiet(KIT, 'node', ['apply.mjs', repo, '--train']), /could not tell which GitHub repo this is/)
  assert.match(workflow('release.yml'), /^ {4}if: \$\{\{ !github\.event\.repository\.fork \}\} # release-kit: fork guard$/m)
  assert.equal(config().repository, undefined)

  // A fork's clone: "upstream" wins over "origin", and the name is saved.
  run(repo, 'git', ['remote', 'add', 'origin', 'git@github.com:forker/app.git'])
  run(repo, 'git', ['remote', 'add', 'upstream', 'https://github.com/acme/app.git'])
  quiet(KIT, 'node', ['apply.mjs', repo])
  for (const name of ['release.yml', 'release-train.yml']) assert.match(workflow(name), guard('acme/app'), name)
  assert.equal(config().repository, 'acme/app')
  // Rerunning apply (which rewrites the workflows) keeps the guard, even with the remotes gone.
  run(repo, 'git', ['remote', 'remove', 'upstream'])
  run(repo, 'git', ['remote', 'remove', 'origin'])
  writeFileSync(join(repo, '.github/workflows/release.yml'), '# release-kit (reusable): an older caller.\nname: Release\n')
  quiet(KIT, 'node', ['apply.mjs', repo])
  assert.match(workflow('release.yml'), guard('acme/app'))

  // The vendored copies carry it on the first job, which every other job needs.
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'])
  assert.match(workflow('release.yml'), new RegExp(`  verify:\\n    name: Verify and build\\n(?:    #.*\\n)*${guard('acme/app').source.slice(1, -1)}`))
  assert.match(workflow('release-train.yml'), new RegExp(`  plan:\\n    name: Anything to release\\?\\n(?:    #.*\\n)*${guard('acme/app').source.slice(1, -1)}`))
  assert.match(workflow('release.yml'), /  publish:\n[\s\S]*needs: verify/)

  // --repository renames it; a malformed name is refused.
  quiet(KIT, 'node', ['apply.mjs', repo, '--repository', 'acme/renamed'])
  assert.match(workflow('release.yml'), guard('acme/renamed'))
  assert.equal(config().repository, 'acme/renamed')
  assert.notEqual(attempt(KIT, 'node', ['apply.mjs', repo, '--repository', "a/b' || true"]).status, 0)
})

test("the kit's own workflows skip forks without naming a repo, so callers anywhere still run them", () => {
  for (const [file, job] of [['template/.github/workflows/release.yml', 'verify'], ['template/.github/workflows/release-train.yml', 'plan']]) {
    const text = readFileSync(join(KIT, file), 'utf8')
    assert.match(text, new RegExp(`^  ${job}:\\n(?: {4}.*\\n)*? {4}if: \\$\\{\\{ !github\\.event\\.repository\\.fork \\}\\} # release-kit: fork guard$`, 'm'), file)
  }
  for (const file of ['reusable/release.yml', 'reusable/release-train.yml']) {
    assert.match(readFileSync(join(KIT, file), 'utf8'), /^ {4}if: github\.repository == 'UPSTREAM_REPO' # release-kit: fork guard$/m, file)
  }
})

test('check warns about files an older apply wrote without the fork guard or the Dependabot cooldown exemption', async () => {
  const { makeRepo, tmp, run: quiet } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-stale'))
  const check = () => spawnSync('node', [join(KIT, 'bin/release-kit.mjs'), 'check'], { cwd: repo, encoding: 'utf8', env: { ...process.env, RELEASE_KIT_OFFLINE: '1' } }).stderr
  quiet(KIT, 'node', ['apply.mjs', repo, '--train'])
  assert.doesNotMatch(check(), /fork guard|cooldown/)
  // What kit 2.2.0 wrote.
  writeFileSync(join(repo, '.github/workflows/release.yml'), '# release-kit (reusable): an older caller.\nname: Release\njobs:\n  release:\n    uses: n8watkins/release-kit/.github/workflows/release.yml@v2.2.0\n')
  writeFileSync(join(repo, '.github/dependabot.yml'), '# release-kit: a new kit release arrives as one update PR.\nversion: 2\n')
  const stale = check()
  assert.match(stale, /release\.yml has no fork guard, so a fork that pushes a tag publishes a release: rerun npx release-kit apply \./)
  assert.match(stale, /dependabot\.yml lets Dependabot's cooldown propose older kit versions/)
  writeFileSync(join(repo, '.github/dependabot.yml'), '# release-kit: one PR.\nversion: 2\nupdates:\n  - package-ecosystem: npm\n    multi-ecosystem-group: release-kit\n    cooldown:\n      exclude: ["release-kit"]\n    commit-message:\n      prefix: build\n')
  assert.match(check(), /dependabot\.yml is rejected by Dependabot \(commit-message belongs on the multi-ecosystem group\)/)
  assert.doesNotMatch(stale, /release-train\.yml has no fork guard/)
  quiet(KIT, 'node', ['apply.mjs', repo])
  assert.doesNotMatch(check(), /fork guard|cooldown/)
  // A repo's own release.yml (scribe's Tauri build) that runs the kit is the
  // repo's: apply keeps it, so check doesn't ask for the kit's fork guard in it.
  writeFileSync(join(repo, '.github/workflows/release.yml'), 'name: Release\non:\n  push:\n    tags: [v*]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx release-kit notes\n')
  assert.doesNotMatch(check(), /fork guard/)
})

test('apply installs the pre-push guard beside the commit-msg hook, and keeps a pre-push hook of the repo\'s own', async () => {
  const { makeRepo, tmp, run: quiet, attempt: tryIt } = await import('./helpers.mjs')
  // .githooks, package mode: the kit from node_modules, with a fallback before npm install.
  const repo = makeRepo(tmp('apply-guard'))
  quiet(KIT, 'node', ['apply.mjs', repo])
  const hook = readFileSync(join(repo, '.githooks/pre-push'), 'utf8')
  assert.match(hook, /^#!\/bin\/sh\n# release-kit: pre-push guard/)
  assert.match(hook, /exec "\$kit" pre-push "\$@"/)
  // Not installed yet: a push to main is still blocked, a branch goes through.
  const fallback = (line) => tryIt(repo, 'sh', ['.githooks/pre-push', 'origin', 'x'], {}, `${line}\n`)
  assert.equal(fallback(`refs/heads/main ${'a'.repeat(40)} refs/heads/main ${'b'.repeat(40)}`).status, 1)
  assert.equal(fallback(`refs/heads/f ${'a'.repeat(40)} refs/heads/f ${'b'.repeat(40)}`).status, 0)
  assert.equal(fallback(`refs/tags/v1.0.0 ${'a'.repeat(40)} refs/tags/v1.0.0 ${'0'.repeat(40)}`).status, 0)
  assert.equal(fallback(`refs/tags/v1.0.0 ${'a'.repeat(40)} refs/tags/v1.0.0 ${'b'.repeat(40)}`).status, 1)

  // husky: .husky/pre-push, unless the repo has its own.
  const husky = makeRepo(tmp('apply-guard-husky'))
  mkdirSync(join(husky, '.husky'))
  quiet(KIT, 'node', ['apply.mjs', husky])
  assert.match(readFileSync(join(husky, '.husky/pre-push'), 'utf8'), /^# release-kit: pre-push guard/)
  writeFileSync(join(husky, '.husky/pre-push'), 'npm test\n')
  const out = quiet(KIT, 'node', ['apply.mjs', husky])
  assert.match(out, /\.husky\/pre-push is the repo's own, so the kit's pre-push guard is not installed: add {2}npx --no-install release-kit pre-push "\$@" {2}as its first line/)
  assert.equal(readFileSync(join(husky, '.husky/pre-push'), 'utf8'), 'npm test\n')

  // .githooks with a pre-push of the repo's own.
  const own = makeRepo(tmp('apply-guard-own'))
  mkdirSync(join(own, '.githooks'))
  writeFileSync(join(own, '.githooks/pre-push'), '#!/bin/sh\nnpm test\n')
  assert.match(quiet(KIT, 'node', ['apply.mjs', own, '--vendored']), /\.githooks\/pre-push is the repo's own, so the kit's pre-push hook is not installed: add {2}node scripts\/release-kit\/guard\.mjs "\$@" {2}to it/)
  assert.equal(readFileSync(join(own, '.githooks/pre-push'), 'utf8'), '#!/bin/sh\nnpm test\n')
  assert.ok(existsSync(join(own, '.githooks/commit-msg')))
})

test('visibility: a private repo scans weekly only, every repo gets auto-merge, and the settings can be overridden', async () => {
  const { makeRepo, tmp, run: quiet, attempt: tryIt } = await import('./helpers.mjs')
  const repo = makeRepo(tmp('apply-private'))
  const config = () => JSON.parse(readFileSync(join(repo, '.release.json'), 'utf8'))
  const workflow = (name) => readFileSync(join(repo, '.github/workflows', name), 'utf8')
  // gh can't tell (offline): a note, and the public defaults.
  const unknown = quiet(KIT, 'node', ['apply.mjs', repo, '--repository', 'o/r'], { RELEASE_KIT_OFFLINE: '1' })
  assert.match(unknown, /could not tell whether o\/r is public or private .*rerun with --visibility private/)
  assert.equal(config().visibility, undefined)
  // Auto-merge in every repo: GitHub's where checks are required, else merge when green.
  assert.ok(existsSync(join(repo, '.github/workflows/auto-merge.yml')))

  // gh says private.
  const bin = tmp('apply-gh')
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho PRIVATE\n', { mode: 0o755 })
  quiet(KIT, 'node', ['apply.mjs', repo], { PATH: `${bin}:${process.env.PATH}`, RELEASE_KIT_OFFLINE: '' })
  assert.equal(config().visibility, 'private')
  assert.match(workflow('security.yml'), /pull-requests: auto # release-kit: security on pull requests/)
  const autoMerge = workflow('auto-merge.yml')
  assert.match(autoMerge, /^# release-kit: merge update pull requests once CI passes/)
  assert.match(autoMerge, /workflows: \["Commit messages", "Security scan"\]/)
  assert.match(autoMerge, /uses: n8watkins\/release-kit\/\.github\/workflows\/auto-merge\.yml@v/)
  // The policy is the documented example's.
  const policy = (text) => /^ {4}if: >-\n((?: {6}.*\n)+)/m.exec(text)[1]
  assert.equal(policy(autoMerge), policy(readFileSync(join(KIT, 'docs/examples/auto-merge.yml'), 'utf8')))
  // And its permissions: merge when green reads the checks on the pull request.
  const grants = (text) => /^ {4}permissions:\n((?: {6}.*\n)+)/m.exec(text)[1]
  assert.equal(grants(autoMerge), grants(readFileSync(join(KIT, 'docs/examples/auto-merge.yml'), 'utf8')))
  assert.match(workflow('direct-push.yml'), /uses: n8watkins\/release-kit\/\.github\/workflows\/direct-push\.yml@v/)

  // Overrides, and release branches reach the alarm.
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ ...config(), security: { onPullRequest: true }, branches: ['main', 'review/v1'] }))
  quiet(KIT, 'node', ['apply.mjs', repo, '--visibility', 'public'])
  assert.equal(config().visibility, 'public')
  assert.match(workflow('security.yml'), /pull-requests: true # release-kit: security on pull requests/)
  assert.match(workflow('direct-push.yml'), /branches: \[main, master, review\/v1\]/)
  assert.match(workflow('direct-push.yml'), /branches: "review\/v1" # release-kit: branches/)
  // Vendored: the same settings in the full copies.
  quiet(KIT, 'node', ['apply.mjs', repo, '--vendored'], { RELEASE_KIT_OFFLINE: '1' })
  assert.match(workflow('security.yml'), /\(inputs\.pull-requests \|\| 'true'\) == 'true'/)
  assert.match(workflow('direct-push.yml'), /format\(',main,master,review\/v1,\{0\},'/)
  assert.match(tryIt(KIT, 'node', ['apply.mjs', repo, '--visibility', 'secret']).stderr, /--visibility takes public or private, not "secret"/)
  // "autoMerge": false: apply doesn't write it.
  rmSync(join(repo, '.github/workflows/auto-merge.yml'))
  writeFileSync(join(repo, '.release.json'), JSON.stringify({ ...config(), autoMerge: false }))
  quiet(KIT, 'node', ['apply.mjs', repo], { RELEASE_KIT_OFFLINE: '1' })
  assert.ok(!existsSync(join(repo, '.github/workflows/auto-merge.yml')))
})
