// canvas init [dir] [--update] [--port N]
//   (no flag)  prepare dir: .canvas/ (what is missing), the canvas entry in .mcp.json, the canvas section of CLAUDE.md, and the registry
//   --update   only rewrite the canvas section of CLAUDE.md and the canvas fields of .mcp.json, for a newer installed version
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { addProject, listProjects, loadRegistry } from './config.ts'
import { DEFAULT_PORT, initData, mcpId, mcpPort, template, writeMcp, writeSection, type Step } from './setup.ts'

const args = process.argv.slice(2)
const update = args.includes('--update')
const unknown = args.filter((a) => a.startsWith('--') && !['--update', '--port'].includes(a))
const iPort = args.indexOf('--port')
const positional = args.filter((a, i) => !a.startsWith('--') && (iPort < 0 || i !== iPort + 1))

function fail(msg: string): never {
  console.error(`canvas init: ${msg}`)
  process.exit(1)
}

if (unknown.length) fail(`unknown option ${unknown[0]} (usage: canvas init [dir] [--update] [--port N])`)
const root = resolve(positional[0] ?? '.')
if (!existsSync(root) || !statSync(root).isDirectory()) fail(`not a folder: ${root}`)

const portArg = iPort >= 0 ? Number(args[iPort + 1]) : process.env.CANVAS_PORT ? Number(process.env.CANVAS_PORT) : undefined
if (portArg !== undefined && !(Number.isInteger(portArg) && portArg > 0 && portArg < 65536)) fail('--port needs a number between 1 and 65535')
const port = portArg ?? mcpPort(root) ?? DEFAULT_PORT

const steps: Step[] = []
let id: string | undefined
try {
  loadRegistry()
  if (update) {
    id = listProjects().find((p) => p.path === root)?.id ?? mcpId(root)
    if (!id) fail(`${root} is not set up yet. Run: canvas init`)
  } else {
    steps.push(...initData(root))
    const before = listProjects().find((p) => p.path === root)
    id = addProject(root).id
    steps.push({ what: 'registry (~/.config/canvas/projects.json)', result: before ? 'unchanged' : 'created', note: `id ${id}` })
  }
  steps.push(writeMcp(root, `http://127.0.0.1:${port}/p/${id}/mcp`))
  steps.push(writeSection(root, template()))
} catch (e: any) {
  for (const s of steps) console.log(`  ${s.result.padEnd(9)} ${s.what}`)
  fail(String(e?.message ?? e))
}

console.log(`${update ? 'Updated' : 'Initialised'} ${root}`)
for (const s of steps) console.log(`  ${s.result.padEnd(9)} ${s.what}${s.note ? `  (${s.note})` : ''}`)
if (!update) console.log(`\nStart the canvas with: canvas   (then open http://127.0.0.1:${port}/p/${id})`)
