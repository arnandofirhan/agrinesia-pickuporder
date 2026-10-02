/*************************************************
 * GAS BRIDGE - pengganti google.script.run
 * Memanggil backend Apps Script lewat fetch (POST text/plain
 * = "simple request", jadi TANPA preflight CORS => cepat).
 * Semua kode di app.js tetap sama persis; objek google.script.run
 * di bawah ini meniru perilaku aslinya (withSuccessHandler,
 * withFailureHandler, dan pemanggilan fungsi server by name).
 *************************************************/
(function () {
  'use strict';

  // Hanya fungsi BACA yang boleh diulang otomatis (aman, tidak menggandakan data).
  // Fungsi tulis (create/update/delete/login) tidak pernah diulang.
  var SAFE_RETRY = /^(get|validate|ping)/;

  // Antrean: Apps Script sering membalas 404/lambat bila dibanjiri request paralel -> maks 3 sekaligus,
  // request tulis (login/update/dll) didahulukan. Request BACA identik yang sedang berjalan digabung jadi satu.
  var MAXC = 3, active = 0, queue = [], INFLIGHT = {};
  function pump() {
    while (active < MAXC && queue.length) {
      (function (it) {
        active++;
        it.task().then(function (v) { active--; it.res(v); pump(); }, function (e) { active--; it.rej(e); pump(); });
      })(queue.shift());
    }
  }
  function schedule(task, urgent) {
    return new Promise(function (res, rej) {
      var it = { task: task, res: res, rej: rej };
      if (urgent) queue.unshift(it); else queue.push(it);
      pump();
    });
  }

  function callServer(fn, args, attempt) {
    attempt = attempt || 0;
    var dk = null;
    if (SAFE_RETRY.test(fn) && attempt === 0) {
      dk = fn + '|' + JSON.stringify(args);
      if (INFLIGHT[dk]) return INFLIGHT[dk];
    }
    var p = callServer_(fn, args, attempt);
    if (dk) { INFLIGHT[dk] = p; var clr = function () { if (INFLIGHT[dk] === p) delete INFLIGHT[dk]; }; p.then(clr, clr); }
    else if (!SAFE_RETRY.test(fn)) { var wipe = function () { INFLIGHT = {}; }; p.then(wipe, wipe); } // setelah tulis, baca berikutnya harus segar
    return p;
  }

  function callServer_(fn, args, attempt) {
    var url = window.API_URL;
    if (!url || /PASTE_URL/.test(url)) {
      return Promise.reject(new Error('API_URL belum diisi di config.js'));
    }
    var isRead = SAFE_RETRY.test(fn);
    return schedule(function () {
      // TIMEOUT: request yang menggantung tidak boleh menahan loading/antrean selamanya
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var to = setTimeout(function () { if (ctl) ctl.abort(); }, isRead ? 25000 : 60000);
      return fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn: fn, args: args }),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        if (!r.ok) { var he = new Error('HTTP ' + r.status); he.transient = true; throw he; }
        return r.json();
      }).then(function (v) { clearTimeout(to); return v; },
              function (e) {
                clearTimeout(to);
                if (e && e.name === 'AbortError') { var te = new Error('Server terlalu lama merespons (timeout)'); te.transient = true; throw te; }
                throw e;
              });
    }, !isRead).then(function (j) {
      // Server melempar exception (setara failure handler pada google.script.run)
      if (j && j.__gas_error) throw new Error(j.message || 'Server error');
      return j;
    }).catch(function (err) {
      // Gangguan sesaat (HTTP 404/5xx dari Google, jaringan putus) pada fungsi baca -> coba lagi otomatis
      var transient = err && (err.transient || err.name === 'TypeError');
      if (transient && SAFE_RETRY.test(fn) && attempt < 3) {
        return new Promise(function (res) { setTimeout(res, 250 * (attempt + 1)); })
          .then(function () { return callServer_(fn, args, attempt + 1); });
      }
      throw err;
    });
  }

  function makeRunner(onOk, onFail) {
    var target = {
      withSuccessHandler: function (cb) { return makeRunner(cb, onFail); },
      withFailureHandler: function (cb) { return makeRunner(onOk, cb); },
      withUserObject: function () { return makeRunner(onOk, onFail); }
    };
    return new Proxy(target, {
      get: function (t, name) {
        if (name in t) return t[name];
        if (typeof name !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          callServer(name, args).then(function (res) {
            if (onOk) onOk(res);
          }, function (err) {
            if (onFail) onFail(err);
            else console.error(err);
          });
        };
      }
    });
  }

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = makeRunner(null, null);
})();

/*************************************************
 * PICKUP ORDER MANAGEMENT - Frontend JS (SPA-like)
 *************************************************/
var STATE = {
  token: null, user: null,
  lookup: null,            // { stores:[], areas:[] }
  orders: null,            // semua order (sudah di-scope server sesuai role)
  stats: null, users: null,
  page: 'dashboard', pageNo: 1, confirmCb: null,
  notifRead: {}            // { orderReference: true } - notif yang sudah dibaca (per sesi browser)
};
var PAGE_SIZE = 25;
var USER_PAGE = { no: 1, size: 25 };
var TTL = 90000; // cache dianggap segar selama 90 detik
var CACHE = { dashboard: 0, orders: 0, lookup: 0, users: 0 };
var ADMIN_PAGES = ['users', 'stores', 'areas'];
var TITLES = { dashboard: 'Dashboard', orders: 'Orders', recap: 'Rekap Hampers', gallery: 'Galeri Bukti', users: 'Users', stores: 'Stores', areas: 'Area' };

/* ============== ICONS (Lucide, 2D flat) ============== */
var ICONS = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  hash: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/><path d="M21 12v4h-5a2 2 0 0 1 0-4z"/>',
  package: '<path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  orders: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  store: '<path d="M3 9l1.5-5.5A1 1 0 0 1 5.46 3h13.08a1 1 0 0 1 .96.74L21 9"/><path d="M3 9h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M9 20v-6h6v6"/>',
  map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4z"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  truck: '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.91a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  xcircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  chevLeft: '<path d="m15 18-6-6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'
};

function ic(name, size) {
  var cls = 'icon' + (size === 'sm' ? ' icon-sm' : size === 'lg' ? ' icon-lg' : '');
  return '<svg class="' + cls + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (ICONS[name] || '') + '</svg>';
}
function hydrateIcons(root) {
  (root || document).querySelectorAll('i[data-ic]').forEach(function (el) {
    el.outerHTML = ic(el.getAttribute('data-ic'), el.getAttribute('data-size'));
  });
}

/* ============== UTIL ============== */
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function debounce(fn, d) { var t; return function () { clearTimeout(t); t = setTimeout(fn, d); }; }
function fmtCurrency(n) { n = Number(n) || 0; return 'Rp ' + n.toLocaleString('id-ID'); }
/* ===== Cache lokal: layar langsung terisi data terakhir, data baru diambil di belakang ===== */
function cacheStore_() { try { return localStorage.getItem('pom_token') ? localStorage : sessionStorage; } catch (e) { return null; } }
function cacheKey_(k) { return 'pom_c_' + ((STATE.user && STATE.user.username) || '') + '_' + k; }
function cachePut_(k, v) { var s = cacheStore_(); if (!s || !STATE.user) return; try { s.setItem(cacheKey_(k), JSON.stringify(v)); } catch (e) {} }
function cacheGet_(k) { var s = cacheStore_(); if (!s || !STATE.user) return null; try { return JSON.parse(s.getItem(cacheKey_(k)) || 'null'); } catch (e) { return null; } }
function cacheClear_() {
  [localStorage, sessionStorage].forEach(function (s) {
    try { Object.keys(s).filter(function (k) { return k.indexOf('pom_c_') === 0; }).forEach(function (k) { s.removeItem(k); }); } catch (e) {}
  });
}
function hydrateCache_() {
  var lk = cacheGet_('lookup'), od = cacheGet_('orders'), st = cacheGet_('stats');
  if (lk && !STATE.lookup) { STATE.lookup = lk; try { renderScope_(); populateFilters(); } catch (e) {} }
  if (od && !STATE.orders) STATE.orders = od;
  if (st && !STATE.stats) STATE.stats = st;
  if (STATE.orders) { try { updateBell(); } catch (e) {} }
}
function fresh(key) { return Date.now() - CACHE[key] < TTL; }
function nowStamp() {
  var d = new Date(), p = function (x) { return ('0' + x).slice(-2); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
// Format tanggal seragam: DD-MM-YYYY (+ jam HH:mm:ss bila ada). Terima 2026/03/02, 2026-03-02, 2026-10-01 02:08:19
function fmtDate(v) {
  if (!v) return '';
  var m = String(v).match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?))?/);
  if (!m) return String(v);
  var p = function (x) { return ('0' + x).slice(-2); };
  return p(m[3]) + '-' + p(m[2]) + '-' + m[1] + (m[4] ? ' ' + m[4] : '');
}
function isAdmin() { return STATE.user && STATE.user.role === 'ADMIN'; }
/* ===== Sesi login: tetap login walau PWA di-swipe/close (localStorage), bukan hilang seperti sessionStorage ===== */
function isStandalone() { try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; } catch (e) { return false; } }
function sessGet(k) { try { return localStorage.getItem(k) || sessionStorage.getItem(k); } catch (e) { return null; } }
function sessSet(k, v, persist) { try { localStorage.removeItem(k); sessionStorage.removeItem(k); (persist ? localStorage : sessionStorage).setItem(k, v); } catch (e) {} }
function sessDel(k) { try { localStorage.removeItem(k); } catch (e) {} try { sessionStorage.removeItem(k); } catch (e) {} }
function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

var pending = 0;
function progress(d) {
  pending = Math.max(0, pending + d);
  $('topbar').classList.toggle('active', pending > 0);
}

// Wrapper google.script.run: progress bar tipis, bukan overlay layar penuh.
// Loading SELALU berhenti: success, failure, response null, maupun exception di handler.
function api(name, args, ok, fail) {
  progress(1);
  var failed = function (err) {
    if (fail) fail(err); else showToast('Terjadi gangguan koneksi. Coba lagi.', 'error');
  };
  var r = google.script.run
    .withSuccessHandler(function (res) {
      progress(-1);
      // Penyebab umum: server mengembalikan null (mis. objek Date tidak bisa diserialisasi)
      if (res === null || res === undefined) res = { success: false, message: 'Server tidak mengembalikan data. Coba lagi atau hubungi admin.' };
      if (res.success === false && /Sesi tidak valid/.test(res.message || '')) { procHide(); forceRelogin(); return; }
      try { ok(res); } catch (e) { console.error(e); failed(e); }
    })
    .withFailureHandler(function (err) { progress(-1); console.error(err); failed(err); });
  if (typeof r[name] !== 'function') { progress(-1); failed(new Error('Fungsi server tidak ditemukan: ' + name)); return; }
  try { r[name].apply(r, args); } catch (e) { progress(-1); failed(e); }
}

function forceRelogin() {
  cacheClear_();
  sessDel('pom_token'); sessDel('pom_user');
  showToast('Sesi berakhir, silakan login kembali.', 'warning');
  setTimeout(resetToLogin, 1200);
}

/* ---- Processing overlay: spinner -> animasi centang sukses / silang gagal ---- */
var procTimer = null, procSafety = null;
function procSvg(ok) {
  return '<svg class="proc-svg" viewBox="0 0 56 56"><circle cx="28" cy="28" r="26"/>' +
    (ok ? '<path d="M16 29l8 8 16-17"/>' : '<path d="M19 19l18 18M37 19L19 37"/>') + '</svg>';
}
function procShow(msg, sub) {
  clearTimeout(procTimer); clearTimeout(procSafety);
  $('procIcon').innerHTML = '<div class="proc-spin"></div>';
  $('procText').textContent = msg;
  $('procSub').textContent = sub || 'Mohon tunggu sebentar...';
  $('procBox').className = 'proc-box';
  $('procOverlay').classList.add('open');
  procSafety = setTimeout(function () { procError('Waktu permintaan habis. Silakan coba lagi.'); }, 45000);
}
function procHide() { clearTimeout(procTimer); clearTimeout(procSafety); $('procOverlay').classList.remove('open'); }
function procSuccess(msg, cb) {
  clearTimeout(procSafety); clearTimeout(procTimer);
  $('procIcon').innerHTML = procSvg(true);
  $('procText').textContent = msg; $('procSub').textContent = '';
  $('procBox').className = 'proc-box ok';
  procTimer = setTimeout(function () { procHide(); if (cb) cb(); }, 1000);
}
function procError(msg) {
  clearTimeout(procSafety); clearTimeout(procTimer);
  $('procIcon').innerHTML = procSvg(false);
  $('procText').textContent = 'Gagal'; $('procSub').textContent = msg || 'Terjadi kesalahan.';
  $('procBox').className = 'proc-box err';
  procTimer = setTimeout(procHide, 2200);
}
// Jalankan aksi server dengan processing -> success/error. onOk: update data lokal; after: setelah overlay tertutup.
function runAction(o) {
  procShow(o.processing || 'Memproses...');
  api(o.call, o.args, function (res) {
    if (!res.success) { procError(res.message || o.errMsg); return; }
    try { if (o.onOk) o.onOk(res); } catch (e) { console.error(e); }
    procSuccess(o.okMsg || res.message || 'Berhasil', o.after);
  }, function (err) {
    var m = err && err.message ? String(err.message) : '';
    procError((o.errMsg || 'Gagal memproses.') + (m ? ' (' + m + ')' : ' Periksa koneksi Anda.'));
  });
}

function btnLoading(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.html = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin-sm"></span>' + (label ? ' ' + label : '');
  } else {
    btn.disabled = false;
    if (btn.dataset.html) btn.innerHTML = btn.dataset.html;
  }
}

function showToast(message, type) {
  type = type || 'info';
  var map = { success: 'check', warning: 'alert', error: 'xcircle', info: 'info' };
  var c = $('toastContainer');
  var t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.innerHTML = '<span class="t-ico">' + ic(map[type] || 'info') + '</span><span>' + esc(message) + '</span>';
  c.appendChild(t);
  var close = function () {
    if (!t.parentNode) return;
    t.classList.add('toast-out');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  };
  t.addEventListener('click', close);
  setTimeout(close, type === 'error' ? 5000 : 3200);
}

/* ---- modal ---- */
/* Kunci scroll halaman saat popup terbuka (aman untuk Android/iOS) */
var _lockY = 0, _locked = false;
function lockScroll_() {
  if (_locked) return;
  _lockY = window.pageYOffset || document.documentElement.scrollTop || 0;
  document.body.style.top = (-_lockY) + 'px';
  document.documentElement.classList.add('no-scroll');
  document.body.classList.add('no-scroll');
  _locked = true;
}
function unlockScroll_() {
  if (!_locked) return;
  document.body.classList.remove('no-scroll');
  document.documentElement.classList.remove('no-scroll');
  document.body.style.top = '';
  window.scrollTo(0, _lockY);
  _locked = false;
}
function openModal(id) { $(id).classList.add('open'); lockScroll_(); }
function closeModal(id) {
  $(id).classList.remove('open');
  if (!document.querySelector('.modal-overlay.open')) unlockScroll_();
}
function closeAllModals() {
  document.querySelectorAll('.modal-overlay.open').forEach(function (m) { m.classList.remove('open'); });
  unlockScroll_();
}

function openConfirm(title, message, confirmLabel, cb, icon) {
  $('confirmTitle').textContent = title;
  $('confirmMessage').innerHTML = message;
  $('confirmActionBtn').innerHTML = esc(confirmLabel || 'Confirm');
  // Varian visual berdasarkan jenis aksi (hanya tampilan, callback tidak berubah)
  var t = String(title || '').toLowerCase(), variant = 'ok', shownIcon = icon || 'check';
  if (/^hapus/.test(t)) { variant = 'danger'; shownIcon = 'trash'; }
  else if (/^logout/.test(t)) { variant = 'info'; shownIcon = icon || 'logout'; }
  else if (/^nonaktifkan/.test(t)) { variant = 'warn'; shownIcon = 'alert'; }
  else if (shownIcon === 'alert') shownIcon = 'check';
  $('confirmIco').innerHTML = ic(shownIcon, 'lg');
  $('confirmIco').className = 'confirm-ico ' + variant;
  $('confirmActionBtn').className = 'btn ' + (variant === 'danger' ? 'btn-danger' : 'btn-primary');
  STATE.confirmCb = cb;
  openModal('modalConfirm');
}

function stateBlock(msg, retry, extra) {
  if (retry) {
    return '<div class="es err' + (extra ? ' ' + extra : '') + '"><div class="es-ic">' + ic('xcircle', 'lg') + '</div><b>Gagal memuat data</b><p>' + esc(msg) + '</p>' +
      '<button class="btn btn-sm btn-outline" data-act="retry" data-v="' + retry + '">' + ic('refresh', 'sm') + ' Coba Lagi</button></div>';
  }
  return emptyBlock('info', msg, '', extra);
}
function emptyBlock(icon, title, desc, extra) {
  return '<div class="es' + (extra ? ' ' + extra : '') + '"><div class="es-ic">' + ic(icon || 'info', 'lg') + '</div><b>' + esc(title) + '</b>' + (desc ? '<p>' + esc(desc) + '</p>' : '') + '</div>';
}
function emptyRow(cols, icon, title, desc) { return '<tr class="state-row"><td colspan="' + cols + '">' + emptyBlock(icon, title, desc) + '</td></tr>'; }
function stateRow(cols, msg, retry) { return '<tr class="state-row"><td colspan="' + cols + '">' + stateBlock(msg, retry) + '</td></tr>'; }
// Deskripsi hasil kosong: sebut kata kunci bila ada, atau arahkan ubah filter
function noResultDesc_(q, hasFilter) {
  if (q) return 'Tidak ada hasil untuk \u201c' + q + '\u201d. Periksa ejaan, coba kata kunci lain' + (hasFilter ? ', atau ubah filter.' : '.');
  if (hasFilter) return 'Tidak ada data yang cocok dengan filter yang dipilih. Coba ubah atau kosongkan filter.';
  return 'Belum ada data untuk ditampilkan.';
}
var SKEL_ROWS = function (n) { var s = ''; for (var i = 0; i < n; i++) s += '<tr><td colspan="10"><span class="sk" style="height:16px"></span></td></tr>'; return s; };

// Tombol aksi icon-only seragam untuk semua tabel (view/edit/complete/delete/toggle)
function iconActionBtn(o) {
  return '<button class="act-btn act-' + o.kind + '" data-act="' + o.act + '" data-v="' + esc(o.v) + '" title="' + esc(o.title) + '" aria-label="' + esc(o.title) + '">' + ic(o.icon, 'sm') + '</button>';
}

function statusBadge(status) {  var map = {
    READY_FOR_PICKUP: ['Ready for Pickup', 'badge-warning'],
    READY_FOR_DELIVERY: ['Ready for Delivery', 'badge-purple'],
    COMPLETED_PICKUP: ['Completed Pickup', 'badge-success'],
    COMPLETED_DELIVERY: ['Completed Delivery', 'badge-info']
  };
  var d = map[status] || [status, 'badge-default'];
  return '<span class="badge ' + d[1] + '">' + esc(d[0]) + '</span>';
}
function typeChip(t) {
  var s = String(t || '').trim();
  if (!s) return '<span class="muted-dash">-</span>';
  return '<span class="type-chip ' + (s.toLowerCase().indexOf('delivery') !== -1 ? 'tc-delivery' : 'tc-pickup') + '">' + esc(s) + '</span>';
}
function roleChip(r) {
  var role = r === 'STORE_USER' ? 'STORE' : r;
  return '<span class="role-chip rc-' + String(role).toLowerCase() + '">' + esc(role) + '</span>';
}
function isDeliveryOrder(o) { return String(o.deliveryType || '').toLowerCase().indexOf('delivery') !== -1; }
function isReadyStatus(status) { return status === 'READY_FOR_PICKUP' || status === 'READY_FOR_DELIVERY'; }
function activeBadge(s) {
  return s === 'ACTIVE' ? '<span class="badge badge-success">ACTIVE</span>' : '<span class="badge badge-default">INACTIVE</span>';
}

/* ============== BOOT ============== */
document.addEventListener('DOMContentLoaded', function () {
  hydrateIcons();
  bindEvents();
  applySidebarPref();
  tickClock();
  setInterval(tickClock, 1000);

  var saved = null;
  saved = sessGet('pom_token');
  if (!saved) { $('bootSplash').classList.add('hidden'); showLogin(); return; }

  STATE.token = saved;
  var cachedUser = null;
  try { cachedUser = JSON.parse(sessGet('pom_user') || 'null'); } catch (e) {}
  var instant = !!(cachedUser && cachedUser.username);
  if (instant) { $('bootSplash').classList.add('hidden'); restoreSessionUI(cachedUser); }   // topbar & bottom menu langsung tampil, hanya data yang memuat
  google.script.run
    .withSuccessHandler(function (res) {
      $('bootSplash').classList.add('hidden');
      if (res.success) {
        if (!instant) restoreSessionUI({ name: res.data.username, username: res.data.username, role: res.data.role, storeId: res.data.storeId, storeName: '', areaId: res.data.areaId });
      } else {
        sessDel('pom_token'); sessDel('pom_user'); sessDel('pom_page');
        showLogin();
      }
    })
    .withFailureHandler(function () {
      $('bootSplash').classList.add('hidden');
      if (!instant) showLogin();   // jaringan lemah != sesi habis
    })
    .validateSession(STATE.token);
});

function bindEvents() {
  $('loginForm').addEventListener('submit', handleLogin);
  $('pwToggleBtn').addEventListener('click', togglePasswordVisibility);
  $('themeToggle').addEventListener('click', toggleTheme);
  $('loginPassword').addEventListener('keyup', function (e) {
    var on = e.getModifierState && e.getModifierState('CapsLock');
    $('capsWarn').classList.toggle('hidden', !on);
  });
  $('loginPassword').addEventListener('blur', function () { $('capsWarn').classList.add('hidden'); });
  if ($('lgYear')) $('lgYear').textContent = new Date().getFullYear();
  applyRemembered_();
  $('logoutBtn').addEventListener('click', handleLogout);
  if ($('logoutBtn2')) $('logoutBtn2').addEventListener('click', handleLogout);
  function initFilterToggle(p, ids, resetId) {
    var card = $(p + 'FilterCard'), btn = $(p + 'ToggleBtn'), dot = $(p + 'Dot');
    if (!card || !btn) return;
    function refreshDot() {
      var n = 0;
      ids.forEach(function (id) { var el = $(id); if (el && el.value) n++; });
      dot.textContent = n; dot.classList.toggle('hidden', n === 0);
    }
    btn.addEventListener('click', function () {
      var open = card.classList.toggle('filters-open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    ids.forEach(function (id) { var el = $(id); if (el) { el.addEventListener('change', refreshDot); el.addEventListener('input', refreshDot); } });
    if ($(resetId)) $(resetId).addEventListener('click', function () { setTimeout(refreshDot, 50); });
    refreshDot();
  }
  (function () {
    var dw = $('filterDateWrap'), di = $('filterDate'); if (!dw || !di) return;
    function sync() { dw.classList.toggle('empty', !di.value); }
    di.addEventListener('change', sync); di.addEventListener('input', sync);
    if ($('resetFilterBtn')) $('resetFilterBtn').addEventListener('click', function () { setTimeout(sync, 60); });
    sync();
  })();
  initFilterToggle('orders', ['searchInput', 'filterStatus', 'filterStore', 'filterArea', 'filterDeliveryType', 'filterDate'], 'resetFilterBtn');
  initFilterToggle('users', ['userSearchInput', 'userFilterRole', 'userFilterStatus'], 'userResetFilterBtn');
  initFilterToggle('stores', ['storeSearchInput', 'storeFilterArea', 'storeFilterStatus'], 'storeResetFilterBtn');
  $('sidebarToggle').addEventListener('click', toggleSidebar);
  $('sbBackdrop').addEventListener('click', function () { document.body.classList.remove('drawer-open'); });
  $('bellBtn').addEventListener('click', function () { closeUserMenu_(); toggleNotifPopover(); });
  // Menu profil (logout) + sheet "Lainnya"
  $('userChip').addEventListener('click', function (e) { e.stopPropagation(); closeNotifPopover(); toggleUserMenu_(); });
  $('userChip').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } });
  $('logoutBtn3').addEventListener('click', function () { closeUserMenu_(); handleLogout(); });
  document.addEventListener('click', function (e) { var m = $('userMenu'); if (m && m.classList.contains('open') && !m.contains(e.target)) closeUserMenu_(); });
  $('bnMoreBtn').addEventListener('click', function () { toggleMoreSheet_(); });
  $('moreSheetBackdrop').addEventListener('click', function () { toggleMoreSheet_(false); });
  document.querySelectorAll('#moreSheet .nav-item').forEach(function (el) { el.addEventListener('click', function () { toggleMoreSheet_(false); }); });
  document.addEventListener('click', function (e) {
    var pop = $('notifPopover');
    if (!pop || !pop.classList.contains('open')) return;
    if (pop.contains(e.target) || $('bellBtn').contains(e.target)) return;
    if (e.composedPath && e.composedPath().indexOf(pop) !== -1) return;
    closeNotifPopover();
  });

  document.querySelectorAll('.nav-item').forEach(function (el) {
    el.addEventListener('click', function (e) { e.preventDefault(); navigateTo(el.getAttribute('data-page')); });
  });

  // Tutup modal: tombol [data-close] & klik overlay & Esc
  document.querySelectorAll('[data-close]').forEach(function (el) {
    el.addEventListener('click', function () {
      var ov = el.closest('.modal-overlay');
      if (ov) closeModal(ov.id);
    });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) closeModal(ov.id); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var open = document.querySelectorAll('.modal-overlay.open');
    if (open.length) closeModal(open[open.length - 1].id);
  });

  // Filter order: client-side dari cache (instan, tanpa request)
  var rerender = function () { STATE.pageNo = 1; renderOrders(); };
  $('searchInput').addEventListener('input', debounce(rerender, 150));
  ['filterStatus', 'filterStore', 'filterArea', 'filterDeliveryType', 'filterDate'].forEach(function (id) {
    $(id).addEventListener('change', rerender);
  });
  $('resetFilterBtn').addEventListener('click', resetFilters);
  bindProofRecap_();
  bindGallery_();
  $('exportOrdersBtn').addEventListener('click', exportOrdersExcel);
  $('orderPageSize').addEventListener('change', function () { PAGE_SIZE = +this.value || 25; STATE.pageNo = 1; renderOrders(); });
  $('orderPages').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-pg]') : null; if (!b) return;
    STATE.pageNo = +b.getAttribute('data-pg'); renderOrders(true);
  });
  $('prevPageBtn').addEventListener('click', function () { STATE.pageNo--; renderOrders(true); });
  $('nextPageBtn').addEventListener('click', function () { STATE.pageNo++; renderOrders(true); });

  // Filter store: client-side dari cache
  var storeRerender = function () { renderAdminLists(); };
  $('storeSearchInput').addEventListener('input', debounce(storeRerender, 150));
  ['storeFilterArea', 'storeFilterStatus'].forEach(function (id) { $(id).addEventListener('change', storeRerender); });
  $('storeResetFilterBtn').addEventListener('click', resetStoreFilters);

  var userRerender = function () { USER_PAGE.no = 1; renderUsers(); };
  $('userSearchInput').addEventListener('input', debounce(userRerender, 150));
  ['userFilterRole', 'userFilterStatus'].forEach(function (id) { $(id).addEventListener('change', userRerender); });
  $('userResetFilterBtn').addEventListener('click', function () {
    $('userSearchInput').value = ''; $('userFilterRole').value = ''; $('userFilterStatus').value = ''; userRerender();
  });
  $('userPageSize').addEventListener('change', function () { USER_PAGE.size = +this.value || 25; USER_PAGE.no = 1; renderUsers(); });
  $('userPrevBtn').addEventListener('click', function () { USER_PAGE.no--; renderUsers(); scrollUsersTop_(); });
  $('userNextBtn').addEventListener('click', function () { USER_PAGE.no++; renderUsers(); scrollUsersTop_(); });
  $('userPages').addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-pg]') : null; if (!b) return;
    USER_PAGE.no = +b.getAttribute('data-pg'); renderUsers(); scrollUsersTop_();
  });
  $('addUserBtn').addEventListener('click', function () { openUserForm(null); });
  $('saveUserBtn').addEventListener('click', saveUser);
  $('userFormRole').addEventListener('change', toggleUserStoreField);
  ['userFormName', 'userFormUsername', 'userFormPassword'].forEach(function (id) { $(id).addEventListener('input', validateUserForm_); });
  ['userFormRole', 'userFormStatus', 'userFormStore'].forEach(function (id) { $(id).addEventListener('change', validateUserForm_); });
  $('addStoreBtn').addEventListener('click', function () { openStoreForm(null); });
  $('saveStoreBtn').addEventListener('click', saveStore);
  $('addAreaBtn').addEventListener('click', function () { openAreaForm(null); });
  $('saveAreaBtn').addEventListener('click', saveArea);

  $('confirmActionBtn').addEventListener('click', function () {
    var cb = STATE.confirmCb; STATE.confirmCb = null;
    closeModal('modalConfirm');
    if (cb) cb();
  });
  // Keyboard: Enter pada kartu yang bisa diklik
  document.addEventListener('keydown', function (e) {
    var a = document.activeElement;
    if (e.key === 'Enter' && a && a.getAttribute && a.getAttribute('tabindex') === '0' && a.getAttribute('data-act')) a.click();
  });

  // Delegasi klik untuk aksi dinamis
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act'), v = el.getAttribute('data-v');
    if (act === 'detail') openOrderDetail(v);
    else if (act === 'notif-detail') { markNotifRead_(v); closeNotifPopover(); openOrderDetail(v); }
    else if (act === 'notif-viewall') { closeNotifPopover(); goOrders({ status: '' }); }
    else if (act === 'notif-readall') { markAllNotifRead_(); }
    else if (act === 'notif-tab') { STATE.notifTab = v || 'all'; renderNotifPopover(); }
    else if (act === 'edit-user') openUserForm(STATE.users[+v]);
    else if (act === 'toggle-user') toggleUserStatus(STATE.users[+v], el);
    else if (act === 'delete-user') askDeleteUser(STATE.users[+v]);
    else if (act === 'edit-store') openStoreForm(STATE.lookup.stores[+v]);
    else if (act === 'delete-store') askDeleteStore(STATE.lookup.stores[+v]);
    else if (act === 'edit-area') openAreaForm(STATE.lookup.areas[+v]);
    else if (act === 'delete-area') askDeleteArea(STATE.lookup.areas[+v]);
    else if (act === 'area-active') openActiveAreas_();
    else if (act === 'user-stores') openUserStores_(v, el.closest('tr'));
    else if (act === 'aa-toggle') { var it = el.closest('.aa-item'); var o = it.classList.toggle('show-idle'); el.textContent = o ? 'Sembunyikan store tanpa order' : 'Tampilkan ' + it.querySelectorAll('.aa-idle .aa-chip').length + ' store tanpa order'; }
    else if (act === 'jump-area-close') { closeModal('modalActiveAreas'); goOrders({ area: v }); }
    else if (act === 'goto-orders') goOrders({ status: v, deliveryType: el.getAttribute('data-dt') || '' });
    else if (act === 'recap-go') { var rg = {}; try { rg = JSON.parse(v); } catch (e) {} goOrders(rg); }
    else if (act === 'jump-store') goOrders({ store: v });
    else if (act === 'jump-area') goOrders({ area: v });
    else if (act === 'complete') { var co = findOrder(v); if (co) askComplete(co); }
    else if (act === 'revert') { var ro = findOrder(v); if (ro) askRevert(ro); }
    else if (act === 'revert-chip') { $('revertReason').value = v; syncRevertBtn(); $('revertReason').focus(); }
    else if (act === 'revert-submit') submitRevert();
    else if (act === 'proof-mode') setProofMode_(v);
    else if (act === 'proof-cam') openCamera_();
    else if (act === 'proof-gal') $('proofGal').click();
    else if (act === 'proof-clear') { $('proofCam').value = ''; $('proofGal').value = ''; setProofPhoto_(''); }
    else if (act === 'proof-submit') submitProof_();
    else if (act === 'proof-view') openProofPhoto_(v);
    else if (act === 'copy-resi') copyText_(v, 'Nomor resi disalin');
    else if (act === 'recap-group') { RECAP.group = v; renderRecap(); }
    else if (act === 'recap-copy') copyRecap_();
    else if (act === 'retry') {
      if (v === 'dashboard') { STATE.stats = null; loadDashboard(true); }
      else if (v === 'orders') { navigateTo('orders'); loadOrders(true); }
      else if (v === 'users') { loadUsers(true); }
      else if (v === 'lookup') { loadLookup(true); }
    }
  });

  window.addEventListener('resize', debounce(applySidebarPref, 200));
}

/* ============== SIDEBAR ============== */
function isMobile() { return window.innerWidth <= 900; }
function applySidebarPref() {
  if (isMobile()) { document.body.classList.remove('sb-collapsed'); return; }
  var pref = store('pom_sb');
  var collapsed = pref === null || pref === undefined ? window.innerWidth <= 1100 : pref === '1';
  document.body.classList.toggle('sb-collapsed', collapsed);
}
function toggleSidebar() {
  if (isMobile()) { document.body.classList.toggle('drawer-open'); return; }
  var c = document.body.classList.toggle('sb-collapsed');
  store('pom_sb', c ? '1' : '0');
}

/* ============== CLOCK / GREETING ============== */
var _clkKey = '';
function tickClock() {
  if (document.hidden) return;   // jangan kerja saat tab/PWA tidak terlihat
  var d = new Date();
  var p = function (x) { return ('0' + x).slice(-2); };
  var clock = $('bannerClock');
  if (clock) clock.textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  var h = d.getHours();
  var name = STATE.user ? (STATE.user.name || STATE.user.username) : '';
  var key = h + '|' + d.getDate() + '|' + name;
  if (key === _clkKey) return;   // sapaan/tanggal/ikon hanya diperbarui saat berubah
  _clkKey = key;
  var g = (h >= 5 && h <= 10) ? 'Selamat pagi' : (h >= 11 && h <= 14) ? 'Selamat siang' : (h >= 15 && h <= 18) ? 'Selamat sore' : 'Selamat malam';
  if ($('bannerGreeting')) $('bannerGreeting').textContent = g + (name ? ', ' + name : '');
  var day = h >= 6 && h < 18;
  var bi = $('bannerIcon');
  if (bi && bi.getAttribute('data-k') !== (day ? 'd' : 'n')) { bi.setAttribute('data-k', day ? 'd' : 'n'); bi.innerHTML = ic(day ? 'sun' : 'moon', 'lg'); }
  var hd = $('headerDate');
  if (hd) hd.textContent = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/* ============== AUTH ============== */
/* ---- Ingat saya (hanya menyimpan username, bukan password) ---- */
function applyRemembered_() {
  var u = '';
  try { u = localStorage.getItem('pom_remember_user') || ''; } catch (e) {}
  $('loginRemember').checked = !!u;
  if (u) $('loginUsername').value = u;
}
function saveRemembered_(u) {
  try {
    if ($('loginRemember').checked) localStorage.setItem('pom_remember_user', u);
    else localStorage.removeItem('pom_remember_user');
  } catch (e) {}
}
function showLogin() { $('loginPage').classList.remove('hidden'); $('appShell').classList.add('hidden'); }

function togglePasswordVisibility() {
  var input = $('loginPassword'), btn = $('pwToggleBtn');
  var show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = ic(show ? 'eyeOff' : 'eye', 'sm');
}

function showLoginError(msg) {
  $('loginErrorText').textContent = msg;
  $('loginError').classList.remove('hidden');
}

function handleLogin(e) {
  e.preventDefault();
  var btn = $('loginBtn'), box = $('loginError');
  box.classList.add('hidden');
  var u = $('loginUsername').value.trim(), p = $('loginPassword').value;
  if (!u || !p) { showLoginError('Username dan password wajib diisi.'); return; }
  btnLoading(btn, true, 'Memproses...');
  google.script.run
    .withSuccessHandler(function (res) {
      btnLoading(btn, false);
      if (res.success) {
        saveRemembered_(u);
        STATE.token = res.data.token;
        var keep = ($('loginRemember') && $('loginRemember').checked) || isStandalone();
        sessSet('pom_token', STATE.token, keep);
        sessSet('pom_user', JSON.stringify(res.data), keep);
        restoreSessionUI(res.data);
      } else {
        showLoginError(res.message || 'Username atau password salah.');
      }
    })
    .withFailureHandler(function () {
      btnLoading(btn, false);
      showLoginError('Terjadi kesalahan saat login. Periksa koneksi Anda.');
    })
    .login(u, p);
}

/* ---- Dark mode: hanya aktif di dalam aplikasi, tidak pernah dipasang di halaman login ---- */
function getTheme() { try { return localStorage.getItem('pom_theme') || 'light'; } catch (e) { return 'light'; } }
function applyTheme(t) {
  document.body.classList.toggle('dark', t === 'dark');
  var b = $('themeToggle');
  if (b) { b.innerHTML = ic(t === 'dark' ? 'sun' : 'moon'); b.title = t === 'dark' ? 'Mode terang' : 'Mode gelap'; }
}
function toggleTheme() {
  var t = document.body.classList.contains('dark') ? 'light' : 'dark';
  try { localStorage.setItem('pom_theme', t); } catch (e) {}
  applyTheme(t);
}
function restoreSessionUI(data) {
  applyTheme(getTheme());
  STATE.user = data;
  $('loginPage').classList.add('hidden');
  $('appShell').classList.remove('hidden');
  var nm = data.name || data.username || '?';
  $('userName').textContent = nm;
  var roleLabel = { ADMIN: 'Admin', MANAGER: 'Manager', STORE: 'Store', STORE_USER: 'Store' };
  $('userRole').textContent = roleLabel[data.role] || data.role || '-';
  $('userRole').title = data.storeName || '';
  $('userAvatar').textContent = nm.charAt(0).toUpperCase();
  if (!isAdmin()) document.querySelectorAll('.admin-only').forEach(function (el) { el.classList.add('hidden'); });
  tickClock();

  // Buka halaman terakhir (mis. tetap di Orders saat refresh); hanya data halaman itu yang dimuat
  var startPage = pageFromPath_() || store('pom_page');
  if (!startPage || !TITLES[startPage]) startPage = 'dashboard';
  STATE.urlReady = false;
  hydrateCache_();      // tampil instan dari data terakhir, lalu disegarkan di bawah
  loadNotifRead_();
  navigateTo(startPage); // data halaman aktif diminta lebih dulu
  loadLookup(true);
  if (startPage !== 'orders') loadOrders(true);   // data bell notifikasi (Users dimuat saat halamannya dibuka)
}

function handleLogout() {
  openConfirm('Logout', 'Apakah Anda yakin ingin keluar?', 'Logout', doLogout, 'logout');
}

// Kembali ke halaman login TANPA location.reload() (reload di iframe Apps Script menghasilkan halaman blank)
function resetToLogin() {
  cacheClear_();
  document.body.classList.remove('dark'); // login page selalu tema terang
  STATE.token = null; STATE.user = null; STATE.lookup = null; STATE.orders = null;
  STATE.stats = null; STATE.users = null; STATE.page = 'dashboard'; STATE.pageNo = 1; STATE.confirmCb = null;
  CACHE.dashboard = 0; CACHE.orders = 0; CACHE.lookup = 0; CACHE.users = 0;
  pending = 0; $('topbar').classList.remove('active');
  closeAllModals(); procHide();
  document.body.classList.remove('drawer-open');
  closeNotifPopover();
  resetFilters(true);
  document.querySelectorAll('.admin-only').forEach(function (el) { el.classList.remove('hidden'); });
  document.querySelectorAll('.page').forEach(function (p) { p.classList.add('hidden'); });
  $('page-dashboard').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-page') === 'dashboard'); });
  ['statGrid', 'areaSummary', 'storeSummary', 'ordersTableBody', 'ordersCardList', 'usersTableBody', 'storesTableBody', 'areasTableBody'].forEach(function (id) { $(id).innerHTML = ''; });
  $('headerTitle').textContent = TITLES.dashboard;
  $('loginForm').reset(); $('loginError').classList.add('hidden'); applyRemembered_();
  if ($('loginPassword')) $('loginPassword').type = 'password';
  if ($('pwToggleBtn')) $('pwToggleBtn').innerHTML = ic('eye', 'sm');
  $('bootSplash').classList.add('hidden');
  showLogin();
  setTimeout(function () { var u = $('loginUsername'), p = $('loginPassword'); if (u && u.value) p.focus(); else if (u) u.focus(); }, 50);
}

function doLogout() {
  // Instan: langsung ke halaman login, invalidasi sesi di server berjalan di background (tanpa menunggu)
  var token = STATE.token;
  closeAllModals();
  sessDel('pom_token'); sessDel('pom_user'); sessDel('pom_page');
  resetToLogin();
  STATE.urlReady = false;
  try { history.replaceState(null, '', '/'); } catch (e) {}   // URL kembali ke root saat logout
  try { google.script.run.withSuccessHandler(function () {}).withFailureHandler(function () {}).logout(token); } catch (e) {}
}

/* ============== NAVIGATION (tanpa reload, tanpa overlay) ============== */
function toggleUserMenu_() {
  var m = $('userMenu'), open = !m.classList.contains('open');
  m.classList.toggle('open', open); $('userChip').setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) { $('umName').textContent = $('userName').textContent; $('umRole').textContent = $('userRole').textContent; }
}
function closeUserMenu_() { var m = $('userMenu'); if (m) { m.classList.remove('open'); $('userChip').setAttribute('aria-expanded', 'false'); } }
function toggleMoreSheet_(force) {
  var open = typeof force === 'boolean' ? force : !$('moreSheet').classList.contains('open');
  $('moreSheet').classList.toggle('open', open); $('moreSheetBackdrop').classList.toggle('open', open);
  $('bnMoreBtn').setAttribute('aria-expanded', open ? 'true' : 'false');
}
/* ---- URL per halaman: /dashboard, /orders, /rekap, /galeri, /users, /stores, /area ---- */
var PAGE_PATH = { dashboard: 'dashboard', orders: 'orders', recap: 'rekap', gallery: 'galeri', users: 'users', stores: 'stores', areas: 'area' };
function pageFromPath_() {
  var seg = (location.pathname || '/').replace(/^\/+|\/+$/g, '').split('/')[0].toLowerCase();
  for (var k in PAGE_PATH) if (PAGE_PATH[k] === seg) return k;
  return null;
}
function syncUrl_(page, replace) {
  try {
    var want = '/' + PAGE_PATH[page];
    if (location.pathname === want) return;
    history[replace ? 'replaceState' : 'pushState']({ page: page }, '', want + location.search);
  } catch (e) {}
}
window.addEventListener('popstate', function () {
  if (!STATE.user) return;
  var p = pageFromPath_();
  if (p && p !== STATE.page) navigateTo(p, true);
});
function navigateTo(page, fromPop) {
  if (ADMIN_PAGES.indexOf(page) !== -1 && !isAdmin()) page = 'dashboard';
  STATE.page = page; store('pom_page', page);
  if (!fromPop) syncUrl_(page, !STATE.urlReady); STATE.urlReady = true;
  document.querySelectorAll('.page').forEach(function (p) { p.classList.add('hidden'); });
  $('page-' + page).classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(function (n) { n.classList.toggle('active', n.getAttribute('data-page') === page); });
  var moreBtn = $('bnMoreBtn'); if (moreBtn) moreBtn.classList.toggle('active', page === 'users' || page === 'stores' || page === 'areas');
  toggleMoreSheet_(false); closeUserMenu_();
  $('headerTitle').textContent = TITLES[page];
  document.body.classList.remove('drawer-open');
  window.scrollTo(0, 0);

  if (page === 'dashboard') loadDashboard(false);
  else if (page === 'orders') { renderOrders(); if (!fresh('orders')) loadOrders(false); }
  else if (page === 'recap') { renderRecap(); if (!fresh('orders')) loadOrders(false); }
  else if (page === 'gallery') { renderGallery(); if (!fresh('orders')) loadOrders(false); }
  else if (page === 'users') loadUsers(false);
  else {
    if (STATE.lookup) renderAdminLists();
    else { $('storesTableBody').innerHTML = lookupSkel_('stores', 5); $('areasTableBody').innerHTML = lookupSkel_('areas', 5); }
    if (!fresh('lookup')) loadLookup(false);
  }
}

/* ============== LOOKUP (store & area) ============== */
function loadLookup(force) {
  if (!force && STATE.lookup && fresh('lookup')) return;
  api('getStoresAndAreas', [STATE.token], function (res) {
    if (!res.success) { lookupFail(res.message); return; }
    STATE.lookup = res.data; CACHE.lookup = Date.now(); cachePut_('lookup', res.data);
    renderScope_();
    populateFilters();
    renderAdminLists();
    if (STATE.users) renderUsers();
  }, function () { lookupFail('Gagal memuat data store/area.'); });
}
function lookupFail(msg) {
  showToast(msg, 'error');
  if (!STATE.lookup && isAdmin()) {
    $('storesTableBody').innerHTML = stateRow(5, msg, 'lookup');
    $('areasTableBody').innerHTML = stateRow(4, msg, 'lookup');
  }
}

function populateFilters() {
  var sv = $('filterStore').value, av = $('filterArea').value;
  $('filterStore').innerHTML = '<option value="">Semua Store</option>' + STATE.lookup.stores.map(function (s) {
    return '<option value="' + esc(s.storeName) + '">' + esc(s.storeName) + '</option>';
  }).join('');
  $('filterArea').innerHTML = '<option value="">Semua Area</option>' + STATE.lookup.areas.map(function (a) {
    return '<option value="' + esc(a.areaName) + '">' + esc(a.areaName) + '</option>';
  }).join('');
  setSel('filterStore', sv); setSel('filterArea', av);
}

/* ============== DASHBOARD ============== */
function loadDashboard(force) {
  if (STATE.stats) renderDashboard(); else renderDashboardSkeleton();
  if (!force && STATE.stats && fresh('dashboard')) return;
  var fail = function (msg) {
    if (STATE.stats) { showToast(msg, 'error'); return; }
    $('statGrid').innerHTML = stateBlock(msg, 'dashboard', 'span-all');
    $('areaSummary').innerHTML = ''; $('storeSummary').innerHTML = '';
  };
  api('getDashboardStats', [STATE.token], function (res) {
    if (!res.success) { fail(res.message); return; }
    STATE.stats = res.data; CACHE.dashboard = Date.now(); cachePut_('stats', res.data);
    renderDashboard(); updateBell();
  }, function () { fail('Gagal memuat dashboard. Periksa koneksi Anda.'); });
}

/* Navigasi dari Dashboard -> Orders dengan filter otomatis aktif */
function setSel(id, val) {
  var el = $(id); if (!el) return;
  if (!val) { el.value = ''; return; }
  var has = Array.prototype.some.call(el.options, function (o) { return o.value === val; });
  if (!has) { var op = document.createElement('option'); op.value = val; op.textContent = val === '__NONE__' ? 'Unknown' : val; el.appendChild(op); }
  el.value = val;
}
function goOrders(f) {
  f = f || {};
  resetFilters(true);
  setSel('filterStatus', f.status || '');
  setSel('filterArea', f.area || '');
  setSel('filterStore', f.store || '');
  setSel('filterDeliveryType', f.deliveryType || '');
  $('searchInput').value = f.search || '';
  try { $('searchInput').dispatchEvent(new Event('input')); } catch (e) {}
  STATE.pageNo = 1;
  navigateTo('orders');
}

/* Hover merah tombol X (disuntik dari JS + !important agar pasti menang atas CSS lain) */
(function injectCloseBtnCss_() {
  if (document.getElementById('closeBtnCss')) return;
  var st = document.createElement('style');
  st.id = 'closeBtnCss';
  st.textContent = '.modal-close{cursor:pointer;transition:background .18s ease,color .18s ease,box-shadow .18s ease,transform .18s ease !important;}' +
    '.modal-close svg{transition:transform .22s ease;}' +
    '.modal-close:hover svg,.modal-close:focus-visible svg{transform:rotate(90deg);}' +
    '.modal-close:active{transform:scale(.92);}' +
    '.modal-close:focus-visible{outline:none;}' +
    'body .modal-close:hover,body .modal-close:focus-visible,body .modal-header .modal-close:hover,body.dark .modal-overlay .modal-close:hover,body.dark .modal-overlay .mh-form .modal-close:hover{' +
    'background:linear-gradient(135deg,#ff6b6b,#e5393f) !important;color:#fff !important;' +
    'box-shadow:0 6px 16px rgba(229,57,63,.45),0 0 0 3px rgba(239,68,68,.18) !important;}';
  document.head.appendChild(st);
})();

/* CSS ringkasan store disuntik dari JS supaya selalu ikut ter-update bersama file ini */
function ensureScopeCss_() {
  if (document.getElementById('scopePopCss')) return;
  var st = document.createElement('style');
  st.id = 'scopePopCss';
  st.textContent = `.scope-panel{display:none;}
.scope-panel.open{display:block;margin-top:10px;padding:10px 12px;max-height:230px;overflow-y:auto;overscroll-behavior:contain;border-radius:14px;background:rgba(0,0,0,.18);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);animation:scopeIn .14s ease-out;}
@keyframes scopeIn{from{opacity:0}to{opacity:1}}
.scope-panel .sp-group+.sp-group{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1);}
.scope-panel .sp-title{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#ffe29a;margin-bottom:6px;}
.scope-panel .sp-title span{font-weight:600;color:#bfe9d3;text-transform:none;letter-spacing:0;}
.scope-panel .sp-list{display:flex;flex-wrap:wrap;gap:5px;}
.scope-panel .sp-item{font-size:11.5px;font-weight:600;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;}
.scope-panel::-webkit-scrollbar{width:6px;}
.scope-panel::-webkit-scrollbar-thumb{background:rgba(255,255,255,.25);border-radius:6px;}
.scope-wrap .scope-chip .dot{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.6;display:inline-block;}
@media (max-width:600px){.scope-panel.open{max-height:180px;}}`;
  document.head.appendChild(st);
}

/* ---- Banner dashboard: ringkasan cakupan akses (area + jumlah store) ---- */
function renderScope_() {
  var wrap = $('dashboardScopeWrap'); if (!wrap || !STATE.user) return;
  ensureScopeCss_();
  var role = STATE.user.role === 'STORE_USER' ? 'STORE' : STATE.user.role;
  if (role === 'STORE') { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }   // user Store: tanpa nama store
  wrap.style.display = '';
  if (isAdmin()) { wrap.innerHTML = '<div class="scope-row"><span class="scope-chip sc-total">' + ic('store', 'sm') + ' Semua Store</span></div>'; return; }
  var stores = (STATE.lookup && STATE.lookup.stores) || [];
  var areas = (STATE.lookup && STATE.lookup.areas) || [];
  if (!stores.length) { wrap.innerHTML = ''; return; }
  var map = {};
  areas.forEach(function (a) { map[a.areaId] = { name: a.areaName, stores: [] }; });
  stores.forEach(function (st) {
    var g = map[st.areaId] || (map[st.areaId || '_'] = { name: 'Tanpa Area', stores: [] });
    g.stores.push(st.storeName);
  });
  var groups = Object.keys(map).map(function (k) { return map[k]; }).filter(function (g) { return g.stores.length; })
    .sort(function (a, b) { return b.stores.length - a.stores.length; });

  var row;
  if (groups.length === 1) {
    row = '<span class="scope-chip sc-total">' + ic('map', 'sm') + ' ' + esc(groups[0].name) + ' <i class="dot"></i> <b>' + stores.length + '</b> store</span>';
  } else {
    var MAXC = 3;
    row = '<span class="scope-chip sc-total">' + ic('store', 'sm') + ' <b>' + stores.length + '</b> store</span>' +
      groups.slice(0, MAXC).map(function (g) {
        return '<span class="scope-chip sc-area">' + esc(g.name) + ' <b>' + g.stores.length + '</b></span>';
      }).join('');
    if (groups.length > MAXC) row += '<span class="scope-chip sc-more">+' + (groups.length - MAXC) + ' area</span>';
  }
  // Panel dibuat di awal (tersembunyi), jadi saat diklik tinggal ditampilkan -> instan
  var panel = groups.map(function (g) {
    // Satu area saja: judul area disembunyikan (sudah tampil di chip atas)
    var title = groups.length > 1 ? '<div class="sp-title">' + esc(g.name) + ' <span>' + g.stores.length + ' store</span></div>' : '';
    return '<div class="sp-group">' + title + '<div class="sp-list">' +
      g.stores.map(function (n) { return '<span class="sp-item">' + esc(n) + '</span>'; }).join('') + '</div></div>';
  }).join('');
  wrap.innerHTML = '<div class="scope-row">' + row + '<button type="button" class="scope-toggle" id="scopeToggle" aria-expanded="false">Lihat detail</button></div>' +
    '<div class="scope-panel" id="scopePanel">' + panel + '</div>';
  $('scopeToggle').addEventListener('click', function () {
    var open = $('scopePanel').classList.toggle('open');
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
    this.textContent = open ? 'Sembunyikan' : 'Lihat detail';
  });
}

/* ---- Area Aktif: ringkasan + daftar area (yang punya order) + store di dalamnya ---- */
function openActiveAreas_() {
  var s = STATE.stats || {}, byArea = s.byArea || {}, byStore = s.byStore || {};
  var lk = STATE.lookup || { areas: [], stores: [] };
  var names = Object.keys(byArea).filter(function (k) { return k !== 'Unknown' && Number(byArea[k]) > 0; })
    .sort(function (a, b) { return byArea[b] - byArea[a]; });
  var totalOrd = names.reduce(function (t, n) { return t + byArea[n]; }, 0);
  var maxOrd = names.length ? byArea[names[0]] : 1;
  var totalStoreActive = 0;
  var cards = names.map(function (n, idx) {
    var ar = lk.areas.filter(function (a) { return a.areaName === n; })[0];
    var stores = ar ? lk.stores.filter(function (x) { return x.areaId === ar.areaId; }) : [];
    var act = stores.filter(function (x) { return byStore[x.storeName]; })
      .sort(function (a, b) { return byStore[b.storeName] - byStore[a.storeName]; });
    var idle = stores.filter(function (x) { return !byStore[x.storeName]; });
    totalStoreActive += act.length;
    var share = totalOrd ? Math.round(byArea[n] / totalOrd * 100) : 0;
    var chips = act.map(function (x) {
      return '<span class="aa-chip">' + esc(x.storeName) + '<b>' + byStore[x.storeName] + '</b></span>';
    }).join('');
    var idleHtml = idle.length ? '<button type="button" class="aa-more" data-act="aa-toggle" data-v="">Tampilkan ' + idle.length + ' store tanpa order</button>' +
      '<div class="aa-idle">' + idle.map(function (x) { return '<span class="aa-chip off">' + esc(x.storeName) + '</span>'; }).join('') + '</div>' : '';
    return '<div class="aa-item">' +
      '<div class="aa-top clickable" tabindex="0" role="button" title="Lihat order ' + esc(n) + '" data-act="jump-area-close" data-v="' + esc(n) + '">' +
        '<span class="aa-rank">' + (idx + 1) + '</span>' +
        '<div class="aa-main"><div class="aa-name">' + esc(n) + '</div>' +
          '<div class="aa-meta">' + (stores.length ? act.length + ' dari ' + stores.length + ' store punya order' : 'Data store belum dimuat') + '</div></div>' +
        '<div class="aa-num"><b>' + byArea[n].toLocaleString('id-ID') + '</b><span>order · ' + share + '%</span></div>' +
        '<div class="aa-bar"><i style="width:' + Math.max(4, Math.round(byArea[n] / maxOrd * 100)) + '%"></i></div>' +
      '</div>' +
      (chips ? '<div class="aa-stores">' + chips + '</div>' : '') + idleHtml + '</div>';
  }).join('');
  $('activeAreasSub').textContent = 'Sebaran order per area dan store';
  $('activeAreasBody').innerHTML = names.length ?
    '<div class="aa-summary"><div><b>' + names.length + '</b><span>Area aktif</span></div>' +
    '<div><b>' + (lk.stores.length ? totalStoreActive : '-') + '</b><span>Store punya order</span></div>' +
    '<div><b>' + totalOrd.toLocaleString('id-ID') + '</b><span>Total order</span></div></div>' + cards
    : emptyBlock('map', 'Belum ada area aktif', 'Area akan muncul di sini setelah ada order masuk.', 'sm');
  openModal('modalActiveAreas');
}

function renderDashboardSkeleton() {
  renderScope_();
  /* skeleton meniru kartu asli: jumlah, urutan, kelas, dan susunan yang sama */
  var cls = ['kpi-green', 'kpi-orange', 'kpi-purple', 'kpi-blue', 'kpi-teal', 'kpi-slate', 'kpi-gold kpi-wide', 'kpi-orange', 'kpi-teal', 'kpi-green kpi-span'];
  $('statGrid').innerHTML = cls.map(function (c, i) {
    var hero = i === 9;
    return '<div class="kpi is-sk ' + c + '"><div class="kpi-icon"></div>' +
      '<div class="kpi-label"><span class="skl" style="height:9px;width:78%"></span></div>' +
      '<div class="kpi-value"><span class="skl" style="height:20px;width:52%;margin-top:6px"></span></div>' +
      '<div class="kpi-sub"><span class="skl" style="height:9px;width:90%"></span></div>' +
      (hero ? '<div class="kpi-ring"><span class="skl skl-ring"></span></div><div class="kpi-chips"><span class="skl skl-chip"></span><span class="skl skl-chip"></span><span class="skl skl-chip"></span></div>' : '') +
      '</div>';
  }).join('');
  function skRank(kind) {
    var rows = '';
    for (var n = 0; n < 5; n++) rows += '<div class="rank-item"><div class="rank-top"><span class="sk" style="width:' + (80 + (n * 17) % 50) + 'px;height:11px"></span><b class="sk" style="width:20px;height:11px"></b></div><div class="bar"><i class="sk" style="width:' + (92 - n * 16) + '%;height:100%;border-radius:0"></i></div></div>';
    return '<div class="rank-wrap"><div class="rank-list' + (kind === 'area' ? ' single' : '') + '">' + rows + '</div></div>';
  }
  $('areaSummary').innerHTML = skRank('area'); $('storeSummary').innerHTML = skRank('store');
  ensureDashTabs_('–', '–');
}

function rankList(obj, kind) {
  var keys = Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; });
  if (!keys.length) return emptyBlock('info', 'Belum ada data', '', 'sm');
  var max = obj[keys[0]] || 1;
  var html = '<div class="rank-wrap"><div class="rank-list single">' + keys.map(function (k, i) {
    var v = k === 'Unknown' ? '__NONE__' : k;
    return '<div class="rank-item clickable' + (i >= 5 ? ' rk-extra' : '') + '" tabindex="0" role="button" title="Lihat order ' + esc(k) + '" data-act="jump-' + kind + '" data-v="' + esc(v) + '"><div class="rank-top"><span>' + esc(k) + '</span><b>' + obj[k] + '</b></div>' +
      '<div class="bar"><i style="width:' + Math.max(4, Math.round(obj[k] / max * 100)) + '%"></i></div></div>';
  }).join('') + '</div>';
  if (keys.length > 5) html += '<button type="button" class="rk-more" onclick="rkMore_(this)" data-n="' + keys.length + '">Lihat semua (' + keys.length + ')</button>';
  return html + '</div>';
}
function hideSplitForStore_() {
  var g = $('dashSplit'); if (!g) return;
  var role = STATE.user && (STATE.user.role === 'STORE_USER' ? 'STORE' : STATE.user.role);
  if (role === 'STORE') g.style.setProperty('display', 'none', 'important'); else g.style.removeProperty('display');   // user Store hanya melihat store-nya sendiri: ringkasan ini redundan
}
function rkMore_(b) {
  var w = b.parentNode, on = w.classList.toggle('expanded');
  b.textContent = on ? 'Ringkas' : 'Lihat semua (' + b.getAttribute('data-n') + ')';
}
function ensureDashTabs_(na, ns) {
  var g = $('dashSplit') || document.querySelector('#page-dashboard .grid-2'); if (!g) return;
  g.id = 'dashSplit';
  var cards = g.children;
  for (var i = 0; i < cards.length && i < 2; i++) {
    var old = cards[i].querySelector('.dash-tabs'); if (old) old.parentNode.removeChild(old);
    var d = document.createElement('div'); d.className = 'dash-tabs';
    d.innerHTML = '<button type="button" data-t="area" onclick="dashTab_(\'area\')">Per Area <i>' + na + '</i></button><button type="button" data-t="store" onclick="dashTab_(\'store\')">Per Store <i>' + ns + '</i></button>';
    cards[i].insertBefore(d, cards[i].firstChild);
  }
  dashTab_(g.classList.contains('show-store') ? 'store' : 'area');
}
function dashTab_(t) {
  var g = $('dashSplit'); if (!g) return;
  g.classList.toggle('show-store', t === 'store');
  var bs = g.querySelectorAll('.dash-tabs button');
  for (var i = 0; i < bs.length; i++) bs[i].classList.toggle('on', bs[i].getAttribute('data-t') === t);
}

function renderDashboard() {
  var s = STATE.stats;
  renderScope_();
  var totalOrd = Number(s.totalOrder) || 0;
  var avgOrder = totalOrd ? Math.round((Number(s.totalRevenue) || 0) / totalOrd) : 0;
  var activeAreas = Object.keys(s.byArea || {}).filter(function (k) { return k !== 'Unknown' && Number(s.byArea[k]) > 0; }).length;
  var doneOrders = (Number(s.completedPickup) || 0) + (Number(s.completedDelivery) || 0);
  var completionRate = totalOrd ? Math.round(doneOrders / totalOrd * 1000) / 10 : 0;
  var remain = Math.max(0, totalOrd - doneOrders);
  var ringSvg = '<svg viewBox="0 0 100 100" aria-hidden="true"><defs><linearGradient id="kgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#0a7d57"/></linearGradient></defs>' +
    '<circle class="kr-track" cx="50" cy="50" r="42"/><circle class="kr-prog" cx="50" cy="50" r="42" style="stroke-dashoffset:' + (264 * (1 - Math.min(100, completionRate) / 100)).toFixed(1) + '"/></svg>' +
    '<span class="kr-num">' + String(Math.round(completionRate * 10) / 10).replace('.', ',') + '<small>%</small></span>';
  var topOf = function (m) { var bk = '', bv = 0; Object.keys(m || {}).forEach(function (k) { if (k !== 'Unknown' && Number(m[k]) > bv) { bk = k; bv = Number(m[k]); } }); return { k: bk, v: bv }; };
  var topA = topOf(s.byArea), topS = topOf(s.byStore), qpo = totalOrd ? (Number(s.totalQty) || 0) / totalOrd : 0;
  var chipsHtml = (topA.k ? '<span class="kc kc-top" data-act="jump-area" data-v="' + esc(topA.k) + '" title="Lihat order area ' + esc(topA.k) + '"><i></i>Area teratas <b>' + esc(topA.k) + ' (' + topA.v + ')</b></span>' : '') +
    (topS.k ? '<span class="kc kc-top kc-del" data-act="jump-store" data-v="' + esc(topS.k) + '" title="Lihat order store ' + esc(topS.k) + '"><i></i>Store teratas <b>' + esc(topS.k) + ' (' + topS.v + ')</b></span>' : '') +
    '<span class="kc kc-wait"><i></i>Rata-rata <b>' + (Math.round(qpo * 10) / 10).toLocaleString('id-ID') + ' pcs/order</b></span>';
    var cards = [
    { l: 'Total Order', v: s.totalOrder, c: 'kpi-green', i: 'file', sub: 'Seluruh pickup order', st: '', dt: '' },
    { l: 'Ready for Pickup', v: s.readyForPickup, c: 'kpi-orange', i: 'clock', sub: 'Menunggu diambil', st: 'READY_FOR_PICKUP', dt: '' },
    { l: 'Ready for Delivery', v: s.readyForDelivery, c: 'kpi-purple', i: 'clock', sub: 'Menunggu dikirim', st: 'READY_FOR_DELIVERY', dt: '' },
    { l: 'Completed Pickup', v: s.completedPickup, c: 'kpi-blue', i: 'check', sub: 'Sudah diambil', st: 'COMPLETED_PICKUP', dt: '' },
    { l: 'Completed Delivery', v: s.completedDelivery, c: 'kpi-teal', i: 'truck', sub: 'Sudah dikirim', st: 'COMPLETED_DELIVERY', dt: '' },
    { l: 'Total Quantity', v: s.totalQty, c: 'kpi-slate', i: 'layers', sub: 'Total item order', st: '', dt: '' },
    { l: 'Total Revenue', v: s.totalRevenue || 0, c: 'kpi-gold kpi-wide', i: 'wallet', sub: 'Total pendapatan pre-order', st: '', dt: '', money: true },
    { l: 'Rata-rata Order', v: avgOrder, c: 'kpi-orange', i: 'wallet', sub: 'Revenue per order', st: '', dt: '', money: true },
    { l: 'Area Aktif', v: activeAreas, c: 'kpi-teal', i: 'map', sub: 'Area yang punya order', st: '', dt: '', act: 'area-active' },
    { l: 'Completion Rate', v: completionRate, c: 'kpi-green kpi-span', i: 'check', sub: doneOrders.toLocaleString('id-ID') + ' dari ' + Number(s.totalOrder || 0).toLocaleString('id-ID') + ' order selesai (pickup + delivery)', st: '', dt: '', pct: true }
  ];
  $('statGrid').innerHTML = cards.map(function (c) {
    return '<div class="kpi clickable ' + c.c + '" tabindex="0" role="button" title="Lihat order: ' + c.l + '" data-act="' + (c.act || 'goto-orders') + '" data-v="' + c.st + '" data-dt="' + c.dt + '"' + (c.pct ? ' style="--p:' + (Number(c.v) || 0) + '"' : '') + '><div class="kpi-icon">' + ic(c.i) + '</div><div class="kpi-label">' + c.l + '</div><div class="kpi-value">' + (c.money ? fmtCurrency(c.v) : c.pct ? String(c.v).replace('.', ',') + '%' : Number(c.v).toLocaleString('id-ID')) + '</div><div class="kpi-sub">' + c.sub + '</div>' + (c.pct ? '<div class="kpi-bar"><i style="width:' + Math.min(100, c.v) + '%"></i></div>' : '') + (c.pct ? '<div class="kpi-ring">' + ringSvg + '</div><div class="kpi-chips">' + chipsHtml + '</div>' : '') + '<span class="kpi-go">' + ic('chevRight', 'sm') + '</span></div>';
  }).join('');

  $('areaSummary').innerHTML = rankList(s.byArea, 'area');
  $('storeSummary').innerHTML = rankList(s.byStore, 'store');
  ensureDashTabs_(Object.keys(s.byArea || {}).length, Object.keys(s.byStore || {}).length);
  hideSplitForStore_();
  fitKpiValues_();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitKpiValues_);
}
/* Angka KPI otomatis mengecil agar muat di kartunya (kartu tidak dilebarkan) */
function fitKpiValues_() {
  var els = document.querySelectorAll('#statGrid .kpi-value');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    el.style.removeProperty('font-size');
    if (!el.clientWidth) continue;
    var size = parseFloat(getComputedStyle(el).fontSize), guard = 0;
    while (el.scrollWidth > el.clientWidth + 0.5 && size > 11 && guard++ < 30) { size -= 0.5; el.style.setProperty('font-size', size + 'px', 'important'); }
  }
}
window.addEventListener('resize', function () { fitKpiValues_(); });


/* ---- Notification read-state (persist per browser, per user) ---- */
function notifStoreKey_() { return 'pom_notif_read_' + (STATE.user ? STATE.user.username : ''); }
function loadNotifRead_() {
  try { STATE.notifRead = JSON.parse(localStorage.getItem(notifStoreKey_())) || {}; } catch (e) { STATE.notifRead = {}; }
}
function saveNotifRead_() {
  try { localStorage.setItem(notifStoreKey_(), JSON.stringify(STATE.notifRead)); } catch (e) {}
}
function markNotifRead_(ref) {
  if (!ref || STATE.notifRead[ref]) return;
  STATE.notifRead[ref] = true;
  saveNotifRead_();
  updateBell();
}

function notifList_() {
  return (STATE.orders || []).filter(function (o) { return isReadyStatus(o.pickupStatus); });
}

function updateBell() {
  var list = notifList_();
  var n = list.filter(function (o) { return !STATE.notifRead[o.orderReference]; }).length;
  var badge = $('bellBadge');
  badge.textContent = n > 9 ? '9+' : n;
  badge.classList.toggle('hidden', !n);
  renderNotifPopover();
}

/* ---- Notification popover ---- */
function toggleNotifPopover() {
  var pop = $('notifPopover');
  if (!pop) return;
  if (pop.classList.contains('open')) closeNotifPopover(); else openNotifPopover();
}
function openNotifPopover() {
  renderNotifPopover();
  $('notifPopover').classList.add('open');
}
function closeNotifPopover() {
  var pop = $('notifPopover');
  if (pop) pop.classList.remove('open');
}
function markAllNotifRead_() {
  notifList_().forEach(function (o) { STATE.notifRead[o.orderReference] = true; });
  saveNotifRead_();
  updateBell();
}
function renderNotifPopover() {
  var pop = $('notifPopover');
  if (!pop) return;
  var full = notifList_();
  var tab = STATE.notifTab || 'all';
  var isUnread = function (o) { return !STATE.notifRead[o.orderReference]; };
  var unreadCount = full.filter(isUnread).length;
  var nDel = full.filter(isDeliveryOrder).length, nPick = full.length - nDel;
  var filtered = full.filter(function (o) { return tab === 'all' || (tab === 'delivery' ? isDeliveryOrder(o) : !isDeliveryOrder(o)); });
  // belum dibaca tampil duluan
  filtered = filtered.map(function (o, i) { return { o: o, i: i }; }).sort(function (a, b) {
    return (isUnread(b.o) - isUnread(a.o)) || (a.i - b.i);
  }).map(function (x) { return x.o; });
  var list = filtered.slice(0, 8);

  var tabs = [['all', 'Semua', full.length], ['delivery', 'Pengiriman', nDel], ['pickup', 'Pengambilan', nPick]]
    .map(function (t) {
      return '<button type="button" class="nf-tab' + (tab === t[0] ? ' on' : '') + '" data-act="notif-tab" data-v="' + t[0] + '">' + t[1] + '<i>' + t[2] + '</i></button>';
    }).join('');

  var body;
  if (!list.length) {
    body = '<div class="nf-empty"><div class="nf-empty-ic">' + ic('check', 'lg') + '</div><b>Semua beres!</b><p>Tidak ada order yang menunggu diproses.</p></div>';
  } else {
    body = list.map(function (o) {
      var delivery = isDeliveryOrder(o);
      var unread = isUnread(o);
      var cust = String(o.customer || '').trim();
      var dt = fmtDate(o.deliveryDate);
      var meta = [];
      if (o.hamperName) meta.push('<span class="nf-chip">' + ic('package', 'sm') + esc(o.hamperName) + '</span>');
      if (o.qty !== undefined && o.qty !== '') meta.push('<span class="nf-chip">' + esc(o.qty) + ' pcs</span>');
      if (dt) meta.push('<span class="nf-chip">' + ic('orders', 'sm') + esc(dt) + '</span>');
      return '<div class="nf-item ' + (unread ? 'is-unread' : 'is-read') + ' ' + (delivery ? 'is-del' : 'is-pick') + '" data-act="notif-detail" data-v="' + esc(o.orderReference) + '" tabindex="0" role="button">' +
        '<div class="nf-ico">' + ic(delivery ? 'truck' : 'package') + '</div>' +
        '<div class="nf-main">' +
          '<div class="nf-row"><b class="nf-title">' + (delivery ? 'Menunggu Pengiriman' : 'Menunggu Pengambilan') + '</b>' + (unread ? '<span class="nf-new"></span>' : '') + '</div>' +
          '<div class="nf-sub"><span class="nf-ref">#' + esc(String(o.orderReference).replace(/^#/, '')) + '</span>' + (cust && cust !== '-' ? '<span class="nf-sep"></span><span class="nf-cust">' + esc(cust) + '</span>' : '') + '</div>' +
          (meta.length ? '<div class="nf-meta">' + meta.join('') + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  var head = '<div class="nf-head">' +
      '<div class="nf-head-top"><div class="nf-head-title"><span class="nf-head-ic">' + ic('bell') + '</span><div><b>Notifikasi</b><small>' + (unreadCount ? unreadCount + ' belum dibaca' : 'Semua sudah dibaca') + '</small></div></div>' +
      (unreadCount ? '<button type="button" class="nf-readall" data-act="notif-readall">' + ic('check', 'sm') + 'Tandai dibaca</button>' : '') + '</div>' +
      '<div class="nf-tabs">' + tabs + '</div>' +
    '</div>';
  var foot = full.length ? '<div class="nf-foot"><a data-act="notif-viewall">Lihat semua order ' + ic('chevRight', 'sm') + '</a></div>' : '';
  pop.innerHTML = head + '<div class="notif-body nf-body">' + body + '</div>' + foot;
}

/* ============== ORDERS ============== */
function loadOrders(force) {
  if (!force && STATE.orders && fresh('orders')) return;
  // Ambil semua order (sudah di-scope di server per role); filter dijalankan di client dari cache
  var fail = function (msg) {
    if (STATE.orders) { showToast(msg, 'error'); return; }
    $('ordersTableBody').innerHTML = stateRow(10, msg, 'orders');
    $('ordersCardList').innerHTML = stateBlock(msg, 'orders');
  };
  api('getOrders', [STATE.token, {}], function (res) {
    if (!res.success) { fail(res.message); return; }
    STATE.orders = res.data || []; CACHE.orders = Date.now(); cachePut_('orders', STATE.orders);
    renderOrders(); updateBell(); if (STATE.page === 'recap') renderRecap(); if (STATE.page === 'gallery') renderGallery();
  }, function () { fail('Gagal memuat order. Periksa koneksi Anda.'); });
}

function getFilters() {
  return {
    search: $('searchInput').value.trim().toLowerCase(),
    status: $('filterStatus').value, store: $('filterStore').value,
    area: $('filterArea').value, deliveryType: $('filterDeliveryType').value,
    date: $('filterDate').value
  };
}

function resetFilters(silent) {
  $('searchInput').value = ''; $('filterStatus').value = ''; $('filterStore').value = '';
  $('filterArea').value = ''; $('filterDeliveryType').value = ''; $('filterDate').value = '';
  STATE.pageNo = 1;
  if (silent !== true) renderOrders();
}

function filteredOrders() {
  var f = getFilters();
  return (STATE.orders || []).filter(function (o) {
    if (f.status === 'READY') { if (!isReadyStatus(o.pickupStatus)) return false; } else if (f.status && o.pickupStatus !== f.status) return false;
    if (f.area && (f.area === '__NONE__' ? !!o.area : o.area !== f.area)) return false;
    if (f.store && (f.store === '__NONE__' ? !!o.outletName : o.outletName !== f.store)) return false;
    if (f.deliveryType && o.deliveryType !== f.deliveryType) return false;
    if (f.date && String(o.deliveryDate).replace(/\//g, '-').indexOf(f.date) === -1) return false;
    if (f.search) {
      return String(o.orderReference).toLowerCase().indexOf(f.search) !== -1 ||
        String(o.customer).toLowerCase().indexOf(f.search) !== -1 ||
        String(o.phone).toLowerCase().indexOf(f.search) !== -1 ||
        String(o.hamperName || '').toLowerCase().indexOf(f.search) !== -1;
    }
    return true;
  });
}

// Admin saja: batalkan status selesai (tombol hanya muncul untuk order yang sudah selesai)
function revertBtn(o, iconOnly) {
  if (!isAdmin() || isReadyStatus(o.pickupStatus)) return '';
  if (iconOnly) return iconActionBtn({ kind: 'warn', act: 'revert', v: o.orderReference, icon: 'undo', title: 'Batalkan Status Selesai' });
  return '<button class="btn btn-block btn-warn-outline" style="margin-top:8px" data-act="revert" data-v="' + esc(o.orderReference) + '">' + ic('undo', 'sm') + ' Batalkan Status Selesai</button>';
}
function completeBtn(o, iconOnly) {
  if (!isReadyStatus(o.pickupStatus)) return '';
  var delivery = isDeliveryOrder(o);
  var label = delivery ? 'Complete Delivery' : 'Complete Pickup';
  if (iconOnly) return iconActionBtn({ kind: 'complete', act: 'complete', v: o.orderReference, icon: 'check', title: label });
  return '<button class="btn btn-block btn-primary" style="margin-top:8px" data-act="complete" data-v="' + esc(o.orderReference) + '">' + ic('check', 'sm') + ' ' + label + '</button>';
}

function renderOrders(keepScroll) {
  var tbody = $('ordersTableBody'), list = $('ordersCardList'), empty = $('ordersEmptyState'), pager = $('ordersPager');

  if (!STATE.orders) { // skeleton (hanya saat benar-benar belum ada data)
    var sk = ''; for (var i = 0; i < 6; i++) sk += '<tr><td colspan="10"><span class="sk" style="height:16px"></span></td></tr>';
    tbody.innerHTML = sk;
    list.innerHTML = '<div class="sk" style="height:112px;border-radius:16px"></div><div class="sk" style="height:112px;border-radius:16px;margin-top:8px"></div><div class="sk" style="height:112px;border-radius:16px;margin-top:8px"></div>';
    empty.classList.add('hidden'); pager.classList.add('hidden');
    return;
  }

  var all = filteredOrders();
  var pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  if (STATE.pageNo > pages) STATE.pageNo = pages;
  if (STATE.pageNo < 1) STATE.pageNo = 1;
  var start = (STATE.pageNo - 1) * PAGE_SIZE;
  var rows = all.slice(start, start + PAGE_SIZE);
  $('ordersCount').textContent = all.length + ' order';

  if (!all.length) {
    tbody.innerHTML = ''; list.innerHTML = '';
    var oq = ($('searchInput') ? $('searchInput').value.trim() : '');
    var ofl = Array.prototype.some.call(document.querySelectorAll('#ordersFilterCard select, #ordersFilterCard input[type=date]'), function (e) { return !!e.value; });
    empty.innerHTML = STATE.orders.length ? emptyBlock('search', 'Order tidak ditemukan', noResultDesc_(oq, ofl)) : emptyBlock('orders', 'Belum ada order', 'Order yang masuk akan tampil di sini.');
    empty.classList.remove('hidden'); pager.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = rows.map(function (o) {
    return '<tr>' +
      '<td><span class="mono">' + esc(o.orderReference) + '</span></td>' +
      '<td><div class="cell-main">' + esc(o.customer) + '</div><div class="cell-sub">' + esc(o.phone) + '</div></td>' +
      '<td>' + esc(o.outletName) + '</td>' +
      '<td>' + esc(o.area) + '</td>' +
      '<td class="hn" title="' + esc(o.hamperName) + '">' + esc(o.hamperName) + '</td>' +
      '<td class="nw"><span class="qty-pill">' + esc(o.qty) + '</span></td>' +
      '<td class="nw">' + typeChip(o.deliveryType) + '</td>' +
      '<td class="nw">' + (fmtDate(o.deliveryDate) ? esc(fmtDate(o.deliveryDate)) : '<span class="muted-dash">-</span>') + '</td>' +
      '<td>' + statusBadge(o.pickupStatus) + '</td>' +
      '<td><div class="row-actions">' + iconActionBtn({ kind: 'view', act: 'detail', v: o.orderReference, icon: 'eye', title: 'View Detail' }) + completeBtn(o, true) + revertBtn(o, true) + '</div></td>' +
      '</tr>';
  }).join('');

  list.innerHTML = rows.map(function (o) {
    var viewBtn = iconActionBtn({ kind: 'view', act: 'detail', v: o.orderReference, icon: 'eye', title: 'View Detail' });
    function cell(l, v, wide) { return '<div class="oc-cell' + (wide ? ' oc-wide' : '') + '"><small>' + l + '</small><b>' + esc(v == null || v === '' ? '-' : v) + '</b></div>'; }
    return '<div class="order-card oc-compact">' +
      '<div class="order-card-top"><span class="mono">' + esc(o.orderReference) + '</span>' + statusBadge(o.pickupStatus) + '</div>' +
      '<div class="oc-title"><h4>' + esc(o.customer) + '</h4><div class="oc-actions">' + viewBtn + completeBtn(o, true) + revertBtn(o, true) + '</div></div>' +
      '<div class="oc-grid">' + cell('Store', o.outletName, true) + cell('Hampers', o.hamperName, true) +
      cell('Tipe', o.deliveryType) + cell('Qty', o.qty) + cell('Tgl Kirim', fmtDate(o.deliveryDate)) + '</div>' +
      '</div>';
  }).join('');

  pager.classList.toggle('hidden', all.length <= 25 && PAGE_SIZE === 25);
  $('orderPageSize').value = String(PAGE_SIZE);
  $('pagerInfo').textContent = (start + 1) + '–' + (start + rows.length) + ' / ' + all.length;
  $('orderPages').innerHTML = pagerNumsHtml_(STATE.pageNo, pages);
  $('prevPageBtn').disabled = STATE.pageNo <= 1;
  $('nextPageBtn').disabled = STATE.pageNo >= pages;
  if (keepScroll === true) window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ============== ORDER DETAIL (modal, tanpa request) ============== */
function dfield(label, val, html) {
  var v = html ? val : esc(val === '' || val == null ? '-' : val);
  return '<div class="dfield"><div class="dlabel">' + label + '</div><div class="dvalue">' + v + '</div></div>';
}

function findOrder(ref) {
  return (STATE.orders || []).filter(function (o) { return String(o.orderReference) === String(ref); })[0];
}

function openOrderDetail(ref) {
  var o = findOrder(ref);
  if (!o) { showToast('Order tidak ditemukan.', 'error'); return; }
  renderOrderDetail(o);
  openModal('modalOrderDetail');
}

function dsub(label, val, html) {
  var v = html ? val : esc(val === '' || val == null ? '-' : val);
  return '<div class="dcell"><div class="dlabel">' + label + '</div><div class="dvalue">' + v + '</div></div>';
}
function renderOrderDetail(o) {
  var done = !isReadyStatus(o.pickupStatus), delivery = isDeliveryOrder(o);
  var typeIcon = delivery ? 'truck' : 'package';
  var s1 = delivery ? 'Siap Dikirim' : 'Siap Diambil', s2 = delivery ? 'Terkirim' : 'Terambil';
  $('orderDetailBody').innerHTML =
    '<div class="od-hero"><div class="detail-ico">' + ic('file', 'lg') + '</div>' +
    '<div class="od-hero-main"><div class="od-ref">' + esc(o.orderReference) + '</div>' +
    '<div class="od-meta">' + esc(o.customer || '-') + ' &middot; ' + esc(o.outletName || '-') + '</div></div>' +
    statusBadge(o.pickupStatus) + '</div>' +

    '<div class="od-steps ' + (done ? 'is-done' : 'is-ready') + '">' +
      '<div class="od-step on"><span>' + ic('check', 'sm') + '</span><b>Order Masuk</b></div><i class="od-line on"></i>' +
      '<div class="od-step on"><span>' + ic(typeIcon, 'sm') + '</span><b>' + s1 + '</b></div><i class="od-line ' + (done ? 'on' : '') + '"></i>' +
      '<div class="od-step ' + (done ? 'on' : '') + '"><span>' + ic('check', 'sm') + '</span><b>' + s2 + '</b></div>' +
    '</div>' +

    '<div class="od-stats">' +
      '<div class="od-stat"><small>Qty</small><b>' + esc(o.qty) + '</b></div>' +
      '<div class="od-stat"><small>Revenue</small><b>' + esc(fmtCurrency(o.revenue)) + '</b></div>' +
      '<div class="od-stat"><small>Tgl Kirim</small><b>' + esc(fmtDate(o.deliveryDate) || '-') + '</b></div>' +
    '</div>' +

    '<div class="od-grid">' +
      '<div class="od-box"><div class="od-box-title">' + ic('users', 'sm') + ' Customer</div>' +
        dsub('Nama', o.customer) + dsub('Phone', o.phone) + '</div>' +
      '<div class="od-box"><div class="od-box-title">' + ic('store', 'sm') + ' Lokasi</div>' +
        dsub('Store', o.outletName) + dsub('Area', o.area) + '</div>' +
      '<div class="od-box od-full"><div class="od-box-title">' + ic('package', 'sm') + ' Pesanan</div>' +
        dsub('Hampers', o.hamperName) + '<div class="od-two">' + dsub('Tipe', o.deliveryType) + dsub('Order Number', o.orderReference) + '</div></div>' +
      proofBoxHtml_(o) +
      '<div class="od-box od-full od-log"><div class="od-box-title">' + ic('clock', 'sm') + ' Riwayat Update</div>' +
        '<div id="odTimeline" class="od-tl"><div class="od-tl-empty">Memuat riwayat...</div></div></div>' +
    '</div>';
  loadOrderTimeline_(o);

  var f = $('orderDetailFooter');
  if (isReadyStatus(o.pickupStatus)) {
    var lbl = isDeliveryOrder(o) ? 'Complete Delivery' : 'Complete Pickup';
    f.innerHTML = '<button class="btn btn-secondary" data-close>Close</button><button class="btn btn-primary" id="markCompleteBtn">' + ic('check', 'sm') + ' ' + lbl + '</button>';
    f.querySelector('[data-close]').addEventListener('click', function () { closeModal('modalOrderDetail'); });
    $('markCompleteBtn').addEventListener('click', function () { askComplete(o); });
  } else {
    var undoHtml = isAdmin() ? '<button class="btn btn-warn-outline btn-revert" id="detailRevertBtn" style="margin-right:auto">' + ic('undo', 'sm') + '<span>Batalkan Status</span></button>' : '<span class="hint" style="margin-right:auto;align-self:center">Order sudah selesai diproses.</span>';
    f.innerHTML = undoHtml + '<button class="btn btn-secondary" data-close>Close</button>';
    f.querySelector('[data-close]').addEventListener('click', function () { closeModal('modalOrderDetail'); });
    if ($('detailRevertBtn')) $('detailRevertBtn').addEventListener('click', function () { askRevert(o); });
  }
}

/* Riwayat status (dari Pickup_Log): dari status apa ke apa, oleh siapa, kapan, alasan */
function loadOrderTimeline_(o) {
  var ref = o.orderReference;
  api('getAuditLog', [STATE.token, ref], function (res) {
    var box = $('odTimeline');
    if (!box) return;
    var rows = (res && res.success && res.data) || [];
    if (!rows.length) { box.innerHTML = '<div class="od-tl-empty">Belum ada riwayat perubahan status.</div>'; return; }
    if (!o.updatedBy && rows[0].updatedBy) {
      o.updatedBy = rows[0].updatedBy;
      var c = $('odUpBy'); if (c) c.innerHTML = dsub('Updated By', o.updatedBy);
    }
    box.innerHTML = rows.map(function (r) {
      var rev = /^REVERT/.test(r.notes || '');
      var parts = String(r.notes || '').split(' | '), reason = '', extra = [];
      parts.forEach(function (p) {
        if (/^Alasan:/.test(p)) reason = p.replace(/^Alasan:\s*/, '');
        else if (/^(Tgl Kirim sebelumnya|Diselesaikan oleh|Bukti sebelumnya):/.test(p)) extra.push(p);
      });
      if (!rev && r.notes) reason = r.notes;
      return '<div class="od-tl-item ' + (rev ? 'is-rev' : 'is-ok') + '"><span class="od-tl-dot">' + ic(rev ? 'undo' : 'check', 'sm') + '</span>' +
        '<div class="od-tl-body"><div class="od-tl-top"><b>' + (rev ? 'Status dibatalkan' : 'Order diselesaikan') + '</b><small>' + esc(fmtDate(r.updatedAt)) + '</small></div>' +
        '<div class="od-tl-flow">' + statusBadge(r.previousStatus) + '<span class="od-tl-arrow">&rarr;</span>' + statusBadge(r.newStatus) + '</div>' +
        '<div class="od-tl-by">oleh <b>' + esc(r.updatedBy || '-') + '</b></div>' +
        (reason ? '<div class="od-tl-note">' + (rev ? 'Alasan: ' : '') + esc(reason) + '</div>' : '') +
        (extra.length ? '<div class="od-tl-extra">' + esc(extra.join(' · ')) + '</div>' : '') + '</div></div>';
    }).join('');
  }, function () { var b = $('odTimeline'); if (b) b.innerHTML = '<div class="od-tl-empty">Gagal memuat riwayat.</div>'; });
}

/* ============== BUKTI SERAH TERIMA (saat Selesaikan order) ============== */
var PROOF = { ref: null, delivery: false, mode: 'photo', photo: '', busy: false };
function proofThumb_(url, sz) {
  var m = String(url || '').match(/\/d\/([\w-]+)/);
  return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w' + (sz || 800) : '';
}
function askComplete(o) {
  var delivery = isDeliveryOrder(o);
  PROOF = { o: o, ref: o.orderReference, delivery: delivery, mode: delivery ? 'resi' : 'photo', photo: '', busy: false };
  $('proofTitle').textContent = delivery ? 'Bukti Penerimaan' : 'Bukti Pengambilan';
  $('proofSub').textContent = delivery ? 'Isi nomor resi atau lampirkan foto pesanan' : 'Lampirkan foto pesanan yang diambil customer';
  $('proofOrder').innerHTML = '<div class="pf-oref">' + ic(delivery ? 'truck' : 'package', 'sm') + '<b>' + esc(o.orderReference) + '</b>' + typeChip(o.deliveryType) + '</div>' +
    '<div class="pf-ometa">' + esc(o.customer || '-') + ' &middot; ' + esc(o.hamperName || '-') + ' &middot; ' + esc(o.qty) + ' pcs</div>';
  $('proofTabs').classList.toggle('hidden', !delivery);
  $('proofResi').value = '';
  $('proofCam').value = ''; $('proofGal').value = '';
  setProofPhoto_('');
  $('proofSubmitBtn').innerHTML = ic('check', 'sm') + ' ' + (delivery ? 'Complete Delivery' : 'Complete Pickup');
  setProofMode_(PROOF.mode);
  openModal('modalProof');
}
function setProofMode_(m) {
  if (m !== 'resi' && m !== 'photo') return;
  if (m === 'resi' && !PROOF.delivery) m = 'photo';
  PROOF.mode = m;
  Array.prototype.forEach.call(document.querySelectorAll('#proofTabs button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === m); });
  $('proofResiBox').classList.toggle('hidden', m !== 'resi');
  $('proofPhotoBox').classList.toggle('hidden', m !== 'photo');
  syncProofBtn_();
  if (m === 'resi') setTimeout(function () { try { $('proofResi').focus(); } catch (e) {} }, 200);
}
function setProofPhoto_(dataUrl, meta) {
  PROOF.photo = dataUrl || '';
  $('proofPrev').classList.toggle('hidden', !dataUrl);
  $('proofDrop').classList.toggle('hidden', !!dataUrl);
  if (dataUrl) { $('proofImg').src = dataUrl; $('proofMeta').textContent = meta || ''; } else $('proofImg').removeAttribute('src');
  syncProofBtn_();
}
function syncProofBtn_() {
  var ok = PROOF.mode === 'resi' ? $('proofResi').value.trim().length >= 4 : !!PROOF.photo;
  $('proofSubmitBtn').disabled = !ok || PROOF.busy;
}
// Kecilkan foto (maks 1280px, JPEG) agar upload cepat & hemat kuota
function shrinkImage_(file, cb) {
  var rd = new FileReader();
  rd.onerror = function () { cb('Foto tidak dapat dibaca. Coba lagi.'); };
  rd.onload = function () {
    var img = new Image();
    img.onerror = function () { cb('Format foto tidak didukung. Gunakan foto JPG/PNG.'); };
    img.onload = function () {
      try {
        var max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * sc)); cv.height = Math.max(1, Math.round(img.height * sc));
        var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
        cb(null, cv.toDataURL('image/jpeg', 0.72));
      } catch (e) { cb('Gagal memproses foto.'); }
    };
    img.src = rd.result;
  };
  rd.readAsDataURL(file);
}
function handleProofFile_(file) {
  if (!file) return;
  if (!/^image\//.test(file.type || '')) { showToast('File harus berupa gambar.', 'warning'); return; }
  PROOF.busy = true; syncProofBtn_();
  shrinkImage_(file, function (err, dataUrl) {
    PROOF.busy = false;
    if (err) { showToast(err, 'error'); syncProofBtn_(); return; }
    setProofPhoto_(dataUrl, 'Ukuran ' + Math.round(dataUrl.length * 0.75 / 1024) + ' KB');
  });
}
function submitProof_() {
  var proof;
  if (PROOF.mode === 'resi') {
    var resi = $('proofResi').value.trim().replace(/\s+/g, ' ').toUpperCase();
    if (resi.length < 4) { showToast('Nomor resi minimal 4 karakter.', 'warning'); return; }
    proof = { type: 'RESI', resi: resi };
  } else {
    if (!PROOF.photo) { showToast('Foto bukti wajib dilampirkan.', 'warning'); return; }
    proof = { type: 'PHOTO', photo: PROOF.photo };
  }
  var ref = PROOF.ref;
  closeModal('modalProof');
  completeOrder(ref, proof);
}
function copyText_(text, okMsg) {
  var done = function () { showToast(okMsg || 'Disalin', 'success'); };
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { copyFallback_(text, done); }); return; }
  copyFallback_(text, done);
}
function copyFallback_(text, done) {
  var t = document.createElement('textarea'); t.value = text; t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(t); t.select();
  try { document.execCommand('copy'); done(); } catch (e) { showToast('Gagal menyalin.', 'error'); }
  t.remove();
}
function openProofPhoto_(ref) {
  var o = findOrder(ref); if (!o || !o.proofValue) return;
  var img = $('photoViewImg'), err = $('photoViewErr');
  err.classList.add('hidden'); img.classList.remove('hidden');
  img.onerror = function () { img.classList.add('hidden'); err.classList.remove('hidden'); };
  img.src = proofThumb_(o.proofValue, 1600) || o.proofValue;
  $('photoViewOpen').href = o.proofValue;
  openModal('modalPhoto');
}
function proofBoxHtml_(o) {
  if (isReadyStatus(o.pickupStatus)) return '';
  var delivery = isDeliveryOrder(o), t = o.proofType, v = o.proofValue, body;
  if (t === 'RESI' && v) {
    body = '<div class="pf-resi"><div><small>Nomor Resi</small><b class="mono">' + esc(v) + '</b></div>' +
      '<button type="button" class="btn btn-sm btn-secondary" data-act="copy-resi" data-v="' + esc(v) + '">' + ic('copy', 'sm') + ' Salin</button></div>';
  } else if (t === 'PHOTO' && v) {
    var th = proofThumb_(v, 600);
    body = '<button type="button" class="pf-thumb" data-act="proof-view" data-v="' + esc(o.orderReference) + '" title="Lihat foto">' +
      (th ? '<img src="' + esc(th) + '" alt="Foto bukti" loading="lazy" onerror="this.parentNode.classList.add(\'is-err\')">' : '') +
      '<span class="pf-thumb-ph">' + ic('image', 'lg') + '<em>Lihat foto bukti</em></span></button>';
  } else {
    body = '<div class="od-tl-empty">Tidak ada bukti (order diselesaikan sebelum fitur bukti tersedia).</div>';
  }
  return '<div class="od-box od-full"><div class="od-box-title">' + ic('camera', 'sm') + ' ' + (delivery ? 'Bukti Penerimaan' : 'Bukti Pengambilan') + '</div>' + body + '</div>';
}

function completeOrder(ref, proof) {
  runAction({
    processing: proof && proof.type === 'PHOTO' ? 'Mengunggah foto & memproses...' : 'Memproses order...',
    call: 'updateOrderStatus', args: [STATE.token, ref, '', proof],
    okMsg: 'Order berhasil diselesaikan',
    errMsg: 'Gagal memperbarui order.',
    onOk: function (res) {
      // Update cache lokal -> list & dashboard langsung berubah (tanpa reload)
      var o = findOrder(ref);
      var prev = o ? o.pickupStatus : 'READY_FOR_PICKUP';
      var ns = res.data.newStatus;
      if (o) { o.pickupStatus = ns; o.updatedAt = nowStamp(); o.deliveryDate = nowStamp().slice(0, 10).replace(/-/g, '/'); o.updatedBy = STATE.user.name || STATE.user.username; o.proofType = res.data.proofType || ''; o.proofValue = res.data.proofValue || ''; }
      if (STATE.stats) {
        if (prev === 'READY_FOR_PICKUP') STATE.stats.readyForPickup = Math.max(0, STATE.stats.readyForPickup - 1);
        if (prev === 'READY_FOR_DELIVERY') STATE.stats.readyForDelivery = Math.max(0, STATE.stats.readyForDelivery - 1);
        if (ns === 'COMPLETED_PICKUP') STATE.stats.completedPickup++;
        if (ns === 'COMPLETED_DELIVERY') STATE.stats.completedDelivery++;
      }
      renderOrders(); renderDashboard_safe(); updateBell(); if (STATE.page === 'recap') renderRecap();
    },
    after: function () {
      closeAllModals();
      loadOrders(true); loadDashboard(true); // sinkronisasi diam-diam dengan server
    }
  });
}

/* ============== REKAP PER HAMPER (daftar yang harus disiapkan) ============== */
var RECAP = { group: 'store', data: null };
function recapDot_() {
  var n = 0; if ($('recapSearch').value.trim()) n++; if ($('recapStatus').value !== 'ready') n++; if ($('recapType').value) n++;
  var d = $('recapDot'); d.textContent = n; d.classList.toggle('hidden', n === 0);
}
/* Kamera langsung (getUserMedia); fallback ke input capture bila tidak diizinkan */
var CAM = { stream: null, facing: 'environment', blob: null, torch: false };
var CAM_STAMP = true; // cetak kode order + waktu di foto sebagai tanda bukti (set false untuk mematikan)
function camPad_(n) { return (n < 10 ? '0' : '') + n; }
function camNow_() {
  var d = new Date(), M = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return d.getDate() + ' ' + M[d.getMonth()] + ' ' + d.getFullYear() + ' \u00b7 ' + camPad_(d.getHours()) + ':' + camPad_(d.getMinutes()) + ':' + camPad_(d.getSeconds());
}
function camHint_(txt, ready) { $('camHintTx').textContent = txt; $('camHint').classList.toggle('ready', !!ready); }
function openCamera_() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $('proofCam').click(); return; }
  var o = (PROOF && PROOF.o) || {};
  $('camRef').textContent = o.orderReference || PROOF.ref || '-';
  $('camMeta').textContent = [o.customer, o.hamperName, o.qty ? o.qty + ' pcs' : ''].filter(Boolean).join(' \u00b7 ') || 'Bukti serah terima';
  var t = $('camType'); t.textContent = PROOF.delivery ? 'Delivery' : 'Pickup'; t.classList.toggle('dl', !!PROOF.delivery);
  $('camReview').classList.add('hidden'); CAM.blob = null;
  $('camShot').disabled = true; camHint_('Memuat kamera...', false);
  $('camOv').classList.remove('hidden');
  startCamera_();
}
function stopCamStream_() { if (CAM.stream) { CAM.stream.getTracks().forEach(function (t) { t.stop(); }); CAM.stream = null; } CAM.torch = false; }
function startCamera_() {
  stopCamStream_();
  $('camShot').disabled = true; camHint_('Memuat kamera...', false);
  $('camTorch').classList.add('hidden'); $('camTorch').setAttribute('aria-pressed', 'false');
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: CAM.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false })
    .then(function (s) {
      CAM.stream = s; var v = $('camVideo'); v.srcObject = s;
      v.classList.toggle('mirror', CAM.facing === 'user');
      var p = v.play(); if (p && p.catch) p.catch(function () {});
      try {
        var tr = s.getVideoTracks()[0], cp = tr.getCapabilities ? tr.getCapabilities() : {};
        if (cp.focusMode && cp.focusMode.indexOf('continuous') > -1) tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
        if (cp.torch) $('camTorch').classList.remove('hidden');
      } catch (e) {}
      var ready = function () { $('camShot').disabled = false; camHint_('Posisikan pesanan di dalam bingkai', true); };
      if (v.readyState >= 2) setTimeout(ready, 350); else v.onloadeddata = function () { setTimeout(ready, 350); };
    })
    .catch(function () { closeCamera_(); $('proofCam').click(); });
}
function closeCamera_() { stopCamStream_(); $('camVideo').srcObject = null; camRetake_(); $('camOv').classList.add('hidden'); }
function camStamp_(ctx, w, h) {
  var o = (PROOF && PROOF.o) || {}, fs = Math.max(14, Math.round(w * 0.022)), pad = Math.round(fs * 0.8), bh = Math.round(fs * 2.35 + pad * 2);
  ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, h - bh, w, bh);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  ctx.font = '700 ' + fs + 'px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  ctx.fillText((o.orderReference || PROOF.ref || '') + (o.customer ? '  \u00b7  ' + o.customer : ''), pad, h - bh + pad);
  ctx.font = '500 ' + Math.round(fs * 0.9) + 'px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,.85)';
  ctx.fillText(camNow_() + (PROOF.delivery ? '  \u00b7  Delivery' : '  \u00b7  Pickup'), pad, h - bh + pad + fs * 1.4);
}
function snapCamera_() {
  var v = $('camVideo'); if (!v.videoWidth || $('camShot').disabled) return;
  var fl = $('camFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
  if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) {} }
  var c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  var ctx = c.getContext('2d'); ctx.drawImage(v, 0, 0);
  if (CAM_STAMP) camStamp_(ctx, c.width, c.height);
  c.toBlob(function (b) {
    if (!b) return;
    CAM.blob = b;
    $('camRevImg').src = URL.createObjectURL(b);
    $('camReview').classList.remove('hidden');
  }, 'image/jpeg', 0.92);
}
function camUse_() {
  var b = CAM.blob; if (!b) return;
  closeCamera_();
  var f; try { f = new File([b], 'bukti.jpg', { type: 'image/jpeg' }); } catch (e) { f = b; f.name = 'bukti.jpg'; }
  handleProofFile_(f);
}
function camRetake_() {
  var i = $('camRevImg'); if (i.src && i.src.indexOf('blob:') === 0) URL.revokeObjectURL(i.src);
  i.removeAttribute('src'); CAM.blob = null; $('camReview').classList.add('hidden');
}
function camTorch_() {
  if (!CAM.stream) return;
  CAM.torch = !CAM.torch;
  try { CAM.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: CAM.torch }] }).catch(function () { CAM.torch = false; }); } catch (e) { CAM.torch = false; }
  $('camTorch').setAttribute('aria-pressed', CAM.torch ? 'true' : 'false');
}
function bindProofRecap_() {
  $('proofResi').addEventListener('input', syncProofBtn_);
  $('proofResi').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !$('proofSubmitBtn').disabled) submitProof_(); });
  $('proofCam').addEventListener('change', function () { handleProofFile_(this.files && this.files[0]); });
  $('proofGal').addEventListener('change', function () { handleProofFile_(this.files && this.files[0]); });
  $('recapSearch').addEventListener('input', debounce(renderRecap, 150));
  ['recapStatus', 'recapType'].forEach(function (id) { $(id).addEventListener('change', function () { renderRecap(); recapDot_(); }); });
  $('recapSearch').addEventListener('input', recapDot_);
  $('recapToggleBtn').addEventListener('click', function () {
    var open = $('recapFilterCard').classList.toggle('filters-open');
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  $('recapResetBtn').addEventListener('click', function () {
    $('recapSearch').value = ''; $('recapStatus').value = 'ready'; $('recapType').value = '';
    recapDot_(); renderRecap();
  });
  $('camClose').addEventListener('click', closeCamera_);
  $('camFlip').addEventListener('click', function () { CAM.facing = CAM.facing === 'environment' ? 'user' : 'environment'; startCamera_(); });
  $('camShot').addEventListener('click', snapCamera_);
  $('camUse').addEventListener('click', camUse_);
  $('camRetake').addEventListener('click', camRetake_);
  $('camTorch').addEventListener('click', camTorch_);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('camOv').classList.contains('hidden')) closeCamera_(); });
}
function recapCompute_() {
  var st = $('recapStatus').value, tp = $('recapType').value, q = $('recapSearch').value.trim().toLowerCase();
  var byArea = RECAP.group === 'area';
  var rows = (STATE.orders || []).filter(function (o) {
    if (st === 'ready' && !isReadyStatus(o.pickupStatus)) return false;
    if (tp && (tp === 'Delivery') !== isDeliveryOrder(o)) return false;
    if (q && [o.hamperName, o.outletName, o.area].join(' ').toLowerCase().indexOf(q) === -1) return false;
    return true;
  });
  var groups = {}, all = { name: 'Total Keseluruhan', total: 0, orders: 0, hampers: {}, isAll: true }, stores = {};
  function add(g, qty, hn) {
    g.total += qty; g.orders++;
    var h = g.hampers[hn] || (g.hampers[hn] = { name: hn, qty: 0, orders: 0 }); h.qty += qty; h.orders++;
  }
  rows.forEach(function (o) {
    var qty = Number(o.qty) || 0, hn = String(o.hamperName || '').trim() || '(Tanpa nama hampers)';
    var key = byArea ? (o.area || '') : (o.outletName || '');
    var g = groups[key] || (groups[key] = { name: key || (byArea ? 'Tanpa Area' : 'Tanpa Store'), key: key, total: 0, orders: 0, hampers: {}, stores: {} });
    add(g, qty, hn); add(all, qty, hn);
    if (o.outletName) { g.stores[o.outletName] = 1; stores[o.outletName] = 1; }
  });
  var nat = function (a, b) { return String(a).localeCompare(String(b), 'id', { numeric: true, sensitivity: 'base' }); };
  var list = Object.keys(groups).map(function (k) { return groups[k]; }).sort(function (a, b) { return nat(a.name, b.name); });
  [all].concat(list).forEach(function (g) { g.list = Object.keys(g.hampers).map(function (k) { return g.hampers[k]; }).sort(function (a, b) { return nat(a.name, b.name); }); });
  return { groups: list, all: all, orders: rows.length, storeCount: Object.keys(stores).length, byArea: byArea, ready: st === 'ready' };
}
function renderRecap() {
  var box = $('recapList'); if (!box) return;
  Array.prototype.forEach.call(document.querySelectorAll('#recapGroup button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === RECAP.group); });
  if (!STATE.orders) {
    $('recapSummary').innerHTML = '';
    box.innerHTML = '<div class="sk" style="height:120px;border-radius:16px"></div><div class="sk" style="height:120px;border-radius:16px;margin-top:10px"></div>';
    return;
  }
  var d = RECAP.data = recapCompute_();
  $('recapCopyBtn').disabled = !d.orders;
  if (!d.orders) {
    $('recapSummary').innerHTML = '';
    box.innerHTML = '<div class="card">' + (d.ready ? emptyBlock('check', 'Tidak ada order yang perlu disiapkan', 'Semua order pada tanggal ini sudah siap atau belum ada yang masuk.') : emptyBlock('search', 'Order tidak ditemukan', 'Coba ubah tanggal atau filter store / area.')) + '</div>';
    return;
  }
  var tile = function (v, l) { return '<div class="rc-tile"><b>' + Number(v).toLocaleString('id-ID') + '</b><span>' + l + '</span></div>'; };
  $('recapSummary').innerHTML = tile(d.all.total, 'Total pcs') + tile(d.all.list.length, 'Jenis hampers') + tile(d.orders, 'Order') + tile(d.byArea ? d.groups.length : d.storeCount, d.byArea ? 'Area' : 'Store');
  var baseF = { status: d.ready ? 'READY' : '', deliveryType: $('recapType').value };
  function go(extra) { return esc(JSON.stringify(Object.assign({}, baseF, extra))); }
  function card(g, cls) {
    var gf = {};
    if (!g.isAll) { if (d.byArea) gf.area = g.key || '__NONE__'; else gf.store = g.key || '__NONE__'; }
    var head = ' data-act="recap-go" data-v="' + go(gf) + '" title="Lihat ' + g.orders + ' order di menu Orders" tabindex="0" role="button"';
    var sub = (d.byArea && !g.isAll) ? Object.keys(g.stores).length + ' store &middot; ' : '';
    return '<div class="rc-card ' + (cls || '') + '"><div class="rc-head clickable"' + head + '>' +
      '<div class="rc-gname">' + ic(g.isAll ? 'layers' : (d.byArea ? 'map' : 'store'), 'sm') + '<span>' + esc(g.name) + '</span></div>' +
      '<div class="rc-gmeta"><b>' + g.total.toLocaleString('id-ID') + ' pcs</b><span>' + sub + g.orders + ' order</span></div>' + ic('chevRight', 'sm') + '</div>' +
      '<div class="rc-body">' + g.list.map(function (h) {
        var hf = Object.assign({}, gf, { search: h.name === '(Tanpa nama hampers)' ? '' : h.name });
        return '<div class="rc-row clickable" data-act="recap-go" data-v="' + go(hf) + '" tabindex="0" role="button" title="Lihat order hampers ini"><span class="rc-hn">' + esc(h.name) + '</span><span class="rc-ord">' + h.orders + ' order</span><b class="rc-qty">' + h.qty.toLocaleString('id-ID') + '<small>pcs</small></b></div>';
      }).join('') + '</div></div>';
  }
  box.innerHTML = (d.groups.length > 1 ? card(d.all, 'rc-total') : '') + d.groups.map(function (g) { return card(g); }).join('');
}
function copyRecap_() {
  var d = RECAP.data; if (!d || !d.orders) { showToast('Tidak ada data untuk disalin.', 'warning'); return; }
  var p = function (x) { return ('0' + x).slice(-2); }, n = new Date();
  var out = ['*REKAP HAMPERS - ' + (d.byArea ? 'PER AREA' : 'PER STORE') + (d.ready ? ' (PERLU DISIAPKAN)' : '') + '*',
    p(n.getDate()) + '-' + p(n.getMonth() + 1) + '-' + n.getFullYear() + ' ' + p(n.getHours()) + ':' + p(n.getMinutes()), ''];
  d.groups.forEach(function (g) {
    out.push('*' + g.name + '* (' + g.total + ' pcs)');
    g.list.forEach(function (h) { out.push('- ' + h.name + ': ' + h.qty + ' pcs'); });
    out.push('');
  });
  out.push('*TOTAL: ' + d.all.total + ' pcs*');
  copyText_(out.join('\n'), 'Rekap disalin');
}
/* ============== BATALKAN STATUS SELESAI (ADMIN) ============== */
var REVERT_REF = null;
function statusLabel_(s) { return String(s || '').toLowerCase().split('_').map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' '); }
function askRevert(o) {
  if (!isAdmin()) { showToast('Hanya Admin yang dapat membatalkan status.', 'warning'); return; }
  REVERT_REF = o.orderReference;
  var target = isDeliveryOrder(o) ? 'Ready for Delivery' : 'Ready for Pickup';
  $('revertMsg').innerHTML = 'Order <b>' + esc(o.orderReference) + '</b> (' + esc(o.customer || '-') + ') akan dikembalikan dari <b>' + esc(statusLabel_(o.pickupStatus)) + '</b> ke <b>' + target + '</b>.<br><small>Tgl Kirim dikosongkan, riwayat tetap tercatat.</small>';
  $('revertReason').value = '';
  $('revertErr').classList.add('hidden');
  syncRevertBtn();
  openModal('modalRevert');
  setTimeout(function () { try { $('revertReason').focus(); } catch (e) {} }, 250);
}
// Tombol 'Kembalikan Status' nonaktif selama alasan belum diisi
function syncRevertBtn() {
  var ok = $('revertReason').value.trim().length >= 3;
  $('revertSubmitBtn').disabled = !ok;
}
document.addEventListener('input', function (e) { if (e.target && e.target.id === 'revertReason') syncRevertBtn(); });
function submitRevert() {
  var reason = $('revertReason').value.trim();
  if (reason.length < 3) { syncRevertBtn(); return; }
  var ref = REVERT_REF;
  closeModal('modalRevert');
  runAction({
    processing: 'Membatalkan status...',
    call: 'revertOrderStatus', args: [STATE.token, ref, reason],
    okMsg: 'Status order dikembalikan',
    errMsg: 'Gagal membatalkan status order.',
    onOk: function (res) {
      var o = findOrder(ref);
      var prev = o ? o.pickupStatus : '';
      var ns = res.data.newStatus;
      if (o) { o.proofType = ''; o.proofValue = ''; o.pickupStatus = ns; o.deliveryDate = ''; o.updatedBy = STATE.user.name || STATE.user.username; o.updatedAt = nowStamp(); }
      if (STATE.stats) {
        if (prev === 'COMPLETED_PICKUP') STATE.stats.completedPickup = Math.max(0, STATE.stats.completedPickup - 1);
        if (prev === 'COMPLETED_DELIVERY') STATE.stats.completedDelivery = Math.max(0, STATE.stats.completedDelivery - 1);
        if (ns === 'READY_FOR_PICKUP') STATE.stats.readyForPickup++;
        if (ns === 'READY_FOR_DELIVERY') STATE.stats.readyForDelivery++;
      }
      renderOrders(); renderDashboard_safe(); updateBell();
    },
    after: function () { closeAllModals(); loadOrders(true); loadDashboard(true); }
  });
}
function renderDashboard_safe() { if (STATE.stats) renderDashboard(); }

/* ============== USERS ============== */
function lookupSkel_(kind, n) {
  var cols = kind === 'stores'
    ? [['Store ID', 52, 14], ['Nama Store', 70, 16], ['Area', 44, 14], ['Status', 44, 22, '999px']]
    : [['Area ID', 52, 14], ['Nama Area', 66, 16], ['Status', 44, 22, '999px']];
  var s = '';
  for (var i = 0; i < n; i++) {
    s += '<tr class="sk-row">' + cols.map(function (c) {
      var w = Math.max(30, c[1] - (i % 3) * 8);
      return '<td data-label="' + c[0] + '"><span class="sk" style="height:' + c[2] + 'px;width:' + w + '%;' + (c[3] ? 'border-radius:' + c[3] + ';' : '') + '"></span></td>';
    }).join('') + '<td data-label="Aksi"><span class="sk-acts"><i class="sk"></i><i class="sk"></i></span></td></tr>';
  }
  return s;
}
function usersSkel_(n) {
  var w = [62, 78, 54, 70, 66], s = '';
  var b = function (lbl, wd, h, r) { return '<td data-label="' + lbl + '"><span class="sk" style="height:' + (h || 14) + 'px;width:' + wd + '%;' + (r ? 'border-radius:' + r + ';' : '') + '"></span></td>'; };
  for (var i = 0; i < n; i++) {
    var k = w[i % w.length];
    s += '<tr class="sk-row">' + b('Nama', k, 16) + b('Username', 80 - (i % 3) * 8, 14) + b('Role', 46, 22, '999px') + b('Store', 58 + (i % 2) * 14, 14) + b('Area', 40, 14) + b('Status', 44, 22, '999px') +
      '<td data-label="Aksi"><span class="sk-acts"><i class="sk"></i><i class="sk"></i><i class="sk"></i></span></td></tr>';
  }
  return s;
}
function loadUsers(force) {
  if (STATE.users) renderUsers(); else $('usersTableBody').innerHTML = usersSkel_(5);
  if (!STATE.lookup || !fresh('lookup')) loadLookup(false);
  if (!force && STATE.users && fresh('users')) return;
  var fail = function (msg) {
    if (STATE.users) { showToast(msg, 'error'); return; }
    $('usersTableBody').innerHTML = stateRow(7, msg, 'users'); // loading selalu berhenti, tampil error + retry
  };
  api('getUsers', [STATE.token], function (res) {
    if (!res.success) { fail(res.message); return; }
    STATE.users = res.data || []; CACHE.users = Date.now();
    renderUsers();
  }, function () { fail('Gagal memuat data user. Periksa koneksi Anda.'); });
}

/* ---- Kolom Store di tabel User: ringkas 1 baris, klik "+N" untuk lihat semua ---- */
function ensureStoreCellCss_() {
  if (document.getElementById('storeCellCss')) return;
  var st = document.createElement('style'); st.id = 'storeCellCss';
  st.textContent = `.store-cell .sc{display:flex;align-items:center;gap:6px;min-width:0;}
.store-cell .sc-short{flex-wrap:nowrap;}
.store-cell .sc-full{display:none;flex-wrap:wrap;}
.store-cell.open .sc-short{display:none;}
.store-cell.open .sc-full{display:flex;}
.store-cell .st-chip{display:inline-flex;align-items:center;font-size:12px;font-weight:600;line-height:1.2;padding:4px 10px;border-radius:999px;background:#eef6f1;color:#1b4a35;box-shadow:inset 0 0 0 1px #dbe9e1;white-space:nowrap;}
.store-cell .st-first{max-width:190px;overflow:hidden;text-overflow:ellipsis;display:inline-block;}
.store-cell .st-more{cursor:pointer;border:0;font-family:inherit;background:var(--primary);color:#fff;box-shadow:none;transition:filter .15s,transform .15s;}
.store-cell .st-more:hover{filter:brightness(1.12);transform:translateY(-1px);}
.store-cell .st-close{background:#fdecec;color:#c53030;box-shadow:inset 0 0 0 1px #f8caca;}
body.dark .store-cell .st-chip{background:#162a22;color:#cfe6da;box-shadow:inset 0 0 0 1px #2a4337;}
body.dark .store-cell .st-more{background:#1e9d68;color:#fff;box-shadow:none;}
body.dark .store-cell .st-close{background:#3a1a1a;color:#ff9a9a;box-shadow:inset 0 0 0 1px #5a2a2a;}`;
  document.head.appendChild(st);
}
function storeCellHtml_(id) {
  var ids = String(id || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!ids.length) return '-';
  var names = ids.map(function (sid) {
    var s = STATE.lookup ? STATE.lookup.stores.filter(function (x) { return x.storeId === sid; })[0] : null;
    return s ? s.storeName : sid;
  });
  if (names.length === 1) return esc(names[0]);
  var rest = names.length - 1;
  return '<div class="sc sc-short" title="' + esc(names.join(', ')) + '"><span class="st-chip st-first">' + esc(names[0]) + '</span>' +
    '<button type="button" class="st-chip st-more" data-act="user-stores" data-v="' + esc(ids.join(',')) + '" aria-label="Lihat semua store">+' + rest + ' store</button></div>';
}

function storeNameById(id) {
  if (!id) return '-';
  var ids = String(id).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!ids.length) return '-';
  var names = ids.map(function (sid) {
    var s = STATE.lookup ? STATE.lookup.stores.filter(function (x) { return x.storeId === sid; })[0] : null;
    return s ? s.storeName : sid;
  });
  return names.join(', ') || '-';
}
/* Area user: pakai AreaID user bila ada, jika kosong ambil dari area store yang dimiliki user */
function userAreaText_(u) {
  if (u.areaId) return areaNameById(u.areaId);
  var ids = String(u.storeId || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  var seen = {}, names = [];
  ids.forEach(function (sid) {
    var s = STATE.lookup ? STATE.lookup.stores.filter(function (x) { return x.storeId === sid; })[0] : null;
    if (s && s.areaId && !seen[s.areaId]) { seen[s.areaId] = 1; names.push(areaNameById(s.areaId)); }
  });
  return names.length ? names.join(', ') : '-';
}

function areaNameById(id) {
  var a = STATE.lookup ? STATE.lookup.areas.filter(function (x) { return x.areaId === id; })[0] : null;
  return a ? a.areaName : (id || '-');
}

/* ---- Modal daftar store milik Manager ---- */
function openUserStores_(idsStr, tr) {
  var ids = String(idsStr || '').split(',').filter(Boolean);
  var lk = (STATE.lookup && STATE.lookup.stores) || [], areas = (STATE.lookup && STATE.lookup.areas) || [];
  var items = ids.map(function (sid) {
    var s = lk.filter(function (x) { return x.storeId === sid; })[0];
    var ar = s ? areas.filter(function (a) { return a.areaId === s.areaId; })[0] : null;
    return { id: sid, name: s ? s.storeName : sid, area: ar ? ar.areaName : 'Tanpa Area', on: !s || s.status === 'ACTIVE' };
  });
  var cell = function (l) { var td = tr && tr.querySelector('td[data-label="' + l + '"]'); return td ? td.textContent.trim() : ''; };
  var uname = cell('Nama'), uuser = cell('Username'), urole = cell('Role');
  var groups = {}, order = [];
  items.forEach(function (it) { if (!groups[it.area]) { groups[it.area] = []; order.push(it.area); } groups[it.area].push(it); });
  order.sort(function (a, b) { return groups[b].length - groups[a].length || a.localeCompare(b); });
  var nActive = items.filter(function (i) { return i.on; }).length;
  var initials = (uname || '?').split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0); }).join('').toUpperCase();

  $('userStoresTitle').textContent = 'Store yang Dikelola';
  $('userStoresSub').textContent = 'Daftar store dalam akses akun ini';
  $('userStoresBody').innerHTML =
    '<div class="us-profile"><div class="us-avatar">' + esc(initials) + '</div>' +
      '<div class="us-pinfo"><div class="us-pname">' + esc(uname || '-') + (urole ? ' <em>' + esc(urole) + '</em>' : '') + '</div>' +
      '<div class="us-puser">' + esc(uuser) + '</div></div>' +
      '<div class="us-stats"><div><b>' + items.length + '</b><span>Store</span></div><div><b>' + order.length + '</b><span>Area</span></div><div><b>' + nActive + '</b><span>Aktif</span></div></div></div>' +
    order.map(function (a) {
      return '<div class="us-group">' + (order.length > 1 ? '<div class="us-head"><span>' + esc(a) + '</span></div>' : '') + '<div class="us-grid">' +
        groups[a].sort(function (x, y) { return x.name.localeCompare(y.name); }).map(function (it) {
          return '<div class="us-item" data-n="' + esc(it.name.toLowerCase()) + '"><i>' + ic('store', 'sm') + '</i>' +
            '<div class="us-txt"><span class="us-name">' + esc(it.name) + '</span><span class="us-sub">' + esc(it.id) + (order.length > 1 ? '' : ' · ' + esc(a)) + '</span></div>' +
            '<span class="us-dot' + (it.on ? '' : ' off') + '" title="' + (it.on ? 'Aktif' : 'Nonaktif') + '"></span></div>';
        }).join('') + '</div></div>';
    }).join('');
  var q = $('userStoresSearch'); q.value = '';
  q.oninput = function () {
    var v = q.value.trim().toLowerCase(), any = false;
    document.querySelectorAll('#userStoresBody .us-group').forEach(function (g) {
      var vis = 0;
      g.querySelectorAll('.us-item').forEach(function (it) { var ok = !v || it.getAttribute('data-n').indexOf(v) !== -1; it.style.display = ok ? '' : 'none'; if (ok) vis++; });
      g.style.display = vis ? '' : 'none'; if (vis) any = true;
    });
    $('userStoresEmpty').classList.toggle('hidden', any);
  };
  $('userStoresEmpty').classList.add('hidden');
  openModal('modalUserStores');
}

function pagerNumsHtml_(cur, pages) {
  var last = 0, out = '';
  for (var p = 1; p <= pages; p++) {
    if (!(p === 1 || p === pages || Math.abs(p - cur) <= 1)) continue;
    out += (last && p - last > 1 ? '<span class="pager2-gap">…</span>' : '') +
      '<button type="button" class="pager2-num' + (p === cur ? ' active' : '') + '" data-pg="' + p + '"' + (p === cur ? ' aria-current="page"' : '') + '>' + p + '</button>';
    last = p;
  }
  return out;
}
function scrollUsersTop_() {
  var el = $('usersCount'); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderUsersPager_(total, start, shown, pages) {
  var pg = $('usersPager');
  // Pager tetap tampil agar pilihan jumlah data bisa diubah, kecuali data sangat sedikit
  pg.classList.toggle('hidden', total <= 25 && USER_PAGE.size === 25);
  $('userPageSize').value = String(USER_PAGE.size);
  $('usersPagerInfo').textContent = (start + 1) + '–' + (start + shown) + ' / ' + total;
  $('userPrevBtn').disabled = USER_PAGE.no <= 1;
  $('userNextBtn').disabled = USER_PAGE.no >= pages;
  $('userPages').innerHTML = pagerNumsHtml_(USER_PAGE.no, pages);
}

function renderUsers() {
  if (!STATE.users) return;
  if (!STATE.users.length) { $('usersTableBody').innerHTML = emptyRow(7, 'users', 'Belum ada user', 'Klik "Tambah User" untuk membuat akun admin atau store user pertama.'); if ($('usersCount')) $('usersCount').textContent = '0 user'; return; }
  var uq = $('userSearchInput').value.trim().toLowerCase(), ur = $('userFilterRole').value, us = $('userFilterStatus').value;
  var list = STATE.users.map(function (u, i) { u.__idx = i; return u; }).filter(function (u) {
    var role = u.role === 'STORE_USER' ? 'STORE' : u.role;
    if (uq && String(u.name).toLowerCase().indexOf(uq) === -1 && String(u.username).toLowerCase().indexOf(uq) === -1) return false;
    if (ur && role !== ur) return false;
    if (us && u.status !== us) return false;
    return true;
  });
  if ($('usersCount')) $('usersCount').textContent = list.length + ' user';
  if (!list.length) { $('usersTableBody').innerHTML = emptyRow(7, 'search', 'User tidak ditemukan', noResultDesc_($('userSearchInput').value.trim(), !!(ur || us))); $('usersPager').classList.add('hidden'); return; }
  var total = list.length, pages = Math.max(1, Math.ceil(total / USER_PAGE.size));
  if (USER_PAGE.no > pages) USER_PAGE.no = pages;
  if (USER_PAGE.no < 1) USER_PAGE.no = 1;
  var uStart = (USER_PAGE.no - 1) * USER_PAGE.size;
  list = list.slice(uStart, uStart + USER_PAGE.size);
  renderUsersPager_(total, uStart, list.length, pages);
  ensureStoreCellCss_();
  $('usersTableBody').innerHTML = list.map(function (u) {
    var i = u.__idx;
    var on = u.status === 'ACTIVE';
    return '<tr><td data-label="Nama"><span class="cell-main">' + esc(u.name) + '</span></td>' +
      '<td data-label="Username">' + esc(u.username) + '</td>' +
      '<td data-label="Role">' + roleChip(u.role) + '</td>' +
      '<td data-label="Store" class="store-cell">' + (u.role === 'ADMIN' ? 'All Store' : storeCellHtml_(u.storeId)) + '</td>' +
      '<td data-label="Area">' + esc(u.role === 'ADMIN' ? 'All Area' : userAreaText_(u)) + '</td>' +
      '<td data-label="Status">' + activeBadge(u.status) + '</td>' +
      '<td data-label="Aksi"><div class="row-actions">' +
      iconActionBtn({ kind: 'view', act: 'edit-user', v: i, icon: 'edit', title: 'Edit' }) +
      iconActionBtn({ kind: on ? 'warn' : 'view', act: 'toggle-user', v: i, icon: on ? 'xcircle' : 'check', title: on ? 'Nonaktifkan' : 'Aktifkan' }) +
      iconActionBtn({ kind: 'danger', act: 'delete-user', v: i, icon: 'trash', title: 'Delete' }) +
      '</div></td></tr>';
  }).join('');
}

/* Tombol Simpan disable selama kolom wajib belum lengkap */
function validateUserForm_() {
  var btn = $('saveUserBtn'); if (!btn) return;
  var isEdit = !!$('userFormId').value, role = $('userFormRole').value;
  var ok = !!$('userFormName').value.trim() && !!$('userFormUsername').value.trim();
  if (!isEdit && !$('userFormPassword').value) ok = false;
  if (role === 'STORE' && !$('userFormStore').value) ok = false;
  if (role === 'MANAGER' && !$('userFormStoresList').querySelector('.store-check:checked')) ok = false;
  btn.disabled = !ok;
  btn.title = ok ? '' : 'Lengkapi semua kolom wajib terlebih dahulu';
}

function toggleUserStoreField() {
  var role = $('userFormRole').value;
  $('userFormStoreWrap').style.display = role === 'STORE' ? 'block' : 'none';
  $('userFormStoresWrap').classList.toggle('hidden', role !== 'MANAGER');
  validateUserForm_();
}

/* ---- Manager: checklist store dikelompokkan per Area ---- */
function renderManagerStoreList_(stores, selectedIds) {
  var areas = (STATE.lookup && STATE.lookup.areas) || [];
  var groups = [], byArea = {};
  areas.forEach(function (a) { var g = { id: a.areaId, name: a.areaName, stores: [] }; byArea[a.areaId] = g; groups.push(g); });
  stores.forEach(function (s) {
    var g = byArea[s.areaId];
    if (!g) { g = byArea[s.areaId || '_none'] = byArea[s.areaId || '_none'] || { id: s.areaId || '_none', name: 'Tanpa Area', stores: [] }; if (groups.indexOf(g) === -1) groups.push(g); }
    g.stores.push(s);
  });
  groups = groups.filter(function (g) { return g.stores.length; });
  var html = groups.map(function (g) {
    return '<div class="area-group" data-area="' + esc(g.id) + '">' +
      '<label class="area-head"><input type="checkbox" class="area-check" data-area="' + esc(g.id) + '"> <span class="area-name">' + esc(g.name) + '</span><span class="area-count"></span></label>' +
      g.stores.map(function (s) {
        var checked = selectedIds.indexOf(s.storeId) !== -1 ? ' checked' : '';
        return '<label class="checklist-item"><input type="checkbox" class="store-check" data-area="' + esc(g.id) + '" value="' + esc(s.storeId) + '"' + checked + '><span>' + esc(s.storeName) + '</span></label>';
      }).join('') + '</div>';
  }).join('') || '<div class="store-pick-hint" style="padding:8px">Belum ada store.</div>';
  var box = $('userFormStoresList');
  box.innerHTML = html;
  box.onchange = function (e) {
    var t = e.target;
    if (t.classList.contains('area-check')) {
      Array.prototype.forEach.call(box.querySelectorAll('.store-check[data-area="' + t.getAttribute('data-area') + '"]'), function (c) { c.checked = t.checked; });
    }
    syncManagerAreaState_();
  };
  syncManagerAreaState_();
}

function syncManagerAreaState_() {
  var box = $('userFormStoresList'), total = 0, picked = 0;
  Array.prototype.forEach.call(box.querySelectorAll('.area-group'), function (g) {
    var cs = g.querySelectorAll('.store-check'), n = 0;
    Array.prototype.forEach.call(cs, function (c) { if (c.checked) n++; });
    var ac = g.querySelector('.area-check');
    ac.checked = cs.length > 0 && n === cs.length;
    ac.indeterminate = n > 0 && n < cs.length;
    g.querySelector('.area-count').textContent = n + '/' + cs.length;
    total += cs.length; picked += n;
  });
  var sum = $('userFormStoresSum');
  if (sum) sum.textContent = picked + ' dari ' + total + ' store dipilih';
  validateUserForm_(); // dipanggil SETELAH checkbox store disinkronkan
}

function openUserForm(user) {
  $('userFormId').value = user ? user.userId : '';
  $('userFormName').value = user ? user.name : '';
  $('userFormUsername').value = user ? user.username : '';
  $('userFormUsername').disabled = !!user;
  $('userFormPassword').value = '';
  $('userFormPassHint').textContent = user ? '(opsional)' : '';
  $('userFormPassword').placeholder = user ? 'Kosongkan jika tidak diubah' : 'Masukkan password';
  var role = user ? (user.role === 'STORE_USER' ? 'STORE' : user.role) : 'STORE';
  $('userFormRole').value = role;
  $('userFormStatus').value = user ? user.status : 'ACTIVE';
  $('userFormTitle').textContent = user ? 'Edit User' : 'Tambah User';
  var stores = STATE.lookup ? STATE.lookup.stores : [];
  var sel = $('userFormStore');
  sel.innerHTML = stores.map(function (s) {
    return '<option value="' + esc(s.storeId) + '">' + esc(s.storeName) + '</option>';
  }).join('');
  if (user && user.storeId) sel.value = user.storeId.split(',')[0];

  var myIds = (user && user.storeId ? user.storeId.split(',').map(function (x) { return x.trim(); }) : []);
  renderManagerStoreList_(stores, myIds);

  toggleUserStoreField();
  openModal('modalUserForm');
}

function saveUser() {
  var id = $('userFormId').value, role = $('userFormRole').value;
  var storeId = '';
  if (role === 'STORE') storeId = $('userFormStore').value;
  else if (role === 'MANAGER') {
    storeId = Array.prototype.slice.call($('userFormStoresList').querySelectorAll('.store-check:checked')).map(function (c) { return c.value; }).join(',');
  }
  var payload = {
    name: $('userFormName').value.trim(),
    username: $('userFormUsername').value.trim(),
    password: $('userFormPassword').value,
    role: role,
    storeId: storeId,
    status: $('userFormStatus').value
  };
  if (!payload.name || !payload.username) { showToast('Nama dan username wajib diisi.', 'warning'); return; }
  if (!id && !payload.password) { showToast('Password wajib diisi untuk user baru.', 'warning'); return; }
  if (role === 'STORE' && !payload.storeId) { showToast('Store wajib dipilih untuk role Store.', 'warning'); return; }
  if (role === 'MANAGER' && !payload.storeId) { showToast('Minimal 1 store wajib dipilih untuk role Manager.', 'warning'); return; }
  openConfirm(id ? 'Simpan Perubahan User?' : 'Tambah User Baru?',
    'Data user <b>' + esc(payload.name) + '</b> (' + esc(payload.username) + ') akan disimpan.', 'Ya, Simpan',
    function () {
      runAction({
        processing: id ? 'Menyimpan perubahan user...' : 'Menambahkan user...',
        call: id ? 'updateUser' : 'createUser', args: id ? [STATE.token, id, payload] : [STATE.token, payload],
        okMsg: id ? 'User berhasil diperbarui' : 'User berhasil ditambahkan',
        errMsg: 'Gagal menyimpan user.',
        onOk: function () { closeModal('modalUserForm'); loadUsers(true); }
      });
    });
}

function toggleUserStatus(u) {
  if (!u) return;
  var ns = u.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
  openConfirm(ns === 'INACTIVE' ? 'Nonaktifkan User?' : 'Aktifkan User?',
    'User <b>' + esc(u.name) + '</b> akan ' + (ns === 'INACTIVE' ? 'dinonaktifkan dan tidak dapat login.' : 'diaktifkan kembali.'),
    ns === 'INACTIVE' ? 'Ya, Nonaktifkan' : 'Ya, Aktifkan',
    function () {
      runAction({
        processing: 'Memperbarui status user...',
        call: 'updateUser', args: [STATE.token, u.userId, { status: ns }],
        okMsg: 'Status user diperbarui', errMsg: 'Gagal memperbarui user.',
        onOk: function () { u.status = ns; renderUsers(); loadUsers(true); }
      });
    });
}

function askDeleteUser(u) {
  if (!u) return;
  openConfirm('Hapus User?',
    'Data user <b>' + esc(u.name) + '</b> (' + esc(u.username) + ') akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.',
    'Ya, Hapus',
    function () {
      runAction({
        processing: 'Menghapus user...',
        call: 'deleteUser', args: [STATE.token, u.userId],
        okMsg: 'User berhasil dihapus', errMsg: 'Gagal menghapus user.',
        onOk: function () { loadUsers(true); }
      });
    }, 'xcircle');
}

/* ============== STORES & AREAS ============== */
function populateStoreFilterArea() {
  var sel = $('storeFilterArea'); if (!sel || !STATE.lookup) return;
  var cur = sel.value;
  sel.innerHTML = '<option value="">Semua Area</option>' + STATE.lookup.areas.map(function (a) {
    return '<option value="' + esc(a.areaId) + '">' + esc(a.areaName) + '</option>';
  }).join('');
  sel.value = cur;
}

function filteredStores() {
  var st = STATE.lookup ? STATE.lookup.stores : [];
  var q = ($('storeSearchInput') ? $('storeSearchInput').value.trim().toLowerCase() : '');
  var area = $('storeFilterArea') ? $('storeFilterArea').value : '';
  var status = $('storeFilterStatus') ? $('storeFilterStatus').value : '';
  return st.filter(function (s, i) { s.__idx = i; return true; }).filter(function (s) {
    if (q && String(s.storeName).toLowerCase().indexOf(q) === -1 && String(s.storeId).toLowerCase().indexOf(q) === -1) return false;
    if (area && s.areaId !== area) return false;
    if (status && s.status !== status) return false;
    return true;
  });
}

function resetStoreFilters() {
  if ($('storeSearchInput')) $('storeSearchInput').value = '';
  if ($('storeFilterArea')) $('storeFilterArea').value = '';
  if ($('storeFilterStatus')) $('storeFilterStatus').value = '';
  renderAdminLists();
}

function renderAdminLists() {
  if (!STATE.lookup || !isAdmin()) return;
  populateStoreFilterArea();
  var st = filteredStores(), ar = STATE.lookup.areas;
  if ($('storesCount')) $('storesCount').textContent = st.length + ' store';
  $('storesTableBody').innerHTML = !st.length ? (STATE.lookup.stores.length ? emptyRow(5, 'search', 'Store tidak ditemukan', noResultDesc_($('storeSearchInput') ? $('storeSearchInput').value.trim() : '', !!(($('storeFilterArea') && $('storeFilterArea').value) || ($('storeFilterStatus') && $('storeFilterStatus').value)))) : emptyRow(5, 'store', 'Belum ada store', 'Klik "Tambah Store" untuk menambahkan store pertama.')) : st.map(function (s) {
    var i = s.__idx;
    return '<tr><td data-label="Store ID"><span class="mono">' + esc(s.storeId) + '</span></td>' +
      '<td data-label="Nama Store"><span class="cell-main">' + esc(s.storeName) + '</span></td>' +
      '<td data-label="Area">' + esc(areaNameById(s.areaId)) + '</td>' +
      '<td data-label="Status">' + activeBadge(s.status) + '</td>' +
      '<td data-label="Aksi"><div class="row-actions">' +
      iconActionBtn({ kind: 'view', act: 'edit-store', v: i, icon: 'edit', title: 'Edit' }) +
      iconActionBtn({ kind: 'danger', act: 'delete-store', v: i, icon: 'trash', title: 'Delete' }) +
      '</div></td></tr>';
  }).join('');
  $('areasTableBody').innerHTML = !ar.length ? emptyRow(4, 'map', 'Belum ada area', 'Klik "Tambah Area" untuk membuat area pengiriman pertama.') : ar.map(function (a, i) {
    return '<tr><td data-label="Area ID"><span class="mono">' + esc(a.areaId) + '</span></td>' +
      '<td data-label="Nama Area"><span class="cell-main">' + esc(a.areaName) + '</span></td>' +
      '<td data-label="Status">' + activeBadge(a.status) + '</td>' +
      '<td data-label="Aksi"><div class="row-actions">' +
      iconActionBtn({ kind: 'view', act: 'edit-area', v: i, icon: 'edit', title: 'Edit' }) +
      iconActionBtn({ kind: 'danger', act: 'delete-area', v: i, icon: 'trash', title: 'Delete' }) +
      '</div></td></tr>';
  }).join('');
}

function openStoreForm(s) {
  if (!STATE.lookup) { showToast('Data area belum termuat, coba lagi sebentar.', 'warning'); return; }
  $('storeFormId').value = s ? s.storeId : '';
  $('storeFormName').value = s ? s.storeName : '';
  $('storeFormStatus').value = s ? s.status : 'ACTIVE';
  $('storeFormTitle').textContent = s ? 'Edit Store' : 'Tambah Store';
  var sel = $('storeFormArea');
  sel.innerHTML = STATE.lookup.areas.map(function (a) { return '<option value="' + esc(a.areaId) + '">' + esc(a.areaName) + '</option>'; }).join('');
  if (s) sel.value = s.areaId;
  openModal('modalStoreForm');
}

function saveStore() {
  var id = $('storeFormId').value;
  var payload = { storeName: $('storeFormName').value.trim(), areaId: $('storeFormArea').value, status: $('storeFormStatus').value };
  if (!payload.storeName || !payload.areaId) { showToast('Nama store dan area wajib diisi.', 'warning'); return; }
  openConfirm(id ? 'Simpan Perubahan Store?' : 'Tambah Store Baru?',
    'Store <b>' + esc(payload.storeName) + '</b> akan disimpan.', 'Ya, Simpan',
    function () {
      runAction({
        processing: id ? 'Menyimpan perubahan store...' : 'Menambahkan store...',
        call: id ? 'updateStore' : 'createStore', args: id ? [STATE.token, id, payload] : [STATE.token, payload],
        okMsg: id ? 'Store berhasil diperbarui' : 'Store berhasil ditambahkan',
        errMsg: 'Gagal menyimpan store.',
        onOk: function () { closeModal('modalStoreForm'); loadLookup(true); }
      });
    });
}

function askDeleteStore(s) {
  if (!s) return;
  openConfirm('Hapus Store?',
    'Store <b>' + esc(s.storeName) + '</b> akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.',
    'Ya, Hapus',
    function () {
      runAction({
        processing: 'Menghapus store...',
        call: 'deleteStore', args: [STATE.token, s.storeId],
        okMsg: 'Store berhasil dihapus', errMsg: 'Gagal menghapus store.',
        onOk: function () { loadLookup(true); }
      });
    }, 'xcircle');
}

function askDeleteArea(a) {
  if (!a) return;
  openConfirm('Hapus Area?',
    'Area <b>' + esc(a.areaName) + '</b> akan dihapus permanen. Tindakan ini tidak dapat dibatalkan.',
    'Ya, Hapus',
    function () {
      runAction({
        processing: 'Menghapus area...',
        call: 'deleteArea', args: [STATE.token, a.areaId],
        okMsg: 'Area berhasil dihapus', errMsg: 'Gagal menghapus area.',
        onOk: function () { loadLookup(true); }
      });
    }, 'xcircle');
}

function openAreaForm(a) {
  $('areaFormId').value = a ? a.areaId : '';
  $('areaFormName').value = a ? a.areaName : '';
  $('areaFormStatus').value = a ? a.status : 'ACTIVE';
  $('areaFormTitle').textContent = a ? 'Edit Area' : 'Tambah Area';
  openModal('modalAreaForm');
}

function saveArea() {
  var id = $('areaFormId').value;
  var payload = { areaName: $('areaFormName').value.trim(), status: $('areaFormStatus').value };
  if (!payload.areaName) { showToast('Nama area wajib diisi.', 'warning'); return; }
  openConfirm(id ? 'Simpan Perubahan Area?' : 'Tambah Area Baru?',
    'Area <b>' + esc(payload.areaName) + '</b> akan disimpan.', 'Ya, Simpan',
    function () {
      runAction({
        processing: id ? 'Menyimpan perubahan area...' : 'Menambahkan area...',
        call: id ? 'updateArea' : 'createArea', args: id ? [STATE.token, id, payload] : [STATE.token, payload],
        okMsg: id ? 'Area berhasil diperbarui' : 'Area berhasil ditambahkan',
        errMsg: 'Gagal menyimpan area.',
        onOk: function () { closeModal('modalAreaForm'); loadLookup(true); }
      });
    });
}

/* ============== EXPORT EXCEL (sesuai filter yang sedang aktif) ============== */
function exportOrdersExcel() {
  var rows = filteredOrders();
  if (!rows.length) { showToast('Tidak ada data untuk diekspor', 'error'); return; }
  if (typeof ExcelJS === 'undefined') { showToast('Library Excel belum termuat. Periksa koneksi internet lalu coba lagi.', 'error'); return; }
  var btn = $('exportOrdersBtn'); btn.disabled = true; btn.classList.add('is-busy');
  var p2 = function (n) { return ('0' + n).slice(-2); };
  var now = new Date();
  var stamp = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
  var stampFull = p2(now.getDate()) + '-' + p2(now.getMonth() + 1) + '-' + now.getFullYear() + ' ' + p2(now.getHours()) + ':' + p2(now.getMinutes());
  var f = getFilters();
  var fl = [];
  if (f.status) fl.push('Status: ' + statusLabel_(f.status));
  if (f.store) fl.push('Store: ' + (f.store === '__NONE__' ? '(Tanpa Store)' : f.store));
  if (f.area) fl.push('Area: ' + (f.area === '__NONE__' ? '(Tanpa Area)' : f.area));
  if (f.deliveryType) fl.push('Tipe: ' + f.deliveryType);
  if (f.date) fl.push('Tgl Kirim: ' + fmtDate(f.date));
  if (f.search) fl.push('Pencarian: "' + f.search + '"');
  var filterText = fl.length ? fl.join('  |  ') : 'Semua data (tanpa filter)';
  var totQty = 0, totRev = 0;
  rows.forEach(function (o) { totQty += Number(o.qty) || 0; totRev += Number(o.revenue) || 0; });

  var wb = new ExcelJS.Workbook();
  wb.creator = 'Agrinesia Pickup Order'; wb.created = now;
  var ws = wb.addWorksheet('Pickup Orders', { views: [{ state: 'frozen', ySplit: 6, xSplit: 2 }], pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 } });
  var cols = [
    { h: 'No', w: 6, a: 'center' }, { h: 'Order Number', w: 17, a: 'left' }, { h: 'Customer', w: 22, a: 'left' },
    { h: 'Phone', w: 16, a: 'left' }, { h: 'Store', w: 26, a: 'left' }, { h: 'Area', w: 15, a: 'left' },
    { h: 'Hampers', w: 36, a: 'left' }, { h: 'Tipe', w: 11, a: 'center' }, { h: 'Qty', w: 8, a: 'center' },
    { h: 'Revenue (Rp)', w: 16, a: 'right' }, { h: 'Tgl Kirim', w: 13, a: 'center' }, { h: 'Status', w: 20, a: 'center' },
    { h: 'Diupdate Oleh', w: 17, a: 'left' }, { h: 'Diupdate Pada', w: 19, a: 'center' }, { h: 'Bukti Serah Terima', w: 36, a: 'left' }
  ];
  var N = cols.length;
  ws.columns = cols.map(function (c) { return { width: c.w }; });
  var GREEN = 'FF0A6B47', LIGHT = 'FFE6F4EC', LINE = 'FFD5E3DB';
  var thin = { style: 'thin', color: { argb: LINE } };
  var box = { top: thin, left: thin, bottom: thin, right: thin };
  function banner(r, text, font, fill, h) {
    ws.mergeCells(r, 1, r, N);
    var c = ws.getCell(r, 1); c.value = text; c.font = font;
    c.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
    if (fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    ws.getRow(r).height = h;
  }
  banner(1, 'LAPORAN PICKUP ORDER  -  AGRINESIA', { name: 'Calibri', size: 16, bold: true, color: { argb: 'FFFFFFFF' } }, GREEN, 32);
  banner(2, 'Diekspor: ' + stampFull + '   |   Oleh: ' + ((STATE.user && (STATE.user.name || STATE.user.username)) || '-') + ' (' + ((STATE.user && STATE.user.role) || '-') + ')', { name: 'Calibri', size: 10.5, color: { argb: 'FF3B5247' } }, LIGHT, 20);
  banner(3, 'Filter: ' + filterText, { name: 'Calibri', size: 10.5, italic: true, color: { argb: 'FF3B5247' } }, LIGHT, 20);
  banner(4, 'Ringkasan: ' + rows.length + ' order   |   Total Qty: ' + totQty.toLocaleString('id-ID') + '   |   Total Revenue: ' + fmtCurrency(totRev), { name: 'Calibri', size: 11, bold: true, color: { argb: GREEN } }, LIGHT, 22);
  ws.getRow(5).height = 8;

  var hr = ws.getRow(6); hr.height = 28;
  cols.forEach(function (c, i) {
    var cell = hr.getCell(i + 1); cell.value = c.h;
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    cell.alignment = { vertical: 'middle', horizontal: c.a === 'right' ? 'right' : 'center', wrapText: true };
    cell.border = box;
  });
  var stColor = { READY_FOR_PICKUP: ['FFFEF3C7', 'FF92400E'], READY_FOR_DELIVERY: ['FFEDE9FE', 'FF5B21B6'], COMPLETED_PICKUP: ['FFDBEAFE', 'FF1E40AF'], COMPLETED_DELIVERY: ['FFCCFBF1', 'FF0F766E'] };
  rows.forEach(function (o, i) {
    var r = ws.getRow(7 + i); r.height = 21;
    var vals = [i + 1, o.orderReference || '-', o.customer || '-', String(o.phone || '-'), o.outletName || '-', o.area || '-', o.hamperName || '-', o.deliveryType || '-',
      Number(o.qty) || 0, Number(o.revenue) || 0, fmtDate(o.deliveryDate) || '-', statusLabel_(o.pickupStatus), o.updatedBy || '-', fmtDate(o.updatedAt) || '-',
      o.proofType === 'RESI' ? 'Resi: ' + o.proofValue : (o.proofType === 'PHOTO' ? o.proofValue : '-')];
    vals.forEach(function (v, j) {
      var cell = r.getCell(j + 1); cell.value = v; cell.border = box;
      cell.font = { name: 'Calibri', size: 10.5, color: { argb: 'FF1B2B23' } };
      cell.alignment = { vertical: 'middle', horizontal: cols[j].a, indent: cols[j].a === 'center' ? 0 : 1, wrapText: j === 6 };
      if (i % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF6FAF8' } };
      if (j === 3) cell.numFmt = '@';
      if (j === 9) cell.numFmt = '#,##0';
      if (j === 8) cell.numFmt = '#,##0';
    });
    var sc = stColor[o.pickupStatus];
    if (sc) { var s = r.getCell(12); s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sc[0] } }; s.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: sc[1] } }; }
  });
  var tr = ws.getRow(7 + rows.length); tr.height = 24;
  for (var k = 1; k <= N; k++) {
    var tc = tr.getCell(k); tc.border = { top: { style: 'medium', color: { argb: GREEN } }, bottom: thin, left: thin, right: thin };
    tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
    tc.font = { name: 'Calibri', size: 11, bold: true, color: { argb: GREEN } };
    tc.alignment = { vertical: 'middle', horizontal: 'center' };
  }
  ws.mergeCells(7 + rows.length, 1, 7 + rows.length, 8);
  var lab = tr.getCell(1); lab.value = 'TOTAL'; lab.alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
  tr.getCell(9).value = totQty; tr.getCell(9).numFmt = '#,##0';
  tr.getCell(10).value = totRev; tr.getCell(10).numFmt = '#,##0'; tr.getCell(10).alignment = { vertical: 'middle', horizontal: 'right', indent: 1 };
  ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: N } };
  ws.headerFooter.oddFooter = '&LAgrinesia Pickup Order&RHalaman &P / &N';

  function slug(s) { return String(s).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  var parts = ['Pickup-Order'];
  if (f.status) parts.push(slug(statusLabel_(f.status)));
  if (f.store && f.store !== '__NONE__') parts.push(slug(f.store));
  else if (!isAdmin() && STATE.user && STATE.user.storeName) parts.push(slug(STATE.user.storeName));
  if (f.area && f.area !== '__NONE__') parts.push(slug(f.area));
  if (f.deliveryType) parts.push(slug(f.deliveryType));
  parts.push(stamp + '_' + p2(now.getHours()) + p2(now.getMinutes()));
  var fname = parts.join('_').slice(0, 120) + '.xlsx';

  wb.xlsx.writeBuffer().then(function (buf) {
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    showToast('Export berhasil: ' + rows.length + ' order', 'success');
  }).catch(function () { showToast('Gagal membuat file Excel', 'error'); })
    .then(function () { btn.disabled = false; btn.classList.remove('is-busy'); });
}
/* ============== GALERI BUKTI SERAH TERIMA ============== */
var GL = { list: [], shown: 30, idx: -1, built: false };
function glId_(u) { var m = String(u || '').match(/\/d\/([\w-]+)/) || String(u || '').match(/[?&]id=([\w-]+)/); return m ? m[1] : ''; }
function glThumb_(it, w) { return 'https://drive.google.com/thumbnail?id=' + it.fid + '&sz=w' + w; }
function glRef_(o) { return '#' + String(o.orderReference || '').replace(/^#+/, ''); }
function glDateKey_(o) { return String(o.deliveryDate || '').replace(/\//g, '-'); }
function bindGallery_() {
  if (!$('glSearch')) return;
  $('glSearch').addEventListener('input', debounce(function () { GL.shown = 30; renderGallery(); }, 150));
  ['glStore', 'glArea', 'glType', 'glDate'].forEach(function (id) { $(id).addEventListener('change', function () { GL.shown = 30; renderGallery(); }); });
  $('glDate').addEventListener('input', function () { $('glDateWrap').classList.toggle('empty', !this.value); });
  $('glToggleBtn').addEventListener('click', function () {
    var o = $('glFilterCard').classList.toggle('filters-open'); this.setAttribute('aria-expanded', o ? 'true' : 'false');
  });
  $('glReset').addEventListener('click', function () {
    $('glSearch').value = ''; ['glStore', 'glArea', 'glType', 'glDate'].forEach(function (id) { $(id).value = ''; });
    $('glDateWrap').classList.add('empty'); GL.shown = 30; renderGallery();
  });
  $('glMoreBtn').addEventListener('click', function () { GL.shown += 30; renderGallery(); });
  $('glGrid').addEventListener('click', function (e) {
    var c = e.target.closest('[data-gi]'); if (c) glOpen_(+c.getAttribute('data-gi'));
  });
  $('glGrid').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var c = e.target.closest('[data-gi]'); if (c) { e.preventDefault(); glOpen_(+c.getAttribute('data-gi')); }
  });
  Array.prototype.forEach.call(document.querySelectorAll('[data-glclose]'), function (b) { b.addEventListener('click', glClose_); });
  $('glLbFail').addEventListener('click', function (e) {
    var b = e.target.closest('[data-glcopy]'); if (!b) return;
    copyText_(b.getAttribute('data-glcopy'), 'Nomor resi disalin');
    b.classList.add('done'); b.innerHTML = ic('check', 'sm') + ' Tersalin';
    setTimeout(function () { b.classList.remove('done'); b.innerHTML = ic('copy', 'sm') + ' Salin Resi'; }, 1600);
  });
  $('glPrev').addEventListener('click', function () { glStep_(-1); });
  $('glNext').addEventListener('click', function () { glStep_(1); });
  $('glLbOrder').addEventListener('click', function () {
    var it = GL.list[GL.idx]; if (!it) return; glClose_(); goOrders({ search: it.o.orderReference });
  });
  $('glLbImg').addEventListener('error', function () { this.classList.add('hidden'); $('glLbFail').classList.remove('hidden'); });
  document.addEventListener('keydown', function (e) {
    if ($('glLb').classList.contains('hidden')) return;
    if (e.key === 'Escape') glClose_(); else if (e.key === 'ArrowLeft') glStep_(-1); else if (e.key === 'ArrowRight') glStep_(1);
  });
}
function glFillSelects_() {
  var rows = STATE.orders || [], fill = function (id, key, label) {
    var el = $(id), cur = el.value, vals = {};
    rows.forEach(function (o) { if (o.proofType && o[key]) vals[o[key]] = 1; });
    var ks = Object.keys(vals).sort(function (a, b) { return a.localeCompare(b, 'id', { numeric: true }); });
    el.innerHTML = '<option value="">' + label + '</option>' + ks.map(function (k) { return '<option value="' + esc(k) + '">' + esc(k) + '</option>'; }).join('');
    el.value = ks.indexOf(cur) !== -1 ? cur : '';
  };
  fill('glStore', 'outletName', 'Semua Store'); fill('glArea', 'area', 'Semua Area');
}
function renderGallery() {
  var box = $('glGrid'); if (!box) return;
  if (!STATE.orders) { box.innerHTML = '<div class="sk" style="height:76px;border-radius:16px"></div><div class="sk" style="height:76px;border-radius:16px"></div><div class="sk" style="height:76px;border-radius:16px"></div>'; return; }
  glFillSelects_();
  var q = $('glSearch').value.trim().toLowerCase(), st = $('glStore').value, ar = $('glArea').value, tp = $('glType').value, dt = $('glDate').value;
  var n = 0; [q, st, ar, tp, dt].forEach(function (v) { if (v) n++; });
  var dot = $('glDot'); dot.textContent = n; dot.classList.toggle('hidden', n === 0);
  var list = (STATE.orders || []).filter(function (o) {
    if (!o.proofType || !o.proofValue) return false;
    if (o.proofType === 'PHOTO' && !glId_(o.proofValue)) return false;
    if (tp && o.proofType !== tp) return false;
    if (st && o.outletName !== st) return false;
    if (ar && o.area !== ar) return false;
    if (dt && glDateKey_(o).indexOf(dt) === -1) return false;
    if (q && [o.orderReference, o.customer, o.hamperName, o.outletName, o.phone, o.proofType === 'RESI' ? o.proofValue : ''].join(' ').toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).map(function (o) { return { o: o, fid: o.proofType === 'PHOTO' ? glId_(o.proofValue) : '' }; });
  list.sort(function (a, b) { return String(b.o.updatedAt || b.o.deliveryDate).localeCompare(String(a.o.updatedAt || a.o.deliveryDate)); });
  GL.list = list;
  $('glCount').textContent = list.length.toLocaleString('id-ID') + ' bukti';
  if (!list.length) { box.innerHTML = '<div class="card gl-empty">' + (n ? emptyBlock('search', 'Bukti tidak ditemukan', 'Tidak ada bukti yang cocok. Coba ubah kata kunci, tanggal, atau filter store / area.') : emptyBlock('file', 'Belum ada bukti serah terima', 'Foto atau resi akan muncul di sini setelah order diselesaikan.')) + '</div>'; $('glMoreBox').classList.add('hidden'); return; }
  var head = '<div class="gl-head" aria-hidden="true"><span></span><span>Order</span><span>Hampers</span><span>Store</span><span>Tanggal</span><span>Tipe</span><span></span></div>';
  box.innerHTML = head + list.slice(0, GL.shown).map(function (it, i) {
    var o = it.o, del = isDeliveryOrder(o), badge = '<span class="gl-badge ' + (del ? 'del' : 'pick') + '">' + (del ? 'Delivery' : 'Pickup') + '</span>';
    var media = it.fid
      ? '<img loading="lazy" referrerpolicy="no-referrer" src="' + glThumb_(it, 200) + '" alt="Bukti ' + esc(o.orderReference) + '" onerror="this.parentNode.classList.add(\'fail\');this.remove()">'
      : '<div class="gl-resi">' + ic('truck') + '</div>';
    var sub = it.fid ? esc(o.customer || '-') : 'Resi ' + esc(o.proofValue);
    return '<div class="gl-card" data-gi="' + i + '" tabindex="0" role="button" title="Lihat bukti ' + esc(o.orderReference) + '">' +
      '<div class="gl-media">' + media + '<div class="gl-fb">' + ic('image') + '</div></div>' +
      '<div class="gc gc-ref"><b>' + esc(glRef_(o)) + '</b><small>' + sub + '</small></div>' +
      '<div class="gc gc-h">' + esc(o.hamperName || '-') + '</div>' +
      '<div class="gc gc-st">' + esc(o.outletName || '-') + '</div>' +
      '<div class="gc gc-dt">' + esc(fmtDate(glDateKey_(o)) || '-') + '</div>' +
      '<div class="gc gc-tp">' + badge + '</div>' +
      '<span class="gl-chev">' + ic('chevRight', 'sm') + '</span></div>';
  }).join('');
  $('glMoreBox').classList.toggle('hidden', list.length <= GL.shown);
  if (list.length > GL.shown) $('glMoreBtn').textContent = 'Muat lebih banyak (' + (list.length - GL.shown) + ' lagi)';
}
function glOpen_(i) {
  var it = GL.list[i]; if (!it) return; GL.idx = i;
  var o = it.o, del = isDeliveryOrder(o);
  var row = function (ico, l, v) {
    v = String(v || '').trim(); if (!v || v === '-') return '';
    return '<div class="gl-row"><span class="gl-ri">' + ic(ico, 'sm') + '</span><div><span>' + l + '</span><b>' + esc(v) + '</b></div></div>';
  };
  var img = $('glLbImg'), fail = $('glLbFail');
  fail.classList.add('hidden');
  if (it.fid) { img.classList.remove('hidden'); img.src = glThumb_(it, 1600); $('glLbDrive').classList.remove('hidden'); $('glLbDrive').href = o.proofValue; }
  else { img.classList.add('hidden'); img.removeAttribute('src'); fail.innerHTML = ic('truck') + '<small>No. Resi</small><b>' + esc(o.proofValue) + '</b><button type="button" class="gl-copy" data-glcopy="' + esc(o.proofValue) + '">' + ic('copy', 'sm') + ' Salin Resi</button>'; fail.classList.remove('hidden'); $('glLbDrive').classList.add('hidden'); }
  $('glLbType').textContent = del ? 'Delivery' : 'Pickup';
  $('glLbType').className = 'gl-lb-pill ' + (del ? 'del' : 'pick');
  var total = Math.min(GL.list.length, GL.shown);
  $('glLbCnt').textContent = (i + 1) + ' / ' + total;
  $('glLbRef').textContent = glRef_(o);
  $('glLbHamper').textContent = o.hamperName || '-';
  $('glLbQty').textContent = o.qty ? o.qty + ' pcs' : '';
  $('glLbQty').classList.toggle('hidden', !o.qty);
  $('glLbInfo').innerHTML = row('store', 'Store', o.outletName) + row('map', 'Area', o.area) + row('users', 'Customer', o.customer) + row('clock', 'Tanggal', glDateKey_(o)) + row('check', 'Diselesaikan oleh', o.updatedBy);
  $('glPrev').classList.toggle('hidden', i <= 0);
  $('glNext').classList.toggle('hidden', i >= total - 1);
  $('glLb').classList.remove('hidden'); document.body.classList.add('gl-lock');
  $('glLb').querySelector('.gl-lb-box').scrollTop = 0;
}
function glStep_(d) { var n = GL.idx + d; if (n >= 0 && n < Math.min(GL.list.length, GL.shown)) glOpen_(n); }
function glClose_() { $('glLb').classList.add('hidden'); $('glLbImg').removeAttribute('src'); document.body.classList.remove('gl-lock'); }
