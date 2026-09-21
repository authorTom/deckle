import { describe, expect, it } from 'vitest'
import * as library from '../../src/fs/library'
import * as history from '../../src/fs/history'
import { createMemFs, get, listAll, put, sleep } from '../helpers/memfs'

describe('buildTree', () => {
  it('lists folders first, then notes and files by name, skipping hidden entries and clutter', async () => {
    const dir = createMemFs()
    await put(dir, 'b.md', 'b')
    await put(dir, 'A.md', 'a')
    await put(dir, 'photo.png', 'x')
    await put(dir, 'Thumbs.db', 'x')
    await put(dir, '.trash/gone.md', 'x')
    await put(dir, 'Zeta/z.md', 'z')
    await put(dir, 'Alpha/Inner/deep.md', 'd')
    await dir.getDirectoryHandle('Empty', { create: true })

    const tree = await library.buildTree(dir)
    expect(tree.map((n) => n.id)).toEqual(['Alpha', 'Empty', 'Zeta', 'A.md', 'b.md', 'photo.png'])
    expect(tree.at(-1)).toMatchObject({ kind: 'asset', name: 'photo.png', title: 'photo.png', ext: 'png', size: 1 })
    // Notes-only consumers are never handed a file.
    expect(library.flattenFiles(tree).map((f) => f.id)).toEqual([
      'Alpha/Inner/deep.md',
      'Zeta/z.md',
      'A.md',
      'b.md',
    ])
    expect(library.flattenAssets(tree).map((f) => f.id)).toEqual(['photo.png'])
  })
})

describe('notes', () => {
  it('creates uniquely named notes', async () => {
    const dir = createMemFs()
    expect((await library.createNote(dir)).id).toBe('Untitled.md')
    expect((await library.createNote(dir)).id).toBe('Untitled 1.md')
    expect((await library.createNote(dir, 'Projects/2026')).id).toBe('Projects/2026/Untitled.md')
  })

  it('writes and reads, creating folders', async () => {
    const dir = createMemFs()
    await library.writeNote(dir, 'Deep/Down/note.md', '# Deep')
    expect(await library.readNote(dir, 'Deep/Down/note.md')).toBe('# Deep')
    await expect(library.readNote(dir, 'missing.md')).rejects.toMatchObject({ name: 'NotFoundError' })
  })

  it('renames, numbering around a collision and stripping illegal characters', async () => {
    const dir = createMemFs()
    await put(dir, 'Projects/draft.md', 'draft')
    await put(dir, 'Projects/Plan.md', 'existing plan')

    expect(await library.renameNote(dir, 'Projects/draft.md', 'Plan')).toBe('Projects/Plan 1.md')
    expect(await library.renameNote(dir, 'Projects/Plan 1.md', 'Q3: a/b?')).toBe('Projects/Q3 ab.md')
    expect(await library.renameNote(dir, 'Projects/Q3 ab.md', '   ')).toBe('Projects/Untitled.md')
    expect(await get(dir, 'Projects/Plan.md')).toBe('existing plan')
    expect(await get(dir, 'Projects/Untitled.md')).toBe('draft')
  })

  it('changes only the case of a name on a case-insensitive disk without losing the note', async () => {
    const dir = createMemFs({ caseInsensitive: true })
    await put(dir, 'note.md', 'precious')
    expect(await library.renameNote(dir, 'note.md', 'Note')).toBe('Note.md')
    expect(await listAll(dir)).toEqual(['Note.md'])
    expect(await get(dir, 'Note.md')).toBe('precious')

    await put(dir, 'scan.pdf', '%PDF')
    expect(await library.renameAsset(dir, 'scan.pdf', 'SCAN')).toBe('SCAN.pdf')
    expect(await listAll(dir)).toEqual(['Note.md', 'SCAN.pdf'])
    expect(await get(dir, 'SCAN.pdf')).toBe('%PDF')
  })

  it('moves a note into another folder without overwriting', async () => {
    const dir = createMemFs()
    await put(dir, 'a.md', 'root a')
    await put(dir, 'Archive/a.md', 'archived a')
    expect(await library.moveNote(dir, 'a.md', 'Archive')).toBe('Archive/a 1.md')
    expect(await library.moveNote(dir, 'Archive/a 1.md', 'Archive')).toBe('Archive/a 1.md')
    expect(await listAll(dir)).toEqual(['Archive/a 1.md', 'Archive/a.md'])
  })

  it('renames a folder, carrying everything inside it', async () => {
    const dir = createMemFs()
    await put(dir, 'Old/note.md', 'n')
    await put(dir, 'Old/Sub/pic.png', 'binary')
    await put(dir, 'New/keep.md', 'k')
    expect(await library.renameFolder(dir, 'Old', 'New')).toBe('New 1')
    expect(await listAll(dir)).toEqual(['New 1/Sub/pic.png', 'New 1/note.md', 'New/keep.md'])
  })
})

describe('importNotes', () => {
  it('keeps imported paths inside the target folder, visible, and uniquely named', async () => {
    const dir = createMemFs()
    await put(dir, 'Imported/dup.md', 'already here')

    const imported = await library.importNotes(
      dir,
      [
        { path: '../../evil.md', content: 'e' },
        { path: '.hidden/x.md', content: 'h' },
        { path: 'Folder/.env', content: 'dot' },
        { path: 'a:b*c.txt', content: 'txt' },
        { path: 'dup.md', content: 'one' },
        { path: 'dup.md', content: 'two' },
        { path: '../..', content: 'nothing usable' },
        { path: 'C:\\Users\\me\\notes\\win.markdown', content: 'w' },
      ],
      'Imported',
    )

    expect(imported.map((n) => n.id)).toEqual([
      'Imported/evil.md',
      'Imported/hidden/x.md',
      'Imported/Folder/env.md',
      'Imported/abc.md',
      'Imported/dup 1.md',
      'Imported/dup 2.md',
      'Imported/C/Users/me/notes/win.md',
    ])
    expect(imported.find((n) => n.id === 'Imported/dup 1.md')?.renamed).toBe(true)
    expect(await get(dir, 'Imported/dup.md')).toBe('already here')
    expect((await listAll(dir)).every((p) => p.startsWith('Imported/'))).toBe(true)
  })
})

describe('recycle bin', () => {
  it('trashes, lists, restores beside a newer note, and deletes', async () => {
    const dir = createMemFs()
    await put(dir, 'Projects/idea.md', 'old idea')
    await library.trashNote(dir, 'Projects/idea.md')
    expect(await get(dir, 'Projects/idea.md')).toBeNull()

    const [item] = await library.listTrash(dir)
    expect(item).toMatchObject({ originalPath: 'Projects/idea.md', title: 'idea' })

    await put(dir, 'Projects/idea.md', 'new idea')
    expect(await library.restoreTrash(dir, item.trashName)).toBe('Projects/idea 1.md')
    expect(await get(dir, 'Projects/idea 1.md')).toBe('old idea')
    expect(await library.listTrash(dir)).toEqual([])
    expect(await library.restoreTrash(dir, 'no-such-item')).toBeNull()

    await library.trashNote(dir, 'Projects/idea.md')
    const [again] = await library.listTrash(dir)
    await library.deleteTrashItem(dir, again.trashName)
    expect(await library.listTrash(dir)).toEqual([])
  })

  it('bins everything in a folder — files too — then removes the folder', async () => {
    const dir = createMemFs()
    await put(dir, 'Old/a.md', 'a')
    await put(dir, 'Old/Sub/b.md', 'b')
    await put(dir, 'Old/Sub/pic.png', 'png')
    expect(await library.trashFolder(dir, 'Old')).toBe(3)
    expect((await library.listTrash(dir)).map((i) => i.originalPath).sort()).toEqual([
      'Old/Sub/b.md',
      'Old/Sub/pic.png',
      'Old/a.md',
    ])
    expect((await library.buildTree(dir)).map((n) => n.id)).toEqual([])

    await library.emptyTrash(dir)
    expect(await library.listTrash(dir)).toEqual([])
  })
})

describe('collectFiles', () => {
  it('always exports the data folder, and hidden folders only when asked', async () => {
    const dir = createMemFs()
    await put(dir, 'note.md', 'n')
    await put(dir, 'pic.png', 'p')
    await put(dir, '.deckle/tasks.json', '{}')
    await put(dir, '.nib/bookmarks.json', '{}')
    await put(dir, '.trash/old.md', 'o')

    const plain = (await library.collectFiles(dir)).map((f) => f.path).sort()
    expect(plain).toEqual(['.deckle/tasks.json', '.nib/bookmarks.json', 'note.md', 'pic.png'])
    const full = (await library.collectFiles(dir, { includeHidden: true })).map((f) => f.path)
    expect(full).toContain('.trash/old.md')
  })
})

describe('version history', () => {
  it('snapshots, caps each note at twenty, and follows a rename', async () => {
    const dir = createMemFs()
    for (let i = 0; i < 23; i++) {
      await history.snapshotNote(dir, 'Projects/a.md', `v${i}`, 'edit')
      await sleep(2)
    }
    await history.snapshotNote(dir, 'other.md', 'other', 'ai')

    const items = await history.listHistory(dir, 'Projects/a.md')
    expect(items).toHaveLength(20)
    expect(await history.readSnapshot(dir, items[0].snapName)).toBe('v22')
    expect(await history.readSnapshot(dir, items[19].snapName)).toBe('v3')

    await history.deleteSnapshot(dir, items[0].snapName)
    expect(await history.listHistory(dir, 'Projects/a.md')).toHaveLength(19)

    await history.retargetHistory(dir, 'Projects/a.md', 'Archive/a.md')
    expect(await history.listHistory(dir, 'Projects/a.md')).toHaveLength(0)
    expect(await history.listHistory(dir, 'Archive/a.md')).toHaveLength(19)
    expect(await history.listHistory(dir, 'other.md')).toHaveLength(1)
  })

  it('never lets a failure escape into the write it protects', async () => {
    const dir = createMemFs({
      beforeWrite: (path) => {
        if (path.startsWith('.history')) throw new DOMException('disk full', 'QuotaExceededError')
      },
    })
    await expect(history.snapshotNote(dir, 'a.md', 'x', 'edit')).resolves.toBeUndefined()
    expect(await history.listHistory(dir, 'a.md')).toEqual([])
  })
})

describe('files beside notes', () => {
  const bytes = new Uint8Array(Array.from({ length: 600 }, (_, i) => (i * 37 + 11) % 256))
  const same = async (file: File) => new Uint8Array(await file.arrayBuffer()).every((b, i) => b === bytes[i])

  it('moves, bins and restores a binary file byte for byte', async () => {
    const dir = createMemFs()
    await library.writeBlob(dir, 'Inbox/scan.pdf', new Blob([bytes]))
    expect(await library.moveNote(dir, 'Inbox/scan.pdf', 'Projects/Acme')).toBe('Projects/Acme/scan.pdf')
    expect(await same(await library.readBlob(dir, 'Projects/Acme/scan.pdf'))).toBe(true)

    await library.trashNote(dir, 'Projects/Acme/scan.pdf')
    const [item] = await library.listTrash(dir)
    expect(item).toMatchObject({ title: 'scan.pdf', kind: 'file', originalPath: 'Projects/Acme/scan.pdf' })
    await library.writeBlob(dir, 'Projects/Acme/scan.pdf', new Blob(['newer']))
    expect(await library.restoreTrash(dir, item.trashName)).toBe('Projects/Acme/scan 1.pdf')
    expect(await same(await library.readBlob(dir, 'Projects/Acme/scan 1.pdf'))).toBe(true)
  })

  it('renames a file keeping its extension unless a new one is given', async () => {
    const dir = createMemFs()
    await library.writeBlob(dir, 'Q3.xlsx', new Blob([bytes]))
    await library.writeBlob(dir, 'Q3 final.xlsx', new Blob(['taken']))
    expect(await library.renameAsset(dir, 'Q3.xlsx', 'Q3 final')).toBe('Q3 final 1.xlsx')
    expect(await library.renameAsset(dir, 'Q3 final 1.xlsx', 'model.csv')).toBe('model.csv')
    expect(await same(await library.readBlob(dir, 'model.csv'))).toBe(true)
  })

  it('imports dropped files as they are, beside the notes', async () => {
    const dir = createMemFs()
    const imported = await library.importNotes(
      dir,
      [
        { path: 'Research/notes.txt', content: 'plain' },
        { path: 'Research/chart.png', blob: new Blob([bytes]) },
        { path: 'Research/chart.png', blob: new Blob(['again']) },
      ],
      'Inbox',
    )
    expect(imported).toEqual([
      { id: 'Inbox/Research/notes.md', title: 'notes', renamed: false, isNote: true },
      { id: 'Inbox/Research/chart.png', title: 'chart.png', renamed: false, isNote: false },
      { id: 'Inbox/Research/chart 1.png', title: 'chart 1.png', renamed: true, isNote: false },
    ])
    expect(await same(await library.readBlob(dir, 'Inbox/Research/chart.png'))).toBe(true)
  })
})
