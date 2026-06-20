# Panda Commander + MTurk HIT Tracker

One server powers **both**:

1. **Panda Commander** — team command/control for RDP scripts (`/teams`, `/whoami`, `/workers` …)
2. **HIT Monitor** — real-time + full-history HIT tracking, with a single source
   of truth so **every device (PC, phone, any browser) shows the same data.**

## Files

| File | What it is | Where it runs |
|------|------------|---------------|
| `server.js` | **The combined Panda Commander + HIT Monitor server.** Stores all team state **and** all HIT history in `data/state.json`, and streams live updates. | Your server (`38.58.179.188`) |
| `index.html` | **Control Center** — the unified entry page served at `/`. Two side-by-side tabs (📡 HIT Tracker / 🐼 Panda Commander) that show each app in its own isolated frame. | Any browser, at `/` |
| `dashboard.html` | The live + history HIT dashboard UI. Reads everything from the server. | In a tab, or directly at `/dashboard.html` |
| `panda_commander.html` | The Panda Commander control UI. | In a tab, or directly at `/panda_commander.html` |
| `Hit_Monitor.user.js` | Tampermonkey userscript that detects HITs on `worker.mturk.com` and reports them to the server. | Each worker's browser |

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
2. Each dashboard pulls the **full history** from the server on load, then stays
   live over Server-Sent Events (SSE), with a 60s `?since=` delta poll as backup.
3. The browser keeps a local IndexedDB copy **only** as an offline / instant-load
   cache. The first time the upgraded dashboard loads, it uploads anything that
   was previously stored only in that browser to the server (one-time migration
   via `POST /hits/bulk`), so nothing is lost and all devices converge.
4. The server **never downgrades a status**: once a HIT is `submitted` /
   `manual_returned`, a later stale `active` / `expired` write is ignored. This
   is what stops HITs you really submitted from flipping to "Expired".

## HIT endpoints (reference)

```
POST   /hits/:assignmentId   → upsert one HIT (partial body, status-precedence merge)
POST   /hits/bulk            → upsert many (browser→server migration)
GET    /hits.json            → full history, ?limit=N, or ?since=<ISO> delta (gzip)
GET    /hits/stream          → SSE live feed (ready, hit-update, hit-delete, hit-clear)
GET    /hits/count           → { count }
DELETE /hits/:assignmentId   → remove a HIT
DELETE /hits.json            → wipe all HITs (admin)
```

Panda Commander endpoints (`/teams/:team.json`, `/whoami`, `/workers.json`,
`/teams.json`, `/health`) are unchanged.

## Dashboard views

- **Live** — current/recent HITs grouped by team, with live countdowns.
- **History** — day / month / year breakdown per team: submitted, earned ($),
  manual returns, auto-returns/expired, active. Each HIT is counted on the day
  of its real event (submit / return / expiry).
- **Export CSV** downloads the full history; the 🧠 counter shows tracked records.
