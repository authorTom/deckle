// Projects, from the app's side: a convention over folders.
//
// A project is any folder directly inside the projects folder ("Projects" by
// default; a server library may name another with DECKLE_PROJECTS_DIR). Its
// Overview.md — or README.md, or index.md — carries its status, summary and
// tags as front matter; its Log.md is the dated record an agent keeps as it
// works. Mirrors server/projects.mjs, which is what an agent's MCP tools use:
// the two must read a project the same way.

import * as library from '../fs/library'
import * as history from '../fs/history'
import type { NoteFolder, TreeNode } from '../fs/library'
import { parseFrontmatter, setFrontmatterFields } from '../lib/frontmatter'

export const DEFAULT_PROJECTS_DIR = 'Projects'
export const OVERVIEW = 'Overview.md'
export const LOG = 'Log.md'
const OVERVIEW_CANDIDATES = [OVERVIEW, 'README.md', 'Readme.md', 'readme.md', 'index.md']

export const STATUSES = ['active', 'paused', 'done', 'archived'] as const
export type ProjectStatus = (typeof STATUSES)[number]

export interface Project {
  name: string
  /** The project's folder, e.g. "Projects/Acme research". */
  path: string
  /** One of STATUSES, something else an agent wrote, or null for none. */
  status: string | null
  summary: string
  tags: string[]
  created: string | null
  /** The note describing it, if it has one. */
  overview: string | null
  log: string | null
  notes: number
  files: number
  /** The newest change to anything inside it. */
  updatedAt: number
  /** The most recently changed note or file inside, to open when it has no overview. */
  latest: string | null
}

/** The projects folder's node in a tree, if the library has one. */
export function projectsFolder(tree: TreeNode[], root: string): NoteFolder | null {
  let nodes = tree
  let found: NoteFolder | null = null
  for (const segment of root.split('/')) {
    found = (nodes.find((n) => n.kind === 'folder' && n.name === segment) as NoteFolder) ?? null
    if (!found) return null
    nodes = found.children
  }
  return found
}

function asTags(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(',') : []
  return list.map((t) => String(t).trim().replace(/^#/, '')).filter(Boolean)
}

/**
 * Every project in the library, most recently changed first. `readNote` reads
 * an overview's text (the app's cached reader), so an unchanged library costs
 * nothing but a walk of the tree.
 */
export async function listProjects(
  tree: TreeNode[],
  root: string,
  readNote: (id: string, updatedAt: number) => Promise<string>,
): Promise<Project[]> {
  const folder = projectsFolder(tree, root)
  if (!folder) return []
  const out: Project[] = []
  for (const node of folder.children) {
    if (node.kind !== 'folder') continue
    const direct = node.children
    const overviewNode = OVERVIEW_CANDIDATES.map((name) =>
      direct.find((c) => c.kind === 'file' && c.name === name),
    ).find(Boolean)
    let meta: Record<string, unknown> = {}
    if (overviewNode && overviewNode.kind === 'file') {
      try {
        meta = parseFrontmatter(await readNote(overviewNode.id, overviewNode.updatedAt))
      } catch {
        // Unreadable overview: listed without metadata.
      }
    }
    let notes = 0
    let files = 0
    let updatedAt = 0
    let latest: string | null = null
    const walk = (nodes: TreeNode[]) => {
      for (const child of nodes) {
        if (child.kind === 'folder') walk(child.children)
        else {
          if (child.kind === 'file') notes++
          else files++
          if (child.updatedAt > updatedAt) {
            updatedAt = child.updatedAt
            latest = child.id
          }
        }
      }
    }
    walk(direct)
    out.push({
      name: node.name,
      path: node.id,
      status: typeof meta.status === 'string' && meta.status ? meta.status : null,
      summary:
        typeof meta.summary === 'string'
          ? meta.summary
          : typeof meta.description === 'string'
            ? meta.description
            : '',
      tags: asTags(meta.tags),
      created: meta.created ? String(meta.created) : null,
      overview: overviewNode ? overviewNode.id : null,
      log: direct.some((c) => c.kind === 'file' && c.name === LOG) ? `${node.id}/${LOG}` : null,
      notes,
      files,
      updatedAt,
      latest,
    })
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  return out
}

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Start a project by hand: its folder and an Overview.md. Returns the overview's id. */
export async function createProject(
  dir: FileSystemDirectoryHandle,
  root: string,
  name: string,
  summary: string,
): Promise<string> {
  const folder = await library.createFolder(dir, root, name)
  const title = folder.slice(folder.lastIndexOf('/') + 1)
  const oneLine = summary.replace(/\s+/g, ' ').trim()
  const content = [
    '---',
    'type: project',
    'status: active',
    `summary: ${JSON.stringify(oneLine)}`,
    'tags: []',
    `created: ${today()}`,
    '---',
    '',
    `# ${title}`,
    '',
    oneLine,
    '',
  ].join('\n')
  const id = `${folder}/${OVERVIEW}`
  await library.writeNote(dir, id, content)
  return id
}

/**
 * Change a project's status in its Overview.md's front matter. The version it
 * replaces goes into history, as any other edit to a note would.
 *
 * Always Overview.md, never a README standing in for one: a pushed code
 * project's README belongs to the code, and front matter would show up in it
 * wherever else it is read. A project without an Overview.md gets one, carrying
 * over the summary and tags its README gave it.
 */
export async function setProjectStatus(
  dir: FileSystemDirectoryHandle,
  project: Project,
  status: ProjectStatus,
): Promise<string> {
  const id = `${project.path}/${OVERVIEW}`
  let current = ''
  let patch: Record<string, string | string[]> = { status }
  if (project.overview === id) {
    current = await library.readNote(dir, id)
  } else {
    current = `# ${project.name}\n`
    patch = { type: 'project', status, summary: project.summary, tags: project.tags }
  }
  const next = setFrontmatterFields(current, patch)
  if (current.trim() && current !== next) await history.snapshotNote(dir, id, current, 'edit')
  await library.writeNote(dir, id, next)
  return id
}
