// Simple Service Worker for PWA background persistence
const CACHE_NAME = 'scv-cache-v1';
const OFFLINE_URL = '/offline.html'; // Not really needed

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/manifest.json'
      ]);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});

// Background Sync (if supported)
self.addEventListener('sync', (event) => {
  if (event.tag === 'location-sync') {
    // Notify all clients to push their latest location
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({ type: 'doLocationPush' });
      });
    });
  }
});

// Listen for messages from the page
self.addEventListener('message', (event) => {
  if (event.data === 'keepAlive') {
    // Keep SW alive (just receiving a message extends life a bit)
  }
});