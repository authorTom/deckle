import { randomBytes } from 'node:crypto'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ClientGoneError, writeZip } from '../../server/zip.mjs'
import { unzip } from '../../src/lib/unzip.ts'

function collector() {
  const chunks = []
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk)
      callback()
    },
  })
  return { out, bytes: () => Buffer.concat(chunks) }
}

const toArrayBuffer = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

describe('writeZip', () => {
  it('writes an archive the app can read back, deflated or stored', async () => {
    const text = Buffer.from('# Notes\n\n' + 'compressible '.repeat(500))
    const noise = randomBytes(2048)
    const { out, bytes } = collector()

    async function* entries() {
      yield { path: 'Projects/notes.md', content: text, modified: new Date(2026, 0, 2, 3, 4, 6) }
      yield { path: 'attachments/noise.bin', content: noise, modified: new Date() }
      yield { path: 'Café/über.md', content: Buffer.from('ünïcödé'), modified: new Date(1970, 0, 1) }
    }

    expect(await writeZip(out, entries())).toBe(3)
    const archive = bytes()
    // Deflate made the text much smaller than it is.
    expect(archive.length).toBeLessThan(text.length + noise.length)

    const { files, skipped } = await unzip(toArrayBuffer(archive))
    expect(skipped).toEqual([])
    expect(files.map((f) => f.path)).toEqual(['Projects/notes.md', 'attachments/noise.bin', 'Café/über.md'])
    expect(Buffer.from(files[0].bytes).equals(text)).toBe(true)
    expect(Buffer.from(files[1].bytes).equals(noise)).toBe(true)
    expect(new TextDecoder().decode(files[2].bytes)).toBe('ünïcödé')
  })

  it('writes an empty archive', async () => {
    const { out, bytes } = collector()
    async function* none() {}
    expect(await writeZip(out, none())).toBe(0)
    expect((await unzip(toArrayBuffer(bytes()))).files).toEqual([])
  })

  it('gives up when the client goes away with the buffer full, instead of waiting for ever', async () => {
    // A client that never reads: every write stays pending, so 'drain' never comes.
    const out = new Writable({
      highWaterMark: 16,
      write() {},
    })
    async function* entries() {
      for (let i = 0; i < 100; i++) yield { path: `n${i}.bin`, content: randomBytes(4096) }
    }
    const pending = writeZip(out, entries())
    setTimeout(() => out.destroy(), 20)
    await expect(pending).rejects.toBeInstanceOf(ClientGoneError)
  })
})
