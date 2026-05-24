const CACHE = 'dotsboxes-v1'
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/styles/main.css',
  '/src/app.js',
  '/src/game.js',
  '/src/ui.js',
  '/src/pipes.js',
  '/src/store.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
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
  // Network-first for PipesHub traffic — never cache real-time messages
  if (url.includes(':3000') || url.includes(':16916') || url.includes('socket.io')) return

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
