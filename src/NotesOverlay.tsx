import { useEffect, useRef, useState } from 'react'
import { useDismiss } from './useDismiss.ts'
import { api, statusOf, type Note, type NoteKind } from './api.ts'
import { Dropdown } from './Dropdown.tsx'
import { KIND_OPTIONS, STATUS_OPTIONS } from './noteOptions.ts'

export type View = { scrollX: number; scrollY: number; zoom: number }
type Box = { id: string; x: number; y: number; width: number; height: number }

/** Grow a textarea to fit its text, so notes never scroll inside the popover. */
function useAutoHeight(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return ref
}

function NoteRow({ note }: { note: Note }) {
  const [text, setText] = useState(note.text)
  const status = statusOf(note)
  const ref = useAutoHeight(text)
  useEffect(() => setText(note.text), [note.text])
  const save = () => {
    const t = text.trim()
    if (t && t !== note.text) void api.updateNote(note.id, { text: t })
    else setText(note.text)
  }
  return (
    <div className={`note ${note.kind ?? ''} ${status ?? ''}`}>
      <div className="note-head">
        <span className={`kind ${note.kind ?? ''}`}>{note.kind ?? 'note'}</span>
        {status && (
          <Dropdown value={status} options={STATUS_OPTIONS} title="Status" onChange={(v) => void api.updateNote(note.id, { status: v })} />
        )}
        <button className="del" title="Delete note" aria-label="Delete note" onClick={() => void api.deleteNote(note.id)}>×</button>
      </div>
      <textarea ref={ref} value={text} rows={1} onChange={(e) => setText(e.target.value)} onBlur={save} />
    </div>
  )
}

/** A badge on every box that has notes (and on the selected box, to add one); click to read, edit or add notes. */
export function NotesOverlay({ notes, boxes, selected, view, onlyQuestions }: { notes: Record<string, Note[]>; boxes: Map<string, Box>; selected: string[]; view: View; onlyQuestions: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [kind, setKind] = useState<NoteKind>('decision')
  const host = useRef<HTMLDivElement>(null)
  const draftRef = useAutoHeight(draft)

  useDismiss(!!openId, '.note-pop, .note-badge, .dd-menu', () => setOpenId(null))

  const ids = [...new Set([...Object.keys(notes), ...selected.slice(0, 1)])].filter((id) => boxes.has(id))
  const shown = ids.filter((id) => !onlyQuestions || notes[id]?.some((n) => statusOf(n) === 'open'))
  const at = (id: string) => {
    const b = boxes.get(id)!
    return { x: (b.x + b.width + view.scrollX) * view.zoom, y: (b.y + view.scrollY) * view.zoom }
  }

  const add = () => {
    const t = draft.trim()
    if (!t || !openId) return
    void api.addNote(openId, t, kind)
    setDraft('')
  }

  const pop = openId && boxes.has(openId) ? at(openId) : null
  const width = host.current?.clientWidth ?? 1000

  return (
    <div className="notes-layer" ref={host}>
      {shown.map((id) => {
        const list = notes[id] ?? []
        const { x, y } = at(id)
        const open = list.filter((n) => statusOf(n) === 'open').length
        return (
          <button
            key={id}
            className={`note-badge${list.length ? '' : ' empty'}${open ? ' question' : ''}`}
            style={{ left: x, top: y }}
            title={list.length ? `${list.length} note${list.length > 1 ? 's' : ''}${open ? `, ${open} open` : ''}` : 'Add a note'}
            onClick={() => setOpenId(openId === id ? null : id)}
          >
            {list.length ? (open ? `?${open > 1 ? open : ''}` : list.length) : '+'}
          </button>
        )
      })}
      {pop && openId && (
        <div className="note-pop" style={{ left: Math.max(8, Math.min(pop.x - 12, width - 340)), top: pop.y + 14 }}>
          {(notes[openId] ?? []).length > 0 && (
            <div className="note-list">{(notes[openId] ?? []).map((n) => <NoteRow key={n.id} note={n} />)}</div>
          )}
          <div className="add">
            <textarea
              ref={draftRef}
              autoFocus
              rows={2}
              value={draft}
              placeholder="Add a note (Enter to save)"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  add()
                }
              }}
            />
            <div className="add-foot">
              <Dropdown value={kind} options={KIND_OPTIONS} title="Kind of note" variant="field" onChange={setKind} />
              <span className="hint">↵ save · ⇧↵ new line</span>
              <button className="save" disabled={!draft.trim()} onClick={add}>Add</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
