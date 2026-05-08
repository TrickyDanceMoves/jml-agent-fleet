'use strict';

const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schema = require('../schemas/hr-event.schema.json');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

function validateEvent(event) {
  const valid = validate(event);
  if (!valid) {
    return {
      valid: false,
      errors: validate.errors.map(e => `${e.instancePath || '(root)'} ${e.message}`)
    };
  }

  // Extra rules not expressible cleanly in JSON Schema
  if (event.eventType === 'transfer' && !event.changes) {
    return { valid: false, errors: ['changes object required for eventType=transfer'] };
  }
  if (event.eventType === 'hire' && !event.employee.usageLocation) {
    return { valid: false, errors: ['employee.usageLocation required for eventType=hire'] };
  }

  return { valid: true, errors: [] };
}

module.exports = { validateEvent };
