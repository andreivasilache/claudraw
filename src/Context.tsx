import { useEffect, useRef, useState } from 'react'
import { COLORS, PALETTE } from '../server/palette.ts'
import { api, DIAGRAM, type Context as Ctx, type Style } from './api.ts'
import { Dropdown } from './Dropdown.tsx'

type Option<T extends string> = readonly [value: T, label: string]
const CHOICES: { key: keyof Omit<Style, 'legend' | 'maxWords' | 'limitWords'>; label: string; options: Option<string>[] }[] = [
  { key: 'spacing', label: 'Spacing', options: [['compact', 'Compact'], ['normal', 'Normal'], ['spacious', 'Spacious']] },
  { key: 'textSize', label: 'Text size', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] },
  { key: 'corners', label: 'Corners', options: [['rounded', 'Rounded'], ['sharp', 'Sharp']] },
  { key: 'arrows', label: 'Arrow type', options: [['sharp', 'Sharp'], ['curved', 'Curved'], ['elbow', 'Elbow']] },
  { key: 'look', label: 'Look', options: [['sketchy', 'Sketchy'], ['clean', 'Clean']] },
  { key: 'containers', label: 'Containers', options: [['fill', 'Light fill'], ['plain', 'Like boxes']] },
  { key: 'detail', label: 'Box detail', options: [['auto', 'Auto (explain topics)'], ['short', 'Titles only'], ['explain', 'Title + explanation']] },
  { key: 'font', label: 'Font', options: [['match', 'Match canvas'], ['hand', 'Hand-drawn'], ['clean', 'Clean'], ['code', 'Code']] },
]

/** The context Claude reads: the project's rules (.canvas/rules.json) and this diagram's style and subject
 *  (its own context.json, so every diagram can look and be about something different). */
export function Context({ visible }: { visible: boolean }) {
  const [ctx, setCtx] = useState<Ctx | null>(null)
  const [name, setName] = useState(DIAGRAM)
  useEffect(() => void api.diagrams().then((r) => setName(r.diagrams.find((d) => d.id === DIAGRAM)?.name ?? DIAGRAM)), [])
  const [saved, setSaved] = useState(true)
  const [stale, setStale] = useState(false)
  const timer = useRef<number>()
  const dirty = useRef(false)

  // Load on first show, and again on later shows unless there are unsaved edits (the file may have been edited elsewhere).
  useEffect(() => {
    if (!visible || dirty.current) return
    void api.context().then((c) => (c?.style ? (setStale(false), setCtx(c)) : setStale(true)))
  }, [visible])

  const change = (next: Ctx) => {
    setCtx(next)
    setSaved(false)
    dirty.current = true
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void api.saveContext(next).then(() => {
        dirty.current = false
        setSaved(true)
      })
    }, 600)
  }

  if (!ctx) return <div className="context"><p className="hint">{stale ? 'The canvas server is running an older version. Restart it (stop the server, run `canvas` again) and reload this page.' : 'Loading…'}</p></div>
  const { style } = ctx
  const setStyle = (patch: Partial<Style>) => change({ ...ctx, style: { ...style, ...patch } })
  const setLegend = (i: number, patch: Partial<Style['legend'][number]>) =>
    setStyle({ legend: style.legend.map((l, j) => (j === i ? { ...l, ...patch } : l)) })
  const free = COLORS.filter((c) => !style.legend.some((l) => l.color === c))

  const colourOption = (c: string) => ({ value: c, label: c[0].toUpperCase() + c.slice(1), swatch: PALETTE[c] })
  const words = (n: number) => setStyle({ maxWords: Math.min(30, Math.max(1, n)) })

  return (
    <div className="context">
      <div className="ctx-bar">
        <span>Claude reads this for every request on the canvas</span>
        <span className={`ctx-saved${saved ? '' : ' busy'}`}>{saved ? 'Saved' : 'Saving…'}</span>
      </div>
      <div className="ctx-body">
        <section className="ctx-card">
          <header>
            <h3>How Claude works with you</h3>
            <p className="hint">The same for every diagram of this project.</p>
          </header>
          <textarea
            value={ctx.rules}
            placeholder="e.g. Reply in the language I write in. Change only what I selected; ask when the scope is unclear. Save decisions as notes."
            onChange={(e) => change({ ...ctx, rules: e.target.value })}
          />
        </section>

        <div className="ctx-scope"><span>This diagram only</span><b title={name}>{name}</b></div>

        <section className="ctx-card">
          <header>
            <h3>Diagram style</h3>
            <p className="hint">Applied to every box Claude draws in this diagram, and told to Claude. Restart Claude Code to apply to a running session.</p>
          </header>

          <div className="ctx-legend">
            <div className="ctx-sub">Colour legend</div>
            {style.legend.length === 0 && <p className="ctx-empty">No colours yet: boxes stay uncoloured.</p>}
            {style.legend.map((l, i) => (
              <div key={l.color} className="legend-row">
                <Dropdown value={l.color} options={[l.color, ...free].map(colourOption)} title="Colour" variant="field" onChange={(v) => setLegend(i, { color: v })} />
                <input value={l.meaning} placeholder="means…" onChange={(e) => setLegend(i, { meaning: e.target.value })} />
                <button className="ctx-icon" title="Remove colour" aria-label="Remove colour" onClick={() => setStyle({ legend: style.legend.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
            {free.length > 0 && (
              <button className="ctx-add" onClick={() => setStyle({ legend: [...style.legend, { color: free[0], meaning: '' }] })}>+ Add colour</button>
            )}
          </div>

          <div className="ctx-rows">
            {CHOICES.map(({ key, label, options }) => (
              <div className="ctx-row" key={key}>
                <label>{label}</label>
                <div className="ctx-seg" role="radiogroup" aria-label={label}>
                  {options.map(([v, text]) => (
                    <button key={v} role="radio" aria-checked={style[key] === v} className={style[key] === v ? 'on' : ''} onClick={() => setStyle({ [key]: v })}>{text}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className={`ctx-row${style.limitWords ? '' : ' off'}`}>
              <label htmlFor="ctx-limit-words">
                Max words per box
                <span className="ctx-row-hint">{style.limitWords ? 'Longer box text is flagged' : 'Off: no limit'}</span>
              </label>
              <div className="ctx-row-ctl">
                {style.limitWords && (
                  <div className="ctx-stepper">
                    <button aria-label="Fewer" disabled={style.maxWords <= 1} onClick={() => words(style.maxWords - 1)}>−</button>
                    <input type="number" min={1} max={30} value={style.maxWords} onChange={(e) => words(Number(e.target.value) || 1)} />
                    <button aria-label="More" disabled={style.maxWords >= 30} onClick={() => words(style.maxWords + 1)}>+</button>
                  </div>
                )}
                <button
                  id="ctx-limit-words"
                  role="switch"
                  aria-checked={style.limitWords}
                  className={`ctx-switch${style.limitWords ? ' on' : ''}`}
                  title={style.limitWords ? 'Turn the word limit off' : 'Turn the word limit on'}
                  onClick={() => setStyle({ limitWords: !style.limitWords })}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="ctx-card">
          <header>
            <h3>About this diagram</h3>
            <p className="hint">What it is for, who reads it, its terms and conventions: what the boxes themselves don't say.</p>
          </header>
          <textarea
            value={ctx.diagrams}
            placeholder="e.g. Architecture of the data pipeline, for engineers new to the codebase. &quot;Job&quot; means one worker run."
            onChange={(e) => change({ ...ctx, diagrams: e.target.value })}
          />
        </section>
      </div>
    </div>
  )
}
