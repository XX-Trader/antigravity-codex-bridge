'use strict';
// Native sidecar: filesystem hints + local durable-outbox reconciliation. No model polling.
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
    let stdout = '', stderr = '', settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    // Reject at the deadline even if an inherited pipe delays the child's close event.
    const timer = setTimeout(() => { child.kill(); finish(new Error('agentapi timed out after 30000ms')); }, 30000);
    child.stdout.on('data', data => { stdout = (stdout + data).slice(-2000); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.once('error', error => finish(error));
    child.once('close', code => finish(null, { stdout, stderr, exit_code: code }));
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
const checks = new Set(['notification_check', 'parallel_check', 'subagent_check']);
const important = new Set(['terminal', 'execution_alert', 'notification_alert']);
function notificationPolicy(job, event, now = Date.now()) {
  if (event.kind === 'notification_check') return 'silent';
  if (checks.has(event.kind) || important.has(event.kind) || !event.schema) return 'send';
  // A continuation already has a saved chat link. Never replay old startup banners.
  if (event.kind === 'session_ready' && !job.parent_job_id && !job.resumed_session && job.topic_id === job.job_id && now - Date.parse(event.created_at) <= 120000) return 'send';
  return 'silent';
}
function notificationHeading(job, event, label, now = Date.now()) {
  const date = new Date(event.created_at || job.ended_at || job.created_at);
  const zone = job.settings?.notification_timezone;
  const parts = value => Object.fromEntries(new Intl.DateTimeFormat('zh-CN', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(value).map(p => [p.type, p.value]));
  const at = parts(date), today = parts(new Date(now));
  const day = at.year === today.year && at.month === today.month && at.day === today.day ? '' : `${at.month}-${at.day} `;
  const topic = Array.from((job.topic || '').replace(/\s+/g, ' '));
  const matter = topic.length ? ` · ${topic.slice(0, 24).join('')}${topic.length > 24 ? '…' : ''}` : '';
  const delayed = now - date.getTime() >= 120000 ? '（延迟送达）' : '';
  return `${day}${at.hour}:${at.minute}${matter} · ${label}${delayed}`;
}
function noticeResult(text = '') {
  return text.replace(/```[\s\S]*?```/g, '')
    .replace(/\b(?:job_id|topic_id|session_id|event_id)\s*[:=：]\s*[`"']?[a-f\d:-]+[`"']?/gi, '')
    .replace(/\b[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\b/gi, '')
    .replace(/^\s*#{1,6}\s+/gm, '').replace(/`/g, '')
    .split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(0, 2).join('\n').slice(0, 1200).trim();
}
function eventMessage(job, event) {
  const link = event.chat || chatAccess(job.thread_id);
  const metadata = `[CODEX_EVENT ${job.job_id}] event_id=${event.event_id || job.job_id + ':legacy'} sequence=${event.sequence || 0} 事件=${event.kind || 'terminal'} 状态=${event.status}`;
  const compact = '用户正文最多三行：时间与事项；具体完成内容、尚缺什么或需要用户做什么；一个详情链接。必须说明实际内容，不能只报运行中、已完成、收到通知等状态。禁止展示 job_id/topic_id/session_id/event_id、sequence、事件名、仓库目录名和控制指令；这些只供内部路由。需要用户选择时完整保留问题和选项，不受三行限制。';
  const view = link ? `[查看任务](${link.vscode_uri})` : '';
  const draft = (label, content) => `<用户通知草稿>\n${notificationHeading(job, event, label)}\n${content}\n${view}\n</用户通知草稿>`;
  const internal = text => `<内部控制信息，禁止展示>\n${metadata}\n${text}\n</内部控制信息>`;
  if (event.kind === 'notification_check') return internal('本地通知检查，不回复、不展示编号、不调用工具、不派发或续跑业务。');
  if (event.kind === 'session_ready') return `${internal('首次任务会话建立，不调用任何工具；不调用 codex_run、不轮询。')}\n${draft('已启动', '已开始处理这项工作，详细过程可打开原任务查看。')}\n${compact}`;
  if (['notification_alert', 'notification_recovered'].includes(event.kind)) return `${internal(event.detail + '\n不重派、不盲目重发。')}\n${draft('结果通知异常', '任务结果通知未能确认送达，已有结果仍保存在原任务中，请查看详情。')}\n${compact}`;
  if (event.kind === 'execution_alert') return `${internal(event.detail + '\n请领取一次原回执核查所属进程；不重派、不盲目终止PID。')}\n${draft('需要核查', '执行器已退出，后台命令是否结束尚未确认，需要核对原命令和日志。')}\n${compact}`;
  const resume = event.detail?.match(/(?:^|\s)CHECK_ID=([a-f0-9]{24}:\d+)/)?.[1];
  const checkId = resume?.startsWith(job.job_id + ':') ? resume : event.event_id;
  const action = event.kind === 'subagent_check' ? `这是用户明确授权的 Codex 原生子agent 验收。当前执行根=${JSON.stringify(job.cwd)}，MCP服务名见事件说明。仅调用一次 codex_run，wait=false，新 topic“Codex原生子agent只读验收”，不带旧 topic_id/session_id，也不要手填 conversation_id，让本机 hook 绑定真实会话。prompt 必须包含 SUBAGENT_CHECK=${checkId}；要求这个 Codex 执行者实际调用自己的原生 spawn_agent 创建1名只读子agent，让子agent用 PowerShell7 读取 README.md 前60行并输出 CODEX_NATIVE_SUBAGENT_OK，父agent 等待其真实结果，汇总原生子agent ID、来源和返回内容。父agent不能自己读文件冒充委派，不经本MCP递归，不新开CLI冒充子agent；如果原生能力不可用就如实返回 needs_input。所有命令和文件核查都由 Codex/其原生子agent执行；你不能调用 Antigravity invoke_subagent、define_subagent、run_command 或写文件工具代做。只读、不提交、不切分支、不安装或重启、不读凭证；不升级模型。受理后展示job_id，终态再领取结果与查看链接。`
    : event.kind === 'parallel_check' ? `这是用户明确授权的同工作树并发验收，请现在执行，不只是确认收到。当前执行根=${JSON.stringify(job.cwd)}。请连续调用3次 codex_run，三次都 wait=false、使用该 cwd，不带旧 topic_id/session_id；分别做独立只读核查：1项目说明与协作约定；2测试入口与建议的定向测试；3源码模块边界与可独立拆分点。每个任务的 topic 用具体核查名称，prompt 必须包含 PARALLEL_CHECK=${event.event_id} 和各自编号。三者均须实际用 PowerShell7 读取相关文件、输出自己的编号，最后在同一命令短暂等待20秒用于观察重叠，不改文件、不运行重型构建、不提交、不切分支、不安装或重启、不读取凭证。三者互不依赖，可以直接同工作树并发，不需要 worktree；3只是本次验收样本数，不是并发上限。不要自动改模型，沿用本机默认与Medium。提交第一个后继续提交剩余两个，不因进度事件中断，不逐个调用 codex_wait。全部受理后列出3个job_id，收到终态再分别领取结果和展示聊天链接。不得重派已有编号或扩大成业务开发。`
    : event.kind === 'terminal' || !event.schema
    ? `请只调用一次 codex_result(job_id=${job.job_id}) 领取原结果并验收；不要重复派发。`
    : '兼容旧连接的过程事件：静默处理，不回复、不调用工具。';
  const handoff = event.handoff || job.handoff;
  const choice = event.kind === 'terminal' && ['needs_input', 'blocked'].includes(event.status)
    ? `\n【需要判断/用户选择】${handoff?.question || handoff?.text || '请领取原回执查看具体问题。'}${handoff?.options?.length ? '\n选项：' + handoff.options.map((v, i) => `${i + 1}. ${v}`).join('\n') : ''}${handoff?.recommendation ? '\nCodex建议（不是用户授权）：' + handoff.recommendation : ''}\n只有已有明确授权能解决时才能继续；涉及用户偏好、范围、权限或不可逆选择须向用户原样展示问题/选项，等待回答。不得默认选推荐项。用户回答后用原 topic_id/session_id 续接一次，不重开事项。` : '';
  const background = event.kind === 'terminal' && (event.execution_state || job.execution_state) === 'background_unconfirmed'
    ? `\n【后台执行尚未确认结束】Codex对话轮次已结束，但后台命令的退出结果未确认，测试/业务验收仍待完成。${JSON.stringify(event.background_commands || job.background_commands || [])} ${handoff?.kind === 'background_running' ? handoff.text : ''}请先判断等待、核查原命令还是需要用户决定；不能把CLI退出0当成测试通过，不重跑仍可能活动的命令。` : '';
  const label = ['needs_input', 'blocked'].includes(event.status) ? '需要判断' : ['failed', 'timed_out', 'cancelled'].includes(event.status) ? '执行未完成' : '执行结果';
  const content = ['needs_input', 'blocked'].includes(event.status)
    ? `${handoff?.completed ? '已完成：' + handoff.completed + '\n' : ''}${handoff?.question || handoff?.text || '需要核对原结果中的具体阻塞原因。'}${handoff?.options?.length ? '\n' + handoff.options.map((v, i) => `${i + 1}. ${v}`).join('\n') : ''}`
    : (event.execution_state || job.execution_state) === 'background_unconfirmed'
      ? `${handoff?.completed ? '已完成：' + handoff.completed + '\n' : ''}后台命令是否结束尚未确认，最终测试或运行验收还没有结论。`
    : noticeResult(event.result_text || job.error || event.detail) || '尚未取得具体结果说明，需要核对原任务回执。';
  return `${internal(`${checks.has(event.kind) ? '这是用户授权的验收派发。' : '这是后台事件，不是新的用户任务。'}${action}${choice}${background}`)}\n${draft(label, content)}\n${compact}草稿摘自原结果，必须先领取回执并核验，再改写成具体完成内容与未完成项；禁止原样回复“已收到 event_id”或只报状态。单条命令退出0不能扩写成全部测试通过或业务完成。同事项在已有授权内继续时静默续接，只在最终验收、无法继续或需要用户选择时发正文。`;
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
    if (['sent', 'accepted', 'superseded', 'suppressed'].includes(previous?.state)) return false;
    if (['sending', 'uncertain'].includes(previous?.state)) {
      if (await options.reconcile?.(event)) { save(deliveryFile, { ...previous, state: 'accepted', reconciled_at: new Date().toISOString() }); return false; }
      save(deliveryFile, { ...previous, state: 'uncertain', action_required: 'No positive host receipt. Inspect recipient history before explicitly replaying; automatic replay is disabled.' }); return false;
    }
    if (notificationPolicy(job, event, options.now ?? Date.now()) === 'silent') {
      save(deliveryFile, { ...previous, state: 'suppressed', event_id: event.event_id, reason: 'Routine event retained locally; no host/model wakeup.' }); return false;
    }
    if (options.owns && !options.owns()) return false;
    const generation = options.generation || null;
    const attempts = previous?.generation === generation ? previous.attempts || 0 : 0;
    if (previous?.state === 'not_sent' && attempts >= 4) return false;
    if (previous?.state === 'not_sent' && previous.generation === generation && Date.parse(previous.next_attempt_at) > Date.now()) return false;
    const state = { event_id: event.event_id || job.job_id + ':legacy', job_id: job.job_id, conversation_id: job.conversation_id, sequence: event.sequence || 0, state: 'sending', sender_pid: process.pid, generation, attempts: attempts + 1, created_at: new Date().toISOString() };
    save(deliveryFile, state);
    try {
      let message;
      try {
        const resultFile = path.join(path.dirname(deliveryFile), event.schema === 2 ? '..' : '.', 'result.txt');
        const payload = (event.kind === 'terminal' || !event.schema) && fs.existsSync(resultFile) ? { ...event, result_text: fs.readFileSync(resultFile, 'utf8').slice(0, 6000) } : event;
        message = eventMessage(job, payload);
      } catch (error) { error.not_sent = true; throw error; }
      const result = await send(job.conversation_id, message);
      save(deliveryFile, { ...state, state: 'accepted', result }); return true;
    } catch (error) {
      if (await options.reconcile?.(event)) { save(deliveryFile, { ...state, state: 'accepted', reconciled_at: new Date().toISOString(), warning: error.message }); return true; }
      const delays = options.retryDelays || [2000, 10000, 30000];
      const next = error.not_sent === true && attempts < delays.length ? new Date(Date.now() + delays[attempts]).toISOString() : null;
      save(deliveryFile, { ...state, state: error.not_sent === true ? 'not_sent' : 'uncertain', error: error.message, next_attempt_at: next });
      error.retry_at = next; throw error;
    }
  } finally { release(); }
}
async function deliver(broker, id, send, options = {}) {
  const job = broker.get(id), dir = path.dirname(broker.jobPath(id)); let events = notificationEvents(broker.jobPath(id));
  const newer = fs.readdirSync(broker.jobs).filter(n => /^[a-f0-9]{24}$/.test(n) && n !== id).some(n => {
    try { const next = read(broker.jobPath(n)); return next.topic_id === job.topic_id && next.conversation_id === job.conversation_id && next.created_at > job.created_at; } catch { return false; }
  });
  if (newer) {
    for (const event of events.filter(e => !['notification_check', 'parallel_check', 'subagent_check'].includes(e.kind))) {
      const file = event.file.replace(/\.json$/, '.delivery.json');
      if (!fs.existsSync(file) || read(file).state === 'not_sent') save(file, { state: 'superseded', event_id: event.event_id, reason: 'A newer job continued this matter.' });
    }
    events = events.filter(e => ['notification_check', 'parallel_check', 'subagent_check'].includes(e.kind));
    if (!events.length) return false; // Explicit diagnostics may use an old job; stale business notices may not.
  }
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
    if (event.kind === 'notification_alert') {
      const ledgerFile = path.join(path.dirname(broker.jobs), 'notification-alerts.json');
      const group = fs.existsSync(ledgerFile) && Object.values(read(ledgerFile).groups).find(g => g.alert_event === event.file);
      const outstanding = group && group.jobs.some(jobId => notificationEvents(broker.jobPath(jobId)).some(e => {
        if (!['terminal', 'execution_alert'].includes(e.kind)) return false;
        const delivery = e.file.replace(/\.json$/, '.delivery.json');
        return !fs.existsSync(delivery) || !['accepted', 'sent', 'superseded', 'suppressed'].includes(read(delivery).state);
      }));
      if (group && !outstanding) {
        // The original result may have been delivered earlier in this very drain.
        const release = takeClaim(file + '.claim');
        if (release) try {
          const prior = fs.existsSync(file) ? read(file) : null;
          if (!prior || prior.state === 'not_sent') save(file, { state: 'superseded', event_id: event.event_id, reason: 'Original results delivered before this alarm; no stale wakeup.' });
        } finally { release(); }
        // Unknown sends still require positive receipt reconciliation, never suppression/replay.
        sent = await deliverEvent(job, event, file, send, options) || sent;
        continue;
      }
    }
    // A quick task can finish before the debounce; show one final receipt, not stale running alerts.
    if (event !== last && !['notification_check', 'parallel_check', 'subagent_check'].includes(event.kind) && (last.kind === 'terminal' || (event.kind === 'started' && last.kind === 'session_ready')) && (!fs.existsSync(file) || read(file).state === 'not_sent')) { save(file, { state: 'superseded', event_id: event.event_id, superseded_by: last.event_id }); continue; }
    sent = await deliverEvent(job, event, file, send, options) || sent;
  }
  return sent;
}
function auditNotifications(broker, ids, options = {}) {
  const now = options.now ?? Date.now(), threshold = options.alertAfterMs ?? 60000;
  const file = path.join(path.dirname(broker.jobs), 'notification-alerts.json');
  const ledger = fs.existsSync(file) ? read(file) : { schema: 1, groups: {} }, issues = new Map(), touched = new Set();
  for (const id of ids) {
    let job; try { job = broker.get(id); } catch { continue; }
    for (const event of notificationEvents(broker.jobPath(id))) {
      // Alarms protect results and decisions, never routine progress or an alarm itself.
      if (!['terminal', 'execution_alert'].includes(event.kind)) continue;
      const dfile = event.file.replace(/\.json$/, '.delivery.json'), d = fs.existsSync(dfile) ? read(dfile) : { state: 'pending' };
      const age = now - Date.parse(event.created_at);
      const reason = d.state === 'uncertain' || (d.state === 'sending' && now - Date.parse(d.created_at) >= 90000) ? 'outcome_unknown' : d.state === 'not_sent' && d.attempts >= 4 ? 'retry_exhausted' : ['pending', 'not_sent'].includes(d.state) && age >= threshold ? 'delivery_overdue' : null;
      if (!reason) continue;
      const key = `${job.conversation_id}:notification_delivery`;
      if (!issues.has(key)) issues.set(key, { reason: 'notification_delivery', reasons: new Set(), jobs: new Set(), job, events: [] });
      const issue = issues.get(key); issue.jobs.add(id); issue.reasons.add(reason); issue.events.push(`${event.event_id}(state=${d.state},等待${Math.max(0, Math.floor(age / 1000))}秒,尝试${d.attempts || 0}次)`);
    }
  }
  let changed = false;
  for (const [key, issue] of issues) {
    touched.add(key); const previous = ledger.groups[key];
    if (previous?.state === 'open') {
      const jobs = [...new Set([...previous.jobs, ...issue.jobs])].sort();
      if (JSON.stringify(jobs) !== JSON.stringify(previous.jobs)) { previous.jobs = jobs; changed = true; }
      const reasons = [...new Set([...(previous.reasons || []), ...issue.reasons])].sort();
      if (JSON.stringify(reasons) !== JSON.stringify(previous.reasons)) { previous.reasons = reasons; changed = true; }
      continue; // One alert per root cause and originating chat, not per timer/job.
    }
    const episode = (previous?.episode || 0) + 1, digest = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
    const labels = { delivery_overdue: '待投递超过60秒', retry_exhausted: '发送前失败且重试耗尽', outcome_unknown: '发送结果不确定' };
    const event = publishNotification(broker.jobPath(issue.job.job_id), issue.job, `alert-${digest}-${episode}`, 'notification_alert', `通知异常：${[...issue.reasons].map(r => labels[r]).join('、')}；影响${issue.jobs.size}个任务 ${[...issue.jobs].slice(0, 3).join(', ')}；事件 ${issue.events.slice(0, 3).join(', ')}。原任务及已有结果已保留；不要重派任务。`);
    ledger.groups[key] = { state: 'open', reason: issue.reason, reasons: [...issue.reasons].sort(), episode, opened_at: new Date(now).toISOString(), jobs: [...issue.jobs].sort(), alert_job_id: issue.job.job_id, alert_event: event.file };
    changed = true;
  }
  for (const [key, group] of Object.entries(ledger.groups)) {
    if (group.state !== 'open' || touched.has(key)) continue;
    // Only resolve groups whose complete affected set was inspected this pass.
    if (!group.jobs.every(id => ids.has(id))) continue;
    const dfile = group.alert_event.replace(/\.json$/, '.delivery.json'), delivery = fs.existsSync(dfile) ? read(dfile) : { state: 'pending' };
    if (['sending', 'uncertain'].includes(delivery.state)) continue; // Unknown alert receipt also needs reconciliation.
    group.state = 'resolved'; group.resolved_at = new Date(now).toISOString(); changed = true;
    // The delayed original result is the recovery notification; keep health recovery local.
    if (!['sent', 'accepted', 'superseded', 'suppressed'].includes(delivery.state)) {
      save(dfile, { ...delivery, state: 'superseded', reason: 'Recovered before this alert was sent; no extra model wakeup.' });
    }
  }
  if (changed) save(file, ledger);
  return ledger;
}
function watch(broker, send, options = {}) {
  const pending = new Set(), timers = new Map(), offsets = new Map(), known = new Set(), tracked = new Set(); let draining = false, closed = false, interval, watcher;
  const healthFile = path.join(path.dirname(broker.jobs), 'notification-health.json');
  const health = { pid: process.pid, generation: options.generation || null, interval_ms: options.reconcileMs ?? 15000, last_delivery_at: null, watch_error: null };
  const heartbeat = () => { if (fs.existsSync(path.dirname(healthFile))) save(healthFile, { ...health, checked_at: new Date().toISOString(), tracked_jobs: tracked.size, closed }); };
  const schedule = (id, delay = 300, urgent = false) => {
    if (closed) return;
    if (timers.has(id) && !urgent) return; // A busy log stream cannot postpone a progress event indefinitely.
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => { timers.delete(id); pending.add(id); void drain(); }, delay));
  };
  const adaptLegacy = id => {
    const job = broker.get(id); if (!job.conversation_id) return;
    if (job.status === 'orphaned') { publishNotification(broker.jobPath(id), job, 'orphaned-worker', 'execution_alert', '执行器进程已退出，但其后台子进程可能仍在运行。结果未知，需要核对进程归属与日志。'); return; }
    if (job.notification_schema === 2) {
      // A worker crash can persist a terminal state without ever running its finalizer.
      if (terminal.has(job.status) && !notificationEvents(broker.jobPath(id)).some(e => e.kind === 'terminal')) publishNotification(broker.jobPath(id), job, 'terminal', 'terminal', job.error || '执行轮次已结束，请核对原回执与业务验收。');
      return;
    }
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
        try {
          adaptLegacy(id);
          if (await deliver(broker, id, send, options)) health.last_delivery_at = new Date().toISOString();
          const job = broker.get(id), rows = notificationEvents(broker.jobPath(id));
          // Worker status is saved before its terminal outbox event. Do not retire
          // that job in the gap, or a lost final callback will bypass reconciliation.
          const settled = terminal.has(job.status) && ((job.notification_schema !== 2 && rows.length === 0) || rows.some(e => e.kind === 'terminal')) && rows.every(e => {
            const f = e.file.replace(/\.json$/, '.delivery.json'); return fs.existsSync(f) && ['sent', 'accepted', 'superseded', 'suppressed'].includes(read(f).state);
          });
          if (settled) tracked.delete(id); else tracked.add(id);
        }
        catch (error) {
          tracked.add(id);
          process.stderr.write(`${id}: ${error.message}\n`);
          if (error.not_sent && error.retry_at) schedule(id, Math.max(0, Date.parse(error.retry_at) - Date.now()), true);
        }
      }
    } finally { draining = false; }
  };
  const reconcile = () => {
    if (closed) return;
    if (options.owns && !options.owns()) { close(); return; }
    try {
      if (!watcher) attachWatch();
      // Read directory names for discovery, not every historical receipt every fifteen seconds.
      for (const id of fs.readdirSync(broker.jobs)) if (/^[a-f0-9]{24}$/.test(id) && !known.has(id)) { known.add(id); tracked.add(id); }
      const ids = new Set(tracked);
      const alertFile = path.join(path.dirname(broker.jobs), 'notification-alerts.json');
      if (fs.existsSync(alertFile)) for (const g of Object.values(read(alertFile).groups)) if (g.state === 'open') for (const id of g.jobs) ids.add(id);
      const ledger = auditNotifications(broker, ids, options);
      for (const g of Object.values(ledger.groups)) if (g.state === 'open') ids.add(g.alert_job_id);
      for (const id of ids) { tracked.add(id); pending.add(id); }
      heartbeat(); void drain();
    } catch (error) { health.watch_error = error.message; heartbeat(); process.stderr.write(`Local reconciliation: ${error.message}\n`); }
  };
  const onChange = (_event, name) => {
    if (!name) { reconcile(); return; }
    const parts = String(name).split(/[\\/]/);
    if (/^[a-f0-9]{24}$/.test(parts[0]) && ((parts.length === 2 && ['notice.json', 'job.json', 'events.jsonl'].includes(parts[1])) || (parts.length === 3 && parts[1] === 'notifications' && /^\d{8}\.json$/.test(parts[2])))) {
      known.add(parts[0]); tracked.add(parts[0]);
      let urgent = parts[1] === 'notice.json';
      if (parts[1] === 'notifications') { try { urgent = read(path.join(broker.jobs, String(name))).kind === 'terminal'; } catch {} }
      schedule(parts[0], urgent ? 0 : 300, urgent);
    }
  };
  const watchFailed = error => {
    const changed = health.watch_error !== error.message;
    health.watch_error = error.message; health.watch_online = false;
    watcher?.close(); watcher = null;
    heartbeat(); // Local reconciliation remains alive, even if reattachment also fails.
    if (changed) process.stderr.write(`File watcher degraded; local reconciliation continues: ${error.message}\n`);
  };
  const attachWatch = () => {
    try {
      watcher = fs.watch(broker.jobs, { recursive: true }, onChange);
      watcher.on('error', watchFailed);
      if (health.watch_error) health.watch_recovered_at = new Date().toISOString();
      health.watch_error = null; health.watch_online = true;
    } catch (error) { watchFailed(error); }
  };
  attachWatch();
  // Subscribe before recovery scan, so completion during startup cannot be missed.
  for (const name of fs.readdirSync(broker.jobs)) if (/^[a-f0-9]{24}$/.test(name)) { known.add(name); tracked.add(name); pending.add(name); }
  const close = () => { if (closed) return; closed = true; watcher?.close(); watcher = null; clearInterval(interval); for (const timer of timers.values()) clearTimeout(timer); timers.clear(); heartbeat(); };
  interval = setInterval(reconcile, health.interval_ms);
  heartbeat(); void drain(); return { close, reconcile };
}
module.exports = { originHook, deliver, watch, nativeSend, agentCall, recordedReceipt, claimHost, eventMessage, notificationPolicy, notificationHeading, auditNotifications };
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
      ownership.on('error', error => { process.stderr.write(`Ownership watcher degraded; periodic fencing remains active: ${error.message}\n`); ownership.close(); });
      for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { for (const w of watchers) w.close(); ownership.close(); });
    } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = error.duplicate ? 0 : 1; }
  }
}
