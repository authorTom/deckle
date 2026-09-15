import { describe, expect, it, vi } from 'vitest'
import { readDataFile, readDataJson, writeDataJson } from '../../src/fs/appData'
import { EMPTY_STORE as EMPTY_TASKS, loadTaskStore, saveTaskStore } from '../../src/tasks/store'
import { EMPTY_STORE as EMPTY_BOOKMARKS, loadBookmarkStore } from '../../src/bookmarks/store'
import { createMemFs, get, listAll, put } from '../helpers/memfs'

describe('readDataFile', () => {
  it('tells missing, unreadable and readable apart', async () => {
    const dir = createMemFs()
    expect(await readDataFile(dir, 'tasks.json')).toEqual({ state: 'missing' })

    await put(dir, '.deckle/tasks.json', '{"version":1}')
    expect(await readDataFile(dir, 'tasks.json')).toMatchObject({
      state: 'found',
      parsed: true,
      value: { version: 1 },
    })

    await put(dir, '.deckle/tasks.json', '{broken')
    expect(await readDataFile(dir, 'tasks.json')).toEqual({
      state: 'found',
      parsed: false,
      raw: '{broken',
    })
  })

  it('falls back to the pre-rename folder only when the current file is absent', async () => {
    const dir = createMemFs()
    await put(dir, '.nib/tasks.json', '{"legacy":true}')
    expect(await readDataFile(dir, 'tasks.json')).toMatchObject({ value: { legacy: true } })

    // A broken current file is not "absent": the legacy copy must not stand in for it.
    await put(dir, '.deckle/tasks.json', 'oops')
    expect(await readDataFile(dir, 'tasks.json')).toMatchObject({ parsed: false })
  })

  it('throws when the library could not be read at all', async () => {
    const dir = createMemFs({
      beforeRead: () => {
        throw new DOMException('permission lapsed', 'NotAllowedError')
      },
    })
    await put(dir, '.deckle/tasks.json', '{}')
    await expect(readDataFile(dir, 'tasks.json')).rejects.toMatchObject({ name: 'NotAllowedError' })
    // The lenient reader still says "nothing".
    expect(await readDataJson(dir, 'tasks.json')).toBeNull()
  })

  it('writes nested data files', async () => {
    const dir = createMemFs()
    await writeDataJson(dir, 'runs/index.json', { version: 1, runs: [] })
    expect(await readDataJson(dir, 'runs/index.json')).toEqual({ version: 1, runs: [] })
  })
})

describe('task and bookmark stores', () => {
  it('load empty for a new library, and round-trip what they save', async () => {
    const dir = createMemFs()
    expect(await loadTaskStore(dir)).toBe(EMPTY_TASKS)
    expect(Object.isFrozen(EMPTY_TASKS)).toBe(true)
    const store = { version: 1 as const, tasks: [], projects: [{ id: 'p', name: 'P', color: '#000' }] }
    await saveTaskStore(dir, store)
    expect(await loadTaskStore(dir)).toEqual(store)
  })

  it.each([
    ['not JSON', '{"version":1,"tasks":[{"id":"a"'],
    ['a newer format', '{"version":2,"tasks":[],"projects":[]}'],
  ])('copy a tasks file that is %s aside before anything can replace it', async (_label, raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = createMemFs()
    await put(dir, '.deckle/tasks.json', raw)

    expect(await loadTaskStore(dir)).toBe(EMPTY_TASKS)
    const backups = (await listAll(dir)).filter((p) => p.includes('tasks.unreadable-'))
    expect(backups).toHaveLength(1)
    expect(await get(dir, backups[0])).toBe(raw)
    expect(warn).toHaveBeenCalled()
  })

  it('refuse to load — so nothing saves — when the backup itself cannot be written', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = createMemFs({
      beforeWrite: (path) => {
        if (path.includes('unreadable')) throw new DOMException('read-only', 'NotAllowedError')
      },
    })
    await put(dir, '.deckle/bookmarks.json', 'garbage')
    await expect(loadBookmarkStore(dir)).rejects.toMatchObject({ name: 'NotAllowedError' })
    expect(await get(dir, '.deckle/bookmarks.json')).toBe('garbage')
  })

  it('read bookmarks from the pre-rename folder', async () => {
    const dir = createMemFs()
    const legacy = { version: 1, bookmarks: [{ id: 'b' }], collections: [] }
    await put(dir, '.nib/bookmarks.json', JSON.stringify(legacy))
    expect(await loadBookmarkStore(dir)).toEqual(legacy)
    expect(await loadBookmarkStore(createMemFs())).toBe(EMPTY_BOOKMARKS)
  })
})
