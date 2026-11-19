import { PALETTE } from './palette.ts'
import { type FreeLineIn, type FreeShapeIn, type FreeTextIn, type Scene, addShapes, freeOrigin, freeSpot } from './scene.ts'

// Charts drawn from the same primitives add_shapes uses (lines, boxes, texts at exact coordinates), so they are ordinary,
// editable Excalidraw elements and the layout check leaves them alone.

export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'donut', 'scatter', 'funnel', 'waterfall'] as const
export type ChartType = (typeof CHART_TYPES)[number]
export type ChartSeries = { name?: string; values?: number[]; points?: { x: number; y: number }[]; color?: string }
export type ChartIn = {
  type: ChartType
  title?: string
  categories?: string[]
  series: ChartSeries[]
  stack?: 'none' | 'stacked' | 'percent'
  valueFormat?: string
  highlight?: string | number
  annotations?: { at: string | number; text: string }[]
  showTotal?: boolean
  x?: number
  y?: number
  width?: number
  height?: number
  exact?: boolean
}

type Pt = { x: number; y: number }
const ORDER = ['blue', 'green', 'orange', 'red', 'purple', 'yellow', 'gray']
const MAX_CATEGORIES = 200
const MAX_SERIES = 12

/** A nice axis for values between min and max (including 0 unless `zero` is false): the low and high end and the tick values. */
function niceScale(min: number, max: number, count = 5, zero = true) {
  const lo0 = zero ? Math.min(0, min) : min
  const hi0 = zero ? Math.max(0, max) : max
  const raw = (hi0 - lo0 || 1) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag
  const lo = Math.floor(lo0 / step + 1e-9) * step
  const hi = Math.ceil(hi0 / step - 1e-9) * step
  const ticks: number[] = []
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step)
  return { lo, hi: hi === lo ? lo + step : hi, ticks }
}

const num = (v: number) => Number(v.toFixed(2)).toLocaleString('en-US')

/** The elements of one chart, collected before they are drawn. */
class Parts {
  lines: FreeLineIn[] = []
  shapes: FreeShapeIn[] = []
  texts: FreeTextIn[] = []
  text(text: string, x: number, y: number, o: { size?: number; align?: 'left' | 'center' | 'right'; color?: string; maxWidth?: number } = {}) {
    this.texts.push({ text, x, y, size: o.size ?? 14, align: o.align ?? 'center', color: o.color ?? 'gray', ...(o.maxWidth ? { maxWidth: o.maxWidth } : {}) })
  }
  line(points: Pt[], o: { color?: string; width?: number; dashed?: boolean; closed?: boolean; fill?: string; opacity?: number } = {}) {
    const style = o.fill || o.opacity !== undefined ? { ...(o.fill ? { background: o.fill } : {}), ...(o.opacity !== undefined ? { opacity: o.opacity } : {}) } : undefined
    this.lines.push({ points, color: o.color ?? 'gray', width: o.width ?? 1, dashed: o.dashed, closed: o.closed, ...(style ? { style } : {}) })
  }
  box(x: number, y: number, width: number, height: number, o: { color?: string; shape?: 'rectangle' | 'ellipse'; dim?: boolean } = {}) {
    this.shapes.push({ shape: o.shape ?? 'rectangle', x, y, width, height, color: o.color, fill: true, ...(o.dim ? { style: { opacity: 40 } } : {}) })
  }
}

/** Draws a chart on the scene. Returns what add_shapes returns plus a one-line summary. */
export function addChart(s: Scene, o: ChartIn) {
  if (!o.series?.length) throw new Error('Give at least one series')
  if (o.series.length > MAX_SERIES) throw new Error(`At most ${MAX_SERIES} series`)
  const fmt = (v: number) => (o.valueFormat?.includes('{v}') ? o.valueFormat.replace('{v}', num(v)) : num(v))
  const colorOf = (i: number) => (o.series[i]?.color && PALETTE[o.series[i].color!] ? o.series[i].color! : ORDER[i % ORDER.length])
  const sliceColor = (i: number) => ORDER[i % ORDER.length]
  const cats = o.categories ?? []
  const W = o.width ?? (o.type === 'pie' || o.type === 'donut' ? 560 : 680)
  const H = o.height ?? 380
  // A position that lies over other content is moved below it (exact: true keeps it), as add_node does.
  const asked = freeOrigin(s, o.x, o.y)
  const spot = o.exact || (o.x === undefined && o.y === undefined) ? { ...asked, moved: false } : freeSpot(s, asked.x, asked.y, W, H)
  const origin = { x: spot.x, y: spot.y }
  const P = new Parts()
  const ox = origin.x
  const oy = origin.y
  const many = o.series.length > 1
  if (o.title) P.text(o.title, ox + W / 2, oy + 20, { size: 22, color: 'blue' })
  const hi = typeof o.highlight === 'number' ? o.highlight : o.highlight !== undefined ? cats.indexOf(o.highlight) : -1
  const dimmed = (i: number) => hi >= 0 && i !== hi
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg)
  }

  const legend = (names: { name: string; color: string }[], y: number, x0: number) => {
    let x = x0
    for (const n of names) {
      P.box(x, y - 7, 14, 14, { color: n.color })
      P.text(n.name, x + 20, y, { align: 'left' })
      x += 44 + n.name.length * 8
    }
  }
  const finish = (what: string) => {
    const r = addShapes(s, { lines: P.lines, shapes: P.shapes, texts: P.texts })
    const moved = spot.moved ? ` ${Math.round(asked.x)},${Math.round(asked.y)} was taken by other elements, so it went to ${Math.round(ox)},${Math.round(oy)} (exact: true keeps it where asked).` : ''
    return { ...r, text: `Drew a ${what} at ${Math.round(ox)},${Math.round(oy)}, ${W}x${H}, as ${r.ids.length} editable element(s).${moved} ${r.text.split('\n').slice(1).join('\n')}`.trim() }
  }

  // ------------------------------------------------------------------ pie, donut
  if (o.type === 'pie' || o.type === 'donut') {
    const vals = o.series[0].values ?? []
    need(vals.length > 0 && vals.length <= MAX_CATEGORIES, 'A pie or donut needs series[0].values')
    need(vals.every((v) => v >= 0), 'Slices cannot be negative')
    const labels = vals.map((_, i) => cats[i] ?? `#${i + 1}`)
    const total = vals.reduce((a, b) => a + b, 0)
    need(total > 0, 'The values add up to 0')
    const top = o.title ? 56 : 20
    const r = Math.min(H - top - 20, W * 0.5 - 30) / 2
    const cx = ox + 24 + r
    const cy = oy + top + r + 8
    const inner = o.type === 'donut' ? r * 0.55 : 0
    const at = (a: number, rad: number): Pt => ({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) })
    let a0 = -Math.PI / 2
    vals.forEach((v, i) => {
      if (v <= 0) return
      const f = v / total
      const a1 = a0 + f * 2 * Math.PI
      const steps = Math.max(2, Math.ceil(((a1 - a0) * 180) / Math.PI / 3))
      const arc = (rad: number, from: number, to: number) => Array.from({ length: steps + 1 }, (_, k) => at(from + ((to - from) * k) / steps, rad))
      const pts = inner ? [...arc(r, a0, a1), ...arc(inner, a1, a0)] : f >= 0.9999 ? arc(r, a0, a1) : [{ x: cx, y: cy }, ...arc(r, a0, a1)]
      P.line(pts, { color: sliceColor(i), width: 2, closed: true, fill: sliceColor(i), opacity: dimmed(i) ? 40 : undefined })
      if (f >= 0.06) {
        const m = at((a0 + a1) / 2, inner ? (r + inner) / 2 : r * 0.62)
        P.text(`${Math.round(f * 100)}%`, m.x, m.y, { color: 'gray', size: 14 })
      }
      a0 = a1
    })
    if (inner) P.text(fmt(total), cx, cy, { size: 20, color: 'blue' })
    const lx = cx + r + 40
    labels.forEach((l, i) => {
      const y = oy + top + 16 + i * 26
      P.box(lx, y - 7, 14, 14, { color: sliceColor(i), dim: dimmed(i) })
      P.text(`${l}: ${fmt(vals[i])} (${Math.round((vals[i] / total) * 100)}%)`, lx + 22, y, { align: 'left', maxWidth: ox + W - lx - 22 })
    })
    return finish(`${o.type} chart of ${vals.length} slice(s)`)
  }

  // ------------------------------------------------------------------ funnel
  if (o.type === 'funnel') {
    const vals = o.series[0].values ?? []
    need(vals.length > 0 && vals.length <= 20 && vals.every((v) => v >= 0), 'A funnel needs 1 to 20 non-negative values in series[0].values')
    const top = o.title ? 56 : 20
    const ph = H - top - 16
    const slot = ph / vals.length
    const max = Math.max(...vals, 1)
    const cx = ox + W / 2
    const wide = W * 0.8
    vals.forEach((v, i) => {
      const w0 = (v / max) * wide
      const w1 = i + 1 < vals.length ? (vals[i + 1] / max) * wide : w0 * 0.85
      const y0 = oy + top + i * slot
      const y1 = y0 + slot - 4
      P.line([{ x: cx - w0 / 2, y: y0 }, { x: cx + w0 / 2, y: y0 }, { x: cx + w1 / 2, y: y1 }, { x: cx - w1 / 2, y: y1 }], { color: sliceColor(i), width: 2, closed: true, fill: sliceColor(i), opacity: dimmed(i) ? 40 : undefined })
      const label = `${cats[i] ?? `#${i + 1}`}: ${fmt(v)}${i ? ` (${Math.round((v / (vals[0] || 1)) * 100)}%)` : ''}`
      if (Math.min(w0, w1) >= label.length * 8 + 16) P.text(label, cx, (y0 + y1) / 2)
      else P.text(label, cx + Math.max(w0, w1) / 2 + 10, (y0 + y1) / 2, { align: 'left' })
    })
    return finish(`funnel chart of ${vals.length} stage(s)`)
  }

  // ------------------------------------------------------------------ scatter
  if (o.type === 'scatter') {
    const all = o.series.flatMap((x, i) => (x.points ?? []).map((p) => ({ ...p, i })))
    need(all.length > 0 && all.length <= 2000, 'A scatter chart needs series[].points ({x,y}), up to 2000 in all')
    const top = o.title ? 56 : 24
    const left = 70
    const px = ox + left
    const py = oy + top + (many ? 26 : 0)
    const pw = W - left - 24
    const ph = H - (py - oy) - 56
    const xs = niceScale(Math.min(...all.map((p) => p.x)), Math.max(...all.map((p) => p.x)), 5, false)
    const ys = niceScale(Math.min(...all.map((p) => p.y)), Math.max(...all.map((p) => p.y)), 5, false)
    const X = (v: number) => px + ((v - xs.lo) / (xs.hi - xs.lo)) * pw
    const Y = (v: number) => py + ph - ((v - ys.lo) / (ys.hi - ys.lo)) * ph
    for (const t of ys.ticks) {
      P.line([{ x: px, y: Y(t) }, { x: px + pw, y: Y(t) }], { dashed: true, color: 'gray', width: 1, opacity: 35 })
      P.text(fmt(t), px - 8, Y(t), { align: 'right' })
    }
    for (const t of xs.ticks) P.text(num(t), X(t), py + ph + 18)
    P.line([{ x: px, y: py }, { x: px, y: py + ph }], { width: 2 })
    P.line([{ x: px, y: Y(Math.max(ys.lo, 0)) }, { x: px + pw, y: Y(Math.max(ys.lo, 0)) }], { width: 2 })
    for (const p of all) P.box(X(p.x) - 5, Y(p.y) - 5, 10, 10, { color: colorOf(p.i), shape: 'ellipse' })
    if (many) legend(o.series.map((x, i) => ({ name: x.name ?? `Series ${i + 1}`, color: colorOf(i) })), oy + top + 6, px)
    return finish(`scatter chart of ${all.length} point(s)`)
  }

  // ------------------------------------------------------------------ the rest share a category axis
  need(cats.length > 0 && cats.length <= MAX_CATEGORIES, 'Give categories (the labels along the axis)')
  for (const [i, x] of o.series.entries()) need((x.values?.length ?? 0) === cats.length, `series ${i + 1} (${x.name ?? 'unnamed'}) needs ${cats.length} values, one per category, not ${x.values?.length ?? 0}`)
  const showTotal = o.type === 'waterfall' && o.showTotal !== false
  const rows = showTotal ? [...cats, 'Total'] : cats // a waterfall ends with its total as one more bar
  const n = rows.length
  const horizontal = o.type === 'bar'
  const stack = o.stack ?? 'none'
  const stacked = stack !== 'none' && many && o.type !== 'waterfall'
  const vals = o.series.map((x) => x.values!)

  // What the value axis has to cover.
  let min: number
  let max: number
  const run: number[] = [] // waterfall: running totals
  if (o.type === 'waterfall') {
    let t = 0
    for (const v of vals[0]) run.push((t += v))
    min = Math.min(0, ...run)
    max = Math.max(0, ...run)
  } else if (stacked && stack === 'percent') {
    min = 0
    max = 100
  } else if (stacked) {
    const sums = (i: number, sign: number) => vals.reduce((a, v) => a + (Math.sign(v[i]) === sign ? v[i] : 0), 0)
    max = Math.max(0, ...cats.map((_, i) => sums(i, 1)))
    min = Math.min(0, ...cats.map((_, i) => sums(i, -1)))
  } else {
    max = Math.max(0, ...vals.flat())
    min = Math.min(0, ...vals.flat())
  }
  const scale = niceScale(min, max)

  const names = o.series.map((x, i) => ({ name: x.name ?? `Series ${i + 1}`, color: colorOf(i) }))
  const top = (o.title ? 56 : 24) + (many && o.type !== 'waterfall' ? 26 : 0)
  const maxLabel = Math.max(...rows.map((c) => c.length))
  const left = horizontal ? Math.min(180, Math.max(90, 30 + maxLabel * 8)) : 70
  const px = ox + left
  const py = oy + top
  const pw = W - left - 24
  const ph = H - top - (horizontal ? 36 : 56)
  const vLen = horizontal ? pw : ph
  const cLen = horizontal ? ph : pw
  const slot = cLen / n
  /** A value along the value axis, in canvas coordinates. */
  const V = (v: number) => (horizontal ? px + ((v - scale.lo) / (scale.hi - scale.lo)) * vLen : py + ph - ((v - scale.lo) / (scale.hi - scale.lo)) * vLen)
  /** The middle of category i along the category axis. */
  const C = (i: number) => (horizontal ? py + slot * (i + 0.5) : px + slot * (i + 0.5))
  /** A point on the plot from a category position and a value. */
  const at = (c: number, v: number): Pt => (horizontal ? { x: V(v), y: c } : { x: c, y: V(v) })
  const unit = stack === 'percent' && stacked ? (v: number) => `${num(v)}%` : fmt

  for (const t of scale.ticks) {
    const a = at(horizontal ? py : px, t)
    const b = at(horizontal ? py + ph : px + pw, t)
    P.line([a, b], { dashed: true, color: 'gray', width: 1, opacity: 35 })
    if (horizontal) P.text(unit(t), a.x, py + ph + 16)
    else P.text(unit(t), px - 8, a.y, { align: 'right' })
  }
  rows.forEach((c, i) => {
    if (horizontal) P.text(c, px - 8, C(i), { align: 'right', maxWidth: left - 16 })
    else P.text(c, C(i), py + ph + 24, { maxWidth: slot - 6 })
  })
  P.line([{ x: px, y: py }, { x: px, y: py + ph }], { width: 2 })
  const zero = at(horizontal ? py : px, 0)
  P.line(horizontal ? [{ x: zero.x, y: py }, { x: zero.x, y: py + ph }] : [{ x: px, y: zero.y }, { x: px + pw, y: zero.y }], { width: 2 })

  /** A box between two values and two category-axis positions. */
  const bar = (c0: number, c1: number, v0: number, v1: number, color: string, dim: boolean) => {
    const a = V(v0)
    const b = V(v1)
    const lo = Math.min(a, b)
    const len = Math.max(1, Math.abs(a - b))
    if (horizontal) P.box(lo, c0, len, c1 - c0, { color, dim })
    else P.box(c0, lo, c1 - c0, len, { color, dim })
  }
  const label = (text: string, c: number, v: number, size = 12) => {
    const p = at(c, v)
    if (horizontal) P.text(text, p.x + 6, p.y, { align: 'left', size })
    else P.text(text, p.x, p.y - 10, { size })
  }
  /** Where the top of category i is, for annotations. */
  let topOf: (i: number) => Pt = (i) => at(C(i), 0)

  if (o.type === 'column' || o.type === 'bar') {
    const groupW = slot * 0.7
    if (stacked) {
      cats.forEach((_, i) => {
        const total = vals.reduce((a, v) => a + Math.abs(v[i]), 0) || 1
        let up = 0
        let down = 0
        vals.forEach((v, j) => {
          const val = stack === 'percent' ? (v[i] / total) * 100 : v[i]
          const from = val >= 0 ? up : down
          const to = from + val
          if (val >= 0) up = to
          else down = to
          bar(C(i) - groupW / 2, C(i) + groupW / 2, from, to, colorOf(j), dimmed(i))
          if (Math.abs(V(to) - V(from)) >= 18 && val !== 0) {
            const m = at(C(i), (from + to) / 2)
            P.text(stack === 'percent' ? `${Math.round(val)}%` : fmt(v[i]), m.x, m.y, { size: 12 })
          }
        })
        topOf = ((prev) => (k: number) => (k === i ? at(C(i), up) : prev(k)))(topOf)
        if (stack !== 'percent') label(fmt(vals.reduce((a, v) => a + v[i], 0)), C(i), up)
      })
    } else {
      const k = o.series.length
      const w = groupW / k
      cats.forEach((_, i) => {
        vals.forEach((v, j) => {
          const c0 = C(i) - groupW / 2 + j * w
          bar(c0, c0 + w - (k > 1 ? 2 : 0), 0, v[i], colorOf(j), dimmed(i))
          if (n * k <= 24) label(fmt(v[i]), c0 + w / 2, v[i])
        })
        const best = Math.max(...vals.map((v) => v[i]))
        topOf = ((prev) => (m: number) => (m === i ? at(C(i), best) : prev(m)))(topOf)
      })
    }
    if (many) legend(names, oy + top - 14, px)
  } else if (o.type === 'line' || o.type === 'area') {
    const base: number[] = Array(n).fill(0) // stacked area: where the layer below ends
    vals.forEach((v, j) => {
      const upper = v.map((x, i) => (stacked ? base[i] + x : x))
      const pts = upper.map((x, i) => at(C(i), x))
      if (o.type === 'area') {
        const lower = (stacked ? base.map((x, i) => at(C(i), x)) : cats.map((_, i) => at(C(i), 0))).reverse()
        P.line([...pts, ...lower], { color: colorOf(j), width: 1, closed: true, fill: colorOf(j), opacity: 55 })
      }
      if (n > 1) P.line(pts, { color: colorOf(j), width: 3 })
      pts.forEach((p, i) => {
        const size = i === hi ? 14 : 8
        P.box(p.x - size / 2, p.y - size / 2, size, size, { color: colorOf(j), shape: 'ellipse', dim: dimmed(i) })
        if (!many && n <= 12) label(fmt(v[i]), horizontal ? p.y : p.x, upper[i])
      })
      if (stacked) upper.forEach((x, i) => (base[i] = x))
      topOf = ((prev, up) => (i: number) => (j === o.series.length - 1 ? at(C(i), Math.max(...vals.map((s2) => (stacked ? up[i] : s2[i])))) : prev(i)))(topOf, upper)
    })
    if (many) legend(names, oy + top - 14, px)
  } else {
    // waterfall: bars float from the running total; the last bar is the total
    const bw = slot * 0.7
    const total = run[run.length - 1]
    const all = [...vals[0].map((v, i) => ({ from: i ? run[i - 1] : 0, to: run[i], v })), ...(showTotal ? [{ from: 0, to: total, v: total }] : [])]
    all.forEach((b, i) => {
      bar(C(i) - bw / 2, C(i) + bw / 2, b.from, b.to, showTotal && i === all.length - 1 ? 'gray' : b.v >= 0 ? 'green' : 'red', dimmed(i))
      label(`${b.v > 0 ? '+' : ''}${fmt(b.v)}`, C(i), Math.max(b.from, b.to))
      if (i + 1 < all.length) {
        const a = at(C(i) + bw / 2, b.to)
        const z = at(C(i + 1) - bw / 2, b.to)
        P.line([a, z], { dashed: true, color: 'gray', width: 1 })
      }
    })
    if (!showTotal) P.text(`Total: ${fmt(total)}`, ox + W - 24, py - 12, { align: 'right', color: total >= 0 ? 'green' : 'red' })
    topOf = (i) => at(C(i), Math.max(all[i].from, all[i].to))
  }

  for (const a of o.annotations ?? []) {
    const i = typeof a.at === 'number' ? a.at : rows.indexOf(a.at)
    need(i >= 0 && i < n, `annotation at ${JSON.stringify(a.at)}: no such category`)
    const p = topOf(i)
    const e = horizontal ? { x: p.x + 40, y: p.y } : { x: p.x, y: p.y - 44 }
    P.line([horizontal ? { x: p.x + 28, y: p.y } : { x: p.x, y: p.y - 24 }, p], { color: 'orange', width: 1 })
    P.text(a.text, horizontal ? e.x : e.x, e.y, { color: 'orange', size: 14, align: horizontal ? 'left' : 'center', maxWidth: 160 })
  }
  return finish(`${stacked ? `${stack} ` : ''}${o.type} chart of ${o.series.length} series over ${n} categories`)
}
