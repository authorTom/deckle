// The Deckle HTTP application: configuration, routing and error handling, with
// nothing happening at import time.
//
// server/index.mjs boots one of these for real; the tests build one per case
// against a temporary directory. Keeping the two apart is what lets the tests
// exercise the exact handler that ships, rather than a copy of it.
//
// Deckle is still a local-first app — by default it stores notes in a folder you
// pick or privately in the browser, and this process is then nothing more than
// a static file server. Enable the server library and the same process also
// offers real .md files living in the container, so the app works from any
// device with no local storage at all.

import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAuth } from './auth.mjs'
import { createApiAuth } from './api-auth.mjs'
import { createApi } from './api.mjs'
import { createSearch } from './search.mjs'
import { createStaticHandler, pipeFile, SECURITY_HEADERS } from './static.mjs'
import { createLibraryApi, TooLargeError } from './library-api.mjs'
import { createLibraryStore } from './library-store.mjs'
import { createSettingsStore, InvalidSettingsError, MAX_SETTINGS_BYTES } from './settings-store.mjs'
import { BadPathError } from './paths.mjs'
import { resolveLegacyEnv } from './legacy-env.mjs'
import { parseTrustProxy } from './throttle.mjs'
import { VERSION } from './version.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))

/** A body that parses as JSON but isn't the object every endpoint expects. */
class InvalidBodyError extends Error {}

function readPort(raw) {
  const port = Number(raw || 8080)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a number between 0 and 65535, got "${raw}"`)
  }
  return port
}

/**
 * Build the application from an environment.
 *
 * Reads configuration through the compatibility shim, never from process.env
 * directly, so a .env written before the rename still configures this server.
 */
export function createApp(rawEnv = process.env, { log = console.log, warn = console.warn } = {}) {
  const { env, honoured: legacyEnv } = resolveLegacyEnv(rawEnv)

  const libraryDir = path.resolve(env.DECKLE_LIBRARY_DIR || '/data')
  const config = {
    port: readPort(env.PORT),
    publicDir: path.resolve(env.DECKLE_PUBLIC_DIR || path.join(here, '..', 'dist')),
    libraryDir,
    libraryName: env.DECKLE_LIBRARY_NAME || 'My Notes',
    libraryEnabled: env.DECKLE_SERVER_LIBRARY === 'true',
    // Deckle's own state — not notes, and not part of the library, but kept
    // under the library directory by default because that is the volume
    // people mount. The library API refuses to serve it wherever it lives.
    stateDir: path.resolve(env.DECKLE_STATE_DIR || path.join(libraryDir, '.deckle-state')),
    trustProxy: parseTrustProxy(env.DECKLE_TRUST_PROXY),
    legacyEnv,
  }

  const auth = createAuth(env)
  const library = createLibraryApi(config.libraryDir, { reservedPaths: [config.stateDir] })
  const settingsStore = createSettingsStore(config.stateDir)

  // Shared assistant settings are offered only behind a password. Without one
  // the API is open by design (the deployment guide assumes a VPN or an
  // authenticating proxy in front), and an open endpoint handing out a provider
  // key is not a trade this server gets to make on the user's behalf.
  const sharedSettings = config.libraryEnabled && auth.required
  const serveStatic = createStaticHandler(config.publicDir)

  // The machine API (/api/v1): off unless tokens are configured, and useless
  // without the server library, since a local-folder library never reaches this
  // process at all.
  const apiAuth = createApiAuth(env, warn)
  const handleApi = createApi({
    library,
    store: createLibraryStore(library),
    search: createSearch(library),
    auth: apiAuth,
    libraryEnabled: config.libraryEnabled,
    libraryName: config.libraryName,
    corsOrigins: (env.DECKLE_API_CORS_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  })

  function sendJson(res, status, body, extraHeaders = {}) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
      ...extraHeaders,
    })
    res.end(payload)
  }

  async function readJsonBody(req, limit = 4096) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) throw new TooLargeError('body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    // `null` is valid JSON, and `body.password` on it used to be a 500.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new InvalidBodyError('body must be a JSON object')
    }
    return parsed
  }

  /**
   * Second CSRF layer behind the SameSite=Strict cookie: a custom header the
   * browser will only send same-origin, because we serve no CORS headers so any
   * cross-origin preflight fails. A form post or img tag from another site can't
   * set it.
   */
  function hasAppHeader(req) {
    return req.headers['x-deckle-app'] === '1'
  }

  // ---- /api/server-library ---------------------------------------------------

  async function handleServerLibraryRoutes(req, res, url) {
    if (url.pathname === '/api/server-library' && req.method === 'GET') {
      sendJson(res, 200, {
        enabled: config.libraryEnabled,
        name: config.libraryName,
        authRequired: auth.required,
        authenticated: config.libraryEnabled && auth.isAuthenticated(req),
        // Whether this server will hold the assistant's settings for every
        // device, so the app can say why it won't when it won't.
        sharedSettings,
      })
      return true
    }

    if (url.pathname === '/api/server-library/login' && req.method === 'POST') {
      if (!config.libraryEnabled) {
        sendJson(res, 404, { error: 'server library disabled' })
        return true
      }
      if (!hasAppHeader(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return true
      }
      if (!auth.required) {
        sendJson(res, 200, { ok: true })
        return true
      }
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, 400, { error: 'invalid request' })
        return true
      }
      const result = auth.login(req, body.password)
      if (result.error === 'throttled') {
        sendJson(
          res,
          429,
          { error: 'Too many attempts. Try again in a few minutes.' },
          { 'Retry-After': '900' },
        )
        return true
      }
      if (result.error) {
        sendJson(res, 401, { error: 'Incorrect password.' })
        return true
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': result.cookie })
      return true
    }

    if (url.pathname === '/api/server-library/logout' && req.method === 'POST') {
      // Same gate as every other state-changing call. Without it any page on
      // the web could sign a user out with a form post.
      if (!hasAppHeader(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return true
      }
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': auth.logoutCookie(req) })
      return true
    }

    return false
  }

  // ---- /api/assistant-settings -----------------------------------------------

  /**
   * The assistant's settings, shared by every device signed in to this server.
   *
   * Gated exactly like the library routes — same-origin app header, then the
   * session cookie — plus the password requirement above. The stored object is
   * whatever the app sent; this endpoint is a shelf, not a schema.
   */
  async function handleAssistantSettingsRoutes(req, res, url) {
    if (url.pathname !== '/api/assistant-settings') return false

    if (!config.libraryEnabled) {
      sendJson(res, 404, { error: 'server library disabled' })
      return true
    }
    if (!hasAppHeader(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return true
    }
    if (!sharedSettings) {
      sendJson(res, 409, {
        error: 'password_required',
        message:
          'Set DECKLE_PASSWORD to share assistant settings between devices. ' +
          'Without it this server is open, and anyone who can reach it could read the key.',
      })
      return true
    }
    if (!auth.isAuthenticated(req)) {
      sendJson(res, 401, { error: 'not authenticated' })
      return true
    }

    if (req.method === 'GET') {
      sendJson(res, 200, { settings: await settingsStore.read() })
      return true
    }

    if (req.method === 'PUT') {
      let body
      try {
        body = await readJsonBody(req, MAX_SETTINGS_BYTES)
      } catch (err) {
        if (err instanceof TooLargeError) throw err
        sendJson(res, 400, { error: 'invalid request' })
        return true
      }
      try {
        await settingsStore.write(body.settings)
      } catch (err) {
        if (err instanceof InvalidSettingsError) {
          sendJson(res, 400, { error: err.message })
          return true
        }
        throw err
      }
      sendJson(res, 200, { ok: true })
      return true
    }

    sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  // ---- /api/library ----------------------------------------------------------

  async function handleLibraryRoutes(req, res, url) {
    if (!url.pathname.startsWith('/api/library/')) return false

    if (!config.libraryEnabled) {
      sendJson(res, 404, { error: 'server library disabled' })
      return true
    }
    if (!hasAppHeader(req)) {
      sendJson(res, 403, { error: 'forbidden' })
      return true
    }
    if (!auth.isAuthenticated(req)) {
      sendJson(res, 401, { error: 'not authenticated' })
      return true
    }

    const rel = url.searchParams.get('path') ?? ''
    const route = `${req.method} ${url.pathname}`

    switch (route) {
      case 'GET /api/library/tree':
        sendJson(res, 200, { tree: await library.tree(rel) })
        return true

      case 'GET /api/library/list':
        sendJson(res, 200, { entries: await library.list(rel) })
        return true

      case 'GET /api/library/stat':
        sendJson(res, 200, await library.stat(rel))
        return true

      case 'GET /api/library/file': {
        const { handle, size, lastModified } = await library.openForRead(rel)
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          // Notes can hold anything; never let a browser render one inline.
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment',
          'Cache-Control': 'no-store',
          'Content-Length': size,
          'X-Last-Modified': String(lastModified),
        })
        pipeFile(res, handle)
        return true
      }

      case 'PUT /api/library/file': {
        const declared = Number(req.headers['content-length'] || 0)
        if (declared > library.maxFileBytes) {
          sendJson(res, 413, { error: 'file too large' })
          return true
        }
        sendJson(res, 200, await library.writeFile(rel, req))
        return true
      }

      case 'POST /api/library/dir':
        await library.mkdir(rel)
        sendJson(res, 200, { ok: true })
        return true

      case 'DELETE /api/library/entry':
        await library.remove(rel, url.searchParams.get('recursive') === '1')
        sendJson(res, 200, { ok: true })
        return true

      default:
        sendJson(res, 404, { error: 'unknown endpoint' })
        return true
    }
  }

  // ---- Dispatch --------------------------------------------------------------

  function handler(req, res) {
    void (async () => {
      let url
      try {
        url = new URL(req.url, 'http://localhost')
      } catch {
        sendJson(res, 400, { error: 'bad request' })
        return
      }

      try {
        // The machine API comes first: it authenticates by bearer token and must
        // never be reachable with the app's session cookie.
        if (await handleApi(req, res, url)) return
        if (await handleServerLibraryRoutes(req, res, url)) return
        if (await handleAssistantSettingsRoutes(req, res, url)) return
        if (await handleLibraryRoutes(req, res, url)) return

        if (url.pathname.startsWith('/api/')) {
          sendJson(res, 404, { error: 'unknown endpoint' })
          return
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { error: 'method not allowed' })
          return
        }
        await serveStatic(req, res, url.pathname)
      } catch (err) {
        if (res.headersSent) {
          // Nothing left to say with a status; don't leave the client waiting.
          res.destroy()
          return
        }
        // ENOENT is the normal "this note doesn't exist yet" answer to a stat or
        // read, and the client adapter turns a 404 into the NotFoundError the
        // File System Access API would have thrown. ENOTDIR is the same answer
        // for a path that runs *through* a file ("a.md/b.md").
        if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
          sendJson(res, 404, { error: 'not found' })
          return
        }
        if (err instanceof BadPathError) {
          sendJson(res, 400, { error: err.message })
          return
        }
        if (err && err.code === 'ENAMETOOLONG') {
          sendJson(res, 400, { error: 'name too long' })
          return
        }
        if (err instanceof TooLargeError) {
          sendJson(res, 413, { error: 'too large' })
          return
        }
        if (err && (err.code === 'ENOTEMPTY' || err.code === 'EEXIST')) {
          sendJson(res, 409, { error: err.code })
          return
        }
        if (err && (err.code === 'ENOTFILE' || err.code === 'EISDIR')) {
          sendJson(res, 409, { error: 'not a file' })
          return
        }
        if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
          sendJson(res, 500, { error: 'the library directory is not readable or writable' })
          return
        }
        console.error('[deckle] request failed:', req.method, url.pathname, err)
        sendJson(res, 500, { error: 'internal error' })
      }
    })()
  }

  const server = http.createServer(handler)

  /** Create the library directory, and prove it is writable. */
  async function init() {
    if (config.libraryEnabled) await library.init()
  }

  function logStartup() {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : config.port
    // First line, before anything else: whoever is reading these logs is usually
    // reading them because something is wrong, and the first question is always
    // which build this is.
    log(`[deckle] Deckle ${VERSION}`)
    log(`[deckle] listening on http://0.0.0.0:${port}`)
    log(`[deckle] serving ${config.publicDir}`)

    // Say so loudly rather than quietly working: these names will stop being
    // read eventually, and the deployment's .env is the thing to update.
    for (const pair of config.legacyEnv) {
      log(`[deckle] using deprecated config name ${pair} — please rename it in your .env`)
    }

    if (config.libraryEnabled) {
      log(`[deckle] server library: ${config.libraryDir} (${config.libraryName})`)
      log(
        auth.required
          ? '[deckle] server library is password protected'
          : '[deckle] WARNING: server library has no password (DECKLE_PASSWORD unset) — anyone who can reach this port can read and write your notes',
      )
      log(
        sharedSettings
          ? `[deckle] assistant settings shared across devices, stored in ${config.stateDir}`
          : '[deckle] assistant settings stay in each browser (sharing them needs DECKLE_PASSWORD)',
      )
    } else {
      log('[deckle] server library disabled (set DECKLE_SERVER_LIBRARY=true to enable)')
    }

    log(
      config.trustProxy
        ? `[deckle] trusting ${config.trustProxy} reverse ${config.trustProxy === 1 ? 'proxy' : 'proxies'} for client addresses (DECKLE_TRUST_PROXY)`
        : '[deckle] sign-in throttling uses the connecting address; set DECKLE_TRUST_PROXY=true behind a reverse proxy',
    )

    if (!apiAuth.enabled) {
      log('[deckle] API disabled (set DECKLE_API_TOKENS to enable /api/v1)')
    } else if (!config.libraryEnabled) {
      log(
        '[deckle] WARNING: API tokens are set but the server library is off — /api/v1 has no library to serve',
      )
    } else {
      log(`[deckle] API enabled at /api/v1 — tokens: ${apiAuth.describe().join(', ')}`)
    }
  }

  return { server, handler, config, init, logStartup }
}
