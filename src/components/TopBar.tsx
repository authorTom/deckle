import { useEffect, useState } from 'react'
import {
  Activity,
  Columns2,
  Download,
  FileDown,
  FileText,
  FolderInput,
  History,
  Info,
  Maximize2,
  Menu,
  Moon,
  Package,
  Palette,
  Plus,
  Search,
  Sun,
  Trash,
  Upload,
} from 'lucide-react'
import OverflowMenu, { type MenuItem } from './OverflowMenu'
import SaveIndicator from './SaveIndicator'
import type { SaveState } from '../hooks/useNotes'
import type { Theme } from '../hooks/useTheme'
import { MOD_KEY } from '../lib/platform'



interface TopBarProps {
  /** The note the name belongs to. Null when no note is open. */
  noteId: string | null
  title: string
  /**
   * Persist the (renamed) title — called on blur / Enter, not per keystroke.
   * Takes the id the name was typed for rather than reading whichever note is
   * open when the commit lands, so a rename can never overtake a note switch
   * and put one note's name on another's file.
   */
  onTitleCommit: (noteId: string, title: string) => void
  onNew: () => void
  onSaveMarkdown: () => void
  onExportPdf: () => void
  /** Open the dialog that files this note in another folder. */
  onMoveNote: () => void
  /** Download the focused file that isn't a note, as it is. */
  onDownloadFile: () => void
  onOpenHistory: () => void
  onToggleSidebar: () => void
  onToggleFocus: () => void
  onOpenPalette: () => void
  /** Open the agent activity feed. */
  onOpenActivity: () => void
  /** Changes agents made since the person last looked. */
  activityUnseen: number
  onOpenTrash: () => void
  onOpenImport: () => void
  onOpenExport: () => void
  onOpenAppearance: () => void
  /** Open the About box — what this is, and which version. */
  onOpenAbout: () => void
  onToggleSplit: () => void
  isSplit: boolean
  saveState: SaveState
  saveError: string | null
  lastSavedAt: number | null
  theme: Theme
  onToggleTheme: (e: React.MouseEvent) => void
  /** What the focused tab holds: a note, some other file, or nothing. */
  focusedKind: 'note' | 'file' | null
}

/**
 * The chrome above the editor.
 *
 * Only the four controls people reach for constantly stay as buttons; the rest
 * fold into a named menu, which is both less to scan and more discoverable than
 * a row of unlabelled icons.
 */
export default function TopBar({
  noteId,
  title,
  onTitleCommit,
  onNew,
  onSaveMarkdown,
  onExportPdf,
  onMoveNote,
  onDownloadFile,
  onOpenHistory,
  onToggleSidebar,
  onToggleFocus,
  onOpenPalette,
  onOpenActivity,
  activityUnseen,
  onOpenTrash,
  onOpenImport,
  onOpenExport,
  onOpenAppearance,
  onOpenAbout,
  onToggleSplit,
  isSplit,
  saveState,
  saveError,
  lastSavedAt,
  theme,
  onToggleTheme,
  focusedKind,
}: TopBarProps) {
  const hasNote = focusedKind === 'note'
  const hasItem = focusedKind !== null
  // Local state for instant typing; renaming the file happens on commit.
  // The note it was typed for travels with it, along with the name that note
  // started out with — that pair is what decides whether there is a rename to
  // make, and which file it applies to.
  const [draft, setDraft] = useState({ id: noteId, name: title, was: title })

  // Start again whenever a different note takes the top bar, or the name
  // changes underneath us (a switch, or a file renamed to dodge a collision).
  useEffect(() => {
    setDraft({ id: noteId, name: title, was: title })
  }, [noteId, title])

  const commit = () => {
    if (draft.id && draft.name !== draft.was) onTitleCommit(draft.id, draft.name)
  }

  const menuItems: MenuItem[] = [
    {
      id: 'split',
      label: isSplit ? 'Close split view' : 'Split editor',
      Icon: Columns2,
      hint: `${MOD_KEY} \\`,
      run: onToggleSplit,
    },
    {
      id: 'focus',
      label: 'Focus mode',
      Icon: Maximize2,
      hint: `${MOD_KEY} ⇧ F`,
      run: onToggleFocus,
    },
    {
      id: 'theme',
      label: theme === 'dark' ? 'Light mode' : 'Dark mode',
      Icon: theme === 'dark' ? Sun : Moon,
      run: () =>
        onToggleTheme({
          clientX: window.innerWidth - 40,
          clientY: 40,
        } as React.MouseEvent),
    },
    {
      id: 'appearance',
      label: 'Appearance & themes…',
      Icon: Palette,
      run: onOpenAppearance,
    },
    {
      id: 'move',
      label: 'Move to another folder…',
      Icon: FolderInput,
      disabled: !hasItem,
      separated: true,
      run: onMoveNote,
    },
    {
      id: 'history',
      label: 'Version history',
      Icon: History,
      disabled: !hasNote,
      run: onOpenHistory,
    },
    focusedKind === 'file'
      ? {
          id: 'download-file',
          label: 'Download this file',
          Icon: Download,
          run: onDownloadFile,
        }
      : {
          id: 'download-md',
          label: 'Download a copy (.md)',
          Icon: FileText,
          disabled: !hasNote,
          run: onSaveMarkdown,
        },
    {
      id: 'export-pdf',
      label: 'Export to PDF',
      Icon: FileDown,
      disabled: !hasNote,
      run: onExportPdf,
    },
    {
      id: 'import',
      label: 'Import files…',
      Icon: Upload,
      separated: true,
      run: onOpenImport,
    },
    {
      id: 'export-zip',
      label: 'Export library as ZIP…',
      Icon: Package,
      run: onOpenExport,
    },
    {
      id: 'trash',
      label: 'Recycle Bin',
      Icon: Trash,
      separated: true,
      run: onOpenTrash,
    },
    {
      id: 'about',
      label: 'About Deckle',
      Icon: Info,
      run: onOpenAbout,
    },
  ]

  return (
    <div className="topbar">
      <button
        type="button"
        className="icon-btn hamburger"
        onClick={onToggleSidebar}
        aria-label="Toggle notes list"
      >
        <Menu size={20} />
      </button>

      <span className="topbar-title">
        <FileText size={14} aria-hidden="true" />
        <input
          className="topbar-title-input"
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          placeholder="Untitled"
          disabled={!hasItem}
          // Names the field for what it actually is. The heading inside the
          // document is the note's title; this is the file it lives in.
          aria-label="File name"
          title="File name — the note's own heading is in the document"
        />
      </span>

      <SaveIndicator
        state={saveState}
        error={saveError}
        lastSavedAt={lastSavedAt}
      />

      <button
        type="button"
        className="palette-trigger"
        onClick={onOpenPalette}
        title={`Command palette (${MOD_KEY}+K)`}
        aria-label="Open command palette"
      >
        <Search size={15} />
        <span className="palette-trigger-label">Search &amp; commands</span>
        <kbd className="palette-trigger-kbd">{MOD_KEY} K</kbd>
      </button>

      <div className="topbar-actions">
        <button
          type="button"
          className="icon-btn"
          onClick={onNew}
          title="New note"
          aria-label="New note"
        >
          <Plus size={20} />
        </button>
        <button
          type="button"
          className="icon-btn activity-trigger"
          onClick={onOpenActivity}
          title={
            activityUnseen
              ? `Activity — ${activityUnseen} new ${activityUnseen === 1 ? 'change' : 'changes'} by agents`
              : 'Activity'
          }
          aria-label={activityUnseen ? `Activity, ${activityUnseen} new` : 'Activity'}
        >
          <Activity size={18} />
          {activityUnseen > 0 && (
            <span className="icon-btn-count" aria-hidden="true">
              {activityUnseen > 99 ? '99+' : activityUnseen}
            </span>
          )}
        </button>
        <button
          type="button"
          className="icon-btn theme-toggle"
          onClick={onToggleTheme}
          title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
        </button>
        <OverflowMenu items={menuItems} />
      </div>
    </div>
  )
}
