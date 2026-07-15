/**
 * PEP MA QC Portal — Google Apps Script backend API
 *
 * Serves the GitHub Pages frontend. Reads the daily photo folders + KOBO RD
 * excel from the shared drive, manages QC users/sessions, and writes QC
 * results into a per-date "QC RD <date>" Google Sheet (an exact copy of the
 * Kobo file plus QC columns at the end).
 *
 * SETUP (one time):
 *   1. In the Apps Script editor: Services (+) -> add "Drive API" (v3), keep symbol "Drive".
 *   2. Run setup() once from the editor and authorize all scopes.
 *   3. Deploy -> New deployment -> Web app -> Execute as: Me, Access: Anyone.
 *   4. Paste the web app URL into js/config.js of the frontend.
 *   5. Log in as admin / ChangeMe123! and change the password immediately.
 */

var CONFIG = {
  // Root Drive folder that contains one subfolder per day (YYYY-MM-DD)
  ROOT_FOLDER_ID: '15r9ltXPk4Ehc2ViR-UJ6277lmjbI9o2m',

  DB_NAME: 'PEP MA QC Portal DB',          // master spreadsheet (Users/Sessions/QCLog)
  OUTPUT_FOLDER_NAME: 'PEP MA QC OUTPUT',  // folder that receives the QC RD copies
  QC_SHEET_PREFIX: 'QC RD ',               // per-date QC copy name = prefix + date
  KOBO_FILE_PREFIX: 'KOBO RD',             // source excel name inside each date folder

  SESSION_HOURS: 12,
  DEFAULT_ADMIN: { username: 'admin', password: 'ChangeMe123!', displayName: 'Administrator' },

  ID_HEADER: '_id',
  FILTERS: {
    city:    'Select City Name',
    auditor: 'Select Auditor Name',
    channel: 'Channel Type'
  },
  // Always shown as read-only context above the editable measures
  CONTEXT_HEADERS: [
    'Select City Name', 'Select Auditor Name', 'Select Store ID',
    'Select Store Name', 'Channel Type', '1.9: Shop Status Code'
  ],
  // What each photo folder shows in the editable panel.
  //  - range: [startQuestion, endQuestion] matched against the header row
  //  - headers: explicit list of headers
  FOLDER_TYPES: {
    'PEP COOLER':    { range: ['2.1.5', '2.1.24a'] },
    'KO COOLER':     { range: ['2.2.5', '2.2.24a'] },
    'OTHERS COOLER': { range: ['2.3.5', '2.3.24a'] },
    'MT SHELVES':    { range: ['3.1.1', '3.1.16'] },
    'STORES PHOTOS': { headers: [
      'Select Store ID', 'Select Store Name', 'Channel Type',
      '_1.7: GPS Coordinates_latitude', '_1.7: GPS Coordinates_longitude'
    ] }
  },
  QC_FIELDS: ['User', 'Start', 'End', 'Status', 'Changes', 'Remarks']
};

var PROPS = PropertiesService.getScriptProperties();

/* ------------------------------------------------------------------ *
 *  HTTP entry points
 * ------------------------------------------------------------------ */

function doGet() {
  return jsonOut({ ok: true, service: 'PEP MA QC Portal API', time: new Date().toISOString() });
}

function doPost(e) {
  var out;
  try {
    var p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    out = route(p);
  } catch (err) {
    out = { ok: false, error: String((err && err.message) || err) };
  }
  return jsonOut(out);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function route(p) {
  var action = p.action || '';

  if (action === 'login') return login(p);

  var session = requireSession(p.token);

  switch (action) {
    case 'logout':     return logout(p.token);
    case 'me':         return { ok: true, data: session };
    case 'getDates':   return getDates();
    case 'getFolders': return getFolders(p.date);
    case 'getFilters': return getFilters(p.date);
    case 'getQueue':   return getQueue(p);
    case 'getRecord':  return getRecord(p);
    case 'getImage':   return getImage(p.fileId);
    case 'saveQC':     return saveQC(p, session);
    case 'getSessionSummary': return getSessionSummary(p, session);
  }

  // Admin-only actions
  if (session.role !== 'admin') throw new Error('Admin access required');
  switch (action) {
    case 'listUsers':    return listUsers();
    case 'createUser':   return createUser(p, session);
    case 'setPassword':  return setPassword(p);
    case 'setActive':    return setActive(p);
    case 'getProgress':  return getProgress(p.date);
    case 'exportQc':     return exportQc(p.date);
    case 'listSessions': return listSessions();
  }
  throw new Error('Unknown action: ' + action);
}

/* ------------------------------------------------------------------ *
 *  Database (master spreadsheet)
 * ------------------------------------------------------------------ */

function db() {
  var id = PROPS.getProperty('DB_ID');
  if (!id) throw new Error('Backend not initialised — run setup() in the Apps Script editor first.');
  return SpreadsheetApp.openById(id);
}

function dbSheet(name, headers) {
  var ss = db();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  } else {
    // migration: append any headers added in later versions
    var existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
    var missing = headers.filter(function (h) { return existing.indexOf(h) === -1; });
    if (missing.length) sh.getRange(1, existing.length + 1, 1, missing.length).setValues([missing]);
  }
  return sh;
}

function usersSheet()    { return dbSheet('Users',    ['username', 'displayName', 'role', 'salt', 'hash', 'active', 'createdAt', 'createdBy']); }
function sessionsSheet() { return dbSheet('Sessions', ['token', 'username', 'displayName', 'role', 'expiresAt', 'createdAt']); }
function qcLogSheet()    { return dbSheet('QCLog',    ['savedAt', 'date', 'folderType', '_id', 'qcUser', 'qcStart', 'qcEnd', 'status', 'changeCount', 'changes', 'remarks', 'sessionId']); }

/** Short public id of a login session (safe to store in logs — not the full token). */
function sessionIdFromToken(token) { return String(token || '').slice(0, 8); }

/** One-time initialisation: creates the DB spreadsheet, output folder and admin user. */
function setup() {
  if (!PROPS.getProperty('DB_ID')) {
    var ss = SpreadsheetApp.create(CONFIG.DB_NAME);
    PROPS.setProperty('DB_ID', ss.getId());
  }
  if (!PROPS.getProperty('OUT_FOLDER_ID')) {
    var folder = DriveApp.createFolder(CONFIG.OUTPUT_FOLDER_NAME);
    PROPS.setProperty('OUT_FOLDER_ID', folder.getId());
  }
  usersSheet(); sessionsSheet(); qcLogSheet();

  // Bootstrap admin user if missing
  var sh = usersSheet();
  var names = colValues(sh, 1);
  if (names.indexOf(CONFIG.DEFAULT_ADMIN.username) === -1) {
    var salt = Utilities.getUuid();
    sh.appendRow([
      CONFIG.DEFAULT_ADMIN.username, CONFIG.DEFAULT_ADMIN.displayName, 'admin',
      salt, hashPassword(salt, CONFIG.DEFAULT_ADMIN.password), true,
      new Date(), 'setup'
    ]);
  }
  Logger.log('Setup complete. DB: https://docs.google.com/spreadsheets/d/' + PROPS.getProperty('DB_ID'));
  Logger.log('Admin login: ' + CONFIG.DEFAULT_ADMIN.username + ' / ' + CONFIG.DEFAULT_ADMIN.password + '  (CHANGE THIS after first login)');
}

/* ------------------------------------------------------------------ *
 *  Auth
 * ------------------------------------------------------------------ */

function hashPassword(salt, password) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + String(password), Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
}

function findUser(username) {
  var data = usersSheet().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === String(username).toLowerCase()) {
      return { row: i + 1, username: data[i][0], displayName: data[i][1], role: data[i][2], salt: data[i][3], hash: data[i][4], active: data[i][5] === true || data[i][5] === 'TRUE' };
    }
  }
  return null;
}

function login(p) {
  if (!p.username || !p.password) throw new Error('Username and password required');
  var u = findUser(p.username);
  if (!u || !u.active || hashPassword(u.salt, p.password) !== u.hash) {
    Utilities.sleep(500); // slow brute force attempts
    throw new Error('Invalid username or password');
  }
  var token = Utilities.getUuid();
  var expires = new Date(Date.now() + CONFIG.SESSION_HOURS * 3600 * 1000);
  var session = { username: u.username, displayName: u.displayName, role: u.role };
  sessionsSheet().appendRow([token, u.username, u.displayName, u.role, expires, new Date()]);
  CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), 21600);
  return { ok: true, data: { token: token, user: session } };
}

function logout(token) {
  CacheService.getScriptCache().remove('sess_' + token);
  // expire the row instead of deleting it, so session history (createdAt) is kept
  var sh = sessionsSheet();
  var tokens = colValues(sh, 1);
  var idx = tokens.indexOf(token);
  if (idx >= 0) sh.getRange(idx + 2, 5).setValue(new Date());
  return { ok: true };
}

function requireSession(token) {
  if (!token) throw new Error('AUTH: not signed in');
  var cached = CacheService.getScriptCache().get('sess_' + token);
  if (cached) return JSON.parse(cached);

  var data = sessionsSheet().getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      if (new Date(data[i][4]) < new Date()) throw new Error('AUTH: session expired');
      var session = { username: data[i][1], displayName: data[i][2], role: data[i][3] };
      CacheService.getScriptCache().put('sess_' + token, JSON.stringify(session), 21600);
      return session;
    }
  }
  throw new Error('AUTH: invalid session');
}

/* ------------------------------------------------------------------ *
 *  Drive helpers
 * ------------------------------------------------------------------ */

function rootFolder() { return DriveApp.getFolderById(CONFIG.ROOT_FOLDER_ID); }

function getDates() {
  var dates = [];
  var it = rootFolder().getFolders();
  while (it.hasNext()) {
    var name = it.next().getName().trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(name)) dates.push(name);
  }
  dates.sort().reverse();
  return { ok: true, data: dates };
}

function dateFolder(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Invalid date');
  var it = rootFolder().getFoldersByName(date);
  if (!it.hasNext()) throw new Error('No folder for date ' + date);
  return it.next();
}

/** Photo subfolders of a date folder, keyed by folder type ("PEP COOLER" etc). */
function photoFolders(date) {
  var result = {};
  var it = dateFolder(date).getFolders();
  while (it.hasNext()) {
    var f = it.next();
    var base = f.getName().replace(date, '').trim().toUpperCase();
    for (var type in CONFIG.FOLDER_TYPES) {
      // tolerate variations like "MT SHELF"/"MT SHELVES", double names, etc.
      if (base.indexOf(type) === 0 || type.indexOf(base) === 0 ||
          (type === 'MT SHELVES' && /^MT SHEL/.test(base))) {
        result[type] = f.getId();
      }
    }
  }
  return result;
}

function getFolders(date) {
  return { ok: true, data: Object.keys(photoFolders(date)) };
}

/** Map _id -> [{fileId, name}] for the images of one folder type. Cached 20 min. */
function imageMap(date, folderType) {
  var cacheKey = 'imgs|' + date + '|' + folderType;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);

  var folders = photoFolders(date);
  if (!folders[folderType]) throw new Error('Folder "' + folderType + '" not found for ' + date);
  var map = {};
  var it = DriveApp.getFolderById(folders[folderType]).getFiles();
  while (it.hasNext()) {
    var f = it.next();
    var m = f.getName().match(/(\d{5,})\s*(?:\(\d+\))?\.[A-Za-z]+$/);
    if (!m) continue;
    var id = m[1];
    (map[id] = map[id] || []).push({ fileId: f.getId(), name: f.getName() });
  }
  try { cache.put(cacheKey, JSON.stringify(map), 1200); } catch (e) { /* too big for cache — fine */ }
  return map;
}

function getImage(fileId) {
  if (!fileId) throw new Error('fileId required');
  var blob = DriveApp.getFileById(fileId).getBlob();
  return { ok: true, data: { mime: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) } };
}

/* ------------------------------------------------------------------ *
 *  QC sheet (per-date copy of the Kobo file + QC columns)
 * ------------------------------------------------------------------ */

function outputFolder() {
  var id = PROPS.getProperty('OUT_FOLDER_ID');
  if (!id) throw new Error('Run setup() first');
  return DriveApp.getFolderById(id);
}

/** Returns the spreadsheet id of "QC RD <date>", creating it from the Kobo xlsx if needed. */
function ensureQcSheet(date) {
  var propKey = 'QC_' + date;
  var cached = PROPS.getProperty(propKey);
  if (cached) {
    try { SpreadsheetApp.openById(cached); return cached; } catch (e) { PROPS.deleteProperty(propKey); }
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    cached = PROPS.getProperty(propKey);
    if (cached) return cached;

    var name = CONFIG.QC_SHEET_PREFIX + date;
    var existing = outputFolder().getFilesByName(name);
    var ssId;
    if (existing.hasNext()) {
      ssId = existing.next().getId();
    } else {
      // find the Kobo xlsx inside the date folder
      var src = null;
      var it = dateFolder(date).getFiles();
      while (it.hasNext()) {
        var f = it.next();
        if (f.getName().indexOf(CONFIG.KOBO_FILE_PREFIX) === 0) { src = f; break; }
      }
      if (!src) throw new Error('No "' + CONFIG.KOBO_FILE_PREFIX + '" excel file found in folder ' + date);

      // copy + convert xlsx -> Google Sheet (Drive advanced service, shared-drive aware)
      var copy = Drive.Files.copy(
        { name: name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [outputFolder().getId()] },
        src.getId(),
        { supportsAllDrives: true }
      );
      ssId = copy.id;
    }

    appendQcColumns(ssId);
    PROPS.setProperty(propKey, ssId);
    return ssId;
  } finally {
    lock.releaseLock();
  }
}

function qcColName(folderType, field) { return 'QC ' + folderType + ' - ' + field; }

/** Idempotently appends the per-folder-type QC columns after the Kobo columns. */
function appendQcColumns(ssId) {
  var sh = SpreadsheetApp.openById(ssId).getSheets()[0];
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var missing = [];
  Object.keys(CONFIG.FOLDER_TYPES).forEach(function (type) {
    CONFIG.QC_FIELDS.forEach(function (field) {
      var h = qcColName(type, field);
      if (headers.indexOf(h) === -1) missing.push(h);
    });
  });
  if (missing.length) {
    sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  }
}

/** Cached header row + id column values of the QC sheet for a date. */
function qcSheetInfo(date) {
  var ssId = ensureQcSheet(date);
  var sh = SpreadsheetApp.openById(ssId).getSheets()[0];
  var lastCol = sh.getLastColumn();
  var lastRow = sh.getLastRow();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h); });
  return { ssId: ssId, sheet: sh, headers: headers, lastRow: lastRow, lastCol: lastCol };
}

function headerIndex(headers, name) {
  var i = headers.indexOf(name);
  if (i === -1) throw new Error('Column not found: ' + name);
  return i; // 0-based
}

/** 0-based column indexes shown for a folder type. */
function measureIndexes(headers, folderType) {
  var spec = CONFIG.FOLDER_TYPES[folderType];
  if (!spec) throw new Error('Unknown folder type: ' + folderType);
  if (spec.headers) {
    return spec.headers.map(function (h) { return headerIndex(headers, h); });
  }
  var startMarker = spec.range[0], endMarker = spec.range[1];
  var first = -1, last = -1;
  headers.forEach(function (h, i) {
    if (h.indexOf(startMarker + ':') === 0 && first === -1) first = i;
    if (h.indexOf(endMarker + ':') === 0) last = i;
  });
  if (first === -1 || last === -1 || last < first) {
    throw new Error('Could not locate columns ' + startMarker + ' … ' + endMarker + ' for ' + folderType);
  }
  var idx = [];
  for (var i = first; i <= last; i++) idx.push(i);
  return idx;
}

/* ------------------------------------------------------------------ *
 *  Filters / queue / record
 * ------------------------------------------------------------------ */

function getFilters(date) {
  var info = qcSheetInfo(date);
  var n = info.lastRow - 1;
  if (n < 1) return { ok: true, data: { cities: [], auditors: [], channels: [] } };

  function uniqueCol(headerName) {
    var col = headerIndex(info.headers, headerName) + 1;
    var vals = info.sheet.getRange(2, col, n, 1).getValues();
    var seen = {};
    vals.forEach(function (r) { var v = String(r[0]).trim(); if (v && v !== 'null') seen[v] = 1; });
    return Object.keys(seen).sort();
  }
  return { ok: true, data: {
    cities:   uniqueCol(CONFIG.FILTERS.city),
    auditors: uniqueCol(CONFIG.FILTERS.auditor),
    channels: uniqueCol(CONFIG.FILTERS.channel)
  } };
}

/**
 * Builds the QC queue: survey rows that have a photo in the selected folder,
 * filtered by city/auditor/channel, sorted by _id.
 */
function getQueue(p) {
  var date = p.date, folderType = p.folderType;
  var info = qcSheetInfo(date);
  var imgs = imageMap(date, folderType);
  var n = info.lastRow - 1;
  if (n < 1) return { ok: true, data: { items: [], unmatchedImages: 0 } };

  var cId      = headerIndex(info.headers, CONFIG.ID_HEADER);
  var cCity    = headerIndex(info.headers, CONFIG.FILTERS.city);
  var cAuditor = headerIndex(info.headers, CONFIG.FILTERS.auditor);
  var cChannel = headerIndex(info.headers, CONFIG.FILTERS.channel);
  var cStoreId = headerIndex(info.headers, 'Select Store ID');
  var cStore   = headerIndex(info.headers, 'Select Store Name');
  var cStatus  = headerIndex(info.headers, qcColName(folderType, 'Status'));
  var cUser    = headerIndex(info.headers, qcColName(folderType, 'User'));

  var data = info.sheet.getRange(2, 1, n, info.lastCol).getValues();
  var items = [];
  var matchedIds = {};
  data.forEach(function (row) {
    var id = String(row[cId]).replace(/\.0$/, '').trim();
    if (!id || !imgs[id]) return;
    if (p.city    && String(row[cCity]).trim()    !== p.city)    return;
    if (p.auditor && String(row[cAuditor]).trim() !== p.auditor) return;
    if (p.channel && String(row[cChannel]).trim() !== p.channel) return;
    matchedIds[id] = 1;
    items.push({
      id: id,
      city: String(row[cCity]),
      auditor: String(row[cAuditor]),
      storeId: String(row[cStoreId]),
      storeName: String(row[cStore]),
      channel: String(row[cChannel]),
      qcStatus: String(row[cStatus] || ''),
      qcUser: String(row[cUser] || ''),
      imageCount: imgs[id].length
    });
  });
  items.sort(function (a, b) { return Number(a.id) - Number(b.id); });

  var unmatched = Object.keys(imgs).filter(function (id) { return !matchedIds[id]; }).length;
  return { ok: true, data: { items: items, unmatchedImages: unmatched } };
}

/** Full detail for one survey id: context, editable measures, image references. */
function getRecord(p) {
  var date = p.date, folderType = p.folderType, id = String(p.id);
  var info = qcSheetInfo(date);
  var rowNum = findRowById(info, id);
  var row = info.sheet.getRange(rowNum, 1, 1, info.lastCol).getValues()[0];

  var context = CONFIG.CONTEXT_HEADERS.map(function (h) {
    var i = info.headers.indexOf(h);
    return { label: h, value: i === -1 ? '' : fmtValue(row[i]) };
  });
  context.unshift({ label: '_id', value: id });

  var measures = measureIndexes(info.headers, folderType).map(function (i) {
    var header = info.headers[i];
    var readOnly = header.charAt(0) === '_' || /_URL$/.test(header);
    // options for select-type questions come from sibling "Header/Option" columns
    var options = [];
    if (!readOnly && header.indexOf('/') === -1) {
      info.headers.forEach(function (h) {
        if (h.indexOf(header + '/') === 0) options.push(h.slice(header.length + 1));
      });
    }
    return {
      header: header,
      value: fmtValue(row[i]),
      readOnly: readOnly,
      isOption: header.indexOf('/') !== -1,
      options: options
    };
  });

  var qc = {};
  CONFIG.QC_FIELDS.forEach(function (f) {
    var i = info.headers.indexOf(qcColName(folderType, f));
    if (i !== -1) qc[f.toLowerCase()] = fmtValue(row[i]);
  });

  var imgs = (imageMap(date, folderType)[id] || []).map(function (f) {
    return { fileId: f.fileId, name: f.name, directUrl: 'https://lh3.googleusercontent.com/d/' + f.fileId };
  });

  return { ok: true, data: { id: id, rowNum: rowNum, context: context, measures: measures, images: imgs, qc: qc } };
}

function findRowById(info, id) {
  var cId = headerIndex(info.headers, CONFIG.ID_HEADER) + 1;
  var vals = info.sheet.getRange(2, cId, info.lastRow - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).replace(/\.0$/, '').trim() === id) return i + 2;
  }
  throw new Error('Survey _id ' + id + ' not found in QC sheet');
}

function fmtValue(v) {
  if (v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }
  return String(v);
}

/* ------------------------------------------------------------------ *
 *  Save QC
 * ------------------------------------------------------------------ */

/**
 * p = { date, folderType, id, changes: {header: newValue}, qcStart, qcEnd,
 *       status: 'DONE'|'FLAGGED', remarks }
 */
function saveQC(p, session) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var info = qcSheetInfo(p.date);
    var rowNum = findRowById(info, String(p.id));
    var row = info.sheet.getRange(rowNum, 1, 1, info.lastCol).getValues()[0];

    var allowed = measureIndexes(info.headers, p.folderType);
    var changes = p.changes || {};
    var applied = {};

    Object.keys(changes).forEach(function (header) {
      var i = info.headers.indexOf(header);
      if (i === -1 || allowed.indexOf(i) === -1) return; // only columns of this folder type
      var oldVal = fmtValue(row[i]);
      var newVal = changes[header];
      if (String(newVal) === oldVal) return;

      var write = (newVal !== '' && !isNaN(Number(newVal)) && String(newVal).trim() !== '') ? Number(newVal) : newVal;
      info.sheet.getRange(rowNum, i + 1).setValue(write);
      applied[header] = { from: oldVal, to: String(newVal) };

      // keep the 0/1 dummy option columns in sync when a parent select changes
      if (header.indexOf('/') === -1) {
        info.headers.forEach(function (h, j) {
          if (h.indexOf(header + '/') === 0) {
            var opt = h.slice(header.length + 1);
            var on = String(newVal) === opt || String(newVal).indexOf(opt) !== -1;
            info.sheet.getRange(rowNum, j + 1).setValue(on ? 1 : 0);
          }
        });
      }
    });

    var status = p.status === 'FLAGGED' ? 'FLAGGED' : 'DONE';
    var qcVals = {
      'User':    session.username,
      'Start':   p.qcStart || '',
      'End':     p.qcEnd || new Date().toISOString(),
      'Status':  status,
      'Changes': Object.keys(applied).length ? JSON.stringify(applied) : '',
      'Remarks': p.remarks || ''
    };
    CONFIG.QC_FIELDS.forEach(function (f) {
      var i = info.headers.indexOf(qcColName(p.folderType, f));
      if (i !== -1) info.sheet.getRange(rowNum, i + 1).setValue(qcVals[f]);
    });

    qcLogSheet().appendRow([
      new Date(), p.date, p.folderType, String(p.id), session.username,
      p.qcStart || '', p.qcEnd || '', status,
      Object.keys(applied).length, JSON.stringify(applied), p.remarks || '',
      sessionIdFromToken(p.token)
    ]);

    return { ok: true, data: { id: String(p.id), status: status, changed: Object.keys(applied).length } };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 *  Session summaries
 * ------------------------------------------------------------------ */

/** Summary of the calling user's current login session, computed from QCLog. */
function getSessionSummary(p, session) {
  var sid = sessionIdFromToken(p.token);
  var data = qcLogSheet().getDataRange().getValues();
  var hdr = data.length ? data[0].map(String) : [];
  var iSid = hdr.indexOf('sessionId'), iSaved = hdr.indexOf('savedAt'),
      iCount = hdr.indexOf('changeCount'), iStatus = hdr.indexOf('status'),
      iDate = hdr.indexOf('date'), iFolder = hdr.indexOf('folderType'), iId = hdr.indexOf('_id');

  var photos = {}, saves = 0, changes = 0, flagged = 0, first = null, last = null, byFolder = {};
  for (var r = 1; r < data.length; r++) {
    if (iSid === -1 || String(data[r][iSid] || '') !== sid) continue;
    var saved = new Date(data[r][iSaved]);
    saves++;
    changes += Number(data[r][iCount]) || 0;
    if (String(data[r][iStatus]) === 'FLAGGED') flagged++;
    var pKey = data[r][iDate] + '|' + data[r][iFolder] + '|' + data[r][iId];
    photos[pKey] = 1;
    var f = byFolder[data[r][iFolder]] = byFolder[data[r][iFolder]] || { folderType: String(data[r][iFolder]), photos: {}, changes: 0 };
    f.photos[pKey] = 1;
    f.changes += Number(data[r][iCount]) || 0;
    if (!first || saved < first) first = saved;
    if (!last || saved > last) last = saved;
  }

  // session start = login time (falls back to the first save for old sessions)
  var loginAt = null;
  var sess = sessionsSheet().getDataRange().getValues();
  for (var i = 1; i < sess.length; i++) {
    if (String(sess[i][0]) === String(p.token)) {
      if (sess[i][5]) loginAt = new Date(sess[i][5]);
      break;
    }
  }
  var start = loginAt || first;
  return { ok: true, data: {
    username: session.username,
    displayName: session.displayName,
    photosAudited: Object.keys(photos).length,
    saves: saves,
    changesMade: changes,
    flagged: flagged,
    sessionStart: start ? fmtValue(start) : '',
    lastSave: last ? fmtValue(last) : '',
    totalMinutes: start ? Math.max(0, Math.round((new Date() - start) / 60000)) : 0,
    byFolder: Object.keys(byFolder).map(function (k) {
      return { folderType: byFolder[k].folderType, photos: Object.keys(byFolder[k].photos).length, changes: byFolder[k].changes };
    })
  } };
}

/** Admin report: one row per login session with QC activity (latest 100). */
function listSessions() {
  var data = qcLogSheet().getDataRange().getValues();
  if (data.length < 2) return { ok: true, data: [] };
  var hdr = data[0].map(String);
  var iSid = hdr.indexOf('sessionId'), iSaved = hdr.indexOf('savedAt'),
      iCount = hdr.indexOf('changeCount'), iStatus = hdr.indexOf('status'),
      iDate = hdr.indexOf('date'), iFolder = hdr.indexOf('folderType'),
      iId = hdr.indexOf('_id'), iUser = hdr.indexOf('qcUser');

  // login time per session id
  var loginAt = {};
  var sess = sessionsSheet().getDataRange().getValues();
  for (var i = 1; i < sess.length; i++) {
    if (sess[i][5]) loginAt[sessionIdFromToken(sess[i][0])] = new Date(sess[i][5]);
  }

  var groups = {};
  for (var r = 1; r < data.length; r++) {
    var row = data[r];
    var saved = new Date(row[iSaved]);
    var sid = iSid !== -1 ? String(row[iSid] || '') : '';
    // saves from before this feature have no sessionId: group them per user + day
    var key = sid || (String(row[iUser]) + '|' + Utilities.formatDate(saved, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    var g = groups[key] = groups[key] || { sid: sid, username: String(row[iUser]), photos: {}, saves: 0, changes: 0, flagged: 0, first: saved, last: saved };
    g.saves++;
    g.changes += Number(row[iCount]) || 0;
    if (String(row[iStatus]) === 'FLAGGED') g.flagged++;
    g.photos[row[iDate] + '|' + row[iFolder] + '|' + row[iId]] = 1;
    if (saved < g.first) g.first = saved;
    if (saved > g.last) g.last = saved;
  }

  var out = Object.keys(groups).map(function (k) {
    var g = groups[k];
    var start = (g.sid && loginAt[g.sid] && loginAt[g.sid] < g.first) ? loginAt[g.sid] : g.first;
    return {
      username: g.username,
      start: fmtValue(start),
      end: fmtValue(g.last),
      durationMin: Math.max(0, Math.round((g.last - start) / 60000)),
      photos: Object.keys(g.photos).length,
      saves: g.saves,
      changes: g.changes,
      flagged: g.flagged
    };
  });
  out.sort(function (a, b) { return a.end < b.end ? 1 : -1; });
  return { ok: true, data: out.slice(0, 100) };
}

/* ------------------------------------------------------------------ *
 *  Admin
 * ------------------------------------------------------------------ */

function listUsers() {
  var data = usersSheet().getDataRange().getValues();
  var users = [];
  for (var i = 1; i < data.length; i++) {
    users.push({
      username: data[i][0], displayName: data[i][1], role: data[i][2],
      active: data[i][5] === true || data[i][5] === 'TRUE',
      createdAt: fmtValue(data[i][6]), createdBy: data[i][7]
    });
  }
  return { ok: true, data: users };
}

function createUser(p, session) {
  if (!p.username || !p.password) throw new Error('Username and password required');
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(p.username)) throw new Error('Username: 3-30 chars, letters/digits/._- only');
  if (String(p.password).length < 6) throw new Error('Password must be at least 6 characters');
  if (findUser(p.username)) throw new Error('User already exists');
  var salt = Utilities.getUuid();
  usersSheet().appendRow([
    p.username, p.displayName || p.username, p.role === 'admin' ? 'admin' : 'qc',
    salt, hashPassword(salt, p.password), true, new Date(), session.username
  ]);
  return { ok: true };
}

function setPassword(p) {
  var u = findUser(p.username);
  if (!u) throw new Error('User not found');
  if (String(p.password).length < 6) throw new Error('Password must be at least 6 characters');
  var salt = Utilities.getUuid();
  usersSheet().getRange(u.row, 4, 1, 2).setValues([[salt, hashPassword(salt, p.password)]]);
  return { ok: true };
}

function setActive(p) {
  var u = findUser(p.username);
  if (!u) throw new Error('User not found');
  usersSheet().getRange(u.row, 6).setValue(p.active === true);
  return { ok: true };
}

/** QC progress per folder type for a date: total images, matched rows, done, flagged. */
function getProgress(date) {
  var info = qcSheetInfo(date);
  var folders = photoFolders(date);
  var n = info.lastRow - 1;
  var cId = headerIndex(info.headers, CONFIG.ID_HEADER);
  var ids = n > 0 ? info.sheet.getRange(2, cId + 1, n, 1).getValues().map(function (r) { return String(r[0]).replace(/\.0$/, '').trim(); }) : [];

  var result = [];
  Object.keys(folders).forEach(function (type) {
    var imgs = imageMap(date, type);
    var cStatus = info.headers.indexOf(qcColName(type, 'Status'));
    var statuses = (cStatus !== -1 && n > 0) ? info.sheet.getRange(2, cStatus + 1, n, 1).getValues() : [];
    var done = 0, flagged = 0, matched = 0;
    ids.forEach(function (id, i) {
      if (!imgs[id]) return;
      matched++;
      var s = statuses[i] ? String(statuses[i][0]) : '';
      if (s === 'DONE') done++;
      if (s === 'FLAGGED') flagged++;
    });
    result.push({
      folderType: type,
      images: Object.keys(imgs).length,
      matched: matched,
      done: done,
      flagged: flagged,
      pending: matched - done - flagged
    });
  });
  return { ok: true, data: { date: date, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + info.ssId, progress: result } };
}

/** Exports "QC RD <date>" as xlsx (base64) so the browser can download it. */
function exportQc(date) {
  var ssId = ensureQcSheet(date);
  var url = 'https://docs.google.com/spreadsheets/d/' + ssId + '/export?format=xlsx';
  var resp = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } });
  return { ok: true, data: {
    filename: CONFIG.QC_SHEET_PREFIX + date + '.xlsx',
    base64: Utilities.base64Encode(resp.getContent())
  } };
}

/* ------------------------------------------------------------------ *
 *  Utils
 * ------------------------------------------------------------------ */

function colValues(sheet, col) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
}
