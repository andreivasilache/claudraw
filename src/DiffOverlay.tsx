import { useEffect, useRef, useState } from 'react'
import { type Diff } from './api.ts'
import { type View } from './NotesOverlay.tsx'

type Kind = 'added' | 'removed' | 'modified'
type B = Diff['added'][number]
type Item = { kind: Kind; b: B; before?: B; changes?: string[] }

const inside = (b: B, x: number, y: number) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height

const ghostStyle = (p: B) => ({
  borderColor: p.stroke || 'var(--fg)',
  backgroundColor: 'var(--bg)', // opaque, so the current box underneath never shows through
  ...(p.fill && p.fill !== 'transparent' ? { backgroundImage: `linear-gradient(${p.fill}, ${p.fill})` } : {}),
})

/** Outlines over the canvas: added boxes in green, removed ones (drawn where they used to be) in red, changed ones in amber.
 *  Hovering a box shows how it would look after a revert, in place. The layer never takes pointer events; hover is tracked on the window.
 *  With `preview` (hovering a history row) there is no banner and every change is shown reverted at once. */
export function DiffOverlay({ diff, view, onClose, preview }: { diff: Diff; view: View; onClose?: () => void; preview?: boolean }) {
  const [hidden, setHidden] = useState<Set<Kind>>(new Set())
  const [hover, setHover] = useState<Item | null>(null)
  const layer = useRef<HTMLDivElement>(null)
  const items: Item[] = [
    ...diff.added.map((b): Item => ({ kind: 'added', b })),
    ...diff.removed.map((b): Item => ({ kind: 'removed', b })),
    ...diff.modified.map((b): Item => ({ kind: 'modified', b, before: b.before, changes: b.changes })),
  ].filter((i) => !hidden.has(i.kind))

  const itemsRef = useRef(items)
  itemsRef.current = items
  const viewRef = useRef(view)
  viewRef.current = view
  useEffect(() => {
    const move = (ev: MouseEvent) => {
      const r = layer.current?.getBoundingClientRect()
      const v = viewRef.current
      if (!r) return
      const x = (ev.clientX - r.left) / v.zoom - v.scrollX
      const y = (ev.clientY - r.top) / v.zoom - v.scrollY
      // Smallest box under the cursor wins, so a changed child is reachable inside a changed container.
      const hit = itemsRef.current.filter((i) => inside(i.b, x, y)).sort((a, b) => a.b.width * a.b.height - b.b.width * b.b.height)[0]
      setHover((h) => (h?.b.id === hit?.b.id && h?.kind === hit?.kind ? h : hit ?? null))
    }
    window.addEventListener('mousemove', move)
    return () => window.removeEventListener('mousemove', move)
  }, [])

  const at = (b: { x: number; y: number; width: number; height: number }) => ({
    left: (b.x + view.scrollX) * view.zoom,
    top: (b.y + view.scrollY) * view.zoom,
    width: b.width * view.zoom,
    height: b.height * view.zoom,
  })
  const shown = hover && items.some((i) => i.b.id === hover.b.id && i.kind === hover.kind) ? hover : null
  // The previous version: the old box for a modified one, the box itself for a removed one.
  const prev = shown?.kind === 'modified' ? (shown.before ?? undefined) : shown?.kind === 'removed' ? shown.b : undefined
  const counts: [Kind, string, number][] = [
    ['added', '+', diff.added.length],
    ['removed', '−', diff.removed.length],
    ['modified', '~', diff.modified.length],
  ]
  const toggle = (k: Kind) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n })

  return (
    <>
      <div className="diff-layer" ref={layer}>
        {items.map(({ kind, b }) => (
          <div key={`${kind}${b.id}`} className={`diff-box ${kind}${shown?.b.id === b.id && shown.kind === kind ? ' hot' : ''}`} style={at(b)} />
        ))}
        {preview
          ? items.map(({ kind, b, before }) =>
              kind === 'added' ? (
                <div key={`x${b.id}`} className="diff-gone" style={at(b)} />
              ) : kind === 'modified' && !before ? null : (
                <div key={`g${kind}${b.id}`} className="diff-ghost" style={{ ...at(before ?? b), ...ghostStyle(before ?? b) }}>
                  <span>{(before ?? b).text}</span>
                </div>
              ),
            )
          : prev && (
              <div className="diff-ghost" style={{ ...at(prev), ...ghostStyle(prev) }}>
                <span>{prev.text}</span>
              </div>
            )}
        {shown?.kind === 'added' && <div className="diff-gone" style={at(shown.b)} />}
        {shown && (
          <div className={`diff-tip ${shown.kind}`} style={{ left: at(shown.b).left, top: at(shown.b).top + at(shown.b).height + 6 }}>
            {shown.kind === 'added' && <b>Added{shown.b.text ? `: ${shown.b.text}` : ''} — a revert removes it</b>}
            {shown.kind === 'removed' && <b>Removed{shown.b.text ? `: ${shown.b.text}` : ''} — a revert brings it back</b>}
            {shown.kind === 'modified' && (
              <>
                <b>Changed ({shown.changes?.join(', ')}) — the dashed box is the revert</b>
                {shown.changes?.includes('text') && <div>“{shown.b.text}” → “{shown.before?.text}”</div>}
              </>
            )}
          </div>
        )}
      </div>
      {!preview && (
      <div className="diff-banner">
        <b>Diff</b> since before “{diff.label}”
        {counts.map(([k, sign, n]) => (
          <button key={k} className={`link ${k}${hidden.has(k) ? ' off' : ''}`} title={`${hidden.has(k) ? 'Show' : 'Hide'} ${k}`} onClick={() => toggle(k)}>{sign}{n}</button>
        ))}
        <button className="link" onClick={onClose}>close</button>
      </div>
      )}
    </>
  )
}
