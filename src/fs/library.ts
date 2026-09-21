// Plain-Markdown library backed by the File System Access API.
// Each note is a real `.md` file inside a folder the user picks. Subfolders are
// walked recursively, so notes can be organised in nested folders. A note's
// `id` is its path relative to the library root (POSIX "/" separators).
//
// The library holds more than notes: whatever an agent produced or a person
// dropped in — PDFs, spreadsheets, images, documents — sits beside the notes
// as ordinary files. The tree carries those as `kind: 'asset'`, so everything
// that only understands notes (the editor, backlinks, note search) can keep
// asking for `kind: 'file'` and never be handed a spreadsheet.
//
// Three storage backends, sharing the same `FileSystemDirectoryHandle` API:
//   • On-disk folder — Chromium's `showDirectoryPicker` lets the user pick a
//     real folder, so notes are visible on disk (open them in any Markdown
//     editor, sync, back up, etc).
//   • Origin Private File System (OPFS) — `navigator.storage.getDirectory`,
//     supported by Safari and Firefox, gives a sandboxed per-origin directory
//     that exposes the identical handle interface. Notes live privately inside
//     the browser. This is the fallback when the disk picker isn't available.
//   • Server library — when Deckle is deployed with Docker and given a volume, the
//     container holds the .md files and src/fs/remote.ts implements the same
//     handle interface against its file API. Notes are then reachable from any
//     device and nothing is stored locally.

import { isDataDir } from './appData'
import {
  fetchRemoteTree,
  isRemoteHandle,
  moveRemoteEntry,
  readRemoteFile,
  writeRemoteFile,
} from './remote'

export interface NoteFile {
  kind: 'file'
  /** Path relative to the library root, e.g. "Projects/idea.md". Unique. */
  id: string
  /** File name including extension, e.g. "idea.md". */
  name: string
  /** File name without the .md extension (display title). */
  title: string
  updatedAt: number
}

/** Any file in the library that isn't a note: a PDF, an image, a spreadsheet… */
export interface AssetFile {
  kind: 'asset'
  /** Path relative to the library root, e.g. "Projects/Acme/report.pdf". */
  id: string
  /** File name including extension. */
  name: string
  /** What the tree and tabs show — for a file, its whole name. */
  title: string
  /** Lower-case extension without the dot, '' if none. */
  ext: string
  size: number
  updatedAt: number
}

export interface NoteFolder {
  kind: 'folder'
  /** Path relative to the library root, e.g. "Projects". */
  id: string
  name: string
  children: TreeNode[]
}

/** Something that opens in a tab: a note or any other file. */
export type LibraryFile = NoteFile | AssetFile

export type TreeNode = NoteFile | AssetFile | NoteFolder

const MD_EXT = /\.md$/i
const ILLEGAL = /[\\/:*?"<>|]/g

/** Operating-system clutter that is never anyone's work (dotfiles are skipped anyway). */
const CLUTTER = new Set(['thumbs.db', 'desktop.ini', 'icon\r'])

/** A path is a note when it is a `.md` file. */
export function isNoteId(id: string): boolean {
  return MD_EXT.test(id)
}

/** The lower-case extension of a file name, without the dot ('' if none). */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** "report.final.pdf" → { stem: "report.final", ext: ".pdf" }. */
function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

/** Name of the OPFS subfolder that holds the library, so it has a friendly
 *  display name (the OPFS root itself has an empty name). */
const OPFS_LIBRARY_NAME = 'My Notes'

/** Whether the on-disk folder picker (Chromium) is available. When false, the
 *  app falls back to OPFS, which Safari and Firefox support. */
export function supportsDiskPicker(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

export function supportsOpfs(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === 'function'
  )
}

/** Whether *any* supported storage backend is available. */
export function isLibrarySupported(): boolean {
  return supportsDiskPicker() || supportsOpfs()
}

/** Open (creating if needed) the OPFS-backed library. Unlike a disk folder this
 *  is a single fixed location, so it can be re-opened on every load without a
 *  user gesture and without persisting a handle. */
export async function openOpfsLibrary(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return await root.getDirectoryHandle(OPFS_LIBRARY_NAME, { create: true })
}

export async function pickLibrary(): Promise<FileSystemDirectoryHandle> {
  if (supportsDiskPicker()) {
    return await (
      window as unknown as {
        showDirectoryPicker: (opts?: {
          id?: string
          mode?: 'read' | 'readwrite'
        }) => Promise<FileSystemDirectoryHandle>
      }
      // Pre-rename picker id, kept so the browser still reopens at the folder
      // the user last chose.
    ).showDirectoryPicker({ id: 'notes-vault', mode: 'readwrite' })
  }
  // OPFS fallback: a single private library stored inside the browser.
  return await openOpfsLibrary()
}

export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  request: boolean,
): Promise<boolean> {
  // OPFS handles have no permission model (access is implicit), so they don't
  // expose queryPermission/requestPermission — treat them as always granted.
  if (typeof handle.queryPermission !== 'function') return true
  const opts = { mode: 'readwrite' as const }
  if ((await handle.queryPermission(opts)) === 'granted') return true
  if (!request) return false
  return (await handle.requestPermission?.(opts)) === 'granted'
}

function baseName(fileName: string): string {
  return fileName.replace(MD_EXT, '')
}

function sanitizeName(name: string, fallback: string): string {
  const cleaned = name.replace(ILLEGAL, '').trim()
  return cleaned || fallback
}

function sanitizeTitle(title: string): string {
  return sanitizeName(title, 'Untitled')
}

function splitPath(id: string): { parentPath: string; name: string } {
  const idx = id.lastIndexOf('/')
  if (idx === -1) return { parentPath: '', name: id }
  return { parentPath: id.slice(0, idx), name: id.slice(idx + 1) }
}

/**
 * Join two path parts, tolerating an empty one on either side.
 *
 * Either half can legitimately be empty — the library root has no name, and an
 * imported file that came with no folder of its own contributes nothing to the
 * middle — and a naive join turns those into "Projects/" and then
 * "Projects//idea.md", an id that matches no note in the tree.
 */
function joinPath(parentPath: string, name: string): string {
  if (!parentPath) return name
  if (!name) return parentPath
  return `${parentPath}/${name}`
}

async function getDirByPath(
  dir: FileSystemDirectoryHandle,
  path: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  if (!path) return dir
  let cur = dir
  for (const segment of path.split('/')) {
    // An empty segment is not a directory called "" — it is a stray slash, and
    // asking a backend for it is undefined at best.
    if (!segment) continue
    cur = await cur.getDirectoryHandle(segment, { create })
  }
  return cur
}

function asAsyncEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<FileSystemHandle> {
  // values() is an async iterable not present in older TS DOM libs.
  return (dir as unknown as {
    values: () => AsyncIterable<FileSystemHandle>
  }).values()
}

/**
 * How many file operations to have in flight at once.
 *
 * Every one of these is I/O — a stat, a read, a write — and awaiting them one
 * after another means the library spends its time waiting rather than working.
 * Bounded rather than unbounded: `Promise.all` over a few thousand handles at
 * once will exhaust file descriptors on a local library and flood the server
 * library with simultaneous requests, which is slower than doing less at once.
 */
const IO_CONCURRENCY = 16

/** Map over `items` with at most `limit` operations in flight, preserving order. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length <= 1) {
    return items.length ? [await fn(items[0], 0)] : []
  }
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

/** Recursively build the folder/file tree. Hidden entries (dotfiles) are
 *  skipped; empty folders are kept so newly created folders remain visible.
 *  Notes and other files sort together by what the tree shows, matching the
 *  server's walk in server/library-api.mjs. */
export async function buildTree(
  dir: FileSystemDirectoryHandle,
  prefix = '',
): Promise<TreeNode[]> {
  // Server library: walking the handle interface would cost one HTTP request per
  // file, so let the server do the walk and return the finished tree.
  if (isRemoteHandle(dir)) {
    return applyPrefix((await fetchRemoteTree(dir)) as TreeNode[], prefix)
  }

  // Drain the directory first, then do the I/O.
  //
  // The walk used to `await` inside the iteration: one getFile() per note,
  // strictly one at a time, plus a serial descent into every subfolder. The
  // whole tree is rebuilt after every create, rename, move, delete and import,
  // so that serial stat storm was the cost sitting behind "creating a note got
  // slow" — and it grew with the size of the library rather than with the size
  // of the change. The entries are independent, so they're gathered and then
  // resolved concurrently.
  const dirEntries: { id: string; handle: FileSystemDirectoryHandle }[] = []
  const fileEntries: { id: string; name: string; handle: FileSystemFileHandle }[] = []

  for await (const entry of asAsyncEntries(dir)) {
    if (entry.name.startsWith('.')) continue // skip .git, other editors' config, etc.
    const id = joinPath(prefix, entry.name)

    if (entry.kind === 'directory') {
      dirEntries.push({ id, handle: entry as FileSystemDirectoryHandle })
    } else if (!CLUTTER.has(entry.name.toLowerCase())) {
      fileEntries.push({ id, name: entry.name, handle: entry as FileSystemFileHandle })
    }
  }

  const [folders, files] = await Promise.all([
    mapConcurrent(
      dirEntries,
      IO_CONCURRENCY,
      async ({ id, handle }): Promise<NoteFolder> => ({
        kind: 'folder',
        id,
        name: handle.name,
        children: await buildTree(handle, id),
      }),
    ),
    mapConcurrent(
      fileEntries,
      IO_CONCURRENCY,
      async ({ id, name, handle }): Promise<LibraryFile> => {
        const file = await handle.getFile()
        return MD_EXT.test(name)
          ? { kind: 'file', id, name, title: baseName(name), updatedAt: file.lastModified }
          : {
              kind: 'asset',
              id,
              name,
              title: name,
              ext: extensionOf(name),
              size: file.size,
              updatedAt: file.lastModified,
            }
      },
    ),
  ])

  folders.sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.title.localeCompare(b.title))
  return [...folders, ...files]
}

/** The server returns ids relative to the folder it walked; re-root them so a
 *  subfolder walk (e.g. trashFolder) yields library-relative ids like the
 *  handle-based path does. */
function applyPrefix(nodes: TreeNode[], prefix: string): TreeNode[] {
  if (!prefix) return nodes
  return nodes.map((node) =>
    node.kind === 'folder'
      ? { ...node, id: joinPath(prefix, node.id), children: applyPrefix(node.children, prefix) }
      : { ...node, id: joinPath(prefix, node.id) },
  )
}

/** Every note in a tree, in tree order. Other files are left out. */
export function flattenFiles(nodes: TreeNode[]): NoteFile[] {
  const out: NoteFile[] = []
  for (const node of nodes) {
    if (node.kind === 'file') out.push(node)
    else if (node.kind === 'folder') out.push(...flattenFiles(node.children))
  }
  return out
}

/** Every file in a tree that isn't a note. */
export function flattenAssets(nodes: TreeNode[]): AssetFile[] {
  const out: AssetFile[] = []
  for (const node of nodes) {
    if (node.kind === 'asset') out.push(node)
    else if (node.kind === 'folder') out.push(...flattenAssets(node.children))
  }
  return out
}

/** A file's bytes, for previewing or downloading it. */
export async function readBlob(
  dir: FileSystemDirectoryHandle,
  id: string,
): Promise<File> {
  const { parentPath, name } = splitPath(id)
  const parent = await getDirByPath(dir, parentPath)
  return await (await parent.getFileHandle(name)).getFile()
}

/** Write a file's bytes, creating its folders. For files dropped into the library. */
export async function writeBlob(
  dir: FileSystemDirectoryHandle,
  id: string,
  data: Blob,
): Promise<void> {
  const { parentPath, name } = splitPath(id)
  const parent = await getDirByPath(dir, parentPath, true)
  await writeRaw(parent, name, data)
}

export async function readNote(
  dir: FileSystemDirectoryHandle,
  id: string,
): Promise<string> {
  // One request instead of a stat plus a download (see readRemoteFile).
  if (isRemoteHandle(dir)) return await readRemoteFile(dir, id)

  const { parentPath, name } = splitPath(id)
  const parent = await getDirByPath(dir, parentPath)
  const handle = await parent.getFileHandle(name)
  return await (await handle.getFile()).text()
}

/**
 * Write content to a note file (creating folders/file if needed).
 *
 * Deliberately returns nothing. It used to re-open the file it had just written
 * and stat it for a `lastModified`, which put a second round trip on the
 * autosave path — the one operation that runs every few hundred milliseconds
 * while someone is typing — to produce a number the only caller threw away.
 */
export async function writeNote(
  dir: FileSystemDirectoryHandle,
  id: string,
  content: string,
): Promise<void> {
  // The debounced save runs as you type, so it gets a single-request path
  // rather than write + re-open + download (see writeRemoteFile).
  if (isRemoteHandle(dir)) {
    await writeRemoteFile(dir, id, content)
    return
  }

  const { parentPath, name } = splitPath(id)
  const parent = await getDirByPath(dir, parentPath, true)
  await writeRaw(parent, name, content)
}

export async function deleteNote(
  dir: FileSystemDirectoryHandle,
  id: string,
): Promise<void> {
  const { parentPath, name } = splitPath(id)
  const parent = await getDirByPath(dir, parentPath)
  await parent.removeEntry(name)
}

async function fileExists(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await parent.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

/**
 * Find a free file name within `parent`, appending " 1", " 2", … on collision
 * — before the extension, so "report.pdf" becomes "report 1.pdf".
 */
async function uniqueName(
  parent: FileSystemDirectoryHandle,
  desired: string,
  exceptName?: string,
): Promise<string> {
  if (desired === exceptName) return desired
  if (!(await fileExists(parent, desired))) return desired
  const { stem, ext } = splitExt(desired)
  for (let i = 1; ; i++) {
    const candidate = `${stem} ${i}${ext}`
    if (candidate === exceptName || !(await fileExists(parent, candidate))) {
      return candidate
    }
  }
}

/** Create a new note in `folderPath` (root if empty). */
export async function createNote(
  dir: FileSystemDirectoryHandle,
  folderPath = '',
): Promise<NoteFile> {
  const parent = await getDirByPath(dir, folderPath, true)
  const name = await uniqueName(parent, 'Untitled.md')
  await writeRaw(parent, name, '')
  return {
    kind: 'file',
    id: joinPath(folderPath, name),
    name,
    title: baseName(name),
    // The caller refreshes the tree immediately, which reads the real mtime off
    // disk; this is only what the note is stamped with in the meantime.
    updatedAt: Date.now(),
  }
}

/** Write text or bytes to `name` within a directory handle (creating it if needed). */
async function writeRaw(
  parent: FileSystemDirectoryHandle,
  name: string,
  content: string | Blob,
): Promise<void> {
  const handle = await parent.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

/**
 * Rename a note's file to match a new title, keeping it in the same folder.
 * Returns the new id. Assumes latest content is already on disk.
 */
export async function renameNote(
  dir: FileSystemDirectoryHandle,
  id: string,
  newTitle: string,
): Promise<string> {
  return await renameEntry(dir, id, `${sanitizeTitle(newTitle)}.md`)
}

/**
 * Rename a file that isn't a note. Its extension is kept unless the new name
 * brings one of its own, so renaming "Q3.pdf" to "Q3 final" gives "Q3 final.pdf".
 */
export async function renameAsset(
  dir: FileSystemDirectoryHandle,
  id: string,
  newName: string,
): Promise<string> {
  const { name } = splitPath(id)
  const cleaned = sanitizeName(newName, name)
  const { ext } = splitExt(name)
  const desired = ext && !extensionOf(cleaned) ? `${cleaned}${ext}` : cleaned
  return await renameEntry(dir, id, desired)
}

/** Rename a file in place, byte for byte, dodging collisions. Returns the new id. */
async function renameEntry(
  dir: FileSystemDirectoryHandle,
  id: string,
  desired: string,
): Promise<string> {
  const { parentPath, name } = splitPath(id)
  if (desired === name) return id

  const parent = await getDirByPath(dir, parentPath)
  const src = await parent.getFileHandle(name)

  // Does a file with the desired name already exist, and is it a *different*
  // file than the source? (On case-insensitive filesystems, "Note.md"
  // resolves to the same entry as "note.md".)
  let sameEntryDifferentCase = false
  let realConflict = false
  try {
    const existing = await parent.getFileHandle(desired)
    if (await existing.isSameEntry(src)) sameEntryDifferentCase = true
    else realConflict = true
  } catch {
    // `desired` doesn't exist — free to use it.
  }

  const target = realConflict ? await uniqueName(parent, desired, name) : desired
  if (target === name) return id

  // The server renames in place, which handles a case-only change too.
  if (isRemoteHandle(dir)) {
    await moveRemoteEntry(dir, id, joinPath(parentPath, target))
    return joinPath(parentPath, target)
  }

  const content = await src.getFile()
  if (sameEntryDifferentCase) {
    // Case-only rename on a case-insensitive filesystem. Creating the new name
    // directly just re-opens the same file, so hop through a temporary name to
    // force the directory entry to adopt the new casing.
    const tempName = `.deckle-rename-${Date.now()}${splitExt(name).ext}`
    await writeRaw(parent, tempName, content)
    await parent.removeEntry(name)
    await writeRaw(parent, target, content)
    await parent.removeEntry(tempName)
    return joinPath(parentPath, target)
  }

  await writeRaw(parent, target, content)
  await parent.removeEntry(name)
  return joinPath(parentPath, target)
}

async function folderExists(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<boolean> {
  try {
    await parent.getDirectoryHandle(name)
    return true
  } catch {
    return false
  }
}

async function uniqueFolderName(
  parent: FileSystemDirectoryHandle,
  desired: string,
): Promise<string> {
  if (!(await folderExists(parent, desired))) return desired
  for (let i = 1; ; i++) {
    const candidate = `${desired} ${i}`
    if (!(await folderExists(parent, candidate))) return candidate
  }
}

/** Create a subfolder inside `parentPath` (root if empty). Returns its path. */
export async function createFolder(
  dir: FileSystemDirectoryHandle,
  parentPath: string,
  name: string,
): Promise<string> {
  const parent = await getDirByPath(dir, parentPath, true)
  const folderName = await uniqueFolderName(parent, sanitizeName(name, 'New Folder'))
  await parent.getDirectoryHandle(folderName, { create: true })
  return joinPath(parentPath, folderName)
}

/** Recursively copy every entry (files preserved as binary) into `dest`. */
async function copyDirContents(
  src: FileSystemDirectoryHandle,
  dest: FileSystemDirectoryHandle,
): Promise<void> {
  for await (const entry of asAsyncEntries(src)) {
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile()
      const handle = await dest.getFileHandle(entry.name, { create: true })
      const writable = await handle.createWritable()
      await writable.write(file) // a File is a Blob → copies binary content
      await writable.close()
    } else {
      const childSrc = entry as FileSystemDirectoryHandle
      const childDest = await dest.getDirectoryHandle(entry.name, { create: true })
      await copyDirContents(childSrc, childDest)
    }
  }
}

/**
 * Rename a folder, keeping it in the same parent. Returns the new path.
 * The File System Access API has no native rename, so this copies the folder's
 * contents into a new directory and removes the old one.
 */
export async function renameFolder(
  dir: FileSystemDirectoryHandle,
  folderPath: string,
  newName: string,
): Promise<string> {
  const { parentPath, name } = splitPath(folderPath)
  const desired = sanitizeName(newName, name)
  if (desired === name) return folderPath

  const parent = await getDirByPath(dir, parentPath)
  const src = await parent.getDirectoryHandle(name)

  // Distinguish a case-only rename (same entry on case-insensitive systems)
  // from a real collision with a different existing folder.
  let sameEntryDifferentCase = false
  let realConflict = false
  try {
    const existing = await parent.getDirectoryHandle(desired)
    if (await existing.isSameEntry(src)) sameEntryDifferentCase = true
    else realConflict = true
  } catch {
    // `desired` doesn't exist — free to use it.
  }

  if (sameEntryDifferentCase) {
    // Case-only rename: hop through a temp folder so the entry adopts the case.
    const tempName = `.deckle-rename-${Date.now()}`
    const temp = await parent.getDirectoryHandle(tempName, { create: true })
    await copyDirContents(src, temp)
    await parent.removeEntry(name, { recursive: true })
    const finalDir = await parent.getDirectoryHandle(desired, { create: true })
    await copyDirContents(temp, finalDir)
    await parent.removeEntry(tempName, { recursive: true })
    return joinPath(parentPath, desired)
  }

  const target = realConflict ? await uniqueFolderName(parent, desired) : desired
  const dest = await parent.getDirectoryHandle(target, { create: true })
  await copyDirContents(src, dest)
  await parent.removeEntry(name, { recursive: true })
  return joinPath(parentPath, target)
}

/**
 * Move a note — or any other file — into `targetFolderPath` (root if empty).
 * Returns the new id. No-op (returns the original id) if already in that folder.
 * Copies bytes, not text, so a PDF arrives intact; on the server library it is
 * a rename and nothing is transferred at all.
 */
export async function moveNote(
  dir: FileSystemDirectoryHandle,
  id: string,
  targetFolderPath: string,
): Promise<string> {
  const { parentPath, name } = splitPath(id)
  if (parentPath === targetFolderPath) return id

  const srcParent = await getDirByPath(dir, parentPath)
  const destParent = await getDirByPath(dir, targetFolderPath, true)
  const targetName = await uniqueName(destParent, name)
  const to = joinPath(targetFolderPath, targetName)

  if (isRemoteHandle(dir)) {
    await moveRemoteEntry(dir, id, to)
    return to
  }

  const content = await (await srcParent.getFileHandle(name)).getFile()
  await writeRaw(destParent, targetName, content)
  await srcParent.removeEntry(name)

  return to
}

// ---- Import ----------------------------------------------------------------

/** One file to bring into the library, with a path relative to the import root. */
export interface ImportItem {
  /** e.g. "Archive/Projects/idea.md" — folders are created as needed. */
  path: string
  /** A note's Markdown. */
  content?: string
  /**
   * Any other file's bytes — a PDF, an image, a spreadsheet — stored as-is,
   * under its own name and extension.
   */
  blob?: Blob
}

export interface ImportedNote {
  id: string
  title: string
  /** True when a name collision meant the note landed under a different name. */
  renamed: boolean
  /** False for a file that isn't a note — a PDF, an image… */
  isNote: boolean
}

/**
 * Sanitize an imported path: drop empty/traversal segments, strip characters
 * that aren't legal in a file name, and — for a note — force a `.md` extension
 * on the leaf. Returns null if nothing usable is left.
 */
function sanitizeImportPath(
  rawPath: string,
  keepExtension = false,
): { folder: string; name: string } | null {
  const segments = rawPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.' && s !== '..')
    // A dotfile segment would land the note somewhere buildTree skips.
    .map((s) => sanitizeName(s.replace(/^\.+/, ''), ''))
    .filter(Boolean)
  if (!segments.length) return null

  const leaf = segments.pop() as string
  if (keepExtension) return { folder: segments.join('/'), name: leaf }
  const name = MD_EXT.test(leaf) ? leaf : `${leaf.replace(/\.(markdown|txt|text)$/i, '')}.md`
  return { folder: segments.join('/'), name }
}

/**
 * Write imported files into the library under `targetFolder`, preserving their
 * folder structure. Existing notes are never overwritten — a collision gets a
 * " 1", " 2", … suffix, the same rule note creation uses.
 */
/** Every file name already present in a directory, as one listing. */
async function listFileNames(dir: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set<string>()
  for await (const entry of asAsyncEntries(dir)) {
    if (entry.kind === 'file') names.add(entry.name)
  }
  return names
}

/** The collision rule from `uniqueName`, applied against a name set in memory. */
function uniqueNameIn(taken: Set<string>, desired: string): string {
  if (!taken.has(desired)) return desired
  const { stem, ext } = splitExt(desired)
  for (let i = 1; ; i++) {
    const candidate = `${stem} ${i}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function importNotes(
  dir: FileSystemDirectoryHandle,
  items: ImportItem[],
  targetFolder = '',
  onProgress?: (done: number, total: number) => void,
): Promise<ImportedNote[]> {
  // Resolve every destination first, then write.
  //
  // Naming used to probe the filesystem for each candidate — getFileHandle,
  // catch, try the next suffix — which on an import into a folder that already
  // holds the same notes is quadratic in probes and strictly serial. Listing
  // each destination folder once and resolving collisions against that set in
  // memory gives the same names for a fraction of the I/O, and leaves the
  // writes independent of each other so they can go out concurrently.
  interface Planned {
    parent: FileSystemDirectoryHandle
    target: string
    id: string
    renamed: boolean
    content: string | Blob
    isNote: boolean
  }

  const parents = new Map<string, FileSystemDirectoryHandle>()
  const taken = new Map<string, Set<string>>()
  const planned: Planned[] = []

  for (const item of items) {
    const parts = sanitizeImportPath(item.path, item.blob !== undefined)
    if (!parts) continue

    const folderPath = joinPath(targetFolder, parts.folder)
    let parent = parents.get(folderPath)
    if (!parent) {
      parent = await getDirByPath(dir, folderPath, true)
      parents.set(folderPath, parent)
      taken.set(folderPath, await listFileNames(parent))
    }

    const names = taken.get(folderPath)!
    const target = uniqueNameIn(names, parts.name)
    // Claim it, so two files importing to the same name don't both take it.
    names.add(target)

    planned.push({
      parent,
      target,
      id: joinPath(folderPath, target),
      renamed: target !== parts.name,
      content: item.blob ?? item.content ?? '',
      isNote: item.blob === undefined,
    })
  }

  let done = 0
  await mapConcurrent(planned, IO_CONCURRENCY, async (plan) => {
    await writeRaw(plan.parent, plan.target, plan.content)
    onProgress?.(++done, planned.length)
  })

  return planned.map(({ id, target, renamed, isNote }) => ({
    id,
    title: isNote ? baseName(target) : target,
    renamed,
    isNote,
  }))
}

// ---- Export ----------------------------------------------------------------

/** A file collected for export, with its library-relative path. */
export interface ExportedFile {
  path: string
  content: Uint8Array
  modified: Date
}

/**
 * Walk the whole library collecting file contents for an archive.
 *
 * Unlike `buildTree` this keeps everything, not just `.md` files, because an
 * export is a backup: attachments sitting beside notes should come along.
 * `includeHidden` decides whether the dot-folders (`.trash`, `.history`) come
 * too; the data folder (tasks and bookmarks) is always kept, since without it a
 * restored library silently loses the planner — including when it is still
 * under its pre-rename name.
 */
export async function collectFiles(
  dir: FileSystemDirectoryHandle,
  options: { includeHidden?: boolean } = {},
  onFile?: (path: string) => void,
  prefix = '',
): Promise<ExportedFile[]> {
  const out: ExportedFile[] = []

  for await (const entry of asAsyncEntries(dir)) {
    const isHidden = entry.name.startsWith('.')
    if (isHidden && !options.includeHidden && !isDataDir(entry.name)) continue
    const path = joinPath(prefix, entry.name)

    if (entry.kind === 'directory') {
      out.push(
        ...(await collectFiles(
          entry as FileSystemDirectoryHandle,
          options,
          onFile,
          path,
        )),
      )
    } else {
      const file = await (entry as FileSystemFileHandle).getFile()
      out.push({
        path,
        content: new Uint8Array(await file.arrayBuffer()),
        modified: new Date(file.lastModified),
      })
      onFile?.(path)
    }
  }

  return out
}

// ---- Recycle bin -----------------------------------------------------------
// Deleted notes are moved into a hidden ".trash" folder at the library root
// (skipped by buildTree). A JSON index records each item's original location
// and deletion time so it can be restored.

export interface TrashItem {
  /** File name within the .trash folder (unique). */
  trashName: string
  /** Path the note was deleted from, e.g. "Projects/idea.md". */
  originalPath: string
  title: string
  deletedAt: number
  /** Present for a file that isn't a note. */
  kind?: 'file'
  /** 'replaced' when a newer version, saved through the API, took its place. */
  reason?: 'replaced'
  /** The API token that deleted or replaced it, when it wasn't the app. */
  by?: string
}

const TRASH_DIR = '.trash'
const TRASH_INDEX = 'index.json'

async function readTrashIndex(
  dir: FileSystemDirectoryHandle,
): Promise<TrashItem[]> {
  try {
    const trash = await dir.getDirectoryHandle(TRASH_DIR)
    const handle = await trash.getFileHandle(TRASH_INDEX)
    const parsed = JSON.parse(await (await handle.getFile()).text())
    return Array.isArray(parsed) ? (parsed as TrashItem[]) : []
  } catch {
    return []
  }
}

async function writeTrashIndex(
  dir: FileSystemDirectoryHandle,
  items: TrashItem[],
): Promise<void> {
  const trash = await dir.getDirectoryHandle(TRASH_DIR, { create: true })
  await writeRaw(trash, TRASH_INDEX, JSON.stringify(items, null, 2))
}

/**
 * Move one note or file into the bin folder and describe what moved. The index
 * is the caller's business, so a bulk delete can rewrite it once instead of per
 * item. Bytes, not text, so a binary file comes back exactly as it went.
 */
async function moveIntoTrash(
  dir: FileSystemDirectoryHandle,
  trash: FileSystemDirectoryHandle,
  taken: Set<string>,
  id: string,
): Promise<TrashItem> {
  const { name } = splitPath(id)
  const trashName = uniqueNameIn(taken, name)
  taken.add(trashName)
  if (isRemoteHandle(dir)) {
    await moveRemoteEntry(dir, id, joinPath(TRASH_DIR, trashName))
  } else {
    await writeRaw(trash, trashName, await readBlob(dir, id))
    await deleteNote(dir, id)
  }
  const isNote = MD_EXT.test(name)
  return {
    trashName,
    originalPath: id,
    title: isNote ? baseName(name) : name,
    deletedAt: Date.now(),
    ...(isNote ? {} : { kind: 'file' as const }),
  }
}

/** Move a note into the recycle bin. */
export async function trashNote(
  dir: FileSystemDirectoryHandle,
  id: string,
): Promise<void> {
  const trash = await dir.getDirectoryHandle(TRASH_DIR, { create: true })
  const taken = await listFileNames(trash)
  const item = await moveIntoTrash(dir, trash, taken, id)
  const items = await readTrashIndex(dir)
  items.push(item)
  await writeTrashIndex(dir, items)
}

/** List recycle-bin items (newest first), dropping any stale index entries. */
export async function listTrash(
  dir: FileSystemDirectoryHandle,
): Promise<TrashItem[]> {
  let trash: FileSystemDirectoryHandle
  try {
    trash = await dir.getDirectoryHandle(TRASH_DIR)
  } catch {
    return []
  }
  const items = await readTrashIndex(dir)
  // One listing beats one existence probe per entry, and a full bin is exactly
  // when this is opened.
  const present = await listFileNames(trash)
  const valid = items.filter((item) => present.has(item.trashName))
  valid.sort((a, b) => b.deletedAt - a.deletedAt)
  return valid
}

/** Restore a recycle-bin item to its original location. Returns the new id. */
export async function restoreTrash(
  dir: FileSystemDirectoryHandle,
  trashName: string,
): Promise<string | null> {
  const items = await readTrashIndex(dir)
  const entry = items.find((i) => i.trashName === trashName)
  if (!entry) return null

  const trash = await dir.getDirectoryHandle(TRASH_DIR)
  const { parentPath, name } = splitPath(entry.originalPath)
  const parent = await getDirByPath(dir, parentPath, true)
  const target = await uniqueName(parent, name)
  if (isRemoteHandle(dir)) {
    await moveRemoteEntry(dir, joinPath(TRASH_DIR, trashName), joinPath(parentPath, target))
  } else {
    const content = await (await trash.getFileHandle(trashName)).getFile()
    await writeRaw(parent, target, content)
    await trash.removeEntry(trashName)
  }
  await writeTrashIndex(
    dir,
    items.filter((i) => i.trashName !== trashName),
  )
  return joinPath(parentPath, target)
}

/** Permanently delete a single recycle-bin item. */
export async function deleteTrashItem(
  dir: FileSystemDirectoryHandle,
  trashName: string,
): Promise<void> {
  const trash = await dir.getDirectoryHandle(TRASH_DIR, { create: true })
  try {
    await trash.removeEntry(trashName)
  } catch {
    // already gone
  }
  const items = await readTrashIndex(dir)
  await writeTrashIndex(
    dir,
    items.filter((i) => i.trashName !== trashName),
  )
}

/** Permanently delete everything in the recycle bin. */
export async function emptyTrash(
  dir: FileSystemDirectoryHandle,
): Promise<void> {
  try {
    await dir.removeEntry(TRASH_DIR, { recursive: true })
  } catch {
    // nothing to empty
  }
}

/**
 * Delete a folder: move everything inside it (recursively) — notes and other
 * files alike — to the recycle bin, then remove the folder. Returns the number
 * of items sent to the bin.
 */
export async function trashFolder(
  dir: FileSystemDirectoryHandle,
  folderPath: string,
): Promise<number> {
  const folderHandle = await getDirByPath(dir, folderPath)
  const tree = await buildTree(folderHandle, folderPath)
  const notes: LibraryFile[] = [...flattenFiles(tree), ...flattenAssets(tree)]

  // The index is read and rewritten once for the whole folder. Doing it inside
  // the loop meant deleting a folder of 200 notes parsed and re-serialised the
  // bin's JSON 200 times, each pass longer than the last.
  const trash = await dir.getDirectoryHandle(TRASH_DIR, { create: true })
  const taken = await listFileNames(trash)
  const moved: TrashItem[] = []
  for (const note of notes) {
    moved.push(await moveIntoTrash(dir, trash, taken, note.id))
  }
  if (moved.length) {
    await writeTrashIndex(dir, [...(await readTrashIndex(dir)), ...moved])
  }

  const { parentPath, name } = splitPath(folderPath)
  const parent = await getDirByPath(dir, parentPath)
  await parent.removeEntry(name, { recursive: true })
  return notes.length
}
