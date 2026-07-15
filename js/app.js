/* PEP MA QC Portal — main application. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = {
    dates: [], folders: [], queue: [], pos: -1,
    record: null,          // current getRecord payload
    qcStart: null,         // ISO time when current record was shown
    imageIndex: 0,
    filters: { date: '', folderType: '', city: '', auditor: '', channel: '' }
  };

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

  $('btn-logout').addEventListener('click', async function () {
    try { await window.QCApi.call('logout'); } catch (e) { /* ignore */ }
    window.QCApi.clearSession();
    location.reload();
  });

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
      state.dates = await window.QCApi.call('getDates');
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
      var folders = await window.QCApi.call('getFolders', { date: date });
      var filters = await window.QCApi.call('getFilters', { date: date });
      fillSelect($('f-folder'), folders, 'Folder…');
      fillSelect($('f-city'), filters.cities, 'All cities');
      fillSelect($('f-auditor'), filters.auditors, 'All auditors');
      fillSelect($('f-channel'), filters.channels, 'All channels');
      ['f-folder', 'f-city', 'f-auditor', 'f-channel'].forEach(function (id) { $(id).disabled = false; });
      hideToast();
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
  });

  $('f-folder').addEventListener('change', function () {
    $('btn-load').disabled = !this.value;
  });

  $('btn-load').addEventListener('click', loadQueue);

  /* ================= queue ================= */

  async function loadQueue() {
    state.filters = {
      date: $('f-date').value, folderType: $('f-folder').value,
      city: $('f-city').value, auditor: $('f-auditor').value, channel: $('f-channel').value
    };
    if (!state.filters.date || !state.filters.folderType) return;
    $('btn-load').disabled = true;
    toast('Building QC queue…');
    try {
      var data = await window.QCApi.call('getQueue', state.filters);
      state.queue = data.items;
      $('queue-bar').classList.remove('hidden');
      var stats = state.queue.length + ' photos';
      var done = state.queue.filter(function (q) { return q.qcStatus === 'DONE'; }).length;
      var flagged = state.queue.filter(function (q) { return q.qcStatus === 'FLAGGED'; }).length;
      stats += ' · ' + done + ' done · ' + flagged + ' flagged';
      if (data.unmatchedImages) stats += ' · ' + data.unmatchedImages + ' images without survey data';
      $('queue-stats').textContent = stats;
      renderJump();
      hideToast();
      if (!state.queue.length) {
        toast('No photos match this selection', 'err');
        $('workspace').classList.add('hidden');
        $('empty-state').classList.remove('hidden');
        return;
      }
      goTo(firstPending());
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
    finally { $('btn-load').disabled = false; }
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
    if (i < 0 || i >= state.queue.length) { toast(dir > 0 ? 'End of queue 🎉' : 'Start of queue', 'ok'); return; }
    goTo(i);
  }

  async function goTo(i) {
    if (i < 0 || i >= state.queue.length) return;
    state.pos = i;
    $('queue-jump').value = i;
    $('queue-pos').textContent = (i + 1) + ' / ' + state.queue.length;
    $('empty-state').classList.add('hidden');
    $('workspace').classList.remove('hidden');
    $('context-table').innerHTML = '<tr><td class="k">Loading…</td></tr>';
    $('measures-table').innerHTML = '';
    showImageMsg('Loading photo…');
    try {
      var rec = await window.QCApi.call('getRecord', {
        date: state.filters.date, folderType: state.filters.folderType, id: state.queue[i].id
      });
      state.record = rec;
      state.qcStart = new Date().toISOString();
      state.imageIndex = 0;
      renderRecord(rec);
      loadImage(rec, 0);
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

  function loadImage(rec, index) {
    var thumbs = $('image-thumbs');
    thumbs.classList.toggle('hidden', rec.images.length < 2);
    if (rec.images.length > 1) {
      thumbs.innerHTML = '';
      rec.images.forEach(function (im, j) {
        var t = document.createElement('img');
        t.src = im.directUrl.indexOf('data:') === 0 ? im.directUrl : im.directUrl + '=s120';
        t.className = j === index ? 'active' : '';
        t.onclick = function () { loadImage(rec, j); };
        thumbs.appendChild(t);
      });
    }
    state.imageIndex = index;
    var image = rec.images[index];
    if (!image) { showImageMsg('No photo found for this survey in the selected folder.', true); return; }
    $('image-name').textContent = image.name;
    showImageMsg('Loading photo…');

    var triedApi = false;
    img.onload = function () {
      view.natW = img.naturalWidth; view.natH = img.naturalHeight; view.rotation = 0;
      fitImage(); hideImageMsg();
    };
    img.onerror = function () {
      if (!triedApi && image.fileId !== 'demo') {
        triedApi = true;
        showImageMsg('Loading photo via API…');
        window.QCApi.call('getImage', { fileId: image.fileId }).then(function (d) {
          img.src = 'data:' + d.mime + ';base64,' + d.base64;
        }).catch(function (e) {
          showImageMsg('Could not load photo: ' + e.message, true);
        });
      } else {
        showImageMsg('Could not load photo.', true);
      }
    };
    if (image.directUrl.indexOf('data:') === 0) {
      img.src = image.directUrl;
    } else if (window.QC_CONFIG.DIRECT_IMAGES) {
      img.src = image.directUrl + '=s' + (window.QC_CONFIG.IMAGE_SIZE || 2400);
    } else {
      img.onerror(); // go straight to API
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
      var q = state.queue[state.pos];
      q.qcStatus = res.status;
      renderJump();
      $('queue-jump').value = state.pos;
      var done = state.queue.filter(function (x) { return x.qcStatus === 'DONE'; }).length;
      var flagged = state.queue.filter(function (x) { return x.qcStatus === 'FLAGGED'; }).length;
      $('queue-stats').textContent = state.queue.length + ' photos · ' + done + ' done · ' + flagged + ' flagged';
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
