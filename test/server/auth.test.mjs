import { describe, expect, it } from 'vitest'
import { createAuth } from '../../server/auth.mjs'

const req = (headers = {}, ip = '10.0.0.1') => ({ headers, socket: { remoteAddress: ip } })
const cookiePair = (setCookie) => setCookie.split(';')[0]

describe('createAuth', () => {
  it('is open when no password is set', () => {
    const auth = createAuth({})
    expect(auth.required).toBe(false)
    expect(auth.isAuthenticated(req())).toBe(true)
  })

  it('exchanges the right password for a strict, http-only session cookie', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'correct horse' })
    const { cookie } = auth.login(req(), 'correct horse')
    expect(cookie).toMatch(/^deckle_session=[^;]+/)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(cookie).toContain(`Max-Age=${30 * 86_400}`)
    expect(cookie).not.toContain('Secure')
    expect(auth.isAuthenticated(req({ cookie: cookiePair(cookie) }))).toBe(true)
    expect(auth.isAuthenticated(req())).toBe(false)
  })

  it('marks the cookie Secure when the request came over HTTPS', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' })
    const { cookie } = auth.login(req({ 'x-forwarded-proto': 'https' }), 'pw')
    expect(cookie).toContain('Secure')
  })

  it('rejects a wrong, empty or non-string password', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' })
    expect(auth.login(req(), 'nope')).toEqual({ error: 'invalid' })
    expect(auth.login(req(), '')).toEqual({ error: 'invalid' })
    expect(auth.login(req(), 123)).toEqual({ error: 'invalid' })
    expect(auth.login(req(), undefined)).toEqual({ error: 'invalid' })
    expect(auth.login(req(), 'pw ')).toEqual({ error: 'invalid' })
  })

  it('rejects a tampered, forged or expired session', () => {
    let now = 1_000_000
    const env = { DECKLE_PASSWORD: 'pw', DECKLE_SESSION_TTL_DAYS: '1' }
    const auth = createAuth(env, { now: () => now })
    const pair = cookiePair(auth.login(req(), 'pw').cookie)
    const [name, token] = pair.split('=')
    const [payload, signature] = token.split('.')

    const flipped = signature.endsWith('A') ? `${signature.slice(0, -1)}B` : `${signature.slice(0, -1)}A`
    expect(auth.isAuthenticated(req({ cookie: `${name}=${payload}.${flipped}` }))).toBe(false)

    // A far-future expiry signed with a different key.
    const other = createAuth({ DECKLE_PASSWORD: 'pw', DECKLE_SESSION_TTL_DAYS: '3650' })
    const forged = cookiePair(other.login(req(), 'pw').cookie)
    expect(auth.isAuthenticated(req({ cookie: forged }))).toBe(false)

    expect(auth.isAuthenticated(req({ cookie: pair }))).toBe(true)
    now += 86_400_000 + 1
    expect(auth.isAuthenticated(req({ cookie: pair }))).toBe(false)
  })

  it('treats a malformed cookie as signed out rather than throwing', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' })
    expect(auth.isAuthenticated(req({ cookie: 'deckle_session=%E0%A4%A' }))).toBe(false)
    expect(auth.isAuthenticated(req({ cookie: 'deckle_session=no-dot' }))).toBe(false)
    expect(auth.isAuthenticated(req({ cookie: 'other=1; deckle_session=' }))).toBe(false)
  })

  it('keeps sessions across a restart with a fixed secret, but not across a password change', () => {
    const env = { DECKLE_PASSWORD: 'old password', DECKLE_SESSION_SECRET: 's'.repeat(32) }
    const pair = cookiePair(createAuth(env).login(req(), 'old password').cookie)
    expect(createAuth(env).isAuthenticated(req({ cookie: pair }))).toBe(true)
    expect(
      createAuth({ ...env, DECKLE_PASSWORD: 'new password' }).isAuthenticated(req({ cookie: pair })),
    ).toBe(false)
  })

  it('throttles repeated failures, even for the right password', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' })
    for (let i = 0; i < 10; i++) expect(auth.login(req(), 'bad').error).toBe('invalid')
    expect(auth.login(req(), 'pw')).toEqual({ error: 'throttled' })
    // Another address is unaffected.
    expect(auth.login(req({}, '10.0.0.2'), 'pw').cookie).toBeTruthy()
  })

  it('does not let a spoofed X-Forwarded-For dodge the throttle', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' })
    for (let i = 0; i < 10; i++) {
      auth.login(req({ 'x-forwarded-for': `203.0.113.${i}` }), 'bad')
    }
    expect(auth.login(req({ 'x-forwarded-for': '198.51.100.1' }), 'pw')).toEqual({
      error: 'throttled',
    })
  })

  it('tells clients apart behind a trusted proxy', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw', DECKLE_TRUST_PROXY: 'true' })
    for (let i = 0; i < 10; i++) {
      auth.login(req({ 'x-forwarded-for': `whatever-${i}, 203.0.113.9` }), 'bad')
    }
    expect(auth.login(req({ 'x-forwarded-for': '203.0.113.9' }), 'pw')).toEqual({
      error: 'throttled',
    })
    expect(auth.login(req({ 'x-forwarded-for': '203.0.113.10' }), 'pw').cookie).toBeTruthy()
  })

  it('lets the lockout expire', () => {
    let now = 0
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' }, { now: () => now })
    for (let i = 0; i < 10; i++) auth.login(req(), 'bad')
    expect(auth.login(req(), 'pw').error).toBe('throttled')
    now += 15 * 60_000 + 1
    expect(auth.login(req(), 'pw').cookie).toBeTruthy()
  })

  it('uses the default lifetime for a nonsense TTL', () => {
    for (const ttl of ['soon', '-3', '0']) {
      const auth = createAuth({ DECKLE_PASSWORD: 'pw', DECKLE_SESSION_TTL_DAYS: ttl })
      expect(auth.login(req(), 'pw').cookie).toContain(`Max-Age=${30 * 86_400}`)
    }
  })

  it('builds a clearing cookie for sign-out', () => {
    const auth = createAuth({ DECKLE_PASSWORD: 'pw' })
    expect(auth.logoutCookie(req())).toMatch(/^deckle_session=; .*Max-Age=0/)
  })
})
