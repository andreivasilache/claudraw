import { peek } from './history.ts'
import { isNode, plainText, readScene, textOf, type El, type Scene } from './scene.ts'

export type Box = { id: string; type: string; text: string; x: number; y: number; width: number; height: number; stroke: string; fill: string }
/** `before` is the box as it was in the old scene, so the page can show the previous version on hover. */
export type Diff = { label: string; date: string; added: Box[]; removed: Box[]; modified: (Box & { changes: string[]; before: Box })[] }

const nodes = (s: Scene) => new Map(s.elements.filter(isNode).map((e) => [e.id, e]))

const box = (s: Scene, e: El): Box => ({
  id: e.id,
  type: e.type,
  text: plainText(s, e).slice(0, 80),
  x: e.x,
  y: e.y,
  width: e.width,
  height: e.height,
  stroke: e.strokeColor,
  fill: e.backgroundColor,
})

/** What changed on the canvas since the scene saved in a history entry (the state before that change). */
export async function diffSince(id: string): Promise<Diff | null> {
  const old = await peek(id)
  if (!old) return null
  const now = await readScene()
  const before = nodes(old.scene)
  const after = nodes(now)
  const diff: Diff = { label: old.entry.label, date: old.entry.date, added: [], removed: [], modified: [] }
  for (const [nid, e] of after) {
    const o = before.get(nid)
    if (!o) {
      diff.added.push(box(now, e))
      continue
    }
    const changes: string[] = []
    if (textOf(old.scene, o).trim() !== textOf(now, e).trim()) changes.push('text')
    if (o.strokeColor !== e.strokeColor || o.backgroundColor !== e.backgroundColor) changes.push('color')
    if (Math.abs(o.x - e.x) > 1 || Math.abs(o.y - e.y) > 1) changes.push('moved')
    if (Math.abs(o.width - e.width) > 1 || Math.abs(o.height - e.height) > 1) changes.push('resized')
    if (changes.length) diff.modified.push({ ...box(now, e), changes, before: box(old.scene, o) })
  }
  for (const [nid, o] of before) if (!after.has(nid)) diff.removed.push(box(old.scene, o))
  return diff
}
