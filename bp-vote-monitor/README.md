# BP Vote Monitor (shob account ek page e)

bpworker.com `/vote` page theke proti account er status ek dashboard e dekhay:

- 🟢 **RUNNING**: vote available, koyta vote ase (category wise)
- 🔴 **BLOCKED**: rate limit, live countdown (kokhon unlock hobe)
- 🔵 **UNLOCKED**: block time shesh, abar vote kora jabe
- ⚪ **OFFLINE / LOGGED OUT**: 3 min er beshi report nai, othoba login nai
- 💰 Proti account er **Balance** + shob account er total balance

## Kivabe kaj kore

```
[Account 1 browser + Tampermonkey script] ─┐
[Account 2 browser + Tampermonkey script] ─┼──► server.js (port 3100) ──► Dashboard (http://SERVER:3100)
[Account N browser + Tampermonkey script] ─┘
```

Proti account er browser e script ta protiti 60 second e `/vote` page read kore server e pathay.
Server kono account e login kore na, tai proti account nijer browser/IP thekei check hoy.

## Setup

### 1A. Notun Windows Server (2025) e setup

1. Server e RDP diye dhuko. Edge diye https://nodejs.org theke **LTS** download kore install koro (shob option default rekhe Next, Next).
2. GitHub theke ei branch er **ZIP** download koro, extract koro, `bp-vote-monitor` folder ta `C:\bp-vote-monitor` e rakho.
3. `C:\bp-vote-monitor\install-windows.bat` e **right-click → Run as administrator**. Password chaile dao (shudhu letter/number).
   Eta port 3100 open kore, server chalu kore, ar reboot er por nije nije chalu hoy.
4. VPS company r panel e (Contabo/Vultr/AWS ityadi) firewall thakle sheikhane o **TCP 3100** open koro.
5. Server bondho/remove korte: `uninstall-windows.bat` (Run as administrator).

### 1B. Linux VPS e setup

```bash
cd bp-vote-monitor
node server.js
```

Optional, port / password set korte:

```bash
PORT=3100 SECRET=mypassword node server.js
```

Shob shomoy chalu rakhte (pm2 thakle):

```bash
pm2 start server.js --name bp-vote-monitor
```

Firewall e port **3100** open rakhte hobe.

### 2. Script install (proti account er browser e)

1. Tampermonkey e `BP_Vote_Monitor.user.js` install koro.
2. Server URL default `http://50.117.3.240:3100`. Onno hole Tampermonkey menu → **⚙ Set server URL**.
3. SECRET dile menu → **🔑 Set secret key**.
4. Optional: menu → **✏ Set nickname for this account** (dashboard e ei naam dekhabe).
5. `https://www.bpworker.com/vote` ekta tab e khola rakho. Niche dan kone choto badge e status dekhabe.

### 3. Dashboard

Browser e `http://50.117.3.240:3100` kholo (SECRET thakle `http://50.117.3.240:3100/?key=mypassword` ekbar).

- Upore box e click korle filter hoy (Running / Blocked / Offline)
- Naam e click korle rename kora jay
- **🔔 Alerts** on korle kono account unblock hole sound + notification ashbe
- ✕ diye purano account remove kora jay
