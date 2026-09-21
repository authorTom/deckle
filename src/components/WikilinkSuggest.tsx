import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { LibraryFile } from '../fs/library'
import { iconFor } from '../lib/fileTypes'
import { wikilinkTargetFor } from '../lib/wikilinks'
import { folderOf } from '../lib/format'

interface WikilinkSuggestProps {
  editor: Editor | null
  /** Notes and files alike: `[[` can link a PDF as readily as a note. */
  notes: LibraryFile[]
  /** The note being edited — decides whether a bare title is unambiguous. */
  noteId: string | null
}

/** An unclosed `[[` run immediately before the cursor. */
const TRIGGER = /\[\[([^[\]\n]*)$/
const MAX_RESULTS = 8

interface Trigger {
  query: string
  /** Document position of the opening `[`. */
  from: number
  left: number
  top: number
}

/**
 * Note picker that appears while typing `[[`.
 *
 * Positioned against the caret rather than mounted in the document, so nothing
 * is inserted until a note is chosen and an abandoned `[[` stays plain text.
 */
export default function WikilinkSuggest({
  editor,
  notes,
  noteId,
}: WikilinkSuggestProps) {
  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [index, setIndex] = useState(0)

  // Track the caret for an open `[[`.
  useEffect(() => {
    if (!editor) return
    const sync = () => {
      const { from, empty } = editor.state.selection
      if (!empty) return setTrigger(null)
      // 200 characters back is more than any note name needs, and keeps this
      // off the hot path for large documents.
      const before = editor.state.doc.textBetween(Math.max(0, from - 200), from, '\n')
      const m = TRIGGER.exec(before)
      if (!m) return setTrigger(null)
      const start = from - m[0].length
      const coords = editor.view.coordsAtPos(from)
      setTrigger({ query: m[1], from: start, left: coords.left, top: coords.bottom })
      setIndex(0)
    }
    sync()
    editor.on('update', sync)
    editor.on('selectionUpdate', sync)
    return () => {
      editor.off('update', sync)
      editor.off('selectionUpdate', sync)
    }
  }, [editor])

  const matches = useMemo(() => {
    if (!trigger) return []
    const q = trigger.query.trim().toLowerCase()
    const scored = notes
      .filter((n) => n.id !== noteId)
      .map((n) => {
        const title = n.title.toLowerCase()
        if (!q) return { n, score: 0 }
        if (title === q) return { n, score: 3 }
        if (title.startsWith(q)) return { n, score: 2 }
        if (title.includes(q)) return { n, score: 1 }
        if (n.id.toLowerCase().includes(q)) return { n, score: 0.5 }
        return { n, score: -1 }
      })
      .filter((s) => s.score >= 0)
    scored.sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title))
    return scored.slice(0, MAX_RESULTS).map((s) => s.n)
  }, [trigger, notes, noteId])

  const pick = useCallback(
    (note: LibraryFile) => {
      if (!editor || !trigger) return
      const target = wikilinkTargetFor(note, notes, noteId)
      editor
        .chain()
        .focus()
        .insertContentAt(
          { from: trigger.from, to: editor.state.selection.from },
          `[[${target}]]`,
        )
        .run()
      setTrigger(null)
    },
    [editor, trigger, notes, noteId],
  )

  // Intercept navigation keys before ProseMirror sees them.
  useEffect(() => {
    if (!editor || !trigger || matches.length === 0) return
    const dom = editor.view.dom
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => (i + 1) % matches.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => (i - 1 + matches.length) % matches.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        e.stopPropagation()
        pick(matches[Math.min(index, matches.length - 1)])
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setTrigger(null)
      }
    }
    dom.addEventListener('keydown', onKey, true)
    return () => dom.removeEventListener('keydown', onKey, true)
  }, [editor, trigger, matches, index, pick])

  if (!trigger || matches.length === 0) return null

  return (
    <div
      className="wikilink-suggest"
      style={{ left: trigger.left, top: trigger.top + 6 }}
      role="listbox"
      aria-label="Link to note"
    >
      {matches.map((note, i) => {
        const Icon = iconFor(note)
        return (
        <button
          key={note.id}
          type="button"
          role="option"
          aria-selected={i === index}
          className={`wikilink-suggest-item${i === index ? ' selected' : ''}`}
          onMouseMove={() => setIndex(i)}
          // Mouse-down rather than click: the editor mustn't lose the selection
          // before the insert runs.
          onMouseDown={(e) => {
            e.preventDefault()
            pick(note)
          }}
        >
          <Icon size={14} />
          <span className="wikilink-suggest-title">{note.title}</span>
          <span className="wikilink-suggest-path">{folderOf(note.id)}</span>
        </button>
        )
      })}
    </div>
  )
}
