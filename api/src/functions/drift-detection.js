'use strict';

/**
 * POST /api/drift/run
 *
 * Manually triggers a drift detection scan. Auth: x-api-key header.
 *
 * Body (optional):
 * { "checks": "all" }           -- run all checks (default)
 * { "checks": "pim-group-drift,agent-role-drift" }  -- subset
 *
 * Returns 200 with the full JSON report from the PS1 script.
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');
const { requireApiKey } = require('../lib/api-key-auth');

const AGENTS_ROOT = path.resolve(__dirname, '..', '..', '..');
const DRIFT_PS    = path.join(AGENTS_ROOT, 'auditor', 'Invoke-DriftDetection.ps1');

const VALID_CHECKS = new Set([
  'all', 'disabled-licensed', 'pim-group-drift',
  'agent-role-drift', 'stale-accounts', 'orphaned-disabled'
]);

app.http('driftDetection', {
  methods: ['POST'],
  route: 'drift/run',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }

    const checks = body.checks || 'all';
    for (const c of checks.split(',').map(s => s.trim())) {
      if (!VALID_CHECKS.has(c)) {
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: `Unknown check: "${c}". Valid: ${[...VALID_CHECKS].join(', ')}` })
        };
      }
    }

    context.log(`[Drift] Running checks: ${checks}`);

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DRIFT_PS, '-Checks', checks],
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 180_000 }
    );

    if (result.status !== 0) {
      context.log(`[Drift] Script failed (exit ${result.status}): ${result.stderr}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Drift detection failed', exitCode: result.status, details: result.stderr })
      };
    }

    // Extract the JSON report from stdout (last JSON object in output)
    let report = null;
    const jsonMatch = result.stdout.match(/(\{[\s\S]*\})\s*$/);
    if (jsonMatch) {
      try { report = JSON.parse(jsonMatch[1]); } catch { /* fall through */ }
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report ?? { raw: result.stdout })
    };
  }
});
