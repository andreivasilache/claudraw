// Claude Code hook (UserPromptSubmit: `node turn.mjs start`, Stop: `node turn.mjs end`). Tells the canvas server which prompt
// is being worked on, so the history can label and group Claude's changes by prompt. Silent and best-effort: never blocks Claude.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()
  const url = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers?.canvas?.url
  if (url) {
    const end = process.argv[2] === 'end'
    await fetch(url.replace(/\/mcp$/, '/api/turn'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(end ? { end: true } : { text: String(input.prompt ?? '') }),
      signal: AbortSignal.timeout(1500),
    })
  }
} catch {
  /* canvas not running: nothing to label */
}
