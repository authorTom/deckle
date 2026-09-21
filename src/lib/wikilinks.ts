import type { LibraryFile } from '../fs/library'

/** `[[Target]]` or `[[Target|shown text]]`, never spanning a line break. */
export const WIKILINK_RE = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g

export interface WikilinkRef {
  /** What was written inside the brackets, before any `|alias`. */
  target: string
  /** Character offset of the opening `[` in the source text. */
  index: number
  /** Length of the whole `[[…]]` run. */
  length: number
}

/** Every wikilink in a chunk of markdown, in document order. */
export function extractWikilinks(markdown: string): WikilinkRef[] {
  const out: WikilinkRef[] = []
  // The regex is module-level and /g, so reset before each independent scan.
  WIKILINK_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WIKILINK_RE.exec(markdown))) {
    out.push({ target: m[1].trim(), index: m.index, length: m[0].length })
  }
  return out
}

function normalize(s: string): string {
  return s.trim().toLowerCase()
}

/** Strip a trailing `.md`, so `[[Notes/Ideas.md]]` and `[[Notes/Ideas]]` agree. */
function withoutExt(s: string): string {
  return s.replace(/\.mdx?$/i, '')
}

/**
 * Resolve a wikilink target to a note — or file — id.
 *
 * Tried in order: an exact path match, then a title match in the same folder as
 * the note doing the linking, then a title match anywhere. The folder-first rule
 * is what makes `[[Index]]` mean the local index rather than a random one. A
 * file's title is its whole name, so `[[Q3 report.pdf]]` finds the PDF.
 * Returns null when nothing matches — the caller renders that as a broken link.
 */
export function resolveWikilink(
  target: string,
  files: LibraryFile[],
  fromNoteId: string | null = null,
): string | null {
  const wanted = normalize(withoutExt(target))
  if (!wanted) return null

  for (const f of files) {
    if (normalize(withoutExt(f.id)) === wanted) return f.id
  }

  const fromFolder =
    fromNoteId && fromNoteId.includes('/')
      ? fromNoteId.slice(0, fromNoteId.lastIndexOf('/'))
      : ''
  if (fromFolder) {
    for (const f of files) {
      const folder = f.id.includes('/') ? f.id.slice(0, f.id.lastIndexOf('/')) : ''
      if (folder === fromFolder && normalize(f.title) === wanted) return f.id
    }
  }

  for (const f of files) {
    if (normalize(f.title) === wanted) return f.id
  }
  return null
}

/** The text a new `[[…]]` should contain to point at `note` from `fromNoteId`. */
export function wikilinkTargetFor(
  note: LibraryFile,
  files: LibraryFile[],
  fromNoteId: string | null,
): string {
  // Prefer the bare title; fall back to the full path when the title is
  // ambiguous, so the link can't silently resolve to the wrong note.
  const sameTitle = files.filter(
    (f) => normalize(f.title) === normalize(note.title),
  )
  if (sameTitle.length <= 1) return note.title
  const resolved = resolveWikilink(note.title, files, fromNoteId)
  return resolved === note.id ? note.title : withoutExt(note.id)
}

export interface Backlink {
  /** Id of the note containing the link. */
  id: string
  title: string
  /** A short excerpt of the sentence the link appears in. */
  context: string
}

/**
 * Notes that link to `targetId`, with a snippet of surrounding text.
 * `contents` is a map of note id → markdown; callers pass the cache they
 * already keep for search rather than re-reading the library. `files` is every
 * note and file, so a link resolves exactly as it does in the editor; only the
 * entries with contents — the notes — are read as sources.
 */
export function findBacklinks(
  targetId: string,
  files: LibraryFile[],
  contents: Map<string, string>,
): Backlink[] {
  const out: Backlink[] = []
  for (const file of files) {
    if (file.id === targetId) continue
    const md = contents.get(file.id)
    if (!md) continue
    for (const link of extractWikilinks(md)) {
      if (resolveWikilink(link.target, files, file.id) !== targetId) continue
      out.push({ id: file.id, title: file.title, context: contextAt(md, link) })
      break // one entry per linking note, however many times it links
    }
  }
  return out
}

/** ~120 characters of the line the link sits on, with the link marked by «». */
function contextAt(md: string, link: WikilinkRef): string {
  const lineStart = md.lastIndexOf('\n', link.index) + 1
  const lineEnd = md.indexOf('\n', link.index)
  const line = md.slice(lineStart, lineEnd === -1 ? md.length : lineEnd)
  const collapsed = line.replace(/\s+/g, ' ').trim()
  return collapsed.length > 140 ? `${collapsed.slice(0, 140)}…` : collapsed
}
