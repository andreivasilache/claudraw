import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProject } from './config.ts'
import { listDiagrams } from './diagrams.ts'
import { cur, runIn } from './project.ts'
import { find, plainText, readScene } from './scene.ts'
import { notes, statusOf, type NoteStatus } from './store.ts'

const SECTIONS: { status: NoteStatus; title: string }[] = [
  { status: 'open', title: 'Open questions' },
  { status: 'decided', title: 'Decided' },
  { status: 'reversed', title: 'Reversed' },
]

/** The notes that carry a status (decisions and questions) of every diagram, grouped by status, as markdown.
 *  With more than one diagram, each gets its own section. */
export async function renderDecisions(): Promise<string> {
  const diagrams = await listDiagrams()
  const out = [`# Decisions`, '', `Generated from the canvas notes (${cur().name}). Edit the notes on the canvas, not this file.`]
  if (diagrams.length === 1) out.push(...(await renderOne('##')))
  else
    for (const d of diagrams) {
      const p = getProject(cur().id, d.id)
      if (p) out.push('', `## ${d.name}`, ...(await runIn(p, () => renderOne('###'))))
    }
  return out.join('\n') + '\n'
}

/** The current diagram's sections, as lines. */
async function renderOne(h: string): Promise<string[]> {
  const scene = await readScene()
  const all = Object.entries(await notes.all()).flatMap(([node, list]) =>
    list.flatMap((n) => {
      const status = statusOf(n)
      if (!status) return []
      const el = find(scene, node)
      // Notes of a deleted box stay saved for undo, but they are not part of the diagram now.
      if (!el) return []
      const name = plainText(scene, el) || node
      return [{ n, status, name }]
    }),
  )
  const out: string[] = []
  for (const { status, title } of SECTIONS) {
    const rows = all.filter((r) => r.status === status).sort((a, b) => a.n.date.localeCompare(b.n.date))
    if (!rows.length) continue
    out.push('', `${h} ${title}`, '')
    for (const { n, name } of rows) out.push(`- **${name}**: ${n.text.replace(/\s+/g, ' ')} _(${n.date.slice(0, 10)}, ${n.id})_`)
  }
  if (!out.length) out.push('', '_No decisions or open questions yet._')
  return out
}

/** Write DECISIONS.md in the project root and return its path. */
export async function exportDecisions() {
  const file = join(cur().root, 'DECISIONS.md')
  await writeFile(file, await renderDecisions())
  return file
}
