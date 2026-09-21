// Server library: a third storage backend, behind the same interface as the
// other two.
//
// src/fs/library.ts, history.ts, tasks/store.ts and bookmarks/store.ts all
// speak `FileSystemDirectoryHandle`. Rather than thread a second
// storage abstraction through all of them, this module implements that same
// handle interface on top of the container's file API (see server/library-api.mjs),
// so the entire app keeps working unchanged when notes live on the server.
//
// Only the subset the app actually uses is implemented — getFileHandle,
// getDirectoryHandle, values, removeEntry, isSameEntry, getFile and
// createWritable. The handles are cast to the DOM types at the boundary
// (`openServerLibrary`), which is the one place the pretence is made explicit.

const API = '/api/library'

export interface ServerLibraryInfo {
  enabled: boolean
  name: string
  authRequired: boolean
  authenticated: boolean
  /** The folder projects live in (DECKLE_PROJECTS_DIR), "Projects" by default. */
  projectsDir?: string
}

/** Called when the server rejects a request as unauthenticated mid-session. */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler
}

/**
 * Marks requests as coming from the app itself — see hasAppHeader() server-side.
 *
 * Exported because every same-origin call to Deckle's own server needs it, not
 * just the library ones: the header is half the CSRF defence, and a caller that
 * forgets it gets a 403 rather than a subtle bug.
 */
export const APP_HEADERS = { 'X-Deckle-App': '1' }

class NotFoundError extends DOMException {
  constructor(message: string) {
    super(message, 'NotFoundError')
  }
}

async function request(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    credentials: 'same-origin',
    headers: { ...APP_HEADERS, ...(init.headers ?? {}) },
  })
  if (res.status === 404) {
    throw new NotFoundError(`Not found: ${input}`)
  }
  if (res.status === 401) {
    // The session expired or the server restarted with a fresh secret. Let the
    // app show the login screen instead of failing every operation silently.
    onUnauthorized?.()
    throw new DOMException('Not authenticated', 'NotAllowedError')
  }
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = ((await res.json()) as { error?: string }).error ?? detail
    } catch {
      // Non-JSON error body — keep the status text.
    }
    throw new Error(`Server library request failed (${res.status}): ${detail}`)
  }
  return res
}

function query(path: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ path, ...extra })
  return `?${params.toString()}`
}

function joinPath(prefix: string, name: string): string {
  return prefix ? `${prefix}/${name}` : name
}

// ---- Handles ---------------------------------------------------------------

interface RemoteEntry {
  name: string
  kind: 'file' | 'directory'
  lastModified?: number
  size?: number
}

/** Buffers writes and flushes them as one PUT on close, like a real writable. */
class RemoteWritable {
  private chunks: BlobPart[] = []

  constructor(private readonly path: string) {}

  async write(data: unknown): Promise<void> {
    // A real FileSystemWritableFileStream also accepts { type: 'write', data }
    // objects; the app only ever passes a string or a Blob (copyDirContents
    // writes a File through verbatim to preserve binary content).
    if (data && typeof data === 'object' && 'data' in (data as object)) {
      this.chunks.push((data as { data: BlobPart }).data)
      return
    }
    this.chunks.push(data as BlobPart)
  }

  async close(): Promise<void> {
    await request(`${API}/file${query(this.path)}`, {
      method: 'PUT',
      body: new Blob(this.chunks),
    })
  }

  async abort(): Promise<void> {
    this.chunks = []
  }
}

class RemoteFileHandle {
  readonly kind = 'file' as const

  constructor(
    readonly name: string,
    /** Path relative to the library root. */
    readonly path: string,
    private readonly known?: { lastModified: number; size: number },
  ) {}

  async getFile(): Promise<File> {
    const res = await request(`${API}/file${query(this.path)}`)
    const blob = await res.blob()
    const header = res.headers.get('X-Last-Modified')
    const lastModified = header ? Number(header) : this.known?.lastModified ?? Date.now()
    return new File([blob], this.name, { lastModified })
  }

  async createWritable(): Promise<RemoteWritable> {
    return new RemoteWritable(this.path)
  }

  async isSameEntry(other: { path?: string } | null): Promise<boolean> {
    return !!other && other.path === this.path
  }
}

class RemoteDirectoryHandle {
  readonly kind = 'directory' as const

  constructor(
    readonly name: string,
    /** Path relative to the library root; '' for the root itself. */
    readonly path: string,
  ) {}

  private async entries(): Promise<RemoteEntry[]> {
    const res = await request(`${API}/list${query(this.path)}`)
    return ((await res.json()) as { entries: RemoteEntry[] }).entries
  }

  async *values(): AsyncGenerator<RemoteFileHandle | RemoteDirectoryHandle> {
    for (const entry of await this.entries()) {
      const childPath = joinPath(this.path, entry.name)
      if (entry.kind === 'directory') {
        yield new RemoteDirectoryHandle(entry.name, childPath)
      } else {
        yield new RemoteFileHandle(entry.name, childPath, {
          lastModified: entry.lastModified ?? 0,
          size: entry.size ?? 0,
        })
      }
    }
  }

  async getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<RemoteFileHandle> {
    const childPath = joinPath(this.path, name)
    const handle = new RemoteFileHandle(name, childPath)
    try {
      const res = await request(`${API}/stat${query(childPath)}`)
      const stat = (await res.json()) as { kind: string }
      if (stat.kind !== 'file') {
        throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
      }
      return handle
    } catch (err) {
      if (!options?.create || !(err instanceof NotFoundError)) throw err
      // Match getFileHandle({ create: true }): the file now exists and is empty.
      await (await handle.createWritable()).close()
      return handle
    }
  }

  async getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<RemoteDirectoryHandle> {
    const childPath = joinPath(this.path, name)
    if (options?.create) {
      await request(`${API}/dir${query(childPath)}`, { method: 'POST' })
      return new RemoteDirectoryHandle(name, childPath)
    }
    const res = await request(`${API}/stat${query(childPath)}`)
    const stat = (await res.json()) as { kind: string }
    if (stat.kind !== 'directory') {
      throw new DOMException(`${name} is a file`, 'TypeMismatchError')
    }
    return new RemoteDirectoryHandle(name, childPath)
  }

  async removeEntry(
    name: string,
    options?: { recursive?: boolean },
  ): Promise<void> {
    const childPath = joinPath(this.path, name)
    await request(
      `${API}/entry${query(childPath, options?.recursive ? { recursive: '1' } : {})}`,
      { method: 'DELETE' },
    )
  }

  async isSameEntry(other: { path?: string } | null): Promise<boolean> {
    return !!other && other.path === this.path
  }
}

// ---- Public API ------------------------------------------------------------

/** True for handles belonging to the server library (used for the tree fast path). */
export function isRemoteHandle(handle: unknown): handle is RemoteDirectoryHandle {
  return handle instanceof RemoteDirectoryHandle
}

/**
 * One round trip for a whole note tree.
 *
 * `buildTree` walks the handle interface entry by entry, which costs one
 * request per file over HTTP. The server can do that walk locally and return
 * the finished tree, so a library refresh is a single request either way.
 */
export async function fetchRemoteTree(
  handle: RemoteDirectoryHandle,
): Promise<unknown[]> {
  const res = await request(`${API}/tree${query(handle.path)}`)
  return ((await res.json()) as { tree: unknown[] }).tree
}

/**
 * Read a note in one request.
 *
 * Going through the handle interface costs a stat *and* a download; reading a
 * note is on the path of every note switch and every search, so it gets a fast
 * lane. A missing file still surfaces as NotFoundError, exactly as the handle
 * version does.
 */
export async function readRemoteFile(
  dir: RemoteDirectoryHandle,
  id: string,
): Promise<string> {
  const res = await request(`${API}/file${query(joinPath(dir.path, id))}`)
  return await res.text()
}

/**
 * Write a note in one request, returning its new modification time.
 *
 * The handle version writes, re-opens and downloads the file just to read back
 * an mtime — three round trips on the debounced save that runs as you type.
 * The server returns the mtime from the write itself. Parent folders are
 * created server-side, matching getDirByPath(…, { create: true }).
 */
export async function writeRemoteFile(
  dir: RemoteDirectoryHandle,
  id: string,
  content: string,
): Promise<number> {
  const res = await request(`${API}/file${query(joinPath(dir.path, id))}`, {
    method: 'PUT',
    body: new Blob([content]),
  })
  const body = (await res.json()) as { lastModified: number }
  return body.lastModified
}

/**
 * Move a file or folder on the server in one request, without transferring it.
 *
 * The handle interface can only copy and delete, which for a 90 MB PDF means
 * downloading it and uploading it again. The server can simply rename. Refuses
 * (as a 409) to replace anything at `to`.
 */
export async function moveRemoteEntry(
  dir: RemoteDirectoryHandle,
  from: string,
  to: string,
): Promise<void> {
  await request(
    `${API}/move${query(joinPath(dir.path, from), { to: joinPath(dir.path, to) })}`,
    { method: 'POST' },
  )
}

/**
 * An entry's modification time and size, or null when it doesn't exist — one
 * small request, for polling a file (the activity log) for change without
 * downloading it.
 */
export async function statRemote(
  dir: RemoteDirectoryHandle,
  path: string,
): Promise<{ lastModified: number; size: number } | null> {
  try {
    const res = await request(`${API}/stat${query(joinPath(dir.path, path))}`)
    const stat = (await res.json()) as { kind: string; lastModified?: number; size?: number }
    return stat.kind === 'file' ? { lastModified: stat.lastModified ?? 0, size: stat.size ?? 0 } : null
  } catch (err) {
    if (err instanceof NotFoundError) return null
    throw err
  }
}

/**
 * Ask the server whether it offers a library. Returns null when this build isn't
 * served by the Deckle server at all (a plain static host, or `npm run dev`
 * without the API running), which is what makes the server option appear only
 * where it can actually work.
 */
export async function detectServerLibrary(): Promise<ServerLibraryInfo | null> {
  try {
    const res = await fetch('/api/server-library', {
      credentials: 'same-origin',
      headers: APP_HEADERS,
      // This runs before anything else on startup, so a server that accepts the
      // connection and then stalls must not wedge the app on its loading
      // screen — give up and fall back to the local backends.
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    const info = (await res.json()) as ServerLibraryInfo
    return info?.enabled ? info : null
  } catch {
    return null
  }
}

/** Submit the library password. Returns null on success, or an error message. */
export async function loginServerLibrary(password: string): Promise<string | null> {
  try {
    const res = await fetch('/api/server-library/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...APP_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) return null
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    return body.error ?? 'Could not sign in.'
  } catch {
    return 'Could not reach the server.'
  }
}

export async function logoutServerLibrary(): Promise<void> {
  try {
    await fetch('/api/server-library/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: APP_HEADERS,
    })
  } catch {
    // Signing out locally is what matters; the cookie expires on its own.
  }
}

/** The server library root, typed as the handle the rest of the app expects. */
export function openServerLibrary(name: string): FileSystemDirectoryHandle {
  return new RemoteDirectoryHandle(name, '') as unknown as FileSystemDirectoryHandle
}
