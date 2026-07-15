// sw.js — the wallet's service worker. ONLY job: surface relay Web-Push pings («ваш ход» on a
// swap transition) as notifications and focus/open the wallet on tap. No fetch interception,
// no caching — the app itself stays a plain page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Freimarkets', {
    body: d.body || '',
    tag: d.id || 'fw-swap',        // one live notification per swap — a newer stage replaces it
    renotify: true,
    data: d,
    icon: '/icon.svg',
    badge: '/icon.svg',
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) { c.navigate?.('/#exchange'); return c.focus(); }
    return self.clients.openWindow('/#exchange');
  }));
});
