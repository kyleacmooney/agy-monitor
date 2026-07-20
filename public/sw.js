/*
 * sw.js — the minimum service worker that makes agy-monitor an installable PWA
 * (so Chrome/Edge offer "Install app" and it opens in its own standalone window).
 *
 * It deliberately caches NOTHING. agy-monitor is a live console for a local
 * server that self-updates; a cache would serve stale HTML/JS and hide updates,
 * and it's useless without the server anyway. The fetch handler exists only to
 * satisfy the installability heuristic — it lets every request hit the network
 * unchanged (no respondWith → default browser fetch).
 */
"use strict";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => { /* passthrough: let the network serve it */ });
