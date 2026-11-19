#!/usr/bin/env node
// canvas [projectDir] [--all] [--port N] [--prod]   start the server for this project (or hand it to the one already running)
// canvas init [dir] [--update] [--port N]   prepare a project (.canvas/, .mcp.json, CLAUDE.md)
// canvas --version
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log(JSON.parse(readFileSync(`${pkg}package.json`, 'utf8')).version)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`canvas [projectDir] [--all] [--port N] [--prod]   serve projectDir (default: .); if canvas already runs on the port, add the project to it. --all shows every project in the registry
canvas init [dir] [--update] [--port N]   prepare dir (default: .) for canvas; --update only refreshes CLAUDE.md and .mcp.json
canvas --version`)
  process.exit(0)
}

const init = args[0] === 'init'
const entry = `${pkg}server/${init ? 'init' : 'index'}.ts`
const tsx = createRequire(import.meta.url).resolve('tsx/cli')
const child = spawn(process.execPath, [tsx, entry, ...(init ? args.slice(1) : args)], { stdio: 'inherit' })
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
child.on('exit', (code) => process.exit(code ?? 0))
