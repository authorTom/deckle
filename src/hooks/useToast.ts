import { useCallback, useEffect, useRef, useState } from 'react'
import { useEnterExit } from './useEnterExit'

export type ToastTone = 'default' | 'danger'

/**
 * The app's one transient message: a confirmation ("Task added to Inbox"), or
 * a failure that names what to fix. A new one replaces whatever is showing.
 */
export function useToast() {
  const [toast, setToast] = useState<string | null>(null)
  const [tone, setTone] = useState<ToastTone>('default')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showToast = useCallback((message: string, nextTone: ToastTone = 'default') => {
    setToast(message)
    setTone(nextTone)
    if (timer.current) clearTimeout(timer.current)
    // A confirmation can go as soon as it's been read; a failure is a whole
    // sentence naming a thing to fix, and needs long enough to finish it.
    timer.current = setTimeout(() => setToast(null), nextTone === 'danger' ? 7000 : 2200)
  }, [])

  useEffect(() => () => clearTimeout(timer.current), [])

  // Held past the dismissal so the toast can animate back down, still saying
  // what it said.
  const anim = useEnterExit(toast !== null, 180)
  const [text, setText] = useState('')
  useEffect(() => {
    if (toast) setText(toast)
  }, [toast])

  return { showToast, anim, tone, text }
}
