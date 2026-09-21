// Note version history, stored in a hidden ".history" folder at the library
// root (skipped by buildTree, like ".trash"). Each snapshot is a full copy of
// a note's content taken before it is overwritten — by an agent writing through
// the API, by a restore, or periodically while the user edits. A JSON index
// records which note each snapshot belongs to and why it was taken.

/** `ai` is only ever read: Deckle 2.x's assistant wrote it before each edit. */
export type SnapshotReason = 'edit' | 'agent' | 'ai' | 'restore'

export interface HistoryItem {
  /** File name within the .history folder (unique). */
  snapName: string
  /** The note this snapshot belongs to, e.g. "Projects/idea.md". */
  noteId: string
  savedAt: number
  reason: SnapshotReason
}

const HISTORY_DIR = '.history'
const HISTORY_INDEX = 'index.json'
/** Snapshots kept per note; older ones are pruned. */
const MAX_PER_NOTE = 20

async function getHistoryDir(
  dir: FileSystemDirectoryHandle,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  return await dir.getDirectoryHandle(HISTORY_DIR, { create })
}

async function writeFile(
  folder: FileSystemDirectoryHandle,
  name: string,
  content: string,
): Promise<void> {
  const handle = await folder.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

async function readIndex(dir: FileSystemDirectoryHandle): Promise<HistoryItem[]> {
  try {
    const folder = await getHistoryDir(dir, false)
    const handle = await folder.getFileHandle(HISTORY_INDEX)
    const parsed = JSON.parse(await (await handle.getFile()).text())
    return Array.isArray(parsed) ? (parsed as HistoryItem[]) : []
  } catch {
    return []
  }
}

async function writeIndex(
  dir: FileSystemDirectoryHandle,
  items: HistoryItem[],
): Promise<void> {
  const folder = await getHistoryDir(dir, true)
  await writeFile(folder, HISTORY_INDEX, JSON.stringify(items, null, 2))
}

/**
 * Save a snapshot of `content` as the previous version of `noteId`, pruning
 * the note's history beyond MAX_PER_NOTE. Best-effort: history must never
 * block or break the write it protects, so callers can fire-and-forget.
 */
export async function snapshotNote(
  dir: FileSystemDirectoryHandle,
  noteId: string,
  content: string,
  reason: SnapshotReason,
): Promise<void> {
  try {
    const folder = await getHistoryDir(dir, true)
    const savedAt = Date.now()
    // Flatten the note path into a unique, filesystem-safe snapshot name.
    const flat = noteId.replace(/\//g, '__')
    const snapName = `${savedAt}_${flat}`
    await writeFile(folder, snapName, content)

    const items = await readIndex(dir)
    items.push({ snapName, noteId, savedAt, reason })

    // Prune the oldest snapshots of this note beyond the cap.
    const mine = items
      .filter((i) => i.noteId === noteId)
      .sort((a, b) => b.savedAt - a.savedAt)
    const excess = mine.slice(MAX_PER_NOTE)
    for (const item of excess) {
      try {
        await folder.removeEntry(item.snapName)
      } catch {
        // already gone
      }
    }
    const keep = new Set(mine.slice(0, MAX_PER_NOTE).map((i) => i.snapName))
    await writeIndex(
      dir,
      items.filter((i) => i.noteId !== noteId || keep.has(i.snapName)),
    )
  } catch {
    // Never let history-keeping break the operation it protects.
  }
}

/** List snapshots for one note (newest first), dropping stale index entries. */
export async function listHistory(
  dir: FileSystemDirectoryHandle,
  noteId: string,
): Promise<HistoryItem[]> {
  let folder: FileSystemDirectoryHandle
  try {
    folder = await getHistoryDir(dir, false)
  } catch {
    return []
  }
  const items = (await readIndex(dir)).filter((i) => i.noteId === noteId)
  const valid: HistoryItem[] = []
  for (const item of items) {
    try {
      await folder.getFileHandle(item.snapName)
      valid.push(item)
    } catch {
      // file missing — skip
    }
  }
  valid.sort((a, b) => b.savedAt - a.savedAt)
  return valid
}

/** Read a snapshot's full content. */
export async function readSnapshot(
  dir: FileSystemDirectoryHandle,
  snapName: string,
): Promise<string> {
  const folder = await getHistoryDir(dir, false)
  const handle = await folder.getFileHandle(snapName)
  return await (await handle.getFile()).text()
}

/** Delete a single snapshot. */
export async function deleteSnapshot(
  dir: FileSystemDirectoryHandle,
  snapName: string,
): Promise<void> {
  try {
    const folder = await getHistoryDir(dir, false)
    await folder.removeEntry(snapName)
  } catch {
    // already gone
  }
  const items = await readIndex(dir)
  await writeIndex(
    dir,
    items.filter((i) => i.snapName !== snapName),
  )
}

/** Point history at a note's new path after a rename/move. */
export async function retargetHistory(
  dir: FileSystemDirectoryHandle,
  fromId: string,
  toId: string,
): Promise<void> {
  try {
    const items = await readIndex(dir)
    let changed = false
    for (const item of items) {
      if (item.noteId === fromId) {
        item.noteId = toId
        changed = true
      }
    }
    if (changed) await writeIndex(dir, items)
  } catch {
    // best-effort
  }
}
