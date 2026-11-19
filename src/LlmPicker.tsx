import { useEffect, useState } from 'react'
import { BASE } from './api.ts'
import { Dropdown, type Option } from './Dropdown.tsx'

type Llm = { id: string; name: string; kind: string }

type Props = {
  /** This tab is the open one. */
  on: boolean
  /** The LLM the terminal runs now (from the server). */
  current: { id: string; name: string } | null
  onOpen: () => void
  /** Restart the terminal with another LLM. */
  onPick: (id: string) => void
}

const SETTINGS = '__settings'

/** The terminal's tab: its name opens the terminal, the chevron lists the LLMs configured on the settings page (/settings). */
export function LlmPicker({ on, current, onOpen, onPick }: Props) {
  const [list, setList] = useState<Llm[]>([])

  const load = () =>
    fetch(`${BASE}/api/llms`)
      .then((r) => r.json())
      .then((j) => setList(j.llms ?? []))
      .catch(() => {})
  useEffect(() => void load(), [])

  const pick = (id: string) => {
    if (id === SETTINGS) return void window.open('/settings', '_blank')
    if (id !== current?.id) onPick(id)
  }

  const options: Option<string>[] = [
    ...(current && !list.some((l) => l.id === current.id) ? [{ value: current.id, label: current.name }] : []),
    ...list.map((l) => ({ value: l.id, label: l.name, hint: l.kind })),
    { value: SETTINGS, label: 'Settings…', hint: 'Add or edit LLMs' },
  ]

  return (
    <div className={`llm-tab${on ? ' on' : ''}`}>
      <button className="llm-name" role="tab" aria-selected={on} onClick={onOpen} title="The LLM running in the terminal">
        <span className={`llm-live${current ? '' : ' wait'}`} />
        {current?.name ?? 'Connecting…'}
      </button>
      <Dropdown value={current?.id ?? ''} options={options} onChange={pick} onOpen={load} variant="icon" align="start" title="Switch LLM (restarts the terminal)" />
    </div>
  )
}
