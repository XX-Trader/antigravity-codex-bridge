#!/usr/bin/env node
'use strict';

// Local stdio MCP adapter. Codex remains a separate CLI process and owns execution.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'needs_input', 'blocked']);
const capacityMessage = 'Selected model is at capacity. Please try a different model';
const isCapacity = message => typeof message === 'string' && message.trim().replace(/\.$/, '') === capacityMessage;
const VERSION = require('../package.json').version;
const efforts = new Set(['low', 'medium', 'high']);
const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];
function selectedModel(value, aliases = {}) {
  const valid = model => typeof model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model);
  if (!valid(value)) throw new Error('model must be a model ID or configured alias');
  const resolved = Object.hasOwn(aliases, value) ? aliases[value] : value;
  if (!valid(resolved)) throw new Error('Configured model alias must resolve to a model ID');
  return resolved;
}

function capacityRetryAt(attempts, now = Date.now()) {
  const hour = 3600000;
  const starts = attempts.map(x => Date.parse(x.started_at)).filter(Number.isFinite).sort((a, b) => a - b);
  const recent = starts.filter(t => t > now - hour);
  return Math.max(now, (starts.at(-1) || now) + hour / 6, recent.length >= 6 ? recent[recent.length - 6] + hour + 1 : now);
}
function capacityDelay(until, dir) {
  return new Promise((resolve, reject) => {
    let watcher, timer, done = false;
    const finish = error => { if (done) return; done = true; watcher?.close(); clearTimeout(timer); error ? reject(error) : resolve(!fs.existsSync(path.join(dir, 'cancel'))); };
    watcher = fs.watch(dir, (_event, name) => { if ((!name || String(name) === 'cancel') && fs.existsSync(path.join(dir, 'cancel'))) finish(); });
    watcher.on('error', finish);
    timer = setTimeout(finish, Math.max(0, until - Date.now()));
    if (fs.existsSync(path.join(dir, 'cancel'))) finish();
  });
}
const stamp = () => new Date().toISOString();
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) throw error;
      // Windows scanners/readers can briefly prevent replacement; retry publication, not the task.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}
function createOnce(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try { fs.linkSync(tmp, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { fs.unlinkSync(tmp); }
}
function takeFileClaim(file) {
  const nonce = crypto.randomUUID(), name = `${process.pid}-${nonce}.json`;
  const prepared = `${file}.${process.pid}.${nonce}.tmp`;
  const removeOwner = owner => {
    try { fs.unlinkSync(path.join(file, owner)); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    try { fs.rmdirSync(file); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    return true;
  };
  fs.mkdirSync(prepared); fs.writeFileSync(path.join(prepared, name), JSON.stringify({ pid: process.pid, nonce }), { flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { fs.renameSync(prepared, file); return () => removeOwner(name); }
      catch (error) {
        if (!['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error;
        let owners; try { owners = fs.readdirSync(file).filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n)); } catch { return null; }
        if (owners.length !== 1) return null; // Empty means another process is publishing its owner, not an expired lock.
        let previous; try { previous = read(path.join(file, owners[0])); } catch { return null; }
        if (alive(previous.pid)) return null;
        if (!removeOwner(owners[0])) return null;
      }
    }
    return null;
  } finally { if (fs.existsSync(prepared)) { fs.unlinkSync(path.join(prepared, name)); fs.rmdirSync(prepared); } }
}
// Durable events are independent of delivery. Short claims also serialize explicit diagnostics.
function notificationEvents(jobFile) {
  const dir = path.join(path.dirname(jobFile), 'notifications');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => /^\d{8}\.json$/.test(n)).sort().map(n => ({ ...read(path.join(dir, n)), file: path.join(dir, n) }));
}
function publishNotification(jobFile, job, key, kind, detail = '') {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(job.conversation_id || '')) return null;
  const dir = path.join(path.dirname(jobFile), 'notifications'); fs.mkdirSync(dir, { recursive: true });
  let release;
  for (let n = 0; n < 100 && !release; n++) { release = takeFileClaim(path.join(dir, '.publish.claim')); if (!release) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  if (!release) throw new Error('Notification publisher busy; no event overwritten');
  try {
    const events = notificationEvents(jobFile), existing = events.find(e => e.key === key);
    if (existing) return existing;
    const sequence = (events.at(-1)?.sequence || 0) + 1;
    const event = { schema: 2, event_id: `${job.job_id}:${sequence}`, sequence, key, kind, job_id: job.job_id, topic_id: job.topic_id, conversation_id: job.conversation_id, topic: job.topic, status: job.status, chat: chatAccess(job.thread_id), detail: String(detail).slice(0, 700), created_at: stamp() };
    const file = path.join(dir, String(sequence).padStart(8, '0') + '.json'); createOnce(file, event);
    return { ...event, file };
  } finally { release(); }
}
function notificationSummary(jobFile) {
  const dir = path.dirname(jobFile), events = notificationEvents(jobFile);
  const rows = events.map(event => {
    const delivery = event.file.replace(/\.json$/, '.delivery.json');
    return { event_id: event.event_id, sequence: event.sequence, kind: event.kind, ...(fs.existsSync(delivery) ? read(delivery) : { state: 'pending' }) };
  });
  const legacy = path.join(dir, 'delivery.json');
  if (!rows.length && fs.existsSync(legacy)) rows.push(read(legacy));
  const hostFile = process.env.CODEX_EXECUTOR_DATA && path.join(process.env.CODEX_EXECUTOR_DATA, 'notification-host.json');
  const host = hostFile && fs.existsSync(hostFile) ? read(hostFile) : null;
  return { latest: rows.at(-1) || null, pending: rows.filter(r => ['pending', 'not_sent'].includes(r.state)).length, uncertain: rows.filter(r => ['uncertain', 'sending'].includes(r.state)).length, service: { online: hostFile ? !!host && alive(host.pid) : null, build_matches: hostFile ? !!host && host.build === process.env.CODEX_EXECUTOR_BUILD : null }, note: 'accepted means host API accepted, not proof that the chat rendered or business checks passed. not_sent is retryable; uncertain needs receipt reconciliation, never blind replay.' };
}
function commandPhase(command = '') {
  if (/\b(?:cargo\s+clippy|clippy\b)/i.test(command)) return '静态检查';
  if (/\b(?:cargo\s+test|pytest|npm\s+(?:run\s+)?test|node\s+--test)\b/i.test(command)) return '测试';
  if (/\b(?:cargo\s+build|npm\s+run\s+build|cmake\s+--build)\b/i.test(command)) return '构建';
  if (/\bgit\s+(?:-\S+\s+)*commit\b/i.test(command)) return 'Git 提交';
  return null;
}
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
function childEnvironment(source = process.env) {
  const env = { ...source, CODEX_EXECUTOR_CHILD: '1' };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() !== '__COMPAT_LAYER') continue;
    const remaining = env[key].split(/\s+/).filter(flag => flag && !/^RunAsAdmin$/i.test(flag));
    if (remaining.length) env[key] = remaining.join(' ');
    else delete env[key];
  }
  return env;
}
function tail(file, bytes = 16000) {
  if (!fs.existsSync(file)) return '';
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const data = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, data, 0, data.length, Math.max(0, size - data.length));
    return data.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function config(env = process.env) {
  const project = fs.realpathSync(env.CODEX_EXECUTOR_PROJECT || process.cwd());
  const root = env.CODEX_EXECUTOR_DATA;
  if (!root || !path.isAbsolute(root) || !fs.existsSync(root)) throw new Error('CODEX_EXECUTOR_DATA must be an existing absolute runtime directory');
  const data = fs.realpathSync(root);
  const entry = env.CODEX_EXECUTOR_ENTRY;
  if (!entry || !path.isAbsolute(entry)) throw new Error('CODEX_EXECUTOR_ENTRY must name the absolute Codex executable or PowerShell entry point');
  if (!fs.existsSync(entry)) throw new Error(`Codex CLI entry does not exist: ${entry}`);
  const reasoning_effort = env.CODEX_EXECUTOR_REASONING_EFFORT || 'medium';
  if (!efforts.has(reasoning_effort)) throw new Error('reasoning_effort must be low, medium or high');
  const model_aliases = JSON.parse(env.CODEX_EXECUTOR_MODEL_ALIASES || '{}');
  if (!model_aliases || Array.isArray(model_aliases) || typeof model_aliases !== 'object' || Object.keys(model_aliases).length > 20) throw new Error('model aliases must be a JSON object with at most 20 entries');
  for (const key of Object.keys(model_aliases)) selectedModel(key, model_aliases);
  const service_tier = env.CODEX_EXECUTOR_SERVICE_TIER || null;
  if (service_tier !== null && service_tier !== 'fast') throw new Error('service tier must be fast or omitted to inherit Codex configuration');
  const settings = { project, data, entry, pwsh: env.CODEX_EXECUTOR_PWSH || 'pwsh.exe', model: env.CODEX_EXECUTOR_MODEL ? selectedModel(env.CODEX_EXECUTOR_MODEL, model_aliases) : null, model_aliases, reasoning_effort, service_tier, web_search: 'live' };
  if (env.CODEX_EXECUTOR_PROJECTS) {
    const projects = JSON.parse(env.CODEX_EXECUTOR_PROJECTS);
    if (!Array.isArray(projects) || !projects.length || projects.length > 20) throw new Error('Register 1..20 explicit project roots');
    if (projects.some(p => !p || typeof p.project !== 'string' || typeof p.data !== 'string' || !path.isAbsolute(p.project) || !path.isAbsolute(p.data))) throw new Error('Project/data roots must be explicit absolute paths');
    settings.projects = projects.map(p => config({ ...env, CODEX_EXECUTOR_PROJECTS: '', CODEX_EXECUTOR_PROJECT: p.project, CODEX_EXECUTOR_DATA: p.data }));
    const roots = new Set(settings.projects.map(p => p.project.toLowerCase()));
    const dataRoots = new Set(settings.projects.map(p => p.data.toLowerCase()));
    if (roots.size !== projects.length || dataRoots.size !== projects.length || !settings.projects.some(p => p.project === project)) throw new Error('Project roots/data must be unique and include the default project');
    if (settings.projects.some(a => path.parse(a.project).root === a.project || settings.projects.some(b => a !== b && inside(a.project, b.project)))) throw new Error('Do not register a drive root or overlapping projects');
  }
  return settings;
}

function nativeMetadata(settings, method, params) {
  // Local thread metadata only. Reap the owned process before returning to the caller.
  return new Promise((resolve, reject) => {
    const child = spawn(settings.pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'invoke-codex.ps1'), '-AppServer', '-CodexEntry', settings.entry], { cwd: settings.project, windowsHide: true, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false, received = false, stderr = '', finalError, finalValue, shutdownTimer;
    const killOwned = () => {
      if (process.platform === 'win32' && child.pid) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill();
    };
    const finish = (error, value) => {
      if (settled || received) return;
      received = true; finalError = error; finalValue = value; clearTimeout(timer);
      child.stdin.end();
      shutdownTimer = setTimeout(killOwned, 2000);
    };
    const timer = setTimeout(() => { killOwned(); finish(new Error('Local Codex session metadata request timed out; no task submitted')); }, 20000);
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.stdin.on('error', error => { if (!received) finish(error); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(shutdownTimer);
      const error = finalError || (!received ? new Error(`Local metadata process exited ${code}: ${stderr}`) : null);
      error ? reject(error) : resolve(finalValue);
    });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (received) return;
      let reply; try { reply = JSON.parse(line); } catch { return; }
      if (reply.error) { finish(new Error(reply.error.message)); return; }
      if (reply.id === 0) { send({ method: 'initialized', params: {} }); send({ id: 1, method, params }); }
      if (reply.id === 1) finish(null, reply.result);
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'codex-executor-session-metadata', version: VERSION } } });
  });
}

function taskTitle(job) {
  const topic = typeof job.topic === 'string' ? job.topic.trim() : '';
  const raw = topic && topic !== '未命名事项' ? topic : (job.prompt || '').split(/\r?\n/).find(line => line.trim()) || 'Codex 任务';
  const title = raw.replace(/^\s*#{1,6}\s*/, '').replace(/\s+/g, ' ').trim();
  return Array.from(title).slice(0, 80).join('') || 'Codex 任务';
}
async function syncTaskTitle(job, metadataCall = nativeMetadata) {
  if (!chatAccess(job.thread_id)) return { status: 'pending', name: taskTitle(job) };
  if (job.resumed_session) return { status: 'preserved', name: job.chat_title?.name || null, reason: 'Externally owned session is not renamed' };
  const name = taskTitle(job);
  const reply = await metadataCall(job.settings, 'thread/read', { threadId: job.thread_id, includeTurns: false });
  const thread = reply.thread;
  if (!thread || thread.id !== job.thread_id || !thread.cwd || !inside(job.settings.project, fs.realpathSync(thread.cwd))) throw new Error('Title target is outside this registered project');
  if (thread.name && thread.name !== name && thread.name !== job.chat_title?.name) return { status: 'preserved', name: thread.name, thread_id: job.thread_id, reason: 'Existing user title is preserved' };
  if (thread.name !== name) await metadataCall(job.settings, 'thread/name/set', { threadId: job.thread_id, name });
  return { status: 'set', name, thread_id: job.thread_id };
}

function chatAccess(id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id)) return null;
  return {
    session_id: id,
    vscode_uri: `vscode://openai.chatgpt/local/${id}`,
    vscode_insiders_uri: `vscode-insiders://openai.chatgpt/local/${id}`,
    note: 'Open the saved native Codex chat, not a new task. After restarting VS Code, recover this same link with codex_list/codex_result. The extension may hide exec sessions from its history list. Do not send another turn while the bridge task is running.'
  };
}
function latestProgress(file) {
  const lines = tail(file, 24000).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let event; try { event = JSON.parse(lines[i]); } catch { continue; }
    const item = event.item;
    if (!item || !['agent_message', 'command_execution'].includes(item.type)) continue;
    const text = item.text || item.aggregated_output || '';
    return { event_type: event.type, item_type: item.type, ...(item.id ? { item_id: item.id } : {}),
      ...(item.command ? { command: item.command } : {}), text: text.slice(-2000), text_truncated: text.length > 2000,
      ...(item.exit_code !== undefined ? { exit_code: item.exit_code } : {}),
      note: 'Last persisted event, not a live heartbeat or proof that the task succeeded.' };
  }
  return null;
}
function toolResponse(value) {
  const content = [{ type: 'text', text: JSON.stringify(value) }];
  const rows = Array.isArray(value) ? value : Array.isArray(value?.sessions) ? value.sessions : [value];
  const seen = new Set();
  for (const row of rows) {
    const chat = row?.chat;
    if (chat && !seen.has(chat.session_id)) {
      seen.add(chat.session_id);
      content.push({ type: 'text', text: `[在 VS Code 的 Codex 聊天窗查看完整任务](${chat.vscode_uri})\n会话 ID：${chat.session_id}` });
    }
  }
  return { content, isError: false };
}

class Broker {
  constructor(settings, metadataCall = nativeMetadata) {
    this.settings = settings;
    this.metadataCall = metadataCall;
    this.jobs = path.join(settings.data, 'jobs');
    fs.mkdirSync(this.jobs, { recursive: true });
    this.lock = path.join(settings.data, 'active.lock');
  }
  jobPath(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid job_id');
    return path.join(this.jobs, id, 'job.json');
  }
  get(id) {
    const file = this.jobPath(id);
    if (!fs.existsSync(file)) throw new Error('Unknown job_id');
    let job = read(file);
    const crashFile = path.join(path.dirname(file), 'worker-error.txt');
    if (!terminal.has(job.status) && (fs.existsSync(crashFile) || (Date.now() - Date.parse(job.created_at) > 15000 && !alive(job.worker_pid)))) {
      // Never unlock an orphaned, still-running Codex process to start a second writer.
      if (alive(job.child_pid)) return { ...job, status: 'orphaned', error: 'Worker exited but Codex may still run; inspect this owned job before retrying' };
      job = { ...job, status: 'failed', error: fs.existsSync(crashFile) ? tail(crashFile, 4000) : 'Worker exited before recording completion', ended_at: stamp() };
      save(file, job);
      this.unlock(id);
    }
    return job;
  }
  unlock(id) {
    try {
      if (fs.statSync(this.lock).isDirectory()) {
        // A second completion/cancel path must not remove a newly acquired empty lease.
        try { fs.unlinkSync(path.join(this.lock, `${id}.json`)); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
        try { fs.rmdirSync(this.lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      } else if (read(this.lock).job_id === id) {
        // Compatibility with a completed pre-1.1 file lock; unlink cannot remove a new directory lease.
        try { fs.unlinkSync(this.lock); } catch (error) { if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error; }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  lockOwner() {
    try {
      if (!fs.statSync(this.lock).isDirectory()) return read(this.lock);
      const owner = fs.readdirSync(this.lock).find(name => /^[a-f0-9]{24}\.json$/.test(name));
      return owner ? { job_id: owner.slice(0, -5) } : { pending: true };
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  summary(job) {
    return { ...Object.fromEntries(['job_id', 'status', 'cwd', 'sandbox', 'thread_id', 'topic_id', 'topic', 'conversation_id', 'created_at', 'started_at', 'ended_at', 'exit_code', 'error', 'worker_pid', 'child_pid', 'parent_job_id', 'attempt', 'capacity_retry_at', 'execution_used_ms', 'chat_title', 'notification_error'].filter(k => job[k] !== undefined).map(k => [k, job[k]])), chat: chatAccess(job.thread_id), notification: job.job_id ? notificationSummary(this.jobPath(job.job_id)) : null, model: job.settings?.model || null, reasoning_effort: job.settings?.reasoning_effort || null, service_tier: job.settings?.service_tier || null, web_search: job.settings?.web_search || null, attempt_total: job.attempts?.length || 0, attempts: (job.attempts || []).slice(-6) };
  }
  start(input, resumption = null) {
    if (process.env.CODEX_EXECUTOR_CHILD === '1') throw new Error('Recursive Codex delegation is disabled');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 60000) throw new Error('prompt must contain 1..60000 characters');
    if (input.timeout_seconds !== undefined && (!Number.isInteger(input.timeout_seconds) || input.timeout_seconds < 30 || input.timeout_seconds > 14400)) throw new Error('timeout_seconds must be an integer in 30..14400');
    if (input.conversation_id !== undefined && (typeof input.conversation_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.conversation_id))) throw new Error('conversation_id must be an Antigravity UUID, not a Codex session id');
    if (input.topic_id !== undefined && (typeof input.topic_id !== 'string' || !/^[a-f0-9]{24}$/.test(input.topic_id))) throw new Error('Invalid topic_id; use a returned topic_id');
    if (input.topic !== undefined && (typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 120)) throw new Error('topic must contain 1..120 characters');
    if (input.wait !== undefined && typeof input.wait !== 'boolean') throw new Error('wait must be boolean');
    if (input.reasoning_effort !== undefined && !efforts.has(input.reasoning_effort)) throw new Error('reasoning_effort must be low, medium or high');
    if (input.model !== undefined) selectedModel(input.model, this.settings.model_aliases);
    const cwd = fs.realpathSync(input.cwd || this.settings.project);
    if (!fs.statSync(cwd).isDirectory() || !inside(this.settings.project, cwd)) throw new Error('cwd is outside the configured project');
    const sandbox = input.sandbox || 'danger-full-access';
    if (!sandboxModes.includes(sandbox)) throw new Error('sandbox must be read-only, workspace-write or danger-full-access');
    let parent;
    if (input.parent_job_id) {
      parent = this.get(input.parent_job_id);
      if (!terminal.has(parent.status) || !parent.thread_id) throw new Error('Parent must be finished and have a Codex thread_id');
      if (parent.cwd !== cwd) throw new Error('A continuation must retain its original cwd');
      if (input.topic_id && parent.topic_id && input.topic_id !== parent.topic_id) throw new Error('topic_id and selected session disagree');
    }
    const topicParent = input.topic_id ? this.list(Number.MAX_SAFE_INTEGER).find(job => job.topic_id === input.topic_id) : null;
    if (input.topic_id && !topicParent) throw new Error('Unknown topic_id; omit it to create a new matter');
    if (input.topic && (parent?.topic || topicParent?.topic) && input.topic.trim() !== (parent?.topic || topicParent?.topic)) throw new Error('A different matter needs a new topic, not an existing topic_id/session_id');
    const taskSettings = { ...this.settings, model: input.model !== undefined ? selectedModel(input.model, this.settings.model_aliases) : parent?.settings?.model || this.settings.model, reasoning_effort: input.reasoning_effort || parent?.settings?.reasoning_effort || this.settings.reasoning_effort || 'medium' };
    const owner = this.lockOwner();
    if (owner) {
      if (owner.pending) throw new Error('Project lease is being acquired; no new task submitted');
      const previous = this.get(owner.job_id);
      if (!terminal.has(previous.status)) throw new Error(`A task already owns this project: ${previous.job_id} (${previous.status}); query or cancel it, do not submit duplicates`);
      this.unlock(previous.job_id);
    }
    const id = crypto.randomBytes(12).toString('hex');
    const dir = path.dirname(this.jobPath(id));
    fs.mkdirSync(this.lock);
    try { fs.writeFileSync(path.join(this.lock, `${id}.json`), JSON.stringify({ job_id: id }), { flag: 'wx' }); }
    catch (error) { this.unlock(id); throw error; }
    try {
      fs.mkdirSync(dir);
      const job = {
        job_id: id, status: 'queued', created_at: stamp(), cwd, sandbox,
        prompt: input.prompt, timeout_seconds: input.timeout_seconds || 3600,
        settings: taskSettings, notification_schema: 2, topic_id: parent?.topic_id || input.topic_id || id, topic: parent?.topic || topicParent?.topic || input.topic?.trim() || taskTitle({ prompt: input.prompt }),
        ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
        ...(parent ? { parent_job_id: parent.job_id, thread_id: parent.thread_id, ...(parent.chat_title ? { chat_title: parent.chat_title } : {}) } : {}),
        ...(resumption ? { resumed_session: true, thread_id: resumption.id } : {})
      };
      save(path.join(dir, 'job.json'), job);
      const worker = spawn(process.execPath, [__filename, '--worker', path.join(dir, 'job.json')], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env
      });
      worker.on('error', error => {
        save(path.join(dir, 'job.json'), { ...job, status: 'failed', error: error.message, ended_at: stamp() });
        this.unlock(id);
      });
      worker.unref();
      return { ...this.summary(job), session_id: job.thread_id || null, next: 'Background task accepted; continue normal chat. The native sidecar pushes meaningful progress and a terminal/decision event to this chat. Progress includes the saved chat link: display it briefly without executing or polling. Only a terminal event needs codex_result once. Notification delivery state is distinct from task acceptance; never submit duplicates.' };
    } catch (error) { this.unlock(id); throw error; }
  }
  status(id) { return this.summary(this.get(id)); }
  async syncTitle(id, diagnostics = false) {
    const job = this.get(id);
    if (!terminal.has(job.status)) throw new Error('Title repair is only for finished tasks; a running worker owns its metadata');
    const chat_title = await syncTaskTitle(job, this.metadataCall);
    save(this.jobPath(id), { ...job, chat_title });
    return this.result(id, diagnostics);
  }
  result(id, diagnostics = false) {
    const job = this.get(id);
    const dir = path.dirname(this.jobPath(id));
    const receipt = this.receipt(id);
    return {
      ...this.summary(job), ...receipt,
      ...(diagnostics ? { events_tail: tail(path.join(dir, 'events.jsonl'), 12000), stderr_tail: tail(path.join(dir, 'stderr.log'), 8000) } : {}),
      paths: { job: this.jobPath(id), ...receipt.paths }
    };
  }
  receipt(id) {
    const job = this.get(id), dir = path.dirname(this.jobPath(id));
    const resultFile = path.join(dir, 'result.txt');
    const size = fs.existsSync(resultFile) ? fs.statSync(resultFile).size : 0;
    let usage = job.usage;
    if (!usage && terminal.has(job.status)) {
      for (const line of tail(path.join(dir, 'events.jsonl'), 32000).split('\n').reverse()) {
        try { const event = JSON.parse(line); if (event.type === 'turn.completed' && event.usage) { usage = event.usage; break; } } catch {}
      }
    }
    const receiptFile = path.join(dir, 'receipt.json');
    if (terminal.has(job.status) && !fs.existsSync(receiptFile)) createOnce(receiptFile, { ...this.summary(job), ...(job.conversation_id ? { conversation_id: job.conversation_id } : {}), ...(usage ? { usage } : {}), result_bytes: size, result_file: resultFile });
    return {
      job_id: id, status: job.status, sandbox: job.sandbox, cwd: job.cwd, session_id: job.thread_id || null, chat: chatAccess(job.thread_id), chat_title: job.chat_title || null, topic_id: job.topic_id || null, topic: job.topic || null,
      model: job.settings?.model || null, reasoning_effort: job.settings?.reasoning_effort || null, service_tier: job.settings?.service_tier || null, web_search: job.settings?.web_search || null, attempt_total: job.attempts?.length || 0, attempts: (job.attempts || []).slice(-6), ...(job.capacity_retry_at ? { capacity_retry_at: job.capacity_retry_at } : {}),
      ...(job.conversation_id ? { conversation_id: job.conversation_id } : {}),
      exit_code: job.exit_code ?? null, ...(job.error ? { error: job.error } : {}),
      final_response: tail(resultFile, 8000), result_truncated: size > 8000,
      progress: latestProgress(path.join(dir, 'events.jsonl')), notification: notificationSummary(this.jobPath(id)),
      ...(usage ? { usage } : {}),
      acceptance: 'CLI completion is not business acceptance; review the returned evidence.',
      paths: { receipt: path.join(dir, 'receipt.json'), result: resultFile, events: path.join(dir, 'events.jsonl'), stderr: path.join(dir, 'stderr.log') }
    };
  }
  knownSessions() {
    const sessions = new Map();
    for (const job of this.list(Number.MAX_SAFE_INTEGER)) {
      if (job.thread_id && !sessions.has(job.thread_id)) sessions.set(job.thread_id, { session_id: job.thread_id, chat: chatAccess(job.thread_id), title: job.chat_title?.name || taskTitle(job), job_id: job.job_id, topic_id: job.topic_id, topic: job.topic, model: job.model, reasoning_effort: job.reasoning_effort, service_tier: job.service_tier, cwd: job.cwd, sandbox: job.sandbox, status: job.status, updated_at: job.ended_at || job.created_at });
    }
    return [...sessions.values()];
  }
  async sessions(input = {}) {
    const limit = input.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Session page limit must be in 1..20');
    const known = this.knownSessions();
    if (input.include_native === false) return { sessions: known.slice(0, limit), next_cursor: null };
    const reply = await this.metadataCall(this.settings, 'thread/list', { cwd: this.settings.project, limit, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], useStateDbOnly: true, ...(input.cursor ? { cursor: input.cursor } : {}) });
    const byId = new Map(known.map(item => [item.session_id, item]));
    const merged = new Map((reply.data || []).map(item => [item.id, (byId.has(item.id) ? { ...byId.get(item.id), title: item.name || byId.get(item.id).title } : null) || { session_id: item.id, chat: chatAccess(item.id), cwd: item.cwd, title: (item.name || item.preview || '').slice(0, 100), status: item.status?.type || 'stored', source: 'native_codex' }]));
    for (const item of known) if (!merged.has(item.session_id)) merged.set(item.session_id, item);
    return { sessions: [...merged.values()].slice(0, limit), next_cursor: reply.nextCursor || null };
  }
  async run(input, signal) {
    let args = { ...input };
    let resumption;
    if (input.topic_id) {
      if (typeof input.topic_id !== 'string' || !/^[a-f0-9]{24}$/.test(input.topic_id)) throw new Error('Invalid topic_id');
      const latest = this.list(Number.MAX_SAFE_INTEGER).find(job => job.topic_id === input.topic_id);
      if (!latest) throw new Error('Unknown topic_id; omit it for a new matter');
      if (!terminal.has(latest.status)) throw new Error(`This matter is still running: ${latest.job_id}; continue normal chat, do not resubmit or poll`);
      if (input.session_id && input.session_id !== latest.thread_id) throw new Error('topic_id and selected session disagree');
      args = { ...args, ...(latest.thread_id ? { session_id: latest.thread_id } : {}), cwd: input.cwd || latest.cwd, sandbox: input.sandbox || 'danger-full-access' };
    }
    input = args;
    if (input.session_id) {
      let session = this.knownSessions().find(item => item.session_id === input.session_id);
      if (!session) {
        if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.session_id)) throw new Error('Invalid Codex session_id; use codex_sessions');
        const reply = await this.metadataCall(this.settings, 'thread/read', { threadId: input.session_id, includeTurns: false });
        const thread = reply.thread;
        if (!thread || thread.id !== input.session_id || !thread.cwd || !inside(this.settings.project, fs.realpathSync(thread.cwd))) throw new Error('Selected native session is outside the configured project');
        if (thread.status?.type === 'active') throw new Error('Selected native session is active; do not start a concurrent turn');
        resumption = thread;
        session = { cwd: fs.realpathSync(thread.cwd), sandbox: input.sandbox || 'danger-full-access' };
      }
      if (input.cwd && fs.realpathSync(input.cwd) !== session.cwd) throw new Error('Selected session belongs to a different cwd');
      args = { ...input, cwd: session.cwd, sandbox: input.sandbox || 'danger-full-access', ...(session.job_id ? { parent_job_id: session.job_id } : {}) };
    }
    if (signal?.aborted) throw new Error('Request cancelled; no task submitted');
    const job = this.start(args, resumption);
    return input.wait === true ? this.wait(job.job_id, signal) : job;
  }
  wait(id, signal) {
    // Only filesystem events and a single deadline: no model turns or status-tool polling.
    const initial = this.get(id);
    if (terminal.has(initial.status)) return Promise.resolve(this.receipt(id));
    return new Promise((resolve, reject) => {
      let watcher, timer, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; watcher?.close(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => finish(new Error(`Wait cancelled; task ${id} remains independent. Recover its receipt with codex_wait; do not resubmit.`));
      const check = () => {
        try { if (terminal.has(this.get(id).status)) finish(null, this.receipt(id)); }
        catch (error) { if (error.code !== 'ENOENT') finish(error); }
      };
      try {
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        watcher = fs.watch(path.dirname(this.jobPath(id)), (_event, name) => {
          if (!name || ['job.json', 'receipt.json', 'worker-error.txt'].includes(String(name))) check();
        });
        watcher.on('error', error => finish(error));
        const remaining = Math.max(30000, (initial.timeout_seconds || 3600) * 1000 + 30000 - (Date.now() - Date.parse(initial.created_at)));
        timer = setTimeout(() => finish(null, { ...this.receipt(id), wait_ended: true, next: 'Do not resubmit or schedule polling. Use codex_wait with this job_id to recover the same task.' }), remaining);
        check(); // Close the read/watch race without a polling loop.
      } catch (error) { finish(error); }
    });
  }
  cancel(id) {
    const job = this.get(id);
    if (terminal.has(job.status)) return this.summary(job);
    if (job.status === 'orphaned') throw new Error('Orphaned child requires manual process-identity inspection; no arbitrary PID termination');
    fs.writeFileSync(path.join(path.dirname(this.jobPath(id)), 'cancel'), stamp(), 'utf8');
    return { job_id: id, status: 'cancel_requested', next: 'Use codex_wait once only if cancellation confirmation is needed; no polling. Cancellation does not undo file edits.' };
  }
  list(limit = 20) {
    return fs.readdirSync(this.jobs).filter(id => /^[a-f0-9]{24}$/.test(id))
      .map(id => this.status(id)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
  }
}

async function worker(file, clock = { now: () => Date.now(), wait: capacityDelay }) {
  let job = read(file);
  const dir = path.dirname(file), broker = new Broker(job.settings);
  const events = fs.openSync(path.join(dir, 'events.jsonl'), 'a'), stderr = fs.openSync(path.join(dir, 'stderr.log'), 'a');
  let stopReason;
  const update = changes => { job = { ...job, ...changes }; save(file, job); };
  const finish = changes => { broker.unlock(job.job_id); update(changes); };
  const notify = (key, kind, detail) => {
    try { publishNotification(file, job, key, kind, detail); }
    catch (error) { update({ notification_error: error.message }); fs.writeSync(stderr, 'notification persistence: ' + error.message + '\n'); }
  };
  let naming = null;
  const updateTitle = () => {
    if (naming || !job.thread_id || job.resumed_session || ['set', 'preserved'].includes(job.chat_title?.status)) return;
    naming = syncTaskTitle(job).then(chat_title => update({ chat_title }), error => update({ chat_title: { status: 'failed', name: taskTitle(job), error: error.message } }));
  };
  let executionUsed = job.execution_used_ms || 0;
  try {
    update({ status: 'running', started_at: stamp(), worker_pid: process.pid, attempts: [] });
    notify('started', 'started', '已开始执行；这不是完成回执。');
    for (let attempt = 1; ; attempt++) {
      if (fs.existsSync(path.join(dir, 'cancel'))) { stopReason = 'cancelled'; break; }
      if (executionUsed >= job.timeout_seconds * 1000) { stopReason = 'timed_out'; break; }
      const started = clock.now(), deadline = Date.now() + job.timeout_seconds * 1000 - executionUsed;
      update({ attempt, status: 'running', capacity_retry_at: null });
      if (attempt > 1) notify(`resumed-${attempt}`, 'resumed', `原模型、原会话续跑，第 ${attempt} 次启动。`);
      fs.rmSync(path.join(dir, 'result.txt'), { force: true });
      fs.writeSync(events, JSON.stringify({ type: 'bridge.attempt', attempt, model: job.settings.model }) + '\n');
      let child, timer, killSent = false, turnCompleted = false, turnFailed = false, lastError = '', businessStarted = false, usage;
      const stop = reason => {
        if (killSent || !child || child.exitCode !== null) return;
        stopReason = reason; killSent = true;
        if (process.platform === 'win32') {
          const killer = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
          fs.writeSync(stderr, '\nowned-child cancellation: exit=' + killer.status + '\n' + (killer.stdout || '') + (killer.stderr || ''));
        } else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      };
      let outcome;
      try {
        child = spawn(job.settings.pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'invoke-codex.ps1'), '-RequestPath', file], {
          cwd: job.cwd, windowsHide: true, detached: process.platform !== 'win32', env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe']
        });
        update({ child_pid: child.pid }); child.stderr.on('data', data => fs.writeSync(stderr, data));
        const lines = readline.createInterface({ input: child.stdout });
        lines.on('line', line => {
          fs.writeSync(events, line + '\n');
          try {
            const event = JSON.parse(line);
            if (event.type === 'thread.started' && event.thread_id) { update({ thread_id: event.thread_id }); updateTitle(); notify('session', 'session_ready', '原生 Codex 会话已建立，可打开已保存的执行过程。'); }
            if (event.type === 'turn.completed') { turnCompleted = true; turnFailed = false; usage = event.usage; if (lastError) { update({ recovered_error: lastError }); lastError = ''; } }
            if (event.type === 'turn.failed' || event.type === 'error') { turnFailed = true; lastError = event.error?.message || event.message || ''; }
            if (['item.started', 'item.completed'].includes(event.type) && ['command_execution', 'file_change'].includes(event.item?.type)) businessStarted = true;
            if (event.item?.type === 'file_change' && event.type === 'item.completed') notify(`files-${attempt}`, 'files_changed', '已写入首批文件变更，仍需后续验证。');
            const phase = event.item?.type === 'command_execution' && commandPhase(event.item.command);
            if (phase && event.type === 'item.started') notify(`${phase}-${attempt}-start`, 'phase_started', `正在执行${phase}。`);
            if (phase && event.type === 'item.completed') notify(`${phase}-${attempt}-${event.item.id}`, 'phase_finished', `${phase}命令结束，退出码 ${event.item.exit_code ?? 'unknown'}；不代表整个任务验收完成。`);
          } catch { /* Keep unknown output verbatim; never classify a quoted tool result as a capacity failure. */ }
        });
        timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'cancel'))) stop('cancelled'); else if (Date.now() >= deadline) stop('timed_out'); }, 500);
        outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      } finally { clearInterval(timer); }
      const output = path.join(dir, 'attempt-' + attempt + '.result.txt');
      const successful = !stopReason && outcome.code === 0 && turnCompleted && !turnFailed && fs.existsSync(output);
      const capacity = !successful && !stopReason && isCapacity(lastError);
      const reportedUsage = { ...(job.usage || {}) };
      for (const [key, value] of Object.entries(usage || {})) if (typeof value === 'number') reportedUsage[key] = (reportedUsage[key] || 0) + value;
      update({ ...(usage ? { usage: reportedUsage } : {}), attempts: [...job.attempts, { attempt, started_at: new Date(started).toISOString(), model: job.settings.model, exit_code: outcome.code, capacity, ...(usage ? { usage } : {}), ...(lastError ? { error: lastError } : {}) }] });
      if (fs.existsSync(output)) fs.copyFileSync(output, path.join(dir, 'result.txt'));
      if (!capacity || businessStarted) executionUsed += Math.max(0, clock.now() - started);
      // Exact capacity message only: no lifetime retry cap, <=6 launches in a rolling hour.
      // Same model/thread; capacity-only downtime is excluded from the execution budget.
      if (naming) await naming;
      // One post-exit retry closes the startup/persistence race; never rerun the task for a title.
      if (job.chat_title?.status === 'failed' && !stopReason) { naming = null; updateTitle(); if (naming) await naming; }
      if (capacity && (!businessStarted || job.thread_id)) {
        const retryAt = capacityRetryAt(job.attempts, clock.now());
        update({ status: 'waiting_capacity', capacity_retry_at: new Date(retryAt).toISOString(), execution_used_ms: executionUsed });
        notify(`capacity-${attempt}`, 'waiting_capacity', `等待原模型容量；最早续跑时间 ${job.capacity_retry_at}。不会自动换模型。`);
        if (!await clock.wait(retryAt, dir)) { stopReason = 'cancelled'; break; }
        continue;
      }
      const final = tail(path.join(dir, 'result.txt'), 8000);
      const handoff = successful && final.startsWith('[CODEX_NEEDS_INPUT]') ? 'needs_input' : successful && final.startsWith('[CODEX_BLOCKED]') ? 'blocked' : null;
      finish({ status: stopReason || handoff || (successful ? 'completed' : 'failed'), execution_used_ms: executionUsed, exit_code: outcome.code, ended_at: stamp(), retrying_capacity: false,
        ...(!successful && !stopReason ? { error: lastError || 'Codex did not emit a successful turn.completed event' } : {}) });
      break;
    }
    if (stopReason && !terminal.has(job.status)) finish({ status: stopReason, capacity_retry_at: null, ended_at: stamp() });
  } catch (error) { finish({ status: 'failed', error: error.stack, ended_at: stamp() }); fs.writeSync(stderr, error.stack + '\n'); }
  finally {
    if (naming) await naming;
    fs.closeSync(events); fs.closeSync(stderr);
    if (terminal.has(job.status)) {
      broker.receipt(job.job_id);
      notify('terminal', 'terminal', job.error || '执行轮次已结束，请核对原结果与业务验收条件。');
      if (job.conversation_id) createOnce(path.join(dir, 'notice.json'), { job_id: job.job_id, topic_id: job.topic_id, conversation_id: job.conversation_id, status: job.status, created_at: stamp() });
    }
    broker.unlock(job.job_id);
  }
}

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const idSchema = { type: 'string', description: 'The exact job_id returned by codex_run or a prior bridge job' };
const tools = [
  { name: 'codex_run', description: 'Start one matter in an independent Codex session and return immediately by default, leaving Antigravity free for normal chat. Pass an available model ID or a locally configured alias when needed; otherwise inherit Codex configuration. Reasoning defaults to Medium. Reuse topic_id only for the same matter; another subject needs a new topic. No auto-upgrade, timers or polling. wait=true only if the user explicitly wants to wait.', inputSchema: object({ prompt: { type: 'string' }, topic: { type: 'string', maxLength: 120, description: 'Concrete execution task shown as the native Codex chat title, not a generic executor identity or the whole Antigravity conversation' }, topic_id: { type: 'string', description: 'Returned matter ID for same-topic continuation; omit for a different matter' }, model: { type: 'string', description: 'Available model ID or locally configured alias. Omit to inherit the configured Codex model; same-topic continuation retains an explicit prior choice.' }, reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default medium; do not increase automatically' }, wait: { type: 'boolean', default: false, description: 'False returns background acknowledgment. True waits for completion and can occupy this chat turn.' }, cwd: { type: 'string' }, sandbox: { type: 'string', enum: sandboxModes, default: 'danger-full-access', description: 'Full filesystem and command network access by default for these trusted projects. Narrow only when explicitly requested.' }, timeout_seconds: { type: 'integer', minimum: 30, maximum: 14400 }, session_id: { type: 'string', description: 'Exact Codex session ID, separate from Antigravity conversation_id; do not reuse it for an unrelated matter' }, conversation_id: { type: 'string', description: 'Optional actual originating Antigravity UUID. One chat may have many topic IDs; never invent an ID.' } }, ['prompt']) },
  { name: 'codex_wait', description: 'Wait for an already submitted job and collect its receipt once. Used after interruption, never submit the task again or schedule polling. Closing this wait does not cancel Codex.', inputSchema: object({ job_id: idSchema }, ['job_id']) },
  { name: 'codex_sessions', description: 'Read a small page of current-project local Codex session IDs and brief titles and clickable native chat links, including exec/app-server tasks, without calling a model or reading full conversations. Select an exact session_id for codex_run; this does not switch, submit or run anything.', inputSchema: object({ cwd: { type: 'string', description: 'Explicit registered project root; required for multi-folder Antigravity projects' }, include_native: { type: 'boolean', default: true }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }) },
  { name: 'codex_start', description: 'Delegate a concrete task to the real local Codex CLI. Returns immediately with job_id. Codex performs commands, edits and tests; do not submit duplicate jobs. Local saved Codex login is reused.', inputSchema: object({ prompt: { type: 'string', description: 'Goal, evidence/context, scope, constraints, acceptance checks and authorization boundaries' }, cwd: { type: 'string', description: 'Absolute working directory within the configured project; defaults to project root' }, sandbox: { type: 'string', enum: sandboxModes, default: 'danger-full-access' }, timeout_seconds: { type: 'integer', minimum: 30, maximum: 14400, default: 3600 } }, ['prompt']) },
  { name: 'codex_continue', description: 'Continue the exact Codex session of a finished job. Retains original cwd; the next turn defaults to full access unless explicitly narrowed. Never resumes an arbitrary most-recent thread.', inputSchema: object({ job_id: idSchema, prompt: { type: 'string' }, sandbox: { type: 'string', enum: sandboxModes, description: 'Explicit permission choice for the next turn only; omission defaults to danger-full-access' } }, ['job_id', 'prompt']) },
  { name: 'codex_status', description: 'Read persisted process state without waiting. completed means the CLI turn ended normally, not that acceptance checks passed; inspect codex_result evidence. A running job is not complete.', inputSchema: object({ job_id: idSchema }, ['job_id']) },
  { name: 'codex_result', description: 'Collect the original compact receipt once on a CODEX_EVENT or explicit result request. Return the native Codex chat link to the user for full saved history in VS Code, also after restart. Default codex_run returns only a background acknowledgment. No polling or duplicate reads; diagnostics=true is only for original log tails.', inputSchema: object({ job_id: idSchema, diagnostics: { type: 'boolean', default: false }, sync_title: { type: 'boolean', default: false, description: 'Explicitly repair the task title of a finished bridge-owned session. Preserves user-defined titles and never executes the task again.' } }, ['job_id']) },
  { name: 'codex_cancel', description: 'Ask the owned worker to terminate only its Codex child process tree. Does not roll back any edits. Wait for a terminal status before starting another job.', inputSchema: object({ job_id: idSchema }, ['job_id']) },
  { name: 'codex_list', description: 'Recover up to 20 recent jobs and native Codex chat links after restart. Show the returned clickable link to the user so they can view the saved full task in VS Code. Never rerun a job just to view it.', inputSchema: object({ cwd: { type: 'string', description: 'Current project root, to avoid listing unrelated projects' } }) }
];

function dispatch(broker, request, signal) {
  const { method, params = {} } = request;
  if (method === 'initialize') return { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion) ? params.protocolVersion : '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codex-executor', version: VERSION }, instructions: `Registered roots: ${(broker.settings?.projects || [broker.settings]).filter(Boolean).map(p => p.project).join(' ; ')}. Trusted-project executions default to danger-full-access and live web search. An explicit sandbox mode may be selected for a new turn, including upgrading a finished same-session continuation; never hot-change or resubmit a running task. Bind cwd to the current Antigravity project; never assume a different registered directory. Use codex_run once with a short topic and an available model ID or configured alias chosen for the task when needed. Default Medium and background acknowledgment; continue normal conversation without a waiting tool. Each unrelated matter gets its own topic/Codex session; reuse topic_id only for the same matter. A project-only identity hook binds the originating chat; a native sidecar delivers one terminal/decision event to that exact chat. On event read codex_result once and review evidence or intervene within authorization. When a user asks to view a task, show its returned chat.vscode_uri as a clickable Markdown link; codex_list recovers these links after restart. Do not claim exec tasks automatically appear in the extension history list. Opening history does not authorize a new turn. Exact capacity errors resume the same model/thread, at most six starts per rolling hour with no lifetime cap; scripts wait, not models. Same-project tasks remain serialized; busy means not submitted, not queued. No auto-upgrades, schedule/timer/status polling or unrelated-chat messages.` };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools };
  if (method !== 'tools/call') throw Object.assign(new Error(`Unknown method: ${method}`), { code: -32601 });
  try {
    const args = params.arguments || {};
    const response = toolResponse;
    const failure = error => ({ content: [{ type: 'text', text: error.message }], isError: true });
    if (params.name === 'codex_run') return broker.run(args, signal).then(response, failure);
    if (params.name === 'codex_wait') return broker.wait(args.job_id, signal).then(response, failure);
    if (params.name === 'codex_result' && args.sync_title === true) return broker.syncTitle(args.job_id, args.diagnostics === true).then(response, failure);
    if (params.name === 'codex_sessions') return broker.sessions(args).then(response, failure);
    let value;
    switch (params.name) {
      case 'codex_start': value = broker.start(args); break;
      case 'codex_continue': {
        const parent = broker.get(args.job_id);
        value = broker.start({ prompt: args.prompt, cwd: parent.cwd, sandbox: args.sandbox || 'danger-full-access', parent_job_id: args.job_id }); break;
      }
      case 'codex_status': value = broker.status(args.job_id); break;
      case 'codex_result': value = broker.result(args.job_id, args.diagnostics === true); break;
      case 'codex_cancel': value = broker.cancel(args.job_id); break;
      case 'codex_list': value = broker.list(20, args.cwd); break;
      default: throw new Error(`Unknown tool: ${params.name}`);
    }
    return toolResponse(value);
  } catch (error) { return { content: [{ type: 'text', text: error.message }], isError: true }; }
}

function serve(settings = config()) {
  const broker = settings.projects ? new (require('./router.cjs').ProjectRouter)(settings) : new Broker(settings);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const requests = new Map();
  const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  lines.on('line', async line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!request || typeof request.method !== 'string') { send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid Request' } }); return; }
    if (!Object.hasOwn(request, 'id')) {
      if (request.method === 'notifications/cancelled') requests.get(request.params?.requestId)?.abort();
      return;
    }
    const controller = new AbortController(); requests.set(request.id, controller);
    try { const result = await dispatch(broker, request, controller.signal); if (!controller.signal.aborted) send({ jsonrpc: '2.0', id: request.id, result }); }
    catch (error) { send({ jsonrpc: '2.0', id: request.id, error: { code: error.code || -32603, message: error.message } }); }
    finally { requests.delete(request.id); }
  });
  lines.on('close', () => { setImmediate(() => { for (const controller of requests.values()) controller.abort(); }); });
}

module.exports = { taskTitle, syncTaskTitle, latestProgress, chatAccess, nativeMetadata, toolResponse, worker, capacityRetryAt, isCapacity, capacityMessage, Broker, config, dispatch, tools, inside, read, save, terminal, childEnvironment, notificationEvents, publishNotification, notificationSummary, commandPhase, alive, takeFileClaim };
if (require.main === module) {
  if (process.argv[2] === '--worker') worker(process.argv[3]).catch(error => {
    try { fs.writeFileSync(path.join(path.dirname(process.argv[3]), 'worker-error.txt'), `${error.stack}\n`, 'utf8'); } catch {}
    process.stderr.write(`${error.stack}\n`); process.exitCode = 1;
  });
  else { try { serve(); } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; } }
}
