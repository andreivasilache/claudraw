// Which kind of diagram fits a text: rules over counted signals (times, arrows, components, criteria, …), in English and
// Romanian. Pure, so evals/run.ts can score it without a server. Prompts alone left the choice to the model, which drew a
// six-day itinerary as a tree; the scores here give it a reason it can show the user.

export type DiagramType = 'timeline' | 'flow' | 'architecture' | 'columns' | 'grid' | 'tree' | 'mindmap' | 'sequence' | 'cycle' | 'quadrant'
export type Option = {
  type: DiagramType
  tool: string
  score: number
  why: string
  shape: string
  example: string
}

// Letters around a word, since \b does not know "ă" or "ț".
const w = (alts: string) => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, 'giu')
const count = (re: RegExp, t: string) => (t.match(re) ?? []).length
/** 0 for none, close to 1 well past k: many signals count more, but never without limit. */
const sat = (x: number, k: number) => (x <= 0 ? 0 : 1 - Math.exp(-x / k))

const TIME = /(?<!\d)([01]?\d|2[0-3])[:.h][0-5]\d(?!\d)/g
const DATE = /\b\d{4}-\d{2}-\d{2}\b|(?<![\d:])\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?(?![\d:])/g
const MONTH = w('january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|jun|jul|aug|sep|sept|oct|nov|dec|ianuarie|februarie|martie|aprilie|iunie|iulie|septembrie|octombrie|noiembrie|decembrie|ian|iun|iul|noi')
const WEEKDAY = w('monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sun|luni|marți|marti|miercuri|joi|vineri|sâmbătă|sambata|sâmbata|duminică|duminica')
const DAY_N = w('day \\d+|ziua \\d+|week \\d+|săptămâna \\d+|saptamana \\d+')
const PERIOD = w('week|weeks|săptămână|săptămâni|saptamana|sprint|sprints|q[1-4]|quarter|trimestru|month|months|lună|year|years|phase \\d+|faza \\d+|milestone|deadline|termen')
const DURATION = /\d+(?:[,.]\d+)?\s*(?:h|ore|oră|ora|hours?|min|minute|minutes|zile|days)(?!\p{L})/giu
const ALT = /^\s*[-*•]?\s*(?:plan [a-c]|option \w|opțiunea|optiunea|varianta|alternativ\p{L}*|or |sau )/gimu
// "Workshop A or Workshop B", "Plan A sau Plan B" inside a line: two alternatives named in one breath.
const ALT_PAIR = /(?<!\p{L})\p{L}+ [A-C1-3] (?:or|sau|vs\.?) \p{L}+ [A-C1-3](?!\p{L})/giu
const ARROW = /->|→|=>|-->/g
const NUMBERED = /^\s*\d+[.)]\s+\S/gm
const THEN = w('then|next|after that|afterwards|finally|apoi|după aceea|dupa aceea|urmează|urmeaza|la final|în final')
const DECISION = w('if|else|otherwise|whether|unless|dacă|daca|altfel|în caz contrar|in caz contrar')
const QUESTION_END = /\?\s*$/gm
const ARCH = w(
  'api|apis|endpoint|service|services|microservice|microservices|server|client|frontend|backend|db|database|postgres|postgresql|mysql|mongo|mongodb|redis|kafka|rabbitmq|queue|cache|s3|bucket|worker|workers|cron|webhook|auth|oauth|gateway|load balancer|cdn|lambda|container|kubernetes|docker|grpc|rest|graphql|bază de date|baza de date|serviciu|servicii|coadă',
)
const ARCH_VERB = w('calls|sends|reads|writes|publishes|subscribes|stores|queries|uses|talks to|connects to|forwards|validates|loads|apelează|trimite|citește|scrie|publică|folosește|foloseste|vorbește|vorbeste|se conectează|rulează')
const COMPARE = w('vs|versus|compare|compared|comparing|comparison|compar\\p{L}*|pros|cons|pros and cons|avantaje|dezavantaje|criteria|criterii|criteriu|better than|mai bun decât|trade-?offs?')
const HIER = w('reports to|consists of|is part of|made up of|breaks down|breakdown|leads|manages|managed by|în subordine|conduce|coordonează|org chart|organigramă|organigrama|hierarchy|ierarhie|subordonat|department|departament|parent|child|children|subcategorie')
const SEQ_LINE = /^\s*[\p{L}\w][\p{L}\w .]{0,30}?\s*(?:->>|-->>|->|→)\s*[\p{L}\w][\p{L}\w .]{0,30}?\s*:\s*\S/gmu
const SEQ_VERB = w('sends|asks|responds|replies|returns|requests|trimite|răspunde|raspunde|cere|returnează')
// Romanian inflects ("ciclul", "repetăm"), so its words match by stem.
const CYCLE = w('loop|loops|cycle|cycles|cyclic|repeat|repeats|iterate|iteration|ciclu\\p{L}*|ciclic\\p{L}*|repet\\p{L}*|itera\\p{L}*|feedback loop')
const BACK_TO = w('back to|înapoi la|inapoi la|start over|de la capăt|din nou')
const QUAD = w('impact|effort|efort|urgent|important|high|low|ridicat|scăzut|scazut|axis|axă|axa|quadrant|cadran|matrix 2x2|2x2')
const MIND = w('mind ?map|brainstorm|brainstorming|idei|ideas|central idea|idee centrală|subiecte|topics|teme')
const STAGE = w('stage|stages|phase|phases|etapă|etapa|etape|categorie|categorii|category|categories|faza|fază|faze|column|coloană')

/** What the text says, counted once. */
function signals(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  const timeLines = lines.filter((l) => /(?<!\d)([01]?\d|2[0-3])[:.h][0-5]\d(?!\d)/.test(l) || /(?<![\d:])\d{1,2}[./]\d{1,2}(?![\d:])/.test(l)).length
  const bullets = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s/.test(l))
  const indents = new Set(bullets.map((l) => l.match(/^\s*/)![0].replace(/\t/g, '    ').length))
  // A line ending with ":" or a heading, followed by a bullet: a group with items.
  let groups = 0
  lines.forEach((l, i) => {
    if ((/:\s*$/.test(l) || /^\s*#{1,4}\s/.test(l)) && lines[i + 1] && /^\s*([-*•]|\d+[.)])\s/.test(lines[i + 1])) groups++
  })
  const tableLines = lines.filter((l) => (l.match(/\|/g) ?? []).length >= 2 || /\S\t+\S/.test(l)).length
  const quadPairs = Math.min(count(w('impact|urgent|high|ridicat|axis|axă|axa'), text), count(w('effort|efort|important|low|scăzut|scazut|quadrant|cadran|2x2'), text))
  return {
    lines: lines.length,
    times: count(TIME, text),
    dates: count(DATE, text) + count(MONTH, text),
    weekdays: count(WEEKDAY, text),
    dayN: count(DAY_N, text),
    timeLines,
    periods: count(PERIOD, text),
    durations: count(DURATION, text),
    alts: count(ALT, text) + 2 * count(ALT_PAIR, text),
    arrows: count(ARROW, text),
    numbered: count(NUMBERED, text),
    then: count(THEN, text),
    decisions: count(DECISION, text) + count(QUESTION_END, text),
    arch: new Set((text.match(ARCH) ?? []).map((m) => m.toLowerCase())).size,
    archVerbs: count(ARCH_VERB, text),
    compare: count(COMPARE, text),
    tableLines,
    hier: count(HIER, text),
    depth: indents.size,
    // Messages are often written one per line, sometimes in one line separated by ";".
    seq: count(SEQ_LINE, text.replace(/;\s*/g, '\n')),
    seqVerbs: count(SEQ_VERB, text),
    cycle: count(CYCLE, text),
    backTo: count(BACK_TO, text),
    // "... and back to plan": back to a step named earlier closes a loop, even without the word "cycle".
    loopBack: [...text.matchAll(/(?:back to|înapoi la|inapoi la|din nou la)\s+(\p{L}+)/giu)].filter((m) => text.slice(0, m.index).toLowerCase().includes(m[1].toLowerCase())).length,
    quad: count(QUAD, text) >= 2 ? quadPairs : 0,
    mind: count(MIND, text),
    groups,
    stages: count(STAGE, text),
  }
}
type Signals = ReturnType<typeof signals>

/** The day or row labels in the text (lines that name a weekday, "day N" or a date and little else), for the sketch. */
function rowLabels(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s#*-]+/, '').trim())
    .filter((l) => l.length <= 40 && (new RegExp(WEEKDAY.source, 'iu').test(l) || new RegExp(DAY_N.source, 'iu').test(l)))
    .slice(0, 3)
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const list = (parts: (string | false | 0)[]) => parts.filter(Boolean).join(', ')

const SCORERS: Record<DiagramType, (g: Signals) => number> = {
  // Day names alone place nothing on an axis (a timeline needs a start for every item), so they count for less than times or dates.
  timeline: (g) => 0.6 * sat(g.times + g.dates + g.periods + (g.times || g.dates ? 1 : 0.3) * (g.weekdays + g.dayN), 4) + 0.25 * sat(g.durations, 3),
  flow: (g) => 0.45 * sat(g.arrows + g.numbered + g.then, 3) + 0.4 * sat(g.decisions, 1.5),
  // Components only make an architecture when something connects them; a list of technologies under headings is columns.
  architecture: (g) => (0.85 * sat(g.arch - 1, 2) + 0.15 * sat(g.archVerbs + g.arrows, 2)) * (g.archVerbs + g.arrows ? 1 : 0.5),
  columns: (g) => 0.55 * sat(g.groups, 1.5) + 0.25 * sat(g.stages, 1),
  grid: (g) => 0.6 * sat(g.compare, 1) + 0.4 * sat(g.tableLines - 1, 2),
  tree: (g) => 0.7 * sat(g.depth - 1, 1) + 0.5 * sat(g.hier, 1),
  sequence: (g) => (g.seq >= 3 ? 0.95 : 0.5 * sat(g.seq - 1, 1)) + 0.2 * sat(g.seqVerbs - 1, 2),
  // "Back to" alone is usually a trip home, so it only counts next to a loop word.
  cycle: (g) => 0.75 * sat(g.cycle + g.loopBack, 1) + (g.cycle ? 0.15 * sat(g.backTo, 1) : 0),
  quadrant: (g) => 0.9 * sat(g.quad, 1),
  mindmap: (g) => 0.7 * sat(g.mind, 1),
}

const TOOL: Record<DiagramType, string> = {
  timeline: 'add_timeline',
  flow: 'draw_mermaid',
  architecture: 'add_graph',
  columns: 'add_columns',
  grid: 'add_grid',
  tree: 'add_tree',
  mindmap: 'add_mindmap',
  sequence: 'add_sequence',
  cycle: 'add_cycle',
  quadrant: 'add_quadrant',
}

function describe(type: DiagramType, g: Signals, text: string): Pick<Option, 'why' | 'shape' | 'example'> {
  const alt = g.alts >= 2
  switch (type) {
    case 'timeline': {
      const rows = rowLabels(text)
      return {
        why: list([g.times && plural(g.times, 'clock time'), g.dates && plural(g.dates, 'date'), g.weekdays + g.dayN && plural(g.weekdays + g.dayN, 'day name'), g.periods + g.durations && plural(g.periods + g.durations, 'period or duration', 'periods or durations'), alt && `${g.alts} alternatives (Plan A / B)`]),
        shape: `rows = ${rows.length ? rows.map((r) => `"${r}"`).join(', ') + ', …' : 'days / people / teams'}${alt ? '; lanes = the alternatives (Plan A / Plan B) inside each row' : ''}; items = activities placed by start and end, details in notes`,
        example: 'add_timeline({ rows: [{ title: "Mon 12/11", lanes: [{ title: "Plan A", items: [{ start: "09:00", end: "10:30", text: "Museum" }] }] }] })',
      }
    }
    case 'flow':
      return {
        why: list([g.numbered && plural(g.numbered, 'numbered step'), g.arrows && plural(g.arrows, 'arrow'), g.then && plural(g.then, '"then" word'), g.decisions && plural(g.decisions, 'decision (if / else)', 'decisions (if / else)')]),
        shape: 'boxes = steps left to right; diamonds = decisions with labelled yes / no arrows',
        example: 'draw_mermaid({ code: "flowchart LR\\n  A[Order] --> B{Paid?}\\n  B -->|yes| C[Ship]\\n  B -->|no| D[Remind]" })',
      }
    case 'architecture':
      return {
        why: list([plural(g.arch, 'component word') + ' (API, DB, queue, …)', g.archVerbs && plural(g.archVerbs, 'verb like calls / reads / writes', 'verbs like calls / reads / writes')]),
        shape: 'boxes = components; groups = layers or systems (titled boxes around them); arrows = calls, labelled with what flows',
        example: 'add_graph({ nodes: [{ key: "web", text: "Web app", group: "fe" }, { key: "api", text: "API", group: "be" }, { key: "db", text: "Postgres", group: "be" }], edges: [{ from: "web", to: "api", label: "REST" }, { from: "api", to: "db" }], groups: [{ key: "fe", title: "Frontend" }, { key: "be", title: "Backend" }] })',
      }
    case 'columns':
      return {
        why: list([g.groups && plural(g.groups, 'heading with a list under it', 'headings with lists under them'), g.stages && plural(g.stages, 'stage / category word'), alt && `${g.alts} alternatives`]),
        shape: `columns = the headings / stages left to right; items = their bullets${alt ? '; sections = the alternatives inside a column' : ''}`,
        example: 'add_columns({ columns: [{ title: "Stage 1", items: [{ text: "Item" }], sections: [{ title: "Option A", items: [{ text: "Item" }] }] }] })',
      }
    case 'grid':
      return {
        why: list([g.compare && plural(g.compare, 'comparison word') + ' (vs, pros / cons, criteria)', g.tableLines > 1 && plural(g.tableLines, 'table-like line')]),
        shape: 'columns = the options compared; rows = the criteria; cells = short values',
        example: 'add_grid({ columns: ["Option A", "Option B"], rows: ["Price", "Speed"], cells: [["€10", "€15"], ["slow", "fast"]] })',
      }
    case 'tree':
      return {
        why: list([g.depth > 1 && `bullets nested ${g.depth} levels deep`, g.hier && plural(g.hier, 'hierarchy word') + ' (part of, reports to, …)']),
        shape: 'top-down tree: the whole at the top, each part under its parent, siblings in the order given',
        example: 'add_tree({ nodes: [{ key: "a", text: "Company" }, { key: "b", text: "Sales", parent: "a" }, { key: "c", text: "Tech", parent: "a" }] })',
      }
    case 'sequence':
      return {
        why: list([g.seq && plural(g.seq, 'message line') + ' (X -> Y: message)', g.seqVerbs && plural(g.seqVerbs, 'verb like sends / responds', 'verbs like sends / responds')]),
        shape: 'actors across the top with lifelines, messages as labelled arrows in order top to bottom, replies dashed',
        example: 'add_sequence({ actors: ["User", "Server"], messages: [{ from: "User", to: "Server", text: "login" }, { from: "Server", to: "User", text: "token", reply: true }] })',
      }
    case 'cycle':
      return {
        why: plural(g.cycle, 'loop word') + ' (cycle, repeat, back to)',
        shape: 'the steps on a circle clockwise from the top, the last arrow back to the first, the loop\'s name in the middle',
        example: 'add_cycle({ title: "PDCA", steps: [{ text: "Plan" }, { text: "Do" }, { text: "Check" }, { text: "Act" }] })',
      }
    case 'quadrant':
      return {
        why: 'two axes named (impact / effort, urgent / important, high / low)',
        shape: '2x2: one axis across, one up, each item in its quadrant by low / high, quadrants titled',
        example: 'add_quadrant({ xAxis: { title: "Effort", low: "Low", high: "High" }, yAxis: { title: "Impact", low: "Low", high: "High" }, items: [{ text: "Dark mode", x: "low", y: "high" }] })',
      }
    case 'mindmap':
      return {
        why: plural(g.mind, 'brainstorm word') + ' (ideas, topics, mind map)',
        shape: 'the central idea in the middle, branches right and left, their ideas further out',
        example: 'add_mindmap({ center: "Launch", branches: [{ text: "Marketing", children: [{ text: "Blog" }] }, { text: "Pricing" }] })',
      }
  }
}

/**
 * The 2-3 kinds of diagram that fit a text best, best first. Hard rule: when a quarter of the lines carry a time or date,
 * a timeline comes first whatever else scores, since a schedule drawn as a graph was the failure this guards against.
 */
export function recommend(text: string): Option[] {
  const g = signals(text)
  const scores = (Object.keys(SCORERS) as DiagramType[]).map((type) => ({ type, score: Math.min(1, SCORERS[type](g)) }))
  if (g.lines && g.timeLines >= Math.max(2, g.lines * 0.25)) scores.find((s) => s.type === 'timeline')!.score = Math.max(0.95, scores.find((s) => s.type === 'timeline')!.score)
  // Nothing stands out: plain lists read best as columns, and a few connected words as a flow.
  if (scores.every((s) => s.score < 0.15)) scores.find((s) => s.type === (g.arrows ? 'flow' : 'columns'))!.score = 0.2
  const ranked = scores.sort((a, b) => b.score - a.score)
  const top = ranked.filter((s, i) => i === 0 || (i < 3 && s.score >= 0.15))
  // The user still gets a choice: the plainest layout that is not the first one.
  if (top.length < 2) top.push(ranked.find((s) => s.type === (top[0].type === 'columns' ? 'grid' : 'columns'))!)
  return top.map(({ type, score }) => ({ type, tool: TOOL[type], score: Math.round(score * 100) / 100, ...describe(type, g, text) }))
}

// A request to explain a topic: the content comes from the model, not from the user's text, so it needs planning too.
const EXPLAIN = w(
  // "research", "learning" alone are often content ("Q1: research", "learning curve"); asking for one is a phrase.
  'ce este|ce sunt|ce e|ce înseamnă|ce inseamna|cum funcționează|cum functioneaza|cum merge|de ce|explică|explica|explicat\\p{L}*|educativ\\p{L}*|research (?:on|about|into|despre)|cercetare (?:despre|pe)|what is|what are|what does|how does|how do|how it works|why does|explain\\p{L}*|introduction to|introducere în|introducere in|tutorial|teach me',
)

/** Whether the text asks to explain a topic (what it is, how it works, research) rather than to lay out content it gives. */
export function explainsTopic(text: string) {
  const n = count(EXPLAIN, text)
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).length
  return n >= 2 || (n >= 1 && lines <= 6)
}

/** The plan_diagram lines for an explanation: what each box holds, what to cover, where examples and sources go. */
export const EXPLAIN_PLAN = [
  'This asks you to explain a topic: the content comes from you, so plan it like a short lesson and let the user pick the depth as part of the options.',
  '- Each box: a short title (text) plus `detail`, one or two sentences on what it is, why it matters or how it works. The parts, steps or kinds of a box go `inside` it as boxes of their own.',
  '- Cover: what it is, the problem it solves, how it works step by step, its main parts, a concrete example, typical numbers or limits, common pitfalls, and alternatives or improvements.',
  '- Notes: a worked example (kind "example") and the sources (kind "source") on the boxes they explain. Search first when the facts may have changed; never invent a link.',
  '- In each sketch show at least one box with its detail, e.g. `[Chunking] splits documents into pieces of 200-1000 tokens`, and one with boxes inside it.',
].join('\n')

/** What the user should settle before anything is drawn: lines pasted twice and day labels used twice ("Ziua 1" for two days). */
export function toSettle(text: string) {
  const out: string[] = []
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 15)
  const twice = [...new Set(lines.filter((l, i) => lines.indexOf(l) !== i))]
  if (twice.length) out.push(`${plural(twice.length, 'line')} appear more than once (pasted twice?): ${twice.slice(0, 3).map((l) => `"${l.slice(0, 40)}"`).join(', ')}${twice.length > 3 ? ', …' : ''}`)
  const days = (text.match(/(?<!\p{L})(?:day|ziua) \d+/giu) ?? []).map((d) => d.toLowerCase())
  const dup = [...new Set(days.filter((d, i) => days.indexOf(d) !== i))]
  if (dup.length) out.push(`the same day label is used for different days: ${dup.map((d) => `"${d}"`).join(', ')}`)
  return out
}

/** The options as the plan_diagram result: numbered, the first marked, then what to do with them. */
export function renderOptions(opts: Option[], settle: string[] = []) {
  const lines = opts.map((o, i) =>
    [`${i + 1}. ${o.type}${i === 0 ? ' (recommended)' : ''}, score ${o.score}: ${o.tool}`, `   Why: ${o.why || 'few signals'}.`, `   Shape: ${o.shape}.`, `   Example: ${o.example}`].join('\n'),
  )
  return [...lines, ...(settle.length ? [`To settle with the user first: ${settle.join('; ')}.`] : [])].join('\n')
}
