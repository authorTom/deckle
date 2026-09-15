// Bearer-token auth for the machine API (/api/v1).
//
// Deliberately separate from the browser's password session (server/auth.mjs).
// An agent is not a person: it shouldn't hold the human's library password, its
// access should be revocable on its own, and it should be able to be read-only.
//
// Because tokens live in an Authorization header — which a browser never
// attaches on its own — /api/v1 has no CSRF exposure and needs neither the
// SameSite cookie nor the X-Deckle-App header the app's own endpoints rely on.
// The API therefore ignores cookies entirely: a session cookie must never be
// enough to reach it.
//
// Configuration:
//   DECKLE_API_TOKENS   comma-separated tokens, each "name:scope:secret" or just
//                    "secret" (which implies read-write). Scope is "r" or "rw".
//   DECKLE_API_TOKEN    alias for a single read-write token.

import crypto from 'node:crypto'
import { createClientIp, createThrottle } from './throttle.mjs'

/** Tokens shorter than this are too weak to be worth accepting at all. */
const MIN_TOKEN_LENGTH = 16

const LOCKOUT_WINDOW_MS = 15 * 60_000
const MAX_ATTEMPTS = 20

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest()
}

/**
 * Compare against the *digest* rather than the token: digests are always the
 * same length, so timingSafeEqual can't throw and no length is leaked.
 */
function digestsMatch(a, b) {
  return crypto.timingSafeEqual(a, b)
}

/** Parse one "name:scope:secret" | "secret" entry. Returns null if unusable. */
function parseToken(raw, index, warn) {
  const entry = raw.trim()
  if (!entry) return null

  let name = `token-${index + 1}`
  let scope = 'rw'
  let secret = entry

  const parts = entry.split(':')
  if (parts.length >= 3) {
    name = parts[0].trim() || name
    scope = parts[1].trim().toLowerCase()
    // Rejoin the rest, so a secret containing ":" survives.
    secret = parts.slice(2).join(':').trim()
  } else if (parts.length === 2) {
    warn(
      `[deckle] ignoring API token "${parts[0]}": expected "name:scope:secret" (scope is "r" or "rw") or a bare secret`,
    )
    return null
  }

  if (scope !== 'r' && scope !== 'rw') {
    warn(`[deckle] ignoring API token "${name}": scope must be "r" or "rw", got "${scope}"`)
    return null
  }
  if (secret.length < MIN_TOKEN_LENGTH) {
    warn(
      `[deckle] ignoring API token "${name}": secrets must be at least ${MIN_TOKEN_LENGTH} characters`,
    )
    return null
  }

  return { name, scope, digest: sha256(secret) }
}

export function createApiAuth(env = process.env, warn = console.warn, { now = Date.now } = {}) {
  const raw = [env.DECKLE_API_TOKENS, env.DECKLE_API_TOKEN].filter(Boolean).join(',')
  const tokens = raw
    .split(',')
    .map((entry, index) => parseToken(entry, index, warn))
    .filter(Boolean)

  const clientIp = createClientIp(env)
  const throttle = createThrottle({
    maxAttempts: MAX_ATTEMPTS,
    windowMs: LOCKOUT_WINDOW_MS,
    now,
  })

  function bearer(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return null
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    return match ? match[1].trim() : null
  }

  /**
   * Identify the caller. Returns { token } on success or { error } with one of
   * 'disabled' | 'missing' | 'invalid' | 'throttled'.
   */
  function authenticate(req) {
    if (!tokens.length) return { error: 'disabled' }

    const ip = clientIp(req)
    if (throttle.isThrottled(ip)) return { error: 'throttled' }

    const presented = bearer(req)
    if (!presented) return { error: 'missing' }

    const digest = sha256(presented)
    // Check every token rather than breaking early: the work done must not
    // depend on which token was presented.
    let matched = null
    for (const token of tokens) {
      if (digestsMatch(digest, token.digest)) matched = token
    }
    if (!matched) {
      throttle.recordFailure(ip)
      return { error: 'invalid' }
    }

    throttle.reset(ip)
    return { token: matched }
  }

  return {
    /** False when no tokens are configured, which keeps /api/v1 switched off. */
    enabled: tokens.length > 0,
    /** Names only — never the secrets — for the startup log. */
    describe: () => tokens.map((t) => `${t.name} (${t.scope})`),
    authenticate,
  }
}
