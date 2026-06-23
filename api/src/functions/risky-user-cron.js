'use strict';

/**
 * Identity Protection risky user scan cron - fires every 6 hours.
 *
 * Polls Entra ID Identity Protection for at-risk and confirmed-compromised
 * accounts. Critical findings trigger a Teams notification if configured.
 *
 * Schedule: NCRONTAB "0 0 0/6 * * *"  (second minute hour day month weekday)
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');

const AGENTS_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_PS     = path.join(AGENTS_ROOT, 'auditor', 'Invoke-RiskyUserScan.ps1');

app.timer('riskyUserCron', {
  schedule: '0 0 0/6 * * *',
  handler: (myTimer, context) => {
    context.log(`[RiskyUser-Cron] Identity Protection scan triggered at ${new Date().toISOString()}`);

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCAN_PS],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }
    );

    if (result.status !== 0) {
      context.log(`[RiskyUser-Cron] ERROR exit=${result.status}: ${result.stderr}`);
      return;
    }

    const jsonMatch = result.stdout.match(/(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try {
        const report = JSON.parse(jsonMatch[1]);
        context.log(`[RiskyUser-Cron] runId=${report.runId} riskyUsers=${report.summary?.riskyUsersFound} critical=${report.summary?.critical} warning=${report.summary?.warning}`);
      } catch { /* non-fatal */ }
    }
  }
});
