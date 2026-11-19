import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { FORMAT, inspect, prepareProject } from '../server/migrate.ts'
import { END, START, applySection, mcpProblem, mergeMcp, template } from '../server/setup.ts'

const here = dirname(fileURLToPath(import.meta.url))
const BIN = join(here, '..', 'bin', 'canvas.js')
const scratch = mkdtempSync(join(tmpdir(), 'canvas-init-'))
const REGISTRY = join(scratch, 'projects.json')

let n = 0
/** A new empty project folder. */
const folder = () => {
  const d = join(scratch, `p${++n}`)
  mkdirSync(d)
  return d
}
const canvas = (args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, CANVAS_PROJECTS: REGISTRY } })
const read = (f: string) => readFileSync(f, 'utf8')
const registry = () => JSON.parse(read(REGISTRY)) as { id: string; path: string }[]
function snapshot(dir: string) {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(dir, p)] = read(p)
    }
  }
  walk(dir)
  return out
}
const section = (text: string) => text.slice(text.indexOf(START), text.indexOf(END) + END.length)

test('canvas --version prints the version of package.json', () => {
  const r = canvas(['--version'])
  assert.equal(r.status, 0)
  assert.equal(r.stdout.trim(), JSON.parse(read(join(here, '..', 'package.json'))).version)
})

test('init prepares a new project: .canvas/ in the current format, .mcp.json, CLAUDE.md, registry', () => {
  const dir = folder()
  const r = canvas(['init', dir])
  assert.equal(r.status, 0, r.stderr)

  const files = inspect(join(dir, '.canvas'))
  assert.deepEqual(files.map((f) => f.kind).sort(), ['context', 'names', 'rules', 'scene'])
  assert.ok(files.every((f) => f.version === FORMAT))
  assert.deepEqual(JSON.parse(read(join(dir, '.canvas', 'diagram.excalidraw'))).elements, [])
  assert.deepEqual(prepareProject(join(dir, '.canvas')).migrated, []) // nothing left to migrate

  const id = registry().find((p) => p.path === dir)?.id
  assert.ok(id)
  assert.deepEqual(JSON.parse(read(join(dir, '.mcp.json'))), { mcpServers: { canvas: { type: 'http', url: `http://127.0.0.1:8787/p/${id}/mcp` } } })
  const md = read(join(dir, 'CLAUDE.md'))
  assert.equal(section(md), `${START}\n${template().trim()}\n${END}`)
})

test('init twice changes nothing', () => {
  const dir = folder()
  canvas(['init', dir])
  const once = snapshot(dir)
  const reg = read(REGISTRY)
  const r = canvas(['init', dir])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(snapshot(dir), once)
  assert.equal(read(REGISTRY), reg)
})

test('init keeps existing data, other MCP servers and the text around the section', () => {
  const dir = folder()
  cpSync(join(here, 'fixtures', 'v0', '.canvas'), join(dir, '.canvas'), { recursive: true })
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x', args: ['1'] }, canvas: { type: 'sse', url: 'http://old', headers: { a: 'b' } } }, extra: true }))
  writeFileSync(join(dir, 'CLAUDE.md'), '# Project\n\nMy own rules.\n')
  const data = snapshot(join(dir, '.canvas'))

  const r = canvas(['init', dir, '--port', '9001'])
  assert.equal(r.status, 0, r.stderr)
  const after = snapshot(join(dir, '.canvas'))
  for (const [f, text] of Object.entries(data)) assert.equal(after[f], text, `${f} must not change`) // v0 files stay v0 until the server upgrades them
  const mcp = JSON.parse(read(join(dir, '.mcp.json')))
  assert.deepEqual(mcp.mcpServers.other, { command: 'x', args: ['1'] })
  assert.equal(mcp.extra, true)
  assert.equal(mcp.mcpServers.canvas.type, 'http')
  assert.match(mcp.mcpServers.canvas.url, /^http:\/\/127\.0\.0\.1:9001\/p\/[^/]+\/mcp$/)
  assert.deepEqual(mcp.mcpServers.canvas.headers, { a: 'b' })
  assert.match(read(join(dir, 'CLAUDE.md')), /^# Project\n\nMy own rules\.\n\n<!-- canvas:start -->/)
  assert.match(r.stdout, /older format/)
})

test('init --update rewrites only the section between the markers and the canvas fields of .mcp.json', () => {
  const dir = folder()
  canvas(['init', dir])
  const id = registry().find((p) => p.path === dir)!.id
  const data = snapshot(join(dir, '.canvas'))
  const md = read(join(dir, 'CLAUDE.md'))
  // An older installed version had written something else between the markers; the user added text around them and a second server.
  writeFileSync(join(dir, 'CLAUDE.md'), `# Mine\n\nBefore.\n\n${md.replace(template().trim(), 'OLD SECTION TEXT')}\nAfter.\n`)
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' }, canvas: { type: 'http', url: `http://127.0.0.1:8787/p/${id}/mcp`, note: 'mine' } } }))

  const r = canvas(['init', dir, '--update'])
  assert.equal(r.status, 0, r.stderr)
  const now = read(join(dir, 'CLAUDE.md'))
  assert.equal(now, `# Mine\n\nBefore.\n\n${md}\nAfter.\n`)
  assert.deepEqual(snapshot(join(dir, '.canvas')), data)
  const mcp = JSON.parse(read(join(dir, '.mcp.json')))
  assert.deepEqual(mcp.mcpServers.other, { command: 'x' })
  assert.equal(mcp.mcpServers.canvas.note, 'mine')
  assert.equal(mcp.mcpServers.canvas.url, `http://127.0.0.1:8787/p/${id}/mcp`)
  // The port in .mcp.json is kept when none is given.
  canvas(['init', dir, '--port', '9100'])
  assert.match(read(join(dir, '.mcp.json')), /:9100\//)
  canvas(['init', dir, '--update'])
  assert.match(read(join(dir, '.mcp.json')), /:9100\//)
})

test('init --update on a folder that was never set up says so and writes nothing', () => {
  const dir = folder()
  const r = canvas(['init', dir, '--update'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Run: canvas init/)
  assert.deepEqual(readdirSync(dir), [])
})

test('a broken .mcp.json or unbalanced markers stop init without changing the file', () => {
  const dir = folder()
  writeFileSync(join(dir, '.mcp.json'), '{ nope')
  let r = canvas(['init', dir])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not valid JSON/)
  assert.equal(read(join(dir, '.mcp.json')), '{ nope')

  const dir2 = folder()
  writeFileSync(join(dir2, 'CLAUDE.md'), `x\n${START}\nhalf`)
  r = canvas(['init', dir2])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unbalanced/)
  assert.equal(read(join(dir2, 'CLAUDE.md')), `x\n${START}\nhalf`)
})

test('applySection warns about an old hand-written section and mergeMcp creates the file when there is none', () => {
  const a = applySection('# P\n\n## Architecture canvas\n\nold\n', 'new')
  assert.match(a.note ?? '', /old one by hand/)
  assert.ok(a.text.endsWith(`${START}\nnew\n${END}\n`))
  assert.equal(applySection(null, 'x').result, 'created')
  assert.equal(mergeMcp(null, 'http://u').result, 'created')
})

test('mcpProblem names why Claude Code would not find the canvas tools', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-'))
  const url = 'http://127.0.0.1:8787/p/a/mcp'
  assert.match(mcpProblem(dir, url)!, /no \.mcp\.json/)
  writeFileSync(join(dir, '.mcp.json'), '{')
  assert.match(mcpProblem(dir, url)!, /not valid JSON/)
  writeFileSync(join(dir, '.mcp.json'), '{"mcpServers":{}}')
  assert.match(mcpProblem(dir, url)!, /no "canvas"/)
  writeFileSync(join(dir, '.mcp.json'), mergeMcp(null, 'http://127.0.0.1:1/p/a/mcp').text)
  assert.match(mcpProblem(dir, url)!, /points the canvas at/)
  writeFileSync(join(dir, '.mcp.json'), mergeMcp(null, url).text)
  assert.equal(mcpProblem(dir, url), null)
})
