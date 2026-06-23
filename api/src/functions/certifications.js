'use strict';

/**
 * POST /api/certifications/start
 *
 * Manually triggers an Entra ID Governance access review campaign.
 * Auth: x-api-key header
 *
 * Body (optional, defaults to "all"):
 * { "campaignType": "all" | "user-groups" | "agent-pim" }
 *
 * Returns 200 with the list of created review definitions, or 500 on failure.
 * Returns immediately - review definitions are created synchronously but the
 * reviews themselves run for the configured durationDays in Entra.
 */

const path = require('path');
const { app } = require('@azure/functions');
const { spawnSync } = require('child_process');
const { requireApiKey } = require('../lib/api-key-auth');

const AGENTS_ROOT  = path.resolve(__dirname, '..', '..', '..');
const CERTIFIER_PS = path.join(AGENTS_ROOT, 'certifier', 'Invoke-CertificationCampaign.ps1');
const VALID_TYPES  = new Set(['all', 'user-groups', 'agent-pim']);

app.http('certifications', {
  methods: ['POST'],
  route: 'certifications/start',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body = {};
    try { body = await request.json(); } catch { /* empty body is fine */ }

    const campaignType = body.campaignType || 'all';
    if (!VALID_TYPES.has(campaignType)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: `Invalid campaignType. Must be one of: ${[...VALID_TYPES].join(', ')}` })
      };
    }

    context.log(`[Certifier] Launching campaign type: ${campaignType}`);

    const result = spawnSync(
      'powershell.exe',
      ['-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CERTIFIER_PS, '-CampaignType', campaignType],
      { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 120_000 }
    );

    if (result.status !== 0) {
      context.log(`[Certifier] Script failed (exit ${result.status}): ${result.stderr}`);
      return {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Certification campaign failed', exitCode: result.status, details: result.stderr })
      };
    }

    // Parse the JSON array emitted by the PS1 script at the end of stdout
    let campaigns = [];
    const jsonMatch = result.stdout.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try { campaigns = JSON.parse(jsonMatch[0]); } catch { /* output is informational only */ }
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'started', campaignType, campaigns })
    };
  }
});
