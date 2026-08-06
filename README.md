# Panda Commander + MTurk HIT Tracker + Payment Management

One server powers **all three**:

1. **Panda Commander** — team command/control for RDP scripts (`/teams`, `/whoami`, `/workers` …)
2. **HIT Monitor** — real-time + full-history HIT tracking, with a single source
   of truth so **every device (PC, phone, any browser) shows the same data.**
3. **Payment Management** — team earnings dashboard (replaces the Firebase
   `earnings_logs` page), fed by the same server.

## Files

| File | What it is | Where it runs |
|------|------------|---------------|
| `server.js` | **The combined server** (Panda Commander + HIT Monitor + Payments). Stores everything in `data/state.json`. | Your server (`38.58.179.188`) |
| `index.html` | **Control Center** — the unified entry page served at `/`. Three tabs (📡 HIT Tracker / 🐼 Panda Commander / 💰 Payments), each app in its own isolated frame. | Any browser, at `/` |
| `dashboard.html` | The live + history HIT dashboard UI. Reads everything from the server. | In a tab, or directly at `/dashboard.html` |
| `panda_commander.html` | The Panda Commander control UI. | In a tab, or directly at `/panda_commander.html` |
| `payments.html` | The Payment Management UI — team earnings, expandable per-team logs, CSV export. Locked by the same master password (one unlock covers HIT Tracker + Payments). | In a tab, or directly at `/payments.html` |
| `Hit_Monitor.user.js` | Tampermonkey userscript that detects HITs on `worker.mturk.com` and reports them to the server. | Each worker's browser |
| `AB2soft_Earnings_Report.user.js` | Tampermonkey userscript that reads the MTurk **/earnings** page and posts each worker's earnings to the server (`POST /earnings`) on **every visit** (instant). Only uploads workers whose `TEAM` is in the team sheet. Also compares the page's transfer-method last-3 digits with the worker's assigned bank number (from a second, bank sheet) and sends **`WRONG BANK`** in the alert on a mismatch. | Each worker's browser |

> 🔐 **Bank check is done in the userscript, on the worker's own machine.** Only
> the last 3 digits are read and only the result (`OK` / `WRONG BANK`) is sent —
> the full bank number, password, email and 2FA in that sheet **never** reach the
> server or the dashboard. (That sheet still holds secrets, so keep its sharing
> tight.) The Payments **ALERT** column turns red for `WRONG BANK` / `UPDATE BANK`.
>
> The team overview also has a **BANK STATUS** column: **✅ ALL OK** (green) when
> every worker's bank matches, or a red **🚨 N WRONG BANK** count so you can spot
> the problem team at a glance ("—" = no earnings reported yet). It updates live.

> **Is the right server running?** Open `http://<server-ip>:3000/version`. If it
> returns JSON listing `"earnings"` and `"tombstones"`, the new server is live.
> A **404** means the OLD `server.js` is still running — replace it and restart
> (this is why the Payments page can show "Loading…" / "HTTP 404").

> ⚠️ **Do NOT replace `server.js` with a HIT-only server** — it must keep the
> Panda Commander routes or your RDP scripts stop working. `server.js` in this
> repo already contains the full Panda Commander code **plus** the upgraded HIT
> tracking, so it is a safe drop-in for your existing `server.js`.
>
> Keep `index.html`, `panda_commander.html`, `dashboard.html` and the `data/`
> folder next to `server.js`. Your existing `data/state.json` (teams **and**
> hits) is reused as-is.

## Run the server

Needs Node.js (v16+) and the `express` + `cors` packages you already use:

```bash
npm install express cors        # only if not already installed
node server.js
```

- **Control Center (both apps)** → **http://YOUR_SERVER_IP:3000/**
- HIT dashboard only → http://YOUR_SERVER_IP:3000/dashboard.html
- Panda Commander only → http://YOUR_SERVER_IP:3000/panda_commander.html

The Control Center loads both apps in isolated frames (so their styles/scripts
never collide), keeps both live in the background, and remembers the last tab
you used.

Keep it running after logout:

```bash
npm i -g pm2
pm2 start server.js --name panda-commander
pm2 save && pm2 startup
```

### Data & back-up

- Everything is saved to `data/state.json` (atomic write, reloaded on restart).
  **Back this file up** to preserve team state and HIT history.
- The HIT side prunes nothing by default; `state.hits` grows with history.

## How "same on every device" works

1. The **server** holds every HIT and is the only source of truth.
2. On load each dashboard pulls the **full history** and **replaces** its view
   with the server's data, then stays live over SSE with a 60s `?since=` delta
   poll. Because the view is the server's data — not a per-browser pile-up — two
   devices with the same filters always show the **same** result.
3. The browser's IndexedDB copy is **only** an offline / instant-load cache. The
   first time the upgraded dashboard loads it uploads any browser-only HITs to
   the server (one-time migration via `POST /hits/bulk`) so nothing is lost.
4. The server **never downgrades a status**: once a HIT is `submitted` /
   `manual_returned`, a later stale `active` / `expired` write is ignored — this
   stops HITs you really submitted from flipping to "Expired".

## Password & team delete

- **The HIT dashboard is locked by a master password.** Without it, the history
  can't be viewed or deleted — on any device. Reading (`/hits.json`,
  `/hits/stream`) and deleting require a token derived from the password, so the
  protection is enforced by the **server**, not just hidden in the page.
- Change the password by editing `ADMIN_PASSWORD` in `server.js` (or setting the
  `ADMIN_PASSWORD` env var) **and** the `EXPECTED_HASH` in `dashboard.html` to
  its SHA-256. Current password: `Noushad99#$`.
- **🗑 Delete Team** (in the dashboard toolbar) removes a whole team's HIT
  history from the server for everyone — it asks for the master password and the
  server re-checks it. **🔒 Lock** re-locks the dashboard.
- HIT **writes stay open** (`POST /hits/:id`, `/hits/bulk`) so the userscript
  keeps reporting without needing the password. Panda Commander keeps its own
  separate password system.

## HIT endpoints (reference)

```
POST   /hits/:assignmentId   → upsert one HIT (open; status-precedence merge)
POST   /hits/bulk            → upsert many (open; browser→server migration)
GET    /hits.json?token=…    → full history, ?limit=N, or ?since=<ISO> delta (gzip)   [token]
GET    /hits/stream?token=…  → SSE live feed (ready, hit-update, hit-delete, hit-clear) [token]
GET    /hits/count           → { count }
DELETE /hits/team/:team?token=…  → delete a whole team's HITs   [token]
DELETE /hits/:assignmentId?token=…   → remove a HIT             [token]
DELETE /hits.json?token=…    → wipe all HITs                    [token]
```

`[token]` = requires `?token=<sha256(password)>` (or `x-admin-token` header).
Panda Commander endpoints (`/teams/:team.json`, `/whoami`, `/workers.json`,
`/teams.json`, `/health`) are unchanged and need no token.

Deletes are remembered (**tombstones**): a wiped/deleted HIT id can never be
re-added by a later script post or browser re-upload — but brand-new HITs keep
tracking normally. In the dashboard's 🗑 Delete Team dialog, the
**"🧹 ALL TEAMS — wipe the entire history"** option erases everything everywhere
(password required).

## Payments endpoints (reference)

```
POST   /earnings/:id         → upsert one earnings log (open — scripts post here)
POST   /earnings             → same; id from body ("WORKER ID" / workerId / id)
GET    /earnings.json        → all logs                            [token]
DELETE /earnings/team/:team  → remove a team's logs + its row      [token + PIN]
DELETE /earnings/:id         → remove one worker's log             [token + PIN]
DELETE /earnings.json        → wipe all earnings history           [token + PIN]
```

### 🔐 Delete PIN

Deleting anything from the Payments page needs the **delete PIN** (`099588`,
changeable via the `DELETE_PIN` env var in `server.js`) **on top of** the
master password. The PIN is re-checked **by the server** on every delete, so
even someone who knows the master password (and can view) cannot delete — from
any device. In the page: every detail row has a 🗑 button (delete one worker's
log) and each team's panel has **🗑 Delete Team** (deletes all that team's logs
**and** the team row itself, everywhere, instantly via SSE).

> Note: earnings are **live** data. If a deleted team/worker's script is still
> running, its next report re-creates the entry — delete after decommissioning.

Scripts can keep the exact Firebase field names they already send: `TEAM`,
`USERNAME`, `"WORKER ID"`, `"SERVER IP"`, `currentEarnings`, `lastMonthEarnings`,
`lastTransferAmount`, `lastTransferDate`, `nextTransferDate`, `bankAccount`,
`ip`, `alert`, `timestamp`. Instead of writing to Firebase `earnings_logs`, POST
the same JSON to `http://38.58.179.188:3000/earnings`.

The Payments page shows **every Panda Commander team** (from `/teams.json`) even
before any earnings are reported — team names stay, history starts clean.

## Dashboard views

- **Live** — current/recent HITs grouped by team, with live countdowns.
- **History** — hour / day / **week** / month / year breakdown per team:
  submitted, earned ($), manual returns, auto-returns/expired, active. Each HIT
  is counted on the day of its real event (submit / return / expiry).
- **Date range** — set **FROM**/**TO** (e.g. 6/19/2026 → 6/30/2026) to show only
  that period in either view; **✕ Range** clears it.
- **Export CSV** downloads the full history; the 🧠 counter shows tracked records.

### Data safety

The dashboard never deletes history from the browser cache to "match" the
server — older history that only lived in a browser is **uploaded** to the
server (one-time recovery) instead, so nothing is lost. All HITs the userscript
reports go straight to `data/state.json`, which survives server restarts. The
only way to remove history is the explicit, password-protected **Delete Team**.
