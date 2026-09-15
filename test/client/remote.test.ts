// The app's library code, end to end, against the real server: src/fs/remote.ts
// presents the server's file API as a FileSystemDirectoryHandle, and everything
// above it — notes, trash, history, stores, the queue — must work through it
// exactly as it does on a local folder.

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
// @ts-expect-error — a plain .mjs helper with no type declarations
import { startServer } from '../helpers/server.mjs'
import * as remote from '../../src/fs/remote'
import * as library from '../../src/fs/library'
import * as history from '../../src/fs/history'
import { loadTaskStore, saveTaskStore } from '../../src/tasks/store'
import { loadIndex, newRunId, saveRun } from '../../src/queue/store'
import { createMemory, loadMemories } from '../../src/memory/store'

type Server = Awaited<ReturnType<typeof startServer>>

const realFetch = globalThis.fetch
let base = ''

beforeAll(() => {
  // The adapter calls relative URLs, as the browser would against its own origin.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)) as typeof fetch
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe('the server library through the handle adapter', () => {
  let s: Server
  let dir: FileSystemDirectoryHandle

  beforeAll(async () => {
    s = await startServer({ DECKLE_LIBRARY_NAME: 'Shared' })
    base = s.base
    dir = remote.openServerLibrary('Shared')
  })
  afterAll(() => s.close())

  it('is discovered by the app', async () => {
    expect(await remote.detectServerLibrary()).toMatchObject({ enabled: true, name: 'Shared' })
    expect(remote.isRemoteHandle(dir)).toBe(true)
  })

  it('creates, writes, reads, renames and moves notes', async () => {
    expect((await library.createNote(dir)).id).toBe('Untitled.md')
    expect((await library.createNote(dir)).id).toBe('Untitled 1.md')

    await library.writeNote(dir, 'Projects/2026/plan.md', '# Plan — ünïcödé')
    expect(await library.readNote(dir, 'Projects/2026/plan.md')).toBe('# Plan — ünïcödé')

    const renamed = await library.renameNote(dir, 'Projects/2026/plan.md', 'Roadmap')
    expect(renamed).toBe('Projects/2026/Roadmap.md')
    expect(await library.moveNote(dir, renamed, 'Archive')).toBe('Archive/Roadmap.md')

    const ids = library.flattenFiles(await library.buildTree(dir)).map((f) => f.id)
    expect(ids).toEqual(expect.arrayContaining(['Archive/Roadmap.md', 'Untitled.md', 'Untitled 1.md']))
    await expect(library.readNote(dir, 'Projects/2026/plan.md')).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('bins and restores through the recycle bin', async () => {
    await library.writeNote(dir, 'Bin/me.md', 'bin me')
    await library.trashNote(dir, 'Bin/me.md')
    const [item] = await library.listTrash(dir)
    expect(await library.restoreTrash(dir, item.trashName)).toBe('Bin/me.md')
    await library.trashFolder(dir, 'Bin')
    expect((await library.listTrash(dir)).map((i) => i.originalPath)).toContain('Bin/me.md')
  })

  it('imports, keeping hostile paths inside the library', async () => {
    const imported = await library.importNotes(dir, [{ path: '../../../etc/evil.md', content: 'x' }], 'Imports')
    expect(imported.map((n) => n.id)).toEqual(['Imports/etc/evil.md'])
    await expect(fs.stat(path.join(s.root, 'etc'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps history, tasks, the queue and memory in the library', async () => {
    await history.snapshotNote(dir, 'Archive/Roadmap.md', 'older', 'edit')
    expect(await history.listHistory(dir, 'Archive/Roadmap.md')).toHaveLength(1)

    const store = { version: 1 as const, tasks: [], projects: [{ id: 'p', name: 'Garden', color: '#30a46c' }] }
    await saveTaskStore(dir, store)
    expect(await loadTaskStore(dir)).toEqual(store)

    const id = newRunId()
    await saveRun(dir, {
      id,
      title: 'Run',
      prompt: 'p',
      status: 'queued',
      createdAt: 1,
      messages: [],
      writes: [],
      attempt: 1,
    })
    expect((await loadIndex(dir)).runs.map((r) => r.id)).toContain(id)

    await createMemory(dir, { summary: 'Prefers short answers', body: 'Said so.' })
    expect((await loadMemories(dir, true)).map((m) => m.summary)).toContain('Prefers short answers')
  })

  it('never exports the server’s own state, even with hidden folders included', async () => {
    await fs.mkdir(path.join(s.libraryDir, '.deckle-state'), { recursive: true })
    await fs.writeFile(path.join(s.libraryDir, '.deckle-state', 'assistant.json'), '{"key":"sk"}')
    const files = await library.collectFiles(dir, { includeHidden: true })
    const paths = files.map((f) => f.path)
    expect(paths).toContain('.deckle/tasks.json')
    expect(paths.some((p) => p.startsWith('.deckle-state'))).toBe(false)
  })
})

describe('an expired session', () => {
  let s: Server

  beforeAll(async () => {
    s = await startServer({ DECKLE_PASSWORD: 'correct-password' })
    base = s.base
  })
  afterAll(() => s.close())

  it('sends the app back to the unlock screen rather than failing silently', async () => {
    const onUnauthorized = vi.fn()
    remote.setUnauthorizedHandler(onUnauthorized)
    try {
      const dir = remote.openServerLibrary('Locked')
      await expect(library.readNote(dir, 'a.md')).rejects.toMatchObject({ name: 'NotAllowedError' })
      expect(onUnauthorized).toHaveBeenCalled()
      expect(await remote.loginServerLibrary('wrong')).toBe('Incorrect password.')
    } finally {
      remote.setUnauthorizedHandler(null)
    }
  })
})
