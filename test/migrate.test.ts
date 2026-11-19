import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { FORMAT, MIGRATIONS, inspect, prepareProject, versionOf } from '../server/migrate.ts'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'v0', '.canvas')
const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'))

/** A fresh copy of the v0 fixture, as the `.canvas/` of a throwaway project. */
function project() {
  const root = mkdtempSync(join(tmpdir(), 'canvas-migrate-'))
  const dir = join(root, '.canvas')
  cpSync(FIXTURE, dir, { recursive: true })
  return dir
}
/** Every file under `dir` (except backups) with its content, to compare before and after. */
function snapshot(dir: string, skipBackups = true) {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skipBackups && e.name.startsWith('.backup-')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

test('migrations form an unbroken chain from 0 to FORMAT', () => {
  let v = 0
  for (const m of MIGRATIONS) {
    assert.equal(m.from, v)
    assert.equal(m.to, v + 1)
    v = m.to
  }
  assert.equal(v, FORMAT)
})

test('a file without a version counts as version 0', () => {
  assert.equal(versionOf('notes', { n_a: [] }), 0)
  assert.equal(versionOf('names', { version: 'a diagram called version' }), 0)
  assert.equal(versionOf('scene', { type: 'excalidraw', version: 2 }), 0) // Excalidraw's own version is not ours
  assert.equal(versionOf('scene', { canvasVersion: 1 }), 1)
  assert.equal(versionOf('notes', { version: 1, notes: {} }), 1)
})

test('0 -> 1 brings every file of the v0 fixture to the versioned format and keeps its content', () => {
  const dir = project()
  const before = inspect(dir)
  assert.ok(before.length >= 15 && before.every((f) => f.version === 0))

  const r = prepareProject(dir)
  assert.equal(r.locked, undefined)
  assert.equal(r.migrated.length, before.length)
  assert.ok(inspect(dir).every((f) => f.version === FORMAT))

  assert.deepEqual(read(join(dir, 'notes.json')), { version: 1, notes: read(join(FIXTURE, 'notes.json')) })
  assert.deepEqual(read(join(dir, 'diagrams.json')), { version: 1, names: { plan: 'Plan', rag: 'rag' } })
  assert.deepEqual(read(join(dir, 'rules.json')), { version: 1, rules: 'Reply in the language I write in, concisely.' })
  assert.deepEqual(read(join(dir, 'animation.json')), { version: 1, animations: [{ name: 'Animation 1', steps: [] }] })
  assert.deepEqual(read(join(dir, 'history/index.json')).entries.map((e: any) => e.id), ['h1', 'h2'])
  assert.equal(read(join(dir, 'history/index.json')).version, 1)
  const ctx = read(join(dir, 'context.json'))
  assert.equal(ctx.version, 1)
  assert.equal(ctx.diagrams, 'Architecture of the sample app.')
  assert.equal(ctx.content, 'Older field kept as it was.')
  assert.deepEqual(Object.keys(read(join(dir, 'diagrams/plan/generated.json'))), ['version', 'items'])
  assert.equal(read(join(dir, 'diagrams/plan/generated.json')).items.g1.tool, 'add_columns')
  // The oldest animation format (a bare list of steps) becomes one named animation.
  assert.deepEqual(read(join(dir, 'diagrams/rag/animation.json')), { version: 1, animations: [{ name: 'Animation 1', steps: [{ ids: ['n_a'], caption: 'Old single-list format' }] }] })

  const scene = read(join(dir, 'diagram.excalidraw'))
  assert.equal(scene.canvasVersion, 1)
  assert.equal(scene.version, 2) // Excalidraw's, untouched
  assert.equal(scene.elements.length, 4)
  assert.equal(read(join(FIXTURE, 'diagram.excalidraw')).elements.length, 4)
  // Left alone: the config and the saved scenes next to the history index.
  assert.equal(readFileSync(join(dir, 'canvas.config.json'), 'utf8'), readFileSync(join(FIXTURE, 'canvas.config.json'), 'utf8'))
  assert.equal(readFileSync(join(dir, 'history/h1.json'), 'utf8'), readFileSync(join(FIXTURE, 'history/h1.json'), 'utf8'))
})

test('the originals are copied to .backup-0 first, byte for byte, and git ignores the backups', () => {
  const dir = project()
  prepareProject(dir)
  const backup = join(dir, '.backup-0')
  for (const f of ['notes.json', 'diagrams.json', 'rules.json', 'diagram.excalidraw', 'diagrams/plan/generated.json', 'history/index.json']) {
    assert.equal(readFileSync(join(backup, f), 'utf8'), readFileSync(join(FIXTURE, f), 'utf8'), f)
  }
  const ignore = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n')
  assert.ok(ignore.includes('history/') && ignore.includes('.backup-*/'))
})

test('running it again changes nothing (idempotent), and never overwrites the backup', () => {
  const dir = project()
  prepareProject(dir)
  const once = snapshot(dir)
  const backups = snapshot(join(dir, '.backup-0'), false)
  const again = prepareProject(dir)
  assert.deepEqual(again.migrated, [])
  assert.deepEqual(snapshot(dir), once)
  assert.deepEqual(snapshot(join(dir, '.backup-0'), false), backups)
})

test('a run that stopped half way is finished by the next one, and the backup keeps the originals', () => {
  const dir = project()
  prepareProject(dir)
  // Put one file back as the old version wrote it, as if the earlier run had not got to it.
  writeFileSync(join(dir, 'notes.json'), readFileSync(join(FIXTURE, 'notes.json'), 'utf8').replace('Needs PCI', 'Edited, needs PCI'))
  const r = prepareProject(dir)
  assert.deepEqual(r.migrated.map((m) => relative(dir, m.file)), ['notes.json'])
  assert.equal(read(join(dir, 'notes.json')).notes.n_a[0].text, 'Edited, needs PCI compliance')
  assert.equal(read(join(dir, '.backup-0', 'notes.json')).n_a[0].text, 'Needs PCI compliance') // the first original stays
})

test('a project written by a newer version is not touched and says why', () => {
  const dir = project()
  writeFileSync(join(dir, 'notes.json'), JSON.stringify({ version: FORMAT + 1, notes: {}, shiny: true }))
  const before = snapshot(dir)
  const r = prepareProject(dir)
  assert.match(r.locked ?? '', new RegExp(`format v${FORMAT + 1}`))
  assert.match(r.locked ?? '', /Update claudraw/)
  assert.deepEqual(r.migrated, [])
  assert.deepEqual(snapshot(dir), before)
  assert.equal(existsSync(join(dir, '.backup-0')), false)
})

test('a corrupt file is left as it is; the others still migrate', () => {
  const dir = project()
  writeFileSync(join(dir, 'notes.json'), '{ not json')
  const r = prepareProject(dir)
  assert.equal(r.locked, undefined)
  assert.equal(readFileSync(join(dir, 'notes.json'), 'utf8'), '{ not json')
  assert.equal(read(join(dir, 'rules.json')).version, 1)
})

test('an empty .canvas/ or a missing one has nothing to migrate', () => {
  const root = mkdtempSync(join(tmpdir(), 'canvas-migrate-'))
  assert.deepEqual(prepareProject(join(root, 'nope')).migrated, [])
  mkdirSync(join(root, '.canvas'))
  assert.deepEqual(prepareProject(join(root, '.canvas')).migrated, [])
  assert.equal(statSync(join(root, '.canvas')).isDirectory(), true)
})
