#!/usr/bin/env node
"use strict";
/* ============================================================================
   MTurk HIT Tracker — Server (Panda Commander, persistent edition)
   ----------------------------------------------------------------------------
   A tiny dependency-free Node server that is the SINGLE SOURCE OF TRUTH for
   every HIT. Because all data lives here (not in each browser), every device
   — PC, phone, any browser — shows the exact same, complete history.

   Run:   node server.js
          PORT=3000 HOST=0.0.0.0 DATA_DIR=/var/lib/mturk node server.js

   Endpoints (unchanged contract — drop-in for the old server):
     GET  /                      → dashboard.html
     GET  /dashboard.html        → dashboard.html
     GET  /hits.json?limit&since → full history (or delta) as JSON  (gzip)
     GET  /hits/stream           → Server-Sent Events live feed
     GET  /hits/count            → { count }
     GET  /health                → { ok, hits, clients }
     POST /hits/:id              → upsert one HIT (partial body, merged)
     POST /hits/bulk             → upsert many (array) — used for migration
     DELETE /hits/:id            → remove a HIT
     POST /hits/clear            → wipe all (admin)

   Data is kept in memory and mirrored to DATA_DIR/hits-data.json atomically.
============================================================================ */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const PORT        = parseInt(process.env.PORT || "3000", 10);
const HOST        = process.env.HOST || "0.0.0.0";
const DATA_DIR    = process.env.DATA_DIR || __dirname;
const DATA_FILE   = path.join(DATA_DIR, "hits-data.json");
const DASH_FILE   = path.join(__dirname, "dashboard.html");
const MAX_RECORDS = parseInt(process.env.MAX_RECORDS || "200000", 10);

/* Status precedence — once a HIT reaches a more "final" state it can never be
   downgraded by a later (possibly stale) write. This is what guarantees a real
   Submitted is never overwritten by a wrong Expired/Active guess from any
   client, even during the one-time local→server migration. */
const STATUS_RANK = { active: 0, expired: 1, timed_out: 1, auto_returned: 2, manual_returned: 3, submitted: 3 };

/* ── In-memory store (source of truth) ── */
const hits = new Map();   // id → record

function ts(v) { const t = v ? Date.parse(v) : 0; return isNaN(t) ? 0 : t; }

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) { console.log("[store] no data file yet — starting empty"); return; }
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (Array.isArray(arr)) for (const r of arr) { if (r && r.id != null) hits.set(String(r.id), r); }
    console.log(`[store] loaded ${hits.size} hits from ${DATA_FILE}`);
  } catch (e) {
    console.error("[store] load failed:", e.message, "— keeping a backup and starting empty");
    try { fs.renameSync(DATA_FILE, DATA_FILE + ".corrupt-" + Date.now()); } catch (_) {}
  }
}

/* ── Debounced atomic save (write tmp + rename) ── */
let saveTimer = null, saving = false, dirtyAgain = false;
function scheduleSave() { if (!saveTimer) saveTimer = setTimeout(flushSave, 1500); }
function flushSave() {
  saveTimer = null;
  if (saving) { dirtyAgain = true; return; }
  saving = true;
  const tmp = DATA_FILE + ".tmp";
  const json = JSON.stringify(Array.from(hits.values()));
  fs.writeFile(tmp, json, err => {
    if (err) { console.error("[store] write failed:", err.message); saving = false; return; }
    fs.rename(tmp, DATA_FILE, err2 => {
      saving = false;
      if (err2) console.error("[store] rename failed:", err2.message);
      if (dirtyAgain) { dirtyAgain = false; scheduleSave(); }
    });
  });
}
function saveSync() {
  try {
    fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(Array.from(hits.values())));
    fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
  } catch (e) { console.error("[store] sync save failed:", e.message); }
}

/* ── Precedence-guarded merge (never downgrade a terminal status, never wipe
   a known field with null/undefined) ── */
function mergeRecord(id, incoming) {
  const existing = hits.get(id) || null;
  const out = existing ? Object.assign({}, existing) : {};
  for (const k in incoming) {
    if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue;
    if (k === "status" || k === "id") continue;
    const v = incoming[k];
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  out.id = id;

  const inStatus = incoming.status;
  if (inStatus) {
    const cur     = out.status;
    const curRank = (cur in STATUS_RANK) ? STATUS_RANK[cur] : -1;
    const inRank  = (inStatus in STATUS_RANK) ? STATUS_RANK[inStatus] : -1;
    if (!cur || inRank > curRank) out.status = inStatus;   // upgrade only
  } else if (!out.status) {
    out.status = "active";
  }

  if (!out.acceptedAt) out.acceptedAt = out.lastSyncAt || new Date().toISOString();
  out.updatedAt = new Date().toISOString();
  hits.set(id, out);
  return out;
}

function pruneIfNeeded() {
  if (hits.size <= MAX_RECORDS) return;
  const arr = Array.from(hits.values()).sort((a, b) => ts(a.acceptedAt) - ts(b.acceptedAt));
  const removeN = hits.size - MAX_RECORDS;
  for (let i = 0; i < removeN; i++) hits.delete(String(arr[i].id));
}

/* ── SSE clients ── */
const clients = new Set();
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch (_) {} }
}

/* ── HTTP helpers ── */
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ "Access-Control-Allow-Origin": "*" }, headers || {}));
  res.end(body);
}
function sendJSON(res, code, obj, req) {
  const json = JSON.stringify(obj);
  const ae = (req && req.headers["accept-encoding"]) || "";
  if (/\bgzip\b/.test(ae) && json.length > 1024) {
    zlib.gzip(json, (e, buf) => {
      if (e) return send(res, code, json, { "Content-Type": "application/json" });
      send(res, code, buf, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    });
  } else {
    send(res, code, json, { "Content-Type": "application/json" });
  }
}
function readBody(req, cb) {
  let data = "", tooBig = false;
  req.on("data", c => { data += c; if (data.length > 25 * 1024 * 1024) { tooBig = true; req.destroy(); } });
  req.on("end", () => cb(tooBig ? new Error("body too large") : null, data));
  req.on("error", e => cb(e));
}

/* ── Router ── */
const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, `http://${req.headers.host || "localhost"}`); }
  catch (_) { return send(res, 400, "bad url"); }
  const p = u.pathname, method = req.method;

  if (method === "OPTIONS") {
    return send(res, 204, "", {
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    });
  }

  /* SSE live stream */
  if (method === "GET" && p === "/hits/stream") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no"
    });
    res.write("retry: 3000\n");
    res.write("event: ready\ndata: {}\n\n");
    clients.add(res);
    const ka = setInterval(() => { try { res.write(":keep-alive\n\n"); } catch (_) {} }, 25000);
    req.on("close", () => { clearInterval(ka); clients.delete(res); });
    return;
  }

  /* Full history / delta */
  if (method === "GET" && p === "/hits.json") {
    const limit = parseInt(u.searchParams.get("limit") || "0", 10);
    const since = u.searchParams.get("since");
    let arr = Array.from(hits.values());
    if (since) { const s = ts(since); arr = arr.filter(h => ts(h.updatedAt) > s); }
    arr.sort((a, b) => ts(b.acceptedAt) - ts(a.acceptedAt));
    if (limit > 0 && arr.length > limit) arr = arr.slice(0, limit);
    return sendJSON(res, 200, arr, req);
  }

  if (method === "GET" && p === "/hits/count")
    return sendJSON(res, 200, { count: hits.size }, req);

  if (method === "GET" && p === "/health")
    return sendJSON(res, 200, { ok: true, hits: hits.size, clients: clients.size }, req);

  /* Bulk upsert (migration: local browser memory → server) */
  if (method === "POST" && (p === "/hits/bulk" || p === "/hits")) {
    return readBody(req, (err, body) => {
      if (err) return send(res, 413, "too large");
      let parsed; try { parsed = JSON.parse(body || "[]"); } catch (_) { return send(res, 400, "bad json"); }
      const list = Array.isArray(parsed) ? parsed
                 : (parsed && Array.isArray(parsed.hits) ? parsed.hits : null);
      if (!list) return send(res, 400, "expected array");
      let n = 0;
      for (const item of list) {
        const id = item && (item.id || item.assignmentId);
        if (!id) continue;
        broadcast("hit-update", mergeRecord(String(id), item));
        n++;
      }
      pruneIfNeeded(); scheduleSave();
      return sendJSON(res, 200, { ok: true, upserted: n, total: hits.size }, req);
    });
  }

  /* Single upsert */
  let m;
  if (method === "POST" && (m = p.match(/^\/hits\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    return readBody(req, (err, body) => {
      if (err) return send(res, 413, "too large");
      let data; try { data = JSON.parse(body || "{}"); } catch (_) { return send(res, 400, "bad json"); }
      if (!data || typeof data !== "object") return send(res, 400, "bad body");
      const merged = mergeRecord(String(id), data);
      pruneIfNeeded(); scheduleSave();
      broadcast("hit-update", merged);
      return sendJSON(res, 200, merged, req);
    });
  }

  /* Delete */
  if (method === "DELETE" && (m = p.match(/^\/hits\/([^/]+)$/))) {
    const id = decodeURIComponent(m[1]);
    if (hits.delete(String(id))) { scheduleSave(); broadcast("hit-delete", { id }); }
    return sendJSON(res, 200, { ok: true }, req);
  }

  /* Clear (admin) */
  if (method === "POST" && p === "/hits/clear") {
    hits.clear(); scheduleSave(); broadcast("hit-clear", {});
    return sendJSON(res, 200, { ok: true }, req);
  }

  /* Dashboard */
  if (method === "GET" && (p === "/" || p === "/dashboard.html" || p === "/dashboard")) {
    return fs.readFile(DASH_FILE, (e, buf) => {
      if (e) return send(res, 404, "dashboard.html not found next to server.js");
      send(res, 200, buf, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    });
  }

  send(res, 404, "not found");
});

loadData();
server.listen(PORT, HOST, () =>
  console.log(`MTurk HIT Tracker server → http://${HOST}:${PORT}  (${hits.size} hits loaded, dashboard at /)`));

function shutdown() { saveSync(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", e => console.error("[uncaught]", e));
