// The activity log, read from the app's side.
//
// server/activity.mjs writes one JSON line per change an agent makes through
// the API or MCP, into `.deckle/activity.jsonl` in the library. The app reads
// it back here — through the same handle as everything else, so it needs no
// endpoint of its own — to show what was done, by which agent, and what is new
// since the person last looked.
//
// Only a server library ever has one: agents reach Deckle through its API. A
// local folder that an agent writes into directly has files but no log, and
// the views say so rather than showing an empty feed as if nothing happened.

import { DATA_DIR } from '../fs/appData'
import { isRemoteHandle, statRemote } from '../fs/remote'

export interface ActivityEvent {
  at: number
  /** The API token's name — "hermes", say. */
  actor: string
  via?: 'api' | 'mcp'
  action: string
  kind?: 'note' | 'file' | 'folder' | 'project' | 'task' | 'bookmark'
  path?: string
  to?: string
  project?: string
  size?: number
  count?: number
  message?: string
}

export const ACTIVITY_FILE = 'activity.jsonl'
const ROLLED_FILE = 'activity.1.jsonl'

async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string> {
  try {
    const data = await dir.getDirectoryHandle(DATA_DIR)
    return await (await (await data.getFileHandle(name)).getFile()).text()
  } catch {
    return ''
  }
}

function parseLines(text: string): ActivityEvent[] {
  const out: ActivityEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as ActivityEvent
      if (event && typeof event.at === 'number' && typeof event.action === 'string') out.push(event)
    } catch {
      // A torn last line from a crash mid-append: skip it.
    }
  }
  return out
}

/** Every recorded event, newest first. */
export async function loadActivity(dir: FileSystemDirectoryHandle): Promise<ActivityEvent[]> {
  const events = [
    ...parseLines(await readText(dir, ROLLED_FILE)),
    ...parseLines(await readText(dir, ACTIVITY_FILE)),
  ]
  // Newest first; events from the same millisecond keep the order they were written.
  return events.reverse().sort((a, b) => b.at - a.at)
}

/**
 * A cheap fingerprint of the log — its size and mtime — for noticing that an
 * agent has changed something without downloading the log to find out. null
 * when there is no log (yet), or no way to ask cheaply (a local library).
 */
export async function activityStamp(dir: FileSystemDirectoryHandle): Promise<string | null> {
  if (!isRemoteHandle(dir)) return null
  const stat = await statRemote(dir, `${DATA_DIR}/${ACTIVITY_FILE}`)
  return stat ? `${stat.lastModified}:${stat.size}` : ''
}

/** "hermes saved", "hermes moved", as the feed says it. */
export function describeEvent(event: ActivityEvent): string {
  const what = event.kind && !['note', 'file'].includes(event.kind) ? ` ${event.kind}` : ''
  const count = event.count && event.count > 1 ? ` ${event.count} items` : ''
  return `${event.actor} ${event.action}${what}${count}`
}

/** The newest event about a path — the file's provenance, for the viewer. */
export function lastEventFor(events: ActivityEvent[], path: string): ActivityEvent | null {
  return events.find((e) => e.to === path || (e.path === path && !e.to)) ?? null
}

// ---- What the person has seen ------------------------------------------------
// Kept per library, in this browser. Deliberately not in the library: "seen"
// is one person on one device catching up, not part of the record of the work.

function seenKey(libraryName: string | null): string {
  return `deckle-activity-seen:${libraryName ?? ''}`
}

export function readSeen(libraryName: string | null): number {
  try {
    return Number(localStorage.getItem(seenKey(libraryName))) || 0
  } catch {
    return 0
  }
}

export function writeSeen(libraryName: string | null, at: number): void {
  try {
    localStorage.setItem(seenKey(libraryName), String(at))
  } catch {
    // Storage disabled — everything simply stays "new" in this session.
  }
}
