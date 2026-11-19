import { expect, test, type Page } from '@playwright/test'

const TOKEN = 'e2e-agent-token-0123456789abcdef'

/** Open the server library from the gate, as a first-time visitor would. */
async function openLibrary(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: /On this server/ }).click()
  await expect(newNoteButton(page)).toBeVisible()
}

/** The sidebar's own; the top bar and the empty state have one too. */
const newNoteButton = (page: Page) => page.getByRole('complementary').getByRole('button', { name: 'New note', exact: true })

/**
 * Start a new note and wait until it is the one open and focused — a fresh
 * session may already have another note open, whose editor would otherwise
 * take the first keystrokes.
 */
async function newNote(page: Page) {
  await newNoteButton(page).click()
  await expect(page.getByRole('textbox', { name: 'File name' })).toHaveValue(/^Untitled/)
  const editor = page.locator('.ProseMirror').first()
  await expect(editor).toHaveText('')
  await expect(editor).toBeFocused()
  return editor
}

/** Call one of Deckle's MCP tools, as an agent would. */
async function mcp(page: Page, name: string, args: Record<string, unknown>) {
  const res = await page.request.post('/api/v1/mcp', {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    data: { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } },
  })
  const body = await res.json()
  expect(body.result?.isError, body.result?.content?.[0]?.text).not.toBe(true)
  return body.result.content[0].text as string
}

async function api(page: Page, path: string) {
  const res = await page.request.get(`/api/v1${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  return await res.json()
}

test('a note typed in the browser is saved to the server library', async ({ page }) => {
  await openLibrary(page)
  await newNote(page)
  await page.keyboard.type('# Browser note')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Written by the end-to-end test.')

  await expect
    .poll(async () => (await api(page, '/search?q=end-to-end')).results?.length ?? 0, { timeout: 10_000 })
    .toBeGreaterThan(0)
  const [hit] = (await api(page, '/search?q=end-to-end')).results
  const note = await api(page, `/notes/${hit.path.split('/').map(encodeURIComponent).join('/')}`)
  expect(note.content).toContain('# Browser note')
  expect(note.content).toContain('Written by the end-to-end test.')
})

test('selecting text shows the bubble menu, and its buttons format the selection', async ({ page }) => {
  await openLibrary(page)
  await newNote(page)
  await page.keyboard.type('make this bold')
  await page.keyboard.press('Shift+Home')
  const bubble = page.locator('.bubble-menu')
  await expect(bubble).toBeVisible()
  await bubble.getByRole('button', { name: /^Bold/ }).click()
  await expect(page.locator('.ProseMirror strong')).toHaveText('make this bold')
  // The toolbar follows the caret: Bold reads as on while it sits in bold text.
  await expect(page.getByRole('toolbar').getByRole('button', { name: /^Bold/ })).toHaveAttribute('aria-pressed', 'true')
})

test('the command palette opens from the keyboard and runs a command', async ({ page }) => {
  await openLibrary(page)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await page.keyboard.type('keyboard shortcuts')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/i })).toBeVisible()
  await page.keyboard.press('Escape')
})

test("an agent's write appears at once, waits for review, and can be compared", async ({ page }) => {
  await openLibrary(page)

  // Live: the app hears about the write over its event stream. Polling alone
  // takes 15 seconds, so seeing it inside 5 proves the stream works.
  await mcp(page, 'write_note', {
    path: 'Agent work/Vendor report.md',
    content: '# Vendor report\n\nStatus: draft\n\nFivetran scored 9.',
    message: 'first draft',
  })
  await expect(page.getByRole('tree', { name: 'Notes' }).getByText('Agent work')).toBeVisible({ timeout: 5_000 })

  await mcp(page, 'edit_note', {
    path: 'Agent work/Vendor report.md',
    old_text: 'Status: draft',
    new_text: 'Status: final',
    message: 'ready for review',
  })

  await page.getByRole('button', { name: /^Activity/ }).click()
  const review = page.getByRole('button', { name: /^To review/ })
  await expect(review).toHaveAttribute('aria-pressed', 'true')
  await expect(review).toHaveText(/To review \(\d+\)/)

  const edited = page.locator('.activity-item', { hasText: 'ready for review' })
  await edited.getByRole('button', { name: 'Compare' }).click()
  const dialog = page.getByRole('dialog', { name: /Changes — Vendor report/ })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.compare-line.removed')).toContainText('Status: draft')
  await expect(dialog.locator('.compare-line.added')).toContainText('Status: final')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await edited.getByRole('button', { name: 'Mark reviewed' }).click()
  await expect(page.locator('.activity-item', { hasText: 'ready for review' })).toHaveCount(0)

  // Reviewed is kept in the library, so it survives a reload — and another device.
  await expect
    .poll(async () => {
      const res = await page.request.get('/api/v1/files/.deckle/review.json', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
      return res.status()
    })
    .not.toBe(404)
})

test('is installable: a manifest, icons and a service worker', async ({ page }) => {
  await page.goto('/')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  const manifest = await (await page.request.get(href!)).json()
  expect(manifest).toMatchObject({ name: 'Deckle', display: 'standalone', start_url: '/' })
  for (const icon of manifest.icons) {
    expect((await page.request.get(icon.src)).status(), icon.src).toBe(200)
  }
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toMatch(/\/$/)
})

test('the folder tree moves a note with the keyboard, no dragging needed', async ({ page }) => {
  await page.request.put('/api/v1/notes/Loose%20note.md', {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: { content: '# Loose note' },
  })
  await openLibrary(page)
  const tree = page.getByRole('tree', { name: 'Notes' })
  const row = tree.getByRole('treeitem', { name: /Loose note/ })
  await row.focus()
  await page.keyboard.press('Alt+KeyM')
  const dialog = page.getByRole('dialog').filter({ hasText: /Move/ })
  await expect(dialog).toBeVisible()
  await page.keyboard.type('Archive/2026')
  await dialog.getByRole('option', { name: /Archive\/2026/ }).click()
  await dialog.getByRole('button', { name: 'Move here' }).click()
  await expect
    .poll(async () => (await page.request.get('/api/v1/notes/Archive/2026/Loose%20note.md', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })).status())
    .toBe(200)
})

test('code blocks are coloured once their languages load, without counting as an edit', async ({ page }) => {
  const note = '# Snippet\n\n```js\nconst answer = 42\n```'
  await page.request.put('/api/v1/notes/Code/Snippet.md', {
    headers: { Authorization: `Bearer ${TOKEN}` },
    data: { content: note },
  })
  const languages: string[] = []
  page.on('request', (r) => {
    if (/\/assets\/languages-/.test(r.url())) languages.push(r.url())
  })
  await openLibrary(page)
  await page.getByRole('textbox', { name: 'Search notes and files' }).fill('Snippet')
  await page.getByRole('complementary').getByText('Snippet').first().click()
  await expect(page.locator('.ProseMirror pre .hljs-keyword').first()).toHaveText('const')
  expect(languages).toHaveLength(1)
  // Colouring in changed no text: nothing unsaved, nothing written.
  await expect(page.locator('.tab-dot')).toHaveCount(0)
  await page.waitForTimeout(1200)
  const saved = await api(page, '/notes/Code/Snippet.md')
  expect(saved.content).toBe(note)
})

test('the first screen does not wait for the editor', async ({ page }) => {
  const scripts: string[] = []
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname)
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: /On this server/ })).toBeVisible()
  expect(scripts.some((s) => /EditorPane-/.test(s))).toBe(false)
  expect(scripts.some((s) => /languages-/.test(s))).toBe(false)
})

