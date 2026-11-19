import { newId } from './history.ts'
import { perProject } from './project.ts'

// The Claude prompt being worked on, reported by the UserPromptSubmit / Stop hooks (hooks/turn.mjs).
// Changes made while it is open are labelled with it and share one history version.
// `diagram` is the diagram the prompt works on: the one open in the browser when it was sent (or switched to with open_diagram),
// so moving to another browser tab mid-prompt does not redirect Claude's edits.

const TTL = 15 * 60_000
const state = perProject(() => ({ turn: null as { id: string; text: string; at: number; diagram: string } | null, last: null as { id: string; at: number } | null }))

export function startTurn(text: string, diagram: string) {
  state().turn = { id: newId(), text: text.replace(/\s+/g, ' ').trim(), at: Date.now(), diagram }
  state().last = { id: state().turn!.id, at: Date.now() }
}
export const endTurn = () => void (state().turn = null)
/**
 * The id of the prompt being answered, or of the last one when its Stop hook already ran: a later Stop hook (stop-notes)
 * can send Claude back to work, and that is still the same user message.
 */
export function turnId() {
  const t = currentTurn() ?? state().last
  return t && Date.now() - t.at < TTL ? t.id : null
}
export function currentTurn() {
  const t = state().turn
  return t && Date.now() - t.at < TTL ? t : null
}
