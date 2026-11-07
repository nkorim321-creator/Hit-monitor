// Change a team (or ALL = admin) password.
// Usage:  node set-password.js "SUJON" "NewPassword123"
//         node set-password.js ALL "AdminPassword"
// Then restart the server (run install-windows.bat again on Windows).
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILE = path.join(__dirname, 'passwords.json');
const [team, pw] = process.argv.slice(2);
if (!team || !pw) { console.log('Usage: node set-password.js "TEAM NAME" "password"   (TEAM = ALL for admin)'); process.exit(1); }
let data = {};
try { data = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
const key = team.trim().toUpperCase() === 'ALL' ? 'ALL' : team.trim();
data[key] = { salt, hash };
fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
console.log(`Password set for "${key}".`);
