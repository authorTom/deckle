/** Coerce user input into a valid http(s) URL, or null if it isn't one. */
export function normalizeUrl(raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(candidate)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
  } catch {
    return null
  }
}

/**
 * A bookmark's URL if it is safe to put in an `href`, otherwise undefined.
 *
 * Bookmarks added in the app are normalised to http(s) on the way in, but the
 * file they live in is a JSON file in the user's folder — synced, shared,
 * edited by hand — and React renders a `javascript:` href as written. One click
 * on such a link would run script with the app's access to the whole library.
 */
export function safeHttpUrl(url: string): string | undefined {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

/** Display domain, e.g. "https://www.amazon.co.uk/dp/X" → "amazon.co.uk". */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** First URL-looking token in a piece of text (trailing punctuation trimmed). */
export function findUrl(text: string): string | null {
  const m = text.match(/(https?:\/\/|www\.)[^\s<>()"']+/i)
  return m ? m[0].replace(/[.,;:!?]+$/, '') : null
}
