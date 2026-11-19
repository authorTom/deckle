// The task planner and bookmarks, applied server-side.
//
// Shared by the REST API (api.mjs) and the MCP server (mcp.mjs), so a task an
// agent adds over MCP is validated, stored and recurs exactly like one added
// over REST — and exactly like the app's own (src/tasks/useTasks.ts).

import { randomUUID } from 'node:crypto'
import { ApiError, normalizeNotePath } from './library-store.mjs'
import { isValidDateStr, nextOccurrence, todayStr } from './dates.mjs'

export function requireString(body, field, { optional = false, max = 100_000 } = {}) {
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
export function optionalId(body, field) {
  const value = body?.[field]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string' || !value) {
    throw new ApiError(400, 'invalid_body', `"${field}" must be an id string or null`)
  }
  return value
}


export function createPlanner(store) {
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

  /**
   * filter: all | inbox | today | upcoming | overdue | completed | deleted.
   * Completed and binned tasks are left out unless asked for.
   */
  function filterTasks(
    tasks,
    { filter = 'all', project = null, includeCompleted = false, includeDeleted = false } = {},
  ) {
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

  /** To the task bin (purged by the app after 30 days), or gone for good. */
  async function deleteTask(id, { permanent = false } = {}) {
    return await store.updateTasks((data) => {
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) throw new ApiError(404, 'not_found', `no task with id "${id}"`)
      const [task] = permanent ? data.tasks.splice(index, 1) : [data.tasks[index]]
      if (!permanent) task.deletedAt = Date.now()
      return { task, permanent }
    })
  }

  return { filterTasks, createTask, patchTask, deleteTask, createBookmark, patchBookmark }
}
