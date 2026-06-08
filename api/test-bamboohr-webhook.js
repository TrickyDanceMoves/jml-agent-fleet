#!/usr/bin/env node
'use strict';

/**
 * Fire a mock BambooHR webhook to the local Azure Functions endpoint.
 *
 * Usage:
 *   node test-bamboohr-webhook.js hire    "Alex Rivera" alex.rivera@contoso.onmicrosoft.com "Engineering" "Software Engineer"
 *   node test-bamboohr-webhook.js term    robert.martinez@contoso.onmicrosoft.com INC-1020
 *   node test-bamboohr-webhook.js transfer sarah.chen@contoso.onmicrosoft.com "Platform Engineering" "Senior Engineer"
 */

const https = require('https');
const http  = require('http');
const crypto = require('crypto');

const ENDPOINT = process.env.WEBHOOK_URL || 'http://localhost:7071/api/webhooks/bamboohr';
const API_KEY  = process.env.JML_API_KEY  || 'dev-local-key-changeme';
const HMAC_SECRET = process.env.BAMBOOHR_WEBHOOK_SECRET || '';

const [,, eventType, ...args] = process.argv;

function buildPayload(type, args) {
  const now = new Date().toISOString().slice(0, 10);

  if (type === 'hire') {
    const [fullName, email, department, jobTitle] = args;
    const [firstName, ...rest] = (fullName || 'Test User').split(' ');
    const lastName = rest.join(' ') || 'User';
    return {
      webhookName: 'New Hire',
      employees: [{
        id: String(Math.floor(Math.random() * 9000) + 1000),
        action: 'inserted',
        fields: {
          firstName:    { value: firstName },
          lastName:     { value: lastName },
          workEmail:    { value: email || `${firstName.toLowerCase()}.${lastName.toLowerCase()}@contoso.onmicrosoft.com` },
          department:   { value: department || 'Engineering' },
          jobTitle:     { value: jobTitle || 'Software Engineer' },
          hireDate:     { value: now },
          country:      { value: 'United States' },
          location:     { value: 'Seattle, WA' },
        }
      }]
    };
  }

  if (type === 'term') {
    const [email, ticketRef] = args;
    return {
      webhookName: 'Termination',
      employees: [{
        id: String(Math.floor(Math.random() * 9000) + 1000),
        action: 'updated',
        fields: {
          workEmail:       { value: email || 'test.user@contoso.onmicrosoft.com' },
          terminationDate: { value: now },
          ticketRef:       { value: ticketRef || 'INC-' + Math.floor(Math.random() * 9000 + 1000) },
        }
      }]
    };
  }

  if (type === 'transfer') {
    const [email, department, jobTitle] = args;
    return {
      webhookName: 'Job Change',
      employees: [{
        id: String(Math.floor(Math.random() * 9000) + 1000),
        action: 'updated',
        fields: {
          workEmail:   { value: email || 'test.user@contoso.onmicrosoft.com' },
          department:  { value: department || 'Engineering' },
          jobTitle:    { value: jobTitle || 'Senior Engineer' },
        }
      }]
    };
  }

  throw new Error(`Unknown event type: ${type}. Use: hire | term | transfer`);
}

if (!eventType || !['hire','term','transfer'].includes(eventType)) {
  console.error('Usage: node test-bamboohr-webhook.js <hire|term|transfer> [...args]');
  console.error('  hire:     "Full Name" email@domain.com "Department" "Job Title"');
  console.error('  term:     email@domain.com TICKET-REF');
  console.error('  transfer: email@domain.com "New Department" "New Title"');
  process.exit(1);
}

const payload = buildPayload(eventType, args);
const body    = JSON.stringify(payload, null, 2);
const ts      = Math.floor(Date.now() / 1000);

// Build headers
const headers = {
  'Content-Type':  'application/json',
  'Content-Length': Buffer.byteLength(body),
};

if (HMAC_SECRET) {
  const sig = crypto.createHmac('sha256', HMAC_SECRET).update(`${ts}.${body}`).digest('hex');
  headers['x-bamboohr-signature'] = `t=${ts},v1=${sig}`;
} else {
  headers['x-api-key'] = API_KEY;
}

const url  = new URL(ENDPOINT);
const mod  = url.protocol === 'https:' ? https : http;
const opts = {
  hostname: url.hostname,
  port:     url.port || (url.protocol === 'https:' ? 443 : 80),
  path:     url.pathname + url.search,
  method:   'POST',
  headers,
};

console.log(`\nFiring ${eventType} webhook → ${ENDPOINT}`);
console.log('Payload:', JSON.stringify(payload, null, 2), '\n');

const req = mod.request(opts, res => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log(`Response ${res.statusCode}:`);
    try { console.log(JSON.stringify(JSON.parse(data), null, 2)); }
    catch { console.log(data); }
  });
});
req.on('error', err => { console.error('Request error:', err.message); process.exit(1); });
req.write(body);
req.end();
