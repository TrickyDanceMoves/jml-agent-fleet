'use strict';

/**
 * JML Queue Worker
 *
 * Polls Azure Storage Queue for HR lifecycle events and invokes the corresponding
 * PS1 agent (Joiner, Mover, or Leaver). Writes status updates to Azure Table Storage
 * so the API's GET /api/jml/status/{eventId} endpoint stays current.
 *
 * Run: node src/worker.js
 * Config: worker.config.json (copy from worker.config.json.example)
 */

const path = require('path');
const fs = require('fs');
const { QueueServiceClient } = require('@azure/storage-queue');
const { TableClient } = require('@azure/data-tables');
const { dispatch } = require('./agent-dispatcher');

const CONFIG_PATH = path.join(__dirname, '..', 'worker.config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('[WORKER] worker.config.json not found. Copy worker.config.json.example and fill in values.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const POLL_INTERVAL_MS    = config.pollIntervalMs    || 5000;
const VISIBILITY_TIMEOUT  = config.visibilityTimeoutSec || 300;
const MAX_RETRIES         = config.maxRetries         || 3;

const queueClient = QueueServiceClient
  .fromConnectionString(config.storageConnectionString)
  .getQueueClient(config.queueName || 'jml-events');

const tableClient = TableClient.fromConnectionString(
  config.storageConnectionString,
  config.statusTable || 'jmlstatus'
);

async function updateStatus(eventId, status, extra = {}) {
  try {
    await tableClient.upsertEntity(
      { partitionKey: 'jml', rowKey: eventId, status, updatedAt: new Date().toISOString(), ...extra },
      'Merge'
    );
  } catch (e) {
    console.error(`[WORKER] Status update failed for ${eventId}: ${e.message}`);
  }
}

async function processMessage(msg) {
  let event;
  try {
    const json = Buffer.from(msg.messageText, 'base64').toString('utf8');
    event = JSON.parse(json);
  } catch (e) {
    console.error(`[WORKER] Unparseable message ${msg.messageId} — discarding: ${e.message}`);
    await queueClient.deleteMessage(msg.messageId, msg.popReceipt);
    return;
  }

  const { eventId, eventType } = event;
  const label = `${eventType} ${eventId} [${event.employee?.email}]`;

  if (msg.dequeueCount > MAX_RETRIES) {
    console.error(`[WORKER] ${label} exceeded ${MAX_RETRIES} retries — dead-lettering`);
    await updateStatus(eventId, 'dead-lettered', { error: `Exceeded ${MAX_RETRIES} retries` });
    await queueClient.deleteMessage(msg.messageId, msg.popReceipt);
    return;
  }

  console.log(`[WORKER] Processing ${label} (attempt ${msg.dequeueCount})`);
  await updateStatus(eventId, 'processing', { startedAt: new Date().toISOString() });

  let result;
  try {
    result = dispatch(event);
  } catch (e) {
    console.error(`[WORKER] Dispatch threw for ${label}: ${e.message}`);
    await updateStatus(eventId, 'failed', { error: e.message });
    return; // leave in queue — visibility timeout will re-expose it for retry
  }

  if (result.exitCode === 0) {
    console.log(`[WORKER] ${label} — completed (exit 0)`);
    await updateStatus(eventId, 'completed', { completedAt: new Date().toISOString(), exitCode: 0 });
    await queueClient.deleteMessage(msg.messageId, msg.popReceipt);
  } else {
    const errSnippet = (result.stderr || result.stdout).slice(-800);
    console.error(`[WORKER] ${label} — failed (exit ${result.exitCode})\n${errSnippet}`);
    await updateStatus(eventId, 'failed', { error: `Exit ${result.exitCode}`, stderr: errSnippet });
    // Leave in queue for retry up to MAX_RETRIES
  }
}

async function poll() {
  try {
    const response = await queueClient.receiveMessages({
      numberOfMessages:  5,
      visibilityTimeout: VISIBILITY_TIMEOUT
    });
    for (const msg of response.receivedMessageItems) {
      await processMessage(msg);
    }
  } catch (e) {
    console.error(`[WORKER] Poll error: ${e.message}`);
  }
}

async function run() {
  console.log('[WORKER] JML Queue Worker starting...');
  console.log(`[WORKER] Queue : ${config.queueName || 'jml-events'}`);
  console.log(`[WORKER] Poll  : every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[WORKER] Retry : up to ${MAX_RETRIES} attempts`);

  await queueClient.createIfNotExists();
  try {
    await tableClient.createTable();
  } catch (e) {
    if (e.statusCode !== 409) throw e;
  }

  console.log('[WORKER] Ready.\n');

  while (true) {
    await poll();
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

run().catch(e => {
  console.error('[WORKER] Fatal:', e.message);
  process.exit(1);
});
