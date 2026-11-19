import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // package.json is the one place the version is written; the app and the
  // server both read it from there, so a release can never ship a number that
  // disagrees with itself. Baked in at build time — the browser has no
  // package.json to read at runtime.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    // The one chunk over Vite's 500 kB default is the editor, which loads on
    // demand (see Workspace.tsx); the first screen needs well under half that.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        // React changes far less often than the app; in a chunk of its own it
        // stays cached across releases. The editor needs no rule: it is
        // loaded on demand, so Rollup already gives it chunks of its own.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
        },
      },
    },
  },
  server: {
    // The server library lives behind /api. Vite doesn't serve it, so proxy to a
    // locally running `node server/index.mjs` (DECKLE_SERVER_LIBRARY=true) to work on
    // that backend with hot reload. Without one running, the proxy just fails and
    // the app falls back to offering only the local folder / in-browser libraries.
    proxy: {
      '/api': {
        target: process.env.DECKLE_API_TARGET || 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
})
