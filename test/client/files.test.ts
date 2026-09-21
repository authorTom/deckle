// Previewing the files an agent stores: office documents read in the browser,
// CSV parsing, file-type families, front matter, and image paths in notes.
//
// Runs in Node, borrowing only jsdom's DOMParser. Under the jsdom environment
// typed arrays come from another realm than Node's DecompressionStream, and
// the unzip underneath the previews fails in a way no browser ever would.

import { JSDOM } from 'jsdom'
import { beforeAll, describe, expect, it } from 'vitest'
import { parseDelimited, readDocx, readPptx, readXlsx } from '../../src/lib/officePreview'
import { describeType, familyOf, iconFor, previewMime } from '../../src/lib/fileTypes'
import {
  joinFrontmatter,
  parseFrontmatter,
  setFrontmatterFields,
  splitFrontmatter,
} from '../../src/lib/frontmatter'
import { libraryPathFor } from '../../src/editor/image'
// @ts-expect-error — a plain .mjs helper with no type declarations
import { docx, pptx, xlsx } from '../helpers/office.mjs'

beforeAll(() => {
  globalThis.DOMParser = new JSDOM().window.DOMParser as unknown as typeof DOMParser
})

const buffer = async (made: Promise<Uint8Array>) => {
  const bytes = await made
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('office previews', () => {
  it('reads a Word document into headings, paragraphs, bullets and tables', async () => {
    const blocks = await readDocx(await buffer(docx()))
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Market sizing' },
      { type: 'paragraph', text: 'Total addressable market is £4.2bn & growing.' },
      { type: 'bullet', text: 'First bullet' },
      { type: 'table', rows: [['Region', 'Share'], ['EMEA', '41%']] },
    ])
  })

  it('reads every sheet of a workbook, placing cells by their references', async () => {
    const sheets = await readXlsx(await buffer(xlsx()))
    expect(sheets.map((s) => s.name)).toEqual(['Revenue', 'Notes & caveats'])
    expect(sheets[0].rows).toEqual([
      ['Quarter', 'Revenue'],
      ['Q3 2026', '', '1250000', 'TRUE'],
    ])
    expect(sheets[1].rows).toEqual([['Unaudited figures']])
  })

  it('reads slides in order', async () => {
    const slides = await readPptx(await buffer(pptx()))
    expect(slides).toEqual([
      { number: 1, paragraphs: ['Quarterly review', 'Churn fell to 2%'] },
      { number: 2, paragraphs: ['Next steps'] },
    ])
  })

  it('refuses something that is not the document it claims to be', async () => {
    await expect(readDocx(await buffer(xlsx()))).rejects.toThrow('not a Word document')
  })
})

describe('CSV', () => {
  it('handles quotes, embedded delimiters, doubled quotes and line breaks', () => {
    const { rows } = parseDelimited('\uFEFFname,note\r\n"Smith, J","said ""hi""\nthen left"\nlast,')
    expect(rows).toEqual([
      ['name', 'note'],
      ['Smith, J', 'said "hi"\nthen left'],
      ['last', ''],
    ])
    expect(parseDelimited('a\tb', '\t').rows).toEqual([['a', 'b']])
  })

  it('stops at the row cap and says so', () => {
    const text = Array.from({ length: 10 }, (_, i) => `row${i}`).join('\n')
    const { rows, truncated } = parseDelimited(text, ',', 3)
    expect(rows).toHaveLength(3)
    expect(truncated).toBe(true)
  })
})

describe('file types', () => {
  it('sorts files into families, and only previews types a browser renders safely', () => {
    expect(familyOf('Q3 Model.XLSX')).toBe('sheet')
    expect(familyOf('Dockerfile')).toBe('code')
    expect(familyOf('mystery.bin')).toBe('other')
    expect(describeType('scan.pdf')).toBe('PDF document')
    expect(previewMime('chart.svg')).toBe('image/svg+xml')
    // A stored web page is shown as source, never rendered from a blob URL.
    expect(previewMime('page.html')).toBeNull()
    expect(iconFor({ kind: 'file', name: 'x.md' })).toBe(iconFor({ kind: 'asset', name: 'notes.txt' }))
  })
})

describe('front matter in the app', () => {
  const doc = '---\nstatus: active\ntags:\n  - a\n  - b\n---\n# Title\n\nBody'

  it('matches the server’s reading of it', () => {
    expect(parseFrontmatter(doc)).toEqual({ status: 'active', tags: ['a', 'b'] })
    expect(splitFrontmatter(doc).body).toBe('# Title\n\nBody')
  })

  it('leaves a note that opens with a horizontal rule alone', () => {
    const ruled = '---\n\nSome words.\n\n---\n\nMore.'
    expect(splitFrontmatter(ruled)).toEqual({ frontmatter: '', body: ruled })
  })

  it('puts the block back above the text with one blank line', () => {
    const { frontmatter, body } = splitFrontmatter(doc)
    expect(joinFrontmatter(frontmatter, body)).toBe('---\nstatus: active\ntags:\n  - a\n  - b\n---\n\n# Title\n\nBody')
    expect(joinFrontmatter('', 'plain')).toBe('plain')
    expect(parseFrontmatter(setFrontmatterFields(doc, { status: 'done' })).status).toBe('done')
  })
})

describe('images in notes', () => {
  it('resolves a note’s image paths inside the library, and nowhere else', () => {
    expect(libraryPathFor('chart.png', 'Projects/Acme/Report.md')).toBe('Projects/Acme/chart.png')
    expect(libraryPathFor('./img/a%20b.png', 'Projects/Acme/Report.md')).toBe('Projects/Acme/img/a b.png')
    expect(libraryPathFor('../shared/logo.svg', 'Projects/Acme/Report.md')).toBe('Projects/shared/logo.svg')
    expect(libraryPathFor('/Assets/logo.svg', 'Projects/Acme/Report.md')).toBe('Assets/logo.svg')
    expect(libraryPathFor('../../../etc/passwd', 'Projects/Report.md')).toBeNull()
    expect(libraryPathFor('https://example.com/a.png', 'Report.md')).toBeNull()
    expect(libraryPathFor('javascript:alert(1)', 'Report.md')).toBeNull()
  })
})
