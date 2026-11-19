import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { followRemoteChanges, isRemoteHandle } from '../fs/remote'
import {
  activityStamp,
  loadActivity,
  readSeen,
  writeSeen,
  type ActivityEvent,
} from './activity'

/** How often to look for an agent's changes while the tab is in view. */
const POLL_MS = 15_000
/** The same, while the live stream is open and doing that job already. */
const POLL_STREAMING_MS = 120_000
/** Waits between attempts to reopen a dropped stream: 2 s, doubling to a minute. */
const RETRY_MIN_MS = 2_000
const RETRY_MAX_MS = 60_000

/**
 * The activity log, kept current.
 *
 * An agent writes to the library from somewhere else entirely, so nothing in
 * the page learns about it on its own. On a server library the server says so
 * the moment it happens, over a live stream (/api/library/events); behind a
 * proxy that won't carry one, this falls back to asking for the log's size and
 * modification time every few seconds while the tab is visible, and on focus —
 * one tiny request. Only when those move does it read the log and tell the
 * caller (`onChange`), which reloads the tree and any open note. A local library has no log; it just refreshes on focus, since an
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

  const [streaming, setStreaming] = useState(false)

  // The live stream, reopened with a growing pause whenever it drops.
  useEffect(() => {
    if (!dir || !isRemoteHandle(dir)) return
    const controller = new AbortController()
    let retry = RETRY_MIN_MS
    let wait: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      const opened = Date.now()
      setStreaming(true)
      followRemoteChanges(() => void check(), controller.signal)
        .catch(() => {})
        .finally(() => {
          setStreaming(false)
          if (controller.signal.aborted) return
          // A stream that lasted a while was healthy; start the back-off over.
          retry = Date.now() - opened > RETRY_MAX_MS ? RETRY_MIN_MS : Math.min(retry * 2, RETRY_MAX_MS)
          // Catch anything missed while it was down.
          void check()
          wait = setTimeout(open, retry)
        })
    }
    open()
    return () => {
      controller.abort()
      if (wait) clearTimeout(wait)
      setStreaming(false)
    }
  }, [dir, check])

  useEffect(() => {
    if (!dir) return
    void check()
    const remote = isRemoteHandle(dir)
    const timer = remote
      ? setInterval(
          () => {
            if (document.visibilityState === 'visible') void check()
          },
          streaming ? POLL_STREAMING_MS : POLL_MS,
        )
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
  }, [dir, check, streaming])

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
