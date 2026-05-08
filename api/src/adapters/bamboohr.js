'use strict';

/**
 * BambooHR → Canonical HR Event adapter.
 *
 * BambooHR fires webhooks per-field-change. Configure three webhooks in BambooHR:
 *   1. New Hire:       trigger on hireDate, fields: firstName, lastName, workEmail,
 *                      department, jobTitle, country, location, supervisorEmail, hireDate
 *   2. Termination:    trigger on terminationDate, fields: workEmail, terminationDate
 *   3. Job Change:     trigger on department or jobTitle, fields: workEmail, department,
 *                      jobTitle, supervisorEmail
 *
 * Webhook format from BambooHR:
 * {
 *   "webhookName": "New Hire",
 *   "employees": [
 *     {
 *       "id": "123",
 *       "action": "inserted",
 *       "fields": {
 *         "firstName":       { "value": "Jane" },
 *         "workEmail":       { "value": "jane@company.com" },
 *         "terminationDate": { "value": "2026-06-01" },
 *         ...
 *       }
 *     }
 *   ]
 * }
 */

const { v4: uuidv4 } = require('uuid');

const COUNTRY_TO_ISO2 = {
  'United States': 'US',
  'United Kingdom': 'GB',
  'Canada':         'CA',
  'Australia':      'AU',
  'Germany':        'DE',
  'France':         'FR',
  'Netherlands':    'NL',
  'India':          'IN',
  'Japan':          'JP',
  'Singapore':      'SG',
};

function field(fields, name) {
  return fields?.[name]?.value || null;
}

function detectEventType(fields) {
  const terminationDate = field(fields, 'terminationDate');
  const status = field(fields, 'status');
  const hireDate = field(fields, 'hireDate');

  if (terminationDate || status === 'Inactive') return 'terminate';
  if (hireDate) return 'hire';
  return 'transfer'; // department/jobTitle change
}

function toIso2(country) {
  if (!country) return 'US';
  if (country.length === 2) return country.toUpperCase();
  return COUNTRY_TO_ISO2[country] || 'US';
}

function adaptWebhook(payload) {
  if (!payload.employees || !Array.isArray(payload.employees)) {
    throw new Error('Invalid BambooHR webhook: missing employees array');
  }

  return payload.employees.map(emp => {
    const f = emp.fields || {};
    const eventType = detectEventType(f);
    const email = field(f, 'workEmail');

    if (!email) {
      throw new Error(`BambooHR employee ID ${emp.id}: missing workEmail — ensure workEmail is included in webhook fields`);
    }

    const event = {
      eventId: uuidv4(),
      eventType,
      source: 'bamboohr',
      effectiveDate: (
        field(f, 'terminationDate') ||
        field(f, 'hireDate') ||
        new Date().toISOString().slice(0, 10)
      ),
      employee: {
        employeeId:     String(emp.id),
        firstName:      field(f, 'firstName'),
        lastName:       field(f, 'lastName'),
        email,
        department:     field(f, 'department'),
        jobTitle:       field(f, 'jobTitle'),
        usageLocation:  toIso2(field(f, 'country')),
        manager:        field(f, 'supervisorEmail'),
        officeLocation: field(f, 'location'),
      }
    };

    if (eventType === 'transfer') {
      event.changes = {
        newDepartment: field(f, 'department'),
        newTitle:      field(f, 'jobTitle'),
        newManager:    field(f, 'supervisorEmail'),
      };
    }

    // Strip null values from employee to avoid schema noise
    Object.keys(event.employee).forEach(k => {
      if (event.employee[k] === null) delete event.employee[k];
    });
    if (event.changes) {
      Object.keys(event.changes).forEach(k => {
        if (event.changes[k] === null) delete event.changes[k];
      });
    }

    return event;
  });
}

module.exports = { adaptWebhook };
