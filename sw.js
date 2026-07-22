/* ============================================================
   Service Worker (sw.js) - バージョン v2
============================================================ */

// ★バージョン名を v2 に変更（これでブラウザが古いキャッシュを全消去します）
const CACHE_NAME = 'vocab-trainer-v4.3';

// ★キャッシュするファイルのリストに新しいファイル群を追加
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './css-style.css',
  './css-ai-features.css',
  './js-app.js',
  './js-ai-features.js',
  './components-ai-features.html'
];

// インストール時に静的アセットをキャッシュ
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// アクティベート時に古いキャッシュ（v1など）を自動削除
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME)
          .map(name => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// fetch時の処理（Stale-While-Revalidate戦略）
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith('http')) return;

  // Gemini APIへのリクエストはキャッシュしない
  if (event.request.url.includes('generativelanguage.googleapis.com')) return;

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, networkResponse.clone());
          });
        }
        return networkResponse;
      }).catch(err => console.log('Offline: Network request failed', err));

      return cachedResponse || fetchPromise;
    })
  );
});
