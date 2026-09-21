import Image from '@tiptap/extension-image'

/**
 * Images in notes, including images stored in the library itself.
 *
 * Without an image node the editor quietly dropped every `![alt](src)` it
 * loaded, so the next save deleted the reference from the file — and agents
 * write images into notes all the time (`![Revenue](charts/revenue.png)`).
 *
 * The node keeps `src` exactly as it was written, so the Markdown on disk never
 * changes; only the `<img>` on screen is pointed somewhere loadable. A web or
 * data URL is used as it is. A library path — relative to the note, or from
 * the library root with a leading `/` — is read through the library and shown
 * from a blob URL, because a local folder or in-browser library has no URL of
 * its own, and the server library's file API refuses to render anything inline.
 */
export interface LibraryImageOptions {
  /** Turn a `src` from the Markdown into something an <img> can load, or null. */
  resolve: (src: string) => Promise<string | null>
}

const LOADABLE = /^(https?:|data:image\/|blob:)/i

export const LibraryImage = Image.extend<LibraryImageOptions & Record<string, unknown>>({
  addOptions() {
    return {
      ...this.parent?.(),
      inline: true,
      allowBase64: true,
      HTMLAttributes: {},
      resolve: async () => null,
    }
  },

  addNodeView() {
    return ({ node }) => {
      const img = document.createElement('img')
      img.className = 'note-image'
      img.alt = node.attrs.alt ?? ''
      if (node.attrs.title) img.title = node.attrs.title
      img.draggable = false
      const src: string = node.attrs.src ?? ''

      if (LOADABLE.test(src)) {
        img.src = src
      } else {
        img.classList.add('loading')
        void this.options.resolve(src).then((url) => {
          img.classList.remove('loading')
          if (url) img.src = url
          else {
            img.classList.add('missing')
            img.title = `Not found in the library: ${src}`
          }
        })
      }
      return { dom: img }
    }
  },
})

/**
 * Where a note's image `src` points inside the library, or null when it points
 * outside it. `src` is relative to the note's folder unless it starts with `/`.
 */
export function libraryPathFor(src: string, noteId: string): string | null {
  let path = src.split(/[?#]/)[0]
  try {
    path = decodeURI(path)
  } catch {
    // Not percent-encoded after all — use it as written.
  }
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null
  const base = path.startsWith('/')
    ? []
    : noteId.split('/').slice(0, -1)
  const segments = [...base]
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!segments.length) return null
      segments.pop()
    } else segments.push(part)
  }
  return segments.length ? segments.join('/') : null
}
