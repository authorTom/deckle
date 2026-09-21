import { useEffect, useState } from 'react'
import type { TreeNode } from '../fs/library'
import { readCached } from '../lib/contentCache'
import { listProjects, type Project } from './projects'

/**
 * The library's projects, recomputed whenever the tree changes. Overviews are
 * read through the shared content cache, keyed by modification time, so this
 * costs a walk of the tree unless an overview actually changed.
 */
export function useProjects(
  dir: FileSystemDirectoryHandle | null,
  tree: TreeNode[],
  root: string,
): Project[] {
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    if (!dir) {
      setProjects([])
      return
    }
    let cancelled = false
    void listProjects(tree, root, (id, updatedAt) =>
      readCached(dir, {
        kind: 'file',
        id,
        name: id.slice(id.lastIndexOf('/') + 1),
        title: '',
        updatedAt,
      }),
    ).then((list) => {
      if (!cancelled) setProjects(list)
    })
    return () => {
      cancelled = true
    }
  }, [dir, tree, root])

  return projects
}
