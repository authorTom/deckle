// An in-memory implementation of the slice of the File System Access API the
// app uses, so library, history, stores and tools can be tested without a
// browser. It follows the real API's behaviour where the app depends on it:
// names are single path segments, a missing entry is a NotFoundError, a file
// where a folder was expected is a TypeMismatchError, and a non-empty folder
// can't be removed without { recursive: true }.

interface FileNode {
  kind: 'file'
  name: string
  data: Uint8Array
  lastModified: number
}

interface DirNode {
  kind: 'directory'
  name: string
  entries: Map<string, FileNode | DirNode>
}

export interface MemFsOptions {
  /** Treat names case-insensitively, like macOS and Windows disks. */
  caseInsensitive?: boolean
  /** Called before a write lands; await something here to make it slow, or throw. */
  beforeWrite?: (path: string, text: string) => Promise<void> | void
  /** Called before a file is read. */
  beforeRead?: (path: string) => Promise<void> | void
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function notFound(name: string): DOMException {
  return new DOMException(`${name} not found`, 'NotFoundError')
}

function checkName(name: string): void {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new TypeError(`Name is not allowed: "${name}"`)
  }
}

class MemFile {
  constructor(
    readonly name: string,
    private readonly bytes: Uint8Array,
    readonly lastModified: number,
  ) {}
  get size() {
    return this.bytes.length
  }
  async text() {
    return decoder.decode(this.bytes)
  }
  async arrayBuffer() {
    return this.bytes.slice().buffer
  }
}

async function toBytes(data: unknown): Promise<Uint8Array> {
  if (typeof data === 'string') return encoder.encode(data)
  if (data instanceof Uint8Array) return data
  if (data && typeof (data as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return new Uint8Array(await (data as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer())
  }
  if (data && typeof data === 'object' && 'data' in (data as object)) {
    return toBytes((data as { data: unknown }).data)
  }
  throw new TypeError('unsupported write')
}

class MemFileHandle {
  readonly kind = 'file' as const
  constructor(
    readonly name: string,
    readonly node: FileNode,
    private readonly path: string,
    private readonly options: MemFsOptions,
  ) {}

  async getFile(): Promise<File> {
    await this.options.beforeRead?.(this.path)
    return new MemFile(this.node.name, this.node.data, this.node.lastModified) as unknown as File
  }

  async createWritable() {
    const chunks: Uint8Array[] = []
    const node = this.node
    const path = this.path
    const options = this.options
    return {
      async write(data: unknown) {
        chunks.push(await toBytes(data))
      },
      async close() {
        const total = chunks.reduce((n, c) => n + c.length, 0)
        const out = new Uint8Array(total)
        let at = 0
        for (const c of chunks) {
          out.set(c, at)
          at += c.length
        }
        await options.beforeWrite?.(path, decoder.decode(out))
        node.data = out
        node.lastModified = Date.now()
      },
      async abort() {
        chunks.length = 0
      },
    }
  }

  async isSameEntry(other: { node?: unknown } | null) {
    return !!other && other.node === this.node
  }
}

class MemDirHandle {
  readonly kind = 'directory' as const
  constructor(
    readonly node: DirNode,
    private readonly path: string,
    private readonly options: MemFsOptions,
  ) {}

  get name() {
    return this.node.name
  }

  private key(name: string) {
    return this.options.caseInsensitive ? name.toLowerCase() : name
  }

  private child(name: string) {
    return this.path ? `${this.path}/${name}` : name
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}) {
    checkName(name)
    const existing = this.node.entries.get(this.key(name))
    if (existing?.kind === 'directory') {
      throw new DOMException(`${name} is a directory`, 'TypeMismatchError')
    }
    if (existing) return new MemFileHandle(existing.name, existing, this.child(existing.name), this.options)
    if (!opts.create) throw notFound(name)
    const node: FileNode = { kind: 'file', name, data: new Uint8Array(), lastModified: Date.now() }
    this.node.entries.set(this.key(name), node)
    return new MemFileHandle(name, node, this.child(name), this.options)
  }

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}) {
    checkName(name)
    const existing = this.node.entries.get(this.key(name))
    if (existing?.kind === 'file') {
      throw new DOMException(`${name} is a file`, 'TypeMismatchError')
    }
    if (existing) return new MemDirHandle(existing, this.child(existing.name), this.options)
    if (!opts.create) throw notFound(name)
    const node: DirNode = { kind: 'directory', name, entries: new Map() }
    this.node.entries.set(this.key(name), node)
    return new MemDirHandle(node, this.child(name), this.options)
  }

  async removeEntry(name: string, opts: { recursive?: boolean } = {}) {
    checkName(name)
    const existing = this.node.entries.get(this.key(name))
    if (!existing) throw notFound(name)
    if (existing.kind === 'directory' && existing.entries.size && !opts.recursive) {
      throw new DOMException(`${name} is not empty`, 'InvalidModificationError')
    }
    this.node.entries.delete(this.key(name))
  }

  async *values() {
    for (const entry of [...this.node.entries.values()]) {
      yield entry.kind === 'file'
        ? new MemFileHandle(entry.name, entry, this.child(entry.name), this.options)
        : new MemDirHandle(entry, this.child(entry.name), this.options)
    }
  }

  async isSameEntry(other: { node?: unknown } | null) {
    return !!other && other.node === this.node
  }
}

/** A fresh, empty library root. */
export function createMemFs(options: MemFsOptions = {}): FileSystemDirectoryHandle {
  const root: DirNode = { kind: 'directory', name: 'Library', entries: new Map() }
  return new MemDirHandle(root, '', options) as unknown as FileSystemDirectoryHandle
}

/** Write a file at a slash-separated path, creating folders. */
export async function put(
  dir: FileSystemDirectoryHandle,
  path: string,
  content: string,
): Promise<void> {
  const parts = path.split('/')
  const name = parts.pop() as string
  let here = dir
  for (const part of parts) here = await here.getDirectoryHandle(part, { create: true })
  const handle = await here.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}

/** Read a file at a slash-separated path, or null when it doesn't exist. */
export async function get(dir: FileSystemDirectoryHandle, path: string): Promise<string | null> {
  const parts = path.split('/')
  const name = parts.pop() as string
  try {
    let here = dir
    for (const part of parts) here = await here.getDirectoryHandle(part)
    return await (await (await here.getFileHandle(name)).getFile()).text()
  } catch {
    return null
  }
}

/** Every file path under a folder, sorted — the whole tree at a glance. */
export async function listAll(dir: FileSystemDirectoryHandle, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()
  for await (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.kind === 'file') out.push(path)
    else out.push(...(await listAll(entry as FileSystemDirectoryHandle, path)))
  }
  return out.sort()
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
