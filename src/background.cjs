'use strict';
// A bridge-owned supervisor, not a second model session. All paths are derived
// from the job and a generated command ID; handoffs never supply a PID to kill.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const idPattern = /^[a-f0-9]{24}$/;
const read = file => {
  if (fs.statSync(file).size > 65536) throw new Error('Oversized background metadata');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const write = (file, value) => {
  const temp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temp, file);
};
function contained(root, file) {
  const base = fs.realpathSync(root), actual = fs.realpathSync(file);
  const relative = path.relative(base, actual);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Background path escapes owned directory');
  return actual;
}
function layout(file) {
  const jobFile = fs.realpathSync(file), job = read(jobFile);
  if (!idPattern.test(job.job_id || '') || job.stage !== 'execute') throw new Error('Background execution requires an execution-stage job');
  const root = path.join(path.dirname(jobFile), 'background');
  fs.mkdirSync(root, { recursive: true });
  contained(path.dirname(jobFile), root);
  return { jobFile, job, root };
}
function identity(pid, pwsh) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process ID');
  if (process.platform !== 'win32') {
    try { return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[19]; }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){try{[Console]::Write($p.StartTime.ToUniversalTime().Ticks)}catch{if(Get-Process -Id ${pid} -ErrorAction SilentlyContinue){throw}}}; exit 0`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  if (result.error || result.status !== 0) throw new Error('Cannot verify owned process identity: ' + (result.error?.message || result.stderr));
  return result.stdout.trim() || null;
}
function killOwned(record, pwsh) {
  if (identity(record.pid, pwsh) !== record.identity) return { requested: false, reason: 'Owned process exited or identity changed' };
  if (process.platform === 'win32') {
    // Recheck using the same Process object that issues Kill; do not resolve a
    // fresh bare PID after the check (PID reuse must not target another process).
    const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${record.pid} -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().Ticks.ToString() -eq '${record.identity}'){ $p.Kill($true); $p.WaitForExit(10000) | Out-Null; 'OWNED_TERMINATION_REQUESTED' }`;
    const r = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return { requested: r.status === 0 && r.stdout.includes('OWNED_TERMINATION_REQUESTED'), exit_code: r.status, error: r.error?.message || r.stderr?.trim() || null };
  }
  try { process.kill(-record.pid, 'SIGTERM'); return { requested: true }; }
  catch (e) { return { requested: false, error: e.message }; }
}
function inspect(file, id, { verifyProcess = true } = {}) {
  if (!idPattern.test(id || '')) throw new Error('Invalid controlled background ID');
  const { job, root } = layout(file), dir = contained(root, path.join(root, id));
  const launch = read(contained(dir, path.join(dir, 'launch.json')));
  if (launch.job_id !== job.job_id || launch.id !== id || !/^[a-f0-9]{48}$/.test(launch.nonce || '') ||
      !Number.isSafeInteger(launch.pid) || launch.pid <= 0 || !/^\d+$/.test(launch.identity || '')) throw new Error('Invalid owned background registration');
  const requestFile = contained(dir, path.join(dir, 'request.json')), request = read(requestFile);
  if (request.id !== id || request.job_id !== job.job_id || request.nonce !== launch.nonce) throw new Error('Background registration does not match launch request');
  if (verifyProcess && process.platform === 'win32' && identity(launch.pid, job.settings.pwsh) === launch.identity) {
    const r = spawnSync(job.settings.pwsh, ['-NoProfile', '-NonInteractive', '-Command',
      `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId = ${launch.pid}' | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.error || r.status !== 0) throw new Error('Cannot verify owned supervisor command line');
    const actual = r.stdout.trim() ? JSON.parse(r.stdout) : null;
    if (actual && (actual.ExecutablePath?.toLowerCase() !== process.execPath.toLowerCase() ||
        !actual.CommandLine?.toLowerCase().includes(__filename.toLowerCase()) ||
        !actual.CommandLine?.includes('--supervise') || !actual.CommandLine?.toLowerCase().includes(requestFile.toLowerCase()))) throw new Error('PID is not this job owned supervisor');
  }
  if (launch.child) {
    if (!Number.isSafeInteger(launch.child.pid) || launch.child.pid <= 0 || !/^\d+$/.test(launch.child.identity || '')) throw new Error('Invalid owned child registration');
    if (verifyProcess && process.platform === 'win32' && identity(launch.child.pid, job.settings.pwsh) === launch.child.identity) {
      const r = spawnSync(job.settings.pwsh, ['-NoProfile', '-NonInteractive', '-Command',
        `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter 'ProcessId = ${launch.child.pid}' | Select-Object ExecutablePath,ParentProcessId | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      if (r.error || r.status !== 0) throw new Error('Cannot verify owned command parent');
      const actual = r.stdout.trim() ? JSON.parse(r.stdout) : null;
      if (actual && (actual.ParentProcessId !== launch.pid || actual.ExecutablePath?.toLowerCase() !== request.executable.toLowerCase())) throw new Error('PID is not this supervisor owned command');
    }
  }
  const log = contained(dir, path.join(dir, 'output.log'));
  const statusFile = path.join(dir, 'status.json');
  let status = null;
  if (fs.existsSync(statusFile)) {
    status = read(contained(dir, statusFile));
    if (status.id !== id || status.nonce !== launch.nonce || status.job_id !== job.job_id ||
        !(status.exit_code === null || Number.isInteger(status.exit_code)) || !Number.isFinite(Date.parse(status.ended_at))) throw new Error('Invalid owned completion record');
  }
  return { job, dir, launch, log, statusFile, status };
}
function logTail(file) {
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 8000)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
async function wait(file, id, { timeoutMs, intervalMs = 60000, onCheck = () => {}, activated } = {}) {
  // activate() has already verified the OS process and immutable registration.
  // Reuse that in-memory result, not a model-provided object or persisted hint.
  const initial = activated || inspect(file, id), started = Date.now(), deadline = started + timeoutMs;
  const pwsh = initial.job.settings.pwsh;
  return new Promise((resolve, reject) => {
    let timer, completionWatcher, cancelWatcher, done = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); completionWatcher?.close(); cancelWatcher?.close();
      error ? reject(error) : resolve({ id, ...result, elapsed_ms: Date.now() - started });
    };
    const check = () => {
      if (done) return;
      clearTimeout(timer);
      try {
        const current = inspect(file, id, { verifyProcess: false }), { launch, status } = current;
        if (JSON.stringify(launch) !== JSON.stringify(initial.launch)) throw new Error('Owned registration changed while waiting');
        const cancelled = fs.existsSync(path.join(path.dirname(file), 'cancel'));
        const timedOut = Date.now() >= deadline;
        if (cancelled || timedOut) {
          const termination = killOwned(launch, pwsh);
          // If the supervisor crashed, only its separately registered child can
          // be stopped, and only after verifying that child's start identity.
          if (!termination.requested && launch.child && !status) termination.child = killOwned(launch.child, pwsh);
          finish(null, { reason: cancelled ? 'cancelled' : 'timed_out', termination }); return;
        }
        if (status) {
          onCheck({ id, at: new Date().toISOString(), process_alive: null, completed: true });
          finish(null, { id, exit_code: status.exit_code, ended_at: status.ended_at, error: status.error || null, status_file: current.statusFile, log_file: current.log, output_tail: logTail(current.log) }); return;
        }
        const supervisor = identity(launch.pid, pwsh);
        onCheck({ id, at: new Date().toISOString(), process_alive: supervisor === launch.identity, completed: !!status });
        if (supervisor && supervisor !== launch.identity) {
          finish(new Error('Owned supervisor identity changed; refusing to adopt or kill reused PID')); return;
        }
        if (!supervisor) {
          const child = launch.child && identity(launch.child.pid, pwsh);
          if (child && child !== launch.child.identity) { finish(new Error('Owned command identity changed')); return; }
          if (!child) { finish(null, { id, exit_code: null, error: 'Owned supervisor exited without a completion record', status_file: current.statusFile, log_file: current.log, output_tail: logTail(current.log) }); return; }
        }
        timer = setTimeout(check, Math.max(1, Math.min(intervalMs, deadline - Date.now())));
      } catch (e) { finish(e); }
    };
    try {
      completionWatcher = fs.watch(initial.dir, (_type, name) => { if (!name || String(name) === 'status.json') check(); });
      cancelWatcher = fs.watch(path.dirname(file), (_type, name) => { if (!name || String(name) === 'cancel') check(); });
      completionWatcher.on('error', e => finish(e)); cancelWatcher.on('error', e => finish(e));
      check();
    } catch (e) { finish(e); }
  });
}
async function enqueue(file, requestFile) {
  const { job, root } = layout(file);
  const request = read(contained(root, requestFile));
  if (!path.isAbsolute(request.executable || '') || !fs.statSync(request.executable).isFile() ||
      !Array.isArray(request.args) || request.args.length > 256 || request.args.some(a => typeof a !== 'string' || a.length > 32768)) throw new Error('Use an existing absolute executable and an argument array');
  const cwd = contained(job.cwd, request.cwd || job.cwd);
  const slot = path.join(root, 'active.json');
  // One outstanding command per model handoff; a duplicate launch must not
  // silently rerun an unknown command. Worker releases the slot after collection.
  const id = crypto.randomBytes(12).toString('hex'), nonce = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(slot, JSON.stringify({ id }), { flag: 'wx' });
  const dir = path.join(root, id); fs.mkdirSync(dir);
  write(path.join(dir, 'request.json'), { executable: fs.realpathSync(request.executable), args: request.args, cwd, job_id: job.job_id, id, nonce, pwsh: job.settings.pwsh });
  return { id };
}
async function activate(file, id) {
  if (!idPattern.test(id || '')) throw new Error('Invalid controlled background ID');
  const { job, root } = layout(file), dir = contained(root, path.join(root, id));
  const requestFile = contained(dir, path.join(dir, 'request.json')), request = read(requestFile);
  if (request.id !== id || request.job_id !== job.job_id || read(path.join(root, 'active.json')).id !== id) throw new Error('Queued command does not belong to this job');
  if (fs.existsSync(path.join(dir, 'launch.json'))) return inspect(file, id);
  // A durable claim prevents replay if the worker crashes in the spawn/record
  // gap. Such an unknown startup requires inspection, never another spawn.
  fs.writeFileSync(path.join(dir, 'activation.json'), JSON.stringify({ worker_pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  const child = spawn(process.execPath, [__filename, '--supervise', requestFile], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_EXECUTOR_BACKGROUND_JOB: '' } });
  let spawnError; child.on('error', e => { spawnError = e; }); child.unref();
  for (let n = 0; n < 400; n++) {
    if (spawnError) throw spawnError;
    if (fs.existsSync(path.join(dir, 'launch.json'))) return inspect(file, id);
    if (fs.existsSync(path.join(dir, 'startup-error.txt'))) throw new Error(fs.readFileSync(path.join(dir, 'startup-error.txt'), 'utf8'));
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Background startup result unknown; inspect owned directory, do not replay');
}
async function start(file, requestFile) {
  const { id } = await enqueue(file, requestFile); await activate(file, id); return { id };
}
async function supervise(requestFile) {
  const request = read(requestFile), dir = path.dirname(requestFile);
  const launch = { id: request.id, job_id: request.job_id, nonce: request.nonce, pid: process.pid, identity: identity(process.pid, request.pwsh) };
  const log = path.join(dir, 'output.log');
  let fd = fs.openSync(log, 'a'), bytes = fs.fstatSync(fd).size;
  const append = chunk => {
    if (bytes + chunk.length > 8 * 1024 * 1024) {
      fs.closeSync(fd);
      const prior = log + '.1'; if (fs.existsSync(prior)) fs.unlinkSync(prior);
      fs.renameSync(log, prior); fd = fs.openSync(log, 'a'); bytes = 0;
    }
    fs.writeSync(fd, chunk); bytes += chunk.length;
  };
  const command = spawn(request.executable, request.args, { cwd: request.cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  command.stdout.on('data', append); command.stderr.on('data', append);
  let error;
  command.on('error', e => { error = e.message; });
  if (command.pid) {
    const birth = identity(command.pid, request.pwsh);
    if (birth) launch.child = { pid: command.pid, identity: birth };
  }
  write(path.join(dir, 'launch.json'), launch);
  const code = await new Promise(resolve => { command.once('close', resolve); });
  fs.closeSync(fd);
  write(path.join(dir, 'status.json'), { id: request.id, job_id: request.job_id, nonce: request.nonce, exit_code: code, ended_at: new Date().toISOString(), ...(error ? { error } : {}) });
}
function release(file, id) {
  const { root } = layout(file), slot = path.join(root, 'active.json');
  if (fs.existsSync(slot) && read(slot).id === id) fs.unlinkSync(slot);
}
module.exports = { identity, killOwned, inspect, wait, start, enqueue, activate, release, contained };
if (require.main === module) {
  const action = process.argv[2], input = process.argv[3];
  const run = action === '--start' ? enqueue(process.env.CODEX_EXECUTOR_BACKGROUND_JOB, input).then(value => console.log('[CODEX_BACKGROUND_WAIT]\n' + JSON.stringify(value))) : action === '--supervise' ? supervise(input) : Promise.reject(new Error('Unknown background action'));
  run.catch(e => { if (action === '--supervise') { try { fs.writeFileSync(path.join(path.dirname(input), 'startup-error.txt'), e.stack, 'utf8'); } catch {} } console.error(e.stack); process.exitCode = 1; });
}
