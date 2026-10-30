'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const argv = process.argv.slice(2);
const value = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const configFile = value('--config');
if (!configFile) throw new Error('Usage: node scripts/verify.cjs --config CONFIG [--sessions --project ROOT --local-only] [--smoke|--write-smoke] [--continue JOB_ID] [--receipt JOB_ID]');
const entry = JSON.parse(fs.readFileSync(configFile, 'utf8')).mcpServers?.['codex-executor'];
if (!entry) { console.log('codex_registered=false'); process.exit(0); }
const child = spawn(entry.command, entry.args || [], { windowsHide: true, env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] });
let seq = 0, stderr = '';
const pending = new Map();
child.stderr.on('data', data => { stderr += data; });
readline.createInterface({ input: child.stdout }).on('line', line => {
  const reply = JSON.parse(line), wait = pending.get(reply.id); if (!wait) return;
  pending.delete(reply.id); clearTimeout(wait.timer);
  reply.error ? wait.reject(new Error(JSON.stringify(reply.error))) : wait.resolve(reply.result);
});
child.on('error', error => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(error); } pending.clear(); });
child.on('close', code => { for (const wait of pending.values()) { clearTimeout(wait.timer); wait.reject(new Error('MCP closed: ' + code + '; ' + stderr)); } pending.clear(); });
function call(method, params = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const id = seq++, timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout; recover the existing job rather than resubmitting: ' + method)); }, timeout);
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function tool(name, args, timeout) {
  const reply = await call('tools/call', { name, arguments: args }, timeout);
  if (reply.isError) throw new Error(reply.content[0].text);
  return JSON.parse(reply.content[0].text);
}
(async () => {
  const init = await call('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'codex-bridge-verification', version: '1.0.0' }, capabilities: {} });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await call('tools/list'); console.log('codex_registered=true server=' + init.serverInfo.name + ' version=' + init.serverInfo.version + ' tools=' + list.tools.length);
  if (argv.includes('--sessions')) console.log(JSON.stringify(await tool('codex_sessions', { limit: 5, ...(value('--project') ? { cwd: value('--project') } : {}), ...(argv.includes('--local-only') ? { include_native: false } : {}) }), null, 2));
  if (value('--receipt')) {
    const result = await tool(argv.includes('--notification-check') ? 'codex_result' : 'codex_wait', { job_id: value('--receipt') }, 660000);
    if (argv.includes('--notification-check')) {
      const { read, publishNotification } = require('../src/server.cjs');
      const file = path.join(path.dirname(result.paths.receipt), 'job.json'), job = read(file);
      if (!job.conversation_id) throw new Error('This job has no originating Antigravity chat; no diagnostic was sent');
      const event = publishNotification(file, job, 'check-' + crypto.randomUUID(), 'notification_check', '仅验证通知投递，不启动任何执行任务。');
      console.log(JSON.stringify({ event_id: event.event_id, conversation_id: job.conversation_id, event_file: event.file, next: 'Verify the exact event ID in native chat history. Host API acceptance alone is not chat receipt confirmation.' }, null, 2));
    } else console.log(JSON.stringify(result, null, 2));
  }
  if (argv.includes('--smoke') || argv.includes('--write-smoke') || value('--continue')) {
    const writeFile = path.join(entry.env.CODEX_EXECUTOR_DATA, 'write-probe-' + crypto.randomBytes(6).toString('hex') + '.txt');
    const prompt = value('--continue') ? '这是隔离接入验收的原会话续接，不是业务开发。不要运行命令、改文件、提交或推送。只回复 CODEX_EXECUTOR_CONTINUE_OK。' : argv.includes('--write-smoke') ? '这是隔离接入写入验收，不是业务开发。不要读业务源码、提交、推送、部署或下单。只创建 ' + writeFile + '，以无 BOM UTF-8 写入 CODEX_EXECUTOR_WRITE_OK，然后通过 PowerShell 7 实际读回，报告字面 stdout 和退出码。不要更改其它文件或创建文档。' : '这是只读接入验收，不是业务开发。不要读业务源码、改文件、提交、推送、部署或启动长任务。只实际运行 PowerShell 7，stdout 必须包含 CODEX_EXECUTOR_SMOKE_OK，并报告退出码。';
    const parent = value('--continue') ? await tool('codex_result', { job_id: value('--continue') }) : null;
    const job = await tool('codex_run', { prompt, topic: parent?.topic || 'Codex bridge smoke test', ...(parent?.topic_id ? { topic_id: parent.topic_id } : {}), ...(value('--project') ? { cwd: value('--project') } : {}), timeout_seconds: 600 });
    console.log('job_id=' + job.job_id);
    const result = await tool('codex_wait', { job_id: job.job_id }, 660000);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'completed') throw new Error('CLI did not complete; inspect this job, do not resubmit');
    if (parent && (result.session_id !== parent.session_id || result.final_response.trim() !== 'CODEX_EXECUTOR_CONTINUE_OK')) throw new Error('Continuation identity/output mismatch');
    if (argv.includes('--write-smoke') && fs.readFileSync(writeFile, 'utf8') !== 'CODEX_EXECUTOR_WRITE_OK') throw new Error('Actual written file mismatch');
    const events = fs.readFileSync(result.paths.events, 'utf8').split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } });
    if (!parent && !events.some(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code === 0 && e.item.aggregated_output?.includes(argv.includes('--write-smoke') ? 'CODEX_EXECUTOR_WRITE_OK' : 'CODEX_EXECUTOR_SMOKE_OK'))) throw new Error('No successful actual command evidence');
    console.log('VERIFIED_REAL_EXECUTION=true');
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => child.stdin.end());
