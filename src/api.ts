import { useEffect, useRef, useState } from 'react'

export type { Note, NoteKind, NoteStatus } from '../server/store.ts'
export { NOTE_KINDS, NOTE_STATUSES, statusOf } from '../server/note-status.ts'
export type { Entry } from '../server/history.ts'
export type { Context, Style } from '../server/context.ts'
export type { Diff } from '../server/diff.ts'
export type { Animation, Step } from '../server/animation.ts'
export type { Diagram } from '../server/diagrams.ts'
import type { Diagram } from '../server/diagrams.ts'
import type { Diff } from '../server/diff.ts'
import type { Context } from '../server/context.ts'
import type { Entry } from '../server/history.ts'
import type { Animation } from '../server/animation.ts'
import type { Note, NoteKind, NoteStatus } from '../server/store.ts'

/** The page lives at /p/<project id>/ (main diagram) or /p/<project id>/d/<diagram id>/; every call goes to that diagram's own API. */
const URL_MATCH = /^(\/p\/[^/]+)(?:\/d\/([^/]+))?/.exec(location.pathname)
export const PROJECT_BASE = URL_MATCH?.[1] ?? ''
export const DIAGRAM = URL_MATCH?.[2] ? decodeURIComponent(URL_MATCH[2]) : 'main'
export const BASE = URL_MATCH?.[0] ?? ''
/** The page of a diagram of this project. */
export const diagramUrl = (id: string) => (id === 'main' ? PROJECT_BASE : `${PROJECT_BASE}/d/${encodeURIComponent(id)}`)

const post = (path: string, body: unknown) =>
  fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
const get = (path: string) => fetch(BASE + path).then((r) => r.json())

export const api = {
  scene: () => get('/api/scene'),
  saveScene: (body: unknown) => post('/api/scene', body),
  screenshot: (b: { reqId: string; png?: string; error?: string }) => post('/api/screenshot', b),
  exportResult: (b: { reqId: string; data?: string; error?: string }) => post('/api/export-result', b),
  select: (ids: string[]) => post('/api/selection', { ids }),
  addNote: (target: string, text: string, kind?: NoteKind, status?: NoteStatus) => post('/api/note-add', { target, text, kind, status }),
  updateNote: (id: string, patch: { text?: string; kind?: NoteKind; status?: NoteStatus }) => post('/api/note-update', { id, ...patch }),
  exportDecisions: (): Promise<{ file: string }> => post('/api/decisions-export', {}),
  deleteNote: (id: string) => post('/api/note-delete', { id }),
  context: (): Promise<Context> => get('/api/context'),
  saveContext: (c: Context): Promise<Context> => post('/api/context', c),
  history: (): Promise<{ entries: Entry[] }> => get('/api/history'),
  diff: (id: string): Promise<Diff> => get(`/api/diff?id=${encodeURIComponent(id)}`),
  layout: (direction: 'LR' | 'TB', id?: string): Promise<{ message?: string; error?: string }> => post('/api/layout', { id, direction }),
  saveAnimations: (animations: Animation[]) => post('/api/animation', { animations }),
  undo: (id?: string) => post('/api/undo', { id }),
  /** This page shows the diagram Claude should work on (it was opened or focused). */
  active: () => post('/api/active', {}),
  diagrams: (): Promise<{ diagrams: Diagram[] }> => get('/api/diagrams'),
  diagram: (b: { action: 'create' | 'rename' | 'delete'; id?: string; name?: string }): Promise<{ diagram?: Diagram; error?: string }> => post('/api/diagrams', b),
}

/** Notes and history, kept fresh by the server's event stream; scene and screenshot requests are passed on. */
export function useCanvasState(
  onScene: () => void,
  onScreenshot: (reqId: string, ids: string[], context: boolean) => void,
  onExport: (reqId: string, o: { format: 'png' | 'svg'; ids: string[]; scale: number; background: boolean; dark: boolean | null }) => void,
) {
  const [notes, setNotes] = useState<Record<string, Note[]>>({})
  const [history, setHistory] = useState<Entry[]>([])
  const [animations, setAnimations] = useState<Animation[]>([])
  const [diagrams, setDiagrams] = useState<Diagram[]>([])
  const cbs = useRef({ onScene, onScreenshot, onExport })
  cbs.current = { onScene, onScreenshot, onExport }

  useEffect(() => {
    // Event type -> what to refetch.
    const loaders: Record<string, () => Promise<void>> = {
      notes: () => get('/api/state').then((s) => setNotes(s.notes ?? {})),
      history: () => api.history().then((h) => setHistory(h.entries ?? [])),
      animation: () => get('/api/animation').then((a) => setAnimations(a.animations ?? [])),
      diagrams: () => api.diagrams().then((d) => setDiagrams(d.diagrams ?? [])),
    }
    const load = () => void Promise.all(Object.values(loaders).map((l) => l()))
    load()
    const es = new EventSource(`${BASE}/api/events`)
    es.onopen = load // also covers server restarts
    es.onmessage = (m) => {
      const e = JSON.parse(m.data)
      if (e.type === 'scene') cbs.current.onScene()
      // Claude moved to another diagram, or this one was deleted: follow it.
      else if (e.type === 'open' && e.from === DIAGRAM) location.assign(diagramUrl(e.id))
      else if (e.type === 'diagrams' && e.deleted === DIAGRAM) location.assign(diagramUrl('main'))
      else if (e.type === 'screenshot') cbs.current.onScreenshot(e.reqId, e.ids, !!e.context)
      else if (e.type === 'export') cbs.current.onExport(e.reqId, { format: e.format, ids: e.ids ?? [], scale: e.scale ?? 2, background: e.background !== false, dark: e.dark ?? null })
      else void loaders[e.type]?.()
    }
    return () => es.close()
  }, [])

  return { notes, history, animations, setAnimations, diagrams, reloadDiagrams: () => void api.diagrams().then((d) => setDiagrams(d.diagrams ?? [])) }
}
