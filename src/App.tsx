import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Bookmark,
  Columns2,
  FileDown,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  History,
  Info,
  ListTodo,
  Maximize2,
  Minimize2,
  Moon,
  Package,
  Palette,
  Plus,
  Server,
  Sun,
  Trash2,
  Keyboard,
  Upload,
  X,
} from 'lucide-react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import Sidebar from './components/Sidebar'
import Workspace from './components/Workspace'
import CommandPalette, { type Command } from './components/CommandPalette'
import TrashModal from './components/TrashModal'
import ExportModal from './components/ExportModal'
import HistoryModal from './components/HistoryModal'
import ConfirmDialog, { type ConfirmRequest } from './components/ConfirmDialog'
import ThemePicker from './components/ThemePicker'
import ResizeCrew from './components/ResizeCrew'
import { EASTER_EGG_KEYWORDS } from './themes/themes'
import TaskPanel, { type PanelTab } from './components/TaskPanel'
import ProjectsView from './components/ProjectsView'
import ActivityView from './components/ActivityView'
import { useActivity } from './activity/useActivity'
import { lastEventFor } from './activity/activity'
import { useProjects } from './projects/useProjects'
import {
  DEFAULT_PROJECTS_DIR,
  createProject,
  setProjectStatus,
  type Project,
} from './projects/projects'
import LibraryGate from './components/LibraryGate'
import InkFilter from './components/InkFilter'
import ShortcutsModal from './components/ShortcutsModal'
import AboutModal, { type StorageKind } from './components/AboutModal'
import { useTasks } from './tasks/useTasks'
import { useBookmarks } from './bookmarks/useBookmarks'
import { domainOf, findUrl, normalizeUrl } from './bookmarks/url'
import {
  blockActions,
  formatActions,
  headingActions,
  listActions,
} from './components/formatActions'
import { deriveTitleFromMarkdown, isGeneratedTitle } from './lib/format'
import { MOD_KEY } from './lib/platform'
import { exportToPdf } from './lib/exportPdf'
import { downloadMarkdown } from './lib/exportMarkdown'
import { serialize } from './editor/markdown'
import {
  selectionFromDataTransfer,
  selectionFromFiles,
  type ImportSelection,
  type ReadProgress,
} from './lib/importMarkdown'
import ImportModal, {
  type ImportOutcome,
  type ImportPending,
  type ImportProgress,
} from './components/ImportModal'
import MoveNoteModal from './components/MoveNoteModal'
import { useTheme } from './hooks/useTheme'
import { downloadBlob } from './lib/zip'
import { readNote as readNoteFromLibrary } from './fs/library'
import { useNotes } from './hooks/useNotes'
import type { EnterFrom, FlightOrigin } from './lib/motion'
import { useBacklinks } from './hooks/useBacklinks'
import { useResizable } from './hooks/useResizable'
import { useDeferredUnmount } from './hooks/useDeferredUnmount'
import { useEnterExit } from './hooks/useEnterExit'
import { COMPACT_QUERY, useMediaQuery } from './hooks/useMediaQuery'
import { supportsDiskPicker } from './fs/library'

/**
 * True when the keystroke belongs to whatever the user is writing in.
 *
 * The editor is a contenteditable, so `isContentEditable` matters as much as
 * the input tags — without it, typing "?" in a note would open a dialog.
 */
function isTypingTarget(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  if (el.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

/** `webkitdirectory` is how every browser exposes folder picking, but it isn't
 *  in React's typed attribute list — assert it once here rather than at each use. */
const DIRECTORY_PROPS = { webkitdirectory: '', directory: '' } as unknown as
  React.InputHTMLAttributes<HTMLInputElement>

export default function App() {
  const {
    theme,
    toggleTheme,
    palette,
    setPalette,
    availableThemes,
    unlockTheme,
  } = useTheme()
  const {
    status,
    libraryName,
    libraryDir,
    reload,
    tree,
    notes,
    allFiles,
    activeNote,
    activeAsset,
    activeId,
    activeContent,
    readFile,
    flush,
    openNotes,
    openNote,
    openNoteInPane,
    closeTab,
    closeOtherTabs,
    moveTab,
    splitId,
    splitNote,
    splitAsset,
    splitContent,
    setSplitId,
    toggleSplit,
    focusedPane,
    setFocusedPane,
    saveState,
    saveError,
    lastSavedAt,
    dirtyIds,
    justCreatedId,
    justPlacedId,
    connect,
    reconnect,
    serverLibrary,
    usingServerLibrary,
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
  } = useNotes()

  // Below this width the three docked panels stop being columns and become
  // drawers over the editor, so at most one of them can usefully be open.
  const compact = useMediaQuery(COMPACT_QUERY)

  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])

  const [focusMode, setFocusMode] = useState(false)
  const toggleFocus = useCallback(() => setFocusMode((f) => !f), [])

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [editor, setEditor] = useState<TiptapEditor | null>(null)

  const [trashOpen, setTrashOpen] = useState(false)
  const openTrash = useCallback(async () => {
    await loadTrash()
    setTrashOpen(true)
  }, [loadTrash])

  const [historyOpen, setHistoryOpen] = useState(false)
  const openHistory = useCallback(async () => {
    await loadHistory()
    setHistoryOpen(true)
  }, [loadHistory])

  // A single confirmation slot: any caller raises one by describing it, rather
  // than reaching for window.confirm.
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)

  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  /**
   * Which backend is holding the notes, for the About box to name.
   *
   * Derived the same way startup chooses one: a remote handle is the server
   * library, and of the two local backends only Chromium gets the folder
   * picker — everywhere else falls back to the browser's private storage.
   */
  const storageKind: StorageKind = usingServerLibrary
    ? 'server'
    : supportsDiskPicker()
      ? 'disk'
      : 'browser'

  // Projects, activity, tasks and bookmarks share a tabbed panel docked on the
  // left, beside the note list.
  const [tasksOpen, setTasksOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<PanelTab>('projects')

  /** Shut every drawer — what the scrim does, and what a phone needs on open. */
  const closeOverlays = useCallback(() => {
    setSidebarOpen(false)
    setTasksOpen(false)
  }, [])

  /** Open the panel on a tab; clicking the active tab's button closes it. */
  const openPanelTab = useCallback(
    (which: PanelTab) => {
      if (tasksOpen && panelTab === which) {
        setTasksOpen(false)
        return
      }
      if (compact) setSidebarOpen(false)
      setPanelTab(which)
      setTasksOpen(true)
    },
    [tasksOpen, panelTab, compact],
  )
  const toggleTasks = useCallback(() => openPanelTab('tasks'), [openPanelTab])
  const toggleBookmarks = useCallback(
    () => openPanelTab('bookmarks'),
    [openPanelTab],
  )
  const toggleProjects = useCallback(() => openPanelTab('projects'), [openPanelTab])
  const toggleActivity = useCallback(() => openPanelTab('activity'), [openPanelTab])
  // Docked panels stay mounted for the length of their slide-out, so closing
  // one animates instead of vanishing. Matches --dur-slow.
  const PANEL_EXIT_MS = 260
  const renderTasks = useDeferredUnmount(tasksOpen, PANEL_EXIT_MS)

  // ---- Resizable docked panels ----
  const sidebarResize = useResizable({
    storageKey: 'deckle-width-sidebar',
    defaultSize: 280,
    min: 200,
    max: 520,
    edge: 'right',
  })
  const taskResize = useResizable({
    storageKey: 'deckle-width-tasks',
    defaultSize: 340,
    min: 260,
    max: 560,
    edge: 'right',
  })
  // Tasks (Todoist-style planner, stored in the library's .deckle/tasks.json)
  const tasks = useTasks(libraryDir)

  // Bookmarks (stored in the library's .deckle/bookmarks.json)
  const bookmarks = useBookmarks(libraryDir)

  // Wikilink backlinks, one index per pane — for a file as much as a note.
  const backlinks = useBacklinks(libraryDir, allFiles, activeId)
  const splitBacklinks = useBacklinks(libraryDir, allFiles, splitId)

  // What agents are doing to the library. Polls the server library's activity
  // log and reloads the tree and any open note when it moves, so a file an
  // agent saves appears without anyone refreshing the page.
  const activity = useActivity(libraryDir, libraryName, reload)

  // Projects: the folders in Projects/ (or wherever the server was told).
  const projectsDir =
    (usingServerLibrary ? serverLibrary?.projectsDir : undefined) ?? DEFAULT_PROJECTS_DIR
  const projects = useProjects(libraryDir, tree, projectsDir)

  // Transient confirmation toast (e.g. after capturing a task).
  const [toast, setToast] = useState<string | null>(null)
  const [toastTone, setToastTone] = useState<'default' | 'danger'>('default')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showToast = useCallback(
    (msg: string, tone: 'default' | 'danger' = 'default') => {
      setToast(msg)
      setToastTone(tone)
      if (toastTimer.current) clearTimeout(toastTimer.current)
      // A confirmation can go as soon as it's been read; a failure is a whole
      // sentence naming a thing to fix, and needs long enough to finish it.
      toastTimer.current = setTimeout(
        () => setToast(null),
        tone === 'danger' ? 7000 : 2200,
      )
    },
    [],
  )
  // Held past the dismissal so the toast can animate back down.
  const toastAnim = useEnterExit(toast !== null, 180)
  const [toastText, setToastText] = useState('')
  useEffect(() => {
    if (toast) setToastText(toast)
  }, [toast])

  // ---- Naming a note after its own heading ----
  // Set for the length of a rename, so the pane that re-keys underneath it
  // doesn't grab the caret back from whatever the user just clicked.
  const renaming = useRef(false)
  const shouldClaimFocus = useCallback(() => !renaming.current, [])

  const nameNoteAfterHeading = useCallback(
    (noteId: string, markdown: string) => {
      const note = notes.find((n) => n.id === noteId)
      // Only ever renames away from the name Deckle invented. A title the user
      // typed is theirs, even when the heading later says something else.
      if (!note || !isGeneratedTitle(note.title)) return
      const derived = deriveTitleFromMarkdown(markdown)
      if (!derived || derived === note.title) return
      renaming.current = true
      void renameNote(noteId, derived).finally(() => {
        renaming.current = false
      })
    },
    [notes, renameNote],
  )

  // A failed write says its piece once, in full. The top bar keeps the
  // persistent "Not saved" state after the toast has gone, so the message is
  // the explanation and the chip is the reminder.
  useEffect(() => {
    if (saveError) showToast(saveError, 'danger')
  }, [saveError, showToast])

  const addTaskFromText = useCallback(
    (text: string) => {
      const title = text.replace(/\s+/g, ' ').trim().slice(0, 300)
      if (!title) return
      tasks.addTask({
        title,
        source: activeId ? { noteId: activeId } : undefined,
      })
      showToast('Task added to Inbox')
    },
    [tasks, activeId, showToast],
  )

  /** Capture the editor selection as a task; false if nothing is selected. */
  const captureSelectionTask = useCallback(() => {
    if (!editor) return false
    const { from, to } = editor.state.selection
    if (from === to) return false
    addTaskFromText(editor.state.doc.textBetween(from, to, ' '))
    return true
  }, [editor, addTaskFromText])

  /** Capture the link in the editor selection as a bookmark. */
  const captureSelectionBookmark = useCallback(() => {
    if (!editor) return
    const { from, to } = editor.state.selection
    if (from === to) {
      showToast('Select a link or URL first')
      return
    }
    // Prefer an actual link mark in the selection; fall back to a URL in the text.
    let href: string | null = null
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (href) return false
      const mark = node.marks.find((m) => m.type.name === 'link')
      if (mark) href = (mark.attrs as { href?: string }).href ?? null
      return true
    })
    const text = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
    const raw = href ?? findUrl(text)
    const url = raw ? normalizeUrl(raw) : null
    if (!url) {
      showToast('No link found in selection')
      return
    }
    const title =
      text.replace(raw!, '').replace(/\s+/g, ' ').trim().slice(0, 200) || domainOf(url)
    bookmarks.addBookmark({
      url,
      title,
      source: activeId ? { noteId: activeId } : undefined,
    })
    showToast('Bookmark saved')
  }, [editor, bookmarks, activeId, showToast])

  // ---- Import / export ----
  // The file inputs live here rather than in the sidebar so the command palette
  // can open the same pickers.
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const openPicker = useCallback((input: HTMLInputElement | null) => {
    if (!input) return
    // Clear first, so picking the same file twice in a row still fires change.
    input.value = ''
    input.click()
  }, [])

  const openImport = useCallback(() => openPicker(fileInput.current), [openPicker])
  const openFolderImport = useCallback(
    () => openPicker(folderInput.current),
    [openPicker],
  )

  // An import reports itself in a modal rather than a toast: it has two phases,
  // it can take a while on a folder or an archive, and when it goes wrong the
  // interesting part is *which files* went wrong — none of which fits in a
  // sentence that disappears after two seconds.
  const [importOpen, setImportOpen] = useState(false)
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null)
  const [importOutcome, setImportOutcome] = useState<ImportOutcome | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  // Files that have been read and are waiting to be told where to go. Held here
  // rather than in the modal because they are the import itself, and a dialog
  // that owned them would lose them the moment it unmounted.
  const [importSelection, setImportSelection] = useState<ImportSelection | null>(null)

  const onReadProgress = useCallback<ReadProgress>((done, total, label) => {
    setImportProgress({ phase: 'reading', done, total, label })
  }, [])

  /** The writing half: everything from here on touches the library. */
  const writeSelection = useCallback(
    async (selection: ImportSelection, targetFolder: string) => {
      setImportSelection(null)
      try {
        const total = selection.items.length
        setImportProgress({ phase: 'writing', done: 0, total })
        // One render per file would cost more than the write does on a large
        // import, and no one can read a counter moving that fast anyway.
        const step = Math.max(1, Math.floor(total / 100))
        const imported = await importNotes(
          selection.items,
          targetFolder,
          (done, count) => {
            if (done === count || done % step === 0) {
              setImportProgress({ phase: 'writing', done, total: count })
            }
          },
        )

        setImportProgress(null)
        setImportOutcome({
          imported: imported.length,
          renamed: imported.filter((n) => n.renamed).length,
          skipped: selection.skipped,
          folder: targetFolder,
        })
      } catch (err) {
        setImportProgress(null)
        setImportError(
          err instanceof Error ? err.message : 'Something went wrong during the import.',
        )
      }
    },
    [importNotes],
  )

  /**
   * Read a selection, then write it.
   *
   * `targetFolder` of `null` means "ask": the files are read, and the modal
   * offers the library's folders before anything is written. A drop already
   * named its destination by landing on a folder, so it passes one and goes
   * straight through.
   */
  const runImport = useCallback(
    async (pending: Promise<ImportSelection>, targetFolder: string | null) => {
      setImportOutcome(null)
      setImportError(null)
      setImportSelection(null)
      setImportProgress({ phase: 'reading', done: 0, total: 0 })
      setImportOpen(true)
      if (compact) closeOverlays()
      else closeSidebar()

      let selection: ImportSelection
      try {
        selection = await pending
      } catch (err) {
        setImportProgress(null)
        setImportError(
          err instanceof Error ? err.message : 'Something went wrong during the import.',
        )
        return
      }

      setImportProgress(null)

      if (!selection.items.length) {
        setImportOutcome({ imported: 0, renamed: 0, skipped: selection.skipped })
        return
      }

      if (targetFolder === null) {
        setImportSelection(selection)
        return
      }

      await writeSelection(selection, targetFolder)
    },
    [writeSelection, closeSidebar, closeOverlays, compact],
  )

  const handleImportFiles = useCallback(
    (files: FileList | File[]) => {
      void runImport(selectionFromFiles(files, onReadProgress), null)
    },
    [runImport, onReadProgress],
  )

  // `webkitGetAsEntry` is only valid while the drop event is being dispatched,
  // so selectionFromDataTransfer reads the entries synchronously before its
  // first await — don't defer this call.
  const handleDropFiles = useCallback(
    (transfer: DataTransfer, targetFolder: string) => {
      void runImport(selectionFromDataTransfer(transfer, onReadProgress), targetFolder)
    },
    [runImport, onReadProgress],
  )

  /** What the destination step is choosing for, in numbers. */
  const importPending = useMemo<ImportPending | null>(
    () =>
      importSelection
        ? {
            notes: importSelection.items.length,
            skipped: importSelection.skipped.length,
            nested: importSelection.items.some((i) => i.path.includes('/')),
          }
        : null,
    [importSelection],
  )

  const closeImport = useCallback(() => {
    setImportOpen(false)
    // Cancelling at the destination step throws the read files away — nothing
    // was written, so there is nothing to keep.
    setImportSelection(null)
  }, [])

  // Keyboard shortcuts: Ctrl/Cmd+K opens the palette, Ctrl/Cmd+Shift+F toggles
  // focus, Ctrl/Cmd+\ splits, Escape exits focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((o) => !o)
      } else if (mod && e.key === '\\') {
        e.preventDefault()
        toggleSplit()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        toggleFocus()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'a') {
        // Capture the selection as a task; with no selection, toggle the panel.
        e.preventDefault()
        if (!captureSelectionTask()) toggleTasks()
      } else if (e.key === '?' && !mod && !isTypingTarget()) {
        // Guarded hard: a question mark is a character before it is a command,
        // and the editor must never lose one to a dialog.
        e.preventDefault()
        setShortcutsOpen(true)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'w') {
        // Close the focused tab. Deliberately NOT plain Ctrl/Cmd+W: browsers
        // reserve that one and ignore preventDefault, so binding it closed the
        // whole app — taking any buffered keystrokes with it.
        e.preventDefault()
        if (activeId) closeTab(activeId)
      } else if (e.key === 'Escape') {
        // Close the topmost layer first; only exit focus mode if nothing is open.
        // (The command palette and confirm dialog handle their own Escape.)
        if (historyOpen) setHistoryOpen(false)
        else if (trashOpen) setTrashOpen(false)
        // On a phone the drawers are the topmost layer, so they go before
        // focus mode does.
        else if (compact && (sidebarOpen || tasksOpen)) {
          closeOverlays()
        } else setFocusMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    toggleFocus,
    toggleSplit,
    trashOpen,
    historyOpen,
    captureSelectionTask,
    toggleTasks,
    closeTab,
    activeId,
    compact,
    sidebarOpen,
    tasksOpen,
    closeOverlays,
  ])

  // ---- Note-switch choreography ----
  // Both are set at the click, not in an effect afterwards: the pane remounts in
  // the same commit as the id change, so anything computed later would arrive a
  // switch too late and animate the wrong way.
  const [flightFrom, setFlightFrom] = useState<FlightOrigin | null>(null)
  const [enterFrom, setEnterFrom] = useState<EnterFrom | undefined>()

  /** Which way along the tab strip this switch travels, if it's on the strip. */
  const directionTo = useCallback(
    (id: string): EnterFrom | undefined => {
      const from = openNotes.findIndex((n) => n.id === activeId)
      const to = openNotes.findIndex((n) => n.id === id)
      if (from === -1 || to === -1 || from === to) return undefined
      return to > from ? 'right' : 'left'
    },
    [openNotes, activeId],
  )

  /** Open a note from the sidebar, palette, a task, or a wikilink. */
  const handleSelect = useCallback(
    (id: string, origin: FlightOrigin | null = null) => {
      setFlightFrom(origin)
      setEnterFrom(undefined) // a jump from outside the strip has no direction
      openNote(id)
      // On a phone the panels sit *over* the editor, so leaving them open would
      // hide the note that was just asked for.
      if (compact) closeOverlays()
      else closeSidebar()
    },
    [openNote, closeSidebar, closeOverlays, compact],
  )

  const toggleSidebar = useCallback(() => {
    const opening = !sidebarOpen
    if (opening && compact) setTasksOpen(false)
    setSidebarOpen(opening)
  }, [sidebarOpen, compact])

  const handleSelectTab = useCallback(
    (id: string, origin: FlightOrigin | null) => {
      setFlightFrom(origin)
      setEnterFrom(directionTo(id))
      openNote(id)
    },
    [openNote, directionTo],
  )

  /** A wikilink click lands in whichever pane the reader was already in. */
  const handleOpenInPane = useCallback(
    (id: string) => openNoteInPane(id, focusedPane),
    [openNoteInPane, focusedPane],
  )

  // Deleting moves the note to the recycle bin (recoverable), so no confirm.
  const handleDelete = useCallback(
    (id: string) => {
      void deleteNote(id)
    },
    [deleteNote],
  )

  const handleCreateFolder = useCallback(
    (parentPath: string, name: string) => {
      void createFolder(parentPath, name)
    },
    [createFolder],
  )

  // ---- Moving a note between folders ----
  // The note the move dialog is asking about. Held as an id, not the note
  // itself, so a rename or a refresh underneath it can't leave the dialog
  // talking about a note that no longer exists.
  const [movingId, setMovingId] = useState<string | null>(null)
  const movingNote = useMemo(
    () => allFiles.find((n) => n.id === movingId) ?? null,
    [allFiles, movingId],
  )

  /** Folder part of a note id — "Projects/idea.md" → "Projects". */
  const folderOf = (id: string) => (id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '')

  const handleMoveNote = useCallback(
    (id: string, targetFolder: string) => {
      if (folderOf(id) === targetFolder) return
      void moveNote(id, targetFolder).then(() =>
        showToast(
          targetFolder
            ? `Moved to ${targetFolder}`
            : `Moved to ${libraryName ?? 'the library root'}`,
        ),
      )
    },
    [moveNote, showToast, libraryName],
  )

  const handleDeleteFolder = useCallback(
    (folderPath: string) => {
      const name = folderPath.includes('/')
        ? folderPath.slice(folderPath.lastIndexOf('/') + 1)
        : folderPath
      setConfirmRequest({
        title: `Delete “${name}”?`,
        body: 'Its notes move to the Recycle Bin, where you can restore them.',
        confirmLabel: 'Delete folder',
        danger: true,
        onConfirm: () => void deleteFolder(folderPath),
      })
    },
    [deleteFolder],
  )

  const handleRenameFolder = useCallback(
    (folderPath: string, newName: string) => {
      void renameFolder(folderPath, newName)
    },
    [renameFolder],
  )

  const handleRenameNote = useCallback(
    (id: string, newTitle: string) => {
      void renameNote(id, newTitle)
    },
    [renameNote],
  )

  // From the file, not the editor: the editor never holds a note's front
  // matter, and a copy without it would not be the note.
  const handleSaveMarkdown = useCallback(async () => {
    if (!activeNote || !libraryDir) return
    await flush()
    try {
      downloadMarkdown(activeNote.title, await readNoteFromLibrary(libraryDir, activeNote.id))
    } catch {
      if (editor) downloadMarkdown(activeNote.title, serialize(editor))
    }
  }, [editor, activeNote, libraryDir, flush])

  const handleDownloadFile = useCallback(
    async (id: string) => {
      const file = allFiles.find((f) => f.id === id)
      if (!file) return
      try {
        downloadBlob(await readFile(id), file.name)
      } catch {
        showToast(`Couldn't read ${file.name}`, 'danger')
      }
    },
    [allFiles, readFile, showToast],
  )

  // ---- Projects and activity ----
  const folderIds = useMemo(() => {
    const out = new Set<string>()
    const walk = (nodes: typeof tree) => {
      for (const node of nodes) {
        if (node.kind !== 'folder') continue
        out.add(node.id)
        walk(node.children)
      }
    }
    walk(tree)
    return out
  }, [tree])
  const kindAt = useCallback(
    (path: string): 'file' | 'folder' | null =>
      allFiles.some((f) => f.id === path) ? 'file' : folderIds.has(path) ? 'folder' : null,
    [allFiles, folderIds],
  )
  const provenanceFor = useCallback(
    (id: string) => lastEventFor(activity.events, id),
    [activity.events],
  )
  /** Agent changes in each project since the person last looked. */
  const unseenByProject = useMemo(() => {
    const out = new Map<string, number>()
    for (const event of activity.events) {
      if (event.at <= activity.seenAt) break
      if (event.project) out.set(event.project, (out.get(event.project) ?? 0) + 1)
    }
    return out
  }, [activity.events, activity.seenAt])

  /** A project opens on its overview, or on whatever changed in it last. */
  const openProject = useCallback(
    (project: Project) => {
      const target = project.overview ?? project.latest
      if (target) handleSelect(target)
      else showToast(`${project.name} is empty`)
    },
    [handleSelect, showToast],
  )
  const openProjectByName = useCallback(
    (name: string) => {
      const project = projects.find((p) => p.name === name)
      if (project) openProject(project)
      else showToast(`There is no project called ${name} any more`)
    },
    [projects, openProject, showToast],
  )
  const handleSetProjectStatus = useCallback(
    (project: Project, status: Parameters<typeof setProjectStatus>[2]) => {
      if (!libraryDir) return
      void setProjectStatus(libraryDir, project, status)
        .then(() => reload())
        .then(() => showToast(`${project.name} marked ${status}`))
        .catch(() => showToast(`Couldn't update ${project.name}`, 'danger'))
    },
    [libraryDir, reload, showToast],
  )
  const handleCreateProject = useCallback(
    (name: string, summary: string) => {
      if (!libraryDir) return
      void createProject(libraryDir, projectsDir, name, summary)
        .then(async (overview) => {
          await reload()
          handleSelect(overview)
        })
        .catch(() => showToast(`Couldn't create ${name}`, 'danger'))
    },
    [libraryDir, projectsDir, reload, handleSelect, showToast],
  )

  // ---- Command palette actions ----
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: 'new-note',
        label: 'New note',
        icon: Plus,
        keywords: 'create add file',
        run: () => void createNote(),
      },
      {
        id: 'new-folder',
        label: 'New folder',
        icon: FolderPlus,
        keywords: 'create directory',
        // Naming happens inline in the tree, so open the sidebar to show it.
        run: () => setSidebarOpen(true),
      },
      {
        id: 'split',
        label: splitId ? 'Close split view' : 'Split editor',
        icon: Columns2,
        hint: 'Ctrl/Cmd+\\',
        keywords: 'split pane side by side compare two',
        run: toggleSplit,
      },
      {
        id: 'focus',
        label: 'Toggle focus mode',
        icon: Maximize2,
        hint: 'Ctrl/Cmd+Shift+F',
        keywords: 'zen distraction free writing',
        run: toggleFocus,
      },
      {
        id: 'theme',
        label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: 'theme appearance dark light mode',
        run: () => toggleTheme(),
      },
      {
        id: 'appearance',
        label: 'Appearance & themes…',
        icon: Palette,
        keywords: 'theme colour color palette appearance skin style look',
        run: () => setThemePickerOpen(true),
      },
      {
        id: 'open-folder',
        label: supportsDiskPicker()
          ? 'Open a different folder'
          : 'Use the library in this browser',
        icon: FolderOpen,
        keywords: 'library switch change local folder',
        run: () => void connect(),
      },
      {
        id: 'open-trash',
        label: 'Open Recycle Bin',
        icon: Trash2,
        keywords: 'trash deleted bin restore',
        run: () => void openTrash(),
      },
      {
        id: 'import-md',
        label: 'Import files or a ZIP…',
        icon: Upload,
        keywords: 'import upload md markdown pdf image document spreadsheet zip archive add files migrate unzip',
        run: openImport,
      },
      {
        id: 'import-folder',
        label: 'Import a folder',
        icon: FolderOpen,
        keywords: 'import upload folder directory bulk migrate restore',
        run: openFolderImport,
      },
      {
        id: 'export-zip',
        label: 'Export knowledge base as ZIP',
        icon: Package,
        keywords: 'export download backup zip archive everything library',
        run: () => setExportOpen(true),
      },
      {
        id: 'projects',
        label: 'Projects',
        icon: FolderKanban,
        keywords: 'projects work agent hermes status overview folders',
        run: toggleProjects,
      },
      {
        id: 'activity',
        label: 'Agent activity',
        icon: Activity,
        keywords: 'activity log agent hermes changes recent new review feed history api mcp',
        run: toggleActivity,
      },
      {
        id: 'toggle-tasks',
        label: 'Toggle tasks',
        icon: ListTodo,
        hint: 'Ctrl/Cmd+Shift+A',
        keywords: 'todo task planner inbox today upcoming calendar',
        run: toggleTasks,
      },
      {
        id: 'toggle-bookmarks',
        label: 'Toggle bookmarks',
        icon: Bookmark,
        keywords: 'bookmark url link page product saved collection',
        run: toggleBookmarks,
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        icon: Keyboard,
        hint: '?',
        keywords: 'keys keyboard shortcuts bindings help reference cheatsheet',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'about',
        label: 'About Deckle',
        icon: Info,
        keywords: 'about version build release licence license credits info',
        run: () => setAboutOpen(true),
      },
    ]

    // Every unlocked theme is reachable by name, but hidden so six extra rows
    // don't pad the palette's default list.
    for (const t of availableThemes) {
      list.push({
        id: `theme-${t.id}`,
        label: `Theme: ${t.name}`,
        icon: Palette,
        section: 'Appearance',
        keywords: `theme colour color palette appearance ${t.name}`,
        hidden: true,
        run: () => setPalette(t.id),
      })
    }

    // The one you have to go looking for. Once found it joins the picker and
    // the list above, so this only exists while it's still a secret.
    if (!availableThemes.some((t) => t.id === 'springfield')) {
      list.push({
        id: 'unlock-springfield',
        label: '🍩 Mmm… a theme you were not supposed to find',
        icon: Palette,
        section: 'Appearance',
        keywords: EASTER_EGG_KEYWORDS,
        hidden: true,
        run: () => {
          unlockTheme('springfield')
          showToast('Woo-hoo! Springfield theme unlocked')
        },
      })
    }

    // Only offered where a server library actually exists (Docker deployments
    // with a volume mounted).
    if (serverLibrary) {
      list.push({
        id: 'server-library',
        label: usingServerLibrary
          ? serverLibrary.authRequired
            ? 'Sign out of the server library'
            : 'Leave the server library'
          : 'Switch to the server library',
        icon: Server,
        keywords: 'server library docker remote sign out log out switch hosted',
        run: () =>
          usingServerLibrary ? void signOutServer() : connectServer(),
      })
    }

    if (activeNote) {
      list.push({
        id: 'close-tab',
        label: 'Close tab',
        icon: X,
        // Advertised here because the shortcut is deliberately not the browser's
        // Ctrl/Cmd+W, so nobody will guess it.
        hint: 'Ctrl/Cmd+Shift+W',
        keywords: 'close tab hide note dismiss',
        run: () => closeTab(activeNote.id),
      })
      list.push({
        id: 'move-note',
        label: 'Move current note to another folder…',
        icon: FolderInput,
        keywords: 'move relocate folder organise organize file into put',
        run: () => setMovingId(activeNote.id),
      })
      list.push({
        id: 'history',
        label: 'Version history',
        icon: History,
        keywords: 'versions snapshots restore undo backup',
        run: () => void openHistory(),
      })
      list.push({
        id: 'export-pdf',
        label: 'Export current note to PDF',
        icon: FileDown,
        keywords: 'print save pdf',
        run: () => exportToPdf(activeNote.title),
      })
      list.push({
        id: 'delete-note',
        label: 'Move current note to Recycle Bin',
        icon: Trash2,
        keywords: 'remove trash delete bin',
        run: () => handleDelete(activeNote.id),
      })
    }

    // Formatting commands act on the live editor (only when one is mounted).
    if (editor) {
      list.push({
        id: 'bookmark-selection',
        label: 'Save selection as bookmark',
        icon: Bookmark,
        keywords: 'bookmark link url save page product',
        run: captureSelectionBookmark,
      })
      for (const action of [
        ...headingActions,
        ...formatActions,
        ...listActions,
        ...blockActions,
      ]) {
        list.push({
          id: `fmt-${action.name}`,
          label: action.label,
          icon: action.Icon,
          section: 'Formatting',
          keywords: 'format style text',
          run: () => action.run(editor),
        })
      }
    }

    return list
  }, [
    createNote,
    toggleSplit,
    splitId,
    toggleFocus,
    theme,
    toggleTheme,
    availableThemes,
    setPalette,
    unlockTheme,
    showToast,
    connect,
    openTrash,
    openImport,
    openFolderImport,
    openHistory,
    toggleTasks,
    toggleBookmarks,
    toggleProjects,
    toggleActivity,
    captureSelectionBookmark,
    activeNote,
    handleDelete,
    editor,
    serverLibrary,
    usingServerLibrary,
    connectServer,
    signOutServer,
  ])

  // ---- Library gate: shown until a library is connected ----
  if (status !== 'ready') {
    return (
      <LibraryGate
        status={status}
        theme={theme}
        toggleTheme={() => toggleTheme()}
        libraryName={libraryName}
        connect={() => void connect()}
        reconnect={() => void reconnect()}
        serverLibrary={serverLibrary}
        connectServer={connectServer}
        loginServer={loginServer}
      />
    )
  }

  // ---- Ready: full app ----
  return (
    <div className={`app${focusMode ? ' focus-mode' : ''}`}>
      <div
        className="sidebar-dock"
        style={{ width: sidebarResize.size }}
      >
        <Sidebar
          tree={tree}
          activeId={activeId}
          open={sidebarOpen}
          libraryName={libraryName}
          query={query}
          searchResults={searchResults}
          onQueryChange={setQuery}
          onSelect={handleSelect}
          justCreatedId={justCreatedId}
          justPlacedId={justPlacedId}
          onCreate={() => {
            void createNote()
            closeSidebar()
          }}
          onCreateInFolder={(folderPath) => void createNote(folderPath)}
          onCreateFolder={handleCreateFolder}
          onDeleteFolder={handleDeleteFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={handleRenameNote}
          onMoveNote={handleMoveNote}
          onRequestMove={setMovingId}
          onDelete={handleDelete}
          onSwitchLibrary={() => void connect()}
          onOpenTrash={() => void openTrash()}
          onOpenProjects={toggleProjects}
          onOpenTasks={toggleTasks}
          onOpenBookmarks={toggleBookmarks}
          onOpenImport={openImport}
          onOpenFolderImport={openFolderImport}
          onDropFiles={handleDropFiles}
          onOpenExport={() => setExportOpen(true)}
        />
        <div {...sidebarResize.handleProps} aria-label="Resize note list" />
      </div>

      <div
        className={`task-dock${tasksOpen ? ' open' : ''}`}
        style={{ width: tasksOpen ? taskResize.size : 0 }}
      >
        <TaskPanel
          open={renderTasks}
          tab={panelTab}
          onTabChange={setPanelTab}
          onClose={() => setTasksOpen(false)}
          tasks={tasks}
          bookmarks={bookmarks}
          onOpenNote={handleSelect}
          activityUnseen={activity.unseen}
          projects={
            <ProjectsView
              projects={projects}
              root={projectsDir}
              unseenByProject={unseenByProject}
              onOpen={openProject}
              onOpenLog={(p) => p.log && handleSelect(p.log)}
              onSetStatus={handleSetProjectStatus}
              onCreate={handleCreateProject}
            />
          }
          activity={
            <ActivityView
              events={activity.events}
              supported={activity.supported}
              seenAt={activity.seenAt}
              onMarkSeen={activity.markSeen}
              kindAt={kindAt}
              onOpen={handleSelect}
              onOpenProject={openProjectByName}
            />
          }
        />
        {tasksOpen && (
          <div {...taskResize.handleProps} aria-label="Resize tasks panel" />
        )}
      </div>

      {/* One scrim for all three drawers. It only becomes visible inside the
          compact media query, so on a desktop the docked panels never dim the
          editor and the scrim can't be clicked. */}
      <div
        className={`scrim${sidebarOpen || tasksOpen ? ' show' : ''}`}
        onClick={closeOverlays}
      />

      <Workspace
        notes={allFiles}
        openNotes={openNotes}
        activeNote={activeNote}
        activeAsset={activeAsset}
        activeContent={activeContent}
        splitNote={splitNote}
        splitAsset={splitAsset}
        splitContent={splitContent}
        readFile={readFile}
        provenanceFor={provenanceFor}
        onDeleteFile={handleDelete}
        onDownloadFile={(id) => void handleDownloadFile(id)}
        focusedPane={focusedPane}
        onFocusPane={setFocusedPane}
        backlinks={backlinks}
        splitBacklinks={splitBacklinks}
        saveState={saveState}
        saveError={saveError}
        lastSavedAt={lastSavedAt}
        isDirty={(id) => dirtyIds.includes(id)}
        libraryEmpty={allFiles.length === 0}
        justCreatedId={justCreatedId}
        justPlacedId={justPlacedId}
        flightFrom={flightFrom}
        enterFrom={enterFrom}
        onSelectTab={handleSelectTab}
        onCloseTab={closeTab}
        onCloseOtherTabs={closeOtherTabs}
        onReorderTabs={moveTab}
        onToggleSplit={toggleSplit}
        onCloseSplit={() => setSplitId(null)}
        onContentChange={saveContent}
        onLeaveNote={nameNoteAfterHeading}
        shouldClaimFocus={shouldClaimFocus}
        onOpenNote={handleOpenInPane}
        onTitleCommit={handleRenameNote}
        onNew={() => void createNote()}
        onSaveMarkdown={() => void handleSaveMarkdown()}
        onExportPdf={() => activeNote && exportToPdf(activeNote.title)}
        onMoveNote={setMovingId}
        onOpenHistory={() => void openHistory()}
        onToggleSidebar={toggleSidebar}
        onToggleFocus={toggleFocus}
        onOpenPalette={() => setPaletteOpen(true)}
        onOpenActivity={toggleActivity}
        activityUnseen={activity.unseen}
        onOpenTrash={() => void openTrash()}
        onOpenImport={openImport}
        onOpenExport={() => setExportOpen(true)}
        onOpenAppearance={() => setThemePickerOpen(true)}
        onOpenAbout={() => setAboutOpen(true)}
        onAddTask={addTaskFromText}
        onAddBookmark={captureSelectionBookmark}
        onFocusedEditorChange={setEditor}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      {focusMode && (
        <button
          type="button"
          className="icon-btn focus-exit"
          onClick={toggleFocus}
          title="Exit focus mode (Esc)"
          aria-label="Exit focus mode"
        >
          <Minimize2 size={18} />
        </button>
      )}

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        notes={allFiles}
        onOpenNote={handleSelect}
      />

      <TrashModal
        open={trashOpen}
        items={trashItems}
        onClose={() => setTrashOpen(false)}
        onRestore={(name) => {
          void restoreFromTrash(name).then(() =>
            showToast('Back where it was, with its history intact'),
          )
        }}
        onDeleteForever={(name) => void deleteFromTrash(name)}
        onEmpty={() => void emptyTrash()}
      />

      <ExportModal
        open={exportOpen}
        dir={libraryDir}
        libraryName={libraryName}
        noteCount={notes.length}
        fileCount={allFiles.length - notes.length}
        onClose={() => setExportOpen(false)}
      />

      {/* Import pickers: one for loose files (or a .zip), one for a whole
          folder. Owned here so both the sidebar and the command palette can
          open them. */}
      <input
        ref={fileInput}
        type="file"
        multiple
        className="visually-hidden"
        onChange={(e) => {
          if (e.target.files?.length) handleImportFiles(e.target.files)
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="visually-hidden"
        {...DIRECTORY_PROPS}
        onChange={(e) => {
          if (e.target.files?.length) handleImportFiles(e.target.files)
        }}
      />

      <ImportModal
        open={importOpen}
        progress={importProgress}
        pending={importPending}
        outcome={importOutcome}
        error={importError}
        tree={tree}
        libraryName={libraryName}
        onImportInto={(folder) => {
          if (importSelection) void writeSelection(importSelection, folder)
        }}
        onClose={closeImport}
      />

      <MoveNoteModal
        open={movingNote !== null}
        noteTitle={movingNote?.title ?? ''}
        currentFolder={movingNote ? folderOf(movingNote.id) : ''}
        tree={tree}
        libraryName={libraryName}
        onMove={(folder) => movingNote && handleMoveNote(movingNote.id, folder)}
        onClose={() => setMovingId(null)}
      />

      <HistoryModal
        open={historyOpen}
        noteTitle={activeNote?.title ?? ''}
        items={historyItems}
        onClose={() => setHistoryOpen(false)}
        onRestore={(name) => {
          void restoreVersion(name).then(() =>
            showToast('Restored — and the version you were on was saved first'),
          )
        }}
        onDelete={(name) => void deleteVersion(name)}
        loadContent={previewVersion}
      />

      <ConfirmDialog
        request={confirmRequest}
        onClose={() => setConfirmRequest(null)}
      />

      {/* Whichever divider is being dragged gets the crew. Only one can be
          active at a time, so they never collide. */}
      <ResizeCrew
        dragging={sidebarResize.dragging}
        drag={sidebarResize.drag}
        handleRef={sidebarResize.handleRef}
      />
      <ResizeCrew
        dragging={taskResize.dragging}
        drag={taskResize.drag}
        handleRef={taskResize.handleRef}
      />

      <ThemePicker
        open={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
        themes={availableThemes}
        palette={palette}
        onPickPalette={(id, e) => setPalette(id, e)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />

      <ShortcutsModal
        open={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
        mod={MOD_KEY}
      />

      <AboutModal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        libraryName={libraryName}
        storage={storageKind}
      />

      <InkFilter />

      {toastAnim.render && (
        <div
          className={`toast${toastAnim.entered ? ' entered' : ''}${
            toastTone === 'danger' ? ' danger' : ''
          }`}
          role={toastTone === 'danger' ? 'alert' : 'status'}
        >
          {toastText}
        </div>
      )}
    </div>
  )
}
