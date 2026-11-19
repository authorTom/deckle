import { useEffect, useRef } from 'react'

/** True when a keystroke is going into a field or the editor, not to the app. */
export function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export interface GlobalShortcuts {
  togglePalette: () => void
  toggleSplit: () => void
  toggleFocus: () => void
  /** Ctrl/Cmd+Shift+A: capture the selection as a task. */
  captureTask: () => void
  showShortcuts: () => void
  closeTab: () => void
  /** Escape: close the topmost layer the app owns. */
  escape: () => void
}

/**
 * The app-wide keyboard shortcuts. Handlers are read through a ref, so the
 * listener is attached once rather than every time one of them changes.
 */
export function useGlobalShortcuts(shortcuts: GlobalShortcuts) {
  const ref = useRef(shortcuts)
  ref.current = shortcuts

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const on = ref.current
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === 'k') {
        e.preventDefault()
        on.togglePalette()
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        on.toggleSplit()
      } else if (mod && e.shiftKey && key === 'f') {
        e.preventDefault()
        on.toggleFocus()
      } else if (mod && e.shiftKey && key === 'a') {
        e.preventDefault()
        on.captureTask()
      } else if (e.key === '?' && !mod && !isTypingTarget()) {
        // Guarded hard: a question mark is a character before it is a command,
        // and the editor must never lose one to a dialog.
        e.preventDefault()
        on.showShortcuts()
      } else if (mod && e.shiftKey && key === 'w') {
        // Close the focused tab. Deliberately NOT plain Ctrl/Cmd+W: browsers
        // reserve that one and ignore preventDefault, so binding it closed the
        // whole app — taking any buffered keystrokes with it.
        e.preventDefault()
        on.closeTab()
      } else if (e.key === 'Escape') {
        on.escape()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
