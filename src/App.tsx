import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Minimize2 } from 'lucide-react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import Sidebar from './components/Sidebar'
import Workspace from './components/Workspace'
import CommandPalette from './components/CommandPalette'
import { buildCommands } from './lib/paletteCommands'
import TrashModal from './components/TrashModal'
import ExportModal from './components/ExportModal'
import HistoryModal from './components/HistoryModal'
import CompareModal, { type CompareRequest } from './components/CompareModal'
import ConfirmDialog, { type ConfirmRequest } from './components/ConfirmDialog'
import ThemePicker from './components/ThemePicker'
import ResizeCrew from './components/ResizeCrew'
import TaskPanel, { type PanelTab } from './components/TaskPanel'
import ProjectsView from './components/ProjectsView'
import ActivityView from './components/ActivityView'
// Both are only needed once someone opens the Agents tab or writes a brief, so
// they stay out of the first screen's download (see vite.config.ts).
const AgentsView = lazy(() => import('./components/AgentsView'))
const NewBriefModal = lazy(() => import('./components/NewBriefModal'))
import { useBriefs } from './briefs/useBriefs'
import { applyAction, attachContext, createBrief, groupOf, type Brief, type BriefAction, type NewBrief } from './briefs/briefs'
import { selectionFromFiles } from './lib/importMarkdown'
import { useActivity } from './activity/useActivity'
import { useReview } from './activity/useReview'
import type { ActivityEvent } from './activity/activity'
import { readSnapshot } from './fs/history'
import { timeAgo } from './lib/format'
import { isChatter, lastEventFor } from './activity/activity'
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
import { deriveTitleFromMarkdown, isGeneratedTitle } from './lib/format'
import { MOD_KEY } from './lib/platform'
import { exportToPdf } from './lib/exportPdf'
import { downloadMarkdown } from './lib/exportMarkdown'
import { serialize } from './editor/markdown'
import ImportModal from './components/ImportModal'
import { useImport } from './hooks/useImport'
import { useToast } from './hooks/useToast'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import MoveNoteModal from './components/MoveNoteModal'
import { useTheme } from './hooks/useTheme'
import { downloadBlob } from './lib/zip'
import { readNote as readNoteFromLibrary } from './fs/library'
import { useNotes } from './hooks/useNotes'
import type { EnterFrom, FlightOrigin } from './lib/motion'
import { useBacklinks } from './hooks/useBacklinks'
import { useResizable } from './hooks/useResizable'
import { useDeferredUnmount } from './hooks/useDeferredUnmount'
import { COMPACT_QUERY, PHONE_QUERY, useMediaQuery } from './hooks/useMediaQuery'
import { usePhoneKeyboard } from './hooks/usePhoneKeyboard'
import MobileNav, { type MobileSection } from './components/MobileNav'
import { todayStr } from './tasks/dates'
import { supportsDiskPicker } from './fs/library'

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
  // Narrower still, the drawers become full screens under a bottom tab bar,
  // and while the person is writing that bar gives way to the formatting bar.
  const phone = useMediaQuery(PHONE_QUERY)
  const writing = usePhoneKeyboard(phone)

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

  /**
   * The tab bar's one verb. Unlike the desktop toggles, going to the section
   * you are already in keeps you there — a tab bar is a place, not a switch —
   * and "Note" is simply every screen put away.
   */
  const goToSection = useCallback((section: MobileSection) => {
    if (section === 'note') {
      setSidebarOpen(false)
      setTasksOpen(false)
    } else if (section === 'files') {
      setTasksOpen(false)
      setSidebarOpen(true)
    } else {
      setSidebarOpen(false)
      setPanelTab(section)
      setTasksOpen(true)
    }
  }, [])

  // On a phone a section is a screen, and the system back gesture should leave
  // it rather than leave Deckle. Opening one pushes a single history entry;
  // back pops it and puts the screens away. Moving between sections reuses the
  // entry, and closing one from the UI takes its entry back off, so back never
  // has to be pressed twice to go somewhere.
  const screenOpen = phone && (sidebarOpen || tasksOpen)
  useEffect(() => {
    if (!screenOpen) {
      if ((window.history.state as { deckleScreen?: boolean } | null)?.deckleScreen) {
        window.history.back()
      }
      return
    }
    if (!(window.history.state as { deckleScreen?: boolean } | null)?.deckleScreen) {
      window.history.pushState({ deckleScreen: true }, '')
    }
    const onPop = () => {
      setSidebarOpen(false)
      setTasksOpen(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [screenOpen])
  const toggleBookmarks = useCallback(
    () => openPanelTab('bookmarks'),
    [openPanelTab],
  )
  const toggleProjects = useCallback(() => openPanelTab('projects'), [openPanelTab])
  const toggleActivity = useCallback(() => openPanelTab('activity'), [openPanelTab])
  const toggleAgents = useCallback(() => openPanelTab('agents'), [openPanelTab])
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
  // What the tab bar's Tasks badge counts: the same "Today" the planner shows.
  const tasksDue = useMemo(() => {
    const today = todayStr()
    return tasks.store.tasks.filter((t) => !t.completedAt && !t.deletedAt && t.due && t.due <= today).length
  }, [tasks.store.tasks])

  // Bookmarks (stored in the library's .deckle/bookmarks.json)
  const bookmarks = useBookmarks(libraryDir)

  // Wikilink backlinks, one index per pane — for a file as much as a note.
  const backlinks = useBacklinks(libraryDir, allFiles, activeId)
  const splitBacklinks = useBacklinks(libraryDir, allFiles, splitId)

  // What agents are doing to the library. Polls the server library's activity
  // log and reloads the tree and any open note when it moves, so a file an
  // agent saves appears without anyone refreshing the page.
  const activity = useActivity(libraryDir, libraryName, reload)
  // Which of the agents' writes the person has signed off, kept in the library.
  const review = useReview(libraryDir, activity.events)
  const [compare, setCompare] = useState<CompareRequest | null>(null)

  // Projects: the folders in Projects/ (or wherever the server was told).
  const projectsDir =
    (usingServerLibrary ? serverLibrary?.projectsDir : undefined) ?? DEFAULT_PROJECTS_DIR
  const projects = useProjects(libraryDir, tree, projectsDir)
  // Briefs: work queued for agents, inside those projects.
  const { briefs, runs, refreshRuns } = useBriefs(libraryDir, tree, projectsDir)
  const [newBrief, setNewBrief] = useState<{ open: boolean; project?: string }>({ open: false })
  // Mounted from its first opening on, so closing it can animate out.
  const [newBriefLoaded, setNewBriefLoaded] = useState(false)
  const openNewBrief = useCallback((project?: string) => {
    setNewBriefLoaded(true)
    setNewBrief({ open: true, project })
  }, [])
  const closeNewBrief = useCallback(() => setNewBrief((b) => ({ ...b, open: false })), [])
  /** Every agent the library has heard from: polled for briefs, or written anything. */
  const agentNames = useMemo(() => {
    const names = new Set(Object.keys(runs.agents))
    for (const event of activity.events) if (event.actor) names.add(event.actor)
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [runs.agents, activity.events])
  const briefsNeedingYou = useMemo(() => briefs.filter((b) => groupOf(b) === 'needs-you').length, [briefs])

  // Transient confirmation toast (e.g. after capturing a task).
  const toast = useToast()
  const showToast = toast.showToast

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
  const [exportOpen, setExportOpen] = useState(false)
  const getDrawersOutOfTheWay = useCallback(() => {
    if (compact) closeOverlays()
    else closeSidebar()
  }, [compact, closeOverlays, closeSidebar])
  const importer = useImport(importNotes, getDrawersOutOfTheWay)
  const { openImport, openFolderImport } = importer

  // Keyboard shortcuts: Ctrl/Cmd+K opens the palette, Ctrl/Cmd+Shift+F toggles
  // focus, Ctrl/Cmd+\ splits, Escape exits focus.
  useGlobalShortcuts({
    togglePalette: () => setPaletteOpen((o) => !o),
    toggleSplit,
    toggleFocus,
    // Capture the selection as a task; with no selection, toggle the panel.
    captureTask: () => {
      if (!captureSelectionTask()) toggleTasks()
    },
    showShortcuts: () => setShortcutsOpen(true),
    closeTab: () => {
      if (activeId) closeTab(activeId)
    },
    escape: () => {
      // Close the topmost layer first; only exit focus mode if nothing is open.
      // (The command palette and confirm dialog handle their own Escape.)
      if (compare) setCompare(null)
      else if (historyOpen) setHistoryOpen(false)
      else if (trashOpen) setTrashOpen(false)
      // On a phone the drawers are the topmost layer, so they go before
      // focus mode does.
      else if (compact && (sidebarOpen || tasksOpen)) closeOverlays()
      else setFocusMode(false)
    },
  })

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
      if (event.project && !isChatter(event)) out.set(event.project, (out.get(event.project) ?? 0) + 1)
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
  /** An agent's change to a note: the version it replaced, against the note now. */
  const compareEvent = useCallback(
    (event: ActivityEvent) => {
      const path = event.to ?? event.path
      if (!libraryDir || !event.before || !path) return
      const dir = libraryDir
      const before = event.before
      setCompare({
        title: `${path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')} — ${event.actor} ${event.action} it ${timeAgo(event.at)}`,
        beforeLabel: `Before ${event.actor}'s change`,
        afterLabel: 'Now',
        loadBefore: () => readSnapshot(dir, before),
        loadAfter: () => readNoteFromLibrary(dir, path),
        onOpen: () => handleSelect(path),
      })
    },
    [libraryDir, handleSelect],
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
  const handleBriefAction = useCallback(
    async (brief: Brief, action: BriefAction): Promise<boolean> => {
      if (!libraryDir) return false
      try {
        const status = await applyAction(libraryDir, brief, action)
        // Signing off a brief signs off the agent's writes inside it.
        if (action.kind === 'approve') {
          review.markReviewed(
            activity.events.filter((e) => (e.to ?? e.path ?? '').startsWith(`${brief.id}/`)),
          )
        }
        await reload()
        void refreshRuns()
        const said: Record<BriefAction['kind'], string> = {
          queue: 'queued',
          'to-draft': 'back to draft',
          approve: status === 'done' ? 'approved' : 'approved; the next run is scheduled',
          'request-changes': 'sent back with your changes',
          answer: 'answered and queued again',
          cancel: 'cancelled',
          rerun: 'queued to run again',
        }
        showToast(`${brief.title} ${said[action.kind]}`)
        return true
      } catch (err) {
        showToast(err instanceof Error && err.message ? err.message : `Couldn't update ${brief.title}`, 'danger')
        return false
      }
    },
    [libraryDir, review, activity.events, reload, refreshRuns, showToast],
  )
  const handleCreateBrief = useCallback(
    async (input: NewBrief, newProject: { name: string; summary: string } | null): Promise<boolean> => {
      if (!libraryDir) return false
      try {
        let projectName = input.project
        if (newProject) {
          const overview = await createProject(libraryDir, projectsDir, newProject.name, newProject.summary)
          // The folder may have been given a free name ("Acme 1").
          projectName = overview.slice(projectsDir.length + 1, overview.lastIndexOf('/'))
        }
        await createBrief(libraryDir, projectsDir, { ...input, project: projectName })
        await reload()
        setPanelTab('agents')
        setTasksOpen(true)
        showToast(input.queue ? `${input.title.trim()} queued` : `${input.title.trim()} saved as a draft`)
        return true
      } catch {
        return false
      }
    },
    [libraryDir, projectsDir, reload, showToast],
  )
  const handleAttachToBrief = useCallback(
    (brief: Brief, files: FileList) => {
      if (!libraryDir) return
      void selectionFromFiles(files)
        .then((selection) => attachContext(libraryDir, brief, selection.items))
        .then(() => reload())
        .then(() => showToast(`Attached to ${brief.title}`))
        .catch(() => showToast(`Couldn't attach files to ${brief.title}`, 'danger'))
    },
    [libraryDir, reload, showToast],
  )
  const readLibraryText = useCallback(
    (path: string) => (libraryDir ? readNoteFromLibrary(libraryDir, path) : Promise.resolve('')),
    [libraryDir],
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
  const commands = useMemo(() => {
    return buildCommands({
      createNote,
      setSidebarOpen,
      splitId,
      toggleSplit,
      toggleFocus,
      theme,
      toggleTheme,
      setThemePickerOpen,
      connect,
      openTrash,
      openImport,
      openFolderImport,
      setExportOpen,
      toggleProjects,
      toggleActivity,
      toggleAgents,
      openNewBrief,
      toggleTasks,
      toggleBookmarks,
      setShortcutsOpen,
      setAboutOpen,
      availableThemes,
      setPalette,
      unlockTheme,
      showToast,
      serverLibrary,
      usingServerLibrary,
      signOutServer,
      connectServer,
      activeNote,
      closeTab,
      setMovingId,
      openHistory,
      handleDelete,
      editor,
      captureSelectionBookmark,
    })
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
    toggleAgents,
    openNewBrief,
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
    <div
      className={[
        'app',
        focusMode ? 'focus-mode' : '',
        phone ? 'phone' : '',
        phone && writing ? 'writing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
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
          onDropFiles={importer.dropFiles}
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
              review={review}
              onCompare={compareEvent}
            />
          }
          agentsCount={briefsNeedingYou}
          agents={
            <Suspense fallback={<div className="task-empty">Loading…</div>}>
              <AgentsView
                briefs={briefs}
                runs={runs}
                supported={activity.supported}
                agentNames={agentNames}
                onOpen={handleSelect}
                onNewBrief={() => openNewBrief()}
                onAction={handleBriefAction}
                onAttach={handleAttachToBrief}
                readText={readLibraryText}
              />
            </Suspense>
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

      {phone && (
        <MobileNav
          current={
            sidebarOpen
              ? 'files'
              : !tasksOpen
                ? 'note'
                : panelTab === 'projects' || panelTab === 'agents' || panelTab === 'tasks'
                  ? panelTab
                  : null
          }
          onGo={goToSection}
          agentsCount={briefsNeedingYou}
          tasksDue={tasksDue}
        />
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
        ref={importer.fileInput}
        type="file"
        multiple
        className="visually-hidden"
        aria-label="Import files"
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files?.length) importer.importFiles(e.target.files)
        }}
      />
      <input
        ref={importer.folderInput}
        type="file"
        multiple
        className="visually-hidden"
        aria-label="Import a folder"
        tabIndex={-1}
        {...DIRECTORY_PROPS}
        onChange={(e) => {
          if (e.target.files?.length) importer.importFiles(e.target.files)
        }}
      />

      <ImportModal
        open={importer.dialog.open}
        progress={importer.dialog.progress}
        pending={importer.dialog.pending}
        outcome={importer.dialog.outcome}
        error={importer.dialog.error}
        tree={tree}
        libraryName={libraryName}
        onImportInto={importer.importInto}
        onClose={importer.close}
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

      <CompareModal request={compare} onClose={() => setCompare(null)} />

      {newBrief.open || newBriefLoaded ? (
        <Suspense fallback={null}>
          <NewBriefModal
            open={newBrief.open}
            projects={projects.map((p) => p.name)}
            initialProject={newBrief.project}
            agentNames={agentNames}
            onClose={closeNewBrief}
            onCreate={handleCreateBrief}
          />
        </Suspense>
      ) : null}

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

      {toast.anim.render && (
        <div
          className={`toast${toast.anim.entered ? ' entered' : ''}${
            toast.tone === 'danger' ? ' danger' : ''
          }`}
          role={toast.tone === 'danger' ? 'alert' : 'status'}
        >
          {toast.text}
        </div>
      )}
    </div>
  )
}
