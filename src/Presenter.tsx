import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { CaptureUpdateAction } from '@excalidraw/excalidraw'
import { useEffect, useRef, useState } from 'react'
import type { Step } from './api.ts'

type Pt = readonly [number, number]
type El = ExcalidrawElement & { containerId?: string | null; startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null; points?: readonly Pt[] }

const isLinear = (e: El) => (e.type === 'arrow' || e.type === 'line') && (e.points?.length ?? 0) >= 2

/** Scene bounds of an element; arrows and lines by their points (they can run left or up from x,y). */
function bounds(e: El) {
  if (!isLinear(e)) return { x0: e.x, y0: e.y, x1: e.x + e.width, y1: e.y + e.height }
  const xs = e.points!.map((p) => e.x + p[0]), ys = e.points!.map((p) => e.y + p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}
type Box = ReturnType<typeof bounds>
const union = (bs: Box[]): Box | null => (bs.length ? { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) } : null)
const touches = (a: Box, b: Box, m: number) => a.x0 - m <= b.x1 && b.x0 - m <= a.x1 && a.y0 - m <= b.y1 && b.y0 - m <= a.y1

/**
 * The step at which each element appears (-1 = always visible).
 * An element listed in a step (box, frame, arrow, line, text) appears with it. Otherwise a box or text is claimed by the earliest
 * step listing a box or frame it lies inside, and an arrow appears once both of its ends have. Text follows its container.
 */
export function stepIndexes(all: readonly ExcalidrawElement[], steps: Step[]): Map<string, number> {
  const els = (all as readonly El[]).filter((e) => !e.isDeleted)
  const listed = new Map<string, number>()
  steps.forEach((s, i) => s.ids.forEach((id) => listed.has(id) || listed.set(id, i)))
  const holders = els.filter((e) => listed.has(e.id) && ['rectangle', 'frame', 'magicframe', 'ellipse', 'diamond'].includes(e.type))
  const within = (e: El, b: El) => e.x >= b.x && e.y >= b.y && e.x + e.width <= b.x + b.width && e.y + e.height <= b.y + b.height
  const idx = new Map<string, number>()

  for (const e of els) {
    if (e.type === 'arrow' || (e.type === 'text' && e.containerId)) continue
    const own = listed.get(e.id)
    const claims = [e.frameId ? listed.get(e.frameId) : undefined, ...holders.filter((b) => b.id !== e.id && within(e, b)).map((b) => listed.get(b.id))].filter((n): n is number => n !== undefined)
    idx.set(e.id, own ?? (claims.length ? Math.min(...claims) : -1))
  }
  // Arrows: their own step when listed, else by their bindings, else by the smallest box each end touches.
  const boxes = els.filter((e) => !['arrow', 'line', 'text', 'freedraw'].includes(e.type))
  const endIdx = (a: El, b: { elementId: string } | null | undefined, at: number) => {
    if (b) return idx.get(b.elementId) ?? -1
    const pts = a.points!
    const [px, py] = pts[at < 0 ? pts.length - 1 : 0]
    const x = a.x + px, y = a.y + py, m = 8
    const hit = boxes.filter((e) => x >= e.x - m && x <= e.x + e.width + m && y >= e.y - m && y <= e.y + e.height + m).sort((p, q) => p.width * p.height - q.width * q.height)[0]
    return hit ? (idx.get(hit.id) ?? -1) : -1
  }
  for (const a of els.filter((e) => e.type === 'arrow')) idx.set(a.id, listed.get(a.id) ?? Math.max(endIdx(a, a.startBinding, 0), endIdx(a, a.endBinding, -1)))
  for (const e of els) if (e.type === 'text' && e.containerId) idx.set(e.id, idx.get(e.containerId) ?? -1)
  return idx
}

/** The first `p` (0..1) of a polyline, measured along its length: an arrow being drawn from its start. */
function partial(pts: readonly Pt[], p: number): Pt[] {
  const lens = pts.slice(1).map((q, i) => Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]))
  let left = lens.reduce((a, b) => a + b, 0) * p
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const l = lens[i - 1]
    if (left >= l) { out.push(pts[i]); left -= l; continue }
    const t = l ? left / l : 0, a = pts[i - 1], b = pts[i]
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    break
  }
  if (out.length < 2) out.push(pts[0])
  return out
}
const lengthOf = (pts: readonly Pt[]) => pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0)

/** o = share of the element's own opacity (0..1), p = how much of an arrow/line is drawn (0..1). */
type Vis = { o: number; p: number }
type Tween = { from: Vis; to: Vis; t0: number; dur: number }
type Cam = { cx: number; cy: number; z: number }
type Run = {
  idx: Map<string, number>
  orig: Map<string, El>
  vis: Map<string, Vis>
  shown: Map<string, string>
  tweens: Map<string, Tween>
  cam: { from: Cam; to: Cam; t0: number; dur: number } | null
  stage: Box | null
  raf: number
}

/** Earlier steps are dimmed to this, so the step just revealed stands out. */
const DIM = 0.35
/** Below this zoom text is too small to read, so the camera follows the steps instead of showing the whole stage. */
const READABLE = 0.55
/** Room kept for the caption bar at the bottom of the canvas. */
const BAR = 90
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const clamp01 = (t: number) => Math.max(0, Math.min(1, t))

/**
 * Fullscreen walk through the steps. Each click reveals one step: its boxes fade in, its arrows and lines are drawn from start to
 * end (the label appears as the arrow arrives), and earlier steps dim. The camera shows the whole animated area when it is
 * readable, and otherwise follows the steps. The scene and the view are restored on exit.
 */
export function Presenter({ xa, steps, onExit }: { xa: ExcalidrawImperativeAPI; steps: Step[]; onExit: () => void }) {
  const [k, setK] = useState(-1)
  const last = steps.length - 1
  const run = useRef<Run | null>(null)

  const viewport = () => {
    const a = xa.getAppState()
    return { w: a.width, h: Math.max(200, a.height - BAR) }
  }
  /** The camera that shows a box: centred, fitted with a margin, never zoomed in past `max`. */
  const camFor = (b: Box, max: number): Cam => {
    const { w, h } = viewport()
    const z = Math.min(max, (w * 0.9) / Math.max(1, b.x1 - b.x0), (h * 0.88) / Math.max(1, b.y1 - b.y0))
    return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, z: Math.max(0.1, z) }
  }
  const camNow = (): Cam => {
    const a = xa.getAppState(), { w, h } = viewport(), z = a.zoom.value
    return { cx: w / (2 * z) - a.scrollX, cy: h / (2 * z) - a.scrollY, z }
  }
  const camTo = (to: Cam, dur: number) => {
    const r = run.current!, from = camNow()
    const moves = Math.abs(Math.log(to.z / from.z)) > 0.05 || Math.hypot(to.cx - from.cx, to.cy - from.cy) * from.z > 40
    r.cam = moves ? { from, to, t0: performance.now(), dur } : null
    return moves
  }

  const render = (now: number) => {
    const r = run.current
    if (!r) return
    let busy = false
    for (const [id, tw] of r.tweens) {
      const t = tw.dur ? clamp01((now - tw.t0) / tw.dur) : 1
      const e = ease(t)
      r.vis.set(id, { o: tw.from.o + (tw.to.o - tw.from.o) * e, p: tw.from.p + (tw.to.p - tw.from.p) * e })
      if (t >= 1) r.tweens.delete(id)
      else busy = true
    }
    const elements = xa.getSceneElementsIncludingDeleted().map((el) => {
      const o0 = r.orig.get(el.id), v = r.vis.get(el.id)
      if (!o0 || !v) return el
      const drawn = isLinear(o0) && v.p < 0.999
      const opacity = drawn && v.p < 0.01 ? 0 : Math.round(o0.opacity * v.o)
      const key = `${opacity}|${drawn ? v.p.toFixed(3) : 1}`
      if (r.shown.get(el.id) === key) return el
      r.shown.set(el.id, key)
      const bump = { version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() }
      if (!isLinear(o0)) return { ...el, opacity, ...bump }
      const points = drawn ? partial(o0.points!, v.p) : o0.points!
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1])
      return { ...el, opacity, points, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), ...bump } as unknown as ExcalidrawElement
    })
    let appState: Record<string, unknown> | undefined
    if (r.cam) {
      const { from, to, t0, dur } = r.cam
      const t = clamp01((now - t0) / dur), e = ease(t)
      const z = Math.exp(Math.log(from.z) + (Math.log(to.z) - Math.log(from.z)) * e)
      const cx = from.cx + (to.cx - from.cx) * e, cy = from.cy + (to.cy - from.cy) * e
      const { w, h } = viewport()
      appState = { scrollX: w / (2 * z) - cx, scrollY: h / (2 * z) - cy, zoom: { value: z } }
      if (t >= 1) r.cam = null
      else busy = true
    }
    xa.updateScene({ elements, ...(appState ? { appState: appState as never } : {}), captureUpdate: CaptureUpdateAction.NEVER })
    r.raf = busy ? requestAnimationFrame(render) : 0
  }
  const kick = () => {
    const r = run.current!
    if (!r.raf) r.raf = requestAnimationFrame(render)
  }

  /** Where every animated element should be once step `to` is shown. */
  const target = (id: string, to: number): Vis => {
    const i = run.current!.idx.get(id) ?? -1
    if (i < 0 || i === to) return { o: 1, p: 1 }
    if (i > to) return { o: 0, p: 0 }
    return { o: DIM, p: 1 }
  }
  const tween = (id: string, from: Vis, to: Vis, delay: number, dur: number) => run.current!.tweens.set(id, { from, to, t0: performance.now() + delay, dur })

  /** Moves the camera for step `to`: the whole stage when it is readable, else the step with the one before it. */
  const frameStep = (to: number): boolean => {
    const r = run.current!
    if (!r.stage) return false
    const whole = camFor(r.stage, 1.4)
    if (to < 0 || whole.z >= READABLE) return camTo(whole, 700)
    const els = xa.getSceneElements() as readonly El[]
    const of = (n: number) => els.filter((e) => r.idx.get(e.id) === n).map(bounds)
    const near = union([...of(to), ...(to > 0 ? of(to - 1) : [])])
    const own = union(of(to))
    if (!own) return false
    // Stay put while the new step is already on screen and readable.
    const cur = camNow(), { w, h } = viewport()
    const onScreen = own.x0 >= cur.cx - w / (2 * cur.z) && own.x1 <= cur.cx + w / (2 * cur.z) && own.y0 >= cur.cy - h / (2 * cur.z) && own.y1 <= cur.cy + h / (2 * cur.z)
    if (onScreen && cur.z >= READABLE) return false
    const both = near ? camFor(near, 1) : null
    return camTo(both && both.z >= READABLE ? both : camFor(own, 1), 700)
  }

  const go = (n: number) => {
    const to = Math.max(-1, Math.min(last, n))
    if (to === k) return
    const r = run.current!
    const forward = to === k + 1
    setK(to)
    const lead = frameStep(to) ? 450 : 0
    const els = xa.getSceneElements() as readonly El[]
    const fresh = forward ? els.filter((e) => r.idx.get(e.id) === to) : []
    // Within a step, boxes come first and the arrows between them are drawn after.
    const onArrow = (e: El) => { const c = e.containerId && r.orig.get(e.containerId); return !!c && isLinear(c) }
    const hasShapes = fresh.some((e) => !isLinear(e) && !onArrow(e))
    const drawAt = new Map<string, { at: number; dur: number }>()
    for (const e of fresh) {
      if (!isLinear(e)) continue
      const at = lead + (hasShapes && e.type === 'arrow' ? 350 : 0)
      const dur = Math.min(1100, 350 + lengthOf(r.orig.get(e.id)!.points!) * 0.4)
      drawAt.set(e.id, { at, dur })
      tween(e.id, { o: 1, p: 0 }, { o: 1, p: 1 }, at, dur)
    }
    for (const id of r.orig.keys()) {
      if (drawAt.has(id)) continue
      const from = r.vis.get(id) ?? { o: 1, p: 1 }
      const t = target(id, to)
      if (from.o === t.o && from.p === t.p) continue
      if (fresh.length && r.idx.get(id) === to) {
        // A label rides on its arrow: it fades in as the arrow arrives.
        const c = r.orig.get(id)!.containerId
        const d = c ? drawAt.get(c) : undefined
        tween(id, from, t, d ? d.at + d.dur * 0.55 : lead, d ? 350 : 400)
      } else tween(id, from, t, forward ? lead : 0, 350)
    }
    kick()
  }

  // Setup / teardown: remember the scene and the view as they are, and put the very same elements back on exit (so nothing is saved).
  useEffect(() => {
    const els = xa.getSceneElements() as readonly El[]
    const orig = new Map<string, El>((xa.getSceneElementsIncludingDeleted() as readonly El[]).map((e) => [e.id, e]))
    const view = (({ scrollX, scrollY, zoom }) => ({ scrollX, scrollY, zoom }))(xa.getAppState())
    const idx = stepIndexes(els, steps)
    // The stage: everything the steps reveal, plus what always stays visible around it (participants, lifelines, frames),
    // grown until nothing more touches it. Unrelated parts of the diagram stay out of the picture.
    const live = els.filter((e) => !(e.type === 'text' && e.containerId))
    let stage = union(live.filter((e) => (idx.get(e.id) ?? -1) >= 0).map(bounds))
    for (let pass = 0; stage && pass < 8; pass++) {
      const more = live.filter((e) => (idx.get(e.id) ?? -1) < 0).map(bounds).filter((b) => touches(b, stage!, 40) && (b.x0 < stage!.x0 || b.y0 < stage!.y0 || b.x1 > stage!.x1 || b.y1 > stage!.y1))
      if (!more.length) break
      stage = union([stage, ...more])
    }
    const vis = new Map<string, Vis>([...orig.keys()].map((id) => [id, { o: 1, p: 1 }]))
    run.current = { idx, orig, vis, shown: new Map(), tweens: new Map(), cam: null, stage: stage ?? union(live.map(bounds)), raf: 0 }
    xa.updateScene({ appState: { selectedElementIds: {} } as never, captureUpdate: CaptureUpdateAction.NEVER })
    for (const id of orig.keys()) vis.set(id, target(id, -1))
    render(performance.now())
    // The side panel has just been hidden; give the canvas a moment to take the full width.
    const t = window.setTimeout(() => { frameStep(-1); kick() }, 150)
    return () => {
      window.clearTimeout(t)
      cancelAnimationFrame(run.current!.raf)
      const back = xa.getSceneElementsIncludingDeleted().map((e) => orig.get(e.id) ?? e)
      xa.updateScene({ elements: back, appState: view as never, captureUpdate: CaptureUpdateAction.NEVER })
      run.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const keys = useRef(go)
  keys.current = go
  const kRef = useRef(k)
  kRef.current = k
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = [' ', 'ArrowRight', 'ArrowDown', 'PageDown', 'Enter']
      const prev = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']
      const go = keys.current
      if (e.key === 'Escape') onExit()
      else if (next.includes(e.key)) go(kRef.current + 1)
      else if (prev.includes(e.key)) go(kRef.current - 1)
      else if (e.key === 'Home') go(-1)
      else if (e.key === 'End') go(last)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [last, onExit])

  return (
    <div className="present-bar">
      <button onClick={() => go(k - 1)} disabled={k < 0} title="Back (←)">‹</button>
      <div className="present-caption">{k < 0 ? 'Press → to start' : (steps[k].caption ?? '')}</div>
      <span className="present-count">{k + 1} / {steps.length}</span>
      <button onClick={() => go(k + 1)} disabled={k >= last} title="Next (→ or Space)">›</button>
      <button onClick={onExit} title="Exit (Esc)">✕</button>
    </div>
  )
}
