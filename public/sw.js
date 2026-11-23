// Life's service worker: shows Life's own notifications and opens the app when you tap one.
// (No offline caching: the app always loads fresh through the Cloudflare sign-in.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'Life', body: e.data ? e.data.text() : '' }; }
  // iPhone requires every push to show a notification, so always show one.
  e.waitUntil(self.registration.showNotification(d.title || 'Life', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    data: { url: d.url || '/#today' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/#today', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin !== self.location.origin) continue;
      await w.focus();
      if (w.url !== url) { try { await w.navigate(url); } catch (_) { w.postMessage({ open: url }); } }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
