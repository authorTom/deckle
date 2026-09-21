import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isRemoteHandle } from '../fs/remote'
import {
  activityStamp,
  loadActivity,
  readSeen,
  writeSeen,
  type ActivityEvent,
} from './activity'

/** How often to look for an agent's changes while the tab is in view. */
const POLL_MS = 15_000

/**
 * The activity log, kept current.
 *
 * An agent writes to the library from somewhere else entirely, so nothing in
 * the page learns about it on its own. On a server library this asks for the
 * log's size and modification time every few seconds while the tab is
 * visible, and on focus — one tiny request — and only when those move does it
 * read the log and tell the caller (`onChange`), which reloads the tree and any
 * open note. A local library has no log; it just refreshes on focus, since an
 * agent may have written into the folder directly.
 */
export function useActivity(
  dir: FileSystemDirectoryHandle | null,
  libraryName: string | null,
  onChange: () => void,
) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [seenAt, setSeenAt] = useState(() => readSeen(libraryName))
  const stamp = useRef<string | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const supported = !!dir && isRemoteHandle(dir)

  useEffect(() => setSeenAt(readSeen(libraryName)), [libraryName])

  const reloadEvents = useCallback(async () => {
    if (!dir) {
      setEvents([])
      return
    }
    setEvents(await loadActivity(dir))
  }, [dir])

  // Initial read, and a fresh start whenever the library changes.
  useEffect(() => {
    stamp.current = null
    void reloadEvents()
  }, [reloadEvents])

  const check = useCallback(async () => {
    if (!dir) return
    if (!isRemoteHandle(dir)) {
      onChangeRef.current()
      return
    }
    let next: string | null
    try {
      next = await activityStamp(dir)
    } catch {
      return // offline, or signed out: the next tick will try again
    }
    if (stamp.current === null) {
      stamp.current = next
      return
    }
    if (next === stamp.current) return
    stamp.current = next
    await reloadEvents()
    onChangeRef.current()
  }, [dir, reloadEvents])

  useEffect(() => {
    if (!dir) return
    void check()
    const remote = isRemoteHandle(dir)
    const timer = remote
      ? setInterval(() => {
          if (document.visibilityState === 'visible') void check()
        }, POLL_MS)
      : undefined
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearInterval(timer)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [dir, check])

  const unseen = useMemo(() => events.filter((e) => e.at > seenAt).length, [events, seenAt])

  /** Everything up to now has been looked at. */
  const markSeen = useCallback(() => {
    const newest = events[0]?.at ?? Date.now()
    setSeenAt(newest)
    writeSeen(libraryName, newest)
  }, [events, libraryName])

  return { events, supported, unseen, seenAt, markSeen, refresh: reloadEvents }
}

export type ActivityApi = ReturnType<typeof useActivity>
