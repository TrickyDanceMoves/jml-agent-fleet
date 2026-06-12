'use strict';

/**
 * Queue message processing, factored out of worker.js so it can be unit
 * tested with injected queue/table clients and a stub dispatch.
 */

function createMessageHandler({ queueClient, tableClient, dispatch, maxRetries = 3, log = console }) {
  async function updateStatus(eventId, status, extra = {}) {
    try {
      await tableClient.upsertEntity(
        { partitionKey: 'jml', rowKey: eventId, status, updatedAt: new Date().toISOString(), ...extra },
        'Merge'
      );
    } catch (e) {
      log.error(`[WORKER] Status update failed for ${eventId}: ${e.message}`);
    }
  }

  async function processMessage(msg) {
    let event;
    try {
      const json = Buffer.from(msg.messageText, 'base64').toString('utf8');
      event = JSON.parse(json);
    } catch (e) {
      log.error(`[WORKER] Unparseable message ${msg.messageId} — discarding: ${e.message}`);
      await queueClient.deleteMessage(msg.messageId, msg.popReceipt);
      return;
    }

    const { eventId, eventType } = event;
    const label = `${eventType} ${eventId} [${event.employee?.email}]`;

    if (msg.dequeueCount > maxRetries) {
      log.error(`[WORKER] ${label} exceeded ${maxRetries} retries — dead-lettering`);
      await updateStatus(eventId, 'dead-lettered', { error: `Exceeded ${maxRetries} retries` });
      await queueClient.deleteMessage(msg.messageId, msg.popReceipt);
      return;
    }

    log.log(`[WORKER] Processing ${label} (attempt ${msg.dequeueCount})`);
    await updateStatus(eventId, 'processing', { startedAt: new Date().toISOString() });

    let result;
    try {
      result = dispatch(event);
    } catch (e) {
      log.error(`[WORKER] Dispatch threw for ${label}: ${e.message}`);
      await updateStatus(eventId, 'failed', { error: e.message });
      return; // leave in queue — visibility timeout will re-expose it for retry
    }

    if (result.exitCode === 0) {
      log.log(`[WORKER] ${label} — completed (exit 0)`);
      await updateStatus(eventId, 'completed', { completedAt: new Date().toISOString(), exitCode: 0 });
      await queueClient.deleteMessage(msg.messageId, msg.popReceipt);
    } else {
      const errSnippet = (result.stderr || result.stdout).slice(-800);
      log.error(`[WORKER] ${label} — failed (exit ${result.exitCode})\n${errSnippet}`);
      await updateStatus(eventId, 'failed', { error: `Exit ${result.exitCode}`, stderr: errSnippet });
      // Leave in queue for retry up to maxRetries
    }
  }

  return { processMessage, updateStatus };
}

module.exports = { createMessageHandler };
