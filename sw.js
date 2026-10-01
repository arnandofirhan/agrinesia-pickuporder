/* Service worker PWA - hanya cache "kerangka" aplikasi.
 * Panggilan ke Apps Script (POST / domain google) TIDAK pernah disentuh,
 * jadi data selalu real-time dan kecepatan API tidak berubah.
 * Naikkan VERSION jika ingin memaksa semua perangkat memuat ulang cache. */
var VERSION = 'po-v5';
var SHELL = ['./', 'index.html', 'style.css?v=5', 'config.js?v=5', 'app.js?v=5', 'manifest.json',
             'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                       // semua panggilan API (POST) lewat langsung
  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var fonts = /(^|\.)fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !fonts) return;                      // domain Google Apps Script tidak disentuh

  // Halaman utama: jaringan dulu (selalu versi terbaru), cache hanya cadangan saat offline
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (res) {
      var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put('index.html', copy); });
      return res;
    }).catch(function () { return caches.match('index.html').then(function (r) { return r || caches.match('./'); }); }));
    return;
  }

  // Aset statis (berversi ?v=) & font: cache dulu = instan, lalu isi cache dari jaringan
  e.respondWith(caches.match(req).then(function (hit) {
    if (hit) return hit;
    return fetch(req).then(function (res) {
      if (res && (res.ok || res.type === 'opaque')) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
      return res;
    });
  }));
});
