import type { ServerResponse } from 'node:http'

import { cur, perProject } from './project.ts'

/** Every open page of the project, with the diagram it shows. */
const clients = perProject(() => new Map<ServerResponse, string>())

export function subscribe(res: ServerResponse) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  })
  res.write(': connected\n\n')
  const all = clients()
  all.set(res, cur().diagramId)
  const ping = setInterval(() => res.write(': ping\n\n'), 20000)
  res.on('close', () => {
    clearInterval(ping)
    all.delete(res)
  })
}

const send = (event: Record<string, unknown>, to: (diagram: string) => boolean) => {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const [c, d] of clients()) if (to(d)) c.write(data)
}

/** To the pages showing the current diagram. */
export const emit = (event: Record<string, unknown>) => {
  const id = cur().diagramId
  send(event, (d) => d === id)
}

/** To every page of the project, whatever diagram it shows (the diagram list changed). */
export const broadcast = (event: Record<string, unknown>) => send(event, () => true)

/** Diagrams that have a page open right now. */
export const openDiagrams = () => new Set(clients().values())
