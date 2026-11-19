import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
/** The installed version, from package.json. */
export const VERSION: string = pkg.version

const REPO: string = process.env.CANVAS_UPDATE_REPO ?? 'https://github.com/andreivasilache/claudraw.git'
const TTL = 6 * 60 * 60 * 1000

const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number)

/** > 0 when a is newer than b (plain MAJOR.MINOR.PATCH, with or without a leading v); null when either is not a version. */
export function compare(a: string, b: string): number | null {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** The newest version among the tag names of `git ls-remote --tags --refs` output. */
export function newestTag(lsRemote: string): string | null {
  const tags = lsRemote.split('\n').map((l) => /refs\/tags\/(\S+)$/.exec(l.trim())?.[1]).filter((t): t is string => !!t && !!parse(t))
  return tags.sort((a, b) => compare(b, a)!)[0] ?? null
}

let latest: { at: number; tag: string | null } | null = null
let asking = false

/** The newest tag in the repo, when one is known. Never waits: the first call starts a check in the background (a few seconds
 *  at most, no prompts, silent on any error) and answers with what the previous check found, or null. */
export function latestTag(): string | null {
  if (process.env.CANVAS_NO_UPDATE_CHECK) return null
  if (!asking && (!latest || Date.now() - latest.at > TTL)) {
    asking = true
    execFile('git', ['ls-remote', '--tags', '--refs', REPO], { timeout: 4000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out) => {
      asking = false
      latest = { at: Date.now(), tag: err ? null : newestTag(out) }
    })
  }
  return latest?.tag ?? null
}

/** What the project list shows: the installed version and, if the repo has a newer tag, that one. */
export function versionInfo() {
  const tag = latestTag()
  return { version: VERSION, ...(tag && (compare(tag, VERSION) ?? 0) > 0 ? { latest: tag.replace(/^v/, '') } : {}) }
}
