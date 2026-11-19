'use strict';
// A bridge-owned supervisor, not a second model session. Metadata paths are
// job-owned; command cwd may be external. Handoffs never supply a PID to kill.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { ProcessQuery } = require('./process-query.cjs');
const idPattern = /^[a-f0-9]{24}$/;
function observationError(message) {
  const error = new Error(message);
  // Explicit policy denials require intervention, rather than automatic retry.
  if (!/blocked by policy|rejected:|execution policy/i.test(message)) error.code = 'BACKGROUND_OBSERVATION_UNAVAILABLE';
  return error;
}
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
async function identity(pid, pwsh, query) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned process ID');
  if (process.platform !== 'win32') {
    try { return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[19]; }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  const own = !query; query ||= new ProcessQuery(pwsh);
  try { return (await query.request({ op: 'inspect', pids: [pid] })).items[0].identity; }
  catch (e) { throw observationError('Cannot verify owned process identity: ' + e.message); }
  finally { if (own) query.close(); }
}
async function killOwned(record, pwsh, query) {
  if (process.platform === 'win32') {
    const own = !query; query ||= new ProcessQuery(pwsh);
    try { return await query.request({ op: 'kill', ...record }); }
    catch (e) { const error = observationError('Cannot confirm owned process termination: ' + e.message); error.termination_unknown = true; throw error; }
    finally { if (own) query.close(); }
  }
  if (await identity(record.pid, pwsh) !== record.identity) return { requested: false, reason: 'Owned process exited or identity changed' };
  try { process.kill(-record.pid, 'SIGTERM'); return { requested: true }; }
  catch (e) { return { requested: false, error: e.message }; }
}
async function inspect(file, id, { verifyProcess = true, query } = {}) {
  if (!idPattern.test(id || '')) throw new Error('Invalid controlled background ID');
  const { job, root } = layout(file), dir = contained(root, path.join(root, id));
  const launch = read(contained(dir, path.join(dir, 'launch.json')));
  if (launch.job_id !== job.job_id || launch.id !== id || !/^[a-f0-9]{48}$/.test(launch.nonce || '') ||
      !Number.isSafeInteger(launch.pid) || launch.pid <= 0 || !/^\d+$/.test(launch.identity || '')) throw new Error('Invalid owned background registration');
  const requestFile = contained(dir, path.join(dir, 'request.json')), request = read(requestFile);
  if (request.id !== id || request.job_id !== job.job_id || request.nonce !== launch.nonce) throw new Error('Background registration does not match launch request');
  if (launch.child && (!Number.isSafeInteger(launch.child.pid) || launch.child.pid <= 0 || !/^\d+$/.test(launch.child.identity || ''))) throw new Error('Invalid owned child registration');
  let observed = null;
  if (verifyProcess && process.platform === 'win32') {
    const own = !query; query ||= new ProcessQuery(job.settings.pwsh);
    try { observed = (await query.request({ op: 'inspect', pids: [launch.pid, ...(launch.child ? [launch.child.pid] : [])] })).items; }
    catch (e) { throw observationError('Cannot verify owned processes: ' + e.message); }
    finally { if (own) query.close(); }
    const supervisor = observed[0], child = observed[1];
    if (!supervisor || (launch.child && !child)) throw observationError('Owned process details temporarily unavailable');
    if (supervisor.identity === launch.identity && (supervisor.executable?.toLowerCase() !== process.execPath.toLowerCase() ||
        !supervisor.command?.toLowerCase().includes(__filename.toLowerCase()) || !supervisor.command?.includes('--supervise') ||
        !supervisor.command?.toLowerCase().includes(requestFile.toLowerCase()))) throw new Error('PID is not this job owned supervisor');
    if (child && child.identity === launch.child.identity && (child.parent !== launch.pid || child.executable?.toLowerCase() !== request.executable.toLowerCase())) throw new Error('PID is not this supervisor owned command');
  }
  const log = contained(dir, path.join(dir, 'output.log'));
  const statusFile = path.join(dir, 'status.json');
  let status = null;
  if (fs.existsSync(statusFile)) {
    status = read(contained(dir, statusFile));
    if (status.id !== id || status.nonce !== launch.nonce || status.job_id !== job.job_id ||
        !(status.exit_code === null || Number.isInteger(status.exit_code)) || !Number.isFinite(Date.parse(status.ended_at))) throw new Error('Invalid owned completion record');
  }
  return { job, dir, launch, log, statusFile, status, observed, processVerified: verifyProcess, observation_error: launch.child_observation_error || null };
}
function logTail(file) {
  const fd = fs.openSync(file, 'r');
  try { const size = fs.fstatSync(fd).size, bytes = Buffer.alloc(Math.min(size, 8000)); fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length)); return bytes.toString('utf8'); }
  finally { fs.closeSync(fd); }
}
async function wait(file, id, { timeoutMs, intervalMs = 60000, onCheck = () => {}, activated } = {}) {
  // activate() may return an immutable registration with OS verification pending.
  // Complete that verification before observation or termination adopts the process.
  const initial = activated || await inspect(file, id, { verifyProcess: false }), started = Date.now(), deadline = timeoutMs == null ? null : started + timeoutMs;
  let processVerified = initial.processVerified === true;
  const pwsh = initial.job.settings.pwsh;
  const query = process.platform === 'win32' ? new ProcessQuery(pwsh) : null;
  return new Promise((resolve, reject) => {
    let timer, deadlineTimer, completionWatcher, cancelWatcher, done = false, checking = false, terminating = false, recheck = false, lastCheck = 0, watchError = null;
    const schedule = () => { clearTimeout(timer); timer = setTimeout(check, Math.max(1, Math.min(intervalMs, deadline === null ? intervalMs : deadline - Date.now(), 2147483647))); };
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(deadlineTimer); completionWatcher?.close(); cancelWatcher?.close(); query?.close();
      error ? reject(error) : resolve({ id, ...result, elapsed_ms: Date.now() - started });
    };
    const collect = current => {
      if (!current.status) return false;
      onCheck({ id, at: new Date().toISOString(), process_alive: null, completed: true });
      const { status } = current;
      finish(null, { id, exit_code: status.exit_code, ended_at: status.ended_at, error: status.error || null, status_file: current.statusFile, log_file: current.log, output_tail: logTail(current.log) });
      return true;
    };
    const check = async () => {
      if (done) return;
      if (checking) { if (!terminating) { recheck = true; query?.fail(new Error('Observation interrupted by file event')); } return; }
      checking = true; lastCheck = Date.now();
      clearTimeout(timer);
      try {
        const current = await inspect(file, id, { verifyProcess: false }), { launch, status } = current;
        if (JSON.stringify(launch) !== JSON.stringify(initial.launch)) throw new Error('Owned registration changed while waiting');
        const cancelled = fs.existsSync(path.join(path.dirname(file), 'cancel'));
        const timedOut = deadline !== null && Date.now() >= deadline;
        if (cancelled || timedOut) {
          if (collect(current)) return;
          let termination;
          try {
            if (!processVerified) { await inspect(file, id, { query }); processVerified = true; }
            terminating = true;
            termination = await killOwned(launch, pwsh, query);
          }
          catch (e) { if (recheck || e.code !== 'BACKGROUND_OBSERVATION_UNAVAILABLE') throw e; termination = e.termination_unknown
            ? { requested: null, reason: 'Termination result unknown; no retry requested', observation_error: e.message }
            : { requested: false, reason: 'Process ownership could not be confirmed; no termination requested', observation_error: e.message }; }
          // If the supervisor crashed, only its separately registered child can
          // be stopped, and only after verifying that child's start identity.
          if (!termination.requested && launch.child && !status && !termination.observation_error) {
            try { termination.child = await killOwned(launch.child, pwsh, query); }
            catch (e) { if (e.code !== 'BACKGROUND_OBSERVATION_UNAVAILABLE') throw e; termination.child = { requested: e.termination_unknown ? null : false, observation_error: e.message, reason: e.termination_unknown ? 'Child termination result unknown; no retry requested' : 'Child ownership unconfirmed; no termination requested' }; }
          }
          if (!termination.requested && launch.child_observation_error && !status) termination.unconfirmed_child = 'Child birth identity was unavailable; its exit and termination remain unconfirmed';
          finish(null, { reason: cancelled ? 'cancelled' : 'timed_out', termination }); return;
        }
        if (collect(current)) return;
        const verified = await inspect(file, id, { query }); processVerified = true;
        if (JSON.stringify(verified.launch) !== JSON.stringify(initial.launch)) throw new Error('Owned registration changed while waiting');
        const supervisor = process.platform === 'win32' ? verified.observed[0].identity : await identity(launch.pid, pwsh);
        onCheck({ id, at: new Date().toISOString(), process_alive: supervisor === launch.identity, completed: false, observation_error: watchError || launch.child_observation_error || null });
        if (supervisor && supervisor !== launch.identity) {
          finish(new Error('Owned supervisor identity changed; refusing to adopt or kill reused PID')); return;
        }
        if (!supervisor) {
          if (launch.child_observation_error) throw observationError('Supervisor exited; child ownership and exit remain unconfirmed: ' + launch.child_observation_error);
          const child = launch.child && (process.platform === 'win32' ? verified.observed[1].identity : await identity(launch.child.pid, pwsh));
          if (child && child !== launch.child.identity) { finish(new Error('Owned command identity changed')); return; }
          if (!child) {
            // Process queries can outlive normal completion. Re-read owned
            // metadata before declaring that an exited supervisor left no result.
            const latest = await inspect(file, id, { verifyProcess: false });
            if (JSON.stringify(latest.launch) !== JSON.stringify(initial.launch)) throw new Error('Owned registration changed while waiting');
            if (collect(latest)) return;
            finish(null, { id, exit_code: null, error: 'Owned supervisor exited without a completion record', status_file: latest.statusFile, log_file: latest.log, output_tail: logTail(latest.log) }); return;
          }
        }
        schedule();
      } catch (e) {
        if (done || recheck) return;
        if (e.code !== 'BACKGROUND_OBSERVATION_UNAVAILABLE') { finish(e); return; }
        onCheck({ id, at: new Date().toISOString(), process_alive: null, completed: false, observation_error: e.message });
        schedule();
      } finally { checking = false; if (recheck && !done) { recheck = false; check(); } }
    };
    const watch = (dir, target) => {
      let watcher;
      try {
        watcher = fs.watch(dir, (_type, name) => {
          if ((!name || String(name) === target) && (fs.existsSync(path.join(dir, target)) || Date.now() - lastCheck >= intervalMs)) check();
        });
        watcher.on('error', e => { watcher.close(); watchError = 'File monitoring unavailable; periodic observation continues: ' + e.message; });
      } catch (e) { watchError = 'File monitoring unavailable; periodic observation continues: ' + e.message; }
      return watcher;
    };
    completionWatcher = watch(initial.dir, 'status.json'); cancelWatcher = watch(path.dirname(file), 'cancel');
    if (deadline !== null) deadlineTimer = setTimeout(check, Math.max(1, Math.min(deadline - Date.now(), 2147483647)));
    if (initial.observation_error) onCheck({ id, at: new Date().toISOString(), process_alive: null, completed: false, observation_error: initial.observation_error });
    check();
  });
}
async function enqueue(file, requestFile) {
  const { job, root } = layout(file);
  const request = read(contained(root, requestFile));
  if (!path.isAbsolute(request.executable || '') || !fs.statSync(request.executable).isFile() ||
      !Array.isArray(request.args) || request.args.length > 256 || request.args.some(a => typeof a !== 'string' || a.length > 32768)) throw new Error('Use an existing absolute executable and an argument array');
  // Command cwd is not an ownership boundary: authorized worktrees and shared
  // tools can live outside job.cwd. Only supervisor metadata stays contained.
  const requestedCwd = request.cwd === undefined ? job.cwd : request.cwd;
  if (typeof requestedCwd !== 'string' || !path.isAbsolute(requestedCwd)) throw new Error('Use an existing absolute working directory');
  const cwd = fs.realpathSync(requestedCwd);
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Use an existing absolute working directory');
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
  const inspectActivated = () => inspect(file, id, { verifyProcess: false });
  if (fs.existsSync(path.join(dir, 'launch.json'))) return inspectActivated();
  // A durable claim prevents replay if the worker crashes in the spawn/record
  // gap. Such an unknown startup requires inspection, never another spawn.
  fs.writeFileSync(path.join(dir, 'activation.json'), JSON.stringify({ worker_pid: process.pid, at: new Date().toISOString() }), { flag: 'wx' });
  const child = spawn(process.execPath, [__filename, '--supervise', requestFile], { detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env, CODEX_EXECUTOR_BACKGROUND_JOB: '' } });
  let spawnError; child.on('error', e => { spawnError = e; }); child.unref();
  for (let n = 0; n < 2000; n++) {
    if (spawnError) throw spawnError;
    if (fs.existsSync(path.join(dir, 'launch.json'))) return inspectActivated();
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
  const query = process.platform === 'win32' ? new ProcessQuery(request.pwsh) : null;
  let self;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { self = await identity(process.pid, request.pwsh, query); if (!self) throw observationError('Supervisor identity unavailable'); break; }
      catch (e) { if (e.code !== 'BACKGROUND_OBSERVATION_UNAVAILABLE' || attempt === 1) throw e; }
    }
  } catch (e) { query?.close(); throw e; }
  const launch = { id: request.id, job_id: request.job_id, nonce: request.nonce, pid: process.pid, identity: self };
  const log = path.join(dir, 'output.log');
  let fd;
  try {
  fd = fs.openSync(log, 'a'); let bytes = fs.fstatSync(fd).size;
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
  const completion = new Promise(resolve => { command.once('close', resolve); });
  if (command.pid) {
    try {
      const birth = await identity(command.pid, request.pwsh, query);
      if (birth) launch.child = { pid: command.pid, identity: birth };
    } catch (e) {
      if (e.code !== 'BACKGROUND_OBSERVATION_UNAVAILABLE') throw e;
      // Keep the real ChildProcess handle collecting completion. An unverified
      // child is deliberately not registered as a PID that another worker can kill.
      launch.child_observation_error = e.message;
    }
  }
  query?.close();
  write(path.join(dir, 'launch.json'), launch);
  const code = await completion;
  fs.closeSync(fd); fd = undefined;
  write(path.join(dir, 'status.json'), { id: request.id, job_id: request.job_id, nonce: request.nonce, exit_code: code, ended_at: new Date().toISOString(), ...(error ? { error } : {}) });
  } finally { query?.close(); if (fd !== undefined) fs.closeSync(fd); }
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
