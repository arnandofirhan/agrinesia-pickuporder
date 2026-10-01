/*************************************************
 * PICKUP ORDER MANAGEMENT - Code.gs
 * Backend Google Apps Script
 *************************************************/

const CONFIG = {
  SPREADSHEET_ID: '1siAQBtzwrnM_5h_9d1P-RYGgXQwWGsvYpwOrYllVLOk', // <-- GANTI dengan ID Spreadsheet Anda
  SESSION_TIMEOUT_MINUTES: 10080
};

const SHEETS = {
  ORDERS: 'Export',
  USERS: 'Users',
  STORES: 'Stores',
  AREAS: 'Areas',
  LOG: 'Pickup_Log'
};

const STATUS = {
  READY_PICKUP: 'READY_FOR_PICKUP',
  READY_DELIVERY: 'READY_FOR_DELIVERY',
  DONE_PICKUP: 'COMPLETED_PICKUP',
  DONE_DELIVERY: 'COMPLETED_DELIVERY'
};

// Mapping status lama (existing data) ke status baku sistem.
// Untuk status "ready/belum selesai", TIPE ORDER yang menentukan (bukan teks lama di sheet),
// karena data lama sering menulis "Ready for Pickup" untuk semua order termasuk Delivery.
const STATUS_MAP = {
  'completed pickup': STATUS.DONE_PICKUP,
  'completed delivery': STATUS.DONE_DELIVERY,
  'completed_pickup': STATUS.DONE_PICKUP,
  'completed_delivery': STATUS.DONE_DELIVERY
};

function isDeliveryType_(deliveryType) {
  return String(deliveryType || '').toLowerCase().indexOf('delivery') !== -1;
}

/* ================= ENTRY POINT ================= */

// Favicon logo Agrinesia (format sama seperti aplikasi HR CONTRACT: URL lh3 + akhiran #.png)
// Akhiran "#.png" wajib agar Apps Script menerima tipe gambarnya.
const FAVICON_URL = 'https://lh3.googleusercontent.com/d/1Vvnk1M7ocfoBzgQO2nxam6hde4ANetE7#.png';
// Cadangan: logo yang sudah terbukti jalan di aplikasi HR CONTRACT
const FAVICON_URL_BACKUP = 'https://lh3.googleusercontent.com/d/1dhE53_5RnoAtz4IvI84uKoutHKHTv4r7#.png';

function doGet() {
  var out = HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Pickup Order Management')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  try { out.setFaviconUrl(FAVICON_URL); }
  catch (e) { try { out.setFaviconUrl(FAVICON_URL_BACKUP); } catch (e2) { /* tanpa favicon, app tetap jalan */ } }
  return out;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ================= UTIL ================= */

function ss_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan.');
  return sh;
}

function nowStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Jakarta', 'yyyy-MM-dd HH:mm:ss');
}

function genId_(prefix) {
  return prefix + '-' + Utilities.getUuid().substring(0, 8).toUpperCase();
}

// UserID berurutan: USR-000083, USR-000084, ... (lanjut dari angka tertinggi di sheet Users)
function nextUserId_(extraUsedIds) {
  var max = 0;
  var rows = readSheetAsObjects_(SHEETS.USERS).rows;
  var ids = rows.map(function (u) { return String(u.UserID || ''); }).concat(extraUsedIds || []);
  ids.forEach(function (id) {
    var m = /^USR-(\d{6})$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'USR-' + ('000000' + (max + 1)).slice(-6);
}

function hashPassword_(password) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password, Utilities.Charset.UTF_8);
  return raw.map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('');
}

// Ambil semua data sheet sebagai array of object berdasarkan header (header-based mapping)
function readSheetAsObjects_(sheetName) {
  const sh = sheet_(sheetName);
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 1) return { headers: [], rows: [], sheet: sh };
  const values = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = values[0].map(function (h) { return String(h).trim(); });
  const rows = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    var isEmpty = true;
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null && values[i][c] !== undefined) isEmpty = false;
    }
    if (!isEmpty) {
      obj.__row = i + 1; // nomor baris asli di spreadsheet
      rows.push(obj);
    }
  }
  return { headers: headers, rows: rows, sheet: sh };
}

function colIndex_(headers, name) {
  return headers.indexOf(name);
}

// deliveryType dipakai untuk menentukan status awal yang benar (Pickup vs Delivery)
// ketika raw status kosong / tidak dikenali.
// Status diturunkan dari Tgl Kirim: ada tanggal -> Completed, kosong -> Ready. (kolom "Pickup Status" hanya pelengkap)
function normalizeStatus_(raw, deliveryType, dateVal) {
  var hasDate = !(dateVal === '' || dateVal === null || dateVal === undefined) && String(dateVal).trim() !== '';
  var delivery = isDeliveryType_(deliveryType);
  if (hasDate) return delivery ? STATUS.DONE_DELIVERY : STATUS.DONE_PICKUP;
  return delivery ? STATUS.READY_DELIVERY : STATUS.READY_PICKUP;
}

// Date object TIDAK bisa dikirim lewat google.script.run (hasilnya null di client) -> wajib jadi string
function ser_(v, fmt) {
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Jakarta', fmt || 'yyyy-MM-dd HH:mm:ss');
  }
  return v === null || v === undefined ? '' : v;
}

function errorResponse_(message) {
  return { success: false, message: message };
}

function successResponse_(data, message) {
  return { success: true, data: data, message: message || '' };
}

/* ================= SETUP ================= */

function setupDatabase() {
  const ss = ss_();

  // Pastikan sheet Orders (Export) ada. JANGAN dihapus/ubah datanya.
  var ordersSheet = ss.getSheetByName(SHEETS.ORDERS);
  if (!ordersSheet) {
    throw new Error('Sheet "Export" (data Orders) tidak ditemukan. Import data Excel Anda dahulu ke sheet bernama "Export".');
  }
  // Tambahkan kolom sistem bila belum ada (tanpa menghapus data)
  var headerRange = ordersSheet.getRange(1, 1, 1, ordersSheet.getLastColumn());
  var headers = headerRange.getValues()[0].map(function (h) { return String(h).trim(); });
  var extraCols = ['Created At', 'Updated At', 'Completed At', 'Completed By'];
  extraCols.forEach(function (col) {
    if (headers.indexOf(col) === -1) {
      ordersSheet.getRange(1, ordersSheet.getLastColumn() + 1).setValue(col);
      headers.push(col);
    }
  });

  // Sheet Users
  var usersSheet = ss.getSheetByName(SHEETS.USERS);
  if (!usersSheet) {
    usersSheet = ss.insertSheet(SHEETS.USERS);
    usersSheet.appendRow(['UserID', 'Name', 'Username', 'PasswordHash', 'Role', 'StoreID', 'AreaID', 'Status', 'CreatedAt', 'UpdatedAt', 'LastLoginAt']);
  }

  // Sheet Stores
  var storesSheet = ss.getSheetByName(SHEETS.STORES);
  if (!storesSheet) {
    storesSheet = ss.insertSheet(SHEETS.STORES);
    storesSheet.appendRow(['StoreID', 'StoreName', 'AreaID', 'Status', 'CreatedAt', 'UpdatedAt']);
    storesSheet.appendRow(['STO001', 'Online Store Bandung', 'AREA001', 'ACTIVE', nowStr_(), nowStr_()]);
    storesSheet.appendRow(['STO002', 'Online Store Jakarta', 'AREA002', 'ACTIVE', nowStr_(), nowStr_()]);
  }

  // Sheet Areas
  var areasSheet = ss.getSheetByName(SHEETS.AREAS);
  if (!areasSheet) {
    areasSheet = ss.insertSheet(SHEETS.AREAS);
    areasSheet.appendRow(['AreaID', 'AreaName', 'Status', 'CreatedAt', 'UpdatedAt']);
    areasSheet.appendRow(['AREA001', 'Bandung', 'ACTIVE', nowStr_(), nowStr_()]);
    areasSheet.appendRow(['AREA002', 'Jakarta', 'ACTIVE', nowStr_(), nowStr_()]);
  }

  // Sheet Pickup_Log
  var logSheet = ss.getSheetByName(SHEETS.LOG);
  if (!logSheet) {
    logSheet = ss.insertSheet(SHEETS.LOG);
    logSheet.appendRow(['LogID', 'OrderReference', 'PreviousStatus', 'NewStatus', 'StoreID', 'UpdatedBy', 'UpdatedAt', 'Notes']);
  }

  // Sheet Sessions (untuk session handling)
  var sessSheet = ss.getSheetByName('Sessions');
  if (!sessSheet) {
    sessSheet = ss.insertSheet('Sessions');
    sessSheet.appendRow(['Token', 'UserID', 'Username', 'Role', 'StoreID', 'AreaID', 'CreatedAt', 'ExpiresAt']);
  }

  return successResponse_(null, 'Setup database selesai. Semua sheet sistem sudah siap.');
}

function createInitialAdmin() {
  const data = readSheetAsObjects_(SHEETS.USERS);
  var exists = data.rows.some(function (u) { return String(u.Username).toLowerCase() === 'admin'; });
  if (exists) return successResponse_(null, 'User admin sudah ada, tidak dibuat ulang.');

  const sh = sheet_(SHEETS.USERS);
  sh.appendRow([
    genId_('USR'), 'Administrator', 'admin', hashPassword_('Admin123!'),
    'ADMIN', '', '', 'ACTIVE', nowStr_(), nowStr_(), ''
  ]);

  // Buat juga contoh store user "bandung" terhubung ke STO001
  var storesData = readSheetAsObjects_(SHEETS.STORES);
  var bandung = storesData.rows.find(function (s) { return s.StoreID === 'STO001'; });
  sh.appendRow([
    genId_('USR'), 'Kasir Bandung', 'bandung', hashPassword_('Bandung123!'),
    'STORE_USER', bandung ? bandung.StoreID : 'STO001', bandung ? bandung.AreaID : 'AREA001', 'ACTIVE', nowStr_(), nowStr_(), ''
  ]);

  return successResponse_(null, 'Admin (admin/Admin123!) dan Store User (bandung/Bandung123!) berhasil dibuat. Segera ganti password setelah login pertama.');
}

/* ================= SESSION ================= */

function createSession_(user) {
  const token = Utilities.getUuid();
  const sh = sheet_('Sessions');
  const created = new Date();
  const expires = new Date(created.getTime() + CONFIG.SESSION_TIMEOUT_MINUTES * 60000);
  sh.appendRow([token, user.UserID, user.Username, user.Role, user.StoreID || '', user.AreaID || '', created.toISOString(), expires.toISOString()]);
  return token;
}

function getSession_(token) {
  if (!token) return null;
  const data = readSheetAsObjects_('Sessions');
  const row = data.rows.find(function (r) { return r.Token === token; });
  if (!row) return null;
  if (new Date(row.ExpiresAt).getTime() < Date.now()) {
    return null; // expired
  }
  return row;
}

function destroySession_(token) {
  const sh = sheet_('Sessions');
  const data = readSheetAsObjects_('Sessions');
  const row = data.rows.find(function (r) { return r.Token === token; });
  if (row) sh.deleteRow(row.__row);
}

function requireSession_(token) {
  const session = getSession_(token);
  if (!session) throw new Error('AUTH_REQUIRED');
  return session;
}

/* ================= AUTH ================= */

function login(username, password) {
  try {
    if (!username || !password) return errorResponse_('Username dan password wajib diisi.');
    const data = readSheetAsObjects_(SHEETS.USERS);
    const user = data.rows.find(function (u) {
      return String(u.Username).toLowerCase() === String(username).toLowerCase();
    });
    if (!user) return errorResponse_('Username atau password salah.');
    if (String(user.Status).toUpperCase() !== 'ACTIVE') return errorResponse_('Akun Anda tidak aktif. Hubungi admin.');

    const hashed = hashPassword_(password);
    if (String(user.PasswordHash) !== hashed) return errorResponse_('Username atau password salah.');

    const token = createSession_(user);

    // update last login
    const sh = sheet_(SHEETS.USERS);
    const headers = data.headers;
    sh.getRange(user.__row, colIndex_(headers, 'LastLoginAt') + 1).setValue(nowStr_());

    var storeName = '';
    if (user.StoreID) {
      var storesData = readSheetAsObjects_(SHEETS.STORES);
      var myIds = String(user.StoreID).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      var myNames = storesData.rows.filter(function (s) { return myIds.indexOf(s.StoreID) !== -1; }).map(function (s) { return s.StoreName; });
      storeName = myNames.join(', ');
    }

    return successResponse_({
      token: token,
      name: user.Name,
      username: user.Username,
      role: user.Role,
      storeId: user.StoreID || '',
      storeName: storeName,
      areaId: user.AreaID || ''
    }, 'Login berhasil.');
  } catch (e) {
    return errorResponse_('Terjadi kesalahan saat login.');
  }
}

function logout(token) {
  try {
    destroySession_(token);
    return successResponse_(null, 'Logout berhasil.');
  } catch (e) {
    return errorResponse_('Terjadi kesalahan saat logout.');
  }
}

function validateSession(token) {
  try {
    const s = getSession_(token);
    if (!s) return errorResponse_('Sesi tidak valid atau sudah berakhir.');
    return successResponse_({
      username: s.Username, role: s.Role, storeId: s.StoreID, areaId: s.AreaID
    });
  } catch (e) {
    return errorResponse_('Sesi tidak valid.');
  }
}

/* ================= MULTI-STORE ACCESS HELPER ================= */
// STORE & MANAGER menyimpan StoreID sebagai satu id (STORE) atau beberapa id dipisah koma (MANAGER).
// ADMIN -> null (akses semua). Non-admin -> array id store yang boleh diakses (bisa kosong).
function sessionStoreIds_(session) {
  if (session.Role === 'ADMIN') return null;
  return String(session.StoreID || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
function sessionStoreNames_(session, storesRows) {
  var ids = sessionStoreIds_(session);
  if (ids === null) return null;
  return storesRows.filter(function (s) { return ids.indexOf(s.StoreID) !== -1; }).map(function (s) { return s.StoreName; });
}

// Peta username -> nama lengkap (untuk kolom "Updated By")
function userNameMap_() {
  var map = {};
  readSheetAsObjects_(SHEETS.USERS).rows.forEach(function (u) {
    map[String(u.Username).toLowerCase()] = String(u.Name || u.Username);
  });
  return map;
}
function displayName_(map, v) {
  if (!v) return '';
  return map[String(v).toLowerCase()] || v;
}

/* ================= ORDERS ================= */

// Ambil daftar order sesuai hak akses user (filtering WAJIB di server)
function getOrders(token, filters) {
  try {
    const session = requireSession_(token);
    filters = filters || {};

    const data = readSheetAsObjects_(SHEETS.ORDERS);
    var nameMap = userNameMap_();
    var rows = data.rows.filter(function (r) { return String(r['OrderReference'] || '').trim() !== ''; }).map(function (r) {
      return {
        row: r.__row,
        pickupStatus: normalizeStatus_(r['Pickup Status'], r['Pre-Order Delivery Type'], r['Pre-Order Delivery Date']),
        area: r['Area'] || '',
        outletName: r['OutletName'] || '',
        orderReference: r['OrderReference'] || '',
        hamperName: r['HamperName'] || '',
        deliveryType: r['Pre-Order Delivery Type'] || '',
        customer: r['Pre-Order Customer'] || '',
        phone: r['Pre-Order Phone Number'] || '',
        storeDispatch: r['Pre-Order Store Dispatch'] || '',
        deliveryDate: ser_(r['Pre-Order Delivery Date'], 'yyyy/MM/dd'),
        revenue: r['Rev Pre-Order'] || 0,
        qty: r['Qty Pre-Order'] || 0,
        updatedAt: ser_(r['Updated At']),
        updatedBy: displayName_(nameMap, r['Completed By'])
      };
    });

    // SECURITY: non-admin hanya boleh lihat outlet miliknya (bisa lebih dari 1 store untuk MANAGER), berdasarkan session
    if (session.Role !== 'ADMIN') {
      var storesData = readSheetAsObjects_(SHEETS.STORES);
      var myNames = sessionStoreNames_(session, storesData.rows);
      rows = rows.filter(function (r) { return myNames.indexOf(r.outletName) !== -1; });
    }

    // Filters (aman diterapkan setelah scoping akses)
    if (filters.status) rows = rows.filter(function (r) { return r.pickupStatus === filters.status; });
    if (filters.area) rows = rows.filter(function (r) { return r.area === filters.area; });
    if (filters.store) rows = rows.filter(function (r) { return r.outletName === filters.store; });
    if (filters.deliveryType) rows = rows.filter(function (r) { return r.deliveryType === filters.deliveryType; });
    if (filters.date) rows = rows.filter(function (r) { return String(r.deliveryDate).indexOf(filters.date) !== -1; });
    if (filters.search) {
      var q = String(filters.search).toLowerCase();
      rows = rows.filter(function (r) {
        return String(r.orderReference).toLowerCase().indexOf(q) !== -1 ||
          String(r.customer).toLowerCase().indexOf(q) !== -1 ||
          String(r.phone).toLowerCase().indexOf(q) !== -1;
      });
    }

    return successResponse_(rows);
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat mengambil data order.');
  }
}

function getOrderDetail(token, orderReference) {
  try {
    const session = requireSession_(token);
    const data = readSheetAsObjects_(SHEETS.ORDERS);
    const r = data.rows.find(function (x) { return String(x.OrderReference) === String(orderReference); });
    if (!r) return errorResponse_('Order tidak ditemukan.');

    if (session.Role !== 'ADMIN') {
      var storesData = readSheetAsObjects_(SHEETS.STORES);
      var myNames = sessionStoreNames_(session, storesData.rows);
      if (myNames.indexOf(r.OutletName) === -1) return errorResponse_('Anda tidak memiliki akses ke order ini.');
    }

    return successResponse_({
      pickupStatus: normalizeStatus_(r['Pickup Status'], r['Pre-Order Delivery Type'], r['Pre-Order Delivery Date']),
      area: r['Area'] || '',
      outletName: r['OutletName'] || '',
      orderReference: r['OrderReference'] || '',
      hamperName: r['HamperName'] || '',
      deliveryType: r['Pre-Order Delivery Type'] || '',
      customer: r['Pre-Order Customer'] || '',
      phone: r['Pre-Order Phone Number'] || '',
      deliveryDate: ser_(r['Pre-Order Delivery Date'], 'yyyy/MM/dd'),
      revenue: r['Rev Pre-Order'] || 0,
      qty: r['Qty Pre-Order'] || 0,
      updatedAt: ser_(r['Updated At']),
      updatedBy: displayName_(userNameMap_(), r['Completed By'])
    });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat mengambil detail order.');
  }
}

// Update status pickup -- validasi kepemilikan store dilakukan dari session, BUKAN dari input client
function updateOrderStatus(token, orderReference, notes) {
  try {
    const session = requireSession_(token);
    const data = readSheetAsObjects_(SHEETS.ORDERS);
    const headers = data.headers;
    const r = data.rows.find(function (x) { return String(x.OrderReference) === String(orderReference); });
    if (!r) return errorResponse_('Order tidak ditemukan.');

    var storesData = readSheetAsObjects_(SHEETS.STORES);

    if (session.Role !== 'ADMIN') {
      var myNames = sessionStoreNames_(session, storesData.rows);
      if (myNames.indexOf(r.OutletName) === -1) return errorResponse_('Anda tidak memiliki akses ke order ini.');
    }

    var deliveryTypeRaw = r['Pre-Order Delivery Type'];
    const previousStatus = normalizeStatus_(r['Pickup Status'], deliveryTypeRaw, r['Pre-Order Delivery Date']);
    if (previousStatus === STATUS.DONE_PICKUP || previousStatus === STATUS.DONE_DELIVERY) {
      return errorResponse_('Order ini sudah selesai diproses sebelumnya.');
    }

    var newStatus = isDeliveryType_(deliveryTypeRaw) ? STATUS.DONE_DELIVERY : STATUS.DONE_PICKUP;

    const sh = sheet_(SHEETS.ORDERS);
    const rowNum = r.__row;
    sh.getRange(rowNum, colIndex_(headers, 'Pickup Status') + 1).setValue(newStatus);
    // Tgl Kirim otomatis terisi tanggal saat order diselesaikan
    if (colIndex_(headers, 'Pre-Order Delivery Date') !== -1) {
      sh.getRange(rowNum, colIndex_(headers, 'Pre-Order Delivery Date') + 1).setNumberFormat('yyyy/MM/dd').setValue(new Date());
    }
    if (colIndex_(headers, 'Updated At') !== -1) sh.getRange(rowNum, colIndex_(headers, 'Updated At') + 1).setValue(nowStr_());
    if (colIndex_(headers, 'Completed At') !== -1) sh.getRange(rowNum, colIndex_(headers, 'Completed At') + 1).setValue(nowStr_());
    if (colIndex_(headers, 'Completed By') !== -1) sh.getRange(rowNum, colIndex_(headers, 'Completed By') + 1).setValue(displayName_(userNameMap_(), session.Username));
    if (colIndex_(headers, 'Created At') !== -1 && !r['Created At']) sh.getRange(rowNum, colIndex_(headers, 'Created At') + 1).setValue(nowStr_());

    // Audit log
    var storeIdForLog = '';
    var found = storesData.rows.find(function (s) { return s.StoreName === r.OutletName; });
    if (found) storeIdForLog = found.StoreID;

    const logSheet = sheet_(SHEETS.LOG);
    logSheet.appendRow([genId_('LOG'), orderReference, previousStatus, newStatus, storeIdForLog, session.Username, nowStr_(), notes || '']);

    return successResponse_({ newStatus: newStatus }, 'Order berhasil diperbarui.');
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat memperbarui order.');
  }
}

/* ================= DASHBOARD ================= */

function getDashboardStats(token) {
  try {
    const session = requireSession_(token);
    const data = readSheetAsObjects_(SHEETS.ORDERS);
    var rows = data.rows.filter(function (r) { return String(r['OrderReference'] || '').trim() !== ''; });

    if (session.Role !== 'ADMIN') {
      var storesData = readSheetAsObjects_(SHEETS.STORES);
      var myNames = sessionStoreNames_(session, storesData.rows);
      rows = rows.filter(function (r) { return myNames.indexOf(r.OutletName) !== -1; });
    }

    var stats = {
      totalOrder: rows.length,
      readyForPickup: 0,
      readyForDelivery: 0,
      completedPickup: 0,
      completedDelivery: 0,
      totalQty: 0,
      totalRevenue: 0,
      byArea: {},
      byStore: {}
    };

    rows.forEach(function (r) {
      var st = normalizeStatus_(r['Pickup Status'], r['Pre-Order Delivery Type'], r['Pre-Order Delivery Date']);
      if (st === STATUS.READY_PICKUP) stats.readyForPickup++;
      if (st === STATUS.READY_DELIVERY) stats.readyForDelivery++;
      if (st === STATUS.DONE_PICKUP) stats.completedPickup++;
      if (st === STATUS.DONE_DELIVERY) stats.completedDelivery++;
      stats.totalQty += Number(r['Qty Pre-Order']) || 0;
      stats.totalRevenue += Number(r['Rev Pre-Order']) || 0;

      var area = r['Area'] || 'Unknown';
      stats.byArea[area] = (stats.byArea[area] || 0) + 1;
      var store = r['OutletName'] || 'Unknown';
      stats.byStore[store] = (stats.byStore[store] || 0) + 1;
    });

    return successResponse_(stats);
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat mengambil statistik dashboard.');
  }
}

/* ================= LOOKUP (Store & Area list for filter dropdown) ================= */

function getStoresAndAreas(token) {
  try {
    const session = requireSession_(token);
    const storesData = readSheetAsObjects_(SHEETS.STORES);
    const areasData = readSheetAsObjects_(SHEETS.AREAS);

    var stores = storesData.rows;
    if (session.Role !== 'ADMIN') {
      var ids = sessionStoreIds_(session);
      stores = stores.filter(function (s) { return ids.indexOf(s.StoreID) !== -1; });
    }

    return successResponse_({
      stores: stores.map(function (s) { return { storeId: s.StoreID, storeName: s.StoreName, areaId: s.AreaID, status: s.Status }; }),
      areas: areasData.rows.map(function (a) { return { areaId: a.AreaID, areaName: a.AreaName, status: a.Status }; })
    });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat mengambil data store/area.');
  }
}

/* ================= USER MANAGEMENT (ADMIN ONLY) ================= */

function requireAdmin_(token) {
  const session = requireSession_(token);
  if (session.Role !== 'ADMIN') throw new Error('FORBIDDEN');
  return session;
}

function getUsers(token) {
  try {
    requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.USERS);
    return successResponse_(data.rows.map(function (u) {
      return {
        userId: String(u.UserID), name: String(u.Name), username: String(u.Username), role: String(u.Role),
        storeId: String(u.StoreID || ''), areaId: String(u.AreaID || ''), status: String(u.Status),
        createdAt: ser_(u.CreatedAt), lastLoginAt: ser_(u.LastLoginAt)
      };
    }));
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat mengambil data user: ' + e.message);
  }
}

function createUser(token, payload) {
  try {
    requireAdmin_(token);
    if (!payload.name || !payload.username || !payload.password || !payload.role) {
      return errorResponse_('Nama, username, password, dan role wajib diisi.');
    }
    if ((payload.role === 'STORE' || payload.role === 'STORE_USER') && !payload.storeId) {
      return errorResponse_('Store wajib dipilih untuk role Store.');
    }
    if (payload.role === 'MANAGER' && !payload.storeId) {
      return errorResponse_('Minimal 1 store wajib dipilih untuk role Manager.');
    }
    const data = readSheetAsObjects_(SHEETS.USERS);
    var dup = data.rows.some(function (u) { return String(u.Username).toLowerCase() === String(payload.username).toLowerCase(); });
    if (dup) return errorResponse_('Username sudah digunakan.');

    const sh = sheet_(SHEETS.USERS);
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
    sh.appendRow([
      nextUserId_(), payload.name, payload.username, hashPassword_(payload.password),
      payload.role, payload.storeId || '', payload.areaId || '', 'ACTIVE', nowStr_(), nowStr_(), ''
    ]);
    } finally { lock.releaseLock(); }
    return successResponse_(null, 'User berhasil ditambahkan.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat membuat user.');
  }
}

function updateUser(token, userId, payload) {
  try {
    requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.USERS);
    const headers = data.headers;
    const u = data.rows.find(function (x) { return x.UserID === userId; });
    if (!u) return errorResponse_('User tidak ditemukan.');

    const sh = sheet_(SHEETS.USERS);
    const rowNum = u.__row;
    if (payload.name) sh.getRange(rowNum, colIndex_(headers, 'Name') + 1).setValue(payload.name);
    if (payload.role) sh.getRange(rowNum, colIndex_(headers, 'Role') + 1).setValue(payload.role);
    if (payload.storeId !== undefined) sh.getRange(rowNum, colIndex_(headers, 'StoreID') + 1).setValue(payload.storeId);
    if (payload.areaId !== undefined) sh.getRange(rowNum, colIndex_(headers, 'AreaID') + 1).setValue(payload.areaId);
    if (payload.status) sh.getRange(rowNum, colIndex_(headers, 'Status') + 1).setValue(payload.status);
    if (payload.password) sh.getRange(rowNum, colIndex_(headers, 'PasswordHash') + 1).setValue(hashPassword_(payload.password));
    sh.getRange(rowNum, colIndex_(headers, 'UpdatedAt') + 1).setValue(nowStr_());

    return successResponse_(null, 'User berhasil diperbarui.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat memperbarui user.');
  }
}

function deleteUser(token, userId) {
  try {
    const session = requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.USERS);
    const u = data.rows.find(function (x) { return x.UserID === userId; });
    if (!u) return errorResponse_('User tidak ditemukan.');
    if (session.Username && u.Username === session.Username) {
      return errorResponse_('Anda tidak dapat menghapus akun Anda sendiri.');
    }
    sheet_(SHEETS.USERS).deleteRow(u.__row);
    return successResponse_(null, 'User berhasil dihapus.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat menghapus user.');
  }
}

/* ================= STORE MANAGEMENT (ADMIN ONLY) ================= */

function createStore(token, payload) {
  try {
    requireAdmin_(token);
    if (!payload.storeName || !payload.areaId) return errorResponse_('Nama store dan area wajib diisi.');
    const data = readSheetAsObjects_(SHEETS.STORES);
    var storeId = payload.storeId || genId_('STO');
    var dup = data.rows.some(function (s) { return s.StoreID === storeId; });
    if (dup) return errorResponse_('StoreID sudah digunakan.');

    sheet_(SHEETS.STORES).appendRow([storeId, payload.storeName, payload.areaId, 'ACTIVE', nowStr_(), nowStr_()]);
    return successResponse_(null, 'Store berhasil ditambahkan.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat membuat store.');
  }
}

function updateStore(token, storeId, payload) {
  try {
    requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.STORES);
    const headers = data.headers;
    const s = data.rows.find(function (x) { return x.StoreID === storeId; });
    if (!s) return errorResponse_('Store tidak ditemukan.');

    const sh = sheet_(SHEETS.STORES);
    if (payload.storeName) sh.getRange(s.__row, colIndex_(headers, 'StoreName') + 1).setValue(payload.storeName);
    if (payload.areaId) sh.getRange(s.__row, colIndex_(headers, 'AreaID') + 1).setValue(payload.areaId);
    if (payload.status) sh.getRange(s.__row, colIndex_(headers, 'Status') + 1).setValue(payload.status);
    sh.getRange(s.__row, colIndex_(headers, 'UpdatedAt') + 1).setValue(nowStr_());

    return successResponse_(null, 'Store berhasil diperbarui.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat memperbarui store.');
  }
}

function deleteStore(token, storeId) {
  try {
    requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.STORES);
    const s = data.rows.find(function (x) { return x.StoreID === storeId; });
    if (!s) return errorResponse_('Store tidak ditemukan.');

    var usersData = readSheetAsObjects_(SHEETS.USERS);
    var inUse = usersData.rows.some(function (u) { return u.StoreID === storeId; });
    if (inUse) return errorResponse_('Store tidak dapat dihapus karena masih digunakan oleh user.');

    sheet_(SHEETS.STORES).deleteRow(s.__row);
    return successResponse_(null, 'Store berhasil dihapus.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat menghapus store.');
  }
}

/* ================= AREA MANAGEMENT (ADMIN ONLY) ================= */

function createArea(token, payload) {
  try {
    requireAdmin_(token);
    if (!payload.areaName) return errorResponse_('Nama area wajib diisi.');
    const data = readSheetAsObjects_(SHEETS.AREAS);
    var areaId = payload.areaId || genId_('AREA');
    var dup = data.rows.some(function (a) { return a.AreaID === areaId; });
    if (dup) return errorResponse_('AreaID sudah digunakan.');

    sheet_(SHEETS.AREAS).appendRow([areaId, payload.areaName, 'ACTIVE', nowStr_(), nowStr_()]);
    return successResponse_(null, 'Area berhasil ditambahkan.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat membuat area.');
  }
}

function updateArea(token, areaId, payload) {
  try {
    requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.AREAS);
    const headers = data.headers;
    const a = data.rows.find(function (x) { return x.AreaID === areaId; });
    if (!a) return errorResponse_('Area tidak ditemukan.');

    const sh = sheet_(SHEETS.AREAS);
    if (payload.areaName) sh.getRange(a.__row, colIndex_(headers, 'AreaName') + 1).setValue(payload.areaName);
    if (payload.status) sh.getRange(a.__row, colIndex_(headers, 'Status') + 1).setValue(payload.status);
    sh.getRange(a.__row, colIndex_(headers, 'UpdatedAt') + 1).setValue(nowStr_());

    return successResponse_(null, 'Area berhasil diperbarui.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat memperbarui area.');
  }
}

function deleteArea(token, areaId) {
  try {
    requireAdmin_(token);
    const data = readSheetAsObjects_(SHEETS.AREAS);
    const a = data.rows.find(function (x) { return x.AreaID === areaId; });
    if (!a) return errorResponse_('Area tidak ditemukan.');

    var storesData = readSheetAsObjects_(SHEETS.STORES);
    var inUse = storesData.rows.some(function (s) { return s.AreaID === areaId; });
    if (inUse) return errorResponse_('Area tidak dapat dihapus karena masih digunakan oleh store.');

    sheet_(SHEETS.AREAS).deleteRow(a.__row);
    return successResponse_(null, 'Area berhasil dihapus.');
  } catch (e) {
    if (e.message === 'FORBIDDEN') return errorResponse_('Anda tidak memiliki akses admin.');
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat menghapus area.');
  }
}

/* ================= AUDIT LOG ================= */

function getAuditLog(token, orderReference) {
  try {
    const session = requireSession_(token);
    const data = readSheetAsObjects_(SHEETS.LOG);
    var rows = data.rows;

    if (orderReference) rows = rows.filter(function (r) { return String(r.OrderReference) === String(orderReference); });

    if (session.Role !== 'ADMIN') {
      rows = rows.filter(function (r) { return r.StoreID === session.StoreID; });
    }

    rows.sort(function (a, b) { return new Date(ser_(b.UpdatedAt)) - new Date(ser_(a.UpdatedAt)); });

    return successResponse_(rows.map(function (r) {
      return {
        logId: r.LogID, orderReference: r.OrderReference, previousStatus: r.PreviousStatus,
        newStatus: r.NewStatus, storeId: r.StoreID, updatedBy: r.UpdatedBy, updatedAt: ser_(r.UpdatedAt), notes: r.Notes
      };
    }));
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return errorResponse_('Sesi tidak valid, silakan login kembali.');
    return errorResponse_('Terjadi kesalahan saat mengambil audit log.');
  }
}

/* ============================================================
 * UTILITAS SEKALI JALAN: rapikan user yang diinput manual di sheet.
 * Jalankan dari editor Apps Script: pilih fixManualUsers > Run.
 * - UserID kosong   -> diisi otomatis (format USR-XXXXXXXX, unik)
 * - StoreID kosong untuk role STORE -> dicocokkan dari nama (Name = StoreName)
 * - Username kosong -> hanya dilaporkan di log (harus diisi manual)
 * ============================================================ */
function fixManualUsers() {
  const data = readSheetAsObjects_(SHEETS.USERS);
  const storesData = readSheetAsObjects_(SHEETS.STORES);
  const sh = sheet_(SHEETS.USERS);
  const h = data.headers;
  const used = {};
  data.rows.forEach(function (u) { if (u.UserID) used[String(u.UserID)] = true; });
  var nId = 0, nStore = 0, noUser = [], noStore = [];

  data.rows.forEach(function (u) {
    if (!u.UserID && (u.Name || u.Username)) {
      var id = nextUserId_(Object.keys(used));
      used[id] = true;
      sh.getRange(u.__row, colIndex_(h, 'UserID') + 1).setValue(id);
      nId++;
    }
    if (!u.Username && u.Name) noUser.push('baris ' + u.__row + ': ' + u.Name);
    if (String(u.Role) === 'STORE' && !u.StoreID) {
      var nm = String(u.Name || '').trim().toLowerCase();
      var s = storesData.rows.find(function (x) { return String(x.StoreName).trim().toLowerCase() === nm; });
      if (s) { sh.getRange(u.__row, colIndex_(h, 'StoreID') + 1).setValue(s.StoreID); nStore++; }
      else noStore.push('baris ' + u.__row + ': ' + u.Name);
    }
  });
  SpreadsheetApp.flush();
  Logger.log('UserID terisi: ' + nId + ' | StoreID terisi: ' + nStore);
  Logger.log('Username kosong (isi manual): ' + (noUser.join('; ') || '-'));
  Logger.log('Store tidak ditemukan: ' + (noStore.join('; ') || '-'));
}

/*************************************************
 * ===== TAMBAHAN UNTUK FRONTEND DI GITHUB PAGES =====
 * Hanya MENAMBAH endpoint API. Tidak ada fungsi lama yang diubah;
 * doGet() di atas tetap menyajikan aplikasi lama seperti biasa.
 *************************************************/

// Cek koneksi cepat dari frontend
function ping() {
  return { success: true, data: { time: nowStr_() }, message: 'pong' };
}

// Daftar fungsi yang boleh dipanggil dari luar (setup/fix sengaja TIDAK dimasukkan).
const API_FUNCTIONS_ = {
  ping: ping,
  login: login,
  logout: logout,
  validateSession: validateSession,
  getOrders: getOrders,
  getOrderDetail: getOrderDetail,
  updateOrderStatus: updateOrderStatus,
  getDashboardStats: getDashboardStats,
  getStoresAndAreas: getStoresAndAreas,
  getUsers: getUsers,
  createUser: createUser,
  updateUser: updateUser,
  deleteUser: deleteUser,
  createStore: createStore,
  updateStore: updateStore,
  deleteStore: deleteStore,
  createArea: createArea,
  updateArea: updateArea,
  deleteArea: deleteArea,
  getAuditLog: getAuditLog
};

function doPost(e) {
  var out;
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = API_FUNCTIONS_[String(req.fn || '')];
    if (typeof fn !== 'function') {
      out = { __gas_error: true, message: 'Fungsi server tidak ditemukan.' };
    } else {
      var res = fn.apply(null, req.args || []);
      out = (res === undefined) ? null : res;
    }
  } catch (err) {
    out = { __gas_error: true, message: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
