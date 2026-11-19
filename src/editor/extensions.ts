import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { Markdown } from 'tiptap-markdown'
import { Wikilink } from './wikilink'
import { LazyHighlight, lowlight } from './highlight'
import { LibraryImage } from './image'
import {
  MarkdownTable,
  MarkdownTableCell,
  MarkdownTableHeader,
  MarkdownTableRow,
} from './markdownTable'

export interface EditorExtensionOptions {
  /** Turn an image `src` from the Markdown into something an <img> can load. */
  resolveImage: (src: string) => Promise<string | null>
  /** Note id for a `[[target]]`, or null when nothing matches. */
  resolveWikilink: (target: string) => string | null
  onOpenWikilink: (id: string) => void
}

/**
 * Everything the note editor is made of, in one place — so the editor pane
 * and the tests that prove Markdown round-trips build exactly the same one.
 */
export function editorExtensions({ resolveImage, resolveWikilink, onOpenWikilink }: EditorExtensionOptions) {
  return [
    // StarterKit 3 bundles Link and Underline; Link is configured below
    // instead, and Underline left out — Markdown has no way to write it.
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, codeBlock: false, link: false, underline: false }),
    Placeholder.configure({ placeholder: 'Start writing…' }),
    Markdown.configure({ linkify: true, breaks: true, transformPastedText: true }),
    Link.configure({ openOnClick: true, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    MarkdownTable.configure({ resizable: true }),
    MarkdownTableRow,
    MarkdownTableHeader,
    MarkdownTableCell,
    CodeBlockLowlight.configure({ lowlight }),
    LazyHighlight,
    LibraryImage.configure({ resolve: resolveImage }),
    Wikilink.configure({ resolve: resolveWikilink, onOpen: onOpenWikilink }),
  ]
}
