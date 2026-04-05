// ==UserScript==
// @name        MTurk HIT Tracker (Ultimate Action Memory)
// @namespace   https://worker.mturk.com/
// @version     5.5
// @description Perfects Return/Submit tracking using LocalStorage intent memory to bypass React modals. Kills zombie timers.
// @match       https://worker.mturk.com/*
// @updateURL   https://hit-monitorv3.web.app/Hit_Monitor.user.js
// @downloadURL https://hit-monitorv3.web.app/Hit_Monitor.user.js
// @grant       GM_xmlhttpRequest
// @grant       unsafeWindow
// @connect     docs.google.com
// @connect     firestore.googleapis.com
// @run-at      document-end
// ==/UserScript==

(async () => {

/* ── CONFIG ─────────────────────────────────────────────── */
const AUTH_SHEET = "https://docs.google.com/spreadsheets/d/1p03KacnfGQhtXm7umEnbktki3wCpaVzC_16W51iKn6U/export?format=csv&gid=0";

const FB_PROJECT = "hit-monitorv3";
const FB_KEY     = "AIzaSyCngCK0LNH0jFWGrPy9o2b5whfxBLdTh3Y";
const FS_BASE    = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

/* ── GM_xmlhttpRequest → Promise ────────────────────────── */
function gmPatch(url, body) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "PATCH",
      url,
      headers: { "Content-Type": "application/json" },
      data:    JSON.stringify(body),
      timeout: 12000,
      onload:   r => resolve(r.status),
      onerror:  () => reject(new Error("Network error (Firestore PATCH)")),
      ontimeout: () => reject(new Error("Firestore write timed out")),
    });
  });
}

function gmFetchCSV(url) {
  return new Promise((resolve, reject) => {
    GM_xmlhttpRequest({
      method: "GET",
      url: url,
      headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Accept': 'text/csv,text/plain,*/*' },
      timeout: 15000,
      onload: r => resolve(r),
      onerror: () => reject(new Error("Network error fetching CSV")),
      ontimeout: () => reject(new Error("CSV fetch timed out")),
    });
  });
}

/* ── Firestore REST helpers ──────────────────────────────── */
function toFSFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string")  fields[k] = { stringValue: v };
    else if (typeof v === "number")  fields[k] = { doubleValue: v };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
  }
  return { fields };
}

async function fsSet(docId, data) {
  const keys = Object.keys(data).filter(k => data[k] !== null && data[k] !== undefined);
  if (!keys.length) return;
  const mask = keys.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join("&");
  const url  = `${FS_BASE}/hits/${encodeURIComponent(docId)}?key=${FB_KEY}&${mask}`;
  try {
    await gmPatch(url, toFSFields(data));
  } catch(e) {}
}

/* ── STATUS BADGE ────────────────────────────────────────── */
function makeBadge() {
  const b = document.createElement("div");
  b.id = "__hts__";
  Object.assign(b.style, {
    position:       "fixed",
    bottom:         "14px",
    right:          "14px",
    zIndex:         "2147483640",
    background:     "#08101e",
    border:         "1px solid #1e3a5f",
    borderRadius:   "10px",
    padding:        "8px 14px",
    fontFamily:     "monospace",
    fontSize:       "11px",
    color:          "#64748b",
    boxShadow:      "0 4px 24px rgba(0,0,0,.6)",
    maxWidth:       "260px",
    lineHeight:     "1.6",
    userSelect:     "none",
    transition:     "border-color .3s, color .3s",
    backdropFilter: "blur(8px)",
  });
  b.textContent = "⏳ HIT Tracker loading…";
  document.body.appendChild(b);
  return b;
}

function setBadge(b, state, html) {
  const C = {
    loading: ["#1e3a5f", "#64748b"],
    ok:      ["#00e5a0", "#00e5a0"],
    sync:    ["#38bdf8", "#38bdf8"],
    denied:  ["#ff4060", "#f87171"],
    error:   ["#ff4060", "#fbbf24"],
  };
  const [bc, fc] = C[state] || C.loading;
  b.style.borderColor = bc;
  b.style.color       = fc;
  b.innerHTML         = html;
}

/* ── LOCK SCREEN ─────────────────────────────────────────── */
function xe(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showLock(workerId, reason) {
  document.getElementById("__lock__")?.remove();
  const ov = document.createElement("div");
  ov.id = "__lock__";
  Object.assign(ov.style, {
    position:       "fixed",
    inset:          "0",
    zIndex:         "2147483647",
    background:     "rgba(2,4,10,0.97)",
    backdropFilter: "blur(16px)",
    display:        "flex",
    alignItems:     "center",
    justifyContent: "center",
    fontFamily:     "'Segoe UI', system-ui, sans-serif",
  });

  ov.innerHTML = `
    <div style="background:#080f1e;border:1px solid rgba(255,60,80,.3);
                border-radius:18px;padding:44px 52px;max-width:500px;width:92%;
                text-align:center;box-shadow:0 0 80px rgba(0,0,0,.95)">
      <div style="font-size:60px;margin-bottom:16px;
                  filter:drop-shadow(0 0 24px rgba(255,60,80,.6))">🔒</div>
      <div style="font-size:22px;font-weight:800;color:#ff4060;margin-bottom:10px">
        Access Denied
      </div>
      <div style="font-size:13px;color:#94a3b8;line-height:1.9;margin-bottom:20px">
        Worker ID:
        <code style="background:#0f1929;border:1px solid #1e3a5f;padding:2px 10px;
          border-radius:5px;color:#fbbf24;font-size:12px">${xe(workerId || "Unknown")}</code><br>
        Reason: <span style="color:#f87171">${xe(reason || "Not authorized")}</span>
      </div>
    </div>`;

  document.body.appendChild(ov);
  document.body.style.overflow = "hidden";
}

function hideLock() {
  document.getElementById("__lock__")?.remove();
  document.body.style.overflow = "";
}

/* ── EXACT VACUUM WORKER ID DETECTION ────────────────────── */
function getWorkerId() {
  return new Promise(resolve => {
    var WID_RE = /\b(A[A-Z0-9]{9,19})\b/;

    function scanTextNodes(){
        var walker = document.createTreeWalker(document.body, 4, null, false);
        var node;
        while ((node = walker.nextNode())){
            var t = (node.nodeValue || '').trim();
            if (t.length > 5 && t.length < 100){
                var m = t.match(WID_RE);
                if (m) return m[1];
            }
        }
        return null;
    }
    var fromDOM = scanTextNodes();
    if (fromDOM){ resolve(fromDOM); return; }

    try {
        var win = unsafeWindow || window;
        var globals = ['__reactInitialState__','__INITIAL_STATE__','__APP_STATE__',
                       'turkerId','workerId','worker_id','WORKER_ID','currentWorker'];
        for (var g = 0; g < globals.length; g++){
            var val = win[globals[g]];
            if (!val) continue;
            var str = typeof val === 'string' ? val : JSON.stringify(val);
            var wm = str.match(WID_RE);
            if (wm){ resolve(wm[1]); return; }
        }
    } catch(e){}

    var scripts = document.querySelectorAll('script');
    for (var s = 0; s < scripts.length; s++){
        var sc = scripts[s].textContent || '';
        if (sc.length > 50 && sc.indexOf('A') > -1){
            var sm = sc.match(/worker[_\-]?id['":\s]+([A-Z0-9]{10,20})/i) ||
                     sc.match(/"id"\s*:\s*"(A[A-Z0-9]{9,19})"/i) ||
                     sc.match(/\b(A[A-Z0-9]{13,19})\b/);
            if (sm && sm[1] && /^A[A-Z0-9]{9,19}$/.test(sm[1])){ resolve(sm[1]); return; }
        }
    }

    var ck = (document.cookie || '').match(/worker_id=([A-Z0-9]{10,20})/i);
    if (ck && ck[1]){ resolve(ck[1].toUpperCase()); return; }

    var tried = 0;
    var apis = ['https://worker.mturk.com/api/worker', 'https://worker.mturk.com/api/profile', 'https://worker.mturk.com/worker_requirements'];
    function tryApi(){
        if (tried >= apis.length){ tryDashboard(); return; }
        var url = apis[tried++];
        GM_xmlhttpRequest({
            method: 'GET',
            url: url + '?_=' + Date.now(),
            headers: { 'Accept': 'application/json, text/html', 'X-Requested-With': 'XMLHttpRequest' },
            timeout: 8000,
            onload: function(r){
                var found = extractWid(r.responseText || '');
                if (found){ resolve(found); return; }
                tryApi();
            },
            onerror:   function(){ tryApi(); },
            ontimeout: function(){ tryApi(); }
        });
    }

    function tryDashboard(){
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'https://worker.mturk.com/dashboard?_=' + Date.now(),
            headers: { 'Accept': 'text/html' },
            timeout: 12000,
            onload: function(r){
                var found = extractWid(r.responseText || '');
                resolve(found || null);
            },
            onerror:   function(){ resolve(null); },
            ontimeout: function(){ resolve(null); }
        });
    }

    tryApi();

    function extractWid(text){
        var pats = [/worker[_\-]?id['":\s]+([A-Z0-9]{10,20})/i, /"id"\s*:\s*"(A[A-Z0-9]{12,19})"/i, /\b(A[A-Z0-9]{13,19})\b/];
        for (var i = 0; i < pats.length; i++){
            var m = text.match(pats[i]);
            if (m && m[1] && /^A[A-Z0-9]{9,19}$/.test(m[1])) return m[1].toUpperCase();
        }
        return null;
    }
  });
}

/* ── BULLETPROOF CSV PARSER ─────────────────────────────── */
function parseCSV(txt) {
  txt = (txt || '').replace(/^\uFEFF/, '');
  const rows = [];
  let curRow = [];
  let inQ = false, cur = '';
  for (let i = 0; i < txt.length; i++) {
    const c = txt[i];
    if (c === '"') {
      inQ = !inQ;
    } else if (c === ',' && !inQ) {
      curRow.push(cur.trim());
      cur = '';
    } else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && txt[i+1] === '\n') i++;
      curRow.push(cur.trim());
      rows.push(curRow);
      curRow = [];
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur !== '' || curRow.length > 0) {
    curRow.push(cur.trim());
    rows.push(curRow);
  }
  while(rows.length > 0 && rows[rows.length-1].join('') === '') {
    rows.pop();
  }
  return rows;
}

/* ── SMART SHEET AUTHORIZATION (STRICT USERNAME PULL) ───── */
async function authorize(workerId) {
  if (!workerId) return { denied: true, reason: "Worker ID not detected" };
  const wid = workerId.toUpperCase().trim();

  try {
    const url = AUTH_SHEET + '&nocache=' + Date.now();
    const r = await gmFetchCSV(url);

    if (r.status === 200 && (r.responseText || '').indexOf('<html') === -1) {
      const rows = parseCSV(r.responseText);
      if (rows && rows.length >= 2) {
        const headers = rows[0].map(h => h.toUpperCase().trim());

        let widCol = headers.findIndex(h => h === 'WORKER ID' || h === 'WORKERID' || h === 'ID' || h === 'WORKER_ID');
        let teamCol = headers.findIndex(h => h.includes('TEAM'));
        let userCol = headers.findIndex(h => h === 'USERNAME' || h === 'NAME' || h === 'USER NAME' || h === 'USER');

        let foundRow = -1;

        if (widCol !== -1) {
          for (let row = 1; row < rows.length; row++) {
            if (rows[row][widCol] && rows[row][widCol].toUpperCase().trim() === wid) {
              foundRow = row;
              break;
            }
          }
        }

        if (foundRow === -1) {
          for (let col = 0; col < headers.length; col++) {
            for (let row = 1; row < rows.length; row++) {
              const cell = (rows[row][col] || '').toUpperCase().trim();
              if (cell === wid) {
                foundRow = row;
                break;
              }
            }
            if (foundRow !== -1) break;
          }
        }

        if (foundRow !== -1) {
          let teamname = "Authorized";
          let username = wid;

          if (teamCol !== -1 && rows[foundRow][teamCol]) teamname = rows[foundRow][teamCol].trim();

          if (userCol !== -1 && rows[foundRow][userCol]) {
             let sheetName = rows[foundRow][userCol].trim();
             if (sheetName !== "") {
                 username = sheetName;
             }
          }

          return { username, teamname, denied: false };
        }
      }
    }
    return { denied: true, reason: "Worker ID not found in sheet" };
  } catch(e) {
    return { denied: true, reason: "Network Error reading Auth Sheet" };
  }
}

/* ── ZERO-LATENCY JSON QUEUE SCRAPER (Empty-Queue Aware) ── */
async function getQueueJSON() {
    try {
        const res = await fetch('https://worker.mturk.com/tasks.json?_=' + Date.now(), {
            cache: 'no-store',
            headers: { 'Accept': 'application/json', 'Pragma': 'no-cache' }
        });

        if (res.ok) {
            const text = await res.text();
            try {
                // Try to parse it as normal JSON
                const data = JSON.parse(text);
                const tasks = data.tasks || data.assignments || data.results || [];

                return tasks.map(t => {
                    const proj = t.project || t;
                    const reqName = proj.requester_name || t.requester_name || "Unknown";

                    return {
                        assignmentId: t.assignment_id || t.task_id,
                        requester: reqName,
                        title: proj.title || "HIT",
                        reward: parseFloat(proj.monetary_reward?.amount_in_dollars || proj.reward || 0),
                        timeSecs: parseInt(t.time_to_deadline_in_seconds || proj.assignment_duration_in_seconds) || 3600
                    };
                });
            } catch(parseErr) {
                // If it fails to parse, check if MTurk returned the "Empty Queue" HTML instead
                if (text.includes("You don't currently have any HITs accepted") || text.includes("Your HITs Queue (0)")) {
                    return []; // Queue is officially empty, return empty array (NOT null)
                }
            }
        }
    } catch(e) {}

    // Bulletproof DOM Fallback: Check the actual page text just in case the API was blocked
    if (document.body && document.body.textContent.includes("You don't currently have any HITs accepted")) {
        return [];
    }

    // If we reach here, it's a true network error. Safe to return null and pause syncing.
    return null;
}

/* ── BULLETPROOF ACTION TRACKER (INTENT MEMORY SYSTEM) ──── */
function markIntent(id, type) {
    if (!id) return;
    // Saves the action into browser memory so it survives page reloads
    localStorage.setItem(`intent_${type}_${id}`, Date.now());

    // Fires an immediate signal to the dashboard.
    // (If the user clicks "Cancel" on the MTurk modal, the 5-second sync engine will self-heal and flip it back to ACTIVE).
    if (type === "return") {
        fsSet(id, { status: "manual_returned", returnedAt: new Date().toISOString(), timeLimitSec: 0 });
    } else if (type === "submit") {
        fsSet(id, { status: "submitted", submittedAt: new Date().toISOString(), timeLimitSec: 0 });
    }
}

let pendingReturnId = null;

document.addEventListener("click", ev => {
    const btn = ev.target.closest("a, button, [role='button'], input[type='submit']");
    if (!btn) return;

    const txt = (btn.textContent || btn.value || "").trim().toLowerCase();
    const isReturn = txt === "return" || txt.includes("return hit");
    const isSubmit = txt === "submit" || txt.includes("submit hit");

    if (!isReturn && !isSubmit) return;

    let assignId = null;

    // 1. If inside the HIT Workspace (Top Right bar), pull ID from URL
    const urlParams = new URLSearchParams(window.location.search);
    assignId = urlParams.get("assignment_id") || urlParams.get("assignmentId");
    if (!assignId) {
        const pathMatch = window.location.pathname.match(/\/tasks\/([A-Z0-9]+)/i);
        if (pathMatch) assignId = pathMatch[1];
    }

    // 2. If on the Queue page, pull ID by scanning the "Work" button inside the same row
    if (!assignId) {
        const row = btn.closest('tr, li, .table-row, .task-row');
        if (row) {
            const workLink = row.querySelector('a[href*="/tasks/"]');
            if (workLink) {
                const m1 = workLink.href.match(/\/tasks\/([A-Z0-9]+)/i);
                const m2 = workLink.href.match(/assignment_id=([A-Z0-9]+)/i);
                assignId = (m1 ? m1[1] : null) || (m2 ? m2[1] : null);
            }
        }
    }

    // 3. Process the Action
    if (isReturn) {
        if (assignId) {
            pendingReturnId = assignId; // Hold it in memory just in case a React modal pops up
            markIntent(assignId, "return");
        } else if (pendingReturnId) {
            // This catches the click on the "Return" button INSIDE the pop-up modal where the ID is hidden
            markIntent(pendingReturnId, "return");
            pendingReturnId = null;
        }
    } else if (isSubmit && assignId) {
        markIntent(assignId, "submit");
    }
}, true);


/* ═══════════════════════════════════════════════════════════
   QUEUE LOGIC & SYNC ENGINE
═══════════════════════════════════════════════════════════ */
const PATH     = location.pathname;
const isQueue  = /^\/tasks\/?$/.test(PATH);

if (isQueue) {
  const badge = makeBadge();
  setBadge(badge, "loading", "⏳ Detecting Worker ID…");

  const workerId = await getWorkerId();

  if (!workerId) {
    setBadge(badge, "error", "❌ Worker ID not found");
    showLock("Unknown", "Could not detect Worker ID");
    return;
  }

  setBadge(badge, "loading", "🔐 Verifying Access…");
  let authResult = await authorize(workerId);

  if (!authResult || authResult.denied) {
    setBadge(badge, "denied", "🔒 Access Denied");
    showLock(workerId, authResult?.reason || "not_found");
    return;
  }

  hideLock();
  let { username, teamname } = authResult;
  setBadge(badge, "ok", `✅ ${username} | ${teamname}`);

  // Maps Assignment ID -> Exact Expiration Timestamp (Persists across page loads)
  const knownHits = new Map(JSON.parse(localStorage.getItem("mrp_known_hits") || "[]"));
  let   isSyncing = false;

  // Helper to save memory to the browser
  function saveKnownHits() {
      localStorage.setItem("mrp_known_hits", JSON.stringify([...knownHits]));
  }

  async function syncQueue() {
    if (isSyncing) return;
    isSyncing = true;

    try {
      let hits = await getQueueJSON();
      if (!hits) return; // If JSON fails, do nothing. Avoid DOM fallback which breaks diffing.

      const now  = new Date();
      let currentIds = new Set(hits.map(h => h.assignmentId));

      // SMART DIFFING ENGINE: Sorts vanished HITs perfectly by checking browser memory
      for (let [oldId, expiresAt] of knownHits.entries()) {
          if (!currentIds.has(oldId)) {

              // Look into browser memory to see what the user just clicked
              const intentReturn = localStorage.getItem("intent_return_" + oldId);
              const intentSubmit = localStorage.getItem("intent_submit_" + oldId);

              if (intentReturn) {
                  await fsSet(oldId, { status: "manual_returned", returnedAt: new Date().toISOString(), timeLimitSec: 0 });
                  localStorage.removeItem("intent_return_" + oldId);
              } else if (intentSubmit) {
                  await fsSet(oldId, { status: "submitted", submittedAt: new Date().toISOString(), timeLimitSec: 0 });
                  localStorage.removeItem("intent_submit_" + oldId);
              } else {
                  // No buttons were clicked. Check if the timer naturally hit 0.
                  if (now.getTime() >= expiresAt - 5000) {
                      await fsSet(oldId, { status: "expired", timeLimitSec: 0 });
                  } else {
                      // It vanished magically (likely submitted via an external iframe that we couldn't track)
                      await fsSet(oldId, { status: "submitted", submittedAt: new Date().toISOString(), timeLimitSec: 0 });
                  }
              }
              knownHits.delete(oldId);
              saveKnownHits(); // Save after removing vanished HIT
          }
      }

      setBadge(badge, hits.length > 0 ? "sync" : "ok",
        (hits.length > 0 ? `📡 Syncing ${hits.length} HITs` : "✅ Queue empty") +
        `<br><span style='font-size:10px'>${username}</span>`
      );

      const pushPromises = hits.map(h => {
        const isNew = !knownHits.has(h.assignmentId);
        const expiresMs = now.getTime() + h.timeSecs * 1000;
        
        if (isNew) {
            knownHits.set(h.assignmentId, expiresMs);
            saveKnownHits(); // Save when a new HIT enters the queue
        }

        const payload = {
          workerId, username, teamname,
          requester:    h.requester,
          title:        h.title,
          reward:       h.reward,
          expiresAt:    new Date(expiresMs).toISOString(),
          timeLimitSec: h.timeSecs,
          status:       "active",
          assignmentId: h.assignmentId,
          lastSyncAt:   now.toISOString(),
        };

        if (isNew) payload.acceptedAt = now.toISOString();

        return fsSet(h.assignmentId, payload);
      });

      await Promise.all(pushPromises);

    } catch (e) {
      console.error("Sync error", e);
    } finally {
      isSyncing = false;
      setTimeout(syncQueue, 5000);
    }
  }

  syncQueue();
}

})();
