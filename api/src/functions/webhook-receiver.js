'use strict';

/**
 * POST /api/webhooks/{source}
 *
 * Receives inbound webhooks from HR systems, adapts them to the canonical HR
 * event schema, and enqueues them for processing.
 *
 * Supported sources: bamboohr
 * Future sources:    workday, successfactors
 *
 * Auth: BambooHR webhooks are verified via HMAC-SHA256 signature in the
 *       x-bamboohr-signature header. Set BAMBOOHR_WEBHOOK_SECRET in env.
 *       Falls back to x-api-key header auth if secret is not configured.
 */

const { app }    = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const crypto     = require('crypto');
const { requireApiKey } = require('../lib/api-key-auth');
const { validateEvent } = require('../lib/event-validator');
const { enqueue } = require('../lib/queue-client');
const { setStatus } = require('../lib/status-store');
const { routeEvent } = require('../lib/event-router');
const bamboohrAdapter = require('../adapters/bamboohr');

const ADAPTERS = {
  bamboohr: bamboohrAdapter.adaptWebhook,
};

// Verify BambooHR HMAC-SHA256 signature.
// BambooHR sends: X-BambooHR-Signature: t=<timestamp>,v1=<hex_sig>
// Signed payload: <timestamp>.<raw_body>
function verifyBambooHrSignature(rawBodyText, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const parts = {};
  signatureHeader.split(',').forEach(part => {
    const [k, v] = part.split('=');
    parts[k] = v;
  });
  if (!parts.t || !parts.v1) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${rawBodyText}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
}

app.http('webhookReceiver', {
  methods: ['POST'],
  route: 'webhooks/{source}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const source = request.params.source;

    // Read raw body text first (needed for HMAC verification before JSON.parse)
    const rawBodyText = await request.text();

    // Source-specific auth
    if (source === 'bamboohr') {
      const secret   = process.env.BAMBOOHR_WEBHOOK_SECRET;
      const sigHeader = request.headers.get('x-bamboohr-signature');
      if (secret) {
        if (!sigHeader || !verifyBambooHrSignature(rawBodyText, sigHeader, secret)) {
          context.log.warn('BambooHR HMAC signature verification failed');
          return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid webhook signature' }) };
        }
      } else {
        // No HMAC secret configured — fall back to x-api-key header
        const { authorized } = requireApiKey(request);
        if (!authorized) {
          return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
        }
      }
    } else {
      const { authorized } = requireApiKey(request);
      if (!authorized) {
        return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
      }
    }

    const adapter = ADAPTERS[source];
    if (!adapter) {
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `No adapter registered for source: ${source}` }) };
    }

    let rawBody;
    try {
      rawBody = JSON.parse(rawBodyText);
    } catch {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    let events;
    try {
      events = adapter(rawBody);
    } catch (e) {
      context.log.error(`Adapter error for ${source}: ${e.message}`);
      return { status: 422, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Adapter error: ${e.message}` }) };
    }

    const results = [];

    for (const event of events) {
      if (!event.eventId) event.eventId = uuidv4();

      const { valid, errors } = validateEvent(event);
      if (!valid) {
        context.log.warn(`Skipping invalid ${source} event for ${event.employee?.email}: ${errors.join(', ')}`);
        results.push({ eventId: event.eventId, status: 'rejected', errors });
        continue;
      }

      const agent = routeEvent(event);
      await enqueue(event);
      await setStatus(event.eventId, 'queued', {
        eventType:     event.eventType,
        agent,
        employee:      event.employee.email,
        effectiveDate: event.effectiveDate,
        ticketRef:     event.ticketRef || null,
        source,
        queuedAt:      new Date().toISOString()
      });

      context.log(`Queued ${event.eventType} event ${event.eventId} from ${source} → ${agent} [${event.employee.email}]`);
      results.push({
        eventId:   event.eventId,
        status:    'queued',
        agent,
        statusUrl: `/api/jml/status/${event.eventId}`
      });
    }

    return {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ processed: results.length, results })
    };
  }
});
