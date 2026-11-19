import { accessSync, chmodSync, constants } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import type { Duplex } from 'node:stream'
import * as pty from 'node-pty'
import { WebSocket, WebSocketServer } from 'ws'
import { isLocalRequest, PORT } from './config.ts'
import { getLlm, launch, projectLlm, setProjectLlm, type Llm } from './llm.ts'
import type { Project } from './project.ts'
import { lastMcp, onMcpSeen } from './mcpseen.ts'
import { mcpProblem } from './setup.ts'

// A real agent CLI (Claude Code, or OpenCode against another LLM; see llm.ts) running in a pseudo-terminal in the
// project, shown by xterm.js in the page. One shared terminal per project: reloading the page re-attaches to it,
// with the recent output replayed.

const SCROLLBACK = 200_000

type Term = {
  llm: Llm
  term: pty.IPty | null
  exited: number | null
  buffer: string
  size: { cols: number; rows: number }
  clients: Set<WebSocket>
  /** Set when the agent started but never called the canvas endpoint (see watchConnect). */
  noConnect: boolean
  timer?: NodeJS.Timeout
}
const terms = new Map<string, Term>()
const termOf = (p: Project) => {
  let t = terms.get(p.id)
  if (!t) terms.set(p.id, (t = { llm: projectLlm(p.id), term: null, exited: null, buffer: '', size: { cols: 100, rows: 30 }, clients: new Set(), noConnect: false }))
  return t
}

/** Why `claude` could not start. npm can skip node-pty's install script, leaving its prebuilt spawn-helper
 *  without the execute bit (repairHelper fixes that before every start); name that instead of a bare spawn error. */
function startError(cmd: string, e: unknown) {
  let msg = `Could not start "${cmd}": ${e instanceof Error ? e.message : e}`
  try {
    const helper = join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    try {
      accessSync(helper, constants.X_OK)
    } catch (err: any) {
      if (err?.code === 'EACCES') msg += `\r\n${helper} is not executable and could not be fixed here. Run: chmod +x ${helper}`
    }
  } catch {
    /* node-pty not resolvable: the spawn error says enough */
  }
  return `\r\n${msg}\r\n`
}

/** node-pty's prebuilt spawn-helper must be executable. npm can skip install scripts, so make sure here, before every start. */
function repairHelper() {
  try {
    const helper = join(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
    accessSync(helper, constants.X_OK)
  } catch (e: any) {
    if (e?.code === 'EACCES') {
      try {
        chmodSync(e.path, 0o755)
      } catch {
        /* startError explains it if the spawn then fails */
      }
    }
  }
}

/** Whether `file` can be run: a path, or a name on PATH. pty.spawn of a missing command just exits, with no output. */
function runnable(file: string, path = process.env.PATH ?? '') {
  const ok = (f: string) => {
    try {
      accessSync(f, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  return file.includes('/') ? ok(isAbsolute(file) ? file : join(process.cwd(), file)) : path.split(delimiter).some((d) => d && ok(join(d, file)))
}

const INSTALL: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  opencode: 'brew install sst/tap/opencode',
}

const sendAll = (t: Term, msg: Record<string, unknown>) => {
  const data = JSON.stringify(msg)
  for (const c of t.clients) if (c.readyState === WebSocket.OPEN) c.send(data)
}

const mcpUrl = (p: Project) => `http://127.0.0.1:${PORT}/p/${p.id}/mcp`

/** Why the page should warn about setup, or null. Both agents get the canvas tools inline (see launch), so a stale .mcp.json
 *  only matters to a Claude Code started by hand in the project. */
const setupProblem = (p: Project, t: Term) => (t.llm.kind === 'opencode' ? null : mcpProblem(p.root, mcpUrl(p)))
const NO_CONNECT = 'it started but has not called the canvas server yet'
const setupMsg = (p: Project, t: Term) => JSON.stringify({ type: 'setup', problem: t.noConnect ? NO_CONNECT : setupProblem(p, t) })
const sendSetup = (p: Project, t: Term) => {
  const m = setupMsg(p, t)
  for (const c of t.clients) if (c.readyState === WebSocket.OPEN) c.send(m)
}

/** An agent connects to the canvas right after it starts. If none has by then, it is running without the tools (an
 *  unapproved server, a wrong URL, another MCP tool answering instead) and would draw with whatever else it has: warn. */
const CONNECT_WAIT_MS = 20_000
function watchConnect(p: Project, t: Term) {
  clearTimeout(t.timer)
  const started = Date.now()
  t.noConnect = false
  t.timer = setTimeout(() => {
    if (!t.term || lastMcp(p.id) >= started) return
    t.noConnect = true
    sendSetup(p, t)
  }, CONNECT_WAIT_MS)
}
// A late connection clears the warning.
onMcpSeen((id) => {
  const t = terms.get(id)
  if (t?.noConnect) {
    t.noConnect = false
    for (const c of t.clients) if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'setup', problem: null }))
  }
})

function spawn(p: Project, t: Term) {
  t.buffer = ''
  t.exited = null
  const { file, args, env } = launch(t.llm, mcpUrl(p))
  if (!runnable(file, env.PATH ?? process.env.PATH)) {
    const hint = INSTALL[file] ? `Install it with: ${INSTALL[file]}` : 'Check the command'
    throw new Error(`command not found. ${hint}, or set the full path in Settings (http://127.0.0.1:${PORT}/settings).`)
  }
  repairHelper()
  const problem = setupProblem(p, t)
  if (problem) {
    const warn = `\x1b[33mNote: ${problem}. This panel passes the canvas tools to the agent itself, but Claude Code started elsewhere in this project will not have them.\r\nRun "canvas init" in ${p.root} to fix that.\x1b[0m\r\n\r\n`
    t.buffer = warn
    sendAll(t, { type: 'data', data: warn })
  }
  const proc = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: t.size.cols,
    rows: t.size.rows,
    cwd: p.root,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env } as Record<string, string>,
  })
  t.term = proc
  watchConnect(p, t)
  proc.onData((d) => {
    t.buffer = (t.buffer + d).slice(-SCROLLBACK)
    sendAll(t, { type: 'data', data: d })
  })
  proc.onExit(({ exitCode }) => {
    if (t.term !== proc) return // replaced by a restart
    t.term = null
    t.exited = exitCode
    clearTimeout(t.timer)
    t.noConnect = false
    sendAll(t, { type: 'exit', code: exitCode })
  })
}

const wss = new WebSocketServer({ noServer: true })

wss.on('connection', (ws: WebSocket, _req: IncomingMessage, p: Project) => {
  const t = termOf(p)
  t.clients.add(ws)
  ws.on('close', () => t.clients.delete(ws))
  // Settings may have changed since this terminal started; a stopped one picks them up.
  if (!t.term) t.llm = getLlm(t.llm.id) ?? projectLlm(p.id)
  ws.send(JSON.stringify({ type: 'llm', id: t.llm.id, name: t.llm.name }))
  ws.send(setupMsg(p, t))
  if (!t.term && t.exited === null) {
    try {
      spawn(p, t)
    } catch (e) {
      t.buffer = startError(t.llm.command, e) // kept, so a reload still says why
      t.exited = -1
    }
  }
  if (t.buffer) ws.send(JSON.stringify({ type: 'data', data: t.buffer }))
  if (t.exited !== null) ws.send(JSON.stringify({ type: 'exit', code: t.exited }))

  ws.on('message', (raw: unknown) => {
    let m: any
    try {
      m = JSON.parse(String(raw))
    } catch {
      return
    }
    if (m.type === 'input' && typeof m.data === 'string') t.term?.write(m.data)
    else if (m.type === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols > 0 && m.rows > 0) {
      t.size = { cols: Math.min(m.cols, 500), rows: Math.min(m.rows, 200) }
      t.term?.resize(t.size.cols, t.size.rows)
    } else if (m.type === 'restart') {
      // With an llm id: switch this project's terminal to that agent (and remember it for the project).
      const next = typeof m.llm === 'string' ? getLlm(m.llm) : getLlm(t.llm.id)
      if (next) t.llm = next
      if (next && typeof m.llm === 'string') setProjectLlm(p.id, next.id)
      sendAll(t, { type: 'llm', id: t.llm.id, name: t.llm.name })
      clearTimeout(t.timer)
      t.noConnect = false
      sendSetup(p, t)
      const old = t.term
      t.term = null
      old?.kill()
      try {
        spawn(p, t)
        sendAll(t, { type: 'reset' })
      } catch (e) {
        t.exited = -1
        t.buffer = startError(t.llm.command, e)
        sendAll(t, { type: 'reset' })
        sendAll(t, { type: 'data', data: t.buffer })
        sendAll(t, { type: 'exit', code: -1 })
      }
    }
  })
})

/** The terminal is a shell on this machine, so only the canvas page itself (same local origin) may connect. */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, p: Project) {
  if (!isLocalRequest(req, true)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, p))
}

export const killTerminal = () => {
  for (const t of terms.values()) t.term?.kill()
}
