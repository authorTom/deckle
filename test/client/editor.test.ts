// @vitest-environment jsdom
//
// Notes are files other editors read, so what the editor writes back must be
// the Markdown it was given. This builds the editor exactly as the app does
// (src/editor/extensions.ts) and round-trips the constructs agents and people
// actually write — the guard that catches an editor upgrade quietly changing
// the bytes on disk.

import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import { editorExtensions } from '../../src/editor/extensions'
import { serialize } from '../../src/editor/markdown'

const editors: Editor[] = []
afterEach(() => {
  while (editors.length) editors.pop()!.destroy()
})

function roundTrip(markdown: string): string {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions({
      resolveImage: async () => null,
      resolveWikilink: () => null,
      onOpenWikilink: () => {},
    }),
    content: '',
  })
  editors.push(editor)
  editor.commands.setContent(markdown, { emitUpdate: false })
  return serialize(editor as unknown as Parameters<typeof serialize>[0])
}

/** Each of these must come back exactly as written. */
const STABLE: [string, string][] = [
  ['headings and paragraphs', '# Title\n\n## Section\n\nA paragraph with **bold**, *italic*, `code` and ~~struck~~ text.'],
  ['links', 'See [the docs](https://example.com/docs) for more.'],
  ['wikilinks, to notes and files', 'Linked to [[Research notes]] and [[Q3 report.pdf]] and [[Plan|the plan]].'],
  ['bullet and ordered lists', '- one\n- two\n  - nested\n\n1. first\n2. second'],
  ['a fenced code block with a language', '```ts\nconst x: number = 1\n```'],
  ['a blockquote', '> quoted text'],
  ['an image from the library', '![Revenue](charts/revenue.png)'],
  ['a horizontal rule', 'above\n\n---\n\nbelow'],
]

describe('the editor round-trips Markdown', () => {
  for (const [name, markdown] of STABLE) {
    it(name, () => {
      expect(roundTrip(markdown)).toBe(markdown)
    })
  }

  // Two long-standing quirks, pinned so a change to either is a decision
  // rather than an accident: both read the same in every Markdown renderer.
  it('writes task items as a loose list (a blank line between items)', () => {
    expect(roundTrip('- [ ] open task\n- [x] done task')).toBe('- [ ] open task\n\n- [x] done task')
  })

  it('writes a pipe table with a trailing newline', () => {
    const table = '| Vendor | Score |\n| --- | --- |\n| Fivetran | 9 |\n| Airbyte | 7 |'
    expect(roundTrip(table)).toBe(`${table}\n`)
  })

  it('keeps a table separated from the paragraph before it', () => {
    const out = roundTrip('Intro line\n\n| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(out).toContain('Intro line\n\n| a | b |')
  })

  it('escapes a pipe inside a table cell rather than splitting the column', () => {
    const out = roundTrip('| a | b |\n| --- | --- |\n| x \\| y | 2 |')
    expect(out).toContain('x \\| y')
  })
})
