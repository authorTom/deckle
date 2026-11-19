// Syntax highlighting for code blocks, with the languages loaded on demand.
//
// highlight.js's common grammars are the single largest thing the editor
// carries — larger than ProseMirror's view — and most notes have no code in
// them at all. So the editor starts with an empty highlighter, and the
// grammars are fetched the first time a note with a code block is open. When
// they arrive, every open editor's code blocks are coloured in place.

import { Extension, type Editor } from '@tiptap/core'
import { createLowlight } from 'lowlight'

/** One highlighter for every editor; languages are registered into it once. */
export const lowlight = createLowlight()

/**
 * Set on the transaction that re-colours code blocks once the languages are
 * in. It changes no text, so the pane must not treat it as an edit.
 */
export const REHIGHLIGHT_META = 'deckle-rehighlight'

let loading: Promise<void> | null = null
let loaded = false
const waiting = new Set<Editor>()

function hasCodeBlock(editor: Editor): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (found) return false
    if (node.type.name === 'codeBlock') found = true
    return !found
  })
  return found
}

/** Re-mark each code block, which makes the highlighter recompute its colours. */
function rehighlight(editor: Editor) {
  if (editor.isDestroyed) return
  const { tr } = editor.state
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') tr.setNodeMarkup(pos, undefined, node.attrs)
  })
  if (!tr.docChanged) return
  tr.setMeta('addToHistory', false).setMeta(REHIGHLIGHT_META, true)
  editor.view.dispatch(tr)
}

function loadLanguages(): Promise<void> {
  loading ??= import('./languages').then(
    ({ common }) => {
      lowlight.register(common)
      loaded = true
      for (const editor of waiting) rehighlight(editor)
      waiting.clear()
    },
    (err: unknown) => {
      // Offline, say. Code stays readable, just uncoloured; try again next time.
      console.warn('[deckle] code highlighting unavailable:', err)
      loading = null
    },
  )
  return loading
}

/** Fetch the grammars when an editor first holds a code block. */
export const LazyHighlight = Extension.create({
  name: 'lazyHighlight',
  onCreate() {
    this.editor.on('update', () => check(this.editor))
    check(this.editor)
  },
  onDestroy() {
    waiting.delete(this.editor)
  },
})

function check(editor: Editor) {
  if (loaded || waiting.has(editor) || !hasCodeBlock(editor)) return
  waiting.add(editor)
  void loadLanguages()
}
