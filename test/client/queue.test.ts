import { describe, expect, it, vi } from 'vitest'
import { clampConcurrency, isInsideInbox } from '../../src/queue/settings'
import { needsApproval } from '../../src/queue/runner'
import { nextToStart } from '../../src/queue/useQueue'
import { deleteRun, loadIndex, newRunId, readRun, saveRun } from '../../src/queue/store'
import type { Run, RunStatus, RunSummary } from '../../src/queue/types'
import type { ToolCall } from '../../src/ai/types'
import { createMemFs, sleep } from '../helpers/memfs'

const INBOX = 'Assistant inbox'
const call = (name: string, args: Record<string, unknown>): ToolCall => ({ id: 'c', name, arguments: args })

describe('isInsideInbox', () => {
  it.each([
    ['Assistant inbox', true],
    ['Assistant inbox/draft.md', true],
    ['Assistant inbox/Sub/draft.md', true],
    ['Assistant inboxes/draft.md', false],
    ['Projects/plan.md', false],
    ['Assistant inbox/../Projects/plan.md', false],
    ['Assistant inbox/./draft.md', false],
    ['Assistant inbox//draft.md', false],
    ['/Assistant inbox/draft.md', false],
    ['Assistant inbox\\..\\Projects\\plan.md', false],
  ])('%j → %s', (path, inside) => {
    expect(isInsideInbox(path, INBOX)).toBe(inside)
  })

  it('never treats an empty inbox as a place', () => {
    expect(isInsideInbox('anything.md', ' / ')).toBe(false)
    expect(isInsideInbox('Inbox/a.md', '/Inbox/')).toBe(true)
  })

  it('clamps concurrency', () => {
    expect(clampConcurrency(0)).toBe(1)
    expect(clampConcurrency(99)).toBe(4)
    expect(clampConcurrency('2')).toBe(2)
    expect(clampConcurrency('x')).toBe(1)
  })
})

describe('needsApproval', () => {
  it('lets reads and memory through', () => {
    expect(needsApproval(call('read_file', { path: 'Projects/secret.md' }), INBOX)).toBe(false)
    expect(needsApproval(call('search_notes', { query: 'x' }), INBOX)).toBe(false)
    expect(needsApproval(call('remember', { summary: 's', body: 'b' }), INBOX)).toBe(false)
  })

  it('lets writes inside the inbox through, and stops everything else', () => {
    expect(needsApproval(call('write_file', { path: `${INBOX}/draft.md`, content: '' }), INBOX)).toBe(false)
    expect(needsApproval(call('create_folder', { path: `${INBOX}/Sub` }), INBOX)).toBe(false)
    expect(needsApproval(call('write_file', { path: 'Projects/plan.md', content: '' }), INBOX)).toBe(true)
    expect(
      needsApproval(call('write_file', { path: `${INBOX}/../Projects/plan.md`, content: '' }), INBOX),
    ).toBe(true)
    expect(needsApproval(call('write_file', { content: 'no path' }), INBOX)).toBe(true)
    expect(
      needsApproval(call('move_file', { from: 'Projects/plan.md', to: `${INBOX}/plan.md` }), INBOX),
    ).toBe(true)
  })

  it('always stops deletions, and anything it does not recognise', () => {
    expect(needsApproval(call('delete_file', { path: `${INBOX}/draft.md` }), INBOX)).toBe(true)
    expect(needsApproval(call('delete_folder', { path: INBOX }), INBOX)).toBe(true)
    expect(needsApproval(call('format_disk', {}), INBOX)).toBe(true)
  })
})

describe('nextToStart', () => {
  const row = (id: string, status: RunStatus, createdAt: number) =>
    ({ id, status, createdAt, title: id, prompt: id, writes: [], attempt: 1 }) as RunSummary

  it('starts the oldest queued runs that fit', () => {
    const runs = [row('new', 'queued', 3), row('old', 'queued', 1), row('busy', 'running', 0), row('mid', 'queued', 2)]
    expect(nextToStart(runs, new Set(), 2).map((r) => r.id)).toEqual(['old', 'mid'])
    expect(nextToStart(runs, new Set(['busy']), 2).map((r) => r.id)).toEqual(['old'])
    expect(nextToStart(runs, new Set(['old', 'busy']), 2)).toEqual([])
  })
})

describe('run store', () => {
  function makeRun(status: RunStatus = 'queued', createdAt = Date.now()): Run {
    return {
      id: newRunId(),
      title: 'Run',
      prompt: 'Do the thing',
      status,
      createdAt,
      messages: [{ id: 'u', role: 'user', content: 'Do the thing' }],
      writes: [],
      attempt: 1,
    }
  }

  it('saves records and keeps the index in step', async () => {
    const dir = createMemFs()
    const run = makeRun()
    await saveRun(dir, run)
    expect((await readRun(dir, run.id))?.messages).toHaveLength(1)
    const index = await loadIndex(dir)
    expect(index.runs).toHaveLength(1)
    expect(index.runs[0]).not.toHaveProperty('messages')

    await deleteRun(dir, run.id)
    expect((await loadIndex(dir)).runs).toEqual([])
    expect(await readRun(dir, run.id)).toBeNull()
  })

  it('loses no rows and reverts no statuses when runs save concurrently', async () => {
    // Every read and write yields for a random moment, so unguarded
    // read-modify-writes of the index would interleave.
    const jitter = () => sleep(Math.random() * 4)
    const dir = createMemFs({ beforeRead: jitter, beforeWrite: jitter })
    const runs = Array.from({ length: 12 }, () => makeRun())

    await Promise.all(runs.map((run) => saveRun(dir, run)))
    await Promise.all(
      runs.map(async (run) => {
        for (const status of ['running', 'needs-approval', 'succeeded'] as RunStatus[]) {
          run.status = status
          await saveRun(dir, run)
        }
      }),
    )

    const index = await loadIndex(dir)
    expect(index.runs).toHaveLength(12)
    expect(index.runs.every((r) => r.status === 'succeeded')).toBe(true)
  })

  it('rebuilds a lost index from the run records', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const dir = createMemFs()
    const older = makeRun('succeeded', 1)
    const newer = makeRun('queued', 2)
    await saveRun(dir, older)
    await saveRun(dir, newer)
    const runsDir = await (await dir.getDirectoryHandle('.deckle')).getDirectoryHandle('runs')
    await runsDir.removeEntry('index.json')

    expect((await loadIndex(dir)).runs.map((r) => r.id)).toEqual([newer.id, older.id])
  })

  it('prunes the oldest finished runs, never outstanding ones', async () => {
    const dir = createMemFs()
    const waiting = makeRun('needs-input', 0)
    await saveRun(dir, waiting)
    for (let i = 1; i <= 201; i++) await saveRun(dir, makeRun('succeeded', i))

    const index = await loadIndex(dir)
    expect(index.runs.length).toBeLessThanOrEqual(201)
    expect(index.runs.some((r) => r.id === waiting.id)).toBe(true)
    expect(index.runs.some((r) => r.createdAt === 1)).toBe(false)
  })
})
