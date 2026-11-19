import { useState } from 'react'
import { api, type Entry } from './api.ts'
import { useDismiss } from './useDismiss.ts'

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
}

const SOURCE = { claude: '✦', you: '✎', latest: '●' } as const
const textOf = (e: Entry) => (e.source === 'you' ? 'Manual edit' : e.label)
const who = (e: Entry) => (e.source === 'you' ? 'you' : e.source === 'latest' ? 'the version you left' : 'Claude prompt')
const titleOf = (e: Entry) =>
  e.current ? 'The canvas is at this version'
  : e.source === 'latest' ? 'Go back to the canvas as it was before this go-back'
  : `Go back to the canvas as it was before this (${who(e)})`

/** Versions of the canvas, one per Claude prompt (✦) or stretch of manual edits (✎). Going back keeps the list, so the newest version stays reachable. */
export function History({ entries, diffId, onDiff, onPreview }: { entries: Entry[]; diffId: string | null; onDiff: (id: string | null) => void; onPreview: (id: string | null) => void }) {
  const [open, setOpen] = useState(false)
  // Click outside (or Escape) closes the list.
  useDismiss(open, '.history', () => {
    setOpen(false)
    onPreview(null)
  })
  const restore = (id: string) => {
    onPreview(null)
    void api.undo(id)
    setOpen(false)
  }
  return (
    <div className="history" onMouseLeave={() => onPreview(null)}>
      <button disabled={!entries.length} onClick={() => setOpen((o) => !o)} title="Versions of the canvas: Claude prompts and your manual edits">History ▾</button>
      {open && (
        <ul>
          {entries.map((e) => (
            <li key={e.id} className={e.current ? 'now' : ''} onMouseEnter={() => onPreview(e.id)}>
              <span className="src" title={who(e)}>{SOURCE[e.source ?? 'claude']}</span>
              <button className="pick" onClick={() => restore(e.id)} title={titleOf(e)}>
                {textOf(e)}
              </button>
              {e.current ? (
                <span className="here">now</span>
              ) : (
                <button className={`diff-btn${diffId === e.id ? ' on' : ''}`} title="Show what changed on the canvas since this version" onClick={() => { onDiff(diffId === e.id ? null : e.id); setOpen(false) }}>{diffId === e.id ? 'Hide diff' : 'Diff'}</button>
              )}
              <span className="ago">{ago(e.date)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
