import dagre from '@dagrejs/dagre'
import ELK from 'elkjs/lib/elk.bundled.js'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { cur, perDiagram, runIn, type Project } from './project.ts'
import { emit } from './events.ts'
import { styleValues } from './context.ts'
import { contentHash, entries as historyEntries, peek, push } from './history.ts'
import { currentTurn } from './turn.ts'
import { PALETTE } from './palette.ts'
import { pruneAnimations } from './animation.ts'
import { FORMAT, emptyScene as baseScene } from './migrate.ts'
import { withLock, writeText } from './store.ts'

export type El = Record<string, any> & { id: string; type: string }
export type Scene = {
  type: 'excalidraw'
  version: 2
  /** The format of the data files (migrate.ts); Excalidraw's own `version` above is another thing. */
  canvasVersion?: number
  source: string
  elements: El[]
  appState: Record<string, any>
  files: Record<string, any>
}

const emptyScene = (): Scene => baseScene()

// ---------------------------------------------------------------- persistence
// `json` is `cache` serialised, when this process wrote it; `written` is the file's size and mtime after that write.
const mem = perDiagram(() => ({ cache: null as Scene | null, json: null as string | null, lastHash: '', written: '', watcher: null as FSWatcher | null, lastManual: 0, restored: undefined as string | null | undefined, rev: 0, sigs: new Map<string, string>(), touched: new Map<string, number>() }))
const hash = (s: string) => createHash('sha1').update(s).digest('hex')
const serialize = (s: Scene) => JSON.stringify(s.canvasVersion === FORMAT ? s : { ...s, canvasVersion: FORMAT })
const fileStamp = async (file: string) => {
  const st = await stat(file)
  return `${st.size}:${st.mtimeMs}`
}

export async function readScene(): Promise<Scene> {
  const m = mem()
  if (m.cache) return m.cache
  const { diagram } = cur()
  if (!existsSync(diagram)) return (m.cache = emptyScene())
  const raw = await readFile(diagram, 'utf8')
  m.lastHash = hash(raw.trim())
  m.cache = { ...emptyScene(), ...JSON.parse(raw) }
  m.json = null
  m.sigs = new Map(m.cache!.elements.map((e) => [e.id, JSON.stringify(e)])) // what is on disk is revision 0
  return m.cache!
}

/** The current scene serialised, reusing the string from the last write. */
const currentJson = (m: ReturnType<typeof mem>, s: Scene) => (m.json ??= serialize(s))

/** Revision of the open scene: bumped by every save (the agent's, the browser's, undo's). Memory only, so it restarts at 0 with the server. */
export const revision = () => mem().rev

/** Notes which elements this save changed, added or removed, against the revision they changed in (for conflict checks). */
function trackChanges(m: ReturnType<typeof mem>, scene: Scene) {
  m.rev++
  const next = new Map<string, string>()
  for (const e of scene.elements) {
    const sig = JSON.stringify(e)
    next.set(e.id, sig)
    if (m.sigs.get(e.id) !== sig) m.touched.set(e.id, m.rev)
  }
  for (const id of m.sigs.keys()) if (!next.has(id)) m.touched.set(id, m.rev)
  m.sigs = next
}

/** Throws when one of `ids` changed after revision `baseRev` (the page or an earlier call changed it since the caller read it). */
function checkBase(ids: string[], baseRev: number) {
  const m = mem()
  if (baseRev > m.rev) return // the server restarted since that read: nothing to compare with
  const changed = [...new Set(ids)].filter((id) => (m.touched.get(id) ?? 0) > baseRev)
  if (changed.length) throw new Error(`Conflict: ${changed.join(', ')} changed since rev ${baseRev} (now rev ${m.rev}), probably by the user on the canvas or by an earlier call. Read it again (get_node / find_nodes) and retry with the new baseRev.`)
}

async function persist(scene: Scene, json = serialize(scene)) {
  const m = mem()
  trackChanges(m, scene)
  const { diagram } = cur()
  m.cache = scene
  m.json = json
  m.lastHash = hash(json)
  await writeText(diagram, json)
  m.written = await fileStamp(diagram)
  // Steps that point at deleted boxes would otherwise stay in the animations forever.
  await pruneAnimations(new Set(scene.elements.filter((e) => !e.isDeleted).map((e) => e.id)))
}

/** Keep, per element id, the copy with the higher version (ties keep the server's). */
function merge(server: El[], incoming: El[]): El[] {
  const byId = new Map(server.map((e) => [e.id, e]))
  for (const e of incoming) {
    const cur = byId.get(e.id)
    if (!cur || (e.version ?? 0) > (cur.version ?? 0)) byId.set(e.id, e)
  }
  // Keep the incoming order (z-order) first, then anything only the server has.
  const seen = new Set<string>()
  const out: El[] = []
  for (const e of incoming) {
    out.push(byId.get(e.id)!)
    seen.add(e.id)
  }
  for (const e of server) if (!seen.has(e.id)) out.push(byId.get(e.id)!)
  return out
}

const MANUAL_GAP = 60_000

/** The browser saved its scene. Returns true if the merged result differs from what it sent. */
export function saveFromClient(incoming: Pick<Scene, 'elements' | 'appState' | 'files'>) {
  return withLock(async () => {
    const cur = await readScene()
    const elements = merge(cur.elements, incoming.elements)
    const next: Scene = {
      ...cur,
      elements,
      appState: { ...cur.appState, ...incoming.appState },
      files: { ...cur.files, ...incoming.files },
    }
    const json = serialize(next)
    if (json === currentJson(mem(), cur)) return false
    // Edits made on the page are versions too, one per stretch of work.
    if (contentHash(next) !== contentHash(cur)) {
      const m = mem()
      const now = Date.now()
      const fresh = now - m.lastManual < MANUAL_GAP
      m.lastManual = now
      if (await push(cur, 'Manual edit', { source: 'you', mergeIf: (l) => fresh && l.source === 'you' })) emit({ type: 'history' })
    }
    await persist(next, json)
    const diverged = elements.some((e, i) => e !== incoming.elements[i])
    if (diverged) emit({ type: 'scene' })
    return diverged
  })
}

/** Run a change on behalf of Claude; the browser is told to reload. The scene as it was is kept for undo. */
export function mutate<T>(fn: (s: Scene) => T, label = 'change', guard?: { ids: string[]; baseRev: number }): Promise<T> {
  return withLock(async () => {
    const before = await readScene()
    if (guard) checkBase(guard.ids, guard.baseRev)
    const s = structuredClone(before)
    const result = fn(s)
    const json = serialize(s)
    if (json === currentJson(mem(), before)) return result
    // Everything Claude changes during one prompt is one version: the scene as it was before the prompt.
    const turn = currentTurn()
    await push(before, turn?.text ?? label, { source: 'claude', turn: turn?.id, mergeIf: turn ? (l) => l.turn === turn.id : undefined })
    emit({ type: 'history' })
    mem().restored = null
    await persist(s, json)
    emit({ type: 'scene' })
    return result
  })
}

/** Go back to a version (`id`; without it the one before where the canvas is now). Nothing is removed from the history:
 *  the version being left is added as the newest entry, so a wrong go-back can itself be undone from the top of the list. */
export function undo(id?: string): Promise<string> {
  return withLock(async () => {
    const cur = await readScene()
    const here = contentHash(cur)
    const list = await historyEntries()
    let at = list.map((e) => e.hash).lastIndexOf(here)
    // The canvas can match an old version by chance (empty after clear, say): right after a change it is not "at" that
    // version, so undo goes to the version before the change. Only after an undo is it at the version it restored.
    const m = mem()
    if (at !== -1 && m.restored === null) at = -1
    const entry = id ? list.find((e) => e.id === id) : list[at === -1 ? list.length - 1 : at - 1]
    if (!entry) return id ? `No history entry ${id}.` : 'Nothing to undo.'
    if (entry.hash === here) return 'The canvas is already at that version.'
    const taken = await peek(entry.id)
    if (!taken) return `No history entry ${entry.id}.`
    // Every go-back records the scene it leaves, in order, so the list reads as a timeline and the step can be reversed.
    if (list[list.length - 1]?.hash !== here) await push(cur, `Before going back to: ${entry.label}`, { source: 'latest' })
    // The browser keeps the higher version of every element, so a restored scene must out-version the current one.
    const bump = (e: El): El => ({ ...e, version: (e.version ?? 0) + 1, versionNonce: randomBytes(4).readUInt32BE(), updated: Date.now() })
    const curById = new Map(cur.elements.map((e) => [e.id, e]))
    const back = new Set<string>(taken.scene.elements.map((e: El) => e.id))
    const elements: El[] = [
      ...taken.scene.elements.map((e: El) => bump({ ...e, version: Math.max(e.version ?? 0, curById.get(e.id)?.version ?? 0) })),
      ...cur.elements.filter((e) => !back.has(e.id)).map((e) => (e.isDeleted ? e : bump({ ...e, isDeleted: true }))),
    ]
    await persist({ ...cur, elements, files: { ...cur.files, ...taken.scene.files } })
    m.lastManual = 0 // the page echoing the restored scene back is not a manual edit
    m.restored = entry.hash
    emit({ type: 'scene' })
    emit({ type: 'history' })
    return `Restored the version before: ${entry.label}.`
  })
}

/** Pick up edits made to the file outside the app (CLI, extension, editor). Starts once per diagram, on first use. */
export function watchDisk(p: Project) {
  runIn(p, () => {
    const m = mem()
    if (m.watcher) return
    let timer: NodeJS.Timeout | undefined
    m.watcher = watch(dirname(p.diagram), (_ev, name) => {
      if (name !== basename(p.diagram)) return
      clearTimeout(timer)
      timer = setTimeout(
        () =>
          runIn(p, async () => {
            try {
              if ((await fileStamp(p.diagram)) === m.written) return // our own write
              const raw = (await readFile(p.diagram, 'utf8')).trim()
              if (hash(raw) === m.lastHash) return
              m.lastHash = hash(raw)
              m.cache = { ...emptyScene(), ...JSON.parse(raw) }
              m.json = null
              trackChanges(m, m.cache!)
              emit({ type: 'scene' })
            } catch {
              /* half-written file: the next event will retry */
            }
          }),
        150,
      )
    })
    m.watcher.on('error', () => stopWatching(p)) // the folder went away (diagram deleted)
  })
}

export function stopWatching(p: Project) {
  runIn(p, () => {
    const m = mem()
    m.watcher?.close()
    m.watcher = null
  })
}

// ---------------------------------------------------------------- reading
const alive = (s: Scene) => s.elements.filter((e) => !e.isDeleted)
const LINEAR = new Set(['arrow', 'line'])
const SHAPES = new Set(['rectangle', 'ellipse', 'diamond', 'frame', 'magicframe'])
const BINDABLE = new Set(['rectangle', 'diamond', 'ellipse', 'text', 'image', 'iframe', 'embeddable', 'frame', 'magicframe'])

export const find = (s: Scene, id: string) => alive(s).find((e) => e.id === id)
const boundText = (s: Scene, id: string) => alive(s).find((e) => e.type === 'text' && e.containerId === id)
export const textOf = (s: Scene, e: El) => (e.type === 'text' ? e.text : (boundText(s, e.id)?.text ?? '')) as string

/** A box, frame, ellipse, diamond or free text: what the diagram calls a node (not arrows, lines, drawings or a box's own label). */
export const isNode = (e: El) => !e.isDeleted && !LINEAR.has(e.type) && e.type !== 'freedraw' && !(e.type === 'text' && e.containerId)
/** Placed exactly where and as big as asked (add_shapes, exact boxes): the layout check and fix_layout leave it alone,
 *  since a label on a bar or a logo on a box's corner overlaps on purpose. */
const isExact = (e: El) => e.customData?.exact === true
const markExact = (e: El) => ((e.customData = { ...(e.customData ?? {}), exact: true }), e)
/** The smaller explanation under a box's title: a free text that belongs to the box (customData.of). */
const isDetail = (e: El) => e.type === 'text' && e.customData?.role === 'detail'
const detailOf = (s: Scene, id: string) => alive(s).find((e) => isDetail(e) && e.customData.of === id)
/** A node's text (or a frame's name) on one line. */
export const plainText = (s: Scene, e: El) => (textOf(s, e) || e.name || '').replace(/\s+/g, ' ').trim()
const area = (e: El) => Math.abs(e.width * e.height)
const center = (e: El) => ({ x: e.x + e.width / 2, y: e.y + e.height / 2 })

function containedIn(s: Scene, parent: El): El[] {
  if (!SHAPES.has(parent.type)) return []
  return alive(s)
    .filter((c) => {
      if (c.id === parent.id || !isNode(c) || area(c) >= area(parent) * 0.9) return false
      const p = center(c)
      return p.x > parent.x && p.x < parent.x + parent.width && p.y > parent.y && p.y < parent.y + parent.height
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
}

const label = (s: Scene, e: El) => {
  const t = plainText(s, e)
  return t ? (t.length > 80 ? t.slice(0, 80) + '…' : t) : `(${e.type})`
}

function connections(s: Scene, id: string): string[] {
  const out: string[] = []
  for (const a of alive(s)) {
    if (a.type !== 'arrow') continue
    const from = a.startBinding?.elementId
    const to = a.endBinding?.elementId
    if (from !== id && to !== id) continue
    const other = find(s, from === id ? to : from)
    const via = textOf(s, a)
    const o = other ? `${other.id} "${label(s, other)}"` : '(unbound)'
    out.push(from === id ? `→ ${o}${via ? ` [${via}]` : ''}` : `← ${o}${via ? ` [${via}]` : ''}`)
  }
  return out
}

export function describeNode(s: Scene, id: string, limit = 2500): string {
  const e = find(s, id)
  if (!e) return `### ${id}\n(not found on the canvas)`
  const lines = [`### ${id} (${e.type})`]
  const text = textOf(s, e)
  if (text) lines.push(text)
  const detail = detailOf(s, e.id)
  if (detail) lines.push(`detail (${detail.id}): ${(detail.customData.text ?? detail.text).replace(/\s+/g, ' ').trim()}`)
  const look = styleSummary(s, e)
  if (look) lines.push(`style: ${look}`)
  const inner = containedIn(s, e).filter((c) => c !== detail)
  if (inner.length) {
    lines.push('contains:')
    for (const c of inner) lines.push(`- ${c.id}: ${label(s, c)}`)
  }
  const conn = connections(s, id)
  if (conn.length) lines.push('connections:', ...conn)
  const out = lines.join('\n')
  return out.length > limit ? out.slice(0, limit) + ' …' : out
}

/** The properties of an element that differ from a plain new one, in the terms update_node's style takes. */
function styleSummary(s: Scene, e: El) {
  const out: string[] = [`@${Math.round(e.x)},${Math.round(e.y)} ${Math.round(e.width)}x${Math.round(e.height)}`]
  const t = e.type === 'text' ? e : boundText(s, e.id)
  if (e.strokeColor && e.strokeColor !== '#1e1e1e') out.push(`stroke ${e.strokeColor}`)
  if (e.backgroundColor && e.backgroundColor !== 'transparent') out.push(`background ${e.backgroundColor} (${e.fillStyle})`)
  if (e.strokeWidth && e.strokeWidth !== 2) out.push(`strokeWidth ${e.strokeWidth}`)
  if (e.strokeStyle && e.strokeStyle !== 'solid') out.push(e.strokeStyle)
  if (e.opacity !== undefined && e.opacity !== 100) out.push(`opacity ${e.opacity}`)
  if (e.angle) out.push(`angle ${Math.round((e.angle * 180) / Math.PI)}°`)
  const rough = Object.entries(ROUGH).find(([, v]) => v === e.roughness)?.[0]
  if (rough) out.push(`sloppiness ${rough}`)
  if (SHAPES.has(e.type) && e.type !== 'ellipse') out.push(e.roundness ? 'round edges' : 'sharp edges')
  if (t) {
    const font = Object.entries(FONTS).find(([, v]) => v === t.fontFamily)?.[0] ?? t.fontFamily
    out.push(`font ${font} ${t.fontSize}px, align ${t.textAlign}${t.verticalAlign && t.verticalAlign !== 'middle' ? `/${t.verticalAlign}` : ''}`)
  }
  if (LINEAR.has(e.type)) {
    out.push(`${e.points?.length ?? 0} points`, e.elbowed ? 'elbow' : e.roundness ? 'curved' : 'sharp')
    if (e.startArrowhead || e.endArrowhead) out.push(`arrowheads ${e.startArrowhead ?? 'none'} → ${e.endArrowhead ?? 'none'}`)
  }
  if (e.type === 'image') out.push(`image ${s.files?.[e.fileId]?.mimeType ?? '(file missing)'}`)
  if (e.type === 'frame' || e.type === 'magicframe') out.push(`frame "${e.name ?? ''}"`)
  if (e.frameId) out.push(`in frame ${e.frameId}`)
  if (e.groupIds?.length) out.push(`groups ${e.groupIds.join(', ')}`)
  if (e.link) out.push(`link ${e.link}`)
  if (e.locked) out.push('locked')
  return out.join(', ')
}

/** The nodes (boxes, frames, free texts, images, embeds); with `all` also lines, arrows and drawings. A box's detail
 *  text is part of its box (get_node shows it), not a node of its own. */
export function listNodes(s: Scene, all = false) {
  return alive(s)
    .filter((e) => (all ? !(e.type === 'text' && e.containerId) : isNode(e)) && !isDetail(e))
    .map((e) => nodeRow(s, e))
}
const nodeRow = (s: Scene, e: El) => ({
  id: e.id,
  type: e.type,
  text: label(s, e),
  x: Math.round(e.x),
  y: Math.round(e.y),
  w: Math.round(e.width),
  h: Math.round(e.height),
})

/** Case- and separator-insensitive form: "Auth Flow", "auth-flow" and "authflow" are the same. */
const squash = (t: string) => t.toLowerCase().replace(/[\s\-_]+/g, '')
const MAX_GLOB = 200

/** A glob (`*` any run, `?` one character) as a case-insensitive whole-text regex; null when it is too long or has too many `*`. */
function globRegex(pattern: string): RegExp | null {
  if (pattern.length > MAX_GLOB) return null
  const p = pattern.replace(/\*+/g, '*')
  if ((p.match(/\*/g) ?? []).length > 8) return null
  const re = [...p].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${re}$`, 'is')
}

export type NodeSearch = { query?: string; mode?: 'contains' | 'glob'; types?: string[]; frameId?: string; limit?: number }

/** The nodes whose text (title, or the explanation under it) matches `query`, optionally only of some `types` or inside a frame/box.
 *  Returns the rows list_nodes would, plus how many matched in all. Lines, arrows and drawings are searched only when `types` names them. */
export function searchNodes(s: Scene, o: NodeSearch) {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 200)
  const query = o.query?.trim() ?? ''
  const glob = o.mode === 'glob' && query ? globRegex(query) : null
  if (o.mode === 'glob' && query && !glob) throw new Error(`The glob is too long (max ${MAX_GLOB} characters) or has more than 8 "*".`)
  const needle = squash(query)
  const types = o.types?.map((t) => t.toLowerCase())
  const linear = !!types?.some((t) => LINEAR.has(t) || t === 'freedraw')
  let scope: Set<string> | null = null
  if (o.frameId) {
    const frame = find(s, o.frameId)
    if (!frame) throw new Error(`No element with id ${o.frameId}`)
    scope = new Set([...alive(s).filter((e) => e.frameId === frame.id).map((e) => e.id), ...containedIn(s, frame).map((e) => e.id)])
  }
  const hits = alive(s).filter((e) => {
    if (!(linear ? !(e.type === 'text' && e.containerId) : isNode(e)) || isDetail(e)) return false
    if (types && !types.includes(e.type)) return false
    if (scope && !scope.has(e.id)) return false
    if (!query) return true
    const hay = [plainText(s, e), detailOf(s, e.id)?.text ?? ''].map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
    return glob ? hay.some((t) => glob.test(t)) : hay.some((t) => squash(t).includes(needle))
  })
  return { total: hits.length, nodes: hits.slice(0, limit).map((e) => nodeRow(s, e)) }
}

// ---------------------------------------------------------------- writing
const rand = () => Math.floor(Math.random() * 2 ** 31)
const newId = () => `n_${randomBytes(4).toString('hex')}`
const bump = (e: El) => {
  e.version = (e.version ?? 0) + 1
  e.versionNonce = rand()
  e.updated = Date.now()
}

function base(type: string, x: number, y: number, width: number, height: number, extra: Record<string, any> = {}): El {
  return {
    id: newId(),
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: st().roughness,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: rand(),
    version: 1,
    versionNonce: rand(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
    ...extra,
  }
}

const st = styleValues
const CHAR_W = 0.55
const LINE_H = 1.25

/** Break text on spaces so no line is wider than maxW (estimated). Existing line breaks are kept. */
export function wrapText(text: string, maxW: number, fontSize = st().fontSize) {
  const max = Math.max(4, Math.floor(maxW / (fontSize * CHAR_W)))
  return text
    .split('\n')
    .flatMap((para) => {
      const lines: string[] = []
      let cur = ''
      for (const w of para.split(/\s+/).filter(Boolean)) {
        if (cur && (cur + ' ' + w).length > max) {
          lines.push(cur)
          cur = w
        } else cur = cur ? cur + ' ' + w : w
      }
      lines.push(cur)
      return lines
    })
    .join('\n')
}

const approxSize = (text: string, fontSize: number) => {
  const lines = text.split('\n')
  return {
    width: Math.max(10, Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_W),
    height: lines.length * fontSize * LINE_H,
  }
}

function fontFamily(s: Scene) {
  return st().fontFamily ?? alive(s).find((e) => e.type === 'text')?.fontFamily ?? 5
}

function makeText(s: Scene, text: string, x: number, y: number, containerId: string | null, fontSize = st().fontSize): El {
  const { width, height } = approxSize(text, fontSize)
  return base('text', x, y, width, height, {
    text,
    originalText: text,
    fontSize,
    fontFamily: fontFamily(s),
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId,
    autoResize: true,
    lineHeight: 1.25,
  })
}

const attach = (container: El, child: El) => {
  container.boundElements = [...(container.boundElements ?? []), { id: child.id, type: child.type }]
  bump(container)
}

/** How much of a shape's width and height its text can use: Excalidraw fits bound text into the rectangle inscribed in a diamond or ellipse. */
const room = (type: string) => (type === 'diamond' ? 0.5 : type === 'ellipse' ? 0.7 : 1)

/**
 * Where Excalidraw draws a box's text for its alignment: centred, or 10px in from a side, the top or the bottom of the
 * area a diamond or ellipse leaves for it. The page only recomputes this when the box is edited, so the scene must
 * already hold it, or "align left" shows as centred.
 */
function placeText(c: El, t: El) {
  const f = room(c.type)
  const ix = c.x + (c.width * (1 - f)) / 2, iy = c.y + (c.height * (1 - f)) / 2
  t.x = t.textAlign === 'left' ? ix + 10 : t.textAlign === 'right' ? ix + c.width * f - 10 - t.width : c.x + (c.width - t.width) / 2
  t.y = t.verticalAlign === 'top' ? iy + 10 : t.verticalAlign === 'bottom' ? iy + c.height * f - 10 - t.height : c.y + (c.height - t.height) / 2
}

/** Put a bound text in its container by its alignment, growing the container if the text does not fit. */
function fit(container: El, t: El) {
  if (LINEAR.has(container.type)) {
    t.x = container.x + (container.width - t.width) / 2
    t.y = container.y + (container.height - t.height) / 2
    return
  }
  const w = Math.max(container.width, (t.width + 24) / room(container.type))
  const h = Math.max(container.height, (t.height + 20) / room(container.type))
  if (w !== container.width || h !== container.height) {
    container.width = w
    container.height = h
    bump(container)
  }
  placeText(container, t)
}

export function updateNode(s: Scene, id: string, text?: string, color?: string) {
  const el = find(s, id)
  if (!el) throw new Error(`No element with id ${id}`)
  if (color) {
    const [stroke, bg] = colorOf(color)
    el.strokeColor = stroke
    // Only closed shapes get the soft fill; text and arrows just take the stroke colour.
    if (!LINEAR.has(el.type) && el.type !== 'text') el.backgroundColor = bg
    bump(el)
  }
  if (text === undefined) return `Updated ${id}.`
  // A frame's title is its name; Excalidraw gives no text to images, embeds, drawings or plain lines.
  if (el.type === 'frame' || el.type === 'magicframe') {
    el.name = text
    bump(el)
    return `Renamed frame ${id} to "${text}".`
  }
  if (['image', 'embeddable', 'iframe', 'freedraw', 'line'].includes(el.type)) throw new Error(`${id} is a ${el.type}, which cannot hold text: put a text next to it with add_shapes`)
  if (isDetail(el)) return setDetail(s, el.customData.of, text)
  let t = el.type === 'text' ? el : boundText(s, id)
  if (!t) {
    t = makeText(s, text, el.x, el.y, el.id)
    s.elements.push(t)
    attach(el, t)
  }
  const container = t.containerId ? find(s, t.containerId) : undefined
  // Inside a box the text is wrapped to the box's width; the box only grows taller.
  const shown = container && !LINEAR.has(container.type) ? wrapText(text, container.width * room(container.type) - 24, t.fontSize ?? st().fontSize) : text
  t.text = shown
  t.originalText = text
  Object.assign(t, approxSize(shown, t.fontSize ?? st().fontSize))
  if (container) fit(container, t)
  bump(t)
  return `Updated ${id}.`
}


// ---------------------------------------------------------------- geometry
type Rect = { x: number; y: number; w: number; h: number }
const rect = (e: El): Rect => {
  // A line, arrow or drawing starts at its first point, which is not always its top-left corner.
  if (!Array.isArray(e.points) || !e.points.length) return { x: e.x, y: e.y, w: e.width, h: e.height }
  const xs = e.points.map((p: number[]) => e.x + p[0]), ys = e.points.map((p: number[]) => e.y + p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
const hit = (a: Rect, b: Rect, margin = 0) =>
  a.x + margin < b.x + b.w && b.x + margin < a.x + a.w && a.y + margin < b.y + b.h && b.y + margin < a.y + a.h
const fmt = (r: Rect) => `x ${Math.round(r.x)}..${Math.round(r.x + r.w)}, y ${Math.round(r.y)}..${Math.round(r.y + r.h)} (${Math.round(r.w)}x${Math.round(r.h)})`
const isContainer = (e: El) => SHAPES.has(e.type)
const nodeLabel = (s: Scene, e: El) => `${e.id} "${label(s, e)}"`

/** Nodes that are not inside (or around) `el`: the things it must not collide with. */
function others(s: Scene, el: El, ignore: Set<string> = new Set()) {
  const inner = new Set(containedIn(s, el).map((c) => c.id))
  return alive(s).filter((o) => isNode(o) && o.id !== el.id && !inner.has(o.id) && !ignore.has(o.id) && !containedIn(s, o).some((c) => c.id === el.id))
}

/** Free space around an element, and what the element currently holds. */
export function getSpace(s: Scene, id?: string): string {
  const nodes = alive(s).filter(isNode)
  const lines: string[] = []
  if (!id) {
    const top = nodes.filter((n) => !nodes.some((p) => p.id !== n.id && containedIn(s, p).some((c) => c.id === n.id)))
    const all = nodes.map(rect)
    if (!all.length) return 'Canvas is empty. Anything goes; start at 0,0.'
    const x0 = Math.min(...all.map((r) => r.x)), y0 = Math.min(...all.map((r) => r.y))
    const x1 = Math.max(...all.map((r) => r.x + r.w)), y1 = Math.max(...all.map((r) => r.y + r.h))
    lines.push(`Canvas content spans ${fmt({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 })}. Empty space starts at y ${Math.round(y1 + st().gap)} (below) and x ${Math.round(x1 + st().gap)} (right).`)
    lines.push('Top-level items:', ...top.map((n) => `- ${nodeLabel(s, n)} ${fmt(rect(n))}`))
    return lines.join('\n')
  }
  const el = find(s, id)
  if (!el) return `No element with id ${id}`
  const r = rect(el)
  lines.push(`${nodeLabel(s, el)} (${el.type}) ${fmt(r)}`)
  const inner = containedIn(s, el)
  const t = boundText(s, el.id)
  const titleH = t && !LINEAR.has(el.type) && isContainer(el) && el.type !== 'frame' ? t.height + 16 : 0
  const area: Rect = { x: r.x + st().pad, y: r.y + st().pad + titleH, w: r.w - 2 * st().pad, h: r.h - 2 * st().pad - titleH }
  lines.push(`Usable inside (with ${st().pad}px padding${titleH ? ', below its own title' : ''}): ${fmt(area)}`)
  if (inner.length) {
    lines.push('Already inside:', ...inner.map((c) => `- ${nodeLabel(s, c)} ${fmt(rect(c))}`))
    const bottom = Math.max(...inner.map((c) => c.y + c.height))
    const right = Math.max(...inner.map((c) => c.x + c.width))
    lines.push(`Free inside: ${Math.max(0, Math.round(area.y + area.h - bottom))}px below the lowest child, ${Math.max(0, Math.round(area.x + area.w - right))}px right of the rightmost child.`)
  } else lines.push('Nothing inside yet: the whole usable area is free.')
  // How far it can grow before touching a neighbour.
  const nb = others(s, el)
  const room = (side: 'left' | 'right' | 'up' | 'down') => {
    let best = Infinity
    let who = ''
    for (const o of nb) {
      const q = rect(o)
      const overlapsY = q.y < r.y + r.h && r.y < q.y + q.h
      const overlapsX = q.x < r.x + r.w && r.x < q.x + q.w
      const d =
        side === 'right' && overlapsY && q.x >= r.x + r.w - 1 ? q.x - (r.x + r.w)
        : side === 'left' && overlapsY && q.x + q.w <= r.x + 1 ? r.x - (q.x + q.w)
        : side === 'down' && overlapsX && q.y >= r.y + r.h - 1 ? q.y - (r.y + r.h)
        : side === 'up' && overlapsX && q.y + q.h <= r.y + 1 ? r.y - (q.y + q.h)
        : Infinity
      if (d < best) (best = d), (who = nodeLabel(s, o))
    }
    return best === Infinity ? `${side}: unobstructed` : `${side}: ${Math.round(best)}px to ${who}`
  }
  lines.push('Room to grow (distance to nearest neighbour): ' + (['left', 'right', 'up', 'down'] as const).map(room).join('; '))
  return lines.join('\n')
}

/** Overlaps, things sticking out of their container, clipped text and arrows running through boxes. */
export function lint(s: Scene, scopeId?: string): string {
  const scope = scopeId ? find(s, scopeId) : undefined
  if (scopeId && !scope) return `No element with id ${scopeId}`
  let nodes = alive(s).filter(isNode)
  if (scope) {
    const keep = new Set([scope.id, ...containedIn(s, scope).map((c) => c.id)])
    nodes = nodes.filter((n) => keep.has(n.id) || nodes.some((o) => keep.has(o.id) && hit(rect(o), rect(n))))
  }
  const issues: string[] = []
  // A box only "holds" another when it is a frame, clearly bigger, or fully around it; two similar boxes that overlap are a collision.
  const holds = (p: El, c: El) => containedIn(s, p).some((x) => x.id === c.id) && (p.type === 'frame' || area(p) >= area(c) * 3 || encloses(p, c))
  const rel = (a: El, b: El) => holds(a, b) || holds(b, a)
  for (let i = 0; i < nodes.length; i++)
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      if (isExact(a) || isExact(b) || !hit(rect(a), rect(b), 2)) continue
      if (rel(a, b)) {
        const [p, c] = holds(a, b) ? [a, b] : [b, a]
        const q = rect(p), k = rect(c)
        if (k.x < q.x || k.y < q.y || k.x + k.w > q.x + q.w || k.y + k.h > q.y + q.h) issues.push(`STICKS OUT: ${nodeLabel(s, c)} crosses the edge of ${nodeLabel(s, p)}. Move it in or enlarge the container.`)
      } else issues.push(`OVERLAP: ${nodeLabel(s, a)} and ${nodeLabel(s, b)}.`)
    }
  for (const n of nodes) {
    const t = boundText(s, n.id)
    if (t && !LINEAR.has(n.type) && !isExact(n) && (t.width > n.width * room(n.type) - 8 || t.height > n.height * room(n.type) - 8)) issues.push(`TEXT TOO BIG: ${nodeLabel(s, n)} is ${Math.round(n.width)}x${Math.round(n.height)} but its text needs about ${Math.round(t.width)}x${Math.round(t.height)}.`)
  }
  const ids = new Set(nodes.map((n) => n.id))
  for (const a of alive(s)) {
    // A free arrow (an axis, a labelled line) was put exactly where it was asked: only arrows between boxes are routed.
    if (a.type !== 'arrow' || !a.points || (!a.startBinding && !a.endBinding) || (a.startBinding && !ids.has(a.startBinding.elementId) && !(a.endBinding && ids.has(a.endBinding.elementId)))) continue
    const pts = a.points.map(([px, py]: number[]) => ({ x: a.x + px, y: a.y + py }))
    const ends = new Set([a.startBinding?.elementId, a.endBinding?.elementId])
    for (const n of nodes) {
      if (ends.has(n.id) || [...ends].some((e) => e && containedIn(s, n).some((c) => c.id === e))) continue
      if (pathHits(pts, rect(n))) issues.push(`ARROW CROSSES: arrow ${a.id} runs through ${nodeLabel(s, n)}.`)
    }
  }
  if (!issues.length) return 'Layout OK: no overlaps, nothing sticks out, text fits, no arrows run through boxes.'
  // A long list costs more to read than it helps; fix_layout deals with most of them at once.
  const MAX = 10
  return issues.length > MAX ? [...issues.slice(0, MAX), `…and ${issues.length - MAX} more issue(s). fix_layout fixes sizes and overlaps in one call.`].join('\n') : issues.join('\n')
}

// ---------------------------------------------------------------- writing (continued)
/** Whether the segment p→q passes through the inside of r (shrunk by m on each side): the segment clipped to it (Liang-Barsky). */
function segHits(p: Pt, q: Pt, r: Rect, m = 4) {
  const x1 = r.x + m, y1 = r.y + m, x2 = r.x + r.w - m, y2 = r.y + r.h - m
  if (x2 <= x1 || y2 <= y1) return false
  const dx = q.x - p.x, dy = q.y - p.y
  let t0 = 0, t1 = 1
  for (const [d, k] of [[-dx, p.x - x1], [dx, x2 - p.x], [-dy, p.y - y1], [dy, y2 - p.y]]) {
    if (d === 0) {
      if (k <= 0) return false
      continue
    }
    const t = k / d
    if (d < 0) {
      if (t > t1) return false
      t0 = Math.max(t0, t)
    } else {
      if (t < t0) return false
      t1 = Math.min(t1, t)
    }
  }
  return t1 - t0 > 1e-6
}
const pathHits = (pts: Pt[], r: Rect, m = 4) => pts.some((p, i) => i + 1 < pts.length && segHits(p, pts[i + 1], r, m))

/** p's centre lies in c and c is clearly bigger: c is p's container (the rule containedIn uses), so arrows may run inside it. */
const holdsCentre = (c: El, p: El) => {
  const m = center(p)
  return SHAPES.has(c.type) && area(p) < area(c) * 0.9 && m.x > c.x && m.x < c.x + c.width && m.y > c.y && m.y < c.y + c.height
}

type Side = 'left' | 'right' | 'top' | 'bottom'
const SIDES: Side[] = ['right', 'left', 'bottom', 'top']
const NORMAL: Record<Side, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 } }
const port = (e: El, side: Side): Pt =>
  side === 'left' ? { x: e.x, y: e.y + e.height / 2 } : side === 'right' ? { x: e.x + e.width, y: e.y + e.height / 2 } : side === 'top' ? { x: e.x + e.width / 2, y: e.y } : { x: e.x + e.width / 2, y: e.y + e.height }

/** Drops repeated points and the middle of three points on one line, so a path has only its real bends. */
function simplify(pts: Pt[]) {
  const out: Pt[] = []
  for (const p of pts) {
    if (out.length && Math.abs(out[out.length - 1].x - p.x) < 0.5 && Math.abs(out[out.length - 1].y - p.y) < 0.5) continue
    if (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]]
      if ((Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - p.x) < 0.5) || (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - p.y) < 0.5)) out.pop()
    }
    out.push(p)
  }
  return out
}

/**
 * An orthogonal path from a to b that goes around the other boxes: tries every pair of sides, each with a short stub out
 * of the box and a crossing channel at the middle, in line with either end, or just past a nearby box, and keeps the one
 * that crosses the fewest boxes, then is shortest, with a cost per bend and for running along another arrow.
 */
function orthoPath(s: Scene, a: El, b: El): Pt[] {
  const stub = 20
  const others = alive(s).filter((n) => isNode(n) && n.id !== a.id && n.id !== b.id && !holdsCentre(n, a) && !holdsCentre(n, b)).map(rect)
  const box = { x: Math.min(a.x, b.x) - 160, y: Math.min(a.y, b.y) - 160, w: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x) + 320, h: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) + 320 }
  const near = others.filter((r) => hit(r, box))
  const own = [rect(a), rect(b)]
  // Segments of the other arrows: running along one of them makes two arrows read as one.
  // Arrows that leave the same box are left out: sharing their trunk is the bracket a fan-out should look like.
  const taken = alive(s)
    .filter((e) => e.type === 'arrow' && e.points?.length > 1 && e.startBinding?.elementId !== a.id)
    .flatMap((e) => e.points.slice(1).map((q: number[], i: number) => [{ x: e.x + e.points[i][0], y: e.y + e.points[i][1] }, { x: e.x + q[0], y: e.y + q[1] }] as [Pt, Pt]))
    .filter(([u, v]) => hit({ x: Math.min(u.x, v.x), y: Math.min(u.y, v.y), w: Math.abs(u.x - v.x) + 1, h: Math.abs(u.y - v.y) + 1 }, box))
  const lap = (a1: number, a2: number, b1: number, b2: number) => Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2))
  /** What a segment costs next to the other arrows: a lot for running along one, a little for crossing one. */
  const nearArrows = (p: Pt, q: Pt) => {
    let c = 0
    const flat = Math.abs(p.y - q.y) < 0.5
    for (const [u, v] of taken) {
      const uFlat = Math.abs(u.y - v.y) < 0.5
      if (flat === uFlat) {
        if (flat ? Math.abs(p.y - u.y) < 8 && lap(p.x, q.x, u.x, v.x) > 12 : Math.abs(p.x - u.x) < 8 && lap(p.y, q.y, u.y, v.y) > 12) c += 300
      } else {
        const [h1, h2, vv1, vv2] = flat ? [p, q, u, v] : [u, v, p, q]
        if (lap(h1.x, h2.x, vv1.x, vv1.x) > -0.5 && Math.min(h1.x, h2.x) < vv1.x - 2 && Math.max(h1.x, h2.x) > vv1.x + 2 && Math.min(vv1.y, vv2.y) < h1.y - 2 && Math.max(vv1.y, vv2.y) > h1.y + 2) c += 80
      }
    }
    return c
  }
  // When the boxes are apart on one axis, the arrow should leave and enter by the sides that face each other; otherwise a
  // fan-out takes the shorter one-bend path out of the top or bottom for some children and the right side for others.
  const ra = rect(a), rb = rect(b)
  const facing: [Side, Side] | null =
    rb.x >= ra.x + ra.w ? ['right', 'left'] : rb.x + rb.w <= ra.x ? ['left', 'right'] : rb.y >= ra.y + ra.h ? ['bottom', 'top'] : rb.y + rb.h <= ra.y ? ['top', 'bottom'] : null
  /** Whether a segment runs along a side's outward direction (dir 1) or into it (dir -1). */
  const along = (p: Pt, q: Pt, side: Side, dir: 1 | -1) => (q.x - p.x) * NORMAL[side].x * dir + (q.y - p.y) * NORMAL[side].y * dir > 0
  let best: Pt[] = [], score = Infinity
  for (const sa of SIDES)
    for (const sb of SIDES) {
      const p1 = port(a, sa), p2 = port(b, sb)
      const turn = facing ? (sa === facing[0] ? 0 : 200) + (sb === facing[1] ? 0 : 200) : 0
      const q1 = { x: p1.x + NORMAL[sa].x * stub, y: p1.y + NORMAL[sa].y * stub }
      const q2 = { x: p2.x + NORMAL[sb].x * stub, y: p2.y + NORMAL[sb].y * stub }
      const xs = [(q1.x + q2.x) / 2, q1.x, q2.x, ...near.flatMap((r) => [r.x - stub, r.x + r.w + stub])]
      const ys = [(q1.y + q2.y) / 2, q1.y, q2.y, ...near.flatMap((r) => [r.y - stub, r.y + r.h + stub])]
      const tries = [...xs.map((x) => [p1, q1, { x, y: q1.y }, { x, y: q2.y }, q2, p2]), ...ys.map((y) => [p1, q1, { x: q1.x, y }, { x: q2.x, y }, q2, p2])]
      for (const t of tries) {
        const pts = simplify(t)
        // simplify merges a stub with a segment that doubles back over it, which would start or end inside the box.
        if (pts.length < 2 || !along(pts[0], pts[1], sa, 1) || !along(pts[pts.length - 2], pts[pts.length - 1], sb, -1)) continue
        // The stubs leave and enter the boxes; the rest must not cut back through them.
        const mid = pts.slice(1, -1)
        let sc = turn + near.filter((r) => pathHits(pts, r)).length * 10000 + own.filter((r) => mid.length > 1 && pathHits(mid, r)).length * 10000
        if (sc >= score) continue
        // A path that is not purely horizontal and vertical cannot be an elbow arrow.
        if (pts.some((p, i) => i && Math.abs(p.x - pts[i - 1].x) > 0.5 && Math.abs(p.y - pts[i - 1].y) > 0.5)) continue
        for (let i = 0; i + 1 < pts.length; i++) sc += Math.abs(pts[i + 1].x - pts[i].x) + Math.abs(pts[i + 1].y - pts[i].y)
        sc += (pts.length - 2) * 60
        if (sc >= score) continue
        for (let i = 0; i + 1 < pts.length && sc < score; i++) sc += nearArrows(pts[i], pts[i + 1])
        if (sc < score) (score = sc, best = pts)
      }
    }
  return best
}

/** Sets an arrow's points from absolute ones, keeps elbow bindings attached, and puts its label where it has room. */
function setPath(s: Scene, arrow: El, a: El, b: El, pts: Pt[]) {
  const [p1, p2] = [pts[0], pts[pts.length - 1]]
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  Object.assign(arrow, { x: p1.x, y: p1.y, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys), points: pts.map((p) => [p.x - p1.x, p.y - p1.y]) })
  // Elbow arrows are only kept bound by Excalidraw when each binding says where on the box it sits (a 0..1 ratio);
  // without it the binding is dropped when the page loads the scene and the arrow no longer follows its boxes.
  if (arrow.elbowed) {
    const ratio = (p: Pt, e: El) => [Math.min(0.9999, Math.max(0.0001, (p.x - e.x) / e.width)), Math.min(0.9999, Math.max(0.0001, (p.y - e.y) / e.height))]
    if (arrow.startBinding) arrow.startBinding.fixedPoint = ratio(p1, a)
    if (arrow.endBinding) arrow.endBinding.fixedPoint = ratio(p2, b)
  }
  // The label goes on the middle of the longest horizontal segment that fits it (text is horizontal), else the longest one.
  const t = boundText(s, arrow.id)
  if (t) {
    const segs = pts.slice(1).map((q, i) => ({ p: pts[i], q, len: Math.abs(q.x - pts[i].x) + Math.abs(q.y - pts[i].y), flat: Math.abs(q.y - pts[i].y) < 0.5 }))
    const fits = segs.filter((g) => g.flat && g.len >= t.width + 20)
    const g = (fits.length ? fits : segs).reduce((x, y) => (y.len > x.len ? y : x))
    t.x = (g.p.x + g.q.x) / 2 - t.width / 2
    t.y = (g.p.y + g.q.y) / 2 - t.height / 2
    bump(t)
  }
  bump(arrow)
}

function routeArrow(s: Scene, arrow: El, a: El, b: El) {
  // Elbow arrows go around the boxes in the way; straight and curved ones keep a direct line between the facing sides.
  if (arrow.elbowed) {
    const pts = orthoPath(s, a, b)
    if (pts.length >= 2) return setPath(s, arrow, a, b, pts)
  }
  const ca = center(a)
  const cb = center(b)
  const horizontal = Math.abs(cb.x - ca.x) >= Math.abs(cb.y - ca.y)
  const edge = (e: El, toward: { x: number; y: number }) => {
    const c = center(e)
    return horizontal
      ? { x: toward.x > c.x ? e.x + e.width : e.x, y: c.y }
      : { x: c.x, y: toward.y > c.y ? e.y + e.height : e.y }
  }
  const p1 = edge(a, cb)
  const p2 = edge(b, ca)
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  // An elbow arrow runs along the axes: out of the box, one bend halfway, into the next (straight when the boxes line up).
  const bend = arrow.elbowed && Math.abs(horizontal ? dy : dx) > 1
  // A curved arrow is only drawn curved through a middle point; with two points Excalidraw draws it straight.
  const curve = !arrow.elbowed && arrow.roundness && Math.abs(horizontal ? dy : dx) > 1
  const points = bend
    ? horizontal ? [[0, 0], [dx / 2, 0], [dx / 2, dy], [dx, dy]] : [[0, 0], [0, dy / 2], [dx, dy / 2], [dx, dy]]
    : curve ? (horizontal ? [[0, 0], [dx * 0.6, dy * 0.25], [dx, dy]] : [[0, 0], [dx * 0.25, dy * 0.6], [dx, dy]]) : [[0, 0], [dx, dy]]
  Object.assign(arrow, { x: p1.x, y: p1.y, width: Math.abs(dx), height: Math.abs(dy), points })
  // Elbow arrows are only kept bound by Excalidraw when each binding says where on the box it sits (a 0..1 ratio);
  // without it the binding is dropped when the page loads the scene and the arrow no longer follows its boxes.
  if (arrow.elbowed) {
    const ratio = (p: { x: number; y: number }, e: El) => [Math.min(0.9999, Math.max(0.0001, (p.x - e.x) / e.width)), Math.min(0.9999, Math.max(0.0001, (p.y - e.y) / e.height))]
    if (arrow.startBinding) arrow.startBinding.fixedPoint = ratio(p1, a)
    if (arrow.endBinding) arrow.endBinding.fixedPoint = ratio(p2, b)
  }
  const t = boundText(s, arrow.id)
  if (t) {
    t.x = p1.x + (p2.x - p1.x) / 2 - t.width / 2
    t.y = p1.y + (p2.y - p1.y) / 2 - t.height / 2
    bump(t)
  }
  bump(arrow)
}

/**
 * Lay an arrow along a route computed by the layout engine (absolute points, orthogonal, around the boxes), instead of
 * routeArrow's single bend. Only for elbow arrows: a curved or straight style would draw these bends badly.
 */
function applyRoute(s: Scene, arrow: El, a: El, b: El, pts: Pt[]) {
  if (!arrow.elbowed || pts.length < 2) return routeArrow(s, arrow, a, b)
  setPath(s, arrow, a, b, pts)
}

const rerouteAround = (s: Scene, ids: Set<string>) => {
  for (const a of alive(s)) {
    if (a.type !== 'arrow') continue
    const from = a.startBinding && find(s, a.startBinding.elementId)
    const to = a.endBinding && find(s, a.endBinding.elementId)
    if (from && to && (ids.has(from.id) || ids.has(to.id))) routeArrow(s, a, from, to)
  }
}

/** Move an element with its text, everything inside it, and re-route the arrows attached to any of them. */
export function moveNode(s: Scene, id: string, x: number, y: number) {
  const el = find(s, id)
  if (!el) throw new Error(`No element with id ${id}`)
  const dx = x - el.x
  const dy = y - el.y
  const moved = withContents(s, el)
  for (const e of alive(s)) {
    // Bound arrows are re-routed below; a free one (not attached to boxes) moves like any element.
    if (!moved.has(e.id) || (e.type === 'arrow' && (e.startBinding || e.endBinding))) continue
    e.x += dx
    e.y += dy
    bump(e)
  }
  rerouteAround(s, moved)
  return `Moved ${id} to ${Math.round(x)},${Math.round(y)}. ${lint(s, id)}`
}

/** Resize a box (the text is re-wrapped to the new width and re-centred) and re-route its arrows. */
export function resizeNode(s: Scene, id: string, width: number, height: number) {
  const el = find(s, id)
  if (!el) throw new Error(`No element with id ${id}`)
  if (el.type === 'freedraw' || (LINEAR.has(el.type) && !el.startBinding && !el.endBinding)) return scalePoints(s, el, width, height)
  if (LINEAR.has(el.type)) throw new Error(`${id} is an arrow attached to boxes; move the boxes instead of resizing it`)
  const t = boundText(s, id)
  // A box with text keeps room for it; a bare shape (a tick, a bar) can be as thin as asked.
  const min = t?.text?.trim() ? 20 : 1
  el.width = Math.max(min, width)
  el.height = Math.max(min, height)
  bump(el)
  if (t && !LINEAR.has(el.type)) {
    t.text = wrapText(t.originalText ?? t.text, el.width * room(el.type) - 24, t.fontSize ?? st().fontSize)
    Object.assign(t, approxSize(t.text, t.fontSize ?? st().fontSize))
    placeText(el, t)
    bump(t)
  }
  // The explanation under the title is wrapped to the new width as well.
  const d = detailOf(s, id)
  if (d) setDetail(s, id, d.customData.text ?? d.text)
  rerouteAround(s, new Set([id]))
  return `Resized ${id} to ${Math.round(el.width)}x${Math.round(el.height)}. ${lint(s, id)}`
}

/** Several resizes in one change, with one layout check at the end. */
export function resizeNodes(s: Scene, sizes: { id: string; width?: number; height?: number }[]) {
  for (const r of sizes) {
    const el = find(s, r.id)
    if (!el) throw new Error(`No element with id ${r.id}`)
    resizeNode(s, r.id, r.width ?? el.width, r.height ?? el.height)
  }
  return `Resized ${sizes.length} element(s). ${lint(s)}`
}

/**
 * Arrange boxes by their arrows (dagre, layered): left to right or top to bottom. Scope: the boxes inside `containerId`
 * (the container grows to fit), otherwise every box that is not inside another one. Each box keeps its contents and
 * its arrows are re-routed.
 */
/** The boxes auto_layout arranges (inside a container, or every top-level box) and the arrows between them. */
function autoScope(s: Scene, containerId?: string) {
  const container = containerId ? find(s, containerId) : undefined
  if (containerId && !container) throw new Error(`No element with id ${containerId}`)
  const inner = new Set(alive(s).filter(isNode).flatMap((e) => containedIn(s, e).map((c) => c.id)))
  const nodes = container ? containedIn(s, container) : alive(s).filter((e) => isNode(e) && !inner.has(e.id))
  const ids = new Set(nodes.map((n) => n.id))
  const links: { from: string; to: string }[] = []
  for (const a of alive(s)) {
    const from = a.type === 'arrow' && a.startBinding?.elementId
    const to = a.type === 'arrow' && a.endBinding?.elementId
    if (from && to && from !== to && ids.has(from) && ids.has(to)) links.push({ from, to })
  }
  return { container, nodes, links }
}

/** ELK's top-left for each box auto_layout would move, read from the scene before mutate (ELK is async). Null when it fails. */
export async function elkAutoPositions(s: Scene, containerId?: string, direction: 'LR' | 'TB' = 'LR') {
  try {
    const { nodes, links } = autoScope(s, containerId)
    if (nodes.length < 2) return null
    return (await elkRun(nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })), links, direction, { grouped: false, labels: false })).pos
  } catch {
    return null
  }
}

export function autoLayout(s: Scene, containerId?: string, direction: 'LR' | 'TB' = 'LR', pre?: Map<string, { x: number; y: number }> | null) {
  const { container, nodes, links } = autoScope(s, containerId)
  if (nodes.length < 2) return 'Nothing to arrange (fewer than two boxes in scope).'
  const edges = links.length
  // ELK's positions apply only if they cover every box still here (the scene may have changed since they were computed).
  const elkOk = !!pre && nodes.every((n) => pre.has(n.id))
  const g = new dagre.graphlib.Graph()
  if (!elkOk) {
    g.setGraph({ rankdir: direction, nodesep: 50, ranksep: 90, marginx: 0, marginy: 0 })
    g.setDefaultEdgeLabel(() => ({}))
    for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height })
    for (const l of links) g.setEdge(l.from, l.to)
    dagre.layout(g)
  }

  const pad = 24
  const origin = container
    ? { x: container.x + pad, y: container.y + (container.type === 'frame' ? 44 : pad) }
    : { x: Math.min(...nodes.map((n) => n.x)), y: Math.min(...nodes.map((n) => n.y)) }
  const target = new Map(nodes.map((n) => {
    if (elkOk) { const p = pre!.get(n.id)!; return [n.id, { x: origin.x + p.x, y: origin.y + p.y }] }
    const p = g.node(n.id)
    return [n.id, { x: origin.x + p.x - n.width / 2, y: origin.y + p.y - n.height / 2 }]
  }))

  // Everything that travels with a box (its text, what lies inside it) is worked out before anything moves.
  const moves = nodes.map((n) => ({ group: withContents(s, n), dx: target.get(n.id)!.x - n.x, dy: target.get(n.id)!.y - n.y }))
  const moved = new Set<string>()
  for (const { group, dx, dy } of moves)
    for (const e of alive(s)) {
      if (!group.has(e.id) || (e.type === 'arrow' && (e.startBinding || e.endBinding))) continue
      e.x += dx
      e.y += dy
      bump(e)
      moved.add(e.id)
    }
  rerouteAround(s, moved)

  if (container) {
    const w = Math.max(...nodes.map((n) => n.x + n.width)) + pad - container.x
    const h = Math.max(...nodes.map((n) => n.y + n.height)) + pad - container.y
    if (w > container.width || h > container.height) resizeNode(s, container.id, Math.max(w, container.width), Math.max(h, container.height))
  }
  const note = edges ? '' : ' (no arrows between them, so they were just packed into rows)'
  return `Arranged ${nodes.length} boxes ${direction === 'LR' ? 'left to right' : 'top to bottom'} using ${edges} arrow(s)${note}. ${lint(s, containerId)}`
}

/** First spot at or after x,y where a w*h box touches nothing else (scans right, then down).
 *  With `inside`, a box that would hold it (fully around it and 3x its area, as lint counts it) is not in the way. */
function clearSpot(s: Scene, x: number, y: number, w: number, h: number, inside = false, ignore: Set<string> = new Set()) {
  const nodes = alive(s).filter((e) => isNode(e) && e.type !== 'frame' && !ignore.has(e.id)).map(rect)
  const holds = (n: Rect, r: Rect) => inside && n.w * n.h >= r.w * r.h * 3 && n.x <= r.x && n.y <= r.y && n.x + n.w >= r.x + r.w && n.y + n.h >= r.y + r.h
  for (let dy = 0; dy < 2000; dy += 40)
    for (let dx = 0; dx < 2000; dx += 40) {
      const r = { x: x + dx, y: y + dy, w, h }
      if (!nodes.some((n) => hit(n, r, -st().gap / 2) && !holds(n, r))) return { x: r.x, y: r.y }
    }
  return { x, y }
}

const colorOf = (c?: string) => PALETTE[c ?? ''] ?? ['#1e1e1e', 'transparent']

/** The size a box needs for its text: the given width (default: fits the text, 140..260px), as tall as the wrapped text. */
function boxSize(text: string, width?: number, height?: number, shape: Shape = 'rectangle') {
  const f = room(shape)
  // A diamond or ellipse is wider than a box with the same text, so its text still wraps to a few lines.
  const w = width ?? Math.round(Math.min(260, Math.max(140, approxSize(text, st().fontSize).width + 40)) * (shape === 'rectangle' ? 1 : 1.6))
  const size = approxSize(wrapText(text, w * f - 24), st().fontSize)
  return { w, h: Math.max(height ?? 0, 60, Math.round((size.height + 30) / f)) }
}

/** Where new top-level content goes: at x,y when given, otherwise below everything already on the canvas. */
export function freeOrigin(s: Scene, x?: number, y?: number) {
  const els = alive(s)
  return { x: x ?? (els.length ? Math.min(...els.map((e) => e.x)) : 0), y: y ?? (els.length ? Math.max(...els.map((e) => e.y + e.height)) + 80 : 0) }
}

/** A container's title sits at its top edge, leaving the rest for what goes inside. */
function pinTitle(s: Scene, box: El) {
  const t = boundText(s, box.id)
  if (!t) return
  t.verticalAlign = 'top'
  placeText(box, t)
  bump(t)
}

export type Shape = 'rectangle' | 'diamond' | 'ellipse'
/** What a box is in its drawing: a container (column, group), a section inside one, a header (table header, row label),
 *  or an item inside a filled container. Only matters with the `fill` container style and no colour. */
type Role = 'container' | 'section' | 'header' | 'inside'
// Light neutral fills, a step darker for a section inside a column; items inside them stay white so they read as boxes.
const ROLE_LOOK: Record<Role, { bg: string; stroke?: string; bigger: number }> = {
  container: { bg: '#f8f9fa', stroke: 'transparent', bigger: 4 },
  section: { bg: '#eef0f2', stroke: 'transparent', bigger: 2 },
  header: { bg: '#f1f3f5', stroke: 'transparent', bigger: 2 },
  inside: { bg: '#ffffff', bigger: 0 },
}

function makeBox(s: Scene, text: string, x: number, y: number, w: number, h: number, color?: string, frameId: string | null = null, o: { shape?: Shape; role?: Role } = {}) {
  const [stroke, bg] = colorOf(color)
  const look = o.role && !color && st().containers === 'fill' ? ROLE_LOOK[o.role] : null
  const shape = o.shape ?? 'rectangle'
  const box = base(shape, x, y, w, h, {
    roundness: shape === 'ellipse' ? null : st().rounded ? { type: shape === 'diamond' ? 2 : 3 } : null,
    strokeColor: look?.stroke ?? stroke,
    backgroundColor: look?.bg ?? bg,
    frameId,
  })
  const size = st().fontSize + (look?.bigger ?? 0)
  const t = makeText(s, '', 0, 0, box.id, size)
  t.frameId = frameId
  t.text = wrapText(text, w * room(shape) - 24, size)
  t.originalText = text
  Object.assign(t, approxSize(t.text, size))
  s.elements.push(box, t)
  attach(box, t)
  fit(box, t)
  // Kept on the element, so a later check can tell a column or a header from a box of content.
  if (o.role && o.role !== 'inside') box.customData = { ...(box.customData ?? {}), role: o.role }
  return box
}

// ---------------------------------------------------------------- boxes that explain: a detail under the title, boxes inside
/** A box's content. `detail` is a sentence or two under the title, in smaller type; `inside` are boxes drawn within it
 *  (its parts, steps or kinds), each with its own title and detail. */
export type Inner = { text: string; detail?: string; color?: string; shape?: Shape }
export type Item = Inner & { inside?: Inner[] }

/** The boxes drawn from an item's `inside`, by the item object the caller passed: tools.ts saves their notes and lists them. */
export const drawnInside = new WeakMap<object, { id: string; parent: string }>()

// fix_layout keeps 24px between a container and what it holds, so what is drawn in a box keeps that margin too.
const INSET = 24
const detailFont = () => Math.max(14, st().fontSize - 4)
const hasDetail = (it: Item) => !!it.detail?.trim()
/** Whether the box gets the title-on-top layout. A diamond or an ellipse has room for one text only. */
const rich = (it: Item) => (hasDetail(it) || !!it.inside?.length) && (it.shape ?? 'rectangle') === 'rectangle'
/** The one text of a box without that layout: in a diamond or ellipse the detail joins the title. */
const plainOf = (it: Item) => (hasDetail(it) && !rich(it) ? `${it.text}\n${it.detail!.trim()}` : it.text)
/** An item with inside boxes is a container of them (a section when it sits in a container itself). */
const richRole = (it: Item, role?: Role): Role | undefined => (it.inside?.length ? (role === 'inside' ? 'section' : (role ?? 'container')) : role)
const titleSize = (it: Item, role?: Role) => st().fontSize + (role && !it.color && st().containers === 'fill' ? ROLE_LOOK[role].bigger : 0)

/** A width at which the explanation wraps to a few lines and the inside boxes sit side by side. */
function richWidth(it: Item): number {
  if (!rich(it)) return boxSize(plainOf(it), undefined, undefined, it.shape).w
  let w = boxSize(it.text).w
  const d = it.detail?.trim().length ?? 0
  if (d) w = Math.max(w, d <= 70 ? 260 : d <= 160 ? 300 : 340)
  if (it.inside?.length) {
    const cols = innerCols(it.inside)
    const cell = Math.max(130, ...it.inside.map((c) => Math.min(hasDetail(c) ? 190 : 160, richWidth(c))))
    w = Math.max(w, 2 * INSET + cols * cell + (cols - 1) * st().gap)
  }
  return Math.round(Math.min(760, w))
}

/** How many inside boxes sit side by side: up to three in one row; more go two by two when they explain themselves (or are four), else three. */
const innerCols = (inside: Inner[]) => (inside.length <= 3 ? inside.length : inside.length === 4 || inside.some(hasDetail) ? 2 : 3)

/** The grid of the inside boxes at width w, with fewer columns when they would get too narrow. */
function innerGrid(inside: Inner[], w: number) {
  const { gap } = st()
  const avail = w - 2 * INSET
  let cols = innerCols(inside)
  while (cols > 1 && (avail - gap * (cols - 1)) / cols < 120) cols--
  const cellW = (avail - gap * (cols - 1)) / cols
  const rowH: number[] = []
  for (let r = 0; r < inside.length; r += cols) rowH.push(Math.max(...inside.slice(r, r + cols).map((c) => richSize(c, cellW, 'inside').h)))
  return { cols, cellW, rowH, h: rowH.reduce((a, b) => a + b, 0) + gap * (rowH.length - 1) }
}

/** The size a box needs at width w for its title, the explanation under it and the boxes inside it. */
function richSize(it: Item, w: number, role?: Role): { w: number; h: number } {
  if (!rich(it)) return boxSize(plainOf(it), w, undefined, it.shape)
  const fs = titleSize(it, richRole(it, role))
  let h = 10 + approxSize(wrapText(it.text, w - 24, fs), fs).height
  if (hasDetail(it)) h += 8 + approxSize(wrapText(it.detail!.trim(), w - 2 * INSET, detailFont()), detailFont()).height
  if (it.inside?.length) h += st().gap + innerGrid(it.inside, w).h
  return { w, h: Math.max(60, Math.ceil(h + INSET)) }
}

/** The explanation under a box's title: a free text in smaller, softer type that belongs to the box (customData.of). */
function makeDetail(s: Scene, box: El, raw: string, y: number) {
  const fs = detailFont()
  const d = makeText(s, wrapText(raw, box.width - 2 * INSET, fs), 0, 0, null, fs)
  Object.assign(d, { x: box.x + (box.width - d.width) / 2, y, frameId: box.frameId, strokeColor: box.strokeColor === '#1e1e1e' || box.strokeColor === 'transparent' ? '#495057' : box.strokeColor })
  d.customData = { role: 'detail', of: box.id, text: raw }
  s.elements.push(d)
  return d
}

/** A box for an item: a plain box, or its title on top, the explanation under it and its inside boxes below that. */
function makeRich(s: Scene, it: Item, x: number, y: number, w: number, h: number, frameId: string | null = null, o: { role?: Role } = {}) {
  if (!rich(it)) return makeBox(s, plainOf(it), x, y, w, h, it.color, frameId, { shape: it.shape, role: o.role })
  const box = makeBox(s, it.text, x, y, w, h, it.color, frameId, { role: richRole(it, o.role) })
  pinTitle(s, box)
  const t = boundText(s, box.id)!
  let cy = t.y + t.height + 8
  if (hasDetail(it)) cy += makeDetail(s, box, it.detail!.trim(), cy).height
  if (it.inside?.length) {
    const { gap } = st()
    const g = innerGrid(it.inside, w)
    cy += gap
    it.inside.forEach((c, i) => {
      const r = Math.floor(i / g.cols)
      const top = cy + g.rowH.slice(0, r).reduce((a, b) => a + b + gap, 0)
      // A last row that is not full is centred under the others.
      const inRow = Math.min(g.cols, it.inside!.length - r * g.cols)
      const left = x + INSET + ((g.cols - inRow) * (g.cellW + gap)) / 2
      const kid = makeRich(s, c, left + (i % g.cols) * (g.cellW + gap), top, g.cellW, g.rowH[r], frameId, { role: 'inside' })
      kid.customData = { ...(kid.customData ?? {}), inside: box.id }
      drawnInside.set(c, { id: kid.id, parent: box.id })
    })
    cy += g.h
  }
  // The size was planned from estimates: the box always holds what was drawn in it.
  if (cy + INSET > y + box.height) ((box.height = cy + INSET - y), bump(box))
  return box
}

/**
 * Give a box an explanation under its title, change it, or remove it (""). The title moves to the top, what lies below
 * it inside the box moves with the change, and the box (and the containers around it) grow to fit.
 */
export function setDetail(s: Scene, id: string, text: string) {
  const box = find(s, id)
  if (!box) throw new Error(`No element with id ${id}`)
  if (box.type !== 'rectangle') throw new Error(`${id} is a ${box.type}: only a box (rectangle) takes a detail; put it in the text of a diamond or ellipse`)
  const t = boundText(s, id)
  if (!t) throw new Error(`${id} has no title to put a detail under: give it a text first`)
  const raw = text.trim()
  const outer = ancestorsOf(s, box)
  const oldBottom = box.y + box.height
  const old = detailOf(s, id)
  if (t.verticalAlign !== 'top') pinTitle(s, box)
  const before = old ? old.y + old.height : t.y + t.height
  let after = t.y + t.height
  if (old && !raw) ((old.isDeleted = true), bump(old))
  else if (old) {
    // Changed in place, so its id stays the one get_node showed.
    const fs = old.fontSize ?? detailFont()
    old.text = old.originalText = wrapText(raw, box.width - 2 * INSET, fs)
    Object.assign(old, approxSize(old.text, fs), { y: t.y + t.height + 8 })
    old.x = box.x + (box.width - old.width) / 2
    old.customData = { ...old.customData, text: raw }
    bump(old)
    after = old.y + old.height
  } else if (raw) {
    const d = makeDetail(s, box, raw, t.y + t.height + 8)
    after = d.y + d.height
  }
  // What lies under the old explanation (the inside boxes) moves by the change.
  const delta = after - before
  const inner = containedIn(s, box).filter((c) => !isDetail(c) && c.y >= before - 1)
  const moved = new Set<string>()
  for (const c of inner) for (const m of withContents(s, c)) moved.add(m)
  for (const e of alive(s)) if (moved.has(e.id) && !(e.type === 'arrow' && (e.startBinding || e.endBinding))) ((e.y += delta), bump(e))
  const bottom = Math.max(after, ...inner.map((c) => c.y + c.height))
  const height = Math.max(60, bottom + INSET - box.y, box.height + Math.min(0, delta))
  const grow = height - box.height
  box.height = height
  bump(box)
  if (grow > 0 && outer.length) pushBelow(s, box, outer, oldBottom, grow)
  else if (grow > 0) {
    // On the canvas itself, the top-level boxes right under it (a stack of branches or steps) move down with it.
    const inner = new Set(alive(s).filter(isNode).flatMap((n) => containedIn(s, n).map((c) => c.id)))
    const below = new Set<string>()
    for (const n of alive(s).filter((n) => isNode(n) && n.id !== id && !inner.has(n.id) && !isExact(n))) {
      if (n.y < oldBottom - 1 || n.x >= box.x + box.width || n.x + n.width <= box.x) continue
      for (const m of withContents(s, n)) below.add(m)
    }
    for (const e of alive(s)) if (below.has(e.id) && !(e.type === 'arrow' && (e.startBinding || e.endBinding))) ((e.y += grow), bump(e), moved.add(e.id))
  }
  rerouteAround(s, new Set([id, ...moved]))
  const lines = raw ? wrapText(raw, box.width - 2 * INSET, detailFont()).split('\n').length : 0
  const narrow = lines > 5 ? ` The box is narrow for it (${lines} lines): resize_node to make it wider.` : ''
  return `${raw ? (old ? 'Changed' : 'Added') : 'Removed'} the detail of ${id}.${narrow} ${lint(s, id)}`
}

export function addNode(
  s: Scene,
  o: Item & { x?: number; y?: number; nearId?: string; connectFrom?: string; width?: number; height?: number; exact?: boolean; style?: StyleIn },
) {
  const r = placeNode(s, o)
  if (o.style) applyStyle(s, find(s, r.id)!, o.style)
  return r
}

function placeNode(s: Scene, o: Parameters<typeof addNode>[1]) {
  const near = o.nearId ? find(s, o.nearId) : undefined
  if (o.nearId && !near) throw new Error(`No element with id ${o.nearId}`)
  if (o.exact) {
    // Exactly where and as big as asked: no nudging away from other boxes, no minimum size, no growing around the text.
    if (o.x === undefined || o.y === undefined) throw new Error('exact needs x and y')
    const fits = rich(o) ? richSize(o, o.width ?? richWidth(o)) : boxSize(o.text, o.width, o.height, o.shape)
    const box = markExact(makeRich(s, o, o.x, o.y, o.width ?? fits.w, o.height ?? fits.h))
    box.width = Math.max(1, o.width ?? box.width)
    box.height = Math.max(1, o.height ?? box.height)
    const t = boundText(s, box.id)
    if (t && !o.text.trim()) {
      t.isDeleted = true
      box.boundElements = (box.boundElements ?? []).filter((b: { id: string }) => b.id !== t.id)
      if (!box.boundElements.length) box.boundElements = null
    } else if (t) placeText(box, t)
    if (o.connectFrom) connect(s, o.connectFrom, box.id)
    return { id: box.id, moved: undefined }
  }
  const fits = rich(o) ? richSize(o, o.width ?? richWidth(o)) : boxSize(o.text, o.width, o.height, o.shape)
  const w = fits.w, h = Math.max(fits.h, o.height ?? 0)
  let x = o.x
  let y = o.y
  if (x === undefined || y === undefined) {
    if (near) {
      x ??= near.x + near.width + 80
      y ??= near.y
    } else {
      const els = alive(s)
      x ??= els.length ? Math.min(...els.map((e) => e.x)) : 0
      y ??= els.length ? Math.max(...els.map((e) => e.y + e.height)) + 80 : 0
    }
  }
  // Never drop a box onto something that is already there. A given x,y may still put it inside a bigger box.
  const free = clearSpot(s, x ?? 0, y ?? 0, w, h, o.x !== undefined && o.y !== undefined)
  const box = makeRich(s, o, free.x, free.y, w, h)
  if (o.connectFrom) connect(s, o.connectFrom, box.id)
  return { id: box.id, moved: o.x !== undefined && o.y !== undefined && (free.x !== o.x || free.y !== o.y) ? free : undefined }
}

const encloses = (p: El, c: El) =>
  p.id !== c.id && area(p) > area(c) && p.x <= c.x && p.y <= c.y && p.x + p.width >= c.x + c.width && p.y + p.height >= c.y + c.height

/** The containers fully around `el`, nearest first. Taken before `el` grows: afterwards it may stick out of them. */
function ancestorsOf(s: Scene, el: El) {
  return alive(s)
    .filter((p) => isNode(p) && isContainer(p) && encloses(p, el))
    .sort((a, b) => area(a) - area(b))
}

/**
 * `el` has just grown `delta` px taller (its bottom was at `oldBottom`). In each container around it, nearest first, the
 * boxes below it move down by the same amount and the container grows to keep holding them; a container that grows passes
 * its own growth on to the one around it. `outer` comes from ancestorsOf, taken before the growth. Returns what moved.
 */
function pushBelow(s: Scene, el: El, outer: El[], oldBottom: number, delta: number) {
  const moved = new Set<string>()
  let child = el
  for (const p of outer) {
    if (delta <= 0) break
    // What `child` held lies above its old bottom; a box below it may now sit inside its grown outline but still has to move.
    const ownBy = (n: El) => encloses(child, n) && n.y + n.height <= oldBottom + 1
    const inside = alive(s).filter((n) => isNode(n) && n.id !== child.id && encloses(p, n) && !ownBy(n))
    // A box below and the boxes inside it are both in the list: everything moves once.
    const group = new Set<string>()
    for (const n of inside) {
      const overlapsX = n.x < child.x + child.width && child.x < n.x + n.width
      if (!overlapsX || n.y < oldBottom - 1) continue
      for (const id of withContents(s, n)) group.add(id)
    }
    for (const e of alive(s)) if (group.has(e.id) && !(e.type === 'arrow' && (e.startBinding || e.endBinding))) ((e.y += delta), bump(e), moved.add(e.id))
    const lowest = Math.max(child.y + child.height, ...inside.map((n) => n.y + n.height))
    const pOld = p.y + p.height
    const grow = lowest + st().pad - pOld
    if (grow <= 0) break
    p.height += grow
    bump(p)
    moved.add(p.id)
    child = p
    oldBottom = pOld
    delta = grow
  }
  rerouteAround(s, moved)
  return moved
}

/**
 * Lay several boxes out inside an existing container so they use its space: picks the number of columns whose
 * grid best matches the container's proportions, wraps the text, and (with `connect`) chains them with arrows
 * in a snake order so consecutive boxes always touch. Grows the container downward only if nothing else fits.
 */
export function addNodesInside(
  s: Scene,
  containerId: string,
  items: Item[],
  o: { columns?: number; connect?: boolean; grow?: boolean } = {},
) {
  const c = find(s, containerId)
  if (!c || !isContainer(c)) throw new Error(`${containerId} is not a box or frame that can hold things`)
  if (!items.length) throw new Error('No items given')
  const title = boundText(s, c.id)
  const hasTitle = !!title && c.type !== 'frame'
  if (hasTitle) {
    title!.verticalAlign = 'top'
    title!.y = c.y + 10
    bump(title!)
  }
  const inner = containedIn(s, c)
  const titleH = hasTitle ? title!.height + 16 : 0
  const left = c.x + st().pad
  const innerW = c.width - 2 * st().pad
  const top = Math.max(c.y + st().pad + titleH, inner.length ? Math.max(...inner.map((n) => n.y + n.height)) + st().gap : 0)
  const availH = c.y + c.height - st().pad - top
  const n = items.length

  // The grid fills the container: cells take the full width and rows are stretched to the full height.
  type Plan = { cols: number; cellW: number; rowH: number[]; total: number; fits: boolean; score: number }
  const plans: Plan[] = []
  const colsList = o.columns ? [Math.min(o.columns, n)] : Array.from({ length: n }, (_, i) => i + 1)
  for (const cols of colsList) {
    const cellW = (innerW - st().gap * (cols - 1)) / cols
    if (cellW < 110 && cols > 1) continue
    const rows = Math.ceil(n / cols)
    const need = Array.from({ length: rows }, (_, r) => Math.max(60, ...items.slice(r * cols, r * cols + cols).map((it) => richSize(it, cellW).h)))
    const min = need.reduce((a, b) => a + b, 0) + st().gap * (rows - 1)
    const fits = min <= availH
    const extra = fits ? (availH - min) / rows : 0
    const rowH = need.map((h) => h + extra)
    // Prefer cells that look like boxes (about 2:1) over thin strips or tall slabs.
    plans.push({ cols, cellW, rowH, total: min + extra * rows, fits, score: Math.abs(Math.log(cellW / rowH[0] / 2)) })
  }
  if (!plans.length) throw new Error(`${containerId} is too narrow (${Math.round(innerW)}px usable) to hold boxes side by side or stacked`)
  const fitting = plans.filter((p) => p.fits)
  const plan = fitting.length ? fitting.sort((a, b) => a.score - b.score)[0] : plans.sort((a, b) => a.total - b.total)[0]

  const warnings: string[] = []
  if (!plan.fits) {
    const need = plan.total - availH
    if (o.grow === false || need <= 0) warnings.push(`The items need ${Math.round(need)}px more height than ${containerId} has.`)
    else {
      const outer = ancestorsOf(s, c)
      const oldBottom = c.y + c.height
      c.height += need + 4
      bump(c)
      pushBelow(s, c, outer, oldBottom, need + 4)
      const grew = outer.length ? `, and moved what is below it in ${outer[0].id} down with it` : '. Check what is below it (get_space)'
      warnings.push(`Grew ${containerId} downward by ${Math.round(need)}px to fit${grew}.`)
    }
  }
  const blockW = plan.cols * plan.cellW + st().gap * (plan.cols - 1)
  const x0 = left + (innerW - blockW) / 2
  const y0 = top + Math.max(0, (c.y + c.height - st().pad - top - plan.total) / 2)
  const frameId = c.type === 'frame' ? c.id : null
  const ids: string[] = []
  let y = y0
  for (let r = 0; r < plan.rowH.length; r++) {
    const row = items.slice(r * plan.cols, r * plan.cols + plan.cols)
    row.forEach((it, i) => {
      const col = o.connect && r % 2 === 1 ? plan.cols - 1 - i - (plan.cols - row.length) : i
      const box = makeRich(s, it, x0 + col * (plan.cellW + st().gap), y, plan.cellW, plan.rowH[r], frameId)
      ids.push(box.id)
    })
    y += plan.rowH[r] + st().gap
  }
  if (o.connect) for (let i = 1; i < ids.length; i++) connect(s, ids[i - 1], ids[i])
  const grid = `${plan.cols} column(s) x ${plan.rowH.length} row(s), boxes ${Math.round(plan.cellW)}px wide`
  const text = [`Added ${ids.length} boxes in ${containerId}: ${grid}.`, ids.map((id, i) => `${i + 1}. ${id}`).join('\n'), ...warnings, lint(s, containerId)].join('\n')
  return { text, ids }
}

export type Section = { title: string; items: Item[]; color?: string }
export type Column = { title: string; items?: Item[]; sections?: Section[]; color?: string }

/** A width at which most items wrap to two lines or fewer: 240..360px, narrower when there are many columns. */
function columnWidth(cols: Column[]) {
  const texts = cols.flatMap((c) => [...(c.items ?? []), ...(c.sections ?? []).flatMap((x) => x.items)].map((i) => i.text.length))
  if (!texts.length) return 260
  const typical = texts.sort((a, b) => a - b)[Math.floor(texts.length * 0.8)]
  const nested = cols.some((c) => c.sections?.length) ? 2 : 1
  const w = (typical / 2) * st().fontSize * CHAR_W + 24 + 2 * st().pad * nested
  // A word cannot wrap, so the longest one sets a floor; otherwise its box grows wider than the others in its stack.
  const words = cols.flatMap((c) => [...(c.items ?? []), ...(c.sections ?? []).flatMap((x) => x.items)].flatMap((i) => i.text.split(/\s+/)))
  const word = Math.max(0, ...words.map((x) => approxSize(x, st().fontSize).width)) + 24 + 2 * st().pad * nested + 8
  // Items that explain themselves or hold boxes need the room for it; the column is then as wide as the widest of them.
  const all = cols.flatMap((c) => [...(c.items ?? []), ...(c.sections ?? []).flatMap((x) => x.items)])
  const richW = Math.max(0, ...all.filter(rich).map(richWidth)) + 2 * st().pad * nested
  if (richW > 2 * st().pad * nested) return Math.round(Math.min(cols.length > 6 ? 420 : 600, Math.max(240, w, word, richW)))
  return Math.round(Math.min(cols.length > 6 ? 300 : 360, Math.max(240, w, word)))
}

/** A titled box at x,y, w wide, with `items` stacked inside at full width and then `sections` (titled boxes of their
 *  own, items inside). As tall as what it holds. Returns the box, the item ids and each section with its item ids. */
type Stacked = { box: El; ids: string[]; sections: { id: string; ids: string[] }[] }
function stackBox(s: Scene, title: string, x: number, y: number, w: number, items: Item[], sections: Section[], color: string | undefined, chain?: boolean, role: Role = 'container'): Stacked {
  const { pad, gap } = st()
  const box = makeBox(s, title, x, y, w, 60, color, null, { role })
  pinTitle(s, box)
  const t = boundText(s, box.id)
  let cy = y + pad + (t ? t.height + 16 : 0)
  const innerW = w - 2 * pad
  const ids: string[] = []
  for (const it of items) {
    const box = makeRich(s, it, x + pad, cy, innerW, richSize(it, innerW, 'inside').h, null, { role: 'inside' })
    ids.push(box.id)
    cy += box.height + gap
  }
  if (chain) for (let i = 1; i < ids.length; i++) connect(s, ids[i - 1], ids[i])
  const secs = sections.map((sec) => {
    const r = stackBox(s, sec.title, x + pad, cy, innerW, sec.items, [], sec.color, chain, 'section')
    cy += r.box.height + gap
    return { id: r.box.id, ids: r.ids }
  })
  box.height = Math.max(60, cy - gap + pad - y)
  bump(box)
  return { box, ids, sections: secs }
}

/**
 * A left-to-right row of titled columns, each with its items stacked inside (a timeline by day, phases, a board), and
 * optionally titled sections inside a column (Plan A / Plan B): one call instead of a box per item, and wide instead of
 * one long vertical stack. Each column is as tall as its own content; every box in a column has the same width.
 */
export function addColumns(s: Scene, cols: Column[], o: { x?: number; y?: number; width?: number; connect?: boolean; chain?: boolean } = {}) {
  if (!cols.length) throw new Error('No columns given')
  const { x: x0, y: y0 } = freeOrigin(s, o.x, o.y)
  const w = o.width ?? columnWidth(cols)
  const made = cols.map((c, i) => stackBox(s, c.title, x0 + i * (w + 80), y0, w, c.items ?? [], c.sections ?? [], c.color, o.chain))
  if (o.connect) for (let i = 1; i < made.length; i++) connect(s, made[i - 1].box.id, made[i].box.id)
  const line = (r: (typeof made)[number], i: number) => {
    const secs = r.sections.map((x, k) => `[${x.id} "${cols[i].sections![k].title}": ${x.ids.join(', ') || '(empty)'}]`)
    return `${r.box.id} "${cols[i].title}": ${[r.ids.join(', '), ...secs].filter(Boolean).join(' ') || '(empty)'}`
  }
  const text = [`Added ${made.length} columns left to right at ${Math.round(x0)},${Math.round(y0)}, each ${w}px wide:`, ...made.map(line), lint(s)].join('\n')
  // `ids` of a column: its own items, then each section followed by its items, in drawing order.
  const columns = made.map((r) => ({ id: r.box.id, ids: [...r.ids, ...r.sections.flatMap((x) => [x.id, ...x.ids])], ...(r.sections.length ? { sections: r.sections } : {}) }))
  return { text, ids: made.map((r) => r.box.id), columns }
}

export type GraphNode = Item & { key: string; group?: string }
export type GraphEdge = { from: string; to: string; label?: string }
export type GraphGroup = { key: string; title: string; color?: string }

// Room a group needs around its members: padding, and a title on top.
const GROUP_PAD = 24
const GROUP_TITLE = 44
const graphSizes = (nodes: GraphNode[]) => new Map(nodes.map((n) => [n.key, richSize(n, richWidth(n), n.group ? 'inside' : undefined)]))

/**
 * Parts that nothing connects (no arrow, no shared group), in the order they were given. Each is laid out on its own and
 * they are placed one under the other for LR (side by side for TB): a layout engine alone would put them in any order.
 */
function graphParts(nodes: GraphNode[], edges: GraphEdge[]) {
  const root = new Map(nodes.map((n) => [n.key, n.key]))
  const top = (k: string): string => (root.get(k) === k ? k : top(root.get(k)!))
  const join = (a: string, b: string) => root.set(top(b), top(a))
  for (const e of edges) join(e.from, e.to)
  const firstOf = new Map<string, string>()
  for (const n of nodes) if (n.group) firstOf.has(n.group) ? join(firstOf.get(n.group)!, n.key) : firstOf.set(n.group, n.key)
  const parts = new Map<string, GraphNode[]>()
  for (const n of nodes) parts.set(top(n.key), [...(parts.get(top(n.key)) ?? []), n])
  return [...parts.values()]
}

/** Top-left of each box of one part, by dagre: the fallback when ELK was not run or failed. */
function dagrePart(part: GraphNode[], edges: GraphEdge[], size: Map<string, { w: number; h: number }>, dir: 'LR' | 'TB') {
  const inPart = new Set(part.map((n) => n.key))
  const partGrouped = part.some((n) => n.group)
  const g = new dagre.graphlib.Graph({ compound: partGrouped })
  // Groups add padding and a title around their members, so they need more room between them.
  g.setGraph({ rankdir: dir, nodesep: partGrouped ? 90 : 50, ranksep: partGrouped ? 130 : edges.some((e) => e.label) ? 120 : 90, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of part) g.setNode(n.key, { width: size.get(n.key)!.w, height: size.get(n.key)!.h })
  for (const n of part) if (n.group) (g.setNode(`group:${n.group}`, {}), g.setParent(n.key, `group:${n.group}`))
  for (const e of edges) if (e.from !== e.to && inPart.has(e.from)) g.setEdge(e.from, e.to)
  dagre.layout(g)
  return part.map((n) => { const p = g.node(n.key); return { key: n.key, x: p.x - p.width / 2, y: p.y - p.height / 2 } })
}

const elk = new ELK()
type ElkNode = { id: string; width?: number; height?: number; x?: number; y?: number; children?: ElkNode[]; layoutOptions?: Record<string, string>; edges?: ElkEdge[] }
type Pt = { x: number; y: number }
type ElkEdge = { id: string; sources: string[]; targets: string[]; sections?: { startPoint: Pt; endPoint: Pt; bendPoints?: Pt[] }[] }
export type GraphLayout = { pos: Map<string, Pt>; routes: Map<number, Pt[]> }

/** ELK layered layout, the same for a graph drawing and auto_layout: given order kept, groups as padded compound nodes. */
async function elkRun(children: ElkNode[], edges: { from: string; to: string; i?: number }[], dir: 'LR' | 'TB', o: { grouped: boolean; labels: boolean }) {
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': dir === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      // Keep the order the boxes were given (days stay in order), unless crossings force otherwise.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.spacing.nodeNodeBetweenLayers': String(o.grouped ? 110 : o.labels ? 110 : 80),
      'elk.spacing.nodeNode': String(o.grouped ? 50 : 40),
      'elk.spacing.componentComponent': '80',
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
    },
    children,
    edges: edges.map((e, k) => ({ id: `e${e.i ?? k}`, sources: [e.from], targets: [e.to] })),
  }
  const out = (await elk.layout(graph as never)) as ElkNode
  const pos = new Map<string, { x: number; y: number }>()
  const groupAt = new Map<string, Pt>([['root', { x: 0, y: 0 }]])
  const parent = new Map<string, string>()
  const walk = (n: ElkNode, ox: number, oy: number) => {
    for (const c of n.children ?? []) {
      const x = ox + (c.x ?? 0), y = oy + (c.y ?? 0)
      parent.set(c.id, n.id)
      if (c.children?.length) (groupAt.set(c.id, { x, y }), walk(c, x, y))
      else pos.set(c.id, { x, y })
    }
  }
  walk(out, 0, 0)
  // An edge between two boxes of one group comes back in that group's coordinates; the others in the root's.
  const routes = new Map<number, Pt[]>()
  const collect = (n: ElkNode) => {
    for (const e of n.edges ?? []) {
      const sec = e.sections?.[0]
      if (!sec) continue
      const ps = parent.get(e.sources[0]), pt = parent.get(e.targets[0])
      const o = ps && ps === pt ? groupAt.get(ps) ?? { x: 0, y: 0 } : { x: 0, y: 0 }
      routes.set(+e.id.slice(1), [sec.startPoint, ...(sec.bendPoints ?? []), sec.endPoint].map((p) => ({ x: p.x + o.x, y: p.y + o.y })))
    }
    for (const c of n.children ?? []) collect(c)
  }
  collect(out)
  return { pos, routes }
}

/**
 * Where each box of a graph drawing goes, by ELK (fewer crossings than dagre, and groups laid out as real compound
 * nodes). Async, so it runs before mutate; addGraph takes the result as `layout`. Null when ELK fails: dagre then.
 */
export async function elkPositions(nodes: GraphNode[], edges: GraphEdge[], o: { direction?: 'LR' | 'TB' } = {}) {
  try {
    const size = graphSizes(nodes)
    const pos = new Map<string, Pt>()
    const routes = new Map<number, Pt[]>()
    for (const part of graphParts(nodes, edges)) {
      const inPart = new Set(part.map((n) => n.key))
      const box = (n: GraphNode): ElkNode => ({ id: n.key, width: size.get(n.key)!.w, height: size.get(n.key)!.h })
      const groups = [...new Set(part.map((n) => n.group).filter((g): g is string => !!g))]
      const children: ElkNode[] = [
        ...part.filter((n) => !n.group).map(box),
        ...groups.map((g) => ({
          id: `group:${g}`,
          layoutOptions: { 'elk.padding': `[top=${GROUP_PAD + GROUP_TITLE},left=${GROUP_PAD},bottom=${GROUP_PAD},right=${GROUP_PAD}]` },
          children: part.filter((n) => n.group === g).map(box),
        })),
      ]
      // Group nodes come in the order of their first member, so the model order matches the order given.
      const first = (c: ElkNode) => part.findIndex((n) => n.key === c.id || `group:${n.group}` === c.id)
      children.sort((a, b) => first(a) - first(b))
      const es = edges.map((e, i) => ({ ...e, i })).filter((e) => e.from !== e.to && inPart.has(e.from) && inPart.has(e.to))
      const r = await elkRun(children, es, o.direction ?? 'LR', { grouped: groups.length > 0, labels: edges.some((e) => e.label) })
      for (const [k, p] of r.pos) pos.set(k, p)
      for (const [k, p] of r.routes) routes.set(k, p)
    }
    return { pos, routes } as GraphLayout
  } catch {
    return null
  }
}

/**
 * A whole flow in one call: boxes keyed by the caller, arrows between keys, optional groups (a titled box around
 * its members), laid out by dagre left to right (or top to bottom) and placed below what is already there.
 */
export function addGraph(
  s: Scene,
  nodes: GraphNode[],
  edges: GraphEdge[],
  o: { groups?: GraphGroup[]; direction?: 'LR' | 'TB'; x?: number; y?: number; layout?: GraphLayout } = {},
) {
  if (!nodes.length) throw new Error('No nodes given')
  const keys = new Set<string>()
  for (const n of nodes) {
    if (keys.has(n.key)) throw new Error(`Node key "${n.key}" is used twice`)
    keys.add(n.key)
  }
  const groups = new Map((o.groups ?? []).map((g) => [g.key, g]))
  for (const n of nodes) if (n.group && !groups.has(n.group)) groups.set(n.group, { key: n.group, title: n.group })
  for (const e of edges) for (const k of [e.from, e.to]) if (!keys.has(k)) throw new Error(`Edge ${e.from} -> ${e.to}: no node with key "${k}"`)

  const pad = GROUP_PAD
  const titleH = GROUP_TITLE
  const grouped = groups.size > 0
  const dir = o.direction ?? 'LR'
  const size = graphSizes(nodes)
  const parts = graphParts(nodes, edges)

  const pos = new Map<string, { x: number; y: number }>()
  // How each ELK-laid part was moved into place, so its arrow routes move with it.
  const shiftOf = new Map<string, Pt>()
  let offset = 0
  for (const part of parts) {
    const partGrouped = part.some((n) => n.group)
    // ELK's positions when they were computed for every box of this part (before mutate, since ELK is async), else dagre.
    const elkOk = part.every((n) => o.layout?.pos.has(n.key))
    const local = elkOk ? part.map((n) => ({ key: n.key, ...o.layout!.pos.get(n.key)! })) : dagrePart(part, edges, size, dir)
    // Room for the group padding and title around this part.
    const x0 = Math.min(...local.map((p) => p.x)) - (partGrouped ? pad : 0)
    const y0 = Math.min(...local.map((p) => p.y)) - (partGrouped ? pad + titleH : 0)
    const x1 = Math.max(...local.map((p) => p.x + size.get(p.key)!.w)) + (partGrouped ? pad : 0)
    const y1 = Math.max(...local.map((p) => p.y + size.get(p.key)!.h)) + (partGrouped ? pad : 0)
    const shift = dir === 'LR' ? { x: -x0, y: -y0 + offset } : { x: -x0 + offset, y: -y0 }
    for (const p of local) pos.set(p.key, { x: p.x + shift.x, y: p.y + shift.y })
    if (elkOk) for (const n of part) shiftOf.set(n.key, shift)
    offset += (dir === 'LR' ? y1 - y0 : x1 - x0) + (partGrouped ? 50 : 80)
  }

  // Top-left of the drawing, with room for the group titles and padding.
  const minX = Math.min(...nodes.map((n) => pos.get(n.key)!.x)) - (grouped ? pad : 0)
  const minY = Math.min(...nodes.map((n) => pos.get(n.key)!.y)) - (grouped ? pad + titleH : 0)
  const origin = freeOrigin(s, o.x, o.y)
  const at = (p: { x: number; y: number }) => ({ x: origin.x + p.x - minX, y: origin.y + p.y - minY })

  const behind = s.elements.length
  const ids = new Map<string, string>()
  for (const n of nodes) {
    const p = at(pos.get(n.key)!)
    ids.set(n.key, makeRich(s, n, p.x, p.y, size.get(n.key)!.w, size.get(n.key)!.h, null, { role: n.group ? 'inside' : undefined }).id)
  }
  // Groups go around the boxes as drawn (a long word can make a box wider than planned), and behind them.
  const groupIds = new Map<string, string>()
  for (const [k, gr] of groups) {
    const members = nodes.filter((n) => n.group === k).map((n) => find(s, ids.get(n.key)!)!)
    if (!members.length) continue
    const x1 = Math.min(...members.map((m) => m.x)) - pad
    const y1 = Math.min(...members.map((m) => m.y)) - pad - titleH
    const x2 = Math.max(...members.map((m) => m.x + m.width)) + pad
    const y2 = Math.max(...members.map((m) => m.y + m.height)) + pad
    const box = makeBox(s, gr.title, x1, y1, x2 - x1, y2 - y1, gr.color, null, { role: 'container' })
    pinTitle(s, box)
    s.elements.splice(behind, 0, ...s.elements.splice(s.elements.length - 2, 2))
    groupIds.set(k, box.id)
  }
  const arrows = edges.map((e, i) => {
    const id = connect(s, ids.get(e.from)!, ids.get(e.to)!, e.label)
    const route = o.layout?.routes.get(i)
    const shift = shiftOf.get(e.from)
    // ELK routed it around the boxes as they were planned; a box that grew past its planned size gets routeArrow's path.
    const same = (k: string) => { const el = find(s, ids.get(k)!)!, z = size.get(k)!; return Math.abs(el.width - z.w) < 1 && Math.abs(el.height - z.h) < 1 }
    if (route && shift && same(e.from) && same(e.to)) applyRoute(s, find(s, id)!, find(s, ids.get(e.from)!)!, find(s, ids.get(e.to)!)!, route.map((p) => at({ x: p.x + shift.x, y: p.y + shift.y })))
    return id
  })
  const text = [
    `Added ${nodes.length} boxes, ${arrows.length} arrow(s)${groupIds.size ? ` and ${groupIds.size} group(s)` : ''}, ${o.direction === 'TB' ? 'top to bottom' : 'left to right'}, at ${Math.round(origin.x)},${Math.round(origin.y)}:`,
    [...ids].map(([k, id]) => `${k}=${id}`).join(' '),
    ...(groupIds.size ? [`groups: ${[...groupIds].map(([k, id]) => `${k}=${id}`).join(' ')}`] : []),
    lint(s),
  ].join('\n')
  return { text, ids: Object.fromEntries(ids), groups: Object.fromEntries(groupIds) }
}

/**
 * The flowchart part of Mermaid: `flowchart LR|TD`, nodes `A[text]` `A(text)` `A{text}` `A((text))` and the like,
 * edges `-->` `---` `-.->` `==>` with `|label|` or `-- label -->`, chains `A --> B --> C`, `A & B --> C`, and
 * `subgraph id [title] ... end`. Styling lines (classDef, style, class, linkStyle, click) are ignored.
 */
export function parseMermaid(code: string) {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const groups: GraphGroup[] = []
  const stack: string[] = []
  let direction: 'LR' | 'TB' = 'TB'
  const clean = (t: string) => t.trim().replace(/^"(.*)"$/s, '$1').replace(/<br\s*\/?>/gi, '\n').replace(/\\n/g, '\n').trim()
  const node = (tok: string) => {
    const m = /^([\p{L}\p{N}_.:-]+)\s*(?:(\[\[|\[\(|\(\[|\(\(|\{\{|\[\/|\[\\|\[|\(|\{|>)(.*?)(\]\]|\)\]|\]\)|\)\)|\}\}|\/\]|\\\]|\]|\)|\})(?::::[\w-]+)?)?$/u.exec(tok.trim())
    if (!m) throw new Error(`Cannot read node "${tok.trim()}"`)
    const key = m[1]
    const have = nodes.get(key)
    // {decision} is a diamond; ((circle)) and ([stadium]) are ellipses (start / end); the rest stay boxes.
    const shape: Shape | undefined = m[2] === '{' ? 'diamond' : m[2] === '((' || m[2] === '([' ? 'ellipse' : undefined
    if (!have) nodes.set(key, { key, text: m[3] !== undefined ? clean(m[3]) : key, group: stack.at(-1), ...(shape ? { shape } : {}) })
    else if (m[3] !== undefined) Object.assign(have, { text: clean(m[3]) }, shape ? { shape } : {})
    return key
  }
  // `A -- text --> B` and friends become `A -->|text| B`.
  const normalise = (l: string) =>
    l
      .replace(/\s--\s*([^->|][^>]*?)\s*-->/g, ' -->|$1|')
      .replace(/\s==\s*([^=>|][^>]*?)\s*==>/g, ' ==>|$1|')
      .replace(/\s-\.\s*([^.>|][^>]*?)\s*\.->/g, ' -.->|$1|')
  const EDGE = /\s*(?:<-->|-->|---|-\.->|-\.-|==>|===|--[xo])\s*(?:\|([^|]*)\|)?\s*/
  for (const raw of code.split(/\n|;/)) {
    const l = raw.replace(/%%.*$/, '').trim()
    if (!l) continue
    let m
    if ((m = /^(?:flowchart|graph)\b\s*(LR|RL|TB|TD|BT)?/i.exec(l))) {
      direction = m[1] && /^(LR|RL)$/i.test(m[1]) ? 'LR' : 'TB'
      continue
    }
    if (/^(classDef|class|style|linkStyle|click|direction)\b/.test(l)) continue
    if ((m = /^subgraph\s+(.+)$/.exec(l))) {
      const sm = /^([\p{L}\p{N}_.-]+)\s*\[(.*)\]$/u.exec(m[1].trim())
      const key = sm ? sm[1] : `g${groups.length + 1}`
      groups.push({ key, title: clean(sm ? sm[2] : m[1]) })
      stack.push(key)
      continue
    }
    if (l === 'end') {
      stack.pop()
      continue
    }
    const parts = normalise(` ${l}`).trim().split(new RegExp(EDGE.source))
    // split with one capture group: node, label, node, label, node...
    let prev: string[] | null = null
    for (let i = 0; i < parts.length; i += 2) {
      const here = parts[i].split('&').map((t) => node(t))
      if (prev) for (const a of prev) for (const b of here) edges.push({ from: a, to: b, label: parts[i - 1] ? clean(parts[i - 1]) : undefined })
      prev = here
    }
  }
  return { nodes: [...nodes.values()], edges, groups, direction }
}

/**
 * A table of boxes: column headers along the top, row labels down the left, one box per non-empty cell
 * (e.g. days across, Plan A / Plan B down). `connect` draws arrows along each row between its filled cells.
 */
export function addGrid(
  s: Scene,
  g: { columns: string[]; rows: string[]; cells: (string | null)[][]; x?: number; y?: number; width?: number; connect?: boolean; color?: string },
) {
  if (!g.columns.length || !g.rows.length) throw new Error('Give at least one column and one row')
  if (g.cells.length !== g.rows.length || g.cells.some((r) => r.length > g.columns.length))
    throw new Error(`cells must have one row per row label (${g.rows.length}) and at most ${g.columns.length} entries per row`)
  const origin = freeOrigin(s, g.x, g.y)
  const colW = g.width ?? 220
  const labelW = Math.min(220, Math.max(140, ...g.rows.map((r) => boxSize(r).w)))
  const gap = g.connect ? 60 : st().gap
  const headH = Math.max(...g.columns.map((c) => boxSize(c, colW).h))
  const rowH = g.rows.map((r, i) => Math.max(boxSize(r, labelW).h, ...g.cells[i].map((c) => (c ? boxSize(c, colW).h : 0))))
  const colX = (c: number) => origin.x + labelW + gap + c * (colW + gap)
  const heads = g.columns.map((c, i) => makeBox(s, c, colX(i), origin.y, colW, headH, g.color, null, { role: 'header' }).id)
  let y = origin.y + headH + gap
  const labels: string[] = []
  const cells: (string | null)[][] = []
  g.rows.forEach((r, i) => {
    labels.push(makeBox(s, r, origin.x, y, labelW, rowH[i], g.color, null, { role: 'header' }).id)
    const row = g.columns.map((_, c) => (g.cells[i][c] ? makeBox(s, g.cells[i][c]!, colX(c), y, colW, rowH[i]).id : null))
    if (g.connect) {
      const filled = row.filter((id): id is string => !!id)
      for (let k = 1; k < filled.length; k++) connect(s, filled[k - 1], filled[k])
    }
    cells.push(row)
    y += rowH[i] + gap
  })
  const text = [
    `Added a ${g.rows.length}x${g.columns.length} grid at ${Math.round(origin.x)},${Math.round(origin.y)}:`,
    `columns: ${heads.join(' ')}`,
    ...g.rows.map((r, i) => `${labels[i]} "${r}": ${cells[i].map((c) => c ?? '-').join(' ')}`),
    lint(s),
  ].join('\n')
  return { text, ids: labels, columns: heads, cells }
}

export type TimelineItem = Inner & { start: string | number; end?: string | number }
export type TimelineLane = { title?: string; items: TimelineItem[] }
export type TimelineRow = { title: string; items?: TimelineItem[]; lanes?: TimelineLane[]; color?: string }

/** A point on a timeline axis: a clock time ("09:30", minutes), a date ("2026-11-13", days) or a plain number (a week,
 *  a sprint, a year). Every point of one timeline must be of the same kind. */
type Unit = 'time' | 'date' | 'number'
function parsePoint(v: string | number): { unit: Unit; at: number } {
  if (typeof v === 'number') return { unit: 'number', at: v }
  const t = v.trim().replace(/^~\s*/, '')
  const clock = /^([01]?\d|2[0-4])[:.h]([0-5]\d)$/.exec(t)
  if (clock) return { unit: 'time', at: +clock[1] * 60 + +clock[2] }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (date) return { unit: 'date', at: Date.UTC(+date[1], +date[2] - 1, +date[3]) / 86_400_000 }
  if (/^-?\d+(\.\d+)?$/.test(t)) return { unit: 'number', at: +t }
  throw new Error(`"${v}" is not a time ("09:30"), a date ("2026-11-13") or a number`)
}
const showPoint = (unit: Unit, at: number) =>
  unit === 'time'
    ? `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(Math.round(at % 60)).padStart(2, '0')}`
    : unit === 'date'
      ? new Date(at * 86_400_000).toISOString().slice(5, 10).split('-').reverse().join('/')
      : String(at)
/** Tick spacing on the axis: whole hours / days / numbers, wider when the range is long. */
function tickStep(unit: Unit, per: number, labelW: number) {
  const steps = unit === 'time' ? [15, 30, 60, 120, 180, 240, 360] : unit === 'date' ? [1, 2, 7, 14, 30] : [1, 2, 5, 10, 20, 50, 100, 250, 500, 1000]
  return steps.find((x) => x * per >= labelW + 24) ?? steps[steps.length - 1]
}

/**
 * A timeline: one row per row label (a day, a person, a team, a project), optionally split into titled lanes (Plan A /
 * Plan B, alternatives, sub-teams), with each item placed and sized on a shared horizontal axis by its start and end, and
 * the axis ticks along the top. An item without an end lasts until the next item of its lane. Items that would overlap in
 * a lane go on a second line of that lane. Reads like a calendar: what happens when, and where the gaps are.
 */
export function addTimeline(s: Scene, rows: TimelineRow[], o: { x?: number; y?: number; unitWidth?: number; showTimes?: boolean } = {}) {
  if (!rows.length) throw new Error('No rows given')
  const lanesOf = (r: TimelineRow): TimelineLane[] => [...(r.items?.length ? [{ items: r.items }] : []), ...(r.lanes ?? [])]
  // The axis kind is the most common one among the starts; an item whose start or end is not of that kind (or not a
  // point at all) is drawn without that value, and the result says so, instead of failing the whole drawing.
  const tryPoint = (v: string | number | undefined) => {
    if (v === undefined || v === '') return undefined
    try {
      return parsePoint(v)
    } catch {
      return null
    }
  }
  const kinds = rows.flatMap((r) => lanesOf(r).flatMap((l) => l.items.map((it) => tryPoint(it.start)?.unit))).filter((k): k is Unit => !!k)
  if (!kinds.length) throw new Error('No item has a start that is a time ("09:30"), a date ("2026-11-13") or a number.')
  const unit = (['time', 'date', 'number'] as Unit[]).map((k) => [k, kinds.filter((x) => x === k).length] as const).sort((a, b) => b[1] - a[1])[0][0]
  const skipped: string[] = []
  const pointOf = (v: string | number | undefined, what: string, text: string) => {
    const p = tryPoint(v)
    if (p === undefined) return undefined
    if (p && p.unit === unit) return p
    skipped.push(`${what} "${v}" of "${text}"`)
    return null
  }
  const parsed = rows.map((r) =>
    lanesOf(r).map((l) => ({
      title: l.title,
      items: l.items.flatMap((it, n) => {
        const a = pointOf(it.start, 'start', it.text)
        if (!a) return []
        const b = pointOf(it.end, 'end', it.text)
        return [{ it, n, a, b: b ?? undefined }]
      }),
    })),
  )
  if (!parsed.flat(2).length) throw new Error('No items given')
  // An open-ended item runs until the next item in its lane; the last one gets a typical length.
  const typical = unit === 'time' ? 60 : 1
  const spans = parsed.map((lanes) =>
    lanes.map((l) => {
      const sorted = [...l.items].sort((p, q) => p.a.at - q.a.at)
      return sorted.map((i, k) => {
        const next = sorted.slice(k + 1).find((n) => n.a.at > i.a.at)
        const end = i.b?.at ?? (next ? next.a.at : i.a.at + typical)
        return { ...i, from: i.a.at, to: Math.max(end, i.a.at) }
      })
    }),
  )
  const all = spans.flat(2)
  const first = Math.min(...all.map((i) => i.from))
  const last = Math.max(...all.map((i) => i.to))
  const show = o.showTimes ?? unit === 'time'
  const label = (i: (typeof all)[number]) => (show ? `${showPoint(unit, i.from)} ${i.it.text}` : i.it.text)
  // No box narrower than its own longest word, which would otherwise widen it past its end and into the next item.
  // Per item: one long word elsewhere ("Lauterbrunnen") must not make every short item wide and push it onto a new line.
  const wordW = (t: string) => Math.max(...t.split(/\s+/).map((w) => approxSize(w, st().fontSize).width)) + 36
  const minOf = (i: (typeof all)[number]) => Math.max(110, wordW(label(i)))
  const minW = Math.max(110, ...all.map(minOf).sort((a, b) => a - b).slice(0, Math.ceil(all.length / 2)))
  // Scale: a typical item gets about 200px and a short one still fits; the whole axis stays under about 4000px.
  const durs = all.map((i) => i.to - i.from).filter((d) => d > 0).sort((a, b) => a - b)
  const median = durs[Math.floor(durs.length / 2)] || typical
  const short = durs[Math.floor(durs.length / 10)] || typical
  const per = o.unitWidth ? o.unitWidth / (unit === 'time' ? 60 : 1) : Math.min(Math.max(200 / median, (minW + 6) / short), 4000 / Math.max(1, last - first))
  const step = tickStep(unit, per, approxSize(showPoint(unit, first), st().fontSize).width)
  // Clock times and numbers start on a round tick; dates start on the first date (a round number of days means nothing).
  const lo = unit === 'date' ? first : Math.floor(first / step) * step
  const hi = lo + Math.ceil((last - lo) / step) * step
  const { gap, pad } = st()
  const origin = freeOrigin(s, o.x, o.y)
  const rowLabelW = Math.min(260, Math.max(160, ...rows.map((r) => boxSize(r.title).w)))
  const laneTitles = spans.some((_, i) => parsed[i].some((l) => l.title))
  const laneLabelW = laneTitles ? Math.min(200, Math.max(110, ...parsed.flat().map((l) => (l.title ? boxSize(l.title).w : 0)))) : 0
  const axisX = origin.x + rowLabelW + gap + (laneTitles ? laneLabelW + gap : 0)
  const at = (v: number) => axisX + (v - lo) * per
  // Axis ticks along the top.
  const tickIds: string[] = []
  for (let v = lo; v <= hi; v += step) {
    const t = makeText(s, showPoint(unit, v), 0, origin.y, null)
    t.x = at(v) - t.width / 2
    s.elements.push(t)
    tickIds.push(t.id)
  }
  let y = origin.y + st().fontSize * LINE_H + gap
  const out: { id: string; lanes: { id?: string; ids: string[] }[] }[] = []
  rows.forEach((r, ri) => {
    const rowTop = y
    const lanes: { id?: string; ids: string[] }[] = []
    spans[ri].forEach((items, li) => {
      // Pack into lines: an item goes on the first line where it does not touch the one before.
      const placed = items.map((i) => {
        const x = at(i.from)
        const w = Math.max(minOf(i), (i.to - i.from) * per - 6)
        return { i, x, w, h: richSize({ ...i.it, text: label(i) }, w).h, line: 0 }
      })
      const ends: number[] = []
      for (const p of placed) {
        // Half a pixel of slack: an item that starts where the last one ends must not drop a line over a rounding error.
        let line = ends.findIndex((e) => p.x >= e + 6 - 0.5)
        if (line < 0) line = ends.length
        ends[line] = p.x + p.w
        p.line = line
      }
      const lineH = ends.map((_, k) => Math.max(60, ...placed.filter((p) => p.line === k).map((p) => p.h)))
      const lineY = lineH.map((_, k) => y + lineH.slice(0, k).reduce((a, b) => a + b + gap / 2, 0))
      const laneH = Math.max(60, lineH.reduce((a, b) => a + b, 0) + (lineH.length - 1) * (gap / 2))
      const title = parsed[ri][li].title
      const laneId = title ? makeBox(s, title ?? '', origin.x + rowLabelW + gap, y, laneLabelW, laneH, r.color, null, { role: 'header' }).id : undefined
      // In the order the items were given, not by time, so the caller can match them up.
      const ids: string[] = []
      for (const p of placed) ids[p.i.n] = makeRich(s, { ...p.i.it, text: label(p.i) }, p.x, lineY[p.line], p.w, lineH[p.line]).id
      for (let k = 0; k < ids.length; k++) ids[k] ??= '' // an item that was left out keeps its place in the list
      lanes.push({ id: laneId, ids })
      y += laneH + gap / 2
    })
    const rowH = Math.max(60, y - gap / 2 - rowTop)
    const id = makeBox(s, r.title, origin.x, rowTop, rowLabelW, rowH, r.color, null, { role: 'header' }).id
    out.push({ id, lanes })
    y = rowTop + rowH + gap * 1.5
  })
  const text = [
    `Added a timeline at ${Math.round(origin.x)},${Math.round(origin.y)}: axis ${showPoint(unit, lo)}..${showPoint(unit, hi)}, a tick every ${unit === 'time' ? `${step} min` : unit === 'date' ? `${step} day(s)` : step}, ${Math.round((hi - lo) * per)}px wide.`,
    ...out.map((r, i) => `${r.id} "${rows[i].title}": ${r.lanes.map((l, k) => (l.id ? `[${l.id} "${parsed[i][k].title ?? ''}": ${l.ids.join(', ') || '(empty)'}]` : l.ids.join(', '))).join(' ') || '(empty)'}`),
    ...(skipped.length ? [`Not drawn as given (not a ${unit} like the rest; items without a usable start were left out, a bad end was dropped): ${skipped.join('; ')}. Put such details in notes, or fix them and draw again.`] : []),
    lint(s),
  ].join('\n')
  return { text, ids: out.map((r) => r.id), rows: out, ticks: tickIds }
}

export type TreeNode = Item & { key: string; parent?: string }

/**
 * A hierarchy: every node names its parent, roots have none. Drawn top-down (or left to right) by the graph layout with
 * one arrow per parent → child, siblings kept in the order given. Cycles and unknown parents are refused, not guessed.
 */
export function addTree(s: Scene, nodes: TreeNode[], o: { direction?: 'TB' | 'LR'; x?: number; y?: number; layout?: GraphLayout } = {}) {
  const keys = new Set(nodes.map((n) => n.key))
  for (const n of nodes) if (n.parent && !keys.has(n.parent)) throw new Error(`Node "${n.key}": no node with key "${n.parent}" to be its parent`)
  const parent = new Map(nodes.map((n) => [n.key, n.parent]))
  for (const n of nodes) {
    const seen = new Set<string>()
    for (let k: string | undefined = n.key; k; k = parent.get(k)) {
      if (seen.has(k)) throw new Error(`Node "${n.key}" is its own ancestor: a tree has no cycles`)
      seen.add(k)
    }
  }
  const edges = treeEdges(nodes)
  const r = addGraph(s, nodes.map(({ parent: _, ...n }) => n), edges, { direction: o.direction ?? 'TB', x: o.x, y: o.y, layout: o.layout })
  const roots = nodes.filter((n) => !n.parent).length
  return { ...r, text: r.text.replace(/^Added (\d+) boxes/, `Added a tree of $1 boxes (${roots} root${roots > 1 ? 's' : ''})`) }
}
export const treeEdges = (nodes: TreeNode[]): GraphEdge[] => nodes.filter((n) => n.parent).map((n) => ({ from: n.parent!, to: n.key }))

// ---------------------------------------------------------------- every Excalidraw element and style
export const FONTS = { hand: 5, normal: 6, code: 8, virgil: 1, helvetica: 2, cascadia: 3, lilita: 7 } as const
export const ARROWHEADS = ['none', 'arrow', 'triangle', 'triangle_outline', 'bar', 'dot', 'circle', 'circle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many'] as const
export const FILLS = ['hachure', 'cross-hatch', 'solid', 'zigzag'] as const
const ROUGH = { architect: 0, artist: 1, cartoonist: 2 } as const

/** What the Excalidraw properties panel can set on an element, in the panel's own terms. Every field is optional. */
export type StyleIn = {
  stroke?: string
  background?: string
  fillStyle?: (typeof FILLS)[number]
  strokeWidth?: number
  strokeStyle?: 'solid' | 'dashed' | 'dotted'
  sloppiness?: keyof typeof ROUGH
  edges?: 'sharp' | 'round'
  opacity?: number
  angle?: number
  font?: keyof typeof FONTS
  fontSize?: number
  textAlign?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  startArrowhead?: (typeof ARROWHEADS)[number]
  endArrowhead?: (typeof ARROWHEADS)[number]
  arrowType?: 'sharp' | 'curved' | 'elbow'
  link?: string
  locked?: boolean
}

/** A colour given as a palette name (its stroke, or its soft fill for a background), a hex value or "transparent". */
function colorValue(c: string, as: 'stroke' | 'fill') {
  const v = c.trim().toLowerCase()
  if (PALETTE[v]) return PALETTE[v][as === 'stroke' ? 0 : 1]
  if (v === 'transparent' || v === 'none') return 'transparent'
  if (/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return v
  throw new Error(`Unknown colour "${c}": use ${Object.keys(PALETTE).join(', ')}, a hex like #1e1e1e, or transparent`)
}

const roundnessFor = (type: string, round: boolean) => (!round || type === 'ellipse' || type === 'text' || type === 'freedraw' || type === 'image' ? null : { type: type === 'rectangle' || type === 'frame' || type === 'embeddable' ? 3 : 2 })

/** Re-measure a text after its font changed, and re-centre it in its container (or keep its centre when free). */
function refitText(s: Scene, t: El) {
  const container = t.containerId ? find(s, t.containerId) : undefined
  const raw = t.originalText ?? t.text
  const shown = container && !LINEAR.has(container.type) ? wrapText(raw, container.width * room(container.type) - 24, t.fontSize) : raw
  const c = center(t)
  t.text = shown
  Object.assign(t, approxSize(shown, t.fontSize))
  if (container && !LINEAR.has(container.type)) fit(container, t)
  else ((t.x = c.x - t.width / 2), (t.y = c.y - t.height / 2))
  bump(t)
}

/**
 * Set what the Excalidraw properties panel sets: stroke and background colour, fill style, stroke width and style,
 * sloppiness, edges, opacity, rotation, font, size and alignment of its text, arrowheads, arrow type, link, lock.
 * Stroke, opacity and rotation also go to the element's own text, as on the page. Returns what did not apply.
 */
export function applyStyle(s: Scene, el: El, o: StyleIn): string[] {
  const skipped: string[] = []
  const t = el.type === 'text' ? el : boundText(s, el.id)
  const linear = LINEAR.has(el.type)
  const self = [el, ...(t && t !== el ? [t] : [])]
  if (o.stroke !== undefined) for (const e of self) e.strokeColor = colorValue(o.stroke, 'stroke')
  if (o.background !== undefined) {
    if (el.type === 'text' || el.type === 'image') skipped.push(`background (a ${el.type} has none)`)
    else el.backgroundColor = colorValue(o.background, 'fill')
  }
  if (o.fillStyle) el.fillStyle = o.fillStyle
  if (o.strokeWidth !== undefined) el.strokeWidth = o.strokeWidth
  if (o.strokeStyle) el.strokeStyle = o.strokeStyle
  if (o.sloppiness) el.roughness = ROUGH[o.sloppiness]
  if (o.opacity !== undefined) for (const e of self) e.opacity = Math.max(0, Math.min(100, o.opacity))
  if (o.angle !== undefined) {
    if (linear) skipped.push('angle (rotate a line by moving its points)')
    else for (const e of self) e.angle = (((o.angle % 360) + 360) % 360) * (Math.PI / 180)
  }
  if (o.edges) {
    if (el.type === 'ellipse' || el.type === 'text' || el.type === 'image' || el.type === 'freedraw') skipped.push(`edges (a ${el.type} has no corners)`)
    else if (el.type === 'arrow' && el.elbowed) skipped.push('edges (use arrowType for an arrow)')
    else el.roundness = roundnessFor(el.type, o.edges === 'round')
  }
  if (o.font || o.fontSize || o.textAlign || o.verticalAlign) {
    if (!t) skipped.push('font/text settings (it has no text)')
    else {
      if (o.font) t.fontFamily = FONTS[o.font]
      if (o.fontSize) t.fontSize = o.fontSize
      if (o.textAlign) t.textAlign = o.textAlign
      if (o.verticalAlign) t.verticalAlign = o.verticalAlign
      refitText(s, t)
    }
  }
  if (o.startArrowhead || o.endArrowhead) {
    if (!linear) skipped.push(`arrowheads (${el.id} is a ${el.type}, not a line or arrow)`)
    else {
      if (o.startArrowhead) el.startArrowhead = o.startArrowhead === 'none' ? null : o.startArrowhead
      if (o.endArrowhead) el.endArrowhead = o.endArrowhead === 'none' ? null : o.endArrowhead
    }
  }
  if (o.arrowType) {
    if (!linear) skipped.push(`arrowType (${el.id} is a ${el.type})`)
    else if (o.arrowType === 'elbow' && (el.type !== 'arrow' || !el.startBinding || !el.endBinding)) skipped.push('arrowType elbow (only for an arrow attached to two elements)')
    else {
      el.elbowed = o.arrowType === 'elbow'
      el.roundness = o.arrowType === 'curved' ? { type: 2 } : null
      if (el.elbowed) el.fixedSegments = null
      else delete el.fixedSegments
      const a = el.startBinding && find(s, el.startBinding.elementId)
      const b = el.endBinding && find(s, el.endBinding.elementId)
      if (a && b) routeArrow(s, el, a, b)
    }
  }
  if (o.link !== undefined) el.link = o.link.trim() || null
  if (o.locked !== undefined) for (const e of self) e.locked = o.locked
  for (const e of self) bump(e)
  return skipped
}

/** Turn a box into another shape (rectangle, diamond, ellipse); its text is re-wrapped to fit the new shape. */
export function changeShape(s: Scene, el: El, shape: Shape) {
  if (!['rectangle', 'diamond', 'ellipse'].includes(el.type)) throw new Error(`${el.id} is a ${el.type}; only a rectangle, diamond or ellipse can change shape`)
  if (el.type === shape) return
  el.type = shape
  el.roundness = roundnessFor(shape, st().rounded)
  bump(el)
  const t = boundText(s, el.id)
  if (t) refitText(s, t)
  rerouteAround(s, new Set([el.id]))
}

/** Several style / shape changes in one call; the result says what did not apply. */
export function restyle(s: Scene, changes: { id: string; shape?: Shape; style?: StyleIn }[]) {
  const notes: string[] = []
  for (const c of changes) {
    const el = find(s, c.id)
    if (!el) throw new Error(`No element with id ${c.id}`)
    if (c.shape) changeShape(s, el, c.shape)
    if (c.style) for (const k of applyStyle(s, el, c.style)) notes.push(`${c.id}: ${k} not applied`)
  }
  return notes
}

/** Scale a drawing or a free line to a new bounding box. */
function scalePoints(s: Scene, el: El, width: number, height: number) {
  const fx = el.width ? width / el.width : 1
  const fy = el.height ? height / el.height : 1
  el.points = el.points.map(([x, y]: number[]) => [x * fx, y * fy])
  el.width = Math.abs(el.width * fx)
  el.height = Math.abs(el.height * fy)
  bump(el)
  return `Resized ${el.id} to ${Math.round(el.width)}x${Math.round(el.height)}. ${lint(s, el.id)}`
}

/** A line or arrow that is not bound to boxes, through absolute points, optionally dashed and labelled. */
function freeLine(s: Scene, type: 'arrow' | 'line', pts: Pt[], o: { label?: string; dashed?: boolean; head?: boolean } = {}) {
  const [p1] = pts
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  const el = base(type, p1.x, p1.y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
    points: pts.map((p) => [p.x - p1.x, p.y - p1.y]),
    strokeStyle: o.dashed ? 'dashed' : 'solid',
    strokeWidth: type === 'line' ? 1 : 2,
    startArrowhead: null,
    endArrowhead: type === 'arrow' && o.head !== false ? 'arrow' : null,
    lastCommittedPoint: null,
    ...(type === 'line' ? { strokeColor: '#868e96' } : {}),
  })
  s.elements.push(el)
  if (o.label) {
    const t = makeText(s, o.label, 0, 0, el.id)
    s.elements.push(t)
    attach(el, t)
    // Over the middle of the first segment, a little above the line so the line stays readable.
    t.x = (pts[0].x + pts[1].x) / 2 - t.width / 2
    t.y = (pts[0].y + pts[1].y) / 2 - t.height - 4
  }
  return el
}

type Arrowhead = (typeof ARROWHEADS)[number]
export type FreeLineIn = { points: Pt[]; color?: string; width?: number; dashed?: boolean; arrow?: boolean; startArrowhead?: Arrowhead; endArrowhead?: Arrowhead; curved?: boolean; closed?: boolean; label?: string; style?: StyleIn }
export type FreeShapeIn = { shape?: Shape; x: number; y: number; width: number; height: number; color?: string; fill?: boolean; text?: string; style?: StyleIn }
export type FreeTextIn = { text: string; x: number; y: number; size?: number; color?: string; align?: 'left' | 'center' | 'right'; maxWidth?: number; style?: StyleIn }
export type FreeDrawIn = { points: Pt[]; color?: string; width?: number; style?: StyleIn }
export type ImageIn = { image: LoadedImage; x: number; y: number; width?: number; height?: number; style?: StyleIn }
export type EmbedIn = { url: string; x: number; y: number; width?: number; height?: number; style?: StyleIn }
export type FrameIn = { name: string; around?: string[]; x?: number; y?: number; width?: number; height?: number; padding?: number }
type LoadedImage = { fileId: string; mimeType: string; dataURL: string; width: number; height: number }

/** Put a frame around the given elements (with padding), or at the given bounds; whatever lies fully inside joins it. */
function addFrame(s: Scene, f: FrameIn) {
  const pad = f.padding ?? st().pad
  let r: Rect
  if (f.around?.length) {
    const els = f.around.map((id) => rect(find(s, id) ?? (() => { throw new Error(`No element with id ${id}`) })()))
    const x = Math.min(...els.map((e) => e.x)), y = Math.min(...els.map((e) => e.y))
    r = { x: x - pad, y: y - pad, w: Math.max(...els.map((e) => e.x + e.w)) - x + 2 * pad, h: Math.max(...els.map((e) => e.y + e.h)) - y + 2 * pad }
  } else if (f.x !== undefined && f.y !== undefined && f.width && f.height) r = { x: f.x, y: f.y, w: f.width, h: f.height }
  else throw new Error(`Frame "${f.name}" needs around (ids) or x, y, width and height`)
  const frame = base('frame', r.x, r.y, r.w, r.h, { name: f.name, strokeColor: '#bbb', roughness: 0, roundness: null })
  const inside = (e: El) => {
    const b = rect(e)
    return b.x >= r.x - 1 && b.y >= r.y - 1 && b.x + b.w <= r.x + r.w + 1 && b.y + b.h <= r.y + r.h + 1
  }
  const members = alive(s).filter((e) => e.type !== 'frame' && !e.frameId && (inside(e) || (e.containerId && inside(find(s, e.containerId) ?? e))))
  for (const e of members) ((e.frameId = frame.id), bump(e))
  // Excalidraw draws a frame's children clipped to it; the frame itself goes right after them.
  const last = Math.max(-1, ...members.map((m) => s.elements.indexOf(m)))
  s.elements.splice(last + 1, 0, frame)
  return { frame, members: members.filter(isNode).length }
}

/**
 * Anything the Excalidraw toolbar draws, at exact coordinates, in one call: lines and arrows (any arrowheads, curved,
 * closed into a polygon, labelled), rectangles / diamonds / ellipses (optionally with text), free texts, freehand
 * drawings, images, web embeds and frames. Nothing is nudged away from what is already there and there is no minimum
 * size. A text's x,y is its centre (its left or right edge with align left/right). Frames go last, so `around` can
 * name elements drawn in the same call by their index in `ids`.
 */
export function addShapes(s: Scene, o: { lines?: FreeLineIn[]; shapes?: FreeShapeIn[]; texts?: FreeTextIn[]; drawings?: FreeDrawIn[]; images?: ImageIn[]; embeds?: EmbedIn[]; frames?: FrameIn[] }) {
  const ids: string[] = []
  const skipped: string[] = []
  // Labels of closed shapes are texts of their own; they go after everything else, so "#N" keeps counting as documented.
  const labels: string[] = []
  const styled = (el: El, style?: StyleIn) => {
    if (style) for (const k of applyStyle(s, el, style)) skipped.push(`${el.id}: ${k}`)
    ids.push(markExact(el).id)
  }
  for (const l of o.lines ?? []) {
    if (l.points.length < 2) throw new Error('A line needs at least 2 points')
    const head = l.arrow || (l.startArrowhead && l.startArrowhead !== 'none') || (l.endArrowhead && l.endArrowhead !== 'none')
    const pts = l.closed && (l.points[0].x !== l.points.at(-1)!.x || l.points[0].y !== l.points.at(-1)!.y) ? [...l.points, l.points[0]] : l.points
    const type = (head || l.label) && !l.closed ? 'arrow' : 'line'
    const el = freeLine(s, type, pts, { dashed: l.dashed, label: l.closed ? undefined : l.label, head: l.arrow || !!l.endArrowhead })
    let inner: El | undefined
    if (l.closed && l.label) {
      const r = rect(el)
      inner = makeText(s, l.label, 0, 0, null)
      Object.assign(inner, { x: r.x + (r.w - inner.width) / 2, y: r.y + (r.h - inner.height) / 2 })
      s.elements.push(inner)
    }
    el.strokeColor = colorOf(l.color)[0]
    el.strokeWidth = l.width ?? 2
    if (l.curved) el.roundness = { type: 2 }
    if (el.type === 'arrow') {
      if (l.startArrowhead) el.startArrowhead = l.startArrowhead === 'none' ? null : l.startArrowhead
      if (l.endArrowhead) el.endArrowhead = l.endArrowhead === 'none' ? null : l.endArrowhead
    }
    styled(el, l.style)
    if (inner) labels.push(markExact(inner).id)
  }
  for (const r of o.shapes ?? []) {
    const shape = r.shape ?? 'rectangle'
    const [stroke, bg] = colorOf(r.color)
    let el: El
    if (r.text?.trim()) {
      el = makeBox(s, r.text, r.x, r.y, Math.max(1, r.width), Math.max(1, r.height), r.color, null, { shape })
      if (r.fill) el.backgroundColor = r.color ? bg : PALETTE.gray[1]
    } else {
      el = base(shape, r.x, r.y, Math.max(1, r.width), Math.max(1, r.height), {
        roundness: roundnessFor(shape, st().rounded),
        strokeColor: stroke,
        backgroundColor: r.fill ? (r.color ? bg : stroke) : 'transparent',
      })
      s.elements.push(el)
    }
    styled(el, r.style)
  }
  for (const x of o.texts ?? []) {
    // Font, size and alignment decide where the text's edge goes, so they are applied before it is placed.
    const { font, fontSize, textAlign, ...rest } = x.style ?? {}
    const size = fontSize ?? x.size ?? st().fontSize
    const t = makeText(s, x.maxWidth ? wrapText(x.text, x.maxWidth, size) : x.text, 0, 0, null, size)
    t.originalText = t.text
    const align = textAlign ?? x.align ?? 'center'
    t.textAlign = align
    t.strokeColor = colorOf(x.color)[0]
    if (font) t.fontFamily = FONTS[font]
    t.x = align === 'left' ? x.x : align === 'right' ? x.x - t.width : x.x - t.width / 2
    t.y = x.y - t.height / 2
    s.elements.push(t)
    styled(t, x.style && rest)
  }
  for (const d of o.drawings ?? []) {
    if (d.points.length < 2) throw new Error('A drawing needs at least 2 points')
    const [p1] = d.points
    const xs = d.points.map((p) => p.x), ys = d.points.map((p) => p.y)
    const el = base('freedraw', p1.x, p1.y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), {
      points: d.points.map((p) => [p.x - p1.x, p.y - p1.y]),
      pressures: [],
      simulatePressure: true,
      lastCommittedPoint: null,
      strokeColor: colorOf(d.color)[0],
      strokeWidth: d.width ?? 2,
    })
    s.elements.push(el)
    styled(el, d.style)
  }
  for (const im of o.images ?? []) {
    const { image } = im
    // One side given: the other follows the picture's proportions. Neither: its own size, at most 600px wide.
    const ratio = image.height / image.width
    const w = im.width ?? (im.height ? im.height / ratio : Math.min(600, image.width))
    const h = im.height ?? w * ratio
    s.files[image.fileId] ??= { id: image.fileId, mimeType: image.mimeType, dataURL: image.dataURL, created: Date.now(), lastRetrieved: Date.now() }
    const el = base('image', im.x, im.y, w, h, { fileId: image.fileId, status: 'saved', scale: [1, 1], crop: null, strokeColor: 'transparent', roughness: 0 })
    s.elements.push(el)
    styled(el, im.style)
  }
  for (const e of o.embeds ?? []) {
    if (!/^https?:\/\//i.test(e.url)) throw new Error(`An embed needs an http(s) URL, not ${e.url}`)
    const el = base('embeddable', e.x, e.y, e.width ?? 560, e.height ?? 315, { link: e.url, roundness: roundnessFor('embeddable', st().rounded), roughness: 0 })
    s.elements.push(el)
    styled(el, e.style)
  }
  ids.push(...labels)
  const framed: string[] = []
  for (const f of o.frames ?? []) {
    const { frame, members } = addFrame(s, { ...f, around: f.around?.map((a) => (/^#\d+$/.test(a) ? ids[Number(a.slice(1))] ?? a : a)) })
    ids.push(markExact(frame).id)
    framed.push(`frame ${frame.id} "${f.name}" holds ${members} element(s)`)
  }
  if (!ids.length) throw new Error('Give lines, shapes, texts, drawings, images, embeds and/or frames')
  const n = (k: unknown[] | undefined, what: string) => (k?.length ? `${k.length} ${what}` : '')
  const what = [n(o.lines, 'line(s)'), n(o.shapes, 'shape(s)'), n(o.texts, 'text(s)'), n(o.drawings, 'drawing(s)'), n(o.images, 'image(s)'), n(o.embeds, 'embed(s)'), n(o.frames, 'frame(s)')].filter(Boolean).join(', ')
  return {
    ids,
    text: [`Added ${what} at the exact coordinates given (nothing was moved): ${ids.join(', ')}.`, ...framed, ...(skipped.length ? [`Not applied: ${skipped.join('; ')}.`] : [])].join('\n'),
  }
}

export type Transform =
  | { op: 'duplicate'; dx?: number; dy?: number; count?: number }
  | { op: 'scale'; factor: number }
  | { op: 'flip'; axis: 'horizontal' | 'vertical' }
  | { op: 'rotate'; degrees: number }

/** Where an element lies, counting the points of a line or arrow. */
function boundsOf(e: El) {
  if (e.points?.length) {
    const xs = e.points.map((p: number[]) => e.x + p[0])
    const ys = e.points.map((p: number[]) => e.y + p[1])
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  return { x1: e.x, y1: e.y, x2: e.x + e.width, y2: e.y + e.height }
}

/** Point `p` -> its absolute position, mapped through `f`, back into the element's own origin + relative points. */
function mapPoints(e: El, f: (p: Pt) => Pt) {
  const abs: Pt[] = e.points.map((p: number[]) => f({ x: e.x + p[0], y: e.y + p[1] }))
  e.x = abs[0].x
  e.y = abs[0].y
  e.points = abs.map((p) => [p.x - abs[0].x, p.y - abs[0].y])
  e.width = Math.max(...e.points.map((p: number[]) => p[0])) - Math.min(...e.points.map((p: number[]) => p[0]))
  e.height = Math.max(...e.points.map((p: number[]) => p[1])) - Math.min(...e.points.map((p: number[]) => p[1]))
}

/**
 * Duplicate, scale, flip or rotate a set of elements together with their text and contents (like move_node: arrows between
 * them follow, free lines outside a frame do not). Returns the new ids per old id for a duplicate.
 */
export function transformNodes(s: Scene, ids: string[], t: Transform) {
  const set = new Set<string>()
  for (const id of ids) {
    const el = find(s, id)
    if (!el) throw new Error(`No element with id ${id}`)
    for (const m of withContents(s, el)) set.add(m)
  }
  const members = alive(s).filter((e) => set.has(e.id))
  const b = members.map(boundsOf)
  const box = { x1: Math.min(...b.map((r) => r.x1)), y1: Math.min(...b.map((r) => r.y1)), x2: Math.max(...b.map((r) => r.x2)), y2: Math.max(...b.map((r) => r.y2)) }
  const lone = (e: El) => e.points?.length && !e.startBinding && !e.endBinding // a free line: its points move, not its bound ends
  if (t.op === 'duplicate') {
    const count = Math.min(Math.max(Math.round(t.count ?? 1), 1), 20)
    const dx = t.dx ?? (t.dy === undefined ? 40 : 0)
    const dy = t.dy ?? (t.dx === undefined ? 40 : 0)
    // Arrows between two copied boxes are copied too, with their labels.
    const arrows = alive(s).filter((a) => a.type === 'arrow' && a.startBinding && a.endBinding && set.has(a.startBinding.elementId) && set.has(a.endBinding.elementId))
    const from = new Set([...set, ...arrows.map((a) => a.id), ...alive(s).filter((e) => e.containerId && arrows.some((a) => a.id === e.containerId)).map((e) => e.id)])
    const originals = s.elements.filter((e) => !e.isDeleted && from.has(e.id))
    const all: Record<string, string> = {}
    for (let k = 1; k <= count; k++) {
      const map = new Map(originals.map((e) => [e.id, newId()]))
      const groups = new Map<string, string>()
      const group = (g: string) => groups.get(g) ?? (groups.set(g, `g_${randomBytes(4).toString('hex')}`), groups.get(g)!)
      for (const e of originals) {
        const c = structuredClone(e)
        c.id = map.get(e.id)!
        c.x += dx * k
        c.y += dy * k
        c.seed = rand()
        c.version = 1
        c.versionNonce = rand()
        c.updated = Date.now()
        c.groupIds = (c.groupIds ?? []).map(group)
        if (c.containerId) c.containerId = map.get(c.containerId) ?? c.containerId
        c.boundElements = (c.boundElements ?? []).flatMap((x: any) => (map.has(x.id) ? [{ ...x, id: map.get(x.id) }] : []))
        if (!c.boundElements.length) c.boundElements = null
        for (const key of ['startBinding', 'endBinding'] as const) if (c[key]) c[key] = map.has(c[key].elementId) ? { ...c[key], elementId: map.get(c[key].elementId) } : null
        if (c.frameId && map.has(c.frameId)) c.frameId = map.get(c.frameId)
        if (c.customData?.of && map.has(c.customData.of)) c.customData = { ...c.customData, of: map.get(c.customData.of) }
        s.elements.push(c)
      }
      if (k === 1) for (const [o, n] of map) all[o] = n
    }
    return { text: `Duplicated ${originals.length} element(s)${count > 1 ? ` ${count} times` : ''}, offset ${dx},${dy}. New ids of the first copy: ${ids.map((i) => `${i} -> ${all[i]}`).join(', ')}.`, idMap: all, ids: ids.map((i) => all[i]) }
  }
  if (t.op === 'scale') {
    const f = t.factor
    if (!(f >= 0.1 && f <= 10)) throw new Error('factor must be between 0.1 and 10')
    for (const e of members) {
      e.x = box.x1 + (e.x - box.x1) * f
      e.y = box.y1 + (e.y - box.y1) * f
      e.width *= f
      e.height *= f
      if (e.points) e.points = e.points.map((p: number[]) => [p[0] * f, p[1] * f])
      if (e.type === 'text') e.fontSize = Math.max(6, Math.round(e.fontSize * f))
      bump(e)
    }
    rerouteAround(s, set)
    return { text: `Scaled ${members.length} element(s) by ${f} around their top-left corner. ${lint(s)}` }
  }
  const cx = (box.x1 + box.x2) / 2
  const cy = (box.y1 + box.y2) / 2
  if (t.op === 'flip') {
    const h = t.axis === 'horizontal'
    const mirror = (p: Pt): Pt => (h ? { x: 2 * cx - p.x, y: p.y } : { x: p.x, y: 2 * cy - p.y })
    for (const e of members) {
      if (lone(e)) mapPoints(e, mirror)
      else if (!e.points) {
        if (h) e.x = 2 * cx - (e.x + e.width)
        else e.y = 2 * cy - (e.y + e.height)
        e.angle = h ? -(e.angle ?? 0) : Math.PI - (e.angle ?? 0)
      }
      for (const key of ['startBinding', 'endBinding'] as const) if (e[key]?.fixedPoint) e[key] = { ...e[key], fixedPoint: h ? [1 - e[key].fixedPoint[0], e[key].fixedPoint[1]] : [e[key].fixedPoint[0], 1 - e[key].fixedPoint[1]] }
      bump(e)
    }
    rerouteAround(s, set)
    return { text: `Flipped ${members.length} element(s) ${t.axis}ly (text keeps reading the same way). ${lint(s)}` }
  }
  const rad = (t.degrees * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const turn = (p: Pt): Pt => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin, y: cy + (p.x - cx) * sin + (p.y - cy) * cos })
  for (const e of members) {
    if (lone(e)) mapPoints(e, turn)
    else if (!e.points) {
      const c = turn({ x: e.x + e.width / 2, y: e.y + e.height / 2 })
      e.x = c.x - e.width / 2
      e.y = c.y - e.height / 2
      e.angle = (((e.angle ?? 0) + rad) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    }
    bump(e)
  }
  rerouteAround(s, set)
  return { text: `Rotated ${members.length} element(s) by ${t.degrees} degrees around their common centre. Arrows are re-routed between the unrotated edges, so an angle that is not a multiple of 90 can leave them slightly off. ${lint(s)}` }
}

/** Whether a w x h area at x,y would lie over something already on the canvas (a margin of 10 counts as touching). */
export function overlapsContent(s: Scene, x: number, y: number, w: number, h: number) {
  const m = 10
  return alive(s).some((e) => {
    const b = boundsOf(e)
    return b.x1 < x + w + m && b.x2 > x - m && b.y1 < y + h + m && b.y2 > y - m
  })
}

/** The spot for a drawing of w x h that was asked for at x,y: there when it is free, otherwise below everything. */
export function freeSpot(s: Scene, x: number, y: number, w: number, h: number) {
  if (!overlapsContent(s, x, y, w, h)) return { x, y, moved: false }
  return { x, y: freeOrigin(s).y, moved: true }
}

/** Moves exactly these elements by dx,dy (no re-routing): for a set that was drawn together and shifts as one. */
export function shiftElements(s: Scene, ids: string[], dx: number, dy: number) {
  const set = new Set(ids)
  for (const e of alive(s)) if (set.has(e.id)) ((e.x += dx), (e.y += dy), bump(e))
}

/** Everything that goes with `ids` when they are moved or deleted: each element with its text and what lies inside it. */
export function contentsOf(s: Scene, ids: string[]) {
  const set = new Set<string>()
  for (const id of ids) {
    const el = find(s, id)
    if (el) for (const m of withContents(s, el)) set.add(m)
  }
  return set
}

/** The scene as an .excalidraw document: everything alive, or only `ids` with their text and contents and the arrows between them. */
export function exportScene(s: Scene, ids?: string[]) {
  let elements = alive(s)
  if (ids?.length) {
    const set = new Set<string>()
    for (const id of ids) {
      const el = find(s, id)
      if (!el) throw new Error(`No element with id ${id}`)
      for (const m of withContents(s, el)) set.add(m)
    }
    for (const a of elements) if (a.type === 'arrow' && a.startBinding && a.endBinding && set.has(a.startBinding.elementId) && set.has(a.endBinding.elementId)) set.add(a.id)
    for (const e of elements) if (e.containerId && set.has(e.containerId)) set.add(e.id)
    elements = elements.filter((e) => set.has(e.id))
  }
  const used = new Set(elements.flatMap((e) => (e.fileId ? [e.fileId] : [])))
  const files = Object.fromEntries(Object.entries(s.files ?? {}).filter(([id]) => used.has(id)))
  const { viewBackgroundColor, gridSize } = s.appState ?? {}
  return { type: 'excalidraw', version: 2, source: s.source, elements, appState: { viewBackgroundColor: viewBackgroundColor ?? '#ffffff', ...(gridSize ? { gridSize } : {}) }, files }
}

/** Grouping, stacking order, alignment and spacing of several elements, as the page's Arrange menu does it. */
export function arrange(
  s: Scene,
  o: { ids: string[]; group?: boolean; ungroup?: boolean; order?: 'front' | 'back' | 'forward' | 'backward'; align?: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'; distribute?: 'horizontal' | 'vertical'; frame?: string | null },
) {
  const els = o.ids.map((id) => find(s, id) ?? (() => { throw new Error(`No element with id ${id}`) })())
  // An element's own text always goes along with it.
  const withText = (e: El) => [e, ...alive(s).filter((t) => t.containerId === e.id)]
  const all = els.flatMap(withText)
  const done: string[] = []
  if (o.ungroup) {
    for (const e of all) if (e.groupIds?.length) ((e.groupIds = e.groupIds.slice(0, -1)), bump(e))
    done.push('ungrouped')
  }
  if (o.group) {
    if (els.length < 2) throw new Error('Grouping needs at least 2 elements')
    const g = `g_${randomBytes(4).toString('hex')}`
    for (const e of all) ((e.groupIds = [...(e.groupIds ?? []), g]), bump(e))
    done.push(`grouped as ${g}`)
  }
  if (o.order) {
    const set = new Set(all.map((e) => e.id))
    const block = s.elements.filter((e) => set.has(e.id))
    const rest = s.elements.filter((e) => !set.has(e.id))
    let at = o.order === 'front' ? rest.length : o.order === 'back' ? 0 : -1
    if (at < 0) {
      // One step: past the next (or before the previous) element that overlaps one of them.
      const first = s.elements.indexOf(block[0])
      const last = s.elements.indexOf(block.at(-1)!)
      const overlaps = (e: El) => !e.isDeleted && !e.containerId && els.some((m) => hit(rect(m), rect(e)))
      if (o.order === 'forward') {
        const next = s.elements.findIndex((e, i) => i > last && !set.has(e.id) && overlaps(e))
        at = next < 0 ? rest.length : rest.indexOf(s.elements[next]) + 1
        while (at < rest.length && rest[at].containerId) at++
      } else {
        const prev = s.elements.map((e, i) => [e, i] as const).filter(([e, i]) => i < first && !set.has(e.id) && overlaps(e)).at(-1)
        at = prev ? rest.indexOf(prev[0]) : 0
      }
    }
    s.elements = [...rest.slice(0, at), ...block, ...rest.slice(at)]
    for (const e of block) bump(e)
    done.push(`moved ${o.order === 'front' ? 'to the front' : o.order === 'back' ? 'to the back' : o.order}`)
  }
  if (o.align) {
    const bs = els.map(rect)
    const x0 = Math.min(...bs.map((b) => b.x)), x1 = Math.max(...bs.map((b) => b.x + b.w))
    const y0 = Math.min(...bs.map((b) => b.y)), y1 = Math.max(...bs.map((b) => b.y + b.h))
    els.forEach((e, i) => {
      // Move by the offset of its real bounds: a line's x,y is its first point, not its corner.
      const b = bs[i]
      const x = o.align === 'left' ? x0 : o.align === 'right' ? x1 - b.w : o.align === 'center' ? (x0 + x1 - b.w) / 2 : b.x
      const y = o.align === 'top' ? y0 : o.align === 'bottom' ? y1 - b.h : o.align === 'middle' ? (y0 + y1 - b.h) / 2 : b.y
      moveNode(s, e.id, e.x + x - b.x, e.y + y - b.y)
    })
    done.push(`aligned ${o.align}`)
  }
  if (o.distribute) {
    if (els.length < 3) throw new Error('Distributing needs at least 3 elements')
    const h = o.distribute === 'horizontal'
    const sorted = [...els].sort((a, b) => (h ? a.x - b.x : a.y - b.y))
    const start = h ? sorted[0].x : sorted[0].y
    const end = h ? sorted.at(-1)!.x + sorted.at(-1)!.width : sorted.at(-1)!.y + sorted.at(-1)!.height
    const gap = (end - start - sorted.reduce((n, e) => n + (h ? e.width : e.height), 0)) / (sorted.length - 1)
    let at = start
    for (const e of sorted) {
      moveNode(s, e.id, h ? at : e.x, h ? e.y : at)
      at += (h ? e.width : e.height) + gap
    }
    done.push(`spaced evenly ${o.distribute}ly (${Math.round(gap)}px gaps)`)
  }
  if (o.frame !== undefined) {
    const frame = o.frame ? find(s, o.frame) : undefined
    if (o.frame && frame?.type !== 'frame') throw new Error(`${o.frame} is not a frame`)
    for (const e of all) ((e.frameId = o.frame || null), bump(e))
    let grown = ''
    if (frame) {
      // Excalidraw clips a frame's children to the frame, so one lying outside it would vanish: the frame grows around them.
      const pad = st().pad
      const bs = [rect(frame), ...els.map(rect).map((b) => ({ x: b.x - pad, y: b.y - pad, w: b.w + 2 * pad, h: b.h + 2 * pad }))]
      const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y))
      const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h))
      if (x0 < frame.x || y0 < frame.y || x1 > frame.x + frame.width || y1 > frame.y + frame.height) {
        Object.assign(frame, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
        bump(frame)
        grown = ` (the frame grew to ${Math.round(frame.width)}x${Math.round(frame.height)} to hold them)`
      }
      // Its children are drawn before it, as Excalidraw keeps them.
      const last = Math.max(...all.map((e) => s.elements.indexOf(e)))
      const at = s.elements.indexOf(frame)
      if (at < last) s.elements.splice(last, 0, ...s.elements.splice(at, 1))
    }
    done.push(o.frame ? `put in frame ${o.frame}${grown}` : 'taken out of their frame')
  }
  if (!done.length) throw new Error('Say what to do: group, ungroup, order, align, distribute or frame')
  return `${els.length} element(s) ${done.join(', ')}. ${lint(s)}`
}

export type SequenceMessage = { from: string; to: string; text: string; reply?: boolean }

/**
 * A sequence diagram: actors as headers across the top with dashed lifelines under them, and one horizontal labelled
 * arrow per message, in order top to bottom (replies dashed, a message to itself a small loop). Computed, no graph engine.
 */
export function addSequence(s: Scene, actors: { text: string; color?: string }[], messages: SequenceMessage[], o: { x?: number; y?: number } = {}) {
  if (actors.length < 2) throw new Error('A sequence needs at least two actors')
  const names = actors.map((a) => a.text)
  for (const m of messages) for (const k of [m.from, m.to]) if (!names.includes(k)) throw new Error(`Message "${m.text}": no actor named "${k}" (actors: ${names.join(', ')})`)
  const origin = freeOrigin(s, o.x, o.y)
  const fs = st().fontSize
  // Columns wide enough for the actor names and the longest message that spans one column.
  const longest = Math.max(0, ...messages.map((m) => approxSize(m.text, fs).width / Math.max(1, Math.abs(names.indexOf(m.to) - names.indexOf(m.from)))))
  const colW = Math.max(220, ...actors.map((a) => boxSize(a.text).w + 60), longest + 60)
  const headW = Math.min(colW - 40, Math.max(...actors.map((a) => boxSize(a.text).w)))
  const headH = Math.max(...actors.map((a) => boxSize(a.text, headW).h))
  const rowH = Math.round(fs * LINE_H + 40)
  const mid = (i: number) => origin.x + i * colW + colW / 2
  const heads = actors.map((a, i) => makeBox(s, a.text, mid(i) - headW / 2, origin.y, headW, headH, a.color, null, { role: 'header' }).id)
  const top = origin.y + headH
  const bottom = top + rowH * (messages.length + 1)
  const lines = actors.map((_, i) => freeLine(s, 'line', [{ x: mid(i), y: top }, { x: mid(i), y: bottom }], { dashed: true }).id)
  const arrows = messages.map((m, k) => {
    const y = top + rowH * (k + 1)
    const a = names.indexOf(m.from), b = names.indexOf(m.to)
    if (a === b) {
      // A message to itself: a small loop, its label beside it (a label bound to so short a line would cover it).
      const el = freeLine(s, 'arrow', [{ x: mid(a), y: y - 12 }, { x: mid(a) + 40, y: y - 12 }, { x: mid(a) + 40, y: y + 12 }, { x: mid(a) + 4, y: y + 12 }], { dashed: m.reply })
      const t = makeText(s, m.text, 0, 0, null)
      t.x = mid(a) + 50
      t.y = y - t.height / 2
      s.elements.push(t)
      return el.id
    }
    return freeLine(s, 'arrow', [{ x: mid(a) + (b > a ? 2 : -2), y }, { x: mid(b) + (b > a ? -2 : 2), y }], { label: m.text, dashed: m.reply }).id
  })
  const text = [
    `Added a sequence at ${Math.round(origin.x)},${Math.round(origin.y)}: ${actors.length} actors, ${messages.length} messages top to bottom.`,
    `actors: ${heads.map((id, i) => `${id} "${names[i]}"`).join(', ')}`,
    `messages: ${arrows.join(' ')}`,
    lint(s),
  ].join('\n')
  return { text, ids: heads, lifelines: lines, messages: arrows }
}

/** A cycle: the steps on a circle clockwise from the top, an arrow from each to the next and from the last back to the first. */
export function addCycle(s: Scene, steps: Item[], o: { title?: string; x?: number; y?: number } = {}) {
  if (steps.length < 2) throw new Error('A cycle needs at least two steps')
  const w = Math.max(...steps.map(richWidth))
  const h = Math.max(...steps.map((x) => richSize(x, w).h))
  // The radius leaves room for every box around the circle, with a gap the arrows can run through.
  const n = steps.length
  const r = Math.max(n <= 3 ? 170 : 200, ((w + 90) * n) / (2 * Math.PI))
  const rx = r * 1.15, ry = r * 0.85
  const origin = freeOrigin(s, o.x, o.y)
  const cx = origin.x + rx + w / 2, cy = origin.y + ry + h / 2
  const ids = steps.map((x, i) => {
    const t = -Math.PI / 2 + (i * 2 * Math.PI) / n
    return makeRich(s, x, cx + rx * Math.cos(t) - w / 2, cy + ry * Math.sin(t) - h / 2, w, h).id
  })
  // The title goes in first, so the arrows are routed around it rather than through the middle.
  let title: string | undefined
  if (o.title) {
    const t = makeText(s, o.title, 0, 0, null, st().fontSize + 4)
    t.x = cx - t.width / 2
    t.y = cy - t.height / 2
    s.elements.push(t)
    title = t.id
  }
  const arrows = ids.map((id, i) => connect(s, id, ids[(i + 1) % n]))
  const text = [`Added a cycle of ${n} steps clockwise from the top at ${Math.round(origin.x)},${Math.round(origin.y)}: ${ids.map((id, i) => `${id} "${steps[i].text}"`).join(', ')}${title ? `; title ${title}` : ''}.`, lint(s)].join('\n')
  return { text, ids, arrows }
}

export type QuadrantItem = Item & { x: 'low' | 'high'; y: 'low' | 'high' }

/**
 * A 2x2 matrix: two axes (low → high), four titled quadrants with their items stacked inside, high y on top and high x
 * on the right, axis labels beside and below. For impact / effort, urgent / important and the like.
 */
export function addQuadrant(
  s: Scene,
  g: { xAxis: { title?: string; low: string; high: string }; yAxis: { title?: string; low: string; high: string }; titles?: string[]; items: QuadrantItem[]; x?: number; y?: number },
) {
  const origin = freeOrigin(s, g.x, g.y)
  const { gap, pad } = st()
  // Quadrant order: top-left, top-right, bottom-left, bottom-right.
  const cells: [QuadrantItem['x'], QuadrantItem['y']][] = [['low', 'high'], ['high', 'high'], ['low', 'low'], ['high', 'low']]
  const inQ = cells.map(([x, y]) => g.items.filter((i) => i.x === x && i.y === y))
  const w = Math.max(280, columnWidth(inQ.map((items, k) => ({ title: g.titles?.[k] ?? '', items }))))
  const labelW = Math.min(200, Math.max(120, boxSize(g.yAxis.low).w, boxSize(g.yAxis.high).w))
  const qx = origin.x + labelW + gap
  // Both quadrants of a row get the same height, so the matrix stays a square grid.
  const heights = inQ.map((items) => pad * 2 + 44 + items.reduce((a, i) => a + richSize(i, w - 2 * pad, 'inside').h + gap, 0))
  const rowH = [Math.max(heights[0], heights[1], 140), Math.max(heights[2], heights[3], 140)]
  const made = cells.map((_, k) => {
    const col = k % 2, row = Math.floor(k / 2)
    const r = stackBox(s, g.titles?.[k] ?? '', qx + col * (w + gap), origin.y + (row ? rowH[0] + gap : 0), w, inQ[k], [], undefined)
    if (r.box.height < rowH[row]) ((r.box.height = rowH[row]), bump(r.box))
    return r
  })
  const yLabel = (t: string, row: number) => makeBox(s, t, origin.x, origin.y + (row ? rowH[0] + gap : 0), labelW, rowH[row], undefined, null, { role: 'header' }).id
  const yIds = [yLabel(`↑ ${g.yAxis.high}`, 0), yLabel(g.yAxis.low, 1)]
  const below = origin.y + rowH[0] + rowH[1] + gap * 2
  const xLabel = (t: string, col: number) => makeBox(s, t, qx + col * (w + gap), below, w, 60, undefined, null, { role: 'header' }).id
  const xIds = [xLabel(g.xAxis.low, 0), xLabel(`${g.xAxis.high} →`, 1)]
  const axis = (t: string | undefined, x: number, y: number) => {
    if (!t) return undefined
    const el = makeText(s, t, 0, 0, null, st().fontSize + 2)
    el.x = x - el.width / 2
    el.y = y
    s.elements.push(el)
    return el.id
  }
  const xTitle = axis(g.xAxis.title, qx + w + gap / 2, below + 60 + gap)
  const yTitle = axis(g.yAxis.title, origin.x + labelW / 2, origin.y - st().fontSize * LINE_H - gap)
  const names = ['top-left', 'top-right', 'bottom-left', 'bottom-right']
  const text = [
    `Added a 2x2 matrix at ${Math.round(origin.x)},${Math.round(origin.y)} (y high on top, x high on the right):`,
    ...made.map((r, k) => `${names[k]} ${r.box.id}${g.titles?.[k] ? ` "${g.titles[k]}"` : ''}: ${r.ids.join(', ') || '(empty)'}`),
    `axis labels: y ${yIds.join(' ')}, x ${xIds.join(' ')}${xTitle || yTitle ? `, titles ${[yTitle, xTitle].filter(Boolean).join(' ')}` : ''}`,
    lint(s),
  ].join('\n')
  return { text, ids: made.map((r) => r.box.id), items: made.map((r) => r.ids) }
}

export type MindBranch = Item & { children?: Item[] }

/**
 * A mind map: the central idea in the middle, branches split between the right and the left (first half right), each
 * branch's ideas further out on its side, stacked so nothing overlaps. Arrows run from the centre out.
 */
export function addMindmap(s: Scene, center: string | Item, branches: MindBranch[], o: { x?: number; y?: number } = {}) {
  const mid: Item = typeof center === 'string' ? { text: center } : center
  if (!branches.length) throw new Error('A mind map needs at least one branch')
  const { gap } = st()
  const right = branches.slice(0, Math.ceil(branches.length / 2)), left = branches.slice(right.length)
  // Branches share one width, and those that hold boxes another, as wide as they need: not every branch as wide as them.
  const plain = branches.filter((b) => !b.inside?.length)
  const bw = Math.max(140, ...(plain.length ? plain : branches).map(richWidth))
  const boxed = branches.filter((b) => b.inside?.length)
  const boxedW = Math.max(bw, ...boxed.map(richWidth))
  const wOf = (b: MindBranch) => (b.inside?.length ? boxedW : bw)
  const kw = Math.max(140, ...branches.flatMap((b) => (b.children ?? []).map(richWidth)))
  const block = (b: MindBranch) => {
    const kids = (b.children ?? []).map((c) => richSize(c, kw).h)
    return Math.max(richSize(b, wOf(b)).h, kids.reduce((a, h) => a + h + gap / 2, 0) - (kids.length ? gap / 2 : 0))
  }
  const sideH = (bs: MindBranch[]) => bs.reduce((a, b) => a + block(b) + gap * 1.5, 0) - gap * 1.5
  const hasKids = (bs: MindBranch[]) => bs.some((b) => b.children?.length)
  const cw = Math.max(richWidth(mid), 200)
  const cs = { w: cw, h: richSize(mid, cw, 'container').h }
  const leftW = left.length ? Math.max(...left.map(wOf)) + 100 + (hasKids(left) ? kw + 70 : 0) : 0
  const origin = freeOrigin(s, o.x, o.y)
  const total = Math.max(sideH(right), sideH(left), cs.h)
  const cx = origin.x + leftW, cy = origin.y + total / 2 - cs.h / 2
  const centre = makeRich(s, mid, cx, cy, cw, cs.h + 10, null, { role: 'container' })
  const out: { id: string; children: string[] }[] = []
  // Arrows are routed once every box is placed, so they go around the boxes drawn after them too.
  const links: [string, string][] = []
  const side = (bs: MindBranch[], dir: 1 | -1) => {
    let y = origin.y + (total - sideH(bs)) / 2
    for (const b of bs) {
      const h = block(b)
      const w = wOf(b)
      const bx = dir === 1 ? cx + cw + 100 : cx - 100 - w
      const bh = richSize(b, w).h
      const id = makeRich(s, b, bx, y + (h - bh) / 2, w, bh).id
      links.push([centre.id, id])
      let ky = y
      const kids = (b.children ?? []).map((c) => {
        const kh = richSize(c, kw).h
        const kid = makeRich(s, c, dir === 1 ? bx + w + 70 : bx - 70 - kw, ky, kw, kh).id
        links.push([id, kid])
        ky += kh + gap / 2
        return kid
      })
      out.push({ id, children: kids })
      y += h + gap * 1.5
    }
  }
  side(right, 1)
  side(left, -1)
  for (const [from, to] of links) connect(s, from, to)
  const text = [
    `Added a mind map at ${Math.round(origin.x)},${Math.round(origin.y)}: centre ${centre.id} "${mid.text}", ${right.length} branch(es) on the right, ${left.length} on the left.`,
    ...out.map((b, i) => `${b.id} "${branches[i].text}": ${b.children.join(', ') || '(no children)'}`),
    lint(s),
  ].join('\n')
  return { text, ids: out.map((b) => b.id), center: centre.id, branches: out }
}

const TIME = /\b([01]?\d|2[0-3])[:.][0-5]\d\b/

/**
 * What a screenshot shows but a small image model reads badly, said in words: the top-level groups and how full they are,
 * boxes of one kind with different widths, and in a schedule the boxes without a time or with the time in another place.
 */
export function describeLook(s: Scene) {
  // A box's explanation is part of the box, not a box of its own.
  const nodes = alive(s).filter((n) => isNode(n) && !isDetail(n))
  const top = nodes.filter((n) => !nodes.some((p) => isContainer(p) && encloses(p, n)))
  const out: string[] = []
  const groups = top.filter((t) => nodes.some((n) => encloses(t, n)))
  if (groups.length > 1) {
    const sizes = groups.map((g) => {
      const kids = nodes.filter((n) => encloses(g, n))
      const used = kids.length ? Math.max(...kids.map((k) => k.y + k.height)) - g.y + st().pad : 0
      return { g, kids, fill: Math.min(1, used / g.height) }
    })
    out.push(`${groups.length} groups side by side: ` + sizes.map(({ g, kids }) => `"${label(s, g).slice(0, 30)}" ${Math.round(g.width)}x${Math.round(g.height)} (${kids.length} inside)`).join('; ') + '.')
    const empty = sizes.filter((x) => x.fill < 0.5)
    if (empty.length) out.push(`Mostly empty (less than half the height used): ${empty.map((x) => x.g.id).join(', ')}.`)
    const widths = new Set(groups.map((g) => Math.round(g.width)))
    if (widths.size > 1) out.push(`The groups have different widths (${[...widths].join(', ')}px).`)
  }
  // In each column or section, the boxes directly inside it should line up.
  const nearest = (n: El) => nodes.filter((p) => isContainer(p) && encloses(p, n)).sort((a, b) => area(a) - area(b))[0]
  const byParent = new Map<string, El[]>()
  for (const n of nodes) {
    const p = nearest(n)
    if (p && !nodes.some((o) => encloses(n, o))) byParent.set(p.id, [...(byParent.get(p.id) ?? []), n])
  }
  for (const [p, kids] of byParent) {
    const w = new Set(kids.map((k) => Math.round(k.width)))
    if (w.size > 1) out.push(`In ${p} the boxes have different widths (${[...w].join(', ')}px).`)
  }
  const leaves = nodes.filter((n) => !nodes.some((o) => encloses(n, o)) && plainText(s, n))
  const timed = leaves.filter((n) => TIME.test(plainText(s, n)))
  // A box that names a day (a row label, a column title) is not an activity missing its time.
  const untimed = leaves.filter((n) => !TIME.test(plainText(s, n)) && dayKey(plainText(s, n)) === null && !/^\s*(plan [a-c]|option \w|varianta \w)\s*$/iu.test(plainText(s, n)))
  if (timed.length >= leaves.length / 2 && untimed.length) {
    const none = untimed
    out.push(`It reads as a schedule, but ${none.length} box(es) have no time: ${none.slice(0, 8).map((n) => `${n.id} "${label(s, n).slice(0, 40)}"`).join(', ')}${none.length > 8 ? ', …' : ''}.`)
  }
  if (timed.length >= 4) {
    const first = timed.filter((n) => TIME.test(plainText(s, n).slice(0, 7))).length
    if (first && first < timed.length) out.push(`The time is at the start of ${first} box(es) and later in the text of ${timed.length - first}: put it in the same place in every box.`)
  }
  // Reading order of the top-level boxes that name days, among those that line up: a column read top to bottom, a row
  // left to right. Two drawings side by side are not compared with each other.
  const days = top.filter((n) => dayKey(plainText(s, n)) !== null)
  const lines = (key: (n: El) => number) => {
    const groups: El[][] = []
    for (const n of [...days].sort((a, b) => key(a) - key(b))) {
      const g = groups.find((x) => Math.abs(key(x[0]) - key(n)) < 40)
      g ? g.push(n) : groups.push([n])
    }
    return groups.filter((g) => g.length >= 3)
  }
  const order =
    lines((n) => n.x).map((g) => orderHint(g.sort((a, b) => a.y - b.y).map((n) => plainText(s, n)), 'top to bottom')).find(Boolean) ||
    lines((n) => n.y).map((g) => orderHint(g.sort((a, b) => a.x - b.x).map((n) => plainText(s, n)), 'left to right')).find(Boolean)
  if (order) out.push(order)
  const through = (lint(s).match(/ARROW CROSSES/g) ?? []).length
  if (through) out.push(`${through} arrow(s) run through a box (check_layout lists them; move_node or fix_layout re-routes them).`)
  const { maxWords, legend, detail } = st()
  const wordy = leaves.filter((n) => plainText(s, n).split(/\s+/).length > maxWords)
  if (wordy.length) out.push(`${wordy.length} box(es) have more than ${maxWords} words: ${wordy.slice(0, 5).map((n) => n.id).join(', ')}${wordy.length > 5 ? ', …' : ''}.`)
  // A diagram that explains: every box of content says what it is under its title. Columns, headers and the small boxes
  // drawn inside another box are not asked for one.
  const explained = new Set(alive(s).filter(isDetail).map((d) => d.customData.of))
  const content = leaves.filter((n) => n.type === 'rectangle' && !n.customData?.role && !n.customData?.inside && !isExact(n) && dayKey(plainText(s, n)) === null)
  const bare = content.filter((n) => !explained.has(n.id))
  if (bare.length && (detail === 'explain' || (detail === 'auto' && explained.size)))
    out.push(`${detail === 'explain' ? 'The diagram explains its topic' : `${content.length - bare.length} of ${content.length} boxes explain themselves`}, but ${bare.length} box(es) have only a title: ${bare.slice(0, 6).map((n) => `${n.id} "${label(s, n).slice(0, 30)}"`).join(', ')}${bare.length > 6 ? ', …' : ''}. Add a sentence under each with update_node({ id, detail }).`)
  // Colour only means something when the legend names it.
  const named = new Set(legend.map((c) => PALETTE[c]?.[0]))
  const stray = nodes.filter((n) => !LINEAR.has(n.type) && n.type !== 'text' && Object.values(PALETTE).some(([stroke]) => stroke === n.strokeColor) && !named.has(n.strokeColor))
  if (stray.length) out.push(`${stray.length} box(es) are coloured with a colour the legend does not name${legend.length ? '' : ' (there is no legend)'}: ${stray.slice(0, 5).map((n) => n.id).join(', ')}.`)
  if (legend.length && !nodes.some((n) => named.has(n.strokeColor)))
    out.push(`The colour legend names ${legend.join(', ')} (get_context has what they mean), but no box uses one: colour the boxes a legend entry describes (update_nodes with color), or say that none fits.`)
  // Times or dates on many boxes but no axis of ticks: a schedule drawn as something else.
  const ticks = alive(s).filter((e) => e.type === 'text' && !e.containerId && TIME.test(e.text ?? '') && (e.text ?? '').trim().length <= 5).length
  if (leaves.length >= 4 && timed.length >= leaves.length * 0.3 && ticks < 2) out.push(`${timed.length} of ${leaves.length} boxes have times but there is no time axis: add_timeline would place them to scale.`)
  return out.length ? `What the image shows, in words:\n- ${out.join('\n- ')}` : ''
}

// Letters around a word, since \b does not know "â" or "ț".
const word = (alts: string) => new RegExp(`(?<!\\p{L})(${alts})(?!\\p{L})`, 'iu')
const DATE = /(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)|\b\d{4}-\d{2}-\d{2}\b/
const WEEKDAY = word(
  'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|luni|marți|marti|miercuri|joi|vineri|sâmbătă|sambata|sâmbata|duminică|duminica|lun|mie|vin|sâm|sam|dum',
)
const DAY_N = word('day \\d+|ziua \\d+')
const ALT = /^\s*(plan [a-c]\b|option\b|opțiunea|optiunea|alternativ)/iu
const WEEKDAYS = [/^(mon|lun)/i, /^(tue|mar)/i, /^(wed|mie)/i, /^(thu|joi)/i, /^(fri|vin)/i, /^(sat|s[âa]m)/i, /^(sun|dum)/i]

const dated = (t: string) => TIME.test(t) || DATE.test(t) || WEEKDAY.test(t) || DAY_N.test(t)

/** A sort key for a title that names a day: a d/m date wins, then "day N", then a weekday; null when it names none. */
function dayKey(t: string): number | null {
  const iso = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (iso) return +iso[1] * 10000 + +iso[2] * 100 + +iso[3]
  const d = t.match(DATE)
  if (d && d[1] && +d[2] <= 12 && +d[1] <= 31) return (d[3] ? +d[3] % 100 : 0) * 10000 + +d[2] * 100 + +d[1]
  const n = t.match(/(?:day|ziua) (\d+)/i)
  if (n) return +n[1]
  const w = t.match(WEEKDAY)
  if (w) return WEEKDAYS.findIndex((r) => r.test(w[1]))
  return null
}

/**
 * Whether the boxes, in the order a reader meets them, name their days in order. Mixed calendars (some with a date,
 * some with only a weekday) are not compared, since a weekday alone does not say which week.
 */
function orderHint(titles: string[], where: string) {
  const keys = titles.map(dayKey)
  if (keys.filter((k) => k !== null).length < 3) return ''
  const kinds = new Set(titles.map((t, i) => (keys[i] === null ? 'none' : DATE.test(t) ? 'date' : DAY_N.test(t) ? 'n' : 'weekday')))
  kinds.delete('none')
  if (kinds.size > 1) return ''
  const named = titles.map((t, i) => ({ t, k: keys[i] })).filter((x) => x.k !== null)
  const bad = named.findIndex((x, i) => i > 0 && x.k! < named[i - 1].k!)
  return bad < 0 ? '' : `The days are not in order ${where}: "${named[bad - 1].t.slice(0, 30)}" comes before "${named[bad].t.slice(0, 30)}". Readers expect the earliest day first.`
}

/**
 * Warnings for content drawn with a tool that does not fit it: a graph of a schedule, a hub with a list of spokes,
 * alternatives drawn as branches, days out of order. Prompts alone did not stop models from this, so the result says it.
 */
export function typeHints(s: Scene, tool: 'graph' | 'tree' | 'columns' | 'timeline', o: { ids?: string[]; titles?: string[]; edges?: { from: string; to: string }[] }) {
  const out: string[] = []
  const ids = o.ids ?? []
  const texts = ids.map((id) => { const e = find(s, id); return e ? plainText(s, e) : '' }).filter(Boolean)
  const timed = texts.filter(dated)
  if (tool !== 'timeline' && texts.length >= 4 && timed.length >= texts.length * 0.3)
    out.push(`${timed.length} of ${texts.length} boxes have times or dates: add_timeline shows this to scale (rows = days, lanes = alternatives such as Plan A / Plan B). Consider undo and redraw with add_timeline.`)
  const edges = o.edges ?? []
  if (tool === 'graph' && edges.length) {
    const outs = new Map<string, string[]>()
    for (const e of edges) outs.set(e.from, [...(outs.get(e.from) ?? []), e.to])
    const hub = [...outs].find(([, to]) => to.length >= 6 && to.filter((t) => !outs.has(t)).length > to.length / 2)
    if (hub) out.push(`${hub[0]} has ${hub[1].length} arrows to boxes that lead nowhere: that is a list under one heading, not a flow. add_columns (or add_timeline when it has times) reads better.`)
  }
  const alts = texts.filter((t) => ALT.test(t))
  if (tool !== 'timeline' && alts.length >= 2)
    out.push(`${alts.length} boxes start with an alternative ("${alts[0].slice(0, 20)}", …): alternatives belong in lanes (add_timeline) or in sections of a column (add_columns), not in separate boxes or branches.`)
  if (o.titles) {
    const h = orderHint(o.titles, tool === 'columns' ? 'left to right' : 'top to bottom')
    if (h) out.push(h)
  } else if (tool === 'graph') {
    // A graph puts siblings where dagre likes; read them the way the drawing does, top to bottom then left to right.
    const byFrom = new Map<string, El[]>()
    for (const e of edges) { const el = find(s, e.to); if (el) byFrom.set(e.from, [...(byFrom.get(e.from) ?? []), el]) }
    for (const kids of byFrom.values()) {
      const h = orderHint(kids.sort((a, b) => a.y - b.y || a.x - b.x).map((k) => plainText(s, k)), 'top to bottom')
      if (h) { out.push(h); break }
    }
  }
  return out.length ? `\nCheck the diagram type and order:\n- ${out.join('\n- ')}` : ''
}

/** Groups of top-level elements, left to right, each small enough to read in one screenshot (longest side about 1600px). */
export function screenshotChunks(s: Scene, maxSide = 1600) {
  const nodes = alive(s).filter(isNode)
  const top = nodes.filter((n) => !nodes.some((p) => isContainer(p) && encloses(p, n))).sort((a, b) => a.x - b.x || a.y - b.y)
  const all = top.map(rect)
  if (top.length < 2) return []
  const x0 = Math.min(...all.map((r) => r.x)), x1 = Math.max(...all.map((r) => r.x + r.w))
  const y0 = Math.min(...all.map((r) => r.y)), y1 = Math.max(...all.map((r) => r.y + r.h))
  if (Math.max(x1 - x0, y1 - y0) <= maxSide * 1.25) return []
  // The height of the content sets the image's scale, so a chunk is about as wide as the content is tall (and no wider than maxSide).
  const width = Math.max(400, Math.min(maxSide, y1 - y0))
  const chunks: string[][] = []
  let cur: El[] = []
  for (const n of top) {
    const left = cur.length ? Math.min(...cur.map((c) => c.x)) : n.x
    if (cur.length && n.x + n.width - left > width) (chunks.push(cur.map((c) => c.id)), (cur = []))
    cur.push(n)
  }
  if (cur.length) chunks.push(cur.map((c) => c.id))
  // Lines and arrows bound to no box (lifelines, sequence messages) travel with the chunk their middle falls in.
  const spans = chunks.map((ids) => { const els = ids.map((id) => find(s, id)!); return [Math.min(...els.map((e) => e.x)), Math.max(...els.map((e) => e.x + e.width))] })
  for (const l of alive(s)) {
    if (!LINEAR.has(l.type) || l.startBinding || l.endBinding) continue
    const mx = l.x + Math.min(0, ...l.points.map((p: number[]) => p[0])) + l.width / 2
    const k = spans.findIndex(([a, b]) => mx >= a - 40 && mx <= b + 40)
    if (k >= 0) chunks[k].push(l.id)
  }
  return chunks.length > 1 ? chunks.slice(0, 4) : []
}

/** An element, its label and everything inside it (with their labels): what moves or goes away together. */
function withContents(s: Scene, el: El) {
  const group = new Set<string>([el.id, ...containedIn(s, el).map((c) => c.id)])
  // A frame also holds its lines, arrows and drawings (Excalidraw moves and deletes them with it), wherever they lie.
  if (el.type === 'frame' || el.type === 'magicframe') for (const e of alive(s)) if (e.frameId === el.id) group.add(e.id)
  for (const m of [...group]) for (const t of alive(s)) if (t.containerId === m) group.add(t.id)
  return group
}

/**
 * Fix what lint reports, as far as it can be done without guessing: boxes too small for their text grow,
 * containers grow around what sticks out of them, overlapping boxes move apart (the newer one moves to free space),
 * and arrows are re-routed. Several passes, since one fix can cause another. Returns what it did and the lint after.
 */
export function fixLayout(s: Scene, scopeId?: string) {
  const scope = scopeId ? find(s, scopeId) : undefined
  if (scopeId && !scope) throw new Error(`No element with id ${scopeId}`)
  const done = { text: 0, grown: 0, moved: 0 }
  const order = (e: El) => s.elements.indexOf(e)
  // Exactly placed elements stay as they are: nothing grows, moves or is moved for them.
  const inScope = () => {
    const all = alive(s).filter((e) => isNode(e) && !isExact(e))
    if (!scope) return all
    const keep = new Set([scope.id, ...containedIn(s, scope).map((c) => c.id)])
    return all.filter((n) => keep.has(n.id))
  }
  const holds = (p: El, c: El) => containedIn(s, p).some((x) => x.id === c.id) && (p.type === 'frame' || area(p) >= area(c) * 3 || encloses(p, c))
  // The nearest container around a box (by centre, as containedIn counts it), to tell siblings in a stack apart.
  const parentOf = (n: El) =>
    alive(s)
      .filter((p) => isNode(p) && p.id !== n.id && holds(p, n))
      .sort((a, b) => area(a) - area(b))[0]
  for (let pass = 0; pass < 6; pass++) {
    let changed = false
    const nodes = inScope()
    for (const n of nodes) {
      const t = boundText(s, n.id)
      if (!t || LINEAR.has(n.type) || (t.width <= n.width * room(n.type) - 8 && t.height <= n.height * room(n.type) - 8)) continue
      n.width = Math.max(n.width, (t.width + 24) / room(n.type))
      n.height = Math.max(n.height, (t.height + 30) / room(n.type))
      placeText(n, t)
      bump(n)
      bump(t)
      done.text++
      changed = true
    }
    for (const p of nodes)
      for (const c of nodes) {
        if (p === c || !holds(p, c)) continue
        const x1 = Math.min(p.x, c.x - 24), y1 = Math.min(p.y, c.y - 24)
        const x2 = Math.max(p.x + p.width, c.x + c.width + 24), y2 = Math.max(p.y + p.height, c.y + c.height + 24)
        if (x1 === p.x && y1 === p.y && x2 === p.x + p.width && y2 === p.y + p.height) continue
        const dx = x1 - p.x, dy = y1 - p.y
        Object.assign(p, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 })
        const t = boundText(s, p.id)
        if (t) ((t.x += dx), (t.y += dy), bump(t))
        bump(p)
        done.grown++
        changed = true
      }
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        if (!hit(rect(a), rect(b), 2) || holds(a, b) || holds(b, a)) continue
        // Two boxes of the same container (a column's items, a grown section and the one below it): the lower one and
        // everything under it in that container move down, so the stack stays in order; the container grows next pass.
        const parent = parentOf(a)
        if (parent && parentOf(b)?.id === parent.id) {
          const [upper, lower] = a.y < b.y || (a.y === b.y && order(a) < order(b)) ? [a, b] : [b, a]
          const dy = upper.y + upper.height + st().gap - lower.y
          const below = new Set<string>()
          for (const n of containedIn(s, parent)) if (n.y >= lower.y - 1 && !encloses(upper, n) && n.id !== upper.id) for (const id of withContents(s, n)) below.add(id)
          for (const e of alive(s)) if (below.has(e.id) && e.type !== 'arrow') ((e.y += dy), bump(e))
          done.moved++
          changed = true
          continue
        }
        const mover = order(a) > order(b) ? a : b
        const group = withContents(s, mover)
        const spot = clearSpot(s, mover.x, mover.y, mover.width, mover.height, true, group)
        const dx = spot.x - mover.x, dy = spot.y - mover.y
        if (!dx && !dy) continue
        for (const e of alive(s)) if (group.has(e.id) && e.type !== 'arrow') ((e.x += dx), (e.y += dy), bump(e))
        done.moved++
        changed = true
      }
    if (!changed) break
  }
  rerouteAround(s, new Set(inScope().map((n) => n.id)))
  const did = [done.text && `${done.text} box(es) grown to fit their text`, done.grown && `${done.grown} container(s) grown around their contents`, done.moved && `${done.moved} overlapping box(es) moved apart`].filter(Boolean)
  return `${did.length ? `Fixed: ${did.join(', ')}.` : 'Nothing to fix by size or position.'} Arrows re-routed. ${lint(s, scopeId)}`
}

/** Delete several elements, each with its label, what is inside it and the arrows attached. Unknown ids are reported, not fatal. */
export function deleteNodes(s: Scene, ids: string[]) {
  const missing: string[] = []
  let n = 0
  for (const id of ids) {
    const el = find(s, id)
    if (!el) {
      missing.push(id)
      continue
    }
    for (const m of withContents(s, el)) if (find(s, m) && !find(s, m)!.containerId) (deleteNode(s, m), n++)
  }
  return `Deleted ${n} element(s) with their text and arrows.${missing.length ? ` Not found: ${missing.join(', ')}.` : ''}`
}

/** Empty the diagram (everything, including free drawings). */
export function clearScene(s: Scene) {
  const els = alive(s)
  const boxes = els.filter(isNode).length
  for (const e of els) ((e.isDeleted = true), bump(e))
  return `Cleared the diagram (${boxes} boxes and texts, ${els.filter((e) => e.type === 'arrow').length} arrows). undo brings it back.`
}

export function connect(s: Scene, fromId: string, toId: string, text?: string, style?: StyleIn) {
  const a = find(s, fromId)
  const b = find(s, toId)
  if (!a) throw new Error(`No element with id ${fromId}`)
  if (!b) throw new Error(`No element with id ${toId}`)
  // What Excalidraw can attach an arrow to; any other binding is dropped when the page loads the scene.
  for (const e of [a, b])
    if (!BINDABLE.has(e.type) || (e.type === 'text' && e.containerId))
      throw new Error(`${e.id} is ${e.type === 'text' ? 'the label of another element' : `a ${e.type}`}: an arrow can only attach to a box, diamond, ellipse, free text, image, embed or frame${e.type === 'text' ? ` (use ${e.containerId})` : ''}`)
  const arrow = base('arrow', a.x, a.y, 0, 0, {
    points: [[0, 0], [0, 0]],
    startBinding: { elementId: a.id, focus: 0, gap: 4 },
    endBinding: { elementId: b.id, focus: 0, gap: 4 },
    startArrowhead: null,
    endArrowhead: 'arrow',
    elbowed: st().arrows === 'elbow',
    roundness: st().arrows === 'curved' ? { type: 2 } : null,
    ...(st().arrows === 'elbow' ? { fixedSegments: null } : {}),
    lastCommittedPoint: null,
  })
  s.elements.push(arrow)
  attach(a, arrow)
  attach(b, arrow)
  if (text) {
    const t = makeText(s, text, 0, 0, arrow.id)
    s.elements.push(t)
    attach(arrow, t)
  }
  // applyStyle re-routes when it changes the arrow type.
  if (!style?.arrowType) routeArrow(s, arrow, a, b)
  if (style) applyStyle(s, arrow, style)
  return arrow.id
}

export function deleteNode(s: Scene, id: string) {
  const el = find(s, id)
  if (!el) throw new Error(`No element with id ${id}`)
  const doomed = new Set<string>([id])
  // Its label and the explanation under its title go with it.
  for (const t of alive(s)) if (t.containerId === id || (isDetail(t) && t.customData.of === id)) doomed.add(t.id)
  for (const a of alive(s))
    if (a.type === 'arrow' && (doomed.has(a.startBinding?.elementId) || doomed.has(a.endBinding?.elementId))) {
      doomed.add(a.id)
      for (const t of alive(s)) if (t.containerId === a.id) doomed.add(t.id)
    }
  for (const e of s.elements) {
    if (doomed.has(e.id)) {
      e.isDeleted = true
      bump(e)
      continue
    }
    if (e.boundElements?.some((b: any) => doomed.has(b.id))) {
      e.boundElements = e.boundElements.filter((b: any) => !doomed.has(b.id))
      bump(e)
    }
    // What was in a deleted frame stays on the canvas, out of the frame (it would point at a frame that is gone).
    if (e.frameId && doomed.has(e.frameId)) ((e.frameId = null), bump(e))
  }
  return `Deleted ${doomed.size} element(s).`
}
