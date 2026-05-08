'use strict';

/**
 * POST /api/identity-protection/run
 *
 * Manually triggers an Identity Protection risky user scan.
 * Auth: x-api-key header
 *
 * Returns 200 with the full JSON report from the PS1 script.
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');
const { requireApiKey } = require('../lib/api-key-auth');

const AGENTS_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_PS     = path.join(AGENTS_ROOT, 'auditor', 'Invoke-RiskyUserScan.ps1');

app.http('riskyUserScan', {
  methods: ['POST'],
  route: 'identity-protection/run',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    context.log('[RiskyUserScan] Triggering Identity Protection scan');

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCAN_PS],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 }
    );

    if (result.status !== 0) {
      context.log(`[RiskyUserScan] Script failed (exit ${result.status}): ${result.stderr}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Risky user scan failed', exitCode: result.status, details: result.stderr })
      };
    }

    let report = null;
    const jsonMatch = result.stdout.match(/(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try { report = JSON.parse(jsonMatch[1]); } catch { /* non-fatal */ }
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report ?? { raw: result.stdout })
    };
  }
});
