import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDaysStr, dayHeading, dueChipLabel, nextOccurrence, parseDateStr, toDateStr } from '../../src/tasks/dates'
import { domainOf, findUrl, normalizeUrl, safeHttpUrl } from '../../src/bookmarks/url'
import { extractWikilinks, findBacklinks, resolveWikilink, wikilinkTargetFor } from '../../src/lib/wikilinks'
import { unescapeWikilinks } from '../../src/editor/markdown'
import { deriveTitleFromMarkdown, folderOf, isGeneratedTitle, timeAgo } from '../../src/lib/format'
import type { NoteFile } from '../../src/fs/library'

const note = (id: string): NoteFile => ({
  kind: 'file',
  id,
  name: id.split('/').pop() as string,
  title: (id.split('/').pop() as string).replace(/\.md$/, ''),
  updatedAt: 0,
})

describe('task dates', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 14, 9, 30))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does local date arithmetic across month and year ends', () => {
    expect(toDateStr(parseDateStr('2026-01-05'))).toBe('2026-01-05')
    expect(addDaysStr('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysStr('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('labels days relative to today', () => {
    expect(dayHeading('2026-09-14')).toBe('Today')
    expect(dueChipLabel('2026-09-15')).toBe('Tomorrow')
    expect(dayHeading('2027-01-01')).toContain('2027')
  })

  it('never schedules a recurring task in the past', () => {
    expect(nextOccurrence('2020-01-01', { freq: 'weekly', interval: 1 }) > '2026-09-14').toBe(true)
  })
})

describe('bookmark URLs', () => {
  it('normalises what people paste', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
    expect(normalizeUrl('  http://example.com/a?b=1 ')).toBe('http://example.com/a?b=1')
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('ftp://example.com')).toBeNull()
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
  })

  it('only lets http(s) into an href', () => {
    expect(safeHttpUrl('https://example.com/x')).toBe('https://example.com/x')
    expect(safeHttpUrl('javascript:alert(document.cookie)')).toBeUndefined()
    expect(safeHttpUrl('JAVASCRIPT:alert(1)')).toBeUndefined()
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeHttpUrl('not a url')).toBeUndefined()
  })

  it('finds and displays URLs', () => {
    expect(findUrl('see https://example.com/page, then')).toBe('https://example.com/page')
    expect(findUrl('nothing here')).toBeNull()
    expect(domainOf('https://www.amazon.co.uk/dp/X')).toBe('amazon.co.uk')
    expect(domainOf('garbage')).toBe('garbage')
  })
})

describe('wikilinks', () => {
  const files = [note('Index.md'), note('Projects/Index.md'), note('Projects/Plan.md'), note('Journal/Plan.md')]

  it('extracts targets, ignoring aliases', () => {
    expect(extractWikilinks('See [[Plan|the plan]] and [[Projects/Index]].').map((l) => l.target)).toEqual([
      'Plan',
      'Projects/Index',
    ])
  })

  it('resolves by exact path, then the linking note’s folder, then anywhere', () => {
    expect(resolveWikilink('Projects/Plan.md', files)).toBe('Projects/Plan.md')
    // A root note's path *is* its title, so an exact path match wins even over the local folder.
    expect(resolveWikilink('index', files, 'Projects/Plan.md')).toBe('Index.md')
    expect(resolveWikilink('plan', files, 'Journal/Other.md')).toBe('Journal/Plan.md')
    expect(resolveWikilink('Plan', files, 'Other/x.md')).toBe('Projects/Plan.md')
    expect(resolveWikilink('Nope', files)).toBeNull()
    expect(resolveWikilink('  ', files)).toBeNull()
  })

  it('writes a path when a bare title would be ambiguous', () => {
    expect(wikilinkTargetFor(note('Journal/Plan.md'), files, 'Index.md')).toBe('Journal/Plan')
    expect(wikilinkTargetFor(note('Projects/Plan.md'), files, 'Projects/Index.md')).toBe('Plan')
  })

  it('finds each note that links here, once', () => {
    const contents = new Map([
      ['Index.md', 'Start with [[Projects/Plan]] and [[Projects/Plan]] again'],
      ['Journal/Plan.md', 'unrelated'],
    ])
    const backlinks = findBacklinks('Projects/Plan.md', files, contents)
    expect(backlinks).toEqual([
      { id: 'Index.md', title: 'Index', context: 'Start with [[Projects/Plan]] and [[Projects/Plan]] again' },
    ])
  })

  it('undoes the editor’s escaping so files keep real wikilinks', () => {
    expect(unescapeWikilinks('See \\[\\[Plan\\]\\] now')).toBe('See [[Plan]] now')
    expect(unescapeWikilinks('\\[not a link\\]')).toBe('\\[not a link\\]')
  })
})

describe('formatting', () => {
  it('names a note after its opening heading only', () => {
    expect(deriveTitleFromMarkdown('\n# **Latency** review\n\nbody')).toBe('Latency review')
    expect(deriveTitleFromMarkdown('prose first\n# Heading')).toBeNull()
    expect(deriveTitleFromMarkdown('# Untitled 3')).toBeNull()
    expect(isGeneratedTitle('Untitled 12')).toBe(true)
    expect(folderOf('Projects/2026/idea.md')).toBe('Projects/2026')
    expect(folderOf('idea.md')).toBe('')
  })

  it('describes recent times', () => {
    const now = Date.now()
    expect(timeAgo(now)).toBe('just now')
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago')
    expect(timeAgo(now - 3 * 86_400_000)).toBe('3d ago')
  })
})
