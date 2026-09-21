// The server-side library: a thin, deliberately dumb file API over a directory
// in the container (a Docker volume, by default /data).
//
// It mirrors the handful of operations the browser's File System Access API
// offers, because the client adapter (src/fs/remote.ts) presents these
// endpoints *as* a FileSystemDirectoryHandle. Keeping the two in step is what
// lets the rest of the app stay backend-agnostic — notes, files, history,
// tasks and bookmarks all go through the same handle interface.
//
// Endpoints (all library-relative paths in the ?path= query parameter):
//   GET    /api/library/tree    recursive tree of notes and files (one round trip)
//   GET    /api/library/list    shallow directory listing, including dotfiles
//   GET    /api/library/stat    entry kind + mtime, 404 when missing
//   GET    /api/library/file    file contents
//   PUT    /api/library/file    write file contents (creates parent folders)
//   POST   /api/library/dir     create a directory (mkdir -p)
//   POST   /api/library/move    rename a file or folder (&to= the destination)
//   DELETE /api/library/entry   remove a file or directory

import fs from 'node:fs/promises'
import path from 'node:path'
import { constants as fsConstants, createWriteStream } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import {
  BadPathError,
  assertRealPathInside,
  joinRelative,
  resolveLibraryPath,
} from './paths.mjs'

const MD_EXT = /\.md$/i

/**
 * A folder inside the library root that this API pretends does not exist.
 *
 * It is the server's own state, not part of the library. Deckle 2.x kept the
 * AI assistant's settings there — a provider API key among them — and an
 * upgraded volume may still hold that file, so the folder stays invisible even
 * though nothing is written to it any more. Every way out of this module
 * passes through `safePath`, `walk` or `list`, so denying it in those places is
 * what keeps it out of: the file API, the client's export walk (which lists its
 * way through the remote handle), the server's own export walk, the machine
 * API and MCP — none of which have any business reading a key.
 *
 * Set DECKLE_STATE_DIR to move the state somewhere else entirely; this name
 * stays reserved either way, so a library can't grow a folder that would
 * later collide with it.
 */
export const RESERVED_DIR = '.deckle-state'

/**
 * The largest single file the library accepts, unless DECKLE_MAX_FILE_MB says
 * otherwise. Notes are small, but the library also holds what an agent
 * produced — PDFs, spreadsheets, images — so this is sized for documents
 * rather than prose. It exists so one request cannot fill the volume.
 */
export const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024

/**
 * Operating-system clutter that is never anyone's work. Dotfiles (.DS_Store,
 * ._resource forks) are already skipped by the leading-dot rule.
 */
const CLUTTER = new Set(['thumbs.db', 'desktop.ini', 'icon\r'])

/** The lower-case extension of a file name, without the dot ('' if none). */
export function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Thrown when an upload exceeds the size cap mid-stream. */
export class TooLargeError extends Error {}

/** Abort a stream once it has passed `limit` bytes (Content-Length can lie). */
function limitBytes(limit) {
  let seen = 0
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length
      if (seen > limit) {
        callback(new TooLargeError('file too large'))
        return
      }
      callback(null, chunk)
    },
  })
}

/** A temporary name beside `abs`, hidden from the tree by its leading dot. */
function tempNameFor(abs, kind) {
  return path.join(
    path.dirname(abs),
    `.deckle-${kind}-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`,
  )
}

/** stat, or null when the entry vanished between a listing and the stat. */
async function statOrNull(abs) {
  try {
    return await fs.stat(abs)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * @param {string} rootDir  the library directory
 * @param {{ reservedPaths?: string[], maxFileBytes?: number }} [options]
 *   reservedPaths: extra absolute paths to hide — the state directory, when
 *   DECKLE_STATE_DIR puts it somewhere inside the library other than
 *   RESERVED_DIR. maxFileBytes: the per-file size cap.
 */
export function createLibraryApi(
  rootDir,
  { reservedPaths = [], maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {},
) {
  const root = path.resolve(rootDir)

  // Compared case-insensitively. A library bind-mounted from macOS or Windows
  // lives on a case-insensitive filesystem, where ".DECKLE-STATE" opens the
  // very folder this is guarding. Over-refusing a differently-cased folder on
  // Linux costs nothing.
  const reserved = [path.join(root, RESERVED_DIR), ...reservedPaths.map((p) => path.resolve(p))]
    .map((p) => p.toLowerCase())

  function isReserved(abs) {
    const probe = abs.toLowerCase()
    return reserved.some((r) => probe === r || probe.startsWith(r + path.sep))
  }

  /** Would removing `abs` take a reserved folder with it? */
  function holdsReserved(abs) {
    const probe = abs.toLowerCase()
    return reserved.some((r) => r === probe || r.startsWith(probe + path.sep))
  }

  /**
   * Resolve + symlink-check in one step, refusing the reserved folder.
   *
   * The reserved check runs on the *resolved* path, not the string as sent. It
   * used to compare the first segment of the raw string, so
   * "./.deckle-state/assistant.json" — whose first segment is "." — walked
   * straight past it.
   */
  async function safePath(rel) {
    const abs = resolveLibraryPath(root, rel)
    if (isReserved(abs)) {
      throw new BadPathError(`${RESERVED_DIR} is reserved`)
    }
    await assertRealPathInside(root, abs)
    return abs
  }

  /**
   * Recursive walk producing exactly the shape `buildTree` in src/fs/library.ts
   * builds by hand: folders first, then notes and files together, each group
   * sorted by what the tree shows (a note's title, a file's name), with
   * dotfiles skipped. A `.md` file is a note; anything else is a file — an
   * image, a PDF, a spreadsheet — carried as `kind: 'asset'` so code that only
   * understands notes can tell the two apart. Ids are relative to the directory
   * being walked; the client re-prefixes them if it asked for a subfolder.
   */
  async function walk(abs, prefix) {
    const folders = []
    const files = []

    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue // .trash, .history, .deckle, .git…
      const childAbs = path.join(abs, entry.name)
      if (isReserved(childAbs)) continue
      const id = joinRelative(prefix, entry.name)

      if (entry.isDirectory()) {
        folders.push({
          kind: 'folder',
          id,
          name: entry.name,
          children: await walk(childAbs, id),
        })
      } else if (entry.isFile()) {
        if (CLUTTER.has(entry.name.toLowerCase())) continue
        // A file deleted mid-walk is simply not in the tree, rather than a
        // 404 for the whole library.
        const stat = await statOrNull(childAbs)
        if (!stat) continue
        if (MD_EXT.test(entry.name)) {
          files.push({
            kind: 'file',
            id,
            name: entry.name,
            title: entry.name.replace(MD_EXT, ''),
            updatedAt: Math.round(stat.mtimeMs),
          })
        } else {
          files.push({
            kind: 'asset',
            id,
            name: entry.name,
            // What the tree and tabs show: a file is known by its whole name.
            title: entry.name,
            ext: extensionOf(entry.name),
            size: stat.size,
            updatedAt: Math.round(stat.mtimeMs),
          })
        }
      }
      // Symlinks and other entry kinds are ignored rather than followed.
    }

    folders.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => labelOf(a).localeCompare(labelOf(b)))
    return [...folders, ...files]
  }

  return {
    root,

    /** Create the library directory if this is a first run. */
    async init() {
      await fs.mkdir(root, { recursive: true })
      // Fail fast and loudly if the volume is mounted read-only, rather than
      // letting every later write fail one at a time in the UI.
      await fs.access(root, fsConstants.W_OK)
    },

    async tree(rel) {
      const abs = await safePath(rel)
      return await walk(abs, '')
    },

    async list(rel) {
      const abs = await safePath(rel)
      const entries = await fs.readdir(abs, { withFileTypes: true })
      const out = []
      for (const entry of entries) {
        const childAbs = path.join(abs, entry.name)
        if (isReserved(childAbs)) continue
        if (entry.isDirectory()) {
          out.push({ name: entry.name, kind: 'directory' })
        } else if (entry.isFile()) {
          const stat = await statOrNull(childAbs)
          if (!stat) continue
          out.push({
            name: entry.name,
            kind: 'file',
            lastModified: Math.round(stat.mtimeMs),
            size: stat.size,
          })
        }
      }
      return out
    },

    async stat(rel) {
      const abs = await safePath(rel)
      const stat = await fs.stat(abs)
      if (stat.isDirectory()) return { kind: 'directory' }
      return {
        kind: 'file',
        lastModified: Math.round(stat.mtimeMs),
        size: stat.size,
      }
    },

    /**
     * Open a file for streaming back, after all safety checks.
     *
     * Opened *before* any response header is written, so a file that exists
     * but can't be read (a root-owned file in a bind mount, say) is an error
     * the caller can still answer with a status. It used to be handed to
     * createReadStream after a 200 had gone out, and the stream's unhandled
     * 'error' event took the whole process down with it.
     *
     * The caller owns the returned handle; streaming it closes it.
     */
    async openForRead(rel) {
      const abs = await safePath(rel)
      const handle = await fs.open(abs, 'r')
      try {
        const stat = await handle.stat()
        if (!stat.isFile()) {
          const err = new Error('not a file')
          err.code = 'ENOTFILE'
          throw err
        }
        return { handle, size: stat.size, lastModified: Math.round(stat.mtimeMs) }
      } catch (err) {
        await handle.close().catch(() => {})
        throw err
      }
    },

    /**
     * Stream a request body into a file, creating parent folders. Written to a
     * temporary name in the same directory and renamed into place, so an
     * interrupted upload can't truncate a note that already exists.
     */
    async writeFile(rel, stream) {
      const abs = await safePath(rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const tmp = tempNameFor(abs, 'upload')
      try {
        await pipeline(stream, limitBytes(maxFileBytes), createWriteStream(tmp))
        await fs.rename(tmp, abs)
      } catch (err) {
        await fs.rm(tmp, { force: true })
        throw err
      }
      const stat = await fs.stat(abs)
      return { lastModified: Math.round(stat.mtimeMs), size: stat.size }
    },

    /** Read a file as UTF-8. Used by the JSON stores and the search index. */
    async readText(rel) {
      const abs = await safePath(rel)
      return await fs.readFile(abs, 'utf8')
    },

    /** Read a file's raw bytes — the export archive carries attachments too,
     *  not just Markdown, so it can't go through readText. */
    async readBuffer(rel) {
      const abs = await safePath(rel)
      return await fs.readFile(abs)
    },

    /**
     * Write UTF-8 text — or a Buffer, written as-is — creating parent folders.
     * Same atomic rename as `writeFile`, so an interrupted write can't truncate
     * an existing note.
     */
    async writeText(rel, text) {
      const abs = await safePath(rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const tmp = tempNameFor(abs, 'write')
      try {
        await fs.writeFile(tmp, text, 'utf8')
        await fs.rename(tmp, abs)
      } catch (err) {
        await fs.rm(tmp, { force: true })
        throw err
      }
      const stat = await fs.stat(abs)
      return { lastModified: Math.round(stat.mtimeMs), size: stat.size }
    },

    /** Does an entry exist? Returns 'file', 'directory', or null. */
    async exists(rel) {
      try {
        const abs = await safePath(rel)
        const stat = await fs.stat(abs)
        return stat.isDirectory() ? 'directory' : 'file'
      } catch {
        return null
      }
    },

    async mkdir(rel) {
      const abs = await safePath(rel)
      await fs.mkdir(abs, { recursive: true })
    },

    /**
     * Move a file within the library, creating the destination's folders.
     *
     * A rename, not a copy: the library is one volume, so moving a 90 MB PDF
     * into the recycle bin costs the same as moving a note, and a file can
     * never exist half-copied in two places. Refuses to replace anything
     * already at `toRel` — the callers pick a free name first.
     */
    async rename(fromRel, toRel) {
      const from = await safePath(fromRel)
      const to = await safePath(toRel)
      if (from === root || to === root) throw new BadPathError('cannot move the library root')
      if (holdsReserved(from)) throw new BadPathError(`cannot move ${RESERVED_DIR}`)
      const stat = await fs.stat(from)
      if (from.toLowerCase() !== to.toLowerCase() && (await statOrNull(to))) {
        const err = new Error('destination exists')
        err.code = 'EEXIST'
        throw err
      }
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(from, to)
      return { kind: stat.isDirectory() ? 'directory' : 'file' }
    },

    /**
     * Append UTF-8 text to a file, creating it and its folders if need be.
     * Used for append-only logs, where rewriting the whole file per line
     * would be quadratic.
     */
    async appendText(rel, text) {
      const abs = await safePath(rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.appendFile(abs, text, 'utf8')
      const stat = await fs.stat(abs)
      return { lastModified: Math.round(stat.mtimeMs), size: stat.size }
    },

    async remove(rel, recursive) {
      const abs = await safePath(rel)
      if (abs === root) throw new BadPathError('cannot remove the library root')
      if (holdsReserved(abs)) {
        throw new BadPathError(`cannot remove a folder holding ${RESERVED_DIR}`)
      }
      const stat = await fs.stat(abs)
      if (stat.isDirectory()) {
        if (recursive) {
          await fs.rm(abs, { recursive: true, force: true })
        } else {
          // Matches removeEntry() without { recursive: true }: refuses to
          // delete a non-empty directory.
          await fs.rmdir(abs)
        }
      } else {
        await fs.unlink(abs)
      }
    },

    maxFileBytes,
  }
}

/** What the tree shows for an entry — a note's title, a file's full name. */
function labelOf(node) {
  return node.title
}
