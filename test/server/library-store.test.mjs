import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLibraryApi } from '../../server/library-api.mjs'
import {
  ApiError,
  createLibraryStore,
  normalizeFolderPath,
  normalizeNotePath,
} from '../../server/library-store.mjs'
import { makeTempDir } from '../helpers/server.mjs'

let root
let library
let store

beforeEach(async () => {
  root = await makeTempDir()
  library = createLibraryApi(root)
  await library.init()
  store = createLibraryStore(library)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('path normalisation', () => {
  it('forces .md and tidies slashes', () => {
    expect(normalizeNotePath('/Projects//idea')).toBe('Projects/idea.md')
    expect(normalizeNotePath('Projects\\idea.MD')).toBe('Projects/idea.MD')
    expect(normalizeFolderPath('/Projects/2026/')).toBe('Projects/2026')
    expect(normalizeFolderPath('')).toBe('')
  })

  it.each([['../x'], ['a/../../x'], ['.trash/x'], ['Projects/.hidden/x'], ['nul\u0000'], ['']])(
    'refuses note path %j',
    (bad) => {
      expect(() => normalizeNotePath(bad)).toThrow(ApiError)
    },
  )

  it('refuses hidden and upward folder paths', () => {
    expect(() => normalizeFolderPath('../up')).toThrow(ApiError)
    expect(() => normalizeFolderPath('.deckle')).toThrow(ApiError)
  })
})

describe('notes', () => {
  it('never overwrites on create, numbering the collision instead', async () => {
    const first = await store.createNote({ path: 'Projects/Plan.md', content: 'one' })
    const second = await store.createNote({ path: 'Projects/Plan.md', content: 'two' })
    expect(first.path).toBe('Projects/Plan.md')
    expect(second.path).toBe('Projects/Plan 1.md')
    expect(second).toMatchObject({ title: 'Plan 1', folder: 'Projects', content: 'two' })
  })

  it('snapshots the version an overwrite replaces, keeping at most twenty', async () => {
    await store.writeNote('a.md', 'v0')
    const { created } = await store.writeNote('a.md', 'v0')
    expect(created).toBe(false)
    // Identical content isn't a new version.
    expect(await store.listHistory('a.md')).toHaveLength(0)

    for (let i = 1; i <= 23; i++) {
      await store.writeNote('a.md', `v${i}`)
      // Snapshot names carry a millisecond timestamp.
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const history = await store.listHistory('a.md')
    expect(history).toHaveLength(20)
    expect(await store.readSnapshot(history[0].snapName)).toBe('v22')
    expect(history.every((h) => h.reason === 'ai')).toBe(true)
  })

  it('refuses to write over a folder', async () => {
    await library.mkdir('Folder.md')
    await expect(store.writeNote('Folder.md', 'x')).rejects.toMatchObject({ status: 409 })
  })

  it('moves a note, carrying its history, and refuses to clobber', async () => {
    await store.writeNote('a.md', 'one')
    await store.writeNote('a.md', 'two')
    await store.writeNote('taken.md', 'mine')

    await expect(store.moveNote('a.md', 'taken.md')).rejects.toMatchObject({ status: 409 })
    const moved = await store.moveNote('a.md', 'Archive/a.md')
    expect(moved.content).toBe('two')
    expect(await library.exists('a.md')).toBeNull()
    expect(await store.listHistory('Archive/a.md')).toHaveLength(1)
  })

  it('refuses a snapshot name that tries to leave the history folder', async () => {
    await expect(store.readSnapshot('../a.md')).rejects.toMatchObject({ status: 400 })
    await expect(store.readSnapshot('..')).rejects.toMatchObject({ status: 404 })
  })
})

describe('recycle bin', () => {
  it('trashes, restores beside a newer note, and deletes', async () => {
    await store.writeNote('Projects/idea.md', 'old idea')
    const entry = await store.trashNote('Projects/idea.md')
    expect(await library.exists('Projects/idea.md')).toBeNull()
    expect((await store.listTrash()).map((i) => i.trashName)).toEqual([entry.trashName])

    await store.writeNote('Projects/idea.md', 'new idea')
    const restored = await store.restoreTrash(entry.trashName)
    expect(restored).toMatchObject({ path: 'Projects/idea 1.md', content: 'old idea' })
    expect(await store.listTrash()).toEqual([])

    const again = await store.trashNote('Projects/idea 1.md')
    await store.deleteTrashItem(again.trashName)
    expect(await store.listTrash()).toEqual([])
    await expect(store.deleteTrashItem(again.trashName)).rejects.toMatchObject({ status: 404 })
  })
})

describe('tasks and bookmarks', () => {
  const dataPath = (...parts) => path.join(root, ...parts)

  it('starts from a fresh empty store every time', async () => {
    const first = await store.loadTasks()
    first.tasks.push({ id: 'leaked' })
    expect((await store.loadTasks()).tasks).toEqual([])
    const bookmarks = await store.loadBookmarks()
    bookmarks.bookmarks.push({ id: 'leaked' })
    expect((await store.loadBookmarks()).bookmarks).toEqual([])
  })

  it('reads the pre-rename .nib folder when .deckle has nothing', async () => {
    await fs.mkdir(dataPath('.nib'))
    await fs.writeFile(
      dataPath('.nib', 'tasks.json'),
      JSON.stringify({ version: 1, tasks: [{ id: 'legacy' }], projects: [] }),
    )
    expect((await store.loadTasks()).tasks).toEqual([{ id: 'legacy' }])

    // The first change writes forward to .deckle.
    await store.updateTasks((data) => {
      data.tasks.push({ id: 'new' })
    })
    const saved = JSON.parse(await fs.readFile(dataPath('.deckle', 'tasks.json'), 'utf8'))
    expect(saved.tasks.map((t) => t.id)).toEqual(['legacy', 'new'])
  })

  it.each([
    ['not JSON', '{nope'],
    ['a newer format', JSON.stringify({ version: 2, tasks: [], projects: [] })],
    ['null', 'null'],
  ])('refuses to overwrite a tasks file that is %s', async (_label, content) => {
    await fs.mkdir(dataPath('.deckle'))
    await fs.writeFile(dataPath('.deckle', 'tasks.json'), content)

    await expect(store.loadTasks()).rejects.toMatchObject({ status: 500, code: 'store_unreadable' })
    await expect(
      store.updateTasks((data) => {
        data.tasks.push({ id: 'would-clobber' })
      }),
    ).rejects.toMatchObject({ code: 'store_unreadable' })
    expect(await fs.readFile(dataPath('.deckle', 'tasks.json'), 'utf8')).toBe(content)
  })

  it('serialises concurrent updates so none is lost', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.updateTasks((data) => {
          data.tasks.push({ id: `t${i}` })
        }),
      ),
    )
    expect((await store.loadTasks()).tasks).toHaveLength(25)
  })

  it('leaves the file untouched when a mutation throws', async () => {
    await store.updateBookmarks((data) => {
      data.bookmarks.push({ id: 'keep' })
    })
    await expect(
      store.updateBookmarks((data) => {
        data.bookmarks.push({ id: 'half-done' })
        throw new ApiError(400, 'invalid_body', 'nope')
      }),
    ).rejects.toThrow('nope')
    expect((await store.loadBookmarks()).bookmarks.map((b) => b.id)).toEqual(['keep'])
  })
})
