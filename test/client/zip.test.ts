import { describe, expect, it } from 'vitest'
import { createZip, crc32 } from '../../src/lib/zip'
import { isZipName, unzip } from '../../src/lib/unzip'
import { selectionFromFiles } from '../../src/lib/importMarkdown'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function archive(entries: { path: string; content: string | Uint8Array }[]) {
  return new Uint8Array(await (await createZip(entries)).arrayBuffer())
}

/** Offset of the first central-directory record. */
function centralOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return view.getUint32(bytes.length - 22 + 16, true)
}

function patchCentral(bytes: Uint8Array, field: number, value: number, width: 16 | 32) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const at = centralOffset(bytes) + field
  if (width === 16) view.setUint16(at, value, true)
  else view.setUint32(at, value, true)
}

const buf = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

describe('createZip + unzip', () => {
  it('round-trips text, binary and nested unicode paths', async () => {
    const binary = new Uint8Array(512).map((_, i) => (i * 7919) % 256)
    const bytes = await archive([
      { path: 'Projects/idea.md', content: '# Idea\n\n' + 'words '.repeat(300) },
      { path: 'attachments/pic.bin', content: binary },
      { path: 'Café/über.md', content: 'ünïcödé' },
    ])
    const { files, skipped } = await unzip(buf(bytes))
    expect(skipped).toEqual([])
    expect(files.map((f) => f.path)).toEqual(['Projects/idea.md', 'attachments/pic.bin', 'Café/über.md'])
    expect(dec.decode(files[0].bytes)).toContain('words words')
    expect(files[1].bytes).toEqual(binary)
    expect(dec.decode(files[2].bytes)).toBe('ünïcödé')
  })

  it('computes the standard CRC-32', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926)
  })

  it('skips folders and macOS litter, and lets a filter drop entries silently', async () => {
    const bytes = await archive([
      { path: 'keep.md', content: 'k' },
      { path: '__MACOSX/._keep.md', content: 'x' },
      { path: 'sub/.DS_Store', content: 'x' },
      { path: 'drop.txt', content: 'd' },
    ])
    const { files, skipped } = await unzip(buf(bytes), { filter: (p) => p.endsWith('.md') })
    expect(files.map((f) => f.path)).toEqual(['keep.md'])
    expect(skipped).toEqual([])
  })

  it('refuses an entry that inflates past what the archive claims', async () => {
    const bytes = await archive([{ path: 'bomb.md', content: 'a'.repeat(200_000) }])
    // Claim ten bytes: small enough to pass every size check that trusts the index.
    patchCentral(bytes, 24, 10, 32)
    const { files, skipped } = await unzip(buf(bytes))
    expect(files).toEqual([])
    expect(skipped[0].reason).toMatch(/expands to far more/)
  })

  it('reports a corrupted entry by its checksum', async () => {
    const content = new Uint8Array(64).map((_, i) => (i * 131) % 251)
    const bytes = await archive([{ path: 'data.bin', content }])
    // Stored (incompressible), so its bytes sit right after the local header.
    bytes[30 + 'data.bin'.length + 5] ^= 0xff
    const { skipped } = await unzip(buf(bytes))
    expect(skipped[0].reason).toMatch(/checksum/)
  })

  it('honours per-file and total size limits', async () => {
    const bytes = await archive([
      { path: 'a.md', content: 'x'.repeat(600) },
      { path: 'b.md', content: 'y'.repeat(600) },
      { path: 'c.md', content: 'z'.repeat(5000) },
    ])
    const { files, skipped } = await unzip(buf(bytes), { maxFileBytes: 1000, maxTotalBytes: 1000 })
    expect(files.map((f) => f.path)).toEqual(['a.md'])
    expect(skipped.map((s) => s.path)).toEqual(['b.md', 'c.md'])
    expect(skipped[0].reason).toMatch(/too large to expand/)
    expect(skipped[1].reason).toMatch(/larger than/)
  })

  it('skips encrypted entries and unknown compression methods', async () => {
    const encrypted = await archive([{ path: 'secret.md', content: 's' }])
    patchCentral(encrypted, 8, 0x0801, 16)
    expect((await unzip(buf(encrypted))).skipped[0].reason).toBe('encrypted')

    const lzma = await archive([{ path: 'lzma.md', content: 's' }])
    patchCentral(lzma, 10, 14, 16)
    expect((await unzip(buf(lzma))).skipped[0].reason).toMatch(/unsupported method \(14\)/)
  })

  it('throws only when the archive as a whole is unreadable', async () => {
    await expect(unzip(new ArrayBuffer(10))).rejects.toThrow(/too small/)
    await expect(unzip(new ArrayBuffer(4096))).rejects.toThrow(/doesn't look like a ZIP/)
    const bytes = await archive([{ path: 'a.md', content: 'hello' }])
    await expect(unzip(buf(bytes.slice(0, bytes.length - 30)))).rejects.toThrow()
  })

  it('recognises archive names', () => {
    expect(isZipName('backup.ZIP')).toBe(true)
    expect(isZipName('notes.md')).toBe(false)
  })
})

describe('selectionFromFiles', () => {
  it('reads Markdown, expands archives into a folder, and says what it skipped', async () => {
    const loose = await archive([
      { path: 'one.md', content: '# One' },
      { path: 'two.txt', content: 'Two' },
      { path: 'photo.jpg', content: 'jpg' },
    ])
    const rooted = await archive([
      { path: 'Research/a.md', content: 'A' },
      { path: 'Research/b.md', content: 'B' },
    ])

    const selection = await selectionFromFiles([
      new File(['# Hello'], 'hello.md'),
      new File(['png'], 'image.png'),
      new File([loose as BlobPart], 'my-notes.zip'),
      new File([rooted as BlobPart], 'research.zip'),
      new File(['not a zip at all'], 'broken.zip'),
    ])

    expect(selection.items.map((i) => i.path)).toEqual([
      'hello.md',
      'my-notes/one.md',
      'my-notes/two.txt',
      'Research/a.md',
      'Research/b.md',
    ])
    expect(selection.items[0].content).toBe('# Hello')
    expect(selection.skipped.map((s) => s.name)).toEqual([
      'image.png',
      'my-notes.zip/photo.jpg',
      'broken.zip',
    ])
  })
})
