import { useEffect, useState } from 'react'
import type { AssetFile, NoteFile } from '../fs/library'
import { readCached } from '../lib/contentCache'

/**
 * The sidebar's search: notes by title, folder and text, other files by name
 * and folder, filtered as the person types.
 *
 * Files that aren't notes are found by name only. Their contents are searched
 * by the server's index (GET /api/v1/search, and MCP), which can read inside
 * office documents; the sidebar stays a quick filter over what is in memory.
 */
export function useLibrarySearch(
  dir: FileSystemDirectoryHandle | null,
  files: NoteFile[],
  assets: AssetFile[],
) {
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)

  useEffect(() => {
    const q = query.trim().toLowerCase()
    if (!q || !dir) {
      setSearchResults(null)
      return
    }
    let cancelled = false
    const t = setTimeout(async () => {
      const out: SearchResult[] = []
      // Files that aren't notes are found by name and folder. Their contents
      // are searched by the server's index (GET /api/v1/search, and MCP),
      // which can read inside office documents; the sidebar stays a quick
      // filter over what is already in memory.
      for (const asset of assets) {
        const folderPath = asset.id.includes('/') ? asset.id.slice(0, asset.id.lastIndexOf('/')) : ''
        if (asset.name.toLowerCase().includes(q) || folderPath.toLowerCase().includes(q)) {
          out.push({ id: asset.id, title: asset.name, folderPath, snippet: '', kind: 'asset', name: asset.name })
        }
      }
      for (const file of files) {
        if (cancelled) return
        const folderPath = file.id.includes('/')
          ? file.id.slice(0, file.id.lastIndexOf('/'))
          : ''
        const titleMatch =
          file.title.toLowerCase().includes(q) || folderPath.toLowerCase().includes(q)

        const content = await readCached(dir, file)

        let snippet = ''
        let contentMatch = false
        if (!titleMatch) {
          const idx = content.toLowerCase().indexOf(q)
          if (idx >= 0) {
            contentMatch = true
            snippet = makeSnippet(content, idx, q.length)
          }
        }

        if (titleMatch || contentMatch) {
          out.push({ id: file.id, title: file.title, folderPath, snippet, kind: 'file', name: file.name })
        }
      }
      if (!cancelled) setSearchResults(out)
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, dir, files, assets])

  return { query, setQuery, searchResults }
}

export interface SearchResult {
  id: string
  title: string
  folderPath: string
  snippet: string
  /** A note, or any other file (found by name). */
  kind: 'file' | 'asset'
  name: string
}

function makeSnippet(content: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 25)
  const end = Math.min(content.length, idx + len + 45)
  let snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
  if (start > 0) snippet = `…${snippet}`
  if (end < content.length) snippet = `${snippet}…`
  return snippet
}
