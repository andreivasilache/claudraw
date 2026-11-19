import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

// The registry path is read when config.ts loads, so point it at a throwaway file first.
const scratch = mkdtempSync(join(tmpdir(), 'canvas-project-'))
process.env.CANVAS_PROJECTS = join(scratch, 'projects.json')

const { addProject, getProject } = await import('../server/config.ts')
const { runIn } = await import('../server/project.ts')
const { notes } = await import('../server/store.ts')
const { listDiagrams, createDiagram } = await import('../server/diagrams.ts')
const { getContext, setContext } = await import('../server/context.ts')
const { getAnimations } = await import('../server/animation.ts')
const { generated } = await import('../server/generated.ts')
const { readScene, mutate } = await import('../server/scene.ts')
const { entries } = await import('../server/history.ts')
const { FORMAT } = await import('../server/migrate.ts')

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v0', '.canvas')
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))
function open(name: string) {
  const root = mkdtempSync(join(scratch, `${name}-`))
  cpSync(FIXTURE, join(root, '.canvas'), { recursive: true })
  const entry = addProject(root, name)
  return { root, id: entry.id, dir: join(root, '.canvas') }
}

test('a v0 project opens, is upgraded once, and every module reads the new shapes', async () => {
  const { id, dir } = open('old')
  const main = getProject(id)!
  assert.ok(main && !main.locked)
  assert.equal(read(join(dir, 'notes.json')).version, FORMAT)

  await runIn(main, async () => {
    assert.equal((await notes.all()).n_b[0].kind, 'question')
    assert.deepEqual((await listDiagrams()).map((d) => d.name), ['Main', 'Plan', 'rag'])
    assert.equal(getContext().rules, 'Reply in the language I write in, concisely.')
    assert.match(getContext().diagrams, /Architecture of the sample app/)
    assert.equal((await getAnimations())[0].name, 'Animation 1')
    assert.equal((await readScene()).elements.length, 4)
    assert.equal((await entries()).length, 2)
  })
  const plan = getProject(id, 'plan')!
  await runIn(plan, async () => {
    assert.equal((await generated.all()).g1.tool, 'add_columns')
    assert.equal((await getAnimations())[0].steps.length, 1)
  })
  await runIn(getProject(id, 'rag')!, async () => assert.equal((await getAnimations())[0].steps[0].caption, 'Old single-list format'))
})

test('what the server writes carries the version, and reads back', async () => {
  const { id, dir } = open('write')
  const main = getProject(id)!
  await runIn(main, async () => {
    await notes.add('n_a', 'Saved by the new version', 'decision')
    await setContext({ rules: 'Be brief.', style: {}, diagrams: 'About it.' })
    const d = await createDiagram('Fresh one')
    assert.equal(d.id, 'fresh-one')
    await mutate((s) => void s.elements.push({ ...s.elements[0], id: 'n_c' }), 'add a box')
  })
  assert.equal(read(join(dir, 'notes.json')).version, FORMAT)
  assert.equal(read(join(dir, 'notes.json')).notes.n_a.at(-1).text, 'Saved by the new version')
  assert.equal(read(join(dir, 'rules.json')).version, FORMAT)
  assert.equal(read(join(dir, 'rules.json')).rules, 'Be brief.')
  assert.equal(read(join(dir, 'context.json')).version, FORMAT)
  assert.equal(read(join(dir, 'diagrams.json')).version, FORMAT)
  assert.equal(read(join(dir, 'diagrams.json')).names['fresh-one'], 'Fresh one')
  assert.equal(read(join(dir, 'diagram.excalidraw')).canvasVersion, FORMAT)
  assert.equal(read(join(dir, 'diagram.excalidraw')).elements.length, 5)
  assert.equal(read(join(dir, 'history', 'index.json')).version, FORMAT)
  assert.equal(read(join(dir, 'history', 'index.json')).entries.length, 3)
})

test('a project from a newer version is locked: no writes, a clear message', async () => {
  const { id, dir } = open('future')
  writeFileSync(join(dir, 'rules.json'), JSON.stringify({ version: FORMAT + 1, rules: 'x' }))
  const before = readFileSync(join(dir, 'notes.json'), 'utf8')
  const p = getProject(id)!
  assert.match(p.locked ?? '', new RegExp(`format v${FORMAT + 1}.*Update claudraw`))
  await runIn(p, async () => {
    await assert.rejects(notes.add('n_a', 'nope'), /Update claudraw/)
    await assert.rejects(setContext({ rules: 'nope', style: {}, diagrams: '' }), /Update claudraw/)
  })
  assert.equal(readFileSync(join(dir, 'notes.json'), 'utf8'), before)
  assert.equal(getProject(id, 'plan')!.locked, p.locked)
})
