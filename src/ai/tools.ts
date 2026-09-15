import { READ_FILE_BUDGET, windowText } from './context'
import * as library from '../fs/library'
import * as history from '../fs/history'
import { searchLibrary } from './retrieval'
import * as memory from '../memory/store'
import { findDuplicate } from '../memory/context'
import { rankBm25, tokenize, toRankDoc } from '../lib/bm25'
import type { MemoryKind } from '../memory/types'
import type { TreeNode } from '../fs/library'
import type { AssistantSettings, ToolCall, ToolDef } from './types'

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'list_files',
    description:
      'List every folder and Markdown note in the library as an indented tree. Use this first to understand the structure.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    readOnly: true,
  },
  {
    name: 'search_notes',
    description:
      'Search the library for notes relevant to a query — matches titles, paths, and content (plus semantic similarity when enabled). Returns the best-matching note paths with snippets; use read_file to read a result in full.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'What to look for — a question, topic, or keywords.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'read_file',
    description:
      'Read the Markdown contents of a note. A very long note comes back with its middle elided and a marker saying so — when that happens you are holding an excerpt, so edit it in place rather than rewriting the whole file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path, e.g. "Projects/idea.md".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'write_file',
    description:
      'Create a new note or overwrite an existing one with the given Markdown content. Creates parent folders as needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Note path ending in .md' },
        content: { type: 'string', description: 'Full Markdown content of the note.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'create_folder',
    description: 'Create a folder (and any missing parent folders) at the given path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder path, e.g. "Projects/2026".' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'move_file',
    description: 'Move or rename a note from one path to another.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Current note path.' },
        to: { type: 'string', description: 'New note path (ending in .md).' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'delete_file',
    description: 'Move a note to the recycle bin (recoverable).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Note path.' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
  },
  {
    name: 'delete_folder',
    description:
      'Move a folder and all of its notes to the recycle bin (recoverable).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Folder path.' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
  },

  // ---- Memory -------------------------------------------------------------
  // Descriptions are written for a model reading them cold, and say when *not*
  // to reach for the tool as well as when to: a memory store fills with noise
  // far more easily than it fills with anything useful.
  {
    name: 'search_memory',
    description:
      'Search your memory for what you have learned about this user and their library. The memory index is already in your context — use this when the index hints at something and you want the details, or to check whether you already know a fact before remembering it again.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you are trying to recall.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'read_memory',
    description:
      'Read one memory in full, by the path shown in the memory index (e.g. "preferences/british-spelling.md").',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Memory path.' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: true,
  },
  {
    name: 'remember',
    description:
      'Store something worth knowing next time: a stable preference, a convention the user works by, an ongoing project, or a fact about a person. Remember durable things, not passing ones — not what was just asked, not the contents of a note you can re-read, and not anything you are guessing at. Say why you believe it in the body. If a memory of this already exists it is updated rather than duplicated.',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'One line, the whole point of the memory. This is what you will see in the index every turn, so make it stand on its own.',
        },
        body: {
          type: 'string',
          description:
            'The detail, as Markdown. Include why you believe it — the evidence, not just the claim.',
        },
        kind: {
          type: 'string',
          enum: ['preference', 'project', 'person', 'fact', 'convention'],
          description: 'Which bucket this belongs in. Defaults to "fact".',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'A few short tags, for grouping and retrieval.',
        },
        pinned: {
          type: 'boolean',
          description:
            'True only for things true on every single turn — who the user is, how they want to be written to. Pinned memories cost tokens on every request, so pin sparingly.',
        },
      },
      required: ['summary', 'body'],
      additionalProperties: false,
    },
    readOnly: false,
    autoApply: true,
  },
  {
    name: 'update_memory',
    description:
      'Correct or extend a memory you already hold. Prefer this to remembering a near-duplicate, and use it the moment the user contradicts something you have stored.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Memory path from the index.' },
        summary: { type: 'string', description: 'Replacement one-line summary.' },
        body: { type: 'string', description: 'Replacement body.' },
        pinned: { type: 'boolean', description: 'Change whether it is always in context.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    autoApply: true,
  },
  {
    name: 'forget',
    description:
      'Delete a memory that is wrong, stale, or was never worth keeping. The file is removed from the library; the user can also do this from the Memory panel.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Memory path from the index.' } },
      required: ['path'],
      additionalProperties: false,
    },
    readOnly: false,
    autoApply: true,
  },
]

export function toolByName(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name)
}

function renderTree(nodes: TreeNode[], depth = 0): string {
  return nodes
    .map((node) => {
      const indent = '  '.repeat(depth)
      if (node.kind === 'folder') {
        return `${indent}${node.name}/\n${renderTree(node.children, depth + 1)}`
      }
      return `${indent}${node.name}\n`
    })
    .join('')
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== 'string') throw new Error(`Missing or invalid "${key}"`)
  return v
}

/**
 * A library path from the model, checked before it reaches a backend.
 *
 * The backends refuse ".." on their own today, but a tool argument is the
 * least trusted input in the app — a note the model has just read can tell it
 * what to type — so the tools don't rely on that. Writes are also kept out of
 * hidden folders: those hold the recycle bin, version history, tasks and
 * memory, and a "note" written there is invisible in the tree.
 */
function pathArg(
  args: Record<string, unknown>,
  key: string,
  { mutating }: { mutating: boolean },
): string {
  const value = str(args, key)
  const segments = value.split('/')
  if (
    !value.trim() ||
    value.startsWith('/') ||
    /[\u0000-\u001f\u007f\\]/.test(value) ||
    segments.some((s) => s === '.' || s === '..')
  ) {
    throw new Error(
      `"${value}" is not a usable library path. Use a relative path such as "Projects/idea.md".`,
    )
  }
  if (mutating && segments.some((s) => s.startsWith('.'))) {
    throw new Error(
      `"${value}" is inside a hidden folder, which holds Deckle's own data. Write notes to a visible folder instead.`,
    )
  }
  return value
}

/** Execute a tool against the library. Returns a text result for the model. */
export async function executeTool(
  dir: FileSystemDirectoryHandle,
  call: ToolCall,
  ctx?: { settings: AssistantSettings },
): Promise<string> {
  const a = call.arguments
  switch (call.name) {
    case 'list_files': {
      const tree = await library.buildTree(dir)
      return renderTree(tree).trim() || '(the library is empty)'
    }
    case 'search_notes': {
      const files = library.flattenFiles(await library.buildTree(dir))
      const results = await searchLibrary(dir, files, str(a, 'query'), ctx?.settings)
      if (!results.length) return 'No matching notes found.'
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.id}\n   ${r.snippet || '(empty note)'}`,
      )
      return `Most relevant notes (best first):\n\n${lines.join('\n')}\n\nUse read_file to read any of these in full.`
    }
    case 'read_file':
      // Capped, because a note is a file on the user's disk and nothing stops
      // one being a megabyte. Unbounded, a single read_file could spend the
      // whole context window and take the conversation down with it.
      return windowText(
        await library.readNote(dir, pathArg(a, 'path', { mutating: false })),
        READ_FILE_BUDGET,
      )
    case 'write_file': {
      const path = pathArg(a, 'path', { mutating: true })
      // Keep a restorable snapshot of anything the AI is about to overwrite.
      try {
        const before = await library.readNote(dir, path)
        if (before.trim()) await history.snapshotNote(dir, path, before, 'ai')
      } catch {
        // New file — nothing to snapshot.
      }
      await library.writeNote(dir, path, str(a, 'content'))
      return `Saved ${path}`
    }
    case 'create_folder': {
      const path = pathArg(a, 'path', { mutating: true })
      await library.ensureFolder(dir, path)
      return `Created folder ${path}`
    }
    case 'move_file': {
      const from = pathArg(a, 'from', { mutating: true })
      const to = pathArg(a, 'to', { mutating: true })
      await library.movePath(dir, from, to)
      await history.retargetHistory(dir, from, to)
      return `Moved ${from} to ${to}`
    }
    case 'delete_file': {
      const path = pathArg(a, 'path', { mutating: true })
      await library.trashNote(dir, path)
      return `Moved ${path} to the recycle bin`
    }
    case 'delete_folder': {
      const path = pathArg(a, 'path', { mutating: true })
      await library.trashFolder(dir, path)
      return `Moved folder ${path} to the recycle bin`
    }

    // ---- Memory -----------------------------------------------------------
    case 'search_memory': {
      const all = await memory.loadMemories(dir)
      if (!all.length) return 'Nothing remembered yet.'
      const docs = all.map((m) =>
        toRankDoc(m, [
          ...tokenize(m.summary).flatMap((t) => [t, t, t]),
          ...tokenize(m.tags.join(' ')).flatMap((t) => [t, t]),
          ...tokenize(m.body),
        ]),
      )
      const hits = rankBm25(docs, str(a, 'query')).slice(0, 5)
      if (!hits.length) return 'No memory matches that.'
      return hits
        .map(({ item }) => `${item.path} — ${item.summary}\n${item.body}`)
        .join('\n\n---\n\n')
    }
    case 'read_memory': {
      const path = str(a, 'path')
      const all = await memory.loadMemories(dir)
      const found = all.find((m) => m.path === path)
      if (!found) return `No memory at ${path}. Check the index for the exact path.`
      return `${found.summary}\n\n${found.body}`
    }
    case 'remember': {
      const summary = str(a, 'summary')
      const body = str(a, 'body')
      // Update rather than duplicate. The model is told this happens, so a
      // "remembered" result for something it already knew is not a surprise.
      const existing = findDuplicate(await memory.loadMemories(dir), summary, body)
      if (existing) {
        const merged = await memory.updateMemory(dir, existing.path, { summary, body })
        // Both outcomes end with the path and nothing after it, so a model that
        // wants to pin or amend what it just wrote doesn't have to parse prose
        // to find out where it went.
        return `You already knew this, so it was updated rather than duplicated: ${merged.path}`
      }
      const created = await memory.createMemory(dir, {
        summary,
        body,
        kind: (a.kind as MemoryKind) ?? undefined,
        tags: Array.isArray(a.tags) ? (a.tags as string[]) : undefined,
        pinned: a.pinned === true,
      })
      return `Remembered: ${created.path}`
    }
    case 'update_memory': {
      const path = str(a, 'path')
      const patch: Parameters<typeof memory.updateMemory>[2] = {}
      if (typeof a.summary === 'string') patch.summary = a.summary
      if (typeof a.body === 'string') patch.body = a.body
      if (typeof a.pinned === 'boolean') patch.pinned = a.pinned
      await memory.updateMemory(dir, path, patch)
      return `Updated ${path}`
    }
    case 'forget': {
      const path = str(a, 'path')
      await memory.deleteMemory(dir, path)
      return `Forgot ${path}`
    }
    default:
      throw new Error(`Unknown tool: ${call.name}`)
  }
}

export interface ActionPreview {
  /** A "write" preview shows a before/after diff; "generic" is a one-line summary. */
  kind: 'write' | 'generic'
  summary: string
  path?: string
  before?: string
  after?: string
}

/** Build a human-readable preview of a mutating tool call for the approval card. */
export async function buildPreview(
  dir: FileSystemDirectoryHandle,
  call: ToolCall,
): Promise<ActionPreview> {
  const a = call.arguments
  switch (call.name) {
    case 'write_file': {
      const path = str(a, 'path')
      let before = ''
      try {
        before = await library.readNote(dir, path)
      } catch {
        before = ''
      }
      return {
        kind: 'write',
        summary: before ? `Overwrite ${path}` : `Create ${path}`,
        path,
        before,
        after: str(a, 'content'),
      }
    }
    case 'create_folder':
      return { kind: 'generic', summary: `Create folder “${str(a, 'path')}”` }
    case 'move_file':
      return {
        kind: 'generic',
        summary: `Move “${str(a, 'from')}” → “${str(a, 'to')}”`,
      }
    case 'delete_file':
      return {
        kind: 'generic',
        summary: `Move “${str(a, 'path')}” to the recycle bin`,
      }
    case 'delete_folder':
      return {
        kind: 'generic',
        summary: `Move folder “${str(a, 'path')}” and its notes to the recycle bin`,
      }
    default:
      return { kind: 'generic', summary: `${call.name}(${JSON.stringify(a)})` }
  }
}
