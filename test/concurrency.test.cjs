'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
// Admission-only tests do not start Codex or a worker. Native worker isolation is tested separately.
const originalSpawn = cp.spawn;
cp.spawn = () => ({ pid: process.pid, on() {}, unref() {} });
const { Broker, save, dispatch } = require('../src/server.cjs');
cp.spawn = originalSpawn;
function fixture(t) {
  const base = fs.realpathSync(process.env.CODEX_EXECUTOR_TEST_ROOT), root = fs.mkdtempSync(path.join(base, 'concurrency-'));
  const data = path.join(root, 'data'), project = path.join(root, 'project'); fs.mkdirSync(data); fs.mkdirSync(project);
  t.after(() => { assert.ok(fs.realpathSync(root).startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { project, data, entry: process.execPath, pwsh: process.execPath, model_aliases: {} };
  return { root, project, data, settings, broker: new Broker(settings) };
}
test('same-worktree admission has no numeric running-task cap, active listing exceeds twenty', t => {
  const f = fixture(t), jobs = Array.from({ length: 64 }, (_, n) => f.broker.start({ prompt: 'independent task ' + n }));
  assert.equal(new Set(jobs.map(j => j.job_id)).size, 64); assert.equal(new Set(jobs.map(j => j.topic_id)).size, 64);
  const recovered = new Broker(f.settings);
  assert.equal(recovered.list(20, undefined, true).length, 64);
  const response = dispatch(recovered, { method: 'tools/call', params: { name: 'codex_list', arguments: { active_only: true } } });
  assert.equal(JSON.parse(response.content[0].text).length, 64);
  f.broker.unlock(jobs[0].job_id); assert.equal(fs.readdirSync(f.broker.lock).length, 63);
});
test('the same topic/session is excluded while other matters start without a queue', async t => {
  const f = fixture(t), a = f.broker.start({ prompt: 'first' });
  await assert.rejects(new Broker(f.settings).run({ prompt: 'duplicate', topic_id: a.topic_id }), /still running/);
  const thread = '12345678-1234-1234-1234-123456789abc', file = f.broker.jobPath(a.job_id);
  save(file, { ...JSON.parse(fs.readFileSync(file)), thread_id: thread, status: 'running', worker_pid: process.pid });
  assert.throws(() => f.broker.start({ prompt: 'native duplicate' }, { id: thread }), /already running/);
  assert.ok(f.broker.start({ prompt: 'unrelated task' }).job_id);
  assert.equal(f.broker.list(20, undefined, true).length, 2);
});
test('legacy project leases do not block unrelated work but keep their exact session owned', t => {
  const f = fixture(t), id = 'aaaaaaaaaaaaaaaaaaaaaaaa', thread = '12345678-1234-1234-1234-123456789abc';
  const file = f.broker.jobPath(id); fs.mkdirSync(path.dirname(file));
  save(file, { job_id: id, status: 'running', topic_id: id, thread_id: thread, worker_pid: process.pid, created_at: new Date().toISOString(), cwd: f.project });
  fs.mkdirSync(f.broker.legacyLock); save(path.join(f.broker.legacyLock, id + '.json'), { job_id: id });
  assert.ok(f.broker.start({ prompt: 'new independent task' }).job_id);
  assert.throws(() => f.broker.start({ prompt: 'same old session' }, { id: thread }), /already running/);
  assert.ok(fs.existsSync(path.join(f.broker.legacyLock, id + '.json')));
});
test('a slowly starting owned worker is not mistaken for a crashed job', t => {
  const f = fixture(t), job = f.broker.start({ prompt: 'slow startup' }), file = f.broker.jobPath(job.job_id);
  save(file, { ...JSON.parse(fs.readFileSync(file)), created_at: '2000-01-01T00:00:00.000Z' });
  assert.equal(f.broker.get(job.job_id).status, 'queued');
});
test('two native-session admissions racing across clients cannot start duplicate turns', async t => {
  const f = fixture(t), thread = '12345678-1234-1234-1234-123456789abc';
  const metadata = async () => ({ thread: { id: thread, cwd: f.project, status: { type: 'notLoaded' } } });
  const results = await Promise.allSettled([new Broker(f.settings, metadata).run({ prompt: 'a', session_id: thread }), new Broker(f.settings, metadata).run({ prompt: 'b', session_id: thread })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});
test('cross-process admissions exclude only the same native session', async t => {
  const f = fixture(t), moduleFile = path.resolve(__dirname, '../src/server.cjs');
  const code = 'const cp=require("node:child_process"),fs=require("node:fs");cp.spawn=()=>({pid:process.pid,on(){},unref(){}});const {Broker}=require(process.argv[1]);const s=JSON.parse(process.argv[2]);try{const j=new Broker(s).start({prompt:"same native session"},{id:"12345678-1234-1234-1234-123456789abc"});console.log(JSON.stringify({accepted:j.job_id}));}catch(e){console.log(JSON.stringify({rejected:e.message}));}';
  const rows = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, ['-e', code, moduleFile, JSON.stringify(f.settings)], { windowsHide: true }); let out = '', err = '';
    child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { err += b; }); child.on('error', reject);
    child.on('close', status => status === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  })));
  assert.equal(rows.filter(r => r.accepted).length, 1); assert.equal(rows.filter(r => r.rejected?.includes('already running')).length, 7);
});
