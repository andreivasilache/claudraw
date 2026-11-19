import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DIAGRAM_ID, MAIN, diagramsDir, forgetDiagram, getProject } from './config.ts'
import { broadcast } from './events.ts'
import { cur, perProject, type Project } from './project.ts'
import { stopWatching } from './scene.ts'
import { readData, writeData } from './store.ts'
import { currentTurn } from './turn.ts'

// The diagrams of a project: 'main' (.canvas/diagram.excalidraw) plus one folder per diagram in .canvas/diagrams/.
// Their display names and order are kept in .canvas/diagrams.json ({ id: name }); a folder missing from it still shows up.

export type Diagram = { id: string; name: string }

const namesFile = () => join(cur().dir, 'diagrams.json')
const names = perProject(() => ({ cache: null as Record<string, string> | null }))
const readNames = async () => (names().cache ??= await readData<Record<string, string>>(namesFile(), 'names', {}))
async function saveNames(next: Record<string, string>) {
  names().cache = next
  await writeData(namesFile(), 'names', next)
}

export async function listDiagrams(): Promise<Diagram[]> {
  const n = await readNames()
  const dir = diagramsDir(cur())
  const folders = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && DIAGRAM_ID.test(d.name)).map((d) => d.name) : []
  const known = Object.keys(n).filter((id) => folders.includes(id))
  const rest = folders.filter((id) => !(id in n)).sort()
  return [{ id: MAIN, name: n[MAIN] || 'Main' }, ...[...known, ...rest].map((id) => ({ id, name: n[id] || id }))]
}

const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60)
const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'diagram'

/** Find a diagram by id or (case-insensitive) name. */
export async function findDiagram(key: string): Promise<Diagram | undefined> {
  const all = await listDiagrams()
  const k = key.trim().toLowerCase()
  return all.find((d) => d.id === key.trim()) ?? all.find((d) => d.name.toLowerCase() === k)
}

export async function createDiagram(rawName: string): Promise<Diagram> {
  const name = cleanName(rawName)
  if (!name) throw new Error('A diagram needs a name.')
  const all = await listDiagrams()
  if (all.some((d) => d.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a diagram called "${name}".`)
  const base = slug(name)
  let id = base
  for (let i = 2; id === MAIN || all.some((d) => d.id === id) || existsSync(join(diagramsDir(cur()), id)); i++) id = `${base}-${i}`
  mkdirSync(join(diagramsDir(cur()), id), { recursive: true })
  await saveNames({ ...(await readNames()), [id]: name })
  broadcast({ type: 'diagrams' })
  return { id, name }
}

export async function renameDiagram(id: string, rawName: string): Promise<Diagram> {
  const name = cleanName(rawName)
  if (!name) throw new Error('A diagram needs a name.')
  const all = await listDiagrams()
  if (!all.some((d) => d.id === id)) throw new Error(`No diagram ${id}.`)
  if (all.some((d) => d.id !== id && d.name.toLowerCase() === name.toLowerCase())) throw new Error(`There is already a diagram called "${name}".`)
  await saveNames({ ...(await readNames()), [id]: name })
  broadcast({ type: 'diagrams' })
  return { id, name }
}

/** Removes the diagram's folder (scene, notes, animations, history). The main diagram cannot be deleted. */
export async function deleteDiagram(id: string) {
  if (id === MAIN) throw new Error('The main diagram cannot be deleted.')
  const p = getProject(cur().id, id)
  if (!p) throw new Error(`No diagram ${id}.`)
  stopWatching(p)
  await rm(join(diagramsDir(p), id), { recursive: true, force: true })
  forgetDiagram(p.id, id)
  const { [id]: _gone, ...rest } = await readNames()
  await saveNames(rest)
  const a = active()
  if (a.id === id) a.id = MAIN
  const t = currentTurn()
  if (t?.diagram === id) t.diagram = MAIN
  broadcast({ type: 'diagrams', deleted: id })
}

// ---------------------------------------------------------------- which diagram Claude works on
const active = perProject(() => ({ id: MAIN }))

/** The browser showed (focused) this diagram. */
export const setActive = (id: string) => void (active().id = id)
export const activeId = () => active().id

/** Claude switched to a diagram: it becomes the target for the rest of the prompt, and the open page moves to it. */
export function openDiagram(id: string) {
  const from = target().diagramId
  setActive(id)
  const t = currentTurn()
  if (t) t.diagram = id
  if (from !== id) broadcast({ type: 'open', id, from })
}

/** The diagram the project-level MCP endpoint (/p/<id>/mcp) works on: the one pinned by the current prompt, otherwise the
 *  one last shown in the browser, falling back to main if it no longer exists. */
export function target(): Project {
  const p = cur()
  const id = currentTurn()?.diagram ?? active().id
  return getProject(p.id, id) ?? getProject(p.id, MAIN)!
}
