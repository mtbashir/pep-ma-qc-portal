/* PEP MA QC Portal — admin page. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function showLogin() {
    $('login-screen').classList.remove('hidden');
    $('app-screen').classList.add('hidden');
    if (window.QCApi.isDemo()) $('demo-banner').classList.remove('hidden');
  }

  function showApp(user) {
    if (user.role !== 'admin') {
      $('login-error').textContent = 'This account is not an administrator.';
      $('login-error').classList.remove('hidden');
      window.QCApi.clearSession();
      return showLogin();
    }
    $('login-screen').classList.add('hidden');
    $('app-screen').classList.remove('hidden');
    $('user-name').textContent = user.displayName + ' (' + user.username + ')';
    refreshUsers();
    loadDates();
    loadSessions();
    loadHalves();
  }

  async function boot() {
    var user = window.QCApi.currentUser();
    if (!user) return showLogin();
    try { await window.QCApi.call('me'); showApp(user); }
    catch (e) {
      if (e.staleSession) return;   // a newer sign-in has superseded this check
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
    } finally { btn.disabled = false; btn.textContent = 'Sign in'; }
  });

  $('btn-logout').addEventListener('click', async function () {
    try { await window.QCApi.call('logout'); } catch (e) { /* ignore */ }
    window.QCApi.clearSession();
    location.reload();
  });

  /* ---------------- users ---------------- */

  async function refreshUsers() {
    try {
      var users = await window.QCApi.call('listUsers');
      var tb = $('users-table').querySelector('tbody');
      tb.innerHTML = '';
      users.forEach(function (u) {
        var tr = document.createElement('tr');
        tr.innerHTML =
          '<td></td><td></td><td></td>' +
          '<td><span class="chip ' + (u.active ? 'done' : 'pending') + '">' + (u.active ? 'ACTIVE' : 'DISABLED') + '</span></td>' +
          '<td></td><td></td>';
        tr.children[0].textContent = u.username;
        tr.children[1].textContent = u.displayName;
        tr.children[2].textContent = u.role;
        tr.children[4].textContent = (u.createdAt || '').slice(0, 10);

        var actions = tr.children[5];
        var pwBtn = document.createElement('button');
        pwBtn.className = 'btn'; pwBtn.textContent = 'Reset password';
        pwBtn.onclick = function () { resetPassword(u.username); };
        var actBtn = document.createElement('button');
        actBtn.className = 'btn'; actBtn.style.marginLeft = '6px';
        actBtn.textContent = u.active ? 'Disable' : 'Enable';
        actBtn.onclick = function () { toggleActive(u); };
        actions.appendChild(pwBtn); actions.appendChild(actBtn);
        tb.appendChild(tr);
      });
    } catch (e) { if (e.staleSession) return; toast(e.message, 'err'); if (e.auth) showLogin(); }
  }

  $('create-form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var msg = $('create-msg');
    msg.classList.add('hidden');
    try {
      await window.QCApi.call('createUser', {
        username: $('new-username').value.trim(),
        displayName: $('new-displayname').value.trim(),
        password: $('new-password').value,
        role: $('new-role').value
      });
      toast('User created ✔', 'ok');
      $('create-form').reset();
      refreshUsers();
    } catch (e) {
      msg.textContent = e.message;
      msg.classList.remove('hidden');
    }
  });

  async function resetPassword(username) {
    var pw = prompt('New password for "' + username + '" (min 6 characters):');
    if (!pw) return;
    try {
      await window.QCApi.call('setPassword', { username: username, password: pw });
      toast('Password updated ✔', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function toggleActive(u) {
    try {
      await window.QCApi.call('setActive', { username: u.username, active: !u.active });
      refreshUsers();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------------- user sessions ---------------- */

  function fmtDuration(min) {
    min = Number(min) || 0;
    return min >= 60 ? Math.floor(min / 60) + 'h ' + ('0' + (min % 60)).slice(-2) + 'm' : min + 'm';
  }

  async function loadSessions() {
    var tb = $('sessions-table').querySelector('tbody');
    try {
      var sessions = await window.QCApi.call('listSessions');
      tb.innerHTML = '';
      if (!sessions.length) {
        tb.innerHTML = '<tr><td colspan="8" style="color:var(--muted)">No QC activity yet.</td></tr>';
        return;
      }
      sessions.forEach(function (s) {
        var tr = document.createElement('tr');
        tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>';
        var vals = [s.username, s.start, s.end, fmtDuration(s.durationMin), s.photos, s.saves, s.changes, s.flagged];
        vals.forEach(function (v, i) { tr.children[i].textContent = String(v); });
        tb.appendChild(tr);
      });
    } catch (e) {
      tb.innerHTML = '<tr><td colspan="8" style="color:var(--muted)">Not available — update the backend: paste the latest apps-script/Code.gs and deploy a new version.</td></tr>';
    }
  }

  $('btn-sessions-refresh').addEventListener('click', loadSessions);

  /* ---------------- progress / export ---------------- */

  async function loadDates() {
    try {
      var dates = (await window.QCApi.call('bootstrap', {})).dates;
      var sel = $('prog-date');
      sel.innerHTML = '<option value="">Select date…</option>';
      dates.forEach(function (d) {
        var o = document.createElement('option');
        o.value = d; o.textContent = d;
        sel.appendChild(o);
      });
    } catch (e) { toast(e.message, 'err'); }
  }

  $('prog-date').addEventListener('change', function () {
    $('btn-progress').disabled = !this.value;
    $('btn-export').disabled = !this.value;
  });

  $('btn-progress').addEventListener('click', async function () {
    var date = $('prog-date').value;
    if (!date) return;
    this.disabled = true; this.textContent = 'Loading…';
    try {
      var data = await window.QCApi.call('getProgress', { date: date });
      var tb = $('progress-table').querySelector('tbody');
      tb.innerHTML = '';
      data.progress.forEach(function (p) {
        var tr = document.createElement('tr');
        var pctDone = p.matched ? Math.round(100 * p.done / p.matched) : 0;
        var pctFlag = p.matched ? Math.round(100 * p.flagged / p.matched) : 0;
        tr.innerHTML = '<td></td><td></td><td></td><td></td><td></td><td></td>' +
          '<td><div class="progress-track">' +
          '<div class="progress-done" style="width:' + pctDone + '%"></div>' +
          '<div class="progress-flag" style="width:' + pctFlag + '%"></div>' +
          '</div> <small>' + pctDone + '%</small></td>';
        tr.children[0].textContent = p.folderType;
        tr.children[1].textContent = p.images;
        tr.children[2].textContent = p.matched;
        tr.children[3].textContent = p.done;
        tr.children[4].textContent = p.flagged;
        tr.children[5].textContent = p.pending;
        tb.appendChild(tr);
      });
      $('progress-table').classList.remove('hidden');
      if (data.sheetUrl && data.sheetUrl !== '#') {
        $('sheet-link').href = data.sheetUrl;
        $('sheet-link').classList.remove('hidden');
      }
    } catch (e) { if (e.staleSession) return; toast(e.message, 'err'); if (e.auth) showLogin(); }
    finally { this.disabled = false; this.textContent = 'Show progress'; }
  });

  $('btn-export').addEventListener('click', async function () {
    var date = $('prog-date').value;
    if (!date) return;
    this.disabled = true; this.textContent = 'Exporting…';
    try {
      var data = await window.QCApi.call('exportQc', { date: date });
      var a = document.createElement('a');
      a.href = 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,' + data.base64;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('Export downloaded ✔', 'ok');
    } catch (e) { toast(e.message, 'err'); }
    finally { this.disabled = false; this.textContent = '⬇ Download QC RD xlsx'; }
  });


  /* ---------------- half-month combined sheet ----------------
   *
   * A half-month is ~4,500 rows x ~450 columns, which is more than one Apps
   * Script execution can move, so the backend does as many dates as fit in
   * its time budget and reports progress. Keep calling until it says complete.
   */

  async function loadHalves() {
    try {
      var halves = await window.QCApi.call('listHalfMonths', {});
      var sel = $('half-pick');
      sel.innerHTML = '<option value="">Select…</option>';
      halves.forEach(function (h) {
        var o = document.createElement('option');
        o.value = h.month + '|' + h.half;
        o.textContent = h.month + ' ' + h.half + (h.half === 'H1' ? ' (1–15)' : ' (16–end)') +
                        (h.built ? '  ✔ built' : '');
        if (h.url) o.dataset.url = h.url;
        sel.appendChild(o);
      });
    } catch (e) { /* non-fatal — the rest of the page still works */ }
  }

  $('half-pick').addEventListener('change', function () {
    $('btn-half-build').disabled = !this.value;
    var opt = this.selectedOptions[0];
    var link = $('half-link');
    if (opt && opt.dataset.url) { link.href = opt.dataset.url; link.classList.remove('hidden'); }
    else link.classList.add('hidden');
  });

  $('btn-half-build').addEventListener('click', async function () {
    var v = $('half-pick').value;
    if (!v) return;
    var parts = v.split('|'), month = parts[0], half = parts[1];
    var btn = this;
    btn.disabled = true;
    $('half-track').classList.remove('hidden');
    $('half-status').classList.remove('hidden');
    $('half-bar').style.width = '0%';
    $('report-link').classList.add('hidden');

    var reset = true, guard = 0, r = null;
    try {
      while (guard++ < 40) {
        btn.textContent = 'Building… ' + (r ? r.done + '/' + r.total : '');   // slow: each date is refreshed first
        r = await window.QCApi.call('buildHalfMonth', { month: month, half: half, reset: reset });
        reset = false;
        $('half-bar').style.width = (r.total ? Math.round(100 * r.done / r.total) : 0) + '%';
        $('half-status').textContent = r.done + ' of ' + r.total + ' dates · ' +
          r.rows + ' rows · ' + r.columns + ' columns';
        if (r.complete) break;
      }
      if (!r || !r.complete) {
        toast('Still going — press Build again to continue where it stopped.', 'err');
        return;
      }
      $('half-link').href = r.url;
      $('half-link').classList.remove('hidden');
      var notes = [];
      if (r.rowsPulledIn) {
        notes.push(r.rowsPulledIn + ' row(s) pulled into the QC sheets from Kobo first');
      }
      if (r.refreshFailures) {
        notes.push(r.refreshFailures + ' date(s) could not be refreshed and were combined as-is: ' +
                   (r.refreshWarnings || []).join('; '));
      }
      if (r.extraColumnCount) {
        notes.push(r.extraColumnCount + ' column(s) kept from earlier days');
      }
      if (r.datesMissingQcSheet && r.datesMissingQcSheet.length) {
        notes.push(r.datesMissingQcSheet.length + ' date(s) skipped (no QC sheet): ' +
                   r.datesMissingQcSheet.join(', '));
      }
      $('half-status').textContent = r.name + ' — ' + r.rows + ' rows × ' + r.columns +
        ' columns from ' + r.done + ' date(s), layout from ' + r.latest +
        (notes.length ? '. ' + notes.join('. ') + '.' : '.');
      // The reporting cut is a straight remap of what we just built, so run it
      // now rather than leaving the two files out of step.
      var rep = null, guard2 = 0, repReset = true;
      while (guard2++ < 40) {
        btn.textContent = 'Reporting… ' + (rep ? rep.rows + ' rows' : '');
        try {
          rep = await window.QCApi.call('buildReporting',
            { month: month, half: half, reset: repReset });
        } catch (e) {
          toast('Combined sheet is ready, but the reporting file failed: ' + e.message, 'err');
          rep = null;
          break;
        }
        repReset = false;
        if (rep.complete) break;
      }
      if (rep && rep.complete) {
        $('report-link').href = rep.url;
        $('report-link').classList.remove('hidden');
        $('half-status').textContent += '  ·  ' + rep.name + ': ' +
          rep.rows + ' rows × ' + rep.columns + ' columns' +
          (rep.warnings && rep.warnings.length ? ' (' + rep.warnings.length + ' mapping warning(s))' : '');
        toast('Combined + reporting sheets ready ✔', 'ok');
      } else if (rep) {
        toast('Reporting file is still building — press Build again to finish it.', 'err');
      }
      loadHalves();
    } catch (e) {
      if (e.staleSession) return;
      toast(e.message, 'err');
      if (e.auth) showLogin();
    } finally {
      btn.disabled = false;
      btn.textContent = '▣ Build / rebuild';
    }
  });

  /* ---------------- toast ---------------- */
  var toastTimer = null;
  function toast(msg, cls) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (cls ? ' ' + cls : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, 3000);
  }

  boot();
})();
