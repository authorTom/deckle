// Text extraction, run off the request thread.
//
// extractText parses documents anyone could have written: an agent saves what
// it found on the web, and search reads every file in the library. However
// carefully the parsers are bounded, a document that still finds a slow or
// memory-hungry path must cost one file its text, not every user the server.
// So extraction runs in a worker thread with its own heap cap and a time
// limit per file. A worker that runs over is terminated and replaced, and the
// file is treated as having no text.
//
// One worker at a time, reused across files: starting a thread per document
// would make the first index of a large library needlessly slow.

import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { extractText } from './extract.mjs'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_HEAP_MB = 256

if (!isMainThread && parentPort) {
  parentPort.on('message', ({ id, bytes, name }) => {
    parentPort.postMessage({ id, text: extractText(Buffer.from(bytes), name) })
  })
}

/**
 * @param {{ timeoutMs?: number, maxHeapMb?: number }} [options]
 * @returns {{ extract: (buffer: Buffer, name: string) => Promise<string | null>, close: () => Promise<void> }}
 */
export function createExtractor({ timeoutMs = DEFAULT_TIMEOUT_MS, maxHeapMb = DEFAULT_MAX_HEAP_MB } = {}) {
  let worker = null
  let seq = 0
  // Jobs run one after another; each waits for the one before it to settle.
  let queue = Promise.resolve()

  function spawn() {
    const w = new Worker(new URL(import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: maxHeapMb },
    })
    // An idle worker must not keep the process alive at shutdown.
    w.unref()
    return w
  }

  function discard(w) {
    if (worker === w) worker = null
    w.terminate().catch(() => {})
  }

  function runOne(buffer, name) {
    return new Promise((resolve) => {
      const w = (worker ??= spawn())
      const id = ++seq
      let settled = false

      const finish = (text, broken) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        w.off('message', onMessage)
        w.off('error', onFailure)
        w.off('exit', onFailure)
        if (broken) discard(w)
        resolve(text)
      }
      const onMessage = (msg) => {
        if (msg?.id === id) finish(typeof msg.text === 'string' ? msg.text : null, false)
      }
      // Out of heap, or crashed: the worker is gone either way.
      const onFailure = () => finish(null, true)
      const timer = setTimeout(() => finish(null, true), timeoutMs)

      w.on('message', onMessage)
      w.on('error', onFailure)
      w.on('exit', onFailure)
      // A copy the worker owns outright, so the caller's buffer is untouched.
      const bytes = new Uint8Array(buffer).buffer
      w.postMessage({ id, bytes, name }, [bytes])
    })
  }

  return {
    extract(buffer, name) {
      const job = queue.then(() => runOne(buffer, name))
      queue = job.catch(() => {})
      return job
    },
    async close() {
      if (worker) await worker.terminate()
      worker = null
    },
  }
}
