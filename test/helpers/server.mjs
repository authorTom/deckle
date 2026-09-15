// Start the real Deckle application against a temporary library and a stub
// SPA bundle, on an ephemeral port.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../../server/app.mjs'

export const APP = { 'X-Deckle-App': '1' }

/** A long enough asset to be worth gzipping. */
const ASSET = `console.log(${JSON.stringify('deckle '.repeat(400))})\n`

export async function makeTempDir(prefix = 'deckle-test-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function startServer(env = {}) {
  const root = await makeTempDir()
  const libraryDir = path.join(root, 'library')
  const publicDir = path.join(root, 'public')
  await fs.mkdir(path.join(publicDir, 'assets'), { recursive: true })
  await fs.writeFile(path.join(publicDir, 'index.html'), '<!doctype html><title>Deckle</title>')
  await fs.writeFile(path.join(publicDir, 'assets', 'app-abc123.js'), ASSET)

  const logs = []
  const app = createApp(
    {
      DECKLE_SERVER_LIBRARY: 'true',
      DECKLE_LIBRARY_DIR: libraryDir,
      DECKLE_PUBLIC_DIR: publicDir,
      PORT: '0',
      ...env,
    },
    { log: (line) => logs.push(line), warn: (line) => logs.push(line) },
  )
  await app.init()
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve))
  const { port } = app.server.address()
  const base = `http://127.0.0.1:${port}`

  return {
    app,
    base,
    root,
    libraryDir,
    publicDir,
    logs,
    /** fetch against this server, with a path rather than a URL. */
    fetch: (pathname, init) => fetch(`${base}${pathname}`, init),
    async close() {
      app.server.closeAllConnections?.()
      await new Promise((resolve) => app.server.close(resolve))
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

/** A cookie header value from a login response. */
export function cookieFrom(res) {
  const header = res.headers.get('set-cookie')
  return header ? header.split(';')[0] : ''
}
