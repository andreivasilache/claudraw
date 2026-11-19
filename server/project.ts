import { AsyncLocalStorage } from 'node:async_hooks'

/** One diagram of a registered project, as seen by a request. The rules file and the terminal are shared by every
 *  diagram of the project; the context, scene, notes, animations and history belong to the diagram. */
export type Project = {
  id: string
  name: string
  root: string
  dir: string
  /** This diagram's context (style, what it is about); main keeps .canvas/context.json. */
  contextFile: string
  /** How Claude should work with the user, the same for every diagram of the project. */
  rulesFile: string
  /** 'main' for the project's original diagram, otherwise the folder name under .canvas/diagrams/. */
  diagramId: string
  diagram: string
  notesFile: string
  animationFile: string
  historyDir: string
  /** Why this project must not be written to (its data is in a newer format than this tool knows); undefined when fine. */
  locked?: string
}

// One server serves every project. The request (or MCP call) runs inside its diagram's scope, and the modules
// that keep state look it up with perDiagram() / perProject() instead of using globals.
const scope = new AsyncLocalStorage<Project>()
export const runIn = <T>(p: Project, fn: () => T): T => scope.run(p, fn)

/** Throws when the project in scope is locked. Every write to `.canvas/` goes through writeText or calls this first. */
export function assertWritable() {
  const p = scope.getStore()
  if (p?.locked) throw new Error(p.locked)
}

export function cur(): Project {
  const p = scope.getStore()
  if (!p) throw new Error('No project in scope.')
  return p
}

/** State kept per diagram (scene, notes, history...), created on first use. Returns an accessor for the current diagram's copy. */
export function perDiagram<T>(init: (p: Project) => T): () => T {
  const all = new WeakMap<Project, T>()
  return () => {
    const p = cur()
    let v = all.get(p)
    if (v === undefined) all.set(p, (v = init(p)))
    return v
  }
}

/** State shared by every diagram of a project (context, current prompt, active diagram). */
export function perProject<T>(init: (p: Project) => T): () => T {
  const all = new Map<string, T>()
  return () => {
    const p = cur()
    let v = all.get(p.id)
    if (v === undefined) all.set(p.id, (v = init(p)))
    return v
  }
}
