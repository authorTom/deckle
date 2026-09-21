// The activity log: what agents (and scripts) did to the library, and when.
//
// Every write that arrives through /api/v1 or MCP appends one line here, named
// after the token that made it. It is how a person reviews an agent's work
// after the fact — "what did Hermes change while I was out?" — and it is the
// signal the app polls to know the library moved underneath it.
//
// It lives in the library, as JSON Lines in `.deckle/activity.jsonl`, for the
// same reason tasks do: it is part of the record of the work, so it travels in
// the export and the backup, and any tool that reads a line of JSON can read
// it. Edits made in the app itself are not logged — they are the person's own,
// and version history already keeps them.
//
// Append-only, so a write costs one line rather than rewriting the file. When
// it passes MAX_BYTES it is rolled to `activity.1.jsonl` (replacing any older
// roll), which bounds it at twice that on disk.

const DATA_DIR = '.deckle'
export const ACTIVITY_FILE = `${DATA_DIR}/activity.jsonl`
const ROLLED_FILE = `${DATA_DIR}/activity.1.jsonl`

/** Roughly ten thousand events. */
const MAX_BYTES = 2 * 1024 * 1024

/** Anything longer is somebody's essay, not a log line. */
const MAX_MESSAGE = 500

/**
 * @param {ReturnType<import('./library-api.mjs').createLibraryApi>} library
 * @param {{ projectsDir?: string, now?: () => number, maxBytes?: number }} [options]
 */
export function createActivityLog(
  library,
  { projectsDir = 'Projects', now = Date.now, maxBytes = MAX_BYTES } = {},
) {
  // One append at a time, so a roll can't interleave with a write.
  let chain = Promise.resolve()

  /** The project a path belongs to, if it sits inside the projects folder. */
  function projectOf(path) {
    if (!path || !projectsDir) return undefined
    const prefix = `${projectsDir}/`
    if (!path.startsWith(prefix)) return undefined
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    // "Projects/Acme" is the project folder itself; "Projects/x.md" is not in one.
    if (slash === -1) return undefined
    return rest.slice(0, slash) || undefined
  }

  /**
   * Record one event. Never throws: a failed log line must not fail the write
   * it describes, which has already happened.
   *
   * @param {{ actor: string, action: string, path?: string, to?: string,
   *   kind?: 'note' | 'file' | 'folder' | 'project' | 'task' | 'bookmark',
   *   size?: number, message?: string, project?: string, count?: number }} event
   */
  function record(event) {
    const entry = { at: now(), ...event }
    const project = event.project ?? projectOf(event.to ?? event.path)
    if (project) entry.project = project
    if (typeof entry.message === 'string') {
      entry.message = entry.message.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE)
      if (!entry.message) delete entry.message
    }
    for (const key of Object.keys(entry)) {
      if (entry[key] === undefined) delete entry[key]
    }

    const run = chain.then(async () => {
      try {
        const { size } = await library.appendText(ACTIVITY_FILE, `${JSON.stringify(entry)}\n`)
        if (size > maxBytes) {
          await library.remove(ROLLED_FILE, false).catch(() => {})
          await library.rename(ACTIVITY_FILE, ROLLED_FILE)
        }
      } catch (err) {
        console.warn('[deckle] could not write the activity log:', err?.message ?? err)
      }
    })
    chain = run
    return run
  }

  async function readLines(path) {
    let text
    try {
      text = await library.readText(path)
    } catch {
      return []
    }
    const out = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        if (parsed && typeof parsed.at === 'number') out.push(parsed)
      } catch {
        // A torn last line (a crash mid-append) is skipped, not fatal.
      }
    }
    return out
  }

  /**
   * Events newest first, optionally filtered. `since` is exclusive, in
   * milliseconds, so a caller can pass the `at` of the last event it saw.
   */
  async function list({ since, limit = 100, project, actor, path } = {}) {
    await chain
    const events = [...(await readLines(ROLLED_FILE)), ...(await readLines(ACTIVITY_FILE))]
    const filtered = events.filter(
      (e) =>
        (since === undefined || e.at > since) &&
        (!project || e.project === project) &&
        (!actor || e.actor === actor) &&
        (!path || e.path === path || e.to === path || e.path?.startsWith(`${path}/`)),
    )
    // Reversed before the (stable) sort, so events stamped in the same
    // millisecond still come back newest first — in the order they were written.
    filtered.reverse().sort((a, b) => b.at - a.at)
    return filtered.slice(0, limit)
  }

  return { record, list, projectOf }
}
