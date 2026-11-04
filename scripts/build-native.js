'use strict';
// Builds native/WasapiCapture.exe with the C# compiler that ships with Windows (.NET Framework 4, no SDK needed).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.platform !== 'win32') { console.log('Native capture is Windows-only; skipped.'); process.exit(0); }
const root = path.resolve(__dirname, '..');
const csc = path.join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) { console.error(`csc.exe not found: ${csc}`); process.exit(1); }
const out = path.join(root, 'native', 'WasapiCapture.exe');
execFileSync(csc, ['/nologo', '/optimize+', '/unsafe', '/platform:x64', '/target:exe', `/out:${out}`, path.join(root, 'native', 'WasapiCapture.cs')], { stdio: 'inherit' });
console.log(`Built ${out} (${fs.statSync(out).size} bytes)`);
