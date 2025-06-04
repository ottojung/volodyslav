// Simple service worker for Termux compatibility
// This avoids the complex workbox-build process that uses terser
//
// Configuration details: See docs/PWA_TERMUX_CONFIGURATION.md
//
// This service worker is specifically designed for the injectManifest strategy
// to work around Terser minification issues in resource-constrained environments
//
// NOTE: TypeScript errors are expected here - this runs in a Service Worker context,
// not the main browser context, so self, __WB_MANIFEST, etc. are available globally

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
