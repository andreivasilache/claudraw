// When an MCP client last called a project's /mcp endpoint. The endpoint is stateless, so this is the only sign that an
// agent actually connected: the terminal uses it to warn when Claude Code started but never found the canvas tools.

const last = new Map<string, number>()
const listeners = new Set<(id: string) => void>()

export function seenMcp(id: string) {
  last.set(id, Date.now())
  for (const l of listeners) l(id)
}
export const lastMcp = (id: string) => last.get(id) ?? 0
export const onMcpSeen = (fn: (id: string) => void) => void listeners.add(fn)
