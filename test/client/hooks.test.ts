// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDataFile } from '../../src/hooks/useDataFile'
import { useNotes } from '../../src/hooks/useNotes'
import { useTasks } from '../../src/tasks/useTasks'
import { createMemFs, get, put, sleep } from '../helpers/memfs'

interface Items {
  items: string[]
}

const EMPTY: Items = { items: [] }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useDataFile', () => {
  it('holds changes made while loading, then saves them on top of what loaded', async () => {
    const loading = deferred<Items>()
    const save = vi.fn(async () => {})
    const dir = createMemFs()
    const { result } = renderHook(() =>
      useDataFile(dir, { load: () => loading.promise, save, empty: EMPTY, label: 'test', debounceMs: 5 }),
    )

    act(() => result.current.mutate((s) => ({ items: [...s.items, 'added early'] })))
    await sleep(40)
    // Saving now would write "added early" over whatever the file holds.
    expect(save).not.toHaveBeenCalled()

    await act(async () => loading.resolve({ items: ['from disk'] }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.calls[0]).toEqual([dir, { items: ['from disk', 'added early'] }])
    expect(result.current.store).toEqual({ items: ['from disk', 'added early'] })
  })

  it('writes saves in order, even when an earlier one is slow', async () => {
    const written: Items[] = []
    let first = true
    const save = vi.fn(async (_dir: FileSystemDirectoryHandle, value: Items) => {
      if (first) {
        first = false
        await sleep(60)
      }
      written.push(value)
    })
    const { result } = renderHook(() =>
      useDataFile(createMemFs(), { load: async () => EMPTY, save, empty: EMPTY, label: 'test', debounceMs: 1000 }),
    )
    await waitFor(() => expect(result.current.store).toBe(EMPTY))
    await sleep(5)

    act(() => {
      result.current.mutate(() => ({ items: ['one'] }))
      result.current.flush()
      result.current.mutate(() => ({ items: ['two'] }))
      result.current.flush()
    })
    await waitFor(() => expect(written).toHaveLength(2))
    expect(written).toEqual([{ items: ['one'] }, { items: ['two'] }])
  })

  it('never saves a store it could not load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const save = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useDataFile(createMemFs(), {
        load: async () => {
          throw new DOMException('gone', 'NotAllowedError')
        },
        save,
        empty: EMPTY,
        label: 'test',
        debounceMs: 5,
      }),
    )
    await sleep(10)
    act(() => {
      result.current.mutate(() => ({ items: ['would clobber'] }))
      result.current.flush()
    })
    await sleep(30)
    expect(save).not.toHaveBeenCalled()
  })

  it('writes a pending change to its own library before switching to another', async () => {
    const save = vi.fn(async () => {})
    const a = createMemFs()
    const b = createMemFs()
    const { result, rerender } = renderHook(
      ({ dir }) => useDataFile(dir, { load: async () => EMPTY, save, empty: EMPTY, label: 'test', debounceMs: 10_000 }),
      { initialProps: { dir: a } },
    )
    await sleep(5)
    act(() => result.current.mutate(() => ({ items: ['for a'] })))
    rerender({ dir: b })
    await waitFor(() => expect(save).toHaveBeenCalledWith(a, { items: ['for a'] }))
    // By identity: two empty in-memory libraries are deep-equal to each other.
    expect((save.mock.calls as unknown[][]).every((call) => call[0] === a)).toBe(true)
    expect(result.current.store).toEqual(EMPTY)
  })

  it('saves when the tab is hidden', async () => {
    const save = vi.fn(async () => {})
    const { result } = renderHook(() =>
      useDataFile(createMemFs(), { load: async () => EMPTY, save, empty: EMPTY, label: 'test', debounceMs: 10_000 }),
    )
    await sleep(5)
    act(() => result.current.mutate(() => ({ items: ['x'] })))
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
  })
})

describe('useTasks', () => {
  it('persists tasks to the library and rolls recurring ones forward', async () => {
    const dir = createMemFs()
    const { result } = renderHook(() => useTasks(dir))
    await sleep(5)

    act(() => {
      result.current.addTask({ title: '  Water   plants ', due: '2020-01-01', recurrence: { freq: 'daily', interval: 1 } })
      result.current.addTask({ title: '   ' })
    })
    expect(result.current.store.tasks).toHaveLength(1)
    const task = result.current.store.tasks[0]
    expect(task.title).toBe('Water plants')

    act(() => result.current.toggleComplete(task.id))
    const rolled = result.current.store.tasks[0]
    expect(rolled.completedAt).toBeNull()
    expect(rolled.due! > '2020-01-01').toBe(true)

    await waitFor(async () => expect(await get(dir, '.deckle/tasks.json')).toContain('Water plants'), {
      timeout: 2000,
    })
  })
})

describe('useNotes autosave', () => {
  afterEach(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker
  })

  it('never lets a slow earlier save land after a later one', async () => {
    const writes: string[] = []
    const dir = createMemFs({
      beforeWrite: async (path, text) => {
        if (path !== 'a.md') return
        if (text === 'v1') await sleep(150)
        writes.push(text)
      },
    })
    await put(dir, 'a.md', 'v0')
    writes.length = 0
    ;(window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker =
      async () => dir

    const { result } = renderHook(() => useNotes())
    await waitFor(() => expect(result.current.status).toBe('no-library'))
    await act(async () => {
      await result.current.connect()
    })
    await waitFor(() => expect(result.current.notes.map((n) => n.id)).toEqual(['a.md']))

    act(() => {
      result.current.saveContent('a.md', 'v1')
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await sleep(20)
    act(() => {
      result.current.saveContent('a.md', 'v2')
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await waitFor(() => expect(writes).toHaveLength(2), { timeout: 2000 })
    expect(writes).toEqual(['v1', 'v2'])
    expect(await get(dir, 'a.md')).toBe('v2')
    await waitFor(() => expect(result.current.saveState).toBe('saved'))
  })
})
