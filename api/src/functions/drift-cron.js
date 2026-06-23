'use strict';

/**
 * Weekly drift detection cron - fires at 06:00 UTC every Monday.
 *
 * Runs all drift checks and logs the summary. Critical findings trigger
 * a Teams notification if shared/notifications.json is configured.
 *
 * Schedule: NCRONTAB "0 0 6 * * 1"  (second minute hour day month weekday)
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');

const AGENTS_ROOT = path.resolve(__dirname, '..', '..', '..');
const DRIFT_PS    = path.join(AGENTS_ROOT, 'auditor', 'Invoke-DriftDetection.ps1');

app.timer('driftCron', {
  schedule: '0 0 6 * * 1',
  handler: (myTimer, context) => {
    context.log(`[Drift-Cron] Weekly scan triggered at ${new Date().toISOString()}`);

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DRIFT_PS, '-Checks', 'all'],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 180_000 }
    );

    if (result.status !== 0) {
      context.log(`[Drift-Cron] ERROR exit=${result.status}: ${result.stderr}`);
      return;
    }

    // Log summary line
    const summaryMatch = result.stdout.match(/\[Drift\] Summary: (.+)/);
    if (summaryMatch) context.log(`[Drift-Cron] ${summaryMatch[1]}`);

    // Parse report for structured logging
    const jsonMatch = result.stdout.match(/(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try {
        const report = JSON.parse(jsonMatch[1]);
        context.log(`[Drift-Cron] runId=${report.runId} critical=${report.summary?.critical} warning=${report.summary?.warning} info=${report.summary?.info}`);
      } catch { /* non-fatal */ }
    }
  }
});
