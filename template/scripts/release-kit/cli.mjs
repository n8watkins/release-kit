// Command-line options for the kit's scripts. Every option must be one the
// script knows, so a typo (--dryrun, --dry_run) stops with an error instead of
// falling through to the script's default action, which for release is a real
// release. --help and -h print the script's usage: its opening comment.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** A script's usage: its opening comment block, without the comment markers. */
export function usageOf(url) {
  const lines = readFileSync(fileURLToPath(url), 'utf8').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  for (const line of lines.slice(lines[0]?.startsWith('#!') ? 1 : 0)) {
    if (!line.startsWith('//')) break
    out.push(line.replace(/^\/\/ ?/, ''))
  }
  return `${out.join('\n').trim()}\n`
}

/**
 * Checks a script's arguments before it acts on any of them.
 *   name         the script's name in messages (release, protect, ...)
 *   url          the script's import.meta.url: its opening comment is the usage
 *   flags        options without a value, like ['dry-run', 'push']
 *   values       options that always take the next argument, like ['summary']
 *                (the script itself says when that value is missing or wrong)
 *   optional     options whose value may be left out, like ['baseline']: the
 *                next argument is its value unless it starts with "--"
 *   positionals  how many bare arguments it takes (default none)
 * --help or -h anywhere an option may stand prints the usage and exits 0. An
 * unknown option, a short one, or one bare argument too many prints what is
 * wrong and exits 1, before anything is read or written.
 * Returns the bare arguments.
 */
export function checkArgs(args, { name, url, flags = [], values = [], optional = [], positionals = 0 }) {
  const stop = (problem) => {
    console.error(`${name}: ${problem}; ${name} --help lists what it takes`)
    process.exit(1)
  }
  const bare = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usageOf(url))
      process.exit(0)
    }
    if (!arg.startsWith('-') || arg === '-') {
      bare.push(arg)
      continue
    }
    const option = arg.slice(2)
    if (!arg.startsWith('--')) stop(`unknown option ${arg}`)
    else if (flags.includes(option)) continue
    else if (values.includes(option)) i += 1
    else if (optional.includes(option)) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i += 1
    } else stop(`unknown option ${arg}`)
  }
  if (bare.length > positionals) stop(`unexpected argument "${bare[positionals]}"`)
  return bare
}
