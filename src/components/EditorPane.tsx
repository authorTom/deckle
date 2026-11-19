import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, EditorContent, type Editor as TiptapEditor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { BookmarkPlus, SquareCheckBig, X } from 'lucide-react'
import WikilinkSuggest from './WikilinkSuggest'
import Outline from './Outline'
import Backlinks from './Backlinks'
import NoteProperties from './NoteProperties'
import { formatActions, listActions, type FormatAction } from './formatActions'
import { libraryPathFor } from '../editor/image'
import { editorExtensions } from '../editor/extensions'
import { REHIGHLIGHT_META } from '../editor/highlight'
import { serialize } from '../editor/markdown'
import { joinFrontmatter, splitFrontmatter } from '../lib/frontmatter'
import { resolveWikilink, type Backlink } from '../lib/wikilinks'
import {
  prefersReducedMotion,
  type EnterFrom,
  type FlightOrigin,
} from '../lib/motion'
import type { LibraryFile } from '../fs/library'

/**
 * The bubble menu's settings, kept as constants: TipTap 3's BubbleMenu sends a
 * transaction whenever these props change identity, and this pane re-renders
 * on every transaction — so values made fresh each render loop forever.
 */
const BUBBLE_OPTIONS = { placement: 'top', offset: 8, flip: true, shift: { padding: 8 } } as const
const showBubbleForSelection = ({ state }: { state: { selection: { empty: boolean } } }) => !state.selection.empty

interface EditorPaneProps {
  noteId: string
  content: string
  /**
   * Every note and file in the library — wikilink resolution and the `[[`
   * picker need it, and a link may point at a PDF as readily as a note.
   */
  notes: LibraryFile[]
  /** Read a file from the library, for images the note embeds. */
  loadFile: (path: string) => Promise<Blob | null>
  backlinks: Backlink[]
  /** True when this pane owns the toolbar and the topbar title. */
  focused: boolean
  /** The note was created moments ago — play the ink bloom across the page. */
  isNew?: boolean
  /** Screen rect of whatever was clicked to open this note. */
  flightFrom?: FlightOrigin | null
  /** Side to slide in from, when the switch had a direction. */
  enterFrom?: EnterFrom
  /** Rendered as a pane header when the editor is split. */
  paneLabel?: string
  onClosePane?: () => void
  onFocusPane: () => void
  onContentChange: (noteId: string, markdown: string) => void
  onOpenNote: (noteId: string) => void
  onAddTask: (text: string) => void
  onAddBookmark: () => void
  onEditorReady: (editor: TiptapEditor | null) => void
  /** The user has left this note; a chance to name the file after its heading. */
  onLeaveNote?: (noteId: string, markdown: string) => void
  /**
   * Asked once, at mount, before the pane takes the caret. Lets the app veto
   * the claim when this mount is only a rename re-keying the pane — otherwise
   * naming a file would snatch focus back from whatever the user just clicked.
   */
  shouldClaimFocus?: () => boolean
}

/**
 * One editing surface: the TipTap instance plus everything anchored to it —
 * selection bubble menu, `[[` picker, outline, and backlinks.
 *
 * The workspace renders one of these per pane, so all pane-local state stays
 * here and nothing has to be duplicated when a second pane opens.
 */
export default function EditorPane({
  noteId,
  content,
  notes,
  loadFile,
  backlinks,
  focused,
  isNew = false,
  flightFrom,
  enterFrom,
  paneLabel,
  onClosePane,
  onFocusPane,
  onContentChange,
  onOpenNote,
  onAddTask,
  onAddBookmark,
  onEditorReady,
  onLeaveNote,
  shouldClaimFocus,
}: EditorPaneProps) {
  // The wikilink extension is built once, but resolution has to see the current
  // note list — so it reads through refs rather than being rebuilt per render.
  const notesRef = useRef(notes)
  notesRef.current = notes
  const noteIdRef = useRef(noteId)
  noteIdRef.current = noteId
  const onOpenNoteRef = useRef(onOpenNote)
  onOpenNoteRef.current = onOpenNote

  // Images the note embeds from the library are shown from blob URLs, which
  // are this pane's to free when it goes.
  const loadFileRef = useRef(loadFile)
  loadFileRef.current = loadFile
  const imageUrls = useRef<string[]>([])
  useEffect(
    () => () => {
      for (const url of imageUrls.current) URL.revokeObjectURL(url)
    },
    [],
  )
  const resolveImage = useCallback(async (src: string) => {
    const path = libraryPathFor(src, noteIdRef.current)
    if (!path) return null
    const blob = await loadFileRef.current(path)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    imageUrls.current.push(url)
    return url
  }, [])

  // Front matter never reaches ProseMirror, which would read the fence as a
  // rule and a heading and write that back. It is held here, shown above the
  // text, and put back on top of whatever the editor serialises.
  const { frontmatter: loadedFrontmatter, body } = useMemo(
    () => splitFrontmatter(content),
    [content],
  )
  const [frontmatter, setFrontmatter] = useState(loadedFrontmatter)
  const frontmatterRef = useRef(loadedFrontmatter)
  useEffect(() => {
    frontmatterRef.current = loadedFrontmatter
    setFrontmatter(loadedFrontmatter)
  }, [loadedFrontmatter])

  const extensions = useMemo(
    () =>
      editorExtensions({
        resolveImage,
        resolveWikilink: (target) => resolveWikilink(target, notesRef.current, noteIdRef.current),
        onOpenWikilink: (id) => onOpenNoteRef.current(id),
      }),
    // Built once; everything it reads goes through refs or stable callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const editor = useEditor({
    extensions,
    content: '',
    // TipTap 3 stopped re-rendering on every transaction by default. The
    // bubble menu's active states are read during render, so keep the v2
    // behaviour for this pane.
    shouldRerenderOnTransaction: true,
    // The document is a multi-line text field; say so, and say which note.
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': paneLabel ? `${paneLabel} — note text` : 'Note text',
      },
    },
    onUpdate: ({ editor, transaction }) => {
      // Code blocks being coloured in once their languages load: no edit.
      if (transaction.getMeta(REHIGHLIGHT_META)) return
      onContentChange(noteId, joinFrontmatter(frontmatterRef.current, serialize(editor)))
    },
    onFocus: onFocusPane,
    // Leaving the note is the safe moment to let it take its name from its own
    // first heading: doing it mid-keystroke would rename the file, change the
    // note's id, and remount this pane under the user's hands.
    onBlur: ({ editor }) => onLeaveNote?.(noteId, serialize(editor)),
  })

  /** New properties from the strip: saved with the text as it stands. */
  const changeFrontmatter = (next: string) => {
    frontmatterRef.current = next
    setFrontmatter(next)
    if (editor) onContentChange(noteId, joinFrontmatter(next, serialize(editor)))
  }

  // Load the note's markdown into the editor when it's ready, and re-sync if the
  // content changes underneath us — e.g. an agent rewrites the open note.
  // `content` only changes on a fresh load from disk (typing doesn't update it),
  // so this won't fire on the user's own keystrokes. The guard avoids resetting
  // the cursor when the incoming text already matches what's in the editor.
  useEffect(() => {
    if (!editor) return
    const text = body.replace(/^\s*\n/, '')
    if (text === serialize(editor)) return
    editor.commands.setContent(text, { emitUpdate: false })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, body])

  // Take the caret as soon as the content is in, so the first keystroke after
  // opening or creating a note lands in the document. Without this the ink
  // bloom washes across the page announcing "write here" and the caret is on
  // document.body — the whole opening moment ends in a dead keystroke.
  //
  // Captured at mount rather than read live: a pane claims the caret only if it
  // owned focus when it appeared. Reading the prop would yank the selection to
  // the top of the document the moment the user clicked into the other pane.
  const ownedFocusAtMount = useRef(focused)
  useEffect(() => {
    if (!editor || !ownedFocusAtMount.current) return
    if (shouldClaimFocus && !shouldClaimFocus()) return
    // Never from something the person is already typing in — the command
    // palette opened while the note was still loading, say. The keystrokes
    // meant for it would land in the note instead.
    const current = document.activeElement as HTMLElement | null
    if (
      current &&
      current !== document.body &&
      !editor.view.dom.contains(current) &&
      (current.closest('[role="dialog"]') ||
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(current.tagName) ||
        current.isContentEditable)
    ) {
      return
    }
    // 'start', not 'end': the note has just flown its heading into place and
    // the reader is looking at the top of it. Focusing the end would scroll a
    // long note to its last line and throw that away.
    editor.commands.focus('start')
  }, [editor])

  // The note's heading flies out of whatever was clicked to open it — the tab,
  // or the row in the tree. Declared after the effect that loads the content,
  // and deliberately a passive effect rather than a layout one, so the heading
  // exists in the DOM by the time this measures it.
  const flown = useRef(false)
  useEffect(() => {
    if (!editor || !flightFrom || flown.current || prefersReducedMotion()) return
    // Once per mount, and a mount is one note. Without the guard React's
    // development double-invoke restarts the animation a frame in.
    flown.current = true
    const heading = editor.view.dom.querySelector('h1')
    if (!heading) return // nothing to fly to; the pane's own slide carries it
    const to = heading.getBoundingClientRect()
    if (!to.width || !to.height) return
    // Scale from the source's height, so the title appears to grow out of a
    // label rather than being dropped in at full size.
    const scale = Math.max(0.2, Math.min(1, flightFrom.height / to.height))
    heading.animate(
      [
        {
          transform: `translate(${flightFrom.x - to.x}px, ${
            flightFrom.y - to.y
          }px) scale(${scale})`,
          opacity: 0.3,
        },
        { transform: 'none', opacity: 1 },
      ],
      { duration: 380, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
    )
  }, [editor, flightFrom])

  // Wikilink decorations are derived at render time from the note list. That
  // list changes independently of the document, so nudge the view when it does —
  // otherwise a link stays "broken" until the next keystroke.
  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false))
  }, [editor, notes])

  // Expose the editor instance so the workspace can drive the toolbar and the
  // command palette can run formatting against the focused pane.
  useEffect(() => {
    onEditorReady(editor ?? null)
    return () => onEditorReady(null)
  }, [editor, onEditorReady])

  const addSelectionTask = () => {
    if (!editor) return
    const { from, to } = editor.state.selection
    if (from === to) return
    onAddTask(editor.state.doc.textBetween(from, to, ' '))
  }

  return (
    <div
      className={`pane${focused ? ' focused' : ''}`}
      onMouseDown={onFocusPane}
    >
      {paneLabel && (
        <div className="pane-header">
          <span className="pane-title">{paneLabel}</span>
          {onClosePane && (
            <button
              type="button"
              className="icon-btn pane-close"
              onClick={onClosePane}
              title="Close this pane"
              aria-label="Close this pane"
            >
              <X size={15} />
            </button>
          )}
        </div>
      )}

      {/* Sits on the pane, not the text column: clipped to the column it would
          have hard rectangular edges, which reads as a coloured box rather than
          ink soaking outward. */}
      {isNew && (
        <div className="ink-bloom" aria-hidden="true">
          <span />
        </div>
      )}

      <div className="content">
        <div
          className="editor-wrap"
          // The page enters from the direction it was travelled to: pick a tab
          // to the right and the note arrives from the right. Falls back to the
          // neutral rise when the move had no direction (a click in the tree).
          style={
            enterFrom
              ? ({
                  '--enter-x': enterFrom === 'right' ? '28px' : '-28px',
                  '--enter-y': '0px',
                } as React.CSSProperties)
              : undefined
          }
        >

          {editor && (
            <BubbleMenu
              editor={editor}
              options={BUBBLE_OPTIONS}
              shouldShow={showBubbleForSelection}
              className="bubble-menu"
            >
              <>
                  <button
                    type="button"
                    className="toolbar-btn"
                    title="Add as task (Ctrl/Cmd+Shift+A)"
                    aria-label="Add selection as task"
                    onClick={addSelectionTask}
                  >
                    <SquareCheckBig size={16} />
                  </button>
                  <button
                    type="button"
                    className="toolbar-btn"
                    title="Bookmark link in selection"
                    aria-label="Bookmark link in selection"
                    onClick={onAddBookmark}
                  >
                    <BookmarkPlus size={16} />
                  </button>
                  <span className="toolbar-divider" />
                  {[...formatActions, ...listActions].map((action: FormatAction) => {
                    const { Icon, label, run, isActive } = action
                    return (
                      <button
                        key={action.name}
                        type="button"
                        className={`toolbar-btn${isActive(editor) ? ' active' : ''}`}
                        title={label}
                        aria-label={label}
                        onClick={() => run(editor)}
                      >
                        <Icon size={16} />
                      </button>
                    )
                  })}
              </>
            </BubbleMenu>
          )}

          <NoteProperties frontmatter={frontmatter} onChange={changeFrontmatter} />

          <EditorContent editor={editor} />

          <Backlinks backlinks={backlinks} onOpenNote={onOpenNote} />
        </div>

        <Outline editor={editor} />
      </div>

      <WikilinkSuggest editor={editor} notes={notes} noteId={noteId} />
    </div>
  )
}
