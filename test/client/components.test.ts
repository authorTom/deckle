// @vitest-environment jsdom

import { createElement } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import BookmarkList from '../../src/components/BookmarkList'
import type { BookmarksApi } from '../../src/bookmarks/useBookmarks'

describe('BookmarkList', () => {
  it('never renders a javascript: bookmark as a live link', () => {
    const store = {
      version: 1 as const,
      collections: [],
      bookmarks: [
        {
          id: 'evil',
          // As it would arrive in a synced or hand-edited bookmarks.json.
          url: 'javascript:alert(document.domain)',
          title: 'Evil',
          comment: '',
          collectionId: null,
          createdAt: Date.now(),
        },
        {
          id: 'good',
          url: 'https://example.com/',
          title: 'Good',
          comment: '',
          collectionId: null,
          createdAt: Date.now(),
        },
      ],
    }
    // Every action is a no-op spy; only the store matters to what is drawn.
    const bookmarks = new Proxy({ store } as Record<string, unknown>, {
      get: (target, key: string) => (key in target ? target[key] : vi.fn()),
    }) as unknown as BookmarksApi

    const { container, getByText } = render(
      createElement(BookmarkList, { bookmarks, onOpenNote: vi.fn() }),
    )

    expect(getByText('Evil')).toBeTruthy()
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs.some((href) => href?.toLowerCase().startsWith('javascript:'))).toBe(false)
    expect(hrefs).toContain('https://example.com/')
    for (const link of container.querySelectorAll('a[target="_blank"]')) {
      expect(link.getAttribute('rel')).toContain('noopener')
    }
  })
})
