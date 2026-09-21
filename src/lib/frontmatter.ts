// A deliberately small YAML front-matter reader and editor.
//
// Mirrors server/frontmatter.mjs — the server has no dependencies and can't
// import this, so the two must agree on what a front-matter block is. Change
// them together.
//
// Agents write front matter freely (Hermes, Obsidian and most static-site
// tools all do), so Deckle has to carry it without damage: the editor shows it
// as a properties strip and never lets ProseMirror near it, because a `---`
// fence parsed as Markdown becomes a rule and a heading and is gone on the next
// save. What this *reads* is a flat block of `key: value` pairs — strings,
// numbers, booleans, and lists bracketed or as indented `- item` lines. What it
// *edits* it edits line by line, so YAML it doesn't understand survives.

export type FrontmatterValue = string | number | boolean | string[]

const FENCE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/**
 * The front-matter block at the top of `text`, if there is one. A note that
 * merely opens with a horizontal rule (`---`, some text, `---`) has none: the
 * block must start with a `key:` line, as YAML front matter always does.
 */
function matchFence(text: string): RegExpExecArray | null {
  const match = FENCE.exec(text)
  if (!match) return null
  const first = match[1].split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#'))
  return first !== undefined && /^[A-Za-z0-9_][\w .-]*:(\s|$)/.test(first) ? match : null
}

function unquote(value: string): string {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.replace(/^"|"$/g, '')
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function parseValue(raw: string): FrontmatterValue {
  const value = raw.trim()
  if (!value) return ''
  if (value.startsWith('[')) {
    return value
      .slice(1, value.endsWith(']') ? -1 : undefined)
      .split(',')
      .map((s) => unquote(s.trim()))
      .filter(Boolean)
  }
  if (value.startsWith('"') || value.startsWith("'")) return unquote(value)
  if (value === 'true') return true
  if (value === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value
}

/**
 * Split a document into its front-matter block (fences included, or '' when
 * there is none) and the Markdown beneath it, verbatim.
 */
export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  const match = matchFence(text)
  if (!match) return { frontmatter: '', body: text }
  return { frontmatter: match[0], body: text.slice(match[0].length) }
}

/**
 * Put a front-matter block back above a body — one blank line between them,
 * which is how the editor always writes it, whatever the file had before.
 */
export function joinFrontmatter(frontmatter: string, body: string): string {
  if (!frontmatter) return body
  const block = frontmatter.endsWith('\n') ? frontmatter : `${frontmatter}\n`
  return `${block}\n${body.replace(/^\s*\n/, '')}`
}

/** The key/value pairs in a document's front matter ({} when it has none). */
export function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  const match = matchFence(text)
  if (!match) return {}
  const data: Record<string, FrontmatterValue> = {}
  const lines = match[1].split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Only top-level keys; indented lines belong to the key above them.
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim()
    const rest = line.slice(colon + 1)
    if (!rest.trim()) {
      // A block list: `key:` followed by indented `- item` lines.
      const items: string[] = []
      while (i + 1 < lines.length && /^\s+-\s/.test(lines[i + 1])) {
        items.push(unquote(lines[++i].replace(/^\s+-\s+/, '').trim()))
      }
      data[key] = items.length ? items.filter(Boolean) : ''
      continue
    }
    data[key] = parseValue(rest)
  }
  return data
}

function serializeScalar(value: string): string {
  const needsQuotes =
    value === '' ||
    value !== value.trim() ||
    /^[[\]{}"'#&*!|>%@`,-]/.test(value) ||
    value.includes(': ') ||
    value.includes(' #') ||
    value.includes(',') ||
    value.includes('\n') ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value)
  return needsQuotes ? JSON.stringify(value) : value
}

function serializeValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) return `[${value.map((v) => serializeScalar(String(v))).join(', ')}]`
  if (typeof value !== 'string') return String(value)
  return serializeScalar(value)
}

/**
 * Set (or, with `undefined`, remove) top-level keys in a document's front
 * matter, creating the block if there isn't one. Every other line — other
 * keys, comments, nested YAML — is kept as written, in its place.
 */
export function setFrontmatterFields(
  text: string,
  patch: Record<string, FrontmatterValue | undefined>,
): string {
  const match = matchFence(text)
  const lines = match ? match[1].split(/\r?\n/) : []
  const body = match ? text.slice(match[0].length) : text
  const pending = new Map(Object.entries(patch))

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const colon = line.indexOf(':')
    const key = !/^\s/.test(line) && colon > 0 ? line.slice(0, colon).trim() : null
    if (key === null || !pending.has(key)) {
      out.push(line)
      continue
    }
    // Drop the key's own continuation lines along with it.
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) i++
    const value = pending.get(key)
    pending.delete(key)
    if (value !== undefined && value !== null) out.push(`${key}: ${serializeValue(value)}`)
  }
  for (const [key, value] of pending) {
    if (value !== undefined && value !== null) out.push(`${key}: ${serializeValue(value)}`)
  }

  const block = `---\n${out.join('\n')}\n---\n`
  if (match) return `${block}${body}`
  return `${block}\n${body.replace(/^\s*\n/, '')}`
}
