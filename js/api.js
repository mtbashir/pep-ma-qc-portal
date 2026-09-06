/* PEP MA QC Portal — API client (talks to the Apps Script web app). */
(function () {
  'use strict';

  var TOKEN_KEY = 'qc_token';
  var USER_KEY = 'qc_user';

  function isDemo() {
    return !window.QC_CONFIG.API_URL || window.QC_CONFIG.API_URL.indexOf('PASTE_') === 0;
  }

  // Apps Script intermittently drops a request — the POST is 302-redirected to
  // googleusercontent and that hop sometimes answers 404, or the script hits a
  // cold start and times out. These are transport failures, not real errors, so
  // they are retried. Errors the backend actually reported are never retried.
  var RETRY_DELAYS = [0, 700, 1800, 3500];

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** POST one action to the backend. Resolves the `data` payload or throws. */
  async function api(action, params) {
    params = params || {};
    if (isDemo()) return demoApi(action, params);

    var tokenUsed = localStorage.getItem(TOKEN_KEY) || '';
    var body = Object.assign({ action: action, token: tokenUsed }, params);
    var lastErr;

    for (var attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt]) await sleep(RETRY_DELAYS[attempt]);
      try {
        var resp = await fetch(window.QC_CONFIG.API_URL, {
          method: 'POST',
          // text/plain avoids a CORS preflight, which Apps Script does not answer
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) throw new Error('Network error (' + resp.status + ')');

        var out = await resp.json();
        if (!out.ok) {
          var err = new Error(out.error || 'Request failed');
          err.fromServer = true;             // a real answer — do not retry it
          if (/^AUTH:/.test(out.error || '')) {
            err.auth = true;
            // Only sign out if this failure belongs to the session that is
            // still current. A slow request left over from a previous session
            // must not wipe a login that has since succeeded.
            if ((localStorage.getItem(TOKEN_KEY) || '') === tokenUsed) {
              localStorage.removeItem(TOKEN_KEY);
              localStorage.removeItem(USER_KEY);
            } else {
              err.staleSession = true;
            }
          }
          throw err;
        }
        return out.data;
      } catch (e) {
        if (e.fromServer) throw e;
        lastErr = e;
      }
    }
    lastErr = lastErr || new Error('Request failed');
    lastErr.message += ' — the Google backend did not respond after ' +
      RETRY_DELAYS.length + ' attempts. Please try again.';
    throw lastErr;
  }

  function saveSession(data) {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USER_KEY, JSON.stringify(data.user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function currentUser() {
    try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------- *
   * Demo mode: lets you explore the portal before the backend is
   * configured. Sign in with demo/demo (or admin/admin on the admin
   * page). Data is fake and nothing is saved.
   * ---------------------------------------------------------------- */

  var DEMO_MEASURES = [
    ['2.1.5: Cooler Type', 'Chest Cooler', ['Visi Cooler', 'Chest Cooler']],
    ['2.1.5: Cooler Type/Visi Cooler', '0'],
    ['2.1.5: Cooler Type/Chest Cooler', '1'],
    ['2.1.6: Cooler Placement', 'At Entrance (Inside Store)', ['At Entrance (Outside Store)', 'At Entrance (Inside Store)', 'Backend (Inside Store)', 'Backend (Outside Store)']],
    ['2.1.7: Is the cooler switched ON and operational?', 'Yes', ['Yes', 'No']],
    ['2.1.8: Total number of shelves inside the cooler', '3'],
    ['2.1.9: Number of shelves currently filled with stock', '2'],
    ['2.1.10: Brand Facings — PEP Cooler (Pepsi)', '5'],
    ['2.1.11: Brand Facings — PEP Cooler (7UP)', '0'],
    ['2.1.12: Brand Facings — PEP Cooler (Mirinda)', '15'],
    ['2.1.16: Brand Facings — PEP Cooler (Coca-Cola)', '8'],
    ['2.1.24: Brand Facings — PEP Cooler (Others)', '8']
  ];

  var DEMO_QUEUE = [
    { id: '810019648', city: '5.GJW', auditor: 'DEMO AUDITOR', storeId: 'GJW-0101', storeName: 'STOP N SHOP SS', channel: '1.GT', qcStatus: '', qcUser: '', imageCount: 1 },
    { id: '810017874', city: '5.GJW', auditor: 'DEMO AUDITOR', storeId: 'GJW-0102', storeName: 'MANSHA STORE', channel: '1.GT', qcStatus: 'DONE', qcUser: 'demo', imageCount: 1 },
    { id: '810018529', city: '6.LHR', auditor: 'DEMO AUDITOR 2', storeId: 'LHR-0201', storeName: 'SINDHI BIRYANI', channel: '2.LMT', qcStatus: '', qcUser: '', imageCount: 1 }
  ];

  function nowStr() {
    var d = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  var demoSession = { photos: {}, saves: 0, changes: 0, flagged: 0, start: nowStr(), startMs: Date.now() };

  function demoImage(id) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200">' +
      '<rect width="100%" height="100%" fill="#1a3a5c"/>' +
      '<rect x="150" y="150" width="600" height="900" rx="20" fill="#2d5f8f" stroke="#fff" stroke-width="6"/>' +
      '<rect x="190" y="230" width="520" height="160" fill="#39719f"/><rect x="190" y="420" width="520" height="160" fill="#39719f"/>' +
      '<rect x="190" y="610" width="520" height="160" fill="#39719f"/><rect x="190" y="800" width="520" height="160" fill="#39719f"/>' +
      '<text x="450" y="105" font-family="sans-serif" font-size="44" fill="#fff" text-anchor="middle">DEMO COOLER PHOTO</text>' +
      '<text x="450" y="1130" font-family="sans-serif" font-size="36" fill="#9cc3e8" text-anchor="middle">_id ' + id + '</text></svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  async function demoApi(action, p) {
    await new Promise(function (r) { setTimeout(r, 250); });
    switch (action) {
      case 'login':
        if ((p.username === 'demo' || p.username === 'admin') && p.password === p.username) {
          return { token: 'demo-token', user: { username: p.username, displayName: p.username === 'admin' ? 'Demo Admin' : 'Demo QC User', role: p.username === 'admin' ? 'admin' : 'qc' } };
        }
        throw new Error('Demo mode: sign in with demo/demo (or admin/admin). Configure js/config.js to connect the real backend.');
      case 'logout': return {};
      case 'bootstrap':
        var boot = { dates: ['2026-07-13'], version: 'demo', queue: { firstPage: 2, page: 2 } };
        if (p.date) {
          boot.folders = ['PEP COOLER', 'KO COOLER', 'OTHERS COOLER', 'STORES PHOTOS', 'MT SHELVES'];
          boot.filters = { cities: ['5.GJW', '6.LHR'], auditors: ['DEMO AUDITOR', 'DEMO AUDITOR 2'], channels: ['1.GT', '2.LMT'] };
        }
        return boot;
      case 'refreshDate':
        return { date: p.date, rowsAdded: 0, surveyRows: DEMO_QUEUE.length, photos: DEMO_QUEUE.length, folders: ['PEP COOLER'] };
      case 'getDates': return ['2026-07-13'];
      case 'getFolders': return ['PEP COOLER', 'KO COOLER', 'OTHERS COOLER', 'STORES PHOTOS', 'MT SHELVES'];
      case 'getFilters': return { cities: ['5.GJW', '6.LHR'], auditors: ['DEMO AUDITOR', 'DEMO AUDITOR 2'], channels: ['1.GT', '2.LMT'] };
      case 'getQueue':
        var all = DEMO_QUEUE.filter(function (q) {
          return (!p.city || q.city === p.city) && (!p.auditor || q.auditor === p.auditor) && (!p.channel || q.channel === p.channel);
        });
        var off = Number(p.offset) || 0;
        var lim = Number(p.limit) > 0 ? Number(p.limit) : all.length;
        var items = all.slice(off, off + lim).map(function (q) {
          return Object.assign({}, q, {
            shopStatus: 'Completed Interview',
            values: DEMO_MEASURES.map(function (m) { return q.vals && q.vals[m[0]] !== undefined ? q.vals[m[0]] : m[1]; }),
            images: [{ fileId: 'demo-' + q.id, name: 'DEMO_' + q.id + '.jpg' }]
          });
        });
        return {
          items: items,
          schema: DEMO_MEASURES.map(function (m) {
            return { header: m[0], readOnly: false, isOption: m[0].indexOf('/') !== -1, options: m[2] || [] };
          }),
          total: all.length, offset: off,
          unmatchedImages: 0
        };
      case 'getRecord':
        var q = DEMO_QUEUE.filter(function (x) { return x.id === String(p.id); })[0] || DEMO_QUEUE[0];
        return {
          id: q.id, rowNum: 2,
          context: [
            { label: '_id', value: q.id }, { label: 'Select City Name', value: q.city },
            { label: 'Select Auditor Name', value: q.auditor }, { label: 'Select Store ID', value: q.storeId },
            { label: 'Select Store Name', value: q.storeName }, { label: 'Channel Type', value: q.channel },
            { label: '1.9: Shop Status Code', value: 'Completed Interview' }
          ],
          measures: DEMO_MEASURES.map(function (m) {
            return { header: m[0], value: m[1], readOnly: false, isOption: m[0].indexOf('/') !== -1, options: m[2] || [] };
          }),
          images: [{ fileId: 'demo', name: 'DEMO_' + q.id + '.jpg', directUrl: demoImage(q.id) }],
          qc: {}
        };
      case 'getImage': return { mime: 'image/svg+xml', base64: demoImage(String(p.fileId)).split(',')[1] };
      case 'saveQC':
        var it = DEMO_QUEUE.filter(function (x) { return x.id === String(p.id); })[0];
        if (it) { it.qcStatus = p.status || 'DONE'; it.qcUser = 'demo'; }
        demoSession.saves++;
        demoSession.photos[String(p.id)] = 1;
        demoSession.changes += Object.keys(p.changes || {}).length;
        if (p.status === 'FLAGGED') demoSession.flagged++;
        return { id: String(p.id), status: p.status || 'DONE', changed: Object.keys(p.changes || {}).length };
      case 'getSessionSummary':
        return {
          username: 'demo', displayName: 'Demo QC User',
          photosAudited: Object.keys(demoSession.photos).length,
          saves: demoSession.saves,
          changesMade: demoSession.changes,
          flagged: demoSession.flagged,
          sessionStart: demoSession.start,
          lastSave: demoSession.saves ? nowStr() : '',
          totalMinutes: Math.max(1, Math.round((Date.now() - demoSession.startMs) / 60000)),
          byFolder: demoSession.saves ? [{ folderType: 'PEP COOLER', photos: Object.keys(demoSession.photos).length, changes: demoSession.changes }] : []
        };
      case 'listSessions':
        return [
          { username: 'demo', start: '2026-07-15 09:12:04', end: '2026-07-15 11:41:30', durationMin: 149, photos: 118, saves: 121, changes: 34, flagged: 5 },
          { username: 'qc.ali', start: '2026-07-15 08:55:10', end: '2026-07-15 10:02:45', durationMin: 67, photos: 64, saves: 64, changes: 12, flagged: 1 }
        ];
      case 'listUsers':
        return [{ username: 'admin', displayName: 'Demo Admin', role: 'admin', active: true, createdAt: '2026-07-15', createdBy: 'setup' },
                { username: 'demo', displayName: 'Demo QC User', role: 'qc', active: true, createdAt: '2026-07-15', createdBy: 'admin' }];
      case 'createUser': case 'setPassword': case 'setActive': return {};
      case 'getProgress':
        return { date: p.date, sheetUrl: '#', progress: [
          { folderType: 'PEP COOLER', images: 354, matched: 350, done: 120, flagged: 3, pending: 227 },
          { folderType: 'KO COOLER', images: 99, matched: 98, done: 40, flagged: 1, pending: 57 },
          { folderType: 'OTHERS COOLER', images: 41, matched: 41, done: 41, flagged: 0, pending: 0 },
          { folderType: 'STORES PHOTOS', images: 399, matched: 399, done: 0, flagged: 0, pending: 399 },
          { folderType: 'MT SHELVES', images: 8, matched: 8, done: 8, flagged: 0, pending: 0 }
        ] };
      case 'listHalfMonths': return [{ month: '2026-07', half: 'H1', built: false, url: '' }];
      case 'buildHalfMonth':
        return { month: p.month, half: p.half, name: 'QC RD ' + p.month + '-' + p.half, url: '#',
                 latest: p.month + '-15', total: 2, done: 2, remaining: 0, complete: true,
                 rows: DEMO_QUEUE.length, columns: 12, datesMissingQcSheet: [],
                 rowsPulledIn: 0, refreshFailures: 0, refreshWarnings: [],
                 extraColumns: [], extraColumnCount: 0 };
      case 'exportQc': throw new Error('Export is not available in demo mode');
      default: throw new Error('Unknown demo action ' + action);
    }
  }

  window.QCApi = { call: api, saveSession: saveSession, clearSession: clearSession, currentUser: currentUser, isDemo: isDemo };
})();
