import { describe, expect, it } from 'vitest'
import { parseFrontmatter, withFrontmatter } from '../../src/memory/frontmatter'
import * as memory from '../../src/memory/store'
import { buildMemoryContext, estimateTokens, findDuplicate } from '../../src/memory/context'
import { buildPreview, executeTool, TOOL_DEFS, toolByName } from '../../src/ai/tools'
import * as history from '../../src/fs/history'
import * as library from '../../src/fs/library'
import type { ToolCall } from '../../src/ai/types'
import { createMemFs, get, put } from '../helpers/memfs'

const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c1', name, arguments: args })

describe('front matter', () => {
  it('round-trips the values a memory carries, quoting where a bare value would change meaning', () => {
    const data = {
      kind: 'preference',
      summary: 'Note: British spelling, "always"',
      tags: ['style', 'writing'],
      pinned: true,
      confidence: 'high',
      created: '2026-09-14',
      uses: 3,
      looksBoolean: 'true',
      looksNumber: '42',
      leadingDash: '- not a list',
    }
    const text = withFrontmatter(data, '\n# Body\n\nDetails.\n')
    const parsed = parseFrontmatter(text)
    expect(parsed.data).toEqual(data)
    expect(parsed.body).toBe('# Body\n\nDetails.')
  })

  it('reads a document without front matter as all body', () => {
    expect(parseFrontmatter('# Just a note')).toEqual({ data: {}, body: '# Just a note' })
  })
})

describe('memory store', () => {
  it('creates, dedupes paths, updates, indexes and forgets', async () => {
    const dir = createMemFs()
    const first = await memory.createMemory(dir, {
      summary: 'Writes British English and expects the copy to match',
      body: 'Corrected "color" twice.',
      kind: 'preference',
      tags: ['style'],
    })
    expect(first.path).toBe('preferences/writes-british-english-and-expects-the.md')
    const second = await memory.createMemory(dir, {
      summary: 'Writes British English and expects the copy to match',
      body: 'Again.',
      kind: 'preference',
    })
    expect(second.path).toBe('preferences/writes-british-english-and-expects-the-2.md')

    const updated = await memory.updateMemory(dir, first.path, { pinned: true })
    expect(updated).toMatchObject({ pinned: true, created: first.created, body: first.body })

    const index = await memory.readIndex(dir)
    expect(index).toContain(first.path)
    expect(index).toContain('*(pinned)*')

    await memory.deleteMemory(dir, second.path)
    expect((await memory.loadMemories(dir, true)).map((m) => m.path)).toEqual([first.path])
  })

  it.each([['../tasks.json'], ['preferences/../../tasks.json'], ['./x.md'], ['a\\..\\b.md']])(
    'refuses a memory path that climbs out: %j',
    async (bad) => {
      const dir = createMemFs()
      await put(dir, '.deckle/tasks.json', '{"version":1,"tasks":[],"projects":[]}')
      await expect(memory.deleteMemory(dir, bad)).rejects.toThrow('Invalid memory path')
      await expect(memory.updateMemory(dir, bad, { body: 'x' })).rejects.toThrow()
      expect(await get(dir, '.deckle/tasks.json')).toContain('"tasks"')
    },
  )

  it('builds a memory block within budget and finds duplicates', async () => {
    const dir = createMemFs()
    await memory.createMemory(dir, { summary: 'Prefers metric units', body: 'Uses km and kg.', pinned: true })
    await memory.createMemory(dir, { summary: 'Works on the Deckle project', body: 'A notes app.', kind: 'project' })

    const block = await buildMemoryContext(dir, 'deckle release', { budget: 1000 })
    expect(block.text).toContain('Prefers metric units')
    expect(block.used.length).toBeGreaterThan(0)
    expect(block.tokens).toBeLessThanOrEqual(1000)
    expect(estimateTokens('abcd')).toBe(1)

    const all = await memory.loadMemories(dir)
    expect(findDuplicate(all, 'Prefers metric units', 'Uses km and kg')?.summary).toBe('Prefers metric units')
    expect(findDuplicate(all, 'Owns a cat', 'Named Biscuit')).toBeNull()
  })
})

describe('assistant tools', () => {
  it('have unique names, and every inline-safe tool is read-only', () => {
    const names = TOOL_DEFS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of ['list_files', 'search_notes', 'read_file']) {
      expect(toolByName(name)?.readOnly).toBe(true)
    }
    for (const name of ['write_file', 'move_file', 'delete_file', 'delete_folder', 'create_folder']) {
      expect(toolByName(name)?.readOnly).toBe(false)
      expect(toolByName(name)?.autoApply).toBeFalsy()
    }
  })

  it('snapshot what write_file overwrites, and not what it creates', async () => {
    const dir = createMemFs()
    await executeTool(dir, call('write_file', { path: 'New.md', content: 'fresh' }))
    expect(await history.listHistory(dir, 'New.md')).toEqual([])

    await executeTool(dir, call('write_file', { path: 'New.md', content: 'rewritten' }))
    const [snapshot] = await history.listHistory(dir, 'New.md')
    expect(snapshot.reason).toBe('ai')
    expect(await history.readSnapshot(dir, snapshot.snapName)).toBe('fresh')
    expect(await get(dir, 'New.md')).toBe('rewritten')
  })

  it.each([
    ['read_file', { path: '../outside.md' }],
    ['read_file', { path: '/etc/passwd' }],
    ['read_file', { path: 'a\\b.md' }],
    ['read_file', { path: '   ' }],
    ['write_file', { path: '.deckle/tasks.json', content: '{}' }],
    ['write_file', { path: 'Projects/./x.md', content: '' }],
    ['create_folder', { path: '.trash/x' }],
    ['move_file', { from: 'a.md', to: '.history/a.md' }],
    ['delete_folder', { path: '..' }],
    ['write_file', { path: 42, content: '' }],
  ])('refuse %s with %j', async (name, args) => {
    const dir = createMemFs()
    await put(dir, 'a.md', 'a')
    await put(dir, '.deckle/tasks.json', 'untouched')
    await expect(executeTool(dir, call(name, args))).rejects.toThrow()
    expect(await get(dir, '.deckle/tasks.json')).toBe('untouched')
  })

  it('still read Deckle’s own hidden files when asked to read', async () => {
    const dir = createMemFs()
    await put(dir, '.trash/old.md', 'recoverable')
    expect(await executeTool(dir, call('read_file', { path: '.trash/old.md' }))).toBe('recoverable')
  })

  it('move, bin and list through the library', async () => {
    const dir = createMemFs()
    await put(dir, 'Inbox/a.md', 'a')
    await history.snapshotNote(dir, 'Inbox/a.md', 'earlier', 'edit')

    await executeTool(dir, call('move_file', { from: 'Inbox/a.md', to: 'Projects/a.md' }))
    expect(await history.listHistory(dir, 'Projects/a.md')).toHaveLength(1)
    expect(await executeTool(dir, call('list_files', {}))).toBe('Inbox/\nProjects/\n  a.md')

    await executeTool(dir, call('delete_file', { path: 'Projects/a.md' }))
    expect((await library.listTrash(dir)).map((i) => i.originalPath)).toEqual(['Projects/a.md'])
    await expect(executeTool(dir, call('nope', {}))).rejects.toThrow('Unknown tool')
  })

  it('remember into memory, updating instead of duplicating', async () => {
    const dir = createMemFs()
    const first = await executeTool(dir, call('remember', { summary: 'Likes tea', body: 'Earl Grey, no milk.' }))
    expect(first).toMatch(/^Remembered: facts\/likes-tea\.md$/)
    const again = await executeTool(dir, call('remember', { summary: 'Likes tea', body: 'Earl Grey, no milk!' }))
    expect(again).toMatch(/updated rather than duplicated/)
    expect(await memory.loadMemories(dir, true)).toHaveLength(1)
  })

  it('preview a write as a before/after pair', async () => {
    const dir = createMemFs()
    await put(dir, 'a.md', 'before')
    expect(await buildPreview(dir, call('write_file', { path: 'a.md', content: 'after' }))).toEqual({
      kind: 'write',
      summary: 'Overwrite a.md',
      path: 'a.md',
      before: 'before',
      after: 'after',
    })
    expect((await buildPreview(dir, call('write_file', { path: 'b.md', content: 'x' }))).summary).toBe('Create b.md')
    expect((await buildPreview(dir, call('delete_folder', { path: 'Old' }))).summary).toContain('recycle bin')
  })
})
