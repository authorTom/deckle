import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { CornerDownLeft, Search, type LucideIcon } from 'lucide-react'
import type { LibraryFile } from '../fs/library'
import { folderOf } from '../lib/format'
import { iconFor } from '../lib/fileTypes'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'

/** Keep in step with --dur-base in theme.css. */

export interface Command {
  id: string
  label: string
  hint?: string
  icon?: LucideIcon
  /** Section header to group under (defaults to "Commands"). */
  section?: string
  /** Extra terms to match against (synonyms). */
  keywords?: string
  /**
   * Never listed, only found: shown when a search matches its keywords and
   * never on the empty list. For things that should reward looking.
   */
  hidden?: boolean
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
  commands: Command[]
  /** Notes and files, openable by name. */
  notes: LibraryFile[]
  onOpenNote: (id: string) => void
}

type Item =
  | { kind: 'command'; cmd: Command }
  | { kind: 'note'; note: LibraryFile }

export default function CommandPalette({
  open,
  onClose,
  commands,
  notes,
  onOpenNote,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { render, entered } = useEnterExit(open, OVERLAY_EXIT_MS)

  // Reset whenever the palette opens. Focus is handled by autoFocus on the
  // input: the element doesn't exist on the render where `open` flips, so
  // focusing from here would fire against a null ref.
  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
  }, [open])

  // Escape closes the palette wherever focus happens to be — the input keeps
  // it in the common case, but a click on a row or the footer moves it off.
  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation() // don't also drop the app out of focus mode
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const { items, commandCount } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const cmds = commands.filter((c) => {
      const matches =
        c.label.toLowerCase().includes(q) ||
        (c.keywords ?? '').toLowerCase().includes(q)
      // Hidden commands never pad the default list — they only turn up for
      // someone who typed the right thing.
      if (c.hidden) return q.length > 0 && matches
      return !q || matches
    })
    const ns = notes
      .filter(
        (n) =>
          !q ||
          n.title.toLowerCase().includes(q) ||
          folderOf(n.id).toLowerCase().includes(q),
      )
      .slice(0, 50)
    const list: Item[] = [
      ...cmds.map((cmd): Item => ({ kind: 'command', cmd })),
      ...ns.map((note): Item => ({ kind: 'note', note })),
    ]
    return { items: list, commandCount: cmds.length }
  }, [query, commands, notes])

  // Keep the selection in range as the filtered list changes.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  // Keep the selected row visible.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!render) return null

  const run = (item: Item) => {
    onClose()
    if (item.kind === 'command') item.cmd.run()
    else onOpenNote(item.note.id)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => (items.length ? (i + 1) % items.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = items[index]
      if (item) run(item)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <div
      className={`palette-overlay${entered ? ' entered' : ''}`}
      onMouseDown={onClose}
    >
      <div
        className={`palette${entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <Search size={18} />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command, or the name of a note or file…"
            aria-label="Command palette"
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty">
              Nothing matches. Commands and note titles are searched; note
              contents are searched from the sidebar.
            </div>
          )}
          {items.map((item, i) => {
            const Icon =
              item.kind === 'command'
                ? item.cmd.icon ?? CornerDownLeft
                : iconFor(item.note)
            const key =
              item.kind === 'command' ? `c-${item.cmd.id}` : `n-${item.note.id}`
            const path = item.kind === 'note' ? folderOf(item.note.id) : ''

            // Section header: when a command's section changes, or at the
            // first note.
            let header: string | null = null
            if (item.kind === 'command') {
              const section = item.cmd.section ?? 'Commands'
              const prev = i > 0 ? items[i - 1] : null
              const prevSection =
                prev && prev.kind === 'command'
                  ? prev.cmd.section ?? 'Commands'
                  : null
              if (section !== prevSection) header = section
            } else if (i === commandCount) {
              header = 'Notes and files'
            }

            return (
              <Fragment key={key}>
                {header && <div className="palette-section">{header}</div>}
                <div
                  data-index={i}
                  className={`palette-item${i === index ? ' selected' : ''}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(item)}
                >
                  <Icon size={16} className="palette-item-icon" />
                  <span className="palette-item-label">
                    {item.kind === 'command' ? item.cmd.label : item.note.title}
                  </span>
                  {item.kind === 'command' && item.cmd.hint && (
                    <span className="palette-hint">{item.cmd.hint}</span>
                  )}
                  {item.kind === 'note' && path && (
                    <span className="palette-hint">{path}</span>
                  )}
                </div>
              </Fragment>
            )
          })}
        </div>

        <div className="palette-footer">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>esc close</span>
          {/* The palette is where people already come looking for a way to do
              something; it is the honest place to mention there is a list. */}
          <span className="palette-footer-end">? all shortcuts</span>
        </div>
      </div>
    </div>
  )
}
