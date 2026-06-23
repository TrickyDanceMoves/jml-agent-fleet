'use strict';

/**
 * Monthly certification cron - fires at midnight UTC on the 1st of every month.
 *
 * Invokes certifier/Invoke-CertificationCampaign.ps1 with -CampaignType all,
 * launching both user group and agent PIM access review campaigns in Entra.
 *
 * Schedule: NCRONTAB "0 0 0 1 * *"  (second minute hour day month weekday)
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');

const AGENTS_ROOT  = path.resolve(__dirname, '..', '..', '..');
const CERTIFIER_PS = path.join(AGENTS_ROOT, 'certifier', 'Invoke-CertificationCampaign.ps1');

app.timer('certificationCron', {
  schedule: '0 0 0 1 * *',
  handler: (myTimer, context) => {
    const runDate = new Date().toISOString();
    context.log(`[Certifier-Cron] Monthly certification triggered at ${runDate}`);

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CERTIFIER_PS, '-CampaignType', 'all'],
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 120_000 }
    );

    if (result.status !== 0) {
      context.log(`[Certifier-Cron] ERROR exit=${result.status}: ${result.stderr}`);
    } else {
      context.log('[Certifier-Cron] Certification campaigns launched successfully');
      if (result.stdout) context.log(result.stdout);
    }
  }
});
