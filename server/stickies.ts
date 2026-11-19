import { type FreeShapeIn, type FreeTextIn, type Scene, addShapes, freeOrigin, freeSpot } from './scene.ts'

/** Sticky notes: coloured paper squares in clusters. The open-source Excalidraw has no sticky-note element, so each is a
 *  plain box with a paper colour, sharp corners and a slight tilt, which stays editable like any box. */
export const STICKY_COLORS = { yellow: '#ffdf6b', blue: '#a5d8ff', green: '#b2f2bb', pink: '#fcc2d7', orange: '#ffd8a8' } as const
export type StickyColor = keyof typeof STICKY_COLORS
export type StickyCluster = { title?: string; color?: StickyColor; notes: string[] }
export type StickyIn = { clusters: StickyCluster[]; notesPerRow?: number; noteSize?: number; showDates?: boolean; x?: number; y?: number; exact?: boolean }

const GAP = 14
const ORDER = Object.keys(STICKY_COLORS) as StickyColor[]

export function addStickyNotes(s: Scene, o: StickyIn) {
  if (!o.clusters.length) throw new Error('Give at least one cluster')
  const size = Math.min(Math.max(o.noteSize ?? 160, 100), 320)
  const perRow = Math.min(Math.max(Math.round(o.notesPerRow ?? 3), 1), 8)
  // The area all clusters take, so a position over other content can be moved below it (exact: true keeps it).
  const widths = o.clusters.map((c) => Math.min(perRow, Math.max(c.notes.length, 1)) * size + (Math.min(perRow, Math.max(c.notes.length, 1)) - 1) * GAP)
  const heights = o.clusters.map((c) => (c.title ? 40 : 0) + Math.ceil(c.notes.length / perRow) * (size + GAP + (o.showDates ? 18 : 0)))
  const asked = freeOrigin(s, o.x, o.y)
  const spot = o.exact || (o.x === undefined && o.y === undefined) ? { ...asked, moved: false } : freeSpot(s, asked.x, asked.y, widths.reduce((a, b) => a + b + 60, -60), Math.max(...heights))
  const origin = { x: spot.x, y: spot.y }
  const shapes: FreeShapeIn[] = []
  const texts: FreeTextIn[] = []
  const date = new Date().toISOString().slice(0, 10)
  let x = origin.x
  let count = 0
  o.clusters.forEach((c, ci) => {
    const color = STICKY_COLORS[c.color ?? ORDER[ci % ORDER.length]]
    const cols = Math.min(perRow, Math.max(c.notes.length, 1))
    const width = cols * size + (cols - 1) * GAP
    const top = origin.y + (c.title ? 40 : 0)
    if (c.title) texts.push({ text: c.title, x, y: origin.y + 12, size: 22, align: 'left', color: 'blue', maxWidth: Math.max(width, 260) })
    c.notes.forEach((text, k) => {
      const col = k % perRow
      const row = Math.floor(k / perRow)
      shapes.push({
        shape: 'rectangle',
        x: x + col * (size + GAP),
        y: top + row * (size + GAP + (o.showDates ? 18 : 0)),
        width: size,
        height: size,
        text,
        style: { background: color, fillStyle: 'solid', edges: 'sharp', sloppiness: 'artist', strokeWidth: 1, angle: ((count++ % 3) - 1) * 1.5 },
      })
      if (o.showDates) texts.push({ text: date, x: x + col * (size + GAP) + size / 2, y: top + row * (size + GAP + 18) + size + 10, size: 11, color: 'gray' })
    })
    x += width + 60
  })
  const r = addShapes(s, { shapes, texts })
  const moved = spot.moved ? ` ${Math.round(asked.x)},${Math.round(asked.y)} was taken by other elements, so they went below them (exact: true keeps the position).` : ''
  return { ...r, text: `Added ${count} sticky note(s) in ${o.clusters.length} cluster(s) at ${Math.round(origin.x)},${Math.round(origin.y)}.${moved} ${r.ids.join(', ')}.` }
}
