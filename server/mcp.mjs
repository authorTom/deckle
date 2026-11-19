// Deckle as an MCP server, at /api/v1/mcp.
//
// The Model Context Protocol is how agents such as Hermes discover and call
// tools. Pointing one at this endpoint gives it Deckle as a knowledge base: it
// can search and read what is already known, keep its work in projects, save
// what it produces — notes and files alike — and log what it did, all through
// the same library rules the REST API follows (the recycle bin, version
// history, the activity log).
//
// Transport: Streamable HTTP, stateless. Every request is a POST of a JSON-RPC
// message (or a batch), answered with a JSON body — the spec allows a server
// to reply with plain JSON instead of an event stream, and nothing here needs
// to push messages unprompted. So there is no session id, and GET (the
// optional server-to-client stream) is answered 405, as the spec provides.
//
// Authentication is the API's own: a bearer token from DECKLE_API_TOKENS,
// checked before this module sees the request. A read-only (`r`) token is
// shown the read tools only, and refused the rest if it asks anyway.

import { Readable } from 'node:stream'
import { VERSION } from './version.mjs'
import { BadPathError } from './paths.mjs'
import { TooLargeError } from './library-api.mjs'
import {
  ApiError,
  isNotePath,
  normalizeFilePath,
  normalizeFolderPath,
  normalizeNotePath,
} from './library-store.mjs'
import { STATUSES } from './projects.mjs'
import { BRIEF_STATUSES, REPEATS } from './briefs.mjs'
import { createPlanner } from './planner.mjs'

/** Newest first. The one a client asks for is used when we know it. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_VERSION = '2025-06-18'

/** Base64 inflates by a third; keep a decoded file under the JSON body cap. */
const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_READ_CHARS = 40_000
const MAX_LIST_ENTRIES = 500
/**
 * Messages in one JSON-RPC batch. Every reply is held until the batch ends, and
 * a `read` reply can carry 200,000 characters, so without a cap a few
 * megabytes of requests — from a read-only token — could fill the heap.
 */
const MAX_BATCH = 50

const INSTRUCTIONS = `Deckle is the user's knowledge base: plain Markdown notes and ordinary files in folders, which the user reads and reviews in the Deckle app. Treat it as long-term memory for your work.

- Before starting a task, search for what is already known, and list_projects to see where the work belongs.
- Keep each piece of work in a project: create_project once, then save everything for it under Projects/<name>/.
- Save deliverables (reports, spreadsheets, images, code) with save_file or write_note, and write findings, decisions and sources as notes rather than leaving them only in the conversation.
- After each meaningful step, log_progress with what you did, what you decided and why, and what is next.
- Link related notes and files with [[wikilinks]] — [[Q3 report.pdf]], [[Research notes]] — and describe every important file in a note, because PDFs and images are only searchable by name and by the notes that mention them.
- To change part of a note, use edit_note rather than rewriting it with write_note.
- When you need the user to do or decide something — review a report, approve a plan — add_task with source_note pointing at the note, rather than only saying so in the conversation.
- Save useful sources with save_bookmark.
- The user queues work for you as briefs. When asked to check for work, or on a schedule, call next_brief: it hands you the instructions and context files. report_progress as you go, deliver_file each finished file, ask_user if blocked, and complete_brief at the end.
- Never store secrets: API keys, passwords, tokens, .env files, private keys.

Deleting moves things to a recycle bin, and replacing a file keeps the old copy there, so the user can undo anything you do.`

// ---- Formatting ------------------------------------------------------------

function iso(ms) {
  return ms ? new Date(ms).toISOString() : 'unknown'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function text(value) {
  return { content: [{ type: 'text', text: value }] }
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Arguments arrive untyped; these keep a malformed call from becoming a 500. */
function str(args, key, { optional = false, max = 100_000 } = {}) {
  const value = args?.[key]
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined
    throw new ApiError(400, 'invalid_params', `"${key}" is required`)
  }
  if (typeof value !== 'string') throw new ApiError(400, 'invalid_params', `"${key}" must be a string`)
  if (value.length > max) throw new ApiError(400, 'invalid_params', `"${key}" is too long`)
  return value
}

function int(args, key, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = args?.[key]
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new ApiError(400, 'invalid_params', `"${key}" must be a number`)
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function stringList(args, key) {
  const value = args?.[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string')
  throw new ApiError(400, 'invalid_params', `"${key}" must be a list of strings`)
}

/** A window onto long text, with directions for reading on. */
function windowed(content, offset, maxChars) {
  const slice = content.slice(offset, offset + maxChars)
  const end = offset + slice.length
  const more =
    end < content.length
      ? `\n\n[… ${content.length - end} more characters. Call read again with offset=${end} to continue.]`
      : ''
  return `${slice}${more}`
}

const TASK_FILTERS = ['all', 'inbox', 'today', 'upcoming', 'overdue', 'completed']

function countOccurrences(haystack, needle) {
  let count = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++
  return count
}

function findByName(list, name) {
  const wanted = name.trim().toLowerCase()
  return list.find((item) => item.name.trim().toLowerCase() === wanted)
}

function findPlannerProject(data, name) {
  return findByName(data.projects, name)
}

function plannerProjectNames(data) {
  return data.projects.map((p) => p.name).join(', ') || 'none yet'
}

function byDueThenPriority(a, b) {
  if (a.due !== b.due) return !a.due ? 1 : !b.due ? -1 : a.due < b.due ? -1 : 1
  return a.priority - b.priority
}

function describeTask(task, data) {
  const project = task.projectId ? data.projects.find((p) => p.id === task.projectId)?.name : null
  const bits = [
    `P${task.priority}`,
    task.due ? `due ${task.due}` : null,
    task.recurrence ? `repeats ${task.recurrence.interval > 1 ? `every ${task.recurrence.interval} ` : ''}${task.recurrence.freq}` : null,
    project ? `project ${project}` : 'Inbox',
    task.source?.noteId ? `about ${task.source.noteId}` : null,
  ].filter(Boolean)
  const box = task.deletedAt ? '[binned]' : task.completedAt ? '[x]' : '[ ]'
  return `- ${box} ${task.title} (${bits.join(', ')}) · id ${task.id}`
}

/** A library path as it goes in a URL: each segment encoded, the slashes kept. */
function urlPath(path) {
  return path.split('/').map(encodeURIComponent).join('/')
}

function describeFile(file) {
  const size = file.size != null ? ` (${formatBytes(file.size)})` : ''
  const how = file.readable
    ? 'read it with `read`'
    : `binary — download GET /api/v1/files/${urlPath(file.path)}, or run deckle_pull.py`
  return `- ${file.path}${size} — ${how}`
}

function describeBrief(brief) {
  const bits = [
    brief.status,
    `P${brief.priority}`,
    brief.agent ? `for ${brief.agent}` : 'any agent',
    brief.due ? `due ${brief.due}` : null,
    brief.repeat ? `repeats ${brief.repeat}${brief.start ? `, next ${brief.start}` : ''}` : brief.start ? `from ${brief.start}` : null,
    brief.claim ? `held by ${brief.claim.agent}${brief.claim.stale ? ' (stale)' : ''}` : null,
  ].filter(Boolean)
  return `- ${brief.title} [${brief.project}] (${bits.join(', ')}) · id ${brief.id}`
}

/** What next_brief tells the agent it just took on. */
function formatClaimed(brief, runDate, leaseMinutes) {
  const outputDir = brief.repeat ? `${brief.outputDir}/${runDate}` : brief.outputDir
  const facts = [
    `P${brief.priority}`,
    brief.due ? `due ${brief.due}` : null,
    brief.outputs.length ? `expected outputs: ${brief.outputs.join(', ')}` : null,
    brief.repeat ? `repeats ${brief.repeat}` : null,
  ].filter(Boolean)
  const reworking = brief.runLog.includes('**Changes requested:**') || brief.runLog.includes('**Answer:**')
  return [
    `You have taken the brief "${brief.title}" in project ${brief.project}.`,
    `id: ${brief.id}`,
    facts.join(' · '),
    `## Instructions\n${brief.instructions || '(none written — the title is the brief)'}`,
    `## Context files for this brief\n${brief.context.length ? brief.context.map(describeFile).join('\n') : '(none)'}`,
    brief.projectContext.length
      ? `## Context shared across the project\n${brief.projectContext.map(describeFile).join('\n')}`
      : null,
    `## Run log so far\n${brief.runLog.trim() || '(empty)'}`,
    reworking
      ? 'The run log holds answers or change requests from the user since an earlier run — act on the newest ones, and build on what is already in the Output folder rather than starting again.'
      : null,
    [
      '## How to work it',
      `- report_progress after each step (at least every ${leaseMinutes} minutes, or the brief goes back to the queue).`,
      `- deliver_file each finished file; it lands in ${outputDir}/.`,
      '- ask_user if you cannot go on without the user; then stop.',
      '- complete_brief with a summary when the work is done.',
    ].join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n')
}

// ---- The server ------------------------------------------------------------

export function createMcp({ library, store, search, activity, projects, briefs, libraryName, maxFileBytes }) {
  const inlineLimit = Math.min(MAX_INLINE_FILE_BYTES, maxFileBytes)

  const record = (token, event) => activity.record({ actor: token.name, via: 'mcp', ...event })
  const planner = createPlanner(store)

  /** Decode a save_file / deliver_file body, held to the inline limit. */
  function decodeContent(args) {
    const encoding = args?.encoding ?? 'utf8'
    if (encoding !== 'utf8' && encoding !== 'base64') throw new ApiError(400, 'invalid_params', '"encoding" must be utf8 or base64')
    const raw = str(args, 'content', { max: Math.ceil(inlineLimit * 1.4) + 16 })
    const bytes = encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
    if (bytes.length > inlineLimit) {
      throw new ApiError(
        413,
        'too_large',
        `That is ${formatBytes(bytes.length)}; at most ${formatBytes(inlineLimit)} can be sent inline. Use the deckle_push.py script for large files.`,
      )
    }
    return bytes
  }

  /**
   * Write bytes to a path by the library's rules — a note keeps its history,
   * any other file keeps its old copy in the bin — and record it.
   */
  async function saveBytes(path, bytes, token, { message, overwrite = true, brief } = {}) {
    const existing = await library.exists(path)
    if (existing === 'directory') return toolError(`"${path}" is a folder.`)
    if (existing === 'file' && !overwrite) {
      return toolError(`A file already exists at "${path}" and overwrite is false.`)
    }
    if (isNotePath(path)) {
      const { note, created, before } = await store.writeNote(path, bytes.toString('utf8'), 'agent')
      await record(token, { action: created ? 'created' : 'replaced', kind: 'note', path: note.path, message, before, brief })
      return text(`${created ? 'Saved' : 'Replaced'} ${note.path}.`)
    }
    const { file, created } = await store.putFile(path, Readable.from([bytes]), { replacedBy: token.name })
    await record(token, {
      action: created ? 'saved' : 'replaced',
      kind: 'file',
      path: file.path,
      size: file.size,
      message,
      brief,
    })
    return text(
      `${created ? 'Saved' : 'Replaced'} ${file.path} (${formatBytes(file.size)}).` +
        (created ? '' : ' The previous copy is in the recycle bin.'),
    )
  }

  /** A task-planner project named in args.project, as an id; null for the Inbox. */
  async function resolvePlannerProject(args) {
    if (args?.project === undefined || args?.project === null || args?.project === '') return null
    if (typeof args.project !== 'string') throw new ApiError(400, 'invalid_params', '"project" must be a name')
    const data = await store.loadTasks()
    const project = findPlannerProject(data, args.project)
    if (!project) {
      throw new ApiError(
        404,
        'not_found',
        `No task-planner project called "${args.project}". Projects: ${plannerProjectNames(data)}. Omit project for the Inbox.`,
      )
    }
    return project.id
  }

  // Each tool: name, whether a read-only token may use it, the schema the
  // model sees, and what it does. Descriptions are written for the model.
  const tools = [
    {
      name: 'search',
      readOnly: true,
      title: 'Search the knowledge base',
      description:
        'Search the Deckle knowledge base: notes by title and text, and files by name and by their contents (Word, Excel, PowerPoint, OpenDocument, CSV, JSON, text and code). Returns ranked paths with snippets. Use it before starting work to find what is already known. PDFs and images are matched by file name and by the notes that link to them.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for.' },
          folder: { type: 'string', description: 'Only search inside this folder, e.g. "Projects/Acme".' },
          kind: { type: 'string', enum: ['note', 'file'], description: 'Only notes, or only other files.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        },
        required: ['query'],
      },
      async run(args) {
        const query = str(args, 'query', { max: 1000 })
        const kind = args?.kind === 'note' || args?.kind === 'file' ? args.kind : undefined
        const results = await search.search(query, {
          limit: int(args, 'limit', 10, { min: 1, max: 50 }),
          folder: normalizeFolderPath(args?.folder ?? ''),
          kind,
        })
        if (!results.length) return text(`No matches for "${query}".`)
        return text(
          results
            .map(
              (r, i) =>
                `${i + 1}. ${r.path} (${r.kind}${r.size !== undefined ? `, ${formatBytes(r.size)}` : ''}, updated ${iso(r.updatedAt)})` +
                (r.snippet ? `\n   ${r.snippet}` : ''),
            )
            .join('\n'),
        )
      },
    },
    {
      name: 'read',
      readOnly: true,
      title: 'Read a note or file',
      description:
        'Read a note, or the text of a file, by its path. Word, Excel, PowerPoint, OpenDocument, CSV, JSON, text and code files come back as text (Excel as one table per sheet); images, PDFs and other binary files return their details only. Long content is cut at max_chars — call again with the offset it gives to read on.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Library-relative path, e.g. "Projects/Acme/Overview.md".' },
          offset: { type: 'integer', minimum: 0, default: 0 },
          max_chars: { type: 'integer', minimum: 1000, maximum: 200000, default: DEFAULT_READ_CHARS },
        },
        required: ['path'],
      },
      async run(args) {
        const raw = str(args, 'path', { max: 1024 })
        const offset = int(args, 'offset', 0)
        const maxChars = int(args, 'max_chars', DEFAULT_READ_CHARS, { min: 1000, max: 200_000 })
        let path = normalizeFilePath(raw)
        let kind = await library.exists(path)
        // Let "Projects/Acme/Overview" find the note, as the REST API does.
        if (!kind && !isNotePath(path)) {
          const asNote = normalizeNotePath(raw)
          if ((await library.exists(asNote)) === 'file') {
            path = asNote
            kind = 'file'
          }
        }
        if (kind === 'directory') return toolError(`"${path}" is a folder — use list to see what is in it.`)
        if (!kind) return toolError(`Nothing at "${path}". Use search or list to find the right path.`)

        if (isNotePath(path)) {
          const note = await store.readNote(path)
          return text(
            `Note: ${note.path}\nUpdated: ${iso(note.updatedAt)} · ${note.content.length} characters\n\n` +
              windowed(note.content, offset, maxChars),
          )
        }
        const info = await store.readFileInfo(path)
        const header = `File: ${info.path}\nType: ${info.ext || 'unknown'} · ${formatBytes(info.size)} · updated ${iso(info.updatedAt)}`
        const content = await search.textOf(path)
        if (content === null) {
          return text(
            `${header}\n\nDeckle can't read the contents of this kind of file. Look for a note that describes it (search for its name), or read it with your own tools after downloading it from ${`/api/v1/files/${path.split('/').map(encodeURIComponent).join('/')}`}.`,
          )
        }
        return text(`${header} · ${content.length} characters of text\n\n${windowed(content, offset, maxChars)}`)
      },
    },
    {
      name: 'list',
      readOnly: true,
      title: 'List a folder',
      description:
        'List the notes, files and folders in a folder of the knowledge base — the top of the library when folder is omitted. Set recursive to include everything below it.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Library-relative folder, e.g. "Projects/Acme". Omit for the root.' },
          recursive: { type: 'boolean', default: false },
        },
      },
      async run(args) {
        const folder = normalizeFolderPath(args?.folder ?? '')
        if (folder && (await library.exists(folder)) !== 'directory') {
          return toolError(`No folder at "${folder}".`)
        }
        const recursive = args?.recursive === true
        const lines = []
        let truncated = false
        const walk = (nodes, prefix, depth) => {
          for (const node of nodes) {
            if (lines.length >= MAX_LIST_ENTRIES) {
              truncated = true
              return
            }
            const path = prefix ? `${prefix}/${node.id.slice(node.id.lastIndexOf('/') + 1)}` : node.id
            const indent = '  '.repeat(depth)
            if (node.kind === 'folder') {
              lines.push(`${indent}${path}/`)
              if (recursive) walk(node.children, path, depth + 1)
            } else if (node.kind === 'file') {
              lines.push(`${indent}${path}  (note, updated ${iso(node.updatedAt)})`)
            } else {
              lines.push(`${indent}${path}  (${node.ext || 'file'}, ${formatBytes(node.size)}, updated ${iso(node.updatedAt)})`)
            }
          }
        }
        walk(await library.tree(folder), folder, 0)
        if (!lines.length) return text(folder ? `"${folder}" is empty.` : 'The library is empty.')
        return text(
          `${folder || libraryName}:\n${lines.join('\n')}${truncated ? `\n[… stopped at ${MAX_LIST_ENTRIES} entries; list a subfolder to see more]` : ''}`,
        )
      },
    },
    {
      name: 'list_projects',
      readOnly: true,
      title: 'List projects',
      description: `List projects — the folders inside ${projects.root}/ — with their status, summary, tags, size and when they last changed, most recent first. Use it to find where work belongs before saving anything.`,
      inputSchema: {
        type: 'object',
        properties: { status: { type: 'string', enum: STATUSES } },
      },
      async run(args) {
        const status = STATUSES.includes(args?.status) ? args.status : undefined
        const list = await projects.list({ status })
        if (!list.length) {
          return text(
            status
              ? `No ${status} projects.`
              : `No projects yet. create_project starts one in ${projects.root}/.`,
          )
        }
        return text(
          list
            .map(
              (p) =>
                `- ${p.name} [${p.status ?? 'no status'}] — ${p.summary || 'no summary'}\n` +
                `  ${p.path}/ · ${p.notes} notes, ${p.files} files · last change ${iso(p.updatedAt)}` +
                (p.tags.length ? ` · tags: ${p.tags.join(', ')}` : '') +
                (p.overview ? `\n  overview: ${p.overview}` : ''),
            )
            .join('\n'),
        )
      },
    },
    {
      name: 'recent_activity',
      readOnly: true,
      title: 'Recent activity',
      description:
        'What has been created, changed, moved or deleted in the knowledge base through the API and MCP — by you or by other agents — newest first. Use it to pick up where earlier work stopped.',
      inputSchema: {
        type: 'object',
        properties: {
          since: { type: 'string', description: 'An ISO date or time; only newer events are returned.' },
          project: { type: 'string', description: 'Only events inside this project.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
        },
      },
      async run(args) {
        const sinceRaw = str(args, 'since', { optional: true, max: 64 })
        let since
        if (sinceRaw) {
          since = Date.parse(sinceRaw)
          if (!Number.isFinite(since)) return toolError(`"since" must be a date, such as 2026-09-21.`)
        }
        const events = await activity.list({
          since,
          project: str(args, 'project', { optional: true, max: 300 }),
          limit: int(args, 'limit', 30, { min: 1, max: 200 }),
        })
        if (!events.length) return text('No activity recorded yet.')
        return text(
          events
            .map(
              (e) =>
                `${iso(e.at)} · ${e.actor} ${e.action} ${e.kind ?? ''} ${e.path ?? ''}${e.to ? ` → ${e.to}` : ''}`.replace(/\s+/g, ' ').trim() +
                (e.message ? ` — ${e.message}` : ''),
            )
            .join('\n'),
        )
      },
    },
    {
      name: 'write_note',
      readOnly: false,
      title: 'Write a note',
      description:
        "Create or update a Markdown note. mode 'create' (the default) never overwrites — a clash gets a numbered name, which is returned; 'replace' overwrites the note, keeping the old version in its history; 'append' adds to the end, creating the note if it is missing. Link other notes and files with [[wikilinks]]. '.md' is added to the path if missing.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "Projects/Acme/Competitor research.md".' },
          content: { type: 'string', description: 'Markdown.' },
          mode: { type: 'string', enum: ['create', 'replace', 'append'], default: 'create' },
          message: { type: 'string', description: 'One line on why, shown in the activity log.' },
        },
        required: ['path', 'content'],
      },
      async run(args, token) {
        const path = normalizeNotePath(str(args, 'path', { max: 1024 }))
        const content = str(args, 'content', { max: 4_000_000 })
        const mode = args?.mode ?? 'create'
        const message = str(args, 'message', { optional: true, max: 1000 })
        if (!['create', 'replace', 'append'].includes(mode)) {
          return toolError(`"mode" must be create, replace or append.`)
        }
        if ((await library.exists(path)) === 'directory') return toolError(`"${path}" is a folder.`)

        if (mode === 'create') {
          const note = await store.createNote({ path, content })
          await record(token, { action: 'created', kind: 'note', path: note.path, message })
          return text(
            note.path === path
              ? `Created ${note.path}.`
              : `A note already existed at ${path}, so this was saved as ${note.path}.`,
          )
        }
        let next = content
        if (mode === 'append' && (await library.exists(path)) === 'file') {
          const current = await library.readText(path)
          const separator = current && !current.endsWith('\n') ? '\n\n' : current ? '\n' : ''
          next = `${current}${separator}${content}`
        }
        const { note, created, before } = await store.writeNote(path, next, 'agent')
        await record(token, {
          action: created ? 'created' : mode === 'append' ? 'appended to' : 'replaced',
          kind: 'note',
          path: note.path,
          message,
          before,
        })
        return text(`${created ? 'Created' : mode === 'append' ? 'Appended to' : 'Replaced'} ${note.path}.`)
      },
    },
    {
      name: 'edit_note',
      readOnly: false,
      title: 'Edit part of a note',
      description:
        "Change part of a note without rewriting it: replaces old_text with new_text. old_text must match the note exactly — read the note first — and must appear once, unless replace_all is true. If the note changed since you read it and old_text is gone, nothing is written and you are told so; read it again. The previous version is kept in the note's history. Prefer this to write_note's replace mode for small changes: it is cheaper, and it never undoes edits the user made meanwhile.",
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "Projects/Acme/Overview.md".' },
          old_text: { type: 'string', description: 'The exact text to replace.' },
          new_text: { type: 'string', description: 'What to put in its place; empty to delete it.' },
          replace_all: { type: 'boolean', default: false },
          message: { type: 'string', description: 'One line on why, shown in the activity log.' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
      async run(args, token) {
        const path = normalizeNotePath(str(args, 'path', { max: 1024 }))
        const oldText = str(args, 'old_text', { max: 1_000_000 })
        const newText = args?.new_text ?? ''
        if (typeof newText !== 'string') return toolError(`"new_text" must be a string.`)
        if (newText.length > 4_000_000) return toolError(`"new_text" is too long.`)
        const message = str(args, 'message', { optional: true, max: 1000 })
        const kind = await library.exists(path)
        if (kind === 'directory') return toolError(`"${path}" is a folder.`)
        if (!kind) return toolError(`No note at "${path}". Use write_note to create it.`)

        const current = await library.readText(path)
        const count = countOccurrences(current, oldText)
        if (count === 0) {
          return toolError(
            `old_text was not found in ${path}. The note may have changed since you read it — read it again and copy the text exactly.`,
          )
        }
        if (count > 1 && args?.replace_all !== true) {
          return toolError(
            `old_text appears ${count} times in ${path}. Include more of the surrounding text so it matches once, or set replace_all.`,
          )
        }
        const next = args?.replace_all === true
          ? current.split(oldText).join(newText)
          : current.replace(oldText, () => newText)
        if (next === current) return text(`No change: ${path} already reads that way.`)
        const { note, before } = await store.writeNote(path, next, 'agent')
        await record(token, { action: 'edited', kind: 'note', path: note.path, message, before })
        return text(`Edited ${note.path}${count > 1 ? ` (${count} places)` : ''}.`)
      },
    },
    {
      name: 'save_file',
      readOnly: false,
      title: 'Save a file',
      description: `Save a file of any type — a report, spreadsheet, image, PDF, dataset or source file. For text formats pass the text as content; for binary files pass base64 with encoding "base64" (at most ${formatBytes(inlineLimit)}; for bigger files, or a whole folder, run the deckle_push.py script from the Deckle skill instead). A file already at the path is replaced and the old copy moved to the recycle bin, unless overwrite is false. Describe important files in a note that links to them with [[wikilinks]].`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'e.g. "Projects/Acme/Deliverables/Q3 analysis.xlsx".' },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
          overwrite: { type: 'boolean', default: true },
          message: { type: 'string', description: 'One line on what this is, shown in the activity log.' },
        },
        required: ['path', 'content'],
      },
      async run(args, token) {
        const path = normalizeFilePath(str(args, 'path', { max: 1024 }))
        const bytes = decodeContent(args)
        const message = str(args, 'message', { optional: true, max: 1000 })
        return await saveBytes(path, bytes, token, { message, overwrite: args?.overwrite !== false })
      },
    },
    {
      name: 'create_project',
      readOnly: false,
      title: 'Start a project',
      description: `Start a project: creates ${projects.root}/<name>/ with an Overview.md holding its status, summary and tags, which the user sees in Deckle's Projects view. Save everything produced for the project inside that folder. Check list_projects first so you don't start a duplicate.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short and human, e.g. "Acme market research". Becomes the folder name.' },
          summary: { type: 'string', description: 'One or two sentences on the goal.' },
          tags: { type: 'array', items: { type: 'string' } },
          status: { type: 'string', enum: STATUSES, default: 'active' },
          body: { type: 'string', description: 'Optional Markdown for the rest of the overview: goal, scope, sources.' },
        },
        required: ['name', 'summary'],
      },
      async run(args, token) {
        const project = await projects.create({
          name: str(args, 'name', { max: 120 }),
          summary: str(args, 'summary', { max: 2000 }),
          tags: stringList(args, 'tags'),
          status: args?.status,
          body: str(args, 'body', { optional: true, max: 200_000 }),
          createdBy: token.name,
        })
        await record(token, { action: 'created', kind: 'project', path: project.path, project: project.name })
        return text(`Created project "${project.name}" at ${project.path}/ (overview: ${project.overview}).`)
      },
    },
    {
      name: 'update_project',
      readOnly: false,
      title: 'Update a project',
      description: `Change a project's status (${STATUSES.join(', ')}), summary or tags. Mark a project done when its work is finished.`,
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          status: { type: 'string', enum: STATUSES },
          summary: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
      },
      async run(args, token) {
        const project = await projects.update(str(args, 'name', { max: 300 }), {
          status: args?.status,
          summary: str(args, 'summary', { optional: true, max: 2000 }),
          tags: stringList(args, 'tags'),
        })
        await record(token, {
          action: 'updated',
          kind: 'project',
          path: project.path,
          project: project.name,
          message: args?.status ? `status: ${project.status}` : undefined,
        })
        return text(`Updated "${project.name}": ${project.status ?? 'no status'} — ${project.summary || 'no summary'}.`)
      },
    },
    {
      name: 'log_progress',
      readOnly: false,
      title: 'Log progress',
      description:
        "Add a dated entry to a project's Log.md: what you did, what you decided and why, and what is next. Write one after each meaningful step, so the user can follow and review the work.",
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          entry: { type: 'string', description: 'Markdown; may link files and notes with [[wikilinks]].' },
        },
        required: ['project', 'entry'],
      },
      async run(args, token) {
        const entry = str(args, 'entry', { max: 20_000 })
        const { project, path } = await projects.log(str(args, 'project', { max: 300 }), entry, token.name)
        await record(token, { action: 'logged', kind: 'note', path, project, message: entry.split('\n')[0] })
        return text(`Logged to ${path}.`)
      },
    },
    {
      name: 'next_brief',
      readOnly: false,
      title: 'Take the next brief',
      description:
        "Take the next piece of work the user has queued for you: a brief, with its instructions, the files they attached as context, and its run log so far (which holds any answers to your questions and any changes they asked for). Returns nothing to do when the queue is empty — then stop. While you work, report_progress after each step: a brief you stop reporting on goes back to the queue. Deliver each finished file with deliver_file, ask_user if you are blocked, and complete_brief when the work is done.",
      inputSchema: { type: 'object', properties: {} },
      async run(_args, token) {
        const { brief, expired, runDate } = await briefs.claim(token.name)
        for (const lapsed of expired) {
          await record(token, { action: 'released', kind: 'brief', path: lapsed.id, message: `${lapsed.agent} stopped reporting; back in the queue` })
        }
        if (!brief) return text('No briefs are waiting for you. Nothing to do — stop here.')
        await record(token, { action: 'started', kind: 'brief', path: brief.id, message: brief.title })
        return text(formatClaimed(brief, runDate, Math.round(briefs.leaseMs / 60_000)))
      },
    },
    {
      name: 'report_progress',
      readOnly: false,
      title: 'Report progress on a brief',
      description: `Add a line to the brief's run log — what you just did, decided or found — and keep your claim on it. The user sees the latest line on the brief's card. Report at least every ${Math.round(briefs.leaseMs / 60_000)} minutes, or the brief goes back to the queue.`,
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string', description: 'The brief id next_brief gave you.' },
          entry: { type: 'string', description: 'Markdown; may link files with [[wikilinks]].' },
        },
        required: ['brief', 'entry'],
      },
      async run(args, token) {
        const brief = await briefs.progress(str(args, 'brief', { max: 1024 }), token.name, str(args, 'entry', { max: 20_000 }))
        await record(token, { action: 'reported progress on', kind: 'brief', path: brief.id, message: String(args.entry).split('\n')[0] })
        return text(`Noted on "${brief.title}".`)
      },
    },
    {
      name: 'ask_user',
      readOnly: false,
      title: 'Ask the user about a brief',
      description:
        "Ask the user a question you cannot go on without — a decision, a missing file, a login you must not store. The brief is set aside as blocked and your claim released; when they answer, it is queued again and next_brief hands it back with their answer in the run log. Save anything you have done so far with deliver_file or write_note first: the next session starts fresh.",
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          question: { type: 'string', description: 'Self-contained: the user may read it hours later.' },
        },
        required: ['brief', 'question'],
      },
      async run(args, token) {
        const brief = await briefs.ask(str(args, 'brief', { max: 1024 }), token.name, str(args, 'question', { max: 20_000 }))
        await record(token, { action: 'asked about', kind: 'brief', path: brief.id, message: String(args.question).split('\n')[0] })
        return text(`Asked. "${brief.title}" is blocked until the user answers — stop work on it now.`)
      },
    },
    {
      name: 'deliver_file',
      readOnly: false,
      title: 'Deliver a file for a brief',
      description: `Hand back a finished file for the brief you are working — a Word document, slide deck, spreadsheet, PDF, image, Markdown report or anything else. It is saved in the brief's Output folder (you choose only the name, which may include subfolders), where the user reviews it. Text formats as content; binary files as base64 with encoding "base64", at most ${formatBytes(inlineLimit)} — for bigger files run deckle_push.py with --brief. Delivering a name again replaces the file and keeps the old copy in the recycle bin.`,
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          name: { type: 'string', description: 'e.g. "Vendor comparison.docx" or "charts/revenue.png".' },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
          message: { type: 'string', description: 'One line on what this is, shown in the activity log.' },
        },
        required: ['brief', 'name', 'content'],
      },
      async run(args, token) {
        const { brief, path } = await briefs.outputPath(str(args, 'brief', { max: 1024 }), token.name, str(args, 'name', { max: 300 }))
        const bytes = decodeContent(args)
        const result = await saveBytes(normalizeFilePath(path), bytes, token, {
          message: str(args, 'message', { optional: true, max: 1000 }),
          brief: brief.id,
        })
        if (!result.isError) await briefs.progress(brief.id, token.name, `Delivered [[${path.slice(brief.id.length + 1)}]].`)
        return result
      },
    },
    {
      name: 'complete_brief',
      readOnly: false,
      title: 'Complete a brief',
      description:
        "Say the brief is done and hand it to the user for review, with a summary: what you produced, what you decided and why, anything left open. The files you delivered during this run are listed for them automatically. Your claim ends; if they ask for changes, next_brief hands the brief back with their comments.",
      inputSchema: {
        type: 'object',
        properties: {
          brief: { type: 'string' },
          summary: { type: 'string', description: 'Markdown, for the person reviewing the work.' },
        },
        required: ['brief', 'summary'],
      },
      async run(args, token) {
        const { brief, delivered, next } = await briefs.complete(str(args, 'brief', { max: 1024 }), token.name, str(args, 'summary', { max: 20_000 }))
        await record(token, { action: 'completed', kind: 'brief', path: brief.id, message: brief.title, count: delivered.length })
        return text(
          `"${brief.title}" is with the user for review, with ${delivered.length} ${delivered.length === 1 ? 'file' : 'files'} delivered.` +
            (next ? ` It repeats ${brief.repeat}: the next run is due ${next}.` : '') +
            ' Call next_brief for more work.',
        )
      },
    },
    {
      name: 'list_briefs',
      readOnly: true,
      title: 'List briefs',
      description:
        'List briefs — work queued for agents — with their status (draft, queued, running, blocked, review, changes-requested, done, cancelled), agent and project. Use next_brief to take one; this only looks.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: BRIEF_STATUSES },
          project: { type: 'string' },
          mine: { type: 'boolean', description: 'Only briefs addressed to you or to any agent.' },
        },
      },
      async run(args, token) {
        const status = BRIEF_STATUSES.includes(args?.status) ? args.status : undefined
        const list = await briefs.list({
          status,
          project: str(args, 'project', { optional: true, max: 300 }),
          agent: args?.mine === true ? token.name : undefined,
        })
        if (!list.length) return text(status ? `No ${status} briefs.` : 'No briefs.')
        return text(list.map(describeBrief).join('\n'))
      },
    },
    {
      name: 'create_brief',
      readOnly: false,
      title: 'Queue a brief',
      description:
        "Queue work for an agent — yourself later, or another agent by its name — as a brief in a project: a title, instructions written for whoever picks it up cold, and optionally who should do it, a priority, a due date, a date not to start before, a repeat (daily, weekly, monthly) and the output types expected. Use it to split a large job into pieces, or to hand work on. The project must exist (create_project).",
      inputSchema: {
        type: 'object',
        properties: {
          project: { type: 'string' },
          title: { type: 'string' },
          instructions: { type: 'string', description: 'Markdown: the goal, the inputs, what done looks like.' },
          agent: { type: 'string', description: 'The agent to do it, by token name; omit for any agent.' },
          priority: { type: 'integer', enum: [1, 2, 3, 4], default: 3 },
          due: { type: 'string', description: 'YYYY-MM-DD.' },
          start: { type: 'string', description: 'YYYY-MM-DD; not picked up before this date.' },
          repeat: { type: 'string', enum: REPEATS },
          outputs: { type: 'array', items: { type: 'string' }, description: 'File types expected, e.g. ["docx", "pptx"].' },
          draft: { type: 'boolean', description: 'Save without queuing it, for the user to look over first.' },
        },
        required: ['project', 'title', 'instructions'],
      },
      async run(args, token) {
        const brief = await briefs.create({
          project: str(args, 'project', { max: 300 }),
          title: str(args, 'title', { max: 300 }),
          instructions: str(args, 'instructions', { max: 200_000 }),
          agent: str(args, 'agent', { optional: true, max: 60 }),
          priority: args?.priority,
          due: str(args, 'due', { optional: true, max: 20 }),
          start: str(args, 'start', { optional: true, max: 20 }),
          repeat: str(args, 'repeat', { optional: true, max: 20 }),
          outputs: stringList(args, 'outputs'),
          status: args?.draft === true ? 'draft' : 'queued',
          createdBy: token.name,
        })
        await record(token, { action: 'created', kind: 'brief', path: brief.id, message: brief.title })
        return text(`${brief.status === 'draft' ? 'Drafted' : 'Queued'} "${brief.title}" (id ${brief.id}). Files to work from go in ${brief.contextDir}/.`)
      },
    },
    {
      name: 'get_project_context',
      readOnly: true,
      title: 'Catch up on a project',
      description:
        "Everything needed to pick up a project in one call: its overview, the latest entries of its log, its open briefs, and the files that changed most recently. Call it before working in a project you have not seen in this session.",
      inputSchema: {
        type: 'object',
        properties: { project: { type: 'string' } },
        required: ['project'],
      },
      async run(args) {
        const { project, overview, log, briefs: open, recent } = await briefs.projectContext(str(args, 'project', { max: 300 }))
        return text(
          [
            `# ${project.name} — ${project.status ?? 'no status'}`,
            project.summary,
            `## Overview (${project.overview ?? 'none'})\n${overview.trim() || '(empty)'}`,
            `## Latest log entries\n${log || '(no log yet)'}`,
            `## Open briefs\n${open.length ? open.map(describeBrief).join('\n') : '(none)'}`,
            `## Recently changed\n${recent.length ? recent.map(describeFile).join('\n') : '(nothing)'}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        )
      },
    },
    {
      name: 'list_tasks',
      readOnly: true,
      title: 'List tasks',
      description:
        "List tasks from the user's task planner. filter: inbox (no project), today (due today or overdue), upcoming, overdue, completed, or all open tasks. Use it to see what the user wants done, or to check before adding a task that may already exist.",
      inputSchema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: TASK_FILTERS, default: 'all' },
          project: { type: 'string', description: 'Only tasks in this task-planner project, by name.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
      async run(args) {
        const filter = TASK_FILTERS.includes(args?.filter) ? args.filter : 'all'
        const data = await store.loadTasks()
        const projectName = str(args, 'project', { optional: true, max: 200 })
        let projectId = null
        if (projectName) {
          projectId = findPlannerProject(data, projectName)?.id
          if (!projectId) return toolError(`No task-planner project called "${projectName}". Projects: ${plannerProjectNames(data)}.`)
        }
        const tasks = planner
          .filterTasks(data.tasks, { filter, project: projectId })
          .sort(byDueThenPriority)
          .slice(0, int(args, 'limit', 100, { min: 1, max: 500 }))
        if (!tasks.length) return text(filter === 'all' ? 'No open tasks.' : `No ${filter} tasks.`)
        return text(tasks.map((t) => describeTask(t, data)).join('\n'))
      },
    },
    {
      name: 'add_task',
      readOnly: false,
      title: 'Add a task for the user',
      description:
        "Add a task to the user's task planner — something you need them to do or decide, such as reviewing a report you wrote. It appears in Deckle's Inbox (or the named project) and in Today when it falls due. Link the note it is about with source_note.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short and actionable, e.g. "Review the Q3 competitor report".' },
          due: { type: 'string', description: 'A date as YYYY-MM-DD.' },
          priority: { type: 'integer', enum: [1, 2, 3, 4], default: 4, description: '1 is most urgent.' },
          project: { type: 'string', description: 'A task-planner project, by name. Omit for the Inbox.' },
          source_note: { type: 'string', description: 'The note this task is about, e.g. "Projects/Acme/Report.md".' },
          recurrence: {
            type: 'object',
            properties: {
              freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
              interval: { type: 'integer', minimum: 1, default: 1 },
            },
          },
        },
        required: ['title'],
      },
      async run(args, token) {
        const projectId = await resolvePlannerProject(args)
        const task = await planner.createTask({
          title: args?.title,
          due: args?.due,
          priority: args?.priority,
          recurrence: args?.recurrence,
          projectId,
          sourceNote: args?.source_note,
        })
        await record(token, { action: 'added', kind: 'task', message: task.title })
        return text(`Added task "${task.title}" (id ${task.id})${task.due ? `, due ${task.due}` : ''}.`)
      },
    },
    {
      name: 'update_task',
      readOnly: false,
      title: 'Update or complete a task',
      description:
        'Change a task by its id (from list_tasks): its title, due date, priority or project, or mark it complete. Completing a recurring task moves it to its next date, as the app does.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          due: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null to clear it.' },
          priority: { type: 'integer', enum: [1, 2, 3, 4] },
          project: { type: ['string', 'null'], description: 'A project name, or null for the Inbox.' },
          completed: { type: 'boolean' },
        },
        required: ['id'],
      },
      async run(args, token) {
        const id = str(args, 'id', { max: 200 })
        const patch = {}
        for (const key of ['title', 'due', 'priority', 'completed']) {
          if (args?.[key] !== undefined) patch[key] = args[key]
        }
        if (args?.project !== undefined) patch.projectId = await resolvePlannerProject(args)
        const task = await planner.patchTask(id, patch)
        await record(token, {
          action: args?.completed === true ? 'completed' : 'updated',
          kind: 'task',
          message: task.title,
        })
        const data = await store.loadTasks()
        return text(`Updated: ${describeTask(task, data)}`)
      },
    },
    {
      name: 'delete_task',
      readOnly: false,
      title: 'Move a task to the bin',
      description: "Move a task to the planner's bin by its id. The user can restore it for 30 days.",
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      async run(args, token) {
        const { task } = await planner.deleteTask(str(args, 'id', { max: 200 }))
        await record(token, { action: 'deleted', kind: 'task', message: task.title })
        return text(`Moved "${task.title}" to the task bin.`)
      },
    },
    {
      name: 'list_bookmarks',
      readOnly: true,
      title: 'List bookmarks',
      description: "List the user's saved bookmarks — URLs with titles and comments, in coloured collections — newest first.",
      inputSchema: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Only this collection, by name.' },
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
        },
      },
      async run(args) {
        const data = await store.loadBookmarks()
        const name = str(args, 'collection', { optional: true, max: 200 })
        let list = data.bookmarks
        if (name) {
          const collection = findByName(data.collections, name)
          if (!collection) return toolError(`No bookmark collection called "${name}".`)
          list = list.filter((b) => b.collectionId === collection.id)
        }
        list = [...list].sort((a, b) => b.createdAt - a.createdAt).slice(0, int(args, 'limit', 100, { min: 1, max: 500 }))
        if (!list.length) return text('No bookmarks.')
        const names = new Map(data.collections.map((c) => [c.id, c.name]))
        return text(
          list
            .map(
              (b) =>
                `- ${b.title} — ${b.url}` +
                (b.collectionId ? ` [${names.get(b.collectionId) ?? 'unknown collection'}]` : '') +
                (b.comment ? `\n  ${b.comment.split('\n')[0]}` : ''),
            )
            .join('\n'),
        )
      },
    },
    {
      name: 'save_bookmark',
      readOnly: false,
      title: 'Save a bookmark',
      description:
        "Save a web page to the user's bookmarks — a source you used, or something worth their reading — with a comment on why it matters. Only http and https URLs.",
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          comment: { type: 'string', description: 'Why it is worth keeping.' },
          collection: { type: 'string', description: 'An existing collection, by name. Omit for none.' },
          source_note: { type: 'string', description: 'The note that cites it.' },
        },
        required: ['url'],
      },
      async run(args, token) {
        let collectionId = null
        const name = str(args, 'collection', { optional: true, max: 200 })
        if (name) {
          const data = await store.loadBookmarks()
          const collection = findByName(data.collections, name)
          if (!collection) {
            return toolError(
              `No bookmark collection called "${name}". Collections: ${data.collections.map((c) => c.name).join(', ') || 'none'}.`,
            )
          }
          collectionId = collection.id
        }
        const bookmark = await planner.createBookmark({
          url: args?.url,
          title: args?.title,
          comment: args?.comment,
          collectionId,
          sourceNote: args?.source_note,
        })
        await record(token, { action: 'saved', kind: 'bookmark', message: `${bookmark.title} — ${bookmark.url}` })
        return text(`Saved bookmark "${bookmark.title}".`)
      },
    },
    {
      name: 'move',
      readOnly: false,
      title: 'Move or rename',
      description: 'Move or rename a note or file. Never overwrites: fails if something is already at the destination.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string', description: 'The full new path, including the file name.' },
        },
        required: ['from', 'to'],
      },
      async run(args, token) {
        const from = normalizeFilePath(str(args, 'from', { max: 1024 }))
        let to = normalizeFilePath(str(args, 'to', { max: 1024 }))
        // A note stays a note: "Archive/Plan" means "Archive/Plan.md".
        if (isNotePath(from) && !isNotePath(to)) to = normalizeNotePath(to)
        const moved = await store.moveFile(from, to)
        await record(token, { action: 'moved', kind: moved.kind, path: from, to: moved.path })
        return text(`Moved ${from} → ${moved.path}.`)
      },
    },
    {
      name: 'delete',
      readOnly: false,
      title: 'Move to the recycle bin',
      description:
        'Move a note or file to the recycle bin, where the user can restore it. Does not delete folders.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          message: { type: 'string', description: 'One line on why, shown in the activity log.' },
        },
        required: ['path'],
      },
      async run(args, token) {
        const path = normalizeFilePath(str(args, 'path', { max: 1024 }))
        const kind = await library.exists(path)
        if (kind === 'directory') return toolError(`"${path}" is a folder; this tool only deletes files.`)
        if (!kind) return toolError(`Nothing at "${path}".`)
        await store.trashEntry(path, { by: token.name })
        await record(token, {
          action: 'deleted',
          kind: isNotePath(path) ? 'note' : 'file',
          path,
          message: str(args, 'message', { optional: true, max: 1000 }),
        })
        return text(`Moved ${path} to the recycle bin.`)
      },
    },
  ]

  const byName = new Map(tools.map((t) => [t.name, t]))

  function describeTool(tool) {
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        title: tool.title,
        readOnlyHint: tool.readOnly,
        destructiveHint: ['delete', 'save_file', 'deliver_file', 'write_note', 'edit_note', 'delete_task'].includes(tool.name),
        idempotentHint: tool.readOnly,
        openWorldHint: false,
      },
    }
  }

  function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
  }

  /** Answer one JSON-RPC message; null for a notification or a response. */
  async function handleMessage(message, token) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
      return rpcError(null, -32600, 'invalid JSON-RPC message')
    }
    const { id, method, params } = message
    // A notification (no id) or a response to something we never asked: nothing to say.
    if (id === undefined || id === null || typeof method !== 'string') return null

    const canWrite = token.scope === 'rw'
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : FALLBACK_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'deckle', title: `Deckle — ${libraryName}`, version: VERSION },
            instructions: canWrite
              ? INSTRUCTIONS
              : `${INSTRUCTIONS}\n\nThis connection uses a read-only token: search, read, list, list_projects, get_project_context, recent_activity, list_briefs, list_tasks and list_bookmarks are available; nothing can be saved.`,
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: tools.filter((t) => canWrite || t.readOnly).map(describeTool) },
        }
      case 'tools/call': {
        const tool = byName.get(params?.name)
        if (!tool) return rpcError(id, -32602, `unknown tool: ${params?.name}`)
        if (!tool.readOnly && !canWrite) {
          return {
            jsonrpc: '2.0',
            id,
            result: toolError(`The token "${token.name}" is read-only, so ${tool.name} is not available.`),
          }
        }
        try {
          return { jsonrpc: '2.0', id, result: await tool.run(params?.arguments ?? {}, token) }
        } catch (err) {
          // What went wrong goes back to the model as a tool error, so it can
          // correct itself; only the unexpected is logged.
          if (err instanceof ApiError) return { jsonrpc: '2.0', id, result: toolError(err.message) }
          if (err?.code === 'ENOENT') return { jsonrpc: '2.0', id, result: toolError('Not found.') }
          if (err instanceof BadPathError) {
            return { jsonrpc: '2.0', id, result: toolError(err.message) }
          }
          if (err?.code === 'EEXIST') {
            return { jsonrpc: '2.0', id, result: toolError('Something already exists at that path.') }
          }
          if (err instanceof TooLargeError) {
            return { jsonrpc: '2.0', id, result: toolError('That file is larger than this library accepts.') }
          }
          console.error('[deckle] MCP tool failed:', tool.name, err)
          return { jsonrpc: '2.0', id, result: toolError('Deckle hit an internal error running that tool.') }
        }
      }
      default:
        return rpcError(id, -32601, `method not found: ${method}`)
    }
  }

  /**
   * Handle one HTTP request to the MCP endpoint. `readBody` returns the raw
   * text of the request; `send(status, body?, headers?)` writes the response.
   */
  async function handleHttp(req, token, { readBody, send }) {
    if (req.method === 'GET' || req.method === 'DELETE') {
      // No server-initiated stream and no sessions to end: the spec's answer
      // for both is 405.
      send(405, { error: { code: 'method_not_allowed', message: 'this MCP server answers POST only' } }, { Allow: 'POST' })
      return
    }
    if (req.method !== 'POST') {
      send(405, { error: { code: 'method_not_allowed', message: `${req.method} is not supported` } }, { Allow: 'POST' })
      return
    }

    let payload
    try {
      payload = JSON.parse(await readBody())
    } catch (err) {
      if (err instanceof TooLargeError) throw err
      send(400, rpcError(null, -32700, 'parse error'))
      return
    }

    if (Array.isArray(payload)) {
      if (!payload.length) {
        send(400, rpcError(null, -32600, 'empty batch'))
        return
      }
      if (payload.length > MAX_BATCH) {
        send(400, rpcError(null, -32600, `batch too large: at most ${MAX_BATCH} messages`))
        return
      }
      const replies = []
      for (const message of payload) {
        const reply = await handleMessage(message, token)
        if (reply) replies.push(reply)
      }
      if (!replies.length) send(202)
      else send(200, replies)
      return
    }

    const reply = await handleMessage(payload, token)
    if (!reply) send(202)
    else send(200, reply)
  }

  return { handleHttp, handleMessage, tools }
}
