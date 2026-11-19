import { useCallback, useMemo } from 'react'
import { useDataFile } from '../hooks/useDataFile'
import type { ActivityEvent } from './activity'
import {
  EMPTY_REVIEW,
  isReviewable,
  isReviewed,
  loadReviewStore,
  pendingReview,
  reviewAll,
  saveReviewStore,
  setReviewed,
  type ReviewStore,
} from './review'

/** The review queue: agent work the person has not yet signed off. */
export function useReview(dir: FileSystemDirectoryHandle | null, events: ActivityEvent[]) {
  const { store, mutate } = useDataFile<ReviewStore>(dir, {
    load: loadReviewStore,
    save: saveReviewStore,
    empty: EMPTY_REVIEW,
    label: 'review state',
  })

  const pending = useMemo(() => pendingReview(store, events), [store, events])

  const reviewed = useCallback((event: ActivityEvent) => isReviewed(store, event), [store])

  const toggle = useCallback(
    (event: ActivityEvent) => {
      if (!isReviewable(event)) return
      mutate((s) => setReviewed(s, event, !isReviewed(s, event), events))
    },
    [mutate, events],
  )

  const markAll = useCallback(() => mutate((s) => reviewAll(s, events)), [mutate, events])

  /** Sign off a batch at once — everything an agent wrote for one brief, say. */
  const markReviewed = useCallback(
    (batch: ActivityEvent[]) =>
      mutate((s) =>
        batch.reduce(
          (store, event) => (isReviewable(event) && !isReviewed(store, event) ? setReviewed(store, event, true, events) : store),
          s,
        ),
      ),
    [mutate, events],
  )

  return { pending, reviewed, toggle, markAll, markReviewed }
}

export type ReviewApi = ReturnType<typeof useReview>
