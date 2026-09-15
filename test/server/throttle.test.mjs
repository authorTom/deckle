import { describe, expect, it } from 'vitest'
import { createClientIp, createThrottle, parseTrustProxy } from '../../server/throttle.mjs'

const req = (headers = {}, ip = '10.0.0.1') => ({ headers, socket: { remoteAddress: ip } })

describe('parseTrustProxy', () => {
  it.each([
    [undefined, 0],
    ['', 0],
    ['false', 0],
    ['0', 0],
    ['nonsense', 0],
    ['-1', 0],
    ['true', 1],
    ['YES', 1],
    ['1', 1],
    ['2', 2],
    ['99', 10],
  ])('%s → %i hops', (value, hops) => {
    expect(parseTrustProxy(value)).toBe(hops)
  })
})

describe('createClientIp', () => {
  it('ignores X-Forwarded-For unless a proxy is trusted', () => {
    const clientIp = createClientIp({})
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('10.0.0.1')
  })

  it('takes the address the trusted proxy appended, not what the client claimed', () => {
    const clientIp = createClientIp({ DECKLE_TRUST_PROXY: 'true' })
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 203.0.113.7' }))).toBe('203.0.113.7')
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7')
  })

  it('counts back past every trusted hop', () => {
    const clientIp = createClientIp({ DECKLE_TRUST_PROXY: '2' })
    expect(clientIp(req({ 'x-forwarded-for': 'spoofed, 203.0.113.7, 198.51.100.1' }))).toBe(
      '203.0.113.7',
    )
  })

  it('falls back to the socket when the header is absent or empty', () => {
    const clientIp = createClientIp({ DECKLE_TRUST_PROXY: 'true' })
    expect(clientIp(req())).toBe('10.0.0.1')
    expect(clientIp(req({ 'x-forwarded-for': ' , ' }))).toBe('10.0.0.1')
    expect(clientIp({ headers: {}, socket: {} })).toBe('unknown')
  })
})

describe('createThrottle', () => {
  it('refuses after too many failures, and forgets after the window', () => {
    let now = 0
    const throttle = createThrottle({ maxAttempts: 3, windowMs: 1000, now: () => now })
    for (let i = 0; i < 3; i++) {
      expect(throttle.isThrottled('a')).toBe(false)
      throttle.recordFailure('a')
    }
    expect(throttle.isThrottled('a')).toBe(true)
    expect(throttle.isThrottled('b')).toBe(false)
    now = 1001
    expect(throttle.isThrottled('a')).toBe(false)
  })

  it('clears a key on success', () => {
    const throttle = createThrottle({ maxAttempts: 1, windowMs: 1000 })
    throttle.recordFailure('a')
    expect(throttle.isThrottled('a')).toBe(true)
    throttle.reset('a')
    expect(throttle.isThrottled('a')).toBe(false)
  })

  it('never tracks more addresses than its cap', () => {
    let now = 0
    const throttle = createThrottle({ maxAttempts: 5, windowMs: 1000, maxTracked: 3, now: () => now })
    for (let i = 0; i < 50; i++) {
      now += 1
      throttle.recordFailure(`client-${i}`)
    }
    expect(throttle.size).toBeLessThanOrEqual(3)
  })
})
