'use strict';
// Native Antigravity sidecar. Filesystem events only; no polling and no model task.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Broker, config, terminal, read, save, alive, notificationEvents, publishNotification, latestProgress, chatAccess, commandPhase, takeFileClaim: takeClaim } = require('./server.cjs');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function originHook(payload, project) {
  const projects = typeof project === 'string' ? [{ project: fs.realpathSync(project) }] : project;
  return require('./router.cjs').bindOrigin(payload, projects);
}

function agentCall(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['agentapi', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exit_code: code }); });
  });
}
async function nativeSend(executable, recipient, message, call = agentCall) {
  // A failed preflight is definitely before sending; a failed send is not.
  let check;
  try { check = await call(executable, ['get-conversation-metadata', recipient]); }
  catch (error) { error.not_sent = true; throw error; }
  if (check.exit_code !== 0) throw Object.assign(new Error(`Host preflight exit=${check.exit_code}: ${check.stderr || check.stdout}`), { not_sent: true });
  const result = await call(executable, ['send-message', recipient, message]);
  if (result.exit_code === 0) return result;
  throw new Error(`agentapi exit=${result.exit_code}: ${result.stderr || result.stdout}`);
}
function recordedReceipt(directory, event) {
  if (!directory || !fs.existsSync(directory)) return false;
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.json'))) {
    try {
      const receipt = read(path.join(directory, name)), message = receipt.payload?.sendMessage;
      if (!receipt.error && message?.recipientId === event.conversation_id && message.content?.includes(`[CODEX_EVENT ${event.job_id}]`) && (event.schema !== 2 || message.content.includes(`event_id=${event.event_id} `))) return true;
    } catch { /* Ignore unrelated/partially written host records. */ }
  }
  return false;
}
function eventMessage(job, event) {
  const link = event.chat || chatAccess(job.thread_id);
  const action = event.kind === 'notification_check' ? `这是通知链路验收，只回复“通知已收到 event_id=${event.event_id}”并展示查看入口；不调用任何工具、不执行或续跑业务任务。` : event.kind === 'terminal' || !event.schema
    ? `请只调用一次 codex_result(job_id=${job.job_id}) 领取原结果并验收；不要重复派发。`
    : '这是执行中的状态变化，请简短展示进度与查看入口，不调用 codex_run、不轮询、不把进度当成完成。';
  return `[CODEX_EVENT ${job.job_id}] event_id=${event.event_id || job.job_id + ':legacy'} sequence=${event.sequence || 0} 事项=${JSON.stringify(job.topic || job.topic_id)}，topic_id=${job.topic_id}，状态=${event.status}，事件=${event.kind || 'terminal'}。${event.detail || ''}\n${link ? `[在 Codex 聊天窗查看完整任务](${link.vscode_uri})\n` : ''}这是后台事件，不是新的用户任务。${action} CLI 执行结束、通知送达与业务验收是不同状态。`;
}
function claimHost(data, generation) {
  const file = path.join(data, 'notification-host.json'), release = takeClaim(file + '.claim');
  if (!release) throw new Error('Notification host ownership is being changed');
  try {
    const previous = fs.existsSync(file) ? read(file) : null;
    if (previous?.generation === generation && alive(previous.pid)) throw Object.assign(new Error('A notifier already owns this host generation'), { duplicate: true });
    const host = { pid: process.pid, instance: crypto.randomUUID(), generation, started_at: new Date().toISOString(), build: process.env.CODEX_EXECUTOR_BUILD || null };
    save(file, host);
    return { host, owns: () => { try { return read(file).instance === host.instance; } catch { return false; } } };
  } finally { release(); }
}
async function deliverEvent(job, event, deliveryFile, send, options) {
  if (event.job_id !== job.job_id || !uuid(event.conversation_id) || event.conversation_id !== job.conversation_id || event.topic_id !== job.topic_id) throw new Error('Notice identity mismatch');
  const release = takeClaim(deliveryFile + '.claim'); if (!release) return false;
  try {
    const previous = fs.existsSync(deliveryFile) ? read(deliveryFile) : null;
    if (['sent', 'accepted', 'superseded'].includes(previous?.state)) return false;
    if (['sending', 'uncertain'].includes(previous?.state)) {
      if (await options.reconcile?.(event)) { save(deliveryFile, { ...previous, state: 'accepted', reconciled_at: new Date().toISOString() }); return false; }
      save(deliveryFile, { ...previous, state: 'uncertain', action_required: 'No positive host receipt. Inspect recipient history before explicitly replaying; automatic replay is disabled.' }); return false;
    }
    if (options.owns && !options.owns()) return false;
    const generation = options.generation || null;
    const attempts = previous?.generation === generation ? previous.attempts || 0 : 0;
    if (previous?.state === 'not_sent' && attempts >= 4) return false;
    const state = { event_id: event.event_id || job.job_id + ':legacy', job_id: job.job_id, conversation_id: job.conversation_id, sequence: event.sequence || 0, state: 'sending', sender_pid: process.pid, generation, attempts: attempts + 1, created_at: new Date().toISOString() };
    save(deliveryFile, state);
    try {
      const result = await send(job.conversation_id, eventMessage(job, event));
      save(deliveryFile, { ...state, state: 'accepted', result }); return true;
    } catch (error) {
      if (await options.reconcile?.(event)) { save(deliveryFile, { ...state, state: 'accepted', reconciled_at: new Date().toISOString(), warning: error.message }); return true; }
      save(deliveryFile, { ...state, state: error.not_sent === true ? 'not_sent' : 'uncertain', error: error.message }); throw error;
    }
  } finally { release(); }
}
async function deliver(broker, id, send, options = {}) {
  const job = broker.get(id), dir = path.dirname(broker.jobPath(id)), events = notificationEvents(broker.jobPath(id));
  const newer = fs.readdirSync(broker.jobs).filter(n => /^[a-f0-9]{24}$/.test(n) && n !== id).some(n => {
    try { const next = read(broker.jobPath(n)); return next.topic_id === job.topic_id && next.conversation_id === job.conversation_id && next.created_at > job.created_at; } catch { return false; }
  });
  if (newer) return false; // A continuation supersedes old progress/terminal notices, not the saved evidence.
  if (!events.length) {
    const file = path.join(dir, 'notice.json'); if (!fs.existsSync(file)) return false;
    const notice = read(file);
    if (!terminal.has(job.status) || notice.status !== job.status) throw new Error('Notice identity mismatch');
    return deliverEvent(job, notice, path.join(dir, 'delivery.json'), send, options);
  }
  let sent = false;
  const last = events.at(-1);
  for (const event of events) {
    const file = event.file.replace(/\.json$/, '.delivery.json');
    // A quick task can finish before the debounce; show one final receipt, not stale running alerts.
    if (event !== last && (last.kind === 'terminal' || (event.kind === 'started' && last.kind === 'session_ready')) && (!fs.existsSync(file) || read(file).state === 'not_sent')) { save(file, { state: 'superseded', event_id: event.event_id, superseded_by: last.event_id }); continue; }
    sent = await deliverEvent(job, event, file, send, options) || sent;
  }
  return sent;
}
function watch(broker, send, options = {}) {
  const pending = new Set(), timers = new Map(), retries = new Map(), offsets = new Map(); let draining = false, closed = false;
  const schedule = (id, delay = 300, urgent = false) => {
    if (closed) return;
    if (timers.has(id) && !urgent) return; // A busy log stream cannot postpone a progress event indefinitely.
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); pending.add(id); void drain(); }, delay));
  };
  const adaptLegacy = id => {
    const job = broker.get(id); if (job.notification_schema === 2 || !job.conversation_id) return;
    if (terminal.has(job.status)) {
      if (notificationEvents(broker.jobPath(id)).some(e => ['recovered', 'progress'].includes(e.kind))) publishNotification(broker.jobPath(id), job, 'terminal', 'terminal', job.error || '原执行轮次已结束，通知服务已恢复。');
      return;
    }
    publishNotification(broker.jobPath(id), job, `recovered-${options.generation || 'local'}`, 'recovered', '通知服务已恢复，沿用原任务与原会话，没有重新执行。');
    const file = path.join(path.dirname(broker.jobPath(id)), 'events.jsonl'); if (!fs.existsSync(file)) return;
    const stat = fs.statSync(file), offset = offsets.get(id) ?? stat.size;
    offsets.set(id, stat.size);
    if (stat.size > offset) {
      const progress = latestProgress(file);
      if (progress?.item_type === 'command_execution' && commandPhase(progress.command)) publishNotification(broker.jobPath(id), job, `legacy-${progress.item_id}-${progress.event_type}`, 'progress', `${commandPhase(progress.command)}状态变化：${progress.event_type}。`);
    }
  };
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const id of pending) {
        pending.delete(id);
        if (closed || (options.owns && !options.owns())) { close(); break; }
        try { adaptLegacy(id); await deliver(broker, id, send, options); }
        catch (error) {
          process.stderr.write(`${id}: ${error.message}\n`);
          const delays = options.retryDelays || [2000, 10000, 30000];
          if (error.not_sent && (retries.get(id) || 0) < delays.length) { const n = retries.get(id) || 0; retries.set(id, n + 1); schedule(id, delays[n]); }
        }
      }
    } finally { draining = false; }
  };
  const watcher = fs.watch(broker.jobs, { recursive: true }, (_event, name) => {
    if (!name) return;
    const parts = String(name).split(/[\\/]/);
    if (/^[a-f0-9]{24}$/.test(parts[0]) && ((parts.length === 2 && ['notice.json', 'job.json', 'events.jsonl'].includes(parts[1])) || (parts.length === 3 && parts[1] === 'notifications' && /^\d{8}\.json$/.test(parts[2])))) {
      let urgent = parts[1] === 'notice.json';
      if (parts[1] === 'notifications') { try { urgent = read(path.join(broker.jobs, String(name))).kind === 'terminal'; } catch {} }
      schedule(parts[0], urgent ? 0 : 300, urgent);
    }
  });
  // Subscribe before recovery scan, so completion during startup cannot be missed.
  for (const name of fs.readdirSync(broker.jobs)) if (/^[a-f0-9]{24}$/.test(name)) pending.add(name);
  const close = () => { closed = true; watcher.close(); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); };
  void drain(); return { close, on: (...args) => { watcher.on(...args); } };
}
module.exports = { originHook, deliver, watch, nativeSend, agentCall, recordedReceipt, claimHost, eventMessage };
if (require.main === module) {
  if (process.argv[2] === '--origin-hook') {
    let input = '';
    process.stdin.setEncoding('utf8'); process.stdin.on('data', data => { input += data; });
    process.stdin.on('end', () => {
      try {
        let project = process.argv[3];
        if (project === '--config') {
          const entry = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).mcpServers['codex-executor'];
          const settings = config({ ...process.env, ...entry.env }); project = settings.projects || [settings];
        }
        process.stdout.write(JSON.stringify(originHook(JSON.parse(input), project)) + '\n');
      }
      catch (error) { process.stdout.write(JSON.stringify({ decision: 'deny', reason: `无法验证当前项目及任务身份，未执行：${error.message}` }) + '\n'); }
    });
  } else {
    try {
      if (!process.env.ANTIGRAVITY_LS_ADDRESS) throw new Error('Native sidecar host address is required; run through Antigravity, not a guessed endpoint');
      const executable = process.env.CODEX_EXECUTOR_AGENTAPI;
      if (!executable || !fs.existsSync(executable)) throw new Error('CODEX_EXECUTOR_AGENTAPI must identify the installed native language_server.exe');
      const settings = config(), projects = settings.projects || [settings];
      const generation = crypto.createHash('sha256').update(process.env.ANTIGRAVITY_LS_ADDRESS + '|' + (process.env.CODEX_EXECUTOR_BUILD || '')).digest('hex');
      const owner = claimHost(settings.data, generation);
      const eventDirectory = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ? path.resolve(process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR, '../events') : null;
      const watchers = projects.map(p => watch(new Broker(p), (recipient, message) => nativeSend(executable, recipient, message), { generation, owns: owner.owns, reconcile: event => recordedReceipt(eventDirectory, event) }));
      save(path.join(settings.data, 'notification-host.json'), { ...owner.host, projects: projects.map(p => p.project), watcher_count: watchers.length });
      const ownership = fs.watch(settings.data, (_event, name) => { if (String(name) === 'notification-host.json' && !owner.owns()) { for (const w of watchers) w.close(); ownership.close(); } });
      for (const watcher of watchers) watcher.on('error', error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; for (const w of watchers) w.close(); });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const w of watchers) w.close(); ownership.close(); });
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = error.duplicate ? 0 : 1; }
  }
}
