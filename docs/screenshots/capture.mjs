// Retakes the editor, tasks, bookmarks and palette README screenshots by
// driving a real browser. The files, projects and activity screenshots show an
// agent's work, so they are taken against a library an agent has filled —
// through /api/v1/mcp — rather than the demo library this script expects.
//
// Pair it with make-demo-library.mjs, which builds the library it shoots. The
// app is served through the *server library* backend on purpose: the disk
// backend needs a folder picker, which is a native dialog no script can drive.
//
//   node docs/screenshots/make-demo-library.mjs /tmp/demo
//   npm run build
//   DECKLE_SERVER_LIBRARY=true DECKLE_LIBRARY_DIR=/tmp/demo \
//     PORT=8099 node server/index.mjs &
//   node docs/screenshots/capture.mjs http://127.0.0.1:8099 docs/screenshots
//
// Needs playwright-core, deliberately not a dependency of this repo: it exists
// for the two occasions a year the screenshots change. Node resolves ESM imports
// from the importing file upwards and ignores NODE_PATH, so it has to be
// reachable from here — the least invasive way is a link into node_modules,
// which is gitignored:
//
//   npm i playwright-core --prefix /tmp/pw
//   ln -sfn /tmp/pw/node_modules/playwright-core node_modules/playwright-core
//
// It drives the Chrome already on your machine rather than downloading its own;
// override the path with CHROME_PATH.

import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:8099'
const outDir = process.argv[3] || 'docs/screenshots'

// 2x of 1360x950 — matches the resolution the originals were taken at, which is
// what keeps the README images crisp on high-DPI screens.
const VIEWPORT = { width: 1360, height: 950 }
const SCALE = 2

const CHROME =
  process.env.CHROME_PATH ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: SCALE,
})

/** Screenshots settle better with a beat after the last interaction. */
const settle = (ms = 450) => page.waitForTimeout(ms)

async function shot(name) {
  // Park the cursor off every control first. Rows and buttons reveal hover
  // affordances — a tree row grows rename and delete icons — and a cursor
  // resting wherever the last click landed puts them in the picture.
  await page.mouse.move(VIEWPORT.width - 4, VIEWPORT.height - 4)
  await settle()
  await page.screenshot({ path: `${outDir}/${name}.png` })
  console.log(`  ✓ ${name}.png`)
}

// ---- Connect to the library -------------------------------------------------

await page.goto(base, { waitUntil: 'networkidle' })

// First load offers a choice of backend when a server library is available.
const serverOption = page.locator('button', { hasText: 'On this server' })
if (await serverOption.count()) {
  await serverOption.first().click()
}
await page.locator('.tree-label', { hasText: 'Welcome' }).first().waitFor()

/**
 * Folders do not all start expanded, so reveal one by its child rather than
 * blind-clicking it — clicking an already-open folder would collapse it.
 */
async function reveal(folder, child) {
  const row = page.locator('.tree-label', { hasText: child })
  if (await row.count()) return
  await page.locator('.tree-label', { hasText: folder }).first().click()
  await row.first().waitFor()
}

await reveal('Projects', 'Product launch plan')
await reveal('Reading', 'Atomic Habits')

// ---- Open the three tabs, left to right -------------------------------------
// Clicking in this order leaves Welcome active, with the other two behind it.

for (const label of ['Product launch plan', 'Atomic Habits', 'Welcome']) {
  await page.locator('.tree-label', { hasText: label }).first().click()
  await settle(300)
}

// The backlinks panel is the point of the first shot; make sure it has resolved.
await page.locator('text=Linked from').first().waitFor({ timeout: 5000 })
await shot('editor')

// ---- Tasks ------------------------------------------------------------------

await page.locator('[aria-label="Tasks"]').click()
await page.locator('button', { hasText: 'Upcoming' }).first().click()
await shot('tasks')

// ---- Bookmarks --------------------------------------------------------------
// The first bookmark is expanded so the comment box is visible — that field is
// the feature the caption is about.

// Inactive tabs show only their icon, so find this one by its name.
await page.locator('.panel-tab[aria-label="Bookmarks"]').click()
await settle(300)
await page.locator('.bm-title').first().click()
await shot('bookmarks')

// ---- Dark mode, for the palette --------------------------------------------

// Dismiss the side panel with its own close button. Clicking the sidebar's
// Tasks icon would only switch the panel back to the tasks tab, leaving it open
// and in shot behind the palette.
await page.locator('[aria-label="Close panel"]').click()
await page.locator('[aria-label="Toggle theme"]').click()
await settle(600)

// ---- Command palette --------------------------------------------------------

await page.keyboard.press('ControlOrMeta+k')
await page.locator('[placeholder^="Type a command"]').waitFor()
await shot('palette')

await browser.close()
console.log('done')
