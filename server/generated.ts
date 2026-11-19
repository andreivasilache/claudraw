import { dirname, join } from 'node:path'
import { cur, perDiagram } from './project.ts'
import { readData, withLock, writeData } from './store.ts'

/** What a whole-diagram call drew: the call itself (so it can be edited and drawn again in place, see `replace`) and the
 *  elements it made. Kept next to the diagram's notes, apart from the scene, so history and undo ignore it. */
export type Generated = { id: string; tool: string; args: Record<string, unknown>; ids: string[]; date: string; turn?: string }

/** A call's arguments are kept when they stay under this size (a drawing of hundreds of boxes is still well below). */
const MAX_ARGS = 200_000
const file = () => join(dirname(cur().notesFile), 'generated.json')
const state = perDiagram(() => ({ all: null as Record<string, Generated> | null }))
const load = async () => (state().all ??= await readData<Record<string, Generated>>(file(), 'items', {}))

/** The arguments without what only steers the call (the plan gate, the screenshot, the revision). */
const SKIPPED = new Set(['userChoice', 'about', 'replace', 'screenshot', 'baseRev'])
export const specOf = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).filter(([k]) => !SKIPPED.has(k)))

export const generated = {
  all: load,
  remove: (id: string) =>
    withLock(async () => {
      const all = await load()
      if (!all[id]) return false
      delete all[id]
      await writeData(file(), 'items', all)
      return true
    }),
  get: async (id: string) => (await load())[id],
  /** Saves (or, with `id`, replaces) the entry; returns its id, or null when the arguments are too big to keep. */
  record: (e: Omit<Generated, 'id' | 'date'>, id?: string) =>
    withLock(async () => {
      if (JSON.stringify(e.args).length > MAX_ARGS) return null
      const all = await load()
      const n = Math.max(0, ...Object.keys(all).map((k) => Number(k.slice(1)) || 0))
      const key = id ?? `g${n + 1}`
      all[key] = { ...e, id: key, date: new Date().toISOString() }
      await writeData(file(), 'items', all)
      return key
    }),
}
