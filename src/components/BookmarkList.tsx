import { useMemo, useState } from 'react'
import {
  FileText,
  Globe,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react'
import { timeAgo } from '../lib/format'
import { domainOf, normalizeUrl, safeHttpUrl } from '../bookmarks/url'
import type { BookmarksApi } from '../bookmarks/useBookmarks'

interface BookmarkListProps {
  bookmarks: BookmarksApi
  onOpenNote: (noteId: string) => void
}

export default function BookmarkList({
  bookmarks,
  onOpenNote,
}: BookmarkListProps) {
  const [view, setView] = useState('all')
  const [quickUrl, setQuickUrl] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { store } = bookmarks
  const collection =
    view !== 'all' ? store.collections.find((c) => c.id === view) : undefined
  // Fall back to All if the viewed collection was deleted.
  const activeView = view !== 'all' && !collection ? 'all' : view

  const list = useMemo(() => {
    const filtered =
      activeView === 'all'
        ? store.bookmarks
        : store.bookmarks.filter((b) => b.collectionId === activeView)
    return [...filtered].sort((a, b) => b.createdAt - a.createdAt)
  }, [store.bookmarks, activeView])

  const quickAdd = () => {
    const url = normalizeUrl(quickUrl)
    if (!url) return
    const id = bookmarks.addBookmark({ url, collectionId: collection?.id ?? null })
    setQuickUrl('')
    setExpandedId(id) // open for title/comment editing right away
  }

  return (
    <>
      <div className="task-projects bm-nav">
        <button
          type="button"
          className={`task-pill${activeView === 'all' ? ' active' : ''}`}
          onClick={() => setView('all')}
        >
          All
          {store.bookmarks.length > 0 && (
            <span className="task-count">{store.bookmarks.length}</span>
          )}
        </button>
        {store.collections.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`task-pill${activeView === c.id ? ' active' : ''}`}
            onClick={() => setView(c.id)}
          >
            <span className="task-project-dot" style={{ background: c.color }} />
            {c.name}
          </button>
        ))}
        <button
          type="button"
          className="task-pill"
          title="New collection"
          onClick={() => {
            const name = window.prompt('Collection name')
            if (name?.trim()) setView(bookmarks.addCollection(name))
          }}
        >
          <Plus size={13} /> Collection
        </button>
      </div>

      <div className="task-body">
        <div className="task-quickadd">
          <Plus size={15} />
          <input
            value={quickUrl}
            onChange={(e) => setQuickUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                quickAdd()
              }
            }}
            placeholder={
              collection
                ? `Paste a link into ${collection.name}…`
                : 'Paste a link to bookmark it…'
            }
            aria-label="Add a bookmark"
          />
        </div>

        {collection && (
          <div className="task-projhead">
            <span
              className="task-project-dot"
              style={{ background: collection.color }}
            />
            <strong>{collection.name}</strong>
            <button
              type="button"
              className="icon-btn"
              title="Rename collection"
              aria-label="Rename collection"
              onClick={() => {
                const name = window.prompt('Rename collection', collection.name)
                if (name) bookmarks.renameCollection(collection.id, name)
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              className="icon-btn trash-danger"
              title="Delete collection"
              aria-label="Delete collection"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete "${collection.name}"? Its bookmarks stay in All.`,
                  )
                ) {
                  bookmarks.deleteCollection(collection.id)
                  setView('all')
                }
              }}
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}

        {list.length === 0 && (
          <div className="task-empty">
            Nothing saved yet — paste a link above, or select a link in a note
            and use the bookmark button in the selection menu.
          </div>
        )}

        {list.map((b) => {
          const chip =
            activeView === 'all' && b.collectionId
              ? store.collections.find((c) => c.id === b.collectionId)
              : undefined
          const isOpen = expandedId === b.id
          return (
            <div key={b.id} className="task-item">
              <div className="task-row">
                <span className="bm-icon">
                  <Globe size={15} />
                </span>
                <div className="task-main-static">
                  <button
                    type="button"
                    className="bm-title"
                    onClick={() => setExpandedId(isOpen ? null : b.id)}
                    aria-expanded={isOpen}
                  >
                    {b.title || domainOf(b.url)}
                  </button>
                  <span className="task-meta">
                    <a
                      className="bm-link"
                      href={safeHttpUrl(b.url)}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={b.url}
                    >
                      {domainOf(b.url)}
                    </a>
                    · {timeAgo(b.createdAt)}
                    {b.comment && <MessageSquare size={11} aria-label="Has comment" />}
                    {chip && (
                      <span className="task-project">
                        <span
                          className="task-project-dot"
                          style={{ background: chip.color }}
                        />
                        {chip.name}
                      </span>
                    )}
                  </span>
                </div>
                {b.source && (
                  <button
                    type="button"
                    className="icon-btn task-action"
                    title={`Open note: ${b.source.noteId}`}
                    aria-label="Open source note"
                    onClick={() => onOpenNote(b.source!.noteId)}
                  >
                    <FileText size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn task-action trash-danger"
                  title="Delete bookmark"
                  aria-label="Delete bookmark"
                  onClick={() => {
                    if (window.confirm(`Delete bookmark "${b.title}"?`)) {
                      bookmarks.deleteBookmark(b.id)
                    }
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>

              {isOpen && (
                <div className="task-edit">
                  <label>
                    Title
                    <input
                      value={b.title}
                      onChange={(e) =>
                        bookmarks.updateBookmark(b.id, { title: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    URL
                    <input
                      value={b.url}
                      onChange={(e) =>
                        bookmarks.updateBookmark(b.id, { url: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Collection
                    <select
                      value={b.collectionId ?? ''}
                      onChange={(e) =>
                        bookmarks.updateBookmark(b.id, {
                          collectionId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">None</option>
                      {store.collections.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Comment
                    <textarea
                      rows={3}
                      value={b.comment}
                      placeholder="Why did you save this? Prices, thoughts, links…"
                      onChange={(e) =>
                        bookmarks.updateBookmark(b.id, { comment: e.target.value })
                      }
                    />
                  </label>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
