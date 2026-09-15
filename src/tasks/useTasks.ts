import { useCallback, useMemo } from 'react'
import { EMPTY_STORE, loadTaskStore, saveTaskStore } from './store'
import { nextOccurrence } from './dates'
import { PALETTE } from '../lib/palette'
import { useDataFile } from '../hooks/useDataFile'
import type { Priority, Recurrence, Task, TaskComment, TaskStore } from './types'

let counter = 0
const uid = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(counter++).toString(36)}`

/** Binned tasks older than this are purged when the store loads. */
const TRASH_RETENTION_MS = 30 * 86_400_000

export interface AddTaskInput {
  title: string
  due?: string | null
  projectId?: string | null
  priority?: Priority
  recurrence?: Recurrence | null
  source?: { noteId: string }
}

/** Load the store, dropping binned tasks past their retention. */
async function loadWithPurge(dir: FileSystemDirectoryHandle): Promise<TaskStore> {
  const s = await loadTaskStore(dir)
  const cutoff = Date.now() - TRASH_RETENTION_MS
  const kept = s.tasks.filter((t) => !t.deletedAt || t.deletedAt > cutoff)
  return kept.length === s.tasks.length ? s : { ...s, tasks: kept }
}

/** Task state backed by .deckle/tasks.json in the library, saved with a debounce. */
export function useTasks(dir: FileSystemDirectoryHandle | null) {
  const { store, mutate } = useDataFile<TaskStore>(dir, {
    load: loadWithPurge,
    save: saveTaskStore,
    empty: EMPTY_STORE,
    label: 'tasks',
  })

  const addTask = useCallback(
    (input: AddTaskInput) => {
      const title = input.title.replace(/\s+/g, ' ').trim()
      if (!title) return
      const task: Task = {
        id: uid('t'),
        title,
        projectId: input.projectId ?? null,
        due: input.due ?? null,
        priority: input.priority ?? 4,
        recurrence: input.recurrence ?? null,
        ...(input.source ? { source: input.source } : {}),
        completedAt: null,
        createdAt: Date.now(),
      }
      mutate((s) => ({ ...s, tasks: [...s.tasks, task] }))
    },
    [mutate],
  )

  const updateTask = useCallback(
    (id: string, patch: Partial<Task>) => {
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      }))
    },
    [mutate],
  )

  /** Append a free-text update to a task. Blank bodies are ignored. */
  const addComment = useCallback(
    (taskId: string, body: string) => {
      // Trailing whitespace goes; interior newlines stay, because an update is
      // prose and a paragraph break in it is meant.
      const text = body.trim()
      if (!text) return
      const comment: TaskComment = {
        id: uid('c'),
        body: text,
        createdAt: Date.now(),
      }
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === taskId ? { ...t, comments: [...(t.comments ?? []), comment] } : t,
        ),
      }))
    },
    [mutate],
  )

  const updateComment = useCallback(
    (taskId: string, commentId: string, body: string) => {
      const text = body.trim()
      if (!text) return
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === taskId
            ? {
                ...t,
                comments: (t.comments ?? []).map((c) =>
                  c.id === commentId ? { ...c, body: text } : c,
                ),
              }
            : t,
        ),
      }))
    },
    [mutate],
  )

  const deleteComment = useCallback(
    (taskId: string, commentId: string) => {
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === taskId
            ? { ...t, comments: (t.comments ?? []).filter((c) => c.id !== commentId) }
            : t,
        ),
      }))
    },
    [mutate],
  )

  const toggleComplete = useCallback(
    (id: string) => {
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) => {
          if (t.id !== id) return t
          if (t.completedAt) return { ...t, completedAt: null }
          // Recurring tasks roll to the next occurrence instead of completing.
          // server/api.mjs does the same for PATCH /tasks/{id}; keep them in step.
          if (t.recurrence && t.due) {
            return { ...t, due: nextOccurrence(t.due, t.recurrence) }
          }
          return { ...t, completedAt: Date.now() }
        }),
      }))
    },
    [mutate],
  )

  /** Soft delete: the task moves to the bin and can be restored. */
  const deleteTask = useCallback(
    (id: string) => {
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) =>
          t.id === id ? { ...t, deletedAt: Date.now() } : t,
        ),
      }))
    },
    [mutate],
  )

  const restoreTask = useCallback(
    (id: string) => {
      mutate((s) => ({
        ...s,
        tasks: s.tasks.map((t) => (t.id === id ? { ...t, deletedAt: null } : t)),
      }))
    },
    [mutate],
  )

  const deleteForever = useCallback(
    (id: string) => {
      mutate((s) => ({ ...s, tasks: s.tasks.filter((t) => t.id !== id) }))
    },
    [mutate],
  )

  const emptyTaskBin = useCallback(() => {
    mutate((s) => ({ ...s, tasks: s.tasks.filter((t) => !t.deletedAt) }))
  }, [mutate])

  /** Move all completed tasks to the bin (recoverable). */
  const clearCompleted = useCallback(() => {
    mutate((s) => ({
      ...s,
      tasks: s.tasks.map((t) =>
        t.completedAt && !t.deletedAt ? { ...t, deletedAt: Date.now() } : t,
      ),
    }))
  }, [mutate])

  const addProject = useCallback(
    (name: string): string => {
      const id = uid('p')
      mutate((s) => ({
        ...s,
        projects: [
          ...s.projects,
          {
            id,
            name: name.trim() || 'New project',
            color: PALETTE[s.projects.length % PALETTE.length],
          },
        ],
      }))
      return id
    },
    [mutate],
  )

  const renameProject = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim()
      if (!trimmed) return
      mutate((s) => ({
        ...s,
        projects: s.projects.map((p) => (p.id === id ? { ...p, name: trimmed } : p)),
      }))
    },
    [mutate],
  )

  /** Delete a project; its tasks move back to the Inbox. */
  const deleteProject = useCallback(
    (id: string) => {
      mutate((s) => ({
        version: 1,
        projects: s.projects.filter((p) => p.id !== id),
        tasks: s.tasks.map((t) =>
          t.projectId === id ? { ...t, projectId: null } : t,
        ),
      }))
    },
    [mutate],
  )

  return useMemo(
    () => ({
      store,
      addTask,
      updateTask,
      addComment,
      updateComment,
      deleteComment,
      toggleComplete,
      deleteTask,
      restoreTask,
      deleteForever,
      emptyTaskBin,
      clearCompleted,
      addProject,
      renameProject,
      deleteProject,
    }),
    [
      store,
      addTask,
      updateTask,
      addComment,
      updateComment,
      deleteComment,
      toggleComplete,
      deleteTask,
      restoreTask,
      deleteForever,
      emptyTaskBin,
      clearCompleted,
      addProject,
      renameProject,
      deleteProject,
    ],
  )
}

export type TasksApi = ReturnType<typeof useTasks>
