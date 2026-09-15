// Task persistence: a single JSON file in a hidden folder at the library root,
// so tasks travel with the library (sync, backup, coexistence with other
// Markdown editors) and work identically on a disk folder and OPFS.

import { preserveUnreadable, readDataFile, writeDataJson } from '../fs/appData'
import type { TaskStore } from './types'

const TASKS_FILE = 'tasks.json'

/** Shown before a library loads, and for one with no tasks yet. Never mutated. */
export const EMPTY_STORE: TaskStore = Object.freeze({
  version: 1,
  tasks: [],
  projects: [],
}) as TaskStore

export function isTaskStore(value: unknown): value is TaskStore {
  const store = value as TaskStore | null
  return (
    store?.version === 1 && Array.isArray(store.tasks) && Array.isArray(store.projects)
  )
}

export async function loadTaskStore(
  dir: FileSystemDirectoryHandle,
): Promise<TaskStore> {
  const read = await readDataFile(dir, TASKS_FILE)
  if (read.state === 'missing') return EMPTY_STORE
  if (read.parsed && isTaskStore(read.value)) return read.value

  // A file that won't parse, or a shape this version doesn't know (a newer
  // Deckle's). It used to load as an empty planner, and the next task added
  // was saved straight over every task in it. It is copied aside first now —
  // and if even the copy can't be written this throws, and nothing is saved.
  const backup = await preserveUnreadable(dir, TASKS_FILE, read.raw)
  console.warn(
    `[deckle] .deckle/${TASKS_FILE} could not be read; kept a copy as .deckle/${backup} and started an empty planner`,
  )
  return EMPTY_STORE
}

export async function saveTaskStore(
  dir: FileSystemDirectoryHandle,
  store: TaskStore,
): Promise<void> {
  await writeDataJson(dir, TASKS_FILE, store)
}
