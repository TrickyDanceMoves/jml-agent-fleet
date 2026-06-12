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
const { createMessageHandler } = require('./message-handler');

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

const { processMessage } = createMessageHandler({
  queueClient,
  tableClient,
  dispatch,
  maxRetries: MAX_RETRIES
});

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
