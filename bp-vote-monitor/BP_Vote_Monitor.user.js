// ==UserScript==
// @name        BP Worker Vote Monitor (Multi-Account Reporter)
// @namespace   https://www.bpworker.com/
// @version     1.0
// @description Reads the bpworker.com /vote page (Running / Blocked, unlock time, balance, available votes) and reports it to your Vote Monitor server so all accounts show on one dashboard.
// @match       https://www.bpworker.com/*
// @match       https://bpworker.com/*
// @grant       GM_xmlhttpRequest
// @grant       GM_getValue
// @grant       GM_setValue
// @grant       GM_registerMenuCommand
// @connect     38.58.179.188
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
  const DEFAULT_SERVER_URL = 'http://38.58.179.188:3100';
  const DEFAULT_SECRET     = '';          // same as SECRET on the server (optional)
  const CHECK_EVERY_MS     = 60 * 1000;   // how often to re-read /vote
  const VOTE_URL           = location.origin + '/vote';

  const cfg = {
    get server()   { return (GM_getValue('serverUrl', DEFAULT_SERVER_URL) || '').replace(/\/+$/, ''); },
    get secret()   { return GM_getValue('secret', DEFAULT_SECRET) || ''; },
    get nickname() { return GM_getValue('nickname', '') || ''; },
  };

  GM_registerMenuCommand('✏ Set nickname for this account', () => {
    const v = prompt('Nickname for this account (shown on dashboard):', cfg.nickname);
    if (v !== null) { GM_setValue('nickname', v.trim()); checkNow(); }
  });
  GM_registerMenuCommand('⚙ Set server URL', () => {
    const v = prompt('Vote Monitor server URL:', cfg.server);
    if (v !== null) { GM_setValue('serverUrl', v.trim()); checkNow(); }
  });
  GM_registerMenuCommand('🔑 Set secret key', () => {
    const v = prompt('Secret key (must match server SECRET, blank if none):', cfg.secret);
    if (v !== null) { GM_setValue('secret', v.trim()); checkNow(); }
  });
  GM_registerMenuCommand('🔄 Check now', () => checkNow());

  /* ── PARSER: turns /vote HTML into a status object ───── */
  function parseVoteHtml(html) {
    const out = {
      workerKey: null, email: null, state: 'UNKNOWN',
      balanceCents: null, totalBalanceCents: null, rateLimitSeconds: null,
      rateLimitText: null, categories: [], totalAvailable: 0, payoutUnlockSeconds: null,
    };

    const keyM = html.match(/window\.bp_push_worker\s*=\s*"([^"]+)"/);
    if (keyM) out.workerKey = keyM[1];

    const modelM = html.match(/WorkerDashboardVueModel\((\{[\s\S]*?\})\)\);/);
    let model = null;
    if (modelM) { try { model = JSON.parse(modelM[1]); } catch (e) { /* ignore */ } }

    const emailM = html.match(/Emailed to\s+([^\s<]+@[^\s<]+?)\.?\s*<br/i);
    if (emailM) out.email = emailM[1];

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

    out.state = (out.rateLimitSeconds && out.rateLimitSeconds > 0) ? 'BLOCKED' : 'RUNNING';
    return out;
  }

  /* ── NETWORK ─────────────────────────────────────────── */
  function report(payload) {
    return new Promise(resolve => {
      if (!cfg.server) return resolve(false);
      GM_xmlhttpRequest({
        method: 'POST',
        url: cfg.server + '/api/report',
        headers: { 'Content-Type': 'application/json', 'X-Key': cfg.secret },
        data: JSON.stringify(payload),
        timeout: 12000,
        onload: r => resolve(r.status >= 200 && r.status < 300),
        onerror: () => resolve(false),
        ontimeout: () => resolve(false),
      });
    });
  }

  /* ── BADGE ───────────────────────────────────────────── */
  let badge = null;
  function setBadge(color, text) {
    if (!badge) {
      badge = document.createElement('div');
      Object.assign(badge.style, {
        position: 'fixed', bottom: '12px', right: '12px', zIndex: 2147483640,
        background: '#0b1220', color: '#cbd5e1', border: '1px solid #1e3a5f',
        borderRadius: '8px', padding: '6px 12px', font: '11px/1.5 monospace',
        boxShadow: '0 4px 18px rgba(0,0,0,.35)', pointerEvents: 'none',
      });
      document.body.appendChild(badge);
    }
    badge.style.borderColor = color;
    badge.textContent = text;
  }

  /* ── MAIN LOOP ───────────────────────────────────────── */
  let timer = null, busy = false;

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
      if (s.email)     GM_setValue('lastEmail', s.email);
      const id = s.workerKey || GM_getValue('lastWorkerKey', '') || GM_getValue('lastEmail', '');
      if (!id) { setBadge('#fbbf24', '⚠ Vote Monitor: account not detected'); return; }

      const ok = await report({
        id,
        email: s.email || GM_getValue('lastEmail', ''),
        nickname: cfg.nickname,
        state: s.state,
        balanceCents: s.balanceCents,
        totalBalanceCents: s.totalBalanceCents,
        rateLimitSeconds: s.rateLimitSeconds,
        rateLimitText: s.rateLimitText,
        categories: s.categories,
        totalAvailable: s.totalAvailable,
        payoutUnlockSeconds: s.payoutUnlockSeconds,
        httpStatus: res.status,
      });

      // If blocked and the unlock is sooner than the next check, check right after unlock
      if (s.state === 'BLOCKED' && s.rateLimitSeconds > 0) {
        nextMs = Math.min(nextMs, s.rateLimitSeconds * 1000 + 5000);
      }

      const icon  = { RUNNING: '🟢', BLOCKED: '🔴', LOGGED_OUT: '⚪' }[s.state] || '🟡';
      const color = { RUNNING: '#22c55e', BLOCKED: '#ef4444' }[s.state] || '#fbbf24';
      setBadge(ok ? color : '#f59e0b',
        `${icon} ${s.state}  ·  ${ok ? 'synced ' + new Date().toLocaleTimeString() : '⚠ server unreachable'}`);
    } catch (e) {
      setBadge('#f59e0b', '⚠ Vote Monitor error: ' + (e && e.message || e));
    } finally {
      busy = false;
      timer = setTimeout(checkNow, nextMs);
    }
  }

  checkNow();
})();
