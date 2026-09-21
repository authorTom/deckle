// Just enough ZIP reading to look inside office documents.
//
// A .docx, .xlsx or .pptx — and their OpenDocument cousins — is a ZIP of XML
// files. Search and MCP's `read` want the words in them, and the server takes
// no dependencies, so this reads the archive's central directory and inflates
// the handful of members it is asked for with Node's own zlib.
//
// Deliberately narrow: no Zip64, no encryption, no streaming. An office file
// that needs any of those is not one search is going to index anyway, and it
// fails closed — the caller treats a throw as "no text for this file".

import zlib from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

export class ZipError extends Error {}

/**
 * Read the members of a ZIP held in `buffer` for which `want(name)` is true.
 *
 * @param {Buffer} buffer
 * @param {{ want: (name: string) => boolean, maxEntryBytes?: number, maxTotalBytes?: number }} options
 * @returns {Map<string, Buffer>}
 */
export function readZipEntries(
  buffer,
  { want, maxEntryBytes = 16 * 1024 * 1024, maxTotalBytes = 48 * 1024 * 1024 },
) {
  // The end-of-central-directory record sits in the last 22 bytes plus up to
  // 64 KB of archive comment.
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buffer.length - 22; i >= floor; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new ZipError('not a ZIP archive')

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (offset === 0xffffffff || count === 0xffff) throw new ZipError('Zip64 is not supported')

  const out = new Map()
  let total = 0
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) {
      throw new ZipError('corrupt central directory')
    }
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const size = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if (!want(name)) continue
    if (flags & 0x1) throw new ZipError('encrypted archives are not supported')
    if (size > maxEntryBytes) throw new ZipError(`${name} is too large to read`)
    total += size
    if (total > maxTotalBytes) throw new ZipError('archive expands too far')

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new ZipError('corrupt local header')
    }
    const start =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
    const data = buffer.subarray(start, start + compressedSize)

    if (method === 0) {
      out.set(name, data)
    } else if (method === 8) {
      // maxOutputLength makes a lying size field a throw, not a memory spike.
      out.set(name, zlib.inflateRawSync(data, { maxOutputLength: maxEntryBytes }))
    } else {
      throw new ZipError(`compression method ${method} is not supported`)
    }
  }
  return out
}
