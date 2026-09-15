import { defineConfig } from 'vitest/config'
import pkg from './package.json' with { type: 'json' }

// Tests live in test/, outside src/, so the app's own type-check (tsc -b) never
// has to know about Node's APIs or the test runner.
//
//   test/server/  the container's server, driven through its real HTTP handler
//   test/client/  the app's library, storage, AI tooling and hooks
//
// Most files run in Node. The React hook tests opt into jsdom per file.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ['test/**/*.test.{ts,tsx,mjs}'],
    environment: 'node',
    restoreMocks: true,
    testTimeout: 15_000,
  },
})
