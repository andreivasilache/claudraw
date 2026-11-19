import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { type Layout, getContext, learnFromFirstDrawing, renderContext, setContext, styleNote } from './context.ts'
import { getProject } from './config.ts'
import { COLORS, PALETTE } from './palette.ts'
import { type Column, type El, type Scene, addColumns, addGraph, addGrid, addTimeline, addNode, autoLayout, addNodesInside, clearScene, connect, connect as connectNodes, addShapes, arrange, restyle, ARROWHEADS, FILLS, FONTS, resizeNodes, deleteNode, deleteNodes, describeLook, find, fixLayout, parseMermaid, describeNode, typeHints, elkPositions, elkAutoPositions, addTree, treeEdges, addSequence, addCycle, addQuadrant, addMindmap, getSpace, lint, listNodes, moveNode, mutate, readScene, resizeNode, revision, contentsOf, plainText, shiftElements, screenshotChunks, searchNodes, transformNodes, type Transform, setDetail, drawnInside, undo, updateNode } from './scene.ts'
import { requestScreenshot } from './screenshot.ts'
import { exportDiagram } from './export.ts'
import { generated, specOf } from './generated.ts'
import { CHART_TYPES, addChart } from './charts.ts'
import { STICKY_COLORS, addStickyNotes } from './stickies.ts'
import { loadImage } from './images.ts'
import { EXPLAIN_PLAN, explainsTopic, recommend, renderOptions, toSettle } from './recommend.ts'
import { closestExamples, renderExamples } from './examples.ts'
import { currentTurn, turnId } from './turn.ts'
import { NOTE_KINDS, NOTE_STATUSES, notes, selection } from './store.ts'
import { exportDecisions } from './decisions.ts'
import { CANVAS_RULES, GUIDE_TOPICS, readGuide, structuredInstructions } from './guides.ts'
import { getAnimations, upsertAnimation } from './animation.ts'
import { createDiagram, findDiagram, listDiagrams, openDiagram, renameDiagram } from './diagrams.ts'
import { cur, perDiagram, runIn } from './project.ts'

const colorEnum = z.enum(COLORS)
/** Notes saved on a box as it is drawn, so what does not belong in the box (a caveat, a cost, a link, a thing to check)
 *  is kept next to it instead of becoming a box of its own or being dropped. */
const noteList = z
  .array(z.object({ text: z.string().max(1000), kind: z.string().optional() }))
  .max(10)
  .optional()
  .describe('Notes saved on this box: details, caveats, links, costs, open questions, examples, sources. kind is "fact", "decision", "question" (an open point), "example" (a concrete case) or "source" (a link or reference you checked); omit it for a plain note. Not shown as boxes.')
type NoteIn = { text: string; kind?: string }
/** A kind the model made up ("info", "warning") is a plain note, not a reason to refuse the whole drawing. */
const noteKind = (k?: string) => NOTE_KINDS.find((x) => x === k?.toLowerCase().trim())
const detail = z
  .string()
  .max(600)
  .optional()
  .describe('One or two sentences under the title, in smaller type: what it is, why it matters or how it works. For diagrams that explain a topic; the title (text) stays short. A diamond or ellipse adds it to its text.')
/** A box drawn inside another one: its own title, explanation and notes. */
const innerItem = z.object({ text: z.string(), detail, color: colorEnum.optional(), notes: noteList })
const inside = z
  .array(innerItem)
  .max(12)
  .optional()
  .describe('Boxes drawn INSIDE this box, under its title and detail: its parts, steps, kinds or examples, in a grid (up to 3 side by side). Each has text, detail and notes. Use it when the parts belong to the box rather than being boxes of their own.')
const item = z.object({ text: z.string(), color: colorEnum.optional(), detail, inside, notes: noteList })
/** Save the notes given with a drawing call on the boxes it made; returns a line for the result. */
async function saveNotes(pairs: [string | undefined, NoteIn[] | undefined][]) {
  const batch = pairs.flatMap(([id, list]) => (id && list ? list.map((x) => ({ node: id, text: x.text, kind: noteKind(x.kind) })) : []))
  const n = (await notes.addMany(batch)).length
  return n ? `\nSaved ${n} note(s) on the boxes.` : ''
}
const point = z.union([z.string(), z.number()])
const shapeEnum = z.enum(['rectangle', 'diamond', 'ellipse'])
const arrowhead = z.enum(ARROWHEADS)
/** Everything the Excalidraw properties panel sets on an element. Only for what the user asked for: the diagram's own
 *  look (context) is applied to new boxes already. */
const style = z
  .object({
    stroke: z.string().optional().describe('Stroke (and text) colour: a colour name (blue, green, …), a hex like #1e1e1e, or "transparent".'),
    background: z.string().optional().describe('Fill colour: a colour name (its soft tint), a hex, or "transparent".'),
    fillStyle: z.enum(FILLS).optional().describe('How the background is filled (default solid).'),
    strokeWidth: z.number().min(0.5).max(20).optional().describe('1 thin, 2 bold, 4 extra bold.'),
    strokeStyle: z.enum(['solid', 'dashed', 'dotted']).optional(),
    sloppiness: z.enum(['architect', 'artist', 'cartoonist']).optional().describe('architect = clean, artist = sketchy, cartoonist = very sketchy.'),
    edges: z.enum(['sharp', 'round']).optional(),
    opacity: z.number().min(0).max(100).optional(),
    angle: z.number().optional().describe('Rotation in degrees, clockwise.'),
    font: z.enum(Object.keys(FONTS) as [keyof typeof FONTS]).optional().describe('hand (Excalifont), normal (Nunito), code (Comic Shanns), or the older virgil, helvetica, cascadia, lilita.'),
    fontSize: z.number().min(6).max(200).optional().describe('16 small, 20 medium, 28 large, 36 very large.'),
    textAlign: z.enum(['left', 'center', 'right']).optional(),
    verticalAlign: z.enum(['top', 'middle', 'bottom']).optional(),
    startArrowhead: arrowhead.optional(),
    endArrowhead: arrowhead.optional(),
    arrowType: z.enum(['sharp', 'curved', 'elbow']).optional().describe('Arrows and lines: straight, curved, or elbow (right angles; only for an arrow between two elements).'),
    link: z.string().optional().describe('A URL (or "" to remove it) opened from the element.'),
    locked: z.boolean().optional().describe('Locked elements cannot be selected or moved on the page.'),
  })
  .optional()
  .describe('Excalidraw properties, only those the user asked for; anything left out keeps the diagram\'s style.')
const skippedNote = (n: string[]) => (n.length ? ` Not applied: ${n.join('; ')}.` : '')
const timelineItem = item.omit({ inside: true }).extend({ start: point, end: point.optional() })
/** addGraph plus the warnings for content a graph does not fit (shared by add_graph and draw_mermaid). */
const graphWithHints = (s: Scene, ...a: Parameters<typeof addGraph> extends [any, ...infer R] ? R : never) => {
  const r = addGraph(s, ...a)
  const edges = a[1].map((e) => ({ from: r.ids[e.from], to: r.ids[e.to] }))
  return { ...r, text: r.text + typeHints(s, 'graph', { ids: Object.values(r.ids), edges }) }
}
const columnItems = (c: Column) => [...(c.items ?? []), ...(c.sections ?? []).flatMap((x) => [{ text: x.title }, ...x.items])]

type Def = {
  name: string
  description: string
  shape: z.ZodRawShape
  run: (args: any) => Promise<string | Shot | Out>
}

/** A tool result that carries one or more PNGs (base64) next to its text. */
type Shot = { text: string; png: string | string[]; data?: Record<string, unknown> }

/** A tool result with values a script can use (ids, the node list) next to its text. Only structured clients see `data`. */
type Out = { text: string; data: Record<string, unknown> }

/** Which diagram the tools work on, and the others (only said when the project has more than one). */
async function diagramsLine() {
  const all = await listDiagrams()
  const here = all.find((d) => d.id === cur().diagramId)
  if (all.length < 2) return `Diagram: "${here?.name}".`
  return `Diagram: "${here?.name}" (${cur().diagramId}). Others: ${all.filter((d) => d !== here).map((d) => `"${d.name}" (${d.id})`).join(', ')}; switch with open_diagram.`
}

/** "new / separate / another diagram", or "create three diagrams named …": a count or a name means separate diagrams were asked for.
 *  "make a flow diagram" has neither, so a plain drawing request is still refused. */
export const asksForNewDiagram = (text: string) =>
  (/\b(new|separate|another|nou[aă]?|alt[aă]?|separat[aă]?)\b/i.test(text) && /diagra|canvas|page|pagin/i.test(text)) ||
  /\b(create|make|add|set up|creeaz[aă]|f[aă])\s+(\d+|two|three|four|five|six|doua|dou[aă]|trei|patru|cinci)\s+(\w+\s+)?diagra/i.test(text) ||
  /\bdiagrams?\s+(named|called|numit[aă]?|cu numele)\b/i.test(text)

/** Run in another diagram of the current project (open_diagram / create_diagram run in the one they leave). */
const inDiagram = <T>(id: string, fn: () => T): T => runIn(getProject(cur().id, id)!, fn)
const contextOf = (id: string) => inDiagram(id, renderContext)

const withNotes = async (id: string, body: string) => [body, await notes.format(id)].filter(Boolean).join('\n')

const withEl = <T>(s: Scene, id: string, fn: (el: El) => T) => {
  const el = find(s, id)
  if (!el) throw new Error(`No element with id ${id}`)
  return fn(el)
}

/** A picture of the given elements (nothing = the whole diagram, in a few images when it is too big for one readable one). */
async function shoot(target: string[], context: boolean): Promise<Shot> {
  const scene = await readScene()
  const look = target.length ? '' : describeLook(scene)
  const chunks = target.length ? [] : screenshotChunks(scene)
  if (chunks.length) {
    const png = await Promise.all(chunks.map((c) => requestScreenshot(c, false)))
    const parts = chunks.map((c, i) => `${i + 1}: ${c.join(', ')}`).join('; ')
    return { text: [`Screenshot of the whole diagram in ${chunks.length} parts, left to right (${parts}).`, look].filter(Boolean).join('\n') + RUBRIC(), png }
  }
  const png = await requestScreenshot(target, context)
  return { text: [target.length ? `Screenshot of ${target.join(', ')}.` : 'Screenshot of the whole diagram.', look].filter(Boolean).join('\n') + RUBRIC(), png }
}

/** The changes an update_nodes call makes (text, detail, colour, shape, style); shared with edit_nodes. */
const updateMany = (s: Scene, changes: any[], check = true) => {
  for (const c of changes) if (c.text !== undefined || c.color) updateNode(s, c.id, c.text, c.color)
  for (const c of changes) if (c.detail !== undefined) setDetail(s, c.id, c.detail)
  const skipped = restyle(s, changes.filter((c) => c.shape || c.style))
  return `Updated ${changes.length} element(s).${skippedNote(skipped)}${check ? ` ${lint(s)}` : ''}`
}
/** The moves a move_nodes call makes; shared with edit_nodes. */
const moveMany = (s: Scene, moves: any[], check = true) => {
  for (const m of moves) {
    const el = find(s, m.id)
    if (!el) throw new Error(`No element with id ${m.id}`)
    moveNode(s, m.id, m.x ?? el.x + (m.dx ?? 0), m.y ?? el.y + (m.dy ?? 0))
  }
  return `Moved ${moves.length} element(s).${check ? ` ${lint(s)}` : ''}`
}
/** The boxes an add_nodes call draws (inside a container, or at their own x,y); shared with edit_nodes. */
const addMany = (s: Scene, { containerId, items, columns, connect, grow, exact }: { containerId?: string; items: any[]; columns?: number; connect?: boolean; grow?: boolean; exact?: boolean }) => {
  if (containerId) {
    const r = addNodesInside(s, containerId, items, { columns, connect, grow })
    const styled = items.map((i: any, k: number) => ({ id: r.ids[k], style: i.style })).filter((c: any) => c.style)
    if (!styled.length) return r
    // A style (a bigger font) can grow a box: the layout check is redone after it.
    const skipped = restyle(s, styled)
    return { ...r, text: r.text + skippedNote(skipped) + `\nAfter the style changes: ${lint(s, containerId)}` }
  }
  if (items.some((i: any) => i.x === undefined || i.y === undefined)) throw new Error('Without containerId every item needs x and y')
  const placed: { id: string; moved?: unknown }[] = items.map((i: any) => addNode(s, { ...i, exact }))
  if (connect) for (let k = 1; k < placed.length; k++) connectNodes(s, placed[k - 1].id, placed[k].id)
  const moved = placed.filter((p) => p.moved).length
  const ids = placed.map((p) => p.id)
  return { ids, text: `Added ${ids.length} box(es): ${ids.join(', ')}.${moved ? ` ${moved} were nudged off a taken spot (exact=true keeps them in place).` : ''} ${lint(s)}` }
}

const changeItem = z.object({ id: z.string(), text: z.string().optional(), detail: z.string().max(600).optional(), color: colorEnum.optional(), shape: shapeEnum.optional(), style })
const moveItem = z.object({ id: z.string(), x: z.number().optional(), y: z.number().optional(), dx: z.number().optional(), dy: z.number().optional() })
/** The arguments of add_nodes (also the `add` part of edit_nodes). */
const addShape = {
  containerId: z.string().optional().describe('The frame or box to draw into, e.g. from get_selection. Omit to place each item at its own x,y.'),
  items: z.array(item.extend({ x: z.number().optional(), y: z.number().optional(), width: z.number().optional(), height: z.number().optional(), shape: shapeEnum.optional(), style })).min(1).max(100),
  columns: z.number().int().min(1).optional().describe('Force a column count; omit to let it choose.'),
  connect: z.boolean().optional().describe('Chain consecutive items with arrows (a sequence/flow).'),
  grow: z.boolean().optional().describe('Let the container grow downward if the items do not fit (default true).'),
  exact: z.boolean().optional().describe('Without containerId: no nudging to free space, no growing to fit the text.'),
}

/** The conflict guard for a write: refuse when one of these elements changed after the revision the caller read (see baseRev). */
const guard = (ids: string[], baseRev?: number) => (baseRev === undefined ? undefined : { ids, baseRev })
const baseRev = z.number().int().min(0).optional().describe('The rev the last read (list_nodes, find_nodes, get_node, get_selection) or write reported. When given, the call is refused if the user changed these elements on the canvas since then, so you re-read instead of overwriting their edit.')
/** Tools that change existing elements, which therefore take baseRev. */
const GUARDED = new Set(['update_node', 'update_nodes', 'move_node', 'move_nodes', 'resize_node', 'resize_nodes', 'delete_node', 'delete_nodes', 'arrange', 'edit_nodes', 'transform_nodes'])

const defs: Def[] = [
  {
    name: 'list_nodes',
    description: 'List every shape, free text, image, embed and frame on the canvas (id, type, text, position, size). With all=true also lines, arrows and freehand drawings. get_node shows one element\'s connections and style. On a big diagram use find_nodes instead of listing everything.',
    shape: { all: z.boolean().optional().describe('Also list lines, arrows and drawings.') },
    run: async ({ all }) => {
      const nodes = listNodes(await readScene(), all)
      return { text: `${await diagramsLine()}\n` + (nodes.map((n) => `${n.id} ${n.type} @${n.x},${n.y} ${n.w}x${n.h} "${n.text}"`).join('\n') || '(empty canvas)'), data: { nodes } }
    },
  },
  {
    name: 'find_nodes',
    description:
      'Search the canvas instead of listing everything (use it on a big diagram). Matches a box\'s title or the explanation under it, ignoring case, spaces, "-" and "_" ("Auth Flow" finds "auth-flow"). mode "glob" uses * (any run) and ? (one character) and must match the whole text. Filter by types (rectangle, diamond, ellipse, text, frame, image, embeddable; arrow, line and freedraw only when named) and/or frameId (only what lies inside that frame or box). Give at least one of query, types, frameId. Returns the rows list_nodes would, up to limit (default 50), and says how many more matched.',
    shape: {
      query: z.string().max(200).optional().describe('Text to look for.'),
      mode: z.enum(['contains', 'glob']).optional().describe('contains (default) or glob.'),
      types: z.array(z.string()).max(10).optional().describe('Only these element types.'),
      frameId: z.string().optional().describe('Only elements inside this frame or box.'),
      limit: z.number().int().min(1).max(200).optional().describe('At most this many rows (default 50).'),
    },
    run: async (a) => {
      if (!a.query?.trim() && !a.types?.length && !a.frameId) throw new Error('Give a query, types or frameId.')
      const { total, nodes } = searchNodes(await readScene(), a)
      if (!total) return { text: 'No match.', data: { nodes } }
      const rows = nodes.map((n) => `${n.id} ${n.type} @${n.x},${n.y} ${n.w}x${n.h} "${n.text}"`).join('\n')
      const more = total > nodes.length ? `\n… ${total - nodes.length} more matched; narrow the query or raise limit.` : ''
      return { text: `${total} match(es):\n${rows}${more}`, data: { nodes } }
    },
  },
  {
    name: 'delete_generated',
    description: 'Delete a whole drawing made with a whole-diagram tool or add_chart (ids from get_generated) with every piece of it, including lines such as pie slices, arrows and gridlines that list_nodes does not show. Prefer it to deleting a chart box by box. Undoable.',
    shape: { id: z.string() },
    run: async ({ id }) => {
      const g = await generated.get(id)
      if (!g) throw new Error(`No generated drawing ${id}; get_generated lists them.`)
      const scene = await readScene()
      const alive = g.ids.filter((i) => find(scene, i))
      if (!alive.length) {
        await generated.remove(id)
        return `Nothing of ${id} was left on the canvas; forgot it.`
      }
      const text = await mutate((s) => deleteNodes(s, alive), `delete_generated ${id}`)
      await generated.remove(id)
      return `${text} (${id}, ${g.tool})`
    },
  },
  {
    name: 'get_generated',
    description:
      'The whole-diagram drawings made so far (draw_mermaid, add_graph, add_columns, add_grid, add_timeline, add_tree, add_sequence, add_cycle, add_quadrant, add_mindmap): without id a list (id, tool, how many of its elements are still on the canvas); with an id the arguments it was drawn with, as JSON. Edit them and call the same tool with replace: id to change the drawing in place; delete_generated removes a whole drawing (a chart\'s slices and lines are not listed by list_nodes).',
    shape: { id: z.string().optional() },
    run: async ({ id }) => {
      const all = await generated.all()
      const scene = await readScene()
      if (id) {
        const g = all[id]
        if (!g) throw new Error(`No generated drawing ${id}.`)
        return `${g.id}: ${g.tool}\n${JSON.stringify(g.args)}`
      }
      const list = Object.values(all)
      return list.length ? list.map((g) => `${g.id} ${g.tool} ${g.ids.filter((i) => find(scene, i)).length}/${g.ids.length} elements still on the canvas, ${g.date.slice(0, 16)}`).join('\n') : 'Nothing was drawn with a whole-diagram tool yet.'
    },
  },
  {
    name: 'read_guide',
    description: `How to use the drawing tools: which tool fits what, argument shapes, styles, details and notes, fixing the layout. Call it before your first drawing in a session (topics: ${GUIDE_TOPICS.join(', ')}; none = all).`,
    shape: { topics: z.array(z.string()).max(10).optional().describe('Topics to read; omit for all of them.') },
    run: async ({ topics }) => readGuide(topics),
  },
  {
    name: 'get_node',
    description: 'Full text of one element: its text, its style (colours, fill, stroke, font, arrowheads, frame, group, link, lock), what it contains, its arrow connections and its saved notes.',
    shape: { id: z.string() },
    run: async ({ id }) => withNotes(id, describeNode(await readScene(), id, 8000)),
  },
  {
    name: 'get_space',
    description:
      'Spatial awareness. With an id: that element\'s bounds, the usable area inside it, what is already inside, how much of it is free, and how far it can grow before touching a neighbour. Without an id: the extent of the whole canvas and where empty space starts. ALWAYS call this on the target box/frame before drawing into or next to it, and size what you draw from these numbers.',
    shape: { id: z.string().optional() },
    run: async ({ id }) => getSpace(await readScene(), id),
  },
  {
    name: 'check_layout',
    description:
      'Lint the layout: overlapping boxes, boxes sticking out of their container, text too big for its box, arrows running through boxes. Pass an id to check only that area. Call it after every drawing change and fix what it reports (move_node / resize_node / update_node) until it says Layout OK.',
    shape: { id: z.string().optional() },
    run: async ({ id }) => lint(await readScene(), id),
  },
  {
    name: 'screenshot',
    description:
      'See the canvas: returns a PNG of only the given elements (with their text, contents and attached arrows), or of the current selection when no ids are given, or of the whole diagram when nothing is selected. Use it to check how a drawing LOOKS (alignment, spacing, readability, colours), which check_layout cannot tell. Call it after drawing and again after fixes. Needs the canvas page open in a browser.',
    shape: {
      ids: z.array(z.string()).max(12).optional().describe('Elements to show. Omit to use the current selection, or the whole diagram.'),
      context: z.boolean().optional().describe('Also show the neighbouring elements around the target (to judge alignment and spacing). Default: only the target.'),
    },
    run: ({ ids, context }) => shoot(ids?.length ? ids : selection().ids, !!context),
  },
  {
    name: 'get_context',
    description: 'The user\'s context for the diagram the tools work on now, set in the canvas Context tab: how to work with the user (the same for every diagram), and this diagram\'s style (colour legend, text length, look) and what it is about. Each diagram has its own; re-read it after switching diagrams or when the user says they changed it. It overrides your defaults.',
    shape: {},
    run: async () => renderContext(),
  },
  {
    name: 'get_selection',
    description: 'What the user currently has selected in the open canvas page (the first item is the main one). When nothing is selected, the whole open diagram counts as selected and is returned. Call this FIRST whenever the user asks for any change or opinion without naming what it applies to ("rephrase", "make it red", "I don\'t like the wording", "this box"). The selection is the SCOPE of the request: change only these items.',
    shape: {},
    run: async () => {
      const sel = selection().ids
      const scene = await readScene()
      if (!sel.length) {
        const nodes = listNodes(scene)
        if (!nodes.length) return `${await diagramsLine()}\n\nNothing is selected and the diagram is empty: draw new content with get_space (no id).`
        const scope = `SCOPE: nothing is selected, so the WHOLE diagram (${nodes.length} element${nodes.length > 1 ? 's' : ''}) counts as selected. Apply the request to the diagram as a whole.`
        const out = await Promise.all(nodes.slice(0, 80).map((n) => withNotes(n.id, `- ${n.id} ${n.type} @${n.x},${n.y} ${n.w}x${n.h} "${n.text}"`)))
        if (nodes.length > 80) out.push(`… and ${nodes.length - 80} more (list_nodes shows all).`)
        return [await diagramsLine(), scope, out.join('\n')].join('\n\n')
      }
      const out: string[] = []
      for (const id of sel.slice(0, 12)) out.push(await withNotes(id, describeNode(scene, id)))
      const n = sel.length
      const scope = `SCOPE: the user selected ${n} item${n > 1 ? 's' : ''}. Apply the request to ${n > 1 ? 'these items' : 'this item'} only; do not touch other elements (including its neighbours in a sequence) unless the user explicitly says "all", "the whole diagram" or names others. If the request seems to need more, say so and ask.`
      return [await diagramsLine(), scope, ...out].join('\n\n')
    },
  },
  {
    name: 'get_notes',
    description: 'Saved notes (decisions, facts, open questions) for one node, or for every node when id is omitted. Check these before changing or discussing a box.',
    shape: { id: z.string().optional() },
    run: async ({ id }) => {
      if (id) return (await notes.format(id)) || '(no notes)'
      const all = await notes.all()
      // Notes of deleted boxes stay saved (undo brings the boxes back) but are not part of the diagram now.
      const scene = await readScene()
      const live = Object.keys(all).filter((n) => find(scene, n))
      const gone = Object.keys(all).length - live.length
      const out = await Promise.all(live.map(async (n) => `### ${n}\n${await notes.format(n)}`))
      return [out.join('\n\n') || '(no notes yet)', gone ? `(${gone} more note(s) belong to boxes that were deleted; undo brings them back.)` : ''].filter(Boolean).join('\n\n')
    },
  },
  {
    name: 'add_note',
    description: 'Save a durable note on a node: a decision and its reason, a fact learned, or an open question. Use it when something is settled in conversation, so it is remembered in later conversations. One short sentence or two. Set kind so the user can find open questions on the canvas.',
    shape: { id: z.string(), text: z.string().max(1000), kind: z.enum(NOTE_KINDS).optional(), status: z.enum(NOTE_STATUSES).optional().describe('open = unresolved question, decided = settled, reversed = no longer true. Defaults from kind (question -> open, decision -> decided).') },
    run: async ({ id, text, kind, status }) => {
      if (!(await readScene()).elements.some((e) => e.id === id && !e.isDeleted)) throw new Error(`No element with id ${id}`)
      const n = await notes.add(id, text, kind, status)
      return `Saved note ${n.id} on ${id}.`
    },
  },
  {
    name: 'update_note',
    description: 'Change a saved note by its id: its text, kind and/or status. Use it to close an open question (status decided), or to mark a decision reversed instead of deleting it, so the reasoning stays in the decision log.',
    shape: { id: z.string(), text: z.string().max(1000).optional(), kind: z.enum(NOTE_KINDS).optional(), status: z.enum(NOTE_STATUSES).optional() },
    run: async ({ id, text, kind, status }) => {
      const ok = await notes.update(id, { text, kind, status })
      return ok ? `Updated ${id}.` : `No note ${id}.`
    },
  },
  {
    name: 'export_decisions',
    description: 'Write DECISIONS.md in the project root: every decision and open question saved as a note, grouped into open / decided / reversed. Returns the file path.',
    shape: {},
    run: async () => `Wrote ${await exportDecisions()}.`,
  },
  {
    name: 'delete_note',
    description: 'Delete a saved note by its id (for example m3), for example when a decision was reversed.',
    shape: { id: z.string() },
    run: async ({ id }) => {
      const ok = await notes.remove(id)
      return ok ? `Deleted ${id}.` : `No note ${id}.`
    },
  },
  {
    name: 'get_animations',
    description: 'The presentations saved for this diagram (Steps / Present on the canvas). A diagram can hold several, each with a name and an ordered list of steps (the boxes that appear together plus an optional caption).',
    shape: {},
    run: async () => {
      const all = await getAnimations()
      return all.map((a) => `## ${a.name}\n${a.steps.map((s, i) => `${i + 1}. ${s.ids.join(', ')}${s.caption ? ` - ${s.caption}` : ''}`).join('\n') || '(no steps)'}`).join('\n\n') || '(no animations yet)'
    },
  },
  {
    name: 'set_animation',
    description:
      'Create or replace ONE presentation by name (other presentations are left alone; an empty steps list deletes it). When the user presents it, the canvas reveals one step per click: boxes fade in, arrows and lines listed in the step are drawn from start to end (their label appears as they arrive), and earlier steps dim so the new one stands out. Anything not in any step stays visible all the time (e.g. the participants and lifelines of a sequence, the frame of a flow). The camera shows the whole animated area and only follows the steps when it is too big to read. Each step lists ids of boxes, frames, arrows or lines (a box brings its text and contents; an unlisted arrow appears once both its ends are visible) and an optional caption. Order the steps the way the story is told: for a sequence or a flow, one message/arrow per step, in time order; a box and the arrow into it can share a step (the box comes first, then the arrow is drawn). The step\'s own label is already on the canvas, so a caption should add something (why it happens, what it carries) or be left out; don\'t repeat the label or number it. Does not change the diagram; it is not part of undo.',
    shape: { name: z.string().min(1).max(60), steps: z.array(z.object({ ids: z.array(z.string()).min(1).max(50), caption: z.string().max(200).optional() })).max(100) },
    run: async ({ name, steps }) => {
      const scene = await readScene()
      const bad = steps.flatMap((s: { ids: string[] }) => s.ids).filter((id: string) => !scene.elements.some((e) => e.id === id && !e.isDeleted))
      if (bad.length) throw new Error(`No element with id ${[...new Set(bad)].join(', ')}`)
      await upsertAnimation(name.trim(), steps)
      return steps.length ? `Saved "${name}" with ${steps.length} steps.` : `Deleted "${name}".`
    },
  },
  {
    name: 'update_node',
    description: 'Change the text, the detail (the explanation under the title), colour, shape and/or any Excalidraw property (style: stroke/background colour, fill style, stroke width and style, sloppiness, edges, opacity, rotation, font, font size, text alignment, arrowheads, arrow type, link, lock) of any element: box, text, arrow, line, drawing, image, frame (its text is its name). Text is wrapped to the box\'s current width; the box only grows taller, never wider. detail moves the title to the top and puts the explanation under it ("" removes it); what is inside the box moves down and the box grows. shape turns a rectangle into a diamond or ellipse (or back). Use resize_node for a different size.',
    shape: { id: z.string(), text: z.string().optional(), detail: z.string().max(600).optional().describe('The explanation under the title: one or two sentences; "" removes it.'), color: colorEnum.optional().describe('Stroke + soft fill (stroke only for text and arrows).'), shape: shapeEnum.optional(), style },
    run: async ({ id, text, detail, color, shape, style, baseRev }) =>
      text === undefined && detail === undefined && !color && !shape && !style
        ? 'Give text, detail, color, shape and/or style.'
        : mutate((s) => {
            const r = updateNode(s, id, text, color)
            const d = detail === undefined ? '' : ` ${setDetail(s, id, detail)}`
            return r + skippedNote(restyle(s, [{ id, shape, style }])) + d
          }, `update_node ${text ?? detail ?? color ?? shape ?? 'style'}`, guard([id], baseRev)).then((r) => r + styleNote(text ? [text] : [], [color])),
  },
  {
    name: 'add_node',
    description: 'Add ONE box with text (rectangle by default; shape diamond for a decision, ellipse for a start/end) (wrapped to width, default fits the text up to 260px), optionally with a detail under its title and boxes inside it. Placed to the right of nearId when given, otherwise at x,y, otherwise below everything; a spot that would overlap an existing box is nudged to free space. To fill a frame or box with several items use add_nodes instead. connectFrom draws an arrow from that element to the new one. Without nearId or x,y every box goes BELOW everything, so repeated add_node calls make one tall column: for grouped content (days, stages) use add_columns; for a flow, connect the boxes and then run auto_layout (left to right). With exact=true (needs x,y) the box goes exactly there at exactly width x height, even over other boxes and smaller than its text; for bare lines and ticks use add_shapes instead.',
    shape: {
      width: z.number().optional(),
      height: z.number().optional(),
      text: z.string(),
      nearId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      color: colorEnum.optional().describe('Stroke + soft fill. Omit for a plain black outline.'),
      connectFrom: z.string().optional(),
      exact: z.boolean().optional().describe('Place at x,y with the given size, without nudging it to free space or growing it to fit the text.'),
      shape: shapeEnum.optional(),
      detail,
      inside,
      notes: noteList,
      style,
    },
    run: (o) =>
      mutate((s) => addNode(s, o), `add_node ${o.text}`).then(async ({ id, moved }) => ({
        text: `Added ${id}.` + (moved ? ` ${o.x},${o.y} was taken, so it went to ${moved.x},${moved.y}.` : '') + (await saveNotes([[id, o.notes]])) + styleNote([o.text], [o.color]),
        data: { id },
      })),
  },
  {
    name: 'add_nodes',
    description:
      'Two uses. (1) With containerId: a few items go INSIDE an existing box or frame (its steps, list or options); it measures the container, picks the grid that matches its proportions, wraps text and centres the block; connect=true chains the items with arrows in snake order. Call get_space on the container first. (2) Without containerId: every item has its own x,y (and optional width/height), several boxes placed at absolute positions in one call; exact=true keeps them exactly there and that size, even over other boxes. Not for a new diagram (use add_timeline, add_graph, add_columns or add_grid). Keep each title to a few words; an explanation goes in its detail. Example: add_nodes({ containerId: "n_1", items: [{ text: "Collect" }, { text: "Review" }], connect: true })',
    shape: addShape,
    run: (o) =>
      mutate((s) => addMany(s, o), `add_nodes ${o.items.length} items`).then(async (r) => ({
        text: r.text + (await saveNotes(o.items.map((i: any, k: number) => [r.ids[k], i.notes] as [string, NoteIn[] | undefined]))) + styleNote(o.items.map((i: any) => i.text), o.items.map((i: any) => i.color)),
        data: { ids: r.ids },
      })),
  },
  {
    name: 'add_shapes',
    description:
      'Anything the Excalidraw toolbar draws, at exact coordinates, all in one call: lines and arrows (any arrowheads, curved, closed into a filled polygon, labelled), rectangles / diamonds / ellipses (bare or with text), free texts (any font and size), freehand drawings (pencil strokes through points), images (a file path in the project, an http(s) URL or a data: URL), web embeds (sites Excalidraw allows: YouTube, Vimeo, Figma, Google Maps, GitHub gists, X…; any other URL shows only as a link) and frames (named, around given elements or at given bounds). Use it whenever the user describes the geometry itself ("a horizontal line", "vertical ticks", "a thin bar", "a star", "put this logo here", "a frame around these") rather than a diagram of boxes. Nothing is nudged and there is no minimum size; a text\'s x,y is its centre (its left/right edge with align left/right). Each element takes a `style` with any Excalidraw property. A frame\'s `around` can name elements made in the same call as "#0", "#1"… (their order in the result ids: lines, shapes, texts, drawings, images, embeds). Example (a 2-month axis with ticks and labels): add_shapes({ lines: [{ points: [{x:0,y:100},{x:400,y:100}] }, { points: [{x:0,y:90},{x:0,y:110}] }, { points: [{x:200,y:90},{x:200,y:110}] }], texts: [{ text: "01", x: 0, y: 75 }, { text: "02", x: 200, y: 75 }] })',
    shape: {
      lines: z
        .array(
          z.object({
            points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).max(200).describe('Absolute canvas points, in order.'),
            color: colorEnum.optional(),
            width: z.number().min(0.5).max(20).optional().describe('Stroke width in px (default 2).'),
            dashed: z.boolean().optional(),
            arrow: z.boolean().optional().describe('An arrowhead at the last point.'),
            startArrowhead: arrowhead.optional(),
            endArrowhead: arrowhead.optional(),
            curved: z.boolean().optional().describe('A smooth curve through the points instead of straight segments.'),
            closed: z.boolean().optional().describe('Join the last point to the first: a polygon that style.background can fill.'),
            label: z.string().optional().describe('Text on the line.'),
            style,
          }),
        )
        .max(400)
        .optional(),
      shapes: z
        .array(
          z.object({
            shape: shapeEnum.optional(),
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
            color: colorEnum.optional(),
            fill: z.boolean().optional().describe('Filled instead of outlined.'),
            text: z.string().optional().describe('Text inside the shape (the shape grows if it does not fit).'),
            style,
          }),
        )
        .max(400)
        .optional(),
      texts: z
        .array(
          z.object({
            text: z.string(),
            x: z.number(),
            y: z.number(),
            size: z.number().min(6).max(200).optional().describe('Font size (default: the diagram\'s).'),
            color: colorEnum.optional(),
            align: z.enum(['left', 'center', 'right']).optional(),
            maxWidth: z.number().optional().describe('Wrap the text to this width.'),
            style,
          }),
        )
        .max(400)
        .optional(),
      drawings: z
        .array(
          z.object({
            points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).max(2000).describe('Absolute points of one pencil stroke, close together (a few px apart) for a smooth line.'),
            color: colorEnum.optional(),
            width: z.number().min(0.5).max(40).optional(),
            style,
          }),
        )
        .max(100)
        .optional(),
      images: z
        .array(
          z.object({
            src: z.string().describe('A file path (relative to the project or absolute), an http(s) URL or a data: URL.'),
            x: z.number(),
            y: z.number(),
            width: z.number().optional().describe('Give one side to keep the proportions; neither = its own size, at most 600px wide.'),
            height: z.number().optional(),
            style,
          }),
        )
        .max(20)
        .optional(),
      embeds: z
        .array(z.object({ url: z.string(), x: z.number(), y: z.number(), width: z.number().optional(), height: z.number().optional(), style }))
        .max(20)
        .optional(),
      frames: z
        .array(
          z.object({
            name: z.string(),
            around: z.array(z.string()).optional().describe('Element ids (or "#0", "#1"… for ones made in this call) the frame goes around.'),
            padding: z.number().optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
          }),
        )
        .max(20)
        .optional(),
    },
    run: async (o) => {
      // Reading a file or a URL is async; the scene change itself is not.
      const images = await Promise.all((o.images ?? []).map(async ({ src, ...rest }: any) => ({ ...rest, image: await loadImage(src) })))
      return mutate((s) => addShapes(s, { ...o, images }), `add_shapes`).then((r) => ({ text: r.text, data: { ids: r.ids } }))
    },
  },
  {
    name: 'arrange',
    description:
      'What the page\'s Arrange menu does, for several elements at once: group / ungroup them (they then select and move together on the page), bring them to the front or send them to the back (or one step forward / backward), align them (left, center, right, top, middle, bottom), space them evenly (horizontal / vertical, needs 3+), or put them in a frame (frame: id) or take them out (frame: null). Each element keeps its own text with it. Returns a layout check.',
    shape: {
      ids: z.array(z.string()).min(1).max(200),
      group: z.boolean().optional(),
      ungroup: z.boolean().optional(),
      order: z.enum(['front', 'back', 'forward', 'backward']).optional(),
      align: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']).optional(),
      distribute: z.enum(['horizontal', 'vertical']).optional(),
      frame: z.string().nullable().optional(),
    },
    run: ({ baseRev, ...o }) => mutate((s) => arrange(s, o), `arrange ${o.ids.length}`, guard(o.ids, baseRev)),
  },
  {
    name: 'plan_diagram',
    description:
      'Call this before drawing a new diagram or redrawing a large part of one (not for small edits): it reads the user\'s text and ranks the 2-3 kinds of diagram that fit it (timeline, flow, architecture, columns, table, tree, …), each with the reason, how their content maps onto it and the drawing tool to use. Show the user these options, each with a short sketch of THEIR content laid out that way, and end your turn; draw only after they answer. Pass the user\'s text as written, with its line breaks; without it only the first 500 characters of their message are read, flattened to one line.',
    shape: {
      text: z.string().max(40000).optional().describe('The content to draw, usually the user\'s message as written.'),
    },
    run: async ({ text: given }) => {
      const src = given?.trim() || currentTurn()?.text
      if (!src) throw new Error('No text to read: pass `text`, the content the user wants drawn.')
      const opts = recommend(src)
      const examples = closestExamples(src, opts.map((o) => o.type))
      const explain = explainsTopic(src)
      planShown().turn = turnId()
      planShown().at = Date.now()
      return {
        text: `Options for this content, best first:\n${renderOptions(opts, toSettle(src))}${renderExamples(examples)}${explain ? `\n${EXPLAIN_PLAN}` : ''}\nShow these to the user (numbered, the first marked as recommended, each with a 3-5 line sketch of their own content) and stop; draw only after the user answers, with the tool of the option they pick.`,
        data: { options: opts, examples: examples.map((e) => e.id), explain },
      }
    },
  },
  {
    name: 'add_columns',
    description:
      'Use when the content is groups WITHOUT times: stages, categories, a board, headings each with a list under them. Not for items with times or dates (add_timeline), steps joined by arrows (add_graph), or options compared by criteria (add_grid). Draws a left-to-right row of titled columns with their items stacked inside; alternatives within a group (Plan A / Plan B) go in `sections` of that column, never as a prefix on every item. connect=true draws an arrow from each column to the next; chain=true links the items inside each column top to bottom. Placed below what is already there unless x,y are given. Example: add_columns({ columns: [{ title: "Backlog", items: [{ text: "Login page" }] }, { title: "Done", items: [{ text: "Onboarding" }] }] })',
    shape: {
      columns: z
        .array(
          z.object({
            title: z.string(),
            items: z.array(item).max(40).optional().describe('Boxes stacked directly in the column, above its sections.'),
            notes: noteList,
            sections: z
              .array(z.object({ title: z.string(), items: z.array(item).max(30), color: colorEnum.optional(), notes: noteList }))
              .max(6)
              .optional()
              .describe('Titled boxes inside the column, each with its own items, e.g. [{ title: "Plan A", items: [...] }, { title: "Plan B", items: [...] }].'),
            color: colorEnum.optional(),
          }),
        )
        .min(1)
        .max(12),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().optional().describe('Column width. Omit to fit the text (240-360px).'),
      connect: z.boolean().optional().describe('Arrow from each column to the next (a sequence such as days).'),
      chain: z.boolean().optional().describe('Arrows between consecutive items inside each column.'),
    },
    run: ({ columns, x, y, width, connect, chain }) =>
      mutate((s) => {
        const r = addColumns(s, columns, { x, y, width, connect, chain })
        return { ...r, text: r.text + typeHints(s, 'columns', { ids: r.columns.flatMap((c) => c.ids.filter((id) => !c.sections?.some((x) => x.id === id))), titles: columns.map((c: Column) => c.title) }) }
      }, `add_columns ${columns.length} columns`).then(async (r) => ({
        text:
          r.text +
          (await saveNotes(
            columns.flatMap((c: Column & { notes?: NoteIn[] }, i: number) => {
              const made = r.columns[i]
              return [
                [made.id, c.notes] as [string, NoteIn[] | undefined],
                ...(c.items ?? []).map((it: any, k: number) => [made.ids[k], it.notes] as [string, NoteIn[] | undefined]),
                ...(c.sections ?? []).flatMap((sec: any, k: number) => [
                  [made.sections?.[k]?.id, sec.notes] as [string | undefined, NoteIn[] | undefined],
                  ...sec.items.map((it: any, j: number) => [made.sections?.[k]?.ids[j], it.notes] as [string | undefined, NoteIn[] | undefined]),
                ]),
              ]
            }),
          )) +
          styleNote(columns.flatMap((c: Column) => [c.title, ...columnItems(c).map((i) => i.text)]), columns.flatMap((c: Column) => [c.color, ...(c.sections ?? []).map((x) => x.color), ...columnItems(c).map((i) => i.color)])),
        data: { ids: r.ids, columns: r.columns },
      })),
  },
  {
    name: 'add_graph',
    description:
      'Use when parts are joined by arrows: a process with steps and decisions, or an architecture (components that call each other, with groups for layers or systems). Not for things placed in time (add_timeline), lists under headings (add_columns), or a list hanging off one heading (a hub with many spokes is the wrong type). Draws boxes with your own short keys, arrows between keys and optional groups (a titled box around its members), laid out automatically left to right (direction TB for a hierarchy) below what is already there. Returns key=id pairs. draw_mermaid is the same drawing written as Mermaid text. Example: add_graph({ nodes: [{ key: "api", text: "API", group: "be" }, { key: "db", text: "Postgres", group: "be" }], edges: [{ from: "api", to: "db", label: "SQL" }], groups: [{ key: "be", title: "Backend" }] })',
    shape: {
      nodes: z.array(item.extend({ key: z.string(), group: z.string().optional().describe('Key of the group this box belongs to.'), shape: z.enum(['rectangle', 'diamond', 'ellipse']).optional().describe('diamond = a decision, ellipse = start / end; default a box.') })).min(1).max(60),
      edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string().optional() })).max(120).optional(),
      groups: z.array(z.object({ key: z.string(), title: z.string(), color: colorEnum.optional() })).max(15).optional(),
      direction: z.enum(['LR', 'TB']).optional().describe('LR = left to right (default), TB = top to bottom.'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: ({ nodes, edges, groups, direction, x, y }) =>
      elkPositions(nodes, edges ?? [], { direction })
        .then((layout) => mutate((s) => graphWithHints(s, nodes, edges ?? [], { groups, direction: direction ?? 'LR', x, y, layout: layout ?? undefined }), `add_graph ${nodes.length} boxes`))
        .then(async (r) => ({
        text: r.text + (await saveNotes(nodes.map((n: any) => [r.ids[n.key], n.notes] as [string, NoteIn[] | undefined]))) + styleNote(nodes.map((n: any) => n.text), [...nodes, ...(groups ?? [])].map((n: any) => n.color)),
        data: { keys: r.ids, groups: r.groups },
      })),
  },
  {
    name: 'draw_mermaid',
    description:
      'Use when parts are joined by arrows (a process, an architecture) and Mermaid is shorter to write: the same drawing as add_graph, so pick whichever is shorter. Not for things placed in time (add_timeline), lists under headings (add_columns) or tables (add_grid). Supports `flowchart LR|TD`, nodes `A[Text]`, edges `A --> B`, `A -->|label| B`, chains `A --> B --> C`, groups `subgraph id [Title] ... end`; `B{Decision?}` is drawn as a diamond and `A((Start))` / `A([End])` as an ellipse; styling lines are ignored. Laid out automatically below what is already there. Example: draw_mermaid({ code: "flowchart LR\\n  A[Order] --> B[Pay] --> C[Ship]" })',
    shape: { code: z.string().max(20000), x: z.number().optional(), y: z.number().optional() },
    run: async ({ code, x, y }) => {
      const g = parseMermaid(code)
      const layout = await elkPositions(g.nodes, g.edges, { direction: g.direction })
      const r = await mutate((s) => graphWithHints(s, g.nodes, g.edges, { groups: g.groups, direction: g.direction, x, y, layout: layout ?? undefined }), `draw_mermaid ${g.nodes.length} boxes`)
      return { text: r.text, data: { keys: r.ids, groups: r.groups } }
    },
  },
  {
    name: 'add_tree',
    description:
      'Use when the content is a hierarchy: an org chart, a breakdown of a whole into parts, nested categories, "reports to", "consists of". Not for steps in order (add_graph), lists under a few headings (add_columns) or a brainstorm around one idea (add_mindmap). Draws each node under its parent, top-down (direction LR for left to right), with one arrow per parent and siblings in the order given; nodes without a parent are roots. Placed below what is already there unless x,y are given. Example: add_tree({ nodes: [{ key: "ceo", text: "CEO" }, { key: "cto", text: "CTO", parent: "ceo" }, { key: "web", text: "Web team", parent: "cto" }] })',
    shape: {
      nodes: z.array(item.extend({ key: z.string(), parent: z.string().optional().describe('Key of the parent node; omit for a root.') })).min(1).max(80),
      direction: z.enum(['TB', 'LR']).optional().describe('TB = top-down (default), LR = left to right.'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: async ({ nodes, direction, x, y }) => {
      const plain = nodes.map(({ notes: _, ...n }: any) => n)
      const layout = await elkPositions(plain.map(({ parent: _, ...n }: any) => n), treeEdges(plain), { direction: direction ?? 'TB' })
      const r = await mutate((s) => {
        const t = addTree(s, plain, { direction, x, y, layout: layout ?? undefined })
        return { ...t, text: t.text + typeHints(s, 'tree', { ids: Object.values(t.ids) }) }
      }, `add_tree ${nodes.length} nodes`)
      return {
        text: r.text + (await saveNotes(nodes.map((n: any) => [r.ids[n.key], n.notes] as [string, NoteIn[] | undefined]))) + styleNote(nodes.map((n: any) => n.text), nodes.map((n: any) => n.color)),
        data: { keys: r.ids },
      }
    },
  },
  {
    name: 'add_sequence',
    description:
      'Use when actors exchange messages in order: a login or API call flow, a handshake, who asks whom and who answers ("user -> app: login"). Not for a process without actors (add_graph) or things placed in time (add_timeline). Draws the actors as headers across the top with dashed lifelines, and one labelled arrow per message top to bottom in the order given; reply=true draws it dashed, from = to a small loop. Placed below what is already there unless x,y are given. Example: add_sequence({ actors: ["User", "App", "Server"], messages: [{ from: "User", to: "App", text: "Log in" }, { from: "App", to: "Server", text: "POST /login" }, { from: "Server", to: "App", text: "token", reply: true }] })',
    shape: {
      actors: z.array(z.union([z.string(), z.object({ text: z.string(), color: colorEnum.optional() })])).min(2).max(10),
      messages: z.array(z.object({ from: z.string(), to: z.string(), text: z.string(), reply: z.boolean().optional() })).max(60),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: ({ actors, messages, x, y }) => {
      const list = actors.map((a: any) => (typeof a === 'string' ? { text: a } : a))
      return mutate((s) => addSequence(s, list, messages, { x, y }), `add_sequence ${messages.length} messages`).then((r) => ({
        text: r.text + styleNote([...list.map((a: any) => a.text), ...messages.map((m: any) => m.text)], list.map((a: any) => a.color)),
        data: { ids: r.ids, messages: r.messages },
      }))
    },
  },
  {
    name: 'add_cycle',
    description:
      'Use when steps repeat in a loop: PDCA, a feedback loop, a lifecycle, a sprint ritual, "and back to the start". Not for a process that ends (add_graph) or steps with dates (add_timeline). Draws the steps on a circle clockwise from the top, an arrow from each to the next and from the last back to the first, with an optional title in the middle. Placed below what is already there unless x,y are given. Example: add_cycle({ title: "PDCA", steps: [{ text: "Plan" }, { text: "Do" }, { text: "Check" }, { text: "Act" }] })',
    shape: { steps: z.array(item).min(2).max(12), title: z.string().optional(), x: z.number().optional(), y: z.number().optional() },
    run: ({ steps, title, x, y }) =>
      mutate((s) => addCycle(s, steps, { title, x, y }), `add_cycle ${steps.length} steps`).then(async (r) => ({
        text: r.text + (await saveNotes(steps.map((st: any, i: number) => [r.ids[i], st.notes] as [string, NoteIn[] | undefined]))) + styleNote(steps.map((st: any) => st.text), steps.map((st: any) => st.color)),
        data: { ids: r.ids },
      })),
  },
  {
    name: 'add_quadrant',
    description:
      'Use when items are sorted on two axes: impact x effort, urgent x important, risk x likelihood, value x cost. Not for options compared on several criteria (add_grid) or plain groups (add_columns). Draws a 2x2 matrix, high y on top and high x on the right, with optional quadrant titles (top-left, top-right, bottom-left, bottom-right) and each item in its quadrant by x and y ("low" or "high"). Placed below what is already there unless x,y are given. Example: add_quadrant({ xAxis: { title: "Effort", low: "Low", high: "High" }, yAxis: { title: "Impact", low: "Low", high: "High" }, titles: ["Quick wins", "Big bets", "Fill-ins", "Avoid"], items: [{ text: "Dark mode", x: "low", y: "high" }] })',
    shape: {
      xAxis: z.object({ title: z.string().optional(), low: z.string(), high: z.string() }),
      yAxis: z.object({ title: z.string().optional(), low: z.string(), high: z.string() }),
      titles: z.array(z.string()).length(4).optional().describe('Quadrant titles: top-left, top-right, bottom-left, bottom-right.'),
      items: z.array(item.extend({ x: z.enum(['low', 'high']), y: z.enum(['low', 'high']) })).max(60),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: (g) =>
      mutate((s) => addQuadrant(s, { ...g, x: g.x, y: g.y }), `add_quadrant ${g.items.length} items`).then(async (r) => {
        const cells = [['low', 'high'], ['high', 'high'], ['low', 'low'], ['high', 'low']]
        const pairs = g.items.map((it: any) => {
          const k = cells.findIndex(([x, y]) => x === it.x && y === it.y)
          const n = g.items.filter((o: any) => o.x === it.x && o.y === it.y).indexOf(it)
          return [r.items[k]?.[n], it.notes] as [string | undefined, NoteIn[] | undefined]
        })
        return { text: r.text + (await saveNotes(pairs)) + styleNote(g.items.map((i: any) => i.text), g.items.map((i: any) => i.color)), data: { ids: r.ids } }
      }),
  },
  {
    name: 'add_mindmap',
    description:
      'Use when one central idea branches into topics: a brainstorm, the themes of a launch, a topic overview. Not for a strict hierarchy with levels (add_tree) or steps in order (add_graph). Draws the centre in the middle, the branches split right and left (first half right), each branch\'s ideas further out on its side, arrows from the centre out. Placed below what is already there unless x,y are given. Example: add_mindmap({ center: "Launch", branches: [{ text: "Marketing", children: [{ text: "Blog" }, { text: "Ads" }] }, { text: "Pricing" }] })',
    shape: {
      center: z.union([z.string(), z.object({ text: z.string(), detail })]).describe('The central idea: a title, or { text, detail } with a sentence under it.'),
      branches: z.array(item.extend({ children: z.array(item).max(12).optional() })).min(1).max(12),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: ({ center, branches, x, y }) =>
      mutate((s) => {
        const r = addMindmap(s, center, branches, { x, y })
        return { ...r, text: r.text + typeHints(s, 'tree', { ids: r.branches.flatMap((b) => [b.id, ...b.children]) }) }
      }, `add_mindmap ${branches.length} branches`).then(async (r) => ({
        text:
          r.text +
          (await saveNotes(branches.flatMap((b: any, i: number) => [[r.branches[i].id, b.notes] as [string, NoteIn[] | undefined], ...(b.children ?? []).map((c: any, k: number) => [r.branches[i].children[k], c.notes] as [string, NoteIn[] | undefined])]))) +
          styleNote([typeof center === 'string' ? center : center.text, ...branches.flatMap((b: any) => [b.text, ...(b.children ?? []).map((c: any) => c.text)])], branches.map((b: any) => b.color)),
        data: { ids: r.ids, center: r.center },
      })),
  },
  {
    name: 'add_chart',
    description:
      'Draw a chart of numbers: column or bar (grouped, or stack "stacked" / "percent" with several series), line, area, pie, donut, scatter, funnel, waterfall. Use it when the content is values to compare or track, not steps or parts. categories = the labels (one per value; for pie, donut and funnel the slice / stage names); series = [{ name, values }] with one value per category (scatter: points [{x,y}] instead); waterfall: values are the changes, a Total bar is added (showTotal false to skip). valueFormat puts the number in a pattern, e.g. "${v}" or "{v}%". highlight = a category (name or index) to stand out, the others fade. annotations = [{ at: category, text }] short remarks pointing at a bar or point. It is drawn as ordinary editable shapes at x,y (default: below everything), width x height default 680x380 (pie, donut 560x380). Example: add_chart({ type: "column", title: "Revenue", categories: ["Q1","Q2","Q3"], series: [{ name: "2025", values: [10, 14, 9] }], valueFormat: "${v}k" }).',
    shape: {
      type: z.enum(CHART_TYPES),
      title: z.string().max(120).optional(),
      categories: z.array(z.string().max(80)).max(200).optional(),
      series: z
        .array(
          z.object({
            name: z.string().max(80).optional(),
            values: z.array(z.number()).max(200).optional(),
            points: z.array(z.object({ x: z.number(), y: z.number() })).max(2000).optional(),
            color: colorEnum.optional(),
          }),
        )
        .min(1)
        .max(12),
      stack: z.enum(['none', 'stacked', 'percent']).optional().describe('Several series in a column, bar or area chart: side by side (none, default), piled up, or as shares of 100%.'),
      valueFormat: z.string().max(40).optional().describe('A pattern with {v}, e.g. "${v}", "{v} kg", "{v}%".'),
      highlight: z.union([z.string(), z.number()]).optional(),
      annotations: z.array(z.object({ at: z.union([z.string(), z.number()]), text: z.string().max(120) })).max(10).optional(),
      showTotal: z.boolean().optional().describe('Waterfall: add the Total bar (default true).'),
      exact: z.boolean().optional().describe('Keep x,y even when it lies over other elements (default: such a position is moved below them).'),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().min(240).max(2000).optional(),
      height: z.number().min(200).max(1500).optional(),
    },
    run: async (o) => {
      const r = await mutate((s) => addChart(s, o), `add_chart ${o.type}`)
      return { text: r.text, data: { ids: r.ids } }
    },
  },
  {
    name: 'add_sticky_notes',
    description:
      'Sticky notes in clusters, for brainstorming or collecting ideas: coloured paper squares in rows, each cluster with an optional title above it. clusters = [{ title, color (yellow, blue, green, pink or orange; default: one per cluster), notes: ["short text", …] }]; notesPerRow (default 3), noteSize (square side, default 160), showDates adds the date under each. Placed at x,y, default below everything. Plain editable boxes, not a diagram of connected boxes: use add_columns for stages and add_graph for flows.',
    shape: {
      clusters: z.array(z.object({ title: z.string().max(80).optional(), color: z.enum(Object.keys(STICKY_COLORS) as [keyof typeof STICKY_COLORS, ...(keyof typeof STICKY_COLORS)[]]).optional(), notes: z.array(z.string().max(300)).min(1).max(60) })).min(1).max(12),
      notesPerRow: z.number().int().min(1).max(8).optional(),
      noteSize: z.number().min(100).max(320).optional(),
      showDates: z.boolean().optional(),
      exact: z.boolean().optional().describe('Keep x,y even when it lies over other elements (default: such a position is moved below them).'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: async (o) => {
      const r = await mutate((s) => addStickyNotes(s, o), 'add_sticky_notes')
      return { text: r.text, data: { ids: r.ids } }
    },
  },
  {
    name: 'add_grid',
    description:
      'Use when things are compared along two dimensions: options x criteria, A vs B, pros / cons, days x plans when only labels (not times) go in the cells. Not for times placed to scale (add_timeline) or plain groups (add_columns). Draws a table of boxes: column headers along the top, row labels down the left, one box per cell; null or "" leaves a cell empty; connect=true draws arrows along each row. Placed below what is already there unless x,y are given. Example: add_grid({ columns: ["Vendor A", "Vendor B"], rows: ["Price", "Support"], cells: [["€10", "€15"], ["email", "24/7"]] })',
    shape: {
      columns: z.array(z.string()).min(1).max(12),
      rows: z.array(z.string()).min(1).max(12),
      cells: z.array(z.array(z.string().nullable())).describe('One array per row, one entry per column.'),
      connect: z.boolean().optional(),
      width: z.number().optional().describe('Cell width (default 220).'),
      color: colorEnum.optional().describe('Colour of the headers and row labels.'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: (g) =>
      mutate((s) => addGrid(s, g), `add_grid ${g.rows.length}x${g.columns.length}`).then((r) => ({
        text: r.text + styleNote([...g.columns, ...g.rows], [g.color]),
        data: { rows: r.ids, headers: r.columns, cells: r.cells },
      })),
  },
  {
    name: 'add_timeline',
    description:
      'Use when the items have times or dates: schedules, agendas, itineraries, roadmaps, project phases, sprints. Not for steps without times (add_graph) or groups without times (add_columns). Draws one row per day / person / team, optionally split into titled lanes for alternatives (Plan A / Plan B) or sub-teams, every item placed on a shared axis by its start and end so its width shows how long it lasts, with ticks along the top. start/end are all clock times ("09:30"), all dates ("2026-11-13") or all numbers (week, sprint); an item without end lasts until the next one in its lane; an item with only a rough time still needs a start (pick one and say so in a note). With clock times the start is written in front of the text automatically; keep the text short and put details in `notes`. Placed below what is already there unless x,y are given. Example: add_timeline({ rows: [{ title: "Mon 12/11", lanes: [{ title: "Plan A", items: [{ start: "09:00", end: "10:30", text: "Museum" }] }] }] })',
    shape: {
      rows: z
        .array(
          z.object({
            title: z.string(),
            items: z.array(timelineItem).max(60).optional().describe('Items of a row that has no lanes.'),
            lanes: z
              .array(z.object({ title: z.string().optional(), items: z.array(timelineItem).max(60), notes: noteList }))
              .max(6)
              .optional()
              .describe('Titled lanes inside the row, each on its own line, e.g. [{ title: "Plan A", items: [...] }, { title: "Plan B", items: [...] }].'),
            color: colorEnum.optional(),
            notes: noteList,
          }),
        )
        .min(1)
        .max(20),
      unitWidth: z.number().optional().describe('Pixels per hour (clock times), per day (dates) or per unit (numbers). Omit to fit.'),
      showTimes: z.boolean().optional().describe('Write the start in front of each item. Default: yes for clock times.'),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    run: ({ rows, unitWidth, showTimes, x, y }) =>
      mutate((s) => {
        const r = addTimeline(s, rows, { unitWidth, showTimes, x, y })
        return { ...r, text: r.text + typeHints(s, 'timeline', { titles: rows.map((row: any) => row.title) }) }
      }, `add_timeline ${rows.length} rows`).then(async (r) => {
        const pairs: [string | undefined, NoteIn[] | undefined][] = []
        rows.forEach((row: any, i: number) => {
          const made = r.rows[i]
          pairs.push([made.id, row.notes])
          const lanes = [...(row.items?.length ? [{ items: row.items }] : []), ...(row.lanes ?? [])]
          lanes.forEach((lane: any, k: number) => {
            pairs.push([made.lanes[k]?.id ?? made.id, lane.notes])
            lane.items.forEach((it: any, j: number) => pairs.push([made.lanes[k]?.ids[j], it.notes]))
          })
        })
        const all = rows.flatMap((row: any) => [...(row.items ?? []), ...(row.lanes ?? []).flatMap((l: any) => l.items)])
        return {
          text: r.text + (await saveNotes(pairs)) + styleNote([...rows.map((row: any) => row.title), ...all.map((i: any) => i.text)], [...rows.map((row: any) => row.color), ...all.map((i: any) => i.color)]),
          data: { ids: r.ids, timeline: r.rows },
        }
      }),
  },
  {
    name: 'fix_layout',
    description:
      'Fix the layout problems check_layout reports, in one call: boxes too small for their text grow, containers grow around what sticks out, overlapping boxes are moved apart (the newer one moves) and arrows are re-routed. With an id: only that box/frame and what is inside it. Returns what it did and the layout check after; whatever is left (usually an arrow crossing a box) needs move_node or auto_layout. Undoable.',
    shape: { id: z.string().optional() },
    run: ({ id }) => mutate((s) => fixLayout(s, id), `fix_layout ${id ?? 'canvas'}`),
  },
  {
    name: 'update_nodes',
    description: 'Change the text, detail, colour, shape and/or style of several elements in one call (same rules as update_node), e.g. an explanation under every box of a diagram at once.',
    shape: { changes: z.array(changeItem).min(1).max(200) },
    run: ({ changes, baseRev }) =>
      mutate((s) => updateMany(s, changes), `update_nodes ${changes.length}`, guard(changes.map((c: any) => c.id), baseRev)).then((r) => r + styleNote(changes.flatMap((c: any) => (c.text ? [c.text] : [])), changes.map((c: any) => c.color))),
  },
  {
    name: 'move_nodes',
    description: 'Move several elements in one call, each to x,y or by dx,dy (each takes its text, contents and arrows along, like move_node). Returns one layout check.',
    shape: { moves: z.array(moveItem).min(1).max(60) },
    run: ({ moves, baseRev }) =>
      mutate((s) => moveMany(s, moves), `move_nodes ${moves.length}`, guard(moves.map((m: any) => m.id), baseRev)),
  },
  {
    name: 'delete_nodes',
    description: 'Delete several elements in one call, each with its text, everything inside it and the arrows attached. Ids that do not exist are reported, not fatal.',
    shape: { ids: z.array(z.string()).min(1).max(200) },
    run: ({ ids, baseRev }) => mutate((s) => deleteNodes(s, ids), `delete_nodes ${ids.length}`, guard(ids, baseRev)),
  },
  {
    name: 'edit_nodes',
    description:
      'Several kinds of change in ONE step (one undo, one layout check, nothing applied if any part fails): delete, then update, then move, then add, in that order. Use it for a rework such as "remove these two boxes, rename that one, shift another and add three new ones"; the single tools stay better for one change. Parts: delete = ids (with their text and arrows); update = the changes of update_nodes; move = the moves of move_nodes; add = the arguments of add_nodes (inside a container, or items with their own x,y).',
    shape: {
      delete: z.array(z.string()).max(200).optional(),
      update: z.array(changeItem).max(200).optional(),
      move: z.array(moveItem).max(60).optional(),
      add: z.object(addShape).optional(),
    },
    run: async ({ delete: del, update, move, add, baseRev }) => {
      if (!del?.length && !update?.length && !move?.length && !add) throw new Error('Give at least one of delete, update, move, add.')
      const r = await mutate((s) => {
        const out: string[] = []
        if (del?.length) out.push(deleteNodes(s, del))
        if (update?.length) out.push(updateMany(s, update, false))
        if (move?.length) out.push(moveMany(s, move, false))
        const added = add ? addMany(s, add) : null
        out.push(added ? added.text : lint(s))
        return { text: out.join('\n'), ids: added && 'ids' in added ? (added.ids as string[]) : [] }
      }, 'edit_nodes', guard([...(del ?? []), ...(update ?? []).map((c: any) => c.id), ...(move ?? []).map((m: any) => m.id)], baseRev))
      const notesLine = add ? await saveNotes(add.items.map((i: any, k: number) => [r.ids[k], i.notes] as [string, NoteIn[] | undefined])) : ''
      return { text: r.text + notesLine, data: { ids: r.ids } }
    },
  },
  {
    name: 'transform_nodes',
    description:
      'Duplicate, scale, flip or rotate elements together with their text and contents (arrows between them follow; free lines that are not in a frame stay). op "duplicate" copies them (dx,dy offset, default 40,40; count copies; the notes are copied too unless withNotes is false) and returns the new ids; "scale" multiplies size and text by factor (0.1 to 10) around the top-left corner; "flip" mirrors them left-right (axis horizontal) or top-bottom (vertical) around their own centre, text keeps reading the same way; "rotate" turns them by degrees around their common centre. Without ids it works on the current selection.',
    shape: {
      ids: z.array(z.string()).max(200).optional().describe('Elements to transform; omit to use the current selection.'),
      op: z.enum(['duplicate', 'scale', 'flip', 'rotate']),
      dx: z.number().optional(),
      dy: z.number().optional(),
      count: z.number().int().min(1).max(20).optional().describe('duplicate: how many copies, each one step further (default 1).'),
      factor: z.number().optional().describe('scale: 0.1 to 10.'),
      axis: z.enum(['horizontal', 'vertical']).optional().describe('flip: horizontal = left-right (default).'),
      degrees: z.number().optional().describe('rotate: clockwise.'),
      withNotes: z.boolean().optional().describe('duplicate: copy the notes of the boxes too (default true).'),
    },
    run: async (a) => {
      const ids: string[] = a.ids?.length ? a.ids : selection().ids
      if (!ids.length) throw new Error('Give ids, or select something on the canvas.')
      const need = (v: unknown, what: string) => (v === undefined ? (() => { throw new Error(`${a.op} needs ${what}`) })() : (v as number))
      const op: Transform =
        a.op === 'duplicate' ? { op: 'duplicate', dx: a.dx, dy: a.dy, count: a.count } : a.op === 'scale' ? { op: 'scale', factor: need(a.factor, 'factor') } : a.op === 'flip' ? { op: 'flip', axis: a.axis ?? 'horizontal' } : { op: 'rotate', degrees: need(a.degrees, 'degrees') }
      const r = await mutate((s) => transformNodes(s, ids, op), `transform_nodes ${a.op}`, guard(ids, a.baseRev))
      const idMap = r.idMap
      if (!idMap || a.withNotes === false) return { text: r.text, data: { ids: r.ids ?? [] } }
      const have = await notes.all()
      const copies = Object.entries(idMap).flatMap(([old, id]) => (have[old] ?? []).map((n) => ({ node: id, text: n.text, kind: n.kind, status: n.status })))
      const n = (await notes.addMany(copies)).length
      return { text: r.text + (n ? `\nCopied ${n} note(s).` : ''), data: { ids: r.ids ?? [] } }
    },
  },
  {
    name: 'clear',
    description: 'Empty the whole open diagram (every box, arrow, text and drawing) to start over. Only when the user asked for a fresh start or a full redraw; the result says how much was removed and undo brings it back. To remove part of it use delete_nodes; to fix a messy layout use fix_layout.',
    shape: {},
    run: () => mutate((s) => clearScene(s), 'clear'),
  },
  {
    name: 'move_node',
    description: 'Move an element (top-left corner to x,y; give only x or only y to keep the other). Its text, anything inside it and the arrows attached to any of those move/re-route with it. Returns a layout check.',
    shape: { id: z.string(), x: z.number().optional(), y: z.number().optional() },
    run: ({ id, x, y, baseRev }) => mutate((s) => withEl(s, id, (el) => moveNode(s, id, x ?? el.x, y ?? el.y)), `move_node ${id}`, guard([id], baseRev)),
  },
  {
    name: 'resize_node',
    description: 'Set a box\'s width and/or height (the one left out stays). Its text is re-wrapped to the new width and re-centred, and attached arrows re-route. Returns a layout check.',
    shape: { id: z.string(), width: z.number().optional(), height: z.number().optional() },
    run: ({ id, width, height, baseRev }) => mutate((s) => withEl(s, id, (el) => resizeNode(s, id, width ?? el.width, height ?? el.height)), `resize_node ${id}`, guard([id], baseRev)),
  },
  {
    name: 'resize_nodes',
    description: 'Resize several boxes in one call (same rules as resize_node; a box without text can be as thin as 1px). Returns one layout check.',
    shape: { sizes: z.array(z.object({ id: z.string(), width: z.number().optional(), height: z.number().optional() })).min(1).max(200) },
    run: ({ sizes, baseRev }) => mutate((s) => resizeNodes(s, sizes), `resize_nodes ${sizes.length}`, guard(sizes.map((z: any) => z.id), baseRev)),
  },
  {
    name: 'auto_layout',
    description: 'Arrange boxes automatically by their arrows (layered graph layout), so nothing has to be placed by hand. With an id: the boxes inside that frame/box (it grows to fit); without: every top-level box on the canvas. direction LR = left to right (default), TB = top to bottom. Arrows are re-routed. Undoable. Call check_layout / screenshot afterwards.',
    shape: { id: z.string().optional(), direction: z.enum(['LR', 'TB']).optional() },
    run: async ({ id, direction }) => {
      const pre = await elkAutoPositions(await readScene(), id, direction)
      return mutate((s) => autoLayout(s, id, direction, pre), `auto_layout ${id ?? 'canvas'}`)
    },
  },
  {
    name: 'connect',
    description: 'Draw an arrow from one element to another, with an optional label. style sets its arrowheads (e.g. none / triangle / dot / crowfoot_many for an ER diagram), arrowType (sharp, curved, elbow), strokeStyle (dashed, dotted), colour and width.',
    shape: { from: z.string(), to: z.string(), label: z.string().optional(), style },
    run: ({ from, to, label, style }) => mutate((s) => connect(s, from, to, label, style), `connect ${from} to ${to}`).then((id) => ({ text: `Added arrow ${id}.`, data: { id } })),
  },
  {
    name: 'delete_node',
    description: 'Delete an element together with its text and any arrows attached to it.',
    shape: { id: z.string() },
    run: ({ id, baseRev }) => mutate((s) => deleteNode(s, id), `delete_node ${id}`, guard([id], baseRev)),
  },
  {
    name: 'export_diagram',
    description:
      'Save this diagram (or only some elements, with their text, contents and the arrows between them) as a file in <diagram folder>/exports/ (kept out of git) and return its path. format "excalidraw" is the scene as an .excalidraw document (opens in excalidraw.com); "png" and "svg" are rendered by the open canvas page, so it must be open in a browser. scale (png only, 1 to 3, default 2); background false = transparent; dark true/false forces the dark/light look (default: the page\'s current theme).',
    shape: {
      format: z.enum(['excalidraw', 'png', 'svg']),
      ids: z.array(z.string()).max(200).optional().describe('Only these elements; omit for the whole diagram.'),
      name: z.string().max(80).optional().describe('File name without extension (default: the date and time).'),
      scale: z.number().min(1).max(3).optional(),
      background: z.boolean().optional(),
      dark: z.boolean().optional(),
    },
    run: async (o) => {
      const { file, bytes } = await exportDiagram(o)
      return `Wrote ${file} (${bytes} bytes).`
    },
  },
  {
    name: 'list_diagrams',
    description: 'The diagrams of this project (each is a separate canvas with its own notes, presentations and history) and which one the canvas tools are working on now.',
    shape: {},
    run: async () => {
      const here = cur().diagramId
      return (await listDiagrams()).map((d) => `${d.id === here ? '* ' : '  '}${d.id}  "${d.name}"`).join('\n') + '\n(* = the diagram the canvas tools work on now)'
    },
  },
  {
    name: 'open_diagram',
    description: 'Switch the canvas tools (and the open browser page) to another diagram of this project, by id or name. Use it when the user asks about or wants changes in a diagram other than the current one; every later canvas call in this prompt works on it.',
    shape: { diagram: z.string().describe('Id or name, from list_diagrams.') },
    run: async ({ diagram }) => {
      const d = await findDiagram(diagram)
      if (!d) throw new Error(`No diagram "${diagram}". ${await diagramsLine()}`)
      openDiagram(d.id)
      return `Now working on "${d.name}" (${d.id}). Its context replaces the one you had:\n\n${contextOf(d.id)}`
    },
  },
  {
    name: 'create_diagram',
    description:
      'Create a new, empty diagram in this project and switch the user\'s page to it. ONLY when the user explicitly asks for a new / separate diagram ("new diagram", "diagramă nouă"). Never for a drawing request ("draw a horse", "add boxes", "make a flow"): draw those in the current diagram, starting with get_selection and get_space.',
    shape: {
      name: z.string().min(1).max(60),
      userRequest: z.string().max(500).describe('The user\'s own words asking for a new/separate diagram, quoted exactly.'),
      about: z.string().max(1000).optional().describe('What the new diagram is for, in one or two sentences from the user\'s request. Saved as its context; the user can edit it in the Context tab.'),
    },
    run: async ({ name, userRequest, about }) => {
      // Smaller models reach for this on any drawing request, which moves the user's page away from what they were
      // working on. The page's Diagrams menu still creates diagrams freely; the tool needs the user to have asked.
      if (!asksForNewDiagram(userRequest ?? ''))
        throw new Error(`Not created: the user did not ask for a new diagram. Draw in the current one. ${await diagramsLine()} Call get_selection, then get_space, then draw there.`)
      const d = await createDiagram(name)
      if (about?.trim()) await inDiagram(d.id, () => setContext({ ...getContext(), diagrams: about.trim() }))
      openDiagram(d.id)
      return `Created "${d.name}" (${d.id}) and switched to it. It is empty: call get_space with no id before drawing. Its context replaces the one you had:\n\n${contextOf(d.id)}`
    },
  },
  {
    name: 'rename_diagram',
    description: 'Rename a diagram (its id and URL stay the same).',
    shape: { diagram: z.string().describe('Id or name, from list_diagrams.'), name: z.string().min(1).max(60) },
    run: async ({ diagram, name }) => {
      const d = await findDiagram(diagram)
      if (!d) throw new Error(`No diagram "${diagram}".`)
      return `Renamed to "${(await renameDiagram(d.id, name)).name}".`
    },
  },
  {
    name: 'undo',
    description: 'Undo the last change made with the canvas tools (every change is saved first). Pass an id from the canvas History list to go back to a specific point. Use it when your last drawing change went wrong.',
    shape: { id: z.string().optional() },
    run: ({ id }) => undo(id),
  },
]

const text = (t: string | Shot | Out) =>
  typeof t === 'string'
    ? { content: [{ type: 'text' as const, text: t }] }
    : 'png' in t
      ? { content: [{ type: 'text' as const, text: t.text }, ...[t.png].flat().map((data) => ({ type: 'image' as const, data, mimeType: 'image/png' }))] }
      : { content: [{ type: 'text' as const, text: t.text }] }
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: String(e instanceof Error ? e.message : e) }], isError: true })
const call = (d: Def) => (args: unknown) => d.run(args).then(text, fail)

/** What every tool but screenshot returns to a structured client: the same text, plus the ids a script needs. */
const outShape = {
  text: z.string().describe('What happened, as a sentence or list.'),
  id: z.string().optional().describe('The new element (add_node) or arrow (connect).'),
  ids: z.array(z.string()).optional().describe('The new boxes, in order (add_nodes), or the new columns (add_columns).'),
  columns: z
    .array(z.object({ id: z.string(), ids: z.array(z.string()), sections: z.array(z.object({ id: z.string(), ids: z.array(z.string()) })).optional() }))
    .optional()
    .describe('Each new column and the items inside it, and its sections with their items (add_columns).'),
  keys: z.record(z.string(), z.string()).optional().describe('Your node key -> new box id (add_graph, draw_mermaid).'),
  groups: z.record(z.string(), z.string()).optional().describe('Group key -> new group box id (add_graph, draw_mermaid).'),
  timeline: z
    .array(z.object({ id: z.string(), lanes: z.array(z.object({ id: z.string().optional(), ids: z.array(z.string()) })) }))
    .optional()
    .describe('Each row label box and its lanes: the lane title box (when titled) and the item ids in the order given (add_timeline).'),
  headers: z.array(z.string()).optional().describe('Column header ids (add_grid).'),
  rows: z.array(z.string()).optional().describe('Row label ids (add_grid).'),
  cells: z.array(z.array(z.string().nullable())).optional().describe('Cell ids per row, null where empty (add_grid).'),
  generated: z.string().optional().describe('The id of the drawing this call made (whole-diagram tools); pass it as replace to redraw it in place.'),
  rev: z.number().optional().describe('Revision of the scene when this call finished; pass it as baseRev to a later change of existing elements.'),
  nodes: z
    .array(z.object({ id: z.string(), type: z.string(), text: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number() }))
    .optional()
    .describe('Every shape and free text (list_nodes).'),
}
const HIDDEN_FROM_SCRIPTS = new Set(['get_animations', 'set_animation', 'export_decisions'])

/** A tool's argument schema, for checking the example gallery's calls (evals/examples.ts). */
export const toolShape = (name: string) => defs.find((d) => d.name === name)?.shape

/** The calls that draw a whole diagram. A structured client's model skips the "ask first" rule in the instructions, so
 *  the call itself refuses once until the user has seen a plan: on an empty diagram (how should it look?) and on one that
 *  already has content (does the new drawing replace it, or go next to it?). */
const WHOLE_DIAGRAM = new Set(['draw_mermaid', 'add_graph', 'add_columns', 'add_grid', 'add_timeline', 'add_tree', 'add_sequence', 'add_cycle', 'add_quadrant', 'add_mindmap', 'add_chart'])
const userChoice = z
  .string()
  .optional()
  .describe('What the user chose after you showed them the plan (how it should look, and where it goes when the diagram is not empty), in words, not just an option number; or how their message already said it should look ("a timeline", "next to the existing one"). Only set it from what the user actually wrote in a message.')
const about = z
  .string()
  .max(1000)
  .optional()
  .describe('Only on the first drawing of an empty diagram: one or two sentences on what it is for, from the user\'s messages (subject, who reads it, conventions such as units or what a colour means). Saved as the diagram\'s About in the Context tab unless the user wrote one; later sessions read it. Not a list of the boxes.')
const PLAN =
  '- Call plan_diagram with the user\'s text first: it ranks the kinds of diagram that fit and says how their content maps onto each. Build the options from its result.\n' +
  '- 2-3 numbered options for how it could look, the one you recommend marked, each with a short sketch in a code block (3-5 lines of text showing the first parts of THEIR content laid out that way), so they can see it before you draw. Pick options that fit the content: items with times or dates -> a timeline to scale (add_timeline); groups or stages -> columns (add_columns); things compared by criteria -> a table (add_grid); steps or parts connected by arrows -> a flow (draw_mermaid / add_graph).\n' +
  '- How much detail goes in the boxes and what goes into notes instead (caveats, costs, links, things to check).\n' +
  '- Anything in their text that needs settling first (duplicates, missing or conflicting values).'
const STOP =
  'Stop drawing now: write your reply to the user with the plan below and end your turn. Do not call this tool again in this turn, with or without userChoice: the answer has to come from the user\'s next message, and an answer you wrote yourself does not count.\n'
const ASK_FIRST = 'NOT DRAWN: the diagram is empty and the user has not seen a plan yet.\n' + STOP + PLAN
const askFirstOnTop = (summary: string) =>
  `NOT DRAWN: the diagram already has content (${summary}) and this call would draw below it.\n` +
  STOP.replace('with the plan below', 'saying what is on the diagram now and asking whether the new drawing replaces it, goes next to it, or should be a separate diagram; if they have not said how it should look, add the plan below') +
  PLAN

/** Set when a refusal asked the user for a plan; the next whole drawing then goes through, and the flag resets once it is drawn. */
const asked = perDiagram(() => ({ done: false }))
/** When plan_diagram last showed options, and in which Claude turn: a drawing in that same turn did not wait for the user. */
const planShown = perDiagram(() => ({ turn: null as string | null, at: 0 }))

/** What the box text should be, by the diagram's detail setting (rubric point 4). */
const boxCheck = () => {
  const { detail, limitWords, maxWords } = getContext().style
  const title = limitWords ? `at most ${maxWords} words per title` : 'short titles'
  if (detail === 'explain') return `Every box of content has a short title and an explanation under it (${title}); examples and sources are in notes.`
  if (detail === 'short') return `${limitWords ? `At most ${maxWords} words per box` : 'Box text is short'}; details are in notes.`
  return `Box text fits the diagram: short (${title}) for schedules, flows and lists; a title with an explanation under it when the diagram explains a topic.`
}

/** The checklist every screenshot ends with, the same in both modes: weak models stop at "Layout OK" or at "looks good". */
const RUBRIC = () =>
  '\nCheck the picture against this list and say in your reply what you found, one line each:' +
  '\n1. Reading order: by time, left to right or top to bottom, the earliest first.' +
  '\n2. Boxes of the same kind have the same size and line up.' +
  '\n3. No arrow runs through a box or along another arrow; labels are readable.' +
  `\n4. ${boxCheck()}` +
  '\n5. Colour only where the legend gives it a meaning.' +
  '\n6. The kind of diagram fits the content (times: timeline; steps: flow; parts that call each other: architecture; groups: columns; criteria: table; hierarchy: tree).' +
  '\n7. What the user asked for is on the canvas, not only in notes.' +
  '\nFix one issue at a time and look again; if a fix made the layout check or the picture worse, undo it. Never call it done when it is not.'
/** Said after every whole drawing to a structured client, whose model tends to stop at "Layout OK". */
const AFTER_DRAW =
  '\nBefore you reply: (1) go through the user\'s text line by line; whatever is not on the canvas (caveats, costs, links, things to check) goes into notes on the box it belongs to (add_note; kind "question" for open points). (2) Call screenshot (or pass screenshot: true on the drawing call) and answer its checklist. (3) In your reply say what you left out, merged or guessed (a time or value you picked). Claim nothing you did not check.'

/** "1", "option 2", "b": a choice that only makes sense next to the question, so it is not saved as the diagram's subject. */
const BARE_CHOICE = /^\s*(option|opțiunea|optiunea|varianta|nr\.?)?\s*([0-9]+|[a-c])[.)]?\s*$/i

/** The top-level boxes of a diagram, briefly: what a model must know about before drawing over or under it. */
type Row = ReturnType<typeof listNodes>[number]
const topLevel = (nodes: Row[]) => nodes.filter((c) => !nodes.some((p) => p !== c && p.x <= c.x && p.y <= c.y && p.x + p.w >= c.x + c.w && p.y + p.h >= c.y + c.h))
function topSummary(scene: Scene) {
  const nodes = listNodes(scene)
  const top = topLevel(nodes)
  return `${nodes.length} element(s); top level: ${top.slice(0, 8).map((n) => `${n.id} "${n.text.slice(0, 40)}"`).join(', ')}${top.length > 8 ? `, … ${top.length - 8} more` : ''}`
}

/** After this many refusals in one turn the drawing goes through, so a model that cannot follow the rule is not stuck. */
const MAX_REFUSALS = 3
const refusals = perDiagram(() => ({ turn: '', n: 0 }))
const SAME_TURN =
  'NOT DRAWN: plan_diagram showed options in this same turn, so the user has not answered yet (a userChoice written in this turn is your guess, not theirs).\n' +
  STOP.replace('with the plan below', 'with the options plan_diagram gave you')

/**
 * Whether a whole-diagram drawing must wait for the user: the refusal text, or null to draw. With Claude Code the hooks
 * report turns, so the rule is exact: on an empty diagram the options must have been shown in an EARLIER turn (or the
 * user's message already said how it should look, recorded as userChoice). Without turns (OpenCode, no hooks) it
 * refuses once, as before. On a diagram with content it asks once per turn where the new drawing goes, unless x,y say it.
 */
async function gate(args: any) {
  if (args?.replace) return null // redrawing what the user already saw and approved
  const scene = await readScene()
  const choice = args?.userChoice?.trim()
  const empty = !listNodes(scene).length
  const placed = args?.x !== undefined || args?.y !== undefined
  // An empty diagram needs a plan unless its context already records a layout; one with content, unless the call says where it goes.
  const needsPlan = empty ? !getContext().layout : !placed
  if (!needsPlan) return null
  const turn = turnId()
  if (!turn) {
    if (choice || asked().done) return (asked().done = false), null
    asked().done = true
    return empty ? ASK_FIRST : askFirstOnTop(topSummary(scene))
  }
  const r = refusals()
  if (r.turn !== turn) Object.assign(r, { turn, n: 0 })
  if (r.n >= MAX_REFUSALS) return null
  const shownNow = planShown().turn === turn
  const shownBefore = !!planShown().turn && !shownNow
  const why = shownNow ? SAME_TURN : !empty ? (choice || r.n ? null : askFirstOnTop(topSummary(scene))) : shownBefore || choice ? null : ASK_FIRST
  if (why) r.n++
  return why
}

const callStructured = (d: Def) => async (args: any) => {
  const whole = WHOLE_DIAGRAM.has(d.name)
  if (whole) {
    const no = await gate(args)
    if (no) return fail(no)
  }
  const after = whole ? AFTER_DRAW : ''
  return d
    .run(args)
    .then((r) => (typeof r === 'string' ? r + after : { ...r, text: r.text + after }))
    .then((r) => ({ ...text(r), structuredContent: typeof r === 'string' ? { text: r } : { text: r.text, ...('data' in r ? r.data : {}) } }), fail)
}
/** A whole-diagram call that draws on an empty diagram also fills in that diagram's context when it has none. */
const LAYOUT: Record<string, Layout> = { draw_mermaid: 'flow', add_graph: 'flow', add_columns: 'columns', add_grid: 'grid', add_timeline: 'timeline', add_tree: 'tree', add_sequence: 'sequence', add_cycle: 'cycle', add_quadrant: 'quadrant', add_mindmap: 'mindmap' }
/** Said after a drawing whose boxes explain a topic, so the answer does not stop at what was drawn. */
const EXPLAINED =
  '\nThis drawing explains a topic. Before you reply: put a concrete example (kind "example") and the sources (kind "source": pages you read in this session or references you are sure of, never a made-up link; search when the facts may have changed) in notes on the boxes they belong to. End your reply with 2-3 concrete offers to go further: a worked example, a comparison with an alternative, a separate diagram for one branch, or more detail inside a box.'

/** The items a call asked to draw inside other boxes (`inside`), and whether any item carries an explanation (`detail`). */
function scanItems(args: unknown) {
  const inner: any[] = []
  let detail = false
  const walk = (v: any): void => {
    if (Array.isArray(v)) return v.forEach(walk)
    if (!v || typeof v !== 'object') return
    if (typeof v.detail === 'string' && v.detail.trim()) detail = true
    if (Array.isArray(v.inside)) inner.push(...v.inside)
    for (const [k, x] of Object.entries(v)) if (k !== 'notes' && k !== 'style') walk(x)
  }
  walk(args)
  return { inner, detail }
}

/** The boxes drawn inside other boxes are listed with their ids and get their notes, which the tools' own results do not
 *  cover; a drawing that explains a topic is reminded of examples, sources and what to offer next. */
const withInside = (d: Def): Def['run'] => async (args: any) => {
  const r = await d.run(args)
  const { inner, detail } = scanItems(args)
  const drawn = inner.flatMap((c) => {
    const m = drawnInside.get(c)
    return m ? [{ c, ...m }] : []
  })
  if (!drawn.length && !detail) return r
  const extra =
    (drawn.length ? `\nBoxes inside other boxes: ${drawn.map((x) => `${x.id} "${String(x.c.text).slice(0, 30)}" in ${x.parent}`).join(', ')}.` : '') +
    (await saveNotes(drawn.map((x) => [x.id, x.c.notes] as [string, NoteIn[] | undefined]))) +
    (detail ? EXPLAINED : '')
  if (typeof r === 'string') return r + extra
  return 'png' in r ? r : { ...r, text: r.text + extra }
}
const ITEM_TOOLS = new Set([...WHOLE_DIAGRAM, 'add_node', 'add_nodes', 'update_node', 'update_nodes'])

/** The Context tab as it is now. The instructions Claude read when its session started can be older than the last edit
 *  (a diagram made in the same session, a legend added afterwards), so every whole-diagram result restates the parts
 *  Claude has to act on: the user's standing rules, and the colour legend with how many boxes already use it. */
const contextNote = async () => {
  const { rules, style } = getContext()
  const lines: string[] = []
  if (rules.trim()) lines.push(`The user's standing rules (Context tab, current): ${rules.trim().slice(0, 500)}`)
  if (style.legend.length) {
    const stroke = new Set(style.legend.map((l) => PALETTE[l.color]?.[0]))
    const used = (await readScene()).elements.filter((e) => !e.isDeleted && stroke.has(e.strokeColor)).length
    lines.push(
      `Colour legend (Context tab, current): ${style.legend.map((l) => `${l.color} = ${l.meaning || '(unnamed)'}`).join('; ')}. ${used ? `${used} element(s) already use a legend colour.` : 'No box uses a legend colour yet.'} Colour each box that a legend entry describes (update_nodes with color), leave the others uncoloured, and say which ones you coloured.`,
    )
  }
  return lines.length ? `\n${lines.join('\n')}` : ''
}

const learning = (d: Def): Def['run'] => async (args: any) => {
  const empty = !listNodes(await readScene()).length
  const r = await d.run(args)
  const add = (note: string) => (typeof r === 'string' ? r + note : { ...r, text: r.text + note })
  const fresh = await contextNote()
  if (!empty) return add(fresh)
  // That plan is used up: a later redraw of an emptied diagram needs a new one.
  planShown().turn = null
  const choice = BARE_CHOICE.test(args?.userChoice ?? '') ? undefined : args?.userChoice
  const note = await learnFromFirstDrawing(args?.about, choice, LAYOUT[d.name], listNodes(await readScene()).map((n) => n.text), scanItems(args).detail)
  return add(note + fresh)
}
/** Claude Code's handler for a whole-diagram tool: the same gate, plain text results. */
const callGated = (d: Def) => async (args: any) => {
  const no = await gate(args)
  return no ? fail(no) : call(d)(args)
}
const callLooking = (d: Def) => (args: unknown) => d.run(args).then(text, fail)

/**
 * Argument names smaller models guess instead of the real ones, per tool (alias -> real name), and item lists given as
 * plain strings. Applied to a tools/call request before the arguments are checked, so the call works instead of failing
 * on a "Missing key". Only fills a real name that is absent; anything else is left for the schema to judge.
 */
const ALIASES: Record<string, Record<string, string>> = {
  add_nodes: { nodes: 'items', boxes: 'items', children: 'items', groupId: 'containerId', parentId: 'containerId', container: 'containerId', frameId: 'containerId', id: 'containerId', parent: 'containerId' },
  add_node: { label: 'text', name: 'text', title: 'text' },
  connect: { source: 'from', target: 'to', fromId: 'from', toId: 'to' },
  move_node: { left: 'x', top: 'y' },
  resize_node: { w: 'width', h: 'height' },
}
const TITLE = { text: 'title', name: 'title', label: 'title' }
const KIDS = { nodes: 'items', children: 'items', activities: 'items' }
const COLUMN_ALIASES = { ...TITLE, ...KIDS, header: 'title', plans: 'sections', groups: 'sections' }
const SECTION_ALIASES = { ...TITLE, ...KIDS }

const rename = (o: any, map: Record<string, string>) => {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return o
  const r = { ...o }
  for (const [from, to] of Object.entries(map)) if (r[to] === undefined && r[from] !== undefined) ((r[to] = r[from]), delete r[from])
  return r
}
const items = (list: unknown) => (Array.isArray(list) ? list.map((i) => (typeof i === 'string' ? { text: i } : rename(i, { label: 'text', name: 'text', title: 'text' }))) : list)

function normalizeArgs(name: string, args: any) {
  if (!args || typeof args !== 'object') return args
  const a = ALIASES[name] ? rename(args, ALIASES[name]) : { ...args }
  if (name === 'add_nodes') a.items = items(a.items)
  if (name === 'add_columns' && Array.isArray(a.columns))
    a.columns = a.columns.map((c: any) => {
      const col = rename(c, COLUMN_ALIASES)
      return { ...col, items: col.items === undefined ? undefined : items(col.items), sections: Array.isArray(col.sections) ? col.sections.map((x: any) => ((x = rename(x, SECTION_ALIASES)), { ...x, items: items(x.items ?? []) })) : col.sections }
    })
  return a
}

/** Rewrites guessed argument names in an MCP request body (one message or a batch) before it reaches the server. */
export function normalizeCall(body: any): any {
  if (Array.isArray(body)) return body.map(normalizeCall)
  if (body?.method !== 'tools/call' || !body.params?.name) return body
  return { ...body, params: { ...body.params, arguments: normalizeArgs(body.params.name, body.params.arguments) } }
}

/** Groups of tools a client can ask for (`?toolsets=read,draw` or the X-MCP-Toolsets header); without it every tool is served.
 *  Fewer tools means fewer schemas to read at every step. */
const TOOLSETS: Record<string, string[]> = {
  read: ['list_nodes', 'find_nodes', 'get_node', 'get_space', 'check_layout', 'screenshot', 'get_context', 'get_selection', 'get_notes', 'list_diagrams', 'plan_diagram', 'read_guide', 'get_generated'],
  draw: ['draw_mermaid', 'add_graph', 'add_columns', 'add_grid', 'add_timeline', 'add_tree', 'add_sequence', 'add_cycle', 'add_quadrant', 'add_mindmap', 'add_chart', 'add_sticky_notes', 'add_node', 'add_nodes', 'add_shapes', 'connect'],
  edit: ['update_node', 'update_nodes', 'move_node', 'move_nodes', 'resize_node', 'resize_nodes', 'delete_node', 'delete_nodes', 'clear', 'arrange', 'fix_layout', 'auto_layout', 'undo', 'edit_nodes', 'transform_nodes', 'delete_generated'],
  notes: ['add_note', 'update_note', 'delete_note', 'export_decisions'],
  diagrams: ['open_diagram', 'create_diagram', 'rename_diagram', 'export_diagram'],
  present: ['get_animations', 'set_animation'],
}
export const TOOLSET_NAMES = Object.keys(TOOLSETS)
/** Tool names in no group (a new tool must be added to one); used by the check at start-up. */
export const ungrouped = () => defs.map((d) => d.name).filter((n) => !Object.values(TOOLSETS).some((g) => g.includes(n)))

/** Calls that can return a picture of what they drew or changed (`screenshot: true`). */
const SHOT_TOOLS = new Set([...WHOLE_DIAGRAM, 'add_sticky_notes', 'add_node', 'add_nodes', 'add_shapes', 'arrange', 'fix_layout', 'auto_layout', 'move_nodes', 'update_nodes', 'edit_nodes', 'transform_nodes'])
const screenshotFlag = z
  .boolean()
  .optional()
  .describe('Also return a picture of what this call drew or changed (needs the canvas page open in a browser), so no separate screenshot call is needed. The result then ends with the checklist to answer.')
const replaceArg = z
  .string()
  .optional()
  .describe('The id of an earlier drawing made with this same tool (get_generated lists them): it is removed and this call draws the new spec in its place, at the same position, and the notes of boxes whose text did not change move over. Send the full new arguments (get_generated shows the old ones). Use it to change a drawing instead of clear + redraw.')
const SHOT_WAIT = 'Screenshot skipped'

/** `screenshot: true`: after the call, a picture of the new top-level boxes (up to 12), else of the whole diagram. A failed
 *  screenshot (page closed) never fails the call: the scene is already saved, so the result just says so. */
const withShot = (d: Def): Def['run'] => async (args: any) => {
  if (!args?.screenshot) return d.run(args)
  const before = new Set(listNodes(await readScene()).map((n) => n.id))
  const r = await d.run(args)
  const plus = (extra: string) => (typeof r === 'string' ? r + extra : { ...r, text: r.text + extra })
  try {
    const made = topLevel(listNodes(await readScene()).filter((n) => !before.has(n.id)))
    const shot = made.length && made.length <= 12 ? await shoot(made.map((n) => n.id), true) : await shoot([], false)
    const done = plus(`\n${shot.text}`)
    return { ...(typeof done === 'string' ? { text: done } : done), png: shot.png }
  } catch (e) {
    return plus(`\n${SHOT_WAIT}: ${e instanceof Error ? e.message : e}`)
  }
}

/** Whole-diagram calls are remembered (what they drew, and the call itself) so get_generated can show the spec and `replace`
 *  can draw an edited one in place of the old drawing, keeping its position and the notes of boxes whose text did not change. */
const withGenerated = (d: Def): Def['run'] => async (args: any) => {
  const replace: string | undefined = args?.replace
  let callArgs = args
  let kept = 0
  let lost = 0
  const report: string[] = []
  const oldRows = new Map<string, string>()
  let corner: { x: number; y: number } | null = null
  if (replace) {
    const g = await generated.get(replace)
    if (!g) throw new Error(`No generated drawing ${replace}; get_generated lists them.`)
    if (g.tool !== d.name) throw new Error(`${replace} was drawn with ${g.tool}: call ${g.tool} with replace "${replace}".`)
    const scene = await readScene()
    const alive = g.ids.filter((id) => find(scene, id))
    if (!alive.length) throw new Error(`Nothing of ${replace} is left on the canvas; draw it as a new one (without replace).`)
    const els = alive.map((id) => find(scene, id)!)
    const gone = contentsOf(scene, alive)
    const extra = [...gone].filter((id) => !g.ids.includes(id)).map((id) => find(scene, id)!).filter((e) => !e.containerId && e.type !== 'arrow')
    const cut = scene.elements.filter((e) => !e.isDeleted && e.type === 'arrow' && !g.ids.includes(e.id) && (gone.has(e.startBinding?.elementId) || gone.has(e.endBinding?.elementId)))
    if (extra.length) report.push(`Also removed (they lay inside it, not drawn by ${replace}): ${extra.map((e) => `${e.id} "${plainText(scene, e)}"`).join(', ')}.`)
    if (cut.length) report.push(`Arrows from other boxes into it were removed: ${cut.map((a) => a.id).join(', ')}.`)
    for (const n of listNodes(scene)) oldRows.set(n.id, n.text)
    corner = { x: args.x ?? Math.min(...els.map((e) => e.x)), y: args.y ?? Math.min(...els.map((e) => e.y)) }
    callArgs = { ...args, x: corner.x, y: corner.y }
    await mutate((s) => deleteNodes(s, alive), `replace ${replace}`)
  }
  const before = new Set((await readScene()).elements.filter((e) => !e.isDeleted).map((e) => e.id))
  const r = await d.run(callArgs)
  let scene = await readScene()
  const made = scene.elements.filter((e) => !e.isDeleted && !before.has(e.id)).map((e) => e.id)
  if (corner && made.length) {
    // A drawing may start a little inside the x,y it was given (a chart's margins): put its top-left corner where the old one's was.
    const fresh = scene.elements.filter((e) => made.includes(e.id))
    const dx = corner.x - Math.min(...fresh.map((e) => e.x))
    const dy = corner.y - Math.min(...fresh.map((e) => e.y))
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      await mutate((s) => shiftElements(s, made, dx, dy), `replace ${replace} position`)
      scene = await readScene()
    }
  }
  if (replace) {
    const fresh = listNodes(scene).filter((n) => !before.has(n.id))
    const have = await notes.all()
    for (const [old, text] of oldRows) {
      if (!have[old]?.length) continue
      const same = fresh.filter((n) => n.text === text)
      if (same.length === 1) kept += await notes.move(old, same[0].id)
      else lost += have[old].length
    }
    if (kept || lost) report.push(`Notes moved to the redrawn boxes: ${kept}.${lost ? ` ${lost} note(s) stay on boxes that were removed or whose text changed (get_notes shows them).` : ''}`)
  }
  const key = await generated.record({ tool: d.name, args: specOf(args ?? {}), ids: made, turn: currentTurn()?.id }, replace)
  const extra = `\n${key ? `Generated ${key}${replace ? ' (replaced in place)' : ''}: pass replace "${key}" to change it later.` : 'Too big to remember, so replace is not available for it.'}${report.length ? `\n${report.join('\n')}` : ''}`
  if (typeof r === 'string') return { text: r + extra, data: key ? { generated: key } : {} }
  return { ...r, text: r.text + extra, data: { ...(('data' in r && r.data) || {}), ...(key ? { generated: key } : {}) } } as Out | Shot
}

/** Calls whose result ends with the scene's revision: what reads and writes of the canvas tell the caller, to pass back as baseRev. */
const REV_TOOLS = new Set(['list_nodes', 'find_nodes', 'get_node', 'get_selection', ...TOOLSETS.draw, ...TOOLSETS.edit])
const withRev = (d: Def): Def['run'] => async (args: any) => {
  const r = await d.run(args)
  const rev = revision()
  const tag = `\nrev ${rev}`
  if (typeof r === 'string') return { text: r + tag, data: { rev } }
  return { ...r, text: r.text + tag, data: { ...(r.data ?? {}), rev } } as Out | Shot
}

/** Tool hints for the client (MCP spec). Unset, a client must assume a tool can destroy data and reach the open world,
 *  so every tool says what it does: reads are auto-approvable, only deletes and undo are flagged destructive. */
const READ_ONLY = new Set(['list_nodes', 'find_nodes', 'get_node', 'get_space', 'check_layout', 'screenshot', 'get_context', 'get_selection', 'get_notes', 'get_animations', 'list_diagrams', 'plan_diagram', 'read_guide', 'get_generated'])
const DESTRUCTIVE = new Set(['clear', 'delete_node', 'delete_nodes', 'undo', 'delete_note', 'edit_nodes', 'delete_generated'])
const OPEN_WORLD = new Set(['add_shapes']) // fetches images and embeds from URLs
const annotationsOf = (name: string) =>
  READ_ONLY.has(name)
    ? { readOnlyHint: true, openWorldHint: false }
    : { readOnlyHint: false, destructiveHint: DESTRUCTIVE.has(name), openWorldHint: OPEN_WORLD.has(name) }

/** MCP over HTTP for the Claude Code in the side panel (and the extension / CLI). The context file rides along as the server's instructions.
 *  `structured` (OpenCode, which calls tools from scripts) adds an output schema, so a script gets { text, id, ids, nodes }
 *  instead of a bare string it cannot take ids from. Claude Code keeps the plain text results. */
export async function httpServer({ structured = false, toolsets }: { structured?: boolean; toolsets?: string[] } = {}) {
  const wanted = (toolsets ?? []).map((n) => n.trim().toLowerCase()).filter(Boolean)
  const all = !wanted.length || wanted.includes('all')
  const groups = wanted.filter((n) => n in TOOLSETS)
  const allowed = all ? null : new Set(groups.flatMap((n) => TOOLSETS[n]))
  const unknown = all ? [] : wanted.filter((n) => !(n in TOOLSETS))
  const only = allowed ? `\n\nThis connection serves only these tool groups: ${groups.join(', ') || '(none)'}.${unknown.length ? ` Unknown: ${unknown.join(', ')} (groups: ${TOOLSET_NAMES.join(', ')}).` : ''} Tell the user if you need a tool from another group.` : ''
  const scripts = structured
    ? structuredInstructions()
    : ''
  const s = new McpServer({ name: 'canvas', version: '1.0.0' }, { instructions: `${CANVAS_RULES}\n\n${renderContext()}\n\n# Diagrams\nThis project can hold several diagrams; the canvas tools work on the one open in the browser. ${await diagramsLine()} Draw in this diagram. The style and subject above belong to it; every diagram has its own, and open_diagram / create_diagram return the new one's (get_context re-reads it). Use create_diagram only when the user explicitly asks for a new/separate diagram, never just because they ask you to draw something.${scripts}${only}` })
  for (const def of defs) {
    if (allowed && !allowed.has(def.name)) continue
    // Every tool's description is read at every step; these never help a script draw.
    if (structured && HIDDEN_FROM_SCRIPTS.has(def.name)) continue
    const own = ITEM_TOOLS.has(def.name) ? { ...def, run: withInside(def) } : def
    const learnt = WHOLE_DIAGRAM.has(def.name) ? { ...own, run: learning(own) } : own
    const gen = WHOLE_DIAGRAM.has(def.name) ? { ...learnt, run: withGenerated(learnt) } : learnt
    const shot = SHOT_TOOLS.has(def.name) ? { ...gen, run: withShot(gen) } : gen
    const d = REV_TOOLS.has(def.name) ? { ...shot, run: withRev(shot) } : shot
    const out = structured && d.name !== 'screenshot'
    const shape = { ...d.shape, ...(WHOLE_DIAGRAM.has(d.name) ? { userChoice, about, replace: replaceArg } : {}), ...(SHOT_TOOLS.has(d.name) ? { screenshot: screenshotFlag } : {}), ...(GUARDED.has(d.name) ? { baseRev } : {}) }
    const handler = out ? callStructured(d) : structured ? callLooking(d) : WHOLE_DIAGRAM.has(d.name) ? callGated(d) : call(d)
    s.registerTool(d.name, { description: d.description, inputSchema: shape, annotations: annotationsOf(d.name), ...(out ? { outputSchema: outShape } : {}) }, handler as never)
  }
  return s
}
