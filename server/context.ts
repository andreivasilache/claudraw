import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cur, perDiagram, perProject, type Project } from './project.ts'
import { COLORS } from './palette.ts'
import { FORMAT } from './migrate.ts'
import { writeJson } from './store.ts'

// The user's context, edited in the Context tab. Per diagram: how it should look (applied by the drawing tools and told
// to Claude) and what it is about (main: .canvas/context.json, others: .canvas/diagrams/<id>/context.json).
// Per project: the rules for how Claude works with the user (.canvas/rules.json).

export const SPACING = ['compact', 'normal', 'spacious'] as const
export const TEXT_SIZES = ['small', 'medium', 'large'] as const
export const CORNERS = ['rounded', 'sharp'] as const
export const LOOKS = ['sketchy', 'clean'] as const
export const ARROWS = ['sharp', 'curved', 'elbow'] as const
export const FONTS = ['match', 'hand', 'clean', 'code'] as const
/** How column, group and header boxes stand apart from the boxes inside them. */
export const CONTAINERS = ['fill', 'plain'] as const
/** How much a box says: `short` a title only, `explain` a title with a sentence or two under it, `auto` the second for
 *  diagrams that explain a topic and the first for schedules, flows and lists. */
export const DETAILS = ['auto', 'short', 'explain'] as const

export const LAYOUTS = ['timeline', 'columns', 'grid', 'flow', 'tree', 'sequence', 'cycle', 'quadrant', 'mindmap'] as const
export type Layout = (typeof LAYOUTS)[number]

export type Style = {
  /** What each colour means; Claude colours only what is named here. */
  legend: { color: string; meaning: string }[]
  spacing: (typeof SPACING)[number]
  textSize: (typeof TEXT_SIZES)[number]
  corners: (typeof CORNERS)[number]
  look: (typeof LOOKS)[number]
  /** Arrow type, as in Excalidraw's Arrow type picker. */
  arrows: (typeof ARROWS)[number]
  /** `match` copies the font already used on the canvas. */
  font: (typeof FONTS)[number]
  /** `fill`: containers and headers get a light neutral background, no outline and a larger title; `plain`: drawn like any box. */
  containers: (typeof CONTAINERS)[number]
  detail: (typeof DETAILS)[number]
  /** Off by default: when on, box text is held to `maxWords` words. */
  limitWords: boolean
  maxWords: number
}
export type Context = {
  /** How Claude should work with the user; shared by every diagram of the project (.canvas/rules.json). */
  rules: string
  style: Style
  /** About this diagram: what it is for, who reads it, its terms and conventions. */
  diagrams: string
  /** How the first drawing was laid out; once set, a new drawing on the empty diagram does not ask how it should look. */
  layout?: Layout
}

export const MAX_TEXT = 8000

const defaults = (): Context => ({
  rules: '',
  style: { legend: [], spacing: 'normal', textSize: 'medium', corners: 'rounded', look: 'sketchy', arrows: 'elbow', font: 'match', containers: 'fill', detail: 'auto', limitWords: false, maxWords: 6 },
  diagrams: '',
})

const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => list.find((x) => x === v) ?? fallback
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

/** Older contexts had a separate "What this diagram will contain" field: fold it into About, dropping the text that
 *  learnFromFirstDrawing used to generate (a box count and a list of box titles), which said nothing the canvas does not. */
const GENERATED = /^(Started as a drawing of \d+ boxes\.|First drawn: [\s\S]*)$/
function about(raw: any) {
  const kept = (v: unknown) => (typeof v === 'string' && !GENERATED.test(v.trim()) ? v : '')
  const own = kept(raw?.diagrams)
  const old = kept(raw?.content).trim()
  return (old ? [own.trim(), old].filter(Boolean).join('\n\n') : own).slice(0, MAX_TEXT)
}

/** Anything in, a valid Context out: unknown values fall back to the defaults. */
export function sanitize(raw: any): Context {
  const d = defaults()
  const s = raw?.style ?? {}
  const words = Math.round(Number(s.maxWords))
  return {
    rules: text(raw?.rules, MAX_TEXT),
    style: {
      legend: (Array.isArray(s.legend) ? s.legend : [])
        .filter((l: any) => COLORS.includes(l?.color))
        .slice(0, COLORS.length)
        .map((l: any) => ({ color: l.color as string, meaning: text(l.meaning, 120) })),
      spacing: pick(SPACING, s.spacing, d.style.spacing),
      textSize: pick(TEXT_SIZES, s.textSize, d.style.textSize),
      corners: pick(CORNERS, s.corners, d.style.corners),
      containers: pick(CONTAINERS, s.containers, d.style.containers),
      look: pick(LOOKS, s.look, d.style.look),
      arrows: pick(ARROWS, s.arrows, d.style.arrows),
      font: pick(FONTS, s.font, d.style.font),
      detail: pick(DETAILS, s.detail, d.style.detail),
      limitWords: s.limitWords === true,
      maxWords: words >= 1 && words <= 30 ? words : d.style.maxWords,
    },
    diagrams: about(raw),
    ...(LAYOUTS.includes(raw?.layout) ? { layout: raw.layout as Layout } : {}),
  }
}

function readFile(file: string): unknown {
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.warn(`${file} is invalid, using defaults: ${e}`)
    return {}
  }
}

/** A diagram's own context. One that has none yet starts from main's look, without main's legend or subject:
 *  those mean something only for the diagram they were written for. */
function load(p: Project): Diagram {
  const own = readFile(p.contextFile)
  if (own !== undefined) return sanitize(own)
  const main = sanitize(readFile(join(p.dir, 'context.json')) ?? {})
  return { ...defaults(), style: { ...main.style, legend: [] } }
}

type Diagram = Omit<Context, 'rules'>
const state = perDiagram((p) => ({ current: load(p) }))
const shared = perProject((p) => ({ rules: sanitize(readFile(p.rulesFile)).rules }))
const context = (): Context => ({ ...state().current, rules: shared().rules })
export const getContext = context

/** Saves the rules for the whole project and the rest for the current diagram. */
export async function setContext(raw: unknown) {
  const { rules, ...diagram } = sanitize(raw)
  state().current = diagram
  await writeJson(cur().contextFile, { version: FORMAT, ...diagram })
  if (rules !== shared().rules) {
    shared().rules = rules
    await writeJson(cur().rulesFile, { version: FORMAT, rules })
  }
  return context()
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length

/** The first drawing on an empty diagram that has no subject yet fills in its context, so the next session knows what
 *  the diagram is: what Claude says it is for and the user's layout choice (or else the kind of layout and its first box)
 *  as its subject, and a word limit that fits
 *  what was drawn (a 6-word limit made for architecture boxes would flag every itinerary entry). Never overwrites a subject
 *  the user wrote. A first drawing whose boxes explain themselves (`explained`) sets the box detail from auto to explain, so
 *  later boxes on it explain too. Returns a line for the tool result, or ''. */
export async function learnFromFirstDrawing(purpose: string | undefined, choice: string | undefined, layout: Layout | undefined, texts: string[], explained = false) {
  const c = context()
  if (!texts.length) return ''
  const detail = explained && c.style.detail === 'auto' ? ('explain' as const) : c.style.detail
  const detailLine = detail !== c.style.detail ? 'box detail auto → explain (a title with an explanation under it)' : ''
  if (c.diagrams.trim()) {
    // A subject the user wrote stays as it is; only the layout (and how much the boxes say) is recorded.
    if ((layout && !c.layout) || detailLine) await setContext({ ...c, ...(layout && !c.layout ? { layout } : {}), style: { ...c.style, detail } })
    return detailLine ? `\nSaved this diagram's context (Context tab): ${detailLine}.` : ''
  }
  const longest = Math.max(...texts.map(words))
  const maxWords = c.style.limitWords ? Math.min(30, Math.max(c.style.maxWords, longest)) : c.style.maxWords
  const first = texts.map((t) => t.replace(/\s+/g, ' ').trim()).find(Boolean)
  // The box titles are on the canvas already; only what it does not say is worth keeping.
  const parts = [purpose?.trim(), choice?.trim() && `Layout chosen by the user: ${choice.trim()}`].filter(Boolean)
  const diagrams = parts.length ? parts.join('\n\n') : layout && first ? `A ${layout} diagram, starting with "${first.slice(0, 120)}".` : ''
  const next: Context = { ...c, ...(layout ? { layout } : {}), style: { ...c.style, maxWords, detail }, diagrams }
  await setContext(next)
  const limit = [maxWords !== c.style.maxWords && `max words per box ${c.style.maxWords} → ${maxWords}`, detailLine].filter(Boolean).join(', ')
  if (!diagrams) return limit ? `\nSaved this diagram's context (Context tab): ${limit}.` : ''
  return `\nSaved this diagram's context (Context tab): about = "${diagrams}"${limit && `, ${limit}`}. Tell the user they can edit it there (what it is for, who reads it).`
}

/** Numbers the drawing code uses, derived from the style. Read at call time, so a change applies to the next drawing. */
export function styleValues() {
  const s = context().style
  const spacing = { compact: { gap: 12, pad: 16 }, normal: { gap: 24, pad: 24 }, spacious: { gap: 40, pad: 32 } }[s.spacing]
  return {
    ...spacing,
    fontSize: { small: 16, medium: 20, large: 24 }[s.textSize],
    fontFamily: { match: undefined, hand: 5, clean: 6, code: 3 }[s.font],
    roughness: s.look === 'sketchy' ? 1 : 0,
    rounded: s.corners === 'rounded',
    containers: s.containers,
    maxWords: s.limitWords ? s.maxWords : Infinity,
    detail: s.detail,
    legend: s.legend.map((l) => l.color),
    arrows: s.arrows,
  }
}

const EXPLAIN =
  'a short title (`text`) and, in `detail`, one or two sentences that explain it (what it is, why it matters or how it works). When a box has parts, steps or kinds, draw them as boxes inside it (`inside`). Notes hold a concrete example and the sources (links you checked) of the main boxes'

/** What goes in a box, by the diagram's detail setting and word limit. */
function boxRule(s: Style) {
  const words = s.limitWords ? ` (the title at most ${s.maxWords} words)` : ''
  if (s.detail === 'explain') return `- Box content: ${EXPLAIN}${words}.`
  if (s.detail === 'short') return s.limitWords ? `- Box text: at most ${s.maxWords} words; put detail in notes.` : '- Box text: keep it short; put detail in notes.'
  return `- Box content: for schedules, flows and lists of the user's own items keep the text short and put detail in notes. When the diagram explains a topic (what something is, how it works, an overview, research), give each box ${EXPLAIN}${words}.`
}

/** The context as Claude should read it (MCP instructions and get_context). */
export function renderContext(): string {
  const { rules, style: s, diagrams } = context()
  const style = [
    s.legend.length
      ? `- Colour legend: ${s.legend.map((l) => `${l.color} = ${l.meaning || '(unnamed)'}`).join('; ')}. Colour only what the legend names; leave everything else uncoloured.`
      : '- No colour legend: leave boxes uncoloured unless asked.',
    boxRule(s),
    `- Look: ${s.look}, ${s.corners} corners, ${s.arrows} arrows, ${s.textSize} text, ${s.spacing} spacing${s.font === 'match' ? '' : `, ${s.font} font`}. The drawing tools apply these to new boxes; do not work around them.`,
  ]
  return [
    "# Context from the user (set in the canvas Context tab; it overrides your defaults)",
    rules.trim() && `## How to work with me (every diagram)\n${rules.trim()}`,
    `## This diagram's style\n${style.join('\n')}`,
    diagrams.trim() ? `## About this diagram\n${diagrams.trim()}` : '## About this diagram\nNot set yet: take what it is about from the user\'s request, not from other diagrams.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Reminders appended to a drawing tool's result when the new text or colours break the user's style. */
export function styleNote(texts: string[], colors: (string | undefined)[]) {
  const { legend, maxWords, limitWords } = context().style
  const notes: string[] = []
  const long = limitWords ? texts.filter((t) => t.trim().split(/\s+/).length > maxWords).length : 0
  if (long) notes.push(`${long} box text${long > 1 ? 's' : ''} longer than the ${maxWords}-word limit: shorten ${long > 1 ? 'them' : 'it'} with update_node.`)
  const stray = [...new Set(colors.filter((c): c is string => !!c && legend.length > 0 && !legend.some((l) => l.color === c)))]
  if (stray.length) notes.push(`Colour ${stray.join(', ')} is not in the legend: use only ${legend.map((l) => l.color).join(', ')}.`)
  return notes.length ? `\nStyle: ${notes.join(' ')}` : ''
}
