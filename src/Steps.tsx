import { useEffect, useState } from 'react'
import { api, type Animation, type Step } from './api.ts'

type Drag = { from: number | null; over: number | null }

function StepRow({ n, step, names, drag, setDrag, onMove, onChange }: { n: number; step: Step; names: string; drag: Drag; setDrag: (d: Drag) => void; onMove: (from: number, to: number) => void; onChange: (op: 'caption' | 'delete', caption?: string) => void }) {
  const [caption, setCaption] = useState(step.caption ?? '')
  useEffect(() => setCaption(step.caption ?? ''), [step.caption])
  return (
    <li
      className={drag.from === n ? 'dragging' : drag.from !== null && drag.over === n ? (drag.from < n ? 'drop-after' : 'drop-before') : ''}
      onDragOver={(e) => {
        if (drag.from === null) return
        e.preventDefault()
        if (drag.over !== n) setDrag({ ...drag, over: n })
      }}
      onDrop={(e) => {
        e.preventDefault()
        if (drag.from !== null && drag.from !== n) onMove(drag.from, n)
        setDrag({ from: null, over: null })
      }}
    >
      <span
        className="grip"
        draggable
        title="Drag to reorder"
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', String(n))
          e.dataTransfer.setDragImage(e.currentTarget.parentElement!, 0, 0)
          setDrag({ from: n, over: n })
        }}
        onDragEnd={() => setDrag({ from: null, over: null })}
      >⠿</span>
      <b>{n + 1}</b>
      <div>
        <span title={names}>{names || '(boxes deleted)'}</span>
        <input value={caption} placeholder="Caption (optional)" onChange={(e) => setCaption(e.target.value)} onBlur={() => caption.trim() !== (step.caption ?? '') && onChange('caption', caption)} />
      </div>
      <button className="link" onClick={() => onChange('delete')} title="Remove step">×</button>
    </li>
  )
}

/** Presentations of this diagram: pick one, edit its steps ("+ Step" takes the current selection), play it. */
export function Steps({ animations, setAnimations, selected, nameOf, onPresent, onPreview }: { animations: Animation[]; setAnimations: (a: Animation[]) => void; selected: string[]; nameOf: (id: string) => string | null; onPresent: (steps: Step[]) => void; onPreview: (steps: Step[] | null) => void }) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(0)
  const [name, setName] = useState('')
  const i = Math.min(at, Math.max(0, animations.length - 1))
  const anim = animations[i] as Animation | undefined
  useEffect(() => setName(anim?.name ?? ''), [anim?.name])
  // While the list is open, the canvas numbers the boxes of the chosen animation.
  useEffect(() => onPreview(open && anim ? anim.steps : null), [open, anim, onPreview])
  useEffect(() => () => onPreview(null), [onPreview])

  const save = (next: Animation[]) => {
    setAnimations(next)
    void api.saveAnimations(next)
  }
  const patch = (p: Partial<Animation>) => save(animations.map((a, j) => (j === i ? { ...a, ...p } : a)))
  const create = () => {
    let n = animations.length + 1
    while (animations.some((a) => a.name === `Animation ${n}`)) n++
    save([...animations, { name: `Animation ${n}`, steps: [] }])
    setAt(animations.length)
  }
  const rename = () => {
    const t = name.trim()
    if (t && t !== anim?.name && !animations.some((a) => a.name === t)) patch({ name: t })
    else setName(anim?.name ?? '')
  }
  const [drag, setDrag] = useState<Drag>({ from: null, over: null })
  const move = (from: number, to: number) => {
    if (!anim) return
    const steps = [...anim.steps]
    steps.splice(to, 0, steps.splice(from, 1)[0])
    patch({ steps })
  }
  const edit = (k: number, op: 'caption' | 'delete', caption?: string) => {
    if (!anim) return
    const steps = [...anim.steps]
    if (op === 'caption') steps[k] = { ...steps[k], caption: caption?.trim() || undefined }
    else steps.splice(k, 1)
    patch({ steps })
  }
  const canPlay = !!anim?.steps.length
  return (
    <div className="history steps">
      <button disabled={!canPlay} onClick={() => anim && onPresent(anim.steps)} title={canPlay ? `Present "${anim!.name}" (→ next, Esc exit)` : 'Add steps first'}>▶ Present{animations.length > 1 && anim ? `: ${anim.name}` : ''}</button>
      <button onClick={() => setOpen((o) => !o)} title="Presentations and their steps">Animations{animations.length > 0 && <span className="tab-count">{animations.length}</span>} ▾</button>
      {open && (
        <div className="steps-pop">
          <div className="anim-head">
            {anim && (
              <select value={i} onChange={(e) => setAt(Number(e.target.value))} title="Choose the presentation">
                {animations.map((a, j) => <option key={a.name} value={j}>{a.name} ({a.steps.length})</option>)}
              </select>
            )}
            <button onClick={create}>+ New</button>
            {anim && <button className="link" onClick={() => { save(animations.filter((_, j) => j !== i)); setAt(0) }} title="Delete this animation">delete</button>}
          </div>
          {anim && <input className="anim-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} title="Rename" />}
          {anim && (
            <ol>
              {anim.steps.map((s, k) => (
                <StepRow key={`${anim.name}:${k}:${s.ids.join()}`} n={k} step={s} drag={drag} setDrag={setDrag} onMove={move} names={s.ids.map((id) => nameOf(id)).filter(Boolean).join(', ')} onChange={(op, c) => edit(k, op, c)} />
              ))}
            </ol>
          )}
          {!anim && <p className="hint">No animations yet. Create one, select boxes on the canvas and add them as steps. Each step appears on one click; boxes not in any step are always visible.</p>}
          {anim && !anim.steps.length && <p className="hint">Select boxes on the canvas, then add them as a step.</p>}
          {anim && <button disabled={!selected.length} onClick={() => patch({ steps: [...anim.steps, { ids: selected }] })}>+ Step from selection{selected.length ? ` (${selected.length})` : ''}</button>}
        </div>
      )}
    </div>
  )
}

type Box = { x: number; y: number }

/** Step numbers on the boxes of the animation being edited (a box in several steps shows each number). */
export function StepBadges({ steps, boxes, view }: { steps: Step[]; boxes: Map<string, Box>; view: { scrollX: number; scrollY: number; zoom: number } }) {
  const labels = new Map<string, number[]>()
  steps.forEach((s, i) => s.ids.forEach((id) => labels.set(id, [...(labels.get(id) ?? []), i + 1])))
  return (
    <div className="step-layer">
      {[...labels].flatMap(([id, ns]) => {
        const b = boxes.get(id)
        if (!b) return []
        return [<span key={id} className="step-badge" style={{ left: (b.x + view.scrollX) * view.zoom, top: (b.y + view.scrollY) * view.zoom }}>{ns.join(', ')}</span>]
      })}
    </div>
  )
}
