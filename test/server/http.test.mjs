import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { APP, cookieFrom, startServer } from '../helpers/server.mjs'

const json = { 'Content-Type': 'application/json' }

describe('static serving', () => {
  let s
  beforeAll(async () => {
    s = await startServer({ DECKLE_SERVER_LIBRARY: 'false' })
  })
  afterAll(() => s.close())

  it('serves the app with its security headers', async () => {
    const res = await s.fetch('/')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('<title>Deckle</title>')
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const csp = res.headers.get('content-security-policy')
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
  })

  it('falls back to the app for client routes, but not for a missing asset', async () => {
    const route = await s.fetch('/some/client/route')
    expect(route.status).toBe(200)
    expect(await route.text()).toContain('<title>Deckle</title>')

    const asset = await s.fetch('/assets/gone-123.js')
    expect(asset.status).toBe(404)
  })

  it('caches hashed assets for good, and compresses them', async () => {
    const res = await s.fetch('/assets/app-abc123.js', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(await res.text()).toContain('deckle deckle')
  })

  it('answers HEAD without a body', async () => {
    const res = await s.fetch('/', { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(Number(res.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await res.text()).toBe('')
  })

  it('never serves a file from outside the bundle', async () => {
    await fs.writeFile(path.join(s.root, 'secret.txt'), 'TOP SECRET')
    for (const probe of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt', '/%00']) {
      const res = await s.fetch(probe)
      expect(await res.text()).not.toContain('TOP SECRET')
    }
  })

  it('refuses other methods on static paths', async () => {
    expect((await s.fetch('/', { method: 'POST' })).status).toBe(405)
  })

  it('says the server library is off, and keeps its routes closed', async () => {
    const info = await (await s.fetch('/api/server-library')).json()
    expect(info).toMatchObject({ enabled: false, authenticated: false })
    expect((await s.fetch('/api/library/tree', { headers: APP })).status).toBe(404)
    expect((await s.fetch('/api/assistant-settings', { headers: APP })).status).toBe(404)
    expect((await s.fetch('/api/nothing-here')).status).toBe(404)
  })
})

describe('server library without a password', () => {
  let s
  beforeAll(async () => {
    s = await startServer()
  })
  afterAll(() => s.close())

  const lib = (route, init = {}) =>
    s.fetch(`/api/library/${route}`, { ...init, headers: { ...APP, ...(init.headers ?? {}) } })

  it('requires the app header, so another site cannot drive it', async () => {
    expect((await s.fetch('/api/library/tree')).status).toBe(403)
  })

  it('round-trips a note', async () => {
    const put = await lib('file?path=Projects/idea.md', { method: 'PUT', body: 'hello' })
    expect(put.status).toBe(200)
    expect(await put.json()).toMatchObject({ size: 5 })

    const get = await lib('file?path=Projects/idea.md')
    expect(get.status).toBe(200)
    expect(get.headers.get('content-disposition')).toBe('attachment')
    expect(get.headers.get('content-type')).toBe('application/octet-stream')
    expect(Number(get.headers.get('x-last-modified'))).toBeGreaterThan(0)
    expect(await get.text()).toBe('hello')

    expect(await (await lib('stat?path=Projects/idea.md')).json()).toMatchObject({ kind: 'file' })
    expect(await (await lib('stat?path=Projects')).json()).toEqual({ kind: 'directory' })
    const { tree } = await (await lib('tree')).json()
    expect(tree[0]).toMatchObject({ kind: 'folder', id: 'Projects' })
  })

  it('answers a missing note, or a path through a file, with 404', async () => {
    expect((await lib('stat?path=nope.md')).status).toBe(404)
    await lib('file?path=plain.md', { method: 'PUT', body: 'x' })
    expect((await lib('stat?path=plain.md/child.md')).status).toBe(404)
  })

  it('refuses traversal and the reserved state folder', async () => {
    expect((await lib('file?path=../package.json')).status).toBe(400)
    await fs.mkdir(path.join(s.libraryDir, '.deckle-state'), { recursive: true })
    await fs.writeFile(path.join(s.libraryDir, '.deckle-state', 'assistant.json'), '{"key":"sk"}')

    for (const probe of ['.deckle-state/assistant.json', './.deckle-state/assistant.json']) {
      const res = await lib(`file?path=${encodeURIComponent(probe)}`)
      expect(res.status).toBe(400)
      expect(await res.text()).not.toContain('sk')
    }
    const { entries } = await (await lib('list?path=.')).json()
    expect(entries.map((e) => e.name)).not.toContain('.deckle-state')
  })

  it('reads a folder as a conflict rather than an internal error', async () => {
    await lib('dir?path=Folder', { method: 'POST' })
    expect((await lib('file?path=Folder')).status).toBe(409)
  })

  it('refuses a non-empty folder unless the delete is recursive', async () => {
    await lib('file?path=Doomed/a.md', { method: 'PUT', body: 'a' })
    expect((await lib('entry?path=Doomed', { method: 'DELETE' })).status).toBe(409)
    expect((await lib('entry?path=Doomed&recursive=1', { method: 'DELETE' })).status).toBe(200)
    expect((await lib('stat?path=Doomed')).status).toBe(404)
  })

  it('keeps running after a file it is not allowed to read', async () => {
    if (process.getuid?.() === 0) return // root reads everything
    const locked = path.join(s.libraryDir, 'locked.md')
    await fs.writeFile(locked, 'secret')
    await fs.chmod(locked, 0o000)
    try {
      const res = await lib('file?path=locked.md')
      expect(res.status).toBe(500)
      expect(await res.json()).toHaveProperty('error')
    } finally {
      await fs.chmod(locked, 0o644)
    }
    expect((await s.fetch('/api/server-library')).status).toBe(200)
  })

  it('declines to keep assistant settings without a password', async () => {
    const res = await s.fetch('/api/assistant-settings', { headers: APP })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'password_required' })
  })
})

describe('server library with a password', () => {
  let s
  beforeAll(async () => {
    s = await startServer({
      DECKLE_PASSWORD: 'hunter2-hunter2',
      DECKLE_SESSION_SECRET: 'x'.repeat(32),
    })
  })
  afterAll(() => s.close())

  const login = (body) =>
    s.fetch('/api/server-library/login', {
      method: 'POST',
      headers: { ...APP, ...json },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  it('keeps the library closed until sign-in', async () => {
    expect((await s.fetch('/api/library/tree', { headers: APP })).status).toBe(401)
    expect(await (await s.fetch('/api/server-library')).json()).toMatchObject({
      enabled: true,
      authRequired: true,
      authenticated: false,
      sharedSettings: true,
    })
  })

  it('signs in with the password, and the session opens the library', async () => {
    expect((await login({ password: 'wrong' })).status).toBe(401)

    const res = await login({ password: 'hunter2-hunter2' })
    expect(res.status).toBe(200)
    const cookie = cookieFrom(res)
    expect(cookie).toMatch(/^deckle_session=/)

    expect((await s.fetch('/api/library/tree', { headers: { ...APP, cookie } })).status).toBe(200)
    expect(
      await (await s.fetch('/api/server-library', { headers: { cookie } })).json(),
    ).toMatchObject({ authenticated: true })
  })

  it('refuses a login without the app header', async () => {
    const res = await s.fetch('/api/server-library/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ password: 'hunter2-hunter2' }),
    })
    expect(res.status).toBe(403)
  })

  it.each([['null'], ['[]'], ['{'], ['"hunter2-hunter2"']])(
    'answers a malformed login body (%s) with 400, not 500',
    async (body) => {
      expect((await login(body)).status).toBe(400)
    },
  )

  it('treats a garbled session cookie as signed out', async () => {
    const res = await s.fetch('/api/library/tree', {
      headers: { ...APP, cookie: 'deckle_session=%E0%A4%A' },
    })
    expect(res.status).toBe(401)
  })

  it('requires the app header to sign out', async () => {
    expect((await s.fetch('/api/server-library/logout', { method: 'POST' })).status).toBe(403)
    const res = await s.fetch('/api/server-library/logout', { method: 'POST', headers: APP })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
  })

  it('shares assistant settings only with a signed-in app, and never through the file API', async () => {
    const cookie = cookieFrom(await login({ password: 'hunter2-hunter2' }))
    const settings = { provider: 'anthropic', anthropicKey: 'sk-ant-test' }

    const anonymous = await s.fetch('/api/assistant-settings', {
      method: 'PUT',
      headers: { ...APP, ...json },
      body: JSON.stringify({ settings }),
    })
    expect(anonymous.status).toBe(401)

    const saved = await s.fetch('/api/assistant-settings', {
      method: 'PUT',
      headers: { ...APP, ...json, cookie },
      body: JSON.stringify({ settings }),
    })
    expect(saved.status).toBe(200)

    const read = await s.fetch('/api/assistant-settings', { headers: { ...APP, cookie } })
    expect(await read.json()).toEqual({ settings })

    const file = path.join(s.libraryDir, '.deckle-state', 'assistant.json')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)

    for (const probe of ['.deckle-state/assistant.json', './.deckle-state/assistant.json']) {
      const res = await s.fetch(`/api/library/file?path=${encodeURIComponent(probe)}`, {
        headers: { ...APP, cookie },
      })
      expect(res.status).toBe(400)
    }

    const invalid = await s.fetch('/api/assistant-settings', {
      method: 'PUT',
      headers: { ...APP, ...json, cookie },
      body: JSON.stringify({ settings: ['not', 'an', 'object'] }),
    })
    expect(invalid.status).toBe(400)
  })
})

describe('sign-in throttling over HTTP', () => {
  let s
  beforeAll(async () => {
    s = await startServer({ DECKLE_PASSWORD: 'correct-password' })
  })
  afterAll(() => s.close())

  it('locks out a guesser that rotates X-Forwarded-For', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await s.fetch('/api/server-library/login', {
        method: 'POST',
        headers: { ...APP, ...json, 'X-Forwarded-For': `203.0.113.${i}` },
        body: JSON.stringify({ password: `guess-${i}` }),
      })
      expect(res.status).toBe(401)
    }
    const res = await s.fetch('/api/server-library/login', {
      method: 'POST',
      headers: { ...APP, ...json, 'X-Forwarded-For': '198.51.100.99' },
      body: JSON.stringify({ password: 'correct-password' }),
    })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('900')
  })
})

describe('configuration', () => {
  it('refuses a nonsense port', async () => {
    const { createApp } = await import('../../server/app.mjs')
    expect(() => createApp({ PORT: 'eighty' }, { log() {}, warn() {} })).toThrow(/PORT/)
  })

  it('honours the pre-rename NIB_* names', async () => {
    const s = await startServer({ DECKLE_SERVER_LIBRARY: '', NIB_SERVER_VAULT: 'true', NIB_VAULT_NAME: 'Old Vault' })
    try {
      expect(await (await s.fetch('/api/server-library')).json()).toMatchObject({
        enabled: true,
        name: 'Old Vault',
      })
    } finally {
      await s.close()
    }
  })
})
