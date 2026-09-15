import fs from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RESERVED_DIR, TooLargeError, createLibraryApi } from '../../server/library-api.mjs'
import { BadPathError } from '../../server/paths.mjs'
import { makeTempDir } from '../helpers/server.mjs'

let root
let lib

async function write(rel, content) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, content)
}

beforeEach(async () => {
  root = await makeTempDir()
  lib = createLibraryApi(root)
  await lib.init()
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('the reserved state folder', () => {
  beforeEach(async () => {
    await write(`${RESERVED_DIR}/assistant.json`, '{"anthropicKey":"sk-secret"}')
  })

  it.each([
    [`${RESERVED_DIR}/assistant.json`],
    [`./${RESERVED_DIR}/assistant.json`],
    [`.//${RESERVED_DIR}/assistant.json`],
    [`${RESERVED_DIR.toUpperCase()}/assistant.json`],
    [RESERVED_DIR],
  ])('cannot be read through %j', async (rel) => {
    await expect(lib.readText(rel)).rejects.toThrow(BadPathError)
    await expect(lib.openForRead(rel)).rejects.toThrow(BadPathError)
    await expect(lib.stat(rel)).rejects.toThrow(BadPathError)
    expect(await lib.exists(rel)).toBeNull()
  })

  it('cannot be written, created or removed', async () => {
    await expect(lib.writeText(`./${RESERVED_DIR}/assistant.json`, '{}')).rejects.toThrow(BadPathError)
    await expect(lib.mkdir(`./${RESERVED_DIR}/x`)).rejects.toThrow(BadPathError)
    await expect(lib.remove(`./${RESERVED_DIR}`, true)).rejects.toThrow(BadPathError)
    expect(await fs.readFile(path.join(root, RESERVED_DIR, 'assistant.json'), 'utf8')).toContain(
      'sk-secret',
    )
  })

  it('never appears in a listing or a tree', async () => {
    for (const rel of ['', '.', './']) {
      const names = (await lib.list(rel)).map((e) => e.name)
      expect(names).not.toContain(RESERVED_DIR)
    }
    expect(JSON.stringify(await lib.tree(''))).not.toContain(RESERVED_DIR)
  })

  it('also protects a state directory configured elsewhere inside the library', async () => {
    const custom = createLibraryApi(root, { reservedPaths: [path.join(root, 'ops', 'state')] })
    await write('ops/state/assistant.json', '{}')
    await write('ops/readme.md', '# ops')

    await expect(custom.readText('ops/state/assistant.json')).rejects.toThrow(BadPathError)
    expect((await custom.list('ops')).map((e) => e.name)).toEqual(['readme.md'])
    expect(JSON.stringify(await custom.tree(''))).not.toContain('state')
    // Deleting the folder that holds it would delete it too.
    await expect(custom.remove('ops', true)).rejects.toThrow(BadPathError)
  })
})

describe('reading and listing', () => {
  it('builds a tree of folders then notes, skipping dotfiles and other files', async () => {
    await write('b.md', 'b')
    await write('A.md', 'a')
    await write('notes.txt', 'ignored')
    await write('.trash/old.md', 'hidden')
    await write('Zeta/z.md', 'z')
    await write('Alpha/Inner/deep.md', 'deep')

    const tree = await lib.tree('')
    expect(tree.map((n) => n.id)).toEqual(['Alpha', 'Zeta', 'A.md', 'b.md'])
    expect(tree[0].children[0].children[0]).toMatchObject({
      kind: 'file',
      id: 'Alpha/Inner/deep.md',
      title: 'deep',
    })
    expect(await lib.tree('does-not-exist')).toEqual([])
  })

  it('lists dotfiles too, with sizes', async () => {
    await write('.trash/index.json', '[]')
    await write('a.md', 'hello')
    const entries = await lib.list('')
    expect(entries).toEqual(
      expect.arrayContaining([
        { name: '.trash', kind: 'directory' },
        expect.objectContaining({ name: 'a.md', kind: 'file', size: 5 }),
      ]),
    )
  })

  it('opens files, and says when a path is a folder', async () => {
    await write('a.md', 'hello')
    const { handle, size } = await lib.openForRead('a.md')
    expect(size).toBe(5)
    await handle.close()

    await fs.mkdir(path.join(root, 'folder'))
    await expect(lib.openForRead('folder')).rejects.toMatchObject({ code: 'ENOTFILE' })
    await expect(lib.openForRead('missing.md')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to follow a symlink out of the library', async () => {
    const outside = await makeTempDir()
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'secret')
      await fs.symlink(outside, path.join(root, 'escape'))
      await expect(lib.readText('escape/secret.md')).rejects.toThrow(BadPathError)
      await expect(lib.writeText('escape/new.md', 'x')).rejects.toThrow(BadPathError)
      expect(JSON.stringify(await lib.tree(''))).not.toContain('escape')
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe('writing and removing', () => {
  it('writes text atomically, creating folders', async () => {
    const result = await lib.writeText('Projects/2026/plan.md', '# Plan')
    expect(result.size).toBe(6)
    expect(await lib.readText('Projects/2026/plan.md')).toBe('# Plan')
    expect(await fs.readdir(path.join(root, 'Projects', '2026'))).toEqual(['plan.md'])
  })

  it('streams uploads, and stops one that runs past the cap without touching the original', async () => {
    await lib.writeFile('note.md', Readable.from([Buffer.from('original')]))
    const huge = Readable.from([Buffer.alloc(lib.maxFileBytes), Buffer.alloc(16)])
    await expect(lib.writeFile('note.md', huge)).rejects.toThrow(TooLargeError)
    expect(await lib.readText('note.md')).toBe('original')
    // No temporary file left behind.
    expect(await fs.readdir(root)).toEqual(['note.md'])
  })

  it('never removes the library root, and refuses a non-empty folder unless recursive', async () => {
    await expect(lib.remove('', true)).rejects.toThrow(BadPathError)
    await expect(lib.remove('.', true)).rejects.toThrow(BadPathError)

    await write('Folder/a.md', 'a')
    await expect(lib.remove('Folder', false)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await lib.remove('Folder', true)
    expect(await lib.exists('Folder')).toBeNull()
  })

  it('removes single files', async () => {
    await write('a.md', 'a')
    await lib.remove('a.md', false)
    expect(await lib.exists('a.md')).toBeNull()
  })
})
