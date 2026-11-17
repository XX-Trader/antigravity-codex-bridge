'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bg = require('../src/background.cjs');
const { finalHandoff } = require('../src/server.cjs');

test('owned supervisor completion, boundaries, cancellation and crashes', async t => {
  assert.ok(process.env.CODEX_EXECUTOR_TEST_ROOT);
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'background-'));
  const file = path.join(root, 'job.json'), controlled = path.join(root, 'background');
  const pwsh = process.env.CODEX_EXECUTOR_PWSH;
  fs.mkdirSync(controlled);
  fs.writeFileSync(file, JSON.stringify({ job_id: '123456789012345678901234', stage: 'execute', cwd: root, settings: { pwsh } }));
  const launch = async code => {
    const request = path.join(controlled, 'input.json');
    fs.writeFileSync(request, JSON.stringify({ executable: process.execPath, args: ['-e', code], cwd: root }));
    return bg.start(file, request);
  };
  let outstanding;
  try {
    await t.test('handoff is distinct from unknown background; invalid IDs and external requests fail', async () => {
      assert.equal(finalHandoff('[CODEX_BACKGROUND_RUNNING] unknown').kind, 'background_running');
      assert.equal(finalHandoff('[CODEX_BACKGROUND_WAIT]\n{"id":"abc"}').controlled_id, 'abc');
      assert.throws(() => bg.inspect(file, '../outside'), /Invalid/);
      const external = path.join(root, 'external.json'); fs.writeFileSync(external, '{}');
      await assert.rejects(bg.start(file, external), /escapes/);
      const invalid = path.join(controlled, 'invalid.json'); fs.writeFileSync(invalid, JSON.stringify({ executable: 'relative-program', args: [] }));
      await assert.rejects(bg.start(file, invalid), /absolute executable/);
    });
    await t.test('model-side enqueue never starts a process; only local worker activation does', async () => {
      const request = path.join(controlled, 'input.json');
      fs.writeFileSync(request, JSON.stringify({ executable: process.execPath, args: ['-e', 'console.log("WORKER_ACTIVATED")'], cwd: root }));
      const { id } = await bg.enqueue(file, request); outstanding = id;
      assert.equal(fs.existsSync(path.join(controlled, id, 'launch.json')), false);
      assert.equal(fs.existsSync(path.join(controlled, id, 'status.json')), false);
      await bg.activate(file, id);
      const result = await bg.wait(file, id, { timeoutMs: 15000 });
      assert.equal(result.exit_code, 0); assert.match(result.output_tail, /WORKER_ACTIVATED/);
      bg.release(file, id); outstanding = null;
    });
    await t.test('natural completion and nonzero exit preserve real results; output reads are bounded', async () => {
      for (const exit of [0, 7]) {
        const { id } = await launch(`setTimeout(()=>{process.stdout.write('x'.repeat(${exit === 0 ? 20 * 1024 * 1024 : 20000}),()=>process.exit(${exit}))},1200)`); outstanding = id;
        await assert.rejects(launch('console.log("must not rerun")'), /EEXIST/);
        let checks = 0;
        const result = await bg.wait(file, id, { timeoutMs: 15000, intervalMs: 60000, onCheck: () => checks++ });
        assert.equal(result.exit_code, exit); assert.ok(result.output_tail.length <= 8000); assert.ok(checks <= 3);
        assert.ok(fs.statSync(result.log_file).size <= 8 * 1024 * 1024);
        if (exit === 0) assert.ok(fs.statSync(result.log_file + '.1').size <= 8 * 1024 * 1024);
        assert.ok(result.elapsed_ms < 30000, 'completion watcher does not wait the full polling interval');
        bg.release(file, id); outstanding = null;
      }
    });
    await t.test('unlimited wait remains responsive to completion without busy polling', async () => {
      const { id } = await launch('setTimeout(()=>console.log("UNLIMITED_DONE"),1200)'); outstanding = id;
      let checks = 0;
      const result = await bg.wait(file, id, { timeoutMs: null, intervalMs: 60000, onCheck: () => checks++ });
      assert.equal(result.exit_code, 0); assert.match(result.output_tail, /UNLIMITED_DONE/); assert.ok(checks <= 3);
      bg.release(file, id); outstanding = null;
    });
    await t.test('registration nonce, status, symlink and arbitrary live PID cannot be adopted', async () => {
      const { id } = await launch('setTimeout(()=>{},120000)'); outstanding = id;
      const info = bg.inspect(file, id), launchFile = path.join(info.dir, 'launch.json');
      const original = JSON.stringify(info.launch);
      fs.writeFileSync(launchFile, JSON.stringify({ ...info.launch, nonce: 'a'.repeat(48) }));
      assert.throws(() => bg.inspect(file, id), /does not match/);
      fs.writeFileSync(launchFile, JSON.stringify({ ...info.launch, pid: process.pid, identity: bg.identity(process.pid, pwsh) }));
      assert.throws(() => bg.inspect(file, id), /not this job owned supervisor/);
      fs.writeFileSync(launchFile, original);
      fs.writeFileSync(info.statusFile, JSON.stringify({ id, job_id: info.job.job_id, nonce: 'b'.repeat(48), exit_code: 0, ended_at: new Date().toISOString() }));
      assert.throws(() => bg.inspect(file, id), /completion/); fs.unlinkSync(info.statusFile);
      const junction = path.join(controlled, 'abcdefabcdefabcdefabcdef');
      fs.symlinkSync(root, junction, 'junction');
      // The unit directory may not alias a parent or any location outside root.
      assert.throws(() => bg.inspect(file, 'abcdefabcdefabcdefabcdef'), /escapes/); fs.unlinkSync(junction);
      assert.equal(bg.killOwned({ pid: process.pid, identity: '1' }, pwsh).requested, false);
      fs.writeFileSync(path.join(root, 'cancel'), '');
      const result = await bg.wait(file, id, { timeoutMs: 15000 });
      assert.equal(result.reason, 'cancelled'); assert.equal(result.termination.requested, true);
      fs.unlinkSync(path.join(root, 'cancel')); bg.release(file, id); outstanding = null;
    });
    await t.test('deadline terminates only the registered tree', async () => {
      const { id } = await launch('setTimeout(()=>{},120000)'); outstanding = id;
      const result = await bg.wait(file, id, { timeoutMs: 50 });
      assert.equal(result.reason, 'timed_out'); assert.equal(result.termination.requested, true);
      bg.release(file, id); outstanding = null;
    });
    await t.test('supervisor crash without status resumes with unknown exit rather than hanging', async () => {
      const { id } = await launch('setTimeout(()=>{},120000)'); outstanding = id;
      const info = bg.inspect(file, id); assert.equal(bg.killOwned(info.launch, pwsh).requested, true);
      const result = await bg.wait(file, id, { timeoutMs: 15000, intervalMs: 50 });
      assert.equal(result.exit_code, null); assert.match(result.error, /without a completion record/);
      bg.release(file, id); outstanding = null;
    });
  } finally {
    if (outstanding) { const info = bg.inspect(file, outstanding); bg.killOwned(info.launch, pwsh); }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
