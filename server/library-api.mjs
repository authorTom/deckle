// The server-side library: a thin, deliberately dumb file API over a directory
// in the container (a Docker volume, by default /data).
//
// It mirrors the handful of operations the browser's File System Access API
// offers, because the client adapter (src/fs/remote.ts) presents these
// endpoints *as* a FileSystemDirectoryHandle. Keeping the two in step is what
// lets the rest of the app stay backend-agnostic — notes, history, tasks,
// bookmarks and the AI tools all go through the same handle interface.
//
// Endpoints (all library-relative paths in the ?path= query parameter):
//   GET    /api/library/tree    recursive note tree (one round trip per refresh)
//   GET    /api/library/list    shallow directory listing, including dotfiles
//   GET    /api/library/stat    entry kind + mtime, 404 when missing
//   GET    /api/library/file    file contents
//   PUT    /api/library/file    write file contents (creates parent folders)
//   POST   /api/library/dir     create a directory (mkdir -p)
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
 * The server keeps its own state there (the shared assistant settings, and the
 * API key in them), and it sits under the library directory only because that
 * is the volume a self-hoster actually mounts — not because it is part of the
 * library. Every way out of this module passes through `safePath`, `walk` or
 * `list`, so denying it in those places is what keeps it out of: the file API,
 * the client's export walk (which lists its way through the remote handle), the
 * server's own export walk, the machine API, and the assistant's read_file
 * tool — none of which have any business reading a key.
 *
 * Set DECKLE_STATE_DIR to move the state somewhere else entirely; this name
 * stays reserved either way, so a library can't grow a folder that would
 * later collide with it.
 */
export const RESERVED_DIR = '.deckle-state'

/** Notes are text; this cap stops a single request filling the volume. */
const MAX_FILE_BYTES = 32 * 1024 * 1024

/** Thrown when an upload exceeds MAX_FILE_BYTES mid-stream. */
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
 * @param {{ reservedPaths?: string[] }} [options]
 *   extra absolute paths to hide — the state directory, when DECKLE_STATE_DIR
 *   puts it somewhere inside the library other than RESERVED_DIR
 */
export function createLibraryApi(rootDir, { reservedPaths = [] } = {}) {
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
   * builds by hand: folders first, then files, both sorted by display name,
   * with dotfiles skipped and non-.md files ignored. Ids are relative to the
   * directory being walked; the client re-prefixes them if it asked for a
   * subfolder.
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
      } else if (entry.isFile() && MD_EXT.test(entry.name)) {
        // A note deleted mid-walk is simply not in the tree, rather than a
        // 404 for the whole library.
        const stat = await statOrNull(childAbs)
        if (!stat) continue
        files.push({
          kind: 'file',
          id,
          name: entry.name,
          title: entry.name.replace(MD_EXT, ''),
          updatedAt: Math.round(stat.mtimeMs),
        })
      }
      // Symlinks and other entry kinds are ignored rather than followed.
    }

    folders.sort((a, b) => a.name.localeCompare(b.name))
    files.sort((a, b) => a.title.localeCompare(b.title))
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
        await pipeline(stream, limitBytes(MAX_FILE_BYTES), createWriteStream(tmp))
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

    /** Write UTF-8 text, creating parent folders. Same atomic rename as
     *  `writeFile`, so an interrupted write can't truncate an existing note. */
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

    maxFileBytes: MAX_FILE_BYTES,
  }
}
