// Which Host names the app's own library endpoints answer to.
//
// With no password, /api/library trusts any request that carries the
// X-Deckle-App header — and a browser lets a page set that header on a
// same-origin request. DNS rebinding makes a hostile page same-origin: it
// points its own name (attacker.example) at this server's address, and the
// browser then treats the page and Deckle as one site. Every request it sends
// still names attacker.example in its Host header, though, so answering only
// hosts we know closes that door. With a password set this is moot — the
// rebound page has no session cookie — so the check only applies without one.
//
// Allowed without configuration: localhost (and *.localhost) and bare IP
// addresses, which no rebinding attack can put in a Host header. Anything
// else must be named in DECKLE_ALLOWED_HOSTS:
//
//   DECKLE_ALLOWED_HOSTS=notes.example.com,.tailnet.ts.net
//
// A leading dot allows the name and every subdomain. "*" turns the check off.

import net from 'node:net'

/** The host name in a Host header: no port, no IPv6 brackets, lower case. */
export function hostnameOf(header) {
  if (typeof header !== 'string') return ''
  const value = header.trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    return end === -1 ? '' : value.slice(1, end)
  }
  const colon = value.lastIndexOf(':')
  const host = colon === -1 ? value : value.slice(0, colon)
  return host.replace(/\.$/, '')
}

export function parseAllowedHosts(raw) {
  return String(raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter(Boolean)
}

export function createHostCheck(env = process.env) {
  const allowed = parseAllowedHosts(env.DECKLE_ALLOWED_HOSTS)
  const allowAll = allowed.includes('*')

  function isAllowedHost(header) {
    if (allowAll) return true
    const host = hostnameOf(header)
    if (!host) return false
    if (net.isIP(host)) return true
    if (host === 'localhost' || host.endsWith('.localhost')) return true
    return allowed.some((entry) =>
      entry.startsWith('.') ? host === entry.slice(1) || host.endsWith(entry) : host === entry,
    )
  }

  return {
    allowed,
    allowAll,
    /** Is this request addressed to a host the server knows it is serving? */
    allows: (req) => isAllowedHost(req.headers.host),
  }
}
