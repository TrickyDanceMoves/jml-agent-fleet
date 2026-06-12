const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const apiRoot = path.resolve(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function resolveRef(root, ref) {
  assert.ok(ref.startsWith('#/'), `unsupported external ref ${ref}`);
  return ref
    .slice(2)
    .split('/')
    .reduce((value, key) => value[key.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function mergeSchemas(root, schemas) {
  return schemas.reduce((merged, schema) => {
    const resolved = schema && schema.$ref ? resolveRef(root, schema.$ref) : schema;
    return {
      ...merged,
      ...resolved,
      properties: { ...(merged.properties || {}), ...(resolved.properties || {}) },
      required: [...new Set([...(merged.required || []), ...(resolved.required || [])])],
    };
  }, {});
}

function validateSchema(root, schema, value, at = '$') {
  if (schema.$ref) return validateSchema(root, resolveRef(root, schema.$ref), value, at);
  if (schema.allOf) return schema.allOf.flatMap((part) => validateSchema(root, part, value, at));
  if (schema.anyOf) {
    return schema.anyOf.some((part) => validateSchema(root, part, value, at).length === 0)
      ? []
      : [`${at} did not match anyOf`];
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((part) => validateSchema(root, part, value, at).length === 0).length;
    return matches === 1 ? [] : [`${at} matched ${matches} oneOf branches`];
  }

  const errors = [];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${at} must equal ${schema.const}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of ${schema.enum.join(', ')}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((type) => {
      if (type === 'array') return Array.isArray(value);
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (type === 'null') return value === null;
      return typeof value === type;
    });
    if (!ok) errors.push(`${at} must be ${types.join('|')}`);
  }
  if (schema.type === 'object' || schema.properties || schema.required) {
    for (const key of schema.required || []) {
      if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${at}.${key} is required`);
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (value != null && Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateSchema(root, propSchema, value[key], `${at}.${key}`));
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of Object.keys(value || {})) {
        if (!allowed.has(key)) errors.push(`${at}.${key} is not allowed`);
      }
    }
  }
  if (schema.type === 'array' && schema.items && Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...validateSchema(root, schema.items, item, `${at}[${index}]`)));
  }
  return errors;
}

function materialize(root, schema, eventKind) {
  if (schema.$ref) return materialize(root, resolveRef(root, schema.$ref), eventKind);
  if (schema.allOf) return materialize(root, mergeSchemas(root, schema.allOf), eventKind);
  if (schema.oneOf || schema.anyOf) {
    const branches = schema.oneOf || schema.anyOf;
    const branch = branches.find((candidate) => {
      const resolved = candidate.$ref ? resolveRef(root, candidate.$ref) : candidate;
      return JSON.stringify(resolved).toLowerCase().includes(eventKind);
    }) || branches[0];
    return materialize(root, branch, eventKind);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) {
    return schema.enum.find((entry) => String(entry).toLowerCase() === eventKind) || schema.enum[0];
  }
  if (schema.type === 'array') return [materialize(root, schema.items || { type: 'string' }, eventKind)];
  if (schema.type === 'object' || schema.properties) {
    const out = {};
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      const lower = key.toLowerCase();
      if ((schema.required || []).includes(key) || lower.includes('ticket') || lower.includes('event')) {
        out[key] = materialize(root, propSchema, eventKind);
      }
    }
    return out;
  }
  if (schema.type === 'integer') return 1;
  if (schema.type === 'number') return 1;
  if (schema.type === 'boolean') return true;
  if (schema.format === 'date-time') return '2026-06-12T12:00:00.000Z';
  if (schema.format === 'date') return '2026-06-12';
  return eventKind === 'terminate' ? 'TERM-123' : `${eventKind}-value`;
}

function canonicalSchema() {
  const file = path.join(apiRoot, 'src', 'schemas', 'hr-event.schema.json');
  assert.ok(fs.existsSync(file), 'api/src/schemas/hr-event.schema.json must exist');
  return readJson(file);
}

function loadBambooAdapter() {
  const file = path.join(apiRoot, 'src', 'adapters', 'bamboohr.js');
  assert.ok(fs.existsSync(file), 'api/src/adapters/bamboohr.js must exist');
  return require(file);
}

test('canonical HR schema accepts hire, terminate, and transfer examples', () => {
  const schema = canonicalSchema();
  for (const eventKind of ['hire', 'terminate', 'transfer']) {
    const event = materialize(schema, schema, eventKind);
    assert.deepEqual(validateSchema(schema, schema, event), [], `${eventKind} should be valid`);
  }
});

test('canonical HR schema rejects missing required fields', () => {
  const schema = canonicalSchema();
  // A complete, valid event...
  const valid = {
    eventType: 'hire',
    effectiveDate: '2026-06-12',
    employee: { email: 'ava.nguyen@contoso.onmicrosoft.com' },
  };
  assert.deepEqual(validateSchema(schema, schema, valid), [], 'baseline event should be valid');

  // ...is rejected when a top-level required field is removed.
  for (const key of schema.required) {
    const missing = { ...valid };
    delete missing[key];
    assert.notDeepEqual(validateSchema(schema, schema, missing), [], `missing ${key} should be invalid`);
  }
  // employee.email is required too.
  const noEmail = { ...valid, employee: {} };
  assert.notDeepEqual(validateSchema(schema, schema, noEmail), [], 'employee without email should be invalid');
});

test('canonical HR schema requires ticketRef for terminate (if/then rule)', () => {
  const schema = canonicalSchema();
  // The schema encodes "terminate => ticketRef required" via if/then.
  assert.equal(schema.if?.properties?.eventType?.const, 'terminate', 'if-clause targets terminate');
  assert.ok((schema.then?.required || []).includes('ticketRef'), 'then-clause requires ticketRef');

  // Enforce that conditional rule directly (the generic walker above does not do if/then).
  function violatesTerminateRule(ev) {
    return ev.eventType === 'terminate' && !ev.ticketRef;
  }
  const term = { eventType: 'terminate', effectiveDate: '2026-06-12', employee: { email: 'r@contoso.onmicrosoft.com' } };
  assert.equal(violatesTerminateRule(term), true, 'terminate without ticketRef violates the rule');
  assert.equal(violatesTerminateRule({ ...term, ticketRef: 'INC-1042' }), false, 'terminate with ticketRef is fine');
});

// Build a BambooHR webhook in its real shape: { webhookName, employees:[{ id, fields:{ name:{value} } }] }
function bambooWebhook(fieldMap) {
  const fields = {};
  for (const [k, v] of Object.entries(fieldMap)) fields[k] = { value: v };
  return { webhookName: 'test', employees: [{ id: 'E123', action: 'updated', fields }] };
}

test('BambooHR adapter maps New Hire, Termination, and Job Change into canonical events', () => {
  const schema = canonicalSchema();
  const { adaptWebhook } = loadBambooAdapter();
  assert.equal(typeof adaptWebhook, 'function', 'adapter should export adaptWebhook');

  // New Hire (hireDate present, no terminationDate) → hire
  const [hire] = adaptWebhook(bambooWebhook({
    firstName: 'Ava', lastName: 'Nguyen', workEmail: 'ava.nguyen@contoso.onmicrosoft.com',
    department: 'Engineering', jobTitle: 'Engineer', country: 'United States', hireDate: '2026-06-12',
  }));
  assert.equal(hire.eventType, 'hire');
  assert.equal(hire.source, 'bamboohr');
  assert.equal(hire.employee.usageLocation, 'US');
  assert.deepEqual(validateSchema(schema, schema, hire), [], 'hire should be a canonical HR event');

  // Termination (terminationDate present) → terminate, with ticketRef
  const [term] = adaptWebhook(bambooWebhook({
    workEmail: 'robert.martinez@contoso.onmicrosoft.com', terminationDate: '2026-06-12', ticketRef: 'INC-1042',
  }));
  assert.equal(term.eventType, 'terminate');
  assert.equal(term.ticketRef, 'INC-1042');
  assert.deepEqual(validateSchema(schema, schema, term), [], 'terminate should be a canonical HR event');

  // Job Change (no hire/termination date) → transfer, with changes block
  const [xfer] = adaptWebhook(bambooWebhook({
    workEmail: 'dev.patel@contoso.onmicrosoft.com', department: 'Platform', jobTitle: 'Senior Engineer',
  }));
  assert.equal(xfer.eventType, 'transfer');
  assert.equal(xfer.changes.newDepartment, 'Platform');
  assert.deepEqual(validateSchema(schema, schema, xfer), [], 'transfer should be a canonical HR event');
});

test('BambooHR adapter rejects a webhook with no employees array', () => {
  const { adaptWebhook } = loadBambooAdapter();
  assert.throws(() => adaptWebhook({ webhookName: 'x' }), /employees array/);
});

test('x-api-key gate rejects missing/wrong keys and accepts the configured key', () => {
  // requireApiKey reads process.env.JML_API_KEY at module load — set it BEFORE require.
  process.env.JML_API_KEY = 'correct-test-key';
  const { requireApiKey } = require(path.join(apiRoot, 'src', 'lib', 'api-key-auth.js'));

  const reqWith = (key) => ({ headers: { get: (n) => (n.toLowerCase() === 'x-api-key' && key ? key : null) } });

  assert.equal(requireApiKey(reqWith(null)).authorized, false, 'missing key rejected');
  assert.equal(requireApiKey(reqWith('wrong-key')).authorized, false, 'wrong key rejected');
  assert.equal(requireApiKey(reqWith('correct-test-key')).authorized, true, 'correct key accepted');
});
