import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const TOKEN = 'e2e-agent-token-0123456789abcdef'

/** WCAG 2.1 A and AA, which is the bar Deckle holds itself to. */
async function scan(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes
        .slice(0, 4)
        .map((n) => `${n.target.join(' ')}${v.id === 'color-contrast' ? ` — ${n.any[0]?.message ?? ''}` : ''}`)
        .join('\n    ')}`,
  )
  if (process.env.A11Y_REPORT) console.log(`== ${label}\n${summary.join('\n')}`)
  expect(summary, `${label}\n${summary.join('\n')}`).toEqual([])
}

test.describe('accessibility (axe, WCAG 2.1 AA)', () => {
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`${scheme} mode`, () => {
      test.use({ colorScheme: scheme })

      test('the library gate', async ({ page }) => {
        await page.goto('/')
        await expect(page.getByRole('button', { name: /On this server/ })).toBeVisible()
        await scan(page, 'gate')
      })

      test('a note open, the activity panel, and the compare dialog', async ({ page }) => {
        const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
        const call = (name: string, args: object) =>
          page.request.post('/api/v1/mcp', {
            headers: auth,
            data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
          })
        await call('write_note', { path: `A11y/Contrast ${scheme}.md`, content: '# Check\n\nStatus: one\n\n- [ ] a task' })
        await call('edit_note', { path: `A11y/Contrast ${scheme}.md`, old_text: 'Status: one', new_text: 'Status: two' })

        await page.goto('/')
        await page.getByRole('button', { name: /On this server/ }).click()
        await page.getByRole('textbox', { name: 'Search notes and files' }).fill(`Contrast ${scheme}`)
        await page.getByRole('complementary').getByText(`Contrast ${scheme}`).first().click()
        await expect(page.locator('.ProseMirror').first()).toContainText('Status: two')
        await scan(page, 'note open')

        await page.getByRole('button', { name: /^Activity/ }).click()
        await expect(page.getByRole('button', { name: /^To review/ })).toBeVisible()
        await scan(page, 'activity panel')

        await page.locator('.activity-item').filter({ hasText: 'edited' }).first().getByRole('button', { name: 'Compare' }).click()
        await expect(page.getByRole('dialog', { name: /Changes/ })).toBeVisible()
        await scan(page, 'compare dialog')
      })

      test('the Agents tab, a brief waiting on you, and the New brief dialog', async ({ page }) => {
        const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }
        const call = async (name: string, args: object) => {
          const res = await page.request.post('/api/v1/mcp', {
            headers: auth,
            data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
          })
          return (await res.json()).result.content[0].text as string
        }
        await call('create_project', { name: `A11y briefs ${scheme}`, summary: 'Scanned' })
        await call('create_brief', { project: `A11y briefs ${scheme}`, title: `Waiting ${scheme}`, instructions: 'x', priority: 2 })
        await call('create_brief', { project: `A11y briefs ${scheme}`, title: `Queued ${scheme}`, instructions: 'x', priority: 4 })
        // Take the first and leave it asking a question, so a card is open with an answer to give.
        const taken = await call('next_brief', {})
        expect(taken).toContain(`Waiting ${scheme}`)
        const id = taken.match(/^id: (.+)$/m)![1]
        await call('ask_user', { brief: id, question: 'Which currency?' })

        await page.goto('/')
        await page.getByRole('button', { name: /On this server/ }).click()
        await page.keyboard.press('ControlOrMeta+k')
        await page.getByRole('dialog', { name: 'Command palette' }).getByRole('combobox').fill('agents and briefs')
        await page.keyboard.press('Enter')
        await expect(page.locator('.brief-card', { hasText: `Waiting ${scheme}` }).locator('.brief-question')).toContainText(
          'Which currency?',
        )
        await scan(page, 'agents tab')

        await page.getByRole('button', { name: 'Brief', exact: true }).click()
        await expect(page.getByRole('dialog', { name: 'New brief' })).toBeVisible()
        await scan(page, 'new brief dialog')
      })

      test('the command palette', async ({ page }) => {
        await page.goto('/')
        await page.getByRole('button', { name: /On this server/ }).click()
        await page.keyboard.press('ControlOrMeta+k')
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
        await scan(page, 'palette')
      })
    })
  }

  // Every palette, both ways round: the screen with the most quiet text on it —
  // palette hints, section labels, a selected row, the sidebar's metadata.
  for (const palette of ['deckle', 'slate', 'nord', 'rose', 'forest', 'mono', 'springfield']) {
    for (const theme of ['light', 'dark']) {
      test(`contrast: ${palette} palette, ${theme}`, async ({ page }) => {
        // Chosen the way the app remembers a choice, before it loads.
        await page.addInitScript(
          ([p, t]) => {
            localStorage.setItem('notes-palette', p)
            localStorage.setItem('notes-theme', t)
            localStorage.setItem('notes-unlocked-themes', JSON.stringify(['springfield']))
          },
          [palette, theme],
        )
        await page.goto('/')
        await page.getByRole('button', { name: /On this server/ }).click()
        await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
        await page.keyboard.press('ControlOrMeta+k')
        await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
        await scan(page, `${palette} ${theme}`)
      })
    }
  }
})
