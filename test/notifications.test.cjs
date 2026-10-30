'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Broker, save, read, publishNotification, notificationEvents, notificationSummary, commandPhase } = require('../src/server.cjs');
const { deliver, watch, claimHost, recordedReceipt, nativeSend, eventMessage } = require('../src/notifier.cjs');
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
  await assert.rejects(deliver(f.broker, id, async () => { calls++; throw Object.assign(new Error('offline before send'), { not_sent: true }); }), /offline/);
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
});
