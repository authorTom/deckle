import { useCallback, useEffect, useState } from 'react'
import { FilePlus, Upload } from 'lucide-react'
import type { Editor as TiptapEditor } from '@tiptap/react'
import TopBar from './TopBar'
import Toolbar from './Toolbar'
import NoteTabs from './NoteTabs'
import EditorPane from './EditorPane'
import EditorSkeleton from './EditorSkeleton'
import FileViewer from './FileViewer'
import type { AssetFile, LibraryFile, NoteFile } from '../fs/library'
import type { ActivityEvent } from '../activity/activity'
import type { Pane, SaveState } from '../hooks/useNotes'
import type { Backlink } from '../lib/wikilinks'
import type { EnterFrom, FlightOrigin } from '../lib/motion'
import type { Theme } from '../hooks/useTheme'

interface WorkspaceProps {
  /** Every note and file, for wikilinks — which may point at either. */
  notes: LibraryFile[]
  /** The tab strip: notes and files, in order. */
  openNotes: LibraryFile[]
  activeNote: NoteFile | null
  /** The primary pane's file, when its tab is a file rather than a note. */
  activeAsset: AssetFile | null
  activeContent: string | null
  splitNote: NoteFile | null
  splitAsset: AssetFile | null
  splitContent: string | null
  /** Read a file's bytes from the library. */
  readFile: (id: string) => Promise<Blob>
  /** The newest thing an agent did to a path, for a file's provenance line. */
  provenanceFor: (id: string) => ActivityEvent | null
  onDeleteFile: (id: string) => void
  onDownloadFile: (id: string) => void
  focusedPane: Pane
  onFocusPane: (pane: Pane) => void
  backlinks: Backlink[]
  splitBacklinks: Backlink[]
  saveState: SaveState
  saveError: string | null
  lastSavedAt: number | null
  isDirty: (id: string) => boolean
  /** The library has no notes at all — show the first-run state in the panes. */
  libraryEmpty: boolean
  /** Note created moments ago, for the ink bloom and the wet-ink tab. */
  justCreatedId: string | null
  /** Note restored moments ago: wet ink, but no bloom — it was placed, not made. */
  justPlacedId: string | null
  /** Where the current switch was triggered from, for the title flight. */
  flightFrom: FlightOrigin | null
  enterFrom?: EnterFrom

  onSelectTab: (id: string, origin: FlightOrigin | null) => void
  onCloseTab: (id: string) => void
  onCloseOtherTabs: (id: string) => void
  onReorderTabs: (id: string, toIndex: number) => void
  onToggleSplit: () => void
  onCloseSplit: () => void

  onContentChange: (noteId: string, markdown: string) => void
  /** Leaving a note is the moment it may take its name from its first heading. */
  onLeaveNote: (noteId: string, markdown: string) => void
  /** Veto for a pane taking the caret at mount (see EditorPane). */
  shouldClaimFocus: () => boolean
  onOpenNote: (id: string) => void
  onTitleCommit: (noteId: string, title: string) => void
  onNew: () => void
  onSaveMarkdown: () => void
  onExportPdf: () => void
  /** Ask where the focused note (or file) should live. */
  onMoveNote: (noteId: string) => void
  onOpenHistory: () => void
  onToggleSidebar: () => void
  onToggleFocus: () => void
  onOpenPalette: () => void
  onOpenActivity: () => void
  activityUnseen: number
  onOpenTrash: () => void
  onOpenImport: () => void
  onOpenExport: () => void
  onOpenAppearance: () => void
  onOpenAbout: () => void
  onAddTask: (text: string) => void
  onAddBookmark: () => void
  /** The editor belonging to whichever pane has focus, for the palette. */
  onFocusedEditorChange: (editor: TiptapEditor | null) => void
  theme: Theme
  onToggleTheme: (e: React.MouseEvent) => void
}

/**
 * What a brand-new library opens on — no notes and no files.
 *
 * Lives inside the panes rather than over the whole app: it used to be an
 * opaque overlay across `.app`, which covered the sidebar it was telling you
 * to use — while `pointer-events: none` left that hidden sidebar clickable.
 * Here the note list stays visible beside it, so "bring in Markdown" points at
 * something the reader can actually see.
 */
function EmptyLibrary({
  onNew,
  onImport,
}: {
  onNew: () => void
  onImport: () => void
}) {
  return (
    <div className="empty-state">
      <h2>Nothing here yet</h2>
      <p>
        Start a note, or bring in what you already have — Markdown, PDFs,
        spreadsheets, images, a whole folder or a ZIP. Nested folders keep their
        structure and nothing is overwritten. An agent connected to this library
        adds its work here as it goes.
      </p>
      <div className="empty-actions">
        <button type="button" className="btn-primary" onClick={onNew}>
          <FilePlus size={18} />
          New note
        </button>
        <button type="button" className="btn-secondary" onClick={onImport}>
          <Upload size={16} />
          Import files…
        </button>
      </div>
    </div>
  )
}

/**
 * Everything to the right of the sidebar: title chrome, the tab strip, one
 * shared formatting toolbar, and one or two editor panes.
 *
 * The toolbar lives here rather than inside each pane so a split shows one set
 * of formatting controls, bound to whichever pane the user last touched.
 */
export default function Workspace({
  notes,
  openNotes,
  activeNote,
  activeAsset,
  activeContent,
  splitNote,
  splitAsset,
  splitContent,
  readFile,
  provenanceFor,
  onDeleteFile,
  onDownloadFile,
  focusedPane,
  onFocusPane,
  backlinks,
  splitBacklinks,
  saveState,
  saveError,
  lastSavedAt,
  isDirty,
  libraryEmpty,
  justCreatedId,
  justPlacedId,
  flightFrom,
  enterFrom,
  onSelectTab,
  onCloseTab,
  onCloseOtherTabs,
  onReorderTabs,
  onToggleSplit,
  onCloseSplit,
  onContentChange,
  onLeaveNote,
  shouldClaimFocus,
  onOpenNote,
  onTitleCommit,
  onNew,
  onSaveMarkdown,
  onExportPdf,
  onMoveNote,
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
  onAddTask,
  onAddBookmark,
  onFocusedEditorChange,
  theme,
  onToggleTheme,
}: WorkspaceProps) {
  const [primaryEditor, setPrimaryEditor] = useState<TiptapEditor | null>(null)
  const [splitEditor, setSplitEditor] = useState<TiptapEditor | null>(null)

  const focusPrimary = useCallback(() => onFocusPane('primary'), [onFocusPane])
  const focusSplit = useCallback(() => onFocusPane('split'), [onFocusPane])

  const splitItem: LibraryFile | null = splitNote ?? splitAsset
  const activeItem: LibraryFile | null = activeNote ?? activeAsset
  const inSplit = focusedPane === 'split' && splitItem !== null
  const focusedItem = inSplit ? splitItem : activeItem
  // Only a note has an editor for the toolbar and the palette to drive.
  const focusedEditor = inSplit
    ? splitNote
      ? splitEditor
      : null
    : activeNote
      ? primaryEditor
      : null

  useEffect(() => {
    onFocusedEditorChange(focusedEditor)
  }, [focusedEditor, onFocusedEditorChange])

  const split = splitItem !== null

  // A note's images come from the library; a missing one shows as missing.
  const loadFile = useCallback(
    (path: string) => readFile(path).catch(() => null),
    [readFile],
  )

  return (
    <div className="main">
      <TopBar
        noteId={focusedItem?.id ?? null}
        title={focusedItem?.title ?? ''}
        onTitleCommit={onTitleCommit}
        onNew={onNew}
        onSaveMarkdown={onSaveMarkdown}
        onExportPdf={onExportPdf}
        onMoveNote={() => focusedItem && onMoveNote(focusedItem.id)}
        onDownloadFile={() => focusedItem && onDownloadFile(focusedItem.id)}
        onOpenHistory={onOpenHistory}
        onToggleSidebar={onToggleSidebar}
        onToggleFocus={onToggleFocus}
        onOpenPalette={onOpenPalette}
        onOpenActivity={onOpenActivity}
        activityUnseen={activityUnseen}
        onOpenTrash={onOpenTrash}
        onOpenImport={onOpenImport}
        onOpenExport={onOpenExport}
        onOpenAppearance={onOpenAppearance}
        onOpenAbout={onOpenAbout}
        onToggleSplit={onToggleSplit}
        isSplit={split}
        saveState={saveState}
        saveError={saveError}
        lastSavedAt={lastSavedAt}
        theme={theme}
        onToggleTheme={onToggleTheme}
        focusedKind={focusedItem ? (focusedItem.kind === 'file' ? 'note' : 'file') : null}
      />

      <NoteTabs
        notes={openNotes}
        activeId={activeNote?.id ?? null}
        splitId={splitNote?.id ?? null}
        onSelect={onSelectTab}
        onClose={onCloseTab}
        onCloseOthers={onCloseOtherTabs}
        onReorder={onReorderTabs}
        onToggleSplit={onToggleSplit}
        isDirty={isDirty}
        justCreatedId={justCreatedId}
        justPlacedId={justPlacedId}
      />

      {focusedEditor && <Toolbar editor={focusedEditor} />}

      <div className={`panes${split ? ' split' : ''}`}>
        {libraryEmpty ? (
          <EmptyLibrary onNew={onNew} onImport={onOpenImport} />
        ) : activeAsset ? (
          <FileViewer
            key={activeAsset.id}
            file={activeAsset}
            load={readFile}
            focused={focusedPane === 'primary' || !split}
            paneLabel={split ? activeAsset.title : undefined}
            onFocusPane={focusPrimary}
            backlinks={backlinks}
            onOpenNote={onOpenNote}
            provenance={provenanceFor(activeAsset.id)}
            onMove={() => onMoveNote(activeAsset.id)}
            onDelete={() => onDeleteFile(activeAsset.id)}
          />
        ) : activeNote && activeContent !== null ? (
          <EditorPane
            key={activeNote.id}
            noteId={activeNote.id}
            content={activeContent}
            notes={notes}
            loadFile={loadFile}
            backlinks={backlinks}
            focused={focusedPane === 'primary' || !split}
            isNew={activeNote.id === justCreatedId}
            flightFrom={flightFrom}
            enterFrom={enterFrom}
            paneLabel={split ? activeNote.title : undefined}
            onFocusPane={focusPrimary}
            onContentChange={onContentChange}
            onLeaveNote={onLeaveNote}
            shouldClaimFocus={shouldClaimFocus}
            onOpenNote={onOpenNote}
            onAddTask={onAddTask}
            onAddBookmark={onAddBookmark}
            onEditorReady={setPrimaryEditor}
          />
        ) : (
          <EditorSkeleton />
        )}

        {split && (
          <>
            <div className="pane-divider" aria-hidden="true" />
            {splitAsset ? (
              <FileViewer
                key={`split-${splitAsset.id}`}
                file={splitAsset}
                load={readFile}
                focused={focusedPane === 'split'}
                paneLabel={splitAsset.title}
                onClosePane={onCloseSplit}
                onFocusPane={focusSplit}
                backlinks={splitBacklinks}
                onOpenNote={onOpenNote}
                provenance={provenanceFor(splitAsset.id)}
                onMove={() => onMoveNote(splitAsset.id)}
                onDelete={() => onDeleteFile(splitAsset.id)}
              />
            ) : splitNote && splitContent !== null ? (
              <EditorPane
                key={`split-${splitNote.id}`}
                noteId={splitNote.id}
                content={splitContent}
                notes={notes}
                loadFile={loadFile}
                backlinks={splitBacklinks}
                focused={focusedPane === 'split'}
                paneLabel={splitNote.title}
                onClosePane={onCloseSplit}
                onFocusPane={focusSplit}
                onContentChange={onContentChange}
                onLeaveNote={onLeaveNote}
                shouldClaimFocus={shouldClaimFocus}
                onOpenNote={onOpenNote}
                onAddTask={onAddTask}
                onAddBookmark={onAddBookmark}
                onEditorReady={setSplitEditor}
              />
            ) : (
              <EditorSkeleton />
            )}
          </>
        )}
      </div>
    </div>
  )
}
