'use strict';

/**
 * GET /api/jml/status/{eventId}
 *
 * Returns the current processing status for a JML lifecycle event.
 *
 * Status values: queued → processing → completed | failed | dead-lettered
 *
 * Auth: x-api-key header
 */

const { app } = require('@azure/functions');
const { requireApiKey } = require('../lib/api-key-auth');
const { getStatus } = require('../lib/status-store');

app.http('statusQuery', {
  methods: ['GET'],
  route: 'jml/status/{eventId}',
  authLevel: 'anonymous',
  handler: async (request, context) => {
    const { authorized } = requireApiKey(request);
    if (!authorized) {
      return { status: 401, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const { eventId } = request.params;
    const record = await getStatus(eventId);

    if (!record) {
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: `Event ${eventId} not found` }) };
    }

    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventId,
        status:        record.status,
        eventType:     record.eventType,
        agent:         record.agent,
        employee:      record.employee,
        effectiveDate: record.effectiveDate,
        ticketRef:     record.ticketRef || null,
        source:        record.source,
        queuedAt:      record.queuedAt,
        startedAt:     record.startedAt  || null,
        completedAt:   record.completedAt || null,
        error:         record.error       || null
      })
    };
  }
});
