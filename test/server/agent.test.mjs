// Deckle as a knowledge base for an agent, through the real HTTP handler: files
// of any type over /api/v1/files, the activity log, and the MCP endpoint an
// agent such as Hermes connects to.

import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP, startServer } from '../helpers/server.mjs'
import { docx, xlsx } from '../helpers/office.mjs'

const RW = 'rw-secret-0123456789abcdef'
const RO = 'ro-secret-0123456789abcdef'
const enc = (p) => p.split('/').map(encodeURIComponent).join('/')
const bytes = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256))

describe('files, activity and MCP', () => {
  let s
  beforeAll(async () => {
    s = await startServer({
      DECKLE_API_TOKENS: `hermes:rw:${RW},reader:r:${RO}`,
      DECKLE_MAX_FILE_MB: '1',
    })
  })
  afterAll(() => s.close())

  const auth = (token = RW) => ({ Authorization: `Bearer ${token}` })
  const put = (p, body, { token, query = '' } = {}) =>
    s.fetch(`/api/v1/files/${enc(p)}${query}`, { method: 'PUT', headers: auth(token), body })
  const json = async (res) => ({ status: res.status, body: await res.json() })

  describe('/api/v1/files', () => {
    it('stores any file byte for byte, and serves it back as a download', async () => {
      const pdf = bytes(4096)
      const created = await json(await put('Projects/Acme/Deliverables/Q3 report.pdf', pdf))
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ path: 'Projects/Acme/Deliverables/Q3 report.pdf', kind: 'file', ext: 'pdf', size: 4096 })

      const res = await s.fetch(`/api/v1/files/${enc('Projects/Acme/Deliverables/Q3 report.pdf')}`, { headers: auth(RO) })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/pdf')
      expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''Q3%20report.pdf")
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
      expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), pdf)).toBe(0)

      const meta = await json(await s.fetch(`/api/v1/files/${enc('Projects/Acme/Deliverables/Q3 report.pdf')}?meta=true`, { headers: auth() }))
      expect(meta.body).toMatchObject({ kind: 'file', size: 4096 })
    })

    it('keeps the replaced version in the bin, and can refuse to overwrite', async () => {
      await put('data.csv', 'a,b\n1,2')
      const replaced = await put('data.csv', 'a,b\n3,4')
      expect(replaced.status).toBe(200)
      expect((await put('data.csv', 'x', { query: '?overwrite=false' })).status).toBe(409)
      const trash = await json(await s.fetch('/api/v1/trash', { headers: auth() }))
      expect(trash.body.items.find((i) => i.originalPath === 'data.csv')).toMatchObject({ reason: 'replaced', by: 'hermes' })
    })

    it('treats a .md upload as a note, with version history', async () => {
      await put('Inbox/idea.md', '# One')
      await put('Inbox/idea.md', '# Two')
      const history = await json(await s.fetch('/api/v1/history?path=Inbox/idea.md', { headers: auth() }))
      expect(history.body.snapshots[0]).toMatchObject({ noteId: 'Inbox/idea.md', reason: 'agent' })
    })

    it('refuses files over DECKLE_MAX_FILE_MB, hidden paths, and read-only tokens', async () => {
      const big = await put('big.bin', bytes(1024 * 1024 + 1))
      expect(big.status).toBe(413)
      expect(await s.fetch('/api/v1/files/big.bin', { headers: auth() }).then((r) => r.status)).toBe(404)
      expect((await put('.deckle/tasks.json', '{}')).status).toBe(400)
      // Encoded, or fetch would resolve the dots away before sending.
      const traversal = await s.fetch('/api/v1/files/..%2Fescape.bin', { method: 'PUT', headers: auth(), body: 'x' })
      expect(traversal.status).toBe(400)
      expect((await put('nope.bin', 'x', { token: RO })).status).toBe(403)
    })

    it('lists files newest first, filtered by folder and kind', async () => {
      const { body } = await json(await s.fetch('/api/v1/files?folder=Projects', { headers: auth() }))
      expect(body.files.map((f) => f.path)).toContain('Projects/Acme/Deliverables/Q3 report.pdf')
      const notes = await json(await s.fetch('/api/v1/files?kind=note', { headers: auth() }))
      expect(notes.body.files.every((f) => f.kind === 'note')).toBe(true)
    })

    it('bins files, and a folder delete bins everything in it', async () => {
      await put('Scratch/a.png', bytes(10))
      await put('Scratch/deep/b.xlsx', bytes(10))
      const del = await json(await s.fetch('/api/v1/files/Scratch/a.png', { method: 'DELETE', headers: auth() }))
      expect(del.body).toMatchObject({ deleted: 'Scratch/a.png', permanent: false })
      const folder = await json(await s.fetch('/api/v1/folders/Scratch', { method: 'DELETE', headers: auth() }))
      expect(folder.body).toMatchObject({ trashed: 1 })
      await expect(fs.stat(path.join(s.libraryDir, 'Scratch'))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    it('shows files in the app’s tree and the API’s folder listing', async () => {
      const { tree } = await (await s.fetch('/api/library/tree?path=Projects/Acme/Deliverables', { headers: APP })).json()
      expect(tree[0]).toMatchObject({ kind: 'asset', name: 'Q3 report.pdf', ext: 'pdf' })
      // Notes listings still list notes only.
      const notes = await json(await s.fetch('/api/v1/notes?folder=Projects', { headers: auth() }))
      expect(notes.body.notes.every((n) => n.path.endsWith('.md'))).toBe(true)
    })

    it('searches inside documents', async () => {
      await put('Projects/Acme/Brief.docx', await docx())
      await put('Projects/Acme/Model.xlsx', await xlsx())
      const hits = await json(await s.fetch('/api/v1/search?q=addressable+market', { headers: auth() }))
      expect(hits.body.results[0]).toMatchObject({ path: 'Projects/Acme/Brief.docx', kind: 'file' })
      const files = await json(await s.fetch('/api/v1/search?q=revenue&kind=file', { headers: auth() }))
      expect(files.body.results[0].path).toBe('Projects/Acme/Model.xlsx')
    })
  })

  describe('/api/v1/activity', () => {
    it('names the token behind every write, newest first, filtered by project', async () => {
      const { body } = await json(await s.fetch('/api/v1/activity?limit=500', { headers: auth(RO) }))
      expect(body.events[0].at).toBeGreaterThanOrEqual(body.events.at(-1).at)
      expect(body.events.every((e) => e.actor === 'hermes' && e.via === 'api')).toBe(true)
      expect(body.events).toContainEqual(
        expect.objectContaining({ action: 'saved', kind: 'file', path: 'Projects/Acme/Deliverables/Q3 report.pdf', project: 'Acme', size: 4096 }),
      )
      expect(body.events).toContainEqual(expect.objectContaining({ action: 'replaced', path: 'data.csv' }))
      expect(body.events).toContainEqual(expect.objectContaining({ action: 'deleted', kind: 'folder', path: 'Scratch', count: 1 }))

      const acme = await json(await s.fetch('/api/v1/activity?project=Acme', { headers: auth() }))
      expect(acme.body.events.every((e) => e.project === 'Acme')).toBe(true)
      const since = await json(await s.fetch(`/api/v1/activity?since=${Date.now() + 60_000}`, { headers: auth() }))
      expect(since.body.count).toBe(0)
      expect((await s.fetch('/api/v1/activity?since=soon', { headers: auth() })).status).toBe(400)
    })

    it('is readable by the app through the library, which polls it for changes', async () => {
      const res = await s.fetch('/api/library/stat?path=.deckle/activity.jsonl', { headers: APP })
      expect(await res.json()).toMatchObject({ kind: 'file' })
    })
  })

  describe('MCP at /api/v1/mcp', () => {
    let nextId = 1
    const rpc = async (method, params, { token = RW, headers = {} } = {}) => {
      const res = await s.fetch('/api/v1/mcp', {
        method: 'POST',
        headers: {
          ...auth(token),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      })
      return { status: res.status, body: res.status === 202 ? null : await res.json() }
    }
    const call = async (name, args, options) => {
      const { body } = await rpc('tools/call', { name, arguments: args }, options)
      if (body.error) throw new Error(body.error.message)
      return { text: body.result.content[0].text, isError: body.result.isError === true }
    }

    it('initialises, echoing a protocol version it knows', async () => {
      const { status, body } = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'hermes', version: '1' },
      })
      expect(status).toBe(200)
      expect(body.result).toMatchObject({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'deckle' },
      })
      expect(body.result.instructions).toContain('log_progress')
      const unknown = await rpc('initialize', { protocolVersion: '2099-01-01' })
      expect(unknown.body.result.protocolVersion).toBe('2025-06-18')
    })

    it('accepts notifications with 202, refuses GET, and needs a token', async () => {
      const note = await s.fetch('/api/v1/mcp', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      })
      expect(note.status).toBe(202)
      expect(await note.text()).toBe('')
      expect((await s.fetch('/api/v1/mcp', { headers: auth() })).status).toBe(405)
      expect((await s.fetch('/api/v1/mcp', { method: 'POST', body: '{}' })).status).toBe(401)
    })

    it('answers malformed JSON, unknown methods and batches per JSON-RPC', async () => {
      const bad = await s.fetch('/api/v1/mcp', { method: 'POST', headers: auth(), body: '{nope' })
      expect(bad.status).toBe(400)
      expect((await bad.json()).error.code).toBe(-32700)
      expect((await rpc('resources/list')).body.error.code).toBe(-32601)
      const batch = await s.fetch('/api/v1/mcp', {
        method: 'POST',
        headers: { ...auth(), 'Content-Type': 'application/json' },
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 'a', method: 'ping' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
        ]),
      })
      expect(await batch.json()).toEqual([{ jsonrpc: '2.0', id: 'a', result: {} }])
    })

    it('refuses a browser origin it was not told about', async () => {
      const res = await rpc('ping', {}, { headers: { Origin: 'https://evil.example' } })
      expect(res.status).toBe(403)
    })

    it('shows a read-only token the read tools only, and refuses it the rest', async () => {
      const all = (await rpc('tools/list')).body.result.tools.map((t) => t.name)
      expect(all).toEqual(expect.arrayContaining(['search', 'read', 'write_note', 'save_file', 'create_project', 'log_progress']))
      const readOnly = (await rpc('tools/list', {}, { token: RO })).body.result.tools
      expect(readOnly.map((t) => t.name).sort()).toEqual(['list', 'list_projects', 'read', 'recent_activity', 'search'])
      expect(readOnly.every((t) => t.annotations.readOnlyHint)).toBe(true)
      const refused = await call('write_note', { path: 'x.md', content: 'x' }, { token: RO })
      expect(refused).toMatchObject({ isError: true })
      expect(refused.text).toContain('read-only')
      expect(await fs.stat(path.join(s.libraryDir, 'x.md')).catch(() => null)).toBeNull()
    })

    it('runs a whole piece of work: project, notes, files, log, search, read', async () => {
      expect((await call('list_projects', {})).text).toContain('Acme')

      const created = await call('create_project', {
        name: 'Hermes trial',
        summary: 'Evaluate vendors for the data pipeline.',
        tags: ['vendors'],
      })
      expect(created.text).toContain('Projects/Hermes trial/')

      const note = await call('write_note', {
        path: 'Projects/Hermes trial/Vendor comparison',
        content: '# Vendor comparison\n\nFivetran is fastest to set up. See [[scores.csv]].',
        message: 'first pass',
      })
      expect(note.text).toBe('Created Projects/Hermes trial/Vendor comparison.md.')
      const clash = await call('write_note', { path: 'Projects/Hermes trial/Vendor comparison.md', content: 'again' })
      expect(clash.text).toContain('Vendor comparison 1.md')
      await call('write_note', { path: 'Projects/Hermes trial/Vendor comparison.md', content: '\nAirbyte is cheaper.', mode: 'append' })

      const csv = await call('save_file', { path: 'Projects/Hermes trial/scores.csv', content: 'vendor,score\nFivetran,8\nAirbyte,7' })
      expect(csv.text).toContain('Saved Projects/Hermes trial/scores.csv')
      const png = bytes(2048)
      const image = await call('save_file', {
        path: 'Projects/Hermes trial/chart.png',
        content: png.toString('base64'),
        encoding: 'base64',
        message: 'score chart',
      })
      expect(image.text).toContain('2.0 KB')
      const stored = await fs.readFile(path.join(s.libraryDir, 'Projects/Hermes trial/chart.png'))
      expect(Buffer.compare(stored, png)).toBe(0)
      expect((await call('save_file', { path: 'Projects/Hermes trial/chart.png', content: 'x', overwrite: false })).isError).toBe(true)

      await call('log_progress', { project: 'Hermes trial', entry: 'Scored two vendors — see [[scores.csv]].' })
      await call('update_project', { name: 'Hermes trial', status: 'done' })
      expect((await call('list_projects', { status: 'done' })).text).toContain('Hermes trial [done]')

      const found = await call('search', { query: 'Airbyte cheaper' })
      expect(found.text).toContain('Projects/Hermes trial/Vendor comparison.md')
      const read = await call('read', { path: 'Projects/Hermes trial/Vendor comparison' })
      expect(read.text).toContain('Fivetran is fastest to set up.')
      expect(read.text).toContain('Airbyte is cheaper.')
      const sheet = await call('read', { path: 'Projects/Acme/Model.xlsx' })
      expect(sheet.text).toContain('## Revenue')
      const binary = await call('read', { path: 'Projects/Hermes trial/chart.png' })
      expect(binary.text).toContain("can't read the contents")
      const listing = await call('list', { folder: 'Projects/Hermes trial' })
      expect(listing.text).toContain('Projects/Hermes trial/chart.png  (png, 2.0 KB')

      const log = await fs.readFile(path.join(s.libraryDir, 'Projects/Hermes trial/Log.md'), 'utf8')
      expect(log).toContain('· hermes — Scored two vendors — see [[scores.csv]].')

      const activity = await call('recent_activity', { project: 'Hermes trial' })
      expect(activity.text).toMatch(/hermes logged note Projects\/Hermes trial\/Log\.md/)
      expect(activity.text).toContain('hermes saved file Projects/Hermes trial/chart.png — score chart')
    })

    it('reads long text in windows, and moves and deletes', async () => {
      await call('write_note', { path: 'Long.md', content: 'x'.repeat(5000) })
      const first = await call('read', { path: 'Long.md', max_chars: 1000 })
      expect(first.text).toContain('offset=1000')
      const rest = await call('read', { path: 'Long.md', offset: 4500, max_chars: 1000 })
      expect(rest.text).not.toContain('offset=')

      expect((await call('move', { from: 'Long.md', to: 'Archive/Long' })).text).toBe('Moved Long.md → Archive/Long.md.')
      // Never over something that exists — and a note stays a note, so "Taken" means Taken.md.
      await call('write_note', { path: 'Taken.md', content: 'mine' })
      expect((await call('move', { from: 'Archive/Long.md', to: 'Taken' })).isError).toBe(true)
      expect((await call('delete', { path: 'Archive/Long.md' })).text).toContain('recycle bin')
      expect((await call('delete', { path: 'Archive' })).isError).toBe(true)
      expect((await call('read', { path: 'Archive/Long.md' })).isError).toBe(true)
    })

    it('turns bad arguments into tool errors the model can read, not protocol failures', async () => {
      expect(await call('read', {})).toMatchObject({ isError: true, text: '"path" is required' })
      expect((await call('read', { path: '../../etc/passwd' })).isError).toBe(true)
      expect((await call('create_project', { name: 'Bad', summary: 'x', status: 'finished' })).isError).toBe(true)
      expect((await rpc('tools/call', { name: 'format_disk', arguments: {} })).body.error.code).toBe(-32602)
      const huge = await call('save_file', {
        path: 'huge.bin',
        content: bytes(1024 * 1024 + 10).toString('base64'),
        encoding: 'base64',
      })
      expect(huge).toMatchObject({ isError: true })
    })

    it('records its writes as MCP activity', async () => {
      const { body } = await json(await s.fetch('/api/v1/activity?project=Hermes%20trial', { headers: auth() }))
      expect(body.events.every((e) => e.via === 'mcp' && e.actor === 'hermes')).toBe(true)
      expect(body.events.map((e) => e.action)).toEqual(
        expect.arrayContaining(['created', 'saved', 'logged', 'updated', 'appended to']),
      )
    })
  })
})
