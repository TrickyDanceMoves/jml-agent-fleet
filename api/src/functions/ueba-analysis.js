'use strict';

/**
 * POST /api/ueba/run
 *
 * Manually triggers a UEBA behavioural analysis over the audit log.
 * Auth: x-api-key header
 *
 * Body (optional):
 * { "windowDays": 7 }   -- days of history to analyse (default from ueba-config.json)
 *
 * Returns 200 with the full JSON report from the PS1 script.
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');
const { requireApiKey } = require('../lib/api-key-auth');

const AGENTS_ROOT = path.resolve(__dirname, '..', '..', '..');
const UEBA_PS     = path.join(AGENTS_ROOT, 'auditor', 'Invoke-UEBAAnalysis.ps1');

app.http('uebaAnalysis', {
  methods: ['POST'],
  route: 'ueba/run',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }

    const args = ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', UEBA_PS];
    if (body.windowDays) {
      const days = parseInt(body.windowDays, 10);
      if (isNaN(days) || days < 1 || days > 365) {
        return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'windowDays must be 1-365' }) };
      }
      args.push('-WindowDays', String(days));
    }

    context.log(`[UEBA] Triggering analysis${body.windowDays ? ` (window: ${body.windowDays}d)` : ''}`);

    const result = spawnSync('powershell.exe', args,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120_000 });

    if (result.status !== 0) {
      context.log(`[UEBA] Script failed (exit ${result.status}): ${result.stderr}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'UEBA analysis failed', exitCode: result.status, details: result.stderr })
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
