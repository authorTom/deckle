// Bookmark persistence: bookmarks.json in the library's hidden data folder,
// alongside tasks.

import { preserveUnreadable, readDataFile, writeDataJson } from '../fs/appData'
import type { BookmarkStore } from './types'

const BOOKMARKS_FILE = 'bookmarks.json'

/** Shown before a library loads, and for one with no bookmarks yet. Never mutated. */
export const EMPTY_STORE: BookmarkStore = Object.freeze({
  version: 1,
  bookmarks: [],
  collections: [],
}) as BookmarkStore

export function isBookmarkStore(value: unknown): value is BookmarkStore {
  const store = value as BookmarkStore | null
  return (
    store?.version === 1 &&
    Array.isArray(store.bookmarks) &&
    Array.isArray(store.collections)
  )
}

export async function loadBookmarkStore(
  dir: FileSystemDirectoryHandle,
): Promise<BookmarkStore> {
  const read = await readDataFile(dir, BOOKMARKS_FILE)
  if (read.state === 'missing') return EMPTY_STORE
  if (read.parsed && isBookmarkStore(read.value)) return read.value

  // Same rule as tasks.json: an unreadable file is copied aside before the
  // next save can replace it, and if the copy fails, nothing is saved.
  const backup = await preserveUnreadable(dir, BOOKMARKS_FILE, read.raw)
  console.warn(
    `[deckle] .deckle/${BOOKMARKS_FILE} could not be read; kept a copy as .deckle/${backup} and started with no bookmarks`,
  )
  return EMPTY_STORE
}

export async function saveBookmarkStore(
  dir: FileSystemDirectoryHandle,
  store: BookmarkStore,
): Promise<void> {
  await writeDataJson(dir, BOOKMARKS_FILE, store)
}
