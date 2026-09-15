import { useCallback, useEffect, useRef, useState } from 'react'

export interface DataFileOptions<T> {
  /** Read the store from a library. Keep it a stable, module-level function. */
  load: (dir: FileSystemDirectoryHandle) => Promise<T>
  /** Write the whole store back. */
  save: (dir: FileSystemDirectoryHandle, value: T) => Promise<void>
  /** What to show before anything has loaded. Never mutated. */
  empty: T
  /** For log lines: "tasks", "bookmarks". */
  label: string
  debounceMs?: number
}

/**
 * A JSON store kept in the library — tasks, bookmarks — held in memory and
 * written back a moment after it changes.
 *
 * Tasks and bookmarks each had their own copy of this, and both copies had the
 * same three ways to lose data, which is why it now lives once:
 *
 *   - **Saving before loading.** A change made while the file was still being
 *     read (a slow server library, a large file) was debounced and written on
 *     its own — an empty store plus one task, over the real file. Changes made
 *     before the load finishes are now held, replayed onto what loads, and only
 *     then saved.
 *   - **Saves out of order.** Each save was fired and forgotten, so two could
 *     overlap and the older could land last. They now run one after another.
 *   - **Switching libraries.** The pending change was dropped when another
 *     library opened. It is now written to the library it belongs to first.
 *
 * A store that fails to load is never saved at all: what is in memory then is
 * not the file's contents, and writing it would replace them.
 */
export function useDataFile<T>(
  dir: FileSystemDirectoryHandle | null,
  { load, save, empty, label, debounceMs = 400 }: DataFileOptions<T>,
) {
  const [store, setStore] = useState<T>(empty)

  const dirRef = useRef(dir)
  dirRef.current = dir
  // Read through a ref so the effects below don't re-run when a caller passes
  // a fresh options object on every render.
  const options = useRef({ load, save, label, debounceMs })
  options.current = { load, save, label, debounceMs }

  /** The authoritative value; `store` is its rendered copy. */
  const latest = useRef<T>(empty)
  const loaded = useRef(false)
  const beforeLoad = useRef<((value: T) => T)[]>([])
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef<Promise<void>>(Promise.resolve())

  const enqueueSave = useCallback((target: FileSystemDirectoryHandle, value: T) => {
    saving.current = saving.current
      .then(() => options.current.save(target, value))
      .catch((err: unknown) => {
        console.error(`[deckle] could not save ${options.current.label}:`, err)
        // Still owed. The next change, or the tab being hidden, retries it.
        if (dirRef.current === target) dirty.current = true
      })
    return saving.current
  }, [])

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    const target = dirRef.current
    if (!target || !dirty.current || !loaded.current) return
    dirty.current = false
    void enqueueSave(target, latest.current)
  }, [enqueueSave])

  const schedule = useCallback(() => {
    dirty.current = true
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, options.current.debounceMs)
  }, [flush])

  // (Re)load whenever the library changes.
  useEffect(() => {
    const target = dir
    loaded.current = false
    beforeLoad.current = []
    dirty.current = false
    latest.current = empty
    setStore(empty)
    if (!target) return

    let cancelled = false
    options.current.load(target).then(
      (value) => {
        if (cancelled) return
        let next = value
        for (const change of beforeLoad.current) next = change(next)
        const owed = beforeLoad.current.length > 0
        beforeLoad.current = []
        loaded.current = true
        latest.current = next
        setStore(next)
        if (owed) schedule()
      },
      (err: unknown) => {
        if (cancelled) return
        console.error(
          `[deckle] could not load ${options.current.label}; changes will not be saved:`,
          err,
        )
      },
    )

    return () => {
      cancelled = true
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = undefined
      }
      // Leaving this library: write what it is still owed, to *this* library,
      // before the next one loads.
      if (dirty.current && loaded.current) void enqueueSave(target, latest.current)
      dirty.current = false
    }
    // `empty` is a module constant; everything else is read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, enqueueSave, schedule])

  // Best-effort save when the tab is hidden or closed.
  useEffect(() => {
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [flush])

  const mutate = useCallback(
    (change: (value: T) => T) => {
      if (!loaded.current) beforeLoad.current.push(change)
      latest.current = change(latest.current)
      setStore(latest.current)
      schedule()
    },
    [schedule],
  )

  return { store, mutate, flush }
}
