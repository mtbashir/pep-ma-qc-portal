/**
 * TO CHECK THE BACKEND: pick "diagnose" in the function dropdown and press Run.
 * Anything else in that dropdown is an internal helper and will error if run
 * on its own — that is not a fault, it just needs arguments.
 *
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
  // Bumped whenever this file changes. Open the web app URL in a browser to
  // see which version is actually deployed — the editor's "Deploy" button
  // keeps serving the old snapshot unless you pick Version: "New version".
  VERSION: '4.0',

  QUEUE_FIRST_PAGE: 60,     // shown immediately
  QUEUE_PAGE: 150,          // fetched in the background afterwards

  // Root Drive folder that contains one subfolder per day (YYYY-MM-DD)
  ROOT_FOLDER_ID: '15r9ltXPk4Ehc2ViR-UJ6277lmjbI9o2m',

  DB_NAME: 'PEP MA QC Portal DB',          // master spreadsheet (Users/Sessions/QCLog)
  OUTPUT_FOLDER_NAME: 'PEP MA QC OUTPUT',  // folder that receives the QC RD copies
  QC_SHEET_PREFIX: 'QC RD ',               // per-date QC copy name = prefix + date
  KOBO_FILE_PREFIX: 'KOBO RD',             // source excel name inside each date folder

  // Half-month combined sheets: "QC RD <YYYY-MM>-H1" (1st-15th) and "-H2"
  // (16th-end of month). A build stops adding dates after HALF_BUDGET_MS so it
  // stays inside one execution, and the next call resumes where it stopped.
  SOURCE_DATE_HEADER: 'QC Source Date',
  HALF_BUDGET_MS: 240000,
  HALF_APPEND_CELLS: 50000,
  // Refresh each date's QC sheet from its Kobo workbook before combining it.
  // QC sheets are snapshots taken when a date is first opened, so without this
  // the half-month file inherits whatever rows were missing from them. Costs a
  // Drive copy + full read per date, so it roughly doubles build time.
  HALF_REFRESH: true,

  // Reporting format: the half-month sheet rewritten into the 402 columns the
  // reporting pack expects (column map in ReportMap.gs).
  REPORT_SHEET_PREFIX: 'REPORTING ',
  REPORT_CHUNK_CELLS: 90000,
  REPORT_STRICT: true,        // stop rather than emit a report built on a shifted layout

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
 *  Fast data access
 *
 *  SpreadsheetApp is slow on a 400x400 sheet (it loads the whole model
 *  on open). These helpers talk to the Sheets REST API directly with the
 *  script's own OAuth token, so a read costs one HTTP call for exactly
 *  the ranges asked for. No extra Apps Script service needs enabling —
 *  the spreadsheets + external_request scopes are already granted.
 * ------------------------------------------------------------------ */

/**
 * Reads/writes go through the Sheets advanced service when it is available
 * (Editor -> Services + -> "Sheets API"), which is by far the fastest path.
 * If it is not enabled the same calls fall back to SpreadsheetApp with the
 * identical targeted ranges — slower, but the portal keeps working.
 */
var _sheetsBroken = false;
var _ssMemo = {};

function openSs(ssId) {
  if (!ssId) {
    throw new Error('openSs() is an internal helper and cannot be run on its own. ' +
      'Pick "diagnose" (or "setup") in the function dropdown before pressing Run.');
  }
  if (!_ssMemo[ssId]) _ssMemo[ssId] = SpreadsheetApp.openById(ssId);
  return _ssMemo[ssId];
}

function sheetsReady() {
  if (_sheetsBroken) return false;
  try { return (typeof Sheets !== 'undefined') && !!(Sheets && Sheets.Spreadsheets); }
  catch (e) { return false; }
}

/** Remember, for this execution, that the advanced service is unusable. */
function sheetsFailed(e) {
  _sheetsBroken = true;
  console.warn('Sheets advanced service unavailable, falling back to SpreadsheetApp: ' + (e && e.message));
}

function transpose(rows) {
  var out = [];
  var width = rows.reduce(function (w, r) { return Math.max(w, r.length); }, 0);
  for (var c = 0; c < width; c++) {
    out.push(rows.map(function (r) { return r[c] === undefined ? '' : r[c]; }));
  }
  return out;
}

/** A1 range helper: quotes a sheet name safely. */
function quoteSheet(name) { return "'" + String(name).replace(/'/g, "''") + "'"; }

/** 1-based column number -> letter(s), e.g. 1 -> A, 401 -> OK. */
function colLetter(n) {
  var s = '';
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - m - 1) / 26); }
  return s;
}

function valuesBatchGet(ssId, ranges, majorDimension) {
  if (!ranges.length) return [];
  var md = majorDimension || 'ROWS';

  if (sheetsReady()) {
    try {
      var res = Sheets.Spreadsheets.Values.batchGet(ssId, {
        ranges: ranges,
        majorDimension: md,
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      });
      return res.valueRanges || [];
    } catch (e) { sheetsFailed(e); }
  }

  var ss = openSs(ssId);
  return ranges.map(function (r) {
    var vals;
    try { vals = ss.getRange(r).getValues(); } catch (e) { vals = []; }
    return { values: md === 'COLUMNS' ? transpose(vals) : vals };
  });
}

/** data = [{range, values}] — written in a single call where possible. */
function valuesBatchUpdate(ssId, data) {
  if (!data.length) return;

  if (sheetsReady()) {
    try {
      Sheets.Spreadsheets.Values.batchUpdate({ valueInputOption: 'RAW', data: data }, ssId);
      return;
    } catch (e) { sheetsFailed(e); }
  }

  var ss = openSs(ssId);
  data.forEach(function (d) { ss.getRange(d.range).setValues(d.values); });
  SpreadsheetApp.flush();
}

/** First (or only) row/column of a batchGet result, never undefined. */
function firstLine(valueRange) {
  return (valueRange && valueRange.values && valueRange.values[0]) || [];
}

/* ---- chunked cache (CacheService caps a single value at 100KB) ---- */

function cachePutBig(key, str, ttl) {
  var CHUNK = 90000;
  var n = Math.ceil(str.length / CHUNK) || 1;
  var obj = {};
  for (var i = 0; i < n; i++) obj[key + '|' + i] = str.substr(i * CHUNK, CHUNK);
  obj[key + '|n'] = String(n);
  try { CacheService.getScriptCache().putAll(obj, ttl || 21600); } catch (e) { /* cache is best-effort */ }
}

function cacheGetBig(key) {
  var cache = CacheService.getScriptCache();
  var n = Number(cache.get(key + '|n'));
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < n; i++) keys.push(key + '|' + i);
  var got = cache.getAll(keys);
  var out = '';
  for (var j = 0; j < n; j++) {
    var part = got[key + '|' + j];
    if (part === undefined || part === null) return null; // partially evicted -> rebuild
    out += part;
  }
  return out;
}

/**
 * Today's folder is still being filled by the field team, so its data is
 * cached only briefly. Past dates are settled and cached for hours.
 */
function cacheTtl(date) {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return date === today ? 180 : 21600;
}

/** Bumped when a date is refreshed, so every cached key for it is bypassed. */
function dateGen(date) {
  return PROPS.getProperty('GEN_' + date) || '0';
}

function bumpDateGen(date) {
  PROPS.setProperty('GEN_' + date, String(Number(dateGen(date)) + 1));
}

function cacheDropBig(key) {
  var n = Number(CacheService.getScriptCache().get(key + '|n'));
  var keys = [key + '|n'];
  for (var i = 0; i < (n || 0); i++) keys.push(key + '|' + i);
  try { CacheService.getScriptCache().removeAll(keys); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 *  HTTP entry points
 * ------------------------------------------------------------------ */

function doGet(e) {
  var p = (e && e.parameter) || {};

  // Health check over HTTP so it can be run without touching the editor.
  // Requires an admin session token, same as every other privileged action.
  if (p.run === 'diagnose') {
    try {
      var session = requireSession(p.token);
      if (session.role !== 'admin') throw new Error('Admin access required');
      return jsonOut({ ok: true, data: diagnoseReport() });
    } catch (err) {
      return jsonOut({ ok: false, error: String((err && err.message) || err) });
    }
  }

  return jsonOut({
    ok: true,
    service: 'PEP MA QC Portal API',
    version: CONFIG.VERSION,
    time: new Date().toISOString()
  });
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
    case 'bootstrap':  return bootstrap(p);
    case 'refreshDate': return refreshDate(p);
    case 'getDates':   return getDates();
    case 'getFolders': return getFolders(p.date);
    case 'getFilters': return getFilters(p.date);
    case 'getQueue':   return getQueue(p);
    case 'getRecord':  return getRecord(p);
    case 'getImage':   return getImage(p.fileId, p.size);
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
    case 'listHalfMonths': return listHalfMonths();
    case 'buildHalfMonth': return buildHalfMonth(p);
    case 'buildReporting': return buildReporting(p);
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

/**
 * Health check — run this from the editor (function dropdown -> diagnose -> Run)
 * and read the Execution log.
 *
 * It times each stage INSIDE the script. If these numbers are small but the
 * portal still feels slow, the delay is Google's request/redirect layer or
 * execution queueing, not this code — in that case the fix is to wait it out
 * or check quota, not to change the script.
 */
function diagnose() {
  console.log(diagnoseReport().join('\n'));
}

/** Builds the health-check report as an array of lines. */
function diagnoseReport() {
  var out = [];
  function line(s) { out.push(s); }
  function time(label, fn) {
    var t0 = Date.now();
    try {
      var r = fn();
      line('  ' + label + ': ' + (Date.now() - t0) + ' ms' + (r === undefined ? '' : ' — ' + r));
    } catch (e) {
      line('  ' + label + ': FAILED after ' + (Date.now() - t0) + ' ms — ' + e.message);
    }
  }

  line('PEP MA QC Portal backend v' + CONFIG.VERSION);
  line('');
  line('Services');
  line('  Sheets advanced service: ' + (sheetsReady()
    ? 'ENABLED (fast path)'
    : 'NOT ENABLED — add it via Services + -> Sheets API, or the slower SpreadsheetApp fallback is used'));
  line('  Drive advanced service:  ' + ((typeof Drive !== 'undefined' && Drive.Files) ? 'ENABLED' : 'MISSING — add via Services + -> Drive API v3'));
  line('  DB spreadsheet:          ' + (PROPS.getProperty('DB_ID') ? 'created' : 'MISSING — run setup()'));
  line('  Output folder:           ' + (PROPS.getProperty('OUT_FOLDER_ID') ? 'created' : 'MISSING — run setup()'));
  line('');

  var dates = [];
  line('Drive');
  time('list dates', function () {
    dates = getDates().data;
    return dates.length + ' date folders (newest ' + (dates[0] || 'none') + ')';
  });
  if (!dates.length) return out;

  var date = dates[0];
  var folders = {};
  time('photo folders for ' + date, function () {
    folders = photoFolders(date);
    return Object.keys(folders).join(', ') || 'none';
  });

  var folderType = Object.keys(folders)[0];
  if (!folderType) return out;

  time('photo list (' + folderType + ')', function () {
    return Object.keys(imageMap(date, folderType)).length + ' photos';
  });
  line('');

  line('Sheet (' + date + ')');
  var idx = null;
  time('build/read index', function () {
    idx = dateIndex(date);
    var missing = expectedQcColumns().filter(function (h) { return idx.headers.indexOf(h) === -1; });
    return idx.headers.length + ' columns, ' + Object.keys(idx.idToRow).length + ' survey rows' +
      (missing.length ? ' — WARNING: ' + missing.length + ' QC columns missing' : ', QC columns OK');
  });
  if (idx) {
    // which configured columns this survey version actually still has
    var expectedCore = [CONFIG.ID_HEADER, CONFIG.FILTERS.city, CONFIG.FILTERS.auditor,
                        CONFIG.FILTERS.channel, 'Select Store ID', 'Select Store Name']
      .concat(CONFIG.CONTEXT_HEADERS);
    var absent = expectedCore.filter(function (h, i, a) {
      return a.indexOf(h) === i && idx.headers.indexOf(h) === -1;
    });
    line('  survey columns: ' + (absent.length
      ? absent.length + ' configured column(s) not in this survey version — ' + absent.join('; ')
      : 'all configured columns present'));
    Object.keys(CONFIG.FOLDER_TYPES).forEach(function (type) {
      line('    ' + type + ': ' + measureIndexes(idx.headers, type).length + ' measure columns');
    });

    time('filters', function () {
      var f = getFilters(date).data;
      return f.cities.length + ' cities, ' + f.auditors.length + ' auditors';
    });
    time('queue page (first 60)', function () {
      var q = getQueue({ date: date, folderType: folderType, limit: 60, offset: 0 }).data;
      return q.items.length + ' of ' + q.total + ' photos';
    });
    time('queue page (next 150)', function () {
      var q = getQueue({ date: date, folderType: folderType, limit: 150, offset: 60 }).data;
      return q.items.length + ' photos';
    });
  }

  line('');
  line('If the numbers above are small (a few seconds) but the portal is slow,');
  line('the delay is in Google request handling, not this script.');
  return out;
}

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

/**
 * Lists a Drive folder in as few calls as possible.
 * DriveApp iterators cost a round trip per file for getName()/getId();
 * Drive.Files.list returns 1000 files per call with just the fields we need.
 */
function driveList(parentId, mimeFilter) {
  var out = [];
  var token = null;
  var q = "'" + parentId + "' in parents and trashed = false" +
    (mimeFilter === 'folder' ? " and mimeType = 'application/vnd.google-apps.folder'" : '');
  do {
    var res = Drive.Files.list({
      q: q,
      fields: 'nextPageToken, files(id,name,mimeType)',
      pageSize: 1000,
      orderBy: 'name',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken: token
    });
    out = out.concat(res.files || []);
    token = res.nextPageToken;
  } while (token);
  return out;
}

function getDates() {
  var key = 'dates3';
  var hit = cacheGetBig(key);
  if (hit) return { ok: true, data: JSON.parse(hit) };
  var dates = driveList(CONFIG.ROOT_FOLDER_ID, 'folder')
    .map(function (f) { return f.name.trim(); })
    .filter(function (n) { return /^\d{4}-\d{2}-\d{2}$/.test(n); })
    .sort().reverse();
  cachePutBig(key, JSON.stringify(dates), 600); // short: new dates appear daily
  return { ok: true, data: dates };
}

function dateFolderId(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Invalid date');
  var key = 'datefolder3|' + date;
  var hit = CacheService.getScriptCache().get(key);
  if (hit) return hit;
  var match = driveList(CONFIG.ROOT_FOLDER_ID, 'folder').filter(function (f) { return f.name.trim() === date; })[0];
  if (!match) throw new Error('No folder for date ' + date);
  try { CacheService.getScriptCache().put(key, match.id, 21600); } catch (e) { /* ignore */ }
  return match.id;
}

/** Photo subfolders of a date folder, keyed by folder type ("PEP COOLER" etc). */
function photoFolders(date) {
  var key = 'folders3|' + dateGen(date) + '|' + date;
  var hit = cacheGetBig(key);
  if (hit) return JSON.parse(hit);

  var result = {};
  driveList(dateFolderId(date), 'folder').forEach(function (f) {
    var base = f.name.replace(date, '').trim().toUpperCase();
    for (var type in CONFIG.FOLDER_TYPES) {
      // tolerate variations like "MT SHELF"/"MT SHELVES", double names, etc.
      if (base.indexOf(type) === 0 || type.indexOf(base) === 0 ||
          (type === 'MT SHELVES' && /^MT SHEL/.test(base))) {
        result[type] = f.id;
      }
    }
  });
  cachePutBig(key, JSON.stringify(result), cacheTtl(date));
  return result;
}

function getFolders(date) {
  return { ok: true, data: Object.keys(photoFolders(date)) };
}

/** Map _id -> [{fileId, name}] for the images of one folder type. Cached 6 h. */
function imageMap(date, folderType) {
  var key = 'imgs3|' + dateGen(date) + '|' + date + '|' + folderType;
  var hit = cacheGetBig(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }

  var folders = photoFolders(date);
  if (!folders[folderType]) throw new Error('Folder "' + folderType + '" not found for ' + date);
  var map = {};
  driveList(folders[folderType]).forEach(function (f) {
    var m = f.name.match(/(\d{5,})\s*(?:\(\d+\))?\.[A-Za-z]+$/);
    if (!m) return;
    (map[m[1]] = map[m[1]] || []).push({ fileId: f.id, name: f.name });
  });
  cachePutBig(key, JSON.stringify(map), cacheTtl(date));
  return map;
}

/**
 * Returns a photo as base64. Uses Drive's pre-rendered thumbnail at the
 * requested size (typically ~10x smaller than the original) and only falls
 * back to the full-resolution file if no thumbnail is available.
 */
function getImage(fileId, size) {
  if (!fileId) throw new Error('fileId required');
  size = Math.min(Math.max(Number(size) || 1600, 200), 4000);
  try {
    var meta = Drive.Files.get(fileId, { fields: 'thumbnailLink', supportsAllDrives: true });
    if (meta && meta.thumbnailLink) {
      var url = meta.thumbnailLink.replace(/=s\d+([^\/]*)$/, '=s' + size);
      var resp = UrlFetchApp.fetch(url, {
        headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
        muteHttpExceptions: true
      });
      if (resp.getResponseCode() === 200) {
        var b = resp.getBlob();
        return { ok: true, data: { mime: b.getContentType(), base64: Utilities.base64Encode(b.getBytes()), thumb: true } };
      }
    }
  } catch (e) { /* fall through to the original file */ }
  var blob = DriveApp.getFileById(fileId).getBlob();
  return { ok: true, data: { mime: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()), thumb: false } };
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
  // trust the stored id — validating it with an open() costs seconds on every
  // request; dateIndex() busts the property if the file has really gone away
  if (cached) return cached;

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
      var src = driveList(dateFolderId(date)).filter(function (f) {
        return f.name.indexOf(CONFIG.KOBO_FILE_PREFIX) === 0;
      })[0];
      if (!src) throw new Error('No "' + CONFIG.KOBO_FILE_PREFIX + '" excel file found in folder ' + date);

      // copy + convert xlsx -> Google Sheet (Drive advanced service, shared-drive aware)
      var copy = Drive.Files.copy(
        { name: name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [outputFolder().getId()] },
        src.id,
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

/**
 * Pulls survey rows that exist in the day's Kobo file but not yet in the QC
 * sheet, and appends them.
 *
 * The QC sheet is a copy taken the first time a date is opened, so anything
 * the field team uploads later in the day would otherwise never appear.
 * Existing rows are never touched — QC corrections and QC columns are safe.
 * Returns the number of rows added.
 */
function syncNewRows(date) {
  var idx = dateIndex(date, true);

  var src = driveList(dateFolderId(date)).filter(function (f) {
    return f.name.indexOf(CONFIG.KOBO_FILE_PREFIX) === 0;
  })[0];
  if (!src) throw new Error('No "' + CONFIG.KOBO_FILE_PREFIX + '" file found in folder ' + date);

  // the source is an .xlsx, so convert a throwaway copy to read it
  var temp = Drive.Files.copy(
    { name: 'TEMP KOBO ' + date + ' ' + Date.now(),
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [outputFolder().getId()] },
    src.id, { supportsAllDrives: true }
  );

  try {
    var values = SpreadsheetApp.openById(temp.id).getSheets()[0].getDataRange().getValues();
    if (values.length < 2) return 0;

    var srcHeaders = values[0].map(String);
    var srcIdCol = srcHeaders.indexOf(CONFIG.ID_HEADER);
    if (srcIdCol === -1) throw new Error('Kobo file has no "' + CONFIG.ID_HEADER + '" column');

    // match by header name, so column order/count may differ safely
    var destCol = srcHeaders.map(function (h) { return idx.headers.indexOf(h); });

    var newRows = [];
    for (var r = 1; r < values.length; r++) {
      var id = String(values[r][srcIdCol]).replace(/\.0$/, '').trim();
      if (!id || idx.idToRow[id]) continue;          // already in the QC sheet
      var row = [];
      for (var c = 0; c < idx.headers.length; c++) row.push('');
      srcHeaders.forEach(function (h, c) {
        if (destCol[c] >= 0) row[destCol[c]] = fmtValue(values[r][c]);
      });
      newRows.push(row);
    }

    if (newRows.length) {
      var start = idx.lastRow + 1;
      valuesBatchUpdate(idx.ssId, [{
        range: quoteSheet(idx.sheetName) + '!A' + start + ':' +
               colLetter(idx.headers.length) + (start + newRows.length - 1),
        values: newRows
      }]);
    }
    return newRows.length;
  } finally {
    try { DriveApp.getFileById(temp.id).setTrashed(true); } catch (e) { /* leave the temp file */ }
  }
}

/**
 * Re-reads a day from scratch: drops every cached view of it and imports any
 * survey rows added since the QC sheet was created.
 */
function refreshDate(p) {
  var date = p.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error('Invalid date');

  var added = syncNewRows(date);
  bumpDateGen(date);                 // invalidates every cached key for this date
  cacheDropBig('dates3');            // a brand new date folder may exist too

  var idx = dateIndex(date, true);
  var photos = 0;
  var folders = photoFolders(date);
  Object.keys(folders).forEach(function (t) { photos += Object.keys(imageMap(date, t)).length; });

  return { ok: true, data: {
    date: date,
    rowsAdded: added,
    surveyRows: Object.keys(idx.idToRow).length,
    photos: photos,
    folders: Object.keys(folders)
  } };
}

function qcColName(folderType, field) { return 'QC ' + folderType + ' - ' + field; }

/** Every QC column a QC sheet should carry. */
function expectedQcColumns() {
  var all = [];
  Object.keys(CONFIG.FOLDER_TYPES).forEach(function (type) {
    CONFIG.QC_FIELDS.forEach(function (field) { all.push(qcColName(type, field)); });
  });
  return all;
}

/**
 * Idempotently appends the per-folder-type QC columns after the Kobo columns.
 *
 * Converting an .xlsx gives a sheet whose grid is exactly as wide as its data,
 * so the QC headers need room made for them first. Without this the write lands
 * outside the grid and the sheet ends up with no QC columns at all — which
 * makes every queue request fail with "Column not found: QC ... - Status".
 * Returns how many columns were added.
 */
function appendQcColumns(ssId) {
  var sh = SpreadsheetApp.openById(ssId).getSheets()[0];
  var lastCol = sh.getLastColumn();
  var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);

  var missing = expectedQcColumns().filter(function (h) { return headers.indexOf(h) === -1; });
  if (!missing.length) return 0;

  var needed = lastCol + missing.length;
  var maxCols = sh.getMaxColumns();
  if (maxCols < needed) sh.insertColumnsAfter(maxCols, needed - maxCols);

  sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]);
  SpreadsheetApp.flush();
  return missing.length;
}

/**
 * Cached per-date index of the QC sheet: spreadsheet id, tab name, header row
 * and an _id -> row-number map. Built with 3 REST calls, then served from
 * cache for 6 h — this is what removes the per-request sheet scan.
 */
function dateIndex(date, forceRefresh) {
  var key = 'idx3|' + dateGen(date) + '|' + date;
  if (!forceRefresh) {
    var hit = cacheGetBig(key);
    if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }
  }

  var ssId = ensureQcSheet(date);
  var sheetName = qcTabName(ssId, date);
  var q = quoteSheet(sheetName);

  var headers = firstLine(valuesBatchGet(ssId, [q + '!1:1'])[0]).map(String);
  if (!headers.length) {                 // stale spreadsheet id — rebuild once
    PROPS.deleteProperty('QC_' + date);
    PROPS.deleteProperty('QCTAB_' + date);
    ssId = ensureQcSheet(date);
    sheetName = qcTabName(ssId, date);
    q = quoteSheet(sheetName);
    headers = firstLine(valuesBatchGet(ssId, [q + '!1:1'])[0]).map(String);
  }
  while (headers.length && headers[headers.length - 1] === '') headers.pop();

  // Self-heal: a sheet created before the grid-width fix (or by an interrupted
  // run) can be missing its QC columns, which breaks every queue request.
  // Add them now rather than leaving the date permanently unusable.
  var lacking = expectedQcColumns().filter(function (h) { return headers.indexOf(h) === -1; });
  if (lacking.length) {
    appendQcColumns(ssId);
    headers = firstLine(valuesBatchGet(ssId, [q + '!1:1'])[0]).map(String);
    while (headers.length && headers[headers.length - 1] === '') headers.pop();
  }

  var idCol = colLetter(headerIndex(headers, CONFIG.ID_HEADER) + 1);
  var ids = firstLine(valuesBatchGet(ssId, [q + '!' + idCol + '2:' + idCol], 'COLUMNS')[0]);

  var idToRow = {}, lastRow = 1;
  ids.forEach(function (v, i) {
    var id = String(v).replace(/\.0$/, '').trim();
    if (id) { idToRow[id] = i + 2; lastRow = i + 2; }
  });

  var idx = { ssId: ssId, sheetName: sheetName, headers: headers, idToRow: idToRow, lastRow: lastRow };
  cachePutBig(key, JSON.stringify(idx), cacheTtl(date));
  return idx;
}

/** Tab name of the QC sheet, resolved once and remembered. */
function qcTabName(ssId, date) {
  var key = 'QCTAB_' + date;
  var name = PROPS.getProperty(key);
  if (!name) {
    name = openSs(ssId).getSheets()[0].getName();
    PROPS.setProperty(key, name);
  }
  return name;
}

/** A1 range for a whole data column (row 2 .. last row) of the QC sheet. */
function colRange(idx, headerName) {
  var c = colLetter(headerIndex(idx.headers, headerName) + 1);
  return quoteSheet(idx.sheetName) + '!' + c + '2:' + c + idx.lastRow;
}

/** Row number for an _id, refreshing the index once if it looks stale. */
function rowForId(idx, id, date) {
  var row = idx.idToRow[String(id)];
  if (row) return { idx: idx, row: row };
  var fresh = dateIndex(date, true);
  row = fresh.idToRow[String(id)];
  if (!row) throw new Error('Survey _id ' + id + ' not found in QC sheet');
  return { idx: fresh, row: row };
}

function headerIndex(headers, name) {
  var i = headers.indexOf(name);
  if (i === -1) throw new Error('Column not found: ' + name);
  return i; // 0-based
}

/* ------------------------------------------------------------------ *
 *  Survey-version tolerance
 *
 *  Kobo forms change between versions: questions get dropped and the
 *  column count shifts, while the headers that remain keep their names.
 *  Everything below is therefore driven by header text and question
 *  number — never by column position — and a column that no longer
 *  exists is skipped rather than treated as an error.
 * ------------------------------------------------------------------ */

/** Leading question number of a header, e.g. "2.1.24a: Brand Facings…" -> "2.1.24a". */
function questionKey(header) {
  var m = String(header).match(/^(\d+(?:\.\d+[a-zA-Z]?)*)\s*:/);
  return m ? m[1] : null;
}

/** Orders question numbers naturally: 2.1.9 < 2.1.10 < 2.1.24 < 2.1.24a. */
function compareQuestion(a, b) {
  var pa = String(a).split('.'), pb = String(b).split('.');
  for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
    var x = pa[i] === undefined ? '' : pa[i];
    var y = pb[i] === undefined ? '' : pb[i];
    var nx = parseInt(x, 10); if (isNaN(nx)) nx = -1;
    var ny = parseInt(y, 10); if (isNaN(ny)) ny = -1;
    if (nx !== ny) return nx - ny;
    var sx = x.replace(/^\d+/, ''), sy = y.replace(/^\d+/, '');
    if (sx !== sy) return sx < sy ? -1 : 1;
  }
  return 0;
}

/**
 * Reads the named columns that exist, in one call.
 * Returns { headerName: [values…] } with an empty array for any column the
 * current survey version no longer has.
 */
function readNamedColumns(idx, names) {
  var present = names.filter(function (n) { return idx.headers.indexOf(n) !== -1; });
  var res = present.length
    ? valuesBatchGet(idx.ssId, present.map(function (n) { return colRange(idx, n); }), 'COLUMNS').map(firstLine)
    : [];
  var out = {};
  names.forEach(function (n) { out[n] = []; });
  present.forEach(function (n, k) { out[n] = res[k] || []; });
  return out;
}

/** Value at a row from a readNamedColumns result, '' when absent. */
function colCell(cols, name, r) {
  var v = cols[name] && cols[name][r];
  return v === undefined || v === null ? '' : String(v);
}

/**
 * Describes the editable measures of a folder type once (header, options,
 * read-only), so the queue can ship values without repeating the metadata
 * for every photo.
 */
function measureSchema(headers, folderType) {
  return measureIndexes(headers, folderType).map(function (i) {
    var header = headers[i];
    var readOnly = header.charAt(0) === '_' || /_URL$/.test(header);
    var options = [];
    if (!readOnly && header.indexOf('/') === -1) {
      headers.forEach(function (h) {
        if (h.indexOf(header + '/') === 0) options.push(h.slice(header.length + 1));
      });
    }
    return { header: header, readOnly: readOnly, isOption: header.indexOf('/') !== -1, options: options };
  });
}

/** 0-based column indexes shown for a folder type. */
function measureIndexes(headers, folderType) {
  var spec = CONFIG.FOLDER_TYPES[folderType];
  if (!spec) throw new Error('Unknown folder type: ' + folderType);

  // explicit header list (STORES PHOTOS): keep whichever still exist
  if (spec.headers) {
    var found = [];
    spec.headers.forEach(function (h) {
      var i = headers.indexOf(h);
      if (i !== -1) found.push(i);
    });
    return found;
  }

  // Question-number range. Selecting every question that falls inside the
  // range — rather than locating the exact first and last columns — means a
  // survey version that drops questions (including the boundary ones) still
  // resolves correctly, and column order/count no longer matters.
  var start = spec.range[0], end = spec.range[1];
  var idx = [];
  headers.forEach(function (h, i) {
    var key = questionKey(h);
    if (!key) return;
    if (compareQuestion(key, start) >= 0 && compareQuestion(key, end) <= 0) idx.push(i);
  });
  return idx;
}

/* ------------------------------------------------------------------ *
 *  Filters / queue / record
 * ------------------------------------------------------------------ */

/**
 * Everything the portal needs to populate its filter bar, in ONE request.
 * Each Apps Script round trip costs a couple of seconds no matter how little
 * work it does, so combining calls matters as much as making them cheap.
 */
function bootstrap(p) {
  var out = {
    dates: getDates().data,
    version: CONFIG.VERSION,
    queue: { firstPage: CONFIG.QUEUE_FIRST_PAGE, page: CONFIG.QUEUE_PAGE }
  };
  if (p.date) {
    out.folders = getFolders(p.date).data;
    out.filters = getFilters(p.date).data;
  }
  return { ok: true, data: out };
}

function getFilters(date) {
  var idx = dateIndex(date);
  if (idx.lastRow < 2) return { ok: true, data: { cities: [], auditors: [], channels: [] } };

  // one HTTP call for the three columns instead of a full-sheet scan;
  // a filter whose column this survey version dropped just comes back empty
  var cols = readNamedColumns(idx, [CONFIG.FILTERS.city, CONFIG.FILTERS.auditor, CONFIG.FILTERS.channel]);

  function uniq(name) {
    var seen = {};
    (cols[name] || []).forEach(function (v) {
      var s = String(v).trim();
      if (s && s !== 'null') seen[s] = 1;
    });
    return Object.keys(seen).sort();
  }
  return { ok: true, data: {
    cities:   uniq(CONFIG.FILTERS.city),
    auditors: uniq(CONFIG.FILTERS.auditor),
    channels: uniq(CONFIG.FILTERS.channel)
  } };
}

/**
 * Builds the QC queue: survey rows that have a photo in the selected folder,
 * filtered by city/auditor/channel, sorted by _id.
 */
/** Tiny stopwatch so the portal can ask where a slow request spent its time. */
function timer() {
  var t0 = Date.now(), last = t0, marks = {};
  return {
    mark: function (name) { marks[name] = Date.now() - last; last = Date.now(); },
    done: function () { marks.total = Date.now() - t0; return marks; }
  };
}

/**
 * The stable part of the queue: which rows match the filters, in _id order.
 * Store identity never changes, so this is cached and every later page skips
 * the full-sheet scan. QC status is deliberately NOT cached — it is read
 * fresh on each page so progress marks stay correct.
 */
function queueList(p, idx, imgs) {
  var key = ['qlist4', dateGen(p.date), p.date, p.folderType, p.city || '', p.auditor || '', p.channel || ''].join('|');
  var hit = cacheGetBig(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* rebuild */ } }

  var H = {
    id: CONFIG.ID_HEADER,
    city: CONFIG.FILTERS.city,
    auditor: CONFIG.FILTERS.auditor,
    storeId: 'Select Store ID',
    storeName: 'Select Store Name',
    channel: CONFIG.FILTERS.channel,
    shopStatus: '1.9: Shop Status Code'
  };
  var names = Object.keys(H).map(function (k) { return H[k]; });
  var cols = readNamedColumns(idx, names);   // missing columns come back empty
  function cell(k, r) { return colCell(cols, H[k], r); }

  var rowCount = (cols[H.id] || []).length;
  var items = [], matched = {};
  for (var r = 0; r < rowCount; r++) {
    var id = cell('id', r).replace(/\.0$/, '').trim();
    if (!id || !imgs[id]) continue;
    if (p.city    && cell('city', r).trim()    !== p.city)    continue;
    if (p.auditor && cell('auditor', r).trim() !== p.auditor) continue;
    if (p.channel && cell('channel', r).trim() !== p.channel) continue;
    matched[id] = 1;
    items.push({
      id: id, row: r + 2,
      city: cell('city', r), auditor: cell('auditor', r),
      storeId: cell('storeId', r), storeName: cell('storeName', r),
      channel: cell('channel', r), shopStatus: cell('shopStatus', r)
    });
  }
  items.sort(function (a, b) { return Number(a.id) - Number(b.id); });

  var list = {
    items: items,
    unmatchedImages: Object.keys(imgs).filter(function (id) { return !matched[id]; }).length
  };
  cachePutBig(key, JSON.stringify(list), Math.min(900, cacheTtl(p.date)));
  return list;
}

/**
 * One page of the QC queue, with the measure values for those rows only.
 * The portal asks for a small first page so QC can start immediately, then
 * pulls the rest in the background while the user works.
 */
function getQueue(p) {
  var T = timer();
  var folderType = p.folderType;
  var idx = dateIndex(p.date);                       T.mark('index');
  var imgs = imageMap(p.date, folderType);           T.mark('images');
  if (idx.lastRow < 2) return { ok: true, data: { items: [], schema: [], total: 0, offset: 0, unmatchedImages: 0 } };

  var list = queueList(p, idx, imgs);                T.mark('list');

  var offset = Math.max(0, Number(p.offset) || 0);
  var limit = Number(p.limit) > 0 ? Number(p.limit) : list.items.length;
  var slice = list.items.slice(offset, offset + limit);

  // QC status read fresh (cheap: 3 columns) so done/flagged marks are current
  var sStatus = qcColName(folderType, 'Status'),
      sUser   = qcColName(folderType, 'User'),
      sEnd    = qcColName(folderType, 'End');
  var statusCols = readNamedColumns(idx, [sStatus, sUser, sEnd]);
                                                     T.mark('status');

  var schema = measureSchema(idx.headers, folderType);
  var mIdx = measureIndexes(idx.headers, folderType);
  var q = quoteSheet(idx.sheetName);

  // one range per row of this page — all fetched in a single call
  var rowVals = [], lo = 0, hi = 0;
  if (slice.length && mIdx.length) {
    lo = Math.min.apply(null, mIdx);
    hi = Math.max.apply(null, mIdx);
    rowVals = valuesBatchGet(idx.ssId, slice.map(function (it) {
      return q + '!' + colLetter(lo + 1) + it.row + ':' + colLetter(hi + 1) + it.row;
    })).map(firstLine);
  }                                                  T.mark('values');

  var items = slice.map(function (it, k) {
    var span = rowVals[k] || [];
    var si = it.row - 2;
    return {
      id: it.id, city: it.city, auditor: it.auditor,
      storeId: it.storeId, storeName: it.storeName, channel: it.channel,
      shopStatus: it.shopStatus,
      qcStatus: colCell(statusCols, sStatus, si),
      qcUser:   colCell(statusCols, sUser, si),
      qcEnd:    colCell(statusCols, sEnd, si),
      imageCount: (imgs[it.id] || []).length,
      images: imgs[it.id] || [],
      values: mIdx.map(function (i) {
        var v = span[i - lo];
        return v === undefined || v === null ? '' : String(v);
      })
    };
  });

  var out = {
    items: items, schema: schema,
    total: list.items.length, offset: offset,
    unmatchedImages: list.unmatchedImages
  };
  if (p.debug) out.timing = T.done();
  return { ok: true, data: out };
}

/** Full detail for one survey id: context, editable measures, image references. */
function getRecord(p) {
  var date = p.date, folderType = p.folderType, id = String(p.id);
  var found = rowForId(dateIndex(date), id, date);
  var idx = found.idx, rowNum = found.row;
  var row = readRow(idx, rowNum);

  var context = CONFIG.CONTEXT_HEADERS.map(function (h) {
    var i = idx.headers.indexOf(h);
    return { label: h, value: i === -1 ? '' : fmtValue(row[i]) };
  });
  context.unshift({ label: '_id', value: id });

  var mIdx = measureIndexes(idx.headers, folderType);
  var measures = measureSchema(idx.headers, folderType).map(function (s, k) {
    return {
      header: s.header,
      value: fmtValue(row[mIdx[k]]),
      readOnly: s.readOnly,
      isOption: s.isOption,
      options: s.options
    };
  });

  var qc = {};
  CONFIG.QC_FIELDS.forEach(function (f) {
    var i = idx.headers.indexOf(qcColName(folderType, f));
    if (i !== -1) qc[f.toLowerCase()] = fmtValue(row[i]);
  });

  var imgs = (imageMap(date, folderType)[id] || []).map(function (f) {
    return { fileId: f.fileId, name: f.name, directUrl: 'https://lh3.googleusercontent.com/d/' + f.fileId };
  });

  return { ok: true, data: { id: id, rowNum: rowNum, context: context, measures: measures, images: imgs, qc: qc } };
}

/** One sheet row, padded to the header length. */
function readRow(idx, rowNum) {
  var range = quoteSheet(idx.sheetName) + '!A' + rowNum + ':' + colLetter(idx.headers.length) + rowNum;
  var row = firstLine(valuesBatchGet(idx.ssId, [range])[0]);
  while (row.length < idx.headers.length) row.push('');
  return row;
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
    var found = rowForId(dateIndex(p.date), String(p.id), p.date);
    var idx = found.idx, rowNum = found.row;
    var row = readRow(idx, rowNum);
    var sheetQ = quoteSheet(idx.sheetName);

    var allowed = measureIndexes(idx.headers, p.folderType);
    var changes = p.changes || {};
    var applied = {};
    var writes = [];   // collected, then sent as ONE batch update
    function queueWrite(colIdx0, value) {
      writes.push({ range: sheetQ + '!' + colLetter(colIdx0 + 1) + rowNum, values: [[value]] });
    }

    Object.keys(changes).forEach(function (header) {
      var i = idx.headers.indexOf(header);
      if (i === -1 || allowed.indexOf(i) === -1) return; // only columns of this folder type
      var oldVal = fmtValue(row[i]);
      var newVal = changes[header];
      if (String(newVal) === oldVal) return;

      var write = (newVal !== '' && !isNaN(Number(newVal)) && String(newVal).trim() !== '') ? Number(newVal) : newVal;
      queueWrite(i, write);
      applied[header] = { from: oldVal, to: String(newVal) };

      // keep the 0/1 dummy option columns in sync when a parent select changes
      if (header.indexOf('/') === -1) {
        idx.headers.forEach(function (h, j) {
          if (h.indexOf(header + '/') === 0) {
            var opt = h.slice(header.length + 1);
            var on = String(newVal) === opt || String(newVal).indexOf(opt) !== -1;
            queueWrite(j, on ? 1 : 0);
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
      var i = idx.headers.indexOf(qcColName(p.folderType, f));
      if (i !== -1) queueWrite(i, qcVals[f]);
    });

    valuesBatchUpdate(idx.ssId, writes);

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
  var idx = dateIndex(date);
  var folders = Object.keys(photoFolders(date));

  // ids come from the cached index; statuses for every folder type in one call
  var ids = [];
  Object.keys(idx.idToRow).forEach(function (id) { ids[idx.idToRow[id] - 2] = id; });
  var statusNames = folders.map(function (type) { return qcColName(type, 'Status'); });
  var res = idx.lastRow > 1 ? readNamedColumns(idx, statusNames) : {};

  var result = folders.map(function (type, fi) {
    var imgs = imageMap(date, type);
    var statuses = res[statusNames[fi]] || [];
    var done = 0, flagged = 0, matched = 0;
    ids.forEach(function (id, i) {
      if (!id || !imgs[id]) return;
      matched++;
      var s = String(statuses[i] === undefined ? '' : statuses[i]);
      if (s === 'DONE') done++;
      if (s === 'FLAGGED') flagged++;
    });
    return {
      folderType: type,
      images: Object.keys(imgs).length,
      matched: matched,
      done: done,
      flagged: flagged,
      pending: matched - done - flagged
    };
  });
  return { ok: true, data: { date: date, sheetUrl: 'https://docs.google.com/spreadsheets/d/' + idx.ssId, progress: result } };
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
 *  Half-month combined sheet  ("QC RD <YYYY-MM>-H1" / "-H2")
 *
 *  Stacks every "QC RD <date>" sheet of one half of a month into a single
 *  spreadsheet in the same output folder. H1 is the 1st-15th, H2 is the
 *  16th to the end of that month (28/29/30/31, whichever it is).
 *
 *  COLUMNS come from the LATEST date in the half, because Kobo questions
 *  get added and removed mid-month. Columns 1..N are exactly that sheet's
 *  headers in its order, then "QC Source Date", then any column an older
 *  day had that the latest one no longer does — kept rather than dropped,
 *  so a mid-month question change never silently loses data.
 *
 *  ROWS are matched to columns BY HEADER NAME, never by position. A column
 *  the latest has but an older day lacks comes through blank.
 *
 *  A half-month is roughly 4,500 rows x 450 columns, far too much for one
 *  6-minute execution, so a build is RESUMABLE: each call works through as
 *  many dates as fit in HALF_BUDGET_MS, records which dates are done in
 *  Script Properties, and returns progress. Call it again with the same
 *  month/half and reset:false to carry on where it stopped.
 * ------------------------------------------------------------------ */

function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

/** 'H1' for days 1-15, 'H2' for 16 onwards. */
function halfOfDay(day) { return Number(day) <= 15 ? 'H1' : 'H2'; }

/** 'QC RD 2026-08-H1' */
function halfMonthName(month, half) {
  return CONFIG.QC_SHEET_PREFIX + month + '-' + half;
}

function daysInMonth(month) {
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
}

/** Every calendar date in one half-month, ascending. */
function halfMonthDates(month, half) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error('Invalid month "' + month + '" (expected YYYY-MM)');
  if (half !== 'H1' && half !== 'H2') throw new Error('Invalid half "' + half + '" (expected H1 or H2)');
  var from = half === 'H1' ? 1 : 16;
  var to   = half === 'H1' ? 15 : daysInMonth(month);
  var out = [];
  for (var d = from; d <= to; d++) out.push(month + '-' + (d < 10 ? '0' + d : String(d)));
  return out;
}

/** name -> fileId for every Google Sheet in the QC output folder. */
function qcFilesByName() {
  var map = {};
  driveList(outputFolder().getId()).forEach(function (f) {
    if (f.mimeType === 'application/vnd.google-apps.spreadsheet') map[f.name.trim()] = f.id;
  });
  return map;
}

/** First tab's id, name and grid size, in one call where possible. */
function hmSheetProps(ssId) {
  if (sheetsReady()) {
    try {
      var meta = Sheets.Spreadsheets.get(ssId, {
        fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))'
      });
      var p = meta.sheets[0].properties;
      return { sheetId: p.sheetId, title: p.title,
               rows: p.gridProperties.rowCount, cols: p.gridProperties.columnCount };
    } catch (e) { sheetsFailed(e); }
  }
  var sh = openSs(ssId).getSheets()[0];
  return { sheetId: sh.getSheetId(), title: sh.getName(),
           rows: sh.getMaxRows(), cols: sh.getMaxColumns() };
}

/** Header row of a QC sheet, trailing blanks trimmed. */
function hmHeaders(ssId, title) {
  var props = hmSheetProps(ssId);
  var t = title || props.title;
  // An explicit A1 range, never a bare sheet name or a bare row: the Sheets REST
  // API accepts those but SpreadsheetApp.getRange() does not, and valuesBatchGet()
  // turns that failure into an empty result rather than an error.
  var range = quoteSheet(t) + '!A1:' + colLetter(Math.max(1, props.cols)) + '1';
  var h = firstLine(valuesBatchGet(ssId, [range])[0]).map(String);
  while (h.length && h[h.length - 1] === '') h.pop();
  return h;
}

/**
 * Works out which dates go in and the exact column layout of the combined
 * sheet. Costs one header read per date in the half.
 */
function hmPlan(month, half) {
  var byName = qcFilesByName();
  var dates = [], missing = [];
  halfMonthDates(month, half).forEach(function (d) {
    var id = byName[CONFIG.QC_SHEET_PREFIX + d];
    if (id) dates.push({ date: d, ssId: id }); else missing.push(d);
  });
  if (!dates.length) {
    throw new Error('No QC sheets exist yet for ' + month + ' ' + half +
      '. Open those dates in the QC portal first — a QC sheet is only created when a date is first opened.');
  }

  var latest = dates[dates.length - 1];          // halfMonthDates() is ascending
  var headers = hmHeaders(latest.ssId);
  if (!headers.length) throw new Error('The latest QC sheet (' + latest.date + ') has an empty header row');

  var seen = {};
  headers.forEach(function (h) { seen[h] = true; });
  if (!hasOwn(seen, CONFIG.SOURCE_DATE_HEADER)) {
    headers.push(CONFIG.SOURCE_DATE_HEADER);
    seen[CONFIG.SOURCE_DATE_HEADER] = true;
  }

  var extras = [];
  dates.forEach(function (d) {
    if (d.date === latest.date) return;
    hmHeaders(d.ssId).forEach(function (h) {
      if (!h || hasOwn(seen, h)) return;
      seen[h] = true;
      extras.push(h);
      headers.push(h);
    });
  });

  return { dates: dates, latest: latest.date, latestSsId: latest.ssId,
           missing: missing, headers: headers, extras: extras };
}

function hmClearAll(ssId, props) {
  if (sheetsReady()) {
    try { Sheets.Spreadsheets.Values.clear({}, ssId, quoteSheet(props.title)); return; }
    catch (e) { sheetsFailed(e); }
  }
  openSs(ssId).getSheetByName(props.title).clearContents();
}

function hmEnsureGrid(ssId, props, cols) {
  if (props.cols >= cols) return;
  if (sheetsReady()) {
    try {
      Sheets.Spreadsheets.batchUpdate({ requests: [{
        updateSheetProperties: {
          properties: { sheetId: props.sheetId, gridProperties: { columnCount: cols } },
          fields: 'gridProperties.columnCount'
        }
      }] }, ssId);
      props.cols = cols;
      return;
    } catch (e) { sheetsFailed(e); }
  }
  var sh = openSs(ssId).getSheetByName(props.title);
  sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
  props.cols = cols;
}

/**
 * The combined spreadsheet, emptied and ready for rows.
 *
 * An existing file is reused and wiped rather than replaced, so the link
 * people have bookmarked keeps working across rebuilds.
 */
function hmPrepareTarget(month, half, plan) {
  var folderId = outputFolder().getId();
  var name = halfMonthName(month, half);
  var existing = driveList(folderId).filter(function (f) {
    return f.name.trim() === name && f.mimeType === 'application/vnd.google-apps.spreadsheet';
  })[0];

  var ssId;
  if (existing) {
    ssId = existing.id;
  } else {
    // Copying the latest date's sheet carries its column formatting across;
    // the rows that come with it are wiped immediately below.
    ssId = Drive.Files.copy(
      { name: name, mimeType: 'application/vnd.google-apps.spreadsheet', parents: [folderId] },
      plan.latestSsId, { supportsAllDrives: true }
    ).id;
  }

  var props = hmSheetProps(ssId);
  hmClearAll(ssId, props);
  hmEnsureGrid(ssId, props, plan.headers.length);
  valuesBatchUpdate(ssId, [{
    range: quoteSheet(props.title) + '!A1:' + colLetter(plan.headers.length) + '1',
    values: [plan.headers]
  }]);
  return { ssId: ssId, tab: props.title };
}

function hmStateKey(month, half) { return 'HM|' + month + '|' + half; }

function hmGetState(month, half) {
  var raw = PROPS.getProperty(hmStateKey(month, half));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function hmSetState(st) { PROPS.setProperty(hmStateKey(st.month, st.half), JSON.stringify(st)); }

/** Wipes the target and records the plan. Nothing is appended yet. */
function hmStart(month, half) {
  var plan = hmPlan(month, half);
  var target = hmPrepareTarget(month, half, plan);
  var ids = {};
  plan.dates.forEach(function (d) { ids[d.date] = d.ssId; });
  return {
    month: month, half: half,
    ssId: target.ssId, tab: target.tab,
    latest: plan.latest,
    dates: plan.dates.map(function (d) { return d.date; }),
    ids: ids,
    done: [], rows: 0,
    pending: '',                 // date being appended right now, for crash recovery
    refreshed: 0,                // rows syncNewRows() pulled into the QC sheets
    refreshFailed: 0,
    refreshWarnings: [],
    missing: plan.missing,
    cols: plan.headers.length,
    // kept for the report only; the sheet's own row 1 is the real header list
    extras: plan.extras.slice(0, 10),
    extrasCount: plan.extras.length,
    startedAt: new Date().toISOString()
  };
}

/** Appends rows in chunks small enough to stay inside one API request. */
function hmAppendRows(st, rows, width) {
  if (!rows.length) return;
  var per = Math.max(1, Math.floor(CONFIG.HALF_APPEND_CELLS / Math.max(1, width)));
  for (var i = 0; i < rows.length; i += per) {
    var chunk = rows.slice(i, i + per);
    var wrote = false;
    if (sheetsReady()) {
      try {
        Sheets.Spreadsheets.Values.append({ values: chunk }, st.ssId, quoteSheet(st.tab) + '!A1',
          { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' });
        wrote = true;
      } catch (e) {
        // Deliberately NOT falling through to the other API here. A failed
        // append may still have landed, and rewriting the chunk would duplicate
        // rows. The date is marked pending, so give up on it now: the next call
        // purges whatever it wrote and redoes it, by then already on the
        // fallback because this marked the advanced service unusable.
        sheetsFailed(e);
        throw new Error('Append failed for ' + st.month + ' ' + st.half +
          '; the date will be redone on the next pass. ' + ((e && e.message) || e));
      }
    }
    if (!wrote) {
      var sh = openSs(st.ssId).getSheetByName(st.tab);
      var start = sh.getLastRow() + 1;
      var need = start + chunk.length - 1;
      if (sh.getMaxRows() < need) sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows());
      sh.getRange(start, 1, chunk.length, width).setValues(chunk);
      SpreadsheetApp.flush();
    }
  }
}

/** Reads one date's QC sheet and appends its rows, remapped by header name. */
function hmAppendDate(st, date, headers, index) {
  var srcId = st.ids[date];
  var srcProps = hmSheetProps(srcId);
  var srcTitle = srcProps.title;
  var range = quoteSheet(srcTitle) + '!A1:' +
              colLetter(Math.max(1, srcProps.cols)) + Math.max(1, srcProps.rows);
  var got = valuesBatchGet(srcId, [range]);
  var rows = (got[0] && got[0].values) || [];
  // Not even a header row back means the read failed, not that the day is empty.
  // Silently recording 0 rows here is how a whole half-month ends up blank.
  if (!rows.length) {
    throw new Error('Could not read the QC sheet for ' + date + ' (tab "' + srcTitle +
      '"). Nothing was returned for ' + range + '.');
  }
  if (rows.length < 2) return 0;

  var srcHeaders = rows[0].map(String);
  // source column -> combined column. hmPlan() gave every stray column a home,
  // so -1 only happens if the source sheet changed since the build started.
  var map = srcHeaders.map(function (h) { return hasOwn(index, h) ? index[h] : -1; });
  var dateCol = hasOwn(index, CONFIG.SOURCE_DATE_HEADER) ? index[CONFIG.SOURCE_DATE_HEADER] : -1;
  var idCol = srcHeaders.indexOf(CONFIG.ID_HEADER);
  var width = headers.length;

  var out = [];
  for (var r = 1; r < rows.length; r++) {
    var src = rows[r];
    // a QC sheet's grid is usually taller than its data; skip the blank tail
    if (idCol !== -1) {
      var id = src[idCol];
      if (id === undefined || id === null || String(id).trim() === '') continue;
    }
    var line = new Array(width);
    for (var c = 0; c < width; c++) line[c] = '';
    var n = Math.min(src.length, map.length);
    for (var s = 0; s < n; s++) {
      var dst = map[s];
      if (dst >= 0 && src[s] !== undefined && src[s] !== null) line[dst] = src[s];
    }
    if (dateCol >= 0) line[dateCol] = date;
    out.push(line);
  }

  hmAppendRows(st, out, width);
  return out.length;
}

/**
 * Brings one date's QC sheet up to date with its Kobo workbook before it is
 * combined. A QC sheet is a snapshot taken when the date was first opened, so
 * rows the field team uploaded later that day are missing from it until this
 * runs. Append-only: existing rows and QC corrections are never touched.
 *
 * A refresh failure must not sink the whole build - combine whatever the QC
 * sheet already holds and report the failure instead of throwing.
 */
function hmRefreshDate(st, date) {
  try {
    var added = syncNewRows(date);
    if (added) bumpDateGen(date);      // the portal's cached views of this date are now stale
    return added;
  } catch (e) {
    var msg = date + ': ' + ((e && e.message) || e);
    if (st.refreshWarnings.length < 10) st.refreshWarnings.push(msg);
    st.refreshFailed++;
    console.warn('half-month refresh failed for ' + msg);
    return 0;
  }
}

/**
 * Removes any rows already written for one date.
 *
 * Appends are durable the moment they land, so an execution killed part way
 * through a date leaves some of its rows behind while the date is still marked
 * pending. Retrying without clearing them first would double them up. Rows for
 * a date are always appended together, so they form one contiguous block.
 */
function hmPurgeDate(st, date, index) {
  if (!hasOwn(index, CONFIG.SOURCE_DATE_HEADER)) return 0;
  var props = hmSheetProps(st.ssId);
  if (props.rows < 2) return 0;

  var L = colLetter(index[CONFIG.SOURCE_DATE_HEADER] + 1);
  var got = valuesBatchGet(st.ssId, [quoteSheet(st.tab) + '!' + L + '2:' + L + props.rows]);
  var col = (got[0] && got[0].values) || [];

  var first = -1, last = -1;
  for (var i = 0; i < col.length; i++) {
    var cell = col[i] && col[i][0];
    var v = (cell === undefined || cell === null) ? '' : String(cell);
    if (v === date) {
      if (first === -1) first = i + 2;              // 1-based sheet row
      last = i + 2;
    }
  }
  if (first === -1) return 0;
  var count = last - first + 1;

  if (sheetsReady()) {
    try {
      Sheets.Spreadsheets.batchUpdate({ requests: [{
        deleteDimension: {
          range: { sheetId: props.sheetId, dimension: 'ROWS',
                   startIndex: first - 1, endIndex: last }
        }
      }] }, st.ssId);
      return count;
    } catch (e) { sheetsFailed(e); }
  }
  openSs(st.ssId).getSheetByName(st.tab).deleteRows(first, count);
  return count;
}

/** Processes pending dates until the time budget runs out. */
function hmRunBudget(st, budgetMs) {
  var t0 = Date.now();
  var headers = hmHeaders(st.ssId, st.tab);
  var index = {};
  headers.forEach(function (h, i) { if (!hasOwn(index, h)) index[h] = i; });

  // A previous call was killed part way through this date; drop the rows it
  // managed to write before doing it again.
  if (st.pending) {
    // st.rows only ever counted dates that finished, so the rows being dropped
    // here were never added to it — the count must not move.
    hmPurgeDate(st, st.pending, index);
    st.pending = '';
    hmSetState(st);
  }

  var doneSet = {};
  st.done.forEach(function (d) { doneSet[d] = true; });

  // Always finish at least one date, even if the budget is already gone by the
  // time we get here — otherwise a call can return having done nothing at all
  // and the build never advances, however many times it is retried.
  var processed = 0;
  for (var i = 0; i < st.dates.length; i++) {
    var date = st.dates[i];
    if (hasOwn(doneSet, date)) continue;
    if (processed > 0 && Date.now() - t0 > budgetMs) break;

    if (CONFIG.HALF_REFRESH) st.refreshed += hmRefreshDate(st, date);

    // Claim the date before writing any of it, so an interrupted append is
    // recognisable — and undoable — on the next call.
    st.pending = date;
    hmSetState(st);

    st.rows += hmAppendDate(st, date, headers, index);
    st.done.push(date);
    doneSet[date] = true;
    st.pending = '';
    hmSetState(st);          // per date, so a timeout cannot lose finished dates
    processed++;
  }
  return st;
}

function hmReport(st) {
  return {
    month: st.month, half: st.half,
    name: halfMonthName(st.month, st.half),
    url: 'https://docs.google.com/spreadsheets/d/' + st.ssId + '/edit',
    latest: st.latest,
    total: st.dates.length,
    done: st.done.length,
    remaining: st.dates.length - st.done.length,
    complete: st.done.length >= st.dates.length,
    rows: st.rows,
    columns: st.cols,
    datesMissingQcSheet: st.missing,
    rowsPulledIn: st.refreshed || 0,
    refreshFailures: st.refreshFailed || 0,
    refreshWarnings: st.refreshWarnings || [],
    extraColumns: st.extras,
    extraColumnCount: st.extrasCount
  };
}

/**
 * Build (or continue building) one half-month file.
 *   p = { month: 'YYYY-MM', half: 'H1'|'H2', reset: true on the first call }
 * Returns progress; keep calling with reset:false until data.complete.
 */
function buildHalfMonth(p) {
  var month = String(p.month || '').trim();
  var half = String(p.half || '').trim().toUpperCase();
  halfMonthDates(month, half);                     // validates both

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('Another half-month build is running — wait for it to finish, then try again.');
  }
  try {
    var st = p.reset ? null : hmGetState(month, half);
    if (!st) st = hmStart(month, half);
    st = hmRunBudget(st, CONFIG.HALF_BUDGET_MS);
    hmSetState(st);
    return { ok: true, data: hmReport(st) };
  } finally {
    lock.releaseLock();
  }
}

/** Every half-month that has photo dates, newest first, flagged if built. */
function listHalfMonths() {
  var byName = qcFilesByName();
  var seen = {}, out = [];
  getDates().data.forEach(function (d) {
    var month = d.slice(0, 7), half = halfOfDay(d.slice(8, 10));
    var key = month + '|' + half;
    if (hasOwn(seen, key)) return;
    seen[key] = true;
    var id = byName[halfMonthName(month, half)];
    out.push({
      month: month, half: half, built: !!id,
      url: id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : ''
    });
  });
  return { ok: true, data: out };
}

/* ---- nightly rebuild ------------------------------------------------ *
 *
 *  A time-based trigger gets the same 6-minute ceiling as everything else,
 *  so the nightly run does one budgeted pass and then books itself a
 *  one-off trigger a minute later to continue, until the queue is empty.
 * -------------------------------------------------------------------- */

function nightlyRebuildHalfMonth() {
  var today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var month = today.slice(0, 7), day = Number(today.slice(8, 10));
  var queue = [{ month: month, half: halfOfDay(day) }];

  // Just after a half turns over the closed one is usually still being QC'd,
  // so keep refreshing it for a few more days.
  if (day <= 5) {
    var y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7)) - 1;
    if (m === 0) { m = 12; y -= 1; }
    queue.push({ month: y + '-' + (m < 10 ? '0' + m : String(m)), half: 'H2' });
  } else if (day >= 16 && day <= 20) {
    queue.push({ month: month, half: 'H1' });
  }

  PROPS.setProperty('HM_AUTO', JSON.stringify({ queue: queue, tries: 0, fresh: true, rpFresh: true }));
  hmAutoStep();
}

function hmContinue() {
  hmDropContinuations();
  hmAutoStep();
}

function hmAutoStep() {
  var raw = PROPS.getProperty('HM_AUTO');
  if (!raw) return;
  var auto;
  try { auto = JSON.parse(raw); } catch (e) { PROPS.deleteProperty('HM_AUTO'); return; }
  if (!auto.queue || !auto.queue.length || auto.tries > 60) {
    PROPS.deleteProperty('HM_AUTO');
    return;
  }

  var job = auto.queue[0];
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {          // a manual build is in progress; wait it out
    auto.tries++;
    PROPS.setProperty('HM_AUTO', JSON.stringify(auto));
    hmScheduleContinuation();
    return;
  }
  try {
    var st = auto.fresh ? null : hmGetState(job.month, job.half);
    if (!st) st = hmStart(job.month, job.half);
    st = hmRunBudget(st, CONFIG.HALF_BUDGET_MS);
    hmSetState(st);
    auto.fresh = false;
    if (st.done.length >= st.dates.length) {
      // The half-month file is finished, so refresh the reporting cut of it
      // before moving on. Budgeted the same way; a failure here must not cost
      // us the combine that just succeeded.
      try {
        var rst = auto.rpFresh === false ? rpGetState(job.month, job.half) : null;
        if (!rst) rst = rpStart(job.month, job.half);
        rst = rpRunBudget(rst, CONFIG.HALF_BUDGET_MS);
        rpSetState(rst);
        auto.rpFresh = false;
        if (rst.nextRow > rst.srcRows) { auto.queue.shift(); auto.fresh = true; auto.rpFresh = true; }
      } catch (e) {
        console.warn('reporting build for ' + job.month + ' ' + job.half +
                     ' skipped: ' + ((e && e.message) || e));
        auto.queue.shift(); auto.fresh = true; auto.rpFresh = true;
      }
    }
  } catch (e) {
    // A half with no QC sheets yet lands here; drop it and move on.
    console.warn('nightly rebuild of ' + job.month + ' ' + job.half + ' skipped: ' + (e && e.message));
    auto.queue.shift();
    auto.fresh = true;
  } finally {
    lock.releaseLock();
  }

  auto.tries++;
  if (!auto.queue.length) {
    PROPS.deleteProperty('HM_AUTO');
    hmDropContinuations();
    return;
  }
  PROPS.setProperty('HM_AUTO', JSON.stringify(auto));
  hmScheduleContinuation();
}

function hmScheduleContinuation() {
  ScriptApp.newTrigger('hmContinue').timeBased().after(60 * 1000).create();
}

function hmDropContinuations() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hmContinue') ScriptApp.deleteTrigger(t);
  });
}

/**
 * Run once from the editor to install (or re-install) the nightly rebuild.
 * Safe to run again; it clears any previous copy of the trigger first.
 */
function installHalfMonthTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'nightlyRebuildHalfMonth') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('nightlyRebuildHalfMonth').timeBased().atHour(2).everyDays(1).create();
  var msg = 'Nightly half-month rebuild installed for ~02:00 ' + Session.getScriptTimeZone();
  console.log(msg);
  return msg;
}


/* ------------------------------------------------------------------ *
 *  Reporting format  ("REPORTING <YYYY-MM>-H1" / "-H2")
 *
 *  Rewrites a half-month sheet into the 402 columns the reporting pack
 *  expects, in its order. The map lives in ReportMap.gs.
 *
 *  Built from the HALF-MONTH sheet, never from the daily QC sheets, so
 *  whatever the half-month file contains is exactly what gets reported.
 *
 *  The map is POSITIONAL — reporting column N takes source column C. If a
 *  Kobo question is added or removed, every column after it shifts and the
 *  whole report would be quietly wrong, so the live header is checked
 *  against the expected title of every mapped column before a single row is
 *  copied. A mismatch stops the build and names the columns.
 *
 *  Like the half-month build this is resumable, working through the source
 *  in row chunks so it stays inside one execution.
 * ------------------------------------------------------------------ */

function reportName(month, half) {
  return CONFIG.REPORT_SHEET_PREFIX + month + '-' + half;
}

/** Reporting column titles, in order. */
function reportHeaders() {
  return REPORT_MAP.map(function (m) { return m[0]; });
}

/**
 * Confirms the half-month sheet still looks the way the map was built for.
 * Returns a list of human-readable problems; empty means it is safe to copy.
 */
function reportCheckHeader(srcHeaders) {
  var problems = [];
  for (var i = 0; i < REPORT_MAP.length; i++) {
    var col = REPORT_MAP[i][1];
    if (!col) continue;                                  // deliberately blank
    if (col > srcHeaders.length) {
      problems.push('reporting column ' + (i + 1) + ' "' + REPORT_MAP[i][0] +
        '" needs source column ' + col + ' but the sheet only has ' + srcHeaders.length);
      continue;
    }
    var want = String(REPORT_MAP[i][2] || '');
    var got = String(srcHeaders[col - 1] || '');
    if (want && want !== got) {
      problems.push('source column ' + col + ' should be "' + want + '" but is "' + got + '"');
    }
  }
  return problems;
}

function rpStateKey(month, half) { return 'RP|' + month + '|' + half; }

function rpGetState(month, half) {
  var raw = PROPS.getProperty(rpStateKey(month, half));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function rpSetState(st) { PROPS.setProperty(rpStateKey(st.month, st.half), JSON.stringify(st)); }

/** Creates (or empties) the reporting file and writes its header row. */
function rpStart(month, half) {
  var folderId = outputFolder().getId();
  var srcName = halfMonthName(month, half);
  var files = driveList(folderId);

  var src = files.filter(function (f) {
    return f.name.trim() === srcName && f.mimeType === 'application/vnd.google-apps.spreadsheet';
  })[0];
  if (!src) {
    throw new Error('No "' + srcName + '" sheet yet — build the half-month file first.');
  }

  var srcProps = hmSheetProps(src.id);
  var srcHeaders = hmHeaders(src.id, srcProps.title);

  var problems = reportCheckHeader(srcHeaders);
  if (problems.length && CONFIG.REPORT_STRICT) {
    throw new Error('"' + srcName + '" no longer matches the reporting map, so the report ' +
      'would be wrong. ' + problems.length + ' problem(s): ' + problems.slice(0, 5).join('; ') +
      (problems.length > 5 ? ' …' : '') +
      '  Regenerate ReportMap.gs, or set CONFIG.REPORT_STRICT = false to build anyway.');
  }

  var headers = reportHeaders();
  var name = reportName(month, half);
  var existing = files.filter(function (f) {
    return f.name.trim() === name && f.mimeType === 'application/vnd.google-apps.spreadsheet';
  })[0];

  var ssId;
  if (existing) {
    ssId = existing.id;                       // reuse, so shared links keep working
  } else {
    ssId = Drive.Files.create({
      name: name,
      mimeType: 'application/vnd.google-apps.spreadsheet',
      parents: [folderId]
    }, null, { supportsAllDrives: true }).id;
  }

  var props = hmSheetProps(ssId);
  hmClearAll(ssId, props);
  hmEnsureGrid(ssId, props, headers.length);
  valuesBatchUpdate(ssId, [{
    range: quoteSheet(props.title) + '!A1:' + colLetter(headers.length) + '1',
    values: [headers]
  }]);

  return {
    month: month, half: half,
    ssId: ssId, tab: props.title,
    srcId: src.id, srcTab: srcProps.title,
    srcRows: srcProps.rows, srcCols: srcProps.cols,
    nextRow: 2,                    // next source row to read (row 1 is the header)
    rows: 0,
    cols: headers.length,
    warnings: problems.slice(0, 10),
    startedAt: new Date().toISOString()
  };
}

/**
 * Copies one chunk of source rows across, remapped into reporting order.
 * Returns how many source rows were consumed.
 */
function rpCopyChunk(st, dateCol) {
  var perChunk = Math.max(1, Math.floor(CONFIG.REPORT_CHUNK_CELLS / Math.max(1, st.srcCols)));
  var last = Math.min(st.nextRow + perChunk - 1, st.srcRows);
  if (last < st.nextRow) return 0;

  var range = quoteSheet(st.srcTab) + '!A' + st.nextRow + ':' +
              colLetter(st.srcCols) + last;
  var got = valuesBatchGet(st.srcId, [range]);
  var rows = (got[0] && got[0].values) || [];

  var out = [];
  for (var r = 0; r < rows.length; r++) {
    var src = rows[r];
    // The grid is usually taller than the data; every real row carries a
    // source date, so use it to spot the blank tail.
    if (dateCol > 0) {
      var d = src[dateCol - 1];
      if (d === undefined || d === null || String(d).trim() === '') continue;
    }
    var line = new Array(REPORT_MAP.length);
    for (var i = 0; i < REPORT_MAP.length; i++) {
      var col = REPORT_MAP[i][1];
      var v = col ? src[col - 1] : '';
      line[i] = (v === undefined || v === null) ? '' : v;
    }
    out.push(line);
  }

  if (out.length) {
    hmAppendRows({ ssId: st.ssId, tab: st.tab, month: st.month, half: st.half },
                 out, REPORT_MAP.length);
    st.rows += out.length;
  }
  var consumed = last - st.nextRow + 1;
  st.nextRow = last + 1;
  return consumed;
}

/** Works through the source until the time budget runs out. */
function rpRunBudget(st, budgetMs) {
  var t0 = Date.now();
  var srcHeaders = hmHeaders(st.srcId, st.srcTab);
  var dateCol = srcHeaders.indexOf(CONFIG.SOURCE_DATE_HEADER) + 1;   // 0 if absent

  var did = 0;
  while (st.nextRow <= st.srcRows) {
    if (did > 0 && Date.now() - t0 > budgetMs) break;
    if (!rpCopyChunk(st, dateCol)) break;
    did++;
    rpSetState(st);            // per chunk, so a timeout cannot lose the work
  }
  return st;
}

function rpReport(st) {
  return {
    month: st.month, half: st.half,
    name: reportName(st.month, st.half),
    url: 'https://docs.google.com/spreadsheets/d/' + st.ssId + '/edit',
    source: halfMonthName(st.month, st.half),
    rows: st.rows,
    columns: st.cols,
    sourceRows: Math.max(0, st.srcRows - 1),
    complete: st.nextRow > st.srcRows,
    warnings: st.warnings || []
  };
}

/**
 * Build (or continue building) one half-month's reporting file.
 *   p = { month: 'YYYY-MM', half: 'H1'|'H2', reset: true on the first call }
 * Keep calling with reset:false until data.complete.
 */
function buildReporting(p) {
  var month = String(p.month || '').trim();
  var half = String(p.half || '').trim().toUpperCase();
  halfMonthDates(month, half);                     // validates both

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    throw new Error('Another build is running — wait for it to finish, then try again.');
  }
  try {
    var st = p.reset ? null : rpGetState(month, half);
    if (!st) st = rpStart(month, half);
    st = rpRunBudget(st, CONFIG.HALF_BUDGET_MS);
    rpSetState(st);
    return { ok: true, data: rpReport(st) };
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ *
 *  Utils
 * ------------------------------------------------------------------ */

function colValues(sheet, col) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, col, last - 1, 1).getValues().map(function (r) { return String(r[0]); });
}
