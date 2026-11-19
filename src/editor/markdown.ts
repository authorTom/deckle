import type { Editor } from '@tiptap/react'
import type { MarkdownStorage } from 'tiptap-markdown'

/**
 * `[[Target]]` written as literal text, after ProseMirror's escaping.
 *
 * prosemirror-markdown escapes `[` and `]` in text nodes so they can't be
 * mistaken for link syntax on the way back in. Correct in general, but it turns
 * a wikilink into `\[\[Target\]\]` on disk — which no other editor recognises
 * and our own backlink scanner doesn't match.
 */
const ESCAPED_WIKILINK = /\\\[\\\[([^\n]*?)\\\]\\\]/g

/** Undo that escaping, so the file on disk holds real `[[wikilinks]]`. */
export function unescapeWikilinks(markdown: string): string {
  return markdown.replace(ESCAPED_WIKILINK, '[[$1]]')
}

/**
 * The editor's document as the markdown we actually persist.
 *
 * Everything that serialises — autosave, the compare-with-disk guard, the
 * "download a copy" action — goes through here, so all three agree on the exact
 * bytes. Any divergence would make the guard think the document had changed and
 * reset the cursor on every keystroke.
 */
export function serialize(editor: Editor): string {
  // tiptap-markdown doesn't declare its storage on TipTap 3's Storage type.
  const storage = editor.storage as unknown as { markdown: MarkdownStorage }
  return unescapeWikilinks(storage.markdown.getMarkdown())
}
