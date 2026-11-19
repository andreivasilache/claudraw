import { useState } from 'react'
import { api, DIAGRAM, diagramUrl, type Diagram } from './api.ts'
import { useDismiss } from './useDismiss.ts'

/** The project's diagrams: switch between them, create, rename and delete. Each is its own canvas with its own notes and history. */
export function Diagrams({ diagrams, onChanged, flash }: { diagrams: Diagram[]; onChanged: () => void; flash: (t: string) => void }) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  useDismiss(open, '.diagrams', () => {
    setOpen(false)
    setEditing(null)
  })
  const here = diagrams.find((d) => d.id === DIAGRAM)

  const create = async () => {
    const name = newName.trim()
    if (!name) return
    const r = await api.diagram({ action: 'create', name })
    if (r.diagram) location.assign(diagramUrl(r.diagram.id))
    else flash(r.error ?? 'Could not create the diagram.')
  }
  const rename = async () => {
    if (!editing) return
    const r = await api.diagram({ action: 'rename', id: editing.id, name: editing.name })
    if (r.error) return flash(r.error)
    setEditing(null)
    onChanged()
  }
  const remove = async (d: Diagram) => {
    if (!confirm(`Delete the diagram "${d.name}" with its notes, presentations and history? This cannot be undone.`)) return
    const r = await api.diagram({ action: 'delete', id: d.id })
    if (r.error) return flash(r.error)
    onChanged()
  }

  return (
    <div className="diagrams">
      <button onClick={() => setOpen((o) => !o)} title="Diagrams of this project">
        {here?.name ?? DIAGRAM} ▾
      </button>
      {open && (
        <div className="diagrams-pop">
          <ul>
            {diagrams.map((d) =>
              editing?.id === d.id ? (
                <li key={d.id}>
                  <input
                    autoFocus
                    value={editing.name}
                    maxLength={60}
                    onChange={(e) => setEditing({ id: d.id, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void rename()
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setEditing(null)
                      }
                    }}
                  />
                  <button className="small" onClick={() => void rename()}>Save</button>
                </li>
              ) : (
                <li key={d.id} className={d.id === DIAGRAM ? 'now' : ''}>
                  <a className="pick" href={diagramUrl(d.id)} title={d.id === DIAGRAM ? 'Open now' : `Open "${d.name}"`}>
                    {d.name}
                  </a>
                  <button className="small" title="Rename" onClick={() => setEditing({ id: d.id, name: d.name })}>✎</button>
                  {d.id !== 'main' && (
                    <button className="small" title="Delete" onClick={() => void remove(d)}>✕</button>
                  )}
                </li>
              ),
            )}
          </ul>
          <form
            className="new"
            onSubmit={(e) => {
              e.preventDefault()
              void create()
            }}
          >
            <input value={newName} maxLength={60} placeholder="New diagram name" onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" disabled={!newName.trim()}>+ New</button>
          </form>
        </div>
      )}
    </div>
  )
}
