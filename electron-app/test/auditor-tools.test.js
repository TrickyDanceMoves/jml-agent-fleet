'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('chat agents expose a member-user listing tool', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

  assert.match(main, /query_member_users/);
  assert.match(main, /MemberUsers/);
  assert.match(main, /accountEnabled/);
});

test('auditor query script supports member-user UPN lists', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'auditor', 'Invoke-AuditorQuery.ps1'), 'utf8');

  assert.match(script, /MemberUsers/);
  assert.match(script, /userType eq 'Member'/);
  assert.match(script, /userPrincipalName/);
});

test('standalone auditor exposes the same member-user listing tool', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', '..', 'auditor', 'auditor.js'), 'utf8');

  assert.match(cli, /query_member_users/);
  assert.match(cli, /MemberUsers/);
});
