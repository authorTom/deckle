import { defineConfig } from '@playwright/test'

// Browser tests: the production build, served by the real server with a
// server library, driven in Chrome. Run with `npm run test:e2e`, which builds
// first. Uses the installed Chrome rather than downloading a browser.
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: '*.spec.ts',
  // One library shared by every test, so one at a time.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4319',
    channel: 'chrome',
    // Animations off: a scan or a click mid-fade sees a half-drawn page.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node test/e2e/serve.mjs',
    url: 'http://127.0.0.1:4319/api/server-library',
    reuseExistingServer: false,
    timeout: 20_000,
  },
})
