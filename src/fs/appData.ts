// The hidden folder holding Deckle's own data (tasks, bookmarks) inside the
// user's library.
//
// It was called ".nib" before the app was renamed, and it lives in the user's
// own folder — a folder an app upgrade has no business rewriting behind their
// back. So the new name is what we write, the old name is still read when the
// new one holds nothing yet, and both are treated as ours everywhere it
// matters (exports especially, where dropping the folder loses the planner).
//
// Nothing deletes the legacy folder. Once a library has been saved by this
// version its tasks and bookmarks live under `.deckle`, and the leftover
// `.nib` is a stale copy the user can remove whenever they like.

/** Folder holding Deckle's own metadata inside the library. */
export const DATA_DIR = '.deckle'

/** What that folder was called before the rename. Read-only, never written. */
export const LEGACY_DATA_DIR = '.nib'

/** True for either spelling of the metadata folder. */
export function isDataDir(name: string): boolean {
  return name === DATA_DIR || name === LEGACY_DATA_DIR
}

/**
 * Resolve a slash-separated path inside the metadata folder to its file.
 *
 * `getFileHandle` takes a *name*, not a path: give it "runs/index.json" and the
 * File System Access API throws "Name is not allowed". The server library's
 * adapter resolves paths by URL and never noticed, so a nested file worked
 * there and failed on every local and in-browser library — which is exactly
 * how the assistant's queue came to write run records it could never index.
 * Anything nested walks its directories first, here, once.
 */
async function fileAt(
  folder: FileSystemDirectoryHandle,
  file: string,
  create: boolean,
): Promise<FileSystemFileHandle> {
  const parts = file.split('/').filter(Boolean)
  const name = parts.pop()
  if (!name) throw new TypeError(`not a file path: ${file}`)
  let here = folder
  for (const part of parts) {
    here = await here.getDirectoryHandle(part, { create })
  }
  return await here.getFileHandle(name, { create })
}

/**
 * Read and parse a JSON file from the metadata folder, preferring the current
 * name and falling back to the pre-rename one. Returns null when neither has
 * a readable copy, so callers can start from an empty store.
 */
export async function readDataJson(
  dir: FileSystemDirectoryHandle,
  file: string,
): Promise<unknown | null> {
  for (const folderName of [DATA_DIR, LEGACY_DATA_DIR]) {
    try {
      const folder = await dir.getDirectoryHandle(folderName)
      const handle = await fileAt(folder, file, false)
      return JSON.parse(await (await handle.getFile()).text())
    } catch {
      // Absent, unparseable, or unreadable — try the legacy name, then give up.
    }
  }
  return null
}

/** What reading one of Deckle's data files found. */
export type DataFileRead =
  | { state: 'missing' }
  | { state: 'found'; raw: string; parsed: true; value: unknown }
  | { state: 'found'; raw: string; parsed: false }

/** The "nothing there" answers, as opposed to "there, but I couldn't read it". */
function isMissing(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'NotFoundError' || name === 'TypeMismatchError'
}

/**
 * Read a data file, saying whether it was absent, unparseable, or read.
 *
 * `readDataJson` answers null for all three, which is right for derived
 * files like the run index but wrong for files that *are* the data: a
 * tasks.json that won't parse is not an empty planner, and treating it as one
 * is how the next save writes over every task in it. Anything other than
 * "not found" — a lapsed permission, a server that is down — is thrown, so a
 * caller that couldn't look doesn't conclude there was nothing to see.
 */
export async function readDataFile(
  dir: FileSystemDirectoryHandle,
  file: string,
): Promise<DataFileRead> {
  for (const folderName of [DATA_DIR, LEGACY_DATA_DIR]) {
    let raw: string
    try {
      const folder = await dir.getDirectoryHandle(folderName)
      const handle = await fileAt(folder, file, false)
      raw = await (await handle.getFile()).text()
    } catch (err) {
      if (isMissing(err)) continue
      throw err
    }
    try {
      return { state: 'found', raw, parsed: true, value: JSON.parse(raw) }
    } catch {
      return { state: 'found', raw, parsed: false }
    }
  }
  return { state: 'missing' }
}

/**
 * Copy a data file Deckle can't read to a dated name beside it, before
 * anything replaces it. Returns the copy's path inside the data folder.
 *
 * Throws if the copy can't be written; the caller must then not overwrite the
 * original either.
 */
export async function preserveUnreadable(
  dir: FileSystemDirectoryHandle,
  file: string,
  raw: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const name = `${file.replace(/\.json$/i, '')}.unreadable-${stamp}.json`
  await writeDataText(dir, name, raw)
  return name
}

async function writeDataText(
  dir: FileSystemDirectoryHandle,
  file: string,
  text: string,
): Promise<void> {
  const folder = await dir.getDirectoryHandle(DATA_DIR, { create: true })
  const handle = await fileAt(folder, file, true)
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

/**
 * A folder inside the metadata folder — `.deckle/memory`, and whatever comes
 * next. Reading a missing one throws, which callers read as "nothing stored
 * yet"; pass `create` only when about to write.
 */
export async function dataSubdir(
  dir: FileSystemDirectoryHandle,
  name: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  const folder = await dir.getDirectoryHandle(DATA_DIR, { create })
  return await folder.getDirectoryHandle(name, { create })
}

/** Write a JSON file into the metadata folder, creating the folder if needed. */
export async function writeDataJson(
  dir: FileSystemDirectoryHandle,
  file: string,
  value: unknown,
): Promise<void> {
  await writeDataText(dir, file, JSON.stringify(value, null, 2))
}
