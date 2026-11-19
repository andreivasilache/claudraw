import { randomUUID } from 'node:crypto'
import { MAIN } from './config.ts'
import { emit } from './events.ts'
import { cur } from './project.ts'

type Waiting = { resolve: (png: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
const waiting = new Map<string, Waiting>()

/** Ask the open canvas page to render the given elements (or everything) and send back a PNG as base64. */
export function requestScreenshot(ids: string[], context: boolean): Promise<string> {
  const reqId = randomUUID()
  const { id, diagramId } = cur()
  const page = diagramId === MAIN ? `/p/${id}` : `/p/${id}/d/${diagramId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(reqId)
      reject(new Error(`No screenshot came back. The canvas page of this diagram (${page}) must be open in a browser.`))
    }, 15000)
    waiting.set(reqId, { resolve, reject, timer })
    emit({ type: 'screenshot', reqId, ids, context })
  })
}

/** Called by POST /api/screenshot when the page has rendered the image (or failed to). */
export function finishScreenshot(reqId: string, png: string, error?: string) {
  const w = waiting.get(reqId)
  if (!w) return false
  clearTimeout(w.timer)
  waiting.delete(reqId)
  if (error || !png) w.reject(new Error(error || 'Empty screenshot.'))
  else w.resolve(png)
  return true
}

/** Ask the open canvas page to render an export (PNG as base64, or SVG as text) of the given elements (none = everything). */
export function requestExport(o: { format: 'png' | 'svg'; ids: string[]; scale: number; background: boolean; dark: boolean | null }): Promise<string> {
  const reqId = randomUUID()
  const { id, diagramId } = cur()
  const page = diagramId === MAIN ? `/p/${id}` : `/p/${id}/d/${diagramId}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(reqId)
      reject(new Error(`No export came back. The canvas page of this diagram (${page}) must be open in a browser.`))
    }, 30000)
    waiting.set(reqId, { resolve, reject, timer })
    emit({ type: 'export', reqId, ...o })
  })
}
