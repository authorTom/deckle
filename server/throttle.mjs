// Failed-attempt throttling, shared by the password gate (auth.mjs) and the
// API's bearer tokens (api-auth.mjs).
//
// Two things go wrong with a naive per-IP counter, and both used to be true
// here:
//
//   * Trusting X-Forwarded-For from anyone. Every request could name a fresh
//     "client" in that header, so a script guessing the password was never
//     throttled at all — and could lock a real user out by naming *their*
//     address. The header is only believed when the operator says a proxy they
//     control is in front (DECKLE_TRUST_PROXY), and even then only the entries
//     that proxy appended, counted from the right.
//
//   * An unbounded map. One entry per address ever seen is a memory leak an
//     attacker can drive. Expired entries are swept, and the table is capped.

/** Addresses tracked at once before expired entries are swept and the oldest dropped. */
const MAX_TRACKED = 10_000

/**
 * How many reverse proxies sit in front of this server.
 *
 *   unset, "", "false", "0"  → 0: use the socket address, ignore X-Forwarded-For
 *   "true"                   → 1: one proxy (Caddy, Traefik, nginx)
 *   "2", "3", …              → that many, e.g. Cloudflare in front of Caddy
 */
export function parseTrustProxy(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || raw === 'false' || raw === 'no' || raw === 'off') return 0
  if (raw === 'true' || raw === 'yes' || raw === 'on') return 1
  const hops = Number(raw)
  return Number.isInteger(hops) && hops > 0 ? Math.min(hops, 10) : 0
}

/** Build `clientIp(req)` for the configured number of trusted proxies. */
export function createClientIp(env = process.env) {
  const hops = parseTrustProxy(env.DECKLE_TRUST_PROXY)

  return function clientIp(req) {
    const socketAddress = req.socket?.remoteAddress || 'unknown'
    if (!hops) return socketAddress

    const header = req.headers['x-forwarded-for']
    const raw = Array.isArray(header) ? header.join(',') : header
    if (typeof raw !== 'string' || !raw.trim()) return socketAddress

    // Each proxy appends the address it accepted the connection from, so the
    // right-hand end of the list is what the trusted proxies wrote and the
    // left-hand end is whatever the client claimed. With `hops` proxies in
    // front, the real client is `hops` entries from the end.
    const chain = raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (!chain.length) return socketAddress
    return chain[Math.max(0, chain.length - hops)]
  }
}

/**
 * Count failures per key within a window, and refuse once there are too many.
 *
 * `now` is injectable so the window can be tested without waiting for it.
 */
export function createThrottle({ maxAttempts, windowMs, maxTracked = MAX_TRACKED, now = Date.now }) {
  const attempts = new Map() // key -> { count, resetAt }

  function sweep(at) {
    for (const [key, entry] of attempts) {
      if (at > entry.resetAt) attempts.delete(key)
    }
  }

  return {
    isThrottled(key) {
      const entry = attempts.get(key)
      if (!entry) return false
      if (now() > entry.resetAt) {
        attempts.delete(key)
        return false
      }
      return entry.count >= maxAttempts
    },

    recordFailure(key) {
      const at = now()
      const entry = attempts.get(key)
      if (entry && at <= entry.resetAt) {
        entry.count += 1
        return
      }
      attempts.delete(key)
      if (attempts.size >= maxTracked) {
        sweep(at)
        // Still full of live entries: drop the oldest. Map iterates in
        // insertion order, so the first key is the one tracked longest.
        if (attempts.size >= maxTracked) attempts.delete(attempts.keys().next().value)
      }
      attempts.set(key, { count: 1, resetAt: at + windowMs })
    },

    reset(key) {
      attempts.delete(key)
    },

    /** For tests and diagnostics. */
    get size() {
      return attempts.size
    },
  }
}
