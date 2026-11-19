import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sanitize } from './context.ts'
import { FORMAT, emptyScene, inspect, newerMessage } from './migrate.ts'

// What `canvas init` does to a project folder. Every step only adds or updates what is the tool's own and reports what
// it did, so running it again changes nothing.

export const START = '<!-- canvas:start -->'
export const END = '<!-- canvas:end -->'
export const DEFAULT_PORT = 8787

export type Step = { what: string; result: 'created' | 'updated' | 'unchanged' | 'skipped'; note?: string }

const json = (d: unknown) => JSON.stringify(d, null, 2) + '\n'

/** The empty files of a new `.canvas/`: valid, in the current format. */
export function emptyFiles(): Record<string, string> {
  const { rules: _rules, ...context } = sanitize({})
  return {
    'diagram.excalidraw': JSON.stringify(emptyScene()) + '\n',
    'context.json': json({ version: FORMAT, ...context }),
    'rules.json': json({ version: FORMAT, rules: '' }),
    'diagrams.json': json({ version: FORMAT, names: {} }),
    '.gitignore': 'history/\nexports/\n.backup-*/\n',
  }
}

/** Creates `.canvas/` and the files in it that are missing; existing files are never touched. */
export function initData(root: string): Step[] {
  const dir = join(root, '.canvas')
  const steps: Step[] = []
  const existed = existsSync(dir)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(emptyFiles())) {
    const file = join(dir, name)
    if (existsSync(file)) continue
    writeFileSync(file, content)
    steps.push({ what: `.canvas/${name}`, result: 'created' })
  }
  if (!steps.length) steps.push({ what: '.canvas/', result: 'unchanged' })
  const found = inspect(dir)
  const newest = Math.max(0, ...found.map((f) => f.version))
  if (newest > FORMAT) steps.push({ what: '.canvas/', result: 'skipped', note: newerMessage(newest) })
  else if (existed && found.some((f) => f.version < FORMAT)) steps.push({ what: '.canvas/', result: 'unchanged', note: 'has files from an older format; canvas upgrades them (keeping a backup) when it first opens the project' })
  return steps
}

/** `existing` is the text of .mcp.json (null when there is none). Sets the canvas server and leaves everything else alone. */
export function mergeMcp(existing: string | null, url: string): { text: string; result: Step['result'] } {
  let doc: any = {}
  if (existing !== null && existing.trim()) {
    try {
      doc = JSON.parse(existing)
    } catch (e) {
      throw new Error(`.mcp.json is not valid JSON (${e}); fix it and run canvas init again. It was not changed.`)
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('.mcp.json is not a JSON object; it was not changed.')
  }
  const servers = doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {}
  const next = { ...doc, mcpServers: { ...servers, canvas: { ...servers.canvas, type: 'http', url } } }
  const text = json(next)
  return { text, result: existing === null ? 'created' : text === existing ? 'unchanged' : 'updated' }
}

export function writeMcp(root: string, url: string): Step {
  const file = join(root, '.mcp.json')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null
  const { text, result } = mergeMcp(existing, url)
  if (result !== 'unchanged') writeFileSync(file, text)
  return { what: '.mcp.json', result }
}

/** The port in the canvas entry of an existing .mcp.json, to keep it when none is given. */
export function mcpPort(root: string): number | undefined {
  try {
    const u = new URL(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.canvas.url)
    return Number(u.port) || undefined
  } catch {
    return undefined
  }
}

/** The project id in the canvas entry of an existing .mcp.json (`/p/<id>/mcp`). */
export function mcpId(root: string): string | undefined {
  try {
    return /^\/p\/([^/]+)\/mcp$/.exec(new URL(JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers.canvas.url).pathname)?.[1]
  } catch {
    return undefined
  }
}

/** Why Claude Code would not find this project's canvas tools (null when `.mcp.json` points at `url`). Claude Code reads
 *  the canvas server only from `.mcp.json`, so without it the agent has no drawing tools and answers with some other tool. */
export function mcpProblem(root: string, url: string): string | null {
  let found: unknown
  try {
    found = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers?.canvas?.url
  } catch (e: any) {
    return e?.code === 'ENOENT' ? 'this project has no .mcp.json' : '.mcp.json is not valid JSON'
  }
  if (!found) return '.mcp.json has no "canvas" server'
  return found === url ? null : `.mcp.json points the canvas at ${found}, not ${url}`
}

/** CLAUDE.md with the canvas section between its markers set to `body`: replaced when the markers are there, appended when
 *  not. Text outside the markers is not touched. Null `existing` is a missing file. */
export function applySection(existing: string | null, body: string): { text: string; result: Step['result']; note?: string } {
  const block = `${START}\n${body.trim()}\n${END}`
  if (existing === null || !existing.trim()) return { text: block + '\n', result: 'created' }
  const a = existing.indexOf(START)
  const b = existing.indexOf(END)
  if (a < 0 && b < 0) {
    const old = /^#{1,3}\s*Architecture canvas\b/m.test(existing)
    const text = existing.replace(/\s*$/, '') + '\n\n' + block + '\n'
    return { text, result: 'updated', ...(old ? { note: 'CLAUDE.md already has an "Architecture canvas" section outside the markers; remove the old one by hand' } : {}) }
  }
  if (a < 0 || b < a || existing.indexOf(START, a + 1) >= 0 || existing.indexOf(END, b + 1) >= 0) throw new Error(`CLAUDE.md has unbalanced ${START} / ${END} markers; it was not changed. Fix them and run canvas init again.`)
  const text = existing.slice(0, a) + block + existing.slice(b + END.length)
  return { text, result: text === existing ? 'unchanged' : 'updated' }
}

export function writeSection(root: string, body: string): Step {
  const file = join(root, 'CLAUDE.md')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null
  const { text, result, note } = applySection(existing, body)
  if (result !== 'unchanged') writeFileSync(file, text)
  return { what: 'CLAUDE.md', result, note }
}

export const template = () => readFileSync(new URL('../templates/CLAUDE.section.md', import.meta.url), 'utf8')
