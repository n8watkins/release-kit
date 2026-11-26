#!/usr/bin/env node
// The Dependabot policy apply writes into .github/dependabot.yml: major
// updates of some packages are ignored, because the repo can't take them yet.
//
// The repo's .release.json "dependabot" tunes that:
//   ignoreMajors  more packages whose major updates Dependabot doesn't propose,
//                 added to DEFAULT_IGNORE_MAJORS (an exact package name)
//   allowMajors   entries of DEFAULT_IGNORE_MAJORS this repo does take
// Minor and patch updates of an ignored package still arrive.

/**
 * Packages whose major updates the kit's dependabot.yml ignores in every
 * adopter, until the owner says otherwise. To start proposing a package's
 * majors again, remove its line here (then run the rollout).
 *
 * typescript: every released typescript-eslint (8.74.0, and the canary
 * 8.74.1-alpha.4) peer-requires typescript >=4.8.4 <6.1.0, and lint stops with
 * "typescript-eslint does not support TS 7.0", so a TypeScript 7 pull request
 * can't be merged.
 */
export const DEFAULT_IGNORE_MAJORS = [
  'typescript', // lint tooling (typescript-eslint) does not support TypeScript 7 yet
]

const NAME = /^[@\w./-]+$/

/**
 * The repo's Dependabot settings from .release.json "dependabot", with the
 * defaults filled in: { ignoreMajors, problems }. `ignoreMajors` is the
 * packages whose major updates are ignored. A setting that can't be read keeps
 * its default (the safe one) and is named in `problems`.
 */
export function dependabotPolicy(setting) {
  const problems = []
  const policy = { ignoreMajors: [...DEFAULT_IGNORE_MAJORS], problems }
  if (setting === undefined) return policy
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) {
    problems.push('"dependabot" must be an object like { "ignoreMajors": ["react"], "allowMajors": ["typescript"] }')
    return policy
  }
  const known = ['ignoreMajors', 'allowMajors']
  for (const key of Object.keys(setting)) if (!known.includes(key)) problems.push(`"dependabot.${key}" is not a setting (${known.join(', ')})`)
  const names = (key) => {
    const list = setting[key] ?? []
    if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !NAME.test(p))) {
      problems.push(`"dependabot.${key}" must be a list of package names like "typescript" or "@scope/name"`)
      return []
    }
    return list
  }
  const allow = names('allowMajors')
  for (const p of allow) if (!DEFAULT_IGNORE_MAJORS.includes(p)) problems.push(`"dependabot.allowMajors" names "${p}", which the kit doesn't ignore (its list: ${DEFAULT_IGNORE_MAJORS.join(', ')})`)
  policy.ignoreMajors = [...new Set([...DEFAULT_IGNORE_MAJORS.filter((p) => !allow.includes(p)), ...names('ignoreMajors')])]
  return policy
}

/** The dependabot.yml lines (npm entry, under `ignore:`) that ignore one package's major updates. */
export const ignoreMajorLines = (name) => `      - dependency-name: ${name}\n        update-types: ["version-update:semver-major"]\n`

/** Whether a dependabot.yml ignores the major updates of `name`. */
export function ignoresMajor(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  return new RegExp(`dependency-name:\\s*["']?${escaped}["']?\\s*\\n(?:\\s*#[^\\n]*\\n)*\\s*update-types:[^\\n]*version-update:semver-major`).test(text)
}
