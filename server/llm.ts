import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// The agents the side panel can run: Claude Code itself, or OpenCode (sst's agent, with its providers in
// ~/.config/opencode/opencode.json, e.g. the company's vLLM servers). Kept outside the projects, next to
// projects.json, because API keys live here.

export const KINDS = ['claude', 'opencode'] as const
export type Kind = (typeof KINDS)[number]

export type Llm = {
  id: string
  name: string
  kind: Kind
  /** The command line started in the terminal, e.g. "claude" or "opencode". */
  command: string
  baseUrl: string
  apiKey: string
  model: string
  /** Extra environment, one KEY=VALUE per line. */
  env: string
}
type Settings = { llms: Llm[]; default: string; projects: Record<string, string> }

const FILE = process.env.CANVAS_SETTINGS ?? join(homedir(), '.config', 'canvas', 'settings.json')
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/

const DEFAULTS: Llm[] = [
  { id: 'claude', name: 'Claude Code', kind: 'claude', command: process.env.CANVAS_CLAUDE_CMD ?? 'claude', baseUrl: '', apiKey: '', model: '', env: '' },
  { id: 'opencode', name: 'OpenCode', kind: 'opencode', command: 'opencode', baseUrl: '', apiKey: '', model: '', env: '' },
]

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'llm'

let settings: Settings | null = null

function load(): Settings {
  if (settings) return settings
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'))
    const llms = (Array.isArray(raw.llms) ? raw.llms : []).map(clean).filter((l: Llm | null): l is Llm => !!l)
    settings = { llms: llms.length ? llms : DEFAULTS, default: str(raw.default, 40), projects: typeof raw.projects === 'object' && raw.projects ? raw.projects : {} }
  } catch {
    settings = { llms: DEFAULTS, default: 'claude', projects: {} }
  }
  return settings
}

function save(s: Settings) {
  settings = s
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, FILE)
}

function clean(l: any): Llm | null {
  if (!l || typeof l !== 'object') return null
  const name = str(l.name, 80)
  const command = str(l.command, 500)
  if (!name || !command || (l.kind !== undefined && !KINDS.includes(l.kind))) return null
  return {
    id: ID.test(l.id) ? l.id : slug(name),
    name,
    kind: l.kind ?? 'claude',
    command,
    baseUrl: str(l.baseUrl, 500),
    apiKey: str(l.apiKey, 500),
    model: str(l.model, 200),
    env: typeof l.env === 'string' ? l.env.slice(0, 5000) : '',
  }
}

export const llms = () => load().llms
export const getLlm = (id: string | undefined) => llms().find((l) => l.id === id)
export const defaultLlm = () => getLlm(load().default) ?? llms()[0]

/** The agent this project's terminal runs: the last one picked there, else the default. */
export const projectLlm = (projectId: string) => getLlm(load().projects[projectId]) ?? defaultLlm()
export function setProjectLlm(projectId: string, llmId: string) {
  const s = load()
  if (s.projects[projectId] !== llmId) save({ ...s, projects: { ...s.projects, [projectId]: llmId } })
}

/** For the settings page: API keys are never sent back, only whether one is set. */
export const publicSettings = () => {
  const s = load()
  return { default: defaultLlm()?.id ?? '', llms: s.llms.map(({ apiKey, ...l }) => ({ ...l, apiKey: '', hasApiKey: !!apiKey })), kinds: KINDS, file: FILE }
}

/** Replace the list. An empty apiKey keeps the stored one unless `clearApiKey` is set. */
export function saveSettings(b: any) {
  const old = load()
  const seen = new Set<string>()
  const list: Llm[] = []
  for (const raw of Array.isArray(b.llms) ? b.llms.slice(0, 30) : []) {
    const l = clean(raw)
    if (!l) continue
    let id = l.id
    for (let n = 2; seen.has(id); n++) id = `${l.id}-${n}`
    seen.add(id)
    const prev = old.llms.find((o) => o.id === id)
    if (!l.apiKey && !raw.clearApiKey && prev) l.apiKey = prev.apiKey
    list.push({ ...l, id })
  }
  if (!list.length) throw new Error('Add at least one LLM (a name and a command).')
  const def = list.some((l) => l.id === b.default) ? b.default : list[0].id
  save({ llms: list, default: def, projects: old.projects })
  return publicSettings()
}

/** The command and environment a terminal starts with for this agent. `mcpUrl` is the project's canvas MCP endpoint:
 *  Both agents are handed it inline: Claude Code ignores a project's .mcp.json server until the user approves it, and
 *  an unapproved server means no canvas tools (the agent then draws with whatever other tool it has). */
export function launch(l: Llm, mcpUrl: string) {
  const [file, ...args] = l.command.split(/\s+/)
  const env: Record<string, string> = {}
  const set = (k: string, v: string) => v && (env[k] = v)
  if (l.kind === 'opencode') {
    // Providers and keys come from opencode's own config; baseUrl / apiKey are not used.
    // --standalone: a private server that dies with the terminal. The shared background service keeps a session
    // running (and resumes it when restarted) after the panel is restarted, so it would keep drawing on the canvas.
    if (!args.includes('--standalone')) args.push('--standalone')
    if (l.model) args.push('--model', l.model)
    // ?structured: OpenCode calls tools from scripts, which need ids back (see httpServer). It only reads CLAUDE.md when
    // the project has no AGENTS.md (even an empty one), so the canvas rules are handed to it explicitly.
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      instructions: ['CLAUDE.md'],
      mcp: { canvas: { type: 'remote', url: `${mcpUrl}?structured`, enabled: true } },
    })
  } else {
    if (!args.includes('--mcp-config')) args.push('--mcp-config', JSON.stringify({ mcpServers: { canvas: { type: 'http', url: mcpUrl } } }))
    set('ANTHROPIC_BASE_URL', l.baseUrl)
    set('ANTHROPIC_API_KEY', l.apiKey)
    set('ANTHROPIC_MODEL', l.model)
  }
  for (const line of l.env.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return { file, args, env }
}
