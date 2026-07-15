// ==UserScript==
// @name         AB2soft Earnings Report v8.0 (Local Server Edition)
// @namespace    ab2soft.secure
// @version      8.0
// @description  Uploads MTurk earnings to your own Panda Commander server (no Firebase) once per day, only if the worker's TEAM exists in the Google Sheet.
// @match        https://worker.mturk.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      docs.google.com
// @connect      api.ipify.org
// @connect      38.58.179.188
// ==/UserScript==

(async () => {
  'use strict';

  /* ── Only run on the /earnings page ── */
  if (!/^\/earnings(\/|$|\?)/.test(location.pathname)) return;

  /* ────────────────────────────── CONFIG ────────────────────────────── */
  // Your server (same one that runs Panda Commander + HIT Tracker + Payments)
  const SERVER_URL = 'http://38.58.179.188:3000';

  // Google Sheet with TEAM / WORKER ID / USERNAME / SERVER IP columns (team gating).
  const SHEET_CSV =
    'https://docs.google.com/spreadsheets/d/1bNFhVCn5kEQ-dmXra0DpazfAk7DxTKF5f99u1BIv3FM/export?format=csv&gid=0';

  // Google Sheet holding each worker's assigned BANK NUBMER (17-digit). We only
  // read the last 3 digits from it to compare with the transfer method shown on
  // the page — the bank number / password / email NEVER leave this machine.
  const BANK_SHEET_CSV =
    'https://docs.google.com/spreadsheets/d/1yVteJGLxlZPRFPhzbzdfW2FXBn7pEQX3C3uI03KlAtA/export?format=csv&gid=0';

  // If the latest transfer failed → alert "UPDATE BANK".
  const ENABLE_UPDATE_BANK_LOGIC = true;

  /* ────────────────────────────── HELPERS ────────────────────────────── */
  const $  = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const safeJSONParse = s => { try { return JSON.parse(String(s).replace(/&quot;/g, '"')); } catch { return null; } };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function toast(msg, ms = 3500) {
    try {
      const n = document.createElement('div');
      Object.assign(n.style, {
        position: 'fixed', right: '16px', bottom: '16px',
        background: '#111827', color: '#fff', padding: '9px 13px',
        borderRadius: '8px', fontFamily: 'Segoe UI, sans-serif',
        fontSize: '12px', zIndex: 999999, boxShadow: '0 6px 24px rgba(0,0,0,.5)'
      });
      n.textContent = msg;
      document.body.appendChild(n);
      setTimeout(() => n.remove(), ms);
    } catch {}
  }

  async function waitFor(predicate, timeoutMs = 15000, stepMs = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const v = predicate(); if (v) return v; } catch {}
      await sleep(stepMs);
    }
    return null;
  }

  function gmGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "GET", url, headers: { "Cache-Control": "no-cache" },
        timeout: 20000,
        onload: (res) => resolve(res.responseText),
        onerror: reject, ontimeout: reject
      });
    });
  }

  // POST JSON to the server (bypasses CORS / mixed-content via GM_xmlhttpRequest)
  function gmPost(url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST", url,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify(body),
        timeout: 15000,
        onload: (res) => resolve(res.status),
        onerror: () => reject(new Error("Network error (server POST)")),
        ontimeout: () => reject(new Error("Server write timed out"))
      });
    });
  }

  async function fetchPublicIP() {
    try { const j = JSON.parse(await gmGet('https://api.ipify.org?format=json')); return j.ip || 'unknown'; }
    catch { return 'unknown'; }
  }

  /* ────────────────────────────── PARSERS ────────────────────────────── */
  function getWorkerId() {
    const el = $$('[data-react-props]').find(e => e.getAttribute('data-react-props')?.includes('textToCopy'));
    if (el) {
      const j = safeJSONParse(el.getAttribute('data-react-props'));
      if (j?.textToCopy) return String(j.textToCopy).trim();
    }
    return $('.me-bar .text-uppercase span')?.textContent.trim() || '';
  }

  function extractNextTransferInfo() {
    const strongTag = $$('strong').find(el => /transferred to your/i.test(el.textContent));
    let bankAccount = '', nextTransferDate = '';
    if (strongTag) {
      const bankLink = strongTag.querySelector("a[href*='direct_deposit']") ||
                       strongTag.querySelector("a[href*='amazon.com/gp/css/gc/balance']");
      if (bankLink) {
        if (/amazon\.com/i.test(bankLink.href)) bankAccount = 'Amazon Gift Card';
        else if (/direct_deposit/i.test(bankLink.href)) bankAccount = bankLink.textContent.trim() || 'Bank';
        else bankAccount = bankLink.textContent.trim() || 'Other';
      }
      const m = strongTag.textContent.replace(/\s+/g, ' ').match(/on\s+([A-Za-z]{3,}\s+\d{1,2},\s+\d{4})/i);
      if (m) nextTransferDate = m[1].trim();
    }
    return { bankAccount, nextTransferDate };
  }

  function parseMMDDYY(s) {
    const ds = String(s || '').trim();
    if (!ds) return null;
    const parts = ds.split('/');
    if (parts.length !== 3) return null;
    let [mm, dd, yy] = parts.map(p => parseInt(p, 10));
    if ([mm, dd, yy].some(Number.isNaN)) return null;
    if (yy < 100) yy += 2000;
    return new Date(yy, mm - 1, dd);
  }

  function computeLastMonthEarnings(bodyData) {
    if (!Array.isArray(bodyData)) return { sumStr: '0.00', hadAnyPrevMonth: false };
    const now = new Date();
    const startThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const startLast = new Date(startThis.getFullYear(), startThis.getMonth() - 1, 1);
    const endLast   = new Date(startThis.getFullYear(), startThis.getMonth(), 0);
    endLast.setHours(23, 59, 59, 999);
    let total = 0, hadAnyPrevMonth = false;
    for (const t of bodyData) {
      const d = parseMMDDYY(t.requestedDate);
      if (!d) continue;
      if (d >= startLast && d <= endLast) {
        hadAnyPrevMonth = true;
        const amt = parseFloat(t.amountRequested) || 0;
        total += (amt >= 1 ? amt : 0);   // only >= $1 counts
      }
    }
    return { sumStr: total.toFixed(2), hadAnyPrevMonth };
  }

  function shouldUpdateBankOnFailedLatest(bodyData) {
    if (!Array.isArray(bodyData) || bodyData.length === 0) return false;
    const st = String(bodyData[0].status || '').toLowerCase().trim();
    return st === 'failed' || st.includes('failed');
  }

  /* ────────────────────────────── DATA EXTRACT ────────────────────────────── */
  async function extractData() {
    await waitFor(() => getWorkerId() || $('.me-bar'), 15000);

    const html = document.body.innerHTML.replace(/\s+/g, ' ');
    const workerId = getWorkerId();
    const userName = $(".me-bar a[href='/account']")?.textContent.trim() || '';
    const currentEarnings = (html.match(/Current Earnings:\s*\$([\d.]+)/i) || [])[1] || '0.00';

    let lastTransferAmount = '0.00', lastTransferDate = '', lastMonthEarnings = '0.00';
    let updateBankFlag = false, noPrevMonthFlag = false;

    try {
      const el = $$('[data-react-class]').find(e => e.getAttribute('data-react-class')?.includes('TransferHistoryTable'));
      if (el) {
        const parsed = safeJSONParse(el.getAttribute('data-react-props'));
        const body = parsed?.bodyData || [];
        if (ENABLE_UPDATE_BANK_LOGIC && shouldUpdateBankOnFailedLatest(body)) updateBankFlag = true;
        if (body.length > 0) {
          const last = body[0];
          const amt = parseFloat(last.amountRequested);
          lastTransferAmount = Number.isFinite(amt) ? amt.toFixed(2) : String(last.amountRequested ?? '0.00');
          lastTransferDate   = last.requestedDate ?? '';
        }
        const lm = computeLastMonthEarnings(body);
        lastMonthEarnings = lm.sumStr;
        if (!lm.hadAnyPrevMonth) noPrevMonthFlag = true;
      }
    } catch {}

    const { bankAccount, nextTransferDate } = extractNextTransferInfo();
    const ip = await fetchPublicIP();

    // Keep the REAL transfer method (e.g. "x615" / "Amazon Gift Card"). The last
    // 3 digits of a bank method are what we compare to the sheet. Gift cards have
    // no digits → transferLast3 is empty.
    const isGiftCard = /gift\s*card/i.test(bankAccount);
    const trailDigits = (String(bankAccount).match(/(\d+)\s*$/) || [])[1] || '';
    const transferLast3 = isGiftCard ? '' : trailDigits.slice(-3);

    // NOTE: currentEarnings is ALWAYS the real value shown on the page.
    // lastMonthEarnings is naturally 0.00 when there were no prev-month transfers.
    return {
      workerId, userName,
      currentEarnings,
      lastTransferAmount, lastTransferDate, nextTransferDate,
      bankAccount, ip,
      lastMonthEarnings,
      isGiftCard, transferLast3,
      _updateBankFlag: updateBankFlag,
      _noPrevMonthFlag: noPrevMonthFlag
    };
  }

  /* ────────────────────────────── CSV MAP LOADER ────────────────────────────── */
  // Robust-enough CSV parse (handles simple quoted cells).
  function parseCSV(text) {
    const rows = [];
    let row = [], cur = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (inQ && text[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { row.push(cur); cur = ''; }
      else if ((c === '\n' || c === '\r') && !inQ) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(r => r.join('').trim() !== '');
  }

  async function loadSheetFullMap() {
    const map = {};
    try {
      const rows = parseCSV(await gmGet(SHEET_CSV + '&_=' + Date.now()));
      if (!rows.length) return map;
      const headers = rows.shift().map(h => h.replace(/^﻿/, '').trim());
      const widIdx = headers.findIndex(h => /worker.?id/i.test(h));
      if (widIdx < 0) return map;
      for (const row of rows) {
        const workerId = (row[widIdx] || '').replace(/^﻿/, '').trim();
        if (!workerId) continue;
        map[workerId] = {};
        headers.forEach((h, i) => { map[workerId][h] = (row[i] || '').trim(); });
      }
    } catch (e) { console.warn("⚠️ CSV load error", e); }
    return map;
  }

  // Load ONLY the last-3 digits of each worker's assigned bank number.
  // Returns { byWorker: {workerId: last3}, byUser: {username: last3} }.
  // The full bank number / password / email never leave this function.
  async function loadBankLast3() {
    const byWorker = {}, byUser = {};
    try {
      const rows = parseCSV(await gmGet(BANK_SHEET_CSV + '&_=' + Date.now()));
      if (!rows.length) return { byWorker, byUser };
      const headers = rows.shift().map(h => h.replace(/^﻿/, '').trim());
      const widIdx  = headers.findIndex(h => /worker.?id/i.test(h));
      const userIdx = headers.findIndex(h => /user.?name/i.test(h));
      // "BANK NUBMER" (note the sheet's spelling) — any header with "bank", not "routing"
      const bankIdx = headers.findIndex(h => /bank/i.test(h) && !/rout/i.test(h));
      if (bankIdx < 0) return { byWorker, byUser };
      for (const row of rows) {
        const digits = String(row[bankIdx] || '').replace(/\D/g, '');
        if (digits.length < 3) continue;
        const last3 = digits.slice(-3);
        const wid  = widIdx  >= 0 ? String(row[widIdx]  || '').replace(/^﻿/, '').trim() : '';
        const user = userIdx >= 0 ? String(row[userIdx] || '').trim() : '';
        if (wid)  byWorker[wid] = last3;
        if (user) byUser[user]  = last3;
      }
    } catch (e) { console.warn("⚠️ Bank sheet load error", e); }
    return { byWorker, byUser };
  }

  /* ────────────────────────────── MAIN ────────────────────────────── */
  const data = await extractData();
  if (!data.workerId) { toast('⚠️ No Worker ID found on this page.'); return; }

  // INSTANT UPDATE: upload every time the /earnings page is opened (no once-per-day
  // skip) so the Payment dashboard always shows up-to-date current earnings. A
  // tiny guard only prevents a duplicate post on rapid double-refresh.
  const guardKey = `lastPost_${data.workerId}`;
  const lastPost = parseInt(await GM_getValue(guardKey, '0'), 10) || 0;
  if (Date.now() - lastPost < 8000) { return; }   // posted <8s ago → skip the dupe

  // Only allow workers whose TEAM is in the sheet
  const sheetMap  = await loadSheetFullMap();
  const extraInfo = sheetMap[data.workerId] || {};
  const teamName  = (extraInfo["TEAM"] || extraInfo["Team"] || '').trim();
  if (!teamName) { toast('⛔ Skipped — Worker/Team not in the Google Sheet'); return; }

  const userName = (extraInfo["USERNAME"] || extraInfo["Username"] || data.userName || '').trim();

  // ── BANK MATCH: compare the page's transfer-method last-3 with the assigned
  //    bank number's last-3 from the bank sheet. Mismatch → "WRONG BANK". ──
  // Always a non-empty value ('OK' when fine) so a previously-set WRONG BANK
  // clears once the worker fixes it (the server skips empty updates).
  let alert = 'OK';
  const bank = await loadBankLast3();
  const sheetLast3 = bank.byWorker[data.workerId] || (userName ? bank.byUser[userName] : '') || '';

  if (data._updateBankFlag) {
    alert = 'UPDATE BANK';                    // latest transfer failed → highest priority
  } else if (data.isGiftCard) {
    alert = 'OK';                             // gift card has no bank last-3 → not a mismatch
  } else if (sheetLast3 && data.transferLast3 && data.transferLast3 !== sheetLast3) {
    alert = 'WRONG BANK';
  }

  // Build the payload — ONLY the fields the Payments page shows. We deliberately
  // do NOT spread the sheet rows, so bank numbers / passwords / emails never
  // reach the server.
  const payload = {
    "TEAM": teamName,
    "USERNAME": userName,
    "WORKER ID": data.workerId,
    "SERVER IP": (extraInfo["SERVER IP"] || extraInfo["Server IP"] || '').trim(),
    currentEarnings:   data.currentEarnings,
    lastMonthEarnings: data.lastMonthEarnings,
    lastTransferAmount: data.lastTransferAmount,
    lastTransferDate:  data.lastTransferDate,
    nextTransferDate:  data.nextTransferDate,
    bankAccount:       data.bankAccount,
    ip:                data.ip,
    alert:             alert,
    timestamp:         new Date().toISOString()
  };

  try {
    const status = await gmPost(`${SERVER_URL}/earnings/${encodeURIComponent(data.workerId)}`, payload);
    if (status >= 200 && status < 300) {
      await GM_setValue(guardKey, String(Date.now()));
      toast(`✅ Synced ${data.workerId} (${teamName}) → server`);
      console.log('[AB2soft] Synced', data.workerId, payload);
    } else {
      toast(`⚠️ Server responded ${status} — will retry next visit`);
    }
  } catch (e) {
    toast('⚠️ Upload failed: ' + e.message);
    console.warn('[AB2soft] upload error', e);
  }
})();
