'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { taskTitle, syncTaskTitle, chatAccess, toolResponse, latestProgress, save, worker, capacityRetryAt, isCapacity, capacityMessage, Broker, config: parseConfig, dispatch, terminal, childEnvironment } = require('../src/server.cjs');

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
$text = 'FAKE_OK resume=' + ($argv -contains 'resume') + ' unicode=' + $prompt.Contains('中文参数') + ' model=' + $argv[$mi+1] + ' effort=' + ($ec -join ',') + ' fast=' + $fast + ' sandbox=' + $argv[$si+1] + ' web_live=' + $liveWeb
if ($prompt.Contains('NEEDS_INPUT_FIXTURE')) { $text = '[CODEX_NEEDS_INPUT] 请确认选择A还是B' }
if ($prompt.Contains('BLOCKED_FIXTURE')) { $text = '[CODEX_BLOCKED] 方案与当前代码矛盾' }
[IO.File]::WriteAllText($argv[$i+1], $text, [Text.UTF8Encoding]::new($false))
$tid = '00000000-0000-0000-0000-000000000001'
if ($argv -contains 'resume') { $tid = $argv[[Array]::IndexOf($argv, 'resume')+1] }
elseif ($prompt.Contains('SECOND_SESSION')) { $tid = '00000000-0000-0000-0000-000000000002' }
elseif ($prompt.Contains('TITLE_METADATA_ERROR')) { $tid = '00000000-0000-0000-0000-000000000004' }
'{"type":"thread.started","thread_id":"' + $tid + '"}'
if ($prompt.Contains('RECOVERED_ERROR_FIXTURE')) { '{"type":"error","message":"Reconnecting... 2/5 (request timed out)"}' }
if ($prompt.Contains('PROGRESS_FIXTURE')) {
  '{"type":"item.started","item":{"id":"check1","type":"command_execution","command":"cargo test -p fixture"}}'
  '{"type":"item.completed","item":{"id":"check1","type":"command_execution","command":"cargo test -p fixture","exit_code":0}}'
}
'{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"part-1","exit_code":0}}'
'{"type":"item.completed","item":{"type":"command_execution","aggregated_output":"part-2","exit_code":0}}'
'{"type":"item.completed","item":{"type":"agent_message","text":"FAKE_OK"}}'
'{"type":"turn.completed"}'
if ($prompt.Contains('LATE_ERROR_FIXTURE')) { '{"type":"turn.failed","error":{"message":"final failure"}}' }
exit 0
`, 'utf8');
  const settings = config({ CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry, CODEX_EXECUTOR_PWSH: process.env.CODEX_EXECUTOR_PWSH });
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
      assert.equal(broker.lockOwner().job_id, other); broker.unlock(other); assert.equal(fs.existsSync(broker.lock), false);
    });
    let first;
    await t.test('background completion, UTF-8 and restart-safe reads', async () => {
      first = broker.start({ prompt: '中文参数', sandbox: 'read-only' });
      assert.throws(() => broker.start({ prompt: 'duplicate' }), /already owns/);
      const result = await finished(broker, first.job_id);
      assert.equal(result.status, 'completed'); assert.equal(result.exit_code, 0);
      assert.match(result.final_response, /resume=False unicode=True/);
      assert.equal(result.chat_title.status, 'set'); assert.equal(result.chat_title.name, '中文参数');
      assert.equal(fs.readFileSync(path.join(project, '.fake-title-' + result.session_id + '.txt'), 'utf8'), '中文参数');
      assert.equal(new Broker(settings).status(first.job_id).thread_id, '00000000-0000-0000-0000-000000000001');
      assert.ok(result.paths.events.startsWith(data));
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
      assert.match(full.final_response, /sandbox=danger-full-access web_live=True/);
      const narrow = await broker.run({ wait: true, prompt: '中文参数', session_id: full.session_id, sandbox: 'read-only' });
      assert.equal(narrow.sandbox, 'read-only'); assert.equal(narrow.session_id, full.session_id);
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
    await t.test('background MCP returns before execution ends and client disconnect does not stop the task', { timeout: 20000 }, async () => {
      const child = spawn(process.execPath, [path.join(__dirname, '../src/server.cjs')], { windowsHide: true, env: { ...process.env, CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry }, stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map(); let seq = 0;
      readline.createInterface({ input: child.stdout }).on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); });
      const call = (method, params = {}) => new Promise(resolve => { const id = seq++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
      await call('initialize');
      const reply = await call('tools/call', { name: 'codex_run', arguments: { prompt: '中文参数', topic: '不占聊天的后台事项', model: 'terra' } });
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
        fs.writeFileSync(file, JSON.stringify({ job_id: id, status: 'queued', created_at: new Date().toISOString(), cwd: project, sandbox: 'read-only', prompt, topic_id: id, topic: '限频容量续跑', timeout_seconds: 30, settings: { ...settings, model: 'fixture-luna' } }));
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
        assert.equal(r.status, 'needs_input'); assert.equal(fs.existsSync(notices.lock), false);
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
    await t.test('multi-project routing: independent workers/locks, cwd scope and no cross-project matter access', async () => {
      const otherProject = path.join(root, '另一个项目'), otherData = path.join(root, 'other-runtime'); fs.mkdirSync(otherProject); fs.mkdirSync(otherData);
      const combined = config({ CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry, CODEX_EXECUTOR_PWSH: settings.pwsh, CODEX_EXECUTOR_PROJECTS: JSON.stringify([{ project, data }, { project: otherProject, data: otherData }]) });
      const { ProjectRouter } = require('../src/router.cjs'), router = new ProjectRouter(combined);
      const slow = await router.run({ prompt: 'SLOW_FIXTURE', cwd: project, topic: '项目A独立任务' });
      const fast = await router.run({ wait: true, prompt: '中文参数', cwd: otherProject, topic: '项目B独立任务', model: 'terra' });
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
      fs.mkdirSync(broker.lock);
      broker.unlock('ffffffffffffffffffffffff');
      assert.equal(fs.statSync(broker.lock).isDirectory(), true);
      const id = 'eeeeeeeeeeeeeeeeeeeeeeee';
      fs.writeFileSync(path.join(broker.lock, `${id}.json`), '{}');
      broker.unlock(id);
      assert.equal(fs.existsSync(broker.lock), false);
    });
    await t.test('cancellation kills only the owned child and releases the lock', async () => {
      const slow = broker.start({ prompt: 'SLOW_FIXTURE' });
      await sleep(2000);
      const restarted = new Broker(settings);
      assert.equal(restarted.status(slow.job_id).status, 'running');
      assert.equal(restarted.cancel(slow.job_id).status, 'cancel_requested');
      const result = await finished(restarted, slow.job_id);
      assert.equal(result.status, 'cancelled'); assert.equal(fs.existsSync(broker.lock), false);
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
    await t.test('one real MCP execution response, no progress model turns, concurrent ping remains responsive', async () => {
      const child = spawn(process.execPath, [path.join(__dirname, '../src/server.cjs')], { windowsHide: true, env: { ...process.env, CODEX_EXECUTOR_PROJECT: project, CODEX_EXECUTOR_DATA: data, CODEX_EXECUTOR_ENTRY: entry }, stdio: ['pipe', 'pipe', 'pipe'] });
      const pending = new Map(), replies = []; let seq = 0;
      readline.createInterface({ input: child.stdout }).on('line', line => {
        const reply = JSON.parse(line); replies.push(reply);
        const resolve = pending.get(reply.id); if (resolve) { pending.delete(reply.id); resolve(reply); }
      });
      const call = (method, params = {}) => new Promise(resolve => {
        const id = seq++; pending.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
      await call('initialize', { protocolVersion: '2024-11-05' });
      const running = call('tools/call', { name: 'codex_run', arguments: { wait: true, prompt: '中文参数', conversation_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' } });
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
