// The gallery in examples/*.json: short source texts, each with the diagram that suits it and a complete, valid call.
// plan_diagram shows the 1-2 closest ones next to its options, so a model sees a worked call for content like the user's
// at the moment it chooses (retrieved examples beat fixed ones, per Prompt4Vis). Kept apart from recommend.ts, which stays pure.
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DiagramType } from './recommend.ts'

export type Example = { id: string; title: string; tags: string[]; text: string; type: DiagramType; tool: string; args: unknown; why: string }

export const EXAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples')
let cache: Example[] | null = null

/** Every example, read once; a file that does not parse is skipped rather than breaking plan_diagram. */
export function loadExamples(): Example[] {
  if (cache) return cache
  cache = []
  try {
    for (const f of readdirSync(EXAMPLES_DIR).filter((f) => f.endsWith('.json')).sort())
      try {
        cache.push(JSON.parse(readFileSync(join(EXAMPLES_DIR, f), 'utf8')))
      } catch {
        /* a broken example is left out */
      }
  } catch {
    /* no gallery */
  }
  return cache
}

const words = (t: string) => new Set(t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/\p{L}{3,}/gu) ?? [])

/**
 * The examples for a text and the kinds of diagram ranked for it (best first): the closest example of the first kind,
 * then the closest of any listed kind. Closeness is word overlap with the example's text and title (Jaccard), plus extra
 * for each of its tags found in the text. An example of a kind that was not offered would only mislead.
 */
export function closestExamples(text: string, types: DiagramType[], n = 2) {
  const src = words(text)
  const flat = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  const scored = loadExamples()
    .filter((e) => types.includes(e.type))
    .map((e) => {
      const w = words(`${e.title} ${e.text}`)
      const shared = [...w].filter((x) => src.has(x)).length
      const jaccard = shared / Math.max(1, new Set([...w, ...src]).size)
      const tags = e.tags.filter((t) => flat.includes(t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''))).length
      return { e, score: jaccard + 0.08 * tags, match: shared + tags }
    })
    .sort((a, b) => b.score - a.score)
  const first = scored.find((x) => x.e.type === types[0])
  const rest = scored.filter((x) => x !== first && x.match > 0)
  return [...(first ? [first] : []), ...rest].slice(0, n).map((x) => x.e)
}

/** The examples as plan_diagram shows them: title, why, and the call trimmed to about 600 characters. */
export function renderExamples(list: Example[]) {
  if (!list.length) return ''
  const call = (e: Example) => {
    const c = `${e.tool}(${JSON.stringify(e.args)})`
    return c.length > 600 ? `${c.slice(0, 597)}...` : c
  }
  return `\nWorked example${list.length > 1 ? 's' : ''} for similar content (adapt to the user's content, do not copy):\n${list.map((e) => `- ${e.title}: ${e.why}\n  ${call(e)}`).join('\n')}`
}
