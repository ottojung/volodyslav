// Simple service worker for Termux compatibility
// This avoids the complex workbox-build process that uses terser

import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';

// Precache all static assets
precacheAndRoute(self.__WB_MANIFEST);

// Clean up old caches
cleanupOutdatedCaches();

// Basic service worker events
self.addEventListener('install', (event) => {
  console.log('Service worker installing');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service worker activating');
  event.waitUntil(self.clients.claim());
});
