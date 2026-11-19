// Claude Code Stop hook. If this turn used the canvas tools but saved no note, ask Claude once whether
// anything was settled that should be remembered. Turns that never touched the canvas are left alone.
import { readFileSync } from 'node:fs'

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
if (input.stop_hook_active || !input.transcript_path) process.exit(0) // never loop

let lines = []
try {
  lines = readFileSync(input.transcript_path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
} catch {
  process.exit(0)
}

const PREFIX = 'mcp__canvas__'
const isPrompt = (m) =>
  m.type === 'user' &&
  !m.isMeta &&
  (typeof m.message?.content === 'string' || m.message?.content?.some?.((b) => b.type === 'text'))
const start = lines.findLastIndex(isPrompt)
// Notes also come with the drawing calls themselves (`notes` on an item), which count as saved.
const hasNotes = (v) => Array.isArray(v) ? v.some(hasNotes) : !!v && typeof v === 'object' && Object.entries(v).some(([k, x]) => (k === 'notes' && Array.isArray(x) && x.length > 0) || hasNotes(x))
const used = new Set()
let noted = false
for (const m of lines.slice(start + 1))
  if (m.type === 'assistant')
    for (const b of m.message?.content ?? [])
      if (b.type === 'tool_use' && b.name?.startsWith(PREFIX)) {
        used.add(b.name.slice(PREFIX.length))
        if (hasNotes(b.input)) noted = true
      }

if (!used.size || noted || used.has('add_note') || used.has('delete_note')) process.exit(0)

console.log(
  JSON.stringify({
    decision: 'block',
    reason:
      'Canvas check: this turn used the canvas but saved no note. If a decision (with its reason), a fact or an open question about a box was settled, save it now with add_note on the right node id, one or two sentences. If nothing was settled, reply only "No notes needed."',
  }),
)
