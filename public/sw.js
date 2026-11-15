/* UMARSHOYI-SUB service worker: shows phone notifications sent by Web Push when the app is closed. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'UMARSHOYI-SUB', body: e.data ? e.data.text() : '' }; }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible')) return;   // the app is open: it plays its own sound and shows the bell
    await self.registration.showNotification(String(d.title || 'UMARSHOYI-SUB').slice(0, 80), {
      body: String(d.body || '').slice(0, 200), icon: '/icon-192.png', badge: '/icon-192.png',
      tag: d.tag || undefined, renotify: !!d.tag, data: { url: '/' }, vibrate: d.kind === 'ahh' ? [200, 100, 200] : [120],
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) { if ('focus' in c) { await c.focus(); return; } }
    await self.clients.openWindow('/');
  })());
});
