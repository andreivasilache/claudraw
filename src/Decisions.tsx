import { useState } from 'react'
import { api, statusOf, type Note, type NoteStatus } from './api.ts'
import { Dropdown } from './Dropdown.tsx'
import { STATUS_OPTIONS } from './noteOptions.ts'

const FILTERS = ['all', 'open', 'decided', 'reversed'] as const
type Filter = (typeof FILTERS)[number]

type Row = { node: string; name: string; note: Note; status: NoteStatus }

/** Every decision and question saved as a note, filterable by status; exports to DECISIONS.md. */
export function Decisions({ notes, nameOf, onFocus }: { notes: Record<string, Note[]>; nameOf: (id: string) => string | null; onFocus: (id: string) => void }) {
  const [filter, setFilter] = useState<Filter>('open')
  const [saved, setSaved] = useState('')

  const rows: Row[] = Object.entries(notes).flatMap(([node, list]) => {
    const name = nameOf(node)
    return name === null ? [] : list.flatMap((note) => {
      const status = statusOf(note)
      return status ? [{ node, name, note, status }] : []
    })
  })
  rows.sort((a, b) => b.note.date.localeCompare(a.note.date))
  const count = (f: Filter) => (f === 'all' ? rows.length : rows.filter((r) => r.status === f).length)
  const shown = rows.filter((r) => filter === 'all' || r.status === filter)

  const exportMd = async () => {
    const { file } = await api.exportDecisions()
    setSaved(file)
  }

  // One group per box, ordered by its most recent note, so a box's name shows once.
  const groups: { node: string; name: string; rows: Row[] }[] = []
  for (const r of shown) {
    const g = groups.find((x) => x.node === r.node)
    if (g) g.rows.push(r)
    else groups.push({ node: r.node, name: r.name, rows: [r] })
  }

  return (
    <div className="decisions">
      <div className="dec-bar">
        <div className="dec-filter" role="tablist">
          {FILTERS.map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`${f}${filter === f ? ' on' : ''}`} onClick={() => setFilter(f)}>
              {f} <span className="n">{count(f)}</span>
            </button>
          ))}
        </div>
        <button className="dec-export" onClick={() => void exportMd()} title="Write DECISIONS.md in the project root">Export</button>
      </div>
      {saved && <p className="hint dec-saved">Wrote {saved}</p>}
      <div className="dec-list">
        {groups.map((g) => (
          <section key={g.node} className="dec-group">
            <button className="dec-box" onClick={() => onFocus(g.node)} title="Show this box on the canvas">
              <span>{g.name}</span>
              <span className="go" aria-hidden>↗</span>
            </button>
            {g.rows.map((r) => (
              <article key={r.note.id} className={`dec-card ${r.note.kind ?? ''} ${r.status}`}>
                <p>{linkify(r.note.text)}</p>
                <div className="dec-meta">
                  <span className={`kind ${r.note.kind ?? ''}`}>{r.note.kind ?? 'note'}</span>
                  <span className="date">{fmtDate(r.note.date)}</span>
                  <span className="spacer" />
                  <Dropdown value={r.status} options={STATUS_OPTIONS} title="Status" align="end" onChange={(v) => void api.updateNote(r.note.id, { status: v })} />
                </div>
              </article>
            ))}
          </section>
        ))}
        {!shown.length && <p className="dec-empty">Nothing {filter === 'all' ? 'yet' : filter}. Save decisions and questions as notes on a box.</p>}
      </div>
    </div>
  )
}

const fmtDate = (iso: string) => {
  const d = new Date(iso)
  return isNaN(+d) ? iso.slice(0, 10) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Turn bare URLs in a note into links. */
function linkify(text: string) {
  return text.split(/(https?:\/\/\S+)/g).map((part, i) =>
    i % 2 ? <a key={i} href={part} target="_blank" rel="noreferrer">{part.replace(/^https?:\/\/(www\.)?/, '')}</a> : part,
  )
}
