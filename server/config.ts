import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { FORMAT, prepareProject, type Prepared } from './migrate.ts'
import type { Project } from './project.ts'

// canvas [projectDir] [--all] [--port N] [--prod]
// One server (one port) for every project, but a run only shows the project it was started for (projectDir, or the current
// folder) and the ones added to it afterwards; --all shows everything in the registry.
const args = process.argv.slice(2)
const valueFlags = new Set(['--port'])
const positional: string[] = []
const flags = new Map<string, string>()
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (!a.startsWith('--')) positional.push(a)
  else if (valueFlags.has(a)) flags.set(a, args[++i] ?? '')
  else flags.set(a, '')
}

export const PORT = Number(flags.get('--port') ?? process.env.CANVAS_PORT ?? 8787)
export const PROD = flags.has('--prod')
export const ALL = flags.has('--all')
const LOCAL_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`]
/** Only requests addressed to this local server (blocks DNS rebinding) and not from another web origin (blocks CSRF). */
export function isLocalRequest(req: { headers: { host?: string; origin?: string } }, originRequired = false) {
  const { host = '', origin } = req.headers
  return LOCAL_HOSTS.includes(host) && (origin ? LOCAL_HOSTS.some((h) => origin === `http://${h}`) : !originRequired)
}

// ---------------------------------------------------------------- project list
export type Entry = { id: string; name: string; path: string }

const REGISTRY = process.env.CANVAS_PROJECTS ?? join(homedir(), '.config', 'canvas', 'projects.json')
const expand = (p: string) => resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p)
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'

let entries: Entry[] = []
/** The ids this run shows; null shows the whole registry (--all). */
let visible: Set<string> | null = null
const built = new Map<string, Project>()
/** What preparing each project's `.canvas/` (migrations, format check) did, by `.canvas/` path; done once per server run. */
const prepared = new Map<string, Prepared>()

function prepare(dir: string): Prepared {
  let r = prepared.get(dir)
  if (!r) {
    try {
      r = prepareProject(dir)
    } catch (e: any) {
      // A failed migration leaves the files as they were (they are replaced atomically, one at a time): do not write on top of them.
      r = { locked: `Could not upgrade the project's data (${e?.message ?? e}). Nothing was lost: copies of the original files are in .canvas/.backup-*/.`, migrated: [], backups: [] }
    }
    if (r.migrated.length) console.log(`Upgraded ${dir} to data format v${FORMAT} (${r.migrated.length} files; copies in ${r.backups.join(', ')})`)
    if (r.locked) console.error(`${dir}: ${r.locked}`)
    prepared.set(dir, r)
  }
  return r
}

function save() {
  mkdirSync(dirname(REGISTRY), { recursive: true })
  const tmp = `${REGISTRY}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n')
  renameSync(tmp, REGISTRY)
}

export function addProject(path: string, name?: string): Entry {
  const dir = expand(path.trim())
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`)
  const known = entries.find((e) => e.path === dir)
  if (known) return visible?.add(known.id), known
  const base = slug(name || basename(dir))
  let id = base
  for (let n = 2; entries.some((e) => e.id === id); n++) id = `${base}-${n}`
  const entry = { id, name: name?.trim() || basename(dir), path: dir }
  entries.push(entry)
  visible?.add(id)
  save()
  return entry
}

export function removeProject(id: string) {
  entries = entries.filter((e) => e.id !== id)
  visible?.delete(id)
  for (const k of built.keys()) if (k.startsWith(`${id}/`)) built.delete(k)
  prepared.clear()
  save()
}

export const listProjects = () => entries.filter((e) => !visible || visible.has(e.id)).map((e) => ({ ...e, exists: existsSync(e.path), hasCanvas: existsSync(join(e.path, '.canvas')) }))

/** The project's original diagram, kept where it always was (.canvas/diagram.excalidraw, notes.json, history/...). */
export const MAIN = 'main'
/** Other diagrams live in .canvas/diagrams/<id>/, each with its own scene, notes, animations and history. */
export const diagramsDir = (p: Pick<Project, 'dir'>) => join(p.dir, 'diagrams')
export const DIAGRAM_ID = /^[a-z0-9][a-z0-9-]{0,59}$/

/** One diagram of a project, as a runtime description; `.canvas/` is created on first use. Null for an unknown project or diagram. */
export function getProject(id: string, diagramId = MAIN): Project | null {
  const hit = built.get(`${id}/${diagramId}`)
  if (hit) return hit
  const e = entries.find((x) => x.id === id && (!visible || visible.has(id)))
  if (!e || !existsSync(e.path)) return null
  const dir = join(e.path, '.canvas')
  mkdirSync(dir, { recursive: true })
  const locked = prepare(dir).locked
  const base = { id: e.id, name: e.name, root: e.path, dir, ...(locked ? { locked } : {}), contextFile: join(dir, 'context.json'), rulesFile: join(dir, 'rules.json'), diagramId }
  let p: Project
  if (diagramId === MAIN) {
    let diagram = 'diagram.excalidraw'
    try {
      const c = JSON.parse(readFileSync(join(dir, 'canvas.config.json'), 'utf8'))
      if (typeof c.diagram === 'string') diagram = c.diagram
    } catch {
      /* no config or invalid: defaults */
    }
    p = { ...base, diagram: join(dir, diagram), notesFile: join(dir, 'notes.json'), animationFile: join(dir, 'animation.json'), historyDir: join(dir, 'history') }
  } else {
    const d = join(diagramsDir(base), diagramId)
    if (!DIAGRAM_ID.test(diagramId) || !existsSync(d)) return null
    p = { ...base, contextFile: join(d, 'context.json'), diagram: join(d, 'diagram.excalidraw'), notesFile: join(d, 'notes.json'), animationFile: join(d, 'animation.json'), historyDir: join(d, 'history') }
  }
  built.set(`${id}/${diagramId}`, p)
  return p
}

/** Drop a deleted diagram's cached description. */
export const forgetDiagram = (id: string, diagramId: string) => built.delete(`${id}/${diagramId}`)

/** Reads the registry (~/.config/canvas/projects.json). */
export function loadRegistry() {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, 'utf8'))
    entries = (Array.isArray(raw) ? raw : []).filter((e) => typeof e?.id === 'string' && typeof e?.path === 'string').map((e) => ({ id: e.id, name: e.name ?? basename(e.path), path: e.path }))
  } catch {
    entries = []
  }
}

/** The project this run is for: the folder given on the command line, else the current one if it is set up (`.canvas/` exists).
 *  Null with --all and no folder. Exits when the current folder is not a canvas project. */
export function startPath(): string | null {
  if (positional[0]) return expand(positional[0])
  if (ALL) return null
  if (!existsSync(join(process.cwd(), '.canvas'))) {
    console.error(`No .canvas/ in ${process.cwd()}. Run \`canvas init\` here first, give a folder (canvas <dir>), or use canvas --all to see every project.`)
    process.exit(1)
  }
  return process.cwd()
}

/** Reads the registry and picks what to show: the project of this run, or everything with --all. A project is added only that way or from the list page. */
export function loadProjects() {
  loadRegistry()
  const path = startPath()
  visible = ALL ? null : new Set()
  if (path) addProject(path)
}

/** Registry projects this run does not show. */
export const hiddenProjects = () => (visible ? entries.length - visible.size : 0)
