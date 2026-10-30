'use strict';
// Native Antigravity sidecar. Filesystem events only; no polling and no model task.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Broker, config, terminal } = require('./server.cjs');
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
function originHook(payload, project) {
  const projects = typeof project === 'string' ? [{ project: fs.realpathSync(project) }] : project;
  return require('./router.cjs').bindOrigin(payload, projects);
}

function nativeSend(executable, recipient, message) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['agentapi', 'send-message', recipient, message], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr, exit_code: code }) : reject(new Error(`agentapi exit=${code}: ${stderr || stdout}`)); });
  });
}
async function deliver(broker, id, send) {
  const job = broker.get(id), dir = path.dirname(broker.jobPath(id));
  const noticeFile = path.join(dir, 'notice.json'), deliveryFile = path.join(dir, 'delivery.json');
  if (!fs.existsSync(noticeFile)) return false;
  const notice = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
  if (!terminal.has(job.status) || notice.status !== job.status || notice.job_id !== id || !uuid(notice.conversation_id) || notice.conversation_id !== job.conversation_id || notice.topic_id !== job.topic_id) throw new Error('Notice identity mismatch');
  const state = { job_id: id, conversation_id: job.conversation_id, state: 'sending', created_at: new Date().toISOString() };
  try { fs.writeFileSync(deliveryFile, JSON.stringify(state) + '\n', { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  const message = `[CODEX_EVENT ${id}] 事项=${JSON.stringify(job.topic || job.topic_id)}，topic_id=${job.topic_id}，状态=${notice.status}。这是后台事件，不是新的用户任务。请立即调用一次 codex_result(job_id=${id}) 领取原结果并验收；需要选择或逻辑修正时在原事项内干预，授权不足再询问用户。不要重派、轮询、重复报告其他事项，也不能把 CLI 完成当作业务验收通过。`;
  try {
    const result = await send(job.conversation_id, message);
    fs.writeFileSync(deliveryFile, JSON.stringify({ ...state, state: 'sent', result }) + '\n', 'utf8');
    return true;
  } catch (error) {
    // Delivery may already have reached the host: never blindly send again and spend another turn.
    fs.writeFileSync(deliveryFile, JSON.stringify({ ...state, state: 'uncertain', error: error.message }) + '\n', 'utf8');
    throw error;
  }
}
function watch(broker, send) {
  const pending = new Set(); let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    try {
      for (const id of pending) {
        pending.delete(id);
        try { await deliver(broker, id, send); }
        catch (error) { process.stderr.write(`${id}: ${error.message}\n`); }
      }
    } finally { draining = false; }
  };
  const watcher = fs.watch(broker.jobs, { recursive: true }, (_event, name) => {
    if (!name) return;
    const parts = String(name).split(/[\\/]/);
    if (parts.length === 2 && /^[a-f0-9]{24}$/.test(parts[0]) && parts[1] === 'notice.json') { pending.add(parts[0]); void drain(); }
  });
  // Subscribe before recovery scan, so completion during startup cannot be missed.
  for (const name of fs.readdirSync(broker.jobs)) if (/^[a-f0-9]{24}$/.test(name)) pending.add(name);
  void drain(); return watcher;
}
module.exports = { originHook, deliver, watch, nativeSend };
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
      const watchers = projects.map(p => watch(new Broker(p), (recipient, message) => nativeSend(executable, recipient, message)));
      fs.writeFileSync(path.join(settings.data, 'notification-host.json'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), build: process.env.CODEX_EXECUTOR_BUILD || null, projects: projects.map(p => p.project), watcher_count: watchers.length }) + '\n', 'utf8');
      for (const watcher of watchers) watcher.on('error', error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; for (const w of watchers) w.close(); });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const w of watchers) w.close(); });
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
  }
}
