import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useDismiss } from './useDismiss.ts'

/** `tone` picks a theme colour for the dot; `swatch` ([stroke, fill]) gives it an exact colour instead. */
export type Option<T extends string> = { value: T; label?: string; hint?: string; tone?: string; swatch?: readonly [string, string] }

const Dot = ({ o }: { o?: { swatch?: readonly [string, string] } }) => (
  <span className={`dd-dot${o?.swatch ? ' sw' : ''}`} style={o?.swatch ? { background: o.swatch[1], borderColor: o.swatch[0] } : undefined} />
)

const Chevron = () => (
  <svg className="dd-chev" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
    <path d="M2.5 3.75 5 6.25l2.5-2.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
    <path d="m2.5 6.25 2.25 2.25L9.5 3.75" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * A small custom select: a pill trigger with a coloured dot, and a menu (rendered in a portal so
 * scrolling popovers don't clip it) with a hint per option. Arrow keys, Enter and Escape work.
 */
export function Dropdown<T extends string>({ value, options, onChange, onOpen, title, variant = 'pill', align = 'start' }: {
  value: T
  options: Option<T>[]
  onChange: (v: T) => void
  /** Called each time the menu opens (e.g. to refresh the options). */
  onOpen?: () => void
  title?: string
  /** `icon` shows only the chevron, for a trigger next to a label of its own. */
  variant?: 'pill' | 'field' | 'icon'
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number; up: boolean } | null>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0] ?? { value }

  useDismiss(open, '.dd-menu, .dd-trigger.open', () => setOpen(false))

  useLayoutEffect(() => {
    if (!open || !btn.current || !menu.current) return
    const r = btn.current.getBoundingClientRect()
    const m = menu.current.getBoundingClientRect()
    const up = r.bottom + 6 + m.height > window.innerHeight - 8 && r.top - 6 - m.height > 8
    const left = align === 'end' ? r.right - m.width : r.left
    setPos({ left: Math.max(8, Math.min(left, window.innerWidth - m.width - 8)), top: up ? r.top - 6 - m.height : r.bottom + 6, up })
  }, [open, align])

  useEffect(() => {
    if (!open) return setPos(null)
    onOpen?.()
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    menu.current?.focus()
    const close = () => setOpen(false)
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (v: T) => {
    setOpen(false)
    btn.current?.focus()
    if (v !== value) onChange(v)
  }

  const onKey = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      setOpen(false)
      btn.current?.focus()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + d + options.length) % options.length)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(options[active].value)
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dd-trigger ${variant}${open ? ' open' : ''}`}
        data-tone={current.tone}
        title={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault()
            setOpen(true)
          }
        }}
      >
        {variant !== 'icon' && <Dot o={current} />}
        {variant !== 'icon' && <span className="dd-label">{current.label ?? current.value}</span>}
        <Chevron />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className={`dd-menu${pos?.up ? ' up' : ''}`}
            role="listbox"
            tabIndex={-1}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0, visibility: 'hidden' }}
            onKeyDown={onKey}
          >
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`dd-item${i === active ? ' active' : ''}`}
                data-tone={o.tone}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                {(o.tone || o.swatch) && <Dot o={o} />}
                <span className="dd-text">
                  <span className="dd-name">{o.label ?? o.value}</span>
                  {o.hint && <span className="dd-hint">{o.hint}</span>}
                </span>
                <span className="dd-check">{o.value === value && <Check />}</span>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
