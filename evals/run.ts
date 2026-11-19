// Scores recommend() on evals/cases.json: `npx tsx evals/run.ts`. Exits 1 when accuracy drops under THRESHOLD, so a
// change to a rule that breaks other cases is caught before it ships.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { explainsTopic, recommend } from '../server/recommend.ts'

// `explain`: whether plan_diagram should treat it as a topic to explain (true) or as content to lay out (absent = false).
type Case = { id: string; text?: string; file?: string; expect: string; notExpect?: string[]; mentions?: string; explain?: boolean }

const THRESHOLD = 0.9
const here = dirname(fileURLToPath(import.meta.url))
const cases: Case[] = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'))

let passed = 0
const rows = cases.map((c) => {
  const text = c.text ?? readFileSync(join(here, c.file!), 'utf8')
  const opts = recommend(text)
  const got = opts[0]?.type ?? '-'
  const problems = [
    got !== c.expect && `got ${got}`,
    ...(c.notExpect ?? []).filter((t) => got === t).map((t) => `ranked ${t} first`),
    c.mentions && !opts[0]?.shape.includes(c.mentions) && `no "${c.mentions}" in the shape`,
    explainsTopic(text) !== !!c.explain && (c.explain ? 'not seen as a topic to explain' : 'seen as a topic to explain'),
  ].filter(Boolean)
  if (!problems.length) passed++
  return { id: c.id, expect: c.expect, got: opts.map((o) => `${o.type} ${o.score}`).join(', '), pass: problems.length ? `FAIL: ${problems.join('; ')}` : 'ok' }
})
console.table(rows)
const acc = passed / cases.length
console.log(`Accuracy: ${passed}/${cases.length} = ${(acc * 100).toFixed(0)}% (threshold ${THRESHOLD * 100}%)`)
process.exit(acc < THRESHOLD ? 1 : 0)
