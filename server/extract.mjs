// Text out of the files an agent stores, for search and for MCP's `read`.
//
// Notes are text already. Of everything else, three families give up their
// words without a dependency:
//
//   * plain-text formats — CSV, JSON, YAML, source code, logs — read as UTF-8;
//   * Office Open XML — .docx, .xlsx, .pptx — which are ZIPs of XML;
//   * OpenDocument — .odt, .ods, .odp — the same idea, one content.xml.
//
// PDFs are not on the list. Getting reliable text out of a PDF means font
// encodings, CMaps and content-stream parsing — a library's worth of work —
// and half-right text is worse than none in a search index. A PDF is still
// found by its name, and by any note that links to it; the Hermes skill asks
// the agent to write that note.
//
// The output is Markdown-flavoured plain text: headings keep a `#`, sheets and
// slides get their own heading, and table cells are separated by ` | `, so an
// agent reading it gets the structure as well as the words.

import { readZipEntries } from './unzip.mjs'

/** Formats that are text on disk, by extension. */
export const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'yaml', 'yml',
  'xml', 'html', 'htm', 'log', 'toml', 'ini', 'cfg', 'conf', 'rst', 'org', 'tex', 'bib',
  'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql',
  'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php',
  'r', 'lua', 'pl', 'scala', 'dart', 'css', 'scss', 'less', 'vue', 'svelte', 'graphql',
  'proto', 'dockerfile', 'makefile', 'gradle', 'properties', 'srt', 'vtt', 'ipynb',
])

const OOXML = new Set(['docx', 'xlsx', 'pptx'])
const ODF = new Set(['odt', 'ods', 'odp'])

/** Anything bigger is read for its name only. */
export const MAX_EXTRACT_SOURCE_BYTES = 25 * 1024 * 1024
/** And no file contributes more than this much text. */
export const MAX_EXTRACT_CHARS = 400_000

const MAX_SHEET_ROWS = 2000

export function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Whether `extractText` has anything to say about a file with this name. */
export function isExtractable(name) {
  const ext = extensionOf(name)
  return TEXT_EXTENSIONS.has(ext) || OOXML.has(ext) || ODF.has(ext)
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, code) => {
    const lower = code.toLowerCase()
    if (lower === 'amp') return '&'
    if (lower === 'lt') return '<'
    if (lower === 'gt') return '>'
    if (lower === 'quot') return '"'
    if (lower === 'apos') return "'"
    const n = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10)
    try {
      return String.fromCodePoint(n)
    } catch {
      return whole
    }
  })
}

function tidy(text) {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_EXTRACT_CHARS)
}

// ---- Word ------------------------------------------------------------------

/** One paragraph's visible text: runs, tabs and breaks. */
function wordRuns(xml) {
  let out = ''
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g
  let m
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) out += decodeEntities(m[1])
    else if (m[0].startsWith('<w:tab')) out += '\t'
    else out += '\n'
  }
  return out
}

function docxText(documentXml) {
  const body = documentXml.replace(/^[\s\S]*?<w:body>/, '').replace(/<\/w:body>[\s\S]*$/, '')
  const lines = []
  // Tables first become rows of cells, so their paragraphs aren't read twice.
  const withTables = body.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table) => {
    const rows = table.match(/<w:tr[\s>][\s\S]*?<\/w:tr>/g) ?? []
    const text = rows
      .map((row) =>
        (row.match(/<w:tc[\s>][\s\S]*?<\/w:tc>/g) ?? [])
          .map((cell) => wordRuns(cell).replace(/\s+/g, ' ').trim())
          .join(' | '),
      )
      .join('\n')
    return `<w:p><w:r><w:t>${text.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</w:t></w:r></w:p>`
  })
  for (const paragraph of withTables.split(/<\/w:p>/)) {
    const text = wordRuns(paragraph)
    if (!text.trim()) {
      lines.push('')
      continue
    }
    const heading = /<w:pStyle w:val="(?:Heading|heading|Title)\s?(\d?)"/.exec(paragraph)
    const bullet = /<w:numPr>/.test(paragraph)
    if (heading) lines.push(`${'#'.repeat(Math.min(6, Number(heading[1] || 1)))} ${text.trim()}`)
    else if (bullet) lines.push(`- ${text.trim()}`)
    else lines.push(text)
  }
  return tidy(lines.join('\n'))
}

// ---- Excel -----------------------------------------------------------------

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function sharedStrings(xml) {
  if (!xml) return []
  return (xml.match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) =>
    decodeEntities((si.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join('')),
  )
}

function sheetRows(xml, strings) {
  const rows = []
  for (const row of xml.match(/<row[\s>][\s\S]*?<\/row>/g) ?? []) {
    if (rows.length >= MAX_SHEET_ROWS) break
    const cells = []
    // Self-closing (empty) cells first, or the lazy match would run on into
    // the next cell's content.
    for (const cell of row.match(/<c\s[^>]*\/>|<c[\s>][\s\S]*?<\/c>/g) ?? []) {
      const ref = /\sr="([A-Z]+\d+)"/.exec(cell)?.[1]
      const type = /\st="([^"]+)"/.exec(cell)?.[1]
      const raw = /<v>([^<]*)<\/v>/.exec(cell)?.[1]
      let value = ''
      if (type === 's' && raw !== undefined) value = strings[Number(raw)] ?? ''
      else if (type === 'inlineStr') value = decodeEntities((/<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(cell) ?? [])[1] ?? '')
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE'
      else if (raw !== undefined) value = decodeEntities(raw)
      const index = ref ? columnIndex(ref) : cells.length
      while (cells.length < index) cells.push('')
      cells[index] = value.replace(/\s+/g, ' ').trim()
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    if (cells.length) rows.push(cells.join(' | '))
  }
  return rows
}

function xlsxText(entries) {
  const text = (name) => entries.get(name)?.toString('utf8')
  const strings = sharedStrings(text('xl/sharedStrings.xml'))
  const workbook = text('xl/workbook.xml') ?? ''
  const rels = text('xl/_rels/workbook.xml.rels') ?? ''
  const targets = new Map()
  for (const rel of rels.match(/<Relationship\s[^>]*>/g) ?? []) {
    const id = /\sId="([^"]+)"/.exec(rel)?.[1]
    const target = /\sTarget="([^"]+)"/.exec(rel)?.[1]
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'))
  }
  const parts = []
  for (const sheet of workbook.match(/<sheet\s[^>]*>/g) ?? []) {
    const name = decodeEntities(/\sname="([^"]*)"/.exec(sheet)?.[1] ?? 'Sheet')
    const rid = /\sr:id="([^"]+)"/.exec(sheet)?.[1]
    const xml = rid ? text(targets.get(rid) ?? '') : undefined
    if (!xml) continue
    const rows = sheetRows(xml, strings)
    parts.push(`## ${name}\n\n${rows.join('\n')}`)
  }
  return tidy(parts.join('\n\n'))
}

// ---- PowerPoint ------------------------------------------------------------

function pptxText(entries) {
  const slides = [...entries.keys()]
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1]) }))
    .filter((s) => Number.isFinite(s.n))
    .sort((a, b) => a.n - b.n)
  const parts = slides.map(({ name, n }) => {
    const xml = entries.get(name).toString('utf8')
    const paragraphs = xml
      .split(/<\/a:p>/)
      .map((p) =>
        decodeEntities(
          (p.match(/<a:t(?:\s[^>]*)?>[^<]*<\/a:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, '')).join(''),
        ),
      )
      .filter((p) => p.trim())
    return `## Slide ${n}\n\n${paragraphs.join('\n')}`
  })
  return tidy(parts.join('\n\n'))
}

// ---- OpenDocument ----------------------------------------------------------

function odfText(contentXml) {
  const body = contentXml.replace(/^[\s\S]*?<office:body>/, '')
  return tidy(
    decodeEntities(
      body
        .replace(/<text:tab\/>/g, '\t')
        .replace(/<text:line-break\/>/g, '\n')
        .replace(/<text:s(?:\s+text:c="(\d+)")?\/>/g, (_, n) => ' '.repeat(Number(n ?? 1)))
        .replace(/<\/table:table-cell>/g, ' | ')
        .replace(/<\/(?:text:p|text:h|table:table-row)>/g, '\n')
        .replace(/<[^>]+>/g, ''),
    ),
  )
}

/**
 * The text in a file's bytes, or null when it has none Deckle can read.
 *
 * @param {Buffer} buffer
 * @param {string} name  the file name, for its extension
 */
export function extractText(buffer, name) {
  const ext = extensionOf(name)
  try {
    if (TEXT_EXTENSIONS.has(ext)) {
      // A NUL in the first few KB means this "text" file is really binary.
      if (buffer.subarray(0, 8192).includes(0)) return null
      return buffer.toString('utf8').replace(/^\uFEFF/, '').slice(0, MAX_EXTRACT_CHARS)
    }
    if (ext === 'docx') {
      const entries = readZipEntries(buffer, { want: (n) => n === 'word/document.xml' })
      const xml = entries.get('word/document.xml')
      return xml ? docxText(xml.toString('utf8')) : null
    }
    if (ext === 'xlsx') {
      return xlsxText(
        readZipEntries(buffer, {
          want: (n) =>
            n === 'xl/workbook.xml' ||
            n === 'xl/sharedStrings.xml' ||
            n === 'xl/_rels/workbook.xml.rels' ||
            /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
        }),
      )
    }
    if (ext === 'pptx') {
      return pptxText(readZipEntries(buffer, { want: (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) }))
    }
    if (ODF.has(ext)) {
      const xml = readZipEntries(buffer, { want: (n) => n === 'content.xml' }).get('content.xml')
      return xml ? odfText(xml.toString('utf8')) : null
    }
  } catch {
    // A damaged or unusual document has no text, rather than failing a search.
    return null
  }
  return null
}
