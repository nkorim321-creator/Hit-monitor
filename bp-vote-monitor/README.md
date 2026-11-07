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
3. `C:\bp-vote-monitor\install-windows.bat` e **right-click → Run as administrator**. Prothom bar **Admin password** chaibe (ALL ID er password). Dashboard er password dao (shudhu letter/number).
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
4. Optional: menu → **✏ Set nickname for this account** (dashboard e ei naam dekhabe).
5. `https://www.bpworker.com/vote` ekta tab e khola rakho. Niche dan kone choto badge e status dekhabe.

### 3. Dashboard

Browser e `http://50.117.3.240:3100` kholo.

- Upore **team button** (Google Sheet theke ashe): NOUSHAD, SUJON, Hirexology, Bhiya Self, ar **ALL ID** (shudhu admin).
- Team e click korle oi team er password chay. Ekbar dile oi browser e ar chay na (**🔒 Logout** dile abar chaibe).
- Protiti team shudhu nijer password diye khule, baki team lock e thake. Admin password shudhu **ALL ID** khule (sheikhane shob team er ID ekshathe).
- **▾ IDs** button diye serial number gula lukano / dekhano jay. Serial number (1, 2, 3 ...) e click korle shudhu oi ID dekhay. Number er rong: sobuj = Running, lal = Blocked, dhushor = Offline/No data.
- Card e: **ID-number, Mail, Worker ID, BP Year** (sheet theke), ar status, unlock countdown, balance.
- **🔔 Alerts** on korle kono ID unblock hole sound + notification ashbe.
- **💰 Earnings**: Today / Yesterday / Last 7 days / This month / Last 30 days / Custom date. Team er total, din onujayi bar, ar protiti ID card e oi shomoyer earning.
  Script er report e balance barle earning dhora hoy. Collect/payout e balance komle earning theke bad jay na. Earning tracking shuru hoy server update er por theke, ager earning jana nai.

### Team password set / change

**ALL ID** e admin password diye dhuko → **🔑 Passwords** button → team er pashe notun password likhe **Save**.
Notun team sheet e add korle oi team o ei list e chole ashbe. Password shudhu server er `passwords.json` e hash kore thake, git e jay na.

### Google Sheet

Server protiti 1 minute e sheet ta pore (`server.js` e `SHEET_ID`). Column: **Serial, BP Year, Mail, Worker ID, Team name**.
Sheet ta "Anyone with the link can view" share thakte hobe. Notun ID / team sheet e add korlei dashboard e chole ashbe.
Script er pathano mail ar sheet er **Mail** mil kore ID chena hoy.
