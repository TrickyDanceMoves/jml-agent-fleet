'use strict';

const { QueueServiceClient } = require('@azure/storage-queue');

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const queueName = process.env.JML_QUEUE_NAME || 'jml-events';

let _client = null;

function getQueueClient() {
  if (!_client) {
    const svc = QueueServiceClient.fromConnectionString(connStr);
    _client = svc.getQueueClient(queueName);
  }
  return _client;
}

async function enqueue(event) {
  const client = getQueueClient();
  await client.createIfNotExists();
  // Azure Storage Queue requires base64-encoded messages
  const msg = Buffer.from(JSON.stringify(event)).toString('base64');
  const result = await client.sendMessage(msg);
  return result.messageId;
}

module.exports = { enqueue };
