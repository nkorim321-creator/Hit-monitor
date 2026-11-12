// BP Worker Vote Monitor — central server (no npm packages needed)
// Run:  node server.js        (listens on ports 3100 and 80; change with PORTS=3100)
//
// - Account scripts POST their /vote status to /api/report (no password).
// - The ID list (Serial, BP Year, Mail, Worker ID, Team name) comes from a Google Sheet.
// - Each team sees only its own IDs with its own password; "ALL" is the admin password.
//   Passwords live only on the server in passwords.json (scrypt hashes, never in git).
//   Admin sets team passwords from the dashboard (ALL ID → 🔑 Passwords) or with set-password.js.
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

// Listens on 3100 and also on 80. Port 80 is plain web traffic, which proxies and VPNs let through
// even when they block unusual ports like 3100. PORTS=3100 turns port 80 off.
const PORTS     = String(process.env.PORTS || process.env.PORT || '3100,80')
  .split(',').map(x => parseInt(x, 10)).filter(Boolean);
const SHEET_ID  = process.env.SHEET_ID || '1xj9B7ymrRoWIoxT4v0x4z6So8Qgj1oCMS42TujA9rus';
const SHEET_GID = process.env.SHEET_GID || '0';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;
const SHEET_REFRESH_MS = 60 * 1000;

const DATA        = path.join(__dirname, 'accounts.json');
const SHEET_CACHE = path.join(__dirname, 'sheet-cache.json');
const PW_FILE     = path.join(__dirname, 'passwords.json');
const TOKEN_FILE  = path.join(__dirname, 'token-secret.txt');
const PUBLIC      = path.join(__dirname, 'public');

/* ── storage ─────────────────────────────────────────────── */
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

let accounts = readJson(DATA, {});
let sheet    = readJson(SHEET_CACHE, { rows: [], teams: [], fetchedAt: 0 });
let sheetError = '';

/* History per mail, used for earnings and the time-range report.
   Every report compares the balance with the last one for that mail:
     balance up   → earning  event [time, +cents]
     balance down → collect  event [time, -cents]   (never counted as earning)
   The first report of a mail only sets the starting point, so old balance is never counted.
   Also stored: state changes (RUNNING / BLOCKED ...) and when the script was online. */
const EARN_FILE = path.join(__dirname, 'earnings.json');
const ONLINE_GAP_MS = 3 * 60 * 1000;      // reports closer than this = script was online in between
let earn = readJson(EARN_FILE, {});
let migratedEarn = false;
earn.startedAt = earn.startedAt || Date.now();
earn.last = earn.last || {};   // mail → last balance (cents)
earn.ev   = earn.ev   || {};   // mail → [[time, deltaCents, approx?], ...]
earn.st   = earn.st   || {};   // mail → [[time, state, unlockAt], ...]
earn.on   = earn.on   || {};   // mail → [[start, end], ...]
// Older versions stored earnings per hour. Keep that data as events at the start of the hour,
// marked approximate, and remember until when times are only hour-accurate.
if (earn.hours || earn.payouts) {
  for (const [bucket, sign] of [[earn.hours || {}, 1], [earn.payouts || {}, -1]]) {
    for (const [k, hrs] of Object.entries(bucket)) {
      earn.ev[k] = earn.ev[k] || [];
      for (const [h, c] of Object.entries(hrs)) earn.ev[k].push([Number(h), sign * c, 1]);
      earn.ev[k].sort((a, b) => a[0] - b[0]);
    }
  }
  earn.approxUntil = Date.now();
  delete earn.hours; delete earn.payouts;
  migratedEarn = true;
}
let earnDirty = false;
if (migratedEarn) saveEarn();
function saveEarn() {
  if (earnDirty) return;            // throttle: write at most every 5 seconds
  earnDirty = true;
  setTimeout(() => {
    earnDirty = false;
    fs.writeFile(EARN_FILE + '.tmp', JSON.stringify(earn), err => { if (!err) fs.rename(EARN_FILE + '.tmp', EARN_FILE, () => {}); });
  }, 5000);
}
function trackHistory(mail, state, bal, unlockAt, now) {
  const k = String(mail || '').trim().toUpperCase();
  if (!k) return;
  // online intervals
  const on = earn.on[k] = earn.on[k] || [];
  const last = on[on.length - 1];
  if (last && now - last[1] <= ONLINE_GAP_MS) last[1] = now; else on.push([now, now]);
  // state changes
  const st = earn.st[k] = earn.st[k] || [];
  const ls = st[st.length - 1];
  if (!ls || ls[1] !== state) st.push([now, state, state === 'BLOCKED' ? unlockAt : null]);
  else if (state === 'BLOCKED' && unlockAt) ls[2] = unlockAt;
  // balance changes
  if (state !== 'LOGGED_OUT' && bal !== null && bal !== undefined) {
    const prev = earn.last[k];
    earn.last[k] = bal;
    if (prev !== undefined && prev !== null && bal !== prev) (earn.ev[k] = earn.ev[k] || []).push([now, bal - prev]);
  }
  saveEarn();
}

// Everything about one mail between from and to. bucketStart(t) groups earnings for the chart.
function historyFor(mail, from, to, bucketStart) {
  const k = String(mail || '').trim().toUpperCase();
  const out = { earned: 0, collected: 0, buckets: {}, blocks: [], blockedMs: 0, onlineMs: 0, firstSeen: null, lastSeen: null };
  for (const [t, d] of earn.ev[k] || []) {
    if (t < from || t >= to) continue;
    if (d > 0) { out.earned += d; const b = bucketStart(t); out.buckets[b] = (out.buckets[b] || 0) + d; }
    else out.collected += -d;
  }
  for (const [a, b] of earn.on[k] || []) {
    const s = Math.max(a, from), e = Math.min(b, to);
    if (e >= s && b >= from && a < to) {
      out.onlineMs += e - s;
      if (out.firstSeen === null) out.firstSeen = Math.max(a, from);
      out.lastSeen = Math.min(b, to);
    }
  }
  const st = earn.st[k] || [];
  for (let i = 0; i < st.length; i++) {
    const [t, state, unlockAt] = st[i];
    const next = st[i + 1] ? st[i + 1][0] : Infinity;
    if (state !== 'BLOCKED') continue;
    // A block lasts until the unlock time the site gave, or until the next state change, whichever is first
    const end = Math.min(unlockAt || next, next);
    if (end <= from || t >= to) continue;
    out.blocks.push({ at: t, unlockAt: unlockAt || null, endedAt: end === Infinity ? null : end });
    out.blockedMs += Math.min(end, to, Date.now()) - Math.max(t, from);
  }
  return out;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA + '.tmp', JSON.stringify(accounts, null, 1), err => {
      if (!err) fs.rename(DATA + '.tmp', DATA, () => {});
    });
  }, 500);
}

/* ── passwords & tokens ──────────────────────────────────── */
const passwords = readJson(PW_FILE, {});
function setPassword(scope, pw) {
  const key = scope === 'ALL' ? 'ALL' : (Object.keys(passwords).find(k => k !== 'ALL' && norm(k) === norm(scope)) || scope);
  const salt = crypto.randomBytes(16).toString('hex');
  passwords[key] = { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
  fs.writeFileSync(PW_FILE, JSON.stringify(passwords, null, 2) + '\n');
}
let tokenSecret = '';
try { tokenSecret = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
if (!tokenSecret) { tokenSecret = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(TOKEN_FILE, tokenSecret); }

const norm = s => String(s || '').trim().toUpperCase();
function pwEntry(scope) {
  if (scope === 'ALL') return passwords.ALL;
  const k = Object.keys(passwords).find(k => k !== 'ALL' && norm(k) === norm(scope));
  return k ? passwords[k] : null;
}
function checkPassword(scope, pw) {
  const e = pwEntry(scope);
  if (!e || !pw) return false;
  const h = crypto.scryptSync(String(pw), e.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(e.hash, 'hex'));
}
// Token = scope + signature. Changing that scope's password invalidates old tokens.
function makeToken(scope) {
  const sig = crypto.createHmac('sha256', tokenSecret).update(norm(scope) + '|' + pwEntry(scope).hash).digest('base64url');
  return Buffer.from(scope).toString('base64url') + '.' + sig;
}
function readToken(tok) {
  const [a, sig] = String(tok || '').split('.');
  if (!a || !sig) return null;
  const scope = Buffer.from(a, 'base64url').toString();
  const e = pwEntry(scope);
  if (!e) return null;
  const good = crypto.createHmac('sha256', tokenSecret).update(norm(scope) + '|' + e.hash).digest('base64url');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  return scope;
}
// May a token holder see this team?
const canSee = (scope, team) => scope === 'ALL' || (scope && norm(scope) === norm(team));
// Which page a token may open: a team token opens only its own team, the admin token only "ALL ID"
const mayOpen = (scope, team) => !!scope && (team === 'ALL' ? scope === 'ALL' : scope !== 'ALL' && norm(scope) === norm(team));

// Slow down password guessing: max 10 wrong tries per IP per 10 minutes
const fails = new Map();
function tooManyFails(ip) {
  const f = fails.get(ip);
  return f && f.n >= 10 && Date.now() - f.t < 10 * 60 * 1000;
}
function addFail(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.t > 10 * 60 * 1000) fails.set(ip, { n: 1, t: Date.now() });
  else f.n++;
  if (fails.size > 1000) for (const [k, v] of fails) if (Date.now() - v.t > 10 * 60 * 1000) fails.delete(k);
}

/* ── Google Sheet ────────────────────────────────────────── */
function parseCSV(txt) {
  txt = (txt || '').replace(/^﻿/, '');
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (q) {
      if (c === '"' && txt[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur.trim()); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && txt[i + 1] === '\n') i++;
      row.push(cur.trim()); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur.trim()); rows.push(row); }
  return rows.filter(r => r.join('') !== '');
}

async function refreshSheet() {
  try {
    const r = await fetch(SHEET_URL + '&_=' + Date.now(), { redirect: 'follow' });
    const txt = await r.text();
    if (!r.ok || /<html/i.test(txt.slice(0, 500))) throw new Error('sheet HTTP ' + r.status + ' (is it shared "Anyone with the link"?)');
    const rows = parseCSV(txt);
    const head = (rows[0] || []).map(norm);
    const col = (...names) => head.findIndex(h => names.includes(h));
    const cSerial = col('SERIAL', 'SL', 'NO', 'ID'), cYear = col('BP YEAR', 'YEAR'),
          cMail = col('MAIL', 'EMAIL', 'E-MAIL'), cWid = col('WORKER ID', 'WORKERID'), cTeam = col('TEAM NAME', 'TEAM');
    if (cMail < 0 || cTeam < 0) throw new Error('sheet needs "Mail" and "Team name" columns');
    const out = [];
    for (const r of rows.slice(1)) {
      const mail = (r[cMail] || '').trim(), team = (r[cTeam] || '').trim();
      if (!mail || !team) continue;
      out.push({
        serial: cSerial >= 0 ? (r[cSerial] || '').trim() : '',
        bpYear: cYear >= 0 ? (r[cYear] || '').trim() : '',
        mail, workerId: cWid >= 0 ? (r[cWid] || '').trim() : '', team,
      });
    }
    const teams = [];
    for (const row of out) if (!teams.some(t => norm(t) === norm(row.team))) teams.push(row.team);
    sheet = { rows: out, teams, fetchedAt: Date.now() };
    sheetError = '';
    fs.writeFile(SHEET_CACHE, JSON.stringify(sheet), () => {});
  } catch (e) {
    sheetError = String(e.message || e);
    console.log('Sheet refresh failed:', sheetError);
  }
}
refreshSheet();
setInterval(refreshSheet, SHEET_REFRESH_MS);

/* ── build the list a viewer may see ─────────────────────── */
const PUBLIC_FIELDS = ['state', 'totalBalanceCents', 'rateLimitText', 'unlockAt', 'lastUnlockAt', 'noticeText', 'waitText', 'waitUntil',
                       'categories', 'totalAvailable', 'lastSeen'];
function view(scope, team) {
  const byMail = new Map();
  for (const a of Object.values(accounts)) {
    const k = norm(a.email);
    if (k && (!byMail.has(k) || byMail.get(k).lastSeen < a.lastSeen)) byMail.set(k, a);
  }
  const used = new Set();
  const list = [];
  for (const row of sheet.rows) {
    if (team !== 'ALL' && norm(row.team) !== norm(team)) continue;
    if (!canSee(scope, row.team)) continue;
    const a = byMail.get(norm(row.mail));
    if (a) used.add(a.id);
    const item = { key: row.team + '#' + row.serial + '#' + row.mail, team: row.team, serial: row.serial,
                   bpYear: row.bpYear, mail: row.mail, workerId: row.workerId, reported: !!a };
    if (a) { for (const f of PUBLIC_FIELDS) item[f] = a[f]; item.accountId = a.id; }
    // Last time this ID earned (balance went up) — used to tell if it worked again after its 12 h rest
    const ev = earn.ev[norm(row.mail)] || [];
    for (let i = ev.length - 1; i >= 0; i--) if (ev[i][1] > 0) { item.lastEarnAt = ev[i][0]; break; }
    list.push(item);
  }
  // Admin "ALL" view also shows reporting accounts that are not in the sheet
  if (scope === 'ALL' && team === 'ALL') {
    for (const a of Object.values(accounts)) {
      if (used.has(a.id) || sheet.rows.some(r => norm(r.mail) === norm(a.email))) continue;
      const item = { key: 'x#' + a.id, team: '', serial: '', bpYear: '', mail: a.email || a.id, workerId: '',
                     reported: true, accountId: a.id, unassigned: true };
      for (const f of PUBLIC_FIELDS) item[f] = a[f];
      list.push(item);
    }
  }
  return list;
}

/* ── reports from the account scripts ────────────────────── */
const str = (v, max = 200) => (v == null ? '' : String(v).slice(0, max));
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const STATES = ['RUNNING', 'BLOCKED', 'PAUSED', 'REVIEW', 'LOGGED_OUT', 'UNKNOWN'];

function handleReport(b) {
  const id = str(b.id, 120).trim();
  if (!id) throw new Error('missing id');
  const now  = Date.now();
  const prev = accounts[id] || {};
  let state = STATES.includes(b.state) ? b.state : 'UNKNOWN';
  const cats = Array.isArray(b.categories) ? b.categories : [];
  // Older scripts called any page without a rate limit "RUNNING", even a "Voting is paused" page.
  // A real running page always lists vote categories, so without them it is not trusted as running.
  if (state === 'RUNNING' && cats.length === 0) state = 'UNKNOWN';
  const rateLimitSeconds = num(b.rateLimitSeconds), waitSeconds = num(b.waitSeconds);
  const acc = {
    id,
    email: str(b.email) || prev.email || '',
    state,
    totalBalanceCents: num(b.totalBalanceCents),
    rateLimitText: str(b.rateLimitText, 60),
    noticeText: str(b.noticeText, 200),
    waitText: str(b.waitText, 60),
    waitUntil: state === 'PAUSED' && waitSeconds ? now + waitSeconds * 1000 : null,
    unlockAt: state === 'BLOCKED' && rateLimitSeconds ? now + rateLimitSeconds * 1000 : null,
    categories: cats.slice(0, 20).map(c => ({ name: str(c && c.name, 60), count: num(c && c.count) || 0 })),
    totalAvailable: num(b.totalAvailable) || 0,
    lastSeen: now,
    // When a block ends, remember the unlock moment (for the 12-hour "Rest time" on the dashboard).
    // Use the site's unlock time if it is known and already passed, otherwise the time we saw the change.
    lastUnlockAt: prev.state === 'BLOCKED' && state !== 'BLOCKED'
      ? (prev.unlockAt && prev.unlockAt <= now ? prev.unlockAt : now)
      : (prev.lastUnlockAt || null),
  };
  accounts[id] = acc;
  save();
  trackHistory(acc.email, state, acc.totalBalanceCents, acc.unlockAt, now);
  // Tell the script which sheet ID this is, so its badge can show "SUJON ID-9" or "not in sheet"
  const row = sheet.rows.find(r => norm(r.mail) === norm(acc.email));
  return { ok: true, match: row ? { team: row.team, serial: row.serial } : null };
}

/* ── HTTP ────────────────────────────────────────────────── */
function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Token',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
    'X-BP-Vote-Monitor': '1',          // lets the account script tell our answers from a proxy's
  });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 200000) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ip = req.socket.remoteAddress || '';

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p.startsWith('/api/')) {
    try {
      if (p === '/api/report' && req.method === 'POST') {
        return send(res, 200, handleReport(await readBody(req)));
      }

      // Team names only (no data) so the dashboard can show the team buttons
      if (p === '/api/teams' && req.method === 'GET') {
        return send(res, 200, { teams: sheet.teams.map(t => ({ name: t, count: sheet.rows.filter(r => norm(r.team) === norm(t)).length })) });
      }

      if (p === '/api/login' && req.method === 'POST') {
        if (tooManyFails(ip)) return send(res, 429, { error: 'Too many wrong attempts. Try again in 10 minutes.' });
        const b = await readBody(req);
        const team = str(b.team, 80).trim();
        const pw = str(b.password, 200);
        // A team password opens only that team. The admin password opens only "ALL ID".
        if (team === 'ALL' ? checkPassword('ALL', pw) : checkPassword(team, pw)) {
          return send(res, 200, { token: makeToken(team), scope: team });
        }
        addFail(ip);
        return send(res, 401, { error: 'Wrong password' });
      }

      const scope = readToken(req.headers['x-token']);

      if (p === '/api/accounts' && req.method === 'GET') {
        const team = url.searchParams.get('team') || '';
        if (!mayOpen(scope, team)) return send(res, 401, { error: 'login required' });
        const extra = scope === 'ALL' ? { sheetError, passwordTeams: Object.keys(passwords) } : {};
        return send(res, 200, { now: Date.now(), ...extra, accounts: view(scope, team) });
      }

      // Time-range report per ID (same login rules as /api/accounts).
      // bucket=hour|day groups earnings by the viewer's local time (tz = minutes from getTimezoneOffset()).
      if (p === '/api/earnings' && req.method === 'GET') {
        const team = url.searchParams.get('team') || '';
        if (!mayOpen(scope, team)) return send(res, 401, { error: 'login required' });
        const from = Number(url.searchParams.get('from')) || 0;
        const to = Math.min(Number(url.searchParams.get('to')) || Date.now(), Date.now() + 60000);
        const off = -(Number(url.searchParams.get('tz')) || 0) * 60000;     // local = utc + off
        const size = url.searchParams.get('bucket') === 'day' ? 86400000 : 3600000;
        const bucketStart = t => Math.floor((t + off) / size) * size - off;
        const rows = view(scope, team).map(a => ({ key: a.key, mail: a.mail, ...historyFor(a.mail, from, to, bucketStart) }));
        return send(res, 200, { from, to, trackingSince: earn.startedAt, approxUntil: earn.approxUntil || null, rows });
      }

      // Admin only: set a team's (or the admin "ALL") password
      if (p === '/api/admin/password' && req.method === 'POST') {
        if (scope !== 'ALL') return send(res, 401, { error: 'admin only' });
        const b = await readBody(req);
        const team = str(b.team, 80).trim(), pw = str(b.password, 200);
        if (!team) return send(res, 400, { error: 'team missing' });
        if (pw.length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
        setPassword(team, pw);
        // Changing the admin password logs the admin out; give back a fresh admin token
        return send(res, 200, { ok: true, token: team === 'ALL' ? makeToken('ALL') : undefined });
      }

      // Admin only: remove an old report (e.g. an account that is no longer used)
      const m = p.match(/^\/api\/accounts\/(.+)$/);
      if (m && req.method === 'DELETE') {
        if (scope !== 'ALL') return send(res, 401, { error: 'admin only' });
        const id = decodeURIComponent(m[1]);
        if (!accounts[id]) return send(res, 404, { error: 'not found' });
        delete accounts[id]; save();
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  // Static dashboard (never serve the data / password files)
  const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
};

// Log crashes with the time; run-server.bat starts the server again 5 seconds later
process.on('uncaughtException', e => {
  console.log(`[${new Date().toISOString()}] CRASH: ${e && e.stack || e}`);
  process.exit(1);
});
process.on('unhandledRejection', e => console.log(`[${new Date().toISOString()}] Unhandled: ${e && e.stack || e}`));

for (const port of PORTS) {
  const srv = http.createServer(server);
  srv.on('error', e => {
    // e.g. port 80 already used by another program, or not allowed: keep running on the other port(s)
    console.log(`Port ${port} not available (${e.code || e.message}).`);
  });
  srv.listen(port, () => {
    console.log(`[${new Date().toISOString()}] BP Vote Monitor running → http://localhost${port === 80 ? '' : ':' + port}`);
  });
}
if (!passwords.ALL) console.log('WARNING: no admin password yet. Run install-windows.bat, or: node set-password.js ALL "yourpassword"');
