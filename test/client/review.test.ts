import { describe, expect, it } from 'vitest'
import { diffLines, diffStats, foldDiff } from '../../src/lib/diff'
import {
  EMPTY_REVIEW,
  eventKey,
  isReviewed,
  pendingReview,
  reviewAll,
  setReviewed,
} from '../../src/activity/review'
import type { ActivityEvent } from '../../src/activity/activity'

describe('diffLines', () => {
  it('marks only the lines that changed', () => {
    const lines = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne')
    expect(lines).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'added', text: 'B' },
      { kind: 'same', text: 'c' },
      { kind: 'same', text: 'd' },
      { kind: 'added', text: 'e' },
    ])
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 })
  })

  it('aligns moved-around middles by their common lines', () => {
    const lines = diffLines('x\n1\n2\n3\ny', 'x\n2\n3\n4\ny')
    expect(lines.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'removed', text: '1' },
      { kind: 'added', text: '4' },
    ])
  })

  it('reports no change for identical text, and handles empty sides', () => {
    expect(diffStats(diffLines('same\ntext', 'same\ntext'))).toEqual({ added: 0, removed: 0 })
    expect(diffStats(diffLines('', 'new'))).toEqual({ added: 1, removed: 1 })
  })

  it('gives up aligning a huge rewrite rather than building a huge table', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n')
    const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n')
    expect(diffStats(diffLines(before, after))).toEqual({ added: 3000, removed: 3000 })
  })

  it('folds long unchanged runs, keeping context round each change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'line ten')
    const hunks = foldDiff(diffLines(before, after), 2)
    expect(hunks.map((h) => h.kind)).toEqual(['skipped', 'lines', 'skipped'])
    expect(hunks[0]).toEqual({ kind: 'skipped', count: 8 })
    const shown = hunks[1].kind === 'lines' ? hunks[1].lines.map((l) => l.text) : []
    expect(shown).toEqual(['line 8', 'line 9', 'line 10', 'line ten', 'line 11', 'line 12'])
  })
})

describe('the review queue', () => {
  const now = Date.UTC(2026, 10, 19, 12)
  const event = (at: number, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({
    id: `e${at}`,
    at,
    actor: 'hermes',
    action: 'created',
    kind: 'note',
    path: `n${at}.md`,
    ...extra,
  })
  const hour = 60 * 60 * 1000
  const events = [event(now - hour), event(now - 2 * hour), event(now - 3 * hour), event(now - 30 * 24 * hour)]

  it('queues recent note and file writes, not tasks or erasures or old history', () => {
    const extra = [
      event(now - 4 * hour, { kind: 'task', path: undefined }),
      event(now - 5 * hour, { action: 'erased' }),
      event(now - 6 * hour, { kind: 'file', path: 'r.pdf' }),
    ]
    const pending = pendingReview(EMPTY_REVIEW, [...events, ...extra], now)
    expect(pending.map((e) => e.id)).toEqual([
      `e${now - hour}`,
      `e${now - 2 * hour}`,
      `e${now - 3 * hour}`,
      `e${now - 6 * hour}`,
    ])
  })

  it('marks one reviewed, then all, keeping the file small', () => {
    let store = setReviewed(EMPTY_REVIEW, events[1], true, events)
    expect(pendingReview(store, events, now).map((e) => e.id)).toEqual([events[0].id, events[2].id])
    store = reviewAll(store, events)
    expect(store).toEqual({ version: 1, reviewedThrough: now - hour, reviewed: [] })
    expect(pendingReview(store, events, now)).toEqual([])
    const later = event(now + hour)
    expect(pendingReview(store, [later, ...events], now).map((e) => e.id)).toEqual([later.id])
  })

  it('un-reviews one event under the watermark without un-reviewing the rest', () => {
    const store = setReviewed(reviewAll(EMPTY_REVIEW, events), events[2], false, events)
    expect(isReviewed(store, events[2])).toBe(false)
    expect(isReviewed(store, events[0])).toBe(true)
    expect(isReviewed(store, events[1])).toBe(true)
    expect(isReviewed(store, events[3])).toBe(true)
  })

  it('tells apart old log lines that have no id', () => {
    const a = { at: 1, actor: 'x', action: 'created', path: 'a.md' }
    const b = { ...a, path: 'b.md' }
    expect(eventKey(a)).not.toBe(eventKey(b))
  })
})
