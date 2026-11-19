import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAIN, PORT, PROD, addProject, getProject, hiddenProjects, isLocalRequest, listProjects, loadProjects, removeProject, startPath } from './config.ts'
import { activeId, createDiagram, deleteDiagram, listDiagrams, renameDiagram, setActive, target } from './diagrams.ts'
import { cur, runIn, type Project } from './project.ts'
import { getContext, setContext } from './context.ts'
import { contentHash, list } from './history.ts'
import { endTurn, startTurn } from './turn.ts'
import { subscribe } from './events.ts'
import { finishScreenshot } from './screenshot.ts'
import { autoLayout, exportScene, mutate, readScene, saveFromClient, undo, watchDisk } from './scene.ts'
import { seenMcp } from './mcpseen.ts'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { handleUpgrade, killTerminal } from './terminal.ts'
import { httpServer, normalizeCall } from './tools.ts'
import { NOTE_KINDS, NOTE_STATUSES, notes, selection, type NoteKind, type NoteStatus } from './store.ts'
import { diffSince } from './diff.ts'
import { exportDecisions } from './decisions.ts'
import { getAnimations, setAnimations } from './animation.ts'
import { llms, projectLlm, publicSettings, saveSettings } from './llm.ts'
import { VERSION, versionInfo } from './version.ts'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const MAX_BODY = 30_000_000

const send = (res: ServerResponse, code: number, body: unknown) => {
  const data = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) })
  res.end(data)
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > MAX_BODY) throw new Error('too large')
    chunks.push(c)
  }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}')
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
const kind = (v: unknown) => NOTE_KINDS.find((k) => k === v) as NoteKind | undefined
const status = (v: unknown) => NOTE_STATUSES.find((k) => k === v) as NoteStatus | undefined
const ids = (v: unknown) => (Array.isArray(v) ? v.filter((i) => typeof i === 'string').map((i) => i.slice(0, 200)).slice(0, 12) : [])

async function api(req: IncomingMessage, res: ServerResponse, path: string, qs = '') {
  if (req.method === 'GET') {
    if (path === '/api/events') return subscribe(res)
    if (path === '/api/scene') return send(res, 200, await readScene())
    if (path === '/api/state') return send(res, 200, { name: cur().name, notes: await notes.all() })
    if (path === '/api/diagrams') return send(res, 200, { diagrams: await listDiagrams(), current: cur().diagramId })
    if (path === '/api/context') return send(res, 200, getContext())
    if (path === '/api/animation') return send(res, 200, { animations: await getAnimations() })
    if (path === '/api/llms') return send(res, 200, { llms: llms().map(({ id, name, kind }) => ({ id, name, kind })), current: projectLlm(cur().id).id })
    if (path === '/api/diff') {
      const d = await diffSince(new URLSearchParams(qs).get('id') ?? '')
      return d ? send(res, 200, d) : send(res, 404, { error: 'no such history entry' })
    }
    if (path === '/api/export-file') {
      const ids = (new URL(req.url ?? '', 'http://x').searchParams.get('ids') ?? '').split(',').filter(Boolean)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${cur().diagramId}.excalidraw"` })
      return void res.end(JSON.stringify(exportScene(await readScene(), ids)))
    }
    if (path === '/api/history') return send(res, 200, { entries: (await list(contentHash(await readScene()))).slice(0, 40) })
    return send(res, 404, { error: 'not found' })
  }

  const b = await body(req).catch(() => null)
  if (!b) return send(res, 400, { error: 'bad json' })

  if (path === '/api/scene') {
    if (!Array.isArray(b.elements)) return send(res, 400, { error: 'elements required' })
    const diverged = await saveFromClient({ elements: b.elements, appState: b.appState ?? {}, files: b.files ?? {} })
    return send(res, 200, { ok: true, diverged })
  }

  if (path === '/api/selection') {
    selection().ids = ids(b.ids)
    return send(res, 200, { ok: true })
  }
  if (path === '/api/active') {
    setActive(cur().diagramId)
    return send(res, 200, { ok: true })
  }
  if (path === '/api/diagrams') {
    try {
      const id = str(b.id, 100)
      if (b.action === 'create') return send(res, 200, { diagram: await createDiagram(str(b.name, 200)) })
      if (b.action === 'rename') return send(res, 200, { diagram: await renameDiagram(id, str(b.name, 200)) })
      if (b.action === 'delete') return await deleteDiagram(id), send(res, 200, { ok: true })
      return send(res, 400, { error: 'action must be create, rename or delete' })
    } catch (e: any) {
      return send(res, 400, { error: String(e?.message ?? e) })
    }
  }
  if (path === '/api/export-result') {
    return send(res, 200, { ok: finishScreenshot(str(b.reqId, 100), str(b.data, MAX_BODY), str(b.error, 500)) })
  }
  if (path === '/api/screenshot') {
    return send(res, 200, { ok: finishScreenshot(str(b.reqId, 100), str(b.png, MAX_BODY), str(b.error, 500)) })
  }
  if (path === '/api/note-delete') {
    await notes.remove(str(b.id, 20))
    return send(res, 200, { ok: true })
  }

  if (path === '/api/note-add') {
    const target = str(b.target, 200)
    const text = str(b.text, 1000).trim()
    if (!target || !text) return send(res, 400, { error: 'target and text required' })
    const note = await notes.add(target, text, kind(b.kind), status(b.status))
    return send(res, 200, { ok: true, note })
  }
  if (path === '/api/note-update') {
    const text = str(b.text, 1000).trim()
    const ok = await notes.update(str(b.id, 20), { text, kind: kind(b.kind), status: status(b.status) })
    return send(res, 200, { ok })
  }
  if (path === '/api/animation') {
    const animations = await setAnimations(b.animations)
    return send(res, 200, { animations })
  }
  if (path === '/api/decisions-export') return send(res, 200, { file: await exportDecisions() })
  if (path === '/api/context') {
    return send(res, 200, await setContext(b))
  }
  if (path === '/api/layout') {
    const id = str(b.id, 200) || undefined
    return send(res, 200, { message: await mutate((s) => autoLayout(s, id, b.direction === 'TB' ? 'TB' : 'LR'), `auto_layout ${id ?? 'canvas'}`) })
  }
  if (path === '/api/turn') {
    if (b.end) endTurn()
    else startTurn(str(b.text, 500), activeId())
    return send(res, 200, { ok: true })
  }
  if (path === '/api/undo') return send(res, 200, { message: await undo(str(b.id, 40) || undefined) })
  return send(res, 404, { error: 'not found' })
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' }

function serveDist(req: IncomingMessage, res: ServerResponse) {
  const dist = join(PKG, 'dist')
  const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let file = join(dist, rel)
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
  if (!existsSync(file)) return send(res, 500, { error: 'No build found (dist/). Run: npm run build:ui' })
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
}

/** Another canvas already owns the port: hand it this project instead of failing with EADDRINUSE. */
async function attach() {
  const base = `http://127.0.0.1:${PORT}`
  const info = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
  if (typeof info?.version !== 'string') return false
  const path = startPath()
  if (!path) return console.log(`Canvas ${info.version} is already running  ${base}`), true
  const r = await fetch(`${base}/api/projects/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }), signal: AbortSignal.timeout(5000) })
  const e = await r.json().catch(() => ({}))
  if (!r.ok || typeof e.id !== 'string') return console.error(`Canvas is running on ${base} but did not take ${path}: ${e.error ?? r.status}`), process.exit(1)
  console.log(`Canvas ${info.version} is already running; added ${e.name}\n  ${e.id.padEnd(16)} ${base}/p/${e.id}   mcp /p/${e.id}/mcp`)
  return true
}
if (await attach()) process.exit(0)

const vite = PROD ? null : await (await import('vite')).createServer({ root: PKG, server: { middlewareMode: true }, appType: 'spa' })

/** MCP over HTTP for external clients (Claude Code extension / CLI), one endpoint per project. Stateless: one server per request. */
async function mcp(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  const b = await body(req).catch(() => null)
  if (!b) return send(res, 400, { error: 'bad json' })
  const q = new URLSearchParams((req.url ?? '').split('?')[1] ?? '')
  const sets = (q.get('toolsets') ?? String(req.headers['x-mcp-toolsets'] ?? '')).split(',').filter(Boolean)
  const server = await httpServer({ structured: q.has('structured'), toolsets: sets })
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  res.on('close', () => void Promise.all([transport.close(), server.close()]))
  await server.connect(transport)
  await transport.handleRequest(req, res, normalizeCall(b))
}

/** /api/projects*: the project list behind the dashboard page. */
async function projectsApi(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method === 'GET') {
    const withDiagrams = listProjects().map(async (e) => {
      const p = e.exists && e.hasCanvas ? getProject(e.id) : null
      return { ...e, ...(p?.locked ? { locked: p.locked } : {}), diagrams: p && !p.locked ? await runIn(p, listDiagrams).catch(() => []) : [] }
    })
    return send(res, 200, await Promise.all(withDiagrams))
  }
  const b = await body(req).catch(() => null)
  if (!b) return send(res, 400, { error: 'bad json' })
  if (path === '/api/projects/add') {
    try {
      return send(res, 200, addProject(str(b.path, 1000), str(b.name, 100)))
    } catch (e: any) {
      return send(res, 400, { error: String(e?.message ?? e) })
    }
  }
  if (path === '/api/projects/remove') return removeProject(str(b.id, 100)), send(res, 200, { ok: true })
  return send(res, 404, { error: 'not found' })
}

/** /api/settings: the LLMs the side panel can run (edited on the dashboard's settings page). */
async function settingsApi(req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'GET') return send(res, 200, publicSettings())
  const b = await body(req).catch(() => null)
  if (!b) return send(res, 400, { error: 'bad json' })
  try {
    return send(res, 200, saveSettings(b))
  } catch (e: any) {
    return send(res, 400, { error: String(e?.message ?? e) })
  }
}

/** /p/<id>/... is a project's main diagram, /p/<id>/d/<diagram>/... another of its diagrams: the page, API, MCP and terminal.
 *  `pinned` is false for /p/<id>/mcp, which works on whichever diagram the browser (or Claude) has open. */
function projectOf(url: string): { project: Project; rest: string; pinned: boolean } | null {
  const m = /^\/p\/([^/]+)(?:\/d\/([^/]+))?(\/.*)?$/.exec(url.split('?')[0])
  const project = m && getProject(decodeURIComponent(m[1]), m[2] ? decodeURIComponent(m[2]) : MAIN)
  return project ? { project, rest: m[3] ?? '/', pinned: !!m[2] } : null
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  try {
    // /api, /mcp and /pty can read the project and run code, so every method is gated, not just writes.
    const guarded = path.startsWith('/api/') || path.startsWith('/p/')
    if (guarded && !isLocalRequest(req)) return send(res, 403, { error: 'bad origin' })
    if (path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(join(PKG, 'dashboard/index.html')))
    }
    if (path === '/settings') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(readFileSync(join(PKG, 'dashboard/settings.html')))
    }
    if (path.startsWith('/api/projects')) return await projectsApi(req, res, path)
    if (path === '/api/settings') return await settingsApi(req, res)
    if (path === '/api/version') return send(res, 200, versionInfo())
    if (path.startsWith('/p/')) {
      const hit = projectOf(path)
      if (!hit) return send(res, 404, { error: 'unknown project or diagram' })
      const { project, rest, pinned } = hit
      // Data written by a newer claudraw: no reads (their shape is unknown) and no writes, only the reason.
      if (project.locked) {
        if (req.headers.accept?.includes('text/html')) {
          res.writeHead(409, { 'Content-Type': 'text/html; charset=utf-8' })
          return res.end(`<!doctype html><meta charset="utf-8"><title>Project locked</title><body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>This project needs a newer claudraw</h1><p>${project.locked.replace(/[<&]/g, '')}</p><p><a href="/">Back to the project list</a></p>`)
        }
        return send(res, 409, { error: project.locked })
      }
      watchDisk(project)
      if (rest === '/mcp') {
        const p = pinned ? project : runIn(project, target)
        watchDisk(p)
        if (req.method === 'POST') seenMcp(project.id)
        return await runIn(p, () => mcp(req, res))
      }
      if (rest.startsWith('/api/')) return await runIn(project, () => api(req, res, rest, (req.url ?? '').split('?')[1] ?? ''))
      // The page itself: the SPA reads its project id from the URL.
      req.url = '/'
      return vite ? vite.middlewares(req, res) : serveDist(req, res)
    }
    if (path === '/mcp') return send(res, 404, { error: 'The MCP endpoint is per project: /p/<id>/mcp' })
    if (vite) return vite.middlewares(req, res)
    return serveDist(req, res)
  } catch (e: any) {
    console.error(e)
    if (!res.headersSent) send(res, 500, { error: String(e?.message ?? e) })
  }
})

server.on('upgrade', (req, socket, head) => {
  const hit = projectOf(req.url ?? '')
  if (hit?.rest === '/pty') return handleUpgrade(req, socket, head, hit.project)
  // anything else (Vite's own HMR socket) is not ours to answer
})
for (const sig of ['SIGINT', 'SIGTERM'] as const)
  process.on(sig, () => {
    killTerminal()
    process.exit(0)
  })

server.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code !== 'EADDRINUSE') throw e
  console.error(`Port ${PORT} is in use by something that is not canvas. Stop it or pick another port: canvas --port N`)
  process.exit(1)
})
loadProjects()
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Canvas ${VERSION}  http://127.0.0.1:${PORT}`)
  for (const p of listProjects()) console.log(`  ${p.id.padEnd(16)} http://127.0.0.1:${PORT}/p/${p.id}   mcp /p/${p.id}/mcp`)
  if (hiddenProjects()) console.log(`  (${hiddenProjects()} other project${hiddenProjects() > 1 ? 's' : ''} in the list not shown; canvas --all shows every one)`)
})
