import { describe, expect, it, vi } from 'vitest'
import { createApiAuth } from '../../server/api-auth.mjs'

const req = (authorization, ip = '10.0.0.1') => ({
  headers: authorization ? { authorization } : {},
  socket: { remoteAddress: ip },
})

const READER = 'r'.repeat(20)
const BARE = 'b'.repeat(24)

describe('createApiAuth', () => {
  it('is disabled with no tokens', () => {
    const auth = createApiAuth({}, vi.fn())
    expect(auth.enabled).toBe(false)
    expect(auth.authenticate(req(`Bearer ${BARE}`))).toEqual({ error: 'disabled' })
  })

  it('parses named, scoped and bare tokens, and warns about unusable ones', () => {
    const warn = vi.fn()
    const auth = createApiAuth(
      {
        DECKLE_API_TOKENS: [
          `reader:r:${READER}`,
          BARE,
          'short:rw:tiny',
          `bad:admin:${'c'.repeat(16)}`,
          'two:parts',
          '',
        ].join(','),
      },
      warn,
    )
    expect(auth.describe()).toEqual(['reader (r)', 'token-2 (rw)'])
    expect(warn).toHaveBeenCalledTimes(3)
    // Never the secrets.
    expect(auth.describe().join()).not.toContain(READER)
  })

  it('keeps a colon inside a secret', () => {
    const auth = createApiAuth({ DECKLE_API_TOKENS: 'agent:rw:abc:defghijklmnopqrs' }, vi.fn())
    expect(auth.authenticate(req('Bearer abc:defghijklmnopqrs')).token?.name).toBe('agent')
  })

  it('accepts the single-token alias', () => {
    const auth = createApiAuth({ DECKLE_API_TOKEN: BARE }, vi.fn())
    expect(auth.authenticate(req(`Bearer ${BARE}`)).token?.scope).toBe('rw')
  })

  it('identifies the caller, or says what was wrong', () => {
    const auth = createApiAuth({ DECKLE_API_TOKENS: `reader:r:${READER}` }, vi.fn())
    expect(auth.authenticate(req())).toEqual({ error: 'missing' })
    expect(auth.authenticate(req('Basic abc'))).toEqual({ error: 'missing' })
    expect(auth.authenticate(req('Bearer wrong-token-value'))).toEqual({ error: 'invalid' })
    expect(auth.authenticate(req(`bearer   ${READER}`)).token).toMatchObject({
      name: 'reader',
      scope: 'r',
    })
  })

  it('throttles an address after twenty bad tokens, whatever it claims to be', () => {
    const auth = createApiAuth({ DECKLE_API_TOKENS: BARE }, vi.fn())
    for (let i = 0; i < 20; i++) {
      const r = req('Bearer nope-nope-nope-nope')
      r.headers['x-forwarded-for'] = `203.0.113.${i}`
      expect(auth.authenticate(r).error).toBe('invalid')
    }
    expect(auth.authenticate(req(`Bearer ${BARE}`))).toEqual({ error: 'throttled' })
    expect(auth.authenticate(req(`Bearer ${BARE}`, '10.0.0.2')).token).toBeTruthy()
  })
})
