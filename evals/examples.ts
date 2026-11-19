// Checks the example gallery: `npx tsx evals/examples.ts`. Every example's call must pass its tool's schema (strictly, so a
// misspelt field fails), the recommender must rank the example's own type first for its text, and, over evals/cases.json,
// it reports how often the closest example is of the expected type: the number that says whether retrieval helps.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { closestExamples, loadExamples } from '../server/examples.ts'
import { recommend } from '../server/recommend.ts'
import { toolShape } from '../server/tools.ts'

const here = dirname(fileURLToPath(import.meta.url))
let bad = 0
for (const e of loadExamples()) {
  const shape = toolShape(e.tool)
  const problems: string[] = []
  if (!shape) problems.push(`no tool ${e.tool}`)
  else {
    const r = z.object(shape).strict().safeParse(e.args)
    if (!r.success) problems.push(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }
  const got = recommend(e.text)[0]?.type
  if (got !== e.type) problems.push(`recommend ranks ${got} first for its text`)
  if (problems.length) bad++
  console.log(`${problems.length ? 'FAIL' : 'ok  '} ${e.id}${problems.length ? `: ${problems.join(' | ')}` : ''}`)
}
const cases: { id: string; text?: string; file?: string; expect: string }[] = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'))
let hit = 0, any = 0
for (const c of cases) {
  const text = c.text ?? readFileSync(join(here, c.file!), 'utf8')
  const ex = closestExamples(text, recommend(text).map((o) => o.type))
  if (ex.length) any++
  if (ex[0]?.type === c.expect) hit++
}
console.log(`\nExamples: ${loadExamples().length - bad}/${loadExamples().length} valid. Retrieval over ${cases.length} cases: closest example of the expected type ${hit}/${cases.length}, some example shown ${any}/${cases.length}.`)
process.exit(bad ? 1 : 0)
