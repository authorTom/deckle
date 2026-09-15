// Memory persistence: one Markdown file per memory, under `.deckle/memory/`
// inside the library, so memory travels with the notes (sync, backup, ZIP
// export) and is readable in any editor without Deckle.
//
// Hidden rather than a visible `Memory/` folder in the tree, and the reason is
// not tidiness: a visible folder would put every memory into note search, into
// the backlinks index, and into the assistant's own `search_notes` results,
// where it would retrieve its memories a second time as if they were notes.
// One path to memory is worth the panel it costs.
//
// Reads are cached for the session. A library on the server is reached over
// HTTP, where re-reading forty small files on every assistant turn is forty
// requests; the cache is invalidated by our own writes and by an explicit
// refresh, so a file edited underneath us in another editor is picked up when
// the panel is opened rather than instantly. That trade is deliberate.

import { dataSubdir } from '../fs/appData'
import { parseFrontmatter, withFrontmatter } from './frontmatter'
import { KIND_FOLDER, type Confidence, type Memory, type MemoryDraft, type MemoryKind } from './types'

const MEMORY_DIR = 'memory'
const INDEX_FILE = 'index.md'
const MD = /\.md$/i

/** Today as "YYYY-MM-DD", matching how the planner stores dates. */
function today(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * "Writes British English and expects the copy to match"
 *   → "writes-british-english-and-expects-the"
 *
 * Short on purpose, and cut at a word boundary. Every path appears in
 * `index.md`, which goes into every single request — so a store of forty
 * memories pays for forty file names on every message, and a name that runs to
 * the full summary doubles the cost of the line it sits on. It also has to
 * stay readable, because these are files someone may open in another editor;
 * a hash would be cheaper and useless.
 */
const SLUG_MAX = 40

export function slugify(text: string): string {
  const words = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (words.length <= SLUG_MAX) return words || 'memory'
  const cut = words.slice(0, SLUG_MAX)
  const boundary = cut.lastIndexOf('-')
  // Only fall back to a hard cut when the first word is itself over-long.
  return (boundary > 12 ? cut.slice(0, boundary) : cut) || 'memory'
}

function isKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && value in KIND_FOLDER
}

function toMemory(path: string, text: string): Memory {
  const { data, body } = parseFrontmatter(text)
  const kind = isKind(data.kind) ? data.kind : 'fact'
  const confidence =
    data.confidence === 'low' || data.confidence === 'high'
      ? (data.confidence as Confidence)
      : 'medium'
  return {
    path,
    kind,
    // A memory with no summary still has to be listable, so fall back to its
    // first line rather than showing an empty row.
    summary:
      typeof data.summary === 'string' && data.summary
        ? data.summary
        : body.split('\n')[0]?.slice(0, 120) || path,
    tags: Array.isArray(data.tags) ? data.tags : [],
    pinned: data.pinned === true,
    confidence,
    created: typeof data.created === 'string' ? data.created : today(),
    updated: typeof data.updated === 'string' ? data.updated : today(),
    uses: typeof data.uses === 'number' ? data.uses : 0,
    body,
  }
}

function serialize(memory: Memory): string {
  return withFrontmatter(
    {
      kind: memory.kind,
      summary: memory.summary,
      tags: memory.tags,
      pinned: memory.pinned,
      confidence: memory.confidence,
      created: memory.created,
      updated: memory.updated,
      uses: memory.uses,
    },
    memory.body,
  )
}

// ---- File plumbing ----------------------------------------------------------

interface Entry {
  parent: FileSystemDirectoryHandle
  name: string
}

/** Walk a memory path ("preferences/x.md") to its folder and file name. */
async function locate(
  dir: FileSystemDirectoryHandle,
  path: string,
  create: boolean,
): Promise<Entry> {
  const segments = path.split('/').filter(Boolean)
  // The memory tools run without an approval step, so their paths must not
  // be able to climb out of the memory folder — whatever a backend would say.
  if (segments.some((s) => s === '.' || s === '..' || s.includes('\\'))) {
    throw new Error('Invalid memory path')
  }
  const name = segments.pop()
  if (!name) throw new Error('Invalid memory path')
  let parent = await dataSubdir(dir, MEMORY_DIR, create)
  for (const segment of segments) {
    parent = await parent.getDirectoryHandle(segment, { create })
  }
  return { parent, name }
}

async function readText(dir: FileSystemDirectoryHandle, path: string): Promise<string> {
  const { parent, name } = await locate(dir, path, false)
  return await (await (await parent.getFileHandle(name)).getFile()).text()
}

async function writeText(
  dir: FileSystemDirectoryHandle,
  path: string,
  text: string,
): Promise<void> {
  const { parent, name } = await locate(dir, path, true)
  const handle = await parent.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(text)
  await writable.close()
}

function asAsyncEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<FileSystemHandle> {
  return (dir as unknown as { values: () => AsyncIterable<FileSystemHandle> }).values()
}

/** Every `.md` under the memory folder, one level of subfolders deep. */
async function listPaths(dir: FileSystemDirectoryHandle): Promise<string[]> {
  let root: FileSystemDirectoryHandle
  try {
    root = await dataSubdir(dir, MEMORY_DIR, false)
  } catch {
    return [] // nothing remembered yet
  }
  const paths: string[] = []
  for await (const entry of asAsyncEntries(root)) {
    if (entry.kind === 'file') {
      if (MD.test(entry.name) && entry.name !== INDEX_FILE) paths.push(entry.name)
      continue
    }
    const sub = await root.getDirectoryHandle(entry.name)
    for await (const child of asAsyncEntries(sub)) {
      if (child.kind === 'file' && MD.test(child.name)) {
        paths.push(`${entry.name}/${child.name}`)
      }
    }
  }
  return paths.sort()
}

// ---- Session cache ----------------------------------------------------------

const cache = new WeakMap<FileSystemDirectoryHandle, Memory[]>()

/** Drop the cached snapshot — after a write, or when the panel asks to reload. */
export function invalidate(dir: FileSystemDirectoryHandle | null): void {
  if (dir) cache.delete(dir)
}

/** Every memory in the library. Cached per library for the session. */
export async function loadMemories(
  dir: FileSystemDirectoryHandle,
  force = false,
): Promise<Memory[]> {
  const hit = cache.get(dir)
  if (hit && !force) return hit

  const paths = await listPaths(dir)
  const out: Memory[] = []
  for (const path of paths) {
    try {
      out.push(toMemory(path, await readText(dir, path)))
    } catch {
      // A file that vanished or won't parse is skipped, not fatal: one bad
      // memory must not cost the user the other thirty.
    }
  }
  cache.set(dir, out)
  return out
}

// ---- Writing ----------------------------------------------------------------

/** A path for a new memory that no existing file has taken. */
function uniquePath(taken: Set<string>, kind: MemoryKind, summary: string): string {
  const base = `${KIND_FOLDER[kind]}/${slugify(summary)}`
  if (!taken.has(`${base}.md`)) return `${base}.md`
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}.md`
    if (!taken.has(candidate)) return candidate
  }
}

/** Create a memory. Returns the path it landed at. */
export async function createMemory(
  dir: FileSystemDirectoryHandle,
  draft: MemoryDraft,
): Promise<Memory> {
  const existing = await loadMemories(dir)
  const kind = draft.kind ?? 'fact'
  const memory: Memory = {
    path: uniquePath(new Set(existing.map((m) => m.path)), kind, draft.summary),
    kind,
    summary: draft.summary.trim(),
    tags: draft.tags ?? [],
    pinned: draft.pinned ?? false,
    confidence: draft.confidence ?? 'medium',
    created: today(),
    updated: today(),
    uses: 0,
    body: draft.body.trim(),
  }
  await writeText(dir, memory.path, serialize(memory))
  invalidate(dir)
  await rebuildIndex(dir)
  return memory
}

/** Overwrite an existing memory, keeping whatever the caller didn't set. */
export async function updateMemory(
  dir: FileSystemDirectoryHandle,
  path: string,
  patch: Partial<Omit<Memory, 'path' | 'created'>>,
): Promise<Memory> {
  const current = toMemory(path, await readText(dir, path))
  const next: Memory = {
    ...current,
    ...patch,
    path,
    created: current.created,
    updated: today(),
  }
  await writeText(dir, path, serialize(next))
  invalidate(dir)
  await rebuildIndex(dir)
  return next
}

export async function deleteMemory(
  dir: FileSystemDirectoryHandle,
  path: string,
): Promise<void> {
  const { parent, name } = await locate(dir, path, false)
  await parent.removeEntry(name)
  invalidate(dir)
  await rebuildIndex(dir)
}

/**
 * Bump retrieval counters for the memories that made it into a prompt.
 *
 * Deliberately fire-and-forget and deliberately cheap: it rewrites the files
 * whose count changed and nothing else, and a failure is swallowed. A counter
 * is worth having for the review list; it is not worth failing a turn over.
 */
export async function recordUses(
  dir: FileSystemDirectoryHandle,
  paths: string[],
): Promise<void> {
  for (const path of paths) {
    try {
      const memory = toMemory(path, await readText(dir, path))
      await writeText(
        dir,
        path,
        serialize({ ...memory, uses: memory.uses + 1 }),
      )
    } catch {
      // Counting is best-effort.
    }
  }
  invalidate(dir)
}

// ---- The index --------------------------------------------------------------

/**
 * `index.md` — one line per memory, and the only file loaded into every
 * prompt. It is derived, never authoritative: the memory files are the record,
 * and this is rewritten from them after every change. Kept as Markdown rather
 * than JSON because the model reads it directly and because the user opening
 * `.deckle/memory/index.md` in another editor should find something legible.
 */
export async function rebuildIndex(dir: FileSystemDirectoryHandle): Promise<string> {
  const memories = await loadMemories(dir, true)
  const lines = memories
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((m) => `- ${m.path} — ${m.summary}${m.pinned ? ' *(pinned)*' : ''}`)

  const text = [
    '# Memory index',
    '',
    'One line per memory. Written by Deckle from the files in this folder —',
    'edit the memories themselves, not this list.',
    '',
    ...(lines.length ? lines : ['*(nothing remembered yet)*']),
    '',
  ].join('\n')

  try {
    await writeText(dir, INDEX_FILE, text)
  } catch {
    // A read-only or missing library shouldn't break the write that triggered
    // this; the index rebuilds from the files next time.
  }
  return text
}

/** The index as text, rebuilding it if it has drifted from the files. */
export async function readIndex(dir: FileSystemDirectoryHandle): Promise<string> {
  const memories = await loadMemories(dir)
  if (!memories.length) return ''
  try {
    const text = await readText(dir, INDEX_FILE)
    // Cheap staleness check: every memory should appear once. Anything else
    // (a file added by hand, one deleted outside the app) triggers a rebuild.
    const stale = memories.some((m) => !text.includes(m.path))
    if (!stale) return text
  } catch {
    // No index yet.
  }
  return await rebuildIndex(dir)
}
