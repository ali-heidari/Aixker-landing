const CACHE = 'dotsboxes-v1'
const BASE = new URL('./', self.location.href).pathname
const SHELL = [
  BASE,
  BASE + 'index.html',
  BASE + 'manifest.json',
  BASE + 'styles/main.css',
  BASE + 'src/app.js',
  BASE + 'src/game.js',
  BASE + 'src/ui.js',
  BASE + 'src/pipes.js',
  BASE + 'src/store.js',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  )
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', e => {
  const url = e.request.url
  // Skip cross-origin requests (PipesHub auth, socket.io, etc.)
  if (!url.startsWith(self.location.origin)) return

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached
      return fetch(e.request).catch(() => {
        // Offline fallback: return app shell for navigation requests
        if (e.request.mode === 'navigate') return caches.match('/index.html')
      })
    })
  )
})
