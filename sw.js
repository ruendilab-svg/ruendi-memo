/* ============================================================
 * sw.js — 앱 셸 캐시 (오프라인에서도 타임라인이 열린다)
 *  · 같은 출처의 정적 파일: 네트워크 우선 + 캐시 대체 (온라인이면 항상 최신)
 *  · Supabase 등 외부 요청: 네트워크 그대로 (동기화는 항상 최신)
 *  · 앱 셸 버전을 올리면 새 캐시로 교체되고, 새 워커가 바로 활성화된다.
 *  · install 단계 fetch 는 cache:'reload' 로 HTTP 캐시를 건너뛴다
 *    (배포 직후 브라우저 HTTP 캐시에 남은 구버전 파일이 새 캐시에 들어가는 것을 막는다)
 * ============================================================ */
var CACHE = 'memo-app-shell-v1.3.0';

var SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './js/idb.js',
  './js/store.js',
  './js/supabase-rest.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        // cache: 'reload' → HTTP 캐시의 구버전 사본이 아니라 서버의 최신 사본을 받는다
        return fetch(new Request(url, { cache: 'reload' })).then(function (res) {
          if (res && res.ok) return cache.put(url, res);
        }).catch(function (err) {
          console.warn('[sw] 캐시 실패', url, err);
        });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // Supabase 등 외부는 그대로 통과

  // 앱 셸 문서·스크립트·스타일 = 네트워크 우선, 실패하면 캐시(오프라인)
  var network = fetch(req).then(function (res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(req).then(function (hit) {
      if (hit) return hit;
      if (req.mode === 'navigate') {
        return caches.match('./index.html').then(function (ix) {
          return ix || caches.match('./');
        });
      }
      throw new Error('offline');
    });
  });

  event.respondWith(network);
});
