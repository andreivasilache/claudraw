import { emit } from './events.ts'
import { cur, perDiagram } from './project.ts'
import { readJson, withLock, writeData } from './store.ts'

/** One presentation step: the boxes that appear together, and an optional caption shown under the canvas. */
export type Step = { ids: string[]; caption?: string }
/** A named presentation. A diagram can hold several; each is played on its own. */
export type Animation = { name: string; steps: Step[] }

const file = () => cur().animationFile
const state = perDiagram(() => ({ cache: null as Animation[] | null }))

const cleanSteps = (raw: unknown): Step[] =>
  (Array.isArray(raw) ? raw : []).slice(0, 100).map((s: any) => {
    const ids: string[] = Array.isArray(s?.ids) ? s.ids.filter((i: unknown) => typeof i === 'string').map((i: string) => i.slice(0, 200)).slice(0, 50) : []
    const caption = typeof s?.caption === 'string' ? s.caption.slice(0, 200).trim() : ''
    return { ids, ...(caption ? { caption } : {}) }
  })

/** Keeps well-formed animations with unique names. Saved apart from the diagram, so history and undo ignore it. */
const cleanAnimations = (raw: unknown): Animation[] => {
  const seen = new Set<string>()
  return (Array.isArray(raw) ? raw : []).slice(0, 30).flatMap((a: any, i: number) => {
    let name = (typeof a?.name === 'string' ? a.name.trim().slice(0, 60) : '') || `Animation ${i + 1}`
    while (seen.has(name)) name += ' (2)'
    seen.add(name)
    return [{ name, steps: cleanSteps(a?.steps) }]
  })
}

/** Read from disk once, then served from memory. */
export async function getAnimations(): Promise<Animation[]> {
  const st = state()
  if (st.cache) return st.cache
  const f = await readJson<{ animations?: Animation[] }>(file(), {})
  return (st.cache = cleanAnimations(f.animations))
}

/** Write and tell the page. Callers hold the store lock. */
async function save(animations: Animation[]) {
  state().cache = animations
  await writeData(file(), 'animations', animations)
  emit({ type: 'animation' })
  return animations
}

export function setAnimations(raw: unknown): Promise<Animation[]> {
  const animations = cleanAnimations(raw)
  return withLock(() => save(animations))
}

/** Create or replace one animation by name; no steps removes it. */
export function upsertAnimation(name: string, steps: Step[]): Promise<Animation[]> {
  return withLock(async () => {
    const all = await getAnimations()
    const rest = all.filter((a) => a.name !== name)
    const at = all.findIndex((a) => a.name === name)
    if (steps.length) rest.splice(at < 0 ? rest.length : at, 0, { name, steps })
    return save(cleanAnimations(rest))
  })
}

/** Drops deleted boxes from every step, and steps left with none. Called while saving the scene, which already holds the
 *  (non-reentrant) store lock, so it must not take it again. */
export async function pruneAnimations(alive: Set<string>) {
  let changed = false
  const next = (await getAnimations()).map((a) => ({
    ...a,
    steps: a.steps.flatMap((s) => {
      const ids = s.ids.filter((i) => alive.has(i))
      if (ids.length === s.ids.length) return [s]
      changed = true
      return ids.length ? [{ ...s, ids }] : []
    }),
  }))
  if (changed) await save(next)
}
