// Everything the command palette (Ctrl/Cmd+K) can do, built from the app's
// state. A function of that state rather than part of App, so the list reads
// as one place: add a command here and it is in the palette.

import type { Editor } from '@tiptap/react'
import {
  Activity,
  Bookmark,
  Bot,
  Columns2,
  FileDown,
  FolderInput,
  FolderKanban,
  FolderOpen,
  FolderPlus,
  History,
  Info,
  Keyboard,
  ListTodo,
  Maximize2,
  Moon,
  Package,
  Palette,
  Plus,
  Server,
  Sun,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { Command } from '../components/CommandPalette'
import { blockActions, formatActions, headingActions, listActions } from '../components/formatActions'
import { supportsDiskPicker } from '../fs/library'
import type { ServerLibraryInfo } from '../fs/remote'
import { exportToPdf } from './exportPdf'
import { EASTER_EGG_KEYWORDS } from '../themes/themes'
import type { ToastTone } from '../hooks/useToast'

export interface CommandContext {
  createNote: () => unknown
  setSidebarOpen: (open: boolean) => void
  splitId: string | null
  toggleSplit: () => void
  toggleFocus: () => void
  theme: 'light' | 'dark'
  toggleTheme: () => void
  setThemePickerOpen: (open: boolean) => void
  connect: () => unknown
  openTrash: () => unknown
  openImport: () => void
  openFolderImport: () => void
  setExportOpen: (open: boolean) => void
  toggleProjects: () => void
  toggleActivity: () => void
  toggleAgents: () => void
  openNewBrief: () => void
  toggleTasks: () => void
  toggleBookmarks: () => void
  setShortcutsOpen: (open: boolean) => void
  setAboutOpen: (open: boolean) => void
  availableThemes: { id: string; name: string }[]
  setPalette: (id: string) => void
  unlockTheme: (id: string) => void
  showToast: (message: string, tone?: ToastTone) => void
  serverLibrary: ServerLibraryInfo | null
  usingServerLibrary: boolean
  signOutServer: () => unknown
  connectServer: () => unknown
  activeNote: { id: string; title: string } | null
  closeTab: (id: string) => void
  setMovingId: (id: string) => void
  openHistory: () => unknown
  handleDelete: (id: string) => void
  editor: Editor | null
  captureSelectionBookmark: () => void
}

export function buildCommands(ctx: CommandContext): Command[] {
  const {
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
  } = ctx
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
      id: 'agents',
      label: 'Agents and briefs',
      icon: Bot,
      keywords: 'agents briefs queue work hermes claude review approve running pull',
      run: toggleAgents,
    },
    {
      id: 'new-brief',
      label: 'New brief for an agent',
      icon: Plus,
      keywords: 'brief task job agent hermes queue assign instructions work stream delegate',
      run: () => openNewBrief(),
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
}
