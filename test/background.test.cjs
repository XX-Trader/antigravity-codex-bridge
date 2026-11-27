'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const bg = require('../src/background.cjs');
const { finalHandoff } = require('../src/server.cjs');

test('temporary observation failures preserve a single owned command and bounded local waiting', async t => {
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'observation-'));
  const file = path.join(root, 'job.json'), controlled = path.join(root, 'background');
  fs.mkdirSync(controlled);
  fs.writeFileSync(file, JSON.stringify({ job_id: '123456789012345678901234', stage: 'execute', cwd: root, settings: { pwsh: 'fixture-pwsh' } }));
  const source = fs.readFileSync(require.resolve('../src/background.cjs'), 'utf8');
  let unavailable = false, spawns = 0, queries = 0, watchFails = false, mismatch = false, cimUnavailable = false, kills = 0, manualWatch = false, killUnknown = false;
  const watchCallbacks = [];
  let duringQuery = null, queryGate = null, queryStarted = null, instances = 0, closes = 0;
  const fakeFs = Object.create(fs);
  fakeFs.watch = (...args) => {
    if (manualWatch) { watchCallbacks.push(args[1]); const watcher = new EventEmitter(); watcher.close = () => {}; return watcher; }
    if (watchFails) { const watcher = new EventEmitter(); watcher.close = () => {}; setImmediate(() => watcher.emit('error', new Error('watch unavailable'))); return watcher; }
    return fs.watch(...args);
  };
  const module = { exports: {} };
  const filename = require.resolve('../src/background.cjs');
  vm.runInNewContext(source, { module, exports: module.exports, __filename: filename, console, Buffer, setTimeout, clearTimeout,
    process: { platform: 'win32', execPath: process.execPath, pid: process.pid, env: process.env },
    require: name => name === 'node:fs' ? fakeFs : name === './process-query.cjs' ? { ProcessQuery: class {
      constructor() { instances++; this.interrupt = null; }
      async request(request) {
        queries++;
        if (queryGate && request.op === 'inspect') {
          const gate = queryGate; queryGate = null;
          const interrupted = new Promise((_, reject) => { this.interrupt = reject; });
          queryStarted();
          try { await Promise.race([gate, interrupted]); } finally { this.interrupt = null; }
        }
        if (unavailable) throw new Error('process query timed out');
        if (request.op === 'kill') { kills++; if (killUnknown) throw new Error('connection lost after kill request'); return { requested: true }; }
        if (duringQuery) { const action = duringQuery; duringQuery = null; action(); return { items: request.pids.map(pid => ({ pid, identity: null })) }; }
        if (cimUnavailable) throw new Error('CIM query timed out');
        return { items: request.pids.map(pid => ({ pid, identity: '123', executable: process.execPath, command: `${mismatch ? 'foreign' : filename} --supervise ${currentRequest}`, parent: 1234 })) };
      }
      fail(error) { this.interrupt?.(error); }
      close() { closes++; }
    } } : name === 'node:child_process' ? {
      spawn: (_exe, args) => {
        spawns++;
        const request = JSON.parse(fs.readFileSync(args[2], 'utf8'));
        const dir = path.dirname(args[2]);
        fs.writeFileSync(path.join(dir, 'output.log'), 'ONE_COMMAND');
        fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ id: request.id, job_id: request.job_id, nonce: request.nonce, pid: 1234, identity: '123' }));
        const child = new EventEmitter(); child.unref = () => {}; return child;
      }
    } : require(name) });
  const owned = module.exports;
  let currentRequest;
  const prepare = async () => {
    const request = path.join(controlled, 'input.json');
    fs.writeFileSync(request, JSON.stringify({ executable: process.execPath, args: [], cwd: root }));
    const { id } = await owned.enqueue(file, request);
    currentRequest = path.join(controlled, id, 'request.json');
    return id;
  };
  const complete = id => {
    const launch = JSON.parse(fs.readFileSync(path.join(controlled, id, 'launch.json'), 'utf8'));
    fs.writeFileSync(path.join(controlled, id, 'status.json'), JSON.stringify({ id, job_id: launch.job_id, nonce: launch.nonce, exit_code: 0, ended_at: new Date().toISOString() }));
  };
  try {
    await t.test('completion is collected while observation is pending and query is closed', async () => {
      const id = await prepare(), activated = await owned.activate(file, id);
      let releaseQuery, started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      queryStarted = started;
      queryGate = new Promise(resolve => { releaseQuery = resolve; });
      const closeBefore = closes, pending = owned.wait(file, id, { activated, intervalMs: 20000 });
      await startedPromise;
      complete(id);
      try {
        const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('completion blocked by query')), 2000))]);
        assert.equal(result.exit_code, 0);
        assert.ok(closes > closeBefore);
      } finally { releaseQuery(); owned.release(file, id); }
    });
    await t.test('cancel observed during a pending query is not lost', async () => {
      const id = await prepare(), activated = await owned.activate(file, id);
      let releaseQuery, started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      queryStarted = started;
      queryGate = new Promise(resolve => { releaseQuery = resolve; });
      const pending = owned.wait(file, id, { activated, intervalMs: 20000 });
      await startedPromise;
      fs.writeFileSync(path.join(root, 'cancel'), '');
      releaseQuery();
      try {
        const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('cancel event lost')), 2000))]);
        assert.equal(result.reason, 'cancelled'); assert.equal(result.termination.requested, true);
      } finally { fs.unlinkSync(path.join(root, 'cancel')); owned.release(file, id); }
    });
    await t.test('completion wins when a file event interrupts initial cancellation verification', async () => {
      const id = await prepare(), activated = await owned.activate(file, id);
      let releaseQuery, started;
      const startedPromise = new Promise(resolve => { started = resolve; });
      queryStarted = started;
      queryGate = new Promise(resolve => { releaseQuery = resolve; });
      manualWatch = true; watchCallbacks.length = 0;
      fs.writeFileSync(path.join(root, 'cancel'), '');
      const before = kills, pending = owned.wait(file, id, { activated, intervalMs: 20000 });
      await startedPromise;
      complete(id); watchCallbacks[0]('change', 'status.json');
      try {
        const result = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('completion event lost')), 2000))]);
        assert.equal(result.exit_code, 0); assert.equal(kills, before);
      } finally {
        releaseQuery(); manualWatch = false; fs.unlinkSync(path.join(root, 'cancel')); owned.release(file, id);
      }
    });
    await t.test('lost termination receipt leaves result unknown without another child kill', async () => {
      const id = await prepare(); await owned.activate(file, id);
      const launchFile = path.join(controlled, id, 'launch.json');
      const launch = JSON.parse(fs.readFileSync(launchFile, 'utf8'));
      launch.child = { pid: 5678, identity: '123' };
      fs.writeFileSync(launchFile, JSON.stringify(launch));
      const updated = await owned.inspect(file, id, { verifyProcess: false });
      const before = kills;
      killUnknown = true; fs.writeFileSync(path.join(root, 'cancel'), '');
      try {
        const result = await owned.wait(file, id, { activated: updated });
        assert.equal(result.termination.requested, null);
        assert.match(result.termination.observation_error, /connection lost after kill request/);
        assert.equal(kills - before, 1);
      } finally { killUnknown = false; fs.unlinkSync(path.join(root, 'cancel')); owned.release(file, id); }
    });
    for (const policy of [false, true]) await t.test(policy ? 'supervisor does not retry policy denial' : 'supervisor retries a transient self identity failure', async () => {
      const id = await prepare(), supervisorModule = { exports: {} };
      let attempts = 0, starts = 0, closed = 0;
      vm.runInNewContext(source + '\nmodule.exports.fixtureSupervise = supervise;', { module: supervisorModule, exports: supervisorModule.exports, __filename: filename, console, Buffer, setTimeout, clearTimeout,
        process: { platform: 'win32', execPath: process.execPath, pid: 1234, env: process.env },
        require: name => name === './process-query.cjs' ? { ProcessQuery: class {
          async request(request) {
            if (request.pids.includes(1234)) {
              attempts++;
              if (policy) throw new Error('rejected: blocked by policy');
              if (attempts === 1) throw new Error('temporary timeout');
            }
            return { items: request.pids.map(pid => ({ pid, identity: '123' })) };
          }
          close() { if (!this.closed) { this.closed = true; closed++; } }
        } } : name === 'node:child_process' ? {
          spawn: () => {
            starts++;
            const child = new EventEmitter(); child.pid = 5678; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            setTimeout(() => child.emit('close', 0), 20);
            return child;
          }
        } : require(name) });
      try {
        if (policy) {
          await assert.rejects(supervisorModule.exports.fixtureSupervise(currentRequest), /rejected: blocked by policy/);
          assert.equal(attempts, 1); assert.equal(starts, 0);
        } else {
          await supervisorModule.exports.fixtureSupervise(currentRequest);
          assert.equal(attempts, 2); assert.equal(starts, 1);
          assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(currentRequest), 'status.json'), 'utf8')).exit_code, 0);
        }
        assert.equal(closed, 1);
      } finally { owned.release(file, id); }
    });
    for (const tampered of [false, true]) await t.test(tampered ? 'completion written during exit observation still rejects a foreign nonce' : 'completion written during exit observation wins over the stale empty snapshot', async () => {
      const id = await prepare(), activated = await owned.activate(file, id), before = spawns;
      duringQuery = () => {
        complete(id);
        if (tampered) {
          const statusFile = path.join(controlled, id, 'status.json');
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          fs.writeFileSync(statusFile, JSON.stringify({ ...status, nonce: 'f'.repeat(48) }));
        }
      };
      const pending = owned.wait(file, id, { activated, intervalMs: 20 });
      if (tampered) await assert.rejects(pending, /Invalid owned completion record/);
      else { const result = await pending; assert.equal(result.exit_code, 0); assert.match(result.output_tail, /ONE_COMMAND/); }
      assert.equal(spawns, before); owned.release(file, id);
    });
    await t.test('supervisor keeps collecting its real child when child birth observation fails', async () => {
      const id = await prepare(), supervisorModule = { exports: {} };
      let starts = 0;
      vm.runInNewContext(source + '\nmodule.exports.fixtureSupervise = supervise;', { module: supervisorModule, exports: supervisorModule.exports, __filename: filename, console, Buffer, setTimeout, clearTimeout,
        process: { platform: 'win32', execPath: process.execPath, pid: 1234, env: process.env },
        require: name => name === './process-query.cjs' ? { ProcessQuery: class {
          async request(request) {
            if (request.pids.includes(5678)) throw new Error('child birth query timeout');
            return { items: request.pids.map(pid => ({ pid, identity: '123', executable: process.execPath, command: `${filename} --supervise ${currentRequest}`, parent: 1234 })) };
          }
          close() {}
        } } : name === 'node:child_process' ? {
          spawn: () => {
            starts++;
            const child = new EventEmitter(); child.pid = 5678; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
            setTimeout(() => { child.stdout.emit('data', Buffer.from('CHILD_COMPLETED_ONCE')); child.emit('close', 0); }, 20);
            return child;
          }
        } : require(name) });
      await supervisorModule.exports.fixtureSupervise(currentRequest);
      const dir = path.dirname(currentRequest), registration = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
      assert.equal(starts, 1); assert.equal(registration.child, undefined);
      assert.match(registration.child_observation_error, /child birth query timeout/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).exit_code, 0);
      assert.match(fs.readFileSync(path.join(dir, 'output.log'), 'utf8'), /CHILD_COMPLETED_ONCE/);
      owned.release(file, id);
    });
    await t.test('activation degradation recovers initial verification without another spawn', async () => {
      const before = spawns, id = await prepare(); unavailable = true;
      const activated = await owned.activate(file, id), checks = [], instancesBefore = instances;
      assert.equal(activated.processVerified, false);
      const pending = owned.wait(file, id, { activated, intervalMs: 20, onCheck: check => checks.push(check) });
      await new Promise(resolve => setTimeout(resolve, 65));
      assert.ok(checks.length >= 2 && checks.every(check => check.process_alive === null));
      assert.ok(queries < 12, 'no polling storm during query failure');
      unavailable = false;
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(checks.some(check => check.process_alive === true));
      complete(id);
      assert.equal((await pending).exit_code, 0); assert.equal(spawns, before + 1);
      assert.equal(instances - instancesBefore, 1, 'wait reuses one query instance across failures and recovery');
      owned.release(file, id);
    });
    await t.test('failed initial validation must still reject foreign supervisor after recovery', async () => {
      const id = await prepare(); unavailable = true;
      const activated = await owned.activate(file, id);
      unavailable = false; mismatch = true;
      await assert.rejects(owned.wait(file, id, { activated, intervalMs: 20 }), /not this job owned supervisor/);
      mismatch = false; owned.release(file, id);
    });
    await t.test('watch failure falls back to periodic completion collection', async () => {
      const id = await prepare(); const activated = await owned.activate(file, id); watchFails = true;
      const checks = [], pending = owned.wait(file, id, { activated, intervalMs: 20, onCheck: check => checks.push(check) });
      await new Promise(resolve => setTimeout(resolve, 50)); complete(id);
      assert.equal((await pending).exit_code, 0);
      assert.ok(checks.some(check => /File monitoring unavailable/.test(check.observation_error)));
      watchFails = false; owned.release(file, id);
    });
    await t.test('unknown-name watch storms cannot accelerate failed process queries', async () => {
      const id = await prepare(), activated = await owned.activate(file, id);
      manualWatch = true; unavailable = true; watchCallbacks.length = 0;
      const before = queries, pending = owned.wait(file, id, { activated, intervalMs: 2000 });
      let events = 0;
      for (const callback of watchCallbacks) for (let n = 0; n < 64; n++) { callback('change', null); events++; }
      await new Promise(resolve => setTimeout(resolve, 1100));
      for (const callback of watchCallbacks) callback('change', null);
      const observedQueries = queries - before;
      complete(id); watchCallbacks[0]('change', null);
      assert.equal((await pending).exit_code, 0);
      manualWatch = false; unavailable = false; owned.release(file, id);
      assert.ok(events > 100);
      assert.equal(observedQueries, 1, 'unknown-name events respect the full observation interval');
    });
    for (const cancel of [false, true]) await t.test(cancel ? 'cancel cannot bypass pending initial CIM verification' : 'deadline cannot bypass pending initial CIM verification', async () => {
      const id = await prepare(); cimUnavailable = true;
      const activated = await owned.activate(file, id), before = kills;
      assert.equal(activated.processVerified, false);
      if (cancel) fs.writeFileSync(path.join(root, 'cancel'), '');
      const result = await owned.wait(file, id, { activated, intervalMs: 20, timeoutMs: cancel ? null : 40 });
      assert.equal(result.termination.requested, false); assert.equal(kills, before);
      assert.match(result.termination.observation_error, /CIM query timed out/);
      if (cancel) fs.unlinkSync(path.join(root, 'cancel'));
      cimUnavailable = false; owned.release(file, id);
    });
    for (const foreign of [false, true]) await t.test(foreign ? 'cancel rejects foreign supervisor after pending verification' : 'cancel terminates only after initial CIM verification recovers', async () => {
      const id = await prepare(); cimUnavailable = true;
      const activated = await owned.activate(file, id), before = kills;
      cimUnavailable = false; mismatch = foreign;
      fs.writeFileSync(path.join(root, 'cancel'), '');
      if (foreign) {
        await assert.rejects(owned.wait(file, id, { activated }), /not this job owned supervisor/);
        assert.equal(kills, before);
      } else {
        const result = await owned.wait(file, id, { activated });
        assert.equal(result.termination.requested, true); assert.equal(kills, before + 1);
      }
      fs.unlinkSync(path.join(root, 'cancel')); mismatch = false; owned.release(file, id);
    });
    for (const cancel of [false, true]) await t.test(cancel ? 'cancel does not kill unverifiable PID' : 'deadline does not kill unverifiable PID', async () => {
      const id = await prepare(); const activated = await owned.activate(file, id); unavailable = true;
      if (cancel) fs.writeFileSync(path.join(root, 'cancel'), '');
      const result = await owned.wait(file, id, { activated, intervalMs: 20, timeoutMs: cancel ? null : 40 });
      assert.equal(result.reason, cancel ? 'cancelled' : 'timed_out'); assert.equal(result.termination.requested, false);
      assert.match(result.termination.observation_error, /timed out/);
      if (cancel) fs.unlinkSync(path.join(root, 'cancel'));
      unavailable = false; owned.release(file, id);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('owned supervisor completion, boundaries, cancellation and crashes', async t => {
  assert.ok(process.env.CODEX_EXECUTOR_TEST_ROOT);
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'background-'));
  const file = path.join(root, 'job.json'), controlled = path.join(root, 'background');
  const project = path.join(root, 'original-project');
  fs.mkdirSync(project);
  const pwsh = process.env.CODEX_EXECUTOR_PWSH;
  fs.mkdirSync(controlled);
  fs.writeFileSync(file, JSON.stringify({ job_id: '123456789012345678901234', stage: 'execute', cwd: project, settings: { pwsh } }));
  const launch = async code => {
    const request = path.join(controlled, 'input.json');
    fs.writeFileSync(request, JSON.stringify({ executable: process.execPath, args: ['-e', code], cwd: project }));
    return bg.start(file, request);
  };
  let outstanding;
  try {
    await t.test('handoff is distinct from unknown background; invalid IDs and external requests fail', async () => {
      assert.equal(finalHandoff('[CODEX_BACKGROUND_RUNNING] unknown').kind, 'background_running');
      assert.equal(finalHandoff('[CODEX_BACKGROUND_WAIT]\n{"id":"abc"}').controlled_id, 'abc');
      await assert.rejects(bg.inspect(file, '../outside'), /Invalid/);
      const external = path.join(root, 'external.json'); fs.writeFileSync(external, '{}');
      await assert.rejects(bg.start(file, external), /escapes/);
      const invalid = path.join(controlled, 'invalid.json'); fs.writeFileSync(invalid, JSON.stringify({ executable: 'relative-program', args: [] }));
      await assert.rejects(bg.start(file, invalid), /absolute executable/);
    });
    await t.test('external working directories run without moving job metadata; invalid cwd never claims a slot', async () => {
      const external = path.join(root, '外部 worktree'); fs.mkdirSync(external);
      const request = path.join(controlled, 'cwd-input.json');
      const submit = cwd => {
        fs.writeFileSync(request, JSON.stringify({ executable: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.cwd()))'], ...(cwd === undefined ? {} : { cwd }) }));
        return bg.enqueue(file, request);
      };
      for (const cwd of ['relative', '', null, 42, path.join(root, 'missing'), file]) {
        await assert.rejects(submit(cwd));
        assert.equal(fs.existsSync(path.join(controlled, 'active.json')), false);
      }
      for (const cwd of [external, undefined]) {
        const { id } = await submit(cwd); outstanding = id;
        await bg.activate(file, id);
        const result = await bg.wait(file, id, { timeoutMs: 15000 });
        assert.equal(result.exit_code, 0);
        assert.equal(JSON.parse(result.output_tail.trim()), fs.realpathSync(cwd || project));
        assert.equal(path.dirname(result.log_file), path.join(controlled, id));
        assert.deepEqual(fs.readdirSync(external), []);
        bg.release(file, id); outstanding = null;
      }
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
      const info = await bg.inspect(file, id), launchFile = path.join(info.dir, 'launch.json');
      const original = JSON.stringify(info.launch);
      fs.writeFileSync(launchFile, JSON.stringify({ ...info.launch, nonce: 'a'.repeat(48) }));
      await assert.rejects(bg.inspect(file, id), /does not match/);
      fs.writeFileSync(launchFile, JSON.stringify({ ...info.launch, pid: process.pid, identity: await bg.identity(process.pid, pwsh) }));
      await assert.rejects(bg.inspect(file, id), /not this job owned supervisor/);
      fs.writeFileSync(launchFile, original);
      fs.writeFileSync(info.statusFile, JSON.stringify({ id, job_id: info.job.job_id, nonce: 'b'.repeat(48), exit_code: 0, ended_at: new Date().toISOString() }));
      await assert.rejects(bg.inspect(file, id), /completion/); fs.unlinkSync(info.statusFile);
      const junction = path.join(controlled, 'abcdefabcdefabcdefabcdef');
      fs.symlinkSync(root, junction, 'junction');
      // The unit directory may not alias a parent or any location outside root.
      await assert.rejects(bg.inspect(file, 'abcdefabcdefabcdefabcdef'), /escapes/); fs.unlinkSync(junction);
      assert.equal((await bg.killOwned({ pid: process.pid, identity: '1' }, pwsh)).requested, false);
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
      const info = await bg.inspect(file, id); assert.equal((await bg.killOwned(info.launch, pwsh)).requested, true);
      const result = await bg.wait(file, id, { timeoutMs: 15000, intervalMs: 50 });
      assert.equal(result.exit_code, null); assert.match(result.error, /without a completion record/);
      bg.release(file, id); outstanding = null;
    });
    await t.test('write() retries transient lock errors, cleans up tmp, and createLogAppender() survives EBUSY rotation', () => {
      const target = path.join(root, 'retry-meta.json');
      let renameCalls = 0;
      const flakyFs = {
        ...fs,
        renameSync(src, dst) {
          renameCalls++;
          if (process.platform === 'win32' && renameCalls < 3) {
            const err = new Error('busy'); err.code = 'EBUSY'; throw err;
          }
          return fs.renameSync(src, dst);
        }
      };
      bg.write(target, { ok: 1 }, flakyFs);
      assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: 1 });
      if (process.platform === 'win32') assert.equal(renameCalls, 3);
      assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('retry-meta.json.') && n.endsWith('.tmp')), []);

      // Permanent failure must unlink temp file
      const failFs = {
        ...fs,
        renameSync() { const err = new Error('boom'); err.code = 'EINVAL'; throw err; }
      };
      assert.throws(() => bg.write(path.join(root, 'fail-meta.json'), { ok: 0 }, failFs), /boom/);
      assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('fail-meta.json.') && n.endsWith('.tmp')), []);

      // createLogAppender must not throw or double-close fd when renameSync fails with EBUSY
      const logPath = path.join(root, 'rotate-busy.log');
      const busyRotateFs = {
        ...fs,
        renameSync() { const err = new Error('locked'); err.code = 'EBUSY'; throw err; }
      };
      const appender = bg.createLogAppender(logPath, 16, busyRotateFs);
      try {
        appender.append(Buffer.from('0123456789'));
        appender.append(Buffer.from('abcdefghij')); // triggers rotation -> EBUSY -> fallback reopen & write
        appender.append(Buffer.from('KLMNOP'));
      } finally {
        appender.close();
        appender.close(); // idempotent close must never throw EBADF
      }
      assert.equal(fs.readFileSync(logPath, 'utf8'), '0123456789abcdefghijKLMNOP');
    });
  } finally {
    if (outstanding) { const info = await bg.inspect(file, outstanding); await bg.killOwned(info.launch, pwsh); }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
