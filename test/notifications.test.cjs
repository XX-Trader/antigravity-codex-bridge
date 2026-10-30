'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Broker, save, read, publishNotification, notificationEvents, notificationSummary, commandPhase, dispatch, finalHandoff, takeFileClaim } = require('../src/server.cjs');
const { deliver, watch, claimHost, recordedReceipt, nativeSend, eventMessage, auditNotifications } = require('../src/notifier.cjs');
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
  const f = fixture(t); f.emit('phase', 'phase_started'); let calls = 0;
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Object.assign(new Error('offline before send'), { not_sent: true }); }, { retryDelays: [0, 0, 0] }), /offline/);
  assert.equal(notificationSummary(f.file).latest.state, 'not_sent');
  assert.equal(await deliver(f.broker, id, async () => { calls++; return { exit_code: 0 }; }), true);
  assert.equal(calls, 2); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
  assert.equal(await deliver(f.broker, id, async () => { throw Error('duplicate'); }), false);
  f.emit('next', 'phase_finished');
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Error('unknown after send'); }), /unknown/);
  assert.equal(await deliver(f.broker, id, async () => { calls++; return {}; }), false);
  assert.equal(calls, 3); assert.equal(notificationSummary(f.file).uncertain, 1);
  await deliver(f.broker, id, async () => { throw Error('must not send'); }, { reconcile: async () => true });
  assert.equal(notificationSummary(f.file).uncertain, 0); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});
test('single event claim serializes concurrent senders', async t => {
  const f = fixture(t); f.emit('phase', 'phase_started'); let release, calls = 0;
  const pending = deliver(f.broker, id, async () => { calls++; await new Promise(r => { release = r; }); return {}; });
  assert.equal(await deliver(f.broker, id, async () => { calls++; return {}; }), false);
  release(); await pending; assert.equal(calls, 1);
});
test('positive native receipt reconciles a send error without replay', async t => {
  const f = fixture(t); f.emit('phase', 'phase_started'); let calls = 0;
  await deliver(f.broker, id, async () => { calls++; throw Error('receipt recording failed'); }, { reconcile: async () => true });
  assert.equal(calls, 1); assert.equal(notificationSummary(f.file).latest.state, 'accepted');
});
test('event identity is checked and unrelated conversation receipt cannot acknowledge', async t => {
  const f = fixture(t), event = f.emit('phase', 'phase_started');
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
  const f = fixture(t), event = f.emit('phase', 'phase_started'); let calls = 0;
  await deliver(f.broker, id, async () => { calls++; return {}; }, { owns: () => false }); assert.equal(calls, 0);
  save(event.file.replace(/\.json$/, '.delivery.json'), { state: 'sending', sender_pid: 0 });
  await deliver(f.broker, id, async () => { calls++; return {}; }); assert.equal(calls, 0); assert.equal(notificationSummary(f.file).latest.state, 'uncertain');
});
test('watch pushes progress before terminal and recovery does not resend accepted events', async t => {
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
  await changed(f.root, () => f.emit('phase', 'phase_started'), () => notificationSummary(f.file).latest?.attempts === 4 && notificationSummary(f.file).latest?.state === 'not_sent');
  assert.equal(calls, 4);
  for (let n = 0; n < 3; n++) await deliver(f.broker, id, async () => { calls++; throw Error('must remain bounded'); });
  assert.equal(calls, 4);
  await deliver(f.broker, id, async () => { calls++; return {}; }, { generation: 'restarted-host' });
  assert.equal(calls, 5); assert.equal(notificationSummary(f.file).latest.attempts, 1);
});
test('legacy running job receives catch-up and its later terminal is not lost', async t => {
  const f = fixture(t, 'running', undefined); delete f.job.notification_schema; save(f.file, f.job);
  const w = watch(f.broker, async () => ({}), { generation: 'new-host' }); t.after(() => w.close());
  await changed(f.root, () => {}, () => notificationSummary(f.file).latest?.state === 'accepted');
  assert.equal(notificationEvents(f.file)[0].kind, 'recovered');
  await changed(f.root, () => save(f.file, { ...f.job, status: 'blocked' }), () => notificationSummary(f.file).latest?.kind === 'terminal' && notificationSummary(f.file).latest?.state === 'accepted');
});
test('continuation supersedes old notices and terminal supersedes stale pending progress', async t => {
  const f = fixture(t); f.emit('start', 'started');
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb', nextFile = f.broker.jobPath(next); fs.mkdirSync(path.dirname(nextFile)); save(nextFile, { ...f.job, job_id: next, created_at: '2099-01-01T00:00:00.000Z' });
  assert.equal(await deliver(f.broker, id, async () => { throw Error('stale matter alert'); }), false);
  f.emit('check', 'notification_check'); let checks = 0;
  assert.equal(await deliver(f.broker, id, async (_, message) => { assert.match(message, /不调用任何工具/); checks++; return {}; }), true); assert.equal(checks, 1);
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
  assert.match(instructions, /Only terminal events require codex_result/); assert.match(instructions, /notification_check only acknowledges/);
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
  const f = fixture(t); f.emit('phase', 'phase_started'); let calls = 0;
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Object.assign(Error('offline'), { not_sent: true }); }, { retryDelays: [1000, 1000, 1000] }));
  for (let n = 0; n < 4; n++) await deliver(f.broker, id, async () => { calls++; return {}; });
  assert.equal(calls, 1); assert.ok(notificationSummary(f.file).latest.next_attempt_at);
});
test('notification alarms coalesce by conversation/root cause, persist and recover once', async t => {
  const f = fixture(t), e = f.emit('phase', 'phase_started'); const old = Date.now() - 70000; save(e.file, { ...e, created_at: new Date(old).toISOString() });
  const next = 'bbbbbbbbbbbbbbbbbbbbbbbb', nf = f.broker.jobPath(next); fs.mkdirSync(path.dirname(nf));
  const job = { ...f.job, job_id: next, topic_id: next }; save(nf, job); const ne = publishNotification(nf, job, 'phase', 'phase_started'); save(ne.file, { ...ne, created_at: new Date(old).toISOString() });
  const ids = new Set([id, next]); auditNotifications(f.broker, ids); auditNotifications(f.broker, ids);
  assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_alert').length, 1); assert.equal(notificationEvents(nf).length, 1);
  const group = Object.values(read(path.join(f.root, 'notification-alerts.json')).groups)[0]; assert.equal(group.jobs.length, 2);
  save(e.file.replace(/\.json$/, '.delivery.json'), { state: 'sending', created_at: new Date(Date.now() - 100000).toISOString() });
  auditNotifications(f.broker, ids); assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_alert').length, 1);
  assert.ok(Object.values(read(path.join(f.root, 'notification-alerts.json')).groups)[0].reasons.includes('outcome_unknown'));
  fs.unlinkSync(e.file.replace(/\.json$/, '.delivery.json'));
  await deliver(f.broker, id, async () => ({})); await deliver(f.broker, next, async () => ({}));
  auditNotifications(f.broker, ids); auditNotifications(f.broker, ids);
  assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_recovered').length, 1);
});
test('recovery before an alert was sent suppresses stale model wakeups and does not recurse', async t => {
  const f = fixture(t), e = f.emit('phase', 'phase_started'); save(e.file, { ...e, created_at: new Date(Date.now() - 70000).toISOString() });
  const ids = new Set([id]); auditNotifications(f.broker, ids);
  const alert = notificationEvents(f.file).find(e => e.kind === 'notification_alert');
  save(e.file.replace(/\.json$/, '.delivery.json'), { state: 'accepted' }); auditNotifications(f.broker, ids);
  assert.equal(read(alert.file.replace(/\.json$/, '.delivery.json')).state, 'superseded');
  assert.equal(notificationEvents(f.file).filter(e => e.kind === 'notification_recovered').length, 0);
  const ledger = auditNotifications(f.broker, ids); assert.equal(Object.values(ledger.groups)[0].state, 'resolved');
});
test('ordinary running work and accepted notices do not create alarms; watch errors close health', async t => {
  const f = fixture(t); const callback = dropWatch(t, f.broker.jobs); let calls = 0;
  const w = watch(f.broker, async () => { calls++; return {}; }, { reconcileMs: 25 }); t.after(() => w.close());
  await sleep(90); assert.equal(calls, 0); assert.equal(fs.existsSync(path.join(f.root, 'notification-alerts.json')), false);
  callback.fail(new Error('fixture watcher failure'));
  const health = read(path.join(f.root, 'notification-health.json')); assert.equal(health.closed, true); assert.equal(health.watch_error, 'fixture watcher failure');
});
test('structured decisions survive persistence, include real options and do not auto-select', t => {
  const f = fixture(t, 'needs_input');
  const handoff = finalHandoff('[CODEX_NEEDS_INPUT]\n' + JSON.stringify({ question: '选工作树还是等待？', options: ['工作树：隔离修改', '等待：复用当前目录'], recommendation: '等待', completed: '已定位重叠范围' }));
  save(f.file, { ...f.job, handoff }); const event = f.emit('terminal', 'terminal'); const message = eventMessage(read(f.file), event);
  assert.deepEqual(new Broker({ data: f.root }).receipt(id).handoff, handoff);
  assert.match(message, /选工作树还是等待/); assert.match(message, /工作树：隔离修改/); assert.match(message, /不得默认选推荐项/); assert.ok(message.includes('原 topic_id/session_id'));
  assert.equal(finalHandoff('日志中引用 [CODEX_NEEDS_INPUT] 不应暂停'), null);
  assert.equal(finalHandoff('  [CODEX_NEEDS_INPUT] 请确认A或B').kind, 'needs_input');
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
