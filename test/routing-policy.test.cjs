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
  evaluateAgyPacing,
  scanAgyTranscriptUsage,
  runExternalAgyProbe,
  decideRoute,
  evaluateSubagentCall,
  isAgyQuotaError
} = require('../src/routing-policy.cjs');
const { bindOrigin, contextHook, postToolHook, hookMatcher, ProjectRouter } = require('../src/router.cjs');
const { Broker, dispatch, save } = require('../src/server.cjs');
const { run: runModeCli } = require('../scripts/mode.cjs');
const { loadGuardState, readGuardQuotaCooldown } = require('../src/agy-guard.cjs');

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const EPOCH_ZERO_ISO = new Date(0).toISOString(); // Upstream sentinel for unactivated window
const anchorNowMs = () => Math.floor(Date.now() / 1000) * 1000;
const relIso = (baseMs, offsetMs = 0) => new Date(baseMs + offsetMs).toISOString();
const relSec = (baseMs, offsetMs = 0) => Math.floor((baseMs + offsetMs) / 1000);

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

test('Codex 5-day proportional pacing (over 7-day API window) classifies all five bands accurately without faking missing data', () => {
  const now = anchorNowMs();
  const windowMins = 10080; // 7 days = 168h API reset window; default plan_days = 5 days (120h)
  const makeReply = (usedPercent, hoursRemaining, extra = {}) => ({
    ordinaryUsageAllowed: extra.ordinaryUsageAllowed ?? true,
    rateLimits: {
      planType: 'pro',
      primary: { usedPercent, windowDurationMins: windowMins, resetsAt: relSec(now, hoursRemaining * HOUR_MS) },
      credits: { hasCredits: true, unlimited: false, balance: '100' },
      spendControlReached: extra.spendControlReached ?? false,
      rateLimitReachedType: extra.rateLimitReachedType ?? null
    },
    rateLimitResetCredits: { availableCount: 1, credits: [{ expiresAt: relSec(now, 10 * DAY_MS) }] }
  });

  // 108h remaining of 168h => elapsed 60h => 50% of the 5-day (120h) plan window
  const behind = evaluateCodexPacing(makeReply(35, 108), undefined, now);
  assert.equal(behind.available, true);
  assert.equal(behind.plan_days, 5);
  assert.equal(behind.elapsed_percent, 50);
  assert.equal(behind.window_elapsed_percent, 35.71);
  assert.equal(behind.pacing_delta, -15);
  assert.equal(behind.band, 'codex_priority');

  const onPace = evaluateCodexPacing(makeReply(52, 108), undefined, now);
  assert.equal(onPace.band, 'balanced');

  const ahead = evaluateCodexPacing(makeReply(87, 108), undefined, now);
  assert.equal(ahead.pacing_delta, 37);
  assert.equal(ahead.band, 'agy_priority');

  // After day 5 (e.g. 36h remaining => elapsed 132h >= 120h => 5-day target is 100%): 85% used => behind pace => prioritize Codex to finish remaining quota
  const postDay5 = evaluateCodexPacing(makeReply(85, 36), undefined, now);
  assert.equal(postDay5.elapsed_percent, 100);
  assert.equal(postDay5.pacing_delta, -15);
  assert.equal(postDay5.band, 'codex_priority');

  // Explicit 7-day override still works when configured
  const sevenDay = evaluateCodexPacing(makeReply(50, 84), { plan_days: 7 }, now);
  assert.equal(sevenDay.plan_days, 7);
  assert.equal(sevenDay.elapsed_percent, 50);
  assert.equal(sevenDay.pacing_delta, 0);

  const nearCap = evaluateCodexPacing(makeReply(97, 108), undefined, now);
  assert.equal(nearCap.band, 'codex_protected');

  const hardLimited = evaluateCodexPacing(makeReply(60, 108, { ordinaryUsageAllowed: false }), undefined, now);
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
  const now = anchorNowMs();
  const rows = [
    { created_at: relIso(now, -2 * HOUR_MS), model: 'gemini-flash', input_tokens: 1000, cache_read_tokens: 400, output_tokens: 200 },
    { created_at: relIso(now, -30 * HOUR_MS), model: 'gemini-pro', input_tokens: 5000, cache_read_tokens: 0, output_tokens: 800 },
    { created_at: relIso(now, -5 * MINUTE_MS), model: 'gemini-flash', error: '401 Unauthenticated invalid api key' },
    { created_at: relIso(now, -20 * MINUTE_MS), model: 'gemini-flash', error: 'HTTP 429 RESOURCE_EXHAUSTED quota exceeded' }
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
  const now = anchorNowMs();
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
  const futureResetIso = new Date((nowSec + 2 * 3600) * 1000).toISOString();
  const probeScript = path.join(f.root, 'probe.cjs');
  fs.writeFileSync(probeScript, `console.log(JSON.stringify({ remaining_percent: 12, reset_at: ${JSON.stringify(futureResetIso)}, source: "fixture-probe" }));\n`, 'utf8');
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
  assert.equal(body1.reason, 'agy_5h_limited_codex_fallback');
  assert.equal(body1.agy_5h_limited, true);

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
  const cliNow = anchorNowMs();
  const out8 = JSON.parse(await runModeCli(['agy-quota', '--weekly-used', '32', '--weekly-reset', relIso(cliNow, 72 * HOUR_MS), '--5h-used', '45', '--5h-reset', relIso(cliNow, 3 * HOUR_MS), '--policy', f.policyPath]));
  assert.equal(out8.agy_manual_snapshot.weekly_used_percent, 32);
  assert.equal(out8.agy_manual_snapshot.five_hour_used_percent, 45);
  const out9 = JSON.parse(await runModeCli(['agy-budget', '--tokens-5h', '10000000', '--tokens-7d', '100000000', '--target', '90', '--weekly-protect', '90', '--5h-caution', '70', '--5h-protect', '85', '--policy', f.policyPath]));
  assert.equal(out9.agy_pacing.window_5h_tokens, 10000000);
  assert.equal(out9.agy_pacing.window_7d_tokens, 100000000);
  assert.equal(out9.agy_pacing.target_utilization, 90);
  assert.equal(out9.agy_pacing.weekly_protect_used_percent, 90);
  assert.equal(out9.agy_pacing.window_5h_caution_percent, 70);
  assert.equal(out9.agy_pacing.window_5h_protect_percent, 85);
  const out10 = JSON.parse(await runModeCli(['codex-pacing', '--days', '5', '--target', '100', '--policy', f.policyPath]));
  assert.equal(out10.pacing.plan_days, 5);
  assert.equal(out10.pacing.target_utilization, 100);
  const out11 = JSON.parse(await runModeCli(['agy-models', '--standard', 'fast-exec-model', '--complex', 'complex-model', '--expert', 'expert-model', '--policy', f.policyPath]));
  assert.deepEqual(out11.agy_host_models, { standard: 'fast-exec-model', complex: 'complex-model', expert: 'expert-model' });
  const ctx = contextHook({ hookEventName: 'SessionStart', conversationId: 'conv-agy-models', workspacePaths: [f.project] }, [{ project: f.project, data: f.data, review_category: 'general' }], { policyPath: f.policyPath, markerFile: path.join(f.root, 'm2.json') });
  const msg = ctx.injectSteps[0].systemMessage.systemMessage;
  assert.match(msg, /send_message/);
  assert.match(msg, /standard\(常规\)→fast-exec-model/);
  const out12 = JSON.parse(await runModeCli(['agy-models', '--clear', '--policy', f.policyPath]));
  assert.deepEqual(out12.agy_host_models, { standard: null, complex: null, expert: null });

  // Independent model pool linear 7-day 90% pacing + hard stop (reserve 10%) + failover to backup thinking chain
  const resetLinear = new Date(Date.now() + 84 * 3600000).toISOString(); // 50% elapsed => 45% linear target of 90% cap
  await runModeCli(['pool', '--name', 'family-x', '--match', 'famx', '--weekly-protect', '90', '--5h-protect', '88', '--weekly-used', '60', '--weekly-reset', resetLinear, '--policy', f.policyPath]);
  const ctxAhead = contextHook(
    { hookEventName: 'SessionStart', conversationId: 'conv-pool-ahead', modelName: 'famx-top-high', workspacePaths: [f.quantProject] },
    [{ project: f.quantProject, data: f.quantData, review_category: 'quant' }],
    { policyPath: f.policyPath, markerFile: path.join(f.root, 'm3a.json') }
  );
  assert.match(ctxAhead.injectSteps[0].systemMessage.systemMessage, /7天线性目标 45% \/ 已用 60%（偏差 \+15%）/);
  assert.match(ctxAhead.injectSteps[0].systemMessage.systemMessage, /状态=超前建议控速/);

  const outPool = JSON.parse(await runModeCli(['pool', '--name', 'family-x', '--match', 'famx', '--weekly-protect', '90', '--5h-protect', '88', '--weekly-used', '90', '--weekly-reset', resetLinear, '--policy', f.policyPath]));
  assert.equal(outPool.pool.weekly_protect_used_percent, 90);
  assert.equal(outPool.pool.manual_snapshot.weekly_used_percent, 90);
  await runModeCli(['quant-thinking', '--model', 'famx-top', '--general', 'famx-mid', '--backups', 'backup-1,backup-last', '--policy', f.policyPath]);
  const ctxPool = contextHook(
    { hookEventName: 'SessionStart', conversationId: 'conv-pool-stop', modelName: 'famx-top-high', workspacePaths: [f.quantProject] },
    [{ project: f.quantProject, data: f.quantData, review_category: 'quant' }],
    { policyPath: f.policyPath, markerFile: path.join(f.root, 'm3.json') }
  );
  const poolMsg = ctxPool.injectSteps[0].systemMessage.systemMessage;
  assert.match(poolMsg, /\[模型池硬停告警\]/);
  assert.match(poolMsg, /backup-1/);
  assert.match(poolMsg, /backup-1 → backup-last/);
  const outPoolCleared = JSON.parse(await runModeCli(['pool', '--name', 'family-x', '--remove', '--policy', f.policyPath]));
  assert.equal(outPoolCleared.removed, 'family-x');

  // Rollout log fallback + stale cache preservation + HTTP 503 exclusion + high-water Codex concurrency throttle
  const { readLatestCodexRolloutRateLimits, isAgyQuotaError } = require('../src/routing-policy.cjs');
  assert.equal(isAgyQuotaError('HTTP 503: No capacity available for model x on the server'), false);
  assert.equal(isAgyQuotaError('HTTP 429 RESOURCE_EXHAUSTED: quota exceeded'), true);

  const utcNow = new Date();
  const sessDir = path.join(
    f.root,
    'codex-sessions',
    String(utcNow.getUTCFullYear()),
    String(utcNow.getUTCMonth() + 1).padStart(2, '0'),
    String(utcNow.getUTCDate()).padStart(2, '0')
  );
  fs.mkdirSync(sessDir, { recursive: true });
  const futureResetSec = Math.floor((Date.now() + 72 * HOUR_MS) / 1000);
  fs.writeFileSync(path.join(sessDir, 'rollout-test.jsonl'), JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: 98, window_minutes: 10080, resets_at: futureResetSec } } }
  }) + '\n', 'utf8');
  const roll = readLatestCodexRolloutRateLimits({ codexSessionsDir: path.join(f.root, 'codex-sessions') });
  assert.equal(roll.rateLimits.primary.used_percent, 98);

  // Broker.quota falls back to rollout log when app-server times out, and never overwrites good cache with unavailable
  const brokerTimeout = new Broker({ project: f.project, data: f.data, routing_config_file: f.policyPath, codex_sessions_dir: path.join(f.root, 'codex-sessions') });
  brokerTimeout.metadataCall = async () => { throw new Error('Local Codex session metadata request timed out'); };
  const qFallback = await brokerTimeout.quota({ refresh: true });
  assert.equal(qFallback.codex_pacing.available, true);
  assert.equal(qFallback.codex_pacing.used_percent, 98);
  assert.equal(qFallback.codex_pacing.source, 'codex_rollout_log');
  assert.equal(qFallback.preferred_engine, 'agy');

  // While agy_quota_hint is 'low' (from earlier in test), AGY is constrained so Codex still acts as fallback even at 98%
  await runModeCli(['set', '--mode', 'auto', '--policy', f.policyPath]);
  const fallbackAllowed = bindOrigin(
    { conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.project], toolCall: { name: 'codex_run', args: { prompt: 'AGY受限时的兜底任务' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, codexSessionsDir: path.join(f.root, 'codex-sessions') }
  );
  assert.equal(fallbackAllowed.decision, 'allow');

  // Once AGY is healthy (normal), PreToolUse throttles new general codex_run at 98% protected while allowing read-only manage_task(status) fast-path
  await runModeCli(['agy-hint', '--level', 'normal', '--policy', f.policyPath]);
  const fastStatus = bindOrigin(
    { conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.project], toolCall: { name: 'manage_task', args: { Action: 'status', TaskId: 't1' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath }
  );
  assert.equal(fastStatus.decision, 'allow');

  const blockedNew = bindOrigin(
    { conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.project], toolCall: { name: 'codex_run', args: { prompt: '普通改一个小样式' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, codexSessionsDir: path.join(f.root, 'codex-sessions') }
  );
  assert.equal(blockedNew.decision, 'deny');
  assert.match(blockedNew.reason, /CODEX_QUOTA_PROTECTED/);

  // Explicit native_luna pipeline task is still allowed when active tasks < protect_max_concurrent (1)
  const allowedLuna = bindOrigin(
    { conversationId: '11111111-1111-1111-1111-111111111111', workspacePaths: [f.project], toolCall: { name: 'codex_run', args: { prompt: '000938 native_luna_required Stage B 复核' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, codexSessionsDir: path.join(f.root, 'codex-sessions') }
  );
  assert.equal(allowedLuna.decision, 'allow');
});

test('dual 7-day 100% proportional pacing + AGY 5-hour limit guard + Codex fallback', () => {
  const now = anchorNowMs();
  const reset7d = relIso(now, 84 * HOUR_MS); // 50% elapsed of 7d window
  const reset5h = relIso(now, 3 * HOUR_MS);
  const base = defaultPolicy();
  const scope = { project: 'P:/dual', review_category: 'general' };

  // 1. Both calibrated: Codex at 80% (+30% ahead), AGY 7d at 30% (-15% behind 45% target of 90% cap), AGY 5h at 40% (ok) => prefer AGY
  const p1 = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 30, weekly_resets_at: reset7d, five_hour_used_percent: 40, five_hour_resets_at: reset5h }
  }, scope);
  const codexAhead = { available: true, band: 'agy_priority', elapsed_percent: 50, used_percent: 80, pacing_delta: 30, resets_at: reset7d, hours_until_reset: 84, hard_limited: false };
  const r1 = decideRoute({ policy: base, projectPolicy: p1, projectScope: scope, codexPacing: codexAhead, nowMs: now });
  assert.equal(r1.preferred_engine, 'agy');
  assert.equal(r1.reason, 'dual_7d_agy_further_behind_pace');
  assert.equal(r1.agy_pacing.window_7d.target_used_percent, 45);
  assert.equal(r1.agy_pacing.window_7d.pacing_delta, -15);
  assert.equal(r1.agy_pacing.window_7d.buffer_percent, 10);
  assert.equal(r1.agy_pacing.window_5h.status, 'ok');

  // 2. Same 7d deltas, but AGY 5h hits caution (80% >= 75%) => throttle down to balanced to avoid 5h wall
  const p2 = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 30, weekly_resets_at: reset7d, five_hour_used_percent: 80, five_hour_resets_at: reset5h }
  }, scope);
  const r2 = decideRoute({ policy: base, projectPolicy: p2, projectScope: scope, codexPacing: codexAhead, nowMs: now });
  assert.equal(r2.preferred_engine, 'balanced');
  assert.equal(r2.agy_5h_caution, true);
  assert.equal(r2.reason, 'dual_7d_agy_ahead_throttled_by_5h_caution');

  // 3. AGY 5h hits protect (90% >= 88%) => Codex immediately takes over as fallback even though Codex is ahead of 7d pace
  const p3 = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 30, weekly_resets_at: reset7d, five_hour_used_percent: 90, five_hour_resets_at: reset5h }
  }, scope);
  const r3 = decideRoute({ policy: base, projectPolicy: p3, projectScope: scope, codexPacing: codexAhead, nowMs: now });
  assert.equal(r3.preferred_engine, 'codex');
  assert.equal(r3.agy_5h_limited, true);
  assert.equal(r3.reason, 'agy_5h_limited_codex_fallback');

  // 4. Both calibrated: AGY 7d at 70% (+20% ahead), Codex 7d at 40% (-10% behind), AGY 5h ok => prefer Codex
  const p4 = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 70, weekly_resets_at: reset7d, five_hour_used_percent: 20, five_hour_resets_at: reset5h }
  }, scope);
  const codexBehind = { available: true, band: 'codex_priority', elapsed_percent: 50, used_percent: 40, pacing_delta: -10, resets_at: reset7d, hours_until_reset: 84, hard_limited: false };
  const r4 = decideRoute({ policy: base, projectPolicy: p4, projectScope: scope, codexPacing: codexBehind, nowMs: now });
  assert.equal(r4.preferred_engine, 'codex');
  assert.equal(r4.reason, 'dual_7d_codex_further_behind_pace');

  // 5. Parity within 5% margin => balanced
  const p5 = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 52, weekly_resets_at: reset7d, five_hour_used_percent: 30, five_hour_resets_at: reset5h }
  }, scope);
  const codexMid = { available: true, band: 'balanced', elapsed_percent: 50, used_percent: 54, pacing_delta: 4, resets_at: reset7d, hours_until_reset: 84, hard_limited: false };
  const r5 = decideRoute({ policy: base, projectPolicy: p5, projectScope: scope, codexPacing: codexMid, nowMs: now });
  assert.equal(r5.preferred_engine, 'balanced');
  assert.equal(r5.reason, 'dual_7d_on_parity_balanced');

  // 6. Expired manual snapshot is automatically ignored (never fakes stale numbers)
  const pExpired = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 10 * 3600000).toISOString(), weekly_used_percent: 99, weekly_resets_at: new Date(now - 1000).toISOString(), five_hour_used_percent: 99, five_hour_resets_at: new Date(now - 1000).toISOString() }
  }, scope);
  const apExpired = evaluateAgyPacing({ agyUsage: { available: false }, agyExternal: null, projectPolicy: pExpired, codexPacing: codexMid, nowMs: now });
  assert.equal(apExpired.window_7d.available, false);
  assert.equal(apExpired.window_5h.used_percent, null);

  // 7. Local token budget calibrates AGY 5h and 7d automatically from transcript totals
  const pBudget = resolveProjectPolicy({
    ...base,
    agy_pacing: { ...base.agy_pacing, window_5h_tokens: 10000000, window_7d_tokens: 100000000, weekly_resets_at: reset7d }
  }, scope);
  const apBudget = evaluateAgyPacing({
    agyUsage: { available: true, window_5h: { total_tokens: 8900000 }, window_7d: { total_tokens: 40000000 }, quota_errors_5h: 0, auto_degraded: false },
    agyExternal: null, projectPolicy: pBudget, codexPacing: codexAhead, nowMs: now
  });
  assert.equal(apBudget.window_5h.used_percent, 89);
  assert.equal(apBudget.window_5h.status, 'limited');
  assert.equal(apBudget.window_7d.available, true);
  assert.equal(apBudget.window_7d.used_percent, 40);
  assert.equal(apBudget.window_7d.pacing_delta, -5);

  // 8. AGY 90% weekly cap reserves 10% emergency buffer and immediately falls back to Codex
  const pBufferHit = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 90, weekly_resets_at: reset7d, five_hour_used_percent: 20, five_hour_resets_at: reset5h }
  }, scope);
  const rBufferHit = decideRoute({ policy: base, projectPolicy: pBufferHit, projectScope: scope, codexPacing: codexAhead, nowMs: now });
  assert.equal(rBufferHit.agy_pacing.window_7d.band, 'agy_protected');
  assert.equal(rBufferHit.agy_pacing.window_7d.usable_remaining_percent, 0);
  assert.equal(rBufferHit.preferred_engine, 'codex');
  assert.equal(rBufferHit.reason, 'agy_7d_protected_codex_fallback');

  // 9. Last-12h drain (>6h before reset) keeps AGY's reserved 10% buffer; <=6h before reset automatically unlocks the remaining 10% buffer!
  const reset8h = new Date(now + 8 * 3600000).toISOString(); // 8h > 6h => 10% buffer still locked
  const apNoDrain = evaluateAgyPacing({
    agyUsage: { available: false }, agyExternal: null, codexPacing: codexAhead, nowMs: now,
    projectPolicy: resolveProjectPolicy({
      ...base,
      agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 85, weekly_resets_at: reset8h, five_hour_used_percent: 10, five_hour_resets_at: reset5h }
    }, scope)
  });
  assert.equal(apNoDrain.window_7d.buffer_unlocked, false);
  assert.equal(apNoDrain.window_7d.usable_remaining_percent, 5);
  assert.notEqual(apNoDrain.window_7d.band, 'agy_drain');
  const apDrain = evaluateAgyPacing({
    agyUsage: { available: false }, agyExternal: null, codexPacing: codexAhead, nowMs: now,
    projectPolicy: resolveProjectPolicy({
      ...base,
      agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 75, weekly_resets_at: reset8h, five_hour_used_percent: 10, five_hour_resets_at: reset5h }
    }, scope)
  });
  assert.equal(apDrain.window_7d.usable_remaining_percent, 15);
  assert.equal(apDrain.window_7d.band, 'agy_drain');

  // Within final 6h before weekly reset (e.g. 4h left): 93% used unlocks the remaining 10% buffer (effective cap 100%, usable = 7%)!
  const reset4h = new Date(now + 4 * 3600000).toISOString();
  const apUnlocked = evaluateAgyPacing({
    agyUsage: { available: false }, agyExternal: null, codexPacing: codexAhead, nowMs: now,
    projectPolicy: resolveProjectPolicy({
      ...base,
      agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 93, weekly_resets_at: reset4h, five_hour_used_percent: 10, five_hour_resets_at: reset5h }
    }, scope)
  });
  assert.equal(apUnlocked.window_7d.buffer_unlocked, true);
  assert.equal(apUnlocked.window_7d.protect_used_percent, 100);
  assert.equal(apUnlocked.window_7d.buffer_percent, 0);
  assert.equal(apUnlocked.window_7d.usable_remaining_percent, 7);
  assert.equal(apUnlocked.window_7d.band, 'agy_drain');
  assert.equal(apUnlocked.limited, false);
});

test('AGY smart loop guard allows distinct errors to self-heal, trips only on 3 identical repeats or 8 no-progress cap, and resets on success or human turn', t => {
  const f = fixture(t);
  const projects = [{ project: f.project, data: f.data, review_category: 'general' }];
  const convId = '33333333-3333-3333-3333-333333333333';
  const guardFile = path.join(f.root, 'runtime', 'agy-guard-state.json');
  const opts = { policyPath: f.policyPath, guardStateFile: guardFile };

  // 1. Three DIFFERENT errors in different places must NOT trip the guard (keeps efficiency high)
  for (const [tool, args, error] of [
    ['run_command', { CommandLine: 'npm test' }, 'ReferenceError: foo is not defined at a.js:12'],
    ['edit_file', { Path: 'src/b.js' }, 'Target not found in src/b.js'],
    ['run_command', { CommandLine: 'npm run lint' }, 'ESLint error: unused variable bar']
  ]) {
    postToolHook({ conversationId: convId, workspacePaths: [f.project], lastUserInput: 'fix bugs', toolCall: { name: tool, args }, error }, projects, opts);
  }
  const afterDistinct = bindOrigin({ conversationId: convId, workspacePaths: [f.project], lastUserInput: 'fix bugs', toolCall: { name: 'edit_file', args: { Path: 'src/c.js' } } }, projects, opts);
  assert.equal(afterDistinct.decision, 'allow', 'Distinct errors must not prematurely halt normal debugging');

  // 2. One successful tool call resets consecutive failure count completely
  postToolHook({ conversationId: convId, workspacePaths: [f.project], lastUserInput: 'fix bugs', toolCall: { name: 'edit_file', args: { Path: 'src/c.js' } } }, projects, opts);
  assert.equal(loadGuardState(guardFile).conversations[convId].consecutive_failures, 0);

  // 3. Three IDENTICAL normalized errors (even with changing timestamps/line numbers) trip the loop guard
  const errBaseMs = anchorNowMs();
  for (const line of [10, 14, 22]) {
    postToolHook({
      conversationId: convId,
      workspacePaths: [f.project],
      lastUserInput: 'fix bugs',
      toolCall: { name: 'run_command', args: { CommandLine: 'pytest tests/test_alpha.py' } },
      error: `${relIso(errBaseMs, line * 1000)} AssertionError: mismatch at test_alpha.py:${line} (120ms)`
    }, projects, opts);
  }
  const tripped = bindOrigin({ conversationId: convId, workspacePaths: [f.project], lastUserInput: 'fix bugs', toolCall: { name: 'edit_file', args: { Path: 'src/a.py' } } }, projects, opts);
  assert.equal(tripped.decision, 'deny');
  assert.match(tripped.reason, /\[AGY_LOOP_GUARD\]/);
  assert.match(tripped.reason, /同一错误已连续重复失败 3 次/);

  // Read-only research subagent remains allowed even while tripped
  const readOnly = bindOrigin({ conversationId: convId, workspacePaths: [f.project], lastUserInput: 'fix bugs', toolCall: { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Diagnose', Prompt: 'check logs' } } }, projects, opts);
  assert.equal(readOnly.decision, 'allow');

  // 4. New human input automatically unlocks the tripped guard
  const unlocked = bindOrigin({ conversationId: convId, workspacePaths: [f.project], lastUserInput: '换个方向排查并重跑', toolCall: { name: 'edit_file', args: { Path: 'src/a.py' } } }, projects, opts);
  assert.equal(unlocked.decision, 'allow');

  // 5. 429 quota error sets AGY cooldown (triggers Codex fallback) without counting as business failure; 401 auth error does neither
  postToolHook({ conversationId: convId, workspacePaths: [f.project], lastUserInput: '换个方向排查并重跑', toolCall: { name: 'invoke_subagent', args: { TypeName: 'self' } }, error: '401 Unauthenticated invalid token' }, projects, opts);
  assert.equal(loadGuardState(guardFile).conversations[convId].consecutive_failures, 0);
  assert.equal(readGuardQuotaCooldown(guardFile), null);

  postToolHook({ conversationId: convId, workspacePaths: [f.project], lastUserInput: '换个方向排查并重跑', toolCall: { name: 'invoke_subagent', args: { TypeName: 'self' } }, error: 'HTTP 429 RESOURCE_EXHAUSTED quota exceeded' }, projects, opts);
  assert.equal(loadGuardState(guardFile).conversations[convId].consecutive_failures, 0);
  assert.ok(readGuardQuotaCooldown(guardFile)?.until);

  // 6. Safety cap at 8 distinct consecutive failures with zero successes still trips no_progress_cap
  for (let i = 1; i <= 8; i++) {
    postToolHook({ conversationId: convId, workspacePaths: [f.project], lastUserInput: '大范围排查', toolCall: { name: 'run_command', args: { CommandLine: `check_${i}` } }, error: `distinct error number ${i}` }, projects, opts);
  }
  const capTripped = bindOrigin({ conversationId: convId, workspacePaths: [f.project], lastUserInput: '大范围排查', toolCall: { name: 'run_command', args: { CommandLine: 'next' } } }, projects, opts);
  assert.equal(capTripped.decision, 'deny');
  assert.match(capTripped.reason, /已连续失败 8 次且中间无成功进展/);
});

test('Hybrid review-before-AGY gate blocks writes in strict mode until Codex review_only approval exists, and CLI configures/resets guards', async t => {
  const f = fixture(t);
  const projects = [{ project: f.quantProject, data: f.quantData, review_category: 'quant' }];
  const convId = '44444444-4444-4444-4444-444444444444';
  const guardFile = path.join(f.root, 'runtime', 'agy-guard-state.json');
  const opts = { policyPath: f.policyPath, guardStateFile: guardFile };

  // Default advisory mode allows writes in quant project with a helpful reminder
  const adv = bindOrigin({ conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'edit_file', args: { Path: 'strategy.py' } } }, projects, opts);
  assert.equal(adv.decision, 'allow');
  assert.match(adv.reason, /review_only=true/);

  // Switch this project to strict via Mode CLI
  const gateOut = JSON.parse(await runModeCli(['agy-review-gate', '--level', 'strict', '--project', f.quantProject, '--max-same', '3', '--max-total', '8', '--policy', f.policyPath]));
  assert.equal(gateOut.projects[fs.realpathSync(f.quantProject)].agy_review_gate, 'strict');

  // Without approved Codex review, AGY write & execution subagent are denied while read-only research stays allowed
  const deniedWrite = bindOrigin({ conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'edit_file', args: { Path: 'strategy.py' } } }, projects, opts);
  assert.equal(deniedWrite.decision, 'deny');
  assert.match(deniedWrite.reason, /\[AGY_REVIEW_REQUIRED\]/);
  const allowedResearch = bindOrigin({ conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Inspect', Prompt: 'read code' } } }, projects, opts);
  assert.equal(allowedResearch.decision, 'allow');

  // Seed a recent approved Codex review_only receipt in this project => AGY execution immediately unlocks
  const reviewJobId = '222222222222222222222222';
  fs.mkdirSync(path.join(f.quantData, 'jobs', reviewJobId), { recursive: true });
  save(path.join(f.quantData, 'jobs', reviewJobId, 'job.json'), {
    job_id: reviewJobId,
    conversation_id: convId,
    review_only: true,
    stage: 'review_complete',
    status: 'completed',
    created_at: new Date().toISOString(),
    plan_review: { status: 'approved', reviewed_at: new Date().toISOString(), allowed_scope: ['只修改 strategy.py'], reason: '审核通过' }
  });
  const allowedAfterReview = bindOrigin({ conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Implement', Prompt: '按审核实施' } } }, projects, opts);
  assert.equal(allowedAfterReview.decision, 'allow');
  assert.equal(allowedAfterReview.overwrite.Model, 'flash');
  assert.match(allowedAfterReview.reason, /已关联 Codex 只读审核\(22222222\)/);

  // reset-agy-guard CLI clears saved guard state cleanly
  const resetOut = JSON.parse(await runModeCli(['reset-agy-guard', '--policy', f.policyPath]));
  assert.equal(resetOut.state, 'reset');
});

test('official agy /usage 5-bucket JSON parser, incremental transcript index, cross-window shared cache reuse, and Sidecar background sync', async t => {
  const f = fixture(t);
  const {
    parseAgyProbePayload,
    defaultQuotaCachePath,
    defaultTranscriptIndexPath,
    takeQuotaRefreshClaim
  } = require('../src/routing-policy.cjs');
  const { startQuotaSyncLoop } = require('../src/notifier.cjs');

  // Real clock: the Sidecar section calls Broker.quota() with Date.now(), so bucket reset times must stay in the future.
  const now = Math.floor(Date.now() / 1000) * 1000;
  const reset5h = new Date(now + 3 * 3600000).toISOString();
  const reset7d = new Date(now + 84 * 3600000).toISOString(); // 50% of 7d elapsed

  // 1. Parse official `agy --print /usage --output-format json` 5-bucket structure (same schema as CC Switch subscription_agy.rs)
  const agyCliSample = {
    conversation_id: '',
    status: 'SUCCESS',
    usage: { input_tokens: 0, output_tokens: 0 },
    command: {
      name: 'usage',
      data: {
        groups: [
          {
            name: 'Gemini Models',
            buckets: [
              { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.7, reset_time: reset7d },
              { id: 'gemini-5h', window: '5h', remaining_fraction: 0.85, reset_time: reset5h },
              { id: 'gemini-argon-wtu-weekly', window: 'weekly', remaining_fraction: 0.8, reset_time: reset7d }
            ]
          },
          {
            name: 'Third-Party Models',
            buckets: [
              { id: '3p-weekly', window: 'weekly', remaining_fraction: 0.08, reset_time: reset7d },
              { id: '3p-5h', window: '5h', remaining_fraction: 0.5, reset_time: reset5h }
            ]
          }
        ]
      }
    }
  };
  const parsedProbe = parseAgyProbePayload(agyCliSample);
  assert.equal(parsedProbe.available, true);
  assert.equal(parsedProbe.source, 'agy_cli_usage');
  assert.equal(parsedProbe.five_hour_used_percent, 15);
  assert.equal(parsedProbe.weekly_used_percent, 30);
  assert.equal(parsedProbe.buckets['3p-weekly'].used_percent, 92);
  assert.equal(parsedProbe.buckets['3p-5h'].used_percent, 50);

  // 3p-weekly = 92% >= 90% protect cap automatically trips independent 3p model pool hard stop and fails over to backup thinking model!
  saveRoutingPolicy(f.policyPath, {
    ...defaultPolicy(),
    thinking_models: { general: null, quant: 'thirdparty-top', backups: ['backup-safe-model'] },
    agy_model_pools: {
      thirdparty: { match: 'thirdparty', weekly_protect_used_percent: 90, window_5h_caution_percent: 75, window_5h_protect_percent: 88, bucket_5h: '3p-5h', bucket_7d: '3p-weekly' }
    }
  });
  const polLoaded = loadRoutingPolicy(f.policyPath);
  const projPol = resolveProjectPolicy(polLoaded, { project: f.quantProject, review_category: 'quant' });
  const routeFromBuckets = decideRoute({
    policy: polLoaded,
    projectPolicy: projPol,
    projectScope: { project: f.quantProject, review_category: 'quant' },
    codexPacing: { available: true, band: 'agy_priority', elapsed_percent: 50, used_percent: 85, pacing_delta: 35, resets_at: reset7d, hours_until_reset: 84 },
    agyUsage: { available: true, window_5h: { total_tokens: 100 }, window_7d: { total_tokens: 100 }, quota_errors_5h: 0, auto_degraded: false },
    agyExternal: parsedProbe,
    modelName: 'thirdparty-top-high',
    nowMs: now
  });
  assert.equal(routeFromBuckets.agy_pacing.window_7d.used_percent, 30);
  assert.equal(routeFromBuckets.agy_pacing.window_7d.source, 'agy_cli_usage');
  assert.equal(routeFromBuckets.agy_model_pools.thirdparty.weekly_used_percent, 92);
  assert.equal(routeFromBuckets.agy_model_pools.thirdparty.source, 'agy_cli_usage');
  assert.equal(routeFromBuckets.agy_model_pools.thirdparty.stopped, true);
  assert.equal(routeFromBuckets.thinking_guidance.required_thinking_model, 'backup-safe-model');
  assert.equal(routeFromBuckets.thinking_guidance.current_model_pool_stopped, true);

  // 2. Incremental transcript index: 2nd scan reads 0 bytes (stat cache hit), append reads ONLY appended line bytes!
  const brainDir = path.join(f.root, 'inc-brain');
  const logDir1 = path.join(brainDir, 'c1', '.system_generated', 'logs');
  const logDir2 = path.join(brainDir, 'c2', '.system_generated', 'logs');
  fs.mkdirSync(logDir1, { recursive: true });
  fs.mkdirSync(logDir2, { recursive: true });
  const tFile1 = path.join(logDir1, 'transcript.jsonl');
  const tFile2 = path.join(logDir2, 'transcript.jsonl');
  fs.writeFileSync(tFile1, JSON.stringify({ created_at: new Date(now - 3600000).toISOString(), model: 'm-std', input_tokens: 2000, output_tokens: 500 }) + '\n', 'utf8');
  fs.writeFileSync(tFile2, JSON.stringify({ created_at: new Date(now - 7200000).toISOString(), model: 'm-std', input_tokens: 3000, output_tokens: 1000 }) + '\n', 'utf8');
  const indexPath = defaultTranscriptIndexPath(f.policyPath);

  const s1 = scanAgyTranscriptUsage({ brainDir, indexPath, nowMs: now });
  assert.equal(s1.window_5h.total_tokens, 6500);
  assert.equal(s1.sync_stats.full_reads, 2);
  assert.equal(s1.sync_stats.cache_hits, 0);

  // Unchanged files => 0 bytes read from disk, 2 cache hits!
  const s2 = scanAgyTranscriptUsage({ brainDir, indexPath, nowMs: now });
  assert.equal(s2.window_5h.total_tokens, 6500);
  assert.equal(s2.sync_stats.cache_hits, 2);
  assert.equal(s2.sync_stats.bytes_read, 0);

  // Append 1 new line to tFile1 => 1 cache hit (tFile2), 1 incremental read (tFile1) reading ONLY appended line!
  const appendedLine = JSON.stringify({ created_at: new Date(now - 60000).toISOString(), model: 'm-std', input_tokens: 400, output_tokens: 100 }) + '\n';
  fs.appendFileSync(tFile1, appendedLine, 'utf8');
  const s3 = scanAgyTranscriptUsage({ brainDir, indexPath, nowMs: now });
  assert.equal(s3.window_5h.total_tokens, 7000);
  assert.equal(s3.sync_stats.cache_hits, 1);
  assert.equal(s3.sync_stats.incremental_reads, 1);
  assert.equal(s3.sync_stats.bytes_read, Buffer.byteLength(appendedLine, 'utf8'));

  // Matches stateless full scan 100%
  const sFull = scanAgyTranscriptUsage({ brainDir, nowMs: now });
  assert.equal(sFull.window_5h.total_tokens, s3.window_5h.total_tokens);
  assert.equal(sFull.window_7d.total_tokens, s3.window_7d.total_tokens);

  // 3. Cross-window resource reuse + Sidecar centralized background sync:
  // Once Sidecar warms quota-cache.json, opening 5 new windows (SessionStart + PreToolUse) does ZERO probes and ZERO transcript scans!
  let probeRuns = 0;
  const mockAgyBin = path.join(f.root, 'mock-agy-cli.cjs');
  const probeCounterFile = path.join(f.root, 'probe-count.txt');
  fs.writeFileSync(mockAgyBin, [
    'const fs = require("node:fs");',
    `const c = fs.existsSync(${JSON.stringify(probeCounterFile)}) ? Number(fs.readFileSync(${JSON.stringify(probeCounterFile)}, "utf8")) : 0;`,
    `fs.writeFileSync(${JSON.stringify(probeCounterFile)}, String(c + 1), "utf8");`,
    // Verify GEMINI_API_KEY was stripped from child env (same rule as CC Switch subscription_agy.rs)
    'if (process.env.GEMINI_API_KEY) { process.exit(2); }',
    `console.log(JSON.stringify(${JSON.stringify(agyCliSample)}));`
  ].join('\n'), 'utf8');
  saveRoutingPolicy(f.policyPath, {
    ...loadRoutingPolicy(f.policyPath),
    agy_quota_command: [process.execPath, mockAgyBin]
  });

  let rpcCalls = 0;
  const sidecarBroker = new Broker(
    { project: f.quantProject, data: f.quantData, routing_config_file: f.policyPath },
    async () => {
      rpcCalls += 1;
      return {
        ordinaryUsageAllowed: true,
        rateLimits: { planType: 'pro', primary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: Math.floor((Date.now() + 84 * 3600000) / 1000) } }
      };
    }
  );
  const prevKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'should-not-leak-to-official-agy-usage';
  const syncLoop = startQuotaSyncLoop(sidecarBroker, { initialDelayMs: 60000, intervalMs: 120000 });
  try {
    const bg1 = await syncLoop.tick();
    assert.equal(bg1.codex_pacing.used_percent, 88);
    assert.equal(bg1.agy_external.weekly_used_percent, 30);
    probeRuns = Number(fs.readFileSync(probeCounterFile, 'utf8'));
    assert.equal(rpcCalls, 1);
    assert.equal(probeRuns, 1);

    // Second Sidecar background tick 10s later reuses recent Codex (<15m) & AGY (<10m) probes without spawning anything!
    await syncLoop.tick();
    assert.equal(rpcCalls, 1);
    assert.equal(Number(fs.readFileSync(probeCounterFile, 'utf8')), 1);

    // Delete brainDir after Sidecar warmed quota-cache.json to prove opening 5 new windows NEVER touches brainDir or spawns probes!
    const markerFile = path.join(f.root, 'multi-window-markers.json');
    const projects = [
      { project: f.project, data: f.data, review_category: 'general' },
      { project: f.quantProject, data: f.quantData, review_category: 'quant' }
    ];
    for (let w = 1; w <= 5; w++) {
      const convId = `0000000${w}-1111-2222-3333-444444444444`;
      const hookOut = contextHook(
        { hookEventName: 'SessionStart', conversationId: convId, workspacePaths: [w % 2 === 0 ? f.project : f.quantProject], modelName: 'backup-safe-model' },
        projects,
        { policyPath: f.policyPath, brainDir: path.join(f.root, 'non-existent-if-scanned'), markerFile }
      );
      assert.equal(hookOut.injectSteps.length, 1);
      assert.match(hookOut.injectSteps[0].systemMessage.systemMessage, /已用 88%/);
      assert.match(hookOut.injectSteps[0].systemMessage.systemMessage, /AGY 7天目标.*已用 30%/);

      const preOut = bindOrigin(
        { conversationId: convId, workspacePaths: [f.project], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Impl', Prompt: 'work' } } },
        projects,
        { policyPath: f.policyPath }
      );
      assert.equal(preOut.decision, 'allow');
    }

    // Normal codex_quota() call from any window also hits shared quota-cache.json in 0ms without re-probing
    const winQuota = await sidecarBroker.quota({});
    assert.equal(winQuota.cached, true);
    assert.equal(rpcCalls, 1);
    assert.equal(Number(fs.readFileSync(probeCounterFile, 'utf8')), 1);

    // Single-flight claim prevents concurrent refresh stampede
    const cachePath = defaultQuotaCachePath(f.policyPath, { data: f.quantData });
    const held = takeQuotaRefreshClaim(cachePath, 30000, Date.now());
    assert.equal(typeof held, 'function');
    try {
      const bgSkipped = await sidecarBroker.quota({ background: true });
      assert.equal(bgSkipped.skipped, true);
      assert.equal(rpcCalls, 1);
    } finally {
      held();
    }
  } finally {
    syncLoop.close();
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }
});

test('6h automatic buffer unlock, 100% exhaustion cross-engine handover, strict gate unlock, symmetric AGY guard, and dual-exhaustion matrix', t => {
  const f = fixture(t);
  const { writeQuotaCache, defaultQuotaCachePath, evaluateCodexPacing } = require('../src/routing-policy.cjs');
  const now = anchorNowMs();
  const cachePath = defaultQuotaCachePath(f.policyPath, { data: f.quantData });
  const projects = [{ project: f.quantProject, data: f.quantData, review_category: 'quant' }];
  const convId = '77777777-7777-7777-7777-777777777777';

  const makeCodex = (usedPct, hoursLeft, balance = '0') => evaluateCodexPacing({
    ordinaryUsageAllowed: usedPct < 100,
    rateLimits: {
      planType: 'pro',
      primary: { usedPercent: usedPct, windowDurationMins: 10080, resetsAt: Math.floor((now + hoursLeft * 3600000) / 1000) },
      credits: { hasCredits: Number(balance) > 0, unlimited: false, balance }
    }
  }, undefined, now);

  // 1. Codex 100% exhausted + AGY healthy:
  //    - Unsticks sticky continuations, native_luna, and review_only=true -> [CODEX_EXHAUSTED_HANDOVER]
  //    - Explicit CODEX_ALLOW_EXTRA_CREDITS override still works when user authorizes credits
  //    - strict review-before-AGY gate automatically unlocks so AGY writes don't deadlock!
  saveRoutingPolicy(f.policyPath, {
    ...defaultPolicy(),
    agy_guard: { ...defaultPolicy().agy_guard, review_gate: 'strict' },
    agy_manual_snapshot: {
      recorded_at: new Date(now - 60000).toISOString(),
      weekly_used_percent: 20,
      weekly_resets_at: new Date(now + 96 * 3600000).toISOString(),
      five_hour_used_percent: 10,
      five_hour_resets_at: new Date(now + 4 * 3600000).toISOString()
    }
  });
  writeQuotaCache(cachePath, {
    codex_pacing: makeCodex(100, 68, '50'),
    agy_usage: { available: true, window_5h: { total_tokens: 0 }, window_7d: { total_tokens: 0 }, quota_errors_5h: 0, auto_degraded: false },
    agy_external: null,
    fetched_at: new Date(now).toISOString()
  });

  for (const args of [
    { topic_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', prompt: '原事项续接' },
    { prompt: 'native_luna 批量流水线' },
    { review_only: true, prompt: '只读审核方案' }
  ]) {
    const res = bindOrigin(
      { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'codex_run', args } },
      projects,
      { policyPath: f.policyPath, nowMs: now }
    );
    assert.equal(res.decision, 'deny');
    assert.match(res.reason, /\[CODEX_EXHAUSTED_HANDOVER\]/);
    assert.match(res.reason, /额外 Credits/);
  }
  const explicitCredits = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'codex_run', args: { prompt: '用户批准 CODEX_ALLOW_EXTRA_CREDITS 执行' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(explicitCredits.decision, 'allow');

  // Strict review gate does NOT deadlock AGY write when Codex is 100% exhausted!
  const strictUnlocked = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'edit_file', args: { Path: 'alpha.py' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(strictUnlocked.decision, 'allow');
  assert.match(strictUnlocked.reason, /100% 耗尽.*自动免除/);

  // 2. Symmetric AGY protection (>6h before reset) vs <=6h automatic 10% buffer unlock (both main AGY and independent pool):
  saveRoutingPolicy(f.policyPath, {
    ...defaultPolicy(),
    agy_manual_snapshot: {
      recorded_at: new Date(now - 60000).toISOString(),
      weekly_used_percent: 93,
      weekly_resets_at: new Date(now + 24 * 3600000).toISOString(), // 24h > 6h => 90% protect active!
      five_hour_used_percent: 15,
      five_hour_resets_at: new Date(now + 4 * 3600000).toISOString()
    },
    agy_model_pools: {
      extpool: {
        match: 'extpool',
        weekly_protect_used_percent: 90,
        window_5h_caution_percent: 75,
        window_5h_protect_percent: 88,
        manual_snapshot: {
          recorded_at: new Date(now - 60000).toISOString(),
          weekly_used_percent: 93,
          weekly_resets_at: new Date(now + 24 * 3600000).toISOString(),
          five_hour_used_percent: 10,
          five_hour_resets_at: new Date(now + 4 * 3600000).toISOString()
        }
      }
    }
  });
  writeQuotaCache(cachePath, {
    codex_pacing: makeCodex(40, 68),
    agy_usage: { available: true, window_5h: { total_tokens: 0 }, window_7d: { total_tokens: 0 }, quota_errors_5h: 0, auto_degraded: false },
    agy_external: null,
    fetched_at: new Date(now).toISOString()
  });

  // At 24h before reset (>6h), AGY 93% >= 90% blocks AGY write & execution subagent so 10% main-chat buffer stays intact, while research stays open
  const blockedAgySub = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Impl', Prompt: 'code' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(blockedAgySub.decision, 'deny');
  assert.match(blockedAgySub.reason, /\[AGY_QUOTA_PROTECTED\]/);
  const allowedAgyResearch = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'research', Role: 'Read', Prompt: 'scan' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(allowedAgyResearch.decision, 'allow');

  // Advance clock to 4h before weekly reset (now + 20h => 4h <= 6h left): remaining 10% buffer unlocks automatically for BOTH main AGY and extpool!
  const nowAt4hLeft = now + 20 * 3600000;
  writeQuotaCache(cachePath, {
    codex_pacing: makeCodex(40, 48),
    agy_usage: { available: true, window_5h: { total_tokens: 0 }, window_7d: { total_tokens: 0 }, quota_errors_5h: 0, auto_degraded: false },
    agy_external: null,
    fetched_at: new Date(nowAt4hLeft).toISOString()
  });
  const unlockedAgySub = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Role: 'Impl', Prompt: 'drain remaining 7%' } } },
    projects,
    { policyPath: f.policyPath, nowMs: nowAt4hLeft }
  );
  assert.equal(unlockedAgySub.decision, 'allow');
  const polAt4h = loadRoutingPolicy(f.policyPath);
  const routeAt4h = decideRoute({
    policy: polAt4h,
    projectPolicy: resolveProjectPolicy(polAt4h, projects[0]),
    projectScope: projects[0],
    codexPacing: makeCodex(40, 48),
    nowMs: nowAt4hLeft
  });
  assert.equal(routeAt4h.agy_pacing.window_7d.buffer_unlocked, true);
  assert.equal(routeAt4h.agy_model_pools.extpool.buffer_unlocked, true);
  assert.equal(routeAt4h.agy_model_pools.extpool.stopped, false);

  // 3. Dual-Constrained Matrix:
  //    (a) Codex 100% dead + AGY 93% soft buffer (>6h to reset) => routes to AGY Emergency Rationing (NEVER dead Codex!), blocks run_workflow, forces flash_lite!
  writeQuotaCache(cachePath, {
    codex_pacing: makeCodex(100, 68),
    agy_usage: { available: true, window_5h: { total_tokens: 0 }, window_7d: { total_tokens: 0 }, quota_errors_5h: 0, auto_degraded: false },
    agy_external: null,
    fetched_at: new Date(now).toISOString()
  });
  const routeRation = decideRoute({
    policy: polAt4h,
    projectPolicy: resolveProjectPolicy(polAt4h, projects[0]),
    projectScope: projects[0],
    codexPacing: makeCodex(100, 68),
    nowMs: now
  });
  assert.equal(routeRation.preferred_engine, 'agy');
  assert.equal(routeRation.emergency_rationing, true);
  assert.equal(routeRation.reason, 'codex_exhausted_agy_emergency_rationing');

  const blockedWorkflow = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'run_workflow', args: { Script: 'x' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(blockedWorkflow.decision, 'deny');
  assert.match(blockedWorkflow.reason, /\[AGY_EMERGENCY_RATIONING\]/);

  const rationSub = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'invoke_subagent', args: { TypeName: 'self', Model: 'pro', Role: 'Urgent Fix', Prompt: 'fix' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(rationSub.decision, 'allow');
  assert.equal(rationSub.overwrite.Model, 'flash_lite');
  assert.match(rationSub.reason, /应急省流模式/);

  //    (b) Both Codex 100% dead + AGY 100% dead => paused + [DUAL_QUOTA_EXHAUSTED] on both sides with earliest reset hours & CC Switch option!
  saveRoutingPolicy(f.policyPath, {
    ...defaultPolicy(),
    agy_manual_snapshot: {
      recorded_at: new Date(now - 60000).toISOString(),
      weekly_used_percent: 100,
      weekly_resets_at: new Date(now + 50 * 3600000).toISOString(),
      five_hour_used_percent: 100,
      five_hour_resets_at: new Date(now + 1.5 * 3600000).toISOString()
    }
  });
  const polDualDead = loadRoutingPolicy(f.policyPath);
  const routeDualDead = decideRoute({
    policy: polDualDead,
    projectPolicy: resolveProjectPolicy(polDualDead, projects[0]),
    projectScope: projects[0],
    codexPacing: makeCodex(100, 68),
    nowMs: now
  });
  assert.equal(routeDualDead.preferred_engine, 'paused');
  assert.equal(routeDualDead.reason, 'both_engines_exhausted_await_user_or_switch');
  assert.equal(routeDualDead.exhaustion_handover.earliest_reset_hours, 1.5);

  const dualDeadCodex = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'codex_run', args: { prompt: 'try codex' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(dualDeadCodex.decision, 'deny');
  assert.match(dualDeadCodex.reason, /\[DUAL_QUOTA_EXHAUSTED\]/);
  assert.match(dualDeadCodex.reason, /1\.5h/);
  assert.match(dualDeadCodex.reason, /CC Switch/);

  const dualDeadAgy = bindOrigin(
    { conversationId: convId, workspacePaths: [f.quantProject], toolCall: { name: 'edit_file', args: { Path: 'a.py' } } },
    projects,
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(dualDeadAgy.decision, 'deny');
  assert.match(dualDeadAgy.reason, /\[DUAL_QUOTA_EXHAUSTED\]/);
});

test('unused / 0% unactivated windows, epoch-zero sentinels, cross-pool reset isolation, and cycle-reset / account-switch 100%->0% recovery', async t => {
  const f = fixture(t);
  const {
    parseAgyProbePayload,
    codexIsExhausted,
    evaluateCodexPacing,
    evaluateAgyPacing,
    evaluateAgyModelPools,
    readLatestCodexRolloutRateLimits,
    resolveSharedQuotaSnapshot,
    writeQuotaCache,
    defaultQuotaCachePath
  } = require('../src/routing-policy.cjs');
  const now = anchorNowMs();

  // 1. Official agy /usage with inactive 3p buckets (epoch-zero) AND Codex only 3h away from weekly reset:
  //    3p-weekly MUST NOT borrow Codex's 3h reset timestamp or falsely unlock its 10% buffer!
  const parsed = parseAgyProbePayload({
    status: 'SUCCESS',
    command: { data: { groups: [
      { buckets: [
        { id: 'gemini-weekly', remaining_fraction: 0.78, reset_time: relIso(now, 112 * HOUR_MS) },
        { id: 'gemini-5h', remaining_fraction: 0.97, reset_time: relIso(now, 4.5 * HOUR_MS) }
      ] },
      { buckets: [
        { id: '3p-weekly', remaining_fraction: 1, reset_time: EPOCH_ZERO_ISO },
        { id: '3p-5h', remaining_fraction: 1, reset_time: EPOCH_ZERO_ISO }
      ] }
    ] } }
  });
  assert.equal(parsed.buckets['3p-weekly'].resets_at, null);
  assert.equal(parsed.buckets['3p-weekly'].window_active, false);
  assert.equal(parsed.buckets['3p-weekly'].used_percent, 0);

  const policy = resolveProjectPolicy({
    ...defaultPolicy(),
    agy_model_pools: { thirdparty: { match: 'thirdparty', weekly_protect_used_percent: 90, window_5h_protect_percent: 88, bucket_5h: '3p-5h', bucket_7d: '3p-weekly', window_7d_tokens: 1000 } }
  }, { project: 'P:/x', review_category: 'general' });

  const codexNearReset = {
    available: true,
    window_active: true,
    used_percent: 100,
    hard_limited: false,
    band: 'codex_protected',
    resets_at: relIso(now, 3 * HOUR_MS),
    hours_until_reset: 3,
    pacing_delta: 0,
    elapsed_percent: 100
  };
  const route = decideRoute({
    projectPolicy: policy,
    codexPacing: codexNearReset,
    agyUsage: { available: true, window_5h: { total_tokens: 0, by_model: {} }, window_7d: { total_tokens: 900, by_model: { 'thirdparty-x': { total_tokens: 900 } } }, quota_errors_5h: 0, auto_degraded: false },
    agyExternal: parsed,
    nowMs: now
  });
  assert.equal(route.agy_model_pools.thirdparty.source, 'agy_cli_usage');
  assert.equal(route.agy_model_pools.thirdparty.window_active, false);
  assert.equal(route.agy_model_pools.thirdparty.weekly_used_percent, 0);
  assert.equal(route.agy_model_pools.thirdparty.hours_until_reset, null, 'Unactivated 3p pool must never borrow Codex reset time');
  assert.equal(route.agy_model_pools.thirdparty.buffer_unlocked, false, 'Unactivated 3p pool must never falsely unlock 10% buffer');
  assert.equal(route.agy_model_pools.thirdparty.elapsed_percent, 0);
  assert.equal(route.agy_model_pools.thirdparty.target_used_percent, 0);
  assert.equal(route.agy_model_pools.thirdparty.stopped, false);
  assert.equal(codexIsExhausted({ available: true, used_percent: 100 }), true);
  assert.equal(route.codex_exhausted, true);
  assert.equal(route.reason, 'codex_exhausted_handover_agy');

  // 2. Completely unused AGY main pool (`gemini-weekly` & `gemini-5h` at 0% with epoch-zero reset_time):
  //    Must evaluate as `available: true, window_active: false` (never falling into `uncalibrated` and never borrowing Codex's 3h reset)!
  const allUnusedAgy = parseAgyProbePayload({
    status: 'SUCCESS',
    command: { data: { groups: [
      { buckets: [
        { id: 'gemini-weekly', remaining_fraction: 1, reset_time: EPOCH_ZERO_ISO },
        { id: 'gemini-5h', remaining_fraction: 1, reset_time: EPOCH_ZERO_ISO }
      ] }
    ] } }
  });
  const apUnused = evaluateAgyPacing({
    agyUsage: { available: false },
    agyExternal: allUnusedAgy,
    projectPolicy: policy,
    codexPacing: codexNearReset,
    nowMs: now
  });
  assert.equal(apUnused.window_7d.available, true);
  assert.equal(apUnused.window_7d.window_active, false);
  assert.equal(apUnused.window_7d.used_percent, 0);
  assert.equal(apUnused.window_7d.usable_remaining_percent, 90);
  assert.equal(apUnused.window_7d.hours_until_reset, null);
  assert.equal(apUnused.window_7d.buffer_unlocked, false);
  assert.equal(apUnused.window_7d.band, 'agy_priority');
  assert.equal(apUnused.window_5h.window_active, false);
  assert.equal(apUnused.window_5h.used_percent, 0);

  const routeWithUnusedAgy = decideRoute({
    projectPolicy: policy,
    codexPacing: { available: true, window_active: true, band: 'balanced', elapsed_percent: 50, used_percent: 50, pacing_delta: 0, resets_at: relIso(now, 84 * HOUR_MS), hours_until_reset: 84 },
    agyExternal: allUnusedAgy,
    nowMs: now
  });
  assert.doesNotMatch(routeWithUnusedAgy.summary_line, /nullh|undefined/);
  assert.match(routeWithUnusedAgy.summary_line, /待激活 \/ 已用 0%/);

  // 3. Unused Codex states (`resetsAt: null`, `resetsAt: 0`, and past-reset cycle rollover):
  const codexUnusedNull = evaluateCodexPacing({
    ordinaryUsageAllowed: true,
    rateLimits: { planType: 'pro', primary: { usedPercent: 0, windowDurationMins: null, resetsAt: null } }
  }, undefined, now);
  assert.equal(codexUnusedNull.available, true);
  assert.equal(codexUnusedNull.window_active, false);
  assert.equal(codexUnusedNull.used_percent, 0);
  assert.equal(codexUnusedNull.remaining_percent, 100);
  assert.equal(codexUnusedNull.elapsed_percent, 0);
  assert.equal(codexUnusedNull.pacing_delta, 0);
  assert.equal(codexUnusedNull.resets_at, null);
  assert.equal(codexUnusedNull.hours_until_reset, null);
  assert.equal(codexUnusedNull.band, 'codex_priority');
  assert.equal(codexUnusedNull.exhausted, false);

  const codexRolledOver = evaluateCodexPacing({
    ordinaryUsageAllowed: true,
    rateLimits: { planType: 'pro', primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: relSec(now, -5 * MINUTE_MS) } }
  }, undefined, now);
  assert.equal(codexRolledOver.available, true);
  assert.equal(codexRolledOver.window_active, false);
  assert.equal(codexRolledOver.used_percent, 0, 'Past reset timestamp with ordinaryUsageAllowed=true rolls over to 0% unused');
  assert.equal(codexRolledOver.exhausted, false);

  // Missing reset on a 100% exhausted response still preserves exhaustion protection without printing nullh!
  const codexDeadNoReset = evaluateCodexPacing({
    ordinaryUsageAllowed: false,
    rateLimits: { planType: 'pro', primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: null } }
  }, undefined, now);
  assert.equal(codexDeadNoReset.available, true);
  assert.equal(codexDeadNoReset.exhausted, true);
  assert.equal(codexDeadNoReset.band, 'codex_protected');
  const deadRoute = decideRoute({ projectPolicy: policy, codexPacing: codexDeadNoReset, agyExternal: allUnusedAgy, nowMs: now });
  assert.doesNotMatch(deadRoute.summary_line, /nullh|null%/);

  // 4. Cycle reset / CC Switch account switch from 100% -> 0% in rollout logs MUST override stale 100% cache!
  const sessDir = path.join(f.root, 'switch-sessions');
  fs.mkdirSync(sessDir, { recursive: true });
  fs.writeFileSync(path.join(sessDir, 'rollout-fresh-account.jsonl'), JSON.stringify({
    timestamp: relIso(now, -10 * 1000),
    type: 'event_msg',
    payload: { rate_limits: { plan_type: 'pro', primary: { used_percent: 0, window_minutes: 10080, resets_at: 0 } } }
  }) + '\n', 'utf8');
  const rollZero = readLatestCodexRolloutRateLimits({ codexSessionsDir: sessDir, nowMs: now });
  assert.ok(rollZero, 'Rollout reader must accept 0% unused pending window');
  assert.equal(rollZero.rateLimits.primary.used_percent, 0);

  const cachePath = defaultQuotaCachePath(f.policyPath, { data: f.data });
  writeQuotaCache(cachePath, {
    codex_pacing: { ...codexNearReset, used_percent: 100, exhausted: true },
    codex_probed_at: relIso(now, -20 * MINUTE_MS),
    agy_usage: { available: true, window_5h: { total_tokens: 0 }, window_7d: { total_tokens: 0 }, quota_errors_5h: 0, auto_degraded: false },
    agy_external: allUnusedAgy,
    fetched_at: relIso(now, -20 * MINUTE_MS) // Older than 15m shared window so resolveSharedQuotaSnapshot refreshes from rollout
  });
  const refreshedSnap = resolveSharedQuotaSnapshot({ data: f.data }, policy, {
    policyPath: f.policyPath,
    cachePath,
    codexSessionsDir: sessDir,
    brainDir: f.root,
    nowMs: now
  });
  assert.equal(refreshedSnap.codexPacing.used_percent, 0, 'Newer 0% rollout after account switch or reset must override stale 100% cache');
  assert.equal(refreshedSnap.codexPacing.exhausted, false);

  // 5. Local independent model pool direct invocation (`pool-run`), quota-stop protection, subagent `inherit` preservation, and external CLI misuse block:
  const mockPoolCli = path.join(f.root, 'mock-pool-agy.cjs');
  fs.writeFileSync(mockPoolCli, [
    'const args = process.argv.slice(2);',
    'const mIdx = args.indexOf("--model");',
    'const modeIdx = args.indexOf("--mode");',
    'const pIdx = args.indexOf("--print");',
    'console.log(JSON.stringify({',
    '  conversation_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",',
    '  status: "SUCCESS",',
    '  response: `LOCAL_POOL_REVIEW_OK:${args[mIdx + 1]}:${args[modeIdx + 1]}:${args[pIdx + 1]}`,',
    '  duration_seconds: 1.2,',
    '  num_turns: 1,',
    '  usage: { input_tokens: 1000, output_tokens: 50, cache_read_tokens: 800, total_tokens: 1050 }',
    '}));'
  ].join('\n'), 'utf8');

  await runModeCli([
    'pool', '--name', 'thirdparty', '--match', 'thirdparty',
    '--review-model', 'thirdparty-opus-high', '--default-model', 'thirdparty-sonnet-high',
    '--weekly-protect', '90', '--5h-protect', '88',
    '--weekly-used', '12', '--weekly-reset', relIso(now, 96 * HOUR_MS),
    '--5h-used', '15', '--5h-reset', relIso(now, 4 * HOUR_MS),
    '--policy', f.policyPath
  ]);

  // (a) Misguided attempt to invoke external `<token>_mcp_server.py` or `<token> -p` is blocked by PreToolUse with exact local `pool-run` command!
  const blockedExtScript = bindOrigin(
    { conversationId: '88888888-8888-8888-8888-888888888888', workspacePaths: [f.project], toolCall: { name: 'run_command', args: { CommandLine: 'python thirdparty_mcp_server.py --invoke-once' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(blockedExtScript.decision, 'deny');
  assert.match(blockedExtScript.reason, /\[LOCAL_POOL_AVAILABLE\]/);
  assert.match(blockedExtScript.reason, /pool-run --pool thirdparty/);

  const blockedExtCli = bindOrigin(
    { conversationId: '88888888-8888-8888-8888-888888888888', workspacePaths: [f.project], toolCall: { name: 'run_command', args: { CommandLine: 'thirdparty -p "review this"' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(blockedExtCli.decision, 'deny');
  assert.match(blockedExtCli.reason, /thirdparty-opus-high/);

  // Legitimate `Mode.ps1 pool-run` command is allowed through PreToolUse!
  const allowedPoolRunCmd = bindOrigin(
    { conversationId: '88888888-8888-8888-8888-888888888888', workspacePaths: [f.project], toolCall: { name: 'run_command', args: { CommandLine: 'pwsh -NoProfile -File scripts/Mode.ps1 pool-run --pool thirdparty --prompt "review"' } } },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(allowedPoolRunCmd.decision, 'allow');

  // (b) When host window is ALREADY on the thirdparty pool model, `invoke_subagent` naming that pool keeps `Model="inherit"` instead of downgrading to `flash_lite`!
  const preservedInherit = bindOrigin(
    {
      conversationId: '88888888-8888-8888-8888-888888888888',
      modelName: 'thirdparty-opus-high',
      workspacePaths: [f.project],
      toolCall: { name: 'invoke_subagent', args: { TypeName: 'research', Model: 'inherit', Role: 'thirdparty 架构审查', Prompt: '请用 thirdparty 审核方案' } }
    },
    [{ project: f.project, data: f.data }],
    { policyPath: f.policyPath, nowMs: now }
  );
  assert.equal(preservedInherit.decision, 'allow');
  assert.equal(preservedInherit.overwrite, undefined, 'Must preserve Model=inherit when host is already on the requested pool');

  // (c) `runAgyPoolTaskAsync` executes against local pool in `plan` mode when healthy, and blocks when pool hits 90% cap!
  const { runAgyPoolTaskAsync } = require('../src/routing-policy.cjs');
  const loadedWithPool = resolveProjectPolicy(loadRoutingPolicy(f.policyPath), { project: f.project });
  const okPoolRun = await runAgyPoolTaskAsync({
    poolName: 'thirdparty',
    cwd: f.project,
    prompt: 'check edge cases',
    projectPolicy: loadedWithPool,
    agyBin: [process.execPath, mockPoolCli],
    probeHomeDir: path.join(f.root, 'probe-home'),
    nowMs: now
  });
  assert.equal(okPoolRun.ok, true);
  assert.equal(okPoolRun.model, 'thirdparty-opus-high');
  assert.match(okPoolRun.response, /LOCAL_POOL_REVIEW_OK:thirdparty-opus-high:plan:check edge cases/);

  await runModeCli([
    'pool', '--name', 'thirdparty', '--weekly-used', '92', '--weekly-reset', relIso(now, 48 * HOUR_MS), '--policy', f.policyPath
  ]);
  const stoppedPolicy = resolveProjectPolicy(loadRoutingPolicy(f.policyPath), { project: f.project });
  const blockedPoolRun = await runAgyPoolTaskAsync({
    poolName: 'thirdparty',
    cwd: f.project,
    prompt: 'should be blocked by 90% buffer cap',
    projectPolicy: stoppedPolicy,
    agyBin: [process.execPath, mockPoolCli],
    probeHomeDir: path.join(f.root, 'probe-home'),
    nowMs: now
  });
  assert.equal(blockedPoolRun.ok, false);
  assert.equal(blockedPoolRun.blocked, true);
  assert.equal(blockedPoolRun.kind, 'pool_quota_protected');
});
