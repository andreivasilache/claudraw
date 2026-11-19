import { useEffect, useRef } from 'react'

/** While `active`, Escape or a pointer down outside elements matching `inside` (a CSS selector) calls `onClose`. */
export function useDismiss(active: boolean, inside: string, onClose: () => void) {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    const down = (e: PointerEvent) => !(e.target as Element | null)?.closest?.(inside) && close.current()
    window.addEventListener('keydown', key)
    window.addEventListener('pointerdown', down, true)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('pointerdown', down, true)
    }
  }, [active, inside])
}
