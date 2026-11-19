// Deckle's service worker: what makes the app installable, and makes it open
// with no network.
//
// It caches the app itself — the page, its scripts and styles, its icons — and
// nothing else. Notes are never cached here: a server library's notes stay on
// the server (and an offline server library says it can't be reached, rather
// than showing an out-of-date copy), and a local-folder or in-browser library
// is already on the device. Requests to /api are not even looked at.
//
//   - The page (any navigation): network first, so a new deployment takes
//     effect on the next load; the cached copy only when the network fails.
//   - /assets/*: cache first. Their names carry a content hash, so a cached
//     one is never stale — a new build simply asks for new names.
//   - Anything else of our own (icons, the manifest): the cached copy at once,
//     refreshed in the background.

const SHELL = 'deckle-shell-v1'
const ASSETS = 'deckle-assets-v1'
/** Old builds' assets pile up; keep the newest this many. */
const MAX_ASSETS = 200

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/', '/deckle.svg', '/manifest.webmanifest']))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith('deckle-') && name !== SHELL && name !== ASSETS)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(page(request))
  } else if (url.pathname.startsWith('/assets/')) {
    event.respondWith(asset(request))
  } else {
    event.respondWith(staleWhileRevalidate(request))
  }
})

async function page(request) {
  const cache = await caches.open(SHELL)
  try {
    const response = await fetch(request)
    // Every route is the same single page; keep the newest copy of it.
    if (response.ok) await cache.put('/', response.clone())
    return response
  } catch {
    return (await cache.match('/')) ?? Response.error()
  }
}

async function asset(request) {
  const cache = await caches.open(ASSETS)
  const cached = await cache.match(request)
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    void trim(cache)
  }
  return response
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL)
  const cached = await cache.match(request)
  const fresh = fetch(request)
    .then(async (response) => {
      if (response.ok) await cache.put(request, response.clone())
      return response
    })
    .catch(() => cached ?? Response.error())
  return cached ?? fresh
}

async function trim(cache) {
  const keys = await cache.keys()
  // Oldest first, in the order they were added.
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key)
}
