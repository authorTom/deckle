// The OpenAPI 3.1 document served at GET /api/v1/openapi.json.
//
// This is the API's contract, and the reason an agent can be pointed at Deckle and
// work out what to do without anyone writing tool definitions by hand. It is
// hand-maintained alongside server/api.mjs — change a route there, change it
// here in the same commit, or the description stops being true.
//
// Descriptions are written for a model reading them cold: what the endpoint is
// for and when to reach for it, not just what its fields are called.

import { VERSION } from './version.mjs'

const NOTE_PATH_DESCRIPTION =
  'Note path relative to the library root, using "/" separators, e.g. "Projects/idea.md". ' +
  'The ".md" extension is added if missing. Hidden (dot) folders are reserved by Deckle and rejected.'

function ref(name) {
  return { $ref: `#/components/schemas/${name}` }
}

function jsonBody(schema, required = true) {
  return { required, content: { 'application/json': { schema } } }
}

function jsonResponse(description, schema) {
  return { description, content: { 'application/json': { schema } } }
}

const ERRORS = {
  400: jsonResponse('The request was malformed.', ref('Error')),
  401: jsonResponse('Missing or invalid bearer token.', ref('Error')),
  403: jsonResponse('The token is read-only.', ref('Error')),
  404: jsonResponse('No such note, task, bookmark, or endpoint.', ref('Error')),
  409: jsonResponse('The target already exists.', ref('Error')),
  429: jsonResponse('Too many failed authentication attempts.', ref('Error')),
  500: jsonResponse(
    'The server could not complete the request. Code `store_unreadable` means the tasks or ' +
      'bookmarks file exists but cannot be read (invalid JSON, or written by a newer Deckle); ' +
      'it is left untouched and nothing is written until a person repairs it.',
    ref('Error'),
  ),
}

/** Paths that read; only the write ones need a read-write token. */
function withErrors(operation, extra = {}) {
  return {
    ...operation,
    responses: { ...operation.responses, ...ERRORS, ...extra },
  }
}

export function buildOpenApi(libraryName) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Deckle API',
      // The build serving the document, not the contract it describes. The
      // contract is the `/api/v1` path, and it moves only when it breaks.
      version: VERSION,
      summary: 'Read and write a Deckle knowledge base over HTTP.',
      description:
        'Deckle stores a knowledge base as plain Markdown files in folders, plus a task planner ' +
        'and bookmark collections. This API exposes all of it: search and read notes, create ' +
        'and edit them, move them between folders, manage tasks and bookmarks, browse version ' +
        'history and the recycle bin, and export the whole thing as a ZIP.\n\n' +
        'Deleting a note moves it to the recycle bin rather than erasing it, and overwriting a ' +
        'note snapshots the version it replaces into version history — so edits made through ' +
        'this API are as recoverable as edits made in the app.\n\n' +
        'Authenticate every request with `Authorization: Bearer <token>`. Tokens are ' +
        'configured server-side and may be read-only, in which case any write returns 403.',
      license: { name: 'MIT' },
    },
    servers: [{ url: '/api/v1', description: `Deckle server — library "${libraryName}"` }],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'notes', description: 'Markdown notes — the knowledge base itself.' },
      { name: 'search', description: 'Find notes by meaning of the words they contain.' },
      { name: 'folders', description: 'The folder tree notes are organised into.' },
      { name: 'transfer', description: 'Bulk import and whole-library export.' },
      { name: 'tasks', description: 'The task planner and its projects.' },
      { name: 'bookmarks', description: 'Saved links and their collections.' },
      { name: 'history', description: 'Per-note version snapshots.' },
      { name: 'trash', description: 'The recycle bin deleted notes land in.' },
    ],

    paths: {
      '/health': {
        get: {
          tags: ['notes'],
          operationId: 'health',
          summary: 'Check the API is up and which library it serves.',
          responses: {
            200: jsonResponse('Service information.', {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                service: { type: 'string' },
                api: { type: 'string' },
                library: { type: 'string' },
              },
            }),
          },
        },
      },

      '/notes': {
        get: withErrors({
          tags: ['notes'],
          operationId: 'listNotes',
          summary: 'List notes in the library.',
          description:
            'Returns note paths and titles, newest-first when sorted by "updated". Use this to ' +
            'get an overview of the knowledge base; use /search when looking for something ' +
            'specific, as it ranks by relevance and returns snippets.',
          parameters: [
            {
              name: 'folder',
              in: 'query',
              schema: { type: 'string' },
              description: 'Restrict to one folder and its subfolders. Omit for the whole library.',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50, minimum: 1, maximum: 500 },
            },
            { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            {
              name: 'include_content',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description:
                'Include each note\'s full Markdown. Expensive on a large library — prefer ' +
                'reading individual notes.',
            },
            {
              name: 'sort',
              in: 'query',
              schema: { type: 'string', enum: ['path', 'title', 'updated'], default: 'path' },
            },
          ],
          responses: {
            200: jsonResponse('A page of notes.', {
              type: 'object',
              properties: {
                total: { type: 'integer' },
                limit: { type: 'integer' },
                offset: { type: 'integer' },
                notes: { type: 'array', items: ref('Note') },
              },
            }),
          },
        }),
        post: withErrors({
          tags: ['notes'],
          operationId: 'createNote',
          summary: 'Create a new note.',
          description:
            'Never overwrites: if the path is taken, the note is created under a numbered name ' +
            '("idea 1.md") and the response says where it actually landed. Use PUT to replace ' +
            'an existing note deliberately.',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              path: { type: 'string', description: NOTE_PATH_DESCRIPTION },
              title: {
                type: 'string',
                description: 'Used instead of "path" to name the note; combine with "folder".',
              },
              folder: { type: 'string', description: 'Folder for a note named by "title".' },
              content: { type: 'string', description: 'Markdown body. Defaults to empty.' },
            },
          }),
          responses: { 201: jsonResponse('The created note.', ref('Note')) },
        }),
      },

      '/notes/{path}': {
        parameters: [
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: NOTE_PATH_DESCRIPTION,
            example: 'Projects/idea.md',
          },
        ],
        get: withErrors({
          tags: ['notes'],
          operationId: 'getNote',
          summary: 'Read one note in full.',
          parameters: [
            {
              name: 'format',
              in: 'query',
              schema: { type: 'string', enum: ['json', 'markdown'], default: 'json' },
              description: '"markdown" returns the raw file as text/markdown instead of JSON.',
            },
          ],
          responses: { 200: jsonResponse('The note.', ref('Note')) },
        }),
        put: withErrors({
          tags: ['notes'],
          operationId: 'replaceNote',
          summary: 'Create or replace a note.',
          description:
            'Replaces the whole body. The version being overwritten is snapshotted into version ' +
            'history first, so the change can be undone.',
          requestBody: jsonBody({
            type: 'object',
            required: ['content'],
            properties: { content: { type: 'string' } },
          }),
          responses: {
            200: jsonResponse('The note was replaced.', ref('Note')),
            201: jsonResponse('The note was created.', ref('Note')),
          },
        }),
        patch: withErrors({
          tags: ['notes'],
          operationId: 'updateNote',
          summary: 'Append to, prepend to, rename, or move a note.',
          description:
            'Give at most one of "content", "append" or "prepend". Appending is the cheap way to ' +
            'add to a running note without resending the whole body. "path", or "title" and ' +
            '"folder", move or rename the note, carrying its version history with it.',
          requestBody: jsonBody({
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Replace the whole body.' },
              append: { type: 'string', description: 'Add to the end, on a new line.' },
              prepend: { type: 'string', description: 'Add to the start, on its own line.' },
              path: { type: 'string', description: 'Move/rename to this exact path.' },
              title: { type: 'string', description: 'New title (renames the file).' },
              folder: { type: 'string', description: 'Move into this folder.' },
            },
          }),
          responses: { 200: jsonResponse('The updated note.', ref('Note')) },
        }),
        delete: withErrors({
          tags: ['notes'],
          operationId: 'deleteNote',
          summary: 'Move a note to the recycle bin.',
          description:
            'Recoverable by default — the note goes to the recycle bin and can be restored. ' +
            'Pass permanent=true to erase it instead, which cannot be undone.',
          parameters: [
            { name: 'permanent', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: {
            200: jsonResponse('Deletion result.', {
              type: 'object',
              properties: {
                deleted: { type: 'string' },
                permanent: { type: 'boolean' },
                trash: ref('TrashItem'),
              },
            }),
          },
        }),
      },

      '/search': {
        get: withErrors({
          tags: ['search'],
          operationId: 'searchNotes',
          summary: 'Find the notes most relevant to a query.',
          description:
            'BM25 ranking over note titles, paths and content, with titles weighted heavily. ' +
            'Returns the best matches with a snippet around the match — read the full note with ' +
            'GET /notes/{path} once you know which one you want. This is the right first call ' +
            'for answering a question from the knowledge base.',
          parameters: [
            {
              name: 'q',
              in: 'query',
              required: true,
              schema: { type: 'string' },
              description: 'Keywords, a topic, or a question.',
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 10, minimum: 1, maximum: 100 },
            },
            {
              name: 'folder',
              in: 'query',
              schema: { type: 'string' },
              description: 'Restrict the search to one folder and its subfolders.',
            },
          ],
          responses: {
            200: jsonResponse('Ranked results, best first.', {
              type: 'object',
              properties: {
                query: { type: 'string' },
                count: { type: 'integer' },
                results: { type: 'array', items: ref('SearchResult') },
              },
            }),
          },
        }),
      },

      '/folders': {
        get: withErrors({
          tags: ['folders'],
          operationId: 'getTree',
          summary: 'Get the folder and note tree.',
          parameters: [
            {
              name: 'path',
              in: 'query',
              schema: { type: 'string' },
              description: 'Walk only this subtree. Omit for the whole library.',
            },
          ],
          responses: {
            200: jsonResponse('The tree.', {
              type: 'object',
              properties: {
                path: { type: 'string' },
                tree: { type: 'array', items: ref('TreeNode') },
              },
            }),
          },
        }),
        post: withErrors({
          tags: ['folders'],
          operationId: 'createFolder',
          summary: 'Create a folder, including any missing parents.',
          requestBody: jsonBody({
            type: 'object',
            required: ['path'],
            properties: { path: { type: 'string', example: 'Research/Papers' } },
          }),
          responses: { 201: jsonResponse('The created folder.', {
            type: 'object',
            properties: { path: { type: 'string' } },
          }) },
        }),
      },

      '/folders/{path}': {
        parameters: [
          { name: 'path', in: 'path', required: true, schema: { type: 'string' } },
        ],
        delete: withErrors({
          tags: ['folders'],
          operationId: 'deleteFolder',
          summary: 'Delete a folder, sending every note inside it to the recycle bin.',
          responses: {
            200: jsonResponse('Deletion result.', {
              type: 'object',
              properties: {
                deleted: { type: 'string' },
                trashed: { type: 'integer', description: 'Notes moved to the recycle bin.' },
              },
            }),
          },
        }),
      },

      '/import': {
        post: withErrors({
          tags: ['transfer'],
          operationId: 'importNotes',
          summary: 'Create many notes in one request.',
          description:
            'Each note keeps the folder structure in its path. By default nothing is ' +
            'overwritten — colliding names get a numbered suffix. Partial success is normal: ' +
            'the response reports what landed and what did not.',
          requestBody: jsonBody({
            type: 'object',
            required: ['notes'],
            properties: {
              notes: {
                type: 'array',
                maxItems: 1000,
                items: {
                  type: 'object',
                  required: ['path', 'content'],
                  properties: {
                    path: { type: 'string', example: 'Meetings/2026-07-30.md' },
                    content: { type: 'string' },
                  },
                },
              },
              folder: {
                type: 'string',
                description: 'Prefix every imported path with this folder.',
              },
              overwrite: {
                type: 'boolean',
                default: false,
                description: 'Replace existing notes instead of creating numbered copies.',
              },
            },
          }),
          responses: {
            200: jsonResponse('What was imported.', {
              type: 'object',
              properties: {
                imported: { type: 'integer' },
                failed: { type: 'integer' },
                notes: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: 'string' },
                      created: { type: 'boolean' },
                    },
                  },
                },
                errors: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      path: { type: ['string', 'null'] },
                      error: { type: 'string' },
                    },
                  },
                },
              },
            }),
          },
        }),
      },

      '/export': {
        get: withErrors({
          tags: ['transfer'],
          operationId: 'exportLibrary',
          summary: 'Download the whole knowledge base as a ZIP.',
          description:
            'Every note with its folder structure intact, plus the tasks and bookmarks files. ' +
            'The recycle bin and version history are excluded unless include_hidden is set.',
          parameters: [
            {
              name: 'include_hidden',
              in: 'query',
              schema: { type: 'boolean', default: false },
              description: 'Also include the recycle bin and version history (a full backup).',
            },
          ],
          responses: {
            200: {
              description: 'A ZIP archive.',
              content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
            },
          },
        }),
      },

      '/tasks': {
        get: withErrors({
          tags: ['tasks'],
          operationId: 'listTasks',
          summary: 'List tasks from the planner.',
          parameters: [
            {
              name: 'filter',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['all', 'inbox', 'today', 'upcoming', 'overdue', 'completed', 'deleted'],
                default: 'all',
              },
              description:
                '"today" is everything due today or earlier; "overdue" excludes today itself.',
            },
            { name: 'project', in: 'query', schema: { type: 'string' } },
            { name: 'include_completed', in: 'query', schema: { type: 'boolean', default: false } },
            { name: 'include_deleted', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: {
            200: jsonResponse('Matching tasks.', {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                tasks: { type: 'array', items: ref('Task') },
              },
            }),
          },
        }),
        post: withErrors({
          tags: ['tasks'],
          operationId: 'createTask',
          summary: 'Add a task.',
          requestBody: jsonBody(ref('TaskInput')),
          responses: { 201: jsonResponse('The created task.', ref('Task')) },
        }),
      },

      '/tasks/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: withErrors({
          tags: ['tasks'],
          operationId: 'getTask',
          summary: 'Read one task.',
          responses: { 200: jsonResponse('The task.', ref('Task')) },
        }),
        patch: withErrors({
          tags: ['tasks'],
          operationId: 'updateTask',
          summary: 'Edit a task, or mark it complete.',
          requestBody: jsonBody({
            allOf: [
              ref('TaskInput'),
              {
                type: 'object',
                properties: {
                  completed: {
                    type: 'boolean',
                    description:
                      'true completes the task — except a recurring task with a due date, whose ' +
                      'due date moves to its next occurrence instead, exactly as ticking it in the ' +
                      'app does. false reopens a completed task.',
                  },
                },
              },
            ],
          }),
          responses: { 200: jsonResponse('The updated task.', ref('Task')) },
        }),
        delete: withErrors({
          tags: ['tasks'],
          operationId: 'deleteTask',
          summary: 'Move a task to the task bin (or erase it).',
          parameters: [
            { name: 'permanent', in: 'query', schema: { type: 'boolean', default: false } },
          ],
          responses: {
            200: jsonResponse('Deletion result.', {
              type: 'object',
              properties: { deleted: { type: 'string' }, permanent: { type: 'boolean' } },
            }),
          },
        }),
      },

      '/projects': {
        get: withErrors({
          tags: ['tasks'],
          operationId: 'listProjects',
          summary: 'List task projects.',
          responses: {
            200: jsonResponse('Projects.', {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                projects: { type: 'array', items: ref('Project') },
              },
            }),
          },
        }),
        post: withErrors({
          tags: ['tasks'],
          operationId: 'createProject',
          summary: 'Create a task project.',
          requestBody: jsonBody({
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              color: {
                type: 'string',
                pattern: '^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
                description: 'Hex colour, e.g. "#30a46c". Assigned automatically if omitted.',
              },
            },
          }),
          responses: { 201: jsonResponse('The created project.', ref('Project')) },
        }),
      },

      '/bookmarks': {
        get: withErrors({
          tags: ['bookmarks'],
          operationId: 'listBookmarks',
          summary: 'List saved bookmarks.',
          parameters: [{ name: 'collection', in: 'query', schema: { type: 'string' } }],
          responses: {
            200: jsonResponse('Bookmarks.', {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                bookmarks: { type: 'array', items: ref('Bookmark') },
              },
            }),
          },
        }),
        post: withErrors({
          tags: ['bookmarks'],
          operationId: 'createBookmark',
          summary: 'Save a bookmark.',
          requestBody: jsonBody(ref('BookmarkInput')),
          responses: { 201: jsonResponse('The created bookmark.', ref('Bookmark')) },
        }),
      },

      '/bookmarks/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: withErrors({
          tags: ['bookmarks'],
          operationId: 'getBookmark',
          summary: 'Read one bookmark.',
          responses: { 200: jsonResponse('The bookmark.', ref('Bookmark')) },
        }),
        patch: withErrors({
          tags: ['bookmarks'],
          operationId: 'updateBookmark',
          summary: 'Edit a bookmark.',
          requestBody: jsonBody(ref('BookmarkInput')),
          responses: { 200: jsonResponse('The updated bookmark.', ref('Bookmark')) },
        }),
        delete: withErrors({
          tags: ['bookmarks'],
          operationId: 'deleteBookmark',
          summary: 'Delete a bookmark.',
          responses: {
            200: jsonResponse('Deletion result.', {
              type: 'object',
              properties: { deleted: { type: 'string' } },
            }),
          },
        }),
      },

      '/collections': {
        get: withErrors({
          tags: ['bookmarks'],
          operationId: 'listCollections',
          summary: 'List bookmark collections.',
          responses: {
            200: jsonResponse('Collections.', {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                collections: { type: 'array', items: ref('Collection') },
              },
            }),
          },
        }),
        post: withErrors({
          tags: ['bookmarks'],
          operationId: 'createCollection',
          summary: 'Create a bookmark collection.',
          requestBody: jsonBody({
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string' },
              color: {
                type: 'string',
                pattern: '^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$',
                description: 'Hex colour, e.g. "#0091ff". Assigned automatically if omitted.',
              },
            },
          }),
          responses: { 201: jsonResponse('The created collection.', ref('Collection')) },
        }),
      },

      '/history': {
        get: withErrors({
          tags: ['history'],
          operationId: 'listHistory',
          summary: 'List version snapshots.',
          description:
            'Snapshots are taken automatically before a note is overwritten. Up to 20 are kept ' +
            'per note.',
          parameters: [
            {
              name: 'path',
              in: 'query',
              schema: { type: 'string' },
              description: 'Only this note\'s snapshots. Omit for every note.',
            },
          ],
          responses: {
            200: jsonResponse('Snapshots, newest first.', {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                snapshots: { type: 'array', items: ref('Snapshot') },
              },
            }),
          },
        }),
      },

      '/history/{snapshot}': {
        parameters: [
          { name: 'snapshot', in: 'path', required: true, schema: { type: 'string' } },
        ],
        get: withErrors({
          tags: ['history'],
          operationId: 'readSnapshot',
          summary: 'Read the content of one snapshot.',
          responses: {
            200: jsonResponse('The snapshot.', {
              type: 'object',
              properties: { snapshot: { type: 'string' }, content: { type: 'string' } },
            }),
          },
        }),
      },

      '/history/{snapshot}/restore': {
        parameters: [
          { name: 'snapshot', in: 'path', required: true, schema: { type: 'string' } },
        ],
        post: withErrors({
          tags: ['history'],
          operationId: 'restoreSnapshot',
          summary: 'Restore a snapshot over its note.',
          description:
            'The note\'s current content is snapshotted first, so a restore is itself reversible.',
          responses: { 200: jsonResponse('The restored note.', ref('Note')) },
        }),
      },

      '/trash': {
        get: withErrors({
          tags: ['trash'],
          operationId: 'listTrash',
          summary: 'List notes in the recycle bin.',
          responses: {
            200: jsonResponse('Recycle bin contents, newest first.', {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                items: { type: 'array', items: ref('TrashItem') },
              },
            }),
          },
        }),
      },

      '/trash/{trashName}': {
        parameters: [
          { name: 'trashName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        delete: withErrors({
          tags: ['trash'],
          operationId: 'purgeTrashItem',
          summary: 'Permanently delete one recycle bin item.',
          responses: {
            200: jsonResponse('Deletion result.', {
              type: 'object',
              properties: { deleted: { type: 'string' } },
            }),
          },
        }),
      },

      '/trash/{trashName}/restore': {
        parameters: [
          { name: 'trashName', in: 'path', required: true, schema: { type: 'string' } },
        ],
        post: withErrors({
          tags: ['trash'],
          operationId: 'restoreTrashItem',
          summary: 'Restore a note from the recycle bin to where it was deleted from.',
          responses: { 200: jsonResponse('The restored note.', ref('Note')) },
        }),
      },
    },

    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'A token from the server\'s DECKLE_API_TOKENS. Tokens may be read-only, in which ' +
            'case POST, PUT, PATCH and DELETE return 403.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', example: 'not_found' },
                message: { type: 'string' },
              },
            },
          },
        },
        Note: {
          type: 'object',
          properties: {
            path: { type: 'string', example: 'Projects/idea.md' },
            title: { type: 'string', example: 'idea' },
            folder: { type: 'string', example: 'Projects' },
            content: { type: 'string', description: 'Markdown body.' },
            updatedAt: { type: 'integer', description: 'Unix milliseconds.' },
            size: { type: 'integer', description: 'Bytes on disk.' },
          },
        },
        SearchResult: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            title: { type: 'string' },
            folder: { type: 'string' },
            score: { type: 'number', description: 'BM25 relevance; higher is better.' },
            snippet: { type: 'string', description: 'Text around the best match.' },
            updatedAt: { type: 'integer' },
          },
        },
        TreeNode: {
          type: 'object',
          description: 'A folder (with children) or a note.',
          properties: {
            kind: { type: 'string', enum: ['folder', 'file'] },
            id: { type: 'string', description: 'Library-relative path.' },
            name: { type: 'string' },
            title: { type: 'string', description: 'Files only: the name without ".md".' },
            updatedAt: { type: 'integer', description: 'Files only.' },
            children: {
              type: 'array',
              description: 'Folders only.',
              items: ref('TreeNode'),
            },
          },
        },
        TaskInput: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            projectId: {
              type: ['string', 'null'],
              description: 'null puts the task in the Inbox.',
            },
            due: {
              type: ['string', 'null'],
              pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              description: 'A real local calendar date ("2026-02-31" is refused), or null for undated.',
            },
            priority: {
              type: 'integer',
              enum: [1, 2, 3, 4],
              description: '1 is highest; 4 is the default "no priority".',
            },
            recurrence: {
              type: ['object', 'null'],
              properties: {
                freq: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
                interval: { type: 'integer', minimum: 1 },
              },
            },
            sourceNote: {
              type: 'string',
              description: 'Path of a note this task came from; links the two in the app.',
            },
          },
        },
        Task: {
          allOf: [
            ref('TaskInput'),
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                completedAt: { type: ['integer', 'null'] },
                deletedAt: { type: ['integer', 'null'] },
                createdAt: { type: 'integer' },
              },
            },
          ],
        },
        Project: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            color: { type: 'string' },
          },
        },
        BookmarkInput: {
          type: 'object',
          properties: {
            url: { type: 'string', format: 'uri' },
            title: { type: 'string', description: 'Defaults to the URL\'s hostname.' },
            comment: { type: 'string', description: 'Why it was saved, prices, thoughts.' },
            collectionId: { type: ['string', 'null'] },
            sourceNote: { type: 'string' },
          },
        },
        Bookmark: {
          allOf: [
            ref('BookmarkInput'),
            {
              type: 'object',
              properties: {
                id: { type: 'string' },
                createdAt: { type: 'integer' },
              },
            },
          ],
        },
        Collection: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            color: { type: 'string' },
          },
        },
        Snapshot: {
          type: 'object',
          properties: {
            snapName: { type: 'string', description: 'Identifier for /history/{snapshot}.' },
            noteId: { type: 'string', description: 'The note this version belongs to.' },
            savedAt: { type: 'integer' },
            reason: { type: 'string', enum: ['edit', 'ai', 'restore'] },
          },
        },
        TrashItem: {
          type: 'object',
          properties: {
            trashName: { type: 'string', description: 'Identifier for /trash/{trashName}.' },
            originalPath: { type: 'string' },
            title: { type: 'string' },
            deletedAt: { type: 'integer' },
          },
        },
      },
    },
  }
}
