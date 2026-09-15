// Due-date arithmetic for the API's tasks.
//
// A copy of src/tasks/dates.ts, which the server cannot import: the browser
// and an agent completing the same recurring task must land it on the same
// next date, so the two must be changed together. Dates are local
// "YYYY-MM-DD" strings throughout, which compare correctly as plain strings.

export function toDateStr(d) {
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function todayStr() {
  return toDateStr(new Date())
}

/** Parse "YYYY-MM-DD" as local midnight. */
function parseDateStr(s) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Is this a real calendar date written as "YYYY-MM-DD" — not "2026-02-31"? */
export function isValidDateStr(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return toDateStr(parseDateStr(value)) === value
}

function addDaysStr(date, days) {
  const d = parseDateStr(date)
  d.setDate(d.getDate() + days)
  return toDateStr(d)
}

/** Add months keeping the day-of-month, clamped to the target month's end. */
function addMonthsStr(date, months) {
  const d = parseDateStr(date)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + months)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))
  return toDateStr(d)
}

/**
 * The next due date after completing a recurring task: advance from the due
 * date until the result is after `today`, so an overdue daily task completed
 * today lands on tomorrow rather than on a backlog of missed days.
 */
export function nextOccurrence(due, recurrence, today = todayStr()) {
  const n = Math.max(1, recurrence.interval)
  let next = due
  do {
    switch (recurrence.freq) {
      case 'daily':
        next = addDaysStr(next, n)
        break
      case 'weekly':
        next = addDaysStr(next, 7 * n)
        break
      case 'monthly':
        next = addMonthsStr(next, n)
        break
      case 'yearly':
        next = addMonthsStr(next, 12 * n)
        break
      default:
        return due
    }
  } while (next <= today)
  return next
}
