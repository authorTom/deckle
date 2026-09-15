import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  loadLibraryHandle,
  saveLibraryHandle,
  rememberOpfsLibrary,
  hasOpfsLibrary,
} from '../db/notes'
import * as library from '../fs/library'
import * as history from '../fs/history'
import * as remote from '../fs/remote'
import type {
  ImportItem,
  ImportedNote,
  NoteFile,
  TreeNode,
  TrashItem,
} from '../fs/library'
import type { HistoryItem } from '../fs/history'
import type { ServerLibraryInfo } from '../fs/remote'
import { clearContentCache, invalidateCached, readCached } from '../lib/contentCache'

export type LibraryStatus =
  | 'loading'
  | 'unsupported'
  | 'no-library'
  | 'needs-permission'
  | 'needs-login'
  | 'ready'

const ACTIVE_KEY = 'notes-active-id'
// Open tabs and the split pane, so a reload restores the same workspace.
const TABS_KEY = 'notes-open-tabs'
const SPLIT_KEY = 'notes-split-id'
// Which backend the user chose last time: 'server' means the library lives in the
// container. Disk and OPFS libraries are already remembered by their own
// mechanisms (a persisted handle / a flag), so only 'server' is recorded here.
// Pre-rename key name, kept so existing users stay on the backend they chose.
const BACKEND_KEY = 'notes-vault-backend'
const SAVE_DEBOUNCE_MS = 500
// While editing, snapshot the previous on-disk version at most this often.
const SNAPSHOT_INTERVAL_MS = 5 * 60_000
// How long a newly created note reads as "wet ink" in the tabs and the tree.
// Matches the ink-dry animation in global.css.
const INK_DRY_MS = 1400

/** How the topbar reports the debounced writer's progress. */
export type SaveState = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'

/**
 * Turn a failed write into something a person can act on.
 *
 * This is the one moment that matters in a local-first app: the whole promise
 * is "your notes are your files", so when the disk refuses, saying nothing —
 * or saying "Unsaved changes", which the user has already learned to ignore —
 * is the worst available answer. The edits are safe in memory either way; what
 * the message has to convey is what to fix.
 */
function describeSaveError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Deckle lost permission to write to your folder. Reopen the library to grant it again.'
  }
  if (name === 'QuotaExceededError') {
    return 'There is no room left to save. Free up space, then keep typing to retry.'
  }
  if (name === 'NotFoundError') {
    return 'The note file has gone — it may have been moved or deleted outside Deckle.'
  }
  const message = err instanceof Error ? err.message : ''
  return message
    ? `Couldn't save to your library: ${message}`
    : "Couldn't save to your library. Your changes are still here; keep typing to retry."
}

/** Which of the two editor panes has the user's attention. */
export type Pane = 'primary' | 'split'

/**
 * A pane's loaded markdown, carrying the id it was read for.
 *
 * The id travels with the text because the two arrive at different moments:
 * making a note active is synchronous, reading its file is not. Holding a bare
 * string meant that for one render the incoming note was paired with the
 * outgoing note's markdown — long enough for an editor to mount on the pair,
 * load the wrong text, and attribute it to the wrong file.
 */
type PaneDoc = { id: string; text: string } | null

function readStoredList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function readStoredString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string | string[] | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else if (Array.isArray(value)) localStorage.setItem(key, JSON.stringify(value))
    else localStorage.setItem(key, value)
  } catch {
    // Storage disabled — the workspace just won't be restored next launch.
  }
}

export function useNotes() {
  const [status, setStatus] = useState<LibraryStatus>('loading')
  const [dir, setDir] = useState<FileSystemDirectoryHandle | null>(null)
  const [tree, setTree] = useState<TreeNode[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // The optional second pane, shown to the right of the primary one.
  const [splitId, setSplitId] = useState<string | null>(null)
  const [activeDoc, setActiveDoc] = useState<PaneDoc>(null)
  const [splitDoc, setSplitDoc] = useState<PaneDoc>(null)
  // A pane is given content only while it belongs to the note that pane is
  // showing; mid-switch it gets null and renders its skeleton instead.
  const activeContent = activeDoc && activeDoc.id === activeId ? activeDoc.text : null
  const splitContent = splitDoc && splitDoc.id === splitId ? splitDoc.text : null
  const [focusedPane, setFocusedPane] = useState<Pane>('primary')
  // Open tabs, in strip order. The active note is always a member.
  const [openIds, setOpenIds] = useState<string[]>(() => readStoredList(TABS_KEY))

  const files = useMemo(() => library.flattenFiles(tree), [tree])

  // Server library availability, discovered once at startup. null = this build
  // isn't served by the Deckle server, so the option isn't offered at all.
  const [serverLibrary, setServerLibrary] = useState<ServerLibraryInfo | null>(null)

  // ---- Startup: restore a previously chosen library ----
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Ask the server first: the server library works in every browser, so it
        // can rescue even a browser with no local storage backend at all.
        const server = await remote.detectServerLibrary()
        if (cancelled) return
        setServerLibrary(server)

        if (server && localStorage.getItem(BACKEND_KEY) === 'server') {
          if (server.authRequired && !server.authenticated) {
            setStatus('needs-login')
            return
          }
          setDir(remote.openServerLibrary(server.name))
          setStatus('ready')
          return
        }

        if (!library.isLibrarySupported()) {
          setStatus(server ? 'no-library' : 'unsupported')
          return
        }
        // Chromium: a previously picked on-disk folder is restored from its
        // persisted handle.
        const saved = await loadLibraryHandle()
        if (cancelled) return
        if (saved) {
          const granted = await library.ensurePermission(saved, false)
          if (cancelled) return
          setDir(saved)
          setStatus(granted ? 'ready' : 'needs-permission')
          return
        }
        // Safari/Firefox: re-open the OPFS library (a fixed location, so no stored
        // handle is needed) if the user opened it before.
        if (!library.supportsDiskPicker() && library.supportsOpfs() && hasOpfsLibrary()) {
          const handle = await library.openOpfsLibrary()
          if (cancelled) return
          setDir(handle)
          setStatus('ready')
          return
        }
        setStatus('no-library')
      } catch {
        // Never leave the app stuck on the loading screen.
        if (!cancelled) setStatus('no-library')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const refresh = useCallback(async (d: FileSystemDirectoryHandle) => {
    const t = await library.buildTree(d)
    setTree(t)
    return library.flattenFiles(t)
  }, [])

  // ---- One library mutation at a time ----
  // A note's id is its path, and a path is free the instant its file is gone:
  // rename "Untitled.md" to "Meeting.md" and the next new note is handed
  // "Untitled.md" again. Overlapping mutations therefore fight over one id.
  // The case that bit: clicking New while the open note is still called
  // Untitled renames it after its heading (the blur does that) and creates a
  // note in the same breath. The create sees the freed name and takes it, and
  // the rename — still finishing — then remaps "Untitled.md" to "Meeting.md",
  // dragging the tab, the pane and the buffered edits off the brand-new note
  // and onto the old one. The new note appeared under the last note's name.
  //
  // Queuing the mutations means each one's bookkeeping is complete before the
  // next one runs, so no id is ever reissued while a remap is still pending.
  // Reads (refresh, search, history listing) stay outside the queue: they
  // don't move files, and making them wait would only add latency.
  const mutations = useRef<Promise<unknown>>(Promise.resolve())
  const queue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const run = mutations.current.then(task, task)
    // A failed mutation must not wedge the queue for everything behind it.
    mutations.current = run.catch(() => undefined)
    return run
  }, [])

  // ---- Load note list once the library is ready ----
  useEffect(() => {
    if (status !== 'ready' || !dir) return
    let cancelled = false
    void (async () => {
      const list = await refresh(dir)
      if (cancelled) return
      const exists = (id: string | null) => !!id && list.some((n) => n.id === id)
      const saved = readStoredString(ACTIVE_KEY)
      const pick = exists(saved) ? saved : list[0]?.id ?? null
      // Restore the workspace, minus any tabs whose notes are gone.
      setOpenIds(readStoredList(TABS_KEY).filter(exists))
      const savedSplit = readStoredString(SPLIT_KEY)
      setSplitId(exists(savedSplit) ? savedSplit : null)
      setActiveId(pick)
    })()
    return () => {
      cancelled = true
    }
  }, [status, dir, refresh])

  // ---- Load each pane's content from disk ----
  useEffect(() => {
    if (!dir || !activeId) {
      setActiveDoc(null)
      return
    }
    let cancelled = false
    const id = activeId
    store(ACTIVE_KEY, id)
    void (async () => {
      try {
        const text = await library.readNote(dir, id)
        if (!cancelled) setActiveDoc({ id, text })
      } catch {
        if (!cancelled) setActiveDoc({ id, text: '' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dir, activeId])

  useEffect(() => {
    if (!dir || !splitId) {
      setSplitDoc(null)
      return
    }
    let cancelled = false
    const id = splitId
    void (async () => {
      try {
        const text = await library.readNote(dir, id)
        if (!cancelled) setSplitDoc({ id, text })
      } catch {
        if (!cancelled) setSplitDoc({ id, text: '' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dir, splitId])

  // ---- Tabs ----
  // Whatever makes a note active — the tree, the palette, a wikilink, a fresh
  // note — it earns a tab. Centralising that here means callers never have to
  // remember to open one.
  useEffect(() => {
    if (!activeId) return
    setOpenIds((prev) => (prev.includes(activeId) ? prev : [...prev, activeId]))
  }, [activeId])

  // Drop tabs whose notes no longer exist (deleted, renamed, or moved).
  useEffect(() => {
    if (!files.length) return
    setOpenIds((prev) => {
      const next = prev.filter((id) => files.some((f) => f.id === id))
      return next.length === prev.length ? prev : next
    })
  }, [files])

  useEffect(() => store(TABS_KEY, openIds), [openIds])
  useEffect(() => store(SPLIT_KEY, splitId), [splitId])

  const openNote = useCallback((id: string) => {
    setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
    setActiveId(id)
    setFocusedPane('primary')
  }, [])

  /** Open a note in whichever pane currently has focus. */
  const openNoteInPane = useCallback(
    (id: string, pane: Pane) => {
      if (pane === 'split' && splitId !== null) {
        setOpenIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSplitId(id)
        setFocusedPane('split')
        return
      }
      openNote(id)
    },
    [openNote, splitId],
  )

  const closeTab = useCallback(
    (id: string) => {
      const idx = openIds.indexOf(id)
      if (idx === -1) return
      const next = openIds.filter((t) => t !== id)
      setOpenIds(next)
      setSplitId((cur) => (cur === id ? null : cur))
      // Closing the active tab hands focus to its right-hand neighbour,
      // falling back to the left one at the end of the strip.
      if (activeId === id) setActiveId(next[idx] ?? next[idx - 1] ?? null)
    },
    [openIds, activeId],
  )

  const closeOtherTabs = useCallback((id: string) => {
    setOpenIds([id])
    setActiveId(id)
    setSplitId(null)
  }, [])

  /** Reorder tabs by drag, moving `id` to sit at `toIndex`. */
  const moveTab = useCallback((id: string, toIndex: number) => {
    setOpenIds((prev) => {
      const from = prev.indexOf(id)
      if (from === -1 || from === toIndex) return prev
      const next = [...prev]
      next.splice(from, 1)
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, id)
      return next
    })
  }, [])

  /** Show the focused note in a second pane, or close the split if one is open. */
  const toggleSplit = useCallback(() => {
    setSplitId((cur) => {
      if (cur !== null) {
        setFocusedPane('primary')
        return null
      }
      // Open the *next* tab beside the current one where there is one, so a
      // split immediately shows two different notes.
      const idx = activeId ? openIds.indexOf(activeId) : -1
      return openIds[idx + 1] ?? openIds[idx - 1] ?? activeId
    })
  }, [activeId, openIds])

  // ---- Connect / reconnect ----
  const connect = useCallback(async () => {
    let handle: FileSystemDirectoryHandle
    try {
      handle = await library.pickLibrary()
    } catch {
      // User dismissed the picker — leave state untouched.
      return
    }
    const granted = await library.ensurePermission(handle, true)
    if (!granted) return
    // Remember the chosen library for next launch. Disk handles persist in
    // IndexedDB; OPFS handles can't be cloned there (Safari), so we just record
    // a flag and re-open the fixed OPFS location on startup. A persistence
    // failure must not block opening the library for this session.
    try {
      if (library.supportsDiskPicker()) {
        await saveLibraryHandle(handle)
      } else {
        rememberOpfsLibrary()
      }
    } catch {
      // Best effort — continue with the open library even if it won't be remembered.
    }
    // A local library was chosen, so don't reopen the server library next launch.
    try {
      localStorage.removeItem(BACKEND_KEY)
    } catch {
      // Storage disabled — the choice just won't be remembered.
    }
    setTree([])
    setActiveId(null)
    setActiveDoc(null)
    // A different library means different notes at the same paths.
    clearContentCache()
    setOpenIds([])
    setSplitId(null)
    setSplitDoc(null)
    setFocusedPane('primary')
    setDir(handle)
    setStatus('ready')
  }, [])

  const reconnect = useCallback(async () => {
    if (!dir) return
    const granted = await library.ensurePermission(dir, true)
    if (granted) setStatus('ready')
  }, [dir])

  // ---- Server library ----
  const openServer = useCallback((info: ServerLibraryInfo) => {
    try {
      localStorage.setItem(BACKEND_KEY, 'server')
    } catch {
      // Storage disabled — the library still works for this session.
    }
    setTree([])
    setActiveId(null)
    setActiveDoc(null)
    // A different library means different notes at the same paths.
    clearContentCache()
    setOpenIds([])
    setSplitId(null)
    setSplitDoc(null)
    setFocusedPane('primary')
    setDir(remote.openServerLibrary(info.name))
    setStatus('ready')
  }, [])

  const connectServer = useCallback(() => {
    if (!serverLibrary) return
    if (serverLibrary.authRequired && !serverLibrary.authenticated) {
      setStatus('needs-login')
      return
    }
    openServer(serverLibrary)
  }, [serverLibrary, openServer])

  /** Submit the library password. Returns null on success, or an error message. */
  const loginServer = useCallback(
    async (password: string) => {
      if (!serverLibrary) return 'The server library is unavailable.'
      const error = await remote.loginServerLibrary(password)
      if (error) return error
      const info = { ...serverLibrary, authenticated: true }
      setServerLibrary(info)
      openServer(info)
      return null
    },
    [serverLibrary, openServer],
  )

  const signOutServer = useCallback(async () => {
    await remote.logoutServerLibrary()
    try {
      localStorage.removeItem(BACKEND_KEY)
    } catch {
      // Nothing to clean up.
    }
    setServerLibrary((info) => (info ? { ...info, authenticated: false } : info))
    setTree([])
    setActiveId(null)
    setActiveDoc(null)
    // A different library means different notes at the same paths.
    clearContentCache()
    setOpenIds([])
    setSplitId(null)
    setSplitDoc(null)
    setFocusedPane('primary')
    setDir(null)
    setStatus('no-library')
  }, [])

  // A session can expire while the app is open. Bounce back to the login
  // screen rather than letting every save fail silently.
  useEffect(() => {
    remote.setUnauthorizedHandler(() => {
      setServerLibrary((info) => (info ? { ...info, authenticated: false } : info))
      setStatus((current) => (current === 'ready' ? 'needs-login' : current))
    })
    return () => remote.setUnauthorizedHandler(null)
  }, [])

  // ---- Debounced content persistence ----
  // Buffered edits are keyed by note id: with tabs and a split pane, more than
  // one note can be dirty at a time, and each has to survive until it's written.
  const pending = useRef<Map<string, string>>(new Map())
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Per-note timestamp of the last history snapshot (throttles edit snapshots).
  const lastSnapshotAt = useRef<Map<string, number>>(new Map())
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  // What went wrong on the last failed write, in plain language. Cleared as
  // soon as a write succeeds, so a recovered library stops nagging.
  const [saveError, setSaveError] = useState<string | null>(null)
  // Mirrors `pending`'s keys into state, so tabs can mark themselves unsaved.
  // The ref is the source of truth; this exists only to trigger a render.
  const [dirtyIds, setDirtyIds] = useState<string[]>([])
  // Only publishes a *change* in which notes are dirty.
  //
  // This runs on every keystroke, and a fresh array every time meant a new
  // `dirtyIds` identity every time — which re-rendered App, and through it the
  // whole workspace, once per character typed. After the first keystroke on a
  // note the set is the same set, so almost every one of those renders was
  // React redrawing the app to tell it nothing had happened.
  const syncDirty = useCallback(() => {
    const next = [...pending.current.keys()]
    setDirtyIds((prev) =>
      prev.length === next.length && prev.every((id, i) => id === next[i])
        ? prev
        : next,
    )
  }, [])

  // Flushes run one at a time.
  //
  // They used to overlap whenever a write outlasted the debounce — a slow link
  // to a server library, or the history snapshot a flush takes every few
  // minutes — and nothing kept them in order. The older batch could finish
  // last and write the older text over the newer, leaving the file on disk a
  // paragraph behind the editor while the indicator said "Saved".
  const flushChain = useRef<Promise<void>>(Promise.resolve())

  const flush = useCallback((): Promise<void> => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = undefined
    }
    const run = flushChain.current.then(() => writePending())
    flushChain.current = run.catch(() => undefined)
    return run
    // writePending is declared below and changes only when `dir` does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, syncDirty])

  async function writePending(): Promise<void> {
    if (!dir || pending.current.size === 0) return
    const batch = [...pending.current]
    pending.current.clear()
    syncDirty()
    setSaveState('saving')
    try {
      for (const [id, content] of batch) {
        // Periodically keep the version being overwritten, so an editing session
        // leaves a trail of restore points (at most one per SNAPSHOT_INTERVAL_MS).
        const last = lastSnapshotAt.current.get(id) ?? 0
        if (Date.now() - last > SNAPSHOT_INTERVAL_MS) {
          lastSnapshotAt.current.set(id, Date.now())
          try {
            const prev = await library.readNote(dir, id)
            if (prev.trim() && prev !== content) {
              await history.snapshotNote(dir, id, prev, 'edit')
            }
          } catch {
            // New note — nothing to snapshot.
          }
        }
        await library.writeNote(dir, id, content)
        invalidateCached(id)
      }
      setLastSavedAt(Date.now())
      setSaveError(null)
      // Another keystroke may have landed mid-write; don't claim "saved" then.
      setSaveState(pending.current.size ? 'unsaved' : 'saved')
    } catch (err) {
      // Put the batch back so the next flush retries rather than losing edits.
      for (const [id, content] of batch) {
        if (!pending.current.has(id)) pending.current.set(id, content)
      }
      syncDirty()
      // 'error', not 'unsaved': a failed write and a pending write are not the
      // same event, and showing the same words for both is how a revoked
      // permission goes unnoticed for an afternoon.
      setSaveError(describeSaveError(err))
      setSaveState('error')
    }
  }

  const saveContent = useCallback(
    (id: string, content: string) => {
      if (!dir || !id) return
      pending.current.set(id, content)
      syncDirty()
      setSaveState('unsaved')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS)
    },
    [dir, flush, syncDirty],
  )

  // Persist buffered edits when the tab is hidden, and hold the door on close.
  //
  // `flush` is async and a library write cannot finish during unload, so firing
  // it at a closing page is a wish, not a save. Whenever there is anything
  // buffered we ask the browser for its native "Leave site?" prompt as well —
  // the debounce window is up to SAVE_DEBOUNCE_MS of typing, which is a
  // paragraph, and losing it silently is not a trade this app gets to make.
  useEffect(() => {
    const onHide = () => void flush()
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      // Read before flushing: flush() empties the buffer synchronously, so
      // asking afterwards always answers "nothing pending".
      const dirty = pending.current.size > 0
      void flush()
      if (!dirty) return
      e.preventDefault()
      // Legacy spelling, still required by some browsers to raise the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [flush])

  // ---- CRUD ----
  // The note that was just made, so the UI can mark it as freshly inked. Cleared
  // on a timer rather than by the animation, so nothing depends on an event
  // that never fires when motion is switched off.
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null)

  // A note that came back rather than one that was made. The ink vocabulary
  // distinguishes the two: creating a note blooms *and* dries, restoring one
  // only dries — it was placed on the page, not invented on it. One flag drove
  // both meanings before, so restoring would have washed a creation bloom
  // across a note that already existed.
  const [justPlacedId, setJustPlacedId] = useState<string | null>(null)

  useEffect(() => {
    if (!justPlacedId) return
    const timer = setTimeout(() => setJustPlacedId(null), INK_DRY_MS)
    return () => clearTimeout(timer)
  }, [justPlacedId])

  useEffect(() => {
    if (!justCreatedId) return
    const timer = setTimeout(() => setJustCreatedId(null), INK_DRY_MS)
    return () => clearTimeout(timer)
  }, [justCreatedId])

  const createNote = useCallback(
    (folderPath = '') =>
      queue(async () => {
        if (!dir) return
        const note = await library.createNote(dir, folderPath)
        await refresh(dir)
        setActiveId(note.id)
        setJustCreatedId(note.id)
      }),
    [dir, refresh, queue],
  )

  // Deleting moves the note to the recycle bin (.trash) rather than erasing it.
  const deleteNote = useCallback(
    (id: string) =>
      queue(async () => {
        if (!dir) return
        // Flush buffered edits first so the trashed copy is current, and so the
        // pending timer can't recreate the note after it's moved to the bin.
        await flush()
        pending.current.delete(id) // don't let a buffered edit recreate the file
        await library.trashNote(dir, id)
        const list = await refresh(dir)
        closeTab(id)
        // closeTab only reassigns the active note when there's a tab to fall
        // back on; with the strip empty, land on whatever the library still has.
        setActiveId((cur) =>
          cur === null || cur === id ? list[0]?.id ?? null : cur,
        )
      }),
    [dir, flush, refresh, closeTab, queue],
  )

  /** Point tabs, panes and buffers at a note's new path after it moves. */
  const remapId = useCallback((oldId: string, newId: string) => {
    if (oldId === newId) return
    setOpenIds((prev) => prev.map((t) => (t === oldId ? newId : t)))
    setActiveId((cur) => (cur === oldId ? newId : cur))
    setSplitId((cur) => (cur === oldId ? newId : cur))
    const buffered = pending.current.get(oldId)
    if (buffered !== undefined) {
      pending.current.delete(oldId)
      pending.current.set(newId, buffered)
    }
  }, [])

  // Rename a note's file to match a new title (commit on blur/Enter).
  const renameNote = useCallback(
    (id: string, newTitle: string) =>
      queue(async () => {
        if (!dir || !id) return undefined
        await flush() // ensure latest content is on disk before moving the file
        const newId = await library.renameNote(dir, id, newTitle)
        if (newId !== id) await history.retargetHistory(dir, id, newId)
        await refresh(dir)
        remapId(id, newId)
        // Returned so callers can tell a real rename from a no-op, and know the
        // id the note now answers to.
        return newId
      }),
    [dir, flush, refresh, remapId, queue],
  )

  const createFolder = useCallback(
    (parentPath: string, name: string) =>
      queue(async () => {
        if (!dir) return undefined
        const id = await library.createFolder(dir, parentPath, name)
        await refresh(dir)
        return id
      }),
    [dir, refresh, queue],
  )

  const deleteFolder = useCallback(
    (folderPath: string) =>
      queue(async () => {
        if (!dir) return
        await flush() // persist any buffered edits to a note inside the folder
        await library.trashFolder(dir, folderPath)
        const list = await refresh(dir)
        const survives = (id: string) => list.some((n) => n.id === id)
        // Tabs and panes showing notes from the deleted folder close with it.
        setOpenIds((prev) => prev.filter(survives))
        setSplitId((cur) => (cur && survives(cur) ? cur : null))
        setActiveId((cur) => (cur && survives(cur) ? cur : list[0]?.id ?? null))
        for (const id of [...pending.current.keys()]) {
          if (!survives(id)) pending.current.delete(id)
        }
      }),
    [dir, flush, refresh, queue],
  )

  const renameFolder = useCallback(
    (folderPath: string, newName: string) =>
      queue(async () => {
        if (!dir) return
        await flush() // persist any buffered edits before moving files
        const newPath = await library.renameFolder(dir, folderPath, newName)
        await refresh(dir)
        // Every note that lived inside the folder just changed path — rewrite
        // the prefix wherever an id is held: tabs, panes, unwritten buffers.
        const rewrite = (id: string) =>
          id.startsWith(`${folderPath}/`)
            ? newPath + id.slice(folderPath.length)
            : id
        setOpenIds((prev) => prev.map(rewrite))
        setActiveId((cur) => (cur ? rewrite(cur) : cur))
        setSplitId((cur) => (cur ? rewrite(cur) : cur))
        for (const [id, content] of [...pending.current]) {
          const next = rewrite(id)
          if (next === id) continue
          pending.current.delete(id)
          pending.current.set(next, content)
        }
      }),
    [dir, flush, refresh, queue],
  )

  const moveNote = useCallback(
    (id: string, targetFolderPath: string) =>
      queue(async () => {
        if (!dir) return
        if (id === activeId) await flush() // persist edits before moving the file
        const newId = await library.moveNote(dir, id, targetFolderPath)
        if (newId !== id) await history.retargetHistory(dir, id, newId)
        await refresh(dir)
        remapId(id, newId)
      }),
    [dir, activeId, flush, refresh, remapId, queue],
  )

  // ---- Import ----
  /**
   * Bring uploaded Markdown files into the library, preserving any folder
   * structure they came with. Returns what actually landed, so the caller can
   * report it — nothing is ever overwritten, so an import is always additive.
   */
  const importNotes = useCallback(
    (
      items: ImportItem[],
      targetFolder = '',
      onProgress?: (done: number, total: number) => void,
    ): Promise<ImportedNote[]> =>
      queue(async () => {
        if (!dir || !items.length) return []
        // Buffered edits first: the import rebuilds the tree, and a pending save
        // landing afterwards would write against a stale view of it.
        await flush()
        const imported = await library.importNotes(dir, items, targetFolder, onProgress)
        await refresh(dir)
        // Open the first imported note so the upload visibly did something.
        if (imported.length) setActiveId(imported[0].id)
        return imported
      }),
    [dir, flush, refresh, queue],
  )

  // ---- Recycle bin ----
  const [trashItems, setTrashItems] = useState<TrashItem[]>([])

  const loadTrash = useCallback(async () => {
    if (!dir) {
      setTrashItems([])
      return
    }
    setTrashItems(await library.listTrash(dir))
  }, [dir])

  const restoreFromTrash = useCallback(
    (trashName: string) =>
      queue(async () => {
        if (!dir) return
        const newId = await library.restoreTrash(dir, trashName)
        await refresh(dir)
        setTrashItems(await library.listTrash(dir))
        if (newId) {
          setActiveId(newId)
          setJustPlacedId(newId)
        }
      }),
    [dir, refresh, queue],
  )

  const deleteFromTrash = useCallback(
    async (trashName: string) => {
      if (!dir) return
      await library.deleteTrashItem(dir, trashName)
      setTrashItems(await library.listTrash(dir))
    },
    [dir],
  )

  const emptyTrash = useCallback(async () => {
    if (!dir) return
    await library.emptyTrash(dir)
    setTrashItems([])
  }, [dir])

  // ---- Version history (for the active note) ----
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([])

  const loadHistory = useCallback(async () => {
    if (!dir || !activeId) {
      setHistoryItems([])
      return
    }
    await flush() // so the newest state is what a restore would snapshot
    setHistoryItems(await history.listHistory(dir, activeId))
  }, [dir, activeId, flush])

  const previewVersion = useCallback(
    async (snapName: string) => {
      if (!dir) return ''
      try {
        return await history.readSnapshot(dir, snapName)
      } catch {
        return ''
      }
    },
    [dir],
  )

  const restoreVersion = useCallback(
    async (snapName: string) => {
      if (!dir || !activeId) return
      await flush()
      const snapContent = await history.readSnapshot(dir, snapName)
      // Keep the current state as its own restore point before replacing it.
      try {
        const cur = await library.readNote(dir, activeId)
        if (cur.trim() && cur !== snapContent) {
          await history.snapshotNote(dir, activeId, cur, 'restore')
        }
      } catch {
        // Note missing on disk — restore recreates it below.
      }
      lastSnapshotAt.current.set(activeId, Date.now())
      await library.writeNote(dir, activeId, snapContent)
      setActiveDoc({ id: activeId, text: snapContent })
      // The same note may also be open in the split pane; keep them in step.
      if (splitId === activeId) setSplitDoc({ id: activeId, text: snapContent })
      await refresh(dir)
      // The note's text came back: settle it like any other placed thing.
      setJustPlacedId(activeId)
      setHistoryItems(await history.listHistory(dir, activeId))
    },
    [dir, activeId, splitId, flush, refresh],
  )

  const deleteVersion = useCallback(
    async (snapName: string) => {
      if (!dir || !activeId) return
      await history.deleteSnapshot(dir, snapName)
      setHistoryItems(await history.listHistory(dir, activeId))
    },
    [dir, activeId],
  )

  // ---- Search across the whole tree (title, path, and file contents) ----
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)

  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q || !dir) {
      setSearchResults(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      const out: SearchResult[] = []
      for (const file of files) {
        if (cancelled) return
        const folderPath = file.id.includes('/')
          ? file.id.slice(0, file.id.lastIndexOf('/'))
          : ''
        const titleMatch =
          file.title.toLowerCase().includes(q) || folderPath.toLowerCase().includes(q)

        const content = await readCached(dir, file)

        let snippet = ''
        let contentMatch = false
        if (!titleMatch) {
          const idx = content.toLowerCase().indexOf(q)
          if (idx >= 0) {
            contentMatch = true
            snippet = makeSnippet(content, idx, q.length)
          }
        }

        if (titleMatch || contentMatch) {
          out.push({ id: file.id, title: file.title, folderPath, snippet })
        }
      }
      if (!cancelled) setSearchResults(out)
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, dir, files])

  const activeNote = files.find((n) => n.id === activeId) ?? null
  const splitNote = files.find((n) => n.id === splitId) ?? null
  /** Tabs resolved to notes, in strip order, skipping anything already gone. */
  const openNotes = useMemo(
    () =>
      openIds
        .map((id) => files.find((f) => f.id === id))
        .filter((f): f is NoteFile => !!f),
    [openIds, files],
  )

  // Reload after the AI assistant changes files on disk: rebuild the tree and
  // re-read the open note's content, so an edit to the currently-open note shows
  // up immediately instead of only after switching away and back.
  const reload = useCallback(async () => {
    if (!dir) return
    const list = await refresh(dir)
    const survives = (id: string) => list.some((n) => n.id === id)

    // Notes the change deleted or moved: drop their buffered edits so the
    // debounced save can't recreate them, then close their tabs and panes.
    for (const id of [...pending.current.keys()]) {
      if (!survives(id)) pending.current.delete(id)
    }
    setOpenIds((prev) => prev.filter(survives))
    setSplitId((cur) => (cur && survives(cur) ? cur : null))
    if (activeId && !survives(activeId)) {
      setActiveId(list[0]?.id ?? null)
      return
    }
    if (!activeId) return

    // Persist buffered edits before re-reading, so a keystroke made moments
    // before the AI change isn't clobbered by stale disk content. In the rare
    // case where the AI edited the very note being typed in, the user's
    // buffer wins — deterministic, and the editor never diverges from disk.
    await flush()
    try {
      setActiveDoc({ id: activeId, text: await library.readNote(dir, activeId) })
      if (splitId && survives(splitId)) {
        setSplitDoc({ id: splitId, text: await library.readNote(dir, splitId) })
      }
    } catch {
      // Transient read failure — keep showing the current content.
    }
  }, [dir, refresh, activeId, splitId, flush])

  return {
    status,
    libraryName: dir?.name ?? null,
    libraryDir: dir,
    reload,
    tree,
    notes: files,
    activeNote,
    activeId,
    activeContent,
    setActiveId,
    // Tabs
    openNotes,
    openNote,
    openNoteInPane,
    closeTab,
    closeOtherTabs,
    moveTab,
    // Split pane
    splitId,
    splitNote,
    splitContent,
    setSplitId,
    toggleSplit,
    focusedPane,
    setFocusedPane,
    /** Set briefly after createNote, for the ink-bloom and wet-ink treatments. */
    justCreatedId,
    justPlacedId,
    // Save status
    saveState,
    saveError,
    lastSavedAt,
    /** Notes with edits not yet written to disk. */
    dirtyIds,
    connect,
    reconnect,
    serverLibrary,
    // Is the open library the server one? Drives the "sign out" affordance.
    usingServerLibrary: !!dir && remote.isRemoteHandle(dir),
    connectServer,
    loginServer,
    signOutServer,
    createNote,
    createFolder,
    deleteFolder,
    renameFolder,
    moveNote,
    deleteNote,
    saveContent,
    renameNote,
    importNotes,
    trashItems,
    loadTrash,
    restoreFromTrash,
    deleteFromTrash,
    emptyTrash,
    historyItems,
    loadHistory,
    previewVersion,
    restoreVersion,
    deleteVersion,
    query,
    setQuery,
    searchResults,
  }
}

export interface SearchResult {
  id: string
  title: string
  folderPath: string
  snippet: string
}

function makeSnippet(content: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 25)
  const end = Math.min(content.length, idx + len + 45)
  let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < content.length) snippet = `${snippet}…`
  return snippet
}
