// Optional single-password gate for the server library.
//
// Deckle has no user accounts: the server library is one shared library behind one
// optional password (DECKLE_PASSWORD). With no password set the API is wide open,
// which is the right default only when something else already guards the port
// (Tailscale, a VPN, an authenticating reverse proxy).
//
// Sessions are stateless: a signed "expiry" token in an HttpOnly cookie. No
// session store to keep, and revoking everything is a matter of changing the
// secret — or the password, which is mixed into the signing key for exactly
// that reason. Set DECKLE_SESSION_SECRET to keep sessions valid across
// restarts; otherwise a fresh random secret is generated at boot and a restart
// logs everyone out.

import crypto from 'node:crypto'
import { createClientIp, createThrottle } from './throttle.mjs'

const COOKIE_NAME = 'deckle_session'
const DEFAULT_TTL_DAYS = 30

// Failed logins are throttled per client address so the password can't be
// ground down by a script. Counters live in memory and reset on restart.
const LOCKOUT_WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 10

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest()
}

/** A positive number of days, or the default — never NaN, which would mint
 *  tokens that are never valid and cookies with `Max-Age=NaN`. */
function ttlDays(raw) {
  const days = Number(raw)
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_TTL_DAYS
}

export function createAuth(env = process.env, { now = Date.now } = {}) {
  const password = env.DECKLE_PASSWORD || ''
  const required = password.length > 0
  const secret = env.DECKLE_SESSION_SECRET
    ? Buffer.from(env.DECKLE_SESSION_SECRET, 'utf8')
    : crypto.randomBytes(32)
  // Sessions are signed with a key derived from the secret *and* the password.
  // With a fixed DECKLE_SESSION_SECRET, changing a leaked password used to
  // leave every session issued under it valid for the rest of its 30 days;
  // deriving the key from both means a new password signs everyone out.
  const signingKey = crypto
    .createHmac('sha256', secret)
    .update('deckle-session\0')
    .update(password, 'utf8')
    .digest()
  // Compared as digests: equal length always, so neither the comparison nor
  // an early length check can leak how long the password is.
  const passwordDigest = sha256(password)
  const ttlMs = ttlDays(env.DECKLE_SESSION_TTL_DAYS) * 86_400_000
  const clientIp = createClientIp(env)
  const throttle = createThrottle({
    maxAttempts: MAX_ATTEMPTS,
    windowMs: LOCKOUT_WINDOW_MS,
    now,
  })

  function sign(value) {
    return crypto.createHmac('sha256', signingKey).update(value).digest('base64url')
  }

  function issueToken() {
    const payload = String(now() + ttlMs)
    return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`
  }

  function verifyToken(token) {
    if (typeof token !== 'string') return false
    const dot = token.indexOf('.')
    if (dot === -1) return false
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')
    if (!/^\d+$/.test(payload)) return false
    const expected = sign(payload)
    const given = token.slice(dot + 1)
    // Equal-length check first: timingSafeEqual throws on a length mismatch.
    if (given.length !== expected.length) return false
    if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return false
    return Number(payload) > now()
  }

  function readCookie(req) {
    const header = req.headers.cookie
    if (!header) return null
    for (const part of header.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() === COOKIE_NAME) {
        // A malformed escape ("%E0%A4%A") makes decodeURIComponent throw, and
        // that used to surface as a 500 on every request carrying the cookie.
        try {
          return decodeURIComponent(part.slice(eq + 1).trim())
        } catch {
          return null
        }
      }
    }
    return null
  }

  /** Is this request allowed to touch the library? */
  function isAuthenticated(req) {
    if (!required) return true
    return verifyToken(readCookie(req))
  }

  /**
   * Check a submitted password. Returns a `Set-Cookie` value on success, or an
   * error code ('throttled' | 'invalid').
   */
  function login(req, submitted) {
    const ip = clientIp(req)
    if (throttle.isThrottled(ip)) return { error: 'throttled' }

    const ok =
      typeof submitted === 'string' &&
      crypto.timingSafeEqual(sha256(submitted), passwordDigest)
    if (!ok) {
      throttle.recordFailure(ip)
      return { error: 'invalid' }
    }
    throttle.reset(ip)
    return { cookie: buildCookie(req, issueToken(), ttlMs / 1000) }
  }

  function logoutCookie(req) {
    return buildCookie(req, '', 0)
  }

  function buildCookie(req, value, maxAgeSeconds) {
    // Strict SameSite is the primary CSRF defence: the library API is only ever
    // called by the app served from the same origin, never by a cross-site
    // navigation. `Secure` is added only when the request actually arrived over
    // HTTPS — setting it unconditionally would break plain-HTTP LAN deploys,
    // which is how most self-hosters will run this.
    const https =
      req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted === true
    const parts = [
      `${COOKIE_NAME}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(maxAgeSeconds)}`,
    ]
    if (https) parts.push('Secure')
    return parts.join('; ')
  }

  return { required, isAuthenticated, login, logoutCookie }
}
