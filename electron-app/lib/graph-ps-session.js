'use strict';

/*
 * Warm PowerShell session for Graph queries.
 *
 * Spawning powershell.exe + Import-Module + Connect-MgGraph costs 3-8s per
 * query when done cold. This keeps one authenticated worker process alive
 * (lib/graph-worker.ps1) and sends it query snippets over a line-delimited
 * JSON protocol, so repeat queries only pay the Graph round trip.
 *
 * Failure model: any infrastructure problem (spawn failure, worker exit,
 * timeout) kills the worker, rejects in-flight requests with
 * `err.sessionError = true`, and the next run() starts a fresh worker.
 * Script-level errors (a Graph 404, a bad query) reject WITHOUT
 * sessionError — callers must not retry those against a cold spawn.
 */

const { spawn } = require('child_process');
const readline = require('readline');

class GraphPsSession {
  constructor({ command = 'powershell', args = [] }) {
    this.command = command;
    this.args = args;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
    this.readyPromise = null;
  }

  _start() {
    const proc = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    let readyResolve, readyReject;
    this.readyPromise = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { readyResolve(); return; }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) entry.resolve(String(msg.output ?? ''));
      else {
        const err = new Error(msg.error || 'Graph worker error');
        entry.reject(err);
      }
    });

    const fail = why => {
      if (this.proc === proc) this.proc = null;
      const err = new Error('Graph session ' + why);
      err.sessionError = true;
      readyReject(err);
      // readyPromise may already be settled; swallow the late rejection
      this.readyPromise?.catch(() => {});
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      this.pending.clear();
    };

    proc.on('error', e => fail('failed to start: ' + e.message));
    proc.on('exit', code => fail('exited (' + code + ')'));
  }

  _kill() {
    if (this.proc) { try { this.proc.kill(); } catch {} this.proc = null; }
  }

  async run(script, { timeout = 60000 } = {}) {
    if (!this.proc) this._start();
    const proc = this.proc;
    await this.readyPromise;

    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error('Graph session timed out after ' + timeout + 'ms');
        err.sessionError = true;
        // a hung worker can't be trusted — replace it on the next run()
        this._kill();
        reject(err);
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(JSON.stringify({ id, script }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        e.sessionError = true;
        reject(e);
      }
    });
  }

  dispose() {
    this._kill();
  }
}

module.exports = { GraphPsSession };
