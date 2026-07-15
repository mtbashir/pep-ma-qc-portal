/* PEP MA QC Portal — API client (talks to the Apps Script web app). */
(function () {
  'use strict';

  var TOKEN_KEY = 'qc_token';
  var USER_KEY = 'qc_user';

  function isDemo() {
    return !window.QC_CONFIG.API_URL || window.QC_CONFIG.API_URL.indexOf('PASTE_') === 0;
  }

  /** POST one action to the backend. Resolves the `data` payload or throws. */
  async function api(action, params) {
    params = params || {};
    if (isDemo()) return demoApi(action, params);

    var body = Object.assign({ action: action, token: localStorage.getItem(TOKEN_KEY) || '' }, params);
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
      if (/^AUTH:/.test(out.error || '')) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        err.auth = true;
      }
      throw err;
    }
    return out.data;
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
      case 'getDates': return ['2026-07-13'];
      case 'getFolders': return ['PEP COOLER', 'KO COOLER', 'OTHERS COOLER', 'STORES PHOTOS', 'MT SHELVES'];
      case 'getFilters': return { cities: ['5.GJW', '6.LHR'], auditors: ['DEMO AUDITOR', 'DEMO AUDITOR 2'], channels: ['1.GT', '2.LMT'] };
      case 'getQueue':
        return { items: DEMO_QUEUE.filter(function (q) {
          return (!p.city || q.city === p.city) && (!p.auditor || q.auditor === p.auditor) && (!p.channel || q.channel === p.channel);
        }), unmatchedImages: 0 };
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
        return { id: String(p.id), status: p.status || 'DONE', changed: Object.keys(p.changes || {}).length };
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
      case 'exportQc': throw new Error('Export is not available in demo mode');
      default: throw new Error('Unknown demo action ' + action);
    }
  }

  window.QCApi = { call: api, saveSession: saveSession, clearSession: clearSession, currentUser: currentUser, isDemo: isDemo };
})();
