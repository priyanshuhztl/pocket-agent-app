// Shows phone notifications, even when Pocket Agent is closed, and opens the right session when one is tapped.
// It also keeps a copy of the app on the phone, used when its page can't be reached (offline, or the page is down),
// and keeps the computer's new phone link when the computer sends it after a restart (see app.js). It tells the
// computer each notification arrived, and whether the phone let it show (for "Test your phone" and the log).
// Adapted from Shed (MIT, see NOTICE).
const COPY = 'pocket-agent-app', SAVED = 'pocket-agent';
const saved = async name => (await (await caches.open(SAVED)).match(name))?.text() || '';
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(COPY).then(cache => cache.addAll(['./', 'app.js', 'manifest.webmanifest', 'icon.svg'])).catch(() => {}));
});
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

// The app's own files: from the network when it answers (so a new version shows at once), else from the copy.
self.addEventListener('fetch', event => {
  const { request } = event, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  const key = request.mode === 'navigate' ? './' : request;
  event.respondWith((async () => {
    const cache = await caches.open(COPY);
    const res = await fetch(request).catch(() => null);
    if (res?.ok) { cache.put(key, res.clone()); return res; }
    return await cache.match(key, { ignoreSearch:true }) || res || Response.error();
  })());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title:'Pocket Agent', body:event.data?.text() || '' }; }
  event.waitUntil((async () => {
    // Only the computer can send these (they are signed with its key), so the link can be trusted.
    if (/^https:\/\//.test(data.link || '')) await (await caches.open(SAVED)).put('mac', new Response(new URL(data.link).origin));
    let error = '';
    await self.registration.showNotification(data.title || 'Pocket Agent', {
      body:data.body || '',
      icon:'icon.svg',
      tag:data.tag,
      renotify:Boolean(data.tag) && !data.silent,
      silent:Boolean(data.silent),
      data:{ url:data.url || './' },
    }).catch(e => { error = e.message || String(e); });
    const shown = !error && (await self.registration.getNotifications({ tag:data.tag })).length > 0;
    // The computer: its saved link and this device's key (app.js keeps both), or this page's own address and cookie.
    const key = await saved('key');
    await fetch(`${await saved('mac')}/api/push/receipt`, { method:'POST', headers:{ 'Content-Type':'application/json', ...(key ? { Authorization:`Bearer ${key}` } : {}) },
      body:JSON.stringify({ tag:data.tag || '', shown, error, permission:self.Notification?.permission || '' }) }).catch(() => {});
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type:'window', includeUncontrolled:true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (open) { await open.focus(); open.postMessage({ type:'open', url }); return; }
    await self.clients.openWindow(url);
  })());
});
