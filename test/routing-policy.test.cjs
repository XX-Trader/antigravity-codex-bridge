'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  normalizeMode,
  defaultPolicy,
  loadRoutingPolicy,
  saveRoutingPolicy,
  resolveProjectPolicy,
  evaluateCodexPacing,
  scanAgyTranscriptUsage,
  runExternalAgyProbe,
  decideRoute,
  evaluateSubagentCall,
  isAgyQuotaError
} = require('../src/routing-policy.cjs');
const { bindOrigin, contextHook, hookMatcher, ProjectRouter } = require('../src/router.cjs');
const { Broker, dispatch, save } = require('../src/server.cjs');
const { run: runModeCli } = require('../scripts/mode.cjs');

function fixture(t) {
  const base = fs.realpathSync(process.env.CODEX_EXECUTOR_TEST_ROOT);
  const root = fs.mkdtempSync(path.join(base, 'routing-'));
  const project = path.join(root, 'proj-general');
  const quantProject = path.join(root, 'proj-quant');
  const data = path.join(root, 'runtime', 'general');
  const quantData = path.join(root, 'runtime', 'quant');
  for (const dir of [project, quantProject, data, quantData]) fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { root, project, quantProject, data, quantData, policyPath: path.join(root, 'runtime', 'routing-policy.json') };
}

test('mode normalization accepts auto/hybrid/balanced, agy/AGY/Agy/antigravity and codex', () => {
  for (const v of [undefined, '', 'auto', 'AUTO', 'hybrid', 'balanced']) assert.equal(normalizeMode(v), 'auto');
  for (const v of ['agy', 'AGY', 'Agy', 'antigravity', '  AGY  ']) assert.equal(normalizeMode(v), 'agy');
  assert.equal(normalizeMode('codex'), 'codex');
  assert.equal(normalizeMode('CODEX'), 'codex');
  assert.throws(() => normalizeMode('unknown'), /Unsupported execution mode/);
});

test('Codex 7-day proportional pacing classifies all five bands accurately without faking missing data', () => {
  const now = Date.parse('2026-11-25T07:00:00Z');
  const windowMins = 10080; // 7 days
  const makeReply = (usedPercent, hoursRemaining, extra = {}) => ({
    ordinaryUsageAllowed: extra.ordinaryUsageAllowed ?? true,
    rateLimits: {
      planType: 'pro',
      primary: { usedPercent, windowDurationMins: windowMins, resetsAt: Math.floor((now + hoursRemaining * 3600000) / 1000) },
      credits: { hasCredits: true, unlimited: false, balance: '100' },
      spendControlReached: extra.spendControlReached ?? false,
      rateLimitReachedType: extra.rateLimitReachedType ?? null
    },
    rateLimitResetCredits: { availableCount: 1, credits: [{ expiresAt: Math.floor((now + 10 * 86400000) / 1000) }] }
  });

  // Halfway through 7d window (84h remaining => elapsed 50%)
  const behind = evaluateCodexPacing(makeReply(35, 84), undefined, now);
  assert.equal(behind.available, true);
  assert.equal(behind.elapsed_percent, 50);
  assert.equal(behind.pacing_delta, -15);
  assert.equal(behind.band, 'codex_priority');

  const onPace = evaluateCodexPacing(makeReply(52, 84), undefined, now);
  assert.equal(onPace.band, 'balanced');

  const ahead = evaluateCodexPacing(makeReply(87, 84), undefined, now);
  assert.equal(ahead.pacing_delta, 37);
  assert.equal(ahead.band, 'agy_priority');

  const nearCap = evaluateCodexPacing(makeReply(97, 84), undefined, now);
  assert.equal(nearCap.band, 'codex_protected');

  const hardLimited = evaluateCodexPacing(makeReply(60, 84, { ordinaryUsageAllowed: false }), undefined, now);
  assert.equal(hardLimited.band, 'codex_protected');
  assert.equal(hardLimited.hard_limited, true);

  // End-of-window drain: 6h left, 25% remaining => push to Codex to utilize 100%
  const drain = evaluateCodexPacing(makeReply(75, 6), undefined, now);
  assert.equal(drain.band, 'codex_drain');

  // Missing primary window never invents 0% or 100%
  assert.equal(evaluateCodexPacing({}, undefined, now).available, false);
});

test('local AGY transcript scanner aggregates 5h/7d token usage and separates 429 quota errors from 401/403 auth errors', t => {
  const f = fixture(t);
  const brainDir = path.join(f.root, 'brain');
  const logDir = path.join(brainDir, 'conv-1', '.system_generated', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const now = Date.parse('2026-11-25T10:00:00Z');
  const rows = [
    { created_at: new Date(now - 2 * 3600000).toISOString(), model: 'gemini-flash', input_tokens: 1000, cache_read_tokens: 400, output_tokens: 200 },
    { created_at: new Date(now - 30 * 3600000).toISOString(), model: 'gemini-pro', input_tokens: 5000, cache_read_tokens: 0, output_tokens: 800 },
    { created_at: new Date(now - 5 * 60000).toISOString(), model: 'gemini-flash', error: '401 Unauthenticated invalid api key' },
    { created_at: new Date(now - 20 * 60000).toISOString(), model: 'gemini-flash', error: 'HTTP 429 RESOURCE_EXHAUSTED quota exceeded' }
  ];
  fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  assert.equal(isAgyQuotaError('401 Unauthenticated invalid api key'), false);
  assert.equal(isAgyQuotaError('403 PERMISSION_DENIED blocked by policy'), false);
  assert.equal(isAgyQuotaError('HTTP 429 RESOURCE_EXHAUSTED quota exceeded'), true);

  const scanned = scanAgyTranscriptUsage({ brainDir, nowMs: now });
  assert.equal(scanned.available, true);
  assert.equal(scanned.window_5h.total_tokens, 1200);
  assert.equal(scanned.window_7d.total_tokens, 7000);
  assert.equal(scanned.quota_errors_5h, 1);
  assert.equal(scanned.auto_degraded, false, '20-minute-old 429 is outside the 15-minute auto-degrade window');

  fs.appendFileSync(path.join(logDir, 'transcript.jsonl'), JSON.stringify({ created_at: new Date(now - 3 * 60000).toISOString(), error: '429 Too Many Requests rate limit' }) + '\n', 'utf8');
  const degraded = scanAgyTranscriptUsage({ brainDir, nowMs: now });
  assert.equal(degraded.quota_errors_5h, 2);
  assert.equal(degraded.auto_degraded, true);
});

test('decision engine prioritizes Codex below pace, routes AGY when ahead, falls back to Codex when AGY is constrained, and surfaces quant thinking model', () => {
  const now = Date.parse('2026-11-25T10:00:00Z');
  const basePolicy = { ...defaultPolicy(), thinking_models: { general: null, quant: 'strong-quant-model' } };
  const quantScope = { project: 'P:/quant', review_category: 'quant' };
  const quantPolicy = resolveProjectPolicy(basePolicy, quantScope);

  // Behind 7d pace => Codex first
  const r1 = decideRoute({
    policy: basePolicy, projectPolicy: quantPolicy, projectScope: quantScope,
    codexPacing: { available: true, band: 'codex_priority', elapsed_percent: 50, used_percent: 30, pacing_delta: -20, hours_until_reset: 84 },
    agyUsage: { available: true, window_5h: { total_tokens: 100 }, quota_errors_5h: 0, auto_degraded: false },
    modelName: 'gemini-flash', nowMs: now
  });
  assert.equal(r1.preferred_engine, 'codex');
  assert.equal(r1.fallback_engine, 'codex');
  assert.equal(r1.thinking_guidance.required_thinking_model, 'strong-quant-model');
  assert.equal(r1.thinking_guidance.matches_required, false);
  assert.match(r1.thinking_guidance.reminder, /strong-quant-model/);

  // Ahead of 7d pace => AGY low-cost subagents, Codex fallback
  const r2 = decideRoute({
    policy: basePolicy, projectPolicy: quantPolicy, projectScope: quantScope,
    codexPacing: { available: true, band: 'agy_priority', elapsed_percent: 50, used_percent: 87, pacing_delta: 37, hours_until_reset: 84 },
    agyUsage: { available: true, window_5h: { total_tokens: 100 }, quota_errors_5h: 0, auto_degraded: false },
    modelName: 'strong-quant-model (XHigh)', nowMs: now
  });
  assert.equal(r2.preferred_engine, 'agy');
  assert.equal(r2.fallback_engine, 'codex');
  assert.equal(r2.thinking_guidance.matches_required, true);

  // Ahead of pace BUT AGY recently hit 429 => Codex fallback takes over immediately
  const r3 = decideRoute({
    policy: basePolicy, projectPolicy: quantPolicy, projectScope: quantScope,
    codexPacing: { available: true, band: 'agy_priority', elapsed_percent: 50, used_percent: 87, pacing_delta: 37, hours_until_reset: 84, hard_limited: false },
    agyUsage: { available: true, window_5h: { total_tokens: 100 }, quota_errors_5h: 2, auto_degraded: true },
    nowMs: now
  });
  assert.equal(r3.preferred_engine, 'codex');
  assert.equal(r3.reason, 'agy_recent_quota_error_codex_fallback');
});

test('subagent low-cost routing overwrites default/unspecified calls while preserving quant strategy thinking', () => {
  const generalPolicy = resolveProjectPolicy(defaultPolicy(), { project: 'P:/gen', review_category: 'general' });
  const quantPolicy = resolveProjectPolicy(defaultPolicy(), { project: 'P:/quant', review_category: 'quant' });

  assert.deepEqual(evaluateSubagentCall({ TypeName: 'research', Role: 'Code Search', Prompt: 'find files' }, generalPolicy).overwrite, { Model: 'flash_lite' });
  assert.deepEqual(evaluateSubagentCall({ TypeName: 'self', Role: 'Implement Fix', Prompt: 'fix bug' }, generalPolicy).overwrite, { Model: 'flash' });
  assert.deepEqual(evaluateSubagentCall({ TypeName: 'self', Model: 'inherit', Role: 'Implement Fix', Prompt: 'fix bug' }, generalPolicy).overwrite, { Model: 'flash' });
  assert.equal(evaluateSubagentCall({ TypeName: 'self', Model: 'pro', Role: 'Complex Debug', Prompt: 'deep debug' }, generalPolicy).overwrite, null);
  assert.deepEqual(evaluateSubagentCall({ TypeName: 'browser', Role: 'Inspect UI', Prompt: 'open page' }, generalPolicy).overwrite, { Model: 'flash' });

  // Quant core strategy thinking keeps inherit without downgrade, while mechanical quant tasks still use low-cost
  assert.equal(evaluateSubagentCall({ TypeName: 'self', Model: 'inherit', Role: '量化策略研究架构师', Prompt: '设计新的多因子量化策略与归因分析' }, quantPolicy).overwrite, null);
  assert.deepEqual(evaluateSubagentCall({ TypeName: 'self', Model: 'inherit', Role: '日志核查', Prompt: '检查量化脚本运行日志' }, quantPolicy).overwrite, { Model: 'flash' });
});

test('PreToolUse hook enforces codex lock, enables AGY low-cost overwrite + conflict warning in auto mode, and binds codex_quota', t => {
  const f = fixture(t);
  const projects = [
    { project: f.project, data: f.data, review_category: 'general' },
    { project: f.quantProject, data: f.quantData, review_category: 'quant' }
  ];
  assert.ok(new RegExp(hookMatcher).test('codex_quota'));
  assert.ok(new RegExp(hookMatcher).test('run_workflow'));

  // Default auto mode allows AGY tools and overwrites missing subagent Model to low-cost flash / flash_lite
  const sub = bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Coder', Prompt: 'edit file' } } }, projects, { policyPath: f.policyPath });
  assert.equal(sub.decision, 'allow');
  assert.deepEqual(sub.overwrite, { Model: 'flash' });

  // Active Codex task adds a conflict warning on non-isolated AGY writes
  fs.mkdirSync(path.join(f.data, 'active-tasks'), { recursive: true });
  const jobId = '111111111111111111111111';
  fs.mkdirSync(path.join(f.data, 'jobs', jobId), { recursive: true });
  save(path.join(f.data, 'jobs', jobId, 'job.json'), { job_id: jobId, status: 'running', topic: '活跃测试', worker_pid: process.pid, created_at: new Date().toISOString() });
  save(path.join(f.data, 'active-tasks', `${jobId}.json`), { job_id: jobId, worker_pid: process.pid });
  const warned = bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Coder', Prompt: 'edit' } } }, projects, { policyPath: f.policyPath });
  assert.equal(warned.decision, 'allow');
  assert.match(warned.reason, /活跃 Codex 任务/);
  assert.match(warned.reason, /Workspace="share"/);

  // Locking one project to codex denies AGY only in that project while keeping the other in auto
  saveRoutingPolicy(f.policyPath, { ...defaultPolicy(), projects: { [f.project]: { mode: 'codex' } } });
  assert.equal(bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'invoke_subagent', args: {} } }, projects, { policyPath: f.policyPath }).decision, 'deny');
  assert.equal(bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'run_workflow', args: {} } }, projects, { policyPath: f.policyPath }).decision, 'deny');
  assert.equal(bindOrigin({ workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Scan', Prompt: 'read' } } }, projects, { policyPath: f.policyPath }).overwrite.Model, 'flash_lite');

  // codex_quota binds cwd for single workspace and rejects foreign cwd
  const quotaAllowed = bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'codex_quota', args: {} } }, projects, { policyPath: f.policyPath });
  assert.equal(quotaAllowed.decision, 'allow');
  assert.equal(quotaAllowed.overwrite.cwd, fs.realpathSync(f.project));
  assert.equal(bindOrigin({ workspacePaths: [f.project], toolCall: { name: 'codex_quota', args: { cwd: f.quantProject } } }, projects, { policyPath: f.policyPath }).decision, 'deny');
});

test('contextHook injects routing summary once per unchanged PreInvocation and stays silent outside registered projects', t => {
  const f = fixture(t);
  const projects = [{ project: f.quantProject, data: f.quantData, review_category: 'quant' }];
  saveRoutingPolicy(f.policyPath, { ...defaultPolicy(), thinking_models: { general: null, quant: 'quant-strongest' } });
  const brainDir = path.join(f.root, 'empty-brain');
  fs.mkdirSync(brainDir, { recursive: true });
  const markerFile = path.join(f.root, 'runtime', 'context-hook-state.json');

  assert.deepEqual(contextHook({ hookEventName: 'SessionStart', workspacePaths: [f.project] }, projects, { policyPath: f.policyPath, brainDir, markerFile }), {});

  const first = contextHook({ hookEventName: 'PreInvocation', conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.quantProject], modelName: 'gemini-flash' }, projects, { policyPath: f.policyPath, brainDir, markerFile });
  assert.equal(first.injectSteps.length, 1);
  assert.match(first.injectSteps[0].systemMessage.systemMessage, /双引擎路由状态/);
  assert.match(first.injectSteps[0].systemMessage.systemMessage, /quant-strongest/);

  // Unchanged state on subsequent PreInvocation injects nothing (zero context bloat)
  const second = contextHook({ hookEventName: 'PreInvocation', conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.quantProject], modelName: 'gemini-flash' }, projects, { policyPath: f.policyPath, brainDir, markerFile });
  assert.deepEqual(second, {});

  // Changing policy updates updated_at and triggers a fresh injection
  saveRoutingPolicy(f.policyPath, { ...loadRoutingPolicy(f.policyPath), default_mode: 'agy' });
  const third = contextHook({ hookEventName: 'PreInvocation', conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.quantProject], modelName: 'gemini-flash' }, projects, { policyPath: f.policyPath, brainDir, markerFile });
  assert.equal(third.injectSteps.length, 1);
  assert.match(third.injectSteps[0].systemMessage.systemMessage, /模式=agy/);
});

test('Broker/ProjectRouter codex_quota MCP tool and external AGY probe contract work end to end', async t => {
  const f = fixture(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const probeScript = path.join(f.root, 'probe.cjs');
  fs.writeFileSync(probeScript, 'console.log(JSON.stringify({ remaining_percent: 12, reset_at: "2026-11-25T12:00:00Z", source: "fixture-probe" }));\n', 'utf8');
  saveRoutingPolicy(f.policyPath, { ...defaultPolicy(), agy_quota_command: [process.execPath, probeScript] });

  const probe = runExternalAgyProbe([process.execPath, probeScript]);
  assert.equal(probe.available, true);
  assert.equal(probe.remaining_percent, 12);
  assert.equal(runExternalAgyProbe([process.execPath, '-e', 'console.log("{}")']).available, false);

  let metadataCalls = 0;
  const mockMetadata = async (_settings, method) => {
    metadataCalls += 1;
    assert.equal(method, 'account/rateLimits/read');
    return {
      ordinaryUsageAllowed: true,
      rateLimits: { planType: 'pro', primary: { usedPercent: 85, windowDurationMins: 10080, resetsAt: nowSec + 84 * 3600 } }
    };
  };
  const broker = new Broker({ project: f.project, data: f.data, routing_config_file: f.policyPath }, mockMetadata);
  const reply1 = await dispatch(broker, { method: 'tools/call', params: { name: 'codex_quota', arguments: { refresh: true } } });
  assert.equal(reply1.isError, false);
  const body1 = JSON.parse(reply1.content[0].text);
  assert.equal(metadataCalls, 1);
  assert.equal(body1.codex_pacing.used_percent, 85);
  assert.equal(body1.agy_external.remaining_percent, 12);
  assert.equal(body1.preferred_engine, 'codex', 'Low external AGY probe triggers Codex fallback');
  assert.equal(body1.reason, 'agy_probe_low_codex_fallback');

  // Second call without refresh hits 60s local cache
  const reply2 = await dispatch(broker, { method: 'tools/call', params: { name: 'codex_quota', arguments: {} } });
  assert.equal(metadataCalls, 1);
  assert.equal(JSON.parse(reply2.content[0].text).cached, true);

  // ProjectRouter exposes multi-project summary
  const router = new ProjectRouter({
    project: f.project,
    projects: [
      { project: f.project, data: f.data, routing_config_file: f.policyPath, review_category: 'general' },
      { project: f.quantProject, data: f.quantData, routing_config_file: f.policyPath, review_category: 'quant' }
    ]
  });
  router.brokers.forEach(b => { b.metadataCall = mockMetadata; });
  const multi = await router.quota({ cwd: f.quantProject });
  assert.equal(multi.projects.length, 2);
});

test('Mode CLI switches global/project modes with AGY aliases, quant thinking model, hints and cooldowns', async t => {
  const f = fixture(t);
  const out1 = JSON.parse(await runModeCli(['set', '--mode', 'AGY', '--policy', f.policyPath]));
  assert.equal(out1.default_mode, 'agy');
  const out2 = JSON.parse(await runModeCli(['set', '--mode', 'codex', '--project', f.project, '--policy', f.policyPath]));
  assert.equal(out2.projects[fs.realpathSync(f.project)].mode, 'codex');
  const out3 = JSON.parse(await runModeCli(['quant-thinking', '--model', 'custom-strong-model', '--policy', f.policyPath]));
  assert.equal(out3.thinking_models.quant, 'custom-strong-model');
  const out4 = JSON.parse(await runModeCli(['agy-hint', '--level', 'low', '--policy', f.policyPath]));
  assert.equal(out4.agy_quota_hint, 'low');
  const out5 = JSON.parse(await runModeCli(['cooldown', '--engine', 'AGY', '--minutes', '30', '--reason', '5h limit', '--policy', f.policyPath]));
  assert.ok(out5.cooldowns.agy.until);
  const out6 = JSON.parse(await runModeCli(['clear-cooldown', '--engine', 'agy', '--policy', f.policyPath]));
  assert.equal(out6.cooldowns.agy, null);
  const out7 = JSON.parse(await runModeCli(['reset-project', '--project', f.project, '--policy', f.policyPath]));
  assert.deepEqual(out7.projects, {});
});
