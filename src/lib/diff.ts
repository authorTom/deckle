// A line diff, for showing what an agent changed in a note.
//
// Common leading and trailing lines are trimmed first — an agent edit usually
// touches a few lines of a long note, so what is left is small — and the
// middle is compared with a longest-common-subsequence table. A middle too big
// for that table (two wholly different long notes) is shown as one block
// removed and one added, which is what it is anyway.

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/** Cells in the LCS table before giving up on aligning the middle. */
const MAX_CELLS = 4_000_000

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }

  const head: DiffLine[] = a.slice(0, start).map((text) => ({ kind: 'same', text }))
  const tail: DiffLine[] = a.slice(endA).map((text) => ({ kind: 'same', text }))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  let middle: DiffLine[]
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    middle = [
      ...midA.map((text): DiffLine => ({ kind: 'removed', text })),
      ...midB.map((text): DiffLine => ({ kind: 'added', text })),
    ]
  } else {
    middle = lcsDiff(midA, midB)
  }
  return [...head, ...middle, ...tail]
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const width = m + 1
  // lengths[i * width + j]: LCS of a[i..] and b[j..].
  const lengths = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i] })
      i++
      j++
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      out.push({ kind: 'removed', text: a[i++] })
    } else {
      out.push({ kind: 'added', text: b[j++] })
    }
  }
  while (i < n) out.push({ kind: 'removed', text: a[i++] })
  while (j < m) out.push({ kind: 'added', text: b[j++] })
  return out
}

export type DiffHunk =
  | { kind: 'lines'; lines: DiffLine[] }
  | { kind: 'skipped'; count: number }

/**
 * The diff with long runs of unchanged lines folded away, keeping `context`
 * lines either side of each change.
 */
export function foldDiff(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, i) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true
  })
  const hunks: DiffHunk[] = []
  let skipped = 0
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      skipped++
      continue
    }
    if (skipped) {
      hunks.push({ kind: 'skipped', count: skipped })
      skipped = 0
    }
    const last = hunks[hunks.length - 1]
    if (last?.kind === 'lines') last.lines.push(lines[i])
    else hunks.push({ kind: 'lines', lines: [lines[i]] })
  }
  if (skipped) hunks.push({ kind: 'skipped', count: skipped })
  return hunks
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'added') added++
    else if (line.kind === 'removed') removed++
  }
  return { added, removed }
}
