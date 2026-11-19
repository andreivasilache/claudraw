import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { assertWritable, cur, perDiagram } from './project.ts'
import { readData, writeData, writeJson } from './store.ts'

// Versions of the scene, newest last. Each entry is the scene as it was *before* one prompt of Claude's or one stretch of manual
// edits, so going back to it undoes that whole step. Going back never removes entries: the version it leaves is added as the
// newest entry ("Before going back to: ..."), so any state, including the one before a wrong go-back, can be restored again.
// Callers hold the store lock.

export type Source = 'claude' | 'you' | 'latest'
export type Entry = { id: string; date: string; label: string; source?: Source; turn?: string; hash?: string; current?: boolean }

const KEEP = 100

const INDEX = () => join(cur().historyDir, 'index.json')
const file = (id: string) => join(cur().historyDir, `${id}.json`)
const state = perDiagram(() => ({ entries: null as Entry[] | null, ready: false }))

function ensure() {
  const st = state()
  if (st.ready) return
  assertWritable()
  const { dir, historyDir } = cur()
  mkdirSync(historyDir, { recursive: true })
  if (!existsSync(join(dir, '.gitignore'))) writeFileSync(join(dir, '.gitignore'), 'history/\n')
  st.ready = true
}

/** A short sortable id, shared by history entries and turns. */
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
/** Oldest first, as stored. Read from disk once, then kept in memory (push updates both). */
export async function entries() {
  const st = state()
  return (st.entries ??= await readData<Entry[]>(INDEX(), 'entries', []))
}

const KEYS = ['type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'text', 'containerId', 'points', 'fontSize']
const hashes = new WeakMap<object, string>()
/** Identifies what a scene looks like (not its edit counters), so equal-looking scenes compare equal.
 *  Memoised per scene object: a saved scene is never changed in place (mutate works on a copy). */
export function contentHash(scene: { elements: Record<string, any>[] }) {
  let h = hashes.get(scene)
  if (!h) hashes.set(scene, (h = hashOf(scene)))
  return h
}

function hashOf(scene: { elements: Record<string, any>[] }) {
  const alive = scene.elements.filter((e) => !e.isDeleted).sort((a, b) => (a.id < b.id ? -1 : 1))
  const rows = alive.map((e) => [e.id, ...KEYS.map((k) => (typeof e[k] === 'number' ? Math.round(e[k]) : e[k]))])
  return createHash('sha1').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}

/** Save `scene` as a version. With `mergeIf`, a newest entry it accepts already covers this step, so nothing is added (returns false). */
export async function push(scene: any, label: string, o: { source?: Source; turn?: string; mergeIf?: (last: Entry) => boolean } = {}) {
  ensure()
  const kept = await entries()
  const last = kept[kept.length - 1]
  if (last && o.mergeIf?.(last)) return false
  const id = newId()
  await writeJson(file(id), scene, false)
  kept.push({ id, date: new Date().toISOString(), label: label.slice(0, 80), source: o.source ?? 'claude', ...(o.turn ? { turn: o.turn } : {}), hash: contentHash(scene) })
  const gone = kept.splice(0, Math.max(0, kept.length - KEEP))
  await writeData(INDEX(), 'entries', kept)
  await Promise.all(gone.map((e) => rm(file(e.id), { force: true })))
  return true
}

/** Newest first; the newest entry that looks like `currentHash` is flagged as where the canvas is now. */
export async function list(currentHash: string) {
  const out = [...(await entries())].reverse()
  const here = out.find((e) => e.hash === currentHash)
  return out.map((e) => (e === here ? { ...e, current: true } : e))
}

/** The scene saved in an entry. */
export async function peek(id: string): Promise<{ scene: any; entry: Entry } | null> {
  const entry = (await entries()).find((e) => e.id === id)
  return entry ? { scene: JSON.parse(await readFile(file(entry.id), 'utf8')), entry } : null
}
