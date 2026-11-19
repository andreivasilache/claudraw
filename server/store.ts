import { readFile, rename, writeFile } from 'node:fs/promises'
import { emit } from './events.ts'
import { FORMAT } from './migrate.ts'
import { assertWritable, perDiagram } from './project.ts'

import { NOTE_KINDS, NOTE_STATUSES, statusOf, type NoteKind, type NoteStatus } from './note-status.ts'
export { NOTE_KINDS, NOTE_STATUSES, statusOf, type NoteKind, type NoteStatus }
export type Note = { id: string; date: string; text: string; kind?: NoteKind; status?: NoteStatus }

// One mutex per diagram for every read-modify-write on files in its .canvas/.
const lock = perDiagram(() => ({ chain: Promise.resolve() as Promise<unknown> }))
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const l = lock()
  const run = l.chain.then(fn, fn)
  l.chain = run.catch(() => {})
  return run
}

/** Missing file -> fallback. A file that exists but does not parse throws, so a later write cannot wipe it. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (e: any) {
    if (e?.code === 'ENOENT') return fallback
    throw e
  }
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`${file} is corrupt (${e}); fix or delete it`)
  }
}

/** A data file holds `{ version, [key]: data }` (see migrate.ts). A missing file or key gives `fallback`. */
export async function readData<T>(file: string, key: string, fallback: T): Promise<T> {
  const f = await readJson<Record<string, any>>(file, {})
  return (f[key] as T | undefined) ?? fallback
}
export const writeData = (file: string, key: string, data: unknown) => writeJson(file, { version: FORMAT, [key]: data })

/** A data file read from disk once, then served from memory; writers mutate `all()` and call `save()`. */
function jsonFile<T>(file: string, key: string, fallback: () => T) {
  let cache: T | undefined
  return {
    all: async () => (cache ??= await readData(file, key, fallback())),
    save: () => writeData(file, key, cache),
  }
}

export const writeJson = (file: string, data: unknown, pretty = true) => writeText(file, JSON.stringify(data, null, pretty ? 2 : 0))

/** Written to a temp file, then renamed over `file`, so a crash never leaves it half-written. */
export async function writeText(file: string, text: string) {
  assertWritable()
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text + '\n')
  await rename(tmp, file)
}

const notesFile = perDiagram((p) => jsonFile<Record<string, Note[]>>(p.notesFile, 'notes', () => ({})))

/** Saves the notes and tells the page to reload them. */
const saveNotes = async () => {
  await notesFile().save()
  emit({ type: 'notes' })
}

/** Durable per-node memory: decisions and facts that should outlive any conversation. */
export const notes = {
  all: () => notesFile().all(),
  add: (node: string, text: string, kind?: NoteKind, status?: NoteStatus) => notes.addMany([{ node, text, kind, status }]).then(([note]) => note),
  /** Several notes with one read and one write. */
  addMany: (list: { node: string; text: string; kind?: NoteKind; status?: NoteStatus }[]) =>
    withLock(async () => {
      if (!list.length) return []
      const all = await notes.all()
      let n = Math.max(0, ...Object.values(all).flat().map((x) => Number(x.id.slice(1)) || 0))
      const made = list.map(({ node, text, kind, status }) => {
        const st = status ?? statusOf({ kind })
        const note: Note = { id: `m${++n}`, date: new Date().toISOString(), text, ...(kind ? { kind } : {}), ...(st ? { status: st } : {}) }
        ;(all[node] ??= []).push(note)
        return note
      })
      await saveNotes()
      return made
    }),
  update: (id: string, patch: { text?: string; kind?: NoteKind; status?: NoteStatus }) =>
    withLock(async () => {
      const note = Object.values(await notes.all()).flat().find((x) => x.id === id)
      if (!note) return false
      if (patch.text) note.text = patch.text
      if (patch.kind) note.kind = patch.kind
      if (patch.status) note.status = patch.status
      await saveNotes()
      return true
    }),
  remove: (id: string) =>
    withLock(async () => {
      const all = await notes.all()
      let found = false
      for (const [node, list] of Object.entries(all)) {
        const rest = list.filter((x) => x.id !== id)
        if (rest.length === list.length) continue
        found = true
        if (rest.length) all[node] = rest
        else delete all[node]
      }
      if (found) await saveNotes()
      return found
    }),
  /** Moves every note of one node to another (a redrawn box takes over what was said about the old one). */
  move: (from: string, to: string) =>
    withLock(async () => {
      const all = await notes.all()
      if (!all[from]?.length) return 0
      const moved = all[from].length
      all[to] = [...(all[to] ?? []), ...all[from]]
      delete all[from]
      await saveNotes()
      return moved
    }),
  /** Notes for one node, formatted for a prompt or tool result. Empty string if none. */
  format: async (node: string) => {
    const list = (await notes.all())[node] ?? []
    return list.length ? `notes:\n${list.map((n) => `- [${n.id}, ${n.date.slice(0, 10)}${n.kind ? `, ${n.kind}` : ''}${statusOf(n) ? `, ${statusOf(n)}` : ''}] ${n.text}`).join('\n')}` : ''
  },
}

/** What is selected in the project's open canvas page (main node first). Lives in memory only. */
export const selection = perDiagram(() => ({ ids: [] as string[] }))
