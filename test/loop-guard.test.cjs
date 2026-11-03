'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loopState, executionReport, takeover } = require('../src/loop-guard.cjs');
const { worker, save, Broker, reviewVersion } = require('../src/server.cjs');
const row = (n, fields = {}) => ({ job_id: n.toString(16).padStart(24, '0'), created_at: new Date(n * 1000).toISOString(), status: 'completed', ...fields });
const rejected = n => row(n, { status: 'review_revise', handoff: { kind: 'review_revise', reason: '真实接口与方案不符' } });

test('three failures persist across successful reviews, progress, restart and changed proposals', () => {
  const rows = [rejected(1), row(2, { plan_review: { status: 'approved' }, execution_report: { outcome: 'progress' } }), rejected(3), rejected(4)];
  assert.equal(loopState(rows).failures, 3);
  assert.equal(loopState(JSON.parse(JSON.stringify(rows))).trigger, 'failed_rounds');
  assert.match(takeover(loopState(rows)).diagnostic_questions.join(" "), /原因是什么.*如何解决最合适/);
  assert.equal(loopState([...rows, row(5, { execution_report: { outcome: 'accepted', evidence_item_ids: ['a'] } })]).failures, 3, 'Bare accepted claim cannot reset');
  assert.equal(loopState([...rows, row(5, { execution_report: { outcome: 'accepted', evidence_item_ids: ['a'] }, verification_state: 'accepted_with_evidence' })]).failures, 0);
});

test('two execution rounds without evidence stop; review approval neither resets nor counts as progress', () => {
  const a = row(1, { execution_report: { outcome: 'no_progress' } }), b = row(3, { execution_report: { outcome: 'no_progress' } });
  assert.equal(loopState([a, row(2, { plan_review: { status: 'approved' } }), b]).trigger, 'no_progress');
  assert.equal(loopState([a, row(2, { execution_report: { outcome: 'progress' } }), b]).trigger, null);
});

test('model configuration errors neither add business failures nor erase earlier progress and failures', () => {
  const prior = [rejected(1), row(2, { execution_report: { outcome: 'no_progress' } })];
  const bad = row(3, { status: 'failed', configuration_error: { kind: 'model_configuration' }, repair_round_failed: true, execution_report: { outcome: 'no_progress' } });
  assert.deepEqual(loopState([...prior, bad]), loopState(prior));
});

test('reports require exact successful execution evidence and all acceptance items', () => {
  const items = new Map([['actual1', 'pwsh verify.ps1']]);
  const report = fields => executionReport('结果\n[CODEX_EXECUTION_REPORT]\n' + JSON.stringify({ outcome: 'accepted', reason: '已回读全部目标', evidence_commands: ['pwsh verify.ps1'], remaining_checks: [], ...fields }), items);
  assert.deepEqual(report({}).evidence_item_ids, ['actual1']);
  for (const fields of [{ evidence_item_ids: ['invented'] }, { evidence_commands: ['another command'] }, { remaining_checks: ['真机验证'] }]) assert.equal(report(fields).outcome, 'no_progress');
  assert.equal(executionReport('仅声称完成', items).outcome, 'no_progress');
  for (const raw of ['null', '[]', '7', '{"evidence_commands":{}}']) assert.equal(executionReport('结果\n[CODEX_EXECUTION_REPORT]\n' + raw, items).outcome, 'no_progress');
  assert.equal(executionReport('结果\n[CODEX_EXECUTION_REPORT]\n' + JSON.stringify({ outcome: 'progress', reason: '取得了新的定位证据', evidence_outputs: ['真实命令输出：验收回读成功且参数一致'], remaining_checks: ['真机测试'] }), new Map([['actual2', { output: '真实命令输出：验收回读成功且参数一致', command: 'probe' }]])).outcome, 'progress');
});

test('human reset needs exact decision and appended real reply; policy denials never become repair failures', () => {
  const rows = [rejected(1), rejected(2), rejected(3)];
  const reset = row(4, { loop_reset: { human_reply_job_id: row(4).job_id }, plan_decision: { refusal_job_id: row(3).job_id } });
  assert.equal(loopState([...rows, reset]).failures, 3);
  reset.request_context = { followups: [{ job_id: reset.job_id, text: '先做只读诊断' }] };
  assert.equal(loopState([...rows, reset]).failures, 0);
  assert.equal(loopState([row(1, { status: 'execution_blocked', execution_block: { reason: 'policy' } })]).failures, 0);
});

test('fresh worker holds legacy admissions before any CLI and preserves accumulated history', async t => {
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'loop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings = { project: root, data: root, pwsh: path.join(root, 'must-never-launch.exe') };
  const broker = new Broker(settings), topic = row(1).job_id;
  for (const job of [rejected(1), rejected(2), rejected(3), row(4, { status: 'queued', timeout_seconds: 30 })]) {
    const file = broker.jobPath(job.job_id); fs.mkdirSync(path.dirname(file), { recursive: true });
    save(file, { ...job, cwd: root, settings, topic_id: topic });
  }
  await worker(broker.jobPath(row(4).job_id));
  const held = broker.get(row(4).job_id);
  assert.equal(held.status, 'needs_input'); assert.equal(held.handoff.blocker_type, 'human_takeover');
  assert.equal(held.child_pid, undefined); assert.equal(held.loop_guard.failures, 3);
  assert.match(broker.receipt(held.job_id).final_response, /原因是什么/);
});

test('worker converts the third failure or second empty execution into a human question and resumes only after the reply', async t => {
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'rounds-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, 'fake.ps1');
  fs.writeFileSync(entry, `$argv=@($args)
$prompt=$input -join "\n"
$oi=[Array]::IndexOf($argv,'-o')
$text=if($prompt.Contains('FAIL_ROUND')){'[CODEX_REVIEW_REVISE]'+[Environment]::NewLine+'{"decision_scope":"technical","reason":"实际接口核查失败，需要修订"}'}else{'本轮未实施，仅列出计划。'}
[IO.File]::WriteAllText($argv[$oi+1],$text,[Text.UTF8Encoding]::new($false))
'{"type":"turn.completed"}'
`, 'utf8');
  const settings = { project: root, data: root, entry, pwsh: process.env.CODEX_EXECUTOR_PWSH };
  const broker = new Broker(settings);
  let seq = 10;
  const run = async (topic, prompt, fields = {}) => {
    const job = { ...row(seq++), status: 'queued', created_at: new Date(Date.now() + seq).toISOString(), topic_id: topic,
      cwd: root, sandbox: 'danger-full-access', stage: 'execute', timeout_seconds: 30, settings, thread_id: '11111111-1111-1111-1111-111111111111', resumed_session: true,
      prompt, request_context: { original_text: '完成原验收，不能降低标准', followups: [] }, ...fields };
    // Give unrelated topics different native sessions too.
    job.thread_id = topic + '-session';
    job.plan_review = { status: 'approved', plan_sha256: reviewVersion(job), allowed_scope: ['fixture'], evidence: ['fixture'] };
    const file = broker.jobPath(job.job_id); fs.mkdirSync(path.dirname(file)); save(file, job);
    fs.mkdirSync(broker.lock, { recursive: true }); save(path.join(broker.lock, job.job_id + '.json'), { job_id: job.job_id, worker_pid: process.pid });
    const executing = worker(file), receipt = await broker.wait(job.job_id);
    assert.equal(broker.lockOwner(), null, 'A terminal receipt must not retain its active lease');
    await executing;
    const final = broker.get(job.job_id);
    assert.equal(receipt.status, final.status, 'The first terminal receipt must already contain the complete takeover decision');
    assert.deepEqual(receipt.loop_guard, final.loop_guard);
    return final;
  };
  const topic = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal((await run(topic, 'FAIL_ROUND')).status, 'review_revise');
  assert.equal((await run(topic, 'FAIL_ROUND')).status, 'review_revise');
  const third = await run(topic, 'FAIL_ROUND');
  assert.equal(third.status, 'needs_input'); assert.equal(third.loop_guard.failures, 3);
  assert.match(broker.receipt(third.job_id).final_response, /原因是什么/);
  const blocked = await run(topic, '换个方案，直接继续');
  assert.equal(blocked.status, 'needs_input'); assert.equal(blocked.child_pid, undefined);
  const replyId = row(seq).job_id;
  const resumed = await run(topic, '先诊断', { plan_decision: { refusal_job_id: third.job_id }, request_context: { original_text: '完成原验收，不能降低标准', followups: [{ job_id: replyId, text: '先只读诊断原因，保留原标准' }] } });
  assert.equal(resumed.loop_guard.failures, 0); assert.ok(resumed.child_pid);
  const emptyTopic = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal((await run(emptyTopic, '空执行')).status, 'completed');
  const empty = await run(emptyTopic, '空执行');
  assert.equal(empty.status, 'needs_input'); assert.equal(empty.loop_guard.consecutive_no_progress, 2);
});
