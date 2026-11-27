'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProcessQuery } = require('../src/process-query.cjs');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function fixture() {
  const children = [];
  const module = { exports: {} };
  const spawn = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    children.push(child); return child;
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/process-query.cjs'), 'utf8'), {
    module, exports: module.exports, require: name => name === 'node:child_process' ? { spawn } : require(name), setTimeout, clearTimeout, Error, JSON
  });
  return { query: new module.exports.ProcessQuery('pwsh'), children };
}

test('helper failures reject pending requests and the next observation rebuilds', async () => {
  const { query, children } = fixture();
  let pending = query.request({ op: 'inspect', pids: [1] });
  await assert.rejects(query.request({ op: 'inspect', pids: [2] }), /Concurrent/);
  children[0].stderr.write('rejected: blocked by policy');
  children[0].emit('close');
  await assert.rejects(pending, /rejected: blocked by policy/);
  pending = query.request({ op: 'inspect', pids: [1] });
  assert.equal(children.length, 2);
  children[1].stdout.write(JSON.stringify({ id: 2, items: [{ pid: 1, identity: '123' }] }) + '\n');
  assert.equal((await pending).items[0].identity, '123');
  pending = query.request({ op: 'inspect', pids: [1] });
  query.close();
  await assert.rejects(pending, /closed/);
  assert.equal(query.pending, null);
});

for (const payload of ['not-json\n', 'x'.repeat(65537)]) {
  test('invalid or oversized helper response closes the channel', async () => {
    const { query, children } = fixture();
    const pending = query.request({ op: 'inspect', pids: [1] });
    children[0].stdout.write(payload);
    await assert.rejects(pending);
    assert.equal(children[0].killed, true);
    assert.equal(query.pending, null);
  });
}

test('helper error replies retain policy reason', async () => {
  const { query, children } = fixture();
  const pending = query.request({ op: 'inspect', pids: [1] });
  children[0].stdout.write(JSON.stringify({ id: 1, error: 'rejected: blocked by policy' }) + '\n');
  await assert.rejects(pending, /rejected: blocked by policy/);
  query.close();
});

test('Windows process observation reuses and recovers its bounded helper', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const query = new ProcessQuery(process.env.CODEX_EXECUTOR_PWSH);
  try {
    const first = await query.request({ op: 'inspect', pids: [process.pid] });
    assert.match(first.items[0].identity, /^\d+$/);
    assert.equal(first.items[0].executable.toLowerCase(), process.execPath.toLowerCase());
    const helper = query.child;
    const second = await query.request({ op: 'inspect', pids: [process.pid] });
    assert.equal(second.items[0].identity, first.items[0].identity);
    assert.equal(query.child, helper);
    assert.equal((await query.request({ op: 'kill', pid: process.pid, identity: '1' })).requested, false);
    assert.equal((await query.request({ op: 'kill', pid: 99999999, identity: '1' })).requested, false);
    query.close();
    const third = await query.request({ op: 'inspect', pids: [process.pid] });
    assert.equal(third.items[0].identity, first.items[0].identity);
    assert.notEqual(query.child, helper);
  } finally { query.close(); }
});
