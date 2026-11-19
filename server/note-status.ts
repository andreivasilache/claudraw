// Shared by the server and the page (no node imports): what state a note is in.
// example and source carry what explains a box: a concrete case, and where the facts come from.
export const NOTE_KINDS = ['decision', 'fact', 'question', 'example', 'source'] as const
export type NoteKind = (typeof NOTE_KINDS)[number]

export const NOTE_STATUSES = ['open', 'decided', 'reversed'] as const
export type NoteStatus = (typeof NOTE_STATUSES)[number]

type Statused = { kind?: NoteKind; status?: NoteStatus }

/** A note's status; older notes without one get it from their kind (question -> open, decision -> decided, fact -> none). */
export const statusOf = (n: Statused): NoteStatus | undefined => n.status ?? (n.kind === 'question' ? 'open' : n.kind === 'decision' ? 'decided' : undefined)
