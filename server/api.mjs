// Deckle's machine API: everything the app can do to a library, over HTTP, for
// agents and scripts rather than browsers.
//
// It sits beside — not on top of — the app's own /api/library endpoints. Those
// are a file-handle shim for the browser, cookie-authenticated and shaped by
// the File System Access API. This is a normal REST API: bearer tokens, JSON
// bodies, note paths in the URL, and library semantics (the recycle bin, version
// history, tasks, bookmarks) applied server-side so an agent's writes behave
// exactly like a person's.
//
// It requires the server library. A local-folder or in-browser library lives on the
// user's device and there is nothing here for an agent to reach.
//
// The full surface is documented by the OpenAPI 3.1 document this serves at
// GET /api/v1/openapi.json — that spec and this router must be changed together.

import { randomUUID } from 'node:crypto'
import { SECURITY_HEADERS } from './static.mjs'
import { BadPathError } from './paths.mjs'
import { TooLargeError } from './library-api.mjs'
import {
  ApiError,
  isDataDir,
  normalizeFolderPath,
  normalizeNotePath,
} from './library-store.mjs'
import { buildOpenApi } from './openapi.mjs'
import { VERSION } from './version.mjs'
import { ClientGoneError, writeZip } from './zip.mjs'
import { isValidDateStr, nextOccurrence, todayStr } from './dates.mjs'

const PREFIX = '/api/v1'

/** JSON request bodies are notes, not uploads; 16 MB is already generous. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// ---- Small helpers ---------------------------------------------------------

function parseIntParam(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function boolParam(value) {
  return value === '1' || value === 'true' || value === 'yes'
}

function requireString(body, field, { optional = false, max = 100_000 } = {}) {
  const value = body?.[field]
  if (value === undefined || value === null) {
    if (optional) return undefined
    throw new ApiError(400, 'invalid_body', `"${field}" is required`)
  }
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_body', `"${field}" must be a string`)
  }
  if (value.length > max) {
    throw new ApiError(400, 'invalid_body', `"${field}" is too long`)
  }
  return value
}

/** A reference to another record: a non-empty string, or null for "none". */
function optionalId(body, field) {
  const value = body?.[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || !value) {
    throw new ApiError(400, 'invalid_body', `"${field}" must be an id string or null`)
  }
  return value
}

/**
 * A project or collection colour.
 *
 * The app paints it straight into a style attribute, so anything but a hex
 * colour is refused — `url(https://…)` would otherwise turn every render of
 * the task panel into a request to wherever the caller pointed it.
 */
function optionalColor(body, fallback) {
  const value = requireString(body, 'color', { optional: true, max: 32 })
  if (value === undefined) return fallback
  if (!/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    throw new ApiError(400, 'invalid_body', '"color" must be a hex colour such as "#30a46c"')
  }
  return value
}

/** Re-root ids from a subtree walk so every path is library-relative. */
function applyPrefix(nodes, prefix) {
  if (!prefix) return nodes
  return nodes.map((node) =>
    node.kind === 'folder'
      ? {
          ...node,
          id: `${prefix}/${node.id}`,
          children: applyPrefix(node.children, prefix),
        }
      : { ...node, id: `${prefix}/${node.id}` },
  )
}

function flattenFiles(nodes, out = []) {
  for (const node of nodes) {
    if (node.kind === 'folder') flattenFiles(node.children, out)
    else out.push(node)
  }
  return out
}

// ---- Router ----------------------------------------------------------------

export function createApi({
  library,
  store,
  search,
  auth,
  libraryEnabled,
  libraryName,
  corsOrigins = [],
}) {
  const allowAllOrigins = corsOrigins.includes('*')

  function corsHeaders(req) {
    if (!corsOrigins.length) return {}
    const origin = req.headers.origin
    if (!origin) return {}
    if (!allowAllOrigins && !corsOrigins.includes(origin)) return {}
    return {
      'Access-Control-Allow-Origin': allowAllOrigins ? '*' : origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      // Never credentials: this API authenticates by token, and allowing
      // cookies here would hand a cross-origin page the user's session.
      Vary: 'Origin',
    }
  }

  function sendJson(req, res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body, null, 2)
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    })
    res.end(payload)
  }

  function sendError(req, res, status, code, message, extraHeaders = {}) {
    sendJson(req, res, status, { error: { code, message } }, extraHeaders)
  }

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new TooLargeError('request body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ApiError(400, 'invalid_json', 'request body is not valid JSON')
    }
    // Every endpoint takes an object. `null`, `[]` and `"text"` are all valid
    // JSON, and each used to reach a handler that read a property off it —
    // answering a malformed request with a 500.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ApiError(400, 'invalid_body', 'request body must be a JSON object')
    }
    return parsed
  }

  // ---- Notes ---------------------------------------------------------------

  async function listNotes(url) {
    const folder = normalizeFolderPath(url.searchParams.get('folder') ?? '')
    const limit = parseIntParam(url.searchParams.get('limit'), DEFAULT_LIMIT, {
      min: 1,
      max: MAX_LIMIT,
    })
    const offset = parseIntParam(url.searchParams.get('offset'), 0)
    const includeContent = boolParam(url.searchParams.get('include_content'))
    const sort = url.searchParams.get('sort') ?? 'path'

    const tree = applyPrefix(await library.tree(folder), folder)
    const files = flattenFiles(tree)

    if (sort === 'updated') files.sort((a, b) => b.updatedAt - a.updatedAt)
    else if (sort === 'title') files.sort((a, b) => a.title.localeCompare(b.title))
    else files.sort((a, b) => a.id.localeCompare(b.id))

    const page = files.slice(offset, offset + limit)
    const notes = []
    for (const file of page) {
      const note = {
        path: file.id,
        title: file.title,
        folder: file.id.includes('/') ? file.id.slice(0, file.id.lastIndexOf('/')) : '',
        updatedAt: file.updatedAt,
      }
      if (includeContent) {
        try {
          note.content = await library.readText(file.id)
        } catch {
          note.content = ''
        }
      }
      notes.push(note)
    }

    return { total: files.length, limit, offset, notes }
  }

  async function createNote(body) {
    const content = requireString(body, 'content', { optional: true, max: 4_000_000 }) ?? ''
    const explicit = requireString(body, 'path', { optional: true, max: 1024 })
    const title = requireString(body, 'title', { optional: true, max: 300 })
    const folder = normalizeFolderPath(body?.folder ?? '')

    if (!explicit && !title) {
      throw new ApiError(400, 'invalid_body', 'either "path" or "title" is required')
    }
    const path = explicit
      ? normalizeNotePath(explicit)
      : normalizeNotePath(`${folder ? `${folder}/` : ''}${store.sanitizeName(title, 'Untitled')}`)

    return await store.createNote({ path, content })
  }

  async function patchNote(path, body) {
    const existing = await store.readNote(path)

    // Validate the whole request before touching the disk. The move used to
    // happen first and the edit be checked after, so a rename paired with a
    // malformed edit moved the note and then answered 400 — a request that
    // "failed" having changed the library.
    const edits = ['content', 'append', 'prepend'].filter((key) => body[key] !== undefined)
    if (edits.length > 1) {
      throw new ApiError(
        400,
        'invalid_body',
        'use only one of "content", "append" or "prepend" per request',
      )
    }
    const edit = edits.length
      ? { kind: edits[0], text: requireString(body, edits[0], { max: 4_000_000 }) }
      : null

    let target = existing.path
    if (body.path !== undefined) {
      target = normalizeNotePath(requireString(body, 'path', { max: 1024 }))
    } else if (body.title !== undefined || body.folder !== undefined) {
      const folder =
        body.folder !== undefined ? normalizeFolderPath(body.folder) : existing.folder
      const title =
        body.title !== undefined
          ? store.sanitizeName(requireString(body, 'title', { max: 300 }), existing.title)
          : existing.title
      target = normalizeNotePath(`${folder ? `${folder}/` : ''}${title}`)
    }

    // Rename/move first, so a content edit in the same call lands on the note
    // at its new home rather than leaving the old one updated.
    const current =
      target !== existing.path ? await store.moveNote(existing.path, target) : existing
    if (!edit) return current

    let content
    if (edit.kind === 'content') {
      content = edit.text
    } else if (edit.kind === 'append') {
      const separator = current.content && !current.content.endsWith('\n') ? '\n' : ''
      content = `${current.content}${separator}${edit.text}`
    } else {
      const separator = edit.text.endsWith('\n') ? '' : '\n'
      content = `${edit.text}${separator}${current.content}`
    }

    const { note } = await store.writeNote(current.path, content, 'ai')
    return note
  }

  // ---- Import / export -----------------------------------------------------

  async function importNotes(body) {
    const incoming = body?.notes
    if (!Array.isArray(incoming) || !incoming.length) {
      throw new ApiError(400, 'invalid_body', '"notes" must be a non-empty array')
    }
    if (incoming.length > 1000) {
      throw new ApiError(400, 'invalid_body', 'at most 1000 notes per import request')
    }
    const folder = normalizeFolderPath(body?.folder ?? '')
    const overwrite = body?.overwrite === true

    const imported = []
    const failed = []
    for (const item of incoming) {
      try {
        const relative = normalizeNotePath(requireString(item, 'path', { max: 1024 }))
        const content = requireString(item, 'content', { max: 4_000_000 })
        const path = folder ? `${folder}/${relative}` : relative
        if (overwrite) {
          const { note, created } = await store.writeNote(path, content, 'ai')
          imported.push({ path: note.path, created })
        } else {
          const note = await store.createNote({ path, content })
          imported.push({ path: note.path, created: true })
        }
      } catch (err) {
        failed.push({
          path: typeof item?.path === 'string' ? item.path : null,
          error: err instanceof ApiError ? err.message : 'could not be imported',
        })
      }
    }
    return { imported: imported.length, failed: failed.length, notes: imported, errors: failed }
  }

  /** Walk the library yielding every file, for the export archive. */
  async function* walkForExport(rel, includeHidden) {
    const entries = await library.list(rel)
    for (const entry of entries) {
      const path = rel ? `${rel}/${entry.name}` : entry.name
      const hidden = entry.name.startsWith('.')
      // The data folder always travels: without tasks.json and bookmarks.json a
      // restored library silently loses the planner and the bookmarks. That
      // holds for the pre-rename folder name too.
      if (hidden && !includeHidden && !isDataDir(entry.name)) continue

      if (entry.kind === 'directory') {
        yield* walkForExport(path, includeHidden)
      } else {
        yield {
          path,
          content: await library.readBuffer(path),
          modified: new Date(entry.lastModified ?? Date.now()),
        }
      }
    }
  }

  async function exportZip(req, res, url) {
    const includeHidden = boolParam(url.searchParams.get('include_hidden'))
    const stamp = new Date().toISOString().slice(0, 10)
    const slug =
      libraryName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'library'

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...corsHeaders(req),
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${slug}-${stamp}.zip"`,
      'Cache-Control': 'no-store',
    })

    try {
      await writeZip(res, walkForExport('', includeHidden))
      res.end()
    } catch (err) {
      // Headers are long gone, so there is no status left to send — cut the
      // response short so the client sees a truncated archive rather than a
      // silently valid one, and log the reason. A client that simply left is
      // not a failure worth a log line.
      if (!(err instanceof ClientGoneError)) {
        console.error('[deckle] export failed midway:', err)
      }
      res.destroy()
    }
  }

  // ---- Tasks ---------------------------------------------------------------

  function validatePriority(value) {
    if (value === undefined) return undefined
    const priority = Number(value)
    if (![1, 2, 3, 4].includes(priority)) {
      throw new ApiError(400, 'invalid_body', '"priority" must be 1, 2, 3 or 4')
    }
    return priority
  }

  function validateDue(value) {
    if (value === undefined) return undefined
    if (value === null) return null
    // A real date, not just the right shape: "2026-02-31" used to be stored,
    // and then sorted and filtered as a string no calendar has.
    if (!isValidDateStr(value)) {
      throw new ApiError(400, 'invalid_body', '"due" must be a real date as "YYYY-MM-DD", or null')
    }
    return value
  }

  function validateRecurrence(value) {
    if (value === undefined) return undefined
    if (value === null) return null
    const freq = value?.freq
    const interval = Number(value?.interval ?? 1)
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) {
      throw new ApiError(
        400,
        'invalid_body',
        '"recurrence.freq" must be daily, weekly, monthly or yearly',
      )
    }
    if (!Number.isFinite(interval) || interval < 1) {
      throw new ApiError(400, 'invalid_body', '"recurrence.interval" must be 1 or more')
    }
    return { freq, interval: Math.floor(interval) }
  }

  function filterTasks(tasks, url) {
    const filter = url.searchParams.get('filter') ?? 'all'
    const project = url.searchParams.get('project')
    const includeCompleted = boolParam(url.searchParams.get('include_completed'))
    const includeDeleted = boolParam(url.searchParams.get('include_deleted'))
    const stamp = todayStr()

    return tasks.filter((task) => {
      if (task.deletedAt && !includeDeleted && filter !== 'deleted') return false
      if (!task.deletedAt && filter === 'deleted') return false
      if (task.completedAt && !includeCompleted && filter !== 'completed') return false
      if (!task.completedAt && filter === 'completed') return false
      if (project && task.projectId !== project) return false

      if (filter === 'inbox') return task.projectId === null
      if (filter === 'today') return !!task.due && task.due <= stamp
      if (filter === 'upcoming') return !!task.due && task.due > stamp
      if (filter === 'overdue') return !!task.due && task.due < stamp
      return true
    })
  }

  async function createTask(body) {
    const title = requireString(body, 'title', { max: 1000 }).trim()
    if (!title) throw new ApiError(400, 'invalid_body', '"title" cannot be empty')
    const projectId = optionalId(body, 'projectId') ?? null
    const due = validateDue(body.due) ?? null
    const priority = validatePriority(body.priority) ?? 4
    const recurrence = validateRecurrence(body.recurrence) ?? null
    const source =
      typeof body.sourceNote === 'string' && body.sourceNote
        ? { noteId: normalizeNotePath(body.sourceNote) }
        : undefined

    return await store.updateTasks((tasks) => {
      if (projectId && !tasks.projects.some((p) => p.id === projectId)) {
        throw new ApiError(404, 'not_found', `no project with id "${projectId}"`)
      }
      const task = {
        id: randomUUID(),
        title,
        projectId,
        due,
        priority,
        recurrence,
        completedAt: null,
        deletedAt: null,
        createdAt: Date.now(),
      }
      if (source) task.source = source
      tasks.tasks.push(task)
      return task
    })
  }

  async function patchTask(id, body) {
    return await store.updateTasks((store_) => {
      const task = store_.tasks.find((t) => t.id === id)
      if (!task) throw new ApiError(404, 'not_found', `no task with id "${id}"`)

      if (body.title !== undefined) {
        const title = requireString(body, 'title', { max: 1000 }).trim()
        if (!title) throw new ApiError(400, 'invalid_body', '"title" cannot be empty')
        task.title = title
      }
      if (body.projectId !== undefined) {
        const projectId = optionalId(body, 'projectId')
        if (projectId !== null && !store_.projects.some((p) => p.id === projectId)) {
          throw new ApiError(404, 'not_found', `no project with id "${projectId}"`)
        }
        task.projectId = projectId
      }
      if (body.due !== undefined) task.due = validateDue(body.due)
      if (body.priority !== undefined) task.priority = validatePriority(body.priority)
      if (body.recurrence !== undefined) task.recurrence = validateRecurrence(body.recurrence)
      if (body.completed !== undefined) {
        if (typeof body.completed !== 'boolean') {
          throw new ApiError(400, 'invalid_body', '"completed" must be true or false')
        }
        if (!body.completed) {
          task.completedAt = null
        } else if (!task.completedAt) {
          // Exactly what the app's checkbox does (toggleComplete in
          // src/tasks/useTasks.ts): a recurring task with a due date moves on
          // to its next occurrence rather than completing. The API used to
          // complete it outright, ending the series for everyone.
          if (task.recurrence && task.due) {
            task.due = nextOccurrence(task.due, task.recurrence, todayStr())
          } else {
            task.completedAt = Date.now()
          }
        }
      }
      // Mutations above run on a freshly loaded copy, and updateTasks only
      // writes once this returns — so a validation error part-way through
      // leaves the file untouched rather than half-edited.
      return task
    })
  }

  // ---- Bookmarks -----------------------------------------------------------

  function normalizeUrl(raw) {
    const value = String(raw ?? '').trim()
    if (!value) throw new ApiError(400, 'invalid_body', '"url" is required')
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`
    let parsed
    try {
      parsed = new URL(withScheme)
    } catch {
      throw new ApiError(400, 'invalid_body', `"${value}" is not a valid URL`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ApiError(400, 'invalid_body', 'bookmarks must be http or https URLs')
    }
    return parsed.toString()
  }

  async function createBookmark(body) {
    const url = normalizeUrl(body?.url)
    const collectionId = optionalId(body, 'collectionId') ?? null
    return await store.updateBookmarks((data) => {
      if (collectionId && !data.collections.some((c) => c.id === collectionId)) {
        throw new ApiError(404, 'not_found', `no collection with id "${collectionId}"`)
      }
      const bookmark = {
        id: randomUUID(),
        url,
        title: (requireString(body, 'title', { optional: true, max: 500 }) ?? '').trim() ||
          new URL(url).hostname.replace(/^www\./, ''),
        comment: requireString(body, 'comment', { optional: true, max: 10_000 }) ?? '',
        collectionId,
        createdAt: Date.now(),
      }
      if (typeof body.sourceNote === 'string' && body.sourceNote) {
        bookmark.source = { noteId: normalizeNotePath(body.sourceNote) }
      }
      data.bookmarks.push(bookmark)
      return bookmark
    })
  }

  async function patchBookmark(id, body) {
    return await store.updateBookmarks((data) => {
      const bookmark = data.bookmarks.find((b) => b.id === id)
      if (!bookmark) throw new ApiError(404, 'not_found', `no bookmark with id "${id}"`)

      if (body.url !== undefined) bookmark.url = normalizeUrl(body.url)
      if (body.title !== undefined) {
        bookmark.title = requireString(body, 'title', { max: 500 })
      }
      if (body.comment !== undefined) {
        bookmark.comment = requireString(body, 'comment', { max: 10_000 })
      }
      if (body.collectionId !== undefined) {
        const collectionId = optionalId(body, 'collectionId')
        if (collectionId !== null && !data.collections.some((c) => c.id === collectionId)) {
          throw new ApiError(404, 'not_found', `no collection with id "${collectionId}"`)
        }
        bookmark.collectionId = collectionId
      }
      return bookmark
    })
  }

  /** Colours the app already uses for projects and collections. */
  const PALETTE = ['#e5484d', '#f76808', '#ffb224', '#30a46c', '#0091ff', '#8e4ec6']

  // ---- Dispatch ------------------------------------------------------------

  async function route(req, res, url, segments, token) {
    const [head, ...rest] = segments
    const method = req.method
    const readOnly = token.scope === 'r'

    if (readOnly && WRITE_METHODS.has(method)) {
      throw new ApiError(
        403,
        'read_only',
        `token "${token.name}" is read-only; this endpoint needs a read-write token`,
      )
    }

    // -- service ---------------------------------------------------------
    if (!head || head === 'health') {
      // Two version numbers, deliberately: `api` is the contract this caller is
      // written against and only moves when that contract breaks, `version` is
      // the build serving it. A client needs the first to know it still fits,
      // and the second to say what it was talking to.
      return {
        status: 200,
        body: {
          ok: true,
          service: 'deckle',
          version: VERSION,
          api: 'v1',
          library: libraryName,
        },
      }
    }

    if (head === 'openapi.json' && method === 'GET') {
      return { status: 200, body: buildOpenApi(libraryName) }
    }

    // -- notes -----------------------------------------------------------
    if (head === 'notes') {
      if (!rest.length) {
        if (method === 'GET') return { status: 200, body: await listNotes(url) }
        if (method === 'POST') {
          const note = await createNote(await readBody(req))
          return {
            status: 201,
            body: note,
            headers: { Location: `${PREFIX}/notes/${encodePath(note.path)}` },
          }
        }
        throw methodNotAllowed(method)
      }

      const path = normalizeNotePath(rest.join('/'))

      if (method === 'GET') {
        const note = await store.readNote(path)
        if (url.searchParams.get('format') === 'markdown') {
          return { status: 200, raw: note.content, contentType: 'text/markdown; charset=utf-8' }
        }
        return { status: 200, body: note }
      }
      if (method === 'PUT') {
        const body = await readBody(req)
        const { note, created } = await store.writeNote(
          path,
          requireString(body, 'content', { max: 4_000_000 }),
          'ai',
        )
        return { status: created ? 201 : 200, body: note }
      }
      if (method === 'PATCH') {
        return { status: 200, body: await patchNote(path, await readBody(req)) }
      }
      if (method === 'DELETE') {
        await store.readNote(path) // 404 before doing anything
        if (boolParam(url.searchParams.get('permanent'))) {
          await library.remove(path, false)
          return { status: 200, body: { deleted: path, permanent: true } }
        }
        const entry = await store.trashNote(path)
        return { status: 200, body: { deleted: path, permanent: false, trash: entry } }
      }
      throw methodNotAllowed(method)
    }

    // -- search ----------------------------------------------------------
    if (head === 'search' && method === 'GET') {
      const q = url.searchParams.get('q') ?? url.searchParams.get('query') ?? ''
      if (!q.trim()) throw new ApiError(400, 'invalid_query', '"q" is required')
      const results = await search.search(q, {
        limit: parseIntParam(url.searchParams.get('limit'), 10, { min: 1, max: 100 }),
        folder: normalizeFolderPath(url.searchParams.get('folder') ?? ''),
      })
      return { status: 200, body: { query: q, count: results.length, results } }
    }

    // -- folders ---------------------------------------------------------
    if (head === 'folders') {
      if (!rest.length) {
        if (method === 'GET') {
          const folder = normalizeFolderPath(url.searchParams.get('path') ?? '')
          return {
            status: 200,
            body: { path: folder, tree: applyPrefix(await library.tree(folder), folder) },
          }
        }
        if (method === 'POST') {
          const body = await readBody(req)
          const path = normalizeFolderPath(requireString(body, 'path', { max: 1024 }))
          if (!path) throw new ApiError(400, 'invalid_path', '"path" is required')
          await library.mkdir(path)
          return { status: 201, body: { path } }
        }
        throw methodNotAllowed(method)
      }

      const path = normalizeFolderPath(rest.join('/'))
      if (method === 'DELETE') {
        if (!path) throw new ApiError(400, 'invalid_path', 'cannot delete the library root')
        if ((await library.exists(path)) !== 'directory') {
          throw new ApiError(404, 'not_found', `no folder at "${path}"`)
        }
        // Match the app: notes inside go to the recycle bin, not oblivion.
        const notes = flattenFiles(applyPrefix(await library.tree(path), path))
        for (const note of notes) await store.trashNote(note.id)
        await library.remove(path, true)
        return { status: 200, body: { deleted: path, trashed: notes.length } }
      }
      throw methodNotAllowed(method)
    }

    // -- import / export --------------------------------------------------
    if (head === 'import' && method === 'POST') {
      return { status: 200, body: await importNotes(await readBody(req)) }
    }
    if (head === 'export' && method === 'GET') {
      await exportZip(req, res, url)
      return { handled: true }
    }

    // -- tasks -----------------------------------------------------------
    if (head === 'tasks') {
      if (!rest.length) {
        if (method === 'GET') {
          const data = await store.loadTasks()
          const tasks = filterTasks(data.tasks, url)
          return { status: 200, body: { count: tasks.length, tasks } }
        }
        if (method === 'POST') {
          return { status: 201, body: await createTask(await readBody(req)) }
        }
        throw methodNotAllowed(method)
      }

      const id = rest[0]
      if (method === 'GET') {
        const data = await store.loadTasks()
        const task = data.tasks.find((t) => t.id === id)
        if (!task) throw new ApiError(404, 'not_found', `no task with id "${id}"`)
        return { status: 200, body: task }
      }
      if (method === 'PATCH') {
        return { status: 200, body: await patchTask(id, await readBody(req)) }
      }
      if (method === 'DELETE') {
        const permanent = boolParam(url.searchParams.get('permanent'))
        const result = await store.updateTasks((data) => {
          const index = data.tasks.findIndex((t) => t.id === id)
          if (index === -1) throw new ApiError(404, 'not_found', `no task with id "${id}"`)
          if (permanent) {
            data.tasks.splice(index, 1)
            return { id, permanent: true }
          }
          // Soft delete, matching the app's task bin (purged after 30 days).
          data.tasks[index].deletedAt = Date.now()
          return { id, permanent: false }
        })
        return { status: 200, body: { deleted: result.id, permanent: result.permanent } }
      }
      throw methodNotAllowed(method)
    }

    if (head === 'projects') {
      if (method === 'GET') {
        const data = await store.loadTasks()
        return { status: 200, body: { count: data.projects.length, projects: data.projects } }
      }
      if (method === 'POST') {
        const body = await readBody(req)
        const name = requireString(body, 'name', { max: 200 }).trim()
        if (!name) throw new ApiError(400, 'invalid_body', '"name" cannot be empty')
        const project = await store.updateTasks((data) => {
          const created = {
            id: randomUUID(),
            name,
            color: optionalColor(body, PALETTE[data.projects.length % PALETTE.length]),
          }
          data.projects.push(created)
          return created
        })
        return { status: 201, body: project }
      }
      throw methodNotAllowed(method)
    }

    // -- bookmarks -------------------------------------------------------
    if (head === 'bookmarks') {
      if (!rest.length) {
        if (method === 'GET') {
          const data = await store.loadBookmarks()
          const collection = url.searchParams.get('collection')
          const bookmarks = collection
            ? data.bookmarks.filter((b) => b.collectionId === collection)
            : data.bookmarks
          return { status: 200, body: { count: bookmarks.length, bookmarks } }
        }
        if (method === 'POST') {
          return { status: 201, body: await createBookmark(await readBody(req)) }
        }
        throw methodNotAllowed(method)
      }

      const id = rest[0]
      if (method === 'GET') {
        const data = await store.loadBookmarks()
        const bookmark = data.bookmarks.find((b) => b.id === id)
        if (!bookmark) throw new ApiError(404, 'not_found', `no bookmark with id "${id}"`)
        return { status: 200, body: bookmark }
      }
      if (method === 'PATCH') {
        return { status: 200, body: await patchBookmark(id, await readBody(req)) }
      }
      if (method === 'DELETE') {
        await store.updateBookmarks((data) => {
          const index = data.bookmarks.findIndex((b) => b.id === id)
          if (index === -1) throw new ApiError(404, 'not_found', `no bookmark with id "${id}"`)
          data.bookmarks.splice(index, 1)
        })
        return { status: 200, body: { deleted: id } }
      }
      throw methodNotAllowed(method)
    }

    if (head === 'collections') {
      if (method === 'GET') {
        const data = await store.loadBookmarks()
        return {
          status: 200,
          body: { count: data.collections.length, collections: data.collections },
        }
      }
      if (method === 'POST') {
        const body = await readBody(req)
        const name = requireString(body, 'name', { max: 200 }).trim()
        if (!name) throw new ApiError(400, 'invalid_body', '"name" cannot be empty')
        const collection = await store.updateBookmarks((data) => {
          const created = {
            id: randomUUID(),
            name,
            color: optionalColor(body, PALETTE[data.collections.length % PALETTE.length]),
          }
          data.collections.push(created)
          return created
        })
        return { status: 201, body: collection }
      }
      throw methodNotAllowed(method)
    }

    // -- version history --------------------------------------------------
    if (head === 'history') {
      if (!rest.length && method === 'GET') {
        const path = url.searchParams.get('path')
        const items = await store.listHistory(path ? normalizeNotePath(path) : null)
        return { status: 200, body: { count: items.length, snapshots: items } }
      }
      if (rest.length === 1 && method === 'GET') {
        const content = await store.readSnapshot(rest[0])
        return { status: 200, body: { snapshot: rest[0], content } }
      }
      if (rest.length === 2 && rest[1] === 'restore' && method === 'POST') {
        const items = await store.listHistory(null)
        const entry = items.find((i) => i.snapName === rest[0])
        if (!entry) throw new ApiError(404, 'not_found', 'no such snapshot')
        const content = await store.readSnapshot(rest[0])
        const { note } = await store.writeNote(entry.noteId, content, 'restore')
        return { status: 200, body: note }
      }
      throw methodNotAllowed(method)
    }

    // -- recycle bin ------------------------------------------------------
    if (head === 'trash') {
      if (!rest.length && method === 'GET') {
        const items = await store.listTrash()
        return { status: 200, body: { count: items.length, items } }
      }
      if (rest.length === 2 && rest[1] === 'restore' && method === 'POST') {
        return { status: 200, body: await store.restoreTrash(rest[0]) }
      }
      if (rest.length === 1 && method === 'DELETE') {
        await store.deleteTrashItem(rest[0])
        return { status: 200, body: { deleted: rest[0] } }
      }
      throw methodNotAllowed(method)
    }

    throw new ApiError(404, 'unknown_endpoint', `no endpoint at ${url.pathname}`)
  }

  function methodNotAllowed(method) {
    return new ApiError(405, 'method_not_allowed', `${method} is not supported here`)
  }

  function encodePath(path) {
    return path.split('/').map(encodeURIComponent).join('/')
  }

  /**
   * Entry point. Returns true when the request belonged to this API (whether it
   * succeeded or not), so the caller knows not to fall through to the SPA.
   */
  return async function handleApiRequest(req, res, url) {
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders(req) })
      res.end()
      return true
    }

    if (!auth.enabled) {
      sendError(
        req,
        res,
        404,
        'api_disabled',
        'the API is disabled — set DECKLE_API_TOKENS to enable it',
      )
      return true
    }
    if (!libraryEnabled) {
      sendError(
        req,
        res,
        503,
        'library_disabled',
        'the API needs the server library — set DECKLE_SERVER_LIBRARY=true',
      )
      return true
    }

    const result = auth.authenticate(req)
    if (result.error === 'throttled') {
      sendError(req, res, 429, 'throttled', 'too many failed attempts; try again later', {
        'Retry-After': '900',
      })
      return true
    }
    if (result.error) {
      sendError(
        req,
        res,
        401,
        'unauthorized',
        result.error === 'missing'
          ? 'missing Authorization header (expected "Bearer <token>")'
          : 'invalid API token',
        { 'WWW-Authenticate': 'Bearer realm="deckle"' },
      )
      return true
    }

    const segments = url.pathname
      .slice(PREFIX.length)
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment)
        } catch {
          throw new BadPathError('malformed percent-encoding in path')
        }
      })

    try {
      const outcome = await route(req, res, url, segments, result.token)
      if (outcome?.handled) return true // the handler wrote the response itself
      if (outcome?.raw !== undefined) {
        res.writeHead(outcome.status, {
          ...SECURITY_HEADERS,
          ...corsHeaders(req),
          'Content-Type': outcome.contentType,
          'Cache-Control': 'no-store',
          'Content-Length': Buffer.byteLength(outcome.raw),
        })
        res.end(outcome.raw)
        return true
      }
      sendJson(req, res, outcome.status, outcome.body, outcome.headers ?? {})
    } catch (err) {
      if (res.headersSent) {
        res.destroy()
        return true
      }
      if (err instanceof ApiError) {
        sendError(req, res, err.status, err.code, err.message)
      } else if (err instanceof BadPathError) {
        sendError(req, res, 400, 'invalid_path', err.message)
      } else if (err instanceof TooLargeError) {
        sendError(req, res, 413, 'too_large', 'request body too large')
      } else if (err?.code === 'ENOENT') {
        sendError(req, res, 404, 'not_found', 'not found')
      } else if (err?.code === 'ENOTEMPTY' || err?.code === 'EEXIST') {
        sendError(req, res, 409, 'conflict', err.code)
      } else if (err?.code === 'EACCES' || err?.code === 'EROFS') {
        sendError(req, res, 500, 'not_writable', 'the library directory is not writable')
      } else {
        console.error('[deckle] api request failed:', req.method, url.pathname, err)
        sendError(req, res, 500, 'internal_error', 'internal error')
      }
    }
    return true
  }
}
