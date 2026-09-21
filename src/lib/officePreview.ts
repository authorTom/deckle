// Reading Word, Excel and PowerPoint files well enough to show them.
//
// An agent's output is often an office document, and the point of a knowledge
// base is that you can look at what it made without leaving it. These files
// are ZIPs of XML, so the browser can open them with the unzip Deckle already
// has and read the XML with its own parser — no dependency, and it works the
// same on every storage backend because nothing leaves the page.
//
// This is a preview, not a renderer: text, headings, lists and tables for a
// document; values for a spreadsheet (formulas show their last computed
// result); the words on each slide. Layout, images and styling are left to the
// application that made the file, which the viewer's Download button is for.
// server/extract.mjs reads the same formats for search; the two answer
// different questions and are allowed to differ in detail.

import { unzip } from './unzip'

export type DocBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'bullet'; text: string }
  | { type: 'table'; rows: string[][] }

export interface Sheet {
  name: string
  rows: string[][]
  /** Rows left out of the preview beyond the cap. */
  truncated: number
}

export interface Slide {
  number: number
  paragraphs: string[]
}

/** Enough to see what a sheet holds without building a DOM the size of it. */
export const MAX_PREVIEW_ROWS = 500
export const MAX_PREVIEW_COLUMNS = 60

async function entries(data: ArrayBuffer, want: (path: string) => boolean): Promise<Map<string, string>> {
  const result = await unzip(data, {
    filter: (path) => want(path),
    maxFileBytes: 32 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
  })
  const decoder = new TextDecoder('utf-8')
  return new Map(result.files.map((f) => [f.path, decoder.decode(f.bytes)]))
}

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('This file is damaged: part of it is not valid XML.')
  }
  return doc
}

/** Elements by qualified name ("w:p"), which is how Office writes them. */
function all(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagName(name))
}

// ---- Word ------------------------------------------------------------------

function runText(paragraph: Element): string {
  let out = ''
  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      if (child.tagName === 'w:t') out += child.textContent ?? ''
      else if (child.tagName === 'w:tab') out += '\t'
      else if (child.tagName === 'w:br' || child.tagName === 'w:cr') out += '\n'
      // A nested table's text belongs to the table, not this paragraph.
      else if (child.tagName !== 'w:tbl') walk(child)
    }
  }
  walk(paragraph)
  return out
}

export async function readDocx(data: ArrayBuffer): Promise<DocBlock[]> {
  const parts = await entries(data, (p) => p === 'word/document.xml')
  const xml = parts.get('word/document.xml')
  if (!xml) throw new Error('This is not a Word document: it has no word/document.xml.')
  const body = all(parseXml(xml), 'w:body')[0]
  if (!body) return []

  const blocks: DocBlock[] = []
  for (const child of Array.from(body.children)) {
    if (child.tagName === 'w:tbl') {
      const rows = all(child, 'w:tr').map((tr) =>
        Array.from(tr.children)
          .filter((c) => c.tagName === 'w:tc')
          .map((tc) => all(tc, 'w:p').map(runText).join('\n').trim()),
      )
      if (rows.length) blocks.push({ type: 'table', rows })
      continue
    }
    if (child.tagName !== 'w:p') continue
    const text = runText(child)
    if (!text.trim()) continue
    const style = all(child, 'w:pStyle')[0]?.getAttribute('w:val') ?? ''
    const heading = /^(?:Heading|heading)\s?(\d)$/.exec(style)
    if (heading || style === 'Title') {
      blocks.push({ type: 'heading', level: heading ? Math.min(3, Number(heading[1])) : 1, text })
    } else if (all(child, 'w:numPr').length) {
      blocks.push({ type: 'bullet', text })
    } else {
      blocks.push({ type: 'paragraph', text })
    }
  }
  return blocks
}

// ---- Excel -----------------------------------------------------------------

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export async function readXlsx(data: ArrayBuffer): Promise<Sheet[]> {
  const parts = await entries(
    data,
    (p) =>
      p === 'xl/workbook.xml' ||
      p === 'xl/sharedStrings.xml' ||
      p === 'xl/_rels/workbook.xml.rels' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(p),
  )
  const workbook = parts.get('xl/workbook.xml')
  if (!workbook) throw new Error('This is not an Excel workbook: it has no xl/workbook.xml.')

  const strings = parts.has('xl/sharedStrings.xml')
    ? all(parseXml(parts.get('xl/sharedStrings.xml')!), 'si').map((si) =>
        all(si, 't').map((t) => t.textContent ?? '').join(''),
      )
    : []

  const targets = new Map<string, string>()
  if (parts.has('xl/_rels/workbook.xml.rels')) {
    for (const rel of all(parseXml(parts.get('xl/_rels/workbook.xml.rels')!), 'Relationship')) {
      const id = rel.getAttribute('Id')
      const target = rel.getAttribute('Target')
      if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
    }
  }

  const sheets: Sheet[] = []
  for (const sheet of all(parseXml(workbook), 'sheet')) {
    const name = sheet.getAttribute('name') ?? `Sheet ${sheets.length + 1}`
    const target = targets.get(sheet.getAttribute('r:id') ?? '')
    const xml = target ? parts.get(target) : undefined
    if (!xml) {
      sheets.push({ name, rows: [], truncated: 0 })
      continue
    }
    const rowEls = all(parseXml(xml), 'row')
    const rows: string[][] = []
    for (const row of rowEls.slice(0, MAX_PREVIEW_ROWS)) {
      // Keep empty rows where the sheet has them, so row numbers line up.
      const rowNumber = Number(row.getAttribute('r')) || rows.length + 1
      while (rows.length < rowNumber - 1 && rows.length < MAX_PREVIEW_ROWS) rows.push([])
      const cells: string[] = []
      for (const cell of all(row, 'c')) {
        const ref = cell.getAttribute('r')
        const index = ref ? columnIndex(ref) : cells.length
        if (index >= MAX_PREVIEW_COLUMNS) continue
        const type = cell.getAttribute('t')
        const v = cell.getElementsByTagName('v')[0]?.textContent ?? ''
        let value = v
        if (type === 's') value = strings[Number(v)] ?? ''
        else if (type === 'inlineStr') value = all(cell, 't').map((t) => t.textContent ?? '').join('')
        else if (type === 'b') value = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : v
        while (cells.length < index) cells.push('')
        cells[index] = value
      }
      rows.push(cells)
    }
    sheets.push({ name, rows, truncated: Math.max(0, rowEls.length - MAX_PREVIEW_ROWS) })
  }
  return sheets
}

// ---- PowerPoint ------------------------------------------------------------

export async function readPptx(data: ArrayBuffer): Promise<Slide[]> {
  const parts = await entries(data, (p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
  return [...parts.entries()]
    .map(([path, xml]) => ({
      number: Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0),
      paragraphs: all(parseXml(xml), 'a:p')
        .map((p) => all(p, 'a:t').map((t) => t.textContent ?? '').join(''))
        .filter((t) => t.trim()),
    }))
    .sort((a, b) => a.number - b.number)
}

// ---- CSV -------------------------------------------------------------------

/**
 * Parse CSV (or TSV) the way spreadsheets write it: quoted fields may hold
 * the delimiter, doubled quotes and line breaks. Stops after `maxRows`.
 */
export function parseDelimited(
  text: string,
  delimiter = ',',
  maxRows = MAX_PREVIEW_ROWS,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0

  for (; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 }
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return { rows, truncated: false }
}
