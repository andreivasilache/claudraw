import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { BASE } from './api.ts'

type Props = {
  dark: boolean
  visible: boolean
  /** Items selected on the canvas, main first. */
  selection: { id: string; label: string }[]
  /** Filled with a function that types a line into Claude's prompt and submits it (false when the terminal is not open). */
  prompt?: { current: ((text: string) => boolean) | null }
  /** Filled with a function that restarts the terminal with another LLM (an id from the settings). */
  switchLlm?: { current: ((id: string) => void) | null }
  /** Called with the LLM the server's terminal runs: on connect, and whenever anyone switches it. */
  onLlm?: (llm: { id: string; name: string }) => void
}

const THEMES = {
  dark: { background: '#0d0d0d', foreground: '#ececec', cursor: '#ececec', selectionBackground: '#444444' },
  light: { background: '#ffffff', foreground: '#1b1b1f', cursor: '#1b1b1f', selectionBackground: '#cfd3ff' },
}

/** The real Claude Code (or OpenCode) CLI, running in the project on the server, drawn by xterm.js. */
export function Terminal({ dark, visible, selection, prompt, switchLlm, onLlm }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm>()
  const fit = useRef<FitAddon>()
  const ws = useRef<WebSocket>()
  const [state, setState] = useState<'connecting' | 'open' | 'exited'>('connecting')
  const [name, setName] = useState('Claude Code')
  const [setup, setSetup] = useState<string | null>(null)
  const onLlmRef = useRef(onLlm)
  onLlmRef.current = onLlm

  const send = (m: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m))
  }

  useEffect(() => {
    if (!prompt) return
    prompt.current = (text) => {
      if (ws.current?.readyState !== WebSocket.OPEN || !term.current) return false
      send({ type: 'input', data: text.replace(/\s*\n\s*/g, ' ') })
      window.setTimeout(() => send({ type: 'input', data: '\r' }), 150) // after the paste has landed
      term.current.focus()
      return true
    }
    return () => void (prompt.current = null)
  }, [prompt])

  useEffect(() => {
    if (!switchLlm) return
    switchLlm.current = (id) => send({ type: 'restart', llm: id })
    return () => void (switchLlm.current = null)
  }, [switchLlm])

  useEffect(() => {
    const t = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: THEMES[dark ? 'dark' : 'light'],
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.loadAddon(new WebLinksAddon())
    t.open(host.current!)
    term.current = t
    fit.current = f

    let closed = false
    let retry: number
    const connect = () => {
      t.reset() // the server replays recent output on connect
      const s = new WebSocket(`ws://${location.host}${BASE}/pty`)
      ws.current = s
      s.onopen = () => {
        setState('open')
        f.fit()
        send({ type: 'resize', cols: t.cols, rows: t.rows })
      }
      s.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.type === 'data') t.write(m.data)
        else if (m.type === 'reset') {
          t.reset()
          setState('open')
        } else if (m.type === 'exit') setState('exited')
        else if (m.type === 'setup') setSetup(m.problem)
        else if (m.type === 'llm') {
          setName(m.name)
          onLlmRef.current?.({ id: m.id, name: m.name })
        }
      }
      s.onclose = () => {
        if (closed) return
        setState('connecting')
        retry = window.setTimeout(connect, 1500)
      }
    }
    connect()

    const onData = t.onData((d) => send({ type: 'input', data: d }))
    const onResize = t.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetWidth > 0) f.fit()
    })
    ro.observe(host.current!)

    return () => {
      closed = true
      window.clearTimeout(retry)
      ro.disconnect()
      onData.dispose()
      onResize.dispose()
      ws.current?.close()
      t.dispose()
    }
  }, [])

  useEffect(() => {
    if (term.current) term.current.options.theme = THEMES[dark ? 'dark' : 'light']
  }, [dark])

  useEffect(() => {
    if (!visible) return
    fit.current?.fit()
    term.current?.focus()
  }, [visible])

  const typeSelection = () => {
    const about = selection.length ? selection.map((s) => `"${s.label}"`).join(', ') : 'the whole diagram'
    send({ type: 'input', data: `About ${about}: ` })
    term.current?.focus()
  }

  return (
    <div className="term-wrap">
      <div className="term-bar">
        <span className="sel" title={selection.length ? selection.map((s) => s.id).join(', ') : 'Nothing is selected, so the whole diagram is the selection'}>
          {selection.length ? `Selected: ${selection.map((s) => s.label).join(' · ')}` : 'Selected: whole diagram'}
        </span>
        <button className="link" disabled={state !== 'open'} onClick={typeSelection} title={`Type the selected box names into the prompt. ${name} can also read the selection itself.`}>
          mention
        </button>
        <button className="link" onClick={() => send({ type: 'restart' })} title={`Kill this ${name} process and start a new one`}>
          restart
        </button>
      </div>
      {setup && (
        <div className="term-setup" role="alert">
          <b>{name} has no canvas tools: {setup}.</b> <button className="link" onClick={() => send({ type: 'restart' })}>Restart</button> it; if that does not help, run <code>canvas init</code> in the project folder.
        </div>
      )}
      <div className="term-host" ref={host} />
      {state !== 'open' && (
        <div className="term-state">
          {state === 'connecting' ? 'Connecting…' : (
            <>
              {name} exited. <button className="link" onClick={() => send({ type: 'restart' })}>Start again</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
