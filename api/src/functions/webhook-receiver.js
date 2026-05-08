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
 * Auth: x-api-key header (same key as /api/jml)
 * Note: BambooHR webhook HMAC signature verification can be added here once
 *       the signing secret is available from BambooHR webhook settings.
 */

const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const { requireApiKey } = require('../lib/api-key-auth');
const { validateEvent } = require('../lib/event-validator');
const { enqueue } = require('../lib/queue-client');
const { setStatus } = require('../lib/status-store');
const { routeEvent } = require('../lib/event-router');
const bamboohrAdapter = require('../adapters/bamboohr');

const ADAPTERS = {
  bamboohr: bamboohrAdapter.adaptWebhook,
  // workday: workdayAdapter.adaptWebhook,
};

app.http('webhookReceiver', {
  methods: ['POST'],
  route: 'webhooks/{source}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const source = request.params.source;

    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const adapter = ADAPTERS[source];
    if (!adapter) {
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `No adapter registered for source: ${source}` }) };
    }

    let rawBody;
    try {
      rawBody = await request.json();
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
