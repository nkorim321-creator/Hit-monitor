// BP Worker Vote Monitor — central server (no npm packages needed)
// Run:  node server.js            (PORT=3100, optional SECRET=yourkey)
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = parseInt(process.env.PORT || '3100', 10);
const SECRET = process.env.SECRET || '';
const DATA   = path.join(__dirname, 'accounts.json');
const PUBLIC = path.join(__dirname, 'public');

let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch (e) { accounts = {}; }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA + '.tmp', JSON.stringify(accounts, null, 1), err => {
      if (!err) fs.rename(DATA + '.tmp', DATA, () => {});
    });
  }, 500);
}

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Cache-Control': 'no-store',
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

const str = (v, max = 200) => (v == null ? '' : String(v).slice(0, max));
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const STATES = ['RUNNING', 'BLOCKED', 'LOGGED_OUT', 'UNKNOWN'];

function handleReport(b) {
  const id = str(b.id, 120).trim();
  if (!id) throw new Error('missing id');
  const now  = Date.now();
  const prev = accounts[id] || { id, firstSeen: now, alias: '' };
  const state = STATES.includes(b.state) ? b.state : 'UNKNOWN';
  const rateLimitSeconds = num(b.rateLimitSeconds);

  const acc = {
    ...prev,
    id,
    email: str(b.email) || prev.email || '',
    nickname: str(b.nickname, 60),
    state,
    balanceCents: num(b.balanceCents),
    totalBalanceCents: num(b.totalBalanceCents),
    rateLimitSeconds,
    rateLimitText: str(b.rateLimitText, 60),
    unlockAt: state === 'BLOCKED' && rateLimitSeconds ? now + rateLimitSeconds * 1000 : null,
    payoutUnlockAt: num(b.payoutUnlockSeconds) ? now + num(b.payoutUnlockSeconds) * 1000 : null,
    categories: Array.isArray(b.categories)
      ? b.categories.slice(0, 20).map(c => ({ name: str(c.name, 60), count: num(c.count) || 0, enabled: !!c.enabled }))
      : [],
    totalAvailable: num(b.totalAvailable) || 0,
    lastSeen: now,
  };
  if (prev.state !== state) { acc.stateSince = now; } else { acc.stateSince = prev.stateSince || now; }
  accounts[id] = acc;
  save();
  return acc;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (p.startsWith('/api/')) {
    // Password protects only the dashboard. Account scripts can report without it.
    const isReport = p === '/api/report' && req.method === 'POST';
    if (SECRET && !isReport && (req.headers['x-key'] || url.searchParams.get('key')) !== SECRET) {
      return send(res, 401, { error: 'bad key' });
    }
    try {
      if (p === '/api/report' && req.method === 'POST') {
        return send(res, 200, { ok: true, account: handleReport(await readBody(req)) });
      }
      if (p === '/api/accounts' && req.method === 'GET') {
        return send(res, 200, { now: Date.now(), accounts: Object.values(accounts) });
      }
      const m = p.match(/^\/api\/accounts\/(.+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (!accounts[id]) return send(res, 404, { error: 'not found' });
        if (req.method === 'DELETE') { delete accounts[id]; save(); return send(res, 200, { ok: true }); }
        if (req.method === 'PATCH') {
          const b = await readBody(req);
          if ('alias' in b) accounts[id].alias = str(b.alias, 60);
          save();
          return send(res, 200, { ok: true, account: accounts[id] });
        }
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      return send(res, 400, { error: String(e.message || e) });
    }
  }

  // Static dashboard
  const file = path.join(PUBLIC, p === '/' ? 'index.html' : path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}).listen(PORT, () => {
  console.log(`BP Vote Monitor running → http://localhost:${PORT}  (secret ${SECRET ? 'ON' : 'OFF'})`);
});
