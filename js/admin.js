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
  }

  async function boot() {
    var user = window.QCApi.currentUser();
    if (!user) return showLogin();
    try { await window.QCApi.call('me'); showApp(user); }
    catch (e) { window.QCApi.clearSession(); showLogin(); }
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
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
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

  /* ---------------- progress / export ---------------- */

  async function loadDates() {
    try {
      var dates = await window.QCApi.call('getDates');
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
    } catch (e) { toast(e.message, 'err'); if (e.auth) showLogin(); }
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
