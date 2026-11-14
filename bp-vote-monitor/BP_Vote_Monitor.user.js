// ==UserScript==
// @name        BP Worker Vote Monitor (Multi-Account Reporter)
// Works in Tampermonkey and Violentmonkey.
// @namespace   https://www.bpworker.com/
// @version     3.0
// @description Reads the bpworker.com /vote page that is open in the tab (Running / Blocked, unlock time, balance, available votes) and reports it to your Vote Monitor server. Sends no requests of its own to bpworker.com.
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
     The server URL can also be changed per browser from the script menu ("⚙ Set server URL"). */
  const DEFAULT_SERVER_URL = 'http://50.117.3.240';            // port 80: passes through proxies
  const DEFAULT_SERVER_URLS = [DEFAULT_SERVER_URL, 'http://50.117.3.240:3100'];  // tried in this order
  const LOOK_EVERY_MS      = 15 * 1000;   // how often the open page is looked at (reading it costs no request)
  const SEND_EVERY_MS      = 60 * 1000;   // how often the status goes to the Vote Monitor server when nothing changed

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
  };

  GM_registerMenuCommand('⚙ Set server URL', () => {
    const v = prompt('Vote Monitor server URL (leave blank = automatic: ' + DEFAULT_SERVER_URLS.join(' then ') + '):', GM_getValue('serverUrl', ''));
    if (v !== null) { GM_setValue('serverUrl', cleanUrl(v)); look(true); }
  });
  GM_registerMenuCommand('🔄 Send status now', () => look(true));
  GM_registerMenuCommand('🩺 Test server connection', () => testConnection());

  /* ── PARSER: turns the /vote page (as HTML text) into a status object ───── */
  function parseVoteHtml(html) {
    const out = {
      workerKey: null, email: null, state: 'UNKNOWN',
      totalBalanceCents: null, rateLimitSeconds: null, rateLimitText: null,
      categories: [], totalAvailable: 0,
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

    const doc = new DOMParser().parseFromString(html, 'text/html');
    if (!model) {
      // No dashboard data on the page → a login page (it has a password box), or an error page (e.g. "Too Many Requests")
      out.state = doc.querySelector('input[type="password"]') ? 'LOGGED_OUT' : 'UNKNOWN';
      if (out.state === 'UNKNOWN') {
        doc.querySelectorAll('script, style').forEach(n => n.remove());
        out.noticeText = (doc.body ? doc.body.innerHTML : '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
      }
      return out;
    }

    // Balance: the number the page shows now; before the page has filled it in, the number it was sent with
    const shown = (doc.querySelector('.payout-balance b')?.textContent || '').match(/([\d,]+(?:\.\d+)?)/);
    out.totalBalanceCents = shown ? Math.round(parseFloat(shown[1].replace(/,/g, '')) * 100)
                                  : (model.totalBalanceCents ?? model.balanceCents ?? null);
    out.rateLimitSeconds  = model.rateLimitSeconds ?? null;   // seconds left when the page was made

    doc.querySelectorAll('.category-row').forEach(row => {
      const name  = (row.querySelector('.category-label')?.textContent || '').trim();
      const count = parseInt((row.querySelector('.category-count')?.textContent || '').replace(/[^\d]/g, ''), 10) || 0;
      out.categories.push({ name, count });
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
      c.querySelectorAll('h1, .payout-section, .contact-link, .colorbox-content, script, style').forEach(n => n.remove());
      c.querySelectorAll('[style]').forEach(n => { if (n.style.display === 'none') n.remove(); });   // the hidden pop-up texts
      const t = c.textContent.replace(/\s+/g, ' ').trim();
      if (t) out.noticeText = t.slice(0, 200);
    }
    const nt = doc.querySelector('.notice-timer');
    const ntText = nt ? nt.textContent.replace(/\s+/g, ' ').trim() : '';
    // For a rate limit this is the ticking countdown; the unlock time is worked out from rateLimitSeconds instead
    if (ntText && !(out.rateLimitSeconds > 0)) { out.waitText = ntText.slice(0, 60); out.waitSeconds = parseWait(ntText); }

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
          headers: { 'Content-Type': 'application/json' },
          data: payload ? JSON.stringify(payload) : undefined,
          timeout: 15000,
          onload: r => {
            let data = null; try { data = JSON.parse(r.responseText); } catch (e) {}
            // Only an answer from OUR server counts. Some proxies answer "200 OK" with their own page
            // without passing the report on; that must not show "synced".
            const ours = /x-bp-vote-monitor/i.test(r.responseHeaders || '') ||
                         !!(data && (data.ok === true || Array.isArray(data.teams)));
            const body = String(r.responseText || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
            if (r.status >= 200 && r.status < 300) {
              if (ours) return resolve({ ok: true, data });
              return resolve({ ok: false, status: r.status, why: `HTTP ${r.status} answer came from a proxy/VPN/firewall, not from the Vote Monitor server — the report did not arrive${body ? ' — "' + body + '"' : ''}` });
            }
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
      look(true);
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
  const BADGE_ID = 'bpvm-badge';
  let badge = null;
  function setBadge(color, text) {
    if (!badge) {
      badge = document.createElement('div');
      badge.id = BADGE_ID;
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

  /* ── READING THE OPEN PAGE ────────────────────────────────
     The script asks bpworker.com for nothing. It only reads the page that is already open in this tab
     (what you see yourself), so it adds no traffic to the site. Earlier versions fetched /vote every
     minute and on every page load; the site answered that with "429 Too Many Requests".
     The single page load the script can cause: ONE reload of /vote when a rate limit has ended. */
  const ON_VOTE_PAGE = /^\/vote\/?$/.test(location.pathname);
  const navEntry = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
  // When the site made this page: its numbers (seconds left, balance, votes) were true at that moment
  const PAGE_AT = Math.round((performance.timeOrigin || (Date.now() - performance.now())) + (navEntry ? navEntry.responseStart : 0));

  let lastSig = null, dataAt = PAGE_AT;
  function readVotePage() {
    const page = document.documentElement.cloneNode(true);
    page.querySelector('#' + BADGE_ID)?.remove();             // our own badge is not part of the site's page
    const s = parseVoteHtml(page.outerHTML);
    if (s.state === 'BLOCKED') {
      // The unlock moment is fixed: page time + the seconds the site gave. It does not depend on any timer.
      s.unlockAt = PAGE_AT + s.rateLimitSeconds * 1000;
      s.rateLimitSeconds = Math.round((s.unlockAt - Date.now()) / 1000) || -1;   // below 0 once the limit is over
    }
    const sig = JSON.stringify([s.state, s.totalBalanceCents, s.categories, s.unlockAt || 0, s.noticeText, s.waitText, s.rateLimitText]);
    s.changed = sig !== lastSig;
    if (lastSig !== null && s.changed) dataAt = Date.now();   // the page changed by itself while it was open
    lastSig = sig;
    return s;
  }
  // The account key the site writes into its pages
  const pageKey = () => (document.documentElement.innerHTML.match(/bp_push_worker\s*=\s*"([^"]+)"/) || [])[1] || '';
  const isLoginPage = () => !!document.querySelector('input[type="password"]');

  /* ── ONE RELOAD when the rate limit ends ──────────────────
     The open /vote page does not refresh by itself (its timer stops at 0:00). When the unlock time has
     passed, the page is reloaded once so the vote buttons show and the dashboard gets fresh numbers.
     Never more often than every 2 minutes and at most 3 times an hour, so it cannot loop. */
  const RELOAD_KEY = 'bpvm_autoReloads';
  function reloadOnce() {
    let times = [];
    try { times = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || '[]'); } catch (e) {}
    const now = Date.now();
    times = (Array.isArray(times) ? times : []).filter(t => now - t < 60 * 60 * 1000);
    if (times.length >= 3 || (times.length && now - times[times.length - 1] < 2 * 60 * 1000)) return false;
    times.push(now);
    try { sessionStorage.setItem(RELOAD_KEY, JSON.stringify(times)); } catch (e) {}
    setBadge('#22c55e', '🟢 Rate limit is over · reloading the page once…');
    setTimeout(() => location.reload(), 800);
    return true;
  }

  /* ── SENDING TO THE VOTE MONITOR SERVER ─────────────────── */
  const clock = () => new Date().toLocaleTimeString();
  const idText = m => (m ? `${m.team} ID-${m.serial}  ·  ` : '');
  function showSendError(prefix, sent) {
    const allTimeout = sent.fails.every(f => /timeout/.test(f.why));
    const short = allTimeout ? 'server not answering (is the server PC on and running?)'
      : sent.fails.map(f => /proxy\/VPN\/firewall/.test(f.why) ? `HTTP ${f.status} from proxy/VPN` : f.why.slice(0, 50)).join(' / ');
    setBadge('#f59e0b', `${prefix}  ·  ⚠ not sent: ${short}  (click for details)`);
  }

  // Status read from the open /vote page
  async function sendStatus(s) {
    // Remember the account key so "logged out" can still be reported later
    if (s.workerKey) GM_setValue('lastWorkerKey', s.workerKey);
    // Mail is remembered per account key, so one account never borrows another account's mail
    if (s.workerKey && s.email) GM_setValue('mail_' + s.workerKey, s.email);
    const id = s.workerKey || GM_getValue('lastWorkerKey', '');
    if (!id) { setBadge('#fbbf24', '⚠ Vote Monitor: account not detected'); return false; }
    const email = s.email || GM_getValue('mail_' + id, '');

    const sent = await report({
      id, email,
      state: s.state,
      totalBalanceCents: s.totalBalanceCents,
      rateLimitSeconds: s.rateLimitSeconds,
      rateLimitText: s.rateLimitText,
      noticeText: s.noticeText,
      waitText: s.waitText,
      waitSeconds: s.waitSeconds,
      categories: s.categories,
      totalAvailable: s.totalAvailable,
      // how old these numbers are: since the page was loaded, or since it last changed by itself
      dataAgeSeconds: Math.max(0, Math.round((Date.now() - dataAt) / 1000)),
    });

    const icon  = { RUNNING: '🟢', BLOCKED: '🔴', PAUSED: '🟠', REVIEW: '🟣', LOGGED_OUT: '⚪' }[s.state] || '🟡';
    const color = { RUNNING: '#22c55e', BLOCKED: '#ef4444', PAUSED: '#f97316', REVIEW: '#a78bfa' }[s.state] || '#fbbf24';
    if (!sent.ok) { showSendError(`${icon} ${s.state}`, sent); return false; }
    const d = sent.data || {};
    if (d.v) GM_setValue('serverV', d.v);
    if ('match' in d && !d.match) {
      // Server got it, but this mail is not in the Google Sheet → it cannot show on a team
      setBadge('#f59e0b', `${icon} ${s.state}  ·  ⚠ not in sheet: ${email || 'mail not found on page'}  ·  synced ${clock()}`);
    } else if (d.match) {
      setBadge(color, `${icon} ${s.state}  ·  ${idText(d.match)}synced ${clock()}`);
    } else {
      setBadge(color, `${icon} ${s.state}  ·  synced ${clock()}  ·  (server needs update for ID check)`);   // older server
    }
    return true;
  }

  // On other bpworker pages (while voting, settings …) the status cannot be read.
  // Only "this account's browser is open" is sent, so the ID does not look offline while you vote.
  async function sendAlive() {
    const key = pageKey();
    if (key) GM_setValue('lastWorkerKey', key);
    const id = key || GM_getValue('lastWorkerKey', '');
    if (!id) { setBadge('#fbbf24', '⚠ Vote Monitor: open the /vote page once'); return false; }
    if (!key && isLoginPage()) {
      const sent = await report({ id, email: GM_getValue('mail_' + id, ''), state: 'LOGGED_OUT' });
      if (!sent.ok) { showSendError('⚪ LOGGED_OUT', sent); return false; }
      setBadge('#fbbf24', `⚪ LOGGED_OUT  ·  ${idText(sent.data && sent.data.match)}synced ${clock()}`);
      return true;
    }
    // Servers before version 3 would take this for a full status, so it is only sent to newer ones
    if (!(GM_getValue('serverV', 0) >= 3)) { setBadge('#64748b', 'Vote Monitor  ·  status is read on the /vote page'); return true; }
    const sent = await report({ id, heartbeat: true });
    if (!sent.ok) { showSendError('Vote Monitor', sent); return false; }
    const d = sent.data || {};
    setBadge('#22c55e', d.unknown ? 'Vote Monitor  ·  open the /vote page once so this ID is known'
                                  : `🟢 Vote Monitor  ·  ${idText(d.match)}online ${clock()}`);
    return true;
  }

  /* ── MAIN LOOP ───────────────────────────────────────── */
  let busy = false, lastSentAt = 0, lastOk = true;
  async function look(force) {
    if (busy) return;
    busy = true;
    try {
      // After a failed send, try again at the next look (only our own server is contacted)
      const due = force === true || !lastOk || Date.now() - lastSentAt >= SEND_EVERY_MS;
      if (ON_VOTE_PAGE) {
        const s = readVotePage();
        // Rate limit is over but the page still shows the wait screen → reload it once
        if (s.state === 'BLOCKED' && Date.now() >= s.unlockAt + 5000 && reloadOnce()) return;
        if (s.changed || due) { lastSentAt = Date.now(); lastOk = await sendStatus(s); }
      } else if (due) { lastSentAt = Date.now(); lastOk = await sendAlive(); }
    } catch (e) {
      setBadge('#f59e0b', '⚠ Vote Monitor error: ' + (e && e.message || e));
    } finally {
      busy = false;
    }
  }

  setTimeout(look, 1500);                 // give the page a moment to fill in its numbers
  setInterval(look, LOOK_EVERY_MS);
})();
