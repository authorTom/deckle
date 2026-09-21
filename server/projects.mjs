// Projects: a convention over folders, not a new kind of storage.
//
// A project is any folder directly inside the projects folder (`Projects/` by
// default, DECKLE_PROJECTS_DIR to change it). Whatever an agent produces while
// working on it — notes, PDFs, spreadsheets, images, source files — lives in
// that folder like any other file, so it opens in any editor and survives
// without Deckle.
//
// Two files give a project its shape, and both are optional:
//
//   Overview.md  front matter (status, summary, tags, created) above a normal
//                note describing the project. README.md or index.md stand in
//                when there is no Overview.md, so a pushed code project is
//                described by its own README.
//   Log.md       an append-only, dated record of what was done and why,
//                written by the agent as it works.
//
// A folder with neither is still a project — it just has no status yet.

import { parseFrontmatter, setFrontmatterFields } from './frontmatter.mjs'
import { ApiError } from './library-store.mjs'

export const OVERVIEW = 'Overview.md'
export const LOG = 'Log.md'
const OVERVIEW_CANDIDATES = [OVERVIEW, 'README.md', 'Readme.md', 'readme.md', 'index.md']

export const STATUSES = ['active', 'paused', 'done', 'archived']

/** "2026-09-21" in the server's local time (set TZ on the container). */
function dateStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function timeStamp(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${dateStamp(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function asTags(value) {
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : String(value).split(',')
  return list
    .map((t) => String(t).trim().replace(/^#/, ''))
    .filter(Boolean)
    .slice(0, 20)
}

function validateStatus(status) {
  if (status === undefined) return undefined
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, 'invalid_body', `"status" must be one of ${STATUSES.join(', ')}`)
  }
  return status
}

/** Quote a one-line summary for front matter. */
function oneLine(text, max = 300) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function createProjects({ library, store, now = () => new Date(), projectsDir = 'Projects' }) {
  const root = projectsDir

  function folderFor(name) {
    const clean = store.sanitizeName(String(name ?? ''), '')
    if (!clean || clean.startsWith('.')) {
      throw new ApiError(400, 'invalid_body', '"name" must be a usable folder name')
    }
    return { name: clean, path: `${root}/${clean}` }
  }

  /** Counts and the newest change inside a project folder. */
  function summarise(nodes) {
    let notes = 0
    let files = 0
    let updatedAt = 0
    const walk = (list) => {
      for (const node of list) {
        if (node.kind === 'folder') walk(node.children)
        else {
          if (node.kind === 'file') notes++
          else files++
          updatedAt = Math.max(updatedAt, node.updatedAt ?? 0)
        }
      }
    }
    walk(nodes)
    return { notes, files, updatedAt }
  }

  async function describe(folder) {
    const { name, id, children } = folder
    const path = `${root}/${id}`
    const overviewName = OVERVIEW_CANDIDATES.find((candidate) =>
      children.some((c) => c.kind === 'file' && c.name === candidate),
    )
    let meta = {}
    if (overviewName) {
      try {
        meta = parseFrontmatter(await library.readText(`${path}/${overviewName}`))
      } catch {
        // Unreadable overview: the project still lists, just without metadata.
      }
    }
    const counts = summarise(children)
    return {
      name,
      path,
      status: STATUSES.includes(meta.status) ? meta.status : meta.status ? String(meta.status) : null,
      summary: typeof meta.summary === 'string' ? meta.summary : meta.description ? String(meta.description) : '',
      tags: asTags(meta.tags) ?? [],
      created: meta.created ? String(meta.created) : null,
      overview: overviewName ? `${path}/${overviewName}` : null,
      log: children.some((c) => c.kind === 'file' && c.name === LOG) ? `${path}/${LOG}` : null,
      ...counts,
    }
  }

  async function list({ status } = {}) {
    if ((await library.exists(root)) !== 'directory') return []
    const tree = await library.tree(root)
    const projects = []
    for (const node of tree) {
      if (node.kind !== 'folder') continue
      projects.push(await describe(node))
    }
    const filtered = status ? projects.filter((p) => p.status === status) : projects
    // Most recently touched first: that is the project someone is looking for.
    filtered.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    return filtered
  }

  async function get(name) {
    const { name: clean, path } = folderFor(name)
    if ((await library.exists(path)) !== 'directory') {
      throw new ApiError(404, 'not_found', `no project called "${clean}" (looked in ${path})`)
    }
    return await describe({ name: clean, id: clean, children: await library.tree(path) })
  }

  /** Create a project folder with an Overview.md. Refuses to reuse a name. */
  async function create({ name, summary, status, tags, body, createdBy }) {
    const { name: clean, path } = folderFor(name)
    if (await library.exists(path)) {
      throw new ApiError(409, 'conflict', `a project called "${clean}" already exists`)
    }
    const meta = [
      '---',
      'type: project',
      `status: ${validateStatus(status) ?? 'active'}`,
      `summary: ${JSON.stringify(oneLine(summary))}`,
      `tags: [${(asTags(tags) ?? []).map((t) => JSON.stringify(t)).join(', ')}]`,
      `created: ${dateStamp(now())}`,
      ...(createdBy ? [`created_by: ${JSON.stringify(createdBy)}`] : []),
      '---',
      '',
    ].join('\n')
    const text = String(body ?? '').trim()
    const content = `${meta}\n# ${clean}\n\n${oneLine(summary, 2000)}\n${text ? `\n${text}\n` : ''}`
    await library.mkdir(path)
    await store.writeNote(`${path}/${OVERVIEW}`, content.replace(/\n{3,}/g, '\n\n'), 'agent')
    return await get(clean)
  }

  /**
   * Change a project's status, summary or tags in its Overview.md's front
   * matter. Always Overview.md, never a README standing in for one: a pushed
   * code project's README belongs to the code. A project without an
   * Overview.md gets one, carrying over what its README said.
   */
  async function update(name, { status, summary, tags }) {
    const project = await get(name)
    const patch = {}
    if (status !== undefined) patch.status = validateStatus(status)
    if (summary !== undefined) patch.summary = oneLine(summary)
    if (tags !== undefined) patch.tags = asTags(tags)
    if (!Object.keys(patch).length) {
      throw new ApiError(400, 'invalid_body', 'nothing to change: give a status, summary or tags')
    }
    const overview = `${project.path}/${OVERVIEW}`
    let current
    let fields = patch
    if (project.overview === overview) {
      current = await library.readText(overview)
    } else {
      current = `# ${project.name}\n`
      fields = {
        type: 'project',
        status: project.status ?? undefined,
        summary: project.summary || undefined,
        tags: project.tags.length ? project.tags : undefined,
        ...patch,
      }
    }
    await store.writeNote(overview, setFrontmatterFields(current, fields), 'agent')
    return await get(project.name)
  }

  /** Append a dated line to the project's Log.md, creating it if need be. */
  async function log(name, entry, actor) {
    const project = await get(name)
    const text = String(entry ?? '').trim()
    if (!text) throw new ApiError(400, 'invalid_body', '"entry" cannot be empty')
    if (text.length > 20_000) throw new ApiError(400, 'invalid_body', '"entry" is too long')
    const path = `${project.path}/${LOG}`
    const exists = (await library.exists(path)) === 'file'
    // Continuation lines are indented so a multi-line entry stays one list item.
    const [first, ...rest] = text.split(/\r?\n/)
    const line =
      `- **${timeStamp(now())}**${actor ? ` · ${actor}` : ''} — ${first}` +
      rest.map((l) => `\n  ${l}`).join('') +
      '\n'
    if (!exists) {
      await library.writeText(path, `# Log — ${project.name}\n\n${line}`)
    } else {
      const current = await library.readText(path)
      await library.appendText(path, current.endsWith('\n') ? line : `\n${line}`)
    }
    return { project: project.name, path }
  }

  return { list, get, create, update, log, root }
}
