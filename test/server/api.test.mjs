import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startServer } from '../helpers/server.mjs'
import { toDateStr } from '../../server/dates.mjs'
import { unzip } from '../../src/lib/unzip.ts'

const RW = 'rw-secret-0123456789abcdef'
const RO = 'ro-secret-0123456789abcdef'

function client(s) {
  return async function api(route, { token = RW, method = 'GET', body, raw = false } = {}) {
    const headers = { Authorization: `Bearer ${token}` }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await s.fetch(`/api/v1${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    if (raw) return res
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
    return { status: res.status, body: parsed, headers: res.headers }
  }
}

const enc = (p) => p.split('/').map(encodeURIComponent).join('/')

describe('/api/v1 switched off', () => {
  it('is a 404 until a token is configured', async () => {
    const s = await startServer()
    try {
      const { status, body } = await client(s)('/health')
      expect(status).toBe(404)
      expect(body.error.code).toBe('api_disabled')
    } finally {
      await s.close()
    }
  })

  it('needs the server library', async () => {
    const s = await startServer({ DECKLE_SERVER_LIBRARY: 'false', DECKLE_API_TOKENS: RW })
    try {
      expect((await client(s)('/health')).status).toBe(503)
    } finally {
      await s.close()
    }
  })
})

describe('/api/v1', () => {
  let s
  let api
  beforeAll(async () => {
    s = await startServer({ DECKLE_API_TOKENS: `agent:rw:${RW},reader:r:${RO}` })
    api = client(s)
  })
  afterAll(() => s.close())

  describe('authentication', () => {
    it('requires a valid bearer token', async () => {
      const missing = await s.fetch('/api/v1/health')
      expect(missing.status).toBe(401)
      expect(missing.headers.get('www-authenticate')).toContain('Bearer')
      expect((await api('/health', { token: 'wrong-wrong-wrong-wrong' })).status).toBe(401)
    })

    it('reports the service', async () => {
      const { status, body } = await api('/health')
      expect(status).toBe(200)
      expect(body).toMatchObject({ ok: true, service: 'deckle', api: 'v1' })
    })

    it('keeps read-only tokens read-only', async () => {
      expect((await api('/notes', { token: RO })).status).toBe(200)
      const { status, body } = await api('/notes', {
        token: RO,
        method: 'POST',
        body: { title: 'nope' },
      })
      expect(status).toBe(403)
      expect(body.error.code).toBe('read_only')
    })

    it('publishes its OpenAPI description', async () => {
      const { body } = await api('/openapi.json')
      expect(body.openapi).toMatch(/^3\.1/)
      expect(body.paths).toHaveProperty('/notes/{path}')
    })
  })

  describe('request bodies', () => {
    it.each([
      ['null', 'invalid_body'],
      ['[]', 'invalid_body'],
      ['"a string"', 'invalid_body'],
      ['{', 'invalid_json'],
    ])('answers %s with 400', async (body, code) => {
      const res = await api('/notes', { method: 'POST', body })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe(code)
      expect((await api('/tasks/anything', { method: 'PATCH', body })).status).toBe(400)
    })

    it.each([['..%2Fsecret'], ['.deckle-state%2Fassistant.json'], ['.trash%2Fold.md'], ['%E0%A4%A']])(
      'refuses the note path %s',
      async (route) => {
        expect((await api(`/notes/${route}`)).status).toBe(400)
      },
    )
  })

  describe('notes', () => {
    it('creates, reads, rewrites, edits, moves and bins a note', async () => {
      const created = await api('/notes', {
        method: 'POST',
        body: { title: 'Latency review', folder: 'Projects', content: '# Latency\n\nbudget' },
      })
      expect(created.status).toBe(201)
      expect(created.body.path).toBe('Projects/Latency review.md')
      expect(created.headers.get('location')).toBe('/api/v1/notes/Projects/Latency%20review.md')

      const collision = await api('/notes', {
        method: 'POST',
        body: { title: 'Latency review', folder: 'Projects' },
      })
      expect(collision.body.path).toBe('Projects/Latency review 1.md')

      const note = enc('Projects/Latency review.md')
      expect((await api(`/notes/${note}`)).body.content).toBe('# Latency\n\nbudget')
      const markdown = await api(`/notes/${note}?format=markdown`, { raw: true })
      expect(markdown.headers.get('content-type')).toContain('text/markdown')
      expect(await markdown.text()).toBe('# Latency\n\nbudget')

      expect((await api(`/notes/${note}`, { method: 'PUT', body: { content: 'v2' } })).status).toBe(200)
      const history = await api(`/history?path=${encodeURIComponent('Projects/Latency review.md')}`)
      expect(history.body.count).toBe(1)

      const appended = await api(`/notes/${note}`, { method: 'PATCH', body: { append: 'more' } })
      expect(appended.body.content).toBe('v2\nmore')

      const moved = await api(`/notes/${note}`, { method: 'PATCH', body: { title: 'Renamed' } })
      expect(moved.body.path).toBe('Projects/Renamed.md')
      expect((await api(`/notes/${note}`)).status).toBe(404)
      // Both earlier versions (before the PUT, and before the append) moved with it.
      const retargeted = await api(`/history?path=${encodeURIComponent('Projects/Renamed.md')}`)
      expect(retargeted.body.count).toBe(2)

      const renamed = enc('Projects/Renamed.md')
      const binned = await api(`/notes/${renamed}`, { method: 'DELETE' })
      expect(binned.body).toMatchObject({ permanent: false })
      const restored = await api(`/trash/${encodeURIComponent(binned.body.trash.trashName)}/restore`, {
        method: 'POST',
      })
      expect(restored.body.path).toBe('Projects/Renamed.md')

      expect((await api(`/notes/${renamed}?permanent=true`, { method: 'DELETE' })).status).toBe(200)
      expect((await api(`/notes/${renamed}`)).status).toBe(404)
    })

    it('changes nothing when half of a PATCH is invalid', async () => {
      await api('/notes', { method: 'POST', body: { path: 'Atomic.md', content: 'original' } })
      const res = await api('/notes/Atomic.md', {
        method: 'PATCH',
        body: { title: 'Moved Away', content: 42 },
      })
      expect(res.status).toBe(400)
      expect((await api('/notes/Atomic.md')).body.content).toBe('original')
      expect((await api(`/notes/${enc('Moved Away.md')}`)).status).toBe(404)

      const both = await api('/notes/Atomic.md', {
        method: 'PATCH',
        body: { path: 'Elsewhere.md', append: 'x', prepend: 'y' },
      })
      expect(both.status).toBe(400)
      expect((await api('/notes/Atomic.md')).status).toBe(200)
    })

    it('searches by relevance', async () => {
      await api('/notes', { method: 'POST', body: { path: 'Search/Kettle.md', content: 'descaling the kettle' } })
      await api('/notes', { method: 'POST', body: { path: 'Search/Other.md', content: 'nothing relevant here' } })
      const { body } = await api('/search?q=kettle&folder=Search')
      expect(body.results[0].path).toBe('Search/Kettle.md')
      expect((await api('/search')).status).toBe(400)
    })

    it('imports notes, reporting the ones it could not take', async () => {
      const { body } = await api('/import', {
        method: 'POST',
        body: {
          folder: 'Imported',
          notes: [
            { path: 'a.md', content: 'A' },
            { path: '../escape', content: 'B' },
            { path: 'c.md' },
          ],
        },
      })
      expect(body).toMatchObject({ imported: 1, failed: 2 })
      expect((await api('/notes/Imported/a.md')).body.content).toBe('A')
    })

    it('deletes a folder by binning its notes', async () => {
      expect((await api('/folders', { method: 'POST', body: { path: 'Archive/2026' } })).status).toBe(201)
      await api('/notes', { method: 'POST', body: { path: 'Archive/2026/old.md', content: 'old' } })
      const tree = await api('/folders?path=Archive')
      expect(tree.body.tree[0].id).toBe('Archive/2026')

      const deleted = await api('/folders/Archive', { method: 'DELETE' })
      expect(deleted.body).toMatchObject({ deleted: 'Archive', trashed: 1 })
      expect((await api('/folders/Archive', { method: 'DELETE' })).status).toBe(404)
      expect((await api('/folders/', { method: 'DELETE' })).status).toBe(405)
    })

    it('exports the library as a readable ZIP that never carries the state folder', async () => {
      await api('/notes', { method: 'POST', body: { path: 'Export/keep.md', content: 'kept' } })
      await api('/tasks', { method: 'POST', body: { title: 'travels with the export' } })
      await fs.mkdir(path.join(s.libraryDir, '.deckle-state'), { recursive: true })
      await fs.writeFile(path.join(s.libraryDir, '.deckle-state', 'assistant.json'), '{"key":"sk"}')

      for (const query of ['', '?include_hidden=true']) {
        const res = await api(`/export${query}`, { raw: true })
        expect(res.status).toBe(200)
        expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=".+\.zip"/)
        const { files, skipped } = await unzip(await res.arrayBuffer())
        expect(skipped).toEqual([])
        const paths = files.map((f) => f.path)
        expect(paths).toContain('Export/keep.md')
        expect(paths).toContain('.deckle/tasks.json')
        expect(paths.some((p) => p.startsWith('.deckle-state'))).toBe(false)
        if (query) expect(paths.some((p) => p.startsWith('.trash/'))).toBe(true)
        else expect(paths.some((p) => p.startsWith('.trash/'))).toBe(false)
        const kept = files.find((f) => f.path === 'Export/keep.md')
        expect(new TextDecoder().decode(kept.bytes)).toBe('kept')
      }
    })
  })

  describe('tasks', () => {
    const offset = (days) => {
      const d = new Date()
      d.setDate(d.getDate() + days)
      return toDateStr(d)
    }

    it('validates what it stores', async () => {
      for (const body of [
        { title: '' },
        { title: 'x', due: '2026-02-31' },
        { title: 'x', due: 'tomorrow' },
        { title: 'x', priority: 7 },
        { title: 'x', projectId: 5 },
        { title: 'x', recurrence: { freq: 'hourly' } },
      ]) {
        expect((await api('/tasks', { method: 'POST', body })).status).toBe(400)
      }
      expect((await api('/tasks', { method: 'POST', body: { title: 'x', projectId: 'nope' } })).status).toBe(404)
    })

    it('rolls a recurring task forward on completion, as the app does', async () => {
      const { body: task } = await api('/tasks', {
        method: 'POST',
        body: { title: 'Water plants', due: offset(-3), recurrence: { freq: 'daily' } },
      })
      const { body: done } = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: true } })
      expect(done.completedAt).toBeNull()
      expect(done.due).toBe(offset(1))
    })

    it('completes, reopens and bins a one-off task', async () => {
      const { body: task } = await api('/tasks', { method: 'POST', body: { title: 'Call the bank', priority: 1 } })
      expect((await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: 'yes' } })).status).toBe(400)

      const done = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: true } })
      expect(done.body.completedAt).toEqual(expect.any(Number))
      const completed = await api('/tasks?filter=completed')
      expect(completed.body.tasks.map((t) => t.id)).toContain(task.id)

      const reopened = await api(`/tasks/${task.id}`, { method: 'PATCH', body: { completed: false } })
      expect(reopened.body.completedAt).toBeNull()

      await api(`/tasks/${task.id}`, { method: 'DELETE' })
      expect((await api('/tasks')).body.tasks.map((t) => t.id)).not.toContain(task.id)
      expect((await api('/tasks?filter=deleted')).body.tasks.map((t) => t.id)).toContain(task.id)
      await api(`/tasks/${task.id}?permanent=true`, { method: 'DELETE' })
      expect((await api(`/tasks/${task.id}`)).status).toBe(404)
    })

    it('only accepts hex colours for projects and collections', async () => {
      for (const route of ['/projects', '/collections']) {
        const bad = await api(route, { method: 'POST', body: { name: 'Evil', color: 'url(https://example.com/x)' } })
        expect(bad.status).toBe(400)
        const good = await api(route, { method: 'POST', body: { name: 'Garden', color: '#30a46c' } })
        expect(good.body.color).toBe('#30a46c')
        const auto = await api(route, { method: 'POST', body: { name: 'Auto' } })
        expect(auto.body.color).toMatch(/^#[0-9a-f]{6}$/)
      }
    })
  })

  describe('bookmarks', () => {
    it('keeps to http(s) and validates references', async () => {
      expect(
        (await api('/bookmarks', { method: 'POST', body: { url: 'javascript:alert(1)' } })).status,
      ).toBe(400)
      expect(
        (await api('/bookmarks', { method: 'POST', body: { url: 'example.com', collectionId: 7 } })).status,
      ).toBe(400)

      const { status, body } = await api('/bookmarks', { method: 'POST', body: { url: 'www.example.com/page' } })
      expect(status).toBe(201)
      expect(body).toMatchObject({ url: 'https://www.example.com/page', title: 'example.com' })

      const patched = await api(`/bookmarks/${body.id}`, { method: 'PATCH', body: { url: 'ftp://nope' } })
      expect(patched.status).toBe(400)
      expect((await api(`/bookmarks/${body.id}`)).body.url).toBe('https://www.example.com/page')
    })
  })
})

describe('/api/v1 with an unreadable data file', () => {
  it('refuses to write over it', async () => {
    const s = await startServer({ DECKLE_API_TOKENS: RW })
    try {
      const api = client(s)
      const file = path.join(s.libraryDir, '.deckle', 'bookmarks.json')
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, '{"version":1,"bookmarks":[{"id":"precious"')

      const read = await api('/bookmarks')
      expect(read.status).toBe(500)
      expect(read.body.error.code).toBe('store_unreadable')
      expect((await api('/bookmarks', { method: 'POST', body: { url: 'https://example.com' } })).status).toBe(500)
      expect(await fs.readFile(file, 'utf8')).toBe('{"version":1,"bookmarks":[{"id":"precious"')
    } finally {
      await s.close()
    }
  })
})
