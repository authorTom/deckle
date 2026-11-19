// What the person has reviewed of an agent's work.
//
// "Seen" (activity.ts) is one browser catching up on the feed. "Reviewed" is
// different: the person has looked at what an agent produced and signed it
// off. That belongs to the record of the work — it should hold on the phone as
// well as the desktop — so it is kept in the library, in
// `.deckle/review.json`, beside tasks and bookmarks.
//
// The file stays small: everything up to `reviewedThrough` counts as reviewed,
// and only events newer than that are listed one by one.

import { readDataJson, writeDataJson } from '../fs/appData'
import type { ActivityEvent } from './activity'

export const REVIEW_FILE = 'review.json'

export interface ReviewStore {
  version: 1
  /** Every event at or before this time is reviewed. */
  reviewedThrough: number
  /** Keys of reviewed events newer than reviewedThrough. */
  reviewed: string[]
}

export const EMPTY_REVIEW: ReviewStore = { version: 1, reviewedThrough: 0, reviewed: [] }

/**
 * An event's identity. Servers since this release give each event an id;
 * older lines in the log are told apart by what they say.
 */
export function eventKey(event: ActivityEvent): string {
  return event.id ?? `${event.at}|${event.actor}|${event.action}|${event.path ?? ''}|${event.to ?? ''}`
}

/** Work a person would want to look at: notes and files an agent wrote. */
export function isReviewable(event: ActivityEvent): boolean {
  return (event.kind === 'note' || event.kind === 'file') && event.action !== 'erased'
}

export function isReviewed(store: ReviewStore, event: ActivityEvent): boolean {
  return event.at <= store.reviewedThrough || store.reviewed.includes(eventKey(event))
}

export function setReviewed(
  store: ReviewStore,
  event: ActivityEvent,
  reviewed: boolean,
  events: ActivityEvent[],
): ReviewStore {
  const key = eventKey(event)
  if (reviewed) {
    if (isReviewed(store, event)) return store
    return { ...store, reviewed: [...store.reviewed, key] }
  }
  if (event.at <= store.reviewedThrough) {
    // Un-reviewing something under the watermark: lower the watermark to just
    // below it, and list one by one everything else it used to cover.
    const through = event.at - 1
    const stillReviewed = events
      .filter((e) => e.at > through && e.at <= store.reviewedThrough && eventKey(e) !== key)
      .map(eventKey)
    return {
      ...store,
      reviewedThrough: through,
      reviewed: [...new Set([...store.reviewed.filter((k) => k !== key), ...stillReviewed])],
    }
  }
  return { ...store, reviewed: store.reviewed.filter((k) => k !== key) }
}

/**
 * Everything in `events` up to now is reviewed. The watermark moves to the
 * newest event and the list is emptied.
 */
export function reviewAll(store: ReviewStore, events: ActivityEvent[]): ReviewStore {
  const newest = events.reduce((max, e) => Math.max(max, e.at), store.reviewedThrough)
  return { version: 1, reviewedThrough: newest, reviewed: [] }
}

/**
 * Agent work not yet reviewed, newest first. Before anything has been reviewed
 * at all, only the last two weeks count — a long-running library shouldn't
 * open with a thousand-item queue.
 */
export function pendingReview(store: ReviewStore, events: ActivityEvent[], now = Date.now()): ActivityEvent[] {
  const floor = store.reviewedThrough || now - 14 * 24 * 60 * 60 * 1000
  return events.filter((e) => isReviewable(e) && e.at > floor && !isReviewed(store, e))
}

export async function loadReviewStore(dir: FileSystemDirectoryHandle): Promise<ReviewStore> {
  const raw = (await readDataJson(dir, REVIEW_FILE)) as Partial<ReviewStore> | null
  if (!raw || typeof raw !== 'object') return EMPTY_REVIEW
  return {
    version: 1,
    reviewedThrough: typeof raw.reviewedThrough === 'number' ? raw.reviewedThrough : 0,
    reviewed: Array.isArray(raw.reviewed) ? raw.reviewed.filter((k): k is string => typeof k === 'string') : [],
  }
}

export async function saveReviewStore(dir: FileSystemDirectoryHandle, store: ReviewStore): Promise<void> {
  await writeDataJson(dir, REVIEW_FILE, store)
}
