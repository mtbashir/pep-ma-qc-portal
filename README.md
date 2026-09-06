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

## Half-month combined sheet

QC produces one `QC RD <date>` sheet per day. For reporting, each month is also
combined into two half-month files in the **same** `PEP MA QC OUTPUT` folder:

| File | Covers |
|------|--------|
| `QC RD 2026-08-H1` | 1st – 15th |
| `QC RD 2026-08-H2` | 16th – end of month (28 / 29 / 30 / 31) |

**Column layout comes from the latest date in the half.** Kobo questions get
added and removed mid-month — Aug 1 2026 had 401 Kobo columns, Aug 2 onwards had
418 — so a fixed layout is not possible. The combined file is laid out as:

```
[ every column of the latest date's QC sheet, in its order ]  [ QC Source Date ]  [ extras ]
```

* **extras** are columns an older day had that the latest one no longer does.
  They are kept at the far end instead of being dropped, so a mid-month question
  change never silently loses data. For August H1 that is two columns —
  `Other (please specify the Store ID)` and
  `Other (please specify the Store Name and Address)`, both from Aug 1.
* **`QC Source Date`** holds the `QC RD <date>` each row came from.
* Rows are matched to columns **by header name**, never by position. A column the
  latest date has but an older day lacks comes through blank.
* Dates with no QC sheet yet (never opened in the portal) are **skipped**, and
  reported back so you know which ones to open and refresh first.

### Refresh before combine

`QC RD <date>` is a snapshot taken the first time that date is opened in the
portal, so rows the field team uploads later that day are missing from it. A
combine can only copy what the QC sheets hold, so the build runs `syncNewRows()`
on each date first (`CONFIG.HALF_REFRESH`, on by default). That is append-only:
existing rows and QC corrections are never touched.

It roughly doubles build time — a Drive copy plus a full read of the Kobo
workbook per date — so set `HALF_REFRESH: false` if you would rather refresh by
hand with the portal's ↻ button. A date that cannot be refreshed (missing Kobo
workbook, say) is still combined from whatever its QC sheet holds, and the
failure is counted and named in the result rather than sinking the build.

### Running it

Admin page → **Half-month combined sheet** → pick the half → **Build / rebuild**.

A rebuild **reuses the same file**, wiping and refilling it, so a link you have
shared or bookmarked keeps working. Because the file is emptied at the start of a
rebuild, it is briefly incomplete while one is running.

A half-month is roughly 4,500 rows × 450 columns — far more than one Apps Script
execution can move. The build is therefore **resumable**: each request processes
as many dates as fit in `CONFIG.HALF_BUDGET_MS` (4 minutes), records progress in
Script Properties, and returns `done / total`. The admin page just keeps calling
until it reports `complete`, and every call is guaranteed to advance by at least
one date.

Progress is saved after **every** date, and a date is marked pending before any
of its rows are written. Appends are durable the moment they land, so an
execution killed part way through a date would otherwise leave orphan rows that
a retry would duplicate; on the next call the pending date's rows are deleted
before it is redone. For the same reason a failed append does not silently retry
through the other API — it gives up on the date and lets the retry path handle
it cleanly.

### Nightly rebuild

`installHalfMonthTrigger()` — run once from the Apps Script editor — installs a
daily ~02:00 trigger that rebuilds the **current** half-month. Time-based
triggers get the same 6-minute ceiling, so the run books itself a one-off
continuation a minute later until it finishes.

Just after a half turns over, the one that closed is usually still being QC'd, so
on days 1–5 the previous month's H2 is refreshed too, and on days 16–20 the same
month's H1 is. Older halves are rebuilt on demand with the admin button.

## Performance notes

The backend is tuned for a ~400-row × ~400-column Kobo sheet and ~900 photos
per day. If it ever feels slow again, these are the levers:

- **Reads go through the Sheets REST API**, not `SpreadsheetApp` — opening a
  sheet that size costs seconds, so `getQueue` fetches only the 8 columns it
  needs and `getRecord` fetches a single row.
- **Drive is listed with `Drive.Files.list`** (1000 files per call) instead of
  a `DriveApp` iterator (one round trip per file).
- **A per-date index** (spreadsheet id, tab name, header row, `_id` → row map)
  is cached for 6 h, so repeat requests skip the lookup entirely. The photo
  list per folder is cached the same way. Both rebuild automatically.
- **Saves are batched** into a single write call.
- **Photos**: served straight from Google's CDN when the folder is link-shared,
  otherwise through the API as a size-limited thumbnail (`IMAGE_SIZE` in
  `js/config.js`), never the full original.
- **The portal prefetches the next photo** while the QC user works on the
  current one, and caches recently viewed photos in the browser.

A cold first request of the day is always slower (Apps Script cold start plus
building the caches). After that, requests are served warm.

## Updating the backend after a code change

When `apps-script/Code.gs` changes in this repo, the deployed web app does NOT
update automatically:

1. Paste the new `Code.gs` over the old one at script.google.com.
2. **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy.**
   The web app URL stays the same, so nothing else needs to change.

## Repo layout

```
index.html          QC portal (login + queue + photo viewer + editable measures)
admin.html          Admin portal (users, progress, export, half-month combine)
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
