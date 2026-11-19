import { useState } from 'react'
import { useDismiss } from './useDismiss.ts'

export type ExportFormat = 'png' | 'svg' | 'excalidraw'
const FORMATS: { format: ExportFormat; label: string; hint: string }[] = [
  { format: 'png', label: 'PNG image', hint: 'A picture of the whole diagram, at 2x' },
  { format: 'svg', label: 'SVG image', hint: 'A scalable picture of the whole diagram' },
  { format: 'excalidraw', label: '.excalidraw file', hint: 'The scene itself: opens in excalidraw.com' },
]

/** Download the diagram as a file. Looks like the History list next to it. */
export function ExportMenu({ onExport }: { onExport: (format: ExportFormat) => Promise<void> }) {
  const [open, setOpen] = useState(false)
  useDismiss(open, '.export-menu', () => setOpen(false))
  const pick = (format: ExportFormat) => {
    setOpen(false)
    void onExport(format)
  }
  return (
    <div className="history export-menu">
      <button onClick={() => setOpen((o) => !o)} title="Download the diagram as a file">Export ▾</button>
      {open && (
        <ul>
          {FORMATS.map((f) => (
            <li key={f.format}>
              <button className="pick" onClick={() => pick(f.format)} title={f.hint}>{f.label}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
