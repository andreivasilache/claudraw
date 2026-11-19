import { useDismiss } from './useDismiss.ts'

export type MenuItem = { label: string; hint?: string; run: () => void; divider?: boolean }

/** Right-click menu on a box: ask Claude about it, or arrange what is inside it. */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title: string; items: MenuItem[]; onClose: () => void }) {
  useDismiss(true, '.ctx-menu', onClose)

  const width = 230
  return (
    <div className="ctx-menu" style={{ left: Math.min(x, window.innerWidth - width - 8), top: Math.min(y, window.innerHeight - items.length * 34 - 50) }} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title">{title}</div>
      {items.map((it) => (
        <div key={it.label}>
          {it.divider && <hr />}
          <button
            title={it.hint}
            onClick={() => {
              onClose()
              it.run()
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>
  )
}
