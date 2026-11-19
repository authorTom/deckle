// The server the browser tests run against: the real Deckle server, serving
// the production build in dist/, with a server library in a fresh temporary
// folder and an API token for playing the agent.

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../server/app.mjs'

export const E2E_PORT = 4319
export const E2E_TOKEN = 'e2e-agent-token-0123456789abcdef'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const libraryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deckle-e2e-'))

const app = createApp({
  DECKLE_SERVER_LIBRARY: 'true',
  DECKLE_LIBRARY_DIR: libraryDir,
  DECKLE_LIBRARY_NAME: 'E2E library',
  DECKLE_PUBLIC_DIR: path.join(root, 'dist'),
  DECKLE_API_TOKENS: `hermes:rw:${E2E_TOKEN}`,
  PORT: String(E2E_PORT),
})
await app.init()
app.server.listen(E2E_PORT, '127.0.0.1', () => app.logStartup())

const stop = async () => {
  app.closeStreams()
  app.server.closeAllConnections?.()
  app.server.close()
  await fs.rm(libraryDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
