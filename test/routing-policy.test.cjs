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
  const out8 = JSON.parse(await runModeCli(['agy-quota', '--weekly-used', '32', '--weekly-reset', '2026-11-28T15:14:55Z', '--5h-used', '45', '--5h-reset', '2026-11-25T13:00:00Z', '--policy', f.policyPath]));
  assert.equal(out8.agy_manual_snapshot.weekly_used_percent, 32);
  assert.equal(out8.agy_manual_snapshot.five_hour_used_percent, 45);
  const out9 = JSON.parse(await runModeCli(['agy-budget', '--tokens-5h', '10000000', '--tokens-7d', '100000000', '--5h-caution', '70', '--5h-protect', '85', '--policy', f.policyPath]));
  assert.equal(out9.agy_pacing.window_5h_tokens, 10000000);
  assert.equal(out9.agy_pacing.window_7d_tokens, 100000000);
  assert.equal(out9.agy_pacing.window_5h_caution_percent, 70);
  assert.equal(out9.agy_pacing.window_5h_protect_percent, 85);
});

test('dual 7-day 100% proportional pacing + AGY 5-hour limit guard + Codex fallback', () => {
  const now = Date.parse('2026-11-25T10:00:00Z');
  const reset7d = new Date(now + 84 * 3600000).toISOString(); // 50% elapsed of 7d window
  const reset5h = new Date(now + 3 * 3600000).toISOString();
  const base = defaultPolicy();
  const scope = { project: 'P:/dual', review_category: 'general' };

  // 1. Both calibrated: Codex at 80% (+30% ahead), AGY 7d at 30% (-20% behind), AGY 5h at 40% (ok) => prefer AGY
  const p1 = resolveProjectPolicy({
    ...base,
    agy_manual_snapshot: { recorded_at: new Date(now - 60000).toISOString(), weekly_used_percent: 30, weekly_resets_at: reset7d, five_hour_used_percent: 40, five_hour_resets_at: reset5h }
  }, scope);
  const codexAhead = { available: true, band: 'agy_priority', elapsed_percent: 50, used_percent: 80, pacing_delta: 30, resets_at: reset7d, hours_until_reset: 84, hard_limited: false };
  const r1 = decideRoute({ policy: base, projectPolicy: p1, projectScope: scope, codexPacing: codexAhead, nowMs: now });
  assert.equal(r1.preferred_engine, 'agy');
  assert.equal(r1.reason, 'dual_7d_agy_further_behind_pace');
  assert.equal(r1.agy_pacing.window_7d.pacing_delta, -20);
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
  assert.equal(apBudget.window_7d.pacing_delta, -10);
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
  for (const line of [10, 14, 22]) {
    postToolHook({
      conversationId: convId,
      workspacePaths: [f.project],
      lastUserInput: 'fix bugs',
      toolCall: { name: 'run_command', args: { CommandLine: 'pytest tests/test_alpha.py' } },
      error: `2026-11-25T10:00:${line}Z AssertionError: mismatch at test_alpha.py:${line} (120ms)`
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
