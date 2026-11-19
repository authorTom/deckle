import { describe, expect, it } from 'vitest'
import * as library from '../../src/fs/library'
import {
  actionsFor,
  applyAction,
  attachContext,
  createBrief,
  groupOf,
  listBriefs,
  readRuns,
  runLine,
  type Brief,
  type NewBrief,
} from '../../src/briefs/briefs'
import { todayStr } from '../../src/tasks/dates'
import { createMemFs, get, listAll, put } from '../helpers/memfs'

const read = (dir: FileSystemDirectoryHandle) => (id: string) => library.readNote(dir, id)

async function briefsIn(dir: FileSystemDirectoryHandle): Promise<Brief[]> {
  return await listBriefs(await library.buildTree(dir), 'Projects', read(dir))
}

const base: NewBrief = {
  project: 'Acme',
  title: 'Vendor comparison',
  instructions: 'Compare three vendors.',
  agent: 'hermes',
  priority: 2,
  due: '2030-01-10',
  start: '',
  repeat: '',
  outputs: ['docx', '.PPTX'],
  files: [],
  queue: true,
}

describe('briefs in the app', () => {
  it('creates a brief as plain files the server reads the same way', async () => {
    const dir = createMemFs()
    await put(dir, 'Projects/Acme/Overview.md', '# Acme')
    const id = await createBrief(dir, 'Projects', {
      ...base,
      files: [
        { path: 'pricing.csv', blob: new Blob(['a,b']) },
        { path: 'Research/notes.md', content: '# Notes' },
      ],
    })
    expect(id).toBe(`Projects/Acme/Briefs/${todayStr()} Vendor comparison`)
    expect(await listAll(dir, '')).toEqual(
      [
        'Projects/Acme/Overview.md',
        `${id}/Brief.md`,
        `${id}/Context/Research/notes.md`,
        `${id}/Context/pricing.csv`,
        `${id}/Run.md`,
      ].sort(),
    )
    const text = await get(dir, `${id}/Brief.md`)
    expect(text).toMatch(/^---\ntype: brief\ntitle: Vendor comparison\nstatus: queued\nagent: hermes\npriority: 2\n/)
    expect(text).toContain('outputs: [docx, pptx]')
    expect(text).toContain('created_by: you')
    expect(text).toContain('# Vendor comparison\n\nCompare three vendors.\n')
    expect(await get(dir, `${id}/Run.md`)).toMatch(/· you — Brief created and queued\. 2 files attached\.\n$/)

    const [brief] = await briefsIn(dir)
    expect(brief).toMatchObject({
      id,
      project: 'Acme',
      title: 'Vendor comparison',
      status: 'queued',
      agent: 'hermes',
      priority: 2,
      due: '2030-01-10',
      outputs: ['docx', 'pptx'],
      run: `${id}/Run.md`,
    })
    expect(brief.context.map((f) => f.name).sort()).toEqual(['notes.md', 'pricing.csv'])
    expect(groupOf(brief)).toBe('queued')
  })

  it('reads a brief the server wrote, and tolerates one with no front matter', async () => {
    const dir = createMemFs()
    await put(
      dir,
      'Projects/X/Briefs/2026-11-19 Weekly scan/Brief.md',
      '---\ntype: brief\ntitle: Weekly scan\nstatus: review\npriority: 3\nrepeat: weekly\nstart: 2026-11-26\nlast_run: 2026-11-19\ncreated: 2026-11-12\ncreated_by: "hermes"\n---\n\n# Weekly scan\n',
    )
    await put(dir, 'Projects/X/Briefs/2026-11-19 Weekly scan/Output/2026-11-19/scan.md', '# Scan')
    await put(dir, 'Projects/X/Briefs/Loose/Brief.md', 'Just text.')
    await put(dir, 'Projects/X/Briefs/Not a brief/readme.md', 'no Brief.md here')
    const briefs = await briefsIn(dir)
    expect(briefs.map((b) => b.title).sort()).toEqual(['Loose', 'Weekly scan'])
    const scan = briefs.find((b) => b.title === 'Weekly scan')!
    expect(scan).toMatchObject({ status: 'review', repeat: 'weekly', start: '2026-11-26', lastRun: '2026-11-19', createdBy: 'hermes' })
    expect(scan.output.map((f) => f.id)).toEqual(['Projects/X/Briefs/2026-11-19 Weekly scan/Output/2026-11-19/scan.md'])
    expect(groupOf(scan)).toBe('needs-you')
    const loose = briefs.find((b) => b.title === 'Loose')!
    expect(loose).toMatchObject({ status: 'draft', priority: 3, agent: null })
  })

  it('writes run log lines in the same shape as the server', () => {
    const line = runLine('First line\nsecond', 'you', new Date(2026, 10, 19, 9, 5))
    expect(line).toBe('- **2026-11-19 09:05** · you — First line\n  second\n')
  })

  it('applies the decisions a person makes, keeping history and the run log', async () => {
    const dir = createMemFs()
    await put(dir, 'Projects/Acme/Overview.md', '# Acme')
    const id = await createBrief(dir, 'Projects', { ...base, queue: false })
    let [brief] = await briefsIn(dir)
    expect(brief.status).toBe('draft')
    expect(actionsFor(brief)).toEqual(['queue', 'cancel'])

    expect(await applyAction(dir, brief, { kind: 'queue' })).toBe('queued')
    ;[brief] = await briefsIn(dir)
    expect(brief.status).toBe('queued')

    // The agent's part, as the server would write it.
    const text = (await get(dir, `${id}/Brief.md`))!
    await put(dir, `${id}/Brief.md`, text.replace('status: queued', 'status: review'))
    ;[brief] = await briefsIn(dir)
    expect(actionsFor(brief)).toEqual(['approve', 'request-changes'])

    await expect(applyAction(dir, brief, { kind: 'request-changes', comment: '  ' })).rejects.toThrow()
    expect(await applyAction(dir, brief, { kind: 'request-changes', comment: 'Add a cost table.' })).toBe(
      'changes-requested',
    )
    const runLog = (await get(dir, `${id}/Run.md`))!
    expect(runLog).toContain('· you — **Changes requested:** Add a cost table.')
    expect(runLog.startsWith('# Run log — Vendor comparison')).toBe(true)

    const history = await listAll(dir, '')
    expect(history.some((p) => p.startsWith('.history/'))).toBe(true)

    await put(dir, `${id}/Brief.md`, (await get(dir, `${id}/Brief.md`))!.replace('status: changes-requested', 'status: blocked'))
    ;[brief] = await briefsIn(dir)
    expect(await applyAction(dir, brief, { kind: 'answer', answer: 'GBP.' })).toBe('queued')
    expect(await get(dir, `${id}/Run.md`)).toContain('**Answer:** GBP.')

    await put(dir, `${id}/Brief.md`, (await get(dir, `${id}/Brief.md`))!.replace('status: queued', 'status: review'))
    ;[brief] = await briefsIn(dir)
    expect(await applyAction(dir, brief, { kind: 'approve' })).toBe('done')
    ;[brief] = await briefsIn(dir)
    expect(groupOf(brief)).toBe('finished')
    expect(actionsFor(brief)).toEqual(['rerun'])
    expect(await applyAction(dir, brief, { kind: 'rerun', note: 'Use 2027 prices.' })).toBe('queued')
    expect(await get(dir, `${id}/Run.md`)).toContain('**Run again:** Use 2027 prices.')
  })

  it('keeps a work stream going when one run is approved', async () => {
    const dir = createMemFs()
    await put(dir, 'Projects/Acme/Overview.md', '# Acme')
    const id = await createBrief(dir, 'Projects', { ...base, repeat: 'weekly' })
    const text = (await get(dir, `${id}/Brief.md`))!
    await put(dir, `${id}/Brief.md`, text.replace('status: queued', 'status: review'))
    const [brief] = await briefsIn(dir)
    expect(await applyAction(dir, brief, { kind: 'approve' })).toBe('queued')
    const [after] = await briefsIn(dir)
    expect(after.status).toBe('queued')
    expect(after.start! > todayStr()).toBe(true)
    expect(await get(dir, `${id}/Run.md`)).toContain('**Approved.** Next run as scheduled.')
  })

  it('attaches more context later', async () => {
    const dir = createMemFs()
    await put(dir, 'Projects/Acme/Overview.md', '# Acme')
    await createBrief(dir, 'Projects', base)
    const [brief] = await briefsIn(dir)
    await attachContext(dir, brief, [{ path: 'extra.xlsx', blob: new Blob(['x']) }])
    const [after] = await briefsIn(dir)
    expect(after.context.map((f) => f.name)).toEqual(['extra.xlsx'])
    expect(await get(dir, `${brief.id}/Run.md`)).toContain('Attached 1 file to the context.')
  })

  it('reads runs.json, and treats a missing or broken one as empty', async () => {
    const dir = createMemFs()
    expect(await readRuns(dir)).toEqual({ claims: {}, agents: {}, leaseMs: 30 * 60_000 })
    await put(dir, '.deckle/runs.json', '{"version":1,"claims":{"P/x":{"agent":"hermes","claimedAt":1,"heartbeatAt":2}},"agents":{"hermes":{"lastSeen":3}},"leaseMs":60000}')
    expect(await readRuns(dir)).toMatchObject({ claims: { 'P/x': { agent: 'hermes' } }, agents: { hermes: { lastSeen: 3 } }, leaseMs: 60_000 })
    await put(dir, '.deckle/runs.json', '{ torn')
    expect(await readRuns(dir)).toEqual({ claims: {}, agents: {}, leaseMs: 30 * 60_000 })
  })
})
