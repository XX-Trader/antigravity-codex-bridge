'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
// Admission-only tests do not start Codex or a worker. Native worker isolation is tested separately.
const originalSpawn = cp.spawn;
cp.spawn = () => ({ pid: process.pid, on() {}, unref() {} });
const { Broker, save, dispatch, finalHandoff, executionBlock } = require('../src/server.cjs');
cp.spawn = originalSpawn;
function fixture(t) {
  const base = fs.realpathSync(process.env.CODEX_EXECUTOR_TEST_ROOT), root = fs.mkdtempSync(path.join(base, 'concurrency-'));
  const data = path.join(root, 'data'), project = path.join(root, 'project'); fs.mkdirSync(data); fs.mkdirSync(project);
  t.after(() => { assert.ok(fs.realpathSync(root).startsWith(base + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  const settings = { project, data, entry: process.execPath, pwsh: process.execPath, model_aliases: {} };
  return { root, project, data, settings, broker: new Broker(settings) };
}
test('verbatim user text is distinct from the plan, immutable and retained across old-parent continuation', t => {
  const f = fixture(t), raw = '  用户原文\r\n必须用原方案，不要换成省事方案。\n';
  const first = f.broker.start({ prompt: '规划摘要 A', user_request: raw });
  const finish = id => { const job = f.broker.get(id); save(f.broker.jobPath(id), { ...job, status: 'completed', thread_id: '12345678-1234-1234-1234-123456789abc' }); f.broker.unlock(id); };
  finish(first.job_id);
  assert.equal(f.broker.get(first.job_id).request_context.original_text, raw);
  assert.equal(first.request_context.original_sha256, require('node:crypto').createHash('sha256').update(raw).digest('hex'));
  assert.equal(JSON.stringify(first).includes('必须用原方案'), false, 'Summary must not repeat private source text');
  const second = f.broker.start({ prompt: '规划摘要 B', parent_job_id: first.job_id, user_followup: ' 用户确认：先做 A。\n' }); finish(second.job_id);
  const restarted = new Broker(f.settings), count = restarted.list().length;
  assert.throws(() => restarted.start({ prompt: '改成省事方案', parent_job_id: first.job_id, user_request: '偷偷换目标' }), /Cannot replace user_request/);
  assert.equal(restarted.list().length, count);
  const response = dispatch(restarted, { method: 'tools/call', params: { name: 'codex_continue', arguments: { job_id: first.job_id, prompt: '摘要 C', user_request: raw, user_followup: '第二次补充' } } });
  assert.notEqual(response.isError, true);
  const third = JSON.parse(response.content[0].text), saved = restarted.get(third.job_id);
  assert.equal(saved.request_context.original_text, raw);
  assert.deepEqual(saved.request_context.followups.map(row => row.text), [' 用户确认：先做 A。\n', '第二次补充']);
  assert.equal(saved.request_context.original_job_id, first.job_id);
  assert.equal(restarted.result(first.job_id).request_context.followup_count, 0, 'Earlier receipts stay historical');
  assert.equal(restarted.status(third.job_id).request_context.followup_count, 2);
});
test('missing originals are not invented; invalid or oversized source text is rejected, never truncated', t => {
  const f = fixture(t);
  for (const key of ['user_request', 'user_followup']) for (const value of [null, 1, '', '   ', 'x'.repeat(60001)]) assert.throws(() => f.broker.start({ prompt: '摘要', [key]: value }), /1..60000/);
  assert.equal(f.broker.list().length, 0);
  const legacy = f.broker.start({ prompt: '仅旧摘要' });
  assert.equal(legacy.request_context.source, 'not_provided');
  assert.equal(f.broker.get(legacy.job_id).request_context.original_text, null);
  const large = f.broker.start({ prompt: '摘要', user_request: 'a'.repeat(60000), user_followup: 'b'.repeat(60000) });
  save(f.broker.jobPath(large.job_id), { ...f.broker.get(large.job_id), status: 'completed' }); f.broker.unlock(large.job_id);
  assert.throws(() => f.broker.start({ prompt: '新摘要', topic_id: large.topic_id, user_followup: 'c' }), /120000/);
  assert.equal(f.broker.get(large.job_id).request_context.followups[0].text.length, 60000);
});
test('all execution entry schemas expose original and followup separately from the plan', t => {
  const f = fixture(t), schema = dispatch(f.broker, { method: 'tools/list' });
  for (const name of ['codex_run', 'codex_start', 'codex_continue']) {
    const properties = schema.tools.find(tool => tool.name === name).inputSchema.properties;
    assert.equal(properties.user_request.type, 'string'); assert.equal(properties.user_followup.type, 'string');
    assert.equal(properties.prompt.type, 'string');
    assert.deepEqual(properties.plan_decision.required, ['refusal_job_id']);
    assert.deepEqual(properties.execution_followup.required, ['blocked_job_ids', 'intent']);
  }
});

test('explicit refusal survives restart and blocks topic, old-parent and native-session shortcuts', async t => {
  const f = fixture(t), thread = '12345678-1234-1234-1234-123456789abc';
  const finish = (job, handoff = null) => { save(f.broker.jobPath(job.job_id), { ...f.broker.get(job.job_id), status: handoff ? 'blocked' : 'completed', thread_id: thread, handoff }); f.broker.unlock(job.job_id); };
  const first = f.broker.start({ prompt: '原方案', user_request: '不做整集转码' }); finish(first);
  const rejected = f.broker.start({ prompt: '实现原方案', parent_job_id: first.job_id });
  const handoff = finalHandoff('[CODEX_PLAN_REJECTED]\n' + JSON.stringify({ original_plan: '直接播放', reason: '缺少显示通路', impact: '目前无法播放', question: '补齐还是更改？', options: ['补齐原方案', '更改目标'] }));
  finish(rejected, handoff);
  const original = fs.readFileSync(f.broker.jobPath(rejected.job_id)), restarted = new Broker(f.settings), count = restarted.list().length;
  for (const args of [{ topic_id: rejected.topic_id }, { parent_job_id: first.job_id }, { topic_id: rejected.topic_id, user_followup: '仅有答复，没有关联拒绝' }]) assert.throws(() => restarted.start({ prompt: '已有授权，换方案即可', ...args }), /CODEX_USER_DECISION_REQUIRED/);
  await assert.rejects(restarted.run({ prompt: '从原生会话绕过', session_id: thread }), /CODEX_USER_DECISION_REQUIRED/);
  const compatibility = dispatch(restarted, { method: 'tools/call', params: { name: 'codex_continue', arguments: { job_id: first.job_id, prompt: '从旧 parent 绕过' } } });
  assert.equal(compatibility.isError, true); assert.match(compatibility.content[0].text, /CODEX_USER_DECISION_REQUIRED/);
  assert.equal(restarted.list().length, count);
  const decision = { refusal_job_id: rejected.job_id };
  assert.throws(() => restarted.start({ prompt: '仅传 ID', parent_job_id: first.job_id, plan_decision: decision }), /actual human reply/);
  assert.throws(() => restarted.start({ prompt: '错误 ID', topic_id: rejected.topic_id, plan_decision: { refusal_job_id: first.job_id }, user_followup: '继续' }), /unresolved refusal/);
  assert.throws(() => restarted.start({ prompt: '覆盖原文', topic_id: rejected.topic_id, plan_decision: decision, user_followup: '继续', user_request: '更容易的目标' }), /Cannot replace user_request/);
  assert.throws(() => restarted.start({ prompt: '失败派发不能消费决定', topic_id: rejected.topic_id }), /CODEX_USER_DECISION_REQUIRED/);
  assert.ok(restarted.start({ prompt: '另一个独立事项' }).job_id);
  const reply = '  我选择补齐原方案，不接受转码。\r\n';
  const response = dispatch(restarted, { method: 'tools/call', params: { name: 'codex_continue', arguments: { job_id: first.job_id, prompt: '继续补齐', plan_decision: decision, user_followup: reply } } });
  assert.notEqual(response.isError, true);
  const continued = JSON.parse(response.content[0].text), saved = restarted.get(continued.job_id);
  assert.equal(saved.topic_id, rejected.topic_id); assert.equal(saved.thread_id, thread);
  assert.equal(saved.plan_decision.refusal_job_id, rejected.job_id);
  assert.equal(saved.request_context.followups.at(-1).text, reply);
  assert.equal(restarted.receipt(continued.job_id).plan_decision.refusal_job_id, rejected.job_id);
  assert.deepEqual(fs.readFileSync(f.broker.jobPath(rejected.job_id)), original, 'Do not rewrite the refusal as resolved/success');
  finish(continued);
  assert.ok(new Broker(f.settings).start({ prompt: '后续正常续接', parent_job_id: first.job_id }).job_id);
});

test('ordinary implementation errors do not require a human plan decision, stale or malformed decisions fail closed', t => {
  const f = fixture(t), first = f.broker.start({ prompt: '正常任务' });
  save(f.broker.jobPath(first.job_id), { ...f.broker.get(first.job_id), status: 'failed', thread_id: '12345678-1234-1234-1234-123456789abc', error: 'compiler error', handoff: null }); f.broker.unlock(first.job_id);
  assert.ok(f.broker.start({ prompt: '自行修复编译错误', parent_job_id: first.job_id }).job_id);
  for (const value of [null, [], {}, { refusal_job_id: 'bad' }, { refusal_job_id: first.job_id, approved: true }]) assert.throws(() => f.broker.start({ prompt: 'invalid decision', plan_decision: value }), /plan_decision/);
  assert.throws(() => f.broker.start({ prompt: '不能复用别的事项的 ID', plan_decision: { refusal_job_id: first.job_id }, user_followup: '同意' }), /unresolved refusal/);
});

test('policy blocks persist independently of plan choices; diagnosis and unaffected work never clear the block', async t => {
  const f = fixture(t), thread = '12345678-1234-1234-1234-123456789abc';
  const finish = (job, handoff = null) => { save(f.broker.jobPath(job.job_id), { ...f.broker.get(job.job_id), status: handoff ? 'execution_blocked' : 'completed', thread_id: thread, handoff, execution_block: executionBlock(handoff, '', job.job_id) }); f.broker.unlock(job.job_id); };
  const first = f.broker.start({ prompt: '原方案', user_request: '方案 A 已确认，保留它。' }); finish(first);
  const blocked = f.broker.start({ prompt: '执行', parent_job_id: first.job_id }), handoff = finalHandoff('[CODEX_EXECUTION_BLOCKED]\n{"blocked_action":"隔离原型启动","reason":"Rejected: blocked by policy","affected_checks":["连续播放"]}'); finish(blocked, handoff);
  const original = fs.readFileSync(f.broker.jobPath(blocked.job_id)), restarted = new Broker(f.settings), count = restarted.list().length;
  for (const args of [{ topic_id: blocked.topic_id }, { parent_job_id: first.job_id }, { topic_id: blocked.topic_id, user_followup: '我再次同意方案 A' }]) assert.throws(() => restarted.start({ prompt: '继续执行', ...args }), /CODEX_EXECUTION_POLICY_UNRESOLVED/);
  await assert.rejects(restarted.run({ prompt: '原生会话绕过', session_id: thread }), /CODEX_EXECUTION_POLICY_UNRESOLVED/);
  assert.throws(() => restarted.start({ prompt: '业务确认不是策略解除', topic_id: blocked.topic_id, plan_decision: { refusal_job_id: blocked.job_id }, user_followup: '同意' }), /unresolved refusal/);
  assert.equal(restarted.list().length, count);
  const followup = { blocked_job_ids: [blocked.job_id], intent: 'diagnose' };
  const response = dispatch(restarted, { method: 'tools/call', params: { name: 'codex_continue', arguments: { job_id: first.job_id, prompt: '只读检查', execution_followup: followup } } });
  assert.notEqual(response.isError, true);
  const diagnostic = JSON.parse(response.content[0].text), saved = restarted.get(diagnostic.job_id);
  assert.equal(saved.execution_followup.intent, 'diagnose'); assert.equal(saved.execution_constraints[0].blocked_job_id, blocked.job_id);
  assert.equal(saved.request_context.original_text, '方案 A 已确认，保留它。'); assert.equal(saved.topic_id, blocked.topic_id); assert.equal(saved.thread_id, thread);
  finish(diagnostic);
  assert.throws(() => new Broker(f.settings).start({ prompt: '诊断结束不是放行', parent_job_id: first.job_id }), /CODEX_EXECUTION_POLICY_UNRESOLVED/);
  const independent = restarted.start({ prompt: '另一个独立任务' }); assert.ok(independent.job_id);
  const unaffected = restarted.start({ prompt: '仅做其它已授权工作', parent_job_id: first.job_id, execution_followup: { ...followup, intent: 'continue_unblocked' } }); finish(unaffected);
  assert.throws(() => restarted.start({ prompt: '仍不能静默重试', parent_job_id: first.job_id }), /CODEX_EXECUTION_POLICY_UNRESOLVED/);
  const resolved = restarted.start({ prompt: '只验证续接记录，不执行原动作', parent_job_id: first.job_id, execution_followup: { ...followup, intent: 'resume_after_resolution', resolution: { kind: 'policy_fix', evidence: 'fixture: operator supplied a verified repair record; this grants no permission' } } });
  assert.equal(resolved.execution_followup.evidence_status, 'caller_reported_not_a_permission_grant'); assert.deepEqual(resolved.execution_constraints, []); finish(resolved);
  assert.ok(new Broker(f.settings).start({ prompt: '后续步骤', parent_job_id: first.job_id }).job_id);
  assert.deepEqual(fs.readFileSync(f.broker.jobPath(blocked.job_id)), original);
});

test('execution followups reject unrelated IDs, invalid modes and unsupported resolution claims before admission', t => {
  const f = fixture(t), first = f.broker.start({ prompt: '原任务' }), h = finalHandoff('[CODEX_EXECUTION_BLOCKED] 未提供细分原因');
  save(f.broker.jobPath(first.job_id), { ...f.broker.get(first.job_id), status: 'execution_blocked', thread_id: '12345678-1234-1234-1234-123456789abc', handoff: h, execution_block: executionBlock(h, '', first.job_id) }); f.broker.unlock(first.job_id);
  const valid = { blocked_job_ids: [first.job_id], intent: 'diagnose' };
  for (const value of [null, [], {}, { ...valid, blocked_job_ids: [] }, { ...valid, blocked_job_ids: [first.job_id, first.job_id] }, { ...valid, intent: 'retry_anyway' }, { ...valid, approved: true }]) assert.throws(() => f.broker.start({ prompt: 'invalid', topic_id: first.topic_id, execution_followup: value }), /Invalid execution_followup/);
  assert.throws(() => f.broker.start({ prompt: 'wrong identity', topic_id: first.topic_id, execution_followup: { ...valid, blocked_job_ids: ['a'.repeat(24)] } }), /all unresolved/);
  assert.throws(() => f.broker.start({ prompt: 'diagnosis is not resolution', topic_id: first.topic_id, execution_followup: { ...valid, resolution: { kind: 'policy_fix', evidence: 'x' } } }), /must not claim/);
  for (const resolution of [undefined, null, { kind: 'business_plan_confirmed', evidence: '用户确认方案' }, { kind: 'policy_fix', evidence: '' }, { kind: 'formal_approval', evidence: 'x'.repeat(4001) }]) assert.throws(() => f.broker.start({ prompt: 'invalid resolution', topic_id: first.topic_id, execution_followup: { ...valid, intent: 'resume_after_resolution', resolution } }), /formal_approval or policy_fix/);
  assert.equal(f.broker.list().length, 1);
});
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
test('wrapped native MCP calls preserve arguments and bind the real originating chat', t => {
  const f = fixture(t), { bindOrigin, hookMatcher } = require('../src/router.cjs');
  const conversationId = '11111111-1111-1111-1111-111111111111';
  const payload = { conversationId, workspacePaths: [f.project], toolCall: { name: 'call_mcp_tool', args: { ServerName: 'codex-executor-parallel', ToolName: 'codex_run', Arguments: { prompt: 'keep me', wait: false } } } };
  assert.ok(new RegExp(hookMatcher).test('call_mcp_tool'));
  const result = bindOrigin(payload, [{ project: f.project, data: f.data }]);
  assert.equal(result.overwrite.Arguments.prompt, 'keep me'); assert.equal(result.overwrite.Arguments.wait, false);
  assert.equal(result.overwrite.Arguments.conversation_id, conversationId); assert.equal(result.overwrite.Arguments.cwd, f.project);
  assert.equal(result.overwrite.ServerName, undefined); assert.equal(result.decision, 'allow');
  assert.equal(result.overwrite.Arguments.sandbox, undefined);
  for (const sandbox of ['read-only', 'workspace-write']) {
    const restricted = { ...payload, toolCall: { ...payload.toolCall, args: { ...payload.toolCall.args, Arguments: { prompt: '只读诊断，不改文件', sandbox } } } };
    const denied = bindOrigin(restricted, [{ project: f.project, data: f.data }]);
    assert.equal(denied.decision, 'deny'); assert.match(denied.reason, /宿主机/);
    const allowed = bindOrigin(restricted, [{ project: f.project, data: f.data, allow_sandbox: true }]);
    assert.equal(allowed.decision, 'allow'); assert.equal(allowed.overwrite.Arguments.sandbox, sandbox);
  }
  assert.equal(bindOrigin({ ...payload, toolCall: { name: 'mcp_codex-subagent_codex_run', args: { prompt: 'legitimate Codex dispatch' } } }, [{ project: f.project, data: f.data }]).decision, 'allow');
});
test('Antigravity native execution/subagents are denied only in registered projects, Codex dispatch is allowed', t => {
  const f = fixture(t), { bindOrigin, hookMatcher } = require('../src/router.cjs'), projects = [{ project: f.project, data: f.data }];
  for (const name of ['invoke_subagent', 'define_subagent', 'manage_subagents', 'run_command', 'write_to_file', 'multi_replace_file_content', 'browser_subagent']) {
    assert.ok(new RegExp(hookMatcher).test(name));
    assert.equal(bindOrigin({ workspacePaths: [f.project], toolCall: { name, args: {} } }, projects).decision, 'deny');
    assert.equal(bindOrigin({ workspacePaths: [], toolCall: { name, args: {} } }, projects).decision, 'allow');
  }
  assert.equal(bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'read_file', args: {} } }, projects).decision, 'allow');
  assert.equal(bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'call_mcp_tool', args: { ToolName: 'invoke_subagent', Arguments: {} } } }, projects).decision, 'deny');
});
