'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Broker, save, read, publishNotification, notificationEvents, notificationSummary, commandPhase, dispatch, finalHandoff, executionBlock, takeFileClaim } = require('../src/server.cjs');
const { deliver, watch, claimHost, recordedReceipt, nativeSend, eventMessage, notificationPolicy, notificationHeading, auditNotifications } = require('../src/notifier.cjs');
const chat = '11111111-1111-1111-1111-111111111111';
const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
function fixture(t, status = 'running', schema = 2) {
  const base = fs.realpathSync(process.env.CODEX_EXECUTOR_TEST_ROOT);
  const root = fs.mkdtempSync(path.join(base, 'notices-'));
  t.after(() => { const real = fs.realpathSync(root); assert.ok(real.startsWith(base + path.sep)); fs.rmSync(real, { recursive: true, force: true }); });
  const broker = new Broker({ data: root }), file = broker.jobPath(id); fs.mkdirSync(path.dirname(file));
  const job = { job_id: id, status, notification_schema: schema, conversation_id: chat, topic_id: id, topic: 'fixture task', thread_id: '22222222-2222-2222-2222-222222222222', created_at: new Date().toISOString(), worker_pid: process.pid };
  save(file, job); return { root, broker, job, file, emit: (key, kind, detail) => publishNotification(file, read(file), key, kind, detail) };
}
function changed(dir, trigger, predicate) {
  return new Promise((resolve, reject) => {
    let watcher, timer;
    const finish = error => { watcher?.close(); clearTimeout(timer); error ? reject(error) : resolve(); };
    const check = () => { try { if (predicate()) finish(); } catch (error) { finish(error); } };
    watcher = fs.watch(dir, { recursive: true }, check);
    timer = setTimeout(() => finish(new Error('Expected persisted notification state not observed')), 10000);
    try { trigger(); check(); } catch (error) { finish(error); }
  });
}
test('durable event IDs, sequence, deduplication and restart-visible pending state', t => {
  const f = fixture(t);
  const a = f.emit('start', 'started'), b = f.emit('session', 'session_ready');
  assert.equal(a.sequence, 1); assert.equal(b.sequence, 2); assert.equal(f.emit('start', 'started').event_id, a.event_id);
  assert.equal(notificationEvents(f.file).length, 2); assert.equal(notificationSummary(f.file).pending, 2);
  assert.equal(new Broker({ data: f.root }).receipt(id).notification.latest.state, 'pending');
  assert.equal(publishNotification(f.file, { ...f.job, conversation_id: '' }, 'no', 'started'), null);
});
test('concurrent publishers allocate distinct durable sequence numbers', async t => {
  const f = fixture(t), moduleFile = path.resolve(__dirname, '../src/server.cjs');
  const code = 'const fs=require("node:fs"),{publishNotification}=require(process.argv[1]);const f=process.argv[2];publishNotification(f,JSON.parse(fs.readFileSync(f,"utf8")),process.argv[3],"progress")';
  await Promise.all(Array.from({ length: 8 }, (_, n) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, moduleFile, f.file, 'publisher-' + n], { windowsHide: true }); let error = '';
    child.stderr.on('data', b => { error += b; }); child.on('error', reject); child.on('close', status => status === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.deepEqual(notificationEvents(f.file).map(e => e.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
});
test('known pre-send failure retries the exact event; unknown outcome never blindly replays', async t => {
  const f = fixture(t); f.emit('phase', 'execution_alert'); let calls = 0;
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Object.assign(new Error('offline before send'), { not_sent: true }); }, { retryDelays: [0, 0, 0] }), /offline/);
  assert.equal(notificationSummary(f.file).latest.state, 'not_sent');
  assert.equal(await deliver(f.broker, id, async () => { calls++; return { exit_code: 0 }; }), true);
  assert.equal(calls, 2); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
  assert.equal(await deliver(f.broker, id, async () => { throw Error('duplicate'); }), false);
  f.emit('next', 'execution_alert');
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Error('unknown after send'); }), /unknown/);
  assert.equal(await deliver(f.broker, id, async () => { calls++; return {}; }), false);
  assert.equal(calls, 3); assert.equal(notificationSummary(f.file).uncertain, 1);
  await deliver(f.broker, id, async () => { throw Error('must not send'); }, { reconcile: async () => true });
  assert.equal(notificationSummary(f.file).uncertain, 0); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});
test('single event claim serializes concurrent senders', async t => {
  const f = fixture(t); f.emit('phase', 'execution_alert'); let release, calls = 0;
  const pending = deliver(f.broker, id, async () => { calls++; await new Promise(r => { release = r; }); return {}; });
  assert.equal(await deliver(f.broker, id, async () => { calls++; return {}; }), false);
  release(); await pending; assert.equal(calls, 1);
});
test('positive native receipt reconciles a send error without replay', async t => {
  const f = fixture(t); f.emit('phase', 'execution_alert'); let calls = 0;
  await deliver(f.broker, id, async () => { calls++; throw Error('receipt recording failed'); }, { reconcile: async () => true });
  assert.equal(calls, 1); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});
test('event identity is checked and unrelated conversation receipt cannot acknowledge', async t => {
  const f = fixture(t), event = f.emit('phase', 'execution_alert');
  save(event.file, { ...event, conversation_id: '33333333-3333-3333-3333-333333333333' });
  await assert.rejects(deliver(f.broker, id, async () => { throw Error('must not send'); }), /identity/);
  const receipts = path.join(f.root, 'receipts'); fs.mkdirSync(receipts);
  const receipt = { error: '', payload: { sendMessage: { recipientId: chat, content: eventMessage(f.job, event) } } };
  save(path.join(receipts, 'one.json'), receipt); assert.equal(recordedReceipt(receipts, event), true);
  receipt.payload.sendMessage.recipientId = '33333333-3333-3333-3333-333333333333'; save(path.join(receipts, 'one.json'), receipt);
  assert.equal(recordedReceipt(receipts, event), false);
  receipt.payload.sendMessage.recipientId = chat; receipt.error = 'failed'; save(path.join(receipts, 'one.json'), receipt);
  assert.equal(recordedReceipt(receipts, event), false);
});
test('host generation takeover fences the old sender, same generation is not duplicated', t => {
  const f = fixture(t), first = claimHost(f.root, 'host-one');
  assert.equal(first.owns(), true); assert.throws(() => claimHost(f.root, 'host-one'), /already owns/);
  const next = claimHost(f.root, 'host-two'); assert.equal(first.owns(), false); assert.equal(next.owns(), true);
});
test('ownership lost prevents any send; persisted sending is uncertain after a crash', async t => {
  const f = fixture(t), event = f.emit('phase', 'execution_alert'); let calls = 0;
  await deliver(f.broker, id, async () => { calls++; return {}; }, { owns: () => false }); assert.equal(calls, 0);
  save(event.file.replace(/\.json$/, '.delivery.json'), { state: 'sending', sender_pid: 0 });
  await deliver(f.broker, id, async () => { calls++; return {}; }); assert.equal(calls, 0); assert.equal(notificationSummary(f.file).latest.state, 'uncertain');
});
test('watch sends initial chat link and terminal; restart does not resend accepted events', async t => {
  const f = fixture(t); let messages = [];
  const w = watch(f.broker, async (_, text) => { messages.push(text); return {}; }); t.after(() => w.close());
  await changed(f.root, () => f.emit('session', 'session_ready'), () => notificationSummary(f.file).latest?.state === 'accepted');
  assert.equal(read(f.file).status, 'running'); assert.ok(messages[0].includes('vscode://')); assert.ok(messages[0].includes('不调用 codex_run'));
  await changed(f.root, () => { save(f.file, { ...f.job, status: 'completed' }); publishNotification(f.file, read(f.file), 'terminal', 'terminal'); }, () => notificationSummary(f.file).latest?.kind === 'terminal' && notificationSummary(f.file).latest?.state === 'accepted');
  assert.equal(messages.length, 2); w.close(); await deliver(f.broker, id, async () => { throw Error('restart replay'); });
});
test('watch retries only not_sent with bounded backoff, without task/model polling', async t => {
  const f = fixture(t); let calls = 0;
  const original = process.stderr.write; process.stderr.write = () => true; t.after(() => { process.stderr.write = original; });
  const w = watch(f.broker, async () => { calls++; throw Object.assign(new Error('preflight'), { not_sent: true }); }, { retryDelays: [5, 5, 5] }); t.after(() => w.close());
  await changed(f.root, () => f.emit('phase', 'execution_alert'), () => notificationSummary(f.file).latest?.attempts === 4 && notificationSummary(f.file).latest?.state === 'not_sent');
  assert.equal(calls, 4);
  for (let n = 0; n < 3; n++) await deliver(f.broker, id, async () => { calls++; throw Error('must remain bounded'); });
  assert.equal(calls, 4);
  await deliver(f.broker, id, async () => { calls++; return {}; }, { generation: 'restarted-host' });
  assert.equal(calls, 5); assert.equal(notificationSummary(f.file).latest.attempts, 1);
});
test('legacy running job receives catch-up and its later terminal is not lost', async t => {
  const f = fixture(t, 'running', undefined); delete f.job.notification_schema; save(f.file, f.job);
  const w = watch(f.broker, async () => ({}), { generation: 'new-host', reconcileMs: 25 }); t.after(() => w.close());
  await changed(f.root, () => {}, () => notificationSummary(f.file).latest?.state === 'suppressed');
  assert.equal(notificationEvents(f.file)[0].kind, 'recovered');
  await changed(f.root, () => save(f.file, { ...f.job, status: 'blocked' }), () => notificationSummary(f.file).latest?.kind === 'terminal' && notificationSummary(f.file).latest?.state === 'accepted');
});
test('continuation supersedes old notices and terminal supersedes stale pending progress', async t => {
  const f = fixture(t); f.emit('start', 'started');
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb', nextFile = f.broker.jobPath(next); fs.mkdirSync(path.dirname(nextFile)); save(nextFile, { ...f.job, job_id: next, created_at: '2099-01-01T00:00:00.000Z' });
  assert.equal(await deliver(f.broker, id, async () => { throw Error('stale matter alert'); }), false);
  f.emit('check', 'notification_check'); let checks = 0;
  assert.equal(await deliver(f.broker, id, async () => { throw Error('local check must not enter chat'); }), false);
  f.emit('parallel-check', 'parallel_check');
  assert.equal(await deliver(f.broker, id, async (_, message) => { assert.match(message, /连续调用3次 codex_run/); checks++; return {}; }), true); assert.equal(checks, 1);
  fs.unlinkSync(nextFile); fs.rmdirSync(path.dirname(nextFile)); save(f.file, { ...f.job, status: 'completed' }); f.emit('end', 'terminal'); let calls = 0;
  await deliver(f.broker, id, async () => { calls++; return {}; }); assert.equal(calls, 1); assert.equal(notificationSummary(f.file).pending, 0);
});
test('native preflight failures are known-not-sent, post-send failures remain unknown', async () => {
  let calls = [];
  await assert.rejects(nativeSend('fixture', chat, 'message', async (_, args) => { calls.push(args[0]); return { exit_code: 1, stderr: 'offline' }; }), e => e.not_sent === true);
  assert.deepEqual(calls, ['get-conversation-metadata']); calls = [];
  await assert.rejects(nativeSend('fixture', chat, 'message', async (_, args) => { calls.push(args[0]); return { exit_code: args[0] === 'send-message' ? 1 : 0, stderr: 'unknown' }; }), e => e.not_sent !== true);
  assert.deepEqual(calls, ['get-conversation-metadata', 'send-message']);
});
test('phase detection selects meaningful gates, not every read/log line', () => {
  assert.equal(commandPhase('cargo test --offline -p api'), '测试'); assert.equal(commandPhase('cargo clippy --workspace'), '静态检查');
  assert.equal(commandPhase('git status --short'), null); assert.equal(commandPhase('Get-Content file.txt'), null);
  const instructions = dispatch({ settings: { project: 'fixture' } }, { method: 'initialize' }).instructions;
  assert.match(instructions, /Only terminal events require codex_result/); assert.match(instructions, /notification_check stays local and silent/);
  assert.match(instructions, /without a numeric concurrency cap/);
});
test('parallel verification is explicit read-only dispatch, not a task-count limit or a status acknowledgment', t => {
  const f = fixture(t), event = f.emit('parallel', 'parallel_check');
  const message = eventMessage(f.job, event);
  assert.match(message, /连续调用3次 codex_run/); assert.match(message, /3只是本次验收样本数/);
  assert.match(message, /PARALLEL_CHECK=/); assert.match(message, /不改文件/); assert.match(message, /不带旧 topic_id\/session_id/);
  assert.doesNotMatch(message, /这是后台事件，不是新的用户任务/);
});
test('native subagent verification requires real Codex spawn, not another CLI or Antigravity agent', t => {
  const f = fixture(t), event = f.emit('subagent', 'subagent_check'), message = eventMessage(f.job, event);
  assert.match(message, /原生 spawn_agent/); assert.match(message, /父agent不能自己读文件冒充委派/);
  assert.match(message, /不新开CLI冒充子agent/); assert.match(message, /不能调用 Antigravity invoke_subagent/);
  assert.match(message, /不要手填 conversation_id/); assert.match(message, /SUBAGENT_CHECK=/);
  const resumed = eventMessage(f.job, { ...event, detail: '恢复未派发检查 CHECK_ID=' + f.job.job_id + ':99' });
  assert.ok(resumed.includes('SUBAGENT_CHECK=' + f.job.job_id + ':99'));
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function dropWatch(t, jobs) {
  const original = fs.watch; let callback, emitter;
  fs.watch = (file, ...args) => {
    if (path.resolve(file) !== path.resolve(jobs)) return original(file, ...args);
    callback = args.at(-1); emitter = new (require('node:events').EventEmitter)(); emitter.close = () => {}; return emitter;
  };
  t.after(() => { fs.watch = original; }); const trigger = (...args) => callback(...args); trigger.fail = error => emitter.emit('error', error); return trigger;
}
test('lost callbacks, null filenames and a missed new directory recover locally without model heartbeat', async t => {
  const f = fixture(t); const callback = dropWatch(t, f.broker.jobs); let calls = 0;
  const w = watch(f.broker, async () => { calls++; return {}; }, { reconcileMs: 30 }); t.after(() => w.close());
  await sleep(50); save(f.file, { ...f.job, status: 'completed' }); f.emit('terminal', 'terminal');
  await sleep(180); assert.equal(notificationSummary(f.file).latest.state, 'accepted'); assert.equal(calls, 1);
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb', nextFile = f.broker.jobPath(next); fs.mkdirSync(path.dirname(nextFile));
  const job = { ...f.job, job_id: next, topic_id: next, status: 'completed' }; save(nextFile, job); publishNotification(nextFile, job, 'terminal', 'terminal');
  callback('rename', null); await sleep(180); assert.equal(notificationSummary(nextFile).latest.state, 'accepted'); assert.equal(calls, 2);
  await sleep(100); assert.equal(calls, 2); assert.equal(read(path.join(f.root, 'notification-health.json')).closed, false);
});
test('claim contention is recovered by reconciliation rather than dropping a terminal forever', async t => {
  const f = fixture(t, 'completed'); const event = f.emit('terminal', 'terminal');
  const release = takeFileClaim(event.file.replace(/\.json$/, '.delivery.json') + '.claim');
  const w = watch(f.broker, async () => ({}), { reconcileMs: 25 }); t.after(() => w.close());
  await sleep(70); assert.equal(notificationSummary(f.file).latest.state, 'pending'); release();
  await sleep(160); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});
test('local checks cannot bypass persisted retry deadlines or replay uncertain sends', async t => {
  const f = fixture(t); f.emit('phase', 'execution_alert'); let calls = 0;
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Object.assign(Error('offline'), { not_sent: true }); }, { retryDelays: [1000, 1000, 1000] }));
  for (let n = 0; n < 4; n++) await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 1); assert.ok(notificationSummary(f.file).latest.next_attempt_at);
});
test('notification alarms coalesce by conversation/root cause, persist and recover once', async t => {
  const f = fixture(t), e = f.emit('phase', 'execution_alert'); const old = Date.now() - 70000; save(e.file, { ...e, created_at: new Date(old).toISOString() });
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb', nf = f.broker.jobPath(next); fs.mkdirSync(path.dirname(nf));
  const job = { ...f.job, job_id: next, topic_id: next }; save(nf, job); const ne = publishNotification(nf, job, 'phase', 'execution_alert'); save(ne.file, { ...ne, created_at: new Date(old).toISOString() });
  const ids = new Set([id, next]); auditNotifications(f.broker, ids); auditNotifications(f.broker, ids);
  assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_alert').length, 1); assert.equal(notificationEvents(nf).length, 1);
  const group = Object.values(read(path.join(f.root, 'notification-alerts.json')).groups)[0]; assert.equal(group.jobs.length, 2);
  save(e.file.replace(/\.json$/, '.delivery.json'), { state: 'sending', created_at: new Date(Date.now() - 100000).toISOString() });
  auditNotifications(f.broker, ids); assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_alert').length, 1);
  assert.ok(Object.values(read(path.join(f.root, 'notification-alerts.json')).groups)[0].reasons.includes('outcome_unknown'));
  fs.unlinkSync(e.file.replace(/\.json$/, '.delivery.json'));
  await deliver(f.broker, id, async () => ({})); await deliver(f.broker, next, async () => ({}));
  auditNotifications(f.broker, ids); auditNotifications(f.broker, ids);
  assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_recovered').length, 0);
  assert.equal(Object.values(read(path.join(f.root, 'notification-alerts.json')).groups)[0].state, 'resolved');
});
test('recovery before an alert was sent suppresses stale model wakeups and does not recurse', async t => {
  const f = fixture(t), e = f.emit('phase', 'execution_alert'); save(e.file, { ...e, created_at: new Date(Date.now() - 70000).toISOString() });
  const ids = new Set([id]); auditNotifications(f.broker, ids);
  const alert = notificationEvents(f.file).find(e => e.kind === 'notification_alert');
  save(e.file.replace(/\.json$/, '.delivery.json'), { state: 'accepted' }); auditNotifications(f.broker, ids);
  assert.equal(read(alert.file.replace(/\.json$/, '.delivery.json')).state, 'superseded');
  assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_recovered').length, 0);
  const ledger = auditNotifications(f.broker, ids); assert.equal(Object.values(ledger.groups)[0].state, 'resolved');
});
test('watch failure retains reconciliation, reattaches and delivers a later terminal', async t => {
  const f = fixture(t); const callback = dropWatch(t, f.broker.jobs); let calls = 0;
  const w = watch(f.broker, async () => { calls++; return {}; }, { reconcileMs: 25 }); t.after(() => w.close());
  await sleep(90); assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(f.root, 'notification-alerts.json')), false);
  callback.fail(new Error('fixture watcher failure'));
  const health = read(path.join(f.root, 'notification-health.json')); assert.equal(health.closed, false); assert.equal(health.watch_online, false); assert.equal(health.watch_error, 'fixture watcher failure');
  save(f.file, { ...f.job, status: 'completed' }); f.emit('terminal', 'terminal');
  await sleep(180); assert.equal(calls, 1); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
  const recovered = read(path.join(f.root, 'notification-health.json'));
  assert.equal(recovered.closed, false); assert.equal(recovered.watch_online, true); assert.equal(recovered.watch_error, null); assert.ok(recovered.watch_recovered_at);
});
test('structured decisions survive persistence, include real options and do not auto-select', t => {
  const f = fixture(t, 'needs_input');
  const handoff = finalHandoff('[CODEX_NEEDS_INPUT]\n' + JSON.stringify({ question: '选工作树还是等待？', options: ['工作树：隔离修改', '等待：复用当前目录'], recommendation: '等待', completed: '已定位重叠范围' }));
  save(f.file, { ...f.job, handoff }); const event = f.emit('terminal', 'terminal'); const message = eventMessage(read(f.file), event);
  assert.deepEqual(new Broker({ data: f.root }).receipt(id).handoff, handoff);
  assert.match(message, /选工作树还是等待/); assert.match(message, /工作树：隔离修改/); assert.match(message, /不得默认选推荐项/); assert.ok(message.includes('原 topic_id/session_id'));
  assert.equal(finalHandoff('日志中引用 [CODEX_NEEDS_INPUT] 不应暂停'), null);
  assert.equal(finalHandoff('  [CODEX_NEEDS_INPUT] 请确认A或B').kind, 'needs_input');
  const blocked = finalHandoff('[CODEX_BLOCKED] 执行约束要求保留原文件，原文件未修改；候选完成不代表已经应用。');
  const blockedMessage = eventMessage(f.job, { ...event, status: 'blocked', handoff: blocked });
  assert.equal(blocked.kind, 'blocked'); assert.match(blockedMessage, /状态=blocked/); assert.match(blockedMessage, /原文件未修改/);
});

test('default reconciliation is fifteen seconds and an empty outbox does not send a model heartbeat', t => {
  const f = fixture(t); let calls = 0;
  const w = watch(f.broker, async () => { calls++; return {}; });
  try { assert.equal(read(path.join(f.root, 'notification-health.json')).interval_ms, 15000); assert.equal(calls, 0); }
  finally { w.close(); }
});

test('plan refusal keeps executor reasons distinct, requires a human choice and tolerates legacy/malformed output', t => {
  const f = fixture(t, 'blocked');
  const payload = { original_plan: '直接播放', reason: '缺少画面显示通路', impact: '原目标不能交付', question: '继续补齐还是修改目标？', options: ['补齐：保留原目标', '修改：接受额外等待'], recommendation: '补齐', completed: '已核对代码' };
  const handoff = finalHandoff('[CODEX_PLAN_REJECTED]\n```json\n' + JSON.stringify(payload) + '\n```');
  assert.equal(handoff.kind, 'blocked'); assert.equal(handoff.requires_user_decision, true);
  for (const key of ['original_plan', 'reason', 'impact']) assert.equal(handoff[key], payload[key]);
  save(f.file, { ...f.job, handoff }); const event = f.emit('terminal', 'terminal'), message = eventMessage(read(f.file), event);
  assert.deepEqual(new Broker({ data: f.root }).result(id).handoff, handoff);
  for (const text of ['方案被执行端拒绝', payload.original_plan, payload.reason, payload.impact, ...payload.options, '不得掩盖拒绝', 'plan_decision.refusal_job_id=']) assert.ok(message.includes(text), text);
  const draft = message.match(/<用户通知草稿>([\s\S]*?)<\/用户通知草稿>/)[1];
  assert.ok(!draft.includes('refusal_job_id=')); assert.ok(!draft.includes('Codex建议'), 'Recommendation is not the executor reason or human answer');
  assert.equal(finalHandoff('[CODEX_BLOCKED] 旧式明确拒绝').requires_user_decision, true);
  assert.equal(finalHandoff('[CODEX_PLAN_REJECTED] { malformed').requires_user_decision, true);
  assert.equal(finalHandoff('[CODEX_NEEDS_INPUT] {"decision_scope":"plan","question":"改目标吗？"}').requires_user_decision, true);
  assert.equal(finalHandoff('[CODEX_NEEDS_INPUT] 补充一个路径').requires_user_decision, undefined);
  assert.equal(finalHandoff('测试日志引用 [CODEX_PLAN_REJECTED] 不应触发'), null);
  assert.equal(finalHandoff('编译报错，正在修复'), null);
});

test('an unacknowledged refusal notice is not erased by a newer job, restart delivery stays deduplicated', async t => {
  const f = fixture(t, 'blocked'), handoff = finalHandoff('[CODEX_PLAN_REJECTED] 方案不能达到目标');
  save(f.file, { ...f.job, created_at: '2000-01-01T00:00:00.000Z', handoff }); f.emit('terminal', 'terminal');
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb'; fs.mkdirSync(path.dirname(f.broker.jobPath(next)));
  save(f.broker.jobPath(next), { ...f.job, job_id: next, status: 'completed', created_at: '2001-01-01T00:00:00.000Z' });
  let sends = 0;
  assert.equal(await deliver(new Broker({ data: f.root }), id, async (recipient, message) => { sends++; assert.equal(recipient, chat); assert.match(message, /方案被执行端拒绝/); return {}; }), true);
  assert.equal(await deliver(new Broker({ data: f.root }), id, async () => { sends++; return {}; }), false);
  assert.equal(sends, 1); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});

test('execution policy reports retain facts and unknowns, parse trailing JSON notes and never become plan approval', t => {
  const payload = { blocked_action: '隔离原型启动', reason: 'Rejected: blocked by policy', reported_cause: '猜测：审批参数', known_facts: ['完整访问'], unknowns: ['拒绝规则'], affected_checks: ['音画同步'], completed: ['已构建', '未实机验证'], blocker_type: 'execution_policy', decision_scope: 'plan' };
  const h = finalHandoff('[CODEX_NEEDS_INPUT]\n```json\n' + JSON.stringify(payload) + '\n```\n原始证据仍在日志中。');
  assert.equal(h.kind, 'execution_blocked'); assert.equal(h.requires_user_decision, undefined); assert.equal(h.completed, '已构建\n未实机验证');
  const block = executionBlock(h, '', id); assert.equal(block.source, 'executor_report'); assert.equal(block.cause_status, 'unverified'); assert.equal(block.reported_cause, payload.reported_cause); assert.equal(block.auto_retry_allowed, false);
  assert.equal(finalHandoff('[CODEX_EXECUTION_BLOCKED] malformed {').kind, 'execution_blocked');
  assert.equal(finalHandoff('[CODEX_PLAN_REJECTED]\n' + JSON.stringify(payload)).requires_user_decision, true, 'Do not hide an independent plan refusal');
  assert.equal(finalHandoff('引用 [CODEX_EXECUTION_BLOCKED] 不应触发'), null);
  assert.equal(executionBlock(null, 'a successful command printed Rejected: blocked by policy'), null);
});

test('only a native router execution-denial log is machine evidence; it does not prove a specific root cause', t => {
  const line = '2026-11-01T03:33:17.760090Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected: blocked by policy" }';
  const block = executionBlock(null, line, id); assert.equal(block.source, 'cli_stderr'); assert.equal(block.cause_status, 'unverified'); assert.equal(block.blocked_job_id, id);
  for (const text of [line.replace('ERROR', 'WARN'), line.replace('codex_core::tools::router', 'unrelated'), 'quoted ' + line, 'Rejected: blocked by policy']) assert.equal(executionBlock(null, text), null);
  assert.equal(executionBlock(null, line.replace('blocked by policy', 'path not found')), null);
  assert.equal(executionBlock(null, line + 'x'.repeat(4000)).raw_excerpt_truncated, true);
});

test('execution-policy notifications preserve the plan, do not ask a new plan choice and survive later diagnosis', async t => {
  const f = fixture(t, 'execution_blocked'), h = finalHandoff('[CODEX_EXECUTION_BLOCKED]\n{"blocked_action":"隔离原型启动","reason":"Rejected: blocked by policy","affected_checks":["连续播放"]}'), block = executionBlock(h, '', id);
  save(f.file, { ...f.job, created_at: '2000-01-01T00:00:00.000Z', handoff: h, execution_block: block }); const event = f.emit('terminal', 'terminal');
  assert.deepEqual(event.execution_block, block); assert.deepEqual(new Broker({ data: f.root }).receipt(id).execution_block, block);
  const message = eventMessage(read(f.file), event), draft = message.match(/<用户通知草稿>([\s\S]*?)<\/用户通知草稿>/)[1];
  for (const text of ['执行策略受阻', '原方案保留', '隔离原型启动', '连续播放']) assert.ok(draft.includes(text));
  assert.ok(!draft.includes('方案被执行端拒绝')); assert.ok(!draft.includes('选择')); assert.match(message, /不自动重试/); assert.match(message, /不是权限授予/);
  const next = 'b'.repeat(24); fs.mkdirSync(path.dirname(f.broker.jobPath(next)));
  const diagnostic = { ...f.job, job_id: next, status: 'completed', created_at: '2001-01-01T00:00:00.000Z', execution_followup: { intent: 'diagnose', blocked_job_ids: [id] }, execution_constraints: [block] }; save(f.broker.jobPath(next), diagnostic);
  assert.equal(await deliver(f.broker, id, async () => ({})), true); assert.equal(await deliver(new Broker({ data: f.root }), id, async () => { throw Error('duplicate'); }), false);
  assert.match(eventMessage(diagnostic, { ...event, status: 'completed', execution_block: null, handoff: null }), /原操作仍受阻/);
});

test('blocked and failed user drafts show the actual error, progress and next action before diagnosis', t => {
  const f = fixture(t, 'execution_blocked');
  const handoff = finalHandoff('[CODEX_EXECUTION_BLOCKED]\n' + JSON.stringify({ blocked_action: '启动隔离原型', reason: 'CreateProcess: Rejected: blocked by policy', completed: ['原型构建完成', '模块测试通过'], affected_checks: ['连续播放', '音画同步'], unknowns: ['具体规则尚未确认'] }));
  const execution_block = executionBlock(handoff, '', id), job = { ...f.job, handoff, execution_block };
  const message = eventMessage(job, { ...f.emit('terminal', 'terminal'), handoff, execution_block });
  const draft = message.match(/<用户通知草稿>([\s\S]*?)<\/用户通知草稿>/)[1];
  for (const text of ['启动隔离原型', 'CreateProcess: Rejected: blocked by policy', '原型构建完成', '模块测试通过', '连续播放', '音画同步', '未恢复', '下一步', '具体规则尚未确认']) assert.ok(draft.includes(text), text);
  assert.match(message, /先反馈，再排查/); assert.match(message, /失败、受阻、暂停或需要用户选择不受三行限制/); assert.doesNotMatch(draft, /job_id|event_id|known_facts|选择方案/);
  const failed = eventMessage({ ...f.job, status: 'failed', error: 'link.exe exited with code 1120' }, { ...f.emit('failed', 'terminal'), status: 'failed' });
  assert.match(failed.match(/<用户通知草稿>([\s\S]*?)<\/用户通知草稿>/)[1], /link.exe exited with code 1120/);
});

test('matching terminal evidence repairs legacy status overwrite without rewriting or replaying accepted notices', async t => {
  const f = fixture(t, 'execution_blocked'), handoff = finalHandoff('[CODEX_EXECUTION_BLOCKED]\n{"reason":"Rejected: blocked by policy","blocked_action":"隔离原型启动"}');
  const job = { ...f.job, handoff, execution_block: executionBlock(handoff, '', id), execution_state: 'policy_blocked', verification_state: 'blocked' }; save(f.file, job);
  fs.writeFileSync(path.join(path.dirname(f.file), 'result.txt'), '[CODEX_EXECUTION_BLOCKED]\n{"reason":"Rejected: blocked by policy"}', 'utf8');
  const event = f.emit('terminal', 'terminal'); await deliver(f.broker, id, async () => ({}));
  const eventBytes = fs.readFileSync(event.file), deliveryFile = event.file.replace(/\.json$/, '.delivery.json'), deliveryBytes = fs.readFileSync(deliveryFile);
  save(f.file, { ...job, status: 'failed', error: 'Worker exited before recording completion', ended_at: new Date().toISOString() });
  const restarted = new Broker({ data: f.root }), recovered = restarted.get(id);
  assert.equal(recovered.status, 'execution_blocked'); assert.equal(recovered.error, 'Rejected: blocked by policy'); assert.equal(recovered.ended_at, event.created_at);
  assert.equal(recovered.state_recovery.evidence_event_id, event.event_id); assert.equal(recovered.state_recovery.previous_error, 'Worker exited before recording completion');
  assert.equal(await deliver(restarted, id, async () => { throw Error('Must not replay accepted notice'); }), false);
  assert.deepEqual(fs.readFileSync(event.file), eventBytes); assert.deepEqual(fs.readFileSync(deliveryFile), deliveryBytes);
  save(f.file, { ...job, status: 'failed', error: 'independent worker failure' }); assert.equal(restarted.get(id).status, 'failed');
  save(f.file, { ...job, topic_id: 'b'.repeat(24), status: 'failed', error: 'Worker exited before recording completion' }); assert.equal(restarted.get(id).status, 'failed');
});

test('a dead worker keeps a saved refusal or question and raw stderr instead of a generic crash message', t => {
  const f = fixture(t), dir = path.dirname(f.file), stale = { ...f.job, worker_pid: 2147483647, created_at: '2000-01-01T00:00:00Z' };
  save(f.file, stale); fs.writeFileSync(path.join(dir, 'result.txt'), '[CODEX_EXECUTION_BLOCKED]\n{"reason":"Rejected: blocked by policy","completed":["已构建"]}', 'utf8');
  const recovered = f.broker.get(id); assert.equal(recovered.status, 'execution_blocked'); assert.equal(recovered.handoff.completed, '已构建'); assert.equal(recovered.error, 'Rejected: blocked by policy'); assert.match(recovered.worker_error, /Worker exited/);
  save(f.file, stale); fs.writeFileSync(path.join(dir, 'result.txt'), '[CODEX_NEEDS_INPUT]\n{"question":"是否关闭正在播放的窗口？","options":["保留窗口","稍后验收"]}', 'utf8');
  assert.equal(f.broker.get(id).status, 'needs_input'); assert.deepEqual(f.broker.get(id).handoff.options, ['保留窗口', '稍后验收']);
  save(f.file, stale); fs.unlinkSync(path.join(dir, 'result.txt')); fs.writeFileSync(path.join(dir, 'stderr.log'), 'compiler fixture: missing runtime DLL', 'utf8');
  const failed = f.broker.get(id); assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'compiler fixture: missing runtime DLL');
});

test('liveness recovery re-reads terminal state under claim before writing a crash fallback', t => {
  const f = fixture(t, 'completed'), terminalBytes = fs.readFileSync(f.file), readFile = fs.readFileSync; let stale = true;
  fs.readFileSync = (file, ...args) => {
    if (path.resolve(String(file)) === f.file && stale) { stale = false; return JSON.stringify({ ...f.job, status: 'running', worker_pid: 2147483647, created_at: '2000-01-01T00:00:00Z' }); }
    return readFile(file, ...args);
  };
  try { assert.equal(f.broker.get(id).status, 'completed'); assert.deepEqual(readFile(f.file), terminalBytes); }
  finally { fs.readFileSync = readFile; }
});

test('health allows three reconciliation intervals before declaring the notifier stale', t => {
  const f = fixture(t), previous = process.env.CODEX_EXECUTOR_DATA;
  process.env.CODEX_EXECUTOR_DATA = f.root;
  try {
    save(path.join(f.root, 'notification-host.json'), { pid: process.pid });
    const health = { interval_ms: 15000, closed: false, checked_at: new Date(Date.now() - 30000).toISOString() };
    save(path.join(f.root, 'notification-health.json'), health);
    let service = notificationSummary(f.file).service;
    assert.equal(service.health_window_ms, 45000); assert.equal(service.online, true);
    save(path.join(f.root, 'notification-health.json'), { ...health, checked_at: new Date(Date.now() - 46000).toISOString() });
    service = notificationSummary(f.file).service; assert.equal(service.online, false);
  } finally { if (previous === undefined) delete process.env.CODEX_EXECUTOR_DATA; else process.env.CODEX_EXECUTOR_DATA = previous; }
});
test('a CLI terminal with unfinished commands explicitly reports background uncertainty', t => {
  const f = fixture(t, 'completed'); save(f.file, { ...f.job, execution_state: 'background_unconfirmed', verification_state: 'pending', background_commands: [{ item_id: 'test1', command: 'cargo test -p fixture', state: 'exit_unconfirmed' }] });
  const event = f.emit('terminal', 'terminal'), message = eventMessage(read(f.file), event);
  assert.match(message, /后台执行尚未确认结束/); assert.match(message, /cargo test/); assert.match(message, /不能把CLI退出0当成测试通过/);
});

test('a crashed schema2 worker receives one terminal notice, not silence or task replay', async t => {
 const f=fixture(t); fs.writeFileSync(path.join(path.dirname(f.file),'worker-error.txt'),'fixture worker crash'); let calls=0;
 const w=watch(f.broker,async(_,text)=>{calls++;assert.match(text,/状态=failed/);return{}},{reconcileMs:25});t.after(()=>w.close());
 await sleep(180);assert.equal(read(f.file).status,'failed');assert.equal(notificationEvents(f.file).filter(e=>e.kind==='terminal').length,1);assert.equal(calls,1);
});
test('an orphaned child is an inspect-only alert, not cancelled or redispatched', async t => {
 const f=fixture(t);save(f.file,{...f.job,worker_pid:2147483647,child_pid:process.pid,created_at:new Date(Date.now()-60000).toISOString()});let calls=0;
 const w=watch(f.broker,async(_,text)=>{calls++;assert.match(text,/不重派、不盲目终止PID/);return{}},{reconcileMs:25});t.after(()=>w.close());
 await sleep(180);assert.equal(notificationEvents(f.file).filter(e=>e.kind==='execution_alert').length,1);assert.equal(calls,1);
});

test('terminal status before terminal publication cannot retire the job from reconciliation', async t => {
 const f=fixture(t);f.emit('phase','execution_alert');dropWatch(t,f.broker.jobs);let release,calls=0;
 const w=watch(f.broker,async()=>{calls++;if(calls===1)await new Promise(r=>{release=r});return{}},{reconcileMs:25});t.after(()=>w.close());
 await sleep(40);assert.equal(typeof release,'function');save(f.file,{...f.job,status:'completed'});release();
 await sleep(180);const terminal=notificationEvents(f.file).find(e=>e.kind==='terminal');assert.ok(terminal);assert.equal(notificationSummary(f.file).latest.state,'accepted');assert.equal(calls,2);
 f.emit('terminal','terminal');await sleep(80);assert.equal(calls,2);
});

test('routine events stay durable but silent, never trigger alarms, and do not hide decisions', async t => {
  const f = fixture(t); let calls = 0;
  for (const kind of ['started', 'files_changed', 'phase_started', 'phase_finished', 'waiting_capacity', 'resumed', 'recovered', 'progress', 'notification_recovered']) {
    const event = f.emit(kind, kind, 'fixture');
    save(event.file, { ...event, created_at: new Date(Date.now() - 70000).toISOString() });
  }
  auditNotifications(f.broker, new Set([id]));
  assert.equal(fs.existsSync(path.join(f.root, 'notification-alerts.json')), false);
  await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 0); assert.equal(notificationEvents(f.file).length, 9);
  assert.equal(notificationSummary(f.file).pending, 0);
  for (const e of notificationEvents(f.file)) assert.equal(read(e.file.replace(/\.json$/, '.delivery.json')).state, 'suppressed');
  save(f.file, { ...f.job, status: 'needs_input', handoff: { question: '保留哪一份？', options: ['甲', '乙'] } });
  f.emit('decision', 'terminal');
  await deliver(f.broker, id, async (_, text) => { calls++; assert.match(text, /保留哪一份/); assert.match(text, /不得默认选推荐项/); return {}; });
  assert.equal(calls, 1);
});

test('continuation and stale startup links are silent; first fresh chat and diagnostics still send', async t => {
  const f = fixture(t), event = f.emit('session', 'session_ready'); let calls = 0;
  assert.equal(notificationPolicy(f.job, event), 'send');
  assert.equal(notificationPolicy({ ...f.job, parent_job_id: id }, event), 'silent');
  assert.equal(notificationPolicy({ ...f.job, resumed_session: true }, event), 'silent');
  assert.equal(notificationPolicy(f.job, event, Date.parse(event.created_at) + 120001), 'silent');
  save(f.file, { ...f.job, parent_job_id: id });
  await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 0);
  for (const kind of ['notification_check', 'parallel_check', 'subagent_check']) f.emit(kind, kind);
  await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 2);
});

test('silent policy preserves unknown prior sends and never blindly replays them', async t => {
  const f = fixture(t), event = f.emit('phase', 'phase_finished'); let calls = 0;
  save(event.file.replace(/\.json$/, '.delivery.json'), { state: 'sending' });
  await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 0); assert.equal(notificationSummary(f.file).latest.state, 'uncertain');
  auditNotifications(f.broker, new Set([id]));
  assert.equal(fs.existsSync(path.join(f.root, 'notification-alerts.json')), false);
  await deliver(f.broker, id, async () => { calls++; return {}; }, { reconcile: async () => true });
  assert.equal(calls, 0); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});

test('startup watcher creation failure still discovers new terminal jobs through local checks', async t => {
  const f = fixture(t), original = fs.watch; let calls = 0;
  fs.watch = () => { throw new Error('watch unavailable'); };
  t.after(() => { fs.watch = original; });
  const stderr = process.stderr.write; process.stderr.write = () => true; t.after(() => { process.stderr.write = stderr; });
  const w = watch(f.broker, async () => { calls++; return {}; }, { reconcileMs: 25 }); t.after(() => w.close());
  save(f.file, { ...f.job, status: 'completed' }); f.emit('terminal', 'terminal');
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb', nextFile = f.broker.jobPath(next); fs.mkdirSync(path.dirname(nextFile));
  const job = { ...f.job, job_id: next, topic_id: next, status: 'completed' }; save(nextFile, job); publishNotification(nextFile, job, 'terminal', 'terminal');
  await sleep(180);
  assert.equal(calls, 2); assert.equal(notificationSummary(nextFile).latest.state, 'accepted');
  const health = read(path.join(f.root, 'notification-health.json')); assert.equal(health.closed, false); assert.equal(health.watch_online, false);
});

test('compact notifications use event time, distinguish dates/delay and bound result claims', t => {
  const f = fixture(t), job = { ...f.job, cwd: path.join(f.root, 'example'), topic: '播放验收', settings: { notification_timezone: 'Asia/Shanghai' } };
  const now = Date.parse('2026-10-31T12:00:00Z');
  assert.equal(notificationHeading(job, { created_at: '2026-10-31T11:59:00Z' }, '已启动', now), '19:59 · 播放验收 · 已启动');
  assert.equal(notificationHeading(job, { created_at: '2026-10-30T11:59:00Z' }, '待验收', now), '10-30 19:59 · 播放验收 · 待验收（延迟送达）');
  const message = eventMessage(job, f.emit('terminal', 'terminal'));
  assert.match(message, /最多三行/); assert.match(message, /单条命令退出0不能扩写成全部测试通过/);
  assert.match(message, /静默续接/); assert.match(message, /问题和选项/);
});

test('delivering the original result suppresses an alarm that became stale in the same drain', async t => {
  const f = fixture(t, 'completed'), event = f.emit('terminal', 'terminal');
  save(event.file, { ...event, created_at: new Date(Date.now() - 70000).toISOString() });
  auditNotifications(f.broker, new Set([id])); let calls = 0;
  await deliver(f.broker, id, async (_, message) => { calls++; assert.match(message, /事件=terminal/); return {}; });
  assert.equal(calls, 1);
  const alert = notificationEvents(f.file).find(e => e.kind === 'notification_alert');
  assert.equal(read(alert.file.replace(/\.json$/, '.delivery.json')).state, 'superseded');
  auditNotifications(f.broker, new Set([id]));
  assert.equal(Object.values(read(path.join(f.root, 'notification-alerts.json')).groups)[0].state, 'resolved');
});

test('notification checks stay local, including queued old checks, without a model acknowledgment', async t => {
  const f = fixture(t), event = f.emit('check', 'notification_check'); let calls = 0;
  save(event.file.replace(/\.json$/, '.delivery.json'), { state: 'not_sent', attempts: 2 });
  await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 0); assert.equal(notificationSummary(f.file).latest.state, 'suppressed');
  assert.equal(notificationPolicy(f.job, { ...event, schema: undefined }), 'silent');
  assert.doesNotMatch(eventMessage(f.job, event), /只回复.*通知已收到/);
});

test('terminal notices carry actual result content and separate it from routing codes', async t => {
  const f = fixture(t, 'completed');
  fs.writeFileSync(path.join(path.dirname(f.file), 'result.txt'), '已完成合集收藏的事务处理与跨季预热；真实窗口播放验证尚未完成。\n\njob_id: ' + id, 'utf8');
  f.emit('terminal', 'terminal'); let notice;
  await deliver(f.broker, id, async (_, message) => { notice = message; return {}; });
  const content = notice.match(/<用户通知草稿>\n([\s\S]*?)\n<\/用户通知草稿>/)[1];
  assert.match(content, /已完成合集收藏的事务处理与跨季预热/);
  assert.match(content, /真实窗口播放验证尚未完成/);
  assert.doesNotMatch(content, /job_id|event_id|sequence|phase_started|aaaaaaaaaaaaaaaaaaaaaaaa|fixture-root/);
  assert.match(notice, /必须先领取回执并核验/);
});

test('question notifications contain completed work, the concrete question and all choices', t => {
  const f = fixture(t, 'needs_input'), handoff = { completed: '已完成跨季预热实现', question: '当前窗口正在播放，何时执行播放验收？', options: ['现在关闭当前窗口后验收', '保留窗口，稍后验收'] };
  const message = eventMessage(f.job, { ...f.emit('terminal', 'terminal'), handoff });
  const content = message.match(/<用户通知草稿>\n([\s\S]*?)\n<\/用户通知草稿>/)[1];
  assert.match(content, /已完成跨季预热实现/); assert.match(content, /何时执行播放验收/);
  for (const option of handoff.options) assert.ok(content.includes(option));
  assert.doesNotMatch(content, /job_id|event_id|状态=needs_input/);
});

test('notification verification CLI confirms local suppression without sending into the chat', async t => {
  const f = fixture(t); save(f.file, { ...f.job, cwd: f.root }); let sends = 0;
  const configFile = path.join(f.root, 'mcp.json');
  save(configFile, { mcpServers: { 'codex-executor': { command: process.execPath, args: [path.resolve(__dirname, '../src/server.cjs')], env: { CODEX_EXECUTOR_PROJECT: f.root, CODEX_EXECUTOR_DATA: f.root, CODEX_EXECUTOR_ENTRY: process.execPath, CODEX_EXECUTOR_PWSH: process.execPath } } } });
  const w = watch(f.broker, async () => { sends++; return {}; }, { reconcileMs: 25 }); t.after(() => w.close());
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../scripts/verify.cjs'), '--config', configFile, '--receipt', id, '--notification-check'], { windowsHide: true });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Local verification fixture timed out')); }, 30000);
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(stdout) : reject(new Error(stderr)); });
  });
  assert.match(output, /"delivery_state": "suppressed"/); assert.match(output, /"verified_local_only": true/);
  assert.equal(sends, 0); assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_check').length, 1);
});

test('a temporarily locked result is a known pre-send failure and retries without losing the outcome', async t => {
  const f = fixture(t, 'completed'), resultFile = path.join(path.dirname(f.file), 'result.txt');
  fs.writeFileSync(resultFile, '已完成收藏事务修复；播放验收尚未完成。', 'utf8'); f.emit('terminal', 'terminal');
  const original = fs.readFileSync; let locked = true, sends = 0;
  fs.readFileSync = (file, ...args) => {
    if (path.resolve(String(file)) === resultFile && locked) { locked = false; throw Object.assign(new Error('fixture locked result'), { code: 'EBUSY' }); }
    return original(file, ...args);
  };
  t.after(() => { fs.readFileSync = original; });
  await assert.rejects(deliver(f.broker, id, async () => { sends++; return {}; }, { retryDelays: [0, 0, 0] }), /fixture locked result/);
  assert.equal(sends, 0); assert.equal(notificationSummary(f.file).latest.state, 'not_sent');
  await deliver(f.broker, id, async (_, message) => { sends++; assert.match(message, /收藏事务修复/); return {}; });
  assert.equal(sends, 1); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});
