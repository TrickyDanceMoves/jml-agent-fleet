'use strict';

/**
 * POST /api/jml
 *
 * Accepts a canonical HR lifecycle event, validates it, and enqueues it for
 * processing by the local worker. Returns 202 with an eventId for status polling.
 *
 * Auth: x-api-key header
 *
 * Example body (hire):
 * {
 *   "eventType": "hire",
 *   "effectiveDate": "2026-05-20",
 *   "employee": {
 *     "firstName": "Jane", "lastName": "Doe",
 *     "email": "jane.doe@contoso.com",
 *     "department": "Engineering", "jobTitle": "Senior Engineer",
 *     "usageLocation": "US", "manager": "boss@contoso.com",
 *     "licenses": ["Microsoft_Entra_Suite"]
 *   }
 * }
 */

const { app } = require('@azure/functions');
const { v4: uuidv4 } = require('uuid');
const { requireApiKey } = require('../lib/api-key-auth');
const { validateEvent } = require('../lib/event-validator');
const { enqueue } = require('../lib/queue-client');
const { setStatus } = require('../lib/status-store');
const { routeEvent } = require('../lib/event-router');

app.http('jmlEvents', {
  methods: ['POST'],
  route: 'jml',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    if (!body.eventId) body.eventId = uuidv4();
    if (!body.source) body.source = 'api';

    const { valid, errors } = validateEvent(body);
    if (!valid) {
      return { status: 422, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Validation failed', details: errors }) };
    }

    let agent;
    try {
      agent = routeEvent(body);
    } catch (e) {
      return { status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: e.message }) };
    }

    await enqueue(body);
    await setStatus(body.eventId, 'queued', {
      eventType:     body.eventType,
      agent,
      employee:      body.employee.email,
      effectiveDate: body.effectiveDate,
      ticketRef:     body.ticketRef || null,
      source:        body.source,
      queuedAt:      new Date().toISOString()
    });

    context.log(`Queued ${body.eventType} event ${body.eventId} → ${agent} agent [${body.employee.email}]`);

    return {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId:   body.eventId,
        status:    'queued',
        agent,
        statusUrl: `/api/jml/status/${body.eventId}`
      })
    };
  }
});
