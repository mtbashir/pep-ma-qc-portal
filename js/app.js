/* PEP MA QC Portal — main application. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    dates: [], folders: [], queue: [], pos: -1,
    record: null,          // current getRecord payload
    qcStart: null,         // ISO time when current record was shown
    imageIndex: 0,
    filters: { date: '', folderType: '', city: '', auditor: '', channel: '' },
    session: { photos: {}, changes: 0, flagged: 0 },  // local live counters
    recordCache: {},      // key -> getRecord payload (prefetched)
    imageCache: {},       // fileId -> resolved img src
    imageOrder: [],       // fileIds in load order, for eviction
    navToken: 0,          // guards against out-of-order navigation
    loadToken: 0,         // guards background paging against filter changes
    total: 0,             // photos matching the filters (may exceed loaded)
    unmatched: 0,
    pageSizes: { firstPage: 60, page: 150 }
  };

  var IMAGE_CACHE_MAX = 12;

  /* ================= boot / auth ================= */

  function showLogin() {
    $('login-screen').classList.remove('hidden');
    $('app-screen').classList.add('hidden');
    if (window.QCApi.isDemo()) $('demo-banner').classList.remove('hidden');
  }

  function showApp(user) {
    $('login-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    $('user-name').textContent = user.displayName + ' (' + user.username + ')';
    if (user.role === 'admin') $('admin-link').classList.remove('hidden');
    loadDates();
  }

  async function boot() {
    var user = window.QCApi.currentUser();
    if (!user) return showLogin();
    try {
      await window.QCApi.call('me');
      showApp(user);
    } catch (e) {
      window.QCApi.clearSession();
      showLogin();
    }
  }

  $('login-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var btn = $('login-btn'); btn.disabled = true; btn.textContent = 'Signing in…';
    $('login-error').classList.add('hidden');
    try {
      var data = await window.QCApi.call('login', {
        username: $('login-username').value.trim(),
        password: $('login-password').value
      });
      window.QCApi.saveSession(data);
      showApp(data.user);
    } catch (e) {
      $('login-error').textContent = e.message;
      $('login-error').classList.remove('hidden');
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });

  async function doLogout() {
    try { await window.QCApi.call('logout'); } catch (e) { /* ignore */ }
    window.QCApi.clearSession();
    location.reload();
  }

  // Sign out shows the session summary first (falls back to plain logout
  // if the backend does not support summaries yet)
  $('btn-logout').addEventListener('click', function () { openSummary(true); });
  $('btn-session').addEventListener('click', function () { openSummary(false); });
  $('summary-close').addEventListener('click', function () { $('summary-modal').classList.add('hidden'); });
  $('summary-signout').addEventListener('click', doLogout);

  /* ================= session summary ================= */

  function fmtDuration(min) {
    min = Number(min) || 0;
    return min >= 60 ? Math.floor(min / 60) + 'h ' + ('0' + (min % 60)).slice(-2) + 'm' : min + 'm';
  }

  function updateSessionStats() {
    var n = Object.keys(state.session.photos).length;
    $('session-stats').textContent = n
      ? 'You this session: ' + n + ' QC’d · ' + state.session.changes + ' changes'
      : '';
  }

  async function openSummary(fromSignout) {
    var s;
    try {
      s = await window.QCApi.call('getSessionSummary');
    } catch (e) {
      if (fromSignout) { doLogout(); return; }
      toast(e.message, 'err'); if (e.auth) showLogin();
      return;
    }
    $('summary-user').textContent = (s.displayName || s.username) +
      (s.sessionStart ? ' — signed in ' + s.sessionStart : '');
    var rows = [
      ['Pictures audited', s.photosAudited],
      ['Saves', s.saves],
      ['Changes made', s.changesMade],
      ['Flagged', s.flagged],
      ['Session start', s.sessionStart || '—'],
      ['Last save', s.lastSave || '—'],
      ['Total time', fmtDuration(s.totalMinutes)]
    ];
    var tbl = $('summary-table');
    tbl.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="k"></td><td class="v"></td>';
      tr.children[0].textContent = r[0];
      tr.children[1].textContent = String(r[1]);
      tbl.appendChild(tr);
    });
    var fld = $('summary-folders');
    fld.innerHTML = '';
    (s.byFolder || []).forEach(function (f) {
      var div = document.createElement('div');
      div.textContent = f.folderType + ': ' + f.photos + ' photos · ' + f.changes + ' changes';
      fld.appendChild(div);
    });
    $('summary-signout').classList.toggle('hidden', !fromSignout);
    $('summary-modal').classList.remove('hidden');
  }

  /* ================= filters ================= */

  function fillSelect(sel, values, placeholder) {
    sel.innerHTML = '';
    var opt = document.createElement('option');
    opt.value = ''; opt.textContent = placeholder;
    sel.appendChild(opt);
    values.forEach(function (v) {
      var o = document.createElement('option');
      o.value = typeof v === 'object' ? v.value : v;
      o.textContent = typeof v === 'object' ? v.label : v;
      sel.appendChild(o);
    });
  }

  async function loadDates() {
    try {
      var boot = await window.QCApi.call('bootstrap', {});
      state.dates = boot.dates;
      if (boot.queue) state.pageSizes = boot.queue;
      fillSelect($('f-date'), state.dates, 'Date…');
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
  }

  $('f-date').addEventListener('change', async function () {
    var date = this.value;
    ['f-folder', 'f-city', 'f-auditor', 'f-channel'].forEach(function (id) { $(id).disabled = true; });
    $('btn-load').disabled = true;
    if (!date) return;
    try {
      toast('Loading folders & filters…');
      // folders + filters in a single round trip
      var boot = await window.QCApi.call('bootstrap', { date: date });
      fillSelect($('f-folder'), boot.folders, 'Folder…');
      fillSelect($('f-city'), boot.filters.cities, 'All cities');
      fillSelect($('f-auditor'), boot.filters.auditors, 'All auditors');
      fillSelect($('f-channel'), boot.filters.channels, 'All channels');
      ['f-folder', 'f-city', 'f-auditor', 'f-channel'].forEach(function (id) { $(id).disabled = false; });
      hideToast();
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
  });

  $('f-folder').addEventListener('change', function () {
    $('btn-load').disabled = !this.value;
  });

  $('btn-load').addEventListener('click', loadQueue);

  /* ================= queue ================= */

  function updateQueueStats() {
    var done = state.queue.filter(function (q) { return q.qcStatus === 'DONE'; }).length;
    var flagged = state.queue.filter(function (q) { return q.qcStatus === 'FLAGGED'; }).length;
    var stats = state.total + ' photos · ' + done + ' done · ' + flagged + ' flagged';
    if (state.queue.length < state.total) {
      stats += ' · loading ' + state.queue.length + '/' + state.total + '…';
    }
    if (state.unmatched) stats += ' · ' + state.unmatched + ' images without survey data';
    $('queue-stats').textContent = stats;
  }

  async function loadQueue() {
    state.filters = {
      date: $('f-date').value, folderType: $('f-folder').value,
      city: $('f-city').value, auditor: $('f-auditor').value, channel: $('f-channel').value
    };
    if (!state.filters.date || !state.filters.folderType) return;
    state.recordCache = {};   // different date/folder -> different records
    var token = ++state.loadToken;
    $('btn-load').disabled = true;
    toast('Building QC queue…');
    try {
      // small first page so QC can start straight away
      var data = await window.QCApi.call('getQueue', Object.assign({
        limit: state.pageSizes.firstPage, offset: 0
      }, state.filters));
      if (token !== state.loadToken) return;

      state.queue = data.items;
      state.schema = data.schema || null;
      state.total = data.total === undefined ? data.items.length : data.total;
      state.unmatched = data.unmatchedImages || 0;
      $('queue-bar').classList.remove('hidden');
      updateQueueStats();
      renderJump();
      hideToast();
      if (!state.queue.length) {
        toast('No photos match this selection', 'err');
        $('workspace').classList.add('hidden');
        $('empty-state').classList.remove('hidden');
        return;
      }
      goTo(firstPending());
      loadRemainingPages(token);          // continues while the user works
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
    finally { $('btn-load').disabled = false; }
  }

  /** Pulls the rest of the queue in the background, page by page. */
  async function loadRemainingPages(token) {
    while (state.queue.length < state.total) {
      if (token !== state.loadToken) return;      // filters changed — abandon
      try {
        var page = await window.QCApi.call('getQueue', Object.assign({
          limit: state.pageSizes.page, offset: state.queue.length
        }, state.filters));
        if (token !== state.loadToken) return;
        if (!page.items.length) break;            // nothing more to add
        state.queue = state.queue.concat(page.items);
        var pos = state.pos;
        renderJump();
        $('queue-jump').value = pos;
        updateQueueStats();
      } catch (e) {
        if (e.auth) { showLogin(); return; }
        return;                                    // leave what we have loaded
      }
    }
    updateQueueStats();
  }

  function firstPending() {
    if (!$('chk-skip-done').checked) return 0;
    for (var i = 0; i < state.queue.length; i++) {
      if (!state.queue[i].qcStatus) return i;
    }
    return 0;
  }

  function renderJump() {
    var sel = $('queue-jump');
    sel.innerHTML = '';
    state.queue.forEach(function (q, i) {
      var o = document.createElement('option');
      var mark = q.qcStatus === 'DONE' ? '✔ ' : q.qcStatus === 'FLAGGED' ? '⚑ ' : '';
      o.value = i;
      o.textContent = (i + 1) + '. ' + mark + q.id + ' — ' + q.storeName;
      sel.appendChild(o);
    });
    sel.onchange = function () { goTo(Number(sel.value)); };
  }

  $('btn-prev').addEventListener('click', function () { step(-1); });
  $('btn-next').addEventListener('click', function () { step(1); });

  function step(dir) {
    if (!state.queue.length) return;
    var i = state.pos + dir;
    if ($('chk-skip-done').checked) {
      while (i >= 0 && i < state.queue.length && state.queue[i].qcStatus === 'DONE') i += dir;
    }
    if (i < 0) { toast('Start of queue', 'ok'); return; }
    if (i >= state.queue.length) {
      // the rest of the queue may still be streaming in
      if (state.queue.length < state.total) { toast('Loading more photos…'); return; }
      toast('End of queue 🎉', 'ok');
      return;
    }
    goTo(i);
  }

  function recordKey(id) {
    return state.filters.date + '|' + state.filters.folderType + '|' + id;
  }

  var CONTEXT_FIELDS = [
    ['Select City Name', 'city'], ['Select Auditor Name', 'auditor'],
    ['Select Store ID', 'storeId'], ['Select Store Name', 'storeName'],
    ['Channel Type', 'channel'], ['1.9: Shop Status Code', 'shopStatus']
  ];

  /**
   * Builds the record straight from the queue payload — the queue already
   * carries every measure value and photo id, so moving between photos needs
   * no server call at all.
   */
  function buildRecord(item) {
    if (!state.schema || !item.values) return null;
    var context = [{ label: '_id', value: item.id }];
    CONTEXT_FIELDS.forEach(function (f) {
      context.push({ label: f[0], value: item[f[1]] || '' });
    });
    return {
      id: item.id,
      context: context,
      measures: state.schema.map(function (s, k) {
        return {
          header: s.header, value: item.values[k] === undefined ? '' : item.values[k],
          readOnly: s.readOnly, isOption: s.isOption, options: s.options
        };
      }),
      images: (item.images || []).map(function (im) {
        return { fileId: im.fileId, name: im.name, directUrl: 'https://lh3.googleusercontent.com/d/' + im.fileId };
      }),
      qc: { status: item.qcStatus, user: item.qcUser, end: item.qcEnd }
    };
  }

  /** Local build first; only falls back to the server if values are missing. */
  function fetchRecord(id, useCache) {
    var key = recordKey(id);
    if (useCache !== false && state.recordCache[key]) return Promise.resolve(state.recordCache[key]);

    var item = state.queue.filter(function (q) { return q.id === id; })[0];
    var local = item && buildRecord(item);
    if (local) { state.recordCache[key] = local; return Promise.resolve(local); }

    return window.QCApi.call('getRecord', {
      date: state.filters.date, folderType: state.filters.folderType, id: id
    }).then(function (rec) {
      state.recordCache[key] = rec;
      return rec;
    });
  }

  /**
   * Loads the next queue item (and its photo) in the background while the
   * user is working on the current one, so navigation feels instant.
   */
  function prefetch(i) {
    if (i < 0 || i >= state.queue.length) return;
    var id = state.queue[i].id;
    if (state.recordCache[recordKey(id)]) return;
    fetchRecord(id)
      .then(function (rec) { if (rec.images && rec.images[0]) return resolveImageSrc(rec.images[0]); })
      .catch(function () { /* prefetch is best-effort */ });
  }

  async function goTo(i) {
    if (i < 0 || i >= state.queue.length) return;
    var token = ++state.navToken;
    state.pos = i;
    $('queue-jump').value = i;
    $('queue-pos').textContent = (i + 1) + ' / ' + (state.total || state.queue.length);
    $('empty-state').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('context-table').innerHTML = '<tr><td class="k">Loading…</td></tr>';
    $('measures-table').innerHTML = '';
    showImageMsg('Loading photo…');
    try {
      var rec = await fetchRecord(state.queue[i].id);
      if (token !== state.navToken) return;   // user already moved on
      state.record = rec;
      state.qcStart = new Date().toISOString();
      state.imageIndex = 0;
      renderRecord(rec);
      loadImage(rec, 0, token);
      prefetch(i + 1);
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
  }

  /* ================= record rendering ================= */

  function shortLabel(header) {
    // strip the redundant folder-type wording to keep the left panel compact
    return header
      .replace(/Brand Facings\s*[—–-]*\s*(PEP|KO|Other|LMT Primary)?\s*(Cooler|Shelf)?\s*/i, 'Facings ')
      .replace(/\s{2,}/g, ' ').trim();
  }

  function renderRecord(rec) {
    var ctx = $('context-table');
    ctx.innerHTML = '';
    rec.context.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="k"></td><td class="v"></td>';
      tr.children[0].textContent = c.label.replace(/^Select /, '');
      tr.children[1].textContent = c.value;
      ctx.appendChild(tr);
    });

    $('measures-title').textContent = state.filters.folderType + ' — measures';
    var tbl = $('measures-table');
    tbl.innerHTML = '';
    rec.measures.forEach(function (m, idx) {
      var tr = document.createElement('tr');
      if (m.isOption) tr.className = 'option-row';
      var tdK = document.createElement('td'); tdK.className = 'k';
      tdK.textContent = shortLabel(m.header);
      tdK.title = m.header;
      var tdV = document.createElement('td'); tdV.className = 'v';

      var input;
      if (!m.readOnly && m.options && m.options.length) {
        input = document.createElement('select');
        var cur = document.createElement('option');
        // ensure current value is always present
        var vals = m.options.slice();
        if (vals.indexOf(m.value) === -1) vals.unshift(m.value);
        vals.forEach(function (opt) {
          var o = document.createElement('option');
          o.value = opt; o.textContent = opt === '' ? '(empty)' : opt;
          input.appendChild(o);
        });
        input.value = m.value;
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.value = m.value;
        if (m.readOnly) input.readOnly = true;
        if (/^-?\d+(\.\d+)?$/.test(m.value)) input.inputMode = 'numeric';
      }
      input.dataset.header = m.header;
      input.dataset.original = m.value;
      input.addEventListener('input', markChanged);
      input.addEventListener('change', markChanged);
      tdV.appendChild(input);
      tr.appendChild(tdK); tr.appendChild(tdV);
      tbl.appendChild(tr);
    });

    var line = $('qc-status-line');
    if (rec.qc && rec.qc.status) {
      line.innerHTML = 'QC: <span class="' + rec.qc.status.toLowerCase() + '">' + rec.qc.status + '</span>' +
        (rec.qc.user ? ' by ' + escapeHtml(rec.qc.user) : '') +
        (rec.qc.end ? ' · ' + escapeHtml(rec.qc.end) : '');
    } else {
      line.innerHTML = '<span class="chip pending">PENDING QC</span>';
    }
  }

  function markChanged(ev) {
    var el = ev.target;
    el.classList.toggle('changed', el.value !== el.dataset.original);
  }

  function collectChanges() {
    var changes = {};
    $('measures-table').querySelectorAll('input,select').forEach(function (el) {
      if (!el.readOnly && el.value !== el.dataset.original) changes[el.dataset.header] = el.value;
    });
    return changes;
  }

  $('btn-reset').addEventListener('click', function () {
    $('measures-table').querySelectorAll('input,select').forEach(function (el) {
      el.value = el.dataset.original;
      el.classList.remove('changed');
    });
  });

  function escapeHtml(s) {
    var d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
  }

  /* ================= image viewer ================= */

  var view = { scale: 1, x: 0, y: 0, rotation: 0, natW: 0, natH: 0 };
  var img = $('qc-image');
  var stage = $('image-stage');

  function showImageMsg(msg, isError) {
    img.style.visibility = 'hidden';
    $('image-loading').classList.toggle('hidden', !!isError);
    if (!isError) $('image-loading').textContent = msg;
    $('image-error').classList.toggle('hidden', !isError);
    if (isError) $('image-error').textContent = msg;
  }
  function hideImageMsg() {
    img.style.visibility = 'visible';
    $('image-loading').classList.add('hidden');
    $('image-error').classList.add('hidden');
  }

  /** Loads a URL into a detached Image; resolves with the url or rejects. */
  function probeUrl(url) {
    return new Promise(function (resolve, reject) {
      var probe = new Image();
      probe.onload = function () { resolve(url); };
      probe.onerror = reject;
      probe.src = url;
    });
  }

  function cacheImageSrc(fileId, src) {
    if (!state.imageCache[fileId]) state.imageOrder.push(fileId);
    state.imageCache[fileId] = src;
    while (state.imageOrder.length > IMAGE_CACHE_MAX) {
      delete state.imageCache[state.imageOrder.shift()];
    }
    return src;
  }

  /**
   * Resolves a displayable src for a photo: cache -> Google direct CDN ->
   * API (which returns a size-limited thumbnail). Cached per file id so
   * revisiting a photo is instant.
   */
  async function resolveImageSrc(image) {
    if (!image) return null;
    if (image.directUrl && image.directUrl.indexOf('data:') === 0) return image.directUrl;
    if (state.imageCache[image.fileId]) return state.imageCache[image.fileId];

    var size = window.QC_CONFIG.IMAGE_SIZE || 1600;
    if (window.QC_CONFIG.DIRECT_IMAGES && image.directUrl) {
      try { return cacheImageSrc(image.fileId, await probeUrl(image.directUrl + '=s' + size)); }
      catch (e) { /* not shared publicly — fall back to the API */ }
    }
    // The API client already retries dropped requests; the extra attempt here
    // asks for a smaller image, since big payloads are the ones Apps Script
    // most often fails to deliver.
    try {
      var d = await window.QCApi.call('getImage', { fileId: image.fileId, size: size });
      return cacheImageSrc(image.fileId, 'data:' + d.mime + ';base64,' + d.base64);
    } catch (e) {
      if (e.auth) throw e;
      var small = await window.QCApi.call('getImage', { fileId: image.fileId, size: Math.round(size * 0.6) });
      return cacheImageSrc(image.fileId, 'data:' + small.mime + ';base64,' + small.base64);
    }
  }

  async function loadImage(rec, index, token) {
    var thumbs = $('image-thumbs');
    thumbs.classList.toggle('hidden', rec.images.length < 2);
    if (rec.images.length > 1) {
      thumbs.innerHTML = '';
      rec.images.forEach(function (im, j) {
        var t = document.createElement('img');
        t.src = im.directUrl.indexOf('data:') === 0 ? im.directUrl : im.directUrl + '=s120';
        t.className = j === index ? 'active' : '';
        t.onclick = function () { loadImage(rec, j, token); };
        thumbs.appendChild(t);
      });
    }
    state.imageIndex = index;
    var image = rec.images[index];
    if (!image) { showImageMsg('No photo found for this survey in the selected folder.', true); return; }
    $('image-name').textContent = image.name;
    if (!state.imageCache[image.fileId]) showImageMsg('Loading photo…');

    img.onload = function () {
      view.natW = img.naturalWidth; view.natH = img.naturalHeight; view.rotation = 0;
      fitImage(); hideImageMsg();
    };
    img.onerror = function () { showImageMsg('Could not load photo.', true); };

    try {
      var src = await resolveImageSrc(image);
      if (token !== undefined && token !== state.navToken) return;  // stale
      img.src = src;
    } catch (e) {
      // never let a failure from a photo the user has already left behind
      // paint an error over the photo they are looking at now
      if (token !== undefined && token !== state.navToken) return;
      showImageMsg('Could not load photo: ' + e.message, true);
      var retry = document.createElement('button');
      retry.className = 'btn';
      retry.style.marginLeft = '12px';
      retry.textContent = '↻ Retry';
      retry.onclick = function () {
        delete state.imageCache[image.fileId];
        loadImage(rec, index, state.navToken);
      };
      $('image-error').appendChild(retry);
    }
  }

  function applyView() {
    img.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.scale + ') rotate(' + view.rotation + 'deg)';
  }

  function fitImage() {
    if (!view.natW) return;
    var rotated = view.rotation % 180 !== 0;
    var w = rotated ? view.natH : view.natW;
    var h = rotated ? view.natW : view.natH;
    var sw = stage.clientWidth, sh = stage.clientHeight;
    view.scale = Math.min(sw / w, sh / h);
    // rotation happens around the image origin; compensate offsets per quadrant
    var offX = 0, offY = 0;
    var r = ((view.rotation % 360) + 360) % 360;
    if (r === 90) offX = view.natH * view.scale;
    if (r === 180) { offX = view.natW * view.scale; offY = view.natH * view.scale; }
    if (r === 270) offY = view.natW * view.scale;
    view.x = (sw - w * view.scale) / 2 + offX;
    view.y = (sh - h * view.scale) / 2 + offY;
    applyView();
  }

  function zoomAt(cx, cy, factor) {
    var newScale = Math.min(Math.max(view.scale * factor, 0.05), 12);
    factor = newScale / view.scale;
    view.x = cx - (cx - view.x) * factor;
    view.y = cy - (cy - view.y) * factor;
    view.scale = newScale;
    applyView();
  }

  stage.addEventListener('wheel', function (ev) {
    ev.preventDefault();
    var rect = stage.getBoundingClientRect();
    zoomAt(ev.clientX - rect.left, ev.clientY - rect.top, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  var drag = null;
  stage.addEventListener('mousedown', function (ev) {
    drag = { x: ev.clientX, y: ev.clientY, vx: view.x, vy: view.y };
  });
  window.addEventListener('mousemove', function (ev) {
    if (!drag) return;
    view.x = drag.vx + (ev.clientX - drag.x);
    view.y = drag.vy + (ev.clientY - drag.y);
    applyView();
  });
  window.addEventListener('mouseup', function () { drag = null; });
  stage.addEventListener('dblclick', fitImage);

  $('btn-zoom-in').addEventListener('click', function () { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1.3); });
  $('btn-zoom-out').addEventListener('click', function () { zoomAt(stage.clientWidth / 2, stage.clientHeight / 2, 1 / 1.3); });
  $('btn-zoom-fit').addEventListener('click', fitImage);
  $('btn-zoom-100').addEventListener('click', function () { view.scale = 1; applyView(); });
  $('btn-rotate').addEventListener('click', function () { view.rotation = (view.rotation + 90) % 360; fitImage(); });
  window.addEventListener('resize', fitImage);

  /* ================= save / flag ================= */

  async function save(status, remarks) {
    if (!state.record) return;
    var btn = $('btn-save');
    btn.disabled = true;
    try {
      var payload = {
        date: state.filters.date,
        folderType: state.filters.folderType,
        id: state.record.id,
        changes: collectChanges(),
        qcStart: state.qcStart,
        qcEnd: new Date().toISOString(),
        status: status || 'DONE',
        remarks: remarks || ''
      };
      var res = await window.QCApi.call('saveQC', payload);
      delete state.recordCache[recordKey(payload.id)];   // QC status changed
      state.session.photos[payload.date + '|' + payload.folderType + '|' + payload.id] = 1;
      state.session.changes += res.changed || 0;
      if (res.status === 'FLAGGED') state.session.flagged++;
      updateSessionStats();
      var q = state.queue[state.pos];
      q.qcStatus = res.status;
      q.qcUser = (window.QCApi.currentUser() || {}).username || q.qcUser;
      q.qcEnd = payload.qcEnd;
      // mirror the saved values (and the 0/1 option columns the backend syncs)
      // into the queue item, so the local rebuild stays accurate
      if (q.values && state.schema) {
        state.schema.forEach(function (s, k) {
          if (payload.changes[s.header] !== undefined) {
            q.values[k] = payload.changes[s.header];
            return;
          }
          Object.keys(payload.changes).forEach(function (parent) {
            if (s.header.indexOf(parent + '/') === 0) {
              var opt = s.header.slice(parent.length + 1);
              q.values[k] = String(payload.changes[parent]) === opt ? '1' : '0';
            }
          });
        });
      }
      renderJump();
      $('queue-jump').value = state.pos;
      updateQueueStats();
      toast(res.status === 'FLAGGED' ? 'Flagged ⚑' : 'Saved ✔' + (res.changed ? ' (' + res.changed + ' change' + (res.changed > 1 ? 's' : '') + ')' : ''), 'ok');
      if ($('chk-auto-next').checked) step(1); else goTo(state.pos);
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
    finally { btn.disabled = false; }
  }

  $('btn-save').addEventListener('click', function () { save('DONE'); });

  $('btn-flag').addEventListener('click', function () {
    $('flag-remarks').value = '';
    $('flag-modal').classList.remove('hidden');
    $('flag-remarks').focus();
  });
  $('flag-cancel').addEventListener('click', function () { $('flag-modal').classList.add('hidden'); });
  $('flag-confirm').addEventListener('click', function () {
    $('flag-modal').classList.add('hidden');
    save('FLAGGED', $('flag-remarks').value.trim());
  });

  /* ================= keyboard / toast ================= */

  document.addEventListener('keydown', function (ev) {
    if ($('app-screen').classList.contains('hidden')) return;
    if (!$('flag-modal').classList.contains('hidden')) return;
    if (!$('summary-modal').classList.contains('hidden')) return;
    var inField = /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault(); save('DONE'); return;
    }
    if (inField) return;
    if (ev.key === 'ArrowLeft') step(-1);
    if (ev.key === 'ArrowRight') step(1);
  });

  var toastTimer = null;
  function toast(msg, cls) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (cls ? ' ' + cls : '');
    clearTimeout(toastTimer);
    if (cls) toastTimer = setTimeout(hideToast, 3000);
  }
  function hideToast() { $('toast').className = 'toast hidden'; }

  boot();
})();
