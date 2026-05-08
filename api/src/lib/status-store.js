'use strict';

const { TableClient } = require('@azure/data-tables');

const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
const tableName = process.env.JML_STATUS_TABLE || 'jmlstatus';

let _client = null;

function getClient() {
  if (!_client) {
    _client = TableClient.fromConnectionString(connStr, tableName);
  }
  return _client;
}

async function ensureTable() {
  try {
    await getClient().createTable();
  } catch (e) {
    if (e.statusCode !== 409) throw e; // 409 = already exists, safe to ignore
  }
}

async function setStatus(eventId, status, details = {}) {
  await ensureTable();
  await getClient().upsertEntity(
    { partitionKey: 'jml', rowKey: eventId, status, updatedAt: new Date().toISOString(), ...details },
    'Replace'
  );
}

async function getStatus(eventId) {
  await ensureTable();
  try {
    return await getClient().getEntity('jml', eventId);
  } catch (e) {
    if (e.statusCode === 404) return null;
    throw e;
  }
}

module.exports = { setStatus, getStatus };
