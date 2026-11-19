import type { Option } from './Dropdown.tsx'
import type { NoteKind, NoteStatus } from './api.ts'

export const STATUS_OPTIONS: Option<NoteStatus>[] = [
  { value: 'open', label: 'Open', hint: 'Still to settle', tone: 'accent' },
  { value: 'decided', label: 'Decided', hint: 'Settled, keep it', tone: 'green' },
  { value: 'reversed', label: 'Reversed', hint: 'No longer holds', tone: 'muted' },
]

export const KIND_OPTIONS: Option<NoteKind>[] = [
  { value: 'decision', label: 'Decision', hint: 'A choice and why', tone: 'green' },
  { value: 'fact', label: 'Fact', hint: 'Something that is true', tone: 'blue' },
  { value: 'question', label: 'Question', hint: 'Needs an answer', tone: 'accent' },
  { value: 'example', label: 'Example', hint: 'A concrete case', tone: 'blue' },
  { value: 'source', label: 'Source', hint: 'Where it comes from', tone: 'muted' },
]
