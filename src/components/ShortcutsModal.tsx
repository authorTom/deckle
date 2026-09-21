// The keyboard reference.
//
// Deckle is built for people who would rather not reach for the mouse, and until
// now it kept that a secret: F2 renames, Delete bins, middle-click closes a
// tab, `[[` opens the note picker — none of it written down anywhere, in the
// app or out of it. A tool that rewards fluency owes the reader the list.
//
// Deliberately not a tour and not a tooltip campaign. One sheet, on a key you
// can guess, that tells the truth and gets out of the way.

import { useEffect, useRef } from 'react'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'
import { X } from 'lucide-react'

interface Props {
  open: boolean
  onClose: () => void
  /** "Ctrl" or "⌘", matched to the platform by the caller. */
  mod: string
}

interface Shortcut {
  keys: string[]
  what: string
}

interface Group {
  title: string
  items: Shortcut[]
}

function groups(mod: string): Group[] {
  return [
    {
      title: 'Anywhere',
      items: [
        { keys: [mod, 'K'], what: 'Command palette — every command, and any note by name' },
        { keys: ['?'], what: 'This list' },
        { keys: [mod, 'Shift', 'F'], what: 'Focus mode: hide everything but the page' },
        { keys: [mod, 'Shift', 'A'], what: 'Capture the selection as a task, or open the planner' },
        { keys: [mod, 'Shift', 'W'], what: 'Close the current tab' },
        { keys: ['Esc'], what: 'Close whatever is on top; leave focus mode last' },
      ],
    },
    {
      title: 'Writing',
      items: [
        { keys: ['#', '##', '###'], what: 'Headings — type the hashes and a space' },
        { keys: ['-', '1.', '[]'], what: 'Bulleted, numbered and task lists' },
        { keys: ['>'], what: 'Quote' },
        { keys: ['```'], what: 'Code block' },
        { keys: ['[['], what: 'Link to another note by name' },
        { keys: [mod, 'B'], what: 'Bold' },
        { keys: [mod, 'I'], what: 'Italic' },
      ],
    },
    {
      title: 'The note list',
      items: [
        { keys: ['↑', '↓'], what: 'Move between rows' },
        { keys: ['→', '←'], what: 'Open a folder, or close it and step out' },
        { keys: ['Home', 'End'], what: 'First and last row' },
        { keys: ['A–Z'], what: 'Type a few letters to jump to a note' },
        { keys: ['Enter'], what: 'Open the row' },
        { keys: ['F2'], what: 'Rename' },
        { keys: ['Delete'], what: 'Move to the Recycle Bin — recoverable' },
        { keys: ['Drag'], what: 'Move a note into another folder' },
      ],
    },
    {
      title: 'Tabs',
      items: [
        { keys: ['Middle-click'], what: 'Close a tab' },
        { keys: ['Double-click'], what: 'Close every other tab' },
        { keys: ['Drag'], what: 'Reorder' },
      ],
    },
  ]
}

export default function ShortcutsModal({ open, onClose, mod }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  // Same grammar as every other floating surface: arrives, then leaves faster.
  const anim = useEnterExit(open, OVERLAY_EXIT_MS)
  if (!anim.render) return null

  return (
    <div
      className={`modal-overlay${anim.entered ? ' entered' : ''}`}
      onMouseDown={onClose}
    >
      <div
        className={`modal shortcuts-modal${anim.entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">Keyboard</span>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body shortcuts-body">
          {groups(mod).map((group) => (
            <section key={group.title} className="shortcut-group">
              <h3 className="shortcut-group-title">{group.title}</h3>
              <dl className="shortcut-list">
                {group.items.map((item) => (
                  <div key={item.what} className="shortcut-row">
                    <dt className="shortcut-keys">
                      {item.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dt>
                    <dd className="shortcut-what">{item.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="modal-footer shortcuts-footer">
          <span className="shortcut-footnote">
            Markdown works as you type it — the shorthand above is the whole
            trick, and it goes to disk as the same characters you typed.
          </span>
          {/* This sheet is the closest thing Deckle has to an About box, and a
              version nobody can read is a version nobody can quote in a bug
              report. Selectable, so it can be copied into one. */}
          <span className="shortcut-version">Deckle {__APP_VERSION__}</span>
        </div>
      </div>
    </div>
  )
}
