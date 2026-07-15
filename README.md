# PEP MA QC Portal

Web portal for quality-controlling the Pepsi Merchandising Audit data: QC users
compare each store/cooler photo against the values the auditor entered in the
KOBO survey, correct anything that is wrong, and save. Every save is logged, and
a corrected copy of the daily `KOBO RD <date>.xlsx` (with QC columns appended)
is maintained automatically.

## How it works

```
GitHub Pages (this repo)                Google (your account)
┌──────────────────────┐   HTTPS/JSON  ┌─────────────────────────────┐
│ index.html  QC portal │ ────────────► │ Apps Script Web App (API)   │
│ admin.html  Admin     │               │  • login / sessions         │
└──────────────────────┘               │  • reads photo folders      │
                                       │  • reads KOBO RD excel      │
                                       │  • writes QC results        │
                                       └──────────┬──────────────────┘
                                                  │
                          ┌───────────────────────┼───────────────────────┐
                          ▼                       ▼                       ▼
                 Shared Drive photos     "QC RD <date>" Sheets     "PEP MA QC Portal DB"
                 (read-only, untouched)  (copy of Kobo + QC cols)  (Users / Sessions / QCLog)
```

- The **original Kobo excel and photos are never modified**.
- For each date, the backend creates `QC RD <date>` — a Google Sheet copy of the
  Kobo file. Corrections are written there, plus 6 QC columns per photo folder
  (`QC <FOLDER> - User / Start / End / Status / Changes / Remarks`).
- Every save is also appended to the central **QCLog** sheet.
- The admin page can download `QC RD <date>.xlsx` at any time.

### What each folder shows in the left panel

| Photo folder   | Editable measures (from header row)                 |
|----------------|-----------------------------------------------------|
| PEP COOLER     | `2.1.5` … `2.1.24a`                                 |
| KO COOLER      | `2.2.5` … `2.2.24a`                                 |
| OTHERS COOLER  | `2.3.5` … `2.3.24a`                                 |
| MT SHELVES     | `3.1.1` … `3.1.16`                                  |
| STORES PHOTOS  | Store ID, Store Name, Channel Type, GPS lat / long  |

Columns are located by the question number in the header row (not by fixed
letters), so the portal keeps working if Kobo adds or reorders columns. The
ranges are configured at the top of `apps-script/Code.gs` (`CONFIG.FOLDER_TYPES`).

Photos are matched to survey rows by the numeric `_id` at the end of the file
name (e.g. `5.GJW_STOP_N_SHOP_SS_810019648.jpg` → `_id = 810019648`).

---

## Deployment (one time, ~15 minutes)

### Step 1 — Deploy the backend (Google Apps Script)

1. Go to <https://script.google.com> **while signed in to the Google account
   that can open the photos folder** and create a **New project**.
2. Replace the default `Code.gs` content with `apps-script/Code.gs` from this repo.
3. In the left sidebar click **Services (+)** → add **Drive API** (keep
   identifier `Drive`).
4. If the daily-folder root ever changes, update `CONFIG.ROOT_FOLDER_ID` at the
   top of the script (currently set to the `PEP MA STORE & COOLER PHOTOS` folder).
5. In the editor select the function **`setup`** and click **Run**. Authorize
   the permissions when prompted. This creates:
   - the `PEP MA QC Portal DB` spreadsheet (Users / Sessions / QCLog),
   - the `PEP MA QC OUTPUT` folder (receives the `QC RD <date>` sheets),
   - the first admin login: **admin / ChangeMe123!**
6. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click Deploy and copy the web app URL (`https://script.google.com/macros/s/…/exec`).

### Step 2 — Configure the frontend

Open `js/config.js` and paste the web app URL into `API_URL`.

> Until you do this, both pages run in **demo mode** (sign in with `demo/demo`
> or `admin/admin`) so you can preview the UI safely.

### Step 3 — Publish on GitHub Pages

```bash
git init            # already done if you received this folder from Claude
git add -A
git commit -m "PEP MA QC Portal"
# create an empty repo on github.com, then:
git remote add origin https://github.com/<your-user>/pep-ma-qc-portal.git
git push -u origin main
```

On GitHub: **Settings → Pages → Source: Deploy from a branch → main / (root)**.
After a minute the portal is live at
`https://<your-user>.github.io/pep-ma-qc-portal/`.

> Note: only the portal **code** is public on GitHub Pages. All data, photos and
> passwords stay in your Google account behind the Apps Script API.

### Step 4 — First login & users

1. Open `…/admin.html`, sign in with **admin / ChangeMe123!**
2. **Immediately reset the admin password** (Users → Reset password).
3. Create a login for each QC user (role: *QC user*).

### Optional — faster photo loading

By default photos are streamed through the API (always works, a bit slow).
If you share the photos root folder as **"Anyone with the link – Viewer"**, the
portal loads photos directly from Google's CDN (much faster). This is controlled
by `DIRECT_IMAGES` in `js/config.js` — the portal falls back to the API
automatically whenever a direct load fails, so it is safe to leave on.

---

## Daily QC workflow

1. Sign in → pick **Date** → **Folder** (PEP COOLER, KO COOLER, …) → optionally
   City / Auditor / Channel → **Load**.
2. The queue shows every photo of that selection, sorted by `_id`.
3. For each photo: check the values on the left, fix what's wrong (edited cells
   turn yellow), then **Save & Next** (`Ctrl+S`). Use **⚑ Flag** for unusable
   photos (wrong photo, unreadable…) with a remark.
4. Navigate with `←` / `→`, the dropdown, or the ‹ › buttons. "Skip already
   QC'd" jumps over finished items.
5. Admin → **QC progress & export** shows per-folder completion and downloads
   the corrected `QC RD <date>.xlsx`.
6. **Session summaries**: the queue bar shows a live counter of your activity,
   the **📊 Summary** button (and the Sign out button) show your session
   summary — pictures audited, changes made, session start / end and total
   time. Admins additionally get a **User sessions** report on the admin page
   with one row per sign-in session.

## Updating the backend after a code change

When `apps-script/Code.gs` changes in this repo, the deployed web app does NOT
update automatically:

1. Paste the new `Code.gs` over the old one at script.google.com.
2. **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy.**
   The web app URL stays the same, so nothing else needs to change.

## Repo layout

```
index.html          QC portal (login + queue + photo viewer + editable measures)
admin.html          Admin portal (users, progress, export)
css/styles.css
js/config.js        ← paste your Apps Script web app URL here
js/api.js           API client (+ built-in demo mode)
js/app.js           QC portal logic
js/admin.js         Admin logic
apps-script/
  Code.gs           Backend API — paste into script.google.com
  appsscript.json   Apps Script manifest (Drive advanced service, scopes)
```

## Security notes

- Passwords are stored salted + SHA-256 hashed in the DB spreadsheet; sessions
  expire after 12 h. This is appropriate for an internal QC tool — do not reuse
  passwords from other systems.
- The web app runs under your Google account; QC users never get direct access
  to the Drive files.
- Anyone with the web app URL can *attempt* to call the API, but every action
  except `login` requires a valid session token.
