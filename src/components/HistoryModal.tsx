import { useEffect, useState } from 'react'
import { useEnterExit } from '../hooks/useEnterExit'
import { OVERLAY_EXIT_MS } from '../lib/motion'
import { ChevronDown, ChevronRight, RotateCcw, Trash2, X } from 'lucide-react'
import type { HistoryItem, SnapshotReason } from '../fs/history'
import { timeAgo } from '../lib/format'

interface HistoryModalProps {
  open: boolean
  noteTitle: string
  items: HistoryItem[]
  onClose: () => void
  onRestore: (snapName: string) => void
  onDelete: (snapName: string) => void
  /** Lazily load a snapshot's content for the preview pane. */
  loadContent: (snapName: string) => Promise<string>
}

const REASON_LABEL: Record<SnapshotReason, string> = {
  edit: 'while editing',
  agent: 'before an agent changed it',
  // Written by Deckle 2.x, whose AI assistant snapshotted before each edit.
  ai: 'before an AI edit',
  restore: 'before restore',
}

export default function HistoryModal({
  open,
  noteTitle,
  items,
  onClose,
  onRestore,
  onDelete,
  loadContent,
}: HistoryModalProps) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [contents, setContents] = useState<Record<string, string>>({})

  // Start collapsed each time the modal opens (likely a different note).
  useEffect(() => {
    if (open) {
      setExpanded(null)
      setContents({})
    }
  }, [open])

  // Stays mounted for the length of its exit, so the surface leaves the
  // way it arrived instead of blinking out.
  const anim = useEnterExit(open, OVERLAY_EXIT_MS)
  if (!anim.render) return null

  const toggle = (snapName: string) => {
    if (expanded === snapName) {
      setExpanded(null)
      return
    }
    setExpanded(snapName)
    if (contents[snapName] === undefined) {
      void loadContent(snapName).then((text) =>
        setContents((c) => ({ ...c, [snapName]: text })),
      )
    }
  }

  return (
    <div className={`modal-overlay${anim.entered ? ' entered' : ''}`} onMouseDown={onClose}>
      <div
        className={`modal${anim.entered ? ' entered' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={`Version history for ${noteTitle}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">History — {noteTitle}</span>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="modal-body">
          {items.length === 0 ? (
            <div className="modal-empty">
              No earlier versions yet. Versions are saved periodically while you
              edit, and before an agent changes the note through the API.
            </div>
          ) : (
            items.map((item) => {
              const isOpen = expanded === item.snapName
              return (
                <div key={item.snapName} className="history-item">
                  <div className="trash-row">
                    <button
                      type="button"
                      className="history-toggle"
                      onClick={() => toggle(item.snapName)}
                      aria-expanded={isOpen}
                      aria-label={isOpen ? 'Hide preview' : 'Show preview'}
                    >
                      {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      <span className="trash-info">
                        <span className="trash-title">{timeAgo(item.savedAt)}</span>
                        <span className="trash-meta">
                          {new Date(item.savedAt).toLocaleString()} ·{' '}
                          {REASON_LABEL[item.reason]}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => onRestore(item.snapName)}
                      title="Restore this version"
                      aria-label="Restore this version"
                    >
                      <RotateCcw size={17} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn trash-danger"
                      onClick={() => {
                        if (
                          window.confirm(
                            'Delete this version permanently? This cannot be undone.',
                          )
                        ) {
                          onDelete(item.snapName)
                        }
                      }}
                      title="Delete this version"
                      aria-label="Delete this version"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                  {isOpen && (
                    <pre className="history-preview">
                      {contents[item.snapName] === undefined
                        ? 'Loading…'
                        : contents[item.snapName] || '(empty)'}
                    </pre>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
