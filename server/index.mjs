// Deckle server entry point: build the app (server/app.mjs), prepare the
// library, listen, and shut down cleanly.
//
// The server library is opt-in: without DECKLE_SERVER_LIBRARY=true this process
// is a pure static file server and the image behaves exactly as it always has.
// That default matters — enabling it implicitly would offer people a library
// that silently disappears with the container unless they also mounted a volume.
//
// Configuration (all optional):
//   PORT                     port to listen on                  (default 8080)
//   DECKLE_SERVER_LIBRARY    "true" enables the server library     (default off)
//   DECKLE_LIBRARY_DIR       directory holding the server library (default /data)
//   DECKLE_STATE_DIR         Deckle's own state, outside the library
//                            (default <DECKLE_LIBRARY_DIR>/.deckle-state)
//   DECKLE_LIBRARY_NAME      display name shown in the app  (default "My Notes")
//   DECKLE_PASSWORD          password gating the library; unset = open access
//   DECKLE_SESSION_SECRET    keeps sessions valid across restarts
//   DECKLE_SESSION_TTL_DAYS  session lifetime                     (default 30)
//   DECKLE_TRUST_PROXY       reverse proxies in front, for client addresses
//                            ("true" = one; a number = that many; default none)
//   DECKLE_API_TOKENS        bearer tokens enabling the /api/v1 machine API
//   DECKLE_API_CORS_ORIGINS  origins allowed to call /api/v1 from a browser
//
// The NIB_* names these replaced are still honoured; see legacy-env.mjs.

import { createApp } from './app.mjs'

let app
try {
  app = createApp(process.env)
} catch (err) {
  console.error(`[deckle] ${err.message}`)
  process.exit(1)
}

const { server, config } = app

try {
  await app.init()
} catch (err) {
  console.error(
    `[deckle] server library directory ${config.libraryDir} is not usable (${err.code || err.message}).`,
  )
  console.error('[deckle] mount a writable volume there, or unset DECKLE_SERVER_LIBRARY.')
  process.exit(1)
}

server.on('error', (err) => {
  console.error(`[deckle] could not listen on port ${config.port}: ${err.message}`)
  process.exit(1)
})

server.listen(config.port, () => app.logStartup())

// Compose runs this with init:true, so SIGTERM arrives on `docker compose down`.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
    // Idle keep-alive sockets would otherwise hold close() open until they
    // time out on their own.
    server.closeIdleConnections?.()
    // Don't let a hung request block the shutdown.
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
