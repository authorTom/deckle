import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import type { Node as PMNode } from '@tiptap/pm/model'

/**
 * GFM pipe tables for `tiptap-markdown`.
 *
 * The library parses markdown tables but has no serializer for them, so a table
 * would round-trip out as a raw `<table>` blob. That's the one thing this app
 * can't do: notes are meant to be plain Markdown that every other editor can
 * read.
 */

/** Minimal view of prosemirror-markdown's serializer state. */
interface SerializerState {
  /** The output buffer being built. Swapped out to capture a cell in isolation. */
  out: string
  renderInline: (node: PMNode) => void
  /** Appends content, first flushing any blank line owed to the previous block. */
  write: (content?: string) => void
  ensureNewLine: () => void
  closeBlock: (node: PMNode) => void
}

/**
 * A cell's inline markdown, marks and all.
 *
 * Rendering inline content normally appends to the shared output buffer; here
 * the buffer is swapped for an empty one so the result can be captured and
 * placed between pipes instead. Escaping the pipes matters — an unescaped one
 * inside a cell would split it into two columns on the way back in.
 */
function cellMarkdown(state: SerializerState, cell: PMNode): string {
  const saved = state.out
  state.out = ''
  cell.forEach((child) => {
    if (child.isTextblock) state.renderInline(child)
  })
  const rendered = state.out
  state.out = saved
  return rendered.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}

function serializeTable(state: SerializerState, node: PMNode) {
  const rows: string[][] = []
  node.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => cells.push(cellMarkdown(state, cell)))
    rows.push(cells)
  })
  if (rows.length === 0) return

  // GFM requires every row to have the same number of columns, and a table
  // with no header row isn't valid at all — so the first row becomes one.
  const columns = Math.max(...rows.map((r) => r.length))
  const pad = (cells: string[]) =>
    `| ${Array.from({ length: columns }, (_, i) => cells[i] ?? '').join(' | ')} |`

  // GFM only recognises a pipe table that starts a line, and won't let one
  // interrupt a paragraph — it needs a blank line ahead of it. The separation
  // is written directly rather than left to `write()`: tiptap-markdown doesn't
  // always leave a pending close for the serializer to flush, so relying on
  // that produced tables welded onto the end of the previous line.
  state.ensureNewLine()
  if (state.out && !state.out.endsWith('\n\n')) state.out += '\n'

  const [header, ...body] = rows
  state.write(pad(header))
  state.ensureNewLine()
  state.write(`|${' --- |'.repeat(columns)}`)
  state.ensureNewLine()
  for (const row of body) {
    state.write(pad(row))
    state.ensureNewLine()
  }
  state.closeBlock(node)
}

export const MarkdownTable = Table.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize: serializeTable,
        // Parsing is already handled: markdown-it turns pipe tables into table
        // HTML, which the node's own parseHTML rules pick up.
        parse: {},
      },
    }
  },
})

/** Rows and cells are written by the table serializer, never on their own. */
const consumedByTable = {
  addStorage() {
    return { markdown: { serialize: () => {}, parse: {} } }
  },
}

export const MarkdownTableRow = TableRow.extend(consumedByTable)
export const MarkdownTableCell = TableCell.extend(consumedByTable)
export const MarkdownTableHeader = TableHeader.extend(consumedByTable)
