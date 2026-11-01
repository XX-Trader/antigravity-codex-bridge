#!/usr/bin/env node
'use strict';

// Local stdio MCP adapter. Codex remains a separate CLI process and owns execution.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const terminal = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'needs_input', 'blocked', 'execution_blocked', 'review_revise', 'review_needs_evidence']);
const capacityMessage = 'Selected model is at capacity. Please try a different model';
const isCapacity = message => typeof message === 'string' && message.trim().replace(/\.$/, '') === capacityMessage;
const VERSION = require('../package.json').version;
const efforts = new Set(['low', 'medium', 'high']);
const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'];
function executionSandbox(input, settings) {
  const sandbox = input.sandbox === undefined ? 'danger-full-access' : input.sandbox;
  if (!sandboxModes.includes(sandbox)) throw new Error('sandbox must be read-only, workspace-write or danger-full-access');
  if (sandbox !== 'danger-full-access' && settings.allow_sandbox !== true) {
    throw new Error('本桥接使用宿主机环境，不允许派发方自行切换 sandbox。请省略 sandbox，将只读、不重启等操作边界写进 prompt。只有用户明确要求隔离时，才在本地 MCP 配置中启用 CODEX_EXECUTOR_ALLOW_SANDBOX=1；本次未提交任务。');
  }
  return sandbox;
}
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
function requestContext(input, parent, id) {
  for (const key of ['user_request', 'user_followup']) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 60000)) throw new Error(key + ' must contain 1..60000 characters; preserve the text verbatim');
  }
  const previous = parent?.request_context;
  const original = previous?.original_text ?? null;
  if (original !== null && input.user_request !== undefined && input.user_request !== original) throw new Error('Cannot replace user_request for the same matter/session; append the user\'s actual new words in user_followup, not a rewritten goal');
  const text = original ?? input.user_request ?? null;
  const followups = (previous?.followups || []).map(row => ({ ...row }));
  if (input.user_followup !== undefined) followups.push({ job_id: id, text: input.user_followup });
  if ((text?.length || 0) + followups.reduce((n, row) => n + row.text.length, 0) > 120000) throw new Error('User request history exceeds 120000 characters; do not silently truncate or replace it');
  return { source: text === null ? 'not_provided' : 'caller_supplied', original_text: text,
    original_job_id: original !== null ? previous.original_job_id : text === null ? null : id,
    original_sha256: text === null ? null : crypto.createHash('sha256').update(text, 'utf8').digest('hex'), followups };
}
function requestContextSummary(job) {
  const context = job.request_context;
  return { source: context?.source || 'not_provided', original_job_id: context?.original_job_id || null,
    original_sha256: context?.original_sha256 || null, followup_count: context?.followups?.length || 0,
    note: 'Caller-supplied text is preserved separately from the plan; this is not independent proof of human authorship or approval. Read paths.job for exact text.' };
}
function handoffObject(body) {
  const text = body.replace(/^```(?:json)?\s*/, '');
  if (!text.startsWith('{')) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(text.slice(0, i + 1)); } catch { return null; } }
  }
  return null;
}
function reviewVersion(job) {
  return crypto.createHash('sha256').update(JSON.stringify({ job_id: job.job_id, cwd: job.cwd, sandbox: job.sandbox,
    prompt: job.prompt, original: job.request_context?.original_text ?? null,
    followups: (job.request_context?.followups || []).map(row => row.text),
    review_followup: job.review_followup || null, execution_followup: job.execution_followup || null,
    execution_constraints: job.execution_constraints || [] }), 'utf8').digest('hex');
}
function reviewOutcome(text, job, violation = '') {
  const match = text.trimStart().match(/^\[CODEX_REVIEW_(APPROVED|REVISE|NEEDS_EVIDENCE)\]\s*([\s\S]*)$/);
  const body = match && handoffObject(match[2].trim());
  const strings = value => Array.isArray(value) && value.length > 0 && value.length <= 12 && value.every(v => typeof v === 'string' && v.trim() && v.length <= 2000);
  let error = violation;
  if (!error && (!body || body.plan_sha256 !== job.plan_review.plan_sha256 || body.plan_sha256 !== reviewVersion(job))) error = '审核回执缺失、格式无效或方案版本不匹配；未进入执行。';
  if (!error && match[1] === 'APPROVED' && (job.request_context?.original_text == null || !job.thread_id || !strings(body.evidence) || !strings(body.allowed_scope))) error = '审核通过必须具备用户原文、原生会话、核查依据和明确执行范围；未进入执行。';
  if (!error && match[1] !== 'APPROVED' && (!['technical', 'user'].includes(body.decision_scope) || typeof body.reason !== 'string' || !body.reason.trim())) error = '未通过审核须说明原因和决定归属；未进入执行。';
  if (error) return { status: 'needs_evidence', reason: error, handoff: { kind: 'review_needs_evidence', reason: error, text: error, requires_user_decision: false } };
  const status = { APPROVED: 'approved', REVISE: 'revise_required', NEEDS_EVIDENCE: 'needs_evidence' }[match[1]];
  return { status, source: 'executor_report', reviewed_at: stamp(), reason: String(body.reason || '').slice(0, 4000),
    evidence: strings(body.evidence) ? body.evidence : [], allowed_scope: strings(body.allowed_scope) ? body.allowed_scope : [],
    handoff: status === 'approved' ? null : { ...finalHandoff(text), requires_user_decision: body.decision_scope === 'user' } };
}
function finalHandoff(text = '') {
  const match = text.trimStart().match(/^\[CODEX_(NEEDS_INPUT|BLOCKED|PLAN_REJECTED|EXECUTION_BLOCKED|BACKGROUND_RUNNING|REVIEW_REVISE|REVIEW_NEEDS_EVIDENCE)\]\s*([\s\S]*)$/);
  if (!match) return null;
  const body = match[2].trim(), structured = handoffObject(body);
  const execution = match[1] === 'EXECUTION_BLOCKED' || (match[1] !== 'PLAN_REJECTED' && structured?.blocker_type === 'execution_policy');
  const kind = execution ? 'execution_blocked' : { NEEDS_INPUT: 'needs_input', BLOCKED: 'blocked', PLAN_REJECTED: 'blocked', BACKGROUND_RUNNING: 'background_running', REVIEW_REVISE: 'review_revise', REVIEW_NEEDS_EVIDENCE: 'review_needs_evidence' }[match[1]];
  const handoff = { kind, text: body.slice(0, 8000) };
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    for (const key of ['question', 'recommendation', 'completed', 'reason', 'original_plan', 'impact', 'blocked_action', 'reported_cause', 'decision_scope', 'suggested_changes']) if (typeof structured[key] === 'string') handoff[key] = structured[key].slice(0, 3000);
    for (const key of ['options', 'known_facts', 'unknowns', 'affected_checks', 'evidence']) if (Array.isArray(structured[key])) handoff[key] = structured[key].filter(v => typeof v === 'string').slice(0, 12).map(v => v.slice(0, 1000));
    if (Array.isArray(structured.completed)) handoff.completed = structured.completed.filter(v => typeof v === 'string').slice(0, 12).map(v => v.slice(0, 1000)).join('\n');
    if (Array.isArray(structured.suggested_changes)) handoff.suggested_changes = structured.suggested_changes.filter(v => typeof v === 'string').slice(0, 12).map(v => v.slice(0, 1000)).join('\n');
  }
  // Explicit refusal is not an implementation error the planner may silently repair.
  // Older plain-text BLOCKED output is conservative; the full result remains on disk.
  if (!execution && (kind === 'blocked' || ['plan', 'user'].includes(structured?.decision_scope))) handoff.requires_user_decision = true;
  return handoff;
}
function changeJob(file, change) {
  let release;
  for (let n = 0; n < 100 && !release; n++) { release = takeFileClaim(file + '.state.claim'); if (!release) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
  if (!release) throw new Error('Job state is busy; no state overwritten');
  try { const current = read(file), next = change(current); if (next !== current) save(file, next); return next; }
  finally { release(); }
}
function executionBlock(handoff, stderr = '', jobId = null) {
  // Only the CLI router's own execution error is machine evidence, never arbitrary
  // command stdout, an agent quote, or a successful command printing these words.
  const denial = stderr.split(/\r?\n/).find(line => /^\d{4}-\d\d-\d\dT\S+\s+ERROR\s+codex_core::tools::router:\s+error=exec_command failed: CreateProcess/.test(line) && line.includes('blocked by policy'));
  if (!denial && handoff?.kind !== 'execution_blocked') return null;
  return { category: 'execution_policy', blocked_job_id: jobId, source: denial ? 'cli_stderr' : 'executor_report',
    blocked_action: handoff?.blocked_action || '执行命令（具体目标见原回执）',
    reason: denial ? 'Rejected: blocked by policy' : handoff.reason || handoff.text,
    cause_status: 'unverified', reported_cause: handoff?.reported_cause || null,
    known_facts: handoff?.known_facts || [], unknowns: handoff?.unknowns || ['具体拒绝规则及审批来源尚未核实'],
    affected_checks: handoff?.affected_checks || [], evidence: handoff?.evidence || [],
    ...(denial ? { raw_excerpt: denial.slice(0, 3000), raw_excerpt_truncated: denial.length > 3000 } : {}),
    auto_retry_allowed: false, preserve_original_plan: true };
}
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
    const event = { schema: 2, event_id: `${job.job_id}:${sequence}`, sequence, key, kind, job_id: job.job_id, topic_id: job.topic_id, conversation_id: job.conversation_id, topic: job.topic, status: job.status, chat: chatAccess(job.thread_id), detail: String(detail).slice(0, 700), created_at: stamp(), ...(kind === 'terminal' ? { stage: job.stage || null, plan_review: job.plan_review || null, handoff: job.handoff || null, execution_block: job.execution_block || null, execution_state: job.execution_state || null, verification_state: job.verification_state || 'not_verified', background_commands: job.background_commands || [] } : {}) };
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
  const healthFile = path.join(path.dirname(path.dirname(jobFile)), '..', 'notification-health.json');
  const health = fs.existsSync(healthFile) ? read(healthFile) : null;
  const healthWindowMs = Math.max(20000, (health?.interval_ms || 15000) * 3);
  const alertFile = path.join(path.dirname(healthFile), 'notification-alerts.json');
  const alerts = fs.existsSync(alertFile) ? Object.values(read(alertFile).groups || {}).filter(g => g.state === 'open' && g.jobs?.includes(path.basename(dir))) : [];
  return { latest: rows.at(-1) || null, pending: rows.filter(r => ['pending', 'not_sent'].includes(r.state)).length, uncertain: rows.filter(r => ['uncertain', 'sending'].includes(r.state)).length, alerts, service: { online: hostFile ? !!host && alive(host.pid) && (!health || (!health.closed && Date.now() - Date.parse(health.checked_at) < healthWindowMs)) : null, build_matches: hostFile ? !!host && host.build === process.env.CODEX_EXECUTOR_BUILD : null, health, health_window_ms: healthWindowMs }, note: 'accepted means host API accepted, not proof that the chat rendered or business checks passed. not_sent is retryable; uncertain needs receipt reconciliation, never blind replay.' };
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
  if (env.CODEX_EXECUTOR_ALLOW_SANDBOX !== undefined && !['0', '1'].includes(env.CODEX_EXECUTOR_ALLOW_SANDBOX)) throw new Error('CODEX_EXECUTOR_ALLOW_SANDBOX must be 0 or 1');
  const settings = { project, data, entry, pwsh: env.CODEX_EXECUTOR_PWSH || 'pwsh.exe', model: env.CODEX_EXECUTOR_MODEL ? selectedModel(env.CODEX_EXECUTOR_MODEL, model_aliases) : null, model_aliases, reasoning_effort, service_tier, web_search: 'live', allow_sandbox: env.CODEX_EXECUTOR_ALLOW_SANDBOX === '1' };
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
    this.lock = path.join(settings.data, 'active-tasks');
    this.legacyLock = path.join(settings.data, 'active.lock');
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
    let workerPid = job.worker_pid;
    const lease = path.join(this.lock, `${id}.json`);
    if (!workerPid) try { workerPid = read(lease).worker_pid; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Older loaded clients could overwrite a new terminal status with their generic
    // crash fallback. Recover only this exact corruption with matching saved evidence.
    const overwritten = job.status === 'failed' && job.error === 'Worker exited before recording completion' && job.execution_block && job.handoff?.kind === 'execution_blocked';
    if (overwritten || (!terminal.has(job.status) && (fs.existsSync(crashFile) || (Date.now() - Date.parse(job.created_at) > 15000 && !alive(workerPid))))) {
      return changeJob(file, current => {
      if (current.status === 'failed' && current.error === 'Worker exited before recording completion' && current.execution_block && current.handoff?.kind === 'execution_blocked') {
        const event = notificationEvents(file).find(e => e.kind === 'terminal' && e.status === 'execution_blocked' && e.job_id === id && e.topic_id === current.topic_id && e.conversation_id === current.conversation_id && e.execution_block?.category === 'execution_policy');
        if (event) return { ...current, status: 'execution_blocked', error: current.execution_block.reason, ended_at: event.created_at,
          state_recovery: { previous_error: current.error, evidence_event_id: event.event_id, recovered_at: stamp() } };
      }
      // Re-read under the same short claim used by worker updates, not the stale
      // pre-liveness snapshot. A real saved terminal result must never be replaced.
      if (terminal.has(current.status)) return current;
      job = current;
      if (!fs.existsSync(crashFile) && (Date.now() - Date.parse(job.created_at) <= 15000 || alive(job.worker_pid || workerPid))) return job;
      // Keep the exact session owned while its child may still run; other matters remain independent.
      if (alive(job.child_pid)) return { ...job, status: 'orphaned', error: 'Worker exited but Codex may still run; inspect this owned job before retrying' };
      const dir = path.dirname(file), result = path.join(dir, 'result.txt');
      const handoff = fs.existsSync(result) ? finalHandoff(fs.readFileSync(result, 'utf8')) : null;
      const stderr = tail(path.join(dir, 'stderr.log'), 8000), execution_block = executionBlock(handoff, stderr, id);
      const worker_error = fs.existsSync(crashFile) ? tail(crashFile, 4000) : 'Worker exited before recording completion';
      if (execution_block || ['needs_input', 'blocked', 'background_running', 'review_revise', 'review_needs_evidence'].includes(handoff?.kind)) {
        const background = handoff?.kind === 'background_running' || job.background_commands?.length > 0;
        job = { ...job, status: execution_block ? 'execution_blocked' : handoff.kind === 'background_running' ? 'failed' : handoff.kind,
          handoff, execution_block, worker_error, error: execution_block?.reason || handoff.reason || handoff.question || handoff.text,
          execution_state: background ? 'background_unconfirmed' : execution_block ? 'policy_blocked' : 'cli_finished', verification_state: execution_block ? 'blocked' : background ? 'pending' : 'not_verified', ended_at: stamp() };
      } else job = { ...job, status: 'failed', worker_error, error: stderr.trim() || worker_error, ended_at: stamp() };
      this.unlock(id);
      return job;
      });
    }
    return job;
  }
  unlock(id) {
    for (const lock of [this.lock, this.legacyLock].filter(Boolean)) {
      try {
        if (fs.statSync(lock).isDirectory()) {
          // A second completion/cancel path must not remove a newly acquired empty lease.
          try { fs.unlinkSync(path.join(lock, `${id}.json`)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          // The shared registry is persistent: removing an empty directory races a new admission.
          if (lock !== this.lock) try { fs.rmdirSync(lock); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
        } else if (read(lock).job_id === id) {
          // Compatibility with a completed pre-1.1 file lock; unlink cannot remove a new directory lease.
          try { fs.unlinkSync(lock); } catch (error) { if (!['ENOENT', 'EISDIR'].includes(error.code)) throw error; }
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  lockOwner() {
    try {
      if (!fs.statSync(this.lock).isDirectory()) return read(this.lock);
      const owner = fs.readdirSync(this.lock).find(name => /^[a-f0-9]{24}\.json$/.test(name));
      return owner ? { job_id: owner.slice(0, -5) } : null;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  summary(job) {
    return { ...Object.fromEntries(['job_id', 'status', 'cwd', 'sandbox', 'thread_id', 'topic_id', 'topic', 'conversation_id', 'created_at', 'started_at', 'ended_at', 'exit_code', 'error', 'worker_pid', 'child_pid', 'parent_job_id', 'attempt', 'capacity_retry_at', 'execution_used_ms', 'chat_title', 'notification_error', 'concurrency', 'handoff', 'plan_decision', 'stage', 'plan_review', 'review_followup', 'execution_block', 'execution_followup', 'execution_constraints', 'execution_state', 'verification_state', 'background_commands'].filter(k => job[k] !== undefined).map(k => [k, job[k]])), request_context: requestContextSummary(job), execution_environment: job.sandbox === 'danger-full-access' ? 'host' : 'sandbox', chat: chatAccess(job.thread_id), notification: job.job_id ? notificationSummary(this.jobPath(job.job_id)) : null, model: job.settings?.model || null, reasoning_effort: job.settings?.reasoning_effort || null, service_tier: job.settings?.service_tier || null, web_search: job.settings?.web_search || null, attempt_total: job.attempts?.length || 0, attempts: (job.attempts || []).slice(-6) };
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
    const sandbox = executionSandbox(input, this.settings);
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
    const id = crypto.randomBytes(12).toString('hex');
    const dir = path.dirname(this.jobPath(id));
    const topicId = parent?.topic_id || input.topic_id || id, sessionId = parent?.thread_id || resumption?.id || null;
    let release;
    for (let n = 0; n < 100 && !release; n++) { release = takeFileClaim(path.join(this.settings.data, 'dispatch.claim')); if (!release) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); }
    if (!release) throw new Error('Task admission is busy; no task submitted. This is not a running-task limit.');
    try {
      const jobs = this.list(Number.MAX_SAFE_INTEGER);
      const duplicate = jobs.find(j => !terminal.has(j.status) && (j.topic_id === topicId || (sessionId && j.thread_id === sessionId)));
      if (duplicate) throw new Error(`This matter/session is already running: ${duplicate.job_id}; no duplicate turn submitted`);
      const matterJobs = jobs.filter(j => j.topic_id === topicId || (sessionId && j.thread_id === sessionId));
      const decided = new Set(matterJobs.map(j => j.plan_decision?.refusal_job_id).filter(Boolean));
      const pending = matterJobs.filter(j => j.handoff?.requires_user_decision && !decided.has(j.job_id));
      let plan_decision;
      if (input.plan_decision !== undefined) {
        const decision = input.plan_decision;
        if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).some(k => k !== 'refusal_job_id') || !/^[a-f0-9]{24}$/.test(decision.refusal_job_id || '')) throw new Error('plan_decision must identify one refusal_job_id');
        if (!pending.some(j => j.job_id === decision.refusal_job_id)) throw new Error('plan_decision does not match an unresolved refusal in this matter/session');
        if (typeof input.user_followup !== 'string' || !input.user_followup.trim()) throw new Error('plan_decision requires the actual human reply verbatim in user_followup; a planner summary is not approval');
        plan_decision = { refusal_job_id: decision.refusal_job_id, reply_job_id: id };
      }
      const unresolved = pending.find(j => j.job_id !== plan_decision?.refusal_job_id);
      if (unresolved) throw new Error(`[CODEX_USER_DECISION_REQUIRED] 执行端已明确拒绝/阻塞方案，必须先向用户反馈原计划、理由、影响和选择，不得静默换方案。refusal_job_id=${unresolved.job_id}; read codex_result once; after the user's reply pass plan_decision.refusal_job_id and verbatim user_followup. No task submitted.`);
      const answeredReviews = new Set(matterJobs.map(j => j.review_followup?.review_job_id).filter(Boolean));
      const pendingReviews = matterJobs.filter(j => ['review_revise', 'review_needs_evidence'].includes(j.handoff?.kind) && !j.handoff.requires_user_decision && !answeredReviews.has(j.job_id));
      let review_followup;
      if (input.review_followup !== undefined) {
        const r = input.review_followup;
        if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['review_job_id', 'response'].includes(k)) || !pendingReviews.some(j => j.job_id === r.review_job_id) || typeof r.response !== 'string' || !r.response.trim() || r.response.length > 8000) throw new Error('review_followup must reference an unresolved technical review in this matter/session and explain the revision or added evidence');
        review_followup = structuredClone(r);
      }
      if (pendingReviews.some(j => j.job_id !== review_followup?.review_job_id)) throw new Error('[CODEX_REVIEW_FOLLOWUP_REQUIRED] 审核尚未通过。按原事项传入 review_followup.review_job_id 和 response，逐项回应修订/补证要求；新轮次必须重新审核，不能直接执行。No task submitted.');
      const resolutions = new Set(matterJobs.filter(j => j.execution_followup?.intent === 'resume_after_resolution').flatMap(j => j.execution_followup.blocked_job_ids));
      const pendingExecution = matterJobs.filter(j => j.execution_block && !resolutions.has(j.job_id));
      let execution_followup;
      if (input.execution_followup !== undefined) {
        const followup = input.execution_followup;
        if (!followup || typeof followup !== 'object' || Array.isArray(followup) || Object.keys(followup).some(k => !['blocked_job_ids', 'intent', 'resolution'].includes(k)) || !Array.isArray(followup.blocked_job_ids) || !followup.blocked_job_ids.length || followup.blocked_job_ids.length > 20 || followup.blocked_job_ids.some(v => typeof v !== 'string' || !/^[a-f0-9]{24}$/.test(v)) || new Set(followup.blocked_job_ids).size !== followup.blocked_job_ids.length || !['diagnose', 'continue_unblocked', 'resume_after_resolution'].includes(followup.intent)) throw new Error('Invalid execution_followup; identify blocked_job_ids and a supported intent');
        if (pendingExecution.length !== followup.blocked_job_ids.length || pendingExecution.some(j => !followup.blocked_job_ids.includes(j.job_id))) throw new Error('execution_followup must reference all unresolved execution blocks in this matter/session');
        if (followup.intent === 'resume_after_resolution') {
          const r = followup.resolution;
          if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['kind', 'evidence'].includes(k)) || !['formal_approval', 'policy_fix'].includes(r.kind) || typeof r.evidence !== 'string' || !r.evidence.trim() || r.evidence.length > 4000) throw new Error('Resuming a denied action requires recorded formal_approval or policy_fix evidence; a business-plan confirmation is not policy resolution');
        } else if (followup.resolution !== undefined) throw new Error('Diagnostic/unblocked work must not claim to resolve an execution policy denial');
        execution_followup = { ...structuredClone(followup), evidence_status: 'caller_reported_not_a_permission_grant' };
      }
      if (pendingExecution.length && !execution_followup) throw new Error(`[CODEX_EXECUTION_POLICY_UNRESOLVED] 执行策略受阻，不代表原方案不成立。仅可声明 diagnose / continue_unblocked，保留原拒绝且不执行等价动作；恢复原动作须有正常授权或策略修复的证据。blocked_job_ids=${pendingExecution.map(j => j.job_id).join(',')}; no task submitted.`);
      const execution_constraints = execution_followup && execution_followup.intent !== 'resume_after_resolution' ? pendingExecution.map(j => ({ ...j.execution_block, blocked_job_id: j.job_id })) : [];
      const contextHead = matterJobs.sort((a, b) =>
        Number(b.request_context?.source === 'caller_supplied') - Number(a.request_context?.source === 'caller_supplied') ||
        (b.request_context?.followup_count || 0) - (a.request_context?.followup_count || 0))[0];
      const contextParent = contextHead ? this.get(contextHead.job_id) : parent || topicParent;
      const request_context = requestContext(input, contextParent, id);
      fs.mkdirSync(this.lock, { recursive: true });
      fs.writeFileSync(path.join(this.lock, `${id}.json`), JSON.stringify({ job_id: id }), { flag: 'wx' });
      fs.mkdirSync(dir);
      const job = {
        job_id: id, status: 'queued', created_at: stamp(), cwd, sandbox,
        prompt: input.prompt, request_context, stage: 'review', ...(review_followup ? { review_followup } : {}), ...(plan_decision ? { plan_decision } : {}), ...(execution_followup ? { execution_followup, execution_constraints } : {}), timeout_seconds: input.timeout_seconds || 3600,
        settings: taskSettings, concurrency: 'unlimited', notification_schema: 2, topic_id: topicId, topic: parent?.topic || topicParent?.topic || input.topic?.trim() || taskTitle({ prompt: input.prompt }),
        ...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
        ...(parent ? { parent_job_id: parent.job_id, thread_id: parent.thread_id, ...(parent.chat_title ? { chat_title: parent.chat_title } : {}) } : {}),
        ...(resumption ? { resumed_session: true, thread_id: resumption.id } : {})
      };
      job.plan_review = { status: 'pending', plan_sha256: reviewVersion(job), allowed_scope: [], evidence: [] };
      save(path.join(dir, 'job.json'), job);
      const worker = spawn(process.execPath, [__filename, '--worker', path.join(dir, 'job.json')], {
        detached: true, windowsHide: true, stdio: 'ignore', env: process.env
      });
      save(path.join(this.lock, `${id}.json`), { job_id: id, worker_pid: worker.pid });
      worker.on('error', error => {
        save(path.join(dir, 'job.json'), { ...job, status: 'failed', error: error.message, ended_at: stamp() });
        this.unlock(id);
      });
      worker.unref();
      return { ...this.summary(job), session_id: job.thread_id || null, next: 'Background task accepted; continue normal chat. The native sidecar sends one initial saved-chat link and terminal/decision events. Routine progress and continuation starts stay local and silent. Acknowledge submission in one short line; only a terminal event needs codex_result once, then report verified outcomes or user decisions, not internal continuation rounds. Notification delivery state is distinct from task acceptance; never submit duplicates.' };
    } catch (error) { this.unlock(id); throw error; }
    finally { release(); }
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
      job_id: id, status: job.status, sandbox: job.sandbox, execution_environment: job.sandbox === 'danger-full-access' ? 'host' : 'sandbox', cwd: job.cwd, session_id: job.thread_id || null, chat: chatAccess(job.thread_id), chat_title: job.chat_title || null, topic_id: job.topic_id || null, topic: job.topic || null,
      model: job.settings?.model || null, reasoning_effort: job.settings?.reasoning_effort || null, service_tier: job.settings?.service_tier || null, web_search: job.settings?.web_search || null, attempt_total: job.attempts?.length || 0, attempts: (job.attempts || []).slice(-6), ...(job.capacity_retry_at ? { capacity_retry_at: job.capacity_retry_at } : {}),
      ...(job.conversation_id ? { conversation_id: job.conversation_id } : {}),
      exit_code: job.exit_code ?? null, ...(job.error ? { error: job.error } : {}),
      request_context: requestContextSummary(job), stage: job.stage || null, plan_review: job.plan_review || null, review_followup: job.review_followup || null, handoff: job.handoff || null, plan_decision: job.plan_decision || null, execution_block: job.execution_block || null, execution_followup: job.execution_followup || null, execution_constraints: job.execution_constraints || [], execution_state: job.execution_state || (terminal.has(job.status) ? 'cli_finished' : 'running'), verification_state: job.verification_state || 'not_verified', background_commands: job.background_commands || [],
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
    executionSandbox(input, this.settings); // Reject before native metadata lookup or task admission.
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
  list(limit = 20, _cwd, activeOnly = false) {
    return fs.readdirSync(this.jobs).filter(id => /^[a-f0-9]{24}$/.test(id) && fs.existsSync(this.jobPath(id)))
      .map(id => this.status(id)).filter(job => !activeOnly || !terminal.has(job.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, activeOnly ? Number.MAX_SAFE_INTEGER : limit);
  }
}

async function worker(file, clock = { now: () => Date.now(), wait: capacityDelay }) {
  let job = read(file);
  const dir = path.dirname(file), broker = new Broker(job.settings);
  const events = fs.openSync(path.join(dir, 'events.jsonl'), 'a'), stderr = fs.openSync(path.join(dir, 'stderr.log'), 'a');
  let stopReason;
  const update = changes => { job = changeJob(file, current => ({ ...current, ...changes })); };
  const finish = changes => { update(changes); broker.unlock(job.job_id); };
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
    // Jobs admitted before this protocol must also pass a fresh review; no legacy bypass.
    if (!job.plan_review) update({ stage: 'review', plan_review: { status: 'pending', plan_sha256: reviewVersion(job), allowed_scope: [], evidence: [] } });
    update({ status: 'running', started_at: stamp(), worker_pid: process.pid, attempts: [] });
    notify('started', 'started', '已开始独立核查方案；审核通过后才进入执行。');
    for (let attempt = 1; ; attempt++) {
      if (fs.existsSync(path.join(dir, 'cancel'))) { stopReason = 'cancelled'; break; }
      if (executionUsed >= job.timeout_seconds * 1000) { stopReason = 'timed_out'; break; }
      const started = clock.now(), deadline = Date.now() + job.timeout_seconds * 1000 - executionUsed;
      const reviewing = job.stage === 'review';
      if (!reviewing && (job.plan_review.status !== 'approved' || job.plan_review.plan_sha256 !== reviewVersion(job))) throw new Error('Approved review does not match this execution input; execution was not started');
      update({ attempt, status: 'running', capacity_retry_at: null });
      if (attempt > 1) notify(`resumed-${attempt}`, 'resumed', `原模型、原会话续跑，第 ${attempt} 次启动。`);
      fs.rmSync(path.join(dir, 'result.txt'), { force: true });
      fs.writeSync(events, JSON.stringify({ type: 'bridge.attempt', stage: job.stage, attempt, model: job.settings.model }) + '\n');
      let child, timer, killSent = false, turnCompleted = false, turnFailed = false, lastError = '', businessStarted = false, observed = false, reviewWrite = false, usage;
      const openCommands = new Map();
      const stop = reason => {
        if (killSent || !child || child.exitCode !== null) return;
        stopReason = reason; killSent = true;
        if (process.platform === 'win32') {
          const killer = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
          fs.writeSync(stderr, '\nowned-child cancellation: exit=' + killer.status + '\n' + (killer.stdout || '') + (killer.stderr || ''));
        } else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      };
      let outcome;
      const stderrOffset = fs.fstatSync(stderr).size;
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
            if (event.type === 'item.completed' && ((event.item?.type === 'command_execution' && event.item.exit_code === 0) || (event.item?.type === 'mcp_tool_call' && event.item.status === 'completed'))) observed = true;
            if (reviewing && event.item?.type === 'file_change') { reviewWrite = true; stop('review_needs_evidence'); }
            if (event.item?.type === 'command_execution' && event.item.id) {
              if (event.type === 'item.started') openCommands.set(event.item.id, { item_id: event.item.id, command: String(event.item.command || '').slice(0, 2000), state: 'exit_unconfirmed' });
              if (event.type === 'item.completed') openCommands.delete(event.item.id);
            }
            if (event.item?.type === 'file_change' && event.type === 'item.completed') notify(`files-${attempt}`, 'files_changed', '已写入首批文件变更，仍需后续验证。');
            const phase = event.item?.type === 'command_execution' && commandPhase(event.item.command);
            if (phase && event.type === 'item.started') notify(`${phase}-${attempt}-start`, 'phase_started', `正在执行${phase}。`);
            if (phase && event.type === 'item.completed') notify(`${phase}-${attempt}-${event.item.id}`, 'phase_finished', `${phase}命令结束，退出码 ${event.item.exit_code ?? 'unknown'}；不代表整个任务验收完成。`);
          } catch { /* Keep unknown output verbatim; never classify a quoted tool result as a capacity failure. */ }
        });
        timer = setInterval(() => { if (fs.existsSync(path.join(dir, 'cancel'))) stop('cancelled'); else if (Date.now() >= deadline) stop('timed_out'); }, 500);
        outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      } finally { clearInterval(timer); }
      const output = path.join(dir, (reviewing ? 'review-' : '') + 'attempt-' + attempt + '.result.txt');
      const successful = !stopReason && outcome.code === 0 && turnCompleted && !turnFailed && fs.existsSync(output);
      const attemptStderr = fs.readFileSync(path.join(dir, 'stderr.log')).subarray(stderrOffset).toString('utf8');
      const capacity = !successful && !stopReason && !executionBlock(null, attemptStderr) && isCapacity(lastError);
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
        const retryAt = capacityRetryAt([...(job.plan_review?.attempts || []), ...job.attempts], clock.now());
        update({ status: 'waiting_capacity', capacity_retry_at: new Date(retryAt).toISOString(), execution_used_ms: executionUsed });
        notify(`capacity-${attempt}`, 'waiting_capacity', `等待原模型容量；最早续跑时间 ${job.capacity_retry_at}。不会自动换模型。`);
        if (!await clock.wait(retryAt, dir)) { stopReason = 'cancelled'; break; }
        continue;
      }
      // The handoff marker is at the beginning, not in the UI's truncated tail.
      const finalFile = path.join(dir, 'result.txt');
      const final = fs.existsSync(finalFile) ? fs.readFileSync(finalFile, 'utf8') : '';
      // A nonzero CLI exit must not hide an explicit refusal already written to the result.
      let handoff = finalHandoff(final);
      const execution_block = executionBlock(handoff, attemptStderr, job.job_id);
      const background = [...openCommands.values()].slice(0, 20), pendingBackground = background.length > 0 || handoff?.kind === 'background_running';
      if (reviewing && !execution_block && !['needs_input', 'blocked', 'background_running'].includes(handoff?.kind) && (!stopReason || reviewWrite)) {
        const review = reviewOutcome(final, job, reviewWrite ? '审核阶段出现文件变更事件，已暂停；须先核对影响，未进入执行。' : pendingBackground ? '审核命令退出尚未确认，未进入执行；先核对原命令，不能重跑。' : !successful ? '审核轮次未正常结束；未进入执行。' : !observed ? '审核没有成功的独立工具核查记录；未进入执行。' : '');
        handoff = review.handoff;
        update({ plan_review: { ...job.plan_review, ...review, handoff: undefined, attempts: job.attempts }, execution_used_ms: executionUsed });
        if (review.status === 'approved') {
          update({ stage: 'execute', attempts: [], attempt: 0, child_pid: null });
          fs.writeSync(events, JSON.stringify({ type: 'bridge.review.approved', plan_sha256: job.plan_review.plan_sha256, thread_id: job.thread_id }) + '\n');
          const recent = job.plan_review.attempts.filter(row => Date.parse(row.started_at) > clock.now() - 3600000);
          if (recent.length >= 6) {
            const retryAt = capacityRetryAt(job.plan_review.attempts, clock.now());
            update({ status: 'waiting_capacity', capacity_retry_at: new Date(retryAt).toISOString() });
            if (!await clock.wait(retryAt, dir)) { stopReason = 'cancelled'; break; }
          }
          attempt = 0;
          continue;
        }
      }
      if (['review_revise', 'review_needs_evidence'].includes(handoff?.kind)) update({ plan_review: { ...job.plan_review, status: handoff.kind === 'review_revise' ? 'revise_required' : 'needs_evidence', reason: handoff.reason || handoff.text }, stage: 'review_held' });
      finish({ status: stopReason || (execution_block ? 'execution_blocked' : null) || (['needs_input', 'blocked', 'review_revise', 'review_needs_evidence'].includes(handoff?.kind) ? handoff.kind : null) || (successful ? 'completed' : 'failed'), handoff, execution_block, execution_state: pendingBackground ? 'background_unconfirmed' : execution_block ? 'policy_blocked' : handoff?.kind?.startsWith('review_') ? 'review_held' : 'cli_finished', verification_state: execution_block ? 'blocked' : pendingBackground ? 'pending' : 'not_verified', background_commands: background, execution_used_ms: executionUsed, exit_code: outcome.code, ended_at: stamp(), retrying_capacity: false,
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
const requestFields = {
  user_request: { type: 'string', minLength: 1, maxLength: 60000, description: 'Verbatim human request, separate from prompt (the planner summary/implementation advice). Supply on new matters. Immutable once captured; omit or repeat exactly on continuation. Never invent missing original text.' },
  user_followup: { type: 'string', minLength: 1, maxLength: 60000, description: 'Verbatim new human clarification/decision, appended to the saved request history. Not a replacement summary or evidence of approval by itself.' },
  review_followup: { ...object({ review_job_id: idSchema, response: { type: 'string', minLength: 1, maxLength: 8000 } }, ['review_job_id', 'response']), description: 'Respond to an unresolved technical review in the same matter: explain revisions or added evidence. This never approves the plan; Codex reviews the new version before execution. Human scope/authorization changes still require plan_decision and the actual user reply.' },
  plan_decision: { ...object({ refusal_job_id: idSchema }, ['refusal_job_id']), description: 'Only after showing an explicit executor refusal to the user: identify that refusal job and include the actual human answer verbatim in user_followup. A planner claim or recommendation is not approval.' },
  execution_followup: { ...object({ blocked_job_ids: { type: 'array', items: idSchema, minItems: 1, maxItems: 20, uniqueItems: true }, intent: { type: 'string', enum: ['diagnose', 'continue_unblocked', 'resume_after_resolution'] }, resolution: object({ kind: { type: 'string', enum: ['formal_approval', 'policy_fix'] }, evidence: { type: 'string', minLength: 1, maxLength: 4000 } }, ['kind', 'evidence']) }, ['blocked_job_ids', 'intent']), description: 'Execution-policy denial is not plan rejection. Diagnose read-only or continue only unaffected work without retrying equivalent denied actions. Resume only with evidence of normal authorization/policy repair; this record itself grants no permissions.' }
};
const tools = [
  { name: 'codex_run', description: 'Codex first independently reviews the verbatim user request and planner proposal against current evidence. Only an approved version automatically executes in the same native session; technical revisions/evidence gaps return for review_followup, user scope/authorization changes require a human decision. Start one matter in the host current-user environment and return immediately by default, leaving Antigravity free for normal chat. Read-only diagnostics are prompt constraints, not a sandbox choice. Antigravity plans/reviews only: commands, edits, tests and execution belong to Codex. If subagents are needed, request Codex-native subagents in the prompt, never Antigravity native subagents. Pass an available model ID or a locally configured alias when needed; otherwise inherit Codex configuration. Reasoning defaults to Medium. Reuse topic_id only for the same matter; another subject needs a new topic. Independent matters may run concurrently in the same worktree without a numeric task cap. Ask the user worktree versus waiting for tightly coupled/overlapping work. No auto-upgrade, timers or polling. wait=true only if the user explicitly wants to wait.', inputSchema: object({ ...requestFields, prompt: { type: 'string' }, topic: { type: 'string', maxLength: 120, description: 'Concrete execution task shown as the native Codex chat title, not a generic executor identity or the whole Antigravity conversation' }, topic_id: { type: 'string', description: 'Returned matter ID for same-topic continuation; omit for a different matter' }, model: { type: 'string', description: 'Available model ID or locally configured alias. Omit to inherit the configured Codex model; same-topic continuation retains an explicit prior choice.' }, reasoning_effort: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Default medium; do not increase automatically' }, wait: { type: 'boolean', default: false, description: 'False returns background acknowledgment. True waits for completion and can occupy this chat turn.' }, cwd: { type: 'string' }, sandbox: { type: 'string', enum: sandboxModes, default: 'danger-full-access', description: 'Available only after local CODEX_EXECUTOR_ALLOW_SANDBOX=1 opt-in for user-requested isolation. Omit for host execution; read-only task constraints belong in prompt.' }, timeout_seconds: { type: 'integer', minimum: 30, maximum: 14400 }, session_id: { type: 'string', description: 'Exact Codex session ID, separate from Antigravity conversation_id; do not reuse it for an unrelated matter' }, conversation_id: { type: 'string', description: 'Optional actual originating Antigravity UUID. One chat may have many topic IDs; never invent an ID.' } }, ['prompt']) },
  { name: 'codex_wait', description: 'Wait for an already submitted job and collect its receipt once. Used after interruption, never submit the task again or schedule polling. Closing this wait does not cancel Codex.', inputSchema: object({ job_id: idSchema }, ['job_id']) },
  { name: 'codex_sessions', description: 'Read a small page of current-project local Codex session IDs and brief titles and clickable native chat links, including exec/app-server tasks, without calling a model or reading full conversations. Select an exact session_id for codex_run; this does not switch, submit or run anything.', inputSchema: object({ cwd: { type: 'string', description: 'Explicit registered project root; required for multi-folder Antigravity projects' }, include_native: { type: 'boolean', default: true }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 } }) },
  { name: 'codex_start', description: 'Delegate a concrete task to the real local Codex CLI in the host current-user environment. Returns immediately with job_id. Codex performs commands, edits and tests; do not submit duplicate jobs. Local saved Codex login is reused.', inputSchema: object({ ...requestFields, prompt: { type: 'string', description: 'Goal, evidence/context, scope, constraints, acceptance checks and authorization boundaries' }, cwd: { type: 'string', description: 'Absolute working directory within the configured project; defaults to project root' }, sandbox: { type: 'string', enum: sandboxModes, default: 'danger-full-access' }, timeout_seconds: { type: 'integer', minimum: 30, maximum: 14400, default: 3600 } }, ['prompt']) },
  { name: 'codex_continue', description: 'Continue the exact Codex session of a finished job. Retains original cwd; the next turn uses the host environment by default; isolation requires local configuration opt-in. Never resumes an arbitrary most-recent thread.', inputSchema: object({ ...requestFields, job_id: idSchema, prompt: { type: 'string' }, sandbox: { type: 'string', enum: sandboxModes, description: 'User-requested isolation only after local CODEX_EXECUTOR_ALLOW_SANDBOX=1 opt-in; omission uses the host environment' } }, ['job_id', 'prompt']) },
  { name: 'codex_status', description: 'Read persisted process state without waiting. completed means the CLI turn ended normally, not that acceptance checks passed; inspect codex_result evidence. A running job is not complete.', inputSchema: object({ job_id: idSchema }, ['job_id']) },
  { name: 'codex_result', description: 'Collect the original compact receipt once on a CODEX_EVENT or explicit result request. Return the native Codex chat link to the user for full saved history in VS Code, also after restart. Default codex_run returns only a background acknowledgment. No polling or duplicate reads; diagnostics=true is only for original log tails.', inputSchema: object({ job_id: idSchema, diagnostics: { type: 'boolean', default: false }, sync_title: { type: 'boolean', default: false, description: 'Explicitly repair the task title of a finished bridge-owned session. Preserves user-defined titles and never executes the task again.' } }, ['job_id']) },
  { name: 'codex_cancel', description: 'Ask the owned worker to terminate only its Codex child process tree. Does not roll back any edits. Wait for a terminal status before continuing the same matter/session; independent jobs are unaffected.', inputSchema: object({ job_id: idSchema }, ['job_id']) },
  { name: 'codex_list', description: 'Recover recent jobs, or all active jobs with active_only=true, and native Codex chat links after restart. The history display length is not a running-task cap. Show the returned clickable link to the user so they can view the saved full task in VS Code. Never rerun a job just to view it.', inputSchema: object({ cwd: { type: 'string', description: 'Current project root, to avoid listing unrelated projects' }, active_only: { type: 'boolean', default: false, description: 'List all active tasks without the default recent-history display limit; this is not an execution cap.' } }) }
];

function dispatch(broker, request, signal) {
  const { method, params = {} } = request;
  if (method === 'initialize') return { protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(params.protocolVersion) ? params.protocolVersion : '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'codex-executor', version: VERSION }, instructions: `Every task first enters an independent Codex review. Send the verbatim user_request and all human followups separately from the planner proposal/evidence in prompt. Review checks real code/logs/tool output; missing originals, evidence or scope cannot pass. The bridge records the input version, evidence and allowed_scope; only that approved version auto-executes in the same native session, without another human confirmation for already authorized work. Technical review_revise/review_needs_evidence returns require review_followup identifying the exact review and explaining revisions; Codex reviews again. Changes to human goals, explicit constraints, acceptance or authorization still require the actual human reply through plan_decision. New contradictory execution evidence suspends affected operations for re-review. Review approval is not business acceptance or a grant of permissions. Execution environment: ${broker.settings.allow_sandbox === true ? 'Local configuration permits user-requested isolation; omit sandbox for host execution.' : 'Host current-user environment only. Do not pass sandbox; do not infer isolation from read-only diagnostics. Sandbox requests are rejected before execution.'} Read-only, no-restart and no-file-change constraints belong in prompt and remain binding. Debug the environment where the problem actually occurs; sandbox invisibility is not evidence that host targets are absent. Execution boundary: Antigravity only plans, delegates and reviews; all execution and subagents must be Codex-owned. Codex-native spawn_agent is allowed, recursive calls through this MCP are not. Registered roots: ${(broker.settings?.projects || [broker.settings]).filter(Boolean).map(p => p.project).join(' ; ')}. Trusted-project executions default to danger-full-access and live web search. Sandbox selection requires local configuration opt-in and an explicit user isolation request. A finished session resumes in the host environment by default; never hot-change or resubmit a running task. Bind cwd to the current Antigravity project; never assume a different registered directory. Use codex_run once with a short topic and an available model ID or configured alias chosen for the task when needed. Default Medium and background acknowledgment; continue normal conversation without a waiting tool. Each unrelated matter gets its own topic/Codex session; reuse topic_id only for the same matter. A project-only identity hook binds the originating chat; a native sidecar pushes durable lifecycle events to that exact chat, each with event_id and sequence. Routine lifecycle/progress/recovery events stay local and silent; do not reply to legacy progress events. Show the initial saved chat link once, with no tool call. User notifications use at most three lines: local event time, project/matter/status; concrete verified result or action needed; one detail link. Hide internal IDs and protocol boilerplate. Never infer all checks passed from one command exit. Keep complete user-choice questions/options even when longer than three lines; never truncate choices. Only terminal events require codex_result once to review evidence or intervene within authorization. Continue an authorized unfinished matter silently; notify only a final reviewed outcome, unresolved blocker or user decision, not each internal turn. Notification transport alarms protect terminal/decision results; recovery remains local. execution_alert permits one inspect-only receipt read, never a redispatch. Forward needs_input handoff questions/options to the user without auto-selecting; resume the exact topic/session once after their answer. background_unconfirmed means CLI ended but command exit/verification is pending. notification_check stays local and silent, with no chat reply, tools or business execution. User notices must describe concrete completed work, remaining work or an actual question, never routing IDs, event codes or a receipt acknowledgment. Do not use repository folder names as user-facing task descriptions. parallel_check is an explicitly user-authorized native acceptance request: actually submit the independent read-only sample tasks it describes; the sample count is not a concurrency cap. Expose notification pending/not_sent/uncertain and service health; API acceptance is not rendered-chat or business acceptance. When a user asks to view a task, show its returned chat.vscode_uri as a clickable Markdown link; codex_list recovers these links after restart. Do not claim exec tasks automatically appear in the extension history list. Opening history does not authorize a new turn. Exact capacity errors resume the same model/thread, at most six starts per rolling hour with no lifetime cap; scripts wait, not models. Independent matters in the same worktree run without a numeric concurrency cap. Only duplicate simultaneous turns for the same topic/session are excluded. Before dispatch, assess file/API dependencies; if tightly coupled, ask the user whether to use separate worktrees or wait for the prerequisite, never create worktrees silently. Coordinate shared Git index, branch changes and final integration serially; switching branches in one shared directory is not isolation. Use codex_list(active_only=true) on explicit progress requests to see all active tasks, not periodic polling. No auto-upgrades, model-based schedule/timer/status polling or unrelated-chat messages. Fifteen-second local outbox reconciliation does not call a model or send heartbeats.` };
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: tools.map(tool => {
    if (broker.settings.allow_sandbox === true || !tool.inputSchema.properties.sandbox) return tool;
    const properties = { ...tool.inputSchema.properties }; delete properties.sandbox;
    return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
  }) };
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
        value = broker.start({ prompt: args.prompt, user_request: args.user_request, user_followup: args.user_followup, review_followup: args.review_followup, plan_decision: args.plan_decision, execution_followup: args.execution_followup, cwd: parent.cwd, sandbox: args.sandbox, parent_job_id: args.job_id }); break;
      }
      case 'codex_status': value = broker.status(args.job_id); break;
      case 'codex_result': value = broker.result(args.job_id, args.diagnostics === true); break;
      case 'codex_cancel': value = broker.cancel(args.job_id); break;
      case 'codex_list': value = broker.list(20, args.cwd, args.active_only === true); break;
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

module.exports = { reviewVersion, reviewOutcome, executionSandbox, finalHandoff, executionBlock, taskTitle, syncTaskTitle, latestProgress, chatAccess, toolResponse, nativeMetadata, worker, capacityRetryAt, isCapacity, capacityMessage, Broker, config, dispatch, tools, inside, read, save, terminal, childEnvironment, notificationEvents, publishNotification, notificationSummary, commandPhase, alive, takeFileClaim };
if (require.main === module) {
  if (process.argv[2] === '--worker') worker(process.argv[3]).catch(error => {
    try { fs.writeFileSync(path.join(path.dirname(process.argv[3]), 'worker-error.txt'), `${error.stack}\n`, 'utf8'); } catch {}
    process.stderr.write(`${error.stack}\n`); process.exitCode = 1;
  });
  else { try { serve(); } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; } }
}
