import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isValidDateStr, nextOccurrence, toDateStr } from '../../server/dates.mjs'
import { nextOccurrence as appNextOccurrence } from '../../src/tasks/dates.ts'

describe('isValidDateStr', () => {
  it.each([
    ['2026-09-14', true],
    ['2028-02-29', true],
    ['2026-02-29', false],
    ['2026-02-31', false],
    ['2026-13-01', false],
    ['2026-00-10', false],
    ['2026-9-14', false],
    ['14/09/2026', false],
    [20260914, false],
    [null, false],
  ])('%j → %s', (value, valid) => {
    expect(isValidDateStr(value)).toBe(valid)
  })
})

describe('nextOccurrence', () => {
  const TODAY = new Date(2026, 8, 14, 12, 0, 0) // 14 Sep 2026, local

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TODAY)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const cases = [
    ['an overdue daily task lands on tomorrow', '2026-09-01', { freq: 'daily', interval: 1 }, '2026-09-15'],
    ['a task due today moves on', '2026-09-14', { freq: 'daily', interval: 1 }, '2026-09-15'],
    ['every two weeks', '2026-09-14', { freq: 'weekly', interval: 2 }, '2026-09-28'],
    ['monthly clamps to the end of a short month', '2026-08-31', { freq: 'monthly', interval: 1 }, '2026-09-30'],
    ['a leap day rolls to the 28th', '2024-02-29', { freq: 'yearly', interval: 1 }, '2027-02-28'],
    ['a future due date advances once', '2026-12-01', { freq: 'monthly', interval: 3 }, '2027-03-01'],
    ['a zero interval counts as one', '2026-09-14', { freq: 'daily', interval: 0 }, '2026-09-15'],
  ]

  it.each(cases)('%s', (_label, due, recurrence, expected) => {
    expect(nextOccurrence(due, recurrence, toDateStr(TODAY))).toBe(expected)
  })

  it.each(cases)('agrees with the app: %s', (_label, due, recurrence) => {
    expect(nextOccurrence(due, recurrence, toDateStr(TODAY))).toBe(appNextOccurrence(due, recurrence))
  })
})
