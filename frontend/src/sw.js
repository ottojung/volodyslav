/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck
// Simple service worker for Termux compatibility
// This avoids the complex workbox-build process that uses terser
//
// Configuration details: See docs/PWA_TERMUX_CONFIGURATION.md
//
// This service worker is specifically designed for the injectManifest strategy
// to work around Terser minification issues in resource-constrained environments
//
// TypeScript checking is disabled because this runs in a Service Worker context,
// not the main browser context, so self, __WB_MANIFEST, etc. are available globally

import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { logger } from "./DescriptionEntry/logger.js";

// Precache all static assets
precacheAndRoute(self.__WB_MANIFEST);

// Clean up old caches
cleanupOutdatedCaches();

// Basic service worker events
self.addEventListener("install", () => {
    logger.info("Service worker installing");
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    logger.info("Service worker activating");
    event.waitUntil(self.clients.claim());
});
