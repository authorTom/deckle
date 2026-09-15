// ZIP writer for GET /api/v1/export.
//
// The browser has its own writer (src/lib/zip.ts) because the app can export a
// library the server has never seen — a local folder or the in-browser OPFS one.
// This is the server's half of the same job: the API has to be able to hand an
// agent the whole knowledge base without a browser in the loop.
//
// Entries are streamed out as they're read so a large library never has to sit in
// memory at once. Zip64 is not implemented; a Markdown library will not reach the
// 4 GiB / 65535-entry limits, and `createZipStream` reports rather than emits a
// corrupt archive if one somehow does.

import { deflateRawSync } from 'node:zlib'

const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time, the only timestamp a base ZIP header carries. */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function u16(value) {
  const buf = Buffer.alloc(2)
  buf.writeUInt16LE(value & 0xffff, 0)
  return buf
}

function u32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0, 0)
  return buf
}

/** The response closed before the archive was finished. Routine, not a fault. */
export class ClientGoneError extends Error {
  constructor() {
    super('the client went away before the export finished')
  }
}

/**
 * Wait for a full send buffer to empty — or for the connection to end.
 *
 * Waiting on 'drain' alone hung for ever when a client disconnected with the
 * buffer full: 'drain' never comes to a closed socket, so the export sat in
 * memory, holding its file reads, for the life of the process.
 */
function waitForDrain(out) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      out.off('drain', onDrain)
      out.off('close', onGone)
      out.off('error', onGone)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onGone = () => {
      cleanup()
      reject(new ClientGoneError())
    }
    out.on('drain', onDrain)
    out.on('close', onGone)
    out.on('error', onGone)
  })
}

/**
 * Write a ZIP archive to `res` (or any writable) from an async iterable of
 * `{ path, content: Buffer, modified: Date }`.
 *
 * The caller must have sent headers already: by the time the first entry is
 * known there is nothing left to say about the response.
 */
export async function writeZip(out, entries) {
  const central = []
  let offset = 0

  const push = (chunk) => {
    if (out.destroyed || out.writableEnded) return Promise.reject(new ClientGoneError())
    offset += chunk.length
    // Respect backpressure so a slow client can't balloon the send buffer.
    return out.write(chunk) ? null : waitForDrain(out)
  }

  for await (const entry of entries) {
    if (central.length >= MAX_ENTRIES) {
      throw new Error(`too many files for one archive (limit ${MAX_ENTRIES})`)
    }

    const nameBytes = Buffer.from(entry.path, 'utf8')
    const raw = entry.content
    const deflated = deflateRawSync(raw)
    // Storing beats deflating for tiny or already-dense files.
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const { time, date } = dosDateTime(entry.modified ?? new Date())

    const record = {
      nameBytes,
      crc: crc32(raw),
      compressedSize: body.length,
      uncompressedSize: raw.length,
      method: useDeflate ? 8 : 0,
      time,
      date,
      offset,
    }

    await push(
      Buffer.concat([
        u32(0x04034b50),
        u16(20), // version needed to extract
        u16(0x0800), // flags: bit 11 = UTF-8 file name
        u16(record.method),
        u16(time),
        u16(date),
        u32(record.crc),
        u32(record.compressedSize),
        u32(record.uncompressedSize),
        u16(nameBytes.length),
        u16(0), // extra field length
        nameBytes,
      ]),
    )
    await push(body)

    central.push(record)
    if (offset > MAX_BYTES) throw new Error('archive exceeds the 4 GB ZIP limit')
  }

  const centralOffset = offset
  for (const record of central) {
    await push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed to extract
        u16(0x0800),
        u16(record.method),
        u16(record.time),
        u16(record.date),
        u32(record.crc),
        u32(record.compressedSize),
        u32(record.uncompressedSize),
        u16(record.nameBytes.length),
        u16(0), // extra field length
        u16(0), // file comment length
        u16(0), // disk number start
        u16(0), // internal attributes
        u32(0), // external attributes
        u32(record.offset),
        record.nameBytes,
      ]),
    )
  }

  await push(
    Buffer.concat([
      u32(0x06054b50),
      u16(0), // this disk
      u16(0), // disk with central directory
      u16(central.length),
      u16(central.length),
      u32(offset - centralOffset),
      u32(centralOffset),
      u16(0), // comment length
    ]),
  )

  return central.length
}
