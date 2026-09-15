// Static serving for the built SPA.
//
// This replaces the nginx config the image used to ship, with the same policy:
// content-hashed files under /assets are cached forever, everything else is
// revalidated so a new deployment takes effect on the next load, unknown paths
// fall back to index.html for client-side routing, and the security header
// trio is set on every response.

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const gzip = promisify(zlib.gzip)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const COMPRESSIBLE = /^(text\/|application\/(javascript|json)|image\/svg)/
const GZIP_MIN_BYTES = 1024

/**
 * What the page may load and run.
 *
 * The point is `script-src 'self'`: the app keeps provider API keys in
 * localStorage and can read and write the whole library, so a script that got
 * into the page by any route — a note, a bookmark, a dependency bug — must not
 * be able to run. Everything else is as open as the app genuinely needs:
 *
 *   - connect-src allows any http(s) origin, because the browser calls the AI
 *     provider directly and LM Studio lives at whatever URL the user typed —
 *     usually http://localhost or a LAN address.
 *   - style-src allows inline styles, which the editor and React set freely.
 *   - frame-ancestors replaces X-Frame-Options for browsers that know it.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: http:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
}

/**
 * Stream an already-open file into a response whose headers are written.
 *
 * Through `pipeline`, never a bare `.pipe()`: a read stream that errors with no
 * listener throws, and an uncaught throw there ends the process for every
 * user. By this point a status has gone out, so the only honest answer left is
 * to cut the response short — a truncated body, not a hang.
 */
export function pipeFile(res, handle) {
  pipeline(handle.createReadStream(), res).catch((err) => {
    // The client closing the tab mid-download is routine, not worth a log line.
    if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('[deckle] file stream failed:', err?.message ?? err)
    }
    res.destroy()
  })
}

export function createStaticHandler(publicDir) {
  // Compressed copies of small text assets, keyed by path + mtime. The asset
  // set is fixed at image build time, so this fills once and stays warm.
  const gzipCache = new Map()

  async function resolveFile(urlPath) {
    // Reject traversal before touching the filesystem. path.normalize on the
    // decoded URL collapses any "..", and the result must stay under publicDir.
    let decoded
    try {
      decoded = decodeURIComponent(urlPath)
    } catch {
      return null
    }
    if (decoded.includes('\0')) return null

    const abs = path.join(publicDir, path.normalize(decoded))
    if (abs !== publicDir && !abs.startsWith(publicDir + path.sep)) return null

    try {
      const stat = await fs.stat(abs)
      if (stat.isFile()) return { abs, stat }
      if (stat.isDirectory()) {
        const index = path.join(abs, 'index.html')
        const indexStat = await fs.stat(index)
        if (indexStat.isFile()) return { abs: index, stat: indexStat }
      }
    } catch {
      // Falls through to the SPA fallback.
    }
    return null
  }

  return async function serveStatic(req, res, urlPath) {
    let file = await resolveFile(urlPath)
    let isFallback = false

    if (!file) {
      // A missing file under /assets is a genuine 404 — serving index.html for
      // a stale hashed asset would hand the browser HTML where it expects JS.
      if (urlPath.startsWith('/assets/')) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }
      file = await resolveFile('/index.html')
      isFallback = true
      if (!file) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
        res.end('Not found')
        return
      }
    }

    const ext = path.extname(file.abs).toLowerCase()
    const type = MIME[ext] || 'application/octet-stream'
    const immutable = !isFallback && urlPath.startsWith('/assets/')

    const headers = {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Cache-Control': immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': file.stat.size })
      res.end()
      return
    }

    const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '')
    if (acceptsGzip && COMPRESSIBLE.test(type) && file.stat.size >= GZIP_MIN_BYTES) {
      const key = `${file.abs}:${file.stat.mtimeMs}`
      let body = gzipCache.get(key)
      if (!body) {
        body = await gzip(await fs.readFile(file.abs))
        gzipCache.set(key, body)
      }
      res.writeHead(200, {
        ...headers,
        'Content-Encoding': 'gzip',
        'Content-Length': body.length,
        Vary: 'Accept-Encoding',
      })
      res.end(body)
      return
    }

    // Opened before the status goes out, so a file that disappeared or can't
    // be read is still a clean 404 rather than a 200 with a broken body.
    let handle
    try {
      handle = await fs.open(file.abs, 'r')
    } catch {
      res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    res.writeHead(200, { ...headers, 'Content-Length': file.stat.size })
    pipeFile(res, handle)
  }
}
