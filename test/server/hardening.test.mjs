// Regression tests for the fixes from the 3.0 security audit: each case is an
// input that used to cost the server its availability or let a request past a
// boundary, and must now be refused or stay cheap.

import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createLibraryApi } from '../../server/library-api.mjs'
import { BadPathError } from '../../server/paths.mjs'
import { extractText } from '../../server/extract.mjs'
import { createExtractor } from '../../server/extract-worker.mjs'
import { readZipEntries, ZipError } from '../../server/unzip.mjs'
import { createHostCheck, hostnameOf } from '../../server/hosts.mjs'
import { APP, makeTempDir, startServer } from '../helpers/server.mjs'
import { docx, zipOf } from '../helpers/office.mjs'

const CENTRAL_SIG = 0x02014b50

/** Rewrite every central-directory record's uncompressed size to `size`. */
function lieAboutSizes(zip, size) {
  const copy = Buffer.from(zip)
  for (let i = 0; i + 4 <= copy.length; i++) {
    if (copy.readUInt32LE(i) === CENTRAL_SIG) copy.writeUInt32LE(size, i + 24)
  }
  return copy
}

/** Time a synchronous call, in milliseconds. */
function timed(fn) {
  const start = performance.now()
  const result = fn()
  return { result, ms: performance.now() - start }
}

describe('zip reading trusts no declared size', () => {
  it('refuses a member that inflates past the size it declares', async () => {
    const zip = await zipOf({ 'xl/worksheets/sheet1.xml': 'x'.repeat(100_000) })
    expect(() => readZipEntries(lieAboutSizes(zip, 0), { want: () => true })).toThrow(ZipError)
    expect(() => readZipEntries(lieAboutSizes(zip, 10), { want: () => true })).toThrow(ZipError)
    // The truth still reads.
    expect(readZipEntries(zip, { want: () => true }).get('xl/worksheets/sheet1.xml').length).toBe(100_000)
  })
})

describe('office extraction stays bounded on hostile documents', () => {
  const sheet = (cells) =>
    zipOf({
      'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>`,
    })

  it('ignores a cell reference past the last column instead of padding to it', async () => {
    const buf = await sheet('<c r="A1" t="inlineStr"><is><t>kept</t></is></c><c r="AAAAAAAA1"><v>9</v></c>')
    const { result, ms } = timed(() => extractText(buf, 'x.xlsx'))
    expect(result).toContain('kept')
    expect(result).not.toContain('9')
    expect(ms).toBeLessThan(1000)
  })

  it('reads a worksheet once however many sheets point at it', async () => {
    const many = '<sheet name="S" r:id="rId1"/>'.repeat(500)
    const buf = await zipOf({
      'xl/workbook.xml': `<workbook><sheets>${many}</sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
    })
    expect(extractText(buf, 'x.xlsx').match(/## S/g)).toHaveLength(1)
  })

  it('caps an OpenDocument space run', async () => {
    const buf = await zipOf({
      'content.xml': '<office:document-content><office:body><text:p>a<text:s text:c="100000000"/>b</text:p></office:body></office:document-content>',
    })
    const { result, ms } = timed(() => extractText(buf, 'x.odt'))
    expect(result.length).toBeLessThan(200)
    expect(ms).toBeLessThan(1000)
  })

  it('stays linear on long space runs, unclosed tags and stray angle brackets', async () => {
    const spaces = await zipOf({
      'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>${' '.repeat(1_000_000)}x</w:t></w:r></w:p></w:body></w:document>`,
    })
    const tables = await zipOf({
      'word/document.xml': `<w:document><w:body>${'<w:tbl>'.repeat(100_000)}<w:p><w:r><w:t>tail</w:t></w:r></w:p></w:body></w:document>`,
    })
    const brackets = await zipOf({
      'content.xml': `<office:document-content><office:body>${'<'.repeat(500_000)}</office:body></office:document-content>`,
    })
    for (const [buf, name] of [[spaces, 'a.docx'], [tables, 'b.docx'], [brackets, 'c.odt']]) {
      const { ms } = timed(() => extractText(buf, name))
      expect(ms).toBeLessThan(2000)
    }
    expect(extractText(tables, 'b.docx')).toContain('tail')
  })
})

describe('extraction worker', () => {
  it('extracts in a worker thread', async () => {
    const extractor = createExtractor()
    try {
      expect(await extractor.extract(await docx(), 'Brief.docx')).toContain('Market sizing')
    } finally {
      await extractor.close()
    }
  })

  it('gives up on a file that runs over its time, and recovers for the next', async () => {
    const extractor = createExtractor({ timeoutMs: 0 })
    try {
      expect(await extractor.extract(await docx(), 'Brief.docx')).toBeNull()
      expect(await extractor.extract(await docx(), 'Brief.docx')).toBeNull()
    } finally {
      await extractor.close()
    }
  })
})

describe('the reserved state folder, however it is spelled', () => {
  let root
  let lib
  beforeEach(async () => {
    root = await makeTempDir()
    lib = createLibraryApi(root)
    await lib.init()
    await fs.mkdir(path.join(root, '.deckle-state'))
    await fs.writeFile(path.join(root, '.deckle-state', 'assistant.json'), '{"key":"dummy"}')
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('refuses the long-s spelling a case-folding filesystem would open', async () => {
    await expect(lib.readText('.deckle-ſtate/assistant.json')).rejects.toBeInstanceOf(BadPathError)
  })

  it('refuses a symlink that leads into it', async () => {
    await fs.symlink(path.join(root, '.deckle-state'), path.join(root, 'shortcut'))
    await expect(lib.readText('shortcut/assistant.json')).rejects.toBeInstanceOf(BadPathError)
  })
})

describe('Host check without a password', () => {
  it('parses Host headers', () => {
    expect(hostnameOf('Notes.Example.com:8080')).toBe('notes.example.com')
    expect(hostnameOf('[::1]:8080')).toBe('::1')
    expect(hostnameOf('localhost')).toBe('localhost')
  })

  it('allows localhost, IP addresses and configured names', () => {
    const check = createHostCheck({ DECKLE_ALLOWED_HOSTS: 'notes.example.com, .tailnet.ts.net' })
    const allows = (host) => check.allows({ headers: { host } })
    expect(allows('127.0.0.1:8080')).toBe(true)
    expect(allows('[::1]:8080')).toBe(true)
    expect(allows('deckle.localhost')).toBe(true)
    expect(allows('notes.example.com')).toBe(true)
    expect(allows('box.tailnet.ts.net:8080')).toBe(true)
    expect(allows('tailnet.ts.net')).toBe(true)
    expect(allows('attacker.example')).toBe(false)
    expect(allows('notes.example.com.attacker.example')).toBe(false)
    expect(allows(undefined)).toBe(false)
    expect(createHostCheck({ DECKLE_ALLOWED_HOSTS: '*' }).allows({ headers: { host: 'x' } })).toBe(true)
  })

  /** A raw request, because fetch won't let a caller choose the Host header. */
  function request(base, pathname, headers) {
    const { hostname, port } = new URL(base)
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname, port, path: pathname, headers }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end()
    })
  }

  let open
  let locked
  beforeAll(async () => {
    open = await startServer()
    locked = await startServer({ DECKLE_PASSWORD: 'correct horse battery' })
  })
  afterAll(async () => {
    await open.close()
    await locked.close()
  })

  it('refuses a rebound host name on a passwordless library', async () => {
    expect(await request(open.base, '/api/library/tree', { ...APP, Host: 'attacker.example:8080' })).toBe(403)
    expect(await request(open.base, '/api/library/tree', APP)).toBe(200)
  })

  it('leaves a password-protected library to its password', async () => {
    expect(await request(locked.base, '/api/library/tree', { ...APP, Host: 'notes.example.com' })).toBe(401)
  })
})

describe('MCP batches', () => {
  const TOKEN = 'ro-secret-0123456789abcdef'
  let s
  beforeAll(async () => {
    s = await startServer({ DECKLE_API_TOKENS: `reader:r:${TOKEN}` })
  })
  afterAll(() => s.close())

  const batch = (n) =>
    s.fetch('/api/v1/mcp', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(Array.from({ length: n }, (_, i) => ({ jsonrpc: '2.0', id: i + 1, method: 'ping' }))),
    })

  it('answers a batch of up to 50 and refuses a longer one before running any of it', async () => {
    const ok = await batch(50)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toHaveLength(50)
    const tooMany = await batch(51)
    expect(tooMany.status).toBe(400)
    expect((await tooMany.json()).error.code).toBe(-32600)
  })
})

describe('compose.yaml', () => {
  it('passes the pre-rename security settings through to the container', async () => {
    const compose = await fs.readFile(new URL('../../compose.yaml', import.meta.url), 'utf8')
    for (const name of ['NIB_PASSWORD', 'NIB_SESSION_SECRET', 'NIB_API_TOKENS', 'NIB_API_TOKEN']) {
      expect(compose).toMatch(new RegExp(`^\\s+${name}: "\\$\\{${name}:-\\}"$`, 'm'))
    }
  })
})
