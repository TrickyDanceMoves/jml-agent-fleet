'use strict';

// Locks the Electron renderer-hardening posture. The app is a local file:// SPA
// with a privileged preload; these controls keep a compromised/injected renderer
// from escaping to a remote origin, spawning windows, embedding webviews, or
// gaining device permissions.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const HTML = ['index', 'docked', 'overlay', 'palette', 'setup', 'operator-select']
  .map((n) => [n, fs.readFileSync(path.join(root, 'renderer', n + '.html'), 'utf8')]);

test('every BrowserWindow runs sandboxed, context-isolated, no nodeIntegration', () => {
  // No window may turn on nodeIntegration or turn off the safe defaults.
  assert.doesNotMatch(main, /nodeIntegration:\s*true/);
  assert.doesNotMatch(main, /contextIsolation:\s*false/);
  assert.doesNotMatch(main, /sandbox:\s*false/);
  assert.doesNotMatch(main, /webSecurity:\s*false/);
  assert.doesNotMatch(main, /allowRunningInsecureContent:\s*true/);
});

test('global web-contents guard: deny popups, webviews, and remote navigation', () => {
  assert.match(main, /app\.on\('web-contents-created'/);
  assert.match(main, /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/);
  assert.match(main, /on\('will-navigate'/);
  assert.match(main, /on\('will-redirect'/);
  assert.match(main, /on\('will-attach-webview',\s*\(event\)\s*=>\s*event\.preventDefault\(\)\)/);
  assert.match(main, /function _navAllowed\(targetUrl\)/);
  // Only file:// and Microsoft sign-in hosts may be navigated to.
  assert.match(main, /u\.protocol === 'file:'/);
  assert.match(main, /login\.microsoftonline\.com/);
});

test('IPC is gated by a trusted-sender check on every channel', () => {
  assert.match(main, /function _isTrustedSender\(event\)/);
  assert.match(main, /new URL\(u\)\.protocol === 'file:'/, 'only file:// renderer frames are trusted');
  // ipcMain.handle and ipcMain.on are wrapped so the gate applies uniformly.
  assert.match(main, /ipcMain\.handle = \(channel, listener\) =>/);
  assert.match(main, /ipcMain\.on = \(channel, listener\) =>/);
  assert.match(main, /_isTrustedSender\(event\)/);
});

test('high-privilege IPC channels validate their payload schema', () => {
  assert.match(main, /function _validatePayload\(schema, payload\)/);
  assert.match(main, /const IPC_SCHEMAS = \{/);
  for (const ch of ['run-quick-leaver', 'run-quick-joiner', 'run-quick-mover', 'device-action',
                    'quarantine-agent', 'activate-pim-role', 'create-agent-app-registrations',
                    'save-operators', 'save-policy', 'save-tenant-config']) {
    assert.match(main, new RegExp("'" + ch + "':\\s*\\{"), `schema missing for ${ch}`);
  }
  // The validator is wired into the IPC wrappers.
  assert.match(main, /const schema = IPC_SCHEMAS\[channel\]/);
  assert.match(main, /_validatePayload\(schema, args\[0\]\)/);
});

test('permissions are denied by default', () => {
  assert.match(main, /setPermissionRequestHandler\(\(_wc, _perm, cb\)\s*=>\s*cb\(false\)\)/);
  assert.match(main, /setPermissionCheckHandler\(\(\)\s*=>\s*false\)/);
});

test('external links are https + host-allowlisted before opening', () => {
  assert.match(main, /ipcMain\.handle\('open-external'/);
  assert.match(main, /protocol !== 'https:'/);
  assert.match(main, /ALLOWED_EXTERNAL_HOSTS\.some\(h => hostname === h \|\| hostname\.endsWith\('\.' \+ h\)\)/);
});

test('every renderer page ships a CSP with the key restrictive directives', () => {
  for (const [name, html] of HTML) {
    const m = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    assert.ok(m, `${name}.html must carry a CSP meta`);
    const csp = m[1];
    assert.match(csp, /default-src 'self'/, `${name}: default-src self`);
    assert.match(csp, /object-src 'none'/, `${name}: object-src none`);
    assert.match(csp, /base-uri 'self'/, `${name}: base-uri self`);
    assert.match(csp, /frame-ancestors 'none'/, `${name}: frame-ancestors none`);
    assert.ok(!/script-src[^;]*\bhttp/.test(csp), `${name}: no remote script-src`);
    // No page allows inline scripts - all logic is in external files.
    assert.match(csp, /script-src 'self'/, `${name}: script-src self`);
    assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), `${name}: no unsafe-inline scripts`);
  }
});

test('no renderer page carries an inline <script> body (all logic is external)', () => {
  for (const [name, html] of HTML) {
    assert.ok(!/<script>[\s\S]*?<\/script>/.test(html), `${name}: inline <script> body found`);
  }
});
