#!/usr/bin/env node
// Usage: node .claude/skills/run-jml-console/driver.mjs [tab-name]
import { execSync }                  from 'child_process';
import { join, dirname }             from 'path';
import { fileURLToPath }             from 'url';
import { existsSync, mkdirSync }     from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR   = join(__dirname, '..', '..', '..'); // agents/electron-app/
const OUT_DIR   = join(APP_DIR, '..', 'docs', 'images'); // agents/docs/images/
const TABS      = [
  'operator-select', 'jml-fleet-input', 'dashboard', 'glass-screen', 'approver',
  'auditor', 'security', 'exports', 'approvals', 'operations', 'certifications',
  'settings', 'audit-log', 'users', 'integrations', 'certs', 'graph'
];

const tab = process.argv[2] || 'dashboard';

if (!TABS.includes(tab)) {
  console.error(`Unknown tab '${tab}'. Valid tabs:\n  ${TABS.join(', ')}`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

console.log(`Launching JML Console capture (all tabs, ~30s)...`);
execSync('npm run capture', { cwd: APP_DIR, stdio: 'inherit' });

const png = join(OUT_DIR, `${tab}.png`);
if (existsSync(png)) {
  console.log(`\nScreenshot saved: ${png}`);
} else {
  console.error(`\nCapture completed but '${tab}.png' not found in ${OUT_DIR}`);
  process.exit(1);
}
