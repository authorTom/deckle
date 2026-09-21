// The library's *semantics*, server-side.
//
// server/library-api.mjs is a dumb file API — read this path, write that one.
// Everything above it (unique names, the recycle bin, version history, the
// tasks and bookmarks JSON) lives in the browser, in src/fs/library.ts,
// src/fs/history.ts and the two stores, because until now the browser was the
// only thing that ever touched a library.
//
// The API changed that: an agent writing a note must trash it into the same
// `.trash`, snapshot into the same `.history`, and add tasks to the same
// `.deckle/tasks.json` the app reads, or the two halves would quietly disagree.
// So this module mirrors those rules. The formats are the contract — if one
// side changes, the other must follow.
//
// A library holds files as well as notes — whatever an agent produced: PDFs,
// spreadsheets, images. They follow the same rules where the rules make
// sense: deleting one moves it to the recycle bin, and replacing one moves the
// old copy there too, since a binary file has no text to snapshot.

const MD_EXT = /\.md$/i
const ILLEGAL = /[\\/:*?"<>|]/g

const TRASH_DIR = '.trash'
const TRASH_INDEX = `${TRASH_DIR}/index.json`
const HISTORY_DIR = '.history'
const HISTORY_INDEX = `${HISTORY_DIR}/index.json`
const DATA_DIR = '.deckle'
const TASKS_FILE = `${DATA_DIR}/tasks.json`
const BOOKMARKS_FILE = `${DATA_DIR}/bookmarks.json`

// The data folder was called ".nib" before the app was renamed. A server
// library sitting in a mounted volume survives image upgrades, so it may well
// still hold the old folder — read it when the new one is empty, and mirror
// src/fs/appData.ts, which does the same on the browser side.
const LEGACY_DATA_DIR = '.nib'
const LEGACY_TASKS_FILE = `${LEGACY_DATA_DIR}/tasks.json`
const LEGACY_BOOKMARKS_FILE = `${LEGACY_DATA_DIR}/bookmarks.json`

/** True for either spelling of the data folder. */
export function isDataDir(name) {
  return name === DATA_DIR || name === LEGACY_DATA_DIR
}

/** Snapshots kept per note, matching src/fs/history.ts. */
const MAX_HISTORY_PER_NOTE = 20

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function baseName(fileName) {
  return fileName.replace(MD_EXT, '')
}

/** A `.md` file is a note; anything else is a file. */
export function isNotePath(path) {
  return MD_EXT.test(path)
}

/** "report.final.pdf" → { stem: "report.final", ext: ".pdf" }; no ext → "". */
function splitExt(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

function splitPath(id) {
  const idx = id.lastIndexOf('/')
  if (idx === -1) return { parentPath: '', name: id }
  return { parentPath: id.slice(0, idx), name: id.slice(idx + 1) }
}

function joinPath(parentPath, name) {
  return parentPath ? `${parentPath}/${name}` : name
}

function sanitizeName(name, fallback) {
  const cleaned = String(name ?? '').replace(ILLEGAL, '').trim()
  return cleaned || fallback
}

/**
 * Control characters have no business in a path arriving over HTTP, and a NUL
 * in particular is a truncation attempt. paths.mjs rejects them too, but by
 * then the byte has already been copied into an error message — catch it here
 * so nothing echoes it back.
 */
function assertPrintable(raw) {
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new ApiError(400, 'invalid_path', 'path contains a control character')
  }
}

/**
 * Normalise a note path from a request: strip leading slashes, reject dotfolder
 * segments (the app's tree skips them, so a note written there would be
 * invisible), and force a `.md` extension.
 */
export function normalizeNotePath(raw) {
  const value = String(raw ?? '')
  assertPrintable(value)
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')

  if (!segments.length) throw new ApiError(400, 'invalid_path', 'path is required')
  if (segments.some((s) => s === '..')) {
    throw new ApiError(400, 'invalid_path', 'path may not traverse upwards')
  }
  if (segments.some((s) => s.startsWith('.'))) {
    throw new ApiError(
      400,
      'invalid_path',
      'path may not contain hidden (dot) folders — those are reserved for Deckle',
    )
  }

  const leaf = segments.pop()
  const name = MD_EXT.test(leaf) ? leaf : `${leaf}.md`
  return joinPath(segments.join('/'), name)
}

/**
 * Normalise the path of any file — a note or not — from a request. The same
 * rules as a note path, except that the extension is the caller's: an agent
 * saving `report.pdf` means exactly that.
 */
export function normalizeFilePath(raw) {
  const folder = normalizeFolderPath(raw)
  if (!folder) throw new ApiError(400, 'invalid_path', 'path is required')
  return folder
}

/** Same rules, but for a folder path (no extension forced, '' means the root). */
export function normalizeFolderPath(raw) {
  const value = String(raw ?? '')
  assertPrintable(value)
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.')
  if (segments.some((s) => s === '..')) {
    throw new ApiError(400, 'invalid_path', 'path may not traverse upwards')
  }
  if (segments.some((s) => s.startsWith('.'))) {
    throw new ApiError(400, 'invalid_path', 'path may not contain hidden (dot) folders')
  }
  return segments.join('/')
}

/**
 * Serialise read-modify-write on the shared JSON files. Two concurrent API
 * calls adding a task would otherwise each read the same array and the second
 * write would drop the first task.
 */
function createLocks() {
  const chains = new Map()
  return function withLock(key, fn) {
    const previous = chains.get(key) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    // Keep the chain alive but never let a rejection poison the next waiter.
    chains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }
}

export function createLibraryStore(library) {
  const withLock = createLocks()

  async function readJson(path, fallback) {
    try {
      const parsed = JSON.parse(await library.readText(path))
      return parsed ?? fallback
    } catch {
      return fallback
    }
  }

  async function writeJson(path, value) {
    await library.writeText(path, JSON.stringify(value, null, 2))
  }

  /**
   * Read one of the data files (tasks, bookmarks), falling back to its
   * pre-rename location when the current one doesn't exist. Writes always go
   * to the current path, so the file moves forward on first mutation; nothing
   * deletes the legacy copy.
   *
   * Unlike the trash and history indexes, these files *are* the data. A copy
   * that wouldn't parse — or parsed into a shape this version doesn't know,
   * such as a newer Deckle's — used to be read as empty, and the next task an
   * agent added was written straight over every task that was there. Now it is
   * refused, and nothing is written until a person has looked at the file.
   */
  async function loadDataFile(path, legacyPath, isValid, empty) {
    for (const candidate of [path, legacyPath]) {
      let text
      try {
        text = await library.readText(candidate)
      } catch (err) {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') continue
        throw err
      }
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (isValid(parsed)) return parsed
      throw new ApiError(
        500,
        'store_unreadable',
        `${candidate} is not a file this version of Deckle can read (it is not valid JSON, or was written by a newer version). Nothing was changed — repair or move the file, then try again.`,
      )
    }
    return empty()
  }

  // ---- Notes ---------------------------------------------------------------

  /**
   * Find a free name in `folder`, appending " 1", " 2", … on collision —
   * before the extension, so "report.pdf" becomes "report 1.pdf".
   */
  async function uniqueName(folder, desired) {
    if (!(await library.exists(joinPath(folder, desired)))) return desired
    const { stem, ext } = splitExt(desired)
    for (let i = 1; ; i++) {
      const candidate = `${stem} ${i}${ext}`
      if (!(await library.exists(joinPath(folder, candidate)))) return candidate
    }
  }

  /** What the API says about a file that isn't a note: everything but its bytes. */
  async function readFileInfo(path) {
    const kind = await library.exists(path)
    if (kind !== 'file') throw new ApiError(404, 'not_found', `no file at "${path}"`)
    const stat = await library.stat(path)
    const { parentPath, name } = splitPath(path)
    const dot = name.lastIndexOf('.')
    return {
      path,
      name,
      folder: parentPath,
      kind: isNotePath(path) ? 'note' : 'file',
      ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
      size: stat.size,
      updatedAt: stat.lastModified,
    }
  }

  async function readNote(path) {
    const kind = await library.exists(path)
    if (kind !== 'file') throw new ApiError(404, 'not_found', `no note at "${path}"`)
    const [content, stat] = await Promise.all([library.readText(path), library.stat(path)])
    return {
      path,
      title: baseName(splitPath(path).name),
      folder: splitPath(path).parentPath,
      content,
      updatedAt: stat.lastModified,
      size: stat.size,
    }
  }

  /**
   * Create a note without ever overwriting one: a collision gets a numbered
   * suffix, the same rule the app's "New note" button follows.
   */
  async function createNote({ path, content = '' }) {
    const { parentPath, name } = splitPath(path)
    const finalName = await uniqueName(parentPath, name)
    const finalPath = joinPath(parentPath, finalName)
    await library.writeText(finalPath, content)
    return await readNote(finalPath)
  }

  /**
   * Create or replace a note. An overwrite snapshots the version it replaces
   * into `.history` first, so an agent's edits are as recoverable as the app's.
   */
  async function writeNote(path, content, reason = 'agent') {
    const existing = await library.exists(path)
    if (existing === 'directory') {
      throw new ApiError(409, 'conflict', `"${path}" is a folder`)
    }
    if (existing === 'file') {
      const previous = await library.readText(path)
      if (previous.trim() && previous !== content) {
        await snapshot(path, previous, reason)
      }
    }
    await library.writeText(path, content)
    return { note: await readNote(path), created: existing !== 'file' }
  }

  /** Move or rename a note, carrying its history entries with it. */
  async function moveNote(from, to) {
    if (from === to) return await readNote(from)
    if (await library.exists(to)) {
      throw new ApiError(409, 'conflict', `a note already exists at "${to}"`)
    }
    await library.rename(from, to)
    await retargetHistory(from, to)
    return await readNote(to)
  }

  /** Move or rename any file. Notes keep their history; others just move. */
  async function moveFile(from, to) {
    if (from === to) return await readFileInfo(from)
    if ((await library.exists(from)) !== 'file') {
      throw new ApiError(404, 'not_found', `no file at "${from}"`)
    }
    if (await library.exists(to)) {
      throw new ApiError(409, 'conflict', `something already exists at "${to}"`)
    }
    await library.rename(from, to)
    if (isNotePath(from)) await retargetHistory(from, to)
    return await readFileInfo(to)
  }

  /**
   * Store a file's bytes from a stream, keeping whatever it replaces.
   *
   * The upload lands under a hidden name first, so a connection that drops
   * half way leaves the old file exactly where it was. Only once every byte
   * has arrived does the old copy move to the recycle bin — marked as
   * replaced, and restorable like anything deleted — and the new one take its
   * place.
   */
  async function putFile(path, stream, { replacedBy } = {}) {
    const existing = await library.exists(path)
    if (existing === 'directory') throw new ApiError(409, 'conflict', `"${path}" is a folder`)
    const incoming = `${DATA_DIR}/incoming/${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      await library.writeFile(incoming, stream)
      if (existing === 'file') await trashEntry(path, { reason: 'replaced', by: replacedBy })
      await library.rename(incoming, path)
    } catch (err) {
      await library.remove(incoming, false).catch(() => {})
      throw err
    }
    return { file: await readFileInfo(path), created: existing !== 'file' }
  }

  // ---- Recycle bin ---------------------------------------------------------

  async function listTrash() {
    const items = await readJson(TRASH_INDEX, [])
    const valid = []
    for (const item of Array.isArray(items) ? items : []) {
      if (await library.exists(joinPath(TRASH_DIR, item.trashName))) valid.push(item)
    }
    valid.sort((a, b) => b.deletedAt - a.deletedAt)
    return valid
  }

  /**
   * Move a note or a file to the recycle bin, recording where it came from.
   *
   * A rename, so a large file costs no more than a note and arrives intact.
   * `reason` is 'replaced' when a newer version took its place, so the bin can
   * say why an item is there; `by` names the token that did it.
   */
  async function trashEntry(path, { reason, by } = {}) {
    return await withLock(TRASH_INDEX, async () => {
      const { name } = splitPath(path)
      const trashName = await uniqueName(TRASH_DIR, name)
      await library.rename(path, joinPath(TRASH_DIR, trashName))

      const items = await readJson(TRASH_INDEX, [])
      const entry = {
        trashName,
        originalPath: path,
        title: isNotePath(name) ? baseName(name) : name,
        deletedAt: Date.now(),
      }
      if (!isNotePath(name)) entry.kind = 'file'
      if (reason) entry.reason = reason
      if (by) entry.by = by
      await writeJson(TRASH_INDEX, [...(Array.isArray(items) ? items : []), entry])
      return entry
    })
  }

  /** Kept under its old name: every existing caller trashes notes. */
  const trashNote = (path) => trashEntry(path)

  /**
   * Delete a folder the way the app does: everything in it — notes and files —
   * goes to the recycle bin, then the emptied folder goes. Returns how many
   * items were binned.
   */
  async function trashFolder(folder, { by } = {}) {
    const entries = []
    const collect = (nodes) => {
      for (const node of nodes) {
        if (node.kind === 'folder') collect(node.children)
        else entries.push(joinPath(folder, node.id))
      }
    }
    collect(await library.tree(folder))
    for (const path of entries) await trashEntry(path, { by })
    await library.remove(folder, true)
    return entries.length
  }

  async function restoreTrash(trashName) {
    return await withLock(TRASH_INDEX, async () => {
      const items = await readJson(TRASH_INDEX, [])
      const entry = (Array.isArray(items) ? items : []).find(
        (i) => i.trashName === trashName,
      )
      if (!entry) throw new ApiError(404, 'not_found', 'no such item in the recycle bin')

      const { parentPath, name } = splitPath(entry.originalPath)
      const target = await uniqueName(parentPath, name)
      const path = joinPath(parentPath, target)

      await library.rename(joinPath(TRASH_DIR, trashName), path)
      await writeJson(
        TRASH_INDEX,
        items.filter((i) => i.trashName !== trashName),
      )
      return isNotePath(path) ? await readNote(path) : await readFileInfo(path)
    })
  }

  async function deleteTrashItem(trashName) {
    return await withLock(TRASH_INDEX, async () => {
      const items = await readJson(TRASH_INDEX, [])
      const list = Array.isArray(items) ? items : []
      if (!list.some((i) => i.trashName === trashName)) {
        throw new ApiError(404, 'not_found', 'no such item in the recycle bin')
      }
      try {
        await library.remove(joinPath(TRASH_DIR, trashName), false)
      } catch {
        // Already gone from disk; still drop the index entry.
      }
      await writeJson(
        TRASH_INDEX,
        list.filter((i) => i.trashName !== trashName),
      )
    })
  }

  // ---- Version history -----------------------------------------------------

  /** Save `content` as the previous version of `notePath`, pruning old ones. */
  async function snapshot(notePath, content, reason) {
    await withLock(HISTORY_INDEX, async () => {
      const savedAt = Date.now()
      const snapName = `${savedAt}_${notePath.replace(/\//g, '__')}`
      await library.writeText(joinPath(HISTORY_DIR, snapName), content)

      const items = await readJson(HISTORY_INDEX, [])
      const list = Array.isArray(items) ? items : []
      list.push({ snapName, noteId: notePath, savedAt, reason })

      const mine = list
        .filter((i) => i.noteId === notePath)
        .sort((a, b) => b.savedAt - a.savedAt)
      for (const stale of mine.slice(MAX_HISTORY_PER_NOTE)) {
        try {
          await library.remove(joinPath(HISTORY_DIR, stale.snapName), false)
        } catch {
          // already gone
        }
      }
      const keep = new Set(mine.slice(0, MAX_HISTORY_PER_NOTE).map((i) => i.snapName))
      await writeJson(
        HISTORY_INDEX,
        list.filter((i) => i.noteId !== notePath || keep.has(i.snapName)),
      )
    }).catch(() => {
      // History must never break the write it protects.
    })
  }

  async function listHistory(notePath) {
    const items = await readJson(HISTORY_INDEX, [])
    const list = (Array.isArray(items) ? items : []).filter(
      (i) => !notePath || i.noteId === notePath,
    )
    const valid = []
    for (const item of list) {
      if (await library.exists(joinPath(HISTORY_DIR, item.snapName))) valid.push(item)
    }
    valid.sort((a, b) => b.savedAt - a.savedAt)
    return valid
  }

  async function readSnapshot(snapName) {
    if (snapName.includes('/')) throw new ApiError(400, 'invalid_path', 'invalid snapshot')
    const path = joinPath(HISTORY_DIR, snapName)
    if ((await library.exists(path)) !== 'file') {
      throw new ApiError(404, 'not_found', 'no such snapshot')
    }
    return await library.readText(path)
  }

  async function retargetHistory(fromPath, toPath) {
    await withLock(HISTORY_INDEX, async () => {
      const items = await readJson(HISTORY_INDEX, [])
      const list = Array.isArray(items) ? items : []
      let changed = false
      for (const item of list) {
        if (item.noteId === fromPath) {
          item.noteId = toPath
          changed = true
        }
      }
      if (changed) await writeJson(HISTORY_INDEX, list)
    }).catch(() => {
      // best effort
    })
  }

  // ---- Tasks & bookmarks ---------------------------------------------------

  // Fresh objects every time. These used to be shared constants, and
  // updateTasks mutates what it loads — so a first task added to a library
  // with no tasks.json was pushed into the constant itself, and stayed there
  // for every later load if that write failed.
  const emptyTasks = () => ({ version: 1, tasks: [], projects: [] })
  const emptyBookmarks = () => ({ version: 1, bookmarks: [], collections: [] })

  const isTaskStore = (store) =>
    store?.version === 1 && Array.isArray(store.tasks) && Array.isArray(store.projects)
  const isBookmarkStore = (store) =>
    store?.version === 1 && Array.isArray(store.bookmarks) && Array.isArray(store.collections)

  async function loadTasks() {
    return await loadDataFile(TASKS_FILE, LEGACY_TASKS_FILE, isTaskStore, emptyTasks)
  }

  async function loadBookmarks() {
    return await loadDataFile(
      BOOKMARKS_FILE,
      LEGACY_BOOKMARKS_FILE,
      isBookmarkStore,
      emptyBookmarks,
    )
  }

  /** Read-modify-write the task store under a lock. */
  function updateTasks(mutate) {
    return withLock(TASKS_FILE, async () => {
      const store = await loadTasks()
      const result = await mutate(store)
      await writeJson(TASKS_FILE, store)
      return result
    })
  }

  function updateBookmarks(mutate) {
    return withLock(BOOKMARKS_FILE, async () => {
      const store = await loadBookmarks()
      const result = await mutate(store)
      await writeJson(BOOKMARKS_FILE, store)
      return result
    })
  }

  return {
    // paths
    joinPath,
    splitPath,
    baseName,
    sanitizeName,
    // notes
    readNote,
    createNote,
    writeNote,
    moveNote,
    uniqueName,
    // files
    readFileInfo,
    moveFile,
    putFile,
    // bin
    listTrash,
    trashNote,
    trashEntry,
    trashFolder,
    restoreTrash,
    deleteTrashItem,
    // history
    snapshot,
    listHistory,
    readSnapshot,
    // tasks & bookmarks
    loadTasks,
    updateTasks,
    loadBookmarks,
    updateBookmarks,
    // constants the API needs for export filtering
    HIDDEN_DIRS: [TRASH_DIR, HISTORY_DIR],
    DATA_DIR,
  }
}
