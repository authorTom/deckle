import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query from JavaScript.
 *
 * Layout stays CSS's job; this exists for the handful of decisions CSS can't
 * make — chiefly that on a small screen the docked panels *overlay* the editor
 * instead of sitting beside it, so only one of them can usefully be open at a
 * time. That's a behaviour, not a style, so it has to be known here too.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }
    const list = window.matchMedia(query)
    const onChange = () => setMatches(list.matches)
    onChange() // the query may have changed between render and effect
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [query])

  return matches
}

/**
 * The breakpoint at which the three docked panels stop being columns and become
 * drawers. Kept in step with the `max-width: 900px` block in global.css — the
 * two have to agree or a drawer opens with no scrim behind it.
 */
export const COMPACT_QUERY = '(max-width: 900px)'

/**
 * A phone: narrow enough that the app stops being a desk with drawers and
 * becomes a set of full-screen sections under a bottom tab bar. Kept in step
 * with the `max-width: 640px` phone block in responsive.css. Landscape phones
 * fall outside it on purpose — a bottom bar would cost a fifth of their height,
 * and the compact drawers already fit them.
 */
export const PHONE_QUERY = '(max-width: 640px)'
