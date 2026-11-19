import { useCallback, useEffect, useState } from 'react'
import type { TreeNode } from '../fs/library'
import { readCached } from '../lib/contentCache'
import { EMPTY_RUNS, byUrgency, listBriefs, readRuns, type Brief, type RunsState } from './briefs'

/** How often to re-read runs.json while the page is in view: it moves without the tree moving. */
const RUNS_POLL_MS = 60_000

/**
 * The library's briefs, recomputed whenever the tree changes, and the server's
 * view of who is working on what (runs.json). Brief.md files are read through
 * the shared content cache, keyed by modification time, so an unchanged
 * library costs a walk of the tree.
 *
 * runs.json changes when an agent merely polls or reports progress — neither
 * moves the tree — so it is also re-read once a minute while the tab is in view.
 */
export function useBriefs(dir: FileSystemDirectoryHandle | null, tree: TreeNode[], root: string) {
  const [briefs, setBriefs] = useState<Brief[]>([])
  const [runs, setRuns] = useState<RunsState>(EMPTY_RUNS)

  useEffect(() => {
    if (!dir) {
      setBriefs([])
      return
    }
    let cancelled = false
    void listBriefs(tree, root, (id, updatedAt) =>
      readCached(dir, { kind: 'file', id, name: id.slice(id.lastIndexOf('/') + 1), title: '', updatedAt }),
    ).then((list) => {
      if (!cancelled) setBriefs(list.sort(byUrgency))
    })
    return () => {
      cancelled = true
    }
  }, [dir, tree, root])

  const refreshRuns = useCallback(async () => {
    if (!dir) {
      setRuns(EMPTY_RUNS)
      return
    }
    try {
      setRuns(await readRuns(dir))
    } catch {
      // Offline or signed out: keep what we had.
    }
  }, [dir])

  useEffect(() => {
    void refreshRuns()
  }, [refreshRuns, tree])

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') void refreshRuns()
    }
    const timer = window.setInterval(tick, RUNS_POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [refreshRuns])

  return { briefs, runs, refreshRuns }
}
