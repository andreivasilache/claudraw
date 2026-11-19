import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// The format of a project's data in `.canvas/`. Every data file carries its version; a file without one is version 0
// (what the tool wrote before versions existed). Bump FORMAT and append a migration for every change to a file's shape;
// a change that old versions cannot read is a major release of the package (see CHANGELOG.md).
//
//   diagram.excalidraw   { ...excalidraw scene, canvasVersion }      (Excalidraw's own `version: 2` is its format, not ours)
//   notes.json           { version, notes: { <node>: Note[] } }
//   diagrams.json        { version, names: { <id>: name } }
//   generated.json       { version, items: { <id>: Generated } }
//   animation.json       { version, animations: Animation[] }
//   context.json         { version, ...the diagram's style and subject }
//   rules.json           { version, rules }
//   history/index.json   { version, entries: Entry[] }               (the saved scenes next to it are snapshots, never rewritten)
export const FORMAT = 1

/** An empty drawing in the current format. */
export const emptyScene = () => ({
  type: 'excalidraw' as const,
  version: 2 as const,
  canvasVersion: FORMAT,
  source: 'canvas',
  elements: [] as any[],
  appState: { viewBackgroundColor: '#ffffff' } as Record<string, any>,
  files: {} as Record<string, any>,
})

export type Kind = 'scene' | 'notes' | 'names' | 'generated' | 'animation' | 'context' | 'rules' | 'history'
type Data = any

/** Wrapped files keep their payload under one key; a flat one (context) keeps it beside `version`. */
const PAYLOAD: Record<Exclude<Kind, 'scene' | 'context' | 'rules'>, string> = { notes: 'notes', names: 'names', generated: 'items', animation: 'animations', history: 'entries' }

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

/** The version a parsed file declares: 0 when it has none (written before versions existed). */
export function versionOf(kind: Kind, data: Data): number {
  const v = isObj(data) ? (kind === 'scene' ? data.canvasVersion : data.version) : undefined
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
}

export type Migration = { from: number; to: number; name: string; up: (kind: Kind, data: Data) => Data }

/** In order, each taking a file from `from` to `to`. Pure: the runner reads, backs up and writes. */
export const MIGRATIONS: Migration[] = [
  {
    from: 0,
    to: 1,
    name: 'versioned data files',
    up(kind, data) {
      if (kind === 'scene') return { ...data, canvasVersion: 1 }
      if (kind === 'context') return { version: 1, ...(isObj(data) ? data : {}) }
      if (kind === 'rules') return { version: 1, rules: isObj(data) && typeof data.rules === 'string' ? data.rules : '' }
      const key = PAYLOAD[kind]
      if (kind === 'animation') {
        // Older still: a single list of steps.
        const a = isObj(data) ? data : {}
        const animations = Array.isArray(a.animations) ? a.animations : Array.isArray(a.steps) && a.steps.length ? [{ name: 'Animation 1', steps: a.steps }] : []
        return { version: 1, animations }
      }
      if (kind === 'history') return { version: 1, entries: Array.isArray(data) ? data : [] }
      return { version: 1, [key]: isObj(data) ? data : {} }
    },
  },
]

type Found = { file: string; kind: Kind; data: Data; raw: string; version: number }

/** The folders that hold a diagram's files: `.canvas/` itself (main) and `.canvas/diagrams/<id>/`. */
function diagramDirs(dir: string) {
  const sub = join(dir, 'diagrams')
  const others = existsSync(sub) ? readdirSync(sub, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(sub, d.name)) : []
  return [dir, ...others]
}

function mainSceneName(dir: string) {
  try {
    const c = JSON.parse(readFileSync(join(dir, 'canvas.config.json'), 'utf8'))
    if (typeof c.diagram === 'string') return c.diagram
  } catch {
    /* no config or invalid: the default */
  }
  return 'diagram.excalidraw'
}

/** Every data file of the project that exists and parses, with the version it declares. A file that does not parse is
 *  left alone: the server's own readers report it, and nothing here may overwrite it. */
export function inspect(dir: string): Found[] {
  const spec: [string, Kind][] = []
  spec.push([join(dir, 'rules.json'), 'rules'], [join(dir, 'diagrams.json'), 'names'])
  for (const d of diagramDirs(dir)) {
    spec.push([join(d, d === dir ? mainSceneName(dir) : 'diagram.excalidraw'), 'scene'])
    for (const [f, k] of [['notes.json', 'notes'], ['generated.json', 'generated'], ['animation.json', 'animation'], ['context.json', 'context'], ['history/index.json', 'history']] as [string, Kind][]) spec.push([join(d, f), k])
  }
  const out: Found[] = []
  for (const [file, kind] of spec) {
    if (!existsSync(file)) continue
    try {
      const raw = readFileSync(file, 'utf8')
      if (!raw.trim()) continue
      const data = JSON.parse(raw)
      out.push({ file, kind, data, raw, version: versionOf(kind, data) })
    } catch {
      /* corrupt: not ours to touch */
    }
  }
  return out
}

export type Prepared = { locked?: string; migrated: { file: string; from: number }[]; backups: string[] }

/** `claudraw` is older than the project: refuse to write, with the message shown to the user. */
export const newerMessage = (v: number) => `This project uses data format v${v}, but the installed claudraw only knows up to v${FORMAT}. Update claudraw (see the README) and restart it.`

/** Writes `text` to `file` through a temp file in the same folder, so a crash never leaves it half-written. */
function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}

/** The project's `.canvas/` folder, brought to the current format: a copy of every file that changes goes to
 *  `.backup-<its old version>/` first (an existing backup is never overwritten, so it stays the original), then each file
 *  is rewritten atomically. Safe to run again: files already at FORMAT are skipped. A project written by a newer
 *  version is not touched; `locked` says why. Synchronous: it runs once, when the project is first used. */
export function prepareProject(dir: string): Prepared {
  const files = inspect(dir)
  const newest = Math.max(0, ...files.map((f) => f.version))
  if (newest > FORMAT) return { locked: newerMessage(newest), migrated: [], backups: [] }

  const migrated: Prepared['migrated'] = []
  const backups = new Set<string>()
  for (const f of files) {
    if (f.version >= FORMAT) continue
    const bdir = join(dir, `.backup-${f.version}`)
    const copy = join(bdir, relative(dir, f.file))
    if (!existsSync(copy)) {
      mkdirSync(dirname(copy), { recursive: true })
      copyFileSync(f.file, copy)
    }
    backups.add(bdir)
    let data = f.data
    for (let v = f.version; v < FORMAT; ) {
      const m = MIGRATIONS.find((x) => x.from === v)
      if (!m) throw new Error(`No migration from format v${v}`)
      data = m.up(f.kind, data)
      v = m.to
    }
    const indent = f.kind === 'scene' && !/^\{\s*\n\s+"/.test(f.raw) ? 0 : 2
    writeAtomic(f.file, JSON.stringify(data, null, indent) + '\n')
    migrated.push({ file: f.file, from: f.version })
  }
  for (const b of backups) ignoreBackups(dirname(b))
  return { migrated, backups: [...backups] }
}

/** Keeps the backups out of the project's git, like history/. */
function ignoreBackups(dir: string) {
  const file = join(dir, '.gitignore')
  const have = existsSync(file) ? readFileSync(file, 'utf8') : 'history/\n' // as history.ts would have created it
  if (!have.split('\n').some((l) => l.trim() === '.backup-*/')) writeFileSync(file, have + (have && !have.endsWith('\n') ? '\n' : '') + '.backup-*/\n')
}
