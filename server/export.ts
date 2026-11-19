import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertWritable, cur } from './project.ts'
import { exportScene, readScene } from './scene.ts'
import { requestExport } from './screenshot.ts'
import { writeText } from './store.ts'

export type ExportOptions = { format: 'excalidraw' | 'png' | 'svg'; ids?: string[]; name?: string; scale?: number; background?: boolean; dark?: boolean }

/** `exports/` holds generated files, not the project's source: keep it out of git, like history/. */
async function ensureIgnored(dir: string) {
  const file = join(dir, '.gitignore')
  const have = existsSync(file) ? await readFile(file, 'utf8') : ''
  if (!have.split('\n').some((l) => l.trim() === 'exports/')) await writeFile(file, have + (have && !have.endsWith('\n') ? '\n' : '') + 'exports/\n')
}

/** Writes the diagram (or some elements of it) to `<diagram folder>/exports/` and returns the file. PNG and SVG are rendered by
 *  the open canvas page, so they need it open; .excalidraw is written from the saved scene. */
export async function exportDiagram(o: ExportOptions) {
  assertWritable()
  const { dir, diagramId } = cur()
  const base = (o.name?.trim() || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)).replace(/[^\w.-]+/g, '-').slice(0, 80)
  const folder = join(dir, 'exports')
  await mkdir(folder, { recursive: true })
  await ensureIgnored(dir)
  const file = join(folder, `${diagramId}-${base}.${o.format}`)
  if (o.format === 'excalidraw') {
    await writeText(file, JSON.stringify(exportScene(await readScene(), o.ids), null, 2))
  } else {
    const scale = Math.min(Math.max(o.scale ?? 2, 1), 3)
    const data = await requestExport({ format: o.format, ids: o.ids ?? [], scale, background: o.background ?? true, dark: o.dark ?? null })
    await writeFile(file, o.format === 'png' ? Buffer.from(data, 'base64') : data)
  }
  const bytes = (await readFile(file)).length
  return { file, bytes }
}
