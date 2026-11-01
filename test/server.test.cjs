'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { taskTitle, syncTaskTitle, chatAccess, toolResponse, latestProgress, save, worker, capacityRetryAt, isCapacity, capacityMessage, Broker: RealBroker, config: parseConfig, dispatch, terminal, childEnvironment } = require('../src/server.cjs');
// Supply an actual fixture request for independent mock tasks; continuations inherit theirs.
class Broker extends RealBroker {
  start(input, ...rest) {
    const hasContext = input.parent_job_id || input.topic_id || input.session_id;
    return super.start({ ...(!hasContext ? { user_request: '测试用户要求：按本次测试任务执行并核验。' } : {}), ...input }, ...rest);
  }
}

const { originHook, deliver, watch } = require('../src/notifier.cjs');
const fixtureAliases = { luna: 'fixture-luna', terra: 'fixture-terra', sol: 'fixture-sol' };
const fixtureEnv = { CODEX_EXECUTOR_MODEL: 'terra', CODEX_EXECUTOR_MODEL_ALIASES: JSON.stringify(fixtureAliases), CODEX_EXECUTOR_SERVICE_TIER: 'fast' };
Object.assign(process.env, fixtureEnv);
const config = env => parseConfig({ ...fixtureEnv, ...env });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished(broker, id) {
  for (let i = 0; i < 160; i++) {
    const job = broker.status(id);
    if (terminal.has(job.status)) return broker.result(id, true);
    await sleep(250);
  }
  throw new Error(`Fixture did not terminate: ${id}`);
}

test('local executor: protocol, isolation, persistence, continuation, failure and cancellation', async t => {
  assert.ok(process.env.CODEX_EXECUTOR_TEST_ROOT, 'Set CODEX_EXECUTOR_TEST_ROOT to an external test directory');
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'fixture-'));
  const project = path.join(root, '项目 with spaces');
  const data = path.join(root, 'runtime');
  fs.mkdirSync(project); fs.mkdirSync(data);
  const entry = path.join(root, 'fake-codex.ps1');
  fs.writeFileSync(entry, `
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$argv = @($args)
if ($argv -contains 'app-server') {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = $line | ConvertFrom-Json
    if ($null -eq $request.id) { continue }
    $result = @{}
    $failure = $null
    if ($request.method -eq 'thread/read') {
      $titleFile = Join-Path (Get-Location).Path ('.fake-title-' + $request.params.threadId + '.txt')
      $name = if (Test-Path -LiteralPath $titleFile) { [IO.File]::ReadAllText($titleFile) } else { $null }
      $result = @{ thread = @{ id = $request.params.threadId; cwd = (Get-Location).Path; name = $name } }
    } elseif ($request.method -eq 'thread/name/set') {
      if ($request.params.name.Contains('TITLE_METADATA_ERROR')) { $failure = @{ code = -32000; message = 'fixture title metadata failure' } }
      else {
        $titleFile = Join-Path (Get-Location).Path ('.fake-title-' + $request.params.threadId + '.txt')
        [IO.File]::WriteAllText($titleFile, $request.params.name, [Text.UTF8Encoding]::new($false))
      }
    }
    $reply = @{ jsonrpc = '2.0'; id = $request.id; result = $result }
    if ($failure) { $reply.Remove('result'); $reply.error = $failure }
    [Console]::WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
  }
  exit 0
}
$prompt = $input -join "\n"
$argv = @($args)
if ($prompt.Contains('当前是独立审核阶段（stage=review）')) {
  $oi = [Array]::IndexOf($argv, '-o')
  $version = [regex]::Match($prompt, '本轮方案版本：([a-f0-9]{64})').Groups[1].Value
  $review = @{ plan_sha256 = $version; evidence = @('已实际读取 fixture README 并核对目标'); allowed_scope = @('仅按测试要求实施，不扩大任务范围'); reason = 'fixture 审核通过'; decision_scope = 'technical' }
  $marker = 'APPROVED'
  if ($prompt.Contains('REVIEW_REVISE_FIXTURE')) { $marker = 'REVISE'; $review.reason = '方案调用不存在的接口'; $review.suggested_changes = '依据当前接口修订'; $review.Remove('allowed_scope') }
  if ($prompt.Contains('REVIEW_EVIDENCE_FIXTURE')) { $marker = 'NEEDS_EVIDENCE'; $review.reason = '缺少实际运行日志'; $review.suggested_changes = '补充真实日志'; $review.Remove('allowed_scope') }
  if ($prompt.Contains('REVIEW_USER_FIXTURE')) { $marker = 'REVISE'; $review.decision_scope = 'user'; $review.reason = '需要改变用户明确限制'; $review.question = '是否改变限制？'; $review.options = @('保留原限制', '明确更改限制') }
  if ($prompt.Contains('REVIEW_WRONG_VERSION_FIXTURE')) { $review.plan_sha256 = 'f' * 64 }
  if ($prompt.Contains('REVIEW_EMPTY_SCOPE_FIXTURE')) { $review.allowed_scope = @() }
  $tid = '00000000-0000-0000-0000-000000000001'
  if ($argv -contains 'resume') { $tid = $argv[[Array]::IndexOf($argv, 'resume')+1] }
  elseif (($prompt -match 'REVIEW_[A-Z_]+_FIXTURE') -or $prompt.Contains('CONCURRENT_FIXTURE')) { $tid = [guid]::NewGuid().ToString() }
  elseif ($prompt.Contains('SECOND_SESSION')) { $tid = '00000000-0000-0000-0000-000000000002' }
  elseif ($prompt.Contains('TITLE_METADATA_ERROR')) { $tid = '00000000-0000-0000-0000-000000000004' }
  elseif ($prompt.Contains('PLAN_REJECTED_FIXTURE')) { $tid = '00000000-0000-0000-0000-000000000005' }
  elseif ($prompt.Contains('POLICY_')) { $tid = '00000000-0000-0000-0000-000000000006' }
  elseif ($prompt.Contains('CAPACITY_')) { $tid = '00000000-0000-0000-0000-000000000009' }
  $text = '[CODEX_REVIEW_' + $marker + ']' + [Environment]::NewLine + ($review | ConvertTo-Json -Depth 6 -Compress)
  if ($prompt.Contains('REVIEW_NO_MARKER_FIXTURE')) { $text = '看起来没问题，直接执行吧。' }
  [IO.File]::WriteAllText($argv[$oi+1], $text, [Text.UTF8Encoding]::new($false))
  '{"type":"thread.started","thread_id":"' + $tid + '"}'
  if (-not $prompt.Contains('REVIEW_NO_TOOLS_FIXTURE')) { '{"type":"item.completed","item":{"type":"command_execution","command":"read fixture README","exit_code":0}}' }
  if ($prompt.Contains('REVIEW_WRITE_FIXTURE')) { '{"type":"item.completed","item":{"type":"file_change","changes":[]}}' }
  '{"type":"turn.completed"}'
  exit 0
}
if ($prompt.Contains('SLOW_FIXTURE')) { Start-Sleep -Seconds 60 }
if ($prompt.Contains('FAIL_FIXTURE')) { [Console]::Error.WriteLine('fixture failure'); exit 7 }
if ($prompt.Contains('EMPTY_FIXTURE')) { exit 0 }
$outputIndex = [Array]::IndexOf($argv, '-o')
if ($prompt.Contains('CAPACITY_ONCE_FIXTURE') -or $prompt.Contains('CAPACITY_ALWAYS_FIXTURE')) {
  $attemptNo = [int]([regex]::Match($argv[$outputIndex+1], 'attempt-(\\d+)').Groups[1].Value)
  if ($attemptNo -eq 1 -or $prompt.Contains('CAPACITY_ALWAYS_FIXTURE')) {
    '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000009"}'
    '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model"}}'
    exit 1
  }
}
$i = [Array]::IndexOf($argv, '-o')
$mi = [Array]::IndexOf($argv, '-m')
$ec = @($argv | Where-Object { $_ -like 'model_reasoning_effort=*' })
$fast = ($argv -contains 'service_tier="fast"') -and ($argv -contains 'features.fast_mode=true')
$si = [Array]::IndexOf($argv, '--sandbox')
$liveWeb = $argv -contains 'web_search="live"'
$nativeAgents = $argv -contains 'features.multi_agent=true'
$acceptanceContract = $prompt.Contains('逐项验收') -and $prompt.Contains('假设与证实根因分开报告') -and $prompt.Contains('一次只提出一个阻塞问题') -and $prompt.Contains('普通追问、补充信息或另一个独立任务不表示取消本事项')
$text = 'FAKE_OK resume=' + ($argv -contains 'resume') + ' unicode=' + $prompt.Contains('中文参数') + ' model=' + $argv[$mi+1] + ' effort=' + ($ec -join ',') + ' fast=' + $fast + ' sandbox=' + $argv[$si+1] + ' web_live=' + $liveWeb + ' native_subagents=' + $nativeAgents
$text += ' acceptance_contract=' + $acceptanceContract
$text += ' original_request=' + $prompt.Contains('USER_ORIGINAL_SENTINEL') + ' user_followup=' + $prompt.Contains('USER_FOLLOWUP_SENTINEL')
$text += ' policy_contract=' + ($prompt.Contains('执行策略拒绝与方案不成立必须分开') -and $prompt.Contains('不自动重试、换壳、拆命令、改入口'))
$text += ' execution_diag=' + $prompt.Contains('"intent":"diagnose"')
if ($prompt.Contains('NEEDS_INPUT_FIXTURE')) { $text = '[CODEX_NEEDS_INPUT] 请确认选择A还是B' }
if ($prompt.Contains('STRUCTURED_QUESTION_FIXTURE')) { $text = '[CODEX_NEEDS_INPUT]' + [Environment]::NewLine + '{"question":"选择工作树还是等待？","options":["工作树：隔离修改","等待：复用目录"],"recommendation":"等待","completed":"已定位文件范围"}' }
if ($prompt.Contains('BACKGROUND_HANDOFF_FIXTURE')) { $text = '[CODEX_BACKGROUND_RUNNING] 测试命令 test-pending 退出结果未确认，请勿重跑。' }
if ($prompt.Contains('BLOCKED_FIXTURE')) { $text = '[CODEX_BLOCKED] 方案与当前代码矛盾' }
if ($prompt.Contains('EXECUTION_REVIEW_INVALIDATED_FIXTURE')) { $text = '[CODEX_REVIEW_REVISE]' + [Environment]::NewLine + '{"decision_scope":"technical","reason":"新的运行证据推翻原假设","evidence":["实际接口返回不同"],"completed":"已完成只读检查","suggested_changes":"按实际接口重新设计"}' }
if ($prompt.Contains('PLAN_REJECTED_FIXTURE')) { $text = '[CODEX_PLAN_REJECTED]' + [Environment]::NewLine + '{"original_plan":"直接播放","reason":"缺少画面显示通路","impact":"原目标未完成","question":"补齐还是改方案？","options":["补齐原方案","修改目标"]}' }
if ($prompt.Contains('POLICY_REPORTED_FIXTURE')) { $text = '[CODEX_EXECUTION_BLOCKED]' + [Environment]::NewLine + '{"blocked_action":"隔离原型启动","reason":"Rejected: blocked by policy","known_facts":["完整访问"],"unknowns":["具体规则"],"affected_checks":["连续播放"],"completed":["已构建","未实机验证"]}' + [Environment]::NewLine + '原始证据保留。' }
if ($prompt.Contains('POLICY_COMBINED_FIXTURE')) { $text = '[CODEX_PLAN_REJECTED]' + [Environment]::NewLine + '{"reason":"另有方案矛盾","question":"如何修正方案？","options":["补齐原方案","修改要求"]}' }
if ($prompt.Contains('POLICY_MACHINE_FIXTURE') -or $prompt.Contains('POLICY_COMBINED_FIXTURE')) { [Console]::Error.WriteLine('2026-11-01T03:33:17.760090Z ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: "Rejected: blocked by policy" }') }
if ($prompt.Contains('POLICY_QUOTED_FIXTURE')) { $text = '测试引用 Rejected: blocked by policy，不代表真的拒绝。' }
[IO.File]::WriteAllText($argv[$i+1], $text, [Text.UTF8Encoding]::new($false))
$tid = '00000000-0000-0000-0000-000000000001'
if ($argv -contains 'resume') { $tid = $argv[[Array]::IndexOf($argv, 'resume')+1] }
elseif ($prompt.Contains('SECOND_SESSION')) { $tid = '00000000-0000-0000-0000-000000000002' }
elseif ($prompt.Contains('TITLE_METADATA_ERROR')) { $tid = '00000000-0000-0000-0000-000000000004' }
elseif ($prompt.Contains('PLAN_REJECTED_FIXTURE')) { $tid = '00000000-0000-0000-0000-000000000005' }
elseif ($prompt.Contains('POLICY_')) { $tid = '00000000-0000-0000-0000-000000000006' }
elseif ($prompt.Contains('CONCURRENT_FIXTURE')) { $tid = [guid]::NewGuid().ToString() }
'{"type":"thread.started","thread_id":"' + $tid + '"}'
if ($prompt.Contains('RECOVERED_ERROR_FIXTURE')) { '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}' }
if ($prompt.Contains('PROGRESS_FIXTURE')) {
  '{"type":"item.started","item":{"id":"check1","type":"command_execution","command":"cargo test -p fixture"}}'
  '{"type":"item.completed","item":{"id":"check1","type":"command_execution","command":"cargo test -p fixture","exit_code":0}}'
}
if ($prompt.Contains('BACKGROUND_HANDOFF_FIXTURE')) { '{"type":"item.started","item":{"id":"test-pending","type":"command_execution","command":"cargo test -p fixture"}}' }
'{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"part-1","exit_code":0}}'
'{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"part-2","exit_code":0}}'
'{"type":"item.completed","item":{"type":"agent_message","text":"FAKE_OK"}}'
'{"type":"turn.completed"}'
if ($prompt.Contains('LATE_ERROR_FIXTURE')) { '{"type":"turn.failed","error":{"message":"final failure"}}' }
if ($prompt.Contains('NONZERO_REFUSAL_FIXTURE')) { exit 1 }
exit 0
`, 'utf8');
  // Legacy isolation coverage opts in locally; production defaults are tested separately below.
  const baseEnv = { CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry, CODEX_EXECUTOR_PWSH: process.env.CODEX_EXECUTOR_PWSH };
  const settings = config({ ...baseEnv, CODEX_EXECUTOR_ALLOW_SANDBOX: '1' });
  const broker = new Broker(settings);
  try {
    await t.test('schema and project/sandbox/input boundaries', () => {
      const probe = path.join(root, 'atomic-state.json'); let failures = 2; const rename = fs.renameSync;
      if (process.platform === 'win32') {
        fs.renameSync = (...args) => { if (failures-- > 0) throw Object.assign(new Error('fixture sharing violation'), { code: 'EPERM' }); return rename(...args); };
        try { save(probe, { saved: true }); assert.deepEqual(JSON.parse(fs.readFileSync(probe)), { saved: true }); }
        finally { fs.renameSync = rename; }
      }
      assert.throws(() => broker.start({ prompt: 'x', cwd: root }), /outside/);
      assert.throws(() => broker.start({ prompt: 'x', sandbox: 'unknown-mode' }), /sandbox/);
      const schema = dispatch(broker, { method: 'tools/list' }).tools.find(x => x.name === 'codex_start').inputSchema.properties.sandbox;
      assert.equal(schema.default, 'danger-full-access'); assert.ok(schema.enum.includes('danger-full-access'));
      assert.throws(() => broker.start({ prompt: '' }), /prompt/);
      assert.throws(() => broker.start({ prompt: 'x', timeout_seconds: 0 }), /timeout_seconds/);
      assert.throws(() => broker.status('../other'), /Invalid/);
      assert.equal(dispatch(broker, { method: 'tools/list' }).tools.length, 9);
      assert.equal(dispatch(broker, { method: 'initialize', params: { protocolVersion: '2025-03-26' } }).protocolVersion, '2025-03-26');
      assert.equal(dispatch(broker, { method: 'tools/call', params: { name: 'missing' } }).isError, true);
      const original = { __COMPAT_LAYER: 'RunAsAdmin HIGHDPIAWARE', KEEP: 'unchanged' };
      const env = childEnvironment(original);
      assert.equal(env.__COMPAT_LAYER, 'HIGHDPIAWARE'); assert.equal(env.KEEP, 'unchanged');
      assert.equal(original.__COMPAT_LAYER, 'RunAsAdmin HIGHDPIAWARE');
      assert.equal(childEnvironment({ __COMPAT_LAYER: 'RunAsAdmin' }).__COMPAT_LAYER, undefined);
      fs.mkdirSync(broker.lock); const other = 'ffffffffffffffffffffffff';
      fs.writeFileSync(path.join(broker.lock, `${other}.json`), '{}');
      broker.unlock('eeeeeeeeeeeeeeeeeeeeeeee');
      assert.equal(broker.lockOwner().job_id, other); broker.unlock(other); assert.equal(broker.lockOwner(), null);
    });
    let first;
    await t.test('review gate: same native session, independent evidence, version binding and no execution before approval', async () => {
      const result = await broker.run({ wait: true, prompt: 'REVIEW_VALID_FIXTURE 中文参数', topic: '审核通过自动执行' });
      assert.equal(result.status, 'completed'); assert.equal(result.plan_review.status, 'approved');
      assert.deepEqual(result.plan_review.allowed_scope, ['仅按测试要求实施，不扩大任务范围']);
      const events = fs.readFileSync(result.paths.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(events.filter(e => e.type === 'bridge.attempt').map(e => e.stage), ['review', 'execute']);
      assert.equal(events.filter(e => e.type === 'bridge.review.approved').length, 1);
      assert.deepEqual([...new Set(events.filter(e => e.type === 'thread.started').map(e => e.thread_id))], [result.session_id]);
      assert.equal(result.attempt_total, 1); assert.equal(result.plan_review.attempts.length, 1);
      assert.match(result.final_response, /resume=True/);
      for (const fixture of ['REVIEW_NO_MARKER_FIXTURE', 'REVIEW_WRONG_VERSION_FIXTURE', 'REVIEW_EMPTY_SCOPE_FIXTURE', 'REVIEW_NO_TOOLS_FIXTURE', 'REVIEW_WRITE_FIXTURE']) {
        const held = await broker.run({ wait: true, prompt: fixture, topic: fixture });
        assert.equal(held.status, 'review_needs_evidence', fixture);
        assert.equal(held.plan_review.status, 'needs_evidence');
        assert.equal(new Broker(settings).get(held.job_id).stage, 'review_held');
        const log = fs.readFileSync(held.paths.events, 'utf8');
        assert.doesNotMatch(log, /"stage":"execute"/, fixture);
        assert.equal(fs.existsSync(path.join(path.dirname(held.paths.job || broker.jobPath(held.job_id)), 'attempt-1.result.txt')), false);
      }
      const missing = await broker.run({ wait: true, prompt: 'REVIEW_VALID_FIXTURE 缺少用户原文', user_request: undefined });
      assert.equal(missing.status, 'review_needs_evidence'); assert.match(missing.handoff.reason, /用户原文/);
    });
    await t.test('technical revision and evidence requests return to the same matter for fresh review; user decisions remain mandatory', async () => {
      for (const [fixture, status] of [['REVIEW_REVISE_FIXTURE', 'review_revise'], ['REVIEW_EVIDENCE_FIXTURE', 'review_needs_evidence']]) {
        const held = await broker.run({ wait: true, prompt: fixture, topic: fixture });
        assert.equal(held.status, status); assert.equal(held.handoff.requires_user_decision, false);
        await assert.rejects(broker.run({ prompt: '直接执行', topic_id: held.topic_id }), /CODEX_REVIEW_FOLLOWUP_REQUIRED/);
        const revised = await broker.run({ wait: true, prompt: 'REVIEW_VALID_FIXTURE 已按当前接口修订并补充日志', topic_id: held.topic_id, review_followup: { review_job_id: held.job_id, response: '回应全部待修订/补证项，保留原目标与约束。' } });
        assert.equal(revised.status, 'completed'); assert.equal(revised.session_id, held.session_id);
        assert.notEqual(revised.plan_review.plan_sha256, held.plan_review.plan_sha256);
        assert.equal(broker.get(held.job_id).plan_review.status, held.plan_review.status);
      }
      const held = await broker.run({ wait: true, prompt: 'REVIEW_USER_FIXTURE', topic: '审核涉及用户限制' });
      assert.equal(held.handoff.requires_user_decision, true);
      await assert.rejects(broker.run({ prompt: '规划端认为可以', topic_id: held.topic_id }), /CODEX_USER_DECISION_REQUIRED/);
      const reply = await broker.run({ wait: true, prompt: 'REVIEW_VALID_FIXTURE 保留原限制继续', topic_id: held.topic_id, plan_decision: { refusal_job_id: held.job_id }, user_followup: '保留原限制，在限制内重新设计。' });
      assert.equal(reply.status, 'completed'); assert.equal(reply.session_id, held.session_id);
    });
    await t.test('new execution evidence invalidates approval and preserves completed work for re-review', async () => {
      const held = await broker.run({ wait: true, prompt: 'EXECUTION_REVIEW_INVALIDATED_FIXTURE', topic: '执行中假设失效' });
      assert.equal(held.status, 'review_revise'); assert.equal(held.plan_review.status, 'revise_required');
      assert.equal(held.handoff.completed, '已完成只读检查'); assert.equal(held.stage, 'review_held');
      await assert.rejects(broker.run({ prompt: '继续原执行', topic_id: held.topic_id }), /CODEX_REVIEW_FOLLOWUP_REQUIRED/);
      const continued = await broker.run({ wait: true, prompt: 'REVIEW_VALID_FIXTURE 按新证据修订，不重复已做检查', topic_id: held.topic_id, review_followup: { review_job_id: held.job_id, response: '按实际接口重新设计，保留已完成部分。' } });
      assert.equal(continued.status, 'completed'); assert.equal(continued.session_id, held.session_id);
    });
    await t.test('background completion, UTF-8 and restart-safe reads', async () => {
      first = broker.start({ prompt: '中文参数', user_request: 'USER_ORIGINAL_SENTINEL 原文：不要偷偷换路线。', sandbox: 'read-only' });
      await assert.rejects(broker.run({ prompt: 'duplicate', topic_id: first.topic_id }), /still running/);
      const result = await finished(broker, first.job_id);
      assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 0);
      assert.match(result.final_response, /resume=True unicode=True/);
      assert.equal(result.plan_review.status, 'approved'); assert.equal(result.stage, 'execute');
      assert.match(result.final_response, /native_subagents=True/);
      assert.match(result.final_response, /acceptance_contract=True/);
      assert.match(result.final_response, /original_request=True user_followup=False/);
      assert.equal(result.request_context.source, 'caller_supplied');
      assert.equal(result.chat_title.status, 'set'); assert.equal(result.chat_title.name, '中文参数');
      assert.equal(fs.readFileSync(path.join(project, '.fake-title-' + result.session_id + '.txt'), 'utf8'), '中文参数');
      assert.equal(new Broker(settings).status(first.job_id).thread_id, '00000000-0000-0000-0000-000000000001');
      assert.ok(result.paths.events.startsWith(data));
    });
    await t.test('host-only dispatch rejects sandbox overrides before admission, including native and legacy continuations', async () => {
      const hostSettings = config(baseEnv), host = new Broker(hostSettings);
      assert.equal(hostSettings.allow_sandbox, false);
      assert.throws(() => config({ ...baseEnv, CODEX_EXECUTOR_ALLOW_SANDBOX: 'true' }), /ALLOW_SANDBOX/);
      assert.equal(config({ ...baseEnv, CODEX_EXECUTOR_ALLOW_SANDBOX: '0' }).allow_sandbox, false);
      for (const tool of dispatch(host, { method: 'tools/list' }).tools.filter(t => ['codex_run', 'codex_start', 'codex_continue'].includes(t.name))) {
        assert.equal(tool.inputSchema.properties.sandbox, undefined);
      }
      const before = host.list().length;
      let lookups = 0; host.metadataCall = async () => { lookups++; throw Error('Unexpected metadata lookup'); };
      for (const sandbox of ['read-only', 'workspace-write']) {
        assert.throws(() => host.start({ prompt: '只读诊断，不重启客户端', sandbox }), /宿主机/);
        for (const identity of [{}, { topic_id: first.topic_id }, { session_id: '00000000-0000-0000-0000-000000000099' }]) {
          const reply = await dispatch(host, { method: 'tools/call', params: { name: 'codex_run', arguments: { prompt: '只读诊断，不重启客户端', sandbox, ...identity } } });
          assert.equal(reply.isError, true); assert.match(reply.content[0].text, /宿主机/);
        }
        for (const name of ['codex_start', 'codex_continue']) {
          const reply = dispatch(host, { method: 'tools/call', params: { name, arguments: { job_id: first.job_id, prompt: '只读诊断', sandbox } } });
          assert.equal(reply.isError, true); assert.match(reply.content[0].text, /宿主机/);
        }
      }
      assert.equal(lookups, 0); assert.equal(host.list().length, before);
      // An old isolated session resumes on the host without inheriting its previous sandbox.
      const result = await host.run({ wait: true, prompt: '只读诊断，不改文件，不重启客户端。中文参数', user_followup: 'USER_FOLLOWUP_SENTINEL 我确认只读诊断。', topic_id: first.topic_id });
      assert.equal(result.status, 'completed'); assert.equal(result.sandbox, 'danger-full-access');
      assert.equal(result.execution_environment, 'host'); assert.equal(result.session_id, host.get(first.job_id).thread_id);
      assert.match(result.final_response, /sandbox=danger-full-access/);
      assert.match(result.final_response, /acceptance_contract=True/);
      assert.match(result.final_response, /original_request=True user_followup=True/);
      assert.equal(result.request_context.followup_count, 1);
      assert.equal(host.status(first.job_id).execution_environment, 'sandbox');
      assert.equal(host.get(first.job_id).sandbox, 'read-only');
    });
    await t.test('same worktree runs eight independent workers; cancelling one leaves seven recoverable', async () => {
      const jobs = Array.from({ length: 8 }, (_, n) => broker.start({ prompt: 'CONCURRENT_FIXTURE 中文参数 ' + n, topic: '并发独立任务' + n }));
      assert.equal(new Set(jobs.map(j => j.topic_id)).size, 8);
      const active = new Broker(settings).list(20, undefined, true);
      assert.equal(jobs.filter(j => active.some(a => a.job_id === j.job_id)).length, 8);
      broker.cancel(jobs[0].job_id);
      const results = await Promise.all(jobs.map(j => broker.wait(j.job_id)));
      assert.equal(results[0].status, 'cancelled'); assert.ok(results.slice(1).every(r => r.status === 'completed'));
      assert.equal(new Set(results.slice(1).map(r => r.session_id)).size, 7);
      assert.equal(broker.lockOwner(), null);
    });
    await t.test('title metadata failure is recorded without failing or rerunning the task', async () => {
      const result = await broker.wait(broker.start({ prompt: 'TITLE_METADATA_ERROR 中文参数', topic: 'TITLE_METADATA_ERROR 具体任务', sandbox: 'read-only' }).job_id);
      assert.equal(result.status, 'completed'); assert.equal(result.attempt_total, 1);
      assert.equal(result.chat_title.status, 'failed'); assert.match(result.chat_title.error, /fixture title metadata failure/);
    });
    await t.test('exact-session continuation keeps identity and defaults to full access without mutating the prior job', async () => {
      const call = dispatch(broker, { method: 'tools/call', params: { name: 'codex_continue', arguments: { job_id: first.job_id, prompt: '中文参数' } } });
      const result = await finished(broker, JSON.parse(call.content[0].text).job_id);
      assert.equal(result.status, 'completed'); assert.equal(result.sandbox, 'danger-full-access');
      assert.equal(broker.get(first.job_id).sandbox, 'read-only');
      assert.match(result.final_response, /sandbox=danger-full-access web_live=True/);
      assert.equal(result.parent_job_id, first.job_id); assert.match(result.final_response, /resume=True/);
    });
    await t.test('full access and live search are the unattended default, explicit narrowing remains available', async () => {
      const full = await broker.run({ wait: true, prompt: '中文参数' });
      assert.equal(full.sandbox, 'danger-full-access'); assert.equal(full.web_search, 'live');
      assert.equal(full.execution_environment, 'host');
      assert.match(full.final_response, /sandbox=danger-full-access web_live=True/);
      const narrow = await broker.run({ wait: true, prompt: '中文参数', session_id: full.session_id, sandbox: 'read-only' });
      assert.equal(narrow.sandbox, 'read-only'); assert.equal(narrow.session_id, full.session_id);
      assert.equal(narrow.execution_environment, 'sandbox');
      assert.match(narrow.final_response, /sandbox=read-only web_live=True/);
      const continued = await broker.run({ wait: true, prompt: '中文参数', topic_id: narrow.topic_id });
      assert.equal(continued.sandbox, 'danger-full-access'); assert.equal(continued.session_id, full.session_id);
      assert.match(continued.final_response, /sandbox=danger-full-access web_live=True/);
    });
    await t.test('nonzero exit and false-success detection', async () => {
      const failed = await finished(broker, broker.start({ prompt: 'FAIL_FIXTURE' }).job_id);
      assert.equal(failed.status, 'failed'); assert.equal(failed.exit_code, 7); assert.match(failed.stderr_tail, /fixture failure/);
      const empty = await finished(broker, broker.start({ prompt: 'EMPTY_FIXTURE' }).job_id);
      assert.equal(empty.status, 'failed'); assert.equal(empty.exit_code, 0); assert.match(empty.error, /turn.completed/);
      const recovered = await broker.run({ wait: true, prompt: 'RECOVERED_ERROR_FIXTURE' });
      assert.equal(recovered.status, 'completed'); assert.equal(recovered.error, undefined);
      const late = await broker.run({ wait: true, prompt: 'LATE_ERROR_FIXTURE' });
      assert.equal(late.status, 'failed'); assert.match(late.error, /final failure/);
    });
    await t.test('one-call receipt, multi-part output, session switching and originating chat isolation', async () => {
      const chatA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', chatB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const a = await broker.run({ wait: true, prompt: '中文参数', sandbox: 'read-only', conversation_id: chatA });
      assert.equal(a.status, 'completed'); assert.equal(a.conversation_id, chatA);
      assert.equal(a.events_tail, undefined); assert.equal(a.stderr_tail, undefined);
      assert.ok(fs.existsSync(a.paths.receipt));
      const events = fs.readFileSync(a.paths.events, 'utf8'); assert.match(events, /part-1/); assert.match(events, /part-2/);
      const b = await broker.run({ wait: true, prompt: 'SECOND_SESSION 中文参数', sandbox: 'read-only', conversation_id: chatB });
      assert.notEqual(a.session_id, b.session_id);
      const switched = await broker.run({ wait: true, prompt: '中文参数', session_id: a.session_id, conversation_id: chatB });
      assert.equal(switched.status, 'completed'); assert.equal(switched.session_id, a.session_id); assert.equal(switched.conversation_id, chatB); assert.match(switched.final_response, /resume=True/);
      assert.equal((await new Broker(settings).wait(a.job_id)).conversation_id, chatA);
      assert.ok((await broker.sessions({ include_native: false })).sessions.some(item => item.session_id === b.session_id));
    });
    await t.test('planner model selection, explicit Medium CLI args and per-matter background continuation', async () => {
      assert.equal(settings.model, 'fixture-terra'); assert.equal(settings.reasoning_effort, 'medium'); assert.equal(settings.service_tier, 'fast');
      for (const input of [{ model: 'bad model' }, { model: '__proto__' }, { reasoning_effort: 'max' }, { wait: 'false' }, { topic: '' }]) {
        assert.throws(() => broker.start({ prompt: 'x', ...input }), /model|reasoning_effort|wait|topic/);
      }
      const chat = 'abababab-abab-abab-abab-abababababab';
      const a = await broker.run({ prompt: '中文参数', topic: '事项A 查询', model: 'luna', sandbox: 'read-only', conversation_id: chat });
      assert.equal(a.status, 'queued'); assert.equal(a.model, 'fixture-luna'); assert.equal(a.reasoning_effort, 'medium'); assert.equal(a.service_tier, 'fast'); assert.ok(a.topic_id);
      await assert.rejects(broker.run({ topic_id: a.topic_id, prompt: '不能重复派发' }), /still running/);
      const ra = await broker.wait(a.job_id);
      assert.match(ra.final_response, /model=fixture-luna effort=model_reasoning_effort="medium" fast=True/);
      const b = await broker.run({ prompt: 'SECOND_SESSION 中文参数', topic: '事项B 实现', model: 'terra', sandbox: 'read-only', conversation_id: chat });
      const rb = await broker.wait(b.job_id);
      assert.equal(b.model, 'fixture-terra'); assert.notEqual(a.topic_id, b.topic_id); assert.notEqual(ra.session_id, rb.session_id);
      await assert.rejects(broker.run({ prompt: 'x', topic_id: a.topic_id, session_id: rb.session_id }), /disagree/);
      await assert.rejects(broker.run({ prompt: 'x', topic_id: a.topic_id, topic: '另一个事项' }), /different matter/);
      const resumed = await broker.run({ topic_id: a.topic_id, prompt: '中文参数' });
      assert.equal(resumed.model, 'fixture-luna'); assert.equal(resumed.topic, a.topic); assert.equal(resumed.topic_id, a.topic_id);
      const rr = await broker.wait(resumed.job_id); assert.equal(rr.status, 'completed'); assert.match(rr.final_response, /fast=True/); assert.equal(rr.session_id, ra.session_id); assert.match(rr.final_response, /resume=True/);
      const sol = await broker.run({ topic_id: b.topic_id, prompt: '中文参数', model: 'sol' });
      assert.equal(sol.model, 'fixture-sol'); assert.equal(sol.reasoning_effort, 'medium');
      assert.match((await broker.wait(sol.job_id)).final_response, /model=fixture-sol effort=model_reasoning_effort="medium" fast=True/);
      const known = await broker.sessions({ include_native: false });
      assert.ok(known.sessions.some(x => x.topic_id === a.topic_id && x.model === 'fixture-luna'));
    });
    await t.test('background MCP returns before execution ends and client disconnect does not stop the task', { timeout: 30000 }, async t => {
      const child = spawn(process.execPath, [path.join(__dirname, '../src/server.cjs')], { windowsHide: true, env: { ...process.env, CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry }, stdio: ['pipe', 'pipe', 'pipe'] });
      t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill(); });
      const pending = new Map(); let seq = 0;
      readline.createInterface({ input: child.stdout }).on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); });
      const call = (method, params = {}) => new Promise(resolve => { const id = seq++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
      await call('initialize');
      const reply = await call('tools/call', { name: 'codex_run', arguments: { prompt: '中文参数', user_request: '测试用户原文：核查中文参数。', topic: '不占聊天的后台事项', model: 'terra' } });
      assert.equal(reply.result.isError, false); const ack = JSON.parse(reply.result.content[0].text);
      assert.equal(ack.status, 'queued'); assert.equal(ack.final_response, undefined); assert.ok(ack.topic_id);
      assert.deepEqual((await call('ping')).result, {});
      const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); assert.equal(await closed, 0);
      const result = await new Broker(settings).wait(ack.job_id);
      assert.equal(result.status, 'completed'); assert.equal(result.topic_id, ack.topic_id);
    });
    await t.test('capacity continuation: six starts per rolling hour, no lifetime limit, same model/thread', async () => {
      assert.equal(isCapacity(capacityMessage), true); assert.equal(isCapacity(capacityMessage + '.'), true);
      assert.equal(isCapacity('user quoted: ' + capacityMessage), false);
      const execute = async (prompt, stopAfter) => {
        const id = require('node:crypto').randomBytes(12).toString('hex'), file = broker.jobPath(id);
        fs.mkdirSync(path.dirname(file));
        fs.writeFileSync(file, JSON.stringify({ job_id: id, status: 'queued', created_at: new Date().toISOString(), cwd: project, sandbox: 'read-only', prompt, request_context: { original_text: '测试原文：核查容量重试', followups: [] }, topic_id: id, topic: '限频容量续跑', timeout_seconds: 30, settings: { ...settings, model: 'fixture-luna' } }));
        let now = Date.now(), waits = 0;
        await worker(file, { now: () => now, wait: async until => { assert.ok(until >= now + 600000); now = until; return ++waits < stopAfter; } });
        return { receipt: broker.receipt(id), job: broker.get(id) };
      };
      const first = await execute('CAPACITY_ONCE_FIXTURE 中文参数', Infinity);
      assert.equal(first.receipt.status, 'completed'); assert.equal(first.receipt.attempt_total, 2);
      assert.equal(first.receipt.session_id, '00000000-0000-0000-0000-000000000009'); assert.match(first.receipt.final_response, /resume=True/);
      const long = await execute('CAPACITY_ALWAYS_FIXTURE', 8);
      assert.equal(long.receipt.status, 'cancelled'); assert.equal(long.receipt.attempt_total, 8); assert.equal(long.receipt.attempts.length, 6);
      assert.ok(long.job.attempts.every(x => x.model === 'fixture-luna'));
      const starts = long.job.attempts.map(x => Date.parse(x.started_at));
      for (const end of starts) assert.ok(starts.filter(t => t > end - 3600000 && t <= end).length <= 6);
      assert.ok(capacityRetryAt(long.job.attempts, starts.at(-1)) >= starts.at(-1) + 600000);
      const failure = await broker.run({ wait: true, prompt: 'FAIL_FIXTURE' }); assert.equal(failure.attempt_total, 1);
      const queued = await broker.run({ prompt: 'CAPACITY_ALWAYS_FIXTURE' });
      try {
        await new Promise((resolve, reject) => {
          const dir = path.dirname(broker.jobPath(queued.job_id));
          const watcher = fs.watch(dir, (_event, name) => { if (!name || String(name) === 'job.json') check(); });
          const timer = setTimeout(() => finish(new Error('Fixture did not enter waiting_capacity within startup deadline')), 30000);
          const finish = error => { clearTimeout(timer); watcher.close(); error ? reject(error) : resolve(); };
          const check = () => { try { const state = broker.get(queued.job_id); if (state.status === 'waiting_capacity') finish(); else if (terminal.has(state.status)) finish(new Error('Unexpected terminal state: ' + state.status)); } catch (error) { finish(error); } };
          watcher.on('error', finish); check();
        });
        assert.equal(broker.get(queued.job_id).status, 'waiting_capacity'); assert.equal(broker.get(queued.job_id).attempts.length, 1);
      } finally { broker.cancel(queued.job_id); await broker.wait(queued.job_id); }
      assert.equal(broker.get(queued.job_id).status, 'cancelled');
    });
    await t.test('decision/logic handoff, exact originating chat injection, event delivery and deduplication', async () => {
      const chat = '12121212-1212-1212-1212-121212121212';
      const payload = { toolCall: { name: 'codex_run', args: { prompt: 'x' } }, conversationId: chat, workspacePaths: [project] };
      assert.deepEqual(originHook(payload, project), { decision: 'allow', overwrite: { conversation_id: chat, cwd: project } });
      const hook = spawnSync(settings.pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, '../src/invoke-codex.ps1'), '-OriginHook', '-ProjectRoot', project, '-NodeEntry', process.execPath], { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true });
      assert.equal(hook.status, 0); assert.equal(hook.stderr, ''); assert.deepEqual(JSON.parse(hook.stdout), { decision: 'allow', overwrite: { conversation_id: chat, cwd: project } });
      assert.deepEqual(originHook({ ...payload, toolCall: { name: 'read_file' } }, project), { decision: 'allow' });
      assert.equal(originHook({ ...payload, workspacePaths: [data] }, project).decision, 'deny');
      const noticeData = path.join(root, 'notice-runtime'); fs.mkdirSync(noticeData); const notices = new Broker({ ...settings, data: noticeData });
      let messages = []; const watcher = watch(notices, async (recipient, text) => { messages.push({ recipient, text }); return { exit_code: 0 }; });
      const terminalMessages = () => messages.filter(m => m.text.includes('事件=terminal'));
      try {
        const r = await notices.run({ wait: true, prompt: 'NEEDS_INPUT_FIXTURE', topic: '等待选择', conversation_id: chat });
        assert.equal(r.status, 'needs_input'); assert.equal(notices.lockOwner(), null);
        for (let i = 0; i < 40 && !terminalMessages().length; i++) await sleep(50);
        assert.equal(terminalMessages().length, 1); assert.ok(messages.every(m => m.recipient === chat)); assert.match(messages[0].text, /CODEX_EVENT/);
        assert.equal(await deliver(notices, r.job_id, async () => { throw Error('duplicate delivery'); }), false);
        const paused = await notices.run({ wait: true, prompt: 'BLOCKED_FIXTURE', topic: '逻辑问题', conversation_id: chat }); assert.equal(paused.status, 'blocked');
        const noticePath = path.join(path.dirname(notices.jobPath(paused.job_id)), 'notice.json');
        for (let i = 0; i < 40 && !fs.existsSync(noticePath); i++) await sleep(50);
        assert.ok(fs.existsSync(noticePath));
        for (let i = 0; i < 40 && terminalMessages().length < 2; i++) await sleep(50);
        assert.equal(terminalMessages().length, 2);
        const progress = await notices.run({ wait: true, prompt: 'PROGRESS_FIXTURE', topic: '测试阶段变化', conversation_id: chat });
        const { notificationEvents } = require('../src/server.cjs');
        const kinds = notificationEvents(notices.jobPath(progress.job_id)).map(e => e.kind);
        assert.ok(kinds.includes('started')); assert.ok(kinds.includes('session_ready')); assert.ok(kinds.includes('phase_started')); assert.ok(kinds.includes('phase_finished'));
      } finally { watcher.close(); }
    });
    await t.test('real worker preserves plan refusal even on nonzero exit, gates continuation and accepts the saved human reply', async () => {
      const refusalData = path.join(root, 'refusal-runtime'); fs.mkdirSync(refusalData);
      const refused = new Broker({ ...settings, data: refusalData });
      const result = await refused.run({ wait: true, prompt: 'PLAN_REJECTED_FIXTURE', topic: '方案拒绝交接', user_request: '不做整集转码' });
      assert.equal(result.status, 'blocked'); assert.equal(result.handoff.requires_user_decision, true);
      assert.equal(result.handoff.reason, '缺少画面显示通路');
      await assert.rejects(new Broker(refused.settings).run({ prompt: '自行换方案', topic_id: result.topic_id }), /CODEX_USER_DECISION_REQUIRED/);
      const continued = await refused.run({ wait: true, prompt: '继续补齐原方案', topic_id: result.topic_id, plan_decision: { refusal_job_id: result.job_id }, user_followup: '我选补齐，不要转码。' });
      assert.equal(continued.status, 'completed'); assert.equal(continued.session_id, result.session_id);
      assert.equal(continued.plan_decision.refusal_job_id, result.job_id);
      const failed = await refused.run({ wait: true, prompt: 'PLAN_REJECTED_FIXTURE NONZERO_REFUSAL_FIXTURE', topic: '拒绝伴随退出错误' });
      assert.equal(failed.exit_code, 1); assert.equal(failed.status, 'blocked'); assert.equal(failed.handoff.requires_user_decision, true);
      assert.equal(failed.handoff.reason, '缺少画面显示通路');
    });
    await t.test('worker distinguishes policy blocks, persists original constraints and injects diagnostic continuation without a model', async () => {
      const policyData = path.join(root, 'policy-runtime'); fs.mkdirSync(policyData);
      const host = new Broker({ ...settings, data: policyData });
      const reported = await host.run({ wait: true, prompt: 'POLICY_REPORTED_FIXTURE', topic: '执行受阻', user_request: '保留已经确认的方案 A' });
      assert.equal(reported.status, 'execution_blocked'); assert.equal(reported.execution_state, 'policy_blocked'); assert.equal(reported.verification_state, 'blocked');
      assert.equal(reported.execution_block.source, 'executor_report'); assert.equal(reported.handoff.requires_user_decision, undefined); assert.equal(host.lockOwner(), null);
      assert.equal(reported.handoff.completed, '已构建\n未实机验证');
      await assert.rejects(new Broker(host.settings).run({ prompt: '不能静默重试', topic_id: reported.topic_id }), /CODEX_EXECUTION_POLICY_UNRESOLVED/);
      const diagnostic = await host.run({ wait: true, prompt: '只读诊断，不执行原动作', topic_id: reported.topic_id, execution_followup: { blocked_job_ids: [reported.job_id], intent: 'diagnose' } });
      assert.equal(diagnostic.status, 'completed'); assert.equal(diagnostic.session_id, reported.session_id); assert.match(diagnostic.final_response, /policy_contract=True execution_diag=True/);
      assert.equal(diagnostic.execution_constraints[0].blocked_job_id, reported.job_id);
      await assert.rejects(host.run({ prompt: '诊断未解除拒绝', topic_id: reported.topic_id }), /CODEX_EXECUTION_POLICY_UNRESOLVED/);
      const machine = await host.run({ wait: true, prompt: 'POLICY_MACHINE_FIXTURE NONZERO_REFUSAL_FIXTURE', topic: '原生日志拒绝' });
      assert.equal(machine.exit_code, 1); assert.equal(machine.status, 'execution_blocked'); assert.equal(machine.execution_block.source, 'cli_stderr'); assert.equal(machine.execution_block.cause_status, 'unverified');
      const quoted = await host.run({ wait: true, prompt: 'POLICY_QUOTED_FIXTURE', topic: '引用不构成拒绝' });
      assert.equal(quoted.status, 'completed'); assert.equal(quoted.execution_block, null);
      const both = await host.run({ wait: true, prompt: 'POLICY_COMBINED_FIXTURE', topic: '两类问题并存' });
      assert.equal(both.status, 'execution_blocked'); assert.equal(both.execution_block.source, 'cli_stderr'); assert.equal(both.handoff.requires_user_decision, true);
      assert.deepEqual(both.handoff.options, ['补齐原方案', '修改要求']);
      assert.equal(new Broker(host.settings).result(reported.job_id).status, 'execution_blocked');
    });
    await t.test('structured question resumes exact topic/session with user answer; background command is not verified', async () => {
      const paused = await broker.run({ wait: true, prompt: 'STRUCTURED_QUESTION_FIXTURE', topic: '选择题交接' });
      assert.equal(paused.status, 'needs_input'); assert.equal(paused.handoff.question, '选择工作树还是等待？');
      assert.deepEqual(paused.handoff.options, ['工作树：隔离修改', '等待：复用目录']);
      assert.deepEqual(new Broker(settings).receipt(paused.job_id).handoff, paused.handoff);
      const continued = await broker.run({ wait: true, topic_id: paused.topic_id, prompt: '用户选择：等待。继续原事项，不重做已完成步骤。' });
      assert.equal(continued.status, 'completed'); assert.equal(continued.session_id, paused.session_id); assert.equal(continued.topic_id, paused.topic_id);
      const background = await broker.run({ wait: true, prompt: 'BACKGROUND_HANDOFF_FIXTURE', topic: '后台命令交接' });
      assert.equal(background.status, 'completed'); assert.equal(background.execution_state, 'background_unconfirmed'); assert.equal(background.verification_state, 'pending');
      assert.equal(background.background_commands[0].item_id, 'test-pending');
    });
    await t.test('multi-project routing: independent workers/locks, cwd scope and no cross-project matter access', async () => {
      const otherProject = path.join(root, '另一个项目'), otherData = path.join(root, 'other-runtime'); fs.mkdirSync(otherProject); fs.mkdirSync(otherData);
      const combined = config({ CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry, CODEX_EXECUTOR_PWSH: settings.pwsh, CODEX_EXECUTOR_PROJECTS: JSON.stringify([{ project, data }, { project: otherProject, data: otherData }]) });
      const { ProjectRouter } = require('../src/router.cjs'), router = new ProjectRouter(combined);
      const slow = await router.run({ prompt: 'SLOW_FIXTURE', user_request: '测试项目A独立任务', cwd: project, topic: '项目A独立任务' });
      const fast = await router.run({ wait: true, prompt: '中文参数', user_request: '测试项目B独立任务', cwd: otherProject, topic: '项目B独立任务', model: 'terra' });
      assert.equal(fast.status, 'completed'); assert.ok(fast.paths.result.startsWith(otherData)); assert.equal(router.status(slow.job_id).cwd, project);
      await assert.rejects(router.run({ prompt: 'x', topic_id: fast.topic_id, cwd: project }), /different project/);
      const chat = '34343434-3434-3434-3434-343434343434';
      const payload = { toolCall: { name: 'codex_run', args: { prompt: 'x' } }, conversationId: chat, workspacePaths: [otherProject] };
      assert.equal(originHook(payload, combined.projects).overwrite.cwd, otherProject);
      assert.equal(originHook({ ...payload, toolCall: { name: 'codex_run', args: { cwd: project } } }, combined.projects).decision, 'deny');
      assert.equal(originHook({ ...payload, toolCall: { name: 'codex_cancel', args: { job_id: slow.job_id } } }, combined.projects).decision, 'deny');
      assert.equal(originHook({ ...payload, toolCall: { name: 'codex_result', args: { job_id: fast.job_id } } }, combined.projects).decision, 'allow');
      assert.equal(originHook({ ...payload, workspacePaths: [root] }, combined.projects).decision, 'deny');
      assert.equal((await router.sessions({ cwd: otherProject, include_native: false })).sessions.length, 1);
      assert.ok(router.list(20, otherProject).every(j => j.cwd === otherProject));
      router.cancel(slow.job_id); assert.equal((await router.wait(slow.job_id)).status, 'cancelled');
    });
    await t.test('native session metadata validation does not start a model and denies foreign cwd', async () => {
      const nativeId = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; let methods = [];
      const native = new Broker(settings, async (_settings, method) => { methods.push(method); return { thread: { id: nativeId, cwd: project, status: { type: 'notLoaded' } } }; });
      const result = await native.run({ wait: true, prompt: '中文参数', session_id: nativeId });
      assert.equal(result.session_id, nativeId); assert.equal(broker.status(result.job_id).sandbox, 'danger-full-access'); assert.deepEqual(methods, ['thread/read']);
      const foreignId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      const foreign = new Broker(settings, async () => ({ thread: { id: foreignId, cwd: root, status: { type: 'notLoaded' } } }));
      await assert.rejects(foreign.run({ wait: true, prompt: 'x', session_id: foreignId }), /outside/);
    });
    await t.test('cancelling a wait leaves the owned task recoverable, without global hooks', async () => {
      const job = broker.start({ prompt: 'SLOW_FIXTURE' });
      const controller = new AbortController(); const wait = broker.wait(job.job_id, controller.signal); controller.abort();
      await assert.rejects(wait, /Wait cancelled/);
      assert.ok(!terminal.has(broker.status(job.job_id).status));
      broker.cancel(job.job_id); assert.equal((await broker.wait(job.job_id)).status, 'cancelled');
    });
    await t.test('stale unlock does not remove a newly acquired empty lease', () => {
      fs.mkdirSync(broker.lock, { recursive: true });
      broker.unlock('ffffffffffffffffffffffff');
      assert.equal(fs.statSync(broker.lock).isDirectory(), true);
      const id = 'eeeeeeeeeeeeeeeeeeeeeeee';
      fs.writeFileSync(path.join(broker.lock, `${id}.json`), '{}');
      broker.unlock(id);
      assert.equal(broker.lockOwner(), null);
    });
    await t.test('cancellation kills only the owned child and releases the lock', async () => {
      const slow = broker.start({ prompt: 'SLOW_FIXTURE' });
      await sleep(2000);
      const restarted = new Broker(settings);
      assert.equal(restarted.status(slow.job_id).status, 'running');
      assert.equal(restarted.cancel(slow.job_id).status, 'cancel_requested');
      const result = await finished(restarted, slow.job_id);
      assert.equal(result.status, 'cancelled'); assert.equal(broker.lockOwner(), null);
    });
    await t.test('real stdio framing: initialize id=0, notifications and tool discovery', async () => {
      const child = spawn(process.execPath, [path.join(__dirname, '../src/server.cjs')], { windowsHide: true, env: { ...process.env, CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry }, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
      child.stdin.end([
        JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), '{invalid'
      ].join('\n') + '\n');
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      assert.equal(code, 0); assert.equal(err, '');
      const replies = out.trim().split('\n').map(JSON.parse);
      assert.equal(replies.length, 3); assert.equal(replies.find(reply => reply.id === 0).result.serverInfo.name, 'codex-executor');
      assert.equal(replies.find(reply => reply.id === 1).result.tools.length, 9); assert.equal(replies.find(reply => reply.id === null).error.code, -32700);
    });
    await t.test('one real MCP execution response, no progress model turns, concurrent ping remains responsive', async t => {
      const child = spawn(process.execPath, [path.join(__dirname, '../src/server.cjs')], { windowsHide: true, env: { ...process.env, CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry }, stdio: ['pipe', 'pipe', 'pipe'] });
      t.after(() => { child.stdin.destroy(); if (child.exitCode === null) child.kill(); });
      const pending = new Map(), replies = []; let seq = 0;
      readline.createInterface({ input: child.stdout }).on('line', line => {
        const reply = JSON.parse(line); replies.push(reply);
        const resolve = pending.get(reply.id); if (resolve) { pending.delete(reply.id); resolve(reply); }
      });
      const call = (method, params = {}) => new Promise(resolve => {
        const id = seq++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      await call('initialize', { protocolVersion: '2024-11-05' });
      const running = call('tools/call', { name: 'codex_run', arguments: { wait: true, prompt: '中文参数', user_request: '测试真实协议的中文参数', conversation_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' } });
      const ping = await call('ping'); assert.deepEqual(ping.result, {});
      const completed = await running; const receipt = JSON.parse(completed.result.content[0].text);
      assert.equal(receipt.status, 'completed'); assert.equal(receipt.conversation_id, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
      assert.equal(replies.length, 3); assert.ok(replies.every(reply => !reply.method));
      assert.equal(replies[1].id, ping.id); assert.equal(completed.result.isError, false);
      const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); assert.equal(await closed, 0);
    });
  } finally {
    // Only fixture-owned files in the explicitly allocated E-drive directory.
    for (const job of broker.list()) if (!terminal.has(job.status)) broker.cancel(job.job_id);
    const jobs = broker.list();
    if (jobs.every(job => terminal.has(job.status))) fs.rmSync(root, { recursive: true, force: true });
  }
});


test('native chat links are restart-stable and reject URI injection', async () => {
  const id = '00000000-0000-0000-0000-000000000003';
  const expected = 'vscode://openai.chatgpt/local/' + id;
  assert.equal(chatAccess(id).vscode_uri, expected);
  for (const invalid of [null, undefined, '', 'latest', id + '/../../x', id + '?prompt=run']) assert.equal(chatAccess(invalid), null);
  assert.deepEqual(chatAccess(id), chatAccess(id));
  assert.equal(chatAccess(id).vscode_insiders_uri, 'vscode-insiders://openai.chatgpt/local/' + id);
  const b = Object.create(Broker.prototype);
  b.settings = { project: 'fixture-project' };
  b.knownSessions = () => [];
  let called = 0;
  b.metadataCall = async (_settings, method, params) => {
    called++; assert.equal(method, 'thread/list');
    assert.deepEqual(params.sourceKinds, ['cli', 'vscode', 'exec', 'appServer']);
    assert.equal(params.cwd, 'fixture-project');
    return { data: [{ id, cwd: 'fixture-project', preview: '后台任务', source: 'exec' }], nextCursor: 'page-2' };
  };
  const listed = await b.sessions({ limit: 1 });
  assert.equal(called, 1); assert.equal(listed.next_cursor, 'page-2');
  assert.equal(listed.sessions[0].chat.vscode_uri, expected);
  assert.equal(b.summary({ thread_id: id }).chat.vscode_uri, expected);
  assert.equal(b.summary({}).chat, null);
  assert.equal(b.summary({}).notification, null);
  const result = await dispatch(b, { method: 'tools/call', params: { name: 'codex_sessions', arguments: { limit: 1 } } });
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.content[0].text).sessions[0].chat.vscode_uri, expected);
  assert.ok(result.content[1].text.includes('](' + expected + ')'));
  const repeated = toolResponse([{ chat: chatAccess(id) }, { chat: chatAccess(id) }]);
  assert.equal(repeated.content.length, 2);
  assert.equal(toolResponse({ chat: null }).content.length, 1);
});

test('persisted chat links, progress and long results survive broker restart without executing', async () => {
  assert.ok(process.env.CODEX_EXECUTOR_TEST_ROOT);
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'chat-history-'));
  try {
    const b = new Broker({ data: root });
    const id = '1234567890abcdef12345678', thread = '00000000-0000-0000-0000-000000000003';
    const jobDir = path.dirname(b.jobPath(id)); fs.mkdirSync(jobDir);
    save(b.jobPath(id), { job_id: id, status: 'completed', thread_id: thread, cwd: root, created_at: '2026-10-30T00:00:00Z' });
    const full = '任务全文\n' + '原始输出'.repeat(4000);
    fs.writeFileSync(path.join(jobDir, 'result.txt'), full);
    fs.writeFileSync(path.join(jobDir, 'events.jsonl'), 'partial-json\n' + JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已经定位，正在验证' } }) + '\n');
    const restarted = new Broker({ data: root }, () => { throw Error('Viewing saved job must not start native metadata or a model'); });
    const result = restarted.result(id);
    assert.equal(result.chat.vscode_uri, chatAccess(thread).vscode_uri);
    assert.equal(result.result_truncated, true);
    assert.equal(fs.readFileSync(result.paths.result, 'utf8'), full);
    assert.equal(result.progress.text, '已经定位，正在验证');
    assert.equal(restarted.list()[0].chat.vscode_uri, chatAccess(thread).vscode_uri);
    assert.equal((await restarted.sessions({ include_native: false })).sessions[0].chat.vscode_uri, chatAccess(thread).vscode_uri);
    const response = dispatch(restarted, { method: 'tools/call', params: { name: 'codex_result', arguments: { job_id: id } } });
    assert.equal(response.content.length, 2);
    assert.equal(JSON.parse(response.content[0].text).session_id, thread);
    fs.appendFileSync(path.join(jobDir, 'events.jsonl'), JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'pwsh -NoProfile -Command test', aggregated_output: 'x'.repeat(3000) } }) + '\n{incomplete');
    const progress = latestProgress(path.join(jobDir, 'events.jsonl'));
    assert.equal(progress.event_type, 'item.started'); assert.equal(progress.text.length, 2000); assert.equal(progress.text_truncated, true);
    assert.equal(latestProgress(path.join(root, 'missing.jsonl')), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('native task titles use the concrete task and metadata only, preserving manual and foreign titles', async () => {
  assert.equal(taskTitle({ topic: '查询 Node.js 版本', prompt: 'executor wrapper' }), '查询 Node.js 版本');
  assert.equal(taskTitle({ topic: '未命名事项', prompt: '\n## 修复播放器切集失败\n背景材料' }), '修复播放器切集失败');
  assert.equal(Array.from(taskTitle({ topic: '😀'.repeat(90) })).length, 80);
  const id = '00000000-0000-0000-0000-000000000003';
  const cwd = fs.realpathSync(process.cwd());
  const job = { thread_id: id, topic: '修复播放器切集失败', cwd, settings: { project: cwd } };
  const calls = [];
  const metadata = async (_settings, method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id, cwd, name: null } };
    assert.equal(method, 'thread/name/set'); assert.deepEqual(params, { threadId: id, name: job.topic }); return {};
  };
  assert.deepEqual(await syncTaskTitle(job, metadata), { status: 'set', name: job.topic, thread_id: id });
  assert.deepEqual(calls.map(c => c.method), ['thread/read', 'thread/name/set']);
  calls.length = 0;
  const manual = await syncTaskTitle(job, async (_s, method) => { calls.push(method); return { thread: { id, cwd, name: '用户手动命名' } }; });
  assert.equal(manual.status, 'preserved'); assert.equal(manual.name, '用户手动命名'); assert.deepEqual(calls, ['thread/read']);
  const foreign = await syncTaskTitle({ ...job, resumed_session: true }, () => { throw Error('Foreign session must not be renamed'); });
  assert.equal(foreign.status, 'preserved');
  await assert.rejects(syncTaskTitle(job, async () => ({ thread: { id: 'wrong-id', cwd } })), /outside/);
  await assert.rejects(syncTaskTitle(job, async (_s, method) => { if (method === 'thread/read') return { thread: { id, cwd } }; throw Error('metadata unavailable'); }), /metadata unavailable/);
  const pending = await syncTaskTitle({ ...job, thread_id: null }, () => { throw Error('No native request without ID'); });
  assert.equal(pending.status, 'pending');
});
