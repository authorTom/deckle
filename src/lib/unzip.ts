// The other half of lib/zip.ts: reading an archive back out again, so a library
// exported from Deckle (or zipped up by anything else) can be imported whole.
//
// Inflate comes from the platform, exactly as deflate does on the way out:
// `DecompressionStream('deflate-raw')` is in every browser Deckle supports.
// Stored (method 0) entries need no help at all.
//
// The archive is read through its central directory rather than by scanning
// local headers front to back. The central directory is the authoritative
// index — entries written with a streaming data descriptor carry zeroes for
// their sizes in the local header, and walking those would desynchronise the
// moment one appeared.

import { crc32 } from './zip'

const EOCD_SIG = 0x06054b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const EOCD64_SIG = 0x06064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/** A 32-bit field at this value means "the real value is in the Zip64 extra". */
const U32_MAX = 0xffffffff
const U16_MAX = 0xffff

/** One extracted member of the archive. */
export interface ZipFile {
  /** Path inside the archive, POSIX separators. */
  path: string
  bytes: Uint8Array
}

/** A member that could not be extracted, and why — reported, never swallowed. */
export interface ZipSkip {
  path: string
  reason: string
}

export interface UnzipResult {
  files: ZipFile[]
  skipped: ZipSkip[]
}

export interface UnzipOptions {
  /**
   * Decide whether an entry is worth extracting, before it is decompressed.
   * Returning false drops it silently (it was never wanted); to record a
   * reason, let it through and skip it upstream.
   */
  filter?: (path: string, uncompressedSize: number) => boolean
  /** Refuse any single entry larger than this once decompressed. */
  maxFileBytes?: number
  /** Refuse the archive once this much has been decompressed in total. */
  maxTotalBytes?: number
  onProgress?: (done: number, total: number) => void
}

/** Guard rails against an archive that expands to far more than it claims. */
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024

class ZipFormatError extends Error {}

/** An entry inflated to more bytes than the archive's own index claims. */
class ExpandsBeyondClaimError extends Error {}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

/** Read a 64-bit little-endian value, refusing anything JS can't count to. */
function u64(view: DataView, offset: number): number {
  const low = view.getUint32(offset, true)
  const high = view.getUint32(offset + 4, true)
  const value = high * 0x100000000 + low
  if (!Number.isSafeInteger(value)) {
    throw new ZipFormatError('This archive is larger than the browser can read.')
  }
  return value
}

/** Locate the end-of-central-directory record, scanning back over any comment. */
function findEocd(view: DataView): number {
  // The comment can be up to 65535 bytes, and the record itself is 22.
  const earliest = Math.max(0, view.byteLength - 0xffff - 22)
  for (let i = view.byteLength - 22; i >= earliest; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i
  }
  throw new ZipFormatError(
    "That doesn't look like a ZIP file — its central directory is missing.",
  )
}

interface Directory {
  offset: number
  count: number
}

/** Where the central directory starts and how many entries it holds. */
function readDirectory(view: DataView): Directory {
  const eocd = findEocd(view)
  let count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)

  // Zip64: the 32-bit fields saturate and the real values live in a second
  // record, found through a locator sitting just before the EOCD.
  if (count === U16_MAX || offset === U32_MAX) {
    const locator = eocd - 20
    if (locator < 0 || view.getUint32(locator, true) !== EOCD64_LOCATOR_SIG) {
      throw new ZipFormatError('This archive uses a ZIP64 layout Deckle cannot read.')
    }
    const eocd64 = u64(view, locator + 8)
    if (eocd64 < 0 || eocd64 + 56 > view.byteLength) {
      throw new ZipFormatError('This archive is damaged: its ZIP64 index is out of range.')
    }
    if (view.getUint32(eocd64, true) !== EOCD64_SIG) {
      throw new ZipFormatError('This archive is damaged: its ZIP64 index is unreadable.')
    }
    count = u64(view, eocd64 + 32)
    offset = u64(view, eocd64 + 48)
  }

  return { offset, count }
}

interface CentralEntry {
  path: string
  method: number
  flags: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  /** Byte length of this central-directory record, to step to the next one. */
  recordLength: number
}

/**
 * Pull the true sizes and offset out of a Zip64 extended-information field.
 * The fields are present only for whichever 32-bit values saturated, in a
 * fixed order — so which ones to read depends on what was missing.
 */
function applyZip64Extra(
  entry: CentralEntry,
  view: DataView,
  start: number,
  length: number,
): void {
  let cursor = start
  const end = start + length
  while (cursor + 4 <= end) {
    const headerId = view.getUint16(cursor, true)
    const size = view.getUint16(cursor + 2, true)
    const body = cursor + 4
    if (body + size > end) break
    if (headerId === 0x0001) {
      let at = body
      if (entry.uncompressedSize === U32_MAX && at + 8 <= body + size) {
        entry.uncompressedSize = u64(view, at)
        at += 8
      }
      if (entry.compressedSize === U32_MAX && at + 8 <= body + size) {
        entry.compressedSize = u64(view, at)
        at += 8
      }
      if (entry.localOffset === U32_MAX && at + 8 <= body + size) {
        entry.localOffset = u64(view, at)
      }
      return
    }
    cursor = body + size
  }
}

function readCentralEntry(
  view: DataView,
  bytes: Uint8Array,
  at: number,
  decoder: TextDecoder,
): CentralEntry {
  if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL_SIG) {
    throw new ZipFormatError('This archive is damaged: its file index is unreadable.')
  }
  const nameLength = view.getUint16(at + 28, true)
  const extraLength = view.getUint16(at + 30, true)
  const commentLength = view.getUint16(at + 32, true)
  const nameStart = at + 46

  const entry: CentralEntry = {
    path: decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
    flags: view.getUint16(at + 8, true),
    method: view.getUint16(at + 10, true),
    crc: view.getUint32(at + 16, true),
    compressedSize: view.getUint32(at + 20, true),
    uncompressedSize: view.getUint32(at + 24, true),
    localOffset: view.getUint32(at + 42, true),
    recordLength: 46 + nameLength + extraLength + commentLength,
  }

  if (
    entry.compressedSize === U32_MAX ||
    entry.uncompressedSize === U32_MAX ||
    entry.localOffset === U32_MAX
  ) {
    applyZip64Extra(entry, view, nameStart + nameLength, extraLength)
  }

  return entry
}

/**
 * Inflate one entry, refusing to produce more than `limit` bytes.
 *
 * The size guards before this read the *claimed* size from the archive's
 * index, and an archive can claim anything: a few kilobytes that say "1 KB"
 * and inflate to gigabytes would sail past them and exhaust the tab's memory.
 * So the output is counted as it arrives and the stream abandoned the moment
 * it passes what the index promised.
 */
async function inflateRaw(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipFormatError(
      'This browser cannot decompress ZIP files. Unzip the archive first and import the folder.',
    )
  }
  const reader = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'))
    .getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => {})
      throw new ExpandsBeyondClaimError()
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

/** Entries every macOS-made archive carries and nobody ever wants imported. */
function isNoise(path: string): boolean {
  return (
    path.startsWith('__MACOSX/') ||
    path.split('/').some((segment) => segment === '.DS_Store' || segment === 'Thumbs.db')
  )
}

/**
 * Extract an archive's contents in memory.
 *
 * Never throws for a single bad member — a corrupt or unsupported entry is
 * recorded in `skipped` with its reason and the rest of the archive still
 * imports. It throws only when the archive as a whole cannot be read, which is
 * the one case where there is nothing partial to offer.
 */
export async function unzip(
  data: ArrayBuffer,
  options: UnzipOptions = {},
): Promise<UnzipResult> {
  const {
    filter,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
    onProgress,
  } = options

  if (data.byteLength < 22) {
    throw new ZipFormatError("That file is too small to be a ZIP archive.")
  }

  const bytes = new Uint8Array(data)
  const view = new DataView(data)
  const decoder = new TextDecoder('utf-8')
  const { offset, count } = readDirectory(view)

  const files: ZipFile[] = []
  const skipped: ZipSkip[] = []
  let totalBytes = 0
  let cursor = offset

  for (let i = 0; i < count; i++) {
    if (cursor + 46 > view.byteLength) {
      throw new ZipFormatError('This archive is damaged: its file index ends early.')
    }
    const entry = readCentralEntry(view, bytes, cursor, decoder)
    cursor += entry.recordLength

    onProgress?.(i + 1, count)

    // Directories carry no data; they're implied by the paths inside them.
    if (entry.path.endsWith('/') || isNoise(entry.path)) continue
    if (filter && !filter(entry.path, entry.uncompressedSize)) continue

    // Bit 0 is the (long-broken) ZipCrypto flag. There is no password to ask
    // for and no reason to pretend otherwise.
    if (entry.flags & 0x1) {
      skipped.push({ path: entry.path, reason: 'encrypted' })
      continue
    }
    if (entry.uncompressedSize > maxFileBytes) {
      skipped.push({ path: entry.path, reason: `larger than ${megabytes(maxFileBytes)}` })
      continue
    }
    if (entry.method !== 0 && entry.method !== 8) {
      skipped.push({
        path: entry.path,
        reason: `compressed with an unsupported method (${entry.method})`,
      })
      continue
    }
    if (totalBytes + entry.uncompressedSize > maxTotalBytes) {
      skipped.push({ path: entry.path, reason: 'the archive is too large to expand' })
      continue
    }

    // The local header repeats the name and may carry a *different* extra
    // field length than the central one, so the data offset has to be read
    // from the local header itself rather than assumed.
    const local = entry.localOffset
    if (local + 30 > view.byteLength || view.getUint32(local, true) !== LOCAL_SIG) {
      skipped.push({ path: entry.path, reason: 'its entry in the archive is damaged' })
      continue
    }
    const dataStart =
      local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > view.byteLength) {
      throw new ZipFormatError('This archive is truncated — it may not have finished downloading.')
    }

    try {
      const raw = bytes.subarray(dataStart, dataEnd)
      const content =
        entry.method === 8 ? await inflateRaw(raw, entry.uncompressedSize) : raw.slice()

      if (content.length !== entry.uncompressedSize) {
        skipped.push({ path: entry.path, reason: 'is damaged (its size does not match the archive)' })
        continue
      }

      // The CRC is the archive's own claim about what should have come out.
      // Checking it is the difference between importing a note and importing
      // a corrupted one under a name that looks fine.
      if (crc32(content) !== entry.crc) {
        skipped.push({ path: entry.path, reason: 'failed its checksum (corrupt)' })
        continue
      }

      totalBytes += content.length
      files.push({ path: entry.path, bytes: content })
    } catch (err) {
      if (err instanceof ZipFormatError) throw err
      skipped.push({
        path: entry.path,
        reason:
          err instanceof ExpandsBeyondClaimError
            ? 'expands to far more than the archive says (damaged, or built to exhaust memory)'
            : 'could not be decompressed',
      })
    }
  }

  return { files, skipped }
}

/** Does this file name look like an archive Deckle can expand? */
export function isZipName(name: string): boolean {
  return /\.zip$/i.test(name)
}
