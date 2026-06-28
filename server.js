// ========================================================
//  PANDA COMMANDER — LOCAL FIREBASE REPLACEMENT SERVER
//  Runs on Windows server, mimics Firebase REST API shape
//  so existing HTML + RDP scripts work with minimal changes.
//
//  ★ This single file powers BOTH:
//      1) Panda Commander  (/teams, /whoami, /workers …)  ← unchanged
//      2) HIT Monitor      (/hits …)                      ← upgraded
//    Do NOT replace it with a hits-only server, or Panda Commander breaks.
// ========================================================
//
//  Endpoints:
//    GET  /teams/:team.json        → returns latest command for that team
//    PUT  /teams/:team.json        → set the latest command for that team
//    GET  /teams.json              → debug: see all teams' state
//    GET  /health                  → health check
//
//  Data is stored in ./data/state.json so commands survive restarts.
// ========================================================

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');                       // built-in — for gzipping /hits.json
const crypto = require('crypto');                   // built-in — for the admin token

const PORT = 3000;                                  // Change here if needed
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'state.json');

// ── HIT dashboard access control ──────────────────────────────────────────
// Master password. Reading HIT history (/hits.json, /hits/stream) and any
// destructive HIT action (delete) require a token derived from it, so nobody
// can see or delete the history without the password. Change it here if needed.
// (Panda Commander has its own separate password system and is untouched.)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Noushad99#$';
const ADMIN_TOKEN = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
function isAuthed(req) {
    const t = String((req.query && req.query.token) || req.headers['x-admin-token'] || '');
    if (t.length !== ADMIN_TOKEN.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_TOKEN)); }  // constant-time
    catch (_) { return false; }
}

// ============================================================
// Storage (simple JSON file, atomic write)
// ============================================================
// state.deleted = { id: timestamp } — "tombstones" of HITs that were explicitly
// deleted, so a later re-upload (browser recovery) or a re-post (userscript) can
// never bring a deleted HIT back from the dead.
let state = { teams: {}, hits: {}, deleted: {} };
const MAX_TOMBSTONES = 400000;

function tombstone(ids) {
    const now = Date.now();
    for (const id of ids) state.deleted[String(id)] = now;
    const keys = Object.keys(state.deleted);
    if (keys.length > MAX_TOMBSTONES) {
        keys.sort((a, b) => state.deleted[a] - state.deleted[b]);   // oldest first
        for (let i = 0; i < keys.length - MAX_TOMBSTONES; i++) delete state.deleted[keys[i]];
    }
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState() {
    try {
        ensureDataDir();
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') state = parsed;
            if (!state.teams) state.teams = {};
            if (!state.hits) state.hits = {};
            if (!state.deleted) state.deleted = {};
            // Backfill `updatedAt` (ISO) for older HIT records that only have the
            // numeric `lastUpdatedAt`, so the dashboard's ?since= delta sync is
            // consistent for data that existed before this upgrade.
            for (const id in state.hits) {
                const h = state.hits[id];
                if (h && !h.updatedAt) {
                    h.updatedAt = new Date(h.lastUpdatedAt || Date.now()).toISOString();
                }
            }
        }
    } catch (e) {
        console.error('[STORAGE] Failed to load state:', e.message);
        state = { teams: {}, hits: {}, deleted: {} };
    }
}

let saveTimer = null;
function saveState() {
    // Debounce writes (in case many PUTs hit at once)
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            ensureDataDir();
            const tmp = DATA_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
            fs.renameSync(tmp, DATA_FILE);
        } catch (e) {
            console.error('[STORAGE] Save failed:', e.message);
        }
    }, 100);
}

loadState();

// ============================================================
// Server
// ============================================================
const app = express();

// CORS — allow any origin (so HTML can be opened from file://, GitHub Pages, etc.)
app.use(cors({ origin: true, credentials: false }));

// Trust the first hop so req.ip reflects the original RDP IP when the
// server sits behind a reverse proxy / load balancer in the future.
app.set('trust proxy', true);

// JSON parser with bigger limit (worker arrays + bulk HIT migration can be large)
app.use(express.json({ limit: '25mb' }));

// Serve static files from the same folder as server.js
// This solves the Mixed Content issue: HTML and API live on the same HTTP origin.
//   /                    → index.html  (Control Center: HIT Tracker + Panda Commander tabs)
//   /dashboard.html      → the HIT dashboard
//   /panda_commander.html→ the Panda Commander UI
app.use(express.static(__dirname, {
    index: 'index.html',             // Open the combined Control Center when visiting "/"
    extensions: ['html']
}));

// Friendly request log (so you can see commands flowing in real time)
app.use((req, res, next) => {
    const ts = new Date().toLocaleTimeString();
    if (req.url !== '/health') {
        console.log(`[${ts}] ${req.method} ${req.url}`);
    }
    next();
});

// ----- Health -----
app.get('/health', (req, res) => {
    res.json({
        ok: true,
        teams: Object.keys(state.teams),
        hits: Object.keys(state.hits).length,
        uptime: process.uptime()
    });
});

// ----- Read all (debug) -----
app.get('/teams.json', (req, res) => {
    res.json(state.teams);
});

// ----- Whoami: given a Worker ID, return which team it belongs to -----
// RDP scripts call this on startup to figure out which team's path to listen on.
// Data source: the workers list each team posted via PUT /teams/<team>.json
app.get('/whoami', (req, res) => {
    const workerId = (req.query.workerId || '').trim();
    if (!workerId) {
        return res.status(400).json({ error: 'workerId query parameter required' });
    }
    for (const [team, cmd] of Object.entries(state.teams)) {
        if (cmd && Array.isArray(cmd.workers)) {
            const found = cmd.workers.find(w => w && w.workerId === workerId);
            if (found) {
                return res.json({ workerId, team, found: true });
            }
        }
    }
    res.json({ workerId, team: null, found: false });
});

// ----- Read worker → team mapping (for RDP auto-detect) -----
// Builds a map: { workerId: teamName } from the latest workers list each team posted.
app.get('/workers.json', (req, res) => {
    const map = {};
    for (const [team, cmd] of Object.entries(state.teams)) {
        if (cmd && Array.isArray(cmd.workers)) {
            for (const w of cmd.workers) {
                if (w && w.workerId) map[w.workerId] = team;
            }
        }
    }
    res.json(map);
});

// ----- Read one team's latest command -----
// Path matches Firebase shape: /teams/Mehedi.json
//
// Per-worker filter: the RDP MUST append ?workerId=XXX (its MTurk worker
// ID). When the stored command has scope='selected' with a workerIds
// allow-list, this endpoint returns null for workers NOT in the list.
// IP-based identification is NOT used — same public IP can belong to
// different workerIds across teams (residential proxy pools), so only
// the worker's own MTurk ID can identify it reliably.
app.get('/teams/:team.json', (req, res) => {
    const team = req.params.team;
    const cmd  = state.teams[team] || null;
    if (!cmd) return res.json(null);

    const workerId = (req.query.workerId || '').trim();

    // "selected" scope = only the workerIds in the allow-list should act.
    if (cmd.scope === 'selected' && Array.isArray(cmd.workerIds)) {
        if (!workerId) {
            // No workerId hint at all — we cannot tell who this is. To stay
            // safe (do not blast a "selected" command to everyone), hide it.
            return res.json(null);
        }
        if (!cmd.workerIds.includes(workerId)) {
            return res.json(null);
        }
    }

    res.json(cmd);
});

// ----- Write a team's command -----
app.put('/teams/:team.json', (req, res) => {
    const team = req.params.team;
    const cmd = req.body;
    if (!cmd || typeof cmd !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
    }
    state.teams[team] = cmd;
    saveState();

    const action      = cmd.action || '?';
    const groupId     = cmd.groupId || '(none)';
    const workerCount = cmd.workerCount != null ? cmd.workerCount : '?';
    const scopeTag    = cmd.scope === 'selected'
        ? ` | scope: SELECTED (${Array.isArray(cmd.workerIds) ? cmd.workerIds.length : 0} allowed)`
        : '';
    console.log(`  → [${team}] ${action.toUpperCase()} | HIT: ${groupId} | RDPs: ${workerCount}${scopeTag}`);

    // Echo back like Firebase does
    res.json(cmd);
});

// ----- Optional: clear a team (admin nice-to-have) -----
app.delete('/teams/:team.json', (req, res) => {
    const team = req.params.team;
    delete state.teams[team];
    saveState();
    res.json({ deleted: team });
});

// ============================================================
// HIT MONITOR — Firebase Firestore replacement endpoints
// ============================================================
//
//   POST  /hits/:assignmentId    → upsert (merge) HIT data (replaces Firestore PATCH)
//   POST  /hits/bulk             → upsert many at once (dashboard memory → server migration)
//   GET   /hits.json             → fetch HITs (full history, or ?since= delta; gzipped)
//   GET   /hits/stream           → SSE: real-time push to connected dashboards
//   DELETE /hits/:assignmentId   → remove a HIT (manual cleanup)
//   DELETE /hits.json            → wipe all HIT data (admin reset)
// ============================================================

// Connected SSE clients (dashboards)
const hitSubscribers = new Set();

function broadcastHitUpdate(eventType, payload) {
    const msg = `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of hitSubscribers) {
        try { res.write(msg); } catch (_) {}
    }
}

// Status precedence — once a HIT reaches a more "final" state it can never be
// downgraded by a later (possibly stale) write. THIS is what stops a HIT you
// really submitted from being flipped back to Active/Expired by a delayed or
// duplicated report, from the userscript OR from the dashboard's migration.
const STATUS_RANK = { active: 0, expired: 1, timed_out: 1, auto_returned: 2, manual_returned: 3, submitted: 3 };

function mergeHitRecord(id, incoming) {
    const existing = state.hits[id] || {};
    const out = { ...existing };
    for (const k in incoming) {
        if (!Object.prototype.hasOwnProperty.call(incoming, k)) continue;
        if (k === 'status' || k === 'id') continue;
        const v = incoming[k];
        if (v === null || v === undefined) continue;   // never wipe a known field with null
        out[k] = v;
    }
    out.id = id;

    const inStatus = incoming.status;
    if (inStatus) {
        const cur     = out.status;
        const curRank = (cur in STATUS_RANK) ? STATUS_RANK[cur] : -1;
        const inRank  = (inStatus in STATUS_RANK) ? STATUS_RANK[inStatus] : -1;
        if (!cur || inRank > curRank) out.status = inStatus;   // upgrade only, never downgrade
    } else if (!out.status) {
        out.status = 'active';
    }

    if (!out.acceptedAt) out.acceptedAt = out.lastSyncAt || new Date().toISOString();
    const now = Date.now();
    out.lastUpdatedAt = now;                          // numeric (kept for backward-compat)
    out.updatedAt     = new Date(now).toISOString();  // ISO — used by the dashboard's ?since delta
    state.hits[id] = out;
    return out;
}

// --- Bulk upsert (dashboard one-time migration: browser memory → server) ---
// MUST be declared BEFORE '/hits/:assignmentId', otherwise ":assignmentId"
// would capture the literal path segment "bulk".
app.post('/hits/bulk', (req, res) => {
    const body = req.body;
    const list = Array.isArray(body) ? body
               : (body && Array.isArray(body.hits) ? body.hits : null);
    if (!list) return res.status(400).json({ error: 'expected an array of hits' });

    let n = 0;
    for (const item of list) {
        const id = item && (item.id || item.assignmentId);
        if (!id) continue;
        if (state.deleted[String(id)]) continue;          // tombstoned ⇒ never resurrect
        broadcastHitUpdate('hit-update', mergeHitRecord(String(id), item));
        n++;
    }
    saveState();
    res.json({ ok: true, upserted: n, total: Object.keys(state.hits).length });
});

// --- Upsert a HIT (replaces Firestore "set with merge") ---
app.post('/hits/:assignmentId', (req, res) => {
    const id = req.params.assignmentId;
    if (!id) return res.status(400).json({ error: 'assignmentId required' });
    if (state.deleted[String(id)]) return res.json({ id, skipped: true });  // tombstoned ⇒ stays deleted

    const incoming = req.body || {};
    if (typeof incoming !== 'object') {
        return res.status(400).json({ error: 'Body must be a JSON object' });
    }

    const merged = mergeHitRecord(id, incoming);
    saveState();

    broadcastHitUpdate('hit-update', merged);
    res.json(merged);
});

// --- Bulk read HITs ---
//   • no params      → full history (every HIT ever recorded)
//   • ?limit=N       → newest N only (kept for backward-compat)
//   • ?since=<ISO>   → only HITs changed since that time (delta sync)
//   Response is gzipped when the client supports it and the payload is large.
app.get('/hits.json', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    const limit = parseInt(req.query.limit, 10) || 0;
    const since = req.query.since ? Date.parse(req.query.since) : 0;

    let arr = Object.values(state.hits);

    if (since) {
        arr = arr.filter(h => {
            const t = h.updatedAt ? Date.parse(h.updatedAt) : (h.lastUpdatedAt || 0);
            return t > since;
        });
    }

    arr.sort((a, b) => {
        const aT = a.acceptedAt ? new Date(a.acceptedAt).getTime() : 0;
        const bT = b.acceptedAt ? new Date(b.acceptedAt).getTime() : 0;
        return bT - aT;
    });
    if (limit > 0) arr = arr.slice(0, limit);

    const json = JSON.stringify(arr);
    const ae = req.headers['accept-encoding'] || '';
    if (/\bgzip\b/.test(ae) && json.length > 1024) {
        zlib.gzip(json, (err, buf) => {
            if (err) return res.type('application/json').send(json);
            res.set('Content-Encoding', 'gzip');
            res.type('application/json').send(buf);
        });
    } else {
        res.type('application/json').send(json);
    }
});

// --- Count (lightweight) ---
app.get('/hits/count', (req, res) => {
    res.json({ count: Object.keys(state.hits).length });
});

// --- Real-time stream (replaces Firestore onSnapshot) ---
app.get('/hits/stream', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();

    // Send a hello so the client knows the stream is alive
    res.write(`event: ready\ndata: {"ok":true}\n\n`);

    hitSubscribers.add(res);

    // Heartbeat every 25s (proxies often kill idle connections at 30s)
    const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat\n\n`); } catch (_) {}
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        hitSubscribers.delete(res);
    });
});

// --- Delete an entire team's HITs (password-protected) ---
// MUST be declared BEFORE '/hits/:assignmentId' so ":assignmentId" doesn't
// swallow the literal "team" segment. Removes every HIT whose teamname matches.
app.delete('/hits/team/:team', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    const team = decodeURIComponent(req.params.team);
    const removed = [];
    for (const id in state.hits) {
        const tn = state.hits[id] && (state.hits[id].teamname || 'No Team');
        if (tn === team) { removed.push(id); delete state.hits[id]; }
    }
    if (removed.length) {
        tombstone(removed);                 // remember them so they can't be re-uploaded
        saveState();
        for (const id of removed) broadcastHitUpdate('hit-delete', { id });
    }
    res.json({ ok: true, team, deleted: removed.length });
});

// --- Delete one HIT (password-protected) ---
app.delete('/hits/:assignmentId', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.assignmentId;
    if (state.hits[id]) {
        delete state.hits[id];
        tombstone([id]);
        saveState();
        broadcastHitUpdate('hit-delete', { id });
    }
    res.json({ deleted: id });
});

// --- Delete all HITs (password-protected admin nuke) ---
app.delete('/hits.json', (req, res) => {
    if (!isAuthed(req)) return res.status(401).json({ error: 'unauthorized' });
    tombstone(Object.keys(state.hits));
    state.hits = {};
    saveState();
    broadcastHitUpdate('hit-clear', {});
    res.json({ cleared: true });
});

// ----- 404 -----
app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.url });
});

// ============================================================
// Boot
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  🐼 Panda Commander Server (+ HIT Monitor)');
    console.log('  ─────────────────────────────────────────');
    console.log(`  Listening on  http://0.0.0.0:${PORT}`);
    console.log(`  Local URL     http://localhost:${PORT}`);
    console.log(`  LAN/Public    http://<server-ip>:${PORT}`);
    console.log(`  Dashboard     http://<server-ip>:${PORT}/dashboard.html`);
    console.log(`  Data file     ${DATA_FILE}`);
    console.log('');
    console.log('  Loaded teams:', Object.keys(state.teams).length || '(none yet)',
                '| hits:', Object.keys(state.hits).length);
    console.log('');
});

// Graceful shutdown — flush any pending save
function flushAndExit() {
    console.log('\n  Shutting down — flushing state...');
    if (saveTimer) clearTimeout(saveTimer);
    try {
        ensureDataDir();
        fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
    } catch (_) {}
    process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);
