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

/** Newest first. The one a client asks for is used when we know it. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const FALLBACK_VERSION = '2025-06-18'

/** Base64 inflates by a third; keep a decoded file under the JSON body cap. */
const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024
const DEFAULT_READ_CHARS = 40_000
const MAX_LIST_ENTRIES = 500

const INSTRUCTIONS = `Deckle is the user's knowledge base: plain Markdown notes and ordinary files in folders, which the user reads and reviews in the Deckle app. Treat it as long-term memory for your work.

- Before starting a task, search for what is already known, and list_projects to see where the work belongs.
- Keep each piece of work in a project: create_project once, then save everything for it under Projects/<name>/.
- Save deliverables (reports, spreadsheets, images, code) with save_file or write_note, and write findings, decisions and sources as notes rather than leaving them only in the conversation.
- After each meaningful step, log_progress with what you did, what you decided and why, and what is next.
- Link related notes and files with [[wikilinks]] — [[Q3 report.pdf]], [[Research notes]] — and describe every important file in a note, because PDFs and images are only searchable by name and by the notes that mention them.
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

// ---- The server ------------------------------------------------------------

export function createMcp({ library, store, search, activity, projects, libraryName, maxFileBytes }) {
  const inlineLimit = Math.min(MAX_INLINE_FILE_BYTES, maxFileBytes)

  const record = (token, event) => activity.record({ actor: token.name, via: 'mcp', ...event })

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
        const { note, created } = await store.writeNote(path, next, 'agent')
        await record(token, {
          action: created ? 'created' : mode === 'append' ? 'appended to' : 'replaced',
          kind: 'note',
          path: note.path,
          message,
        })
        return text(`${created ? 'Created' : mode === 'append' ? 'Appended to' : 'Replaced'} ${note.path}.`)
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
        const encoding = args?.encoding ?? 'utf8'
        if (encoding !== 'utf8' && encoding !== 'base64') return toolError(`"encoding" must be utf8 or base64.`)
        const raw = str(args, 'content', { max: Math.ceil(inlineLimit * 1.4) + 16 })
        const bytes = encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
        if (bytes.length > inlineLimit) {
          return toolError(`That is ${formatBytes(bytes.length)}; save_file takes at most ${formatBytes(inlineLimit)}. Use the deckle_push.py script for large files.`)
        }
        const message = str(args, 'message', { optional: true, max: 1000 })
        const existing = await library.exists(path)
        if (existing === 'directory') return toolError(`"${path}" is a folder.`)
        if (existing === 'file' && args?.overwrite === false) {
          return toolError(`A file already exists at "${path}" and overwrite is false.`)
        }

        if (isNotePath(path)) {
          const { note, created } = await store.writeNote(path, bytes.toString('utf8'), 'agent')
          await record(token, { action: created ? 'created' : 'replaced', kind: 'note', path: note.path, message })
          return text(`${created ? 'Saved' : 'Replaced'} ${note.path}.`)
        }
        const { file, created } = await store.putFile(path, Readable.from([bytes]), { replacedBy: token.name })
        await record(token, {
          action: created ? 'saved' : 'replaced',
          kind: 'file',
          path: file.path,
          size: file.size,
          message,
        })
        return text(
          `${created ? 'Saved' : 'Replaced'} ${file.path} (${formatBytes(file.size)}).` +
            (created ? '' : ' The previous copy is in the recycle bin.'),
        )
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
        destructiveHint: tool.name === 'delete' || tool.name === 'save_file' || tool.name === 'write_note',
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
              : `${INSTRUCTIONS}\n\nThis connection uses a read-only token: search, read, list, list_projects and recent_activity are available; nothing can be saved.`,
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
