# MTurk HIT Tracker

Real-time + full-history tracking of MTurk HITs across a team, with a single
source of truth so **every device (PC, phone, any browser) shows the same data.**

## Files

| File | What it is | Where it runs |
|------|------------|---------------|
| `server.js` | The tracker server (Panda Commander). Stores **all** HIT history permanently and streams live updates. Single source of truth. | Your server (`38.58.179.188`) |
| `dashboard.html` | The live + history dashboard UI. Reads everything from the server. | Any browser, served by `server.js` at `/` |
| `Hit_Monitor.user.js` | Tampermonkey userscript that detects HITs on `worker.mturk.com` and reports them to the server. | Each worker's browser |

## Run the server

No dependencies, no `npm install` — just Node.js (v18+):

```bash
node server.js
# or with options:
PORT=3000 HOST=0.0.0.0 DATA_DIR=/var/lib/mturk node server.js
```

Then open **http://YOUR_SERVER_IP:3000/** — that serves the dashboard.

Keep it running after you log out (pick one):

```bash
# pm2 (recommended)
npm i -g pm2
pm2 start server.js --name mturk-tracker
pm2 save && pm2 startup

# or nohup
nohup node server.js > tracker.log 2>&1 &
```

### Data & config

- History is saved to `DATA_DIR/hits-data.json` (default: next to `server.js`),
  written atomically and reloaded on restart. **Back this file up** to keep history.
- `MAX_RECORDS` (default `200000`) caps stored HITs; the oldest are pruned past that.
- `server.js` serves `dashboard.html` from the same folder, so keep them together.

## How "same on every device" works

1. The **server** stores every HIT and is the only source of truth.
2. Each dashboard pulls the **full history** from the server on load, then stays
   live over Server-Sent Events (SSE), with a 60s delta poll as a safety net.
3. The browser keeps a local IndexedDB copy **only** as an offline/instant-load
   cache. The first time the new dashboard loads, it uploads anything that was
   previously stored only in that browser to the server (one-time migration), so
   nothing is lost and all devices converge.
4. The server **never downgrades a status**: once a HIT is `submitted` /
   `manual_returned`, a later stale `active`/`expired` write is ignored. This is
   what stops HITs you really submitted from flipping to "Expired".

## API (for reference)

```
GET  /                      → dashboard.html
GET  /hits.json?limit&since → full history, or only records changed since a time
GET  /hits/stream           → SSE live feed (events: ready, hit-update, hit-delete, hit-clear)
GET  /hits/count            → { count }
GET  /health                → { ok, hits, clients }
POST /hits/:id              → upsert one HIT (partial body is merged)
POST /hits/bulk             → upsert many (used for the browser→server migration)
DELETE /hits/:id            → remove a HIT
POST /hits/clear            → wipe all (admin)
```

## Dashboard views

- **Live** — current/recent HITs grouped by team, with live countdowns.
- **History** — day / month / year breakdown per team: submitted, earned ($),
  manual returns, auto-returns/expired, and active. Each HIT is counted on the
  day of its real event (submit / return / expiry).
- **Export CSV** downloads the full history; the 🧠 counter shows tracked records.
