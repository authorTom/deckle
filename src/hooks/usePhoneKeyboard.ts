import { useEffect, useState } from 'react'

/**
 * Two facts a phone layout needs that CSS can't learn on its own.
 *
 * 1. How much of the screen is actually visible above the on-screen keyboard,
 *    written to `--vv-h` on the root (and `--kb-open`, 0 or 1). iOS Safari
 *    doesn't shrink the layout viewport when the keyboard opens — only the
 *    *visual* one — so a full-height app keeps its bottom edge behind the keys.
 *    While writing, the app is sized to the visual viewport instead, which puts
 *    the formatting bar (the last row of the editor column) directly on top of
 *    the keyboard, and leaves the editor's own scroller ending where the keys
 *    begin — so ProseMirror's scroll-into-view keeps the caret in sight.
 *
 * 2. Whether the person is writing in a note. That is the moment the tab bar
 *    gives its place to the formatting bar, the way every native notes app
 *    trades navigation for tools while the keyboard is up. Focus alone isn't
 *    evidence — the app focuses a new note by itself, often with no keyboard
 *    shown — so it takes a tap or a keystroke in the note, or the keyboard
 *    actually being open over one. Leaving the note ends it.
 *
 * Only runs while `active`, so a desktop never pays for the listeners.
 */
export function usePhoneKeyboard(active: boolean): boolean {
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (!active) {
      setEditing(false)
      return
    }
    const root = document.documentElement
    const vv = window.visualViewport

    const inNote = (el: EventTarget | null) =>
      el instanceof Element && el.closest('.ProseMirror') !== null

    const measure = () => {
      if (!vv) return
      const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`)
      // Under ~80px is browser chrome settling, not a keyboard.
      root.style.setProperty('--kb-open', inset > 80 ? '1' : '0')
      // iOS pans the whole page up to reveal the caret. The app is already
      // sized to what's visible, so that pan only pushes the top bar off the
      // screen; put it back.
      if (vv.offsetTop > 0 && inNote(document.activeElement)) window.scrollTo(0, 0)
      if (inset > 80 && inNote(document.activeElement)) setEditing(true)
    }

    const onEngage = (e: Event) => {
      if (inNote(e.target)) setEditing(true)
    }
    const onFocusOut = (e: FocusEvent) => {
      // Focus moving from one spot in a note to another is still writing.
      if (!inNote(e.relatedTarget)) setEditing(false)
    }

    measure()
    vv?.addEventListener('resize', measure)
    vv?.addEventListener('scroll', measure)
    document.addEventListener('pointerdown', onEngage, true)
    document.addEventListener('keydown', onEngage, true)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      vv?.removeEventListener('resize', measure)
      vv?.removeEventListener('scroll', measure)
      document.removeEventListener('pointerdown', onEngage, true)
      document.removeEventListener('keydown', onEngage, true)
      document.removeEventListener('focusout', onFocusOut)
      root.style.removeProperty('--vv-h')
      root.style.removeProperty('--kb-open')
    }
  }, [active])

  return editing
}
