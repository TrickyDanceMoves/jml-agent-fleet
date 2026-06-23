'use strict';

/**
 * Daily UEBA cron - fires at 07:00 UTC every day.
 *
 * Analyses the past 7 days of audit log behaviour. Critical findings
 * trigger a Teams notification if shared/notifications.json is configured.
 *
 * Schedule: NCRONTAB "0 0 7 * * *"  (second minute hour day month weekday)
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');

const AGENTS_ROOT = path.resolve(__dirname, '..', '..', '..');
const UEBA_PS     = path.join(AGENTS_ROOT, 'auditor', 'Invoke-UEBAAnalysis.ps1');

app.timer('uebaCron', {
  schedule: '0 0 7 * * *',
  handler: (myTimer, context) => {
    context.log(`[UEBA-Cron] Daily analysis triggered at ${new Date().toISOString()}`);

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UEBA_PS],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }
    );

    if (result.status !== 0) {
      context.log(`[UEBA-Cron] ERROR exit=${result.status}: ${result.stderr}`);
      return;
    }

    const summaryMatch = result.stdout.match(/\[UEBA\] Summary: (.+)/);
    if (summaryMatch) context.log(`[UEBA-Cron] ${summaryMatch[1]}`);

    const jsonMatch = result.stdout.match(/(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try {
        const report = JSON.parse(jsonMatch[1]);
        context.log(`[UEBA-Cron] runId=${report.runId} entries=${report.entriesAnalyzed} critical=${report.summary?.critical} warning=${report.summary?.warning}`);
      } catch { /* non-fatal */ }
    }
  }
});
