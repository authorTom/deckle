// Queue preferences. Kept in localStorage beside the assistant's own settings
// rather than in the library: they describe how *this browser* works through
// the queue, not what the queue contains. Two people opening the same server
// library should be able to disagree about how many runs their machine handles
// at once.

export interface QueueSettings {
  /**
   * How many runs may execute at once. One is "in order"; more is several
   * agents working in parallel.
   *
   * Capped at four deliberately. Every concurrent run is a provider request in
   * flight and a set of library writes; past a handful the limit stops being
   * your machine and starts being the provider's rate limit, which surfaces as
   * runs failing rather than runs going faster.
   */
  concurrency: number
  /**
   * Folder queued runs may write to without asking. Anything outside it stops
   * the run for approval.
   */
  inbox: string
}

export const MAX_CONCURRENCY = 4

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  concurrency: 1,
  inbox: 'Assistant inbox',
}

const STORAGE_KEY = 'deckle-queue-settings'

export function loadQueueSettings(): QueueSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_QUEUE_SETTINGS
    const parsed = JSON.parse(raw) as Partial<QueueSettings>
    return {
      concurrency: clampConcurrency(parsed.concurrency),
      inbox: (parsed.inbox || DEFAULT_QUEUE_SETTINGS.inbox).trim(),
    }
  } catch {
    return DEFAULT_QUEUE_SETTINGS
  }
}

export function saveQueueSettings(settings: QueueSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // ignore quota / disabled storage
  }
}

export function clampConcurrency(value: unknown): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_QUEUE_SETTINGS.concurrency
  return Math.min(MAX_CONCURRENCY, Math.max(1, n))
}

/**
 * Is `path` the inbox folder, or inside it?
 *
 * This is the whole fence around writes a queued run makes unattended, so it
 * judges the path as written and doesn't lean on a backend refusing it later:
 * "Assistant inbox/../Projects/plan.md" starts with the inbox and is not in
 * it. Any path that climbs, doubles back, or isn't a plain relative path gets
 * "no", which only ever means "ask the person first".
 */
export function isInsideInbox(path: string, inbox: string): boolean {
  const folder = inbox.replace(/^\/+|\/+$/g, '')
  if (!folder) return false
  if (path.includes('\\')) return false
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false
  }
  return path === folder || path.startsWith(`${folder}/`)
}
