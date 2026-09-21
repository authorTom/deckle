// BM25 ranking for GET /api/v1/search and MCP's `search` tool.
//
// Lexical search over everything in the library: notes by title, path and
// content, and files by name and path — plus their contents where there is
// text to be had (plain-text formats and office documents; see extract.mjs).
// No key, no network, no config.
//
// The index is rebuilt whenever the library's contents change, detected by a
// cheap signature over every entry's path, mtime and size, so repeated
// searches against an unchanged library cost nothing but the scoring pass.
// Extracted document text is cached per file version, so a rebuild after one
// new note doesn't re-read every spreadsheet in the library.

import { extractText, isExtractable, MAX_EXTRACT_SOURCE_BYTES } from './extract.mjs'

const K1 = 1.2
const B = 0.75

/** Titles and paths are short and highly diagnostic; count them extra. */
const TITLE_WEIGHT = 3

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'it', 'for',
  'with', 'my', 'me', 'i', 'this', 'that', 'be', 'are', 'was', 'were', 'what',
  'which', 'how', 'do', 'does', 'about', 'at', 'as', 'by', 'from', 'not',
])

function tokenize(text) {
  const all = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1)
  const filtered = all.filter((t) => !STOPWORDS.has(t))
  // A query of nothing but stopwords should match them rather than nothing.
  return filtered.length ? filtered : all
}

function snippetAround(content, terms) {
  const lower = content.toLowerCase()
  let index = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (index === -1 || found < index)) index = found
  }
  if (index === -1) {
    return content.slice(0, 180).replace(/\s+/g, ' ').trim()
  }
  const start = Math.max(0, index - 60)
  const end = Math.min(content.length, index + 140)
  let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < content.length) snippet = `${snippet}…`
  return snippet
}

function folderOf(id) {
  return id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : ''
}

export function createSearch(library) {
  let cache = null // { signature, docs, df, avgLength }
  /** Extracted text by `id:mtime:size`, so an unchanged file is read once. */
  const extracted = new Map()

  /** Every note and file in the tree the library API builds. */
  function flatten(nodes, out = []) {
    for (const node of nodes) {
      if (node.kind === 'folder') flatten(node.children, out)
      else out.push(node)
    }
    return out
  }

  /**
   * The searchable text of a file that isn't a note, or '' when it has none.
   * Cached by version; exposed so MCP's `read` shares the work.
   */
  async function fileText(node) {
    if (!isExtractable(node.name) || node.size > MAX_EXTRACT_SOURCE_BYTES) return ''
    const key = `${node.id}:${node.updatedAt}:${node.size}`
    const hit = extracted.get(key)
    if (hit !== undefined) return hit
    let text = ''
    try {
      text = extractText(await library.readBuffer(node.id), node.name) ?? ''
    } catch {
      // Gone, or unreadable: nothing to index.
    }
    extracted.set(key, text)
    return text
  }

  async function buildIndex() {
    const files = flatten(await library.tree(''))
    const signature = files.map((f) => `${f.id}:${f.updatedAt}:${f.size ?? ''}`).join('|')
    if (cache && cache.signature === signature) return cache

    const docs = []
    const df = new Map()
    let totalLength = 0
    const live = new Set()

    for (const file of files) {
      const isNote = file.kind === 'file'
      let content = ''
      try {
        content = isNote ? await library.readText(file.id) : await fileText(file)
      } catch {
        // Disappeared between the walk and the read — skip it.
        continue
      }
      if (!isNote) live.add(`${file.id}:${file.updatedAt}:${file.size}`)

      const title = isNote ? file.title : file.name
      const titleTokens = tokenize(`${title} ${file.id.replace(/[/._-]/g, ' ')}`)
      const tokens = [
        ...Array.from({ length: TITLE_WEIGHT }, () => titleTokens).flat(),
        ...tokenize(content),
      ]

      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      for (const token of tf.keys()) df.set(token, (df.get(token) ?? 0) + 1)

      docs.push({ file, title, isNote, content, tf, length: tokens.length })
      totalLength += tokens.length
    }

    // Forget the text of files that were replaced or removed.
    for (const key of extracted.keys()) if (!live.has(key)) extracted.delete(key)

    cache = {
      signature,
      docs,
      df,
      avgLength: docs.length ? totalLength / docs.length : 1,
    }
    return cache
  }

  /**
   * Rank notes and files against `query`. `folder` restricts the search to one
   * subtree; `kind` to notes ('note') or other files ('file').
   * Returns `{ path, title, folder, kind, score, snippet, updatedAt }` objects.
   */
  async function search(query, { limit = 10, folder = '', kind } = {}) {
    const terms = tokenize(query)
    if (!terms.length) return []

    const index = await buildIndex()
    const total = index.docs.length || 1
    const scored = []

    for (const doc of index.docs) {
      if (folder && !doc.file.id.startsWith(`${folder}/`)) continue
      if (kind === 'note' && !doc.isNote) continue
      if (kind === 'file' && doc.isNote) continue

      let score = 0
      for (const term of terms) {
        const tf = doc.tf.get(term)
        if (!tf) continue
        const df = index.df.get(term) ?? 0
        // BM25's idf, in the form that stays positive for common terms.
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5))
        const norm = 1 - B + (B * doc.length) / index.avgLength
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm))
      }
      if (score <= 0) continue

      const result = {
        path: doc.file.id,
        title: doc.title,
        folder: folderOf(doc.file.id),
        kind: doc.isNote ? 'note' : 'file',
        score: Number(score.toFixed(4)),
        snippet: doc.content ? snippetAround(doc.content, terms) : '',
        updatedAt: doc.file.updatedAt,
      }
      if (!doc.isNote) result.size = doc.file.size
      scored.push(result)
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** The extracted text of one file, for MCP's `read` (null when there's none). */
  async function textOf(path) {
    const stat = await library.stat(path)
    const name = path.slice(path.lastIndexOf('/') + 1)
    const text = await fileText({ id: path, name, size: stat.size, updatedAt: stat.lastModified })
    return text || null
  }

  return { search, textOf }
}
