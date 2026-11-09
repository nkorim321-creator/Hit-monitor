// ==UserScript==
// @name        BP Worker Vote Monitor (Multi-Account Reporter)
// Works in Tampermonkey and Violentmonkey.
// @namespace   https://www.bpworker.com/
// @version     2.0
// @description Reads the bpworker.com /vote page (Running / Blocked, unlock time, balance, available votes) and reports it to your Vote Monitor server so all accounts show on one dashboard.
// @match       https://www.bpworker.com/*
// @match       https://bpworker.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @connect     50.117.3.240
// @connect     localhost
// @connect     127.0.0.1
// @connect     *
// @run-at      document-end
// ==/UserScript==

(function () {
  'use strict';

  /* ── CONFIG ─────────────────────────────────────────────
     SERVER_URL / SECRET can also be changed from the Tampermonkey
     menu ("⚙ Set server URL" / "🔑 Set secret key"), per browser. */
  const DEFAULT_SERVER_URL = 'http://50.117.3.240';            // port 80: passes through proxies
  const DEFAULT_SERVER_URLS = [DEFAULT_SERVER_URL, 'http://50.117.3.240:3100'];  // tried in this order
  const DEFAULT_SECRET     = '';          // same as SECRET on the server (optional)
  const CHECK_EVERY_MS     = 60 * 1000;   // how often to re-read /vote
  const VOTE_URL           = location.origin + '/vote';

  const OLD_SERVER_HOSTS   = ['38.58.179.188'];   // old servers: a saved URL pointing here is replaced

  // Clean up a server URL: add http://, drop spaces, trailing "/" and a pasted "/api/..." path
  function cleanUrl(u) {
    u = String(u || '').trim().replace(/\s+/g, '');
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/api(\/.*)?$/i, '').replace(/\/+$/, '');
  }
  // A saved URL from an older version that still points to an old server → use the current default
  (function migrateSavedUrl() {
    const saved = GM_getValue('serverUrl', '');
    // Old server, or the old default with :3100 → use the automatic list (port 80 first, then 3100)
    if (saved && (OLD_SERVER_HOSTS.some(h => saved.includes(h)) || DEFAULT_SERVER_URLS.includes(cleanUrl(saved)))) GM_setValue('serverUrl', '');
  })();

  const cfg = {
    // A URL set from the menu is used alone; otherwise the default list, last working one first
    get servers() {
      const custom = cleanUrl(GM_getValue('serverUrl', ''));
      if (custom) return [custom];
      const w = GM_getValue('workingUrl', '');
      return DEFAULT_SERVER_URLS.includes(w) ? [w, ...DEFAULT_SERVER_URLS.filter(u => u !== w)] : DEFAULT_SERVER_URLS;
    },
    get server() { return this.servers[0]; },
    get secret()   { return GM_getValue('secret', DEFAULT_SECRET) || ''; },
    get nickname() { return GM_getValue('nickname', '') || ''; },
  };

  GM_registerMenuCommand('✏ Set nickname for this account', () => {
    const v = prompt('Nickname for this account (shown on dashboard):', cfg.nickname);
    if (v !== null) { GM_setValue('nickname', v.trim()); checkNow(); }
  });
  GM_registerMenuCommand('⚙ Set server URL', () => {
    const v = prompt('Vote Monitor server URL (leave blank = automatic: ' + DEFAULT_SERVER_URLS.join(' then ') + '):', GM_getValue('serverUrl', ''));
    if (v !== null) { GM_setValue('serverUrl', cleanUrl(v)); checkNow(); }
  });
  GM_registerMenuCommand('🔑 Set secret key', () => {
    const v = prompt('Secret key (must match server SECRET, blank if none):', cfg.secret);
    if (v !== null) { GM_setValue('secret', v.trim()); checkNow(); }
  });
  GM_registerMenuCommand('🔄 Check now', () => checkNow());
  GM_registerMenuCommand('🩺 Test server connection', () => testConnection());

  /* ── PARSER: turns /vote HTML into a status object ───── */
  function parseVoteHtml(html) {
    const out = {
      workerKey: null, email: null, state: 'UNKNOWN',
      balanceCents: null, totalBalanceCents: null, rateLimitSeconds: null,
      rateLimitText: null, categories: [], totalAvailable: 0, payoutUnlockSeconds: null,
      noticeText: null, waitText: null, waitSeconds: null,
    };

    const keyM = html.match(/window\.bp_push_worker\s*=\s*"([^"]+)"/);
    if (keyM) out.workerKey = keyM[1];

    const modelM = html.match(/WorkerDashboardVueModel\((\{[\s\S]*?\})\)\);/);
    let model = null;
    if (modelM) { try { model = JSON.parse(modelM[1]); } catch (e) { /* ignore */ } }

    // The account's mail is written in the payout texts ("Emailed to …", "… at … shortly").
    const emailM = html.match(/Emailed to\s+([^\s<]+@[^\s<]+?)\.?\s*<br/i) ||
                   html.match(/via Tremendous<\/b>\s+at\s+([^\s<]+@[^\s<]+?)\.?(?:\s|<)/i);
    if (emailM) out.email = emailM[1].trim();
    else {
      // Last try: any mail on the page except the site's own addresses
      const all = (html.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || []).filter(m => !/@bpworker\.com$/i.test(m));
      if (all.length) out.email = all[0];
    }

    if (!model) {
      // No dashboard model → most likely logged out / redirected to login
      out.state = /login|sign in|password/i.test(html) ? 'LOGGED_OUT' : 'UNKNOWN';
      return out;
    }

    out.balanceCents      = model.balanceCents ?? null;
    out.totalBalanceCents = model.totalBalanceCents ?? model.balanceCents ?? null;
    out.rateLimitSeconds  = model.rateLimitSeconds ?? null;
    out.payoutUnlockSeconds = model.tremendous ? (model.tremendous.unlockSeconds ?? null) : null;

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('.category-row').forEach(row => {
      const name  = (row.querySelector('.category-label')?.textContent || '').trim();
      const count = parseInt((row.querySelector('.category-count')?.textContent || '').replace(/[^\d]/g, ''), 10) || 0;
      const btn   = row.querySelector('.btn-vote');
      out.categories.push({ name, count, enabled: !!btn && !btn.classList.contains('disabled') });
      out.totalAvailable += count;
    });

    const rl = doc.querySelector('.rate-info b');
    if (rl) out.rateLimitText = rl.textContent.trim();

    // Notice shown instead of the categories, e.g. "Voting is paused on your account. Check back in:" + "9 days"
    const notice = doc.querySelector('.notice');
    if (notice) out.noticeText = notice.textContent.replace(/\s+/g, ' ').trim().slice(0, 200);
    else if (!doc.querySelector('.category-row')) {
      // Message written some other way (e.g. "A few of your past submissions require manual review…")
      const card = doc.querySelector('.dashboard-card') || doc.body;
      const c = card.cloneNode(true);
      c.querySelectorAll('h1, .payout-section, .contact-link, [style*="display:none"], script').forEach(n => n.remove());
      const t = c.textContent.replace(/\s+/g, ' ').trim();
      if (t) out.noticeText = t.slice(0, 200);
    }
    const nt = doc.querySelector('.notice-timer');
    const ntText = nt ? nt.textContent.replace(/\s+/g, ' ').trim() : '';   // empty for the live rate-limit countdown
    if (ntText) { out.waitText = ntText.slice(0, 60); out.waitSeconds = parseWait(ntText); }

    if (out.rateLimitSeconds && out.rateLimitSeconds > 0) out.state = 'BLOCKED';
    else if (out.noticeText && /paused|suspend|disabled|banned/i.test(out.noticeText)) out.state = 'PAUSED';
    else if (out.noticeText && /review/i.test(out.noticeText)) out.state = 'REVIEW';
    else if (out.categories.length) out.state = 'RUNNING';
    else out.state = 'UNKNOWN';          // no vote categories on the page: do not guess "running"
    return out;
  }

  // "9 days", "1 day 4 hours", "5 hours", "2:03:04" → seconds (null if not understood)
  function parseWait(t) {
    const c = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (c) return c[3] !== undefined ? (+c[1]) * 3600 + (+c[2]) * 60 + (+c[3]) : (+c[1]) * 60 + (+c[2]);
    const U = { week: 604800, day: 86400, hour: 3600, hr: 3600, minute: 60, min: 60, second: 1, sec: 1 };
    let sum = 0, found = false;
    for (const m of t.matchAll(/(\d+)\s*(week|day|hour|hr|minute|min|second|sec)s?/gi)) { sum += (+m[1]) * U[m[2].toLowerCase()]; found = true; }
    return found ? sum : null;
  }

  /* ── NETWORK ─────────────────────────────────────────── */
  // One request to one URL. Resolves to { ok: true } or { ok: false, why: '...' }
  function sendOnce(base, method, path, payload) {
    return new Promise(resolve => {
      const url = base + path;
      try {
        GM_xmlhttpRequest({
          method, url,
          headers: { 'Content-Type': 'application/json', 'X-Key': cfg.secret },
          data: payload ? JSON.stringify(payload) : undefined,
          timeout: 15000,
          onload: r => {
            if (r.status >= 200 && r.status < 300) { let data = null; try { data = JSON.parse(r.responseText); } catch (e) {} return resolve({ ok: true, data }); }
            const ours = /x-bp-vote-monitor/i.test(r.responseHeaders || '');
            const body = String(r.responseText || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
            resolve({ ok: false, status: r.status, why: ours
              ? `server answered HTTP ${r.status}${body ? ': ' + body : ''}`
              : `HTTP ${r.status} from something between this browser and the server (proxy/VPN/firewall), not from the Vote Monitor server${body ? ' — "' + body + '"' : ''}` });
          },
          onerror: r => resolve({ ok: false, why: 'cannot connect' + (r && r.error ? ' (' + r.error + ')' : '') }),
          ontimeout: () => resolve({ ok: false, why: 'no answer in 15 s (timeout)' }),
          onabort: () => resolve({ ok: false, why: 'request blocked/aborted' }),
        });
      } catch (e) {
        resolve({ ok: false, why: 'bad server URL: ' + url });
      }
    });
  }
  // Try each server URL (port 80 first, then 3100) and remember the one that works
  let usedUrl = '';
  async function send(method, path, payload) {
    const tried = [], fails = [];
    for (const base of cfg.servers) {
      const r = await sendOnce(base, method, path, payload);
      if (r.ok) { usedUrl = base; if (!GM_getValue('serverUrl', '')) GM_setValue('workingUrl', base); return r; }
      tried.push(`${base} → ${r.why}`); fails.push(r);
    }
    return { ok: false, why: tried.join(' | '), tried, fails };
  }
  const report = payload => send('POST', '/api/report', payload);

  async function testConnection() {
    const r = await send('GET', '/api/teams');
    if (r.ok) {
      alert('✅ Server connection OK\n\n' + usedUrl + '\n\nThis account can report to the dashboard.');
      checkNow();
      return;
    }
    const proxy = /proxy\/VPN\/firewall/.test(r.why);
    alert('❌ Cannot reach the Vote Monitor server\n\n' + r.tried.join('\n\n') + '\n\n' +
      (proxy
        ? 'The block comes from the proxy/VPN this browser uses, not from the server.\n' +
          'Fix: in the proxy/VPN settings, allow (bypass) the IP 50.117.3.240, or ask the proxy seller to allow port 80/3100.\n'
        : r.fails.every(f => /timeout/.test(f.why))
        ? 'The server did not answer at all. Usually the server program stopped or the server PC is off.\n' +
          'Fix: open ' + DEFAULT_SERVER_URL + ' in a browser. If the dashboard does not open,\n' +
          'log in to the server (Remote Desktop) and run install-windows.bat again (Run as administrator).\n'
        : 'Check:\n' +
          '1. Open ' + DEFAULT_SERVER_URL + ' in this same browser. Does the dashboard open?\n' +
          '   No → the server is off, or this PC/proxy cannot reach it.\n' +
          '2. Script menu → "⚙ Set server URL": leave it blank for automatic.\n') +
      '\nViolentmonkey needs no "allow" step. In Tampermonkey choose "Always allow" if it asks.');
  }

  /* ── BADGE ───────────────────────────────────────────── */
  let badge = null;
  function setBadge(color, text) {
    if (!badge) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', bottom: '14px', right: '64px', zIndex: 2147483640,
        background: '#0b1220', color: '#cbd5e1', border: '1px solid #1e3a5f',
        borderRadius: '8px', padding: '6px 12px', font: '11px/1.5 monospace',
        boxShadow: '0 4px 18px rgba(0,0,0,.35)', cursor: 'pointer', maxWidth: '420px',
      });
      badge.title = 'Click to test the server connection';
      badge.addEventListener('click', testConnection);
      document.body.appendChild(badge);
    }
    badge.style.borderColor = color;
    badge.textContent = text;
  }

  /* ── MAIN LOOP ───────────────────────────────────────── */
  let timer = null, busy = false;

  /* ── AUTO RELOAD when the block ends ─────────────────────
     The open /vote page does not refresh by itself: its timer stops at 0:00.
     When the timer hits 0:00 we check right away; if voting is open again
     we reload the page ONE time (never twice within 2 minutes, so no reload loop). */
  const ON_VOTE_PAGE = /^\/vote\/?$/.test(location.pathname);
  const RELOAD_KEY = 'bpvm_lastAutoReload';
  // Is the open page showing the "rate limit" / "paused" screen instead of the vote buttons?
  const pageShowsWait = () => !document.querySelector('.category-row') &&
    /rate limit|paused/i.test((document.querySelector('.notice') || {}).textContent || '');
  function reloadOnce() {
    let last = 0;
    try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch (e) {}
    if (Date.now() - last < 2 * 60 * 1000) return false;
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch (e) {}
    setBadge('#22c55e', '🟢 Voting open again · reloading page…');
    setTimeout(() => location.reload(), 800);
    return true;
  }
  if (ON_VOTE_PAGE) {
    let zeroSeen = false;
    setInterval(() => {
      if (!pageShowsWait()) { zeroSeen = false; return; }
      const t = ((document.querySelector('.notice-timer') || {}).textContent || '').trim();
      const atZero = /^0*:?0*:?00$/.test(t) && !/[1-9]/.test(t);       // "0:00", "00:00", "0:00:00"
      if (atZero && !zeroSeen) { zeroSeen = true; setTimeout(checkNow, 2000); }
      if (!atZero) zeroSeen = false;
    }, 1000);
  }

  async function checkNow() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    let nextMs = CHECK_EVERY_MS;
    try {
      const res  = await fetch(VOTE_URL + '?_=' + Date.now(), { credentials: 'include', cache: 'no-store' });
      const html = await res.text();
      const s    = parseVoteHtml(html);

      // Remember the account key so we can still report "logged out" later
      if (s.workerKey) GM_setValue('lastWorkerKey', s.workerKey);
      // Mail is remembered per account key, so one account never borrows another account's mail
      if (s.workerKey && s.email) GM_setValue('mail_' + s.workerKey, s.email);
      const id = s.workerKey || GM_getValue('lastWorkerKey', '');
      if (!id) { setBadge('#fbbf24', '⚠ Vote Monitor: account not detected'); return; }
      const email = s.email || GM_getValue('mail_' + id, '');

      const sent = await report({
        id,
        email,
        nickname: cfg.nickname,
        state: s.state,
        balanceCents: s.balanceCents,
        totalBalanceCents: s.totalBalanceCents,
        rateLimitSeconds: s.rateLimitSeconds,
        rateLimitText: s.rateLimitText,
        noticeText: s.noticeText,
        waitText: s.waitText,
        waitSeconds: s.waitSeconds,
        categories: s.categories,
        totalAvailable: s.totalAvailable,
        payoutUnlockSeconds: s.payoutUnlockSeconds,
        httpStatus: res.status,
      });

      // If blocked and the unlock is sooner than the next check, check right after unlock
      if (s.state === 'BLOCKED' && s.rateLimitSeconds > 0) {
        nextMs = Math.min(nextMs, s.rateLimitSeconds * 1000 + 5000);
      }

      const icon  = { RUNNING: '🟢', BLOCKED: '🔴', PAUSED: '🟠', REVIEW: '🟣', LOGGED_OUT: '⚪' }[s.state] || '🟡';
      const color = { RUNNING: '#22c55e', BLOCKED: '#ef4444', PAUSED: '#f97316', REVIEW: '#a78bfa' }[s.state] || '#fbbf24';
      // The open page still shows the wait screen, but voting is open now → reload it once
      if (ON_VOTE_PAGE && s.state === 'RUNNING' && pageShowsWait() && reloadOnce()) return;
      if (sent.ok) {
        const m = sent.data && sent.data.match;
        if (sent.data && 'match' in sent.data && !m) {
          // Server got it, but this mail is not in the Google Sheet → it cannot show on a team
          setBadge('#f59e0b', `${icon} ${s.state}  ·  ⚠ not in sheet: ${email || 'mail not found on page'}  ·  synced ${new Date().toLocaleTimeString()}`);
        } else {
          setBadge(color, `${icon} ${s.state}  ·  ${m ? m.team + ' ID-' + m.serial + '  ·  ' : ''}synced ${new Date().toLocaleTimeString()}`);
        }
      } else {
        const allTimeout = sent.fails.every(f => /timeout/.test(f.why));
        const short = allTimeout ? 'server not answering (is the server PC on and running?)'
          : sent.fails.map(f => /proxy\/VPN\/firewall/.test(f.why) ? `HTTP ${f.status} from proxy/VPN` : f.why.slice(0, 50)).join(' / ');
        setBadge('#f59e0b', `${icon} ${s.state}  ·  ⚠ not sent: ${short}  (click for details)`);
        nextMs = Math.min(nextMs, 15000);   // retry soon
      }
    } catch (e) {
      setBadge('#f59e0b', '⚠ Vote Monitor error: ' + (e && e.message || e));
    } finally {
      busy = false;
      timer = setTimeout(checkNow, nextMs);
    }
  }

  checkNow();
})();
