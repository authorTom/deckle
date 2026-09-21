// The pieces that make a library a knowledge base for agents: files beside
// notes, front matter, text extraction, the activity log and projects.

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLibraryApi } from '../../server/library-api.mjs'
import { createLibraryStore } from '../../server/library-store.mjs'
import { createActivityLog } from '../../server/activity.mjs'
import { createProjects } from '../../server/projects.mjs'
import { parseFrontmatter, setFrontmatterFields, splitFrontmatter } from '../../server/frontmatter.mjs'
import { extractText, isExtractable } from '../../server/extract.mjs'
import { readZipEntries, ZipError } from '../../server/unzip.mjs'
import { createSearch } from '../../server/search.mjs'
import { makeTempDir } from '../helpers/server.mjs'
import { docx, odt, pptx, xlsx, zipOf } from '../helpers/office.mjs'

let root
let lib
let store

beforeEach(async () => {
  root = await makeTempDir()
  lib = createLibraryApi(root)
  await lib.init()
  store = createLibraryStore(lib)
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const bytes = (n, seed = 7) => Buffer.from(Array.from({ length: n }, (_, i) => (i * seed + 13) % 256))

describe('front matter', () => {
  const doc = [
    '---',
    'type: project',
    'status: active',
    'summary: "Market research: EMEA"',
    'tags: [research, "q3"]',
    'owners:',
    '  - hermes',
    '  - tom',
    'nested:',
    '  deep: value',
    '# a comment',
    '---',
    '# Heading',
    '',
    'Body.',
  ].join('\n')

  it('reads flat keys, bracketed and block lists', () => {
    expect(parseFrontmatter(doc)).toMatchObject({
      type: 'project',
      status: 'active',
      summary: 'Market research: EMEA',
      tags: ['research', 'q3'],
      owners: ['hermes', 'tom'],
    })
    expect(parseFrontmatter('# No front matter')).toEqual({})
  })

  it('splits the block from the body verbatim', () => {
    const { frontmatter, body } = splitFrontmatter(doc)
    expect(frontmatter.startsWith('---\ntype: project')).toBe(true)
    expect(frontmatter.endsWith('---\n')).toBe(true)
    expect(body).toBe('# Heading\n\nBody.')
    expect(splitFrontmatter('# Plain')).toEqual({ frontmatter: '', body: '# Plain' })
  })

  it('edits keys in place, leaving what it does not understand alone', () => {
    const next = setFrontmatterFields(doc, { status: 'done', owners: ['hermes'], added: 'yes: really' })
    expect(parseFrontmatter(next)).toMatchObject({ status: 'done', owners: ['hermes'], added: 'yes: really' })
    expect(next).toContain('nested:\n  deep: value')
    expect(next).toContain('# a comment')
    expect(next.endsWith('# Heading\n\nBody.')).toBe(true)
    // Removing a key.
    expect(parseFrontmatter(setFrontmatterFields(doc, { tags: undefined }))).not.toHaveProperty('tags')
  })

  it('does not mistake a note that opens with a horizontal rule for front matter', () => {
    const ruled = '---\n\nSome words.\n\n---\n\nMore.'
    expect(splitFrontmatter(ruled)).toEqual({ frontmatter: '', body: ruled })
    expect(parseFrontmatter('---\n\n---\nText')).toEqual({})
    expect(setFrontmatterFields(ruled, { status: 'done' })).toBe(`---\nstatus: done\n---\n\n${ruled}`)
  })

  it('adds a block to a document that had none', () => {
    const next = setFrontmatterFields('# Title\n\nText', { status: 'paused' })
    expect(next).toBe('---\nstatus: paused\n---\n\n# Title\n\nText')
  })

  it('quotes values that would read back as something else', () => {
    const next = setFrontmatterFields('', { a: 'true', b: '42', c: '#tag', d: 'x, y', e: 'plain words' })
    expect(parseFrontmatter(next)).toMatchObject({ a: 'true', b: '42', c: '#tag', d: 'x, y', e: 'plain words' })
  })
})

describe('text extraction', () => {
  it('reads Word, keeping headings, bullets and tables', async () => {
    const text = extractText(await docx(), 'Brief.docx')
    expect(text).toContain('# Market sizing')
    expect(text).toContain('Total addressable market is £4.2bn & growing.')
    expect(text).toContain('- First bullet')
    expect(text).toContain('Region | Share\nEMEA | 41%')
  })

  it('reads Excel as one table per sheet', async () => {
    const text = extractText(await xlsx(), 'Model.xlsx')
    expect(text).toContain('## Revenue')
    expect(text).toContain('Quarter | Revenue')
    // Shared rich text, an empty self-closing cell, a formula's cached value, a boolean.
    expect(text).toContain('Q3 2026 |  | 1250000 | TRUE')
    expect(text).toContain('## Notes & caveats\n\nUnaudited figures')
  })

  it('reads PowerPoint slides in order, and OpenDocument text', async () => {
    const slides = extractText(await pptx(), 'Deck.pptx')
    expect(slides.indexOf('## Slide 1')).toBeLessThan(slides.indexOf('## Slide 2'))
    expect(slides).toContain('Quarterly review\nChurn fell to 2%')
    expect(extractText(await odt(), 'Minutes.odt')).toContain('Minutes\nAgreed  budget')
  })

  it('reads text formats, and refuses binaries dressed as text', () => {
    expect(extractText(Buffer.from('\uFEFFa,b\n1,2'), 'data.csv')).toBe('a,b\n1,2')
    expect(extractText(Buffer.from([0x41, 0, 0x42]), 'fake.txt')).toBeNull()
    expect(extractText(bytes(100), 'photo.png')).toBeNull()
    expect(isExtractable('Report.PDF')).toBe(false)
    expect(isExtractable('model.XLSX')).toBe(true)
  })

  it('treats a damaged document as having no text', () => {
    expect(extractText(Buffer.from('not a zip at all'), 'broken.docx')).toBeNull()
  })

  it('refuses an archive member that inflates past its limit', async () => {
    const bomb = await zipOf({ 'word/document.xml': 'x'.repeat(200_000) })
    expect(() =>
      readZipEntries(bomb, { want: () => true, maxEntryBytes: 1000 }),
    ).toThrow(ZipError)
    // A size field that lies is caught by inflate itself.
    const honest = readZipEntries(bomb, { want: () => true })
    expect(honest.get('word/document.xml').length).toBe(200_000)
    expect(zlib.inflateRawSync).toBeTypeOf('function')
  })
})

describe('files beside notes', () => {
  it('replaces a file only once the new one has fully arrived, binning the old copy', async () => {
    const first = bytes(5000, 3)
    const second = bytes(7000, 5)
    expect((await store.putFile('Out/model.bin', Readable.from([first]))).created).toBe(true)
    const { file, created } = await store.putFile('Out/model.bin', Readable.from([second]), {
      replacedBy: 'hermes',
    })
    expect(created).toBe(false)
    expect(file).toMatchObject({ path: 'Out/model.bin', kind: 'file', ext: 'bin', size: 7000 })
    expect(Buffer.compare(await lib.readBuffer('Out/model.bin'), second)).toBe(0)

    const [binned] = await store.listTrash()
    expect(binned).toMatchObject({ originalPath: 'Out/model.bin', title: 'model.bin', kind: 'file', reason: 'replaced', by: 'hermes' })
    expect(Buffer.compare(await lib.readBuffer(`.trash/${binned.trashName}`), first)).toBe(0)
  })

  it('leaves the old file in place when an upload fails part way', async () => {
    await store.putFile('keep.bin', Readable.from([Buffer.from('original')]))
    const failing = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('connection dropped'))
      },
    })
    await expect(store.putFile('keep.bin', failing)).rejects.toThrow('connection dropped')
    expect(await lib.readText('keep.bin')).toBe('original')
    expect(await store.listTrash()).toEqual([])
  })

  it('bins and restores binary files byte for byte, under a free name', async () => {
    const data = bytes(3000)
    await fs.mkdir(path.join(root, 'Docs'), { recursive: true })
    await fs.writeFile(path.join(root, 'Docs/scan.pdf'), data)
    const entry = await store.trashEntry('Docs/scan.pdf')
    await fs.writeFile(path.join(root, 'Docs/scan.pdf'), 'a newer scan')

    const restored = await store.restoreTrash(entry.trashName)
    expect(restored).toMatchObject({ path: 'Docs/scan 1.pdf', kind: 'file' })
    expect(Buffer.compare(await lib.readBuffer('Docs/scan 1.pdf'), data)).toBe(0)
  })

  it('moves files, carrying a note its history and refusing to overwrite', async () => {
    await store.writeNote('a.md', 'one', 'agent')
    await store.writeNote('a.md', 'two', 'agent')
    await store.moveFile('a.md', 'Archive/a.md')
    expect((await store.listHistory('Archive/a.md')).length).toBe(1)
    await fs.writeFile(path.join(root, 'chart.png'), bytes(10))
    await fs.writeFile(path.join(root, 'other.png'), bytes(10))
    await expect(store.moveFile('chart.png', 'other.png')).rejects.toMatchObject({ status: 409 })
    expect((await store.moveFile('chart.png', 'Images/chart.png')).path).toBe('Images/chart.png')
  })

  it('bins everything in a deleted folder, not just its notes', async () => {
    await store.writeNote('Proj/notes.md', 'n', 'agent')
    await fs.mkdir(path.join(root, 'Proj/data'), { recursive: true })
    await fs.writeFile(path.join(root, 'Proj/data/table.xlsx'), bytes(64))
    expect(await store.trashFolder('Proj')).toBe(2)
    expect(await lib.exists('Proj')).toBeNull()
    expect((await store.listTrash()).map((i) => i.originalPath).sort()).toEqual([
      'Proj/data/table.xlsx',
      'Proj/notes.md',
    ])
  })
})

describe('the activity log', () => {
  it('records events with their project, newest first, and filters them', async () => {
    let t = 1000
    const log = createActivityLog(lib, { now: () => t++ })
    await log.record({ actor: 'hermes', action: 'saved', kind: 'file', path: 'Projects/Acme/a.pdf', message: '  first\n line ' })
    await log.record({ actor: 'hermes', action: 'created', kind: 'note', path: 'Inbox/b.md' })
    await log.record({ actor: 'script', action: 'moved', kind: 'note', path: 'Inbox/b.md', to: 'Projects/Beta/b.md' })

    const all = await log.list()
    expect(all.map((e) => e.action)).toEqual(['moved', 'created', 'saved'])
    expect(all[2]).toMatchObject({ project: 'Acme', message: 'first line', at: 1000 })
    expect(all[0].project).toBe('Beta')
    expect(all[1]).not.toHaveProperty('project')

    expect((await log.list({ project: 'Acme' })).length).toBe(1)
    expect((await log.list({ actor: 'script' })).length).toBe(1)
    expect((await log.list({ since: 1000 })).length).toBe(2)
    expect((await log.list({ path: 'Inbox/b.md' })).length).toBe(2)
    expect(log.projectOf('Projects/Acme')).toBeUndefined()
  })

  it('rolls the file over when it grows, and still reads both halves', async () => {
    const log = createActivityLog(lib, { maxBytes: 400 })
    for (let i = 0; i < 12; i++) await log.record({ actor: 'a', action: 'created', path: `n${i}.md` })
    expect(await lib.exists('.deckle/activity.1.jsonl')).toBe('file')
    const events = await log.list({ limit: 100 })
    expect(events.length).toBeGreaterThan(4)
    expect(events[0].path).toBe('n11.md')
  })

  it('skips a torn last line rather than failing', async () => {
    await lib.writeText('.deckle/activity.jsonl', '{"at":1,"actor":"a","action":"x"}\n{"at":2,"act')
    expect((await createActivityLog(lib).list()).length).toBe(1)
  })
})

describe('projects', () => {
  const fixed = new Date(2026, 8, 21, 14, 3)
  let projects
  beforeEach(() => {
    projects = createProjects({ library: lib, store, now: () => fixed })
  })

  it('creates a project folder with an overview, and refuses a duplicate', async () => {
    const project = await projects.create({
      name: 'Acme research',
      summary: 'Size the EMEA market.',
      tags: ['research', '#emea'],
      createdBy: 'hermes',
    })
    expect(project).toMatchObject({
      name: 'Acme research',
      path: 'Projects/Acme research',
      status: 'active',
      summary: 'Size the EMEA market.',
      tags: ['research', 'emea'],
      created: '2026-09-21',
      overview: 'Projects/Acme research/Overview.md',
      notes: 1,
      files: 0,
    })
    const overview = await lib.readText('Projects/Acme research/Overview.md')
    expect(parseFrontmatter(overview)).toMatchObject({ type: 'project', created_by: 'hermes' })
    expect(overview).toContain('# Acme research')
    await expect(projects.create({ name: 'Acme research', summary: 'again' })).rejects.toMatchObject({ status: 409 })
  })

  it('lists any folder in Projects as a project, reading README when there is no overview', async () => {
    await projects.create({ name: 'Alpha', summary: 'first' })
    await lib.writeText('Projects/scraper/README.md', '---\nstatus: paused\ndescription: A web scraper\n---\n# scraper')
    await fs.writeFile(path.join(root, 'Projects/scraper/out.csv'), 'a,b')
    await lib.mkdir('Projects/Empty')
    const list = await projects.list()
    expect(list.map((p) => p.name).sort()).toEqual(['Alpha', 'Empty', 'scraper'])
    expect(list.find((p) => p.name === 'scraper')).toMatchObject({
      status: 'paused',
      summary: 'A web scraper',
      notes: 1,
      files: 1,
      overview: 'Projects/scraper/README.md',
    })
    expect(list.find((p) => p.name === 'Empty')).toMatchObject({ status: null, overview: null })
    expect((await projects.list({ status: 'paused' })).map((p) => p.name)).toEqual(['scraper'])
  })

  it('updates status in the overview, keeping the old version in history', async () => {
    await projects.create({ name: 'Beta', summary: 'second' })
    const updated = await projects.update('Beta', { status: 'done', tags: ['shipped'] })
    expect(updated).toMatchObject({ status: 'done', tags: ['shipped'], summary: 'second' })
    expect((await store.listHistory('Projects/Beta/Overview.md')).length).toBe(1)
    await expect(projects.update('Beta', { status: 'finished' })).rejects.toMatchObject({ status: 400 })
    await expect(projects.update('Nope', { status: 'done' })).rejects.toMatchObject({ status: 404 })
  })

  it('never writes into a pushed project’s README, giving it an Overview.md instead', async () => {
    const readme = '---\ndescription: A web scraper\ntags: [python]\n---\n# scraper\n\nRun `make`.'
    await lib.writeText('Projects/scraper/README.md', readme)
    const updated = await projects.update('scraper', { status: 'done' })
    expect(await lib.readText('Projects/scraper/README.md')).toBe(readme)
    expect(updated).toMatchObject({ status: 'done', summary: 'A web scraper', tags: ['python'], overview: 'Projects/scraper/Overview.md' })
  })

  it('keeps a dated, append-only log', async () => {
    await projects.create({ name: 'Gamma', summary: 'third' })
    await projects.log('Gamma', 'Collected three sources.', 'hermes')
    await projects.log('Gamma', 'Drafted [[Report.pdf]]\nNext: review.', 'hermes')
    const log = await lib.readText('Projects/Gamma/Log.md')
    expect(log).toBe(
      '# Log — Gamma\n\n' +
        '- **2026-09-21 14:03** · hermes — Collected three sources.\n' +
        '- **2026-09-21 14:03** · hermes — Drafted [[Report.pdf]]\n  Next: review.\n',
    )
    expect((await projects.get('Gamma')).log).toBe('Projects/Gamma/Log.md')
  })
})

describe('search across notes and files', () => {
  it('finds documents by their contents and anything by its name', async () => {
    await lib.writeText('Projects/Acme/Summary.md', 'Our view of the EMEA opportunity.')
    await fs.writeFile(path.join(root, 'Projects/Acme/Brief.docx'), await docx())
    await fs.writeFile(path.join(root, 'Projects/Acme/Model.xlsx'), await xlsx())
    await fs.writeFile(path.join(root, 'Projects/Acme/competitor-landscape.pdf'), bytes(2000))
    const search = createSearch(lib)

    const [hit] = await search.search('addressable market')
    expect(hit).toMatchObject({ path: 'Projects/Acme/Brief.docx', kind: 'file', title: 'Brief.docx' })
    expect(hit.snippet).toContain('addressable market')

    expect((await search.search('unaudited'))[0].path).toBe('Projects/Acme/Model.xlsx')
    expect((await search.search('competitor landscape'))[0]).toMatchObject({
      path: 'Projects/Acme/competitor-landscape.pdf',
      snippet: '',
    })
    expect((await search.search('emea', { kind: 'note' })).every((r) => r.kind === 'note')).toBe(true)
    expect(await search.textOf('Projects/Acme/Brief.docx')).toContain('Market sizing')
    expect(await search.textOf('Projects/Acme/competitor-landscape.pdf')).toBeNull()
  })
})
