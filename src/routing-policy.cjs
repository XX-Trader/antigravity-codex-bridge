'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const MODE_ALIASES = Object.freeze({
  auto: 'auto',
  hybrid: 'auto',
  balanced: 'auto',
  agy: 'agy',
  antigravity: 'agy',
  codex: 'codex'
});

const SUBAGENT_MODELS = new Set(['flash_lite', 'flash', 'pro', 'inherit']);
const AGY_HINTS = new Set(['plenty', 'normal', 'low']);
const TERMINAL_STATUSES = new Set([
  'completed', 'failed', 'cancelled', 'timed_out',
  'needs_input', 'blocked', 'execution_blocked',
  'review_revise', 'review_needs_evidence'
]);

const DEFAULT_PACING = Object.freeze({
  plan_days: 5,                   // Consume 100% of Codex weekly quota proportionally within 5 days
  target_utilization: 100,
  codex_priority_margin: -3,
  balanced_upper_margin: 5,
  agy_priority_used_percent: 92,
  codex_protect_used_percent: 97,
  drain_window_hours: 12,
  drain_min_remaining_percent: 10
});

const DEFAULT_AGY_PACING = Object.freeze({
  target_utilization: 100,
  window_minutes: 10080,          // 7-day weekly quota window (mirrors Codex 7d 100% pacing)
  window_5h_minutes: 300,         // AGY 5-hour rolling/refresh limit window
  dual_compare_margin: 5,         // |delta_codex - delta_agy| <= 5% => balanced
  window_5h_caution_percent: 75,  // AGY 5h >= 75% => throttle to balanced to avoid hitting 5h wall
  window_5h_protect_percent: 88,  // AGY 5h >= 88% => AGY 5h limited, Codex takes over as fallback
  weekly_protect_used_percent: 97,
  drain_window_hours: 12,
  drain_min_remaining_percent: 10,
  window_5h_tokens: null,         // Optional local 5h token calibration budget
  window_7d_tokens: null,         // Optional local 7d token calibration budget
  weekly_resets_at: null          // Optional ISO timestamp for AGY weekly reset anchor
});

const DEFAULT_AGY_TIERS = Object.freeze({
  simple: 'flash_lite',
  standard: 'flash',
  complex: 'pro',
  expert: 'inherit'
});

const DEFAULT_AGY_GUARD = Object.freeze({
  max_same_error_failures: 3,    // Same normalized error 3x in a row => genuine loop, stop!
  max_consecutive_failures: 8,   // Distinct errors are allowed to self-heal; safety cap at 8 with zero successes
  review_gate: 'advisory',       // 'off' | 'advisory' | 'strict'
  review_valid_hours: 12,
  quota_error_cooldown_minutes: 15
});
const REVIEW_GATES = new Set(['off', 'advisory', 'strict']);

const round2 = value => Math.round(value * 100) / 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const samePath = (a, b) => process.platform === 'win32'
  ? String(a).toLowerCase() === String(b).toLowerCase()
  : String(a) === String(b);

function safeReal(target) {
  try { return fs.realpathSync(target); } catch { return path.resolve(target); }
}

function alivePid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function normalizeMode(value, fallback = 'auto') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') throw new Error('Execution mode must be a string: auto, agy or codex');
  const key = value.trim().toLowerCase();
  if (!Object.hasOwn(MODE_ALIASES, key)) {
    throw new Error(`Unsupported execution mode "${value}"; expected auto, agy (AGY/Agy/antigravity), or codex`);
  }
  return MODE_ALIASES[key];
}

function normalizeSubagentModel(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !SUBAGENT_MODELS.has(value.trim())) {
    throw new Error(`Unsupported AGY subagent model "${value}"; expected flash_lite, flash, pro, or inherit`);
  }
  return value.trim();
}

function parseManualAgySnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const recordedAt = Date.parse(raw.recorded_at);
  if (!Number.isFinite(recordedAt)) return null;
  const parsePct = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? round2(v) : null;
  const parseIso = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null;
  return {
    recorded_at: new Date(recordedAt).toISOString(),
    weekly_used_percent: parsePct(raw.weekly_used_percent),
    weekly_resets_at: parseIso(raw.weekly_resets_at),
    five_hour_used_percent: parsePct(raw.five_hour_used_percent),
    five_hour_resets_at: parseIso(raw.five_hour_resets_at)
  };
}

function defaultPolicy() {
  return {
    schema: 1,
    default_mode: 'auto',
    projects: {},
    pacing: { ...DEFAULT_PACING },
    agy_pacing: { ...DEFAULT_AGY_PACING },
    agy_guard: { ...DEFAULT_AGY_GUARD },
    agy_tiers: { ...DEFAULT_AGY_TIERS },
    agy_host_models: { standard: null, complex: null, expert: null },
    subagent_default_model: 'flash',
    subagent_research_model: 'flash_lite',
    enforce_subagent_low_cost: true,
    thinking_models: { general: null, quant: null },
    agy_quota_hint: 'normal',
    agy_manual_snapshot: null,
    agy_quota_command: null,
    cache_ttl_seconds: 60,
    cooldowns: { codex: null, agy: null },
    updated_at: null
  };
}

function parseCooldown(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const untilMs = Date.parse(value.until);
  if (!Number.isFinite(untilMs)) return null;
  return { until: new Date(untilMs).toISOString(), reason: String(value.reason || 'cooldown').slice(0, 300) };
}

function parsePolicy(raw) {
  const base = defaultPolicy();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const policy = { ...base };
  if (raw.default_mode !== undefined) policy.default_mode = normalizeMode(raw.default_mode, base.default_mode);
  if (raw.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects)) {
    const projects = {};
    for (const [root, entry] of Object.entries(raw.projects)) {
      if (!root || typeof root !== 'string') continue;
      if (typeof entry === 'string') {
        projects[root] = { mode: normalizeMode(entry) };
      } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
        const next = {};
        if (entry.mode !== undefined) next.mode = normalizeMode(entry.mode);
        if (typeof entry.thinking_model === 'string' && entry.thinking_model.trim()) next.thinking_model = entry.thinking_model.trim().slice(0, 120);
        if (entry.review_category && ['general', 'quant'].includes(entry.review_category)) next.review_category = entry.review_category;
        if (entry.subagent_default_model !== undefined) next.subagent_default_model = normalizeSubagentModel(entry.subagent_default_model, base.subagent_default_model);
        if (entry.enforce_subagent_low_cost !== undefined) next.enforce_subagent_low_cost = Boolean(entry.enforce_subagent_low_cost);
        if (typeof entry.agy_review_gate === 'string' && REVIEW_GATES.has(entry.agy_review_gate.trim().toLowerCase())) {
          next.agy_review_gate = entry.agy_review_gate.trim().toLowerCase();
        }
        projects[root] = next;
      }
    }
    policy.projects = projects;
  }
  if (raw.pacing && typeof raw.pacing === 'object' && !Array.isArray(raw.pacing)) {
    const p = { ...base.pacing };
    if (raw.pacing.plan_days === null) p.plan_days = null;
    else if (typeof raw.pacing.plan_days === 'number' && Number.isFinite(raw.pacing.plan_days) && raw.pacing.plan_days >= 1 && raw.pacing.plan_days <= 30) {
      p.plan_days = round2(raw.pacing.plan_days);
    }
    for (const [k, min, max] of [
      ['target_utilization', 10, 100],
      ['codex_priority_margin', -50, 20],
      ['balanced_upper_margin', -10, 50],
      ['agy_priority_used_percent', 50, 100],
      ['codex_protect_used_percent', 60, 100],
      ['drain_window_hours', 0, 72],
      ['drain_min_remaining_percent', 1, 80]
    ]) {
      if (typeof raw.pacing[k] === 'number' && Number.isFinite(raw.pacing[k]) && raw.pacing[k] >= min && raw.pacing[k] <= max) {
        p[k] = raw.pacing[k];
      }
    }
    if (p.balanced_upper_margin < p.codex_priority_margin) p.balanced_upper_margin = p.codex_priority_margin;
    if (p.codex_protect_used_percent < p.agy_priority_used_percent) p.codex_protect_used_percent = p.agy_priority_used_percent;
    policy.pacing = p;
  }
  if (raw.agy_pacing && typeof raw.agy_pacing === 'object' && !Array.isArray(raw.agy_pacing)) {
    const ap = { ...base.agy_pacing };
    for (const [k, min, max] of [
      ['target_utilization', 10, 100],
      ['window_minutes', 60, 43200],
      ['window_5h_minutes', 30, 1440],
      ['dual_compare_margin', 0, 40],
      ['window_5h_caution_percent', 30, 99],
      ['window_5h_protect_percent', 40, 100],
      ['weekly_protect_used_percent', 60, 100],
      ['drain_window_hours', 0, 72],
      ['drain_min_remaining_percent', 1, 80]
    ]) {
      if (typeof raw.agy_pacing[k] === 'number' && Number.isFinite(raw.agy_pacing[k]) && raw.agy_pacing[k] >= min && raw.agy_pacing[k] <= max) {
        ap[k] = raw.agy_pacing[k];
      }
    }
    if (ap.window_5h_protect_percent < ap.window_5h_caution_percent) ap.window_5h_protect_percent = ap.window_5h_caution_percent;
    for (const k of ['window_5h_tokens', 'window_7d_tokens']) {
      if (raw.agy_pacing[k] === null) ap[k] = null;
      else if (typeof raw.agy_pacing[k] === 'number' && Number.isFinite(raw.agy_pacing[k]) && raw.agy_pacing[k] > 0) ap[k] = Math.floor(raw.agy_pacing[k]);
    }
    if (raw.agy_pacing.weekly_resets_at === null) ap.weekly_resets_at = null;
    else if (typeof raw.agy_pacing.weekly_resets_at === 'string' && Number.isFinite(Date.parse(raw.agy_pacing.weekly_resets_at))) {
      ap.weekly_resets_at = new Date(Date.parse(raw.agy_pacing.weekly_resets_at)).toISOString();
    }
    policy.agy_pacing = ap;
  }
  if (raw.agy_guard && typeof raw.agy_guard === 'object' && !Array.isArray(raw.agy_guard)) {
    const ag = { ...base.agy_guard };
    if (typeof raw.agy_guard.max_same_error_failures === 'number' && Number.isFinite(raw.agy_guard.max_same_error_failures) && raw.agy_guard.max_same_error_failures >= 0 && raw.agy_guard.max_same_error_failures <= 20) {
      ag.max_same_error_failures = Math.floor(raw.agy_guard.max_same_error_failures);
    }
    if (typeof raw.agy_guard.max_consecutive_failures === 'number' && Number.isFinite(raw.agy_guard.max_consecutive_failures) && raw.agy_guard.max_consecutive_failures >= 0 && raw.agy_guard.max_consecutive_failures <= 50) {
      ag.max_consecutive_failures = Math.floor(raw.agy_guard.max_consecutive_failures);
    }
    if (typeof raw.agy_guard.review_gate === 'string' && REVIEW_GATES.has(raw.agy_guard.review_gate.trim().toLowerCase())) {
      ag.review_gate = raw.agy_guard.review_gate.trim().toLowerCase();
    }
    if (typeof raw.agy_guard.review_valid_hours === 'number' && Number.isFinite(raw.agy_guard.review_valid_hours) && raw.agy_guard.review_valid_hours >= 1 && raw.agy_guard.review_valid_hours <= 168) {
      ag.review_valid_hours = raw.agy_guard.review_valid_hours;
    }
    if (typeof raw.agy_guard.quota_error_cooldown_minutes === 'number' && Number.isFinite(raw.agy_guard.quota_error_cooldown_minutes) && raw.agy_guard.quota_error_cooldown_minutes >= 1 && raw.agy_guard.quota_error_cooldown_minutes <= 300) {
      ag.quota_error_cooldown_minutes = Math.floor(raw.agy_guard.quota_error_cooldown_minutes);
    }
    policy.agy_guard = ag;
  }
  if (raw.agy_tiers && typeof raw.agy_tiers === 'object' && !Array.isArray(raw.agy_tiers)) {
    const tiers = { ...base.agy_tiers };
    for (const tier of ['simple', 'standard', 'complex', 'expert']) {
      if (raw.agy_tiers[tier] !== undefined) tiers[tier] = normalizeSubagentModel(raw.agy_tiers[tier], tiers[tier]);
    }
    policy.agy_tiers = tiers;
  }
  if (raw.agy_host_models && typeof raw.agy_host_models === 'object' && !Array.isArray(raw.agy_host_models)) {
    const hostModels = { ...base.agy_host_models };
    for (const tier of ['standard', 'complex', 'expert']) {
      if (raw.agy_host_models[tier] === null || raw.agy_host_models[tier] === '') hostModels[tier] = null;
      else if (typeof raw.agy_host_models[tier] === 'string' && raw.agy_host_models[tier].trim()) {
        hostModels[tier] = raw.agy_host_models[tier].trim().slice(0, 120);
      }
    }
    policy.agy_host_models = hostModels;
  }
  if (raw.subagent_default_model !== undefined) policy.subagent_default_model = normalizeSubagentModel(raw.subagent_default_model, base.subagent_default_model);
  if (raw.subagent_research_model !== undefined) policy.subagent_research_model = normalizeSubagentModel(raw.subagent_research_model, base.subagent_research_model);
  if (raw.enforce_subagent_low_cost !== undefined) policy.enforce_subagent_low_cost = Boolean(raw.enforce_subagent_low_cost);
  if (raw.thinking_models && typeof raw.thinking_models === 'object' && !Array.isArray(raw.thinking_models)) {
    policy.thinking_models = {
      general: typeof raw.thinking_models.general === 'string' && raw.thinking_models.general.trim() ? raw.thinking_models.general.trim().slice(0, 120) : null,
      quant: typeof raw.thinking_models.quant === 'string' && raw.thinking_models.quant.trim() ? raw.thinking_models.quant.trim().slice(0, 120) : null
    };
  }
  if (typeof raw.agy_quota_hint === 'string' && AGY_HINTS.has(raw.agy_quota_hint.trim().toLowerCase())) {
    policy.agy_quota_hint = raw.agy_quota_hint.trim().toLowerCase();
  }
  policy.agy_manual_snapshot = parseManualAgySnapshot(raw.agy_manual_snapshot);
  if (Array.isArray(raw.agy_quota_command) && raw.agy_quota_command.length > 0 && raw.agy_quota_command.every(v => typeof v === 'string' && v.trim())) {
    policy.agy_quota_command = raw.agy_quota_command.slice(0, 16);
  }
  if (typeof raw.cache_ttl_seconds === 'number' && Number.isFinite(raw.cache_ttl_seconds) && raw.cache_ttl_seconds >= 0 && raw.cache_ttl_seconds <= 3600) {
    policy.cache_ttl_seconds = Math.floor(raw.cache_ttl_seconds);
  }
  if (raw.cooldowns && typeof raw.cooldowns === 'object' && !Array.isArray(raw.cooldowns)) {
    policy.cooldowns = {
      codex: parseCooldown(raw.cooldowns.codex),
      agy: parseCooldown(raw.cooldowns.agy)
    };
  }
  if (typeof raw.updated_at === 'string') policy.updated_at = raw.updated_at;
  return policy;
}

function defaultPolicyPath(settings, env = process.env) {
  const explicit = settings?.routing_config_file || env?.CODEX_EXECUTOR_ROUTING_CONFIG;
  if (explicit) return path.resolve(explicit);
  const dataRoot = settings?.data || settings?.projects?.[0]?.data;
  if (!dataRoot) return null;
  const parent = path.dirname(path.resolve(dataRoot));
  const shared = path.join(parent, 'routing-policy.json');
  if (fs.existsSync(shared)) return shared;
  const local = path.join(path.resolve(dataRoot), 'routing-policy.json');
  if (fs.existsSync(local)) return local;
  return shared;
}

function defaultQuotaCachePath(policyPath, settings) {
  if (policyPath) return path.join(path.dirname(policyPath), 'quota-cache.json');
  const dataRoot = settings?.data || settings?.projects?.[0]?.data;
  return dataRoot ? path.join(path.resolve(dataRoot), 'quota-cache.json') : null;
}

function saveAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; }
    catch (error) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 9) {
        try { fs.unlinkSync(tmp); } catch {}
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

function loadRoutingPolicy(policyPath, options = {}) {
  const fallbackMode = options.defaultMode ? normalizeMode(options.defaultMode) : 'auto';
  if (!policyPath || !fs.existsSync(policyPath)) {
    return { ...defaultPolicy(), default_mode: fallbackMode, source: 'default', path: policyPath || null };
  }
  try {
    const parsed = parsePolicy(JSON.parse(fs.readFileSync(policyPath, 'utf8')));
    return { ...parsed, source: 'file', path: policyPath };
  } catch (error) {
    return { ...defaultPolicy(), default_mode: fallbackMode, source: 'fallback_after_error', path: policyPath, load_error: error.message };
  }
}

function saveRoutingPolicy(policyPath, policy) {
  const normalized = parsePolicy(policy);
  normalized.updated_at = new Date().toISOString();
  saveAtomic(policyPath, normalized);
  return { ...normalized, source: 'file', path: policyPath };
}

function resolveProjectPolicy(policy, projectScope) {
  const base = parsePolicy(policy);
  const projectRoot = typeof projectScope === 'string' ? projectScope : projectScope?.project;
  let override = null;
  if (projectRoot) {
    const resolvedRoot = safeReal(projectRoot);
    for (const [key, value] of Object.entries(base.projects || {})) {
      if (samePath(safeReal(key), resolvedRoot)) { override = value; break; }
    }
  }
  const reviewCategory = override?.review_category || projectScope?.review_category || 'general';
  const thinkingModel = override?.thinking_model || (reviewCategory === 'quant' ? base.thinking_models.quant : base.thinking_models.general) || null;
  return {
    mode: override?.mode || base.default_mode,
    mode_source: override?.mode ? 'project_override' : 'default_mode',
    review_category: reviewCategory,
    thinking_model: thinkingModel,
    agy_tiers: { ...base.agy_tiers },
    agy_host_models: { ...base.agy_host_models },
    subagent_default_model: override?.subagent_default_model || base.subagent_default_model,
    subagent_research_model: base.subagent_research_model,
    enforce_subagent_low_cost: override?.enforce_subagent_low_cost ?? base.enforce_subagent_low_cost,
    pacing: { ...base.pacing },
    agy_pacing: { ...base.agy_pacing },
    agy_guard: { ...base.agy_guard, ...(override?.agy_review_gate ? { review_gate: override.agy_review_gate } : {}) },
    agy_quota_hint: base.agy_quota_hint,
    agy_manual_snapshot: base.agy_manual_snapshot ? { ...base.agy_manual_snapshot } : null,
    agy_quota_command: base.agy_quota_command,
    cache_ttl_seconds: base.cache_ttl_seconds,
    cooldowns: { ...base.cooldowns }
  };
}

function evaluateCodexPacing(rateLimitReply, pacingCfg = DEFAULT_PACING, nowMs = Date.now()) {
  const cfg = { ...DEFAULT_PACING, ...(pacingCfg || {}) };
  const limits = rateLimitReply?.rateLimits || rateLimitReply?.rateLimitsByLimitId?.codex || null;
  const primary = limits?.primary || null;
  if (!primary || typeof primary.usedPercent !== 'number' || typeof primary.windowDurationMins !== 'number' || primary.windowDurationMins <= 0 || typeof primary.resetsAt !== 'number') {
    return { available: false, reason: 'Codex rate-limit primary window unavailable' };
  }
  const windowMs = primary.windowDurationMins * 60 * 1000;
  const resetsAtMs = primary.resetsAt * 1000;
  const remainingMs = Math.max(0, resetsAtMs - nowMs);
  const elapsedMs = clamp(windowMs - remainingMs, 0, windowMs);
  const hoursUntilReset = round2(remainingMs / 3600000);
  const windowElapsedPercent = round2((elapsedMs / windowMs) * 100);
  const planDays = typeof cfg.plan_days === 'number' && cfg.plan_days > 0 ? cfg.plan_days : null;
  const planWindowMs = planDays ? Math.min(windowMs, planDays * 24 * 3600 * 1000) : windowMs;
  const effectivePlanDays = round2(planWindowMs / (24 * 3600 * 1000));
  const elapsedRatio = clamp(elapsedMs / planWindowMs, 0, 1);
  const elapsedPercent = round2(elapsedRatio * 100);
  const targetUsedPercent = round2(elapsedRatio * cfg.target_utilization);
  const usedPercent = round2(clamp(primary.usedPercent, 0, 100));
  const remainingPercent = round2(Math.max(0, 100 - usedPercent));
  const pacingDelta = round2(usedPercent - targetUsedPercent);
  const hardLimited = rateLimitReply?.ordinaryUsageAllowed === false
    || Boolean(limits?.rateLimitReachedType)
    || limits?.spendControlReached === true;

  let band;
  if (hardLimited || usedPercent >= cfg.codex_protect_used_percent) band = 'codex_protected';
  else if (hoursUntilReset > 0 && hoursUntilReset <= cfg.drain_window_hours && remainingPercent >= cfg.drain_min_remaining_percent) band = 'codex_drain';
  else if (usedPercent >= cfg.agy_priority_used_percent || pacingDelta > cfg.balanced_upper_margin) band = 'agy_priority';
  else if (pacingDelta > cfg.codex_priority_margin) band = 'balanced';
  else band = 'codex_priority';

  const resetCredits = rateLimitReply?.rateLimitResetCredits;
  const nextCreditExpiry = Array.isArray(resetCredits?.credits)
    ? resetCredits.credits.map(c => Number(c?.expiresAt)).filter(Number.isFinite).sort((a, b) => a - b)[0] || null
    : null;

  return {
    available: true,
    plan_type: limits.planType || null,
    ordinary_usage_allowed: rateLimitReply?.ordinaryUsageAllowed ?? null,
    hard_limited: hardLimited,
    rate_limit_reached_type: limits.rateLimitReachedType || null,
    window_minutes: primary.windowDurationMins,
    plan_days: effectivePlanDays,
    window_elapsed_percent: windowElapsedPercent,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    elapsed_percent: elapsedPercent,
    target_used_percent: targetUsedPercent,
    pacing_delta: pacingDelta,
    resets_at: new Date(resetsAtMs).toISOString(),
    hours_until_reset: hoursUntilReset,
    band,
    credits: limits.credits ? {
      has_credits: Boolean(limits.credits.hasCredits),
      unlimited: Boolean(limits.credits.unlimited),
      balance: limits.credits.balance ?? null
    } : null,
    reset_credits_available: Number(resetCredits?.availableCount || 0),
    reset_credit_earliest_expiry: nextCreditExpiry ? new Date(nextCreditExpiry * 1000).toISOString() : null
  };
}

function advanceResetAnchor(resetMs, windowMs, nowMs) {
  if (!Number.isFinite(resetMs) || !Number.isFinite(windowMs) || windowMs <= 0) return null;
  let next = resetMs;
  while (next <= nowMs) next += windowMs;
  return next;
}

function evaluateAgyPacing({ agyUsage, agyExternal, projectPolicy, codexPacing, nowMs = Date.now() }) {
  const cfg = { ...DEFAULT_AGY_PACING, ...(projectPolicy?.agy_pacing || {}) };
  const snapshot = projectPolicy?.agy_manual_snapshot || null;
  const snapshotAgeMs = snapshot ? nowMs - Date.parse(snapshot.recorded_at) : Infinity;
  const valid5hSnapshot = snapshot && snapshot.five_hour_used_percent !== null && (
    snapshot.five_hour_resets_at ? Date.parse(snapshot.five_hour_resets_at) > nowMs : snapshotAgeMs <= cfg.window_5h_minutes * 60000
  );
  const valid7dSnapshot = snapshot && snapshot.weekly_used_percent !== null && (
    snapshot.weekly_resets_at ? Date.parse(snapshot.weekly_resets_at) > nowMs : snapshotAgeMs <= 24 * 3600000
  );

  // 1. Evaluate AGY 5-hour window guard (hard/caution)
  let fiveHourUsed = null;
  let fiveHourSource = 'local_transcripts';
  let fiveHourResetsAt = null;
  let fiveHourHoursLeft = null;

  if (agyExternal?.available && agyExternal.five_hour_used_percent !== null && agyExternal.five_hour_used_percent !== undefined) {
    fiveHourUsed = round2(clamp(agyExternal.five_hour_used_percent, 0, 100));
    fiveHourSource = agyExternal.source || 'external_probe';
    fiveHourResetsAt = agyExternal.five_hour_resets_at || null;
  } else if (valid5hSnapshot) {
    fiveHourUsed = round2(clamp(snapshot.five_hour_used_percent, 0, 100));
    fiveHourSource = 'manual_snapshot';
    fiveHourResetsAt = snapshot.five_hour_resets_at || null;
  } else if (cfg.window_5h_tokens && agyUsage?.available && typeof agyUsage.window_5h?.total_tokens === 'number') {
    fiveHourUsed = round2(clamp((agyUsage.window_5h.total_tokens / cfg.window_5h_tokens) * 100, 0, 100));
    fiveHourSource = 'local_token_budget';
  }
  if (fiveHourResetsAt) {
    const ms = Date.parse(fiveHourResetsAt);
    if (Number.isFinite(ms)) fiveHourHoursLeft = round2(Math.max(0, (ms - nowMs) / 3600000));
  }

  const agyCooling = cooldownActive(projectPolicy?.cooldowns?.agy, nowMs);
  const guardCooling = cooldownActive(projectPolicy?.guard_quota_cooldown, nowMs);
  const recentQuotaErr = agyUsage?.auto_degraded === true || guardCooling;
  const hintLow = projectPolicy?.agy_quota_hint === 'low';
  let status5h = 'ok';
  let reason5h = null;
  if (agyCooling) { status5h = 'limited'; reason5h = 'agy_manual_cooldown'; }
  else if (recentQuotaErr) { status5h = 'limited'; reason5h = 'agy_recent_429_quota_error'; }
  else if (fiveHourUsed !== null && fiveHourUsed >= cfg.window_5h_protect_percent) { status5h = 'limited'; reason5h = 'agy_5h_window_protected'; }
  else if (hintLow) { status5h = 'limited'; reason5h = 'agy_hint_low'; }
  else if (fiveHourUsed !== null && fiveHourUsed >= cfg.window_5h_caution_percent) { status5h = 'caution'; reason5h = 'agy_5h_window_caution'; }

  const window5h = {
    source: fiveHourSource,
    window_minutes: cfg.window_5h_minutes,
    used_percent: fiveHourUsed,
    remaining_percent: fiveHourUsed !== null ? round2(Math.max(0, 100 - fiveHourUsed)) : null,
    caution_percent: cfg.window_5h_caution_percent,
    protect_percent: cfg.window_5h_protect_percent,
    resets_at: fiveHourResetsAt,
    hours_until_reset: fiveHourHoursLeft,
    tokens_5h: agyUsage?.available ? (agyUsage.window_5h?.total_tokens ?? null) : null,
    budget_tokens_5h: cfg.window_5h_tokens,
    quota_errors_5h: agyUsage?.available ? (agyUsage.quota_errors_5h ?? 0) : 0,
    auto_degraded: recentQuotaErr,
    status: status5h,
    reason: reason5h
  };

  // 2. Evaluate AGY 7-day 100% proportional pacing (symmetric to Codex)
  let weeklyUsed = null;
  let weeklySource = 'uncalibrated';
  let weeklyResetsAtMs = null;

  if (agyExternal?.available && agyExternal.weekly_used_percent !== null && agyExternal.weekly_used_percent !== undefined) {
    weeklyUsed = round2(clamp(agyExternal.weekly_used_percent, 0, 100));
    weeklySource = agyExternal.source || 'external_probe';
    if (agyExternal.weekly_resets_at && Number.isFinite(Date.parse(agyExternal.weekly_resets_at))) {
      weeklyResetsAtMs = Date.parse(agyExternal.weekly_resets_at);
    }
  } else if (valid7dSnapshot) {
    weeklyUsed = round2(clamp(snapshot.weekly_used_percent, 0, 100));
    weeklySource = 'manual_snapshot';
    if (snapshot.weekly_resets_at) weeklyResetsAtMs = Date.parse(snapshot.weekly_resets_at);
  } else if (cfg.window_7d_tokens && agyUsage?.available && typeof agyUsage.window_7d?.total_tokens === 'number') {
    weeklyUsed = round2(clamp((agyUsage.window_7d.total_tokens / cfg.window_7d_tokens) * 100, 0, 100));
    weeklySource = 'local_token_budget';
  }

  const window7dMs = cfg.window_minutes * 60 * 1000;
  if (!weeklyResetsAtMs && cfg.weekly_resets_at) {
    weeklyResetsAtMs = advanceResetAnchor(Date.parse(cfg.weekly_resets_at), window7dMs, nowMs);
  }
  if (!weeklyResetsAtMs && codexPacing?.available && codexPacing.resets_at) {
    weeklyResetsAtMs = Date.parse(codexPacing.resets_at);
  }

  let window7d;
  if (weeklyUsed !== null && Number.isFinite(weeklyResetsAtMs)) {
    const remainingMs = Math.max(0, weeklyResetsAtMs - nowMs);
    const hoursUntilReset = round2(remainingMs / 3600000);
    const elapsedRatio = clamp(1 - remainingMs / window7dMs, 0, 1);
    const elapsedPercent = round2(elapsedRatio * 100);
    const targetUsedPercent = round2(elapsedRatio * cfg.target_utilization);
    const remainingPercent = round2(Math.max(0, 100 - weeklyUsed));
    const pacingDelta = round2(weeklyUsed - targetUsedPercent);

    let band;
    if (weeklyUsed >= cfg.weekly_protect_used_percent) band = 'agy_protected';
    else if (hoursUntilReset > 0 && hoursUntilReset <= cfg.drain_window_hours && remainingPercent >= cfg.drain_min_remaining_percent) band = 'agy_drain';
    else if (pacingDelta <= -3) band = 'agy_priority';
    else if (pacingDelta <= 5) band = 'balanced';
    else band = 'codex_priority';

    window7d = {
      available: true,
      source: weeklySource,
      window_minutes: cfg.window_minutes,
      used_percent: weeklyUsed,
      remaining_percent: remainingPercent,
      elapsed_percent: elapsedPercent,
      target_used_percent: targetUsedPercent,
      pacing_delta: pacingDelta,
      resets_at: new Date(weeklyResetsAtMs).toISOString(),
      hours_until_reset: hoursUntilReset,
      tokens_7d: agyUsage?.available ? (agyUsage.window_7d?.total_tokens ?? null) : null,
      budget_tokens_7d: cfg.window_7d_tokens,
      band
    };
  } else {
    window7d = {
      available: false,
      source: 'uncalibrated',
      window_minutes: cfg.window_minutes,
      tokens_7d: agyUsage?.available ? (agyUsage.window_7d?.total_tokens ?? null) : null,
      budget_tokens_7d: cfg.window_7d_tokens,
      note: 'AGY 官方未公开剩余百分比 API；如需启用精确 AGY 7 天等比例竞比，可用 Mode.ps1 agy-quota 录入面板快照、配 agy-budget 本地预算，或挂外部只读探针。'
    };
  }

  return {
    window_5h: window5h,
    window_7d: window7d,
    limited: window5h.status === 'limited' || window7d.band === 'agy_protected',
    caution: window5h.status === 'caution'
  };
}

function inferBrainDir(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const resolved = path.resolve(transcriptPath);
  const parts = resolved.split(path.sep);
  const idx = parts.findIndex(segment => segment.toLowerCase() === 'brain');
  if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
  return null;
}

const QUOTA_ERROR_RE = /\b429\b|resource_exhausted|quota\s*(?:exceeded|exhausted|limit|depleted)|rate[\s_-]*limit|too many requests|capacity/i;
const NON_QUOTA_ERROR_RE = /\b(?:401|403)\b|unauthenticated|invalid.*(?:api[_ -]?key|token|credential)|permission_denied|blocked by policy/i;

function isAgyQuotaError(text) {
  if (typeof text !== 'string' || !text.trim()) return false;
  return QUOTA_ERROR_RE.test(text) && !NON_QUOTA_ERROR_RE.test(text);
}

function readTailUtf8(file, maxBytes) {
  const stat = fs.statSync(file);
  if (stat.size <= maxBytes) return { text: fs.readFileSync(file, 'utf8'), truncated: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, buf.length, stat.size - buf.length);
    const raw = buf.toString('utf8');
    const nl = raw.indexOf('\n');
    return { text: nl >= 0 ? raw.slice(nl + 1) : raw, truncated: true };
  } finally { fs.closeSync(fd); }
}

function scanAgyTranscriptUsage(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const brainDir = options.brainDir || inferBrainDir(options.transcriptPath) || path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const maxFiles = options.maxFiles ?? 80;
  const maxBytesPerFile = options.maxBytesPerFile ?? (2 * 1024 * 1024);
  const cutoff7d = nowMs - 7 * 24 * 3600 * 1000;
  const cutoff5h = nowMs - 5 * 3600 * 1000;
  const recentDegradeCutoff = nowMs - 15 * 60 * 1000;

  const emptyBucket = () => ({ requests: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, total_tokens: 0, by_model: {} });
  const win5h = emptyBucket(), win7d = emptyBucket();
  if (!brainDir || !fs.existsSync(brainDir)) {
    return { available: false, source: 'local_transcripts', brain_dir: brainDir || null, reason: 'Antigravity transcript directory not found' };
  }

  const candidates = [];
  let entries = [];
  try { entries = fs.readdirSync(brainDir, { withFileTypes: true }); } catch (error) {
    return { available: false, source: 'local_transcripts', brain_dir: brainDir, reason: error.message };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(brainDir, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    try {
      const st = fs.statSync(file);
      if (st.isFile() && st.mtimeMs >= cutoff7d) candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, maxFiles);

  let quotaErrors5h = 0, latestQuotaErrorAt = null, truncatedFiles = 0;
  const addUsage = (bucket, model, inp, cache, out) => {
    const total = inp + out;
    bucket.requests += 1;
    bucket.input_tokens += inp;
    bucket.cache_read_tokens += cache;
    bucket.output_tokens += out;
    bucket.total_tokens += total;
    const key = model || 'unknown';
    if (!bucket.by_model[key]) bucket.by_model[key] = { requests: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const m = bucket.by_model[key];
    m.requests += 1; m.input_tokens += inp; m.cache_read_tokens += cache; m.output_tokens += out; m.total_tokens += total;
  };

  for (const item of selected) {
    let text, truncated;
    try { ({ text, truncated } = readTailUtf8(item.file, maxBytesPerFile)); } catch { continue; }
    if (truncated) truncatedFiles += 1;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const ts = Date.parse(row.created_at);
      if (!Number.isFinite(ts) || ts < cutoff7d || ts > nowMs + 60000) continue;
      const inp = Number.isSafeInteger(row.input_tokens) && row.input_tokens > 0 ? row.input_tokens : 0;
      const cache = Number.isSafeInteger(row.cache_read_tokens) && row.cache_read_tokens > 0 ? row.cache_read_tokens : 0;
      const out = Number.isSafeInteger(row.output_tokens) && row.output_tokens > 0 ? row.output_tokens : 0;
      if (inp > 0 || out > 0 || cache > 0) {
        addUsage(win7d, row.model, inp, cache, out);
        if (ts >= cutoff5h) addUsage(win5h, row.model, inp, cache, out);
      }
      const errText = typeof row.error === 'string' ? row.error : (row.error?.message || '');
      if (ts >= cutoff5h && isAgyQuotaError(errText)) {
        quotaErrors5h += 1;
        if (!latestQuotaErrorAt || ts > latestQuotaErrorAt) latestQuotaErrorAt = ts;
      }
    }
  }

  return {
    available: true,
    source: 'local_transcripts',
    scanned_sessions: selected.length,
    truncated_files: truncatedFiles,
    window_5h: win5h,
    window_7d: win7d,
    quota_errors_5h: quotaErrors5h,
    latest_quota_error_at: latestQuotaErrorAt ? new Date(latestQuotaErrorAt).toISOString() : null,
    auto_degraded: latestQuotaErrorAt !== null && latestQuotaErrorAt >= recentDegradeCutoff,
    note: 'Local transcript token aggregation only; Antigravity does not expose an official public remaining-quota percentage API.'
  };
}

function runExternalAgyProbe(command, options = {}) {
  if (!Array.isArray(command) || !command.length) return null;
  const timeout = options.timeoutMs ?? 5000;
  const num = v => typeof v === 'number' && Number.isFinite(v) ? round2(clamp(v, 0, 100)) : null;
  try {
    const res = spawnSync(command[0], command.slice(1), { encoding: 'utf8', windowsHide: true, timeout });
    if (res.error) return { available: false, error: res.error.message };
    if (res.status !== 0) return { available: false, error: (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 400) };
    const parsed = JSON.parse((res.stdout || '').trim());

    const legacyRemaining = num(parsed.remaining_percent);
    const fiveHourUsed = num(parsed.five_hour_used_percent)
      ?? (num(parsed.five_hour_remaining_percent) !== null ? round2(100 - num(parsed.five_hour_remaining_percent)) : null)
      ?? (legacyRemaining !== null ? round2(100 - legacyRemaining) : null);
    const weeklyUsed = num(parsed.weekly_used_percent)
      ?? (num(parsed.weekly_remaining_percent) !== null ? round2(100 - num(parsed.weekly_remaining_percent)) : null);

    if (fiveHourUsed === null && weeklyUsed === null) {
      return { available: false, error: 'Probe output missing numeric quota percent fields (remaining_percent / five_hour_used_percent / weekly_used_percent)' };
    }
    return {
      available: true,
      remaining_percent: legacyRemaining ?? (fiveHourUsed !== null ? round2(100 - fiveHourUsed) : round2(100 - weeklyUsed)),
      five_hour_used_percent: fiveHourUsed,
      five_hour_resets_at: typeof parsed.five_hour_resets_at === 'string' ? parsed.five_hour_resets_at : (typeof parsed.reset_at === 'string' ? parsed.reset_at : null),
      weekly_used_percent: weeklyUsed,
      weekly_resets_at: typeof parsed.weekly_resets_at === 'string' ? parsed.weekly_resets_at : null,
      reset_at: typeof parsed.reset_at === 'string' ? parsed.reset_at : null,
      model_group: typeof parsed.model_group === 'string' ? parsed.model_group : null,
      source: typeof parsed.source === 'string' ? parsed.source : 'external_probe'
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function activeCodexTasks(projectScope) {
  const dataRoot = typeof projectScope === 'string' ? projectScope : projectScope?.data;
  if (!dataRoot) return { count: 0, orphaned: 0, tasks: [] };
  const lockDir = path.join(dataRoot, 'active-tasks');
  if (!fs.existsSync(lockDir)) return { count: 0, orphaned: 0, tasks: [] };
  const tasks = [];
  let orphaned = 0;
  let names = [];
  try { names = fs.readdirSync(lockDir); } catch { return { count: 0, orphaned: 0, tasks: [] }; }
  for (const name of names) {
    if (!/^[a-f0-9]{24}\.json$/.test(name)) continue;
    const id = name.slice(0, -5);
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(lockDir, name), 'utf8'));
      const jobFile = path.join(dataRoot, 'jobs', id, 'job.json');
      const job = fs.existsSync(jobFile) ? JSON.parse(fs.readFileSync(jobFile, 'utf8')) : null;
      if (job && TERMINAL_STATUSES.has(job.status)) continue;
      const pid = job?.worker_pid || lease?.worker_pid;
      const pidAlive = alivePid(pid);
      if (job?.status === 'orphaned' || (pid && !pidAlive && job && Date.now() - Date.parse(job.created_at) > 15000)) {
        orphaned += 1;
        continue;
      }
      tasks.push({ job_id: id, status: job?.status || 'queued', topic: (job?.topic || '').slice(0, 80), worker_pid: pid || null });
    } catch {}
  }
  return { count: tasks.length, orphaned, tasks };
}

function cooldownActive(cooldown, nowMs = Date.now()) {
  if (!cooldown?.until) return false;
  const ts = Date.parse(cooldown.until);
  return Number.isFinite(ts) && ts > nowMs;
}

function decideRoute(input = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const policy = input.projectPolicy || resolveProjectPolicy(input.policy || defaultPolicy(), input.projectScope);
  const mode = policy.mode;
  const codexPacing = input.codexPacing || { available: false };
  const agyUsage = input.agyUsage || { available: false };
  const agyExternal = input.agyExternal || null;
  const agyPacing = input.agyPacing || evaluateAgyPacing({ agyUsage, agyExternal, projectPolicy: policy, codexPacing, nowMs });
  const activeTasks = input.activeCodexTasks || { count: 0, orphaned: 0, tasks: [] };
  const currentModelName = typeof input.modelName === 'string' ? input.modelName : '';

  const codexCooling = cooldownActive(policy.cooldowns?.codex, nowMs);
  const agy5hLimited = agyPacing.window_5h.status === 'limited';
  const agy5hCaution = agyPacing.window_5h.status === 'caution';
  const agy7dProtected = agyPacing.window_7d.band === 'agy_protected';
  const agyConstrained = agy5hLimited || agy7dProtected;
  const codexHardBlocked = codexCooling || codexPacing.hard_limited === true || codexPacing.band === 'codex_protected';
  const dualMargin = policy.agy_pacing?.dual_compare_margin ?? DEFAULT_AGY_PACING.dual_compare_margin;

  let preferredEngine = 'codex';
  let fallbackEngine = 'codex';
  let reason = 'default_codex_first';
  let agyAllowed = mode !== 'codex';
  let codexAllowed = mode !== 'agy';

  if (mode === 'codex') {
    preferredEngine = 'codex';
    fallbackEngine = null;
    reason = 'locked_codex_mode';
  } else if (mode === 'agy') {
    preferredEngine = 'agy';
    fallbackEngine = 'codex';
    reason = agy5hLimited ? 'locked_agy_mode_5h_limited_warning' : 'locked_agy_mode';
  } else {
    // Auto mode: Dual 7-day 100% proportional pacing + AGY 5h window limit + Codex fallback.
    if (agyConstrained && !codexHardBlocked) {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      reason = agy5hLimited
        ? (agyPacing.window_5h.reason === 'agy_recent_429_quota_error'
          ? 'agy_recent_quota_error_codex_fallback'
          : agyPacing.window_5h.reason === 'agy_manual_cooldown'
            ? 'agy_cooldown_codex_fallback'
            : agyPacing.window_5h.reason === 'agy_hint_low'
              ? 'agy_hint_low_codex_fallback'
              : 'agy_5h_limited_codex_fallback')
        : 'agy_7d_protected_codex_fallback';
    } else if (codexHardBlocked && !agyConstrained) {
      preferredEngine = 'agy';
      fallbackEngine = 'codex';
      reason = codexCooling ? 'codex_cooldown_route_agy' : 'codex_protected_route_agy';
    } else if (codexHardBlocked && agyConstrained) {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      reason = 'both_constrained_codex_fallback';
    } else if (!codexPacing.available) {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      reason = 'codex_quota_unavailable_codex_first';
    } else if (codexPacing.band === 'codex_drain') {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      reason = 'codex_end_of_window_drain';
    } else if (agyPacing.window_7d.available) {
      // Both sides have calibrated 7-day 100% proportional pacing:
      // route to whichever side is further behind its 7-day pace, while respecting AGY's 5h caution guard.
      if (agyPacing.window_7d.band === 'agy_drain' && !agy5hCaution) {
        preferredEngine = 'agy';
        fallbackEngine = 'codex';
        reason = 'agy_end_of_window_drain';
      } else {
        const diff = round2(codexPacing.pacing_delta - agyPacing.window_7d.pacing_delta);
        if (diff > dualMargin) {
          // Codex is ahead of AGY relative to 7-day 100% pace => prefer AGY unless AGY 5h is in caution
          if (agy5hCaution) {
            preferredEngine = 'balanced';
            fallbackEngine = 'codex';
            reason = 'dual_7d_agy_ahead_throttled_by_5h_caution';
          } else {
            preferredEngine = 'agy';
            fallbackEngine = 'codex';
            reason = 'dual_7d_agy_further_behind_pace';
          }
        } else if (diff < -dualMargin) {
          preferredEngine = 'codex';
          fallbackEngine = 'codex';
          reason = 'dual_7d_codex_further_behind_pace';
        } else {
          preferredEngine = 'balanced';
          fallbackEngine = 'codex';
          reason = 'dual_7d_on_parity_balanced';
        }
      }
    } else if (codexPacing.band === 'codex_priority') {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      reason = 'codex_below_7d_pace';
    } else if (codexPacing.band === 'balanced') {
      preferredEngine = 'balanced';
      fallbackEngine = 'codex';
      reason = 'codex_on_7d_pace_balanced';
    } else {
      if (agy5hCaution) {
        preferredEngine = 'balanced';
        fallbackEngine = 'codex';
        reason = 'codex_ahead_but_agy_5h_caution_balanced';
      } else {
        preferredEngine = 'agy';
        fallbackEngine = 'codex';
        reason = 'codex_ahead_of_7d_pace_route_agy';
      }
    }
  }

  const quantThinking = policy.review_category === 'quant' && policy.thinking_model ? policy.thinking_model : null;
  const knownHostModel = currentModelName && currentModelName.toLowerCase() !== 'auto';
  const quantModelMatched = quantThinking && knownHostModel
    ? currentModelName.toLowerCase().includes(quantThinking.toLowerCase())
    : null;

  const codexPlanLabel = codexPacing.plan_days ? `${codexPacing.plan_days}天` : '7天';
  const codexText = codexPacing.available
    ? `Codex ${codexPlanLabel}进度 ${codexPacing.elapsed_percent}% / 已用 ${codexPacing.used_percent}%（偏差 ${codexPacing.pacing_delta >= 0 ? '+' : ''}${codexPacing.pacing_delta}%，距重置 ${codexPacing.hours_until_reset}h）`
    : 'Codex 实时配额暂未读取（默认优先 Codex）';

  const agy5hText = agyPacing.window_5h.used_percent !== null
    ? `AGY 5h已用 ${agyPacing.window_5h.used_percent}%（${agyPacing.window_5h.status}）`
    : agyUsage.available && agyUsage.window_5h
      ? `AGY 近5h消耗 ${agyUsage.window_5h.total_tokens} tokens（状态=${agyPacing.window_5h.status}，限流错 ${agyUsage.quota_errors_5h ?? 0}）`
      : `AGY 5h状态=${agyPacing.window_5h.status}`;
  const agy7dText = agyPacing.window_7d.available
    ? `AGY 7天进度 ${agyPacing.window_7d.elapsed_percent}% / 已用 ${agyPacing.window_7d.used_percent}%（偏差 ${agyPacing.window_7d.pacing_delta >= 0 ? '+' : ''}${agyPacing.window_7d.pacing_delta}%）`
    : `AGY 7天未标定（按本地5h+Codex${codexPlanLabel}均衡）`;

  const engineLabel = preferredEngine === 'codex' ? '优先 Codex（Codex 兜底）'
    : preferredEngine === 'balanced' ? 'Codex 与 AGY 混合均衡（Codex 兜底）'
    : '优先 AGY 低成本多子代理（Codex 兜底）';

  const summaryLine = `模式=${mode}｜路由=${engineLabel}｜${codexText}｜${agy7dText}｜${agy5hText}${activeTasks.count ? `｜在途Codex任务=${activeTasks.count}` : ''}`;

  return {
    mode,
    mode_source: policy.mode_source,
    preferred_engine: preferredEngine,
    fallback_engine: fallbackEngine,
    agy_allowed: agyAllowed,
    codex_allowed: codexAllowed,
    reason,
    codex_pacing: codexPacing,
    agy_pacing: agyPacing,
    agy_usage: agyUsage,
    agy_external: agyExternal,
    agy_constrained: agyConstrained,
    agy_5h_limited: agy5hLimited,
    agy_5h_caution: agy5hCaution,
    codex_hard_blocked: codexHardBlocked,
    active_codex_tasks: activeTasks,
    agy_tiers: policy.agy_tiers,
    agy_host_models: policy.agy_host_models,
    subagent_defaults: {
      default_model: policy.subagent_default_model,
      research_model: policy.subagent_research_model,
      enforce_low_cost: policy.enforce_subagent_low_cost
    },
    thinking_guidance: {
      review_category: policy.review_category,
      required_thinking_model: quantThinking || policy.thinking_model || null,
      current_model_name: currentModelName || null,
      matches_required: quantModelMatched,
      reminder: quantThinking && quantModelMatched === false
        ? `当前为量化研究项目，建议将主会话模型切换为本机配置的 ${quantThinking} 最强思考模式；日常检索、改脚本与跑测试下沉给低成本子代理或 Codex。`
        : quantThinking
          ? `量化策略研究默认使用本机配置的 ${quantThinking} 最强模式思考，核心思考子任务保留 inherit 不降级；执行与检索下沉低成本档位。`
          : null
    },
    task_allocation: {
      quant_strategy_thinking: quantThinking ? `主会话 ${quantThinking} 最强思考 + Codex quant 独立只读审核` : '主会话最强思考 + Codex quant 独立只读审核',
      long_background_jobs: '优先 Codex（受控 waiting_background 独立托管与断点恢复）',
      simple_mechanical_tasks: codexHardBlocked
        ? `AGY 轻量执行 (${policy.agy_tiers.simple}，复用同子代理保缓存；当前 Codex 处于保护线)`
        : `优先 Codex simple（单位成本最低）；需省 Codex 额度或并行调研时用 AGY ${policy.agy_tiers.simple}`,
      read_only_parallel_exploration: agy5hLimited
        ? 'Codex simple（当前 AGY 5h 受限，由 Codex 兜底）'
        : `AGY research 子代理 (${policy.agy_tiers.simple}) 或 Codex simple`,
      routine_implementation_and_tests: preferredEngine === 'agy'
        ? `优先 AGY 子代理 (${policy.agy_tiers.standard}，同模块通过 send_message 长期复用保缓存${policy.agy_host_models?.standard ? `；主对话直做可切 ${policy.agy_host_models.standard}` : ''})，AGY 5h 吃紧或 429 时立即由 Codex standard 兜底`
        : preferredEngine === 'balanced'
          ? `Codex standard 与 AGY 子代理 (${policy.agy_tiers.standard}，send_message 复用保缓存${policy.agy_host_models?.standard ? ` / 主对话 ${policy.agy_host_models.standard}` : ''}) 混合分流，防 AGY 5h 撞墙，Codex 兜底`
          : `优先 Codex standard（Codex 兜底），AGY 5h 宽裕时可辅助只读并行`,
      complex_architecture_or_debugging: preferredEngine === 'agy'
        ? `AGY 子代理 (${policy.agy_tiers.complex}${policy.agy_host_models?.complex ? ` / 主对话 ${policy.agy_host_models.complex}` : ''})，必要时 Codex complex 兜底`
        : `优先 Codex complex`
    },
    summary_line: summaryLine
  };
}

const QUANT_THINKING_RE = /量化策略|策略研究|策略设计|因子逻辑|因子设计|归因分析|多因子架构|quant(?:itative)?\s*(?:strategy|research|design|alpha)|alpha\s*research/i;
const MECHANICAL_SUBTASK_RE = /清洗|下载|批量扫描|日志核查|跑单测|单元测试|格式检查|lint|format|refactor\s*rename/i;
const EXPLICIT_UPGRADE_RE = /\b(?:expert|complex|pro)\b|最强思考|极难|深度推理/i;

function matchesConfiguredThinkingModel(text, thinkingModel) {
  if (!thinkingModel || typeof text !== 'string') return false;
  return text.toLowerCase().includes(thinkingModel.toLowerCase());
}

function evaluateSubagentCall(args = {}, projectPolicy) {
  const typeName = String(args.TypeName || args.typeName || args.type_name || 'self').trim().toLowerCase();
  const modelKey = Object.hasOwn(args, 'Model') ? 'Model' : Object.hasOwn(args, 'model') ? 'model' : 'Model';
  const currentModel = typeof args[modelKey] === 'string' ? args[modelKey].trim() : '';
  const roleAndPrompt = [args.Role, args.role, args.Prompt, args.prompt].filter(Boolean).join('\n');

  if (typeName === 'image-generator') return { overwrite: null, note: null };
  if (typeName === 'browser') {
    if (!currentModel) return { overwrite: { [modelKey]: 'flash' }, note: '浏览器子代理默认使用 flash。' };
    return { overwrite: null, note: null };
  }

  const isQuantThinking = projectPolicy.review_category === 'quant'
    && (QUANT_THINKING_RE.test(roleAndPrompt) || matchesConfiguredThinkingModel(roleAndPrompt, projectPolicy.thinking_model))
    && !MECHANICAL_SUBTASK_RE.test(args.Role || args.role || '');

  if (isQuantThinking && (currentModel === 'inherit' || currentModel === 'pro')) {
    return { overwrite: null, note: '量化策略核心思考子任务保留原高思考档位，不降级。' };
  }

  if (typeName === 'research') {
    const target = projectPolicy.subagent_research_model || 'flash_lite';
    if (!currentModel || (projectPolicy.enforce_subagent_low_cost && currentModel === 'inherit' && !isQuantThinking)) {
      return { overwrite: { [modelKey]: target }, note: `只读 research 子代理默认路由至低成本 ${target}。` };
    }
    return { overwrite: null, note: null };
  }

  const defaultExec = projectPolicy.subagent_default_model || 'flash';
  if (!currentModel) {
    return { overwrite: { [modelKey]: defaultExec }, note: `AGY 执行子代理未指定模型，自动路由至低成本 ${defaultExec}。` };
  }
  if (projectPolicy.enforce_subagent_low_cost && currentModel === 'inherit' && !isQuantThinking && !EXPLICIT_UPGRADE_RE.test(roleAndPrompt) && !matchesConfiguredThinkingModel(roleAndPrompt, projectPolicy.thinking_model)) {
    return { overwrite: { [modelKey]: defaultExec }, note: `为避免普通子任务误继承高配主模型，自动降档为低成本 ${defaultExec}（如需升级请显式指定 pro 或在提示中说明复杂/量化思考）。` };
  }
  return { overwrite: null, note: null };
}

function readQuotaCache(cachePath, ttlSeconds = 60, nowMs = Date.now()) {
  if (!cachePath || ttlSeconds <= 0 || !fs.existsSync(cachePath)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const fetchedAt = Date.parse(doc.fetched_at);
    if (!Number.isFinite(fetchedAt) || nowMs - fetchedAt > ttlSeconds * 1000) return null;
    return doc;
  } catch { return null; }
}

function writeQuotaCache(cachePath, payload) {
  if (!cachePath) return;
  try { saveAtomic(cachePath, { ...payload, fetched_at: new Date().toISOString() }); } catch {}
}

module.exports = {
  MODE_ALIASES,
  DEFAULT_PACING,
  DEFAULT_AGY_PACING,
  DEFAULT_AGY_GUARD,
  DEFAULT_AGY_TIERS,
  normalizeMode,
  normalizeSubagentModel,
  defaultPolicy,
  parsePolicy,
  defaultPolicyPath,
  defaultQuotaCachePath,
  loadRoutingPolicy,
  saveRoutingPolicy,
  resolveProjectPolicy,
  evaluateCodexPacing,
  evaluateAgyPacing,
  scanAgyTranscriptUsage,
  runExternalAgyProbe,
  activeCodexTasks,
  cooldownActive,
  decideRoute,
  evaluateSubagentCall,
  readQuotaCache,
  writeQuotaCache,
  isAgyQuotaError,
  saveAtomic
};
