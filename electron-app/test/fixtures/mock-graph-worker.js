'use strict';
// Stands in for lib/graph-worker.ps1 in tests: same line protocol, no PowerShell.
process.stdout.write('{"ready":true}\n');
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', l => {
  let req;
  try { req = JSON.parse(l); } catch { return; }
  if (req.script === 'fail') {
    process.stdout.write(JSON.stringify({ id: req.id, ok: false, error: 'boom' }) + '\n');
  } else if (req.script === 'die') {
    process.exit(3);
  } else if (req.script === 'hang') {
    // never reply
  } else {
    process.stdout.write(JSON.stringify({ id: req.id, ok: true, output: 'echo:' + req.script }) + '\n');
  }
});
