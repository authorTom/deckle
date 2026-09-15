import { useCallback, useMemo } from 'react'
import { EMPTY_STORE, loadBookmarkStore, saveBookmarkStore } from './store'
import { domainOf } from './url'
import { PALETTE } from '../lib/palette'
import { useDataFile } from '../hooks/useDataFile'
import type { Bookmark, BookmarkStore } from './types'

let counter = 0
const uid = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

export interface AddBookmarkInput {
  url: string
  title?: string
  comment?: string
  collectionId?: string | null
  source?: { noteId: string }
}

/** Bookmark state backed by .deckle/bookmarks.json, saved with a debounce. */
export function useBookmarks(dir: FileSystemDirectoryHandle | null) {
  const { store, mutate } = useDataFile<BookmarkStore>(dir, {
    load: loadBookmarkStore,
    save: saveBookmarkStore,
    empty: EMPTY_STORE,
    label: 'bookmarks',
  })

  /** Returns the new bookmark's id (so the UI can open it for editing). */
  const addBookmark = useCallback(
    (input: AddBookmarkInput): string => {
      const id = uid('b')
      const bookmark: Bookmark = {
        id,
        url: input.url,
        title: (input.title ?? '').trim() || domainOf(input.url),
        comment: input.comment ?? '',
        collectionId: input.collectionId ?? null,
        ...(input.source ? { source: input.source } : {}),
        createdAt: Date.now(),
      }
      mutate((s) => ({ ...s, bookmarks: [...s.bookmarks, bookmark] }))
      return id
    },
    [mutate],
  )

  const updateBookmark = useCallback(
    (id: string, patch: Partial<Bookmark>) => {
      mutate((s) => ({
        ...s,
        bookmarks: s.bookmarks.map((b) => (b.id === id ? { ...b, ...patch } : b)),
      }))
    },
    [mutate],
  )

  const deleteBookmark = useCallback(
    (id: string) => {
      mutate((s) => ({ ...s, bookmarks: s.bookmarks.filter((b) => b.id !== id) }))
    },
    [mutate],
  )

  const addCollection = useCallback(
    (name: string): string => {
      const id = uid('c')
      mutate((s) => ({
        ...s,
        collections: [
          ...s.collections,
          {
            id,
            name: name.trim() || 'New collection',
            color: PALETTE[s.collections.length % PALETTE.length],
          },
        ],
      }))
      return id
    },
    [mutate],
  )

  const renameCollection = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      mutate((s) => ({
        ...s,
        collections: s.collections.map((c) =>
          c.id === id ? { ...c, name: trimmed } : c,
        ),
      }))
    },
    [mutate],
  )

  /** Delete a collection; its bookmarks become unfiled. */
  const deleteCollection = useCallback(
    (id: string) => {
      mutate((s) => ({
        version: 1,
        collections: s.collections.filter((c) => c.id !== id),
        bookmarks: s.bookmarks.map((b) =>
          b.collectionId === id ? { ...b, collectionId: null } : b,
        ),
      }))
    },
    [mutate],
  )

  return useMemo(
    () => ({
      store,
      addBookmark,
      updateBookmark,
      deleteBookmark,
      addCollection,
      renameCollection,
      deleteCollection,
    }),
    [
      store,
      addBookmark,
      updateBookmark,
      deleteBookmark,
      addCollection,
      renameCollection,
      deleteCollection,
    ],
  )
}

export type BookmarksApi = ReturnType<typeof useBookmarks>
