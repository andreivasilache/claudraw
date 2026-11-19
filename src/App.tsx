import { CaptureUpdateAction, Excalidraw, exportToBlob, exportToSvg, getSceneVersion, reconcileElements, restoreElements } from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, BASE, DIAGRAM, statusOf, useCanvasState, type Diff } from './api.ts'
import { ExportMenu, type ExportFormat } from './ExportMenu.tsx'
import { Diagrams } from './Diagrams.tsx'
import { DiffOverlay } from './DiffOverlay.tsx'
import { Context } from './Context.tsx'
import { ContextMenu, type MenuItem } from './ContextMenu.tsx'
import { Decisions } from './Decisions.tsx'
import { History } from './History.tsx'
import { NotesOverlay, type View } from './NotesOverlay.tsx'
import { Presenter } from './Presenter.tsx'
import { StepBadges, Steps } from './Steps.tsx'
import type { Step } from './api.ts'
import { Terminal } from './Terminal.tsx'
import { LlmPicker } from './LlmPicker.tsx'

type Initial = { elements: ExcalidrawElement[]; appState: Record<string, unknown>; files: BinaryFiles }

type Theme = 'light' | 'dark'
const OS_DARK = '(prefers-color-scheme: dark)'
const startTheme = (): Theme => (window.matchMedia(OS_DARK).matches ? 'dark' : 'light')

type ExportRequest = { format: 'png' | 'svg'; ids: string[]; scale: number; background: boolean; dark: boolean | null }
/** An image of the diagram (or of `ids`): a PNG blob, or the SVG as text. */
async function renderExport(xa: ExcalidrawImperativeAPI, o: ExportRequest) {
  const els = pickElements(xa.getSceneElements(), o.ids, false)
  if (!els.length) throw new Error('The canvas is empty.')
  const app = xa.getAppState()
  const appState = { ...app, exportBackground: o.background, exportWithDarkMode: o.dark ?? app.theme === 'dark' }
  if (o.format === 'svg') return new XMLSerializer().serializeToString(await exportToSvg({ elements: els, appState, files: xa.getFiles(), exportPadding: 20 }))
  return exportToBlob({
    elements: els,
    appState,
    files: xa.getFiles(),
    mimeType: 'image/png',
    exportPadding: 20,
    // Keep the longest side within what browsers draw safely.
    getDimensions: (w: number, h: number) => {
      const k = Math.min(o.scale, 8000 / Math.max(w, h))
      return { width: Math.round(w * k), height: Math.round(h * k), scale: k }
    },
  })
}
const toBase64 = (blob: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result).split(',')[1] ?? '')
    r.onerror = () => no(new Error('Could not read the image.'))
    r.readAsDataURL(blob)
  })
const saveAs = (blob: Blob, name: string) => {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/** The elements a picture of `ids` shows (all of them when none are given): their text, what lies inside them, the arrows
 *  attached, and with `context` the neighbours around. */
function pickElements(all: readonly ExcalidrawElement[], ids: string[], context: boolean) {
  let els = all
  if (ids.length) {
    const wanted = new Set(ids)
    const roots = all.filter((e) => wanted.has(e.id))
    if (!roots.length) throw new Error(`No element with id ${ids.join(', ')}.`)
    // Containers show what is inside them (frame children, or anything lying fully within the box).
    const boxes = roots.filter((e) => e.type === 'rectangle' || e.type === 'frame' || e.type === 'magicframe')
    const inside = (e: (typeof all)[number], b: (typeof all)[number]) => e.x >= b.x && e.y >= b.y && e.x + e.width <= b.x + b.width && e.y + e.height <= b.y + b.height
    const own = all.filter((e) => {
      if (wanted.has(e.id)) return true
      const c = (e as { containerId?: string | null }).containerId
      if (c && wanted.has(c)) return true
      if (e.frameId && wanted.has(e.frameId)) return true
      if (e.type === 'arrow') {
        const a = e as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null }
        return (!!a.startBinding && wanted.has(a.startBinding.elementId)) || (!!a.endBinding && wanted.has(a.endBinding.elementId))
      }
      return boxes.some((b) => b.id !== e.id && inside(e, b))
    })
    // Arrows between boxes that are shown (inside a group too), and the labels of every arrow shown.
    const shown = new Set(own.map((e) => e.id))
    for (const e of all) {
      if (e.type !== 'arrow' || shown.has(e.id)) continue
      const a = e as { startBinding?: { elementId: string } | null; endBinding?: { elementId: string } | null }
      if ((a.startBinding && shown.has(a.startBinding.elementId)) || (a.endBinding && shown.has(a.endBinding.elementId))) (own.push(e), shown.add(e.id))
    }
    for (const e of all) {
      const c = (e as { containerId?: string | null }).containerId
      if (c && shown.has(c) && !shown.has(e.id)) (own.push(e), shown.add(e.id))
    }
    if (context) {
      const pad = 60
      const x1 = Math.min(...own.map((e) => e.x)) - pad
      const y1 = Math.min(...own.map((e) => e.y)) - pad
      const x2 = Math.max(...own.map((e) => e.x + e.width)) + pad
      const y2 = Math.max(...own.map((e) => e.y + e.height)) + pad
      els = all.filter((e) => e.x + e.width >= x1 && e.x <= x2 && e.y + e.height >= y1 && e.y <= y2)
    } else els = own
  }
  return els
}

export function App() {
  const [initial, setInitial] = useState<Initial | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [elements, setElements] = useState<readonly ExcalidrawElement[]>([])
  const [view, setView] = useState<View>({ scrollX: 0, scrollY: 0, zoom: 1 })
  const [onlyQuestions, setOnlyQuestions] = useState(false)
  const [panelOpen, setPanelOpen] = useState(true)
  const [tab, setTab] = useState<'code' | 'context' | 'decisions'>('code')
  const [sideWidth, setSideWidth] = useState<number | null>(() => {
    try { return Number(localStorage.getItem('canvas.sideWidth')) || null } catch { return null }
  })
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setSideWidth(Math.round(Math.min(Math.max(window.innerWidth - ev.clientX, 280), window.innerWidth * 0.8)))
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing-side')
      setSideWidth((w) => {
        try { if (w) localStorage.setItem('canvas.sideWidth', String(w)) } catch { /* ignore */ }
        return w
      })
    }
    document.body.classList.add('resizing-side')
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }
  const [diffId, setDiffId] = useState<string | null>(null)
  const [diff, setDiff] = useState<Diff | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [revertDiff, setRevertDiff] = useState<Diff | null>(null)
  const diffIdRef = useRef<string | null>(null)
  diffIdRef.current = diffId
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [toast, setToast] = useState('')
  const [preview, setPreview] = useState<Step[] | null>(null)
  const [playing, setPlaying] = useState<Step[] | null>(null)
  const presenting = !!playing
  const presentingRef = useRef(false)
  presentingRef.current = presenting
  const promptRef = useRef<((text: string) => boolean) | null>(null)
  const switchLlmRef = useRef<((id: string) => void) | null>(null)
  const [llm, setLlm] = useState<{ id: string; name: string } | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const bypass = useRef(false)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const savedVersion = useRef(0)
  const shownVersion = useRef(-1)
  const saveTimer = useRef<number>()
  const main = useRef<string>('canvas')
  const [theme, setTheme] = useState<Theme>(startTheme)
  const dark = theme === 'dark'

  // The theme starts from the OS and follows it live; Excalidraw's own toggle (menu / Shift+Alt+D)
  // still works until the OS theme changes again. The side panel follows Excalidraw.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const mq = window.matchMedia(OS_DARK)
    const onOs = () => {
      const next: Theme = mq.matches ? 'dark' : 'light'
      setTheme(next)
      apiRef.current?.updateScene({ appState: { theme: next }, captureUpdate: CaptureUpdateAction.NEVER })
    }
    mq.addEventListener('change', onOs)
    return () => mq.removeEventListener('change', onOs)
  }, [])

  useEffect(() => {
    api.scene().then((s) => {
      savedVersion.current = getSceneVersion(s.elements)
      setInitial({ elements: s.elements, appState: { ...s.appState, theme: startTheme(), collaborators: new Map() }, files: s.files })
      setElements(s.elements)
    })
  }, [])

  const loadDiff = useCallback(async () => {
    const id = diffIdRef.current
    if (!id) return setDiff(null)
    const d = await api.diff(id)
    setDiff(diffIdRef.current === id && d.added ? d : null)
  }, [])
  useEffect(() => void loadDiff(), [diffId, loadDiff])

  // The server changed the scene (Claude edited it, or the file changed on disk): merge it in.
  const pullScene = useCallback(async () => {
    const xa = apiRef.current
    if (!xa) return
    const remote = await api.scene()
    const merged = reconcileElements(xa.getSceneElementsIncludingDeleted(), restoreElements(remote.elements, null) as never, xa.getAppState())
    xa.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
    const files = Object.values(remote.files ?? {}) as never[]
    if (files.length) xa.addFiles(files)
    void loadDiff()
  }, [loadDiff])

  // Claude asked to see the canvas: render the requested elements (plus what lies around them) and send the PNG back.
  const takeScreenshot = useCallback(async (reqId: string, ids: string[], context: boolean) => {
    try {
      const xa = apiRef.current
      if (!xa) throw new Error('Canvas not ready.')
      // A drawing call can ask for its picture right after it changed the scene: take the server's latest first.
      await pullScene()
      const all = xa.getSceneElements()
      const els = pickElements(all, ids, context)
      if (!els.length) throw new Error('The canvas is empty.')
      const app = xa.getAppState()
      const blob = await exportToBlob({
        elements: els,
        appState: { ...app, exportBackground: true, exportWithDarkMode: app.theme === 'dark' },
        files: xa.getFiles(),
        mimeType: 'image/png',
        exportPadding: 20,
        // Keep the longest side within what an image model reads well.
        getDimensions: (w: number, h: number) => {
          const k = Math.min(2, 1568 / Math.max(w, h))
          return { width: Math.round(w * k), height: Math.round(h * k), scale: k }
        },
      })
      const png = await new Promise<string>((ok, no) => {
        const r = new FileReader()
        r.onload = () => ok(String(r.result).split(',')[1] ?? '')
        r.onerror = () => no(new Error('Could not read the image.'))
        r.readAsDataURL(blob)
      })
      await api.screenshot({ reqId, png })
    } catch (e) {
      await api.screenshot({ reqId, error: e instanceof Error ? e.message : String(e) })
    }
  }, [pullScene])

  // Claude asked for a file: render it and send it back (the server writes it to the exports folder).
  const takeExport = useCallback(
    async (reqId: string, o: ExportRequest) => {
      try {
        const xa = apiRef.current
        if (!xa) throw new Error('Canvas not ready.')
        await pullScene()
        const out = await renderExport(xa, o)
        await api.exportResult({ reqId, data: typeof out === 'string' ? out : await toBase64(out) })
      } catch (e) {
        await api.exportResult({ reqId, error: e instanceof Error ? e.message : String(e) })
      }
    },
    [pullScene],
  )

  // The Export menu: download the whole diagram.
  const downloadExport = useCallback(async (format: ExportFormat) => {
    try {
      const xa = apiRef.current
      if (!xa) throw new Error('Canvas not ready.')
      if (format === 'excalidraw') return saveAs(await (await fetch(`${BASE}/api/export-file`)).blob(), `${DIAGRAM}.excalidraw`)
      const out = await renderExport(xa, { format, ids: [], scale: 2, background: true, dark: null })
      saveAs(typeof out === 'string' ? new Blob([out], { type: 'image/svg+xml' }) : out, `${DIAGRAM}.${format}`)
    } catch (e) {
      setToast(`Export failed: ${e instanceof Error ? e.message : String(e)}`)
      window.setTimeout(() => setToast(''), 4000)
    }
  }, [])

  const state = useCanvasState(pullScene, takeScreenshot, takeExport)
  // The diagram in the focused page is the one Claude's canvas tools work on.
  useEffect(() => {
    const mark = () => document.visibilityState === 'visible' && void api.active()
    mark()
    window.addEventListener('focus', mark)
    document.addEventListener('visibilitychange', mark)
    return () => {
      window.removeEventListener('focus', mark)
      document.removeEventListener('visibilitychange', mark)
    }
  }, [])
  const diagramName = state.diagrams.find((d) => d.id === DIAGRAM)?.name
  useEffect(() => {
    if (diagramName) document.title = `${diagramName} · Canvas`
  }, [diagramName])
  useEffect(() => {
    setRevertDiff(null)
    if (!previewId) return
    let live = true
    void api.diff(previewId).then((d) => live && d.added && setRevertDiff(d)).catch(() => {})
    return () => { live = false }
  }, [previewId, state.history])
  const startPresent = useCallback((steps: Step[]) => {
    window.clearTimeout(saveTimer.current)
    setMenu(null)
    setPlaying(steps) // a copy: editing the list while presenting does not change the running show
  }, [])
  const stopPresent = useCallback(() => setPlaying(null), [])

  const onChange = useCallback((els: readonly ExcalidrawElement[], appState: { selectedElementIds: Record<string, boolean>; viewBackgroundColor: string; theme: Theme; scrollX: number; scrollY: number; zoom: { value: number } }, files: BinaryFiles) => {
    const ids = Object.keys(appState.selectedElementIds)
    setSelected((cur) => (cur.join() === ids.join() ? cur : ids))
    const v = getSceneVersion(els)
    // onChange also fires for pointer moves that change nothing; only a new scene version re-renders the overlays.
    if (v !== shownVersion.current) {
      shownVersion.current = v
      setElements(els)
    }
    setTheme((cur) => (cur === appState.theme ? cur : appState.theme))
    const { scrollX, scrollY } = appState
    setView((v) => (v.scrollX === scrollX && v.scrollY === scrollY && v.zoom === appState.zoom.value ? v : { scrollX, scrollY, zoom: appState.zoom.value }))
    // The presenter fades boxes in memory; never save that. Back at the saved state, a pending save is stale (it may hold the faded boxes).
    if (v === savedVersion.current) return window.clearTimeout(saveTimer.current)
    if (presentingRef.current) return
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      if (presentingRef.current) return
      savedVersion.current = v
      void api.saveScene({ elements: els, appState: { viewBackgroundColor: appState.viewBackgroundColor }, files })
    }, 400)
  }, [])

  // Box id -> the text bound to it, built once per scene version instead of a scan per lookup.
  const boundText = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of elements) if (e.type === 'text' && !e.isDeleted && e.containerId) m.set(e.containerId, e.text)
    return m
  }, [elements])
  const textOf = useCallback((e: ExcalidrawElement) => (e.type === 'text' ? e.text : boundText.get(e.id)), [boundText])

  // Selection -> nodes. A text bound to a box counts as the box.
  const selection = useMemo(() => {
    const byId = new Map(elements.map((e) => [e.id, e]))
    const labelOf = (id: string) => {
      const e = byId.get(id)
      if (!e) return id
      const text = (textOf(e) ?? '').replace(/\s+/g, ' ').trim()
      return text ? (text.length > 40 ? text.slice(0, 40) + '…' : text) : e.type
    }
    const ids = [...new Set(selected.map((id) => (byId.get(id) as { containerId?: string | null } | undefined)?.containerId ?? id))]
    if (ids.length && !ids.includes(main.current)) main.current = ids[0]
    if (!ids.length) main.current = 'canvas'
    const ordered = ids.length ? [main.current, ...ids.filter((i) => i !== main.current)] : []
    return ordered.map((id) => ({ id, label: labelOf(id) }))
  }, [selected, elements, textOf])

  // Tell the server what is selected, so Claude Code (extension/CLI) can ask via get_selection.
  useEffect(() => {
    const t = window.setTimeout(() => void api.select(selection.map((s) => s.id)), 250)
    return () => window.clearTimeout(t)
  }, [selection])
  const boxes = useMemo(() => new Map(elements.filter((e) => !e.isDeleted).map((e) => [e.id, e])), [elements])
  const nameOf = useCallback(
    (id: string) => {
      const e = boxes.get(id)
      if (!e) return null
      const text = (textOf(e) ?? (e as { name?: string }).name ?? '').replace(/\s+/g, ' ').trim()
      return text || e.type
    },
    [boxes, textOf],
  )
  const focusNode = useCallback(
    (id: string) => {
      const el = boxes.get(id)
      if (!el) return
      apiRef.current?.updateScene({ appState: { selectedElementIds: { [id]: true } } as never, captureUpdate: CaptureUpdateAction.NEVER })
      apiRef.current?.scrollToContent(el, { animate: true, fitToViewport: true, viewportZoomFactor: 0.5 })
    },
    [boxes],
  )
  // Right-click on a box: our menu (ask Claude / arrange). "Excalidraw menu" passes the click through to the normal one.
  const live = useRef({ view, boxes, elements, selection })
  live.current = { view, boxes, elements, selection }
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !initial) return
    const onMenu = (e: MouseEvent) => {
      if (bypass.current) return
      const { view: v, elements: els } = live.current
      const r = stage.getBoundingClientRect()
      const px = (e.clientX - r.left) / v.zoom - v.scrollX
      const py = (e.clientY - r.top) / v.zoom - v.scrollY
      const hit = els
        .filter((x) => !x.isDeleted && x.type !== 'arrow' && x.type !== 'line' && x.type !== 'freedraw' && !(x.type === 'text' && (x as { containerId?: string | null }).containerId))
        .filter((x) => px >= x.x && px <= x.x + x.width && py >= x.y && py <= x.y + x.height)
        .sort((a, b) => a.width * a.height - b.width * b.height)[0]
      if (!hit) return
      e.preventDefault()
      e.stopPropagation()
      apiRef.current?.updateScene({ appState: { selectedElementIds: live.current.selection.some((s) => s.id === hit.id) ? Object.fromEntries(live.current.selection.map((s) => [s.id, true])) : { [hit.id]: true } } as never, captureUpdate: CaptureUpdateAction.NEVER })
      menuTarget.current = e.target
      setMenu({ x: e.clientX, y: e.clientY, id: hit.id })
    }
    stage.addEventListener('contextmenu', onMenu, true)
    return () => stage.removeEventListener('contextmenu', onMenu, true)
  }, [initial])
  const menuTarget = useRef<EventTarget | null>(null)

  const flash = useCallback((t: string) => {
    setToast(t)
    window.setTimeout(() => setToast(''), 4000)
  }, [])

  const ask = useCallback(
    (what: string) => {
      const sel = live.current.selection
      const names = sel.slice(0, 4).map((s) => `"${s.label}" (id ${s.id})`).join(', ')
      setPanelOpen(true)
      setTab('code')
      // The terminal may be hidden (zero size) for a moment after the tab switch.
      window.setTimeout(() => {
        if (!promptRef.current?.(`About ${names}: ${what}`)) flash(`${llm?.name ?? 'Claude Code'} is not connected yet.`)
      }, 50)
    },
    [flash, llm],
  )

  const layout = useCallback(
    async (direction: 'LR' | 'TB', id?: string) => {
      const r = await api.layout(direction, id)
      flash(r.message?.split('\n')[0] ?? r.error ?? 'Layout failed')
    },
    [flash],
  )

  const menuItems = (id: string): MenuItem[] => {
    const el = boxes.get(id)
    const container = !!el && (el.type === 'frame' || el.type === 'rectangle') && live.current.elements.some((x) => !x.isDeleted && x.id !== id && x.type !== 'arrow' && x.x > el.x && x.y > el.y && x.x + x.width < el.x + el.width && x.y + x.height < el.y + el.height)
    const items: MenuItem[] = [
      { label: 'Explain', hint: 'What this box does and how it connects', run: () => ask('explain what this does and how it connects to its neighbours. Read it with get_node (and its notes) first. Do not change the diagram.') },
      { label: 'Break into sub-steps', hint: 'Draw the steps inside the box', run: () => ask('break this down into sub-steps and draw them inside it with add_nodes (get_space first, check_layout after). Change only this box.') },
      { label: 'Find risks', hint: 'Failure modes and open questions', run: () => ask('list the risks, failure modes and open questions. Do not change the diagram; save each real open question as a note (add_note, kind question) on this box.') },
      { label: 'Review', hint: 'Wording, colours, missing arrows', run: () => ask('review this box and its connections: wording, colour against the legend, missing or wrong arrows, unclear scope. Suggest fixes, but do not apply them until I agree.') },
    ]
    if (container) {
      items.push({ label: 'Arrange inside → left to right', divider: true, run: () => void layout('LR', id) }, { label: 'Arrange inside ↓ top to bottom', run: () => void layout('TB', id) })
    }
    items.push({
      label: 'Excalidraw menu…',
      divider: true,
      run: () => {
        const t = menuTarget.current as Element | null
        if (!t || !menu) return
        bypass.current = true
        t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: menu.x, clientY: menu.y, button: 2 }))
        bypass.current = false
      },
    })
    return items
  }

  const openNotes = Object.values(state.notes).reduce((n, l) => n + l.filter((x) => statusOf(x) === 'open').length, 0)
  const hasQuestions = openNotes > 0

  if (!initial) return <div className="loading">Loading…</div>

  return (
    <div className={`app${presenting ? ' presenting' : ''}`}>
      <div className="stage" ref={stageRef}>
        <Excalidraw
          excalidrawAPI={(a) => (apiRef.current = a)}
          initialData={initial as never}
          onChange={onChange as never}
          viewModeEnabled={presenting}
          zenModeEnabled={presenting}
          renderTopRightUI={() => (
            <div className="bar bar-right">
              <History entries={state.history} diffId={diffId} onDiff={setDiffId} onPreview={setPreviewId} />
              <ExportMenu onExport={downloadExport} />
              <button onClick={() => setPanelOpen((o) => !o)} title={`Show / hide ${llm?.name ?? 'Claude'}`}>
                {panelOpen ? `${llm?.name ?? 'Claude'} ›` : `‹ ${llm?.name ?? 'Claude'}`}
              </button>
            </div>
          )}
          UIOptions={{ canvasActions: { loadScene: false, toggleTheme: true } }}
        />
        <NotesOverlay notes={state.notes} boxes={boxes} selected={selection.map((x) => x.id)} view={view} onlyQuestions={onlyQuestions} />
        {preview && !playing && <StepBadges steps={preview} boxes={boxes} view={view} />}
        {revertDiff ? <DiffOverlay diff={revertDiff} view={view} preview /> : diff && <DiffOverlay diff={diff} view={view} onClose={() => setDiffId(null)} />}
        {menu && boxes.has(menu.id) && <ContextMenu x={menu.x} y={menu.y} title={selection.length > 1 ? `${selection.length} boxes` : (nameOf(menu.id) ?? '')} items={menuItems(menu.id)} onClose={() => setMenu(null)} />}
        {toast && <div className="toast">{toast}</div>}
        {playing && apiRef.current && <Presenter xa={apiRef.current} steps={playing} onExit={stopPresent} />}
        <div className="bar bar-center">
          <a className="back" href="/" title="All projects">
            ← Projects
          </a>
          <Diagrams diagrams={state.diagrams} onChanged={state.reloadDiagrams} flash={flash} />
          <span className="bar-sep" />
          {hasQuestions && (
            <button className={onlyQuestions ? 'on' : ''} onClick={() => setOnlyQuestions((o) => !o)} title="Show only boxes with open questions">
              ? open questions
            </button>
          )}
          <Steps animations={state.animations} setAnimations={state.setAnimations} selected={selection.map((x) => x.id)} nameOf={nameOf} onPresent={startPresent} onPreview={setPreview} />
        </div>
      </div>
      <div className={`side${panelOpen ? '' : ' hidden'} tab-${tab}`} style={sideWidth ? { width: sideWidth } : undefined}>
        <div className="side-resize" onPointerDown={startResize} onDoubleClick={() => { setSideWidth(null); try { localStorage.removeItem('canvas.sideWidth') } catch { /* ignore */ } }} title="Drag to resize, double-click to reset" />
        <nav className="tabs" role="tablist">
          <LlmPicker on={tab === 'code'} current={llm} onOpen={() => setTab('code')} onPick={(id) => switchLlmRef.current?.(id)} />
          <button role="tab" aria-selected={tab === 'decisions'} className={tab === 'decisions' ? 'on' : ''} onClick={() => setTab('decisions')}>
            Decisions{openNotes > 0 && <span className="tab-count" title={`${openNotes} open`}>{openNotes}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'context'} className={tab === 'context' ? 'on' : ''} onClick={() => setTab('context')}>Context</button>
        </nav>
        <div className="pane" hidden={tab !== 'code'}>
          <Terminal dark={dark} visible={panelOpen && tab === 'code'} selection={selection} prompt={promptRef} switchLlm={switchLlmRef} onLlm={setLlm} />
        </div>
        <div className="pane" hidden={tab !== 'decisions'}>
          <Decisions notes={state.notes} nameOf={nameOf} onFocus={focusNode} />
        </div>
        <div className="pane" hidden={tab !== 'context'}>
          <Context visible={panelOpen && tab === 'context'} />
        </div>
      </div>
    </div>
  )
}
