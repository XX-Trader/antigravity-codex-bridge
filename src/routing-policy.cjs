'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

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
  drain_min_remaining_percent: 10,
  ahead_max_concurrent: 3,        // Throttle Codex concurrency in auto mode when ahead of pace or >= 85%
  high_max_concurrent: 2,         // Tighter cap when >= 92% used
  protect_max_concurrent: 1       // Hard cap at >= 97% used so sticky continuations cannot stampede last 3%
});

const DEFAULT_AGY_PACING = Object.freeze({
  target_utilization: 90,         // Consume up to 90% of AGY weekly quota, reserving 10% emergency buffer
  window_minutes: 10080,          // 7-day weekly quota window
  window_5h_minutes: 300,         // AGY 5-hour rolling/refresh limit window
  dual_compare_margin: 5,         // |delta_codex - delta_agy| <= 5% => balanced
  window_5h_caution_percent: 75,  // AGY 5h >= 75% => throttle to balanced to avoid hitting 5h wall
  window_5h_protect_percent: 88,  // AGY 5h >= 88% => AGY 5h limited (keeps 12% 5h buffer), Codex takes over as fallback
  weekly_protect_used_percent: 90,// Hard reserve 10% weekly buffer for sudden burst usage
  buffer_unlock_window_hours: 6,  // Auto-unlock reserved 10% buffer within final 6h before weekly reset
  drain_window_hours: 12,
  drain_min_remaining_percent: 10,// Only drain when >= 10% usable headroom remains below target_utilization
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

function normalizeOptionalResetIso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  // Upstream quota APIs (e.g. `agy /usage`) emit epoch-zero (`ms === 0`) when a bucket
  // has 0% usage and its rolling/weekly window has not activated yet.
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function parseManualAgySnapshot(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const recordedAt = Date.parse(raw.recorded_at);
  if (!Number.isFinite(recordedAt) || recordedAt <= 0) return null;
  const parsePct = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? round2(v) : null;
  return {
    recorded_at: new Date(recordedAt).toISOString(),
    weekly_used_percent: parsePct(raw.weekly_used_percent),
    weekly_resets_at: normalizeOptionalResetIso(raw.weekly_resets_at),
    five_hour_used_percent: parsePct(raw.five_hour_used_percent),
    five_hour_resets_at: normalizeOptionalResetIso(raw.five_hour_resets_at)
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
    agy_model_pools: {},
    subagent_default_model: 'flash',
    subagent_research_model: 'flash_lite',
    enforce_subagent_low_cost: true,
    thinking_models: { general: null, quant: null, backups: [] },
    agy_quota_hint: 'normal',
    agy_manual_snapshot: null,
    agy_quota_command: null,
    agy_probe_home: null,
    apply_to_unregistered_projects: false,
    cache_ttl_seconds: 300,
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
    for (const k of ['ahead_max_concurrent', 'high_max_concurrent', 'protect_max_concurrent']) {
      if (raw.pacing[k] === null) p[k] = null;
      else if (typeof raw.pacing[k] === 'number' && Number.isFinite(raw.pacing[k]) && raw.pacing[k] >= 1 && raw.pacing[k] <= 50) {
        p[k] = Math.floor(raw.pacing[k]);
      }
    }
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
      ['buffer_unlock_window_hours', 0, 72],
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
    else if (typeof raw.agy_pacing.weekly_resets_at === 'string') {
      ap.weekly_resets_at = normalizeOptionalResetIso(raw.agy_pacing.weekly_resets_at);
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
  if (raw.agy_model_pools && typeof raw.agy_model_pools === 'object' && !Array.isArray(raw.agy_model_pools)) {
    const pools = {};
    for (const [rawName, cfg] of Object.entries(raw.agy_model_pools)) {
      const name = String(rawName || '').trim().toLowerCase().slice(0, 40);
      if (!name || !cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      const match = typeof cfg.match === 'string' && cfg.match.trim() ? cfg.match.trim().toLowerCase().slice(0, 80) : name;
      const weeklyProtect = typeof cfg.weekly_protect_used_percent === 'number' && Number.isFinite(cfg.weekly_protect_used_percent) && cfg.weekly_protect_used_percent >= 50 && cfg.weekly_protect_used_percent <= 100
        ? cfg.weekly_protect_used_percent : DEFAULT_AGY_PACING.weekly_protect_used_percent;
      const caution5h = typeof cfg.window_5h_caution_percent === 'number' && Number.isFinite(cfg.window_5h_caution_percent) && cfg.window_5h_caution_percent >= 30 && cfg.window_5h_caution_percent <= 99
        ? cfg.window_5h_caution_percent : DEFAULT_AGY_PACING.window_5h_caution_percent;
      const protect5hRaw = typeof cfg.window_5h_protect_percent === 'number' && Number.isFinite(cfg.window_5h_protect_percent) && cfg.window_5h_protect_percent >= 40 && cfg.window_5h_protect_percent <= 100
        ? cfg.window_5h_protect_percent : DEFAULT_AGY_PACING.window_5h_protect_percent;
      pools[name] = {
        match,
        weekly_protect_used_percent: weeklyProtect,
        buffer_unlock_window_hours: typeof cfg.buffer_unlock_window_hours === 'number' && Number.isFinite(cfg.buffer_unlock_window_hours) && cfg.buffer_unlock_window_hours >= 0 && cfg.buffer_unlock_window_hours <= 72
          ? cfg.buffer_unlock_window_hours : null,
        window_5h_caution_percent: caution5h,
        window_5h_protect_percent: Math.max(caution5h, protect5hRaw),
        window_5h_tokens: typeof cfg.window_5h_tokens === 'number' && Number.isFinite(cfg.window_5h_tokens) && cfg.window_5h_tokens > 0 ? Math.floor(cfg.window_5h_tokens) : null,
        window_7d_tokens: typeof cfg.window_7d_tokens === 'number' && Number.isFinite(cfg.window_7d_tokens) && cfg.window_7d_tokens > 0 ? Math.floor(cfg.window_7d_tokens) : null,
        bucket_5h: typeof cfg.bucket_5h === 'string' && cfg.bucket_5h.trim() ? cfg.bucket_5h.trim().slice(0, 80) : null,
        bucket_7d: typeof cfg.bucket_7d === 'string' && cfg.bucket_7d.trim() ? cfg.bucket_7d.trim().slice(0, 80) : null,
        default_model: typeof cfg.default_model === 'string' && cfg.default_model.trim() ? cfg.default_model.trim().slice(0, 120) : null,
        review_model: typeof cfg.review_model === 'string' && cfg.review_model.trim() ? cfg.review_model.trim().slice(0, 120) : null,
        manual_snapshot: parseManualAgySnapshot(cfg.manual_snapshot),
        cooldown: parseCooldown(cfg.cooldown)
      };
    }
    policy.agy_model_pools = pools;
  }
  if (raw.subagent_default_model !== undefined) policy.subagent_default_model = normalizeSubagentModel(raw.subagent_default_model, base.subagent_default_model);
  if (raw.subagent_research_model !== undefined) policy.subagent_research_model = normalizeSubagentModel(raw.subagent_research_model, base.subagent_research_model);
  if (raw.enforce_subagent_low_cost !== undefined) policy.enforce_subagent_low_cost = Boolean(raw.enforce_subagent_low_cost);
  if (raw.thinking_models && typeof raw.thinking_models === 'object' && !Array.isArray(raw.thinking_models)) {
    const rawBackups = Array.isArray(raw.thinking_models.backups) ? raw.thinking_models.backups : [];
    const backups = [...new Set(rawBackups.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim().slice(0, 120)))].slice(0, 8);
    policy.thinking_models = {
      general: typeof raw.thinking_models.general === 'string' && raw.thinking_models.general.trim() ? raw.thinking_models.general.trim().slice(0, 120) : null,
      quant: typeof raw.thinking_models.quant === 'string' && raw.thinking_models.quant.trim() ? raw.thinking_models.quant.trim().slice(0, 120) : null,
      backups
    };
  }
  if (typeof raw.agy_quota_hint === 'string' && AGY_HINTS.has(raw.agy_quota_hint.trim().toLowerCase())) {
    policy.agy_quota_hint = raw.agy_quota_hint.trim().toLowerCase();
  }
  policy.agy_manual_snapshot = parseManualAgySnapshot(raw.agy_manual_snapshot);
  if (Array.isArray(raw.agy_quota_command) && raw.agy_quota_command.length > 0 && raw.agy_quota_command.every(v => typeof v === 'string' && v.trim())) {
    policy.agy_quota_command = raw.agy_quota_command.slice(0, 16);
  }
  if (typeof raw.agy_probe_home === 'string' && raw.agy_probe_home.trim()) {
    const candidate = path.resolve(raw.agy_probe_home.trim());
    if (path.isAbsolute(candidate) && /^[\x20-\x7e]+$/.test(candidate)) {
      policy.agy_probe_home = candidate;
    }
  }
  if (raw.apply_to_unregistered_projects !== undefined) {
    policy.apply_to_unregistered_projects = Boolean(raw.apply_to_unregistered_projects);
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

function defaultTranscriptIndexPath(policyPath, settings) {
  const cachePath = defaultQuotaCachePath(policyPath, settings);
  return cachePath ? path.join(path.dirname(cachePath), 'agy-transcript-index.json') : null;
}

function takeQuotaRefreshClaim(cachePath, staleMs = 30000, nowMs = Date.now()) {
  if (!cachePath) return () => {};
  const claimFile = `${cachePath}.refresh.claim`;
  try { fs.mkdirSync(path.dirname(claimFile), { recursive: true }); } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(claimFile, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date(nowMs).toISOString() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.unlinkSync(claimFile); } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      try {
        const existing = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
        const createdMs = Date.parse(existing?.created_at);
        if (!alivePid(existing?.pid) || !Number.isFinite(createdMs) || nowMs - createdMs > staleMs) {
          fs.unlinkSync(claimFile);
          continue;
        }
      } catch {
        try {
          const st = fs.statSync(claimFile);
          if (nowMs - st.mtimeMs > staleMs) { fs.unlinkSync(claimFile); continue; }
        } catch { continue; }
      }
      return null;
    }
  }
  return null;
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
    thinking_backups: [...(base.thinking_models.backups || [])],
    agy_tiers: { ...base.agy_tiers },
    agy_host_models: { ...base.agy_host_models },
    agy_model_pools: Object.fromEntries(Object.entries(base.agy_model_pools || {}).map(([k, v]) => [k, { ...v }])),
    subagent_default_model: override?.subagent_default_model || base.subagent_default_model,
    subagent_research_model: base.subagent_research_model,
    enforce_subagent_low_cost: override?.enforce_subagent_low_cost ?? base.enforce_subagent_low_cost,
    pacing: { ...base.pacing },
    agy_pacing: { ...base.agy_pacing },
    agy_guard: { ...base.agy_guard, ...(override?.agy_review_gate ? { review_gate: override.agy_review_gate } : {}) },
    agy_quota_hint: base.agy_quota_hint,
    agy_manual_snapshot: base.agy_manual_snapshot ? { ...base.agy_manual_snapshot } : null,
    agy_quota_command: base.agy_quota_command,
    agy_probe_home: base.agy_probe_home,
    cache_ttl_seconds: base.cache_ttl_seconds,
    cooldowns: { ...base.cooldowns }
  };
}

function evaluateCodexPacing(rateLimitReply, pacingCfg = DEFAULT_PACING, nowMs = Date.now()) {
  const cfg = { ...DEFAULT_PACING, ...(pacingCfg || {}) };
  const rawLimits = rateLimitReply?.rateLimits || rateLimitReply?.rate_limits || rateLimitReply?.rateLimitsByLimitId?.codex || null;
  const rawPrimary = rawLimits?.primary || null;
  const usedRaw = rawPrimary?.usedPercent ?? rawPrimary?.used_percent;
  const winMinsRaw = rawPrimary?.windowDurationMins ?? rawPrimary?.window_minutes;
  const resetsAtRaw = rawPrimary?.resetsAt ?? rawPrimary?.resets_at;
  if (!rawPrimary || typeof usedRaw !== 'number' || !Number.isFinite(usedRaw)) {
    return { available: false, reason: 'Codex rate-limit primary window unavailable' };
  }
  const hasValidWinMins = typeof winMinsRaw === 'number' && Number.isFinite(winMinsRaw) && winMinsRaw > 0;
  if (!hasValidWinMins && usedRaw > 0) {
    return { available: false, reason: 'Codex rate-limit primary window duration unavailable' };
  }
  const winMins = hasValidWinMins ? winMinsRaw : 10080;
  const hasPositiveReset = typeof resetsAtRaw === 'number' && Number.isFinite(resetsAtRaw) && resetsAtRaw > 0;

  const limits = {
    planType: rawLimits.planType ?? rawLimits.plan_type ?? null,
    rateLimitReachedType: rawLimits.rateLimitReachedType ?? rawLimits.rate_limit_reached_type ?? null,
    spendControlReached: rawLimits.spendControlReached ?? rawLimits.spend_control_reached ?? false,
    credits: rawLimits.credits ? {
      hasCredits: Boolean(rawLimits.credits.hasCredits ?? rawLimits.credits.has_credits),
      unlimited: Boolean(rawLimits.credits.unlimited),
      balance: rawLimits.credits.balance ?? null
    } : null
  };
  const hardLimited = rateLimitReply?.ordinaryUsageAllowed === false
    || Boolean(limits?.rateLimitReachedType)
    || limits?.spendControlReached === true;

  const windowMs = winMins * 60 * 1000;
  const planDays = typeof cfg.plan_days === 'number' && cfg.plan_days > 0 ? cfg.plan_days : null;
  const planWindowMs = planDays ? Math.min(windowMs, planDays * 24 * 3600 * 1000) : windowMs;
  const effectivePlanDays = round2(planWindowMs / (24 * 3600 * 1000));

  const rawResetMs = hasPositiveReset ? resetsAtRaw * 1000 : null;
  // Special case 1: Previous cycle's reset timestamp already passed while ordinary usage is allowed => cycle rolled over to 0% unused.
  const resetAlreadyPassed = rawResetMs !== null && rawResetMs <= nowMs && !hardLimited;
  // Special case 2: Brand-new / unused cycle with null or 0 reset timestamp.
  const windowActive = Boolean(rawResetMs !== null && !resetAlreadyPassed);

  const usedPercent = resetAlreadyPassed ? 0 : round2(clamp(usedRaw, 0, 100));
  const remainingPercent = round2(Math.max(0, 100 - usedPercent));
  const exhausted = hardLimited || usedPercent >= 100;

  let hoursUntilReset = null;
  let windowElapsedPercent = 0;
  let elapsedPercent = 0;
  let targetUsedPercent = 0;
  let pacingDelta = round2(usedPercent);
  let resetsAtIso = null;

  if (windowActive) {
    const remainingMs = Math.max(0, rawResetMs - nowMs);
    const elapsedMs = clamp(windowMs - remainingMs, 0, windowMs);
    hoursUntilReset = round2(remainingMs / 3600000);
    windowElapsedPercent = round2((elapsedMs / windowMs) * 100);
    const elapsedRatio = clamp(elapsedMs / planWindowMs, 0, 1);
    elapsedPercent = round2(elapsedRatio * 100);
    targetUsedPercent = round2(elapsedRatio * cfg.target_utilization);
    pacingDelta = round2(usedPercent - targetUsedPercent);
    resetsAtIso = new Date(rawResetMs).toISOString();
  } else if (usedPercent > 0) {
    // Missing reset timestamp on a partially/fully used window: never invent elapsed progress, still enforce usage caps.
    windowElapsedPercent = null;
    elapsedPercent = null;
    targetUsedPercent = null;
    pacingDelta = null;
  }

  let band;
  if (hardLimited || usedPercent >= cfg.codex_protect_used_percent) band = 'codex_protected';
  else if (windowActive && hoursUntilReset > 0 && hoursUntilReset <= cfg.drain_window_hours && remainingPercent >= cfg.drain_min_remaining_percent) band = 'codex_drain';
  else if (usedPercent >= cfg.agy_priority_used_percent || (pacingDelta !== null && pacingDelta > cfg.balanced_upper_margin)) band = 'agy_priority';
  else if (pacingDelta === null || pacingDelta > cfg.codex_priority_margin) band = windowActive || usedPercent > 0 ? 'balanced' : 'codex_priority';
  else band = 'codex_priority';

  const resetCredits = rateLimitReply?.rateLimitResetCredits;
  const resetCreditsCount = Number(resetCredits?.availableCount || 0);
  const nextCreditExpiry = Array.isArray(resetCredits?.credits)
    ? resetCredits.credits.map(c => Number(c?.expiresAt)).filter(v => Number.isFinite(v) && v > 0).sort((a, b) => a - b)[0] || null
    : null;
  const numericBalance = limits.credits?.balance !== null && limits.credits?.balance !== undefined ? Number(limits.credits.balance) : 0;
  const hasExtraCredits = Boolean(limits.credits && (limits.credits.unlimited || (limits.credits.hasCredits && Number.isFinite(numericBalance) && numericBalance > 0)));

  return {
    available: true,
    window_active: windowActive,
    plan_type: limits.planType || null,
    ordinary_usage_allowed: rateLimitReply?.ordinaryUsageAllowed ?? null,
    hard_limited: hardLimited,
    exhausted,
    has_extra_credits: hasExtraCredits,
    has_reset_credits: resetCreditsCount > 0,
    rate_limit_reached_type: limits.rateLimitReachedType || null,
    window_minutes: winMins,
    plan_days: effectivePlanDays,
    window_elapsed_percent: windowElapsedPercent,
    used_percent: usedPercent,
    remaining_percent: remainingPercent,
    elapsed_percent: elapsedPercent,
    target_used_percent: targetUsedPercent,
    pacing_delta: pacingDelta,
    resets_at: resetsAtIso,
    hours_until_reset: hoursUntilReset,
    band,
    credits: limits.credits ? {
      has_credits: Boolean(limits.credits.hasCredits),
      unlimited: Boolean(limits.credits.unlimited),
      balance: limits.credits.balance ?? null
    } : null,
    reset_credits_available: resetCreditsCount,
    reset_credit_earliest_expiry: nextCreditExpiry ? new Date(nextCreditExpiry * 1000).toISOString() : null
  };
}

function advanceResetAnchor(resetMs, windowMs, nowMs) {
  if (!Number.isFinite(resetMs) || !Number.isFinite(windowMs) || windowMs <= 0 || !Number.isFinite(nowMs)) return null;
  if (resetMs > nowMs) return resetMs;
  const steps = Math.floor((nowMs - resetMs) / windowMs) + 1;
  return resetMs + steps * windowMs;
}

function evaluateAgyPacing({ agyUsage, agyExternal, agyHealth, projectPolicy, codexPacing, nowMs = Date.now() }) {
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

  const ext5hResetIso = normalizeOptionalResetIso(agyExternal?.five_hour_resets_at);
  const ext5hResetMs = ext5hResetIso ? Date.parse(ext5hResetIso) : NaN;
  const ext5hExpired = Number.isFinite(ext5hResetMs) && ext5hResetMs <= nowMs;
  if (agyExternal?.available && agyExternal.five_hour_used_percent !== null && agyExternal.five_hour_used_percent !== undefined) {
    fiveHourUsed = ext5hExpired ? 0 : round2(clamp(agyExternal.five_hour_used_percent, 0, 100));
    fiveHourSource = agyExternal.source || 'external_probe';
    fiveHourResetsAt = ext5hExpired ? null : ext5hResetIso;
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
  const switchedAtMs = Date.parse(agyHealth?.account_switched_at || '');
  const guardRecordedMs = Date.parse(projectPolicy?.guard_quota_cooldown?.updated_at || '');
  const guardCooling = cooldownActive(projectPolicy?.guard_quota_cooldown, nowMs)
    && !(Number.isFinite(switchedAtMs) && Number.isFinite(guardRecordedMs) && guardRecordedMs < switchedAtMs);
  const latestErrMs = Date.parse(agyUsage?.latest_quota_error_at || '');
  const postSwitchTranscript429 = agyUsage?.auto_degraded === true
    && !(Number.isFinite(switchedAtMs) && Number.isFinite(latestErrMs) && latestErrMs < switchedAtMs);
  const recentQuotaErr = postSwitchTranscript429 || guardCooling;
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
    window_active: fiveHourResetsAt !== null,
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

  // 2. Evaluate AGY 7-day proportional pacing (preserving unactivated 0% windows without borrowing foreign reset anchors!)
  let weeklyUsed = null;
  let weeklySource = 'uncalibrated';
  let weeklyResetsAtMs = null;
  let weeklyWindowUnactivated = false;

  const ext7dResetIso = normalizeOptionalResetIso(agyExternal?.weekly_resets_at);
  const ext7dResetMs = ext7dResetIso ? Date.parse(ext7dResetIso) : NaN;
  const ext7dExpired = Number.isFinite(ext7dResetMs) && ext7dResetMs <= nowMs;
  if (agyExternal?.available && agyExternal.weekly_used_percent !== null && agyExternal.weekly_used_percent !== undefined) {
    weeklyUsed = ext7dExpired ? 0 : round2(clamp(agyExternal.weekly_used_percent, 0, 100));
    weeklySource = agyExternal.source || 'external_probe';
    if (!ext7dExpired && Number.isFinite(ext7dResetMs)) {
      weeklyResetsAtMs = ext7dResetMs;
    } else {
      // Official probe explicitly reported no active weekly reset window (or previous window just expired to 0%).
      // Never borrow Codex's reset timestamp onto an unactivated AGY weekly bucket!
      weeklyWindowUnactivated = true;
    }
  } else if (valid7dSnapshot) {
    weeklyUsed = round2(clamp(snapshot.weekly_used_percent, 0, 100));
    weeklySource = 'manual_snapshot';
    if (snapshot.weekly_resets_at) weeklyResetsAtMs = Date.parse(snapshot.weekly_resets_at);
    else if (weeklyUsed === 0) weeklyWindowUnactivated = true;
  } else if (cfg.window_7d_tokens && agyUsage?.available && typeof agyUsage.window_7d?.total_tokens === 'number') {
    weeklyUsed = round2(clamp((agyUsage.window_7d.total_tokens / cfg.window_7d_tokens) * 100, 0, 100));
    weeklySource = 'local_token_budget';
  }

  const window7dMs = cfg.window_minutes * 60 * 1000;
  if (!weeklyWindowUnactivated && !weeklyResetsAtMs && cfg.weekly_resets_at) {
    weeklyResetsAtMs = advanceResetAnchor(Date.parse(cfg.weekly_resets_at), window7dMs, nowMs);
  }
  if (!weeklyWindowUnactivated && weeklySource === 'local_token_budget' && !weeklyResetsAtMs && codexPacing?.available && codexPacing.resets_at) {
    weeklyResetsAtMs = Date.parse(codexPacing.resets_at);
  }

  let window7d;
  const unlockHours = cfg.buffer_unlock_window_hours ?? DEFAULT_AGY_PACING.buffer_unlock_window_hours;
  if (weeklyUsed !== null && Number.isFinite(weeklyResetsAtMs)) {
    const remainingMs = Math.max(0, weeklyResetsAtMs - nowMs);
    const hoursUntilReset = round2(remainingMs / 3600000);
    const bufferUnlocked = unlockHours > 0 && hoursUntilReset > 0 && hoursUntilReset <= unlockHours && cfg.weekly_protect_used_percent < 100;
    const effectiveTarget = bufferUnlocked ? 100 : cfg.target_utilization;
    const effectiveProtect = bufferUnlocked ? 100 : cfg.weekly_protect_used_percent;
    const elapsedRatio = clamp(1 - remainingMs / window7dMs, 0, 1);
    const elapsedPercent = round2(elapsedRatio * 100);
    const targetUsedPercent = round2(elapsedRatio * effectiveTarget);
    const remainingPercent = round2(Math.max(0, 100 - weeklyUsed));
    const bufferPercent = round2(Math.max(0, 100 - effectiveProtect));
    const usableRemainingPercent = round2(Math.max(0, Math.min(effectiveTarget, effectiveProtect) - weeklyUsed));
    const pacingDelta = round2(weeklyUsed - targetUsedPercent);

    let band;
    if (weeklyUsed >= effectiveProtect) band = 'agy_protected';
    else if (bufferUnlocked && usableRemainingPercent >= 1) band = 'agy_drain';
    else if (hoursUntilReset > 0 && hoursUntilReset <= cfg.drain_window_hours && usableRemainingPercent >= cfg.drain_min_remaining_percent) band = 'agy_drain';
    else if (pacingDelta <= -3) band = 'agy_priority';
    else if (pacingDelta <= 5) band = 'balanced';
    else band = 'codex_priority';

    window7d = {
      available: true,
      window_active: true,
      source: weeklySource,
      window_minutes: cfg.window_minutes,
      target_utilization: effectiveTarget,
      configured_target_utilization: cfg.target_utilization,
      protect_used_percent: effectiveProtect,
      configured_protect_used_percent: cfg.weekly_protect_used_percent,
      buffer_unlock_window_hours: unlockHours,
      buffer_unlocked: bufferUnlocked,
      buffer_percent: bufferPercent,
      used_percent: weeklyUsed,
      remaining_percent: remainingPercent,
      usable_remaining_percent: usableRemainingPercent,
      elapsed_percent: elapsedPercent,
      target_used_percent: targetUsedPercent,
      pacing_delta: pacingDelta,
      resets_at: new Date(weeklyResetsAtMs).toISOString(),
      hours_until_reset: hoursUntilReset,
      tokens_7d: agyUsage?.available ? (agyUsage.window_7d?.total_tokens ?? null) : null,
      budget_tokens_7d: cfg.window_7d_tokens,
      band
    };
  } else if (weeklyUsed !== null) {
    // Unactivated / unused weekly bucket (e.g. 0% used with null/epoch-zero reset_time):
    // available with full configured quota, 0% elapsed, and buffer locked until real window starts.
    const effectiveTarget = cfg.target_utilization;
    const effectiveProtect = cfg.weekly_protect_used_percent;
    const remainingPercent = round2(Math.max(0, 100 - weeklyUsed));
    const bufferPercent = round2(Math.max(0, 100 - effectiveProtect));
    const usableRemainingPercent = round2(Math.max(0, Math.min(effectiveTarget, effectiveProtect) - weeklyUsed));
    const isZeroUnused = weeklyUsed === 0;
    const band = weeklyUsed >= effectiveProtect
      ? 'agy_protected'
      : (isZeroUnused ? 'agy_priority' : 'balanced');
    window7d = {
      available: true,
      window_active: false,
      source: weeklySource,
      window_minutes: cfg.window_minutes,
      target_utilization: effectiveTarget,
      configured_target_utilization: cfg.target_utilization,
      protect_used_percent: effectiveProtect,
      configured_protect_used_percent: cfg.weekly_protect_used_percent,
      buffer_unlock_window_hours: unlockHours,
      buffer_unlocked: false,
      buffer_percent: bufferPercent,
      used_percent: weeklyUsed,
      remaining_percent: remainingPercent,
      usable_remaining_percent: usableRemainingPercent,
      elapsed_percent: isZeroUnused ? 0 : null,
      target_used_percent: isZeroUnused ? 0 : null,
      pacing_delta: isZeroUnused ? 0 : null,
      resets_at: null,
      hours_until_reset: null,
      tokens_7d: agyUsage?.available ? (agyUsage.window_7d?.total_tokens ?? null) : null,
      budget_tokens_7d: cfg.window_7d_tokens,
      band
    };
  } else {
    window7d = {
      available: false,
      window_active: false,
      source: 'uncalibrated',
      window_minutes: cfg.window_minutes,
      target_utilization: cfg.target_utilization,
      protect_used_percent: cfg.weekly_protect_used_percent,
      buffer_unlock_window_hours: unlockHours,
      buffer_unlocked: false,
      buffer_percent: round2(Math.max(0, 100 - cfg.weekly_protect_used_percent)),
      tokens_7d: agyUsage?.available ? (agyUsage.window_7d?.total_tokens ?? null) : null,
      budget_tokens_7d: cfg.window_7d_tokens,
      note: `AGY 默认只用 ${cfg.target_utilization}% 额度、预留 ${round2(Math.max(0, 100 - cfg.weekly_protect_used_percent))}% 应急缓冲（距周重置≤${unlockHours}h 自动解锁）；安装官方 agy CLI 或配置预算后启用精确 7 天竞比。`
    };
  }

  const exhausted5h = recentQuotaErr || (fiveHourUsed !== null && fiveHourUsed >= 100);
  const exhausted7d = window7d.available && window7d.used_percent >= 100;
  const exhausted = exhausted5h || exhausted7d;
  const limited = window5h.status === 'limited' || window7d.band === 'agy_protected';

  return {
    window_5h: window5h,
    window_7d: window7d,
    limited,
    caution: window5h.status === 'caution',
    exhausted,
    soft_buffered: limited && !exhausted
  };
}

function evaluateAgyModelPools({ agyUsage, agyExternal, projectPolicy, codexPacing, nowMs = Date.now() }) {
  const poolsCfg = projectPolicy?.agy_model_pools || {};
  const window7dMs = (projectPolicy?.agy_pacing?.window_minutes || DEFAULT_AGY_PACING.window_minutes) * 60 * 1000;
  const extBuckets = agyExternal?.available && agyExternal.buckets && typeof agyExternal.buckets === 'object' ? agyExternal.buckets : null;
  const result = {};
  for (const [name, cfg] of Object.entries(poolsCfg)) {
    const token = String(cfg.match || name).toLowerCase();
    const sumMatching = byModel => Object.entries(byModel || {})
      .filter(([m]) => String(m).toLowerCase().includes(token))
      .reduce((acc, [, v]) => acc + (v?.total_tokens || 0), 0);
    const tokens5h = agyUsage?.available ? sumMatching(agyUsage.window_5h?.by_model) : null;
    const tokens7d = agyUsage?.available ? sumMatching(agyUsage.window_7d?.by_model) : null;

    const bucket5hKey = cfg.bucket_5h || (!token.includes('gemini') ? '3p-5h' : null);
    const bucket7dKey = cfg.bucket_7d || (!token.includes('gemini') ? '3p-weekly' : null);
    const rawExt5h = bucket5hKey && extBuckets?.[bucket5hKey] && typeof extBuckets[bucket5hKey].used_percent === 'number'
      ? extBuckets[bucket5hKey] : null;
    const ext5hResetIso = normalizeOptionalResetIso(rawExt5h?.resets_at);
    const ext5hExpired = Boolean(ext5hResetIso && Date.parse(ext5hResetIso) <= nowMs);
    const ext5h = rawExt5h ? { ...rawExt5h, used_percent: ext5hExpired ? 0 : rawExt5h.used_percent, resets_at: ext5hExpired ? null : ext5hResetIso } : null;

    const rawExt7d = bucket7dKey && extBuckets?.[bucket7dKey] && typeof extBuckets[bucket7dKey].used_percent === 'number'
      ? extBuckets[bucket7dKey] : null;
    const ext7dResetIso = normalizeOptionalResetIso(rawExt7d?.resets_at);
    const ext7dExpired = Boolean(ext7dResetIso && Date.parse(ext7dResetIso) <= nowMs);
    const ext7d = rawExt7d ? { ...rawExt7d, used_percent: ext7dExpired ? 0 : rawExt7d.used_percent, resets_at: ext7dExpired ? null : ext7dResetIso } : null;

    const snap = cfg.manual_snapshot || null;
    const snapAgeMs = snap ? nowMs - Date.parse(snap.recorded_at) : Infinity;
    const valid5h = snap && snap.five_hour_used_percent !== null && (
      snap.five_hour_resets_at ? Date.parse(snap.five_hour_resets_at) > nowMs : snapAgeMs <= 5 * 3600000
    );
    const valid7d = snap && snap.weekly_used_percent !== null && (
      snap.weekly_resets_at ? Date.parse(snap.weekly_resets_at) > nowMs : snapAgeMs <= 24 * 3600000
    );

    const used5h = ext5h ? round2(clamp(ext5h.used_percent, 0, 100))
      : valid5h ? round2(clamp(snap.five_hour_used_percent, 0, 100))
        : (cfg.window_5h_tokens && typeof tokens5h === 'number' ? round2(clamp((tokens5h / cfg.window_5h_tokens) * 100, 0, 100)) : null);
    const used7d = ext7d ? round2(clamp(ext7d.used_percent, 0, 100))
      : valid7d ? round2(clamp(snap.weekly_used_percent, 0, 100))
        : (cfg.window_7d_tokens && typeof tokens7d === 'number' ? round2(clamp((tokens7d / cfg.window_7d_tokens) * 100, 0, 100)) : null);
    const source = ext7d || ext5h ? (agyExternal.source || 'agy_cli_usage')
      : (valid7d || valid5h ? 'manual_snapshot' : (used7d !== null || used5h !== null ? 'local_token_budget' : 'uncalibrated'));

    // Never borrow Codex or main Gemini reset anchors onto an independent pool whose official bucket is unactivated (0% / null reset_time)!
    const poolWindowUnactivated = Boolean((ext7d && !ext7d.resets_at) || (!ext7d && valid7d && !snap.weekly_resets_at && used7d === 0));
    let weeklyResetsAtMs = ext7d?.resets_at && Number.isFinite(Date.parse(ext7d.resets_at))
      ? Date.parse(ext7d.resets_at)
      : (!ext7d && valid7d && snap.weekly_resets_at && Number.isFinite(Date.parse(snap.weekly_resets_at))
        ? Date.parse(snap.weekly_resets_at) : null);
    if (!poolWindowUnactivated && source === 'local_token_budget' && !weeklyResetsAtMs && projectPolicy?.agy_pacing?.weekly_resets_at) {
      weeklyResetsAtMs = advanceResetAnchor(Date.parse(projectPolicy.agy_pacing.weekly_resets_at), window7dMs, nowMs);
    }

    const windowActive = Number.isFinite(weeklyResetsAtMs);
    const unlockHours = cfg.buffer_unlock_window_hours ?? projectPolicy?.agy_pacing?.buffer_unlock_window_hours ?? DEFAULT_AGY_PACING.buffer_unlock_window_hours;
    const hoursUntilReset = windowActive ? round2(Math.max(0, (weeklyResetsAtMs - nowMs) / 3600000)) : null;
    const bufferUnlocked = hoursUntilReset !== null && unlockHours > 0 && hoursUntilReset > 0 && hoursUntilReset <= unlockHours && cfg.weekly_protect_used_percent < 100;
    const effectiveProtect = bufferUnlocked ? 100 : cfg.weekly_protect_used_percent;

    let elapsedPercent = null, targetUsedPercent = null, pacingDelta = null, band = 'uncalibrated';
    if (used7d !== null && windowActive) {
      const remainingMs = Math.max(0, weeklyResetsAtMs - nowMs);
      const elapsedRatio = clamp(1 - remainingMs / window7dMs, 0, 1);
      elapsedPercent = round2(elapsedRatio * 100);
      targetUsedPercent = round2(elapsedRatio * effectiveProtect);
      pacingDelta = round2(used7d - targetUsedPercent);
      if (used7d >= effectiveProtect) band = 'hard_stop';
      else if (bufferUnlocked) band = 'buffer_unlocked_drain';
      else if (pacingDelta > 5) band = 'ahead_of_pace';
      else if (pacingDelta >= -3) band = 'on_pace';
      else band = 'below_pace';
    } else if (used7d !== null) {
      if (used7d >= effectiveProtect) {
        band = 'hard_stop';
      } else if (used7d === 0) {
        elapsedPercent = 0;
        targetUsedPercent = 0;
        pacingDelta = 0;
        band = 'below_pace';
      } else {
        band = 'on_pace';
      }
    }

    const cooling = cooldownActive(cfg.cooldown, nowMs);
    const weeklyStopped = used7d !== null && used7d >= effectiveProtect;
    const fiveHourLimited = cooling || (used5h !== null && used5h >= cfg.window_5h_protect_percent);
    const fiveHourCaution = !fiveHourLimited && used5h !== null && used5h >= cfg.window_5h_caution_percent;
    const stopped = weeklyStopped || fiveHourLimited;
    const reason = weeklyStopped ? 'pool_weekly_buffer_hard_stop'
      : cooling ? 'pool_cooldown'
        : fiveHourLimited ? 'pool_5h_protected'
          : fiveHourCaution ? 'pool_5h_caution'
            : null;
    result[name] = {
      match: token,
      source,
      default_model: cfg.default_model || null,
      review_model: cfg.review_model || cfg.default_model || null,
      window_active: windowActive,
      weekly_protect_used_percent: effectiveProtect,
      configured_protect_used_percent: cfg.weekly_protect_used_percent,
      buffer_unlock_window_hours: unlockHours,
      buffer_unlocked: bufferUnlocked,
      hours_until_reset: hoursUntilReset,
      buffer_percent: round2(Math.max(0, 100 - effectiveProtect)),
      weekly_used_percent: used7d,
      weekly_remaining_percent: used7d !== null ? round2(Math.max(0, 100 - used7d)) : null,
      usable_remaining_percent: used7d !== null ? round2(Math.max(0, effectiveProtect - used7d)) : null,
      elapsed_percent: elapsedPercent,
      target_used_percent: targetUsedPercent,
      pacing_delta: pacingDelta,
      band,
      five_hour_used_percent: used5h,
      five_hour_caution_percent: cfg.window_5h_caution_percent,
      five_hour_protect_percent: cfg.window_5h_protect_percent,
      tokens_5h: tokens5h,
      tokens_7d: tokens7d,
      stopped,
      caution: fiveHourCaution,
      reason
    };
  }
  return result;
}

function inferBrainDir(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const resolved = path.resolve(transcriptPath);
  const parts = resolved.split(path.sep);
  const idx = parts.findIndex(segment => segment.toLowerCase() === 'brain');
  if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
  return null;
}

const QUOTA_ERROR_RE = /\b429\b|resource_exhausted|quota\s*(?:exceeded|exhausted|limit|depleted)|rate[\s_-]*limit|too many requests/i;
const NON_QUOTA_ERROR_RE = /\b(?:401|403|503)\b|unauthenticated|invalid.*(?:api[_ -]?key|token|credential)|permission_denied|blocked by policy|no capacity available .* on the server|service unavailable/i;

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

function readSliceCompleteLines(file, startOffset, endSize, maxBytes) {
  if (endSize <= startOffset) return { text: '', consumedOffset: endSize, bytesRead: 0, truncated: false };
  let actualStart = startOffset;
  let dropFirstPartial = false;
  if (endSize - startOffset > maxBytes) {
    actualStart = endSize - maxBytes;
    dropFirstPartial = true;
  }
  const len = endSize - actualStart;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const bytesRead = fs.readSync(fd, buf, 0, len, actualStart);
    const lastNl = buf.lastIndexOf(0x0a, bytesRead - 1);
    if (lastNl < 0) {
      if (actualStart === 0 && bytesRead === endSize) {
        return { text: buf.subarray(0, bytesRead).toString('utf8'), consumedOffset: endSize, bytesRead, truncated: false };
      }
      return { text: '', consumedOffset: startOffset, bytesRead, truncated: dropFirstPartial };
    }
    let slice = buf.subarray(0, lastNl + 1);
    if (dropFirstPartial) {
      const firstNl = slice.indexOf(0x0a);
      slice = firstNl >= 0 ? slice.subarray(firstNl + 1) : Buffer.alloc(0);
    }
    return {
      text: slice.toString('utf8'),
      consumedOffset: actualStart + lastNl + 1,
      bytesRead,
      truncated: dropFirstPartial
    };
  } finally {
    fs.closeSync(fd);
  }
}

function parseTranscriptCompactRecords(text, cutoff7d, nowMs) {
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const ts = Date.parse(row.created_at);
    if (!Number.isFinite(ts) || ts < cutoff7d || ts > nowMs + 60000) continue;
    const inp = Number.isSafeInteger(row.input_tokens) && row.input_tokens > 0 ? row.input_tokens : 0;
    const cache = Number.isSafeInteger(row.cache_read_tokens) && row.cache_read_tokens > 0 ? row.cache_read_tokens : 0;
    const out = Number.isSafeInteger(row.output_tokens) && row.output_tokens > 0 ? row.output_tokens : 0;
    const errText = typeof row.error === 'string' ? row.error : (row.error?.message || '');
    const is429 = isAgyQuotaError(errText) ? 1 : 0;
    if (inp > 0 || out > 0 || cache > 0 || is429 === 1) {
      records.push([ts, row.model || 'unknown', inp, cache, out, is429]);
    }
  }
  return records;
}

function loadTranscriptIndex(indexPath) {
  if (!indexPath || !fs.existsSync(indexPath)) return { schema: 1, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (parsed && parsed.schema === 1 && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files)) {
      return parsed;
    }
  } catch {}
  return { schema: 1, files: {} };
}

function scanAgyTranscriptUsage(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const defaultBrain = process.env.CODEX_EXECUTOR_TEST_ROOT ? null : path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
  const brainDir = options.brainDir || inferBrainDir(options.transcriptPath) || defaultBrain;
  const indexPath = options.indexPath || null;
  const maxFiles = options.maxFiles ?? 80;
  const maxBytesPerFile = options.maxBytesPerFile ?? (2 * 1024 * 1024);
  const cutoff7d = nowMs - 7 * 24 * 3600 * 1000;
  const cutoff5h = nowMs - 5 * 3600 * 1000;
  const recentDegradeCutoff = nowMs - 15 * 60 * 1000;

  const emptyBucket = () => ({ requests: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, total_tokens: 0, weighted_tokens: 0, by_model: {} });
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
      if (st.isFile() && st.mtimeMs >= cutoff7d) candidates.push({ file, mtimeMs: st.mtimeMs, size: st.size });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = candidates.slice(0, maxFiles);

  let quotaErrors5h = 0, latestQuotaErrorAt = null, truncatedFiles = 0;
  let cacheHits = 0, incrementalReads = 0, fullReads = 0, bytesRead = 0, dirty = false;
  const prevIndex = indexPath ? loadTranscriptIndex(indexPath) : null;
  const prevFiles = prevIndex?.files || {};
  const nextFiles = {};

  const addUsage = (bucket, model, inp, cache, out) => {
    const total = inp + out;
    const weighted = Math.round(inp + cache * 0.1 + out * 5);
    bucket.requests += 1;
    bucket.input_tokens += inp;
    bucket.cache_read_tokens += cache;
    bucket.output_tokens += out;
    bucket.total_tokens += total;
    bucket.weighted_tokens += weighted;
    const key = model || 'unknown';
    if (!bucket.by_model[key]) bucket.by_model[key] = { requests: 0, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, total_tokens: 0, weighted_tokens: 0 };
    const m = bucket.by_model[key];
    m.requests += 1; m.input_tokens += inp; m.cache_read_tokens += cache; m.output_tokens += out; m.total_tokens += total; m.weighted_tokens += weighted;
  };

  for (const item of selected) {
    let records;
    let itemTruncated = false;
    const prev = indexPath ? prevFiles[item.file] : null;
    if (prev && prev.mtime_ms === item.mtimeMs && prev.size === item.size && prev.offset === item.size && Array.isArray(prev.records)) {
      cacheHits += 1;
      itemTruncated = Boolean(prev.truncated);
      records = prev.records.filter(r => Array.isArray(r) && r[0] >= cutoff7d);
      if (records.length !== prev.records.length) dirty = true;
      nextFiles[item.file] = { mtime_ms: item.mtimeMs, size: item.size, offset: prev.offset, truncated: itemTruncated, records };
    } else if (prev && Array.isArray(prev.records) && typeof prev.offset === 'number' && prev.offset >= 0 && item.size >= prev.offset && (item.size - prev.offset) <= maxBytesPerFile) {
      const priorTruncated = Boolean(prev.truncated);
      if (item.size === prev.offset) {
        cacheHits += 1;
        itemTruncated = priorTruncated;
        records = prev.records.filter(r => Array.isArray(r) && r[0] >= cutoff7d);
        nextFiles[item.file] = { mtime_ms: item.mtimeMs, size: item.size, offset: prev.offset, truncated: itemTruncated, records };
        if (prev.mtime_ms !== item.mtimeMs || records.length !== prev.records.length) dirty = true;
      } else {
        let delta;
        try { delta = readSliceCompleteLines(item.file, prev.offset, item.size, maxBytesPerFile); } catch { continue; }
        incrementalReads += 1;
        bytesRead += delta.bytesRead;
        dirty = true;
        itemTruncated = priorTruncated || Boolean(delta.truncated);
        const appended = parseTranscriptCompactRecords(delta.text, cutoff7d, nowMs);
        records = [...prev.records.filter(r => Array.isArray(r) && r[0] >= cutoff7d), ...appended];
        nextFiles[item.file] = { mtime_ms: item.mtimeMs, size: item.size, offset: delta.consumedOffset, truncated: itemTruncated, records };
      }
    } else if (indexPath) {
      let full;
      try { full = readSliceCompleteLines(item.file, 0, item.size, maxBytesPerFile); } catch { continue; }
      fullReads += 1;
      bytesRead += full.bytesRead;
      dirty = true;
      itemTruncated = Boolean(full.truncated);
      records = parseTranscriptCompactRecords(full.text, cutoff7d, nowMs);
      nextFiles[item.file] = { mtime_ms: item.mtimeMs, size: item.size, offset: full.consumedOffset, truncated: itemTruncated, records };
    } else {
      let text, truncated;
      try { ({ text, truncated } = readTailUtf8(item.file, maxBytesPerFile)); } catch { continue; }
      fullReads += 1;
      bytesRead += Buffer.byteLength(text, 'utf8');
      itemTruncated = truncated;
      records = parseTranscriptCompactRecords(text, cutoff7d, nowMs);
    }

    if (itemTruncated) truncatedFiles += 1;
    for (const rec of records) {
      const [ts, model, inp, cache, out, is429] = rec;
      if (inp > 0 || out > 0 || cache > 0) {
        addUsage(win7d, model, inp, cache, out);
        if (ts >= cutoff5h) addUsage(win5h, model, inp, cache, out);
      }
      if (is429 === 1 && ts >= cutoff5h) {
        quotaErrors5h += 1;
        if (!latestQuotaErrorAt || ts > latestQuotaErrorAt) latestQuotaErrorAt = ts;
      }
    }
  }

  if (indexPath) {
    if (!dirty && Object.keys(prevFiles).length !== Object.keys(nextFiles).length) dirty = true;
    if (dirty) {
      try { saveAtomic(indexPath, { schema: 1, updated_at: new Date(nowMs).toISOString(), files: nextFiles }); } catch {}
    }
  }

  return {
    available: true,
    source: 'local_transcripts',
    scanned_sessions: selected.length,
    truncated_files: truncatedFiles,
    sync_stats: {
      index_used: Boolean(indexPath),
      cache_hits: cacheHits,
      incremental_reads: incrementalReads,
      full_reads: fullReads,
      bytes_read: bytesRead
    },
    window_5h: win5h,
    window_7d: win7d,
    quota_errors_5h: quotaErrors5h,
    latest_quota_error_at: latestQuotaErrorAt ? new Date(latestQuotaErrorAt).toISOString() : null,
    auto_degraded: latestQuotaErrorAt !== null && latestQuotaErrorAt >= recentDegradeCutoff,
    note: 'Incremental local transcript token aggregation; install official agy CLI (`agy --print /usage --output-format json`) or set agy_quota_command for live bucket percentages.'
  };
}

function isLegacyAgyWrapper(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(256);
      const n = fs.readSync(fd, buf, 0, 256, 0);
      return buf.subarray(0, n).toString('utf8').includes('cc-switch-agy-wrapper');
    } finally { fs.closeSync(fd); }
  } catch { return false; }
}

function resolveRealAgyBin(options = {}) {
  if (options.agyBin !== undefined) return options.agyBin || null;
  if (process.env.CODEX_EXECUTOR_TEST_ROOT) return null;
  const home = os.homedir();
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extraDirs = process.platform === 'win32'
    ? [path.join(home, '.local', 'bin'), ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'agy', 'bin')] : [])]
    : [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const names = process.platform === 'win32' ? ['agy.exe', 'agy.cmd', 'agy'] : ['agy'];
  for (const dir of [...pathDirs, ...extraDirs]) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.statSync(candidate).isFile() && !isLegacyAgyWrapper(candidate)) return candidate;
      } catch {}
    }
  }
  return null;
}

let cachedWinSystemProxy;
function detectWindowsSystemProxy() {
  if (process.platform !== 'win32' || process.env.CODEX_EXECUTOR_TEST_ROOT) return null;
  if (cachedWinSystemProxy !== undefined) return cachedWinSystemProxy;
  try {
    const res = spawnSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000
    });
    if (res.status !== 0 || !res.stdout) { cachedWinSystemProxy = null; return null; }
    const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+0x1\b/im.test(res.stdout);
    const serverMatch = res.stdout.match(/^\s*ProxyServer\s+REG_SZ\s+(.+)$/im);
    if (!enabled || !serverMatch) { cachedWinSystemProxy = null; return null; }
    const raw = serverMatch[1].trim();
    let hostPort = raw;
    if (raw.includes('=')) {
      const pairs = Object.fromEntries(raw.split(';').map(s => s.split('=')).filter(p => p.length === 2));
      hostPort = pairs.https || pairs.http || '';
    }
    if (!hostPort) { cachedWinSystemProxy = null; return null; }
    cachedWinSystemProxy = hostPort.includes('://') ? hostPort : `http://${hostPort}`;
    return cachedWinSystemProxy;
  } catch {
    cachedWinSystemProxy = null;
    return null;
  }
}

function cleanOfficialAgyEnv(baseEnv = process.env) {
  const env = { ...baseEnv };
  let hasProxy = false;
  for (const k of Object.keys(env)) {
    const upper = k.toUpperCase();
    if (upper === 'GEMINI_API_KEY' || upper === 'GOOGLE_GEMINI_BASE_URL') delete env[k];
    if ((upper === 'HTTPS_PROXY' || upper === 'HTTP_PROXY' || upper === 'ALL_PROXY') && String(env[k] || '').trim()) {
      hasProxy = true;
    }
  }
  // Go's net/http inside `agy.exe` only reads HTTP(S)_PROXY env vars, not Windows Internet Settings.
  if (!hasProxy) {
    const sysProxy = detectWindowsSystemProxy();
    if (sysProxy) {
      env.HTTP_PROXY = sysProxy;
      env.HTTPS_PROXY = sysProxy;
    }
  }
  // Prevent `agy.exe`'s detached `auto_updater_windows.go` from spawning `agy.exe --version` without CREATE_NO_WINDOW
  // (which flashes a visible ConsoleWindowClass window on Windows when launched from consoleless GUI/Sidecar processes!).
  if (env.AGY_CLI_DISABLE_AUTO_UPDATE === undefined) env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';
  if (env.AGY_CLI_NONINTERACTIVE_HEADLESS === undefined) env.AGY_CLI_NONINTERACTIVE_HEADLESS = 'true';
  if (env.AGY_CLI_INTERACTIVE_HEADLESS === undefined) env.AGY_CLI_INTERACTIVE_HEADLESS = 'true';
  return env;
}

function killChildTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 4000 });
    } catch {}
  }
  try { child.kill(); } catch {}
}

function withNoBrowserEnv(baseEnv, noBrowserBinDir, markerPath) {
  const env = cleanOfficialAgyEnv(baseEnv);
  if (noBrowserBinDir) {
    const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    const existingPath = env[pathKey] || '';
    env[pathKey] = existingPath ? `${noBrowserBinDir}${path.delimiter}${existingPath}` : noBrowserBinDir;
  }
  if (markerPath) {
    env.AGY_BROWSER_INTERCEPT_MARKER = markerPath;
  }
  if (process.platform !== 'win32' && env.BROWSER === undefined) {
    env.BROWSER = 'false';
  }
  return env;
}

function parseAgyProbePayload(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { available: false, error: 'Probe output is not a JSON object' };
  }
  const num = v => typeof v === 'number' && Number.isFinite(v) ? round2(clamp(v, 0, 100)) : null;

  // 1. Official `agy --print /usage --output-format json` or bucket-group schema (same 5 buckets as CC Switch)
  if (parsed.status !== undefined && String(parsed.status).toUpperCase() !== 'SUCCESS') {
    return { available: false, error: `agy /usage returned status=${parsed.status}` };
  }
  const groups = Array.isArray(parsed?.command?.data?.groups) ? parsed.command.data.groups
    : (Array.isArray(parsed?.groups) ? parsed.groups : null);
  if (groups) {
    const buckets = {};
    for (const group of groups) {
      if (!Array.isArray(group?.buckets)) continue;
      for (const b of group.buckets) {
        const id = typeof (b?.id ?? b?.bucketId) === 'string' ? (b.id ?? b.bucketId).trim() : '';
        if (!id) continue;
        const remRaw = b?.remaining_fraction ?? b?.remainingFraction;
        const usedRaw = b?.used_percent ?? b?.usedPercent;
        let used = null;
        if (typeof remRaw === 'number' && Number.isFinite(remRaw)) {
          used = round2((1 - clamp(remRaw, 0, 1)) * 100);
        } else if (typeof usedRaw === 'number' && Number.isFinite(usedRaw)) {
          used = round2(clamp(usedRaw, 0, 100));
        } else {
          continue;
        }
        const resetsAt = normalizeOptionalResetIso(b?.reset_time ?? b?.resetTime ?? b?.resets_at ?? null);
        buckets[id] = {
          id,
          window: typeof b.window === 'string' ? b.window : null,
          window_active: resetsAt !== null,
          used_percent: used,
          remaining_percent: round2(100 - used),
          resets_at: resetsAt
        };
      }
    }
    const g5h = buckets['gemini-5h'] || null;
    const g7d = buckets['gemini-weekly'] || null;
    const anyBucket = g5h || g7d || Object.values(buckets)[0] || null;
    if (!anyBucket) {
      return { available: false, error: 'agy /usage output contained no valid quota buckets' };
    }
    return {
      available: true,
      remaining_percent: g5h ? g5h.remaining_percent : (g7d ? g7d.remaining_percent : anyBucket.remaining_percent),
      five_hour_used_percent: g5h ? g5h.used_percent : null,
      five_hour_resets_at: g5h ? g5h.resets_at : null,
      weekly_used_percent: g7d ? g7d.used_percent : null,
      weekly_resets_at: g7d ? g7d.resets_at : null,
      reset_at: g5h?.resets_at || g7d?.resets_at || anyBucket.resets_at || null,
      buckets,
      source: typeof parsed.source === 'string' ? parsed.source : 'agy_cli_usage'
    };
  }

  // 2. Flat external probe JSON schema
  const legacyRemaining = num(parsed.remaining_percent);
  const fiveHourUsed = num(parsed.five_hour_used_percent)
    ?? (num(parsed.five_hour_remaining_percent) !== null ? round2(100 - num(parsed.five_hour_remaining_percent)) : null)
    ?? (legacyRemaining !== null ? round2(100 - legacyRemaining) : null);
  const weeklyUsed = num(parsed.weekly_used_percent)
    ?? (num(parsed.weekly_remaining_percent) !== null ? round2(100 - num(parsed.weekly_remaining_percent)) : null);

  if (fiveHourUsed === null && weeklyUsed === null) {
    return { available: false, error: 'Probe output missing numeric quota percent fields (remaining_percent / five_hour_used_percent / weekly_used_percent)' };
  }
  const flat5hReset = normalizeOptionalResetIso(parsed.five_hour_resets_at) ?? normalizeOptionalResetIso(parsed.reset_at);
  const flat7dReset = normalizeOptionalResetIso(parsed.weekly_resets_at);
  const flatResetAt = normalizeOptionalResetIso(parsed.reset_at) ?? flat5hReset ?? flat7dReset;
  let normalizedBuckets = null;
  if (parsed.buckets && typeof parsed.buckets === 'object' && !Array.isArray(parsed.buckets)) {
    normalizedBuckets = {};
    for (const [k, v] of Object.entries(parsed.buckets)) {
      if (!v || typeof v !== 'object') continue;
      const rIso = normalizeOptionalResetIso(v.resets_at ?? v.reset_time ?? null);
      normalizedBuckets[k] = { ...v, resets_at: rIso, window_active: rIso !== null };
    }
  }
  return {
    available: true,
    remaining_percent: legacyRemaining ?? (fiveHourUsed !== null ? round2(100 - fiveHourUsed) : round2(100 - weeklyUsed)),
    five_hour_used_percent: fiveHourUsed,
    five_hour_resets_at: flat5hReset,
    weekly_used_percent: weeklyUsed,
    weekly_resets_at: flat7dReset,
    reset_at: flatResetAt,
    buckets: normalizedBuckets,
    model_group: typeof parsed.model_group === 'string' ? parsed.model_group : null,
    source: typeof parsed.source === 'string' ? parsed.source : 'external_probe'
  };
}

function runExternalAgyProbe(command, options = {}) {
  if (!Array.isArray(command) || !command.length) return null;
  const timeout = options.timeoutMs ?? 12000;
  try {
    const res = spawnSync(command[0], command.slice(1), {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      env: cleanOfficialAgyEnv(options.env || process.env)
    });
    if (res.error) return { available: false, error: res.error.message };
    if (res.status !== 0) return { available: false, error: (res.stderr || res.stdout || `exit ${res.status}`).trim().slice(0, 400) };
    return parseAgyProbePayload(JSON.parse((res.stdout || '').trim()));
  } catch (error) {
    return { available: false, error: error.message };
  }
}

const DEFAULT_AGY_OAUTH_RETRY_DELAYS_MS = [1500, 3000, 5000];
const TRANSIENT_AGY_PROBE_ERR_RE = /timed out|deadline exceeded|connection reset|econnreset|etimedout|eai_again|socket hang up|\beof\b|\b(?:502|503|504)\b/i;

function sleepMs(ms) {
  return ms > 0 ? new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); }) : Promise.resolve();
}

function inspectAgyCliLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return null;
  try {
    const { text } = readTailUtf8(logPath, 65536);
    const emailMatch = text.match(/applyAuthResult:\s*email=([^\s,]+)/);
    const timedOut10s = /keyringAuth:\s*timed out after/i.test(text);
    const loadedToken = /keyringAuth:\s*loaded token/i.test(text);
    const explicitRevoked = /invalid_grant|token has been expired or revoked|refresh token[^\r\n]*invalid|unauthorized_client/i.test(text);
    const silentAuthFailed = /Print mode:\s*silent auth failed|triggering interactive OAuth|You are not logged into Antigravity/i.test(text);
    const definiteAuthDrop = explicitRevoked || (silentAuthFailed && !timedOut10s && !loadedToken);
    return {
      account_email: emailMatch ? emailMatch[1].trim() : null,
      timed_out_10s: timedOut10s,
      loaded_token: loadedToken,
      explicit_revoked: explicitRevoked,
      definite_auth_drop: definiteAuthDrop
    };
  } catch {
    return null;
  }
}

function detectCcSwitchAccountsMtimeMs(options = {}) {
  const explicit = options.ccSwitchAccountsFile;
  if (explicit === null) return null;
  if (!explicit && process.env.CODEX_EXECUTOR_TEST_ROOT) return null;
  const targets = explicit
    ? [explicit]
    : [
      path.join(os.homedir(), '.cc-switch', 'agy_accounts.json'),
      path.join(os.homedir(), '.cc-switch', 'agy-login-stash.json')
    ];
  let maxMtime = null;
  for (const target of targets) {
    try {
      const st = fs.statSync(target);
      if (st.isFile()) {
        const ms = Math.floor(st.mtimeMs);
        if (maxMtime === null || ms > maxMtime) maxMtime = ms;
      }
    } catch {}
  }
  return maxMtime;
}

function buildAgyKeyringScript(options = {}) {
  const probeHome = options.probeHomeDir || defaultAgyProbeHome();
  fs.mkdirSync(probeHome, { recursive: true });
  const dllPath = path.join(probeHome, 'agy-cred-meta-v1.dll');
  const pwsh = options.pwsh || process.env.CODEX_EXECUTOR_PWSH || 'pwsh.exe';
  const script = [
    `$dll = ${JSON.stringify(dllPath)}`,
    'if (-not (Test-Path -LiteralPath $dll)) {',
    '  Add-Type -OutputAssembly $dll -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class AgyCredMeta {',
    '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
    '  private struct CREDENTIAL {',
    '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
    '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
    '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
    '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
    '  }',
    '  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
    '  private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credPtr);',
    '  [DllImport("advapi32.dll", SetLastError = true)]',
    '  private static extern void CredFree(IntPtr credPtr);',
    '  public static long GetLastWrittenMs(string target) {',
    '    IntPtr ptr;',
    '    if (!CredRead(target, 1, 0, out ptr) || ptr == IntPtr.Zero) return -1;',
    '    try {',
    '      var cred = Marshal.PtrToStructure<CREDENTIAL>(ptr);',
    '      long ft = (((long)cred.LastWritten.dwHighDateTime) << 32) | ((uint)cred.LastWritten.dwLowDateTime);',
    '      return DateTimeOffset.FromFileTime(ft).ToUnixTimeMilliseconds();',
    '    } finally { CredFree(ptr); }',
    '  }',
    '}',
    '"@',
    '}',
    '[void][Reflection.Assembly]::LoadFile($dll)',
    '[Console]::Out.Write([AgyCredMeta]::GetLastWrittenMs("gemini:antigravity"))'
  ].join('\n');
  return { pwsh, script };
}

function detectAgyKeyringLastWrittenMs(options = {}) {
  if (options.keyringLastWrittenMs !== undefined) return options.keyringLastWrittenMs;
  if (process.platform !== 'win32' || process.env.CODEX_EXECUTOR_TEST_ROOT) return null;
  try {
    const { pwsh, script } = buildAgyKeyringScript(options);
    const res = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000
    });
    if (res.status !== 0) return null;
    const parsed = Number(String(res.stdout || '').trim());
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function detectAgyKeyringLastWrittenMsAsync(options = {}) {
  if (options.keyringLastWrittenMs !== undefined) return Promise.resolve(options.keyringLastWrittenMs);
  if (process.platform !== 'win32' || process.env.CODEX_EXECUTOR_TEST_ROOT) return Promise.resolve(null);
  let pwsh, script;
  try {
    ({ pwsh, script } = buildAgyKeyringScript(options));
  } catch {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    let stdout = '', settled = false;
    const finish = val => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(val);
    };
    let child;
    try {
      child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => {
      try { killChildTree(child); } catch {}
      finish(null);
    }, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', () => finish(null));
    child.on('close', code => {
      if (code !== 0) return finish(null);
      const parsed = Number(String(stdout || '').trim());
      finish(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
    });
  });
}

function resolveAgyRetryPlan(options = {}) {
  if (options.retryOnSuppressedOAuth === false) return { maxAttempts: 1, delaysMs: [] };
  const delaysMs = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : DEFAULT_AGY_OAUTH_RETRY_DELAYS_MS;
  const maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts >= 1
    ? options.maxAttempts
    : 1 + delaysMs.length;
  return { maxAttempts, delaysMs };
}

function isRetryableAgyProbeFailure(result, attempt = 1) {
  if (!result || result.available) return false;
  // If CLI log proved credentials are missing or explicitly revoked (`auth_required`), retry at most once
  // (to rule out a momentary keyring lock) instead of spinning 4 full cycles.
  if (result.failure_kind === 'auth_required') return attempt < 2;
  if (result.oauth_browser_suppressed) return true;
  return TRANSIENT_AGY_PROBE_ERR_RE.test(String(result.error || ''));
}

function runExternalAgyProbeAsync(command, options = {}) {
  if (!Array.isArray(command) || !command.length) return Promise.resolve(null);
  const timeout = options.timeoutMs ?? 15000;
  const explicitGraceMs = options.interceptGraceMs;
  const markerPath = options.interceptMarkerPath || null;
  const logFilePath = options.logFilePath || null;
  if (markerPath) { try { fs.unlinkSync(markerPath); } catch {} }
  if (logFilePath) { try { fs.unlinkSync(logFilePath); } catch {} }

  return new Promise(resolve => {
    let stdout = '', stderr = '', settled = false, interceptAbortTimer = null;
    const spawnedAtMs = Date.now();
    const cleanupFiles = () => {
      if (markerPath) { try { fs.unlinkSync(markerPath); } catch {} }
      if (logFilePath) { try { fs.unlinkSync(logFilePath); } catch {} }
    };
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interceptPoll);
      if (interceptAbortTimer) clearTimeout(interceptAbortTimer);
      const logDiag = logFilePath ? inspectAgyCliLog(logFilePath) : null;
      cleanupFiles();
      if (result && typeof result === 'object') {
        if (logDiag?.account_email && !result.account_email) result.account_email = logDiag.account_email;
        if (!result.available && !result.failure_kind) {
          if (logDiag?.definite_auth_drop) {
            result.failure_kind = 'auth_required';
            result.error = logDiag.explicit_revoked
              ? 'AGY OAuth refresh_token 已失效或被吊销（需在 CC Switch 或 Mode.ps1 agy-login 重新登录）'
              : '未检测到有效的 Antigravity CLI 登录凭据（需在 CC Switch 或 Mode.ps1 agy-login 登录）';
          } else if (result.oauth_browser_suppressed || logDiag?.timed_out_10s) {
            result.failure_kind = 'oauth_refresh_timeout';
          } else {
            result.failure_kind = 'probe_error';
          }
        }
      }
      resolve(result);
    };
    let child;
    try {
      const env = options.allowBrowser === true
        ? cleanOfficialAgyEnv(options.env || process.env)
        : withNoBrowserEnv(options.env || process.env, options.noBrowserBinDir, markerPath);
      child = spawn(command[0], command.slice(1), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env
      });
    } catch (error) {
      finish({ available: false, failure_kind: 'probe_error', error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      killChildTree(child);
      finish({ available: false, error: `AGY quota probe timed out after ${timeout}ms` });
    }, timeout);
    // When Google's closed-source `agy.exe` (`keyring.go:111`) hits its hardcoded 10s timeout refreshing an expired
    // hourly access_token, `printmode.go:433` calls `rundll32 url.dll,FileProtocolHandler`.
    // Our `no-browser-bin/rundll32.cmd` blocks the browser popup and writes `markerPath`;
    // wait `graceMs` (6s if 10s refresh is in flight, 600ms if keyring failed immediately) so `keyringAuth` can save the new token.
    const interceptPoll = (!options.allowBrowser && markerPath) ? setInterval(() => {
      if (interceptAbortTimer || !fs.existsSync(markerPath)) return;
      const elapsedMs = Date.now() - spawnedAtMs;
      const graceMs = explicitGraceMs ?? (elapsedMs >= 8000 ? 6000 : 600);
      interceptAbortTimer = setTimeout(() => {
        killChildTree(child);
        finish({
          available: false,
          oauth_browser_suppressed: true,
          intercept_elapsed_ms: elapsedMs,
          error: 'AGY silent OAuth refresh exceeded 10s; interactive browser sign-in popup was suppressed'
        });
      }, graceMs);
      interceptAbortTimer.unref?.();
    }, 250) : null;
    interceptPoll?.unref?.();

    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-262144); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4096); });
    child.once('error', error => finish({ available: false, error: error.message }));
    child.once('close', code => {
      if (!options.allowBrowser && markerPath && fs.existsSync(markerPath) && code !== 0) {
        finish({
          available: false,
          oauth_browser_suppressed: true,
          intercept_elapsed_ms: Date.now() - spawnedAtMs,
          error: 'AGY silent OAuth refresh failed; interactive browser sign-in popup was suppressed'
        });
        return;
      }
      if (code !== 0) {
        finish({ available: false, error: (stderr || stdout || `exit ${code}`).trim().slice(0, 400) });
        return;
      }
      try {
        finish(parseAgyProbePayload(JSON.parse(stdout.trim())));
      } catch (error) {
        finish({ available: false, error: error.message });
      }
    });
  });
}

function defaultAgyProbeHome(options = {}) {
  const configured = options?.probeHomeDir
    || options?.projectPolicy?.agy_probe_home
    || options?.policy?.agy_probe_home
    || process.env.CODEX_EXECUTOR_AGY_PROBE_HOME
    || null;
  if (typeof configured === 'string' && configured.trim()) {
    const resolved = path.resolve(configured.trim());
    if (path.isAbsolute(resolved) && /^[\x20-\x7e]+$/.test(resolved)) return resolved;
  }
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'agy', 'probe-home') : null,
    path.join(os.tmpdir(), 'agy-probe-home'),
    process.platform === 'win32' ? 'C:\\Windows\\Temp\\agy-probe-home' : '/tmp/agy-probe-home'
  ].filter(Boolean);
  return candidates.find(p => /^[\x20-\x7e]+$/.test(p)) || candidates[0];
}

function rotateAgyProbeLogs(probeHome, options = {}) {
  const maxLogs = Number.isInteger(options.maxLogs) && options.maxLogs >= 1 ? options.maxLogs : 10;
  const nowMs = options.nowMs ?? Date.now();
  const dryRun = options.dryRun === true;
  let pruned = 0;
  let freedBytes = 0;
  if (!probeHome || !fs.existsSync(probeHome)) return { pruned, freed_bytes: freedBytes };

  // 1. Rotate `antigravity-cli/log/cli-*.log` keeping the newest `maxLogs` files.
  const logDir = path.join(probeHome, 'antigravity-cli', 'log');
  if (fs.existsSync(logDir)) {
    try {
      const logs = fs.readdirSync(logDir, { withFileTypes: true })
        .filter(e => e.isFile() && /^cli-.*\.log$/i.test(e.name))
        .map(e => {
          const p = path.join(logDir, e.name);
          const st = fs.statSync(p);
          return { p, mtimeMs: st.mtimeMs, size: st.size };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const item of logs.slice(maxLogs)) {
        pruned += 1;
        freedBytes += item.size;
        if (!dryRun) { try { fs.unlinkSync(item.p); } catch {} }
      }
    } catch {}
  }

  // 2. Clean orphaned temporary `probe-cli-*.log` / `login-cli-*.log` / `oauth-intercept-*.flag` older than 1 hour.
  try {
    for (const e of fs.readdirSync(probeHome, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      if (!/^(?:probe-cli-|login-cli-|oauth-intercept-|pool-oauth-intercept-)/i.test(e.name)) continue;
      const p = path.join(probeHome, e.name);
      const st = fs.statSync(p);
      if (nowMs - st.mtimeMs > 3600 * 1000) {
        pruned += 1;
        freedBytes += st.size;
        if (!dryRun) { try { fs.unlinkSync(p); } catch {} }
      }
    }
  } catch {}

  return { pruned, freed_bytes: freedBytes };
}

function prepareSilentAgyProbeHome(probeHome, nowMs = Date.now(), options = {}) {
  if (!probeHome) return { noBrowserBinDir: null };
  let noBrowserBinDir = null;
  try {
    const cliDir = path.join(probeHome, 'antigravity-cli');
    fs.mkdirSync(cliDir, { recursive: true });
    // 1. Keep `last_check.timestamp` fresh so `auto_updater.go` never spawns a detached updater console window.
    const tsFile = path.join(cliDir, 'last_check.timestamp');
    const nowDate = new Date(nowMs);
    if (!fs.existsSync(tsFile)) fs.writeFileSync(tsFile, '', 'utf8');
    else fs.utimesSync(tsFile, nowDate, nowDate);

    // 2. Rotate old `cli-*.log` files so probe-home stays bounded on disk.
    rotateAgyProbeLogs(probeHome, { maxLogs: options.maxLogs ?? 10, nowMs });

    // 3. Install private PATH shim to block `agy.exe` (`printmode.go:433` -> `rundll32 url.dll,FileProtocolHandler`)
    //    from ever opening the user's web browser when hourly token refresh takes >10s!
    noBrowserBinDir = path.join(probeHome, 'no-browser-bin');
    fs.mkdirSync(noBrowserBinDir, { recursive: true });
    if (process.platform === 'win32') {
      const shimPath = path.join(noBrowserBinDir, 'rundll32.cmd');
      const shimBody = [
        '@echo off',
        'echo.%* | findstr /I "FileProtocolHandler" >nul',
        'if %ERRORLEVEL% EQU 0 (',
        '  if defined AGY_BROWSER_INTERCEPT_MARKER echo INTERCEPTED>"%AGY_BROWSER_INTERCEPT_MARKER%"',
        '  exit /b 1',
        ')',
        '"%SystemRoot%\\System32\\rundll32.exe" %*',
        ''
      ].join('\r\n');
      if (!fs.existsSync(shimPath) || fs.readFileSync(shimPath, 'utf8') !== shimBody) {
        fs.writeFileSync(shimPath, shimBody, 'utf8');
      }
    } else {
      for (const opener of ['xdg-open', 'open']) {
        const shimPath = path.join(noBrowserBinDir, opener);
        const shimBody = '#!/bin/sh\n[ -n "$AGY_BROWSER_INTERCEPT_MARKER" ] && echo INTERCEPTED > "$AGY_BROWSER_INTERCEPT_MARKER"\nexit 1\n';
        if (!fs.existsSync(shimPath)) {
          fs.writeFileSync(shimPath, shimBody, { encoding: 'utf8', mode: 0o755 });
        }
      }
    }
  } catch {}
  return { noBrowserBinDir };
}

async function probeAgyQuotaAsync(projectPolicy, options = {}) {
  const { maxAttempts, delaysMs } = resolveAgyRetryPlan(options);
  if (Array.isArray(projectPolicy?.agy_quota_command) && projectPolicy.agy_quota_command.length > 0) {
    let last = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleepMs(delaysMs[Math.min(attempt - 2, delaysMs.length - 1)] ?? 0);
      last = await runExternalAgyProbeAsync(projectPolicy.agy_quota_command, options);
      if (last && typeof last === 'object') last = { ...last, attempts: attempt };
      if (!isRetryableAgyProbeFailure(last, attempt)) return last;
    }
    return last;
  }
  const agyBin = resolveRealAgyBin(options);
  if (!agyBin) return null;
  const probeHome = options.probeHomeDir || defaultAgyProbeHome({ projectPolicy });
  const { noBrowserBinDir } = prepareSilentAgyProbeHome(probeHome, options.nowMs);
  const runOnce = attempt => {
    const stamp = `${process.pid}-${Date.now()}-${attempt}`;
    const marker = path.join(probeHome, `oauth-intercept-${stamp}.flag`);
    const logFile = path.join(probeHome, `probe-cli-${stamp}.log`);
    const cmdPrefix = Array.isArray(agyBin) ? agyBin : [agyBin];
    return runExternalAgyProbeAsync(
      [...cmdPrefix, `--log-file=${logFile}`, `--gemini_dir=${probeHome}`, '--print', '/usage', '--output-format', 'json'],
      { timeoutMs: 65000, noBrowserBinDir, interceptMarkerPath: marker, logFilePath: logFile, ...options }
    );
  };
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleepMs(delaysMs[Math.min(attempt - 2, delaysMs.length - 1)] ?? 0);
    last = await runOnce(attempt);
    if (last && typeof last === 'object') last = { ...last, attempts: attempt };
    // Retry up to maxAttempts on slow >10s OAuth refreshes (whose background goroutine writes the new token to keyring)
    // as well as transient proxy/TLS timeouts; stop after 2 attempts if CLI log proved credentials are missing/revoked!
    if (!isRetryableAgyProbeFailure(last, attempt)) return last;
  }
  return last;
}

async function runAgyInteractiveLoginAsync(options = {}) {
  const agyBin = resolveRealAgyBin(options);
  if (!agyBin) {
    return {
      ok: false,
      error: '未找到本机官方 agy CLI（%LOCALAPPDATA%\\agy\\bin\\agy.exe），也可直接在 CC Switch 中完成 Antigravity 账号授权。'
    };
  }
  const probeHome = options.probeHomeDir || defaultAgyProbeHome({ projectPolicy: options.projectPolicy, policy: options.policy });
  prepareSilentAgyProbeHome(probeHome, options.nowMs);
  const logFile = path.join(probeHome, `login-cli-${process.pid}-${Date.now()}.log`);
  const cmdPrefix = Array.isArray(agyBin) ? agyBin : [agyBin];
  const probed = await runExternalAgyProbeAsync(
    [...cmdPrefix, `--log-file=${logFile}`, `--gemini_dir=${probeHome}`, '--print', '/usage', '--output-format', 'json'],
    { timeoutMs: options.timeoutMs ?? 180000, allowBrowser: true, logFilePath: logFile, env: options.env }
  );
  if (!probed?.available) {
    return {
      ok: false,
      error: probed?.error || 'Antigravity 登录或配额校验未完成',
      probed
    };
  }
  return {
    ok: true,
    account_email: probed.account_email || null,
    agy_external: probed
  };
}

function evaluateAgyProbeHealth({ probed, prevHealth, prevExternal, prevProbedAt, ccSwitchMtimeMs = null, keyringLastWrittenMs = null, nowMs = Date.now(), modeScriptPath = null }) {
  const nowIso = new Date(nowMs).toISOString();
  const loginCmd = modeScriptPath
    ? `pwsh -NoProfile -File "${modeScriptPath.replace(/\\/g, '/')}" agy-login`
    : 'pwsh -NoProfile -File scripts/Mode.ps1 agy-login';

  if (probed === null) {
    return {
      status: 'cli_not_installed',
      alert_needed: false,
      consecutive_failures: 0,
      account_email: null,
      account_switched: false,
      account_switched_at: prevHealth?.account_switched_at || null,
      cc_switch_mtime_ms: ccSwitchMtimeMs,
      keyring_last_written_ms: keyringLastWrittenMs,
      last_success_at: prevHealth?.last_success_at || null,
      since: null,
      last_error: null,
      recovery_command: null,
      message: null
    };
  }

  if (probed.available) {
    const nextEmail = probed.account_email || prevHealth?.account_email || null;
    const accountSwitched = Boolean(
      probed.account_email
      && prevHealth?.account_email
      && probed.account_email.toLowerCase() !== prevHealth.account_email.toLowerCase()
    );
    return {
      status: 'healthy',
      alert_needed: false,
      consecutive_failures: 0,
      account_email: nextEmail,
      account_switched: accountSwitched,
      account_switched_at: accountSwitched ? nowIso : (prevHealth?.account_switched_at || null),
      cc_switch_mtime_ms: ccSwitchMtimeMs,
      keyring_last_written_ms: keyringLastWrittenMs,
      last_success_at: nowIso,
      since: null,
      last_error: null,
      recovery_command: null,
      message: null
    };
  }

  const consecutive = (prevHealth?.consecutive_failures || 0) + 1;
  const definiteAuthDrop = probed.failure_kind === 'auth_required';
  const repeatedAuthTimeout = Boolean(probed.oauth_browser_suppressed && consecutive >= 2);
  let status;
  if (definiteAuthDrop || repeatedAuthTimeout) {
    status = 'auth_required';
  } else if (consecutive >= 2) {
    status = 'quota_unreachable';
  } else {
    status = 'transient_retry';
  }

  const alertNeeded = status === 'auth_required' || status === 'quota_unreachable';
  const prevSameAlert = alertNeeded && prevHealth?.status === status && prevHealth?.since;
  const since = alertNeeded ? (prevSameAlert ? prevHealth.since : nowIso) : null;
  const prevMs = Date.parse(prevProbedAt || '');
  const canKeepRecentStale = status === 'transient_retry'
    && Boolean(prevExternal?.available)
    && Number.isFinite(prevMs)
    && (nowMs - prevMs <= 30 * 60 * 1000);

  const message = status === 'auth_required'
    ? `检测到本机 Antigravity 账号授权已掉线或失效（后台已拦截自动打开浏览器，避免打断工作）。请在 CC Switch 中重新授权/切换账号，或执行一键登录恢复：${loginCmd}`
    : status === 'quota_unreachable'
      ? `Antigravity 官方五桶额度已连续 ${consecutive} 轮查询失败（最近原因：${probed.error || '未知错误'}；后台未打开浏览器）。请检查代理网络、CC Switch 账号状态，或执行 ${loginCmd} 验证登录。`
      : null;

  return {
    status,
    alert_needed: alertNeeded,
    consecutive_failures: consecutive,
    failure_kind: probed.failure_kind || 'probe_error',
    account_email: prevHealth?.account_email || null,
    account_switched: false,
    account_switched_at: prevHealth?.account_switched_at || null,
    cc_switch_mtime_ms: ccSwitchMtimeMs,
    keyring_last_written_ms: keyringLastWrittenMs,
    last_success_at: prevHealth?.last_success_at || null,
    since,
    last_error: probed.error || null,
    recovery_command: alertNeeded ? loginCmd : null,
    keep_recent_stale: canKeepRecentStale,
    message
  };
}

const VALID_AGY_EXEC_MODES = new Set(['plan', 'auto', 'accept-edits']);

async function runAgyPoolTaskAsync(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const projectPolicy = options.projectPolicy || resolveProjectPolicy(defaultPolicy());
  const poolsCfg = projectPolicy.agy_model_pools || {};
  const poolKey = String(options.poolName || '').trim().toLowerCase();
  if (!poolKey || !poolsCfg[poolKey]) {
    const known = Object.keys(poolsCfg);
    return {
      ok: false,
      blocked: false,
      kind: 'unknown_pool',
      error: `未找到独立模型池 "${poolKey || ''}"${known.length ? `（已配置池：${known.join(', ')}）` : '（尚未在 routing-policy.json 配置 agy_model_pools）'}。`
    };
  }
  const poolCfg = poolsCfg[poolKey];
  const execMode = String(options.execMode || 'plan').trim().toLowerCase();
  if (!VALID_AGY_EXEC_MODES.has(execMode)) {
    return {
      ok: false,
      blocked: false,
      kind: 'invalid_exec_mode',
      error: `不支持的 --exec-mode "${options.execMode}"；仅支持 plan（默认只读审查）、auto 或 accept-edits。`
    };
  }

  const poolsState = evaluateAgyModelPools({
    agyUsage: options.agyUsage || { available: false },
    agyExternal: options.agyExternal || null,
    projectPolicy,
    codexPacing: options.codexPacing || { available: false },
    nowMs
  });
  const poolState = poolsState[poolKey];
  if (poolState?.stopped && options.force !== true) {
    const backups = Array.isArray(projectPolicy.thinking_backups) ? projectPolicy.thinking_backups : [];
    const safeBackups = backups.filter(m => !String(m).toLowerCase().includes(poolState.match));
    return {
      ok: false,
      blocked: true,
      kind: 'pool_quota_protected',
      pool: poolKey,
      pool_state: poolState,
      error: `[POOL_QUOTA_PROTECTED] 本地 ${poolKey} 模型池已触及保护线（原因：${poolState.reason || 'stopped'}，7天已用 ${poolState.weekly_used_percent ?? '?'}% / 上限 ${poolState.weekly_protect_used_percent}%，5h已用 ${poolState.five_hour_used_percent ?? '?'}%），已停止调用以保留应急缓冲${safeBackups.length ? `；请改用备用模型：${safeBackups.join(' → ')}` : ''}。`
    };
  }

  const explicitModel = typeof options.model === 'string' && options.model.trim() ? options.model.trim() : null;
  const targetModel = explicitModel || (execMode === 'plan'
    ? (poolCfg.review_model || poolCfg.default_model)
    : (poolCfg.default_model || poolCfg.review_model));
  if (!targetModel) {
    return {
      ok: false,
      blocked: false,
      kind: 'missing_pool_model',
      pool: poolKey,
      error: `模型池 "${poolKey}" 尚未登记默认模型 ID；请运行 scripts/Mode.ps1 pool --name ${poolKey} --review-model <MODEL_ID> --default-model <MODEL_ID>（可通过 agy models 查看本机官方模型 ID）。`
    };
  }

  const promptText = typeof options.prompt === 'string' ? options.prompt.trim() : '';
  if (!promptText) {
    return { ok: false, blocked: false, kind: 'empty_prompt', error: '缺少审查/执行提示词（--prompt 或 --prompt-file）。' };
  }

  const agyBin = resolveRealAgyBin(options);
  if (!agyBin) {
    return {
      ok: false,
      blocked: false,
      kind: 'agy_cli_missing',
      error: '未找到本机官方 agy CLI 可执行文件（%LOCALAPPDATA%\\agy\\bin\\agy.exe），无法后台直调本地模型池；可在 Antigravity 聊天窗左上角手动切换至对应本地模型。'
    };
  }

  const probeHome = options.probeHomeDir || defaultAgyProbeHome({ projectPolicy });
  const { noBrowserBinDir } = prepareSilentAgyProbeHome(probeHome, nowMs);
  const cliArgs = [
    `--gemini_dir=${probeHome}`,
    '--model', targetModel,
    '--mode', execMode,
    '--dangerously-skip-permissions',
    ...(options.cwd ? ['--add-dir', path.resolve(options.cwd)] : []),
    ...(options.conversationId ? ['--conversation', String(options.conversationId).trim()] : []),
    '--print', promptText,
    '--output-format', 'json'
  ];
  const timeout = options.timeoutMs ?? 600000;
  const explicitGraceMs = options.interceptGraceMs;
  const { maxAttempts, delaysMs } = resolveAgyRetryPlan(options);

  const runPoolOnce = attempt => new Promise(resolve => {
    const markerPath = path.join(probeHome, `pool-oauth-intercept-${process.pid}-${Date.now()}-${attempt}.flag`);
    try { fs.unlinkSync(markerPath); } catch {}
    let stdout = '', stderr = '', settled = false, interceptAbortTimer = null;
    const spawnedAtMs = Date.now();
    const finish = payload => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(interceptPoll);
      if (interceptAbortTimer) clearTimeout(interceptAbortTimer);
      try { fs.unlinkSync(markerPath); } catch {}
      resolve({ ...payload, attempts: attempt });
    };
    let child;
    try {
      const cmd = Array.isArray(agyBin) ? agyBin[0] : agyBin;
      const fullArgs = Array.isArray(agyBin) ? [...agyBin.slice(1), ...cliArgs] : cliArgs;
      child = spawn(cmd, fullArgs, {
        cwd: options.cwd ? path.resolve(options.cwd) : undefined,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: withNoBrowserEnv(options.env || process.env, noBrowserBinDir, markerPath)
      });
    } catch (error) {
      finish({ ok: false, blocked: false, kind: 'spawn_error', pool: poolKey, model: targetModel, error: error.message });
      return;
    }
    const timer = setTimeout(() => {
      killChildTree(child);
      finish({ ok: false, blocked: false, kind: 'timeout', pool: poolKey, model: targetModel, error: `本地 ${poolKey} 模型池调用超时（>${timeout}ms）` });
    }, timeout);
    const interceptPoll = setInterval(() => {
      if (interceptAbortTimer || !fs.existsSync(markerPath)) return;
      const elapsedMs = Date.now() - spawnedAtMs;
      const graceMs = explicitGraceMs ?? (elapsedMs >= 8000 ? 6000 : 600);
      interceptAbortTimer = setTimeout(() => {
        killChildTree(child);
        finish({
          ok: false,
          blocked: false,
          kind: 'oauth_browser_suppressed',
          pool: poolKey,
          model: targetModel,
          error: `本机 Antigravity OAuth 静默令牌刷新连续 ${attempt} 次超过 10s，已自动拦截浏览器登录弹窗；请检查网络代理或在 Antigravity CLI 核查登录状态。`
        });
      }, graceMs);
      interceptAbortTimer.unref?.();
    }, 250);
    interceptPoll.unref?.();
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1048576); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.once('error', error => finish({ ok: false, blocked: false, kind: 'spawn_error', pool: poolKey, model: targetModel, error: error.message }));
    child.once('close', code => {
      if (markerPath && fs.existsSync(markerPath) && code !== 0) {
        finish({
          ok: false,
          blocked: false,
          kind: 'oauth_browser_suppressed',
          pool: poolKey,
          model: targetModel,
          error: `本机 Antigravity OAuth 静默令牌刷新失败（第 ${attempt} 次尝试），已自动拦截浏览器登录弹窗。`
        });
        return;
      }
      if (code !== 0) {
        finish({ ok: false, blocked: false, kind: 'cli_exit_nonzero', pool: poolKey, model: targetModel, exit_code: code, error: (stderr || stdout || `exit ${code}`).trim().slice(0, 800) });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        const ok = String(parsed.status || '').toUpperCase() === 'SUCCESS' && !(Array.isArray(parsed.denied_actions) && parsed.denied_actions.length > 0 && !parsed.response);
        finish({
          ok,
          blocked: false,
          pool: poolKey,
          model: targetModel,
          mode: execMode,
          conversation_id: parsed.conversation_id || null,
          status: parsed.status || null,
          response: typeof parsed.response === 'string' ? parsed.response : '',
          usage: parsed.usage || null,
          duration_seconds: parsed.duration_seconds ?? null,
          num_turns: parsed.num_turns ?? null,
          denied_actions: parsed.denied_actions || null,
          pool_state: poolState,
          ...(ok ? {} : { error: (stderr || `status=${parsed.status}`).trim().slice(0, 600) })
        });
      } catch (error) {
        finish({ ok: false, blocked: false, kind: 'parse_error', pool: poolKey, model: targetModel, error: error.message, raw_stdout: stdout.slice(0, 600) });
      }
    });
  });

  // `oauth_browser_suppressed` occurs in `printmode.go:410->433` BEFORE any prompt/model turn starts,
  // so multi-attempt stepped-backoff retries are 100% side-effect-free!
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleepMs(delaysMs[Math.min(attempt - 2, delaysMs.length - 1)] ?? 0);
    last = await runPoolOnce(attempt);
    if (last.ok || last.kind !== 'oauth_browser_suppressed') return last;
  }
  return last;
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

function codexIsExhausted(p) {
  if (!p?.available) return false;
  if (typeof p.exhausted === 'boolean') return p.exhausted;
  // Older cache writers omit `exhausted`; derive it so handover never silently disables.
  return p.hard_limited === true || (typeof p.used_percent === 'number' && p.used_percent >= 100);
}

function evaluateAgyUsageAlert({ agyPacing, codexPacing, mode }) {
  const w7 = agyPacing?.window_7d;
  const w5 = agyPacing?.window_5h;
  const codexNote = codexPacing?.available
    ? `Codex 当前已用 ${codexPacing.used_percent}%`
    : 'Codex 可分担执行';
  const anchor7d = w7?.resets_at || 'active-7d';
  const anchor5h = w5?.resets_at || 'active-5h';

  if (w7?.available && w7.band === 'agy_protected') {
    return {
      level: 'weekly_protected',
      alert_key: `weekly_protected:${anchor7d}`,
      title: `Antigravity 周额度已触及 ${w7.protect_used_percent}% 保护线`,
      message: `AGY 7天额度已用 ${w7.used_percent}%（触及 ${w7.protect_used_percent}% 保护线，保留 ${w7.buffer_percent}% 主对话缓冲），${codexNote}；后续执行与子代理已硬性交由 Codex 接管。`
    };
  }
  if (w5?.status === 'limited') {
    return {
      level: '5h_protected',
      alert_key: `5h_protected:${anchor5h}`,
      title: 'Antigravity 5小时额度已达保护线',
      message: `AGY 5小时窗口已受限（${w5.used_percent !== null ? `已用 ${w5.used_percent}%，` : ''}原因=${w5.reason || 'limited'}），${codexNote}；当前窗口重置前执行已切往 Codex 兜底。`
    };
  }
  if (w7?.available && typeof w7.used_percent === 'number' && w7.used_percent >= 75) {
    return {
      level: 'weekly_75_high',
      alert_key: `weekly_75_high:${anchor7d}`,
      title: `Antigravity 周额度高水位提醒（已用 ${w7.used_percent}%）`,
      message: `AGY 7天额度已消耗 ${w7.used_percent}%（距 ${w7.protect_used_percent}% 保护线仅剩 ${w7.usable_remaining_percent}%${typeof w7.hours_until_reset === 'number' ? `，距周重置 ${w7.hours_until_reset}h` : ''}），${codexNote}；重任务请优先使用 Codex。`
    };
  }
  if (
    mode !== 'agy'
    && w7?.available
    && typeof w7.pacing_delta === 'number'
    && w7.pacing_delta > 10
  ) {
    const step = w7.pacing_delta >= 40 ? 40 : (w7.pacing_delta >= 25 ? 25 : 10);
    return {
      level: 'weekly_overburn',
      alert_key: `weekly_overburn_${step}:${anchor7d}`,
      title: `Antigravity 线性消耗超前提醒（已用 ${w7.used_percent}%，超前 +${w7.pacing_delta}%）`,
      message: `AGY 7天额度已用 ${w7.used_percent}%（当前时间线性目标 ${w7.target_used_percent}%，已超前 +${w7.pacing_delta}% > 10% 提醒线${typeof w7.hours_until_reset === 'number' ? `，距周重置 ${w7.hours_until_reset}h` : ''}），${codexNote}；当前线性阶段仅提醒不拦截，建议后续新任务优先使用 Codex。`
    };
  }
  if (w5?.status === 'caution' && typeof w5.used_percent === 'number') {
    return {
      level: '5h_75_caution',
      alert_key: `5h_75_caution:${anchor5h}`,
      title: `Antigravity 5小时额度警戒（已用 ${w5.used_percent}%）`,
      message: `AGY 5小时窗口已用 ${w5.used_percent}%（≥${w5.caution_percent}% 警戒线），${codexNote}；建议将执行任务分流给 Codex。`
    };
  }
  return null;
}

function decideRoute(input = {}) {
  const nowMs = input.nowMs ?? Date.now();
  const policy = input.projectPolicy || resolveProjectPolicy(input.policy || defaultPolicy(), input.projectScope);
  const mode = policy.mode;
  const codexPacing = input.codexPacing || { available: false };
  const agyUsage = input.agyUsage || { available: false };
  const agyExternal = input.agyExternal || null;
  const agyHealth = input.agyHealth || null;
  const agyPacing = input.agyPacing || evaluateAgyPacing({ agyUsage, agyExternal, agyHealth, projectPolicy: policy, codexPacing, nowMs });
  const activeTasks = input.activeCodexTasks || { count: 0, orphaned: 0, tasks: [] };
  const currentModelName = typeof input.modelName === 'string' ? input.modelName : '';

  const codexCooling = cooldownActive(policy.cooldowns?.codex, nowMs);
  const agy5hLimited = agyPacing.window_5h.status === 'limited';
  const agy5hCaution = agyPacing.window_5h.status === 'caution';
  const agy7dProtected = agyPacing.window_7d.band === 'agy_protected';
  const agyConstrained = agy5hLimited || agy7dProtected;
  const agyExhausted = Boolean(agyPacing.exhausted);
  const codexExhausted = codexIsExhausted(codexPacing);
  const codexHardBlocked = codexCooling || codexPacing.hard_limited === true || codexPacing.band === 'codex_protected';
  const dualMargin = policy.agy_pacing?.dual_compare_margin ?? DEFAULT_AGY_PACING.dual_compare_margin;

  const resetCandidates = [
    codexPacing.hours_until_reset,
    agyPacing.window_5h.hours_until_reset,
    agyPacing.window_7d.hours_until_reset
  ].filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const earliestResetHours = resetCandidates.length ? round2(Math.min(...resetCandidates)) : null;

  let preferredEngine = 'codex';
  let fallbackEngine = 'codex';
  let reason = 'default_codex_first';
  let agyAllowed = mode !== 'codex';
  let codexAllowed = mode !== 'agy';
  let emergencyRationing = false;

  if (mode === 'codex') {
    preferredEngine = 'codex';
    fallbackEngine = null;
    reason = 'locked_codex_mode';
  } else if (mode === 'agy') {
    preferredEngine = 'agy';
    fallbackEngine = 'codex';
    reason = agy5hLimited ? 'locked_agy_mode_5h_limited_warning' : 'locked_agy_mode';
  } else {
    // Auto mode: Dual proportional pacing + final-6h AGY 10% buffer unlock + symmetric exhaustion handover.
    if (agyConstrained && !codexHardBlocked) {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      if (codexPacing.available) agyAllowed = false;
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
      fallbackEngine = codexExhausted ? null : 'codex';
      if (codexExhausted) codexAllowed = false;
      reason = codexCooling
        ? 'codex_cooldown_route_agy'
        : (codexExhausted ? 'codex_exhausted_handover_agy' : 'codex_protected_route_agy');
    } else if (codexHardBlocked && agyConstrained) {
      if (codexExhausted && agyExhausted) {
        preferredEngine = 'paused';
        fallbackEngine = null;
        agyAllowed = false;
        codexAllowed = false;
        reason = 'both_engines_exhausted_await_user_or_switch';
      } else if (codexExhausted && !agyExhausted) {
        preferredEngine = 'agy';
        fallbackEngine = null;
        codexAllowed = false;
        emergencyRationing = true;
        reason = 'codex_exhausted_agy_emergency_rationing';
      } else if (agyExhausted && !codexExhausted) {
        preferredEngine = 'codex';
        fallbackEngine = null;
        agyAllowed = false;
        emergencyRationing = true;
        reason = 'agy_exhausted_codex_emergency_rationing';
      } else {
        const agyRem = Math.min(agyPacing.window_5h.remaining_percent ?? 100, agyPacing.window_7d.remaining_percent ?? 100);
        const codexRem = codexPacing.remaining_percent ?? 0;
        emergencyRationing = true;
        if (agyRem > codexRem) {
          preferredEngine = 'agy';
          fallbackEngine = 'codex';
          reason = 'both_soft_buffered_agy_more_headroom_rationing';
        } else {
          preferredEngine = 'codex';
          fallbackEngine = 'agy';
          reason = 'both_soft_buffered_codex_more_headroom_rationing';
        }
      }
    } else if (!codexPacing.available) {
      if ((activeTasks?.count || 0) >= 2 && !agyConstrained) {
        preferredEngine = agy5hCaution ? 'balanced' : 'agy';
        fallbackEngine = 'codex';
        reason = 'codex_quota_unavailable_busy_route_agy';
      } else {
        preferredEngine = 'codex';
        fallbackEngine = 'codex';
        reason = 'codex_quota_unavailable_codex_first';
      }
    } else if (codexPacing.band === 'codex_drain') {
      preferredEngine = 'codex';
      fallbackEngine = 'codex';
      reason = 'codex_end_of_window_drain';
    } else if (agyPacing.window_7d.available && codexPacing.pacing_delta !== null && codexPacing.pacing_delta !== undefined && agyPacing.window_7d.pacing_delta !== null && agyPacing.window_7d.pacing_delta !== undefined) {
      // Both sides have calibrated 7-day proportional pacing (including 0% unactivated windows):
      // route to whichever side is further behind its 7-day pace, while respecting AGY's 5h caution guard.
      if (agyPacing.window_7d.band === 'agy_drain' && !agy5hCaution) {
        preferredEngine = 'agy';
        fallbackEngine = 'codex';
        reason = 'agy_end_of_window_drain';
      } else {
        const diff = round2(codexPacing.pacing_delta - agyPacing.window_7d.pacing_delta);
        if (diff > dualMargin) {
          // Codex is ahead of AGY relative to 7-day pace => prefer AGY unless AGY 5h is in caution
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

  const agyPools = evaluateAgyModelPools({ agyUsage, agyExternal, projectPolicy: policy, codexPacing, nowMs });
  const poolForModel = modelStr => {
    if (!modelStr || typeof modelStr !== 'string') return null;
    const lower = modelStr.toLowerCase();
    for (const [name, st] of Object.entries(agyPools)) {
      if (lower.includes(st.match)) return { name, ...st };
    }
    return null;
  };
  const thinkingBackups = Array.isArray(policy.thinking_backups) ? policy.thinking_backups : [];
  const primaryThinking = policy.thinking_model || null;
  const primaryPool = poolForModel(primaryThinking);
  const currentHostPool = poolForModel(currentModelName);
  let effectiveThinking = primaryThinking;
  let thinkingFailoverReason = null;
  if (primaryThinking && primaryPool?.stopped) {
    const availableBackup = thinkingBackups.find(m => !poolForModel(m)?.stopped) || null;
    effectiveThinking = availableBackup || primaryThinking;
    thinkingFailoverReason = `${primaryPool.name} 池已触及 ${primaryPool.weekly_protect_used_percent}% 硬停线（剩余≤${primaryPool.buffer_percent}%缓冲）或 5h 保护线`;
  }
  const quantThinking = policy.review_category === 'quant' && effectiveThinking ? effectiveThinking : null;
  const knownHostModel = currentModelName && currentModelName.toLowerCase() !== 'auto';
  const quantModelMatched = quantThinking && knownHostModel
    ? currentModelName.toLowerCase().includes(quantThinking.toLowerCase())
    : null;
  const currentModelBlockedByPool = Boolean(knownHostModel && currentHostPool?.stopped);

  const effectivePlanDays = codexPacing.plan_days ?? policy.pacing?.plan_days ?? null;
  const codexPlanLabel = effectivePlanDays ? `${effectivePlanDays}天` : '7天';
  const codexSourceTag = codexPacing.stale ? '，缓存回退' : (codexPacing.fallback_after_timeout ? '，会话日志回退' : '');
  const codexResetLabel = typeof codexPacing.hours_until_reset === 'number' ? `距重置 ${codexPacing.hours_until_reset}h` : '窗口待激活';
  const codexDeltaLabel = typeof codexPacing.pacing_delta === 'number'
    ? `偏差 ${codexPacing.pacing_delta >= 0 ? '+' : ''}${codexPacing.pacing_delta}%，`
    : '';
  const codexProgressLabel = typeof codexPacing.elapsed_percent === 'number' ? `进度 ${codexPacing.elapsed_percent}% / ` : '';
  const codexText = codexPacing.available
    ? `Codex ${codexPlanLabel}${codexProgressLabel}已用 ${codexPacing.used_percent}%（${codexDeltaLabel}${codexResetLabel}${codexSourceTag}）`
    : ((activeTasks?.count || 0) >= 2 ? `Codex 实时配额超时（在途${activeTasks.count}个，暂分流AGY）` : 'Codex 实时配额暂未读取（默认优先 Codex）');

  const agy5hText = agyPacing.window_5h.used_percent !== null
    ? `AGY 5h已用 ${agyPacing.window_5h.used_percent}%（${agyPacing.window_5h.status}${agyPacing.window_5h.window_active === false ? '/待激活' : ''}）`
    : agyUsage.available && agyUsage.window_5h
      ? `AGY 近5h消耗 ${agyUsage.window_5h.total_tokens} tokens（状态=${agyPacing.window_5h.status}，限流错 ${agyUsage.quota_errors_5h ?? 0}）`
      : `AGY 5h状态=${agyPacing.window_5h.status}`;
  const agyTargetPct = agyPacing.window_7d.target_utilization ?? policy.agy_pacing?.target_utilization ?? DEFAULT_AGY_PACING.target_utilization;
  const agyBufferPct = agyPacing.window_7d.buffer_percent ?? round2(Math.max(0, 100 - (policy.agy_pacing?.weekly_protect_used_percent ?? DEFAULT_AGY_PACING.weekly_protect_used_percent)));
  const unlockTag = agyPacing.window_7d.buffer_unlocked ? `，≤${agyPacing.window_7d.buffer_unlock_window_hours}h已解锁10%缓冲` : '';
  const agy7dText = agyPacing.window_7d.available
    ? (agyPacing.window_7d.window_active === false
      ? `AGY 7天目标(${agyTargetPct}%上限/留${agyBufferPct}%缓冲) 待激活 / 已用 ${agyPacing.window_7d.used_percent}%`
      : `AGY 7天目标(${agyTargetPct}%上限/留${agyBufferPct}%缓冲${unlockTag}) 进度 ${agyPacing.window_7d.target_used_percent}% / 已用 ${agyPacing.window_7d.used_percent}%（偏差 ${agyPacing.window_7d.pacing_delta >= 0 ? '+' : ''}${agyPacing.window_7d.pacing_delta}%）`)
    : `AGY 7天未标定（上限${agyTargetPct}%/留${agyBufferPct}%缓冲，按本地5h+Codex${codexPlanLabel}均衡）`;

  const engineLabel = preferredEngine === 'paused'
    ? `双端耗尽暂停（最快 ${earliestResetHours ?? '?'}h 后重置 / 可用 CC Switch 切备用号）`
    : emergencyRationing
      ? `应急省流 → ${preferredEngine === 'agy' ? 'AGY 剩余缓冲' : 'Codex 剩余缓冲'}`
      : preferredEngine === 'codex'
        ? '优先 Codex（Codex 兜底）'
        : preferredEngine === 'balanced'
          ? 'Codex 与 AGY 混合均衡（Codex 兜底）'
          : codexExhausted
            ? 'AGY 全量接管（Codex 已100%耗尽，自动解粘性跨端交接）'
            : '优先 AGY 低成本多子代理（Codex 兜底）';

  const agyHealthTag = agyHealth?.status === 'auth_required'
    ? '｜告警=AGY登录已掉线(需重登)'
    : agyHealth?.status === 'quota_unreachable'
      ? `｜告警=AGY额度连续${agyHealth.consecutive_failures}次查询失败`
      : '';
  const summaryLine = `模式=${mode}｜路由=${engineLabel}｜${codexText}｜${agy7dText}｜${agy5hText}${agyHealthTag}${activeTasks.count ? `｜在途Codex任务=${activeTasks.count}` : ''}`;

  const handoverGuidance = preferredEngine === 'paused'
    ? `Codex 与 AGY 当前均已耗尽可用额度（最快重置倒计时：${earliestResetHours ?? '未知'}h）。已停止自动派发与空转重试；请向用户展示三个选项：① 等待最快窗口重置；② 在 CC Switch 切换到备用账号（自动共享生效）；③ 是否授权使用额外 Credits / 重置券。`
    : emergencyRationing
      ? `单边已 100% 硬归零，另一边已进入软缓冲应急区（当前启用 ${preferredEngine.toUpperCase()} 应急省流模式）：禁止批量扇出（run_workflow），仅用最低成本档位处理用户紧急指令，并提示最快重置剩余 ${earliestResetHours ?? '未知'}h。`
      : codexExhausted
        ? `Codex 周额度已 100% 耗尽（距重置 ${codexPacing.hours_until_reset ?? '?'}h）：原 Codex 未完事项自动解除粘性锁定，请先只读读取原任务 codex_result/job.json 与 Git 差异，在 AGY 无缝接力完成（未经用户明确授权禁止静默消耗额外 Credits 或重置券）。`
        : (agyConstrained && !codexHardBlocked && codexPacing.available)
          ? `AGY 已触及保护线（7天缓冲线或 5h 窗口限制），为保住主聊天窗不断粮，执行与子代理已硬性切往 Codex 接管。`
          : (preferredEngine === 'codex' && codexPacing.available && !codexHardBlocked && typeof agyPacing.window_7d?.pacing_delta === 'number' && agyPacing.window_7d.pacing_delta > 10)
            ? `Codex 当前额度充裕（已用 ${codexPacing.used_percent}%），而 AGY 7天消耗已超出线性目标 +${agyPacing.window_7d.pacing_delta}%：此前因 Codex 耗尽临时转交 AGY 的事项解除粘性锁定，新任务与下一批次请优先调用 codex_run 执行（当前线性阶段仅提醒引导，不硬拦截 AGY 操作）。`
            : null;

  const agyUsageAlert = evaluateAgyUsageAlert({ agyPacing, codexPacing, mode });

  return {
    mode,
    mode_source: policy.mode_source,
    preferred_engine: preferredEngine,
    fallback_engine: fallbackEngine,
    agy_allowed: agyAllowed,
    codex_allowed: codexAllowed,
    emergency_rationing: emergencyRationing,
    reason,
    codex_pacing: codexPacing,
    agy_pacing: agyPacing,
    agy_usage: agyUsage,
    agy_external: agyExternal,
    agy_health: agyHealth,
    agy_usage_alert: agyUsageAlert,
    agy_constrained: agyConstrained,
    agy_exhausted: agyExhausted,
    agy_5h_limited: agy5hLimited,
    agy_5h_caution: agy5hCaution,
    codex_hard_blocked: codexHardBlocked,
    codex_exhausted: codexExhausted,
    exhaustion_handover: {
      codex_exhausted: codexExhausted,
      agy_exhausted: agyExhausted,
      emergency_rationing: emergencyRationing,
      earliest_reset_hours: earliestResetHours,
      guidance: handoverGuidance
    },
    active_codex_tasks: activeTasks,
    agy_tiers: policy.agy_tiers,
    agy_host_models: policy.agy_host_models,
    agy_model_pools: agyPools,
    subagent_defaults: {
      default_model: policy.subagent_default_model,
      research_model: policy.subagent_research_model,
      enforce_low_cost: policy.enforce_subagent_low_cost
    },
    thinking_guidance: {
      review_category: policy.review_category,
      required_thinking_model: quantThinking || effectiveThinking || null,
      primary_thinking_model: primaryThinking,
      backups: thinkingBackups,
      failover_reason: thinkingFailoverReason,
      current_model_name: currentModelName || null,
      current_model_pool_stopped: currentModelBlockedByPool,
      matches_required: quantModelMatched,
      reminder: currentModelBlockedByPool
        ? `当前主会话模型所属 ${currentHostPool.name} 池已触及硬停保护（7天≥${currentHostPool.weekly_protect_used_percent}% 留${currentHostPool.buffer_percent}%缓冲，或 5h 受限），不可继续使用；请立即切换至备用模型${effectiveThinking && !poolForModel(effectiveThinking)?.stopped ? ` ${effectiveThinking}` : ''}${thinkingBackups.length ? `（备用顺序：${thinkingBackups.join(' → ')}）` : ''}。`
        : thinkingFailoverReason && effectiveThinking
          ? `${thinkingFailoverReason}，顶配思考自动切至备用模型 ${effectiveThinking}${thinkingBackups.length > 1 ? `（顺序：${thinkingBackups.join(' → ')}）` : ''}。`
          : quantThinking && quantModelMatched === false
            ? `当前为量化研究项目，建议将主会话模型切换为本机配置的 ${quantThinking} 最强思考模式${thinkingBackups.length ? `（备用顺序：${thinkingBackups.join(' → ')}）` : ''}；日常检索、改脚本与跑测试下沉给低成本子代理或 Codex。`
            : quantThinking
              ? `量化策略研究默认使用本机配置的 ${quantThinking} 最强模式思考${thinkingBackups.length ? `（备用：${thinkingBackups.join(' → ')}）` : ''}，核心思考子任务保留 inherit 不降级；执行与检索下沉低成本档位。`
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
const EXPLICIT_UPGRADE_RE = /\b(?:expert|complex|pro|audit|review|verify|analyze|investigate|architect)\b|最强思考|极难|深度推理|审核|审查|复核|终审|对抗|求证|根因|排障|架构|逆推|实证/i;

function matchesConfiguredThinkingModel(text, thinkingModel) {
  if (!thinkingModel || typeof text !== 'string') return false;
  return text.toLowerCase().includes(thinkingModel.toLowerCase());
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingModelPool(text, projectPolicy) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();
  for (const [name, cfg] of Object.entries(projectPolicy?.agy_model_pools || {})) {
    const token = String(cfg.match || name).toLowerCase();
    if (token && lower.includes(token)) return { name, token, cfg };
  }
  return null;
}

function checkExternalPoolCliMisuse(toolName, args = {}, projectPolicy, options = {}) {
  if (!/(?:^|[_/.:-])run_command$/i.test(toolName || '')) return { blocked: false };
  const cmd = String(args.CommandLine || args.command || '');
  if (!cmd.trim() || /ALLOW_EXTERNAL_POOL_CLI/i.test(cmd)) return { blocked: false };
  if (/Mode\.ps1|mode\.cjs/i.test(cmd) && /\bpool(?:-run)?\b/i.test(cmd)) return { blocked: false };

  const pools = Object.entries(projectPolicy?.agy_model_pools || {});
  if (!pools.length) return { blocked: false };
  const bridgeRoot = (options.bridgeRoot || path.resolve(__dirname, '..')).replace(/\\/g, '/');
  const projectRoot = (options.projectRoot || '<PROJECT_DIR>').replace(/\\/g, '/');

  for (const [poolName, cfg] of pools) {
    const token = String(cfg.match || poolName).trim().toLowerCase();
    if (!token || token.length < 2) continue;
    const esc = escapeRegExp(token);
    const externalWrapperRe = new RegExp(`\\b${esc}_mcp_server(?:\\.py)?\\b|\\b${esc}-code\\b`, 'i');
    const standaloneCliRe = new RegExp(`(?:^|[;&|()\\s"'\\\\/])${esc}(?:\\.exe|\\.cmd|\\.ps1)?\\s+(?:-p\\b|--print\\b|mcp\\b|--output-format\\b)`, 'i');
    if (externalWrapperRe.test(cmd) || standaloneCliRe.test(cmd)) {
      const modelHint = cfg.review_model || cfg.default_model || `<已配置${poolName}模型>`;
      return {
        blocked: true,
        kind: 'local_pool_available',
        pool: poolName,
        reason: `[LOCAL_POOL_AVAILABLE] 本机 Antigravity 已内置并配置了本地 "${poolName}" 模型池（默认审查模型：${modelHint}，直接共用当前 Antigravity 登录凭证与独立额度桶，无需外部 API Key），禁止在 Antigravity 中调用外部未登录的 ${token} CLI 或 ${token}_mcp_server 包装脚本！请直接改用受配额保护的本地模型池命令：\npwsh -NoProfile -File "${bridgeRoot}/scripts/Mode.ps1" pool-run --pool ${poolName} --cwd "${projectRoot}" --prompt-file "<UTF8提示词文件>"\n（默认 --exec-mode plan 只读审查，也支持直接传 --prompt "..."；或在聊天窗口左上角手动切换至本地 ${poolName} 模型）。`
      };
    }
  }
  return { blocked: false };
}

function evaluateSubagentCall(args = {}, projectPolicy, currentHostModelName = '') {
  const typeName = String(args.TypeName || args.typeName || args.type_name || 'self').trim().toLowerCase();
  const modelKey = Object.hasOwn(args, 'Model') ? 'Model' : Object.hasOwn(args, 'model') ? 'model' : 'Model';
  const currentModel = typeof args[modelKey] === 'string' ? args[modelKey].trim() : '';
  const roleAndPrompt = [args.Role, args.role, args.Prompt, args.prompt].filter(Boolean).join('\n');

  if (typeName === 'image-generator') return { overwrite: null, note: null };
  if (typeName === 'browser') {
    if (!currentModel) return { overwrite: { [modelKey]: 'flash' }, note: '浏览器子代理默认使用 flash。' };
    return { overwrite: null, note: null };
  }

  const hostPool = findMatchingModelPool(currentHostModelName, projectPolicy);
  const promptPool = findMatchingModelPool(roleAndPrompt, projectPolicy);
  if (hostPool && promptPool && hostPool.name === promptPool.name && (!currentModel || currentModel === 'inherit')) {
    return {
      overwrite: currentModel === 'inherit' ? null : { [modelKey]: 'inherit' },
      note: `主会话当前已处于本地 ${hostPool.name} 模型池且子任务明确点名该池，保留 Model="inherit" 直接复用本地 ${hostPool.name} 池模型，不降档为 flash。`
    };
  }
  const crossFamilyNote = (promptPool && (!hostPool || hostPool.name !== promptPool.name))
    ? `提示：invoke_subagent 的枚举仅支持 Gemini 子档位或继承当前主窗口模型，无法跨家族切换到本地 ${promptPool.name} 池；若用户明确要求由本地 ${promptPool.name} 池审查/执行，请直接运行 scripts/Mode.ps1 pool-run --pool ${promptPool.name}（共用本机 Antigravity 账号，无需外部 CLI）。`
    : null;

  const backupMatched = Array.isArray(projectPolicy.thinking_backups)
    && projectPolicy.thinking_backups.some(m => matchesConfiguredThinkingModel(roleAndPrompt, m));
  const isQuantThinking = projectPolicy.review_category === 'quant'
    && (QUANT_THINKING_RE.test(roleAndPrompt) || matchesConfiguredThinkingModel(roleAndPrompt, projectPolicy.thinking_model) || backupMatched)
    && !MECHANICAL_SUBTASK_RE.test(args.Role || args.role || '');

  if (isQuantThinking && (currentModel === 'inherit' || currentModel === 'pro')) {
    return { overwrite: null, note: ['量化策略核心思考子任务保留原高思考档位，不降级。', crossFamilyNote].filter(Boolean).join(' ') };
  }

  if (typeName === 'research') {
    const target = projectPolicy.subagent_research_model || 'flash_lite';
    const isHighReasoningReview = isQuantThinking || (!MECHANICAL_SUBTASK_RE.test(args.Role || args.role || '') && EXPLICIT_UPGRADE_RE.test(roleAndPrompt));
    if (isHighReasoningReview && currentModel === 'inherit') {
      return { overwrite: null, note: ['深度审查/根因分析子任务保留 Model="inherit" 继承主窗口顶配模型，不降档。', crossFamilyNote].filter(Boolean).join(' ') };
    }
    if (!currentModel || (projectPolicy.enforce_subagent_low_cost && currentModel === 'inherit' && !isHighReasoningReview)) {
      return { overwrite: { [modelKey]: target }, note: [`只读 research 子代理默认路由至低成本 ${target}。`, crossFamilyNote].filter(Boolean).join(' ') };
    }
    return { overwrite: null, note: crossFamilyNote };
  }

  const defaultExec = projectPolicy.subagent_default_model || 'flash';
  if (!currentModel) {
    return { overwrite: { [modelKey]: defaultExec }, note: [`AGY 执行子代理未指定模型，自动路由至低成本 ${defaultExec}。`, crossFamilyNote].filter(Boolean).join(' ') };
  }
  if (projectPolicy.enforce_subagent_low_cost && currentModel === 'inherit' && !isQuantThinking && !EXPLICIT_UPGRADE_RE.test(roleAndPrompt) && !matchesConfiguredThinkingModel(roleAndPrompt, projectPolicy.thinking_model)) {
    return { overwrite: { [modelKey]: defaultExec }, note: [`为避免普通子任务误继承高配主模型，自动降档为低成本 ${defaultExec}（如需升级请显式指定 pro 或在提示中说明复杂/量化思考）。`, crossFamilyNote].filter(Boolean).join(' ') };
  }
  return { overwrite: null, note: crossFamilyNote };
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

function readStaleQuotaCache(cachePath, nowMs = Date.now(), maxStaleSeconds = 43200) {
  if (!cachePath || !fs.existsSync(cachePath)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const fetchedAt = Date.parse(doc.fetched_at);
    if (!Number.isFinite(fetchedAt) || nowMs - fetchedAt > maxStaleSeconds * 1000) return null;
    const resetIso = normalizeOptionalResetIso(doc?.codex_pacing?.resets_at);
    const resetsAtMs = resetIso ? Date.parse(resetIso) : NaN;
    if (doc?.codex_pacing?.available && Number.isFinite(resetsAtMs) && resetsAtMs <= nowMs) return null;
    return doc;
  } catch { return null; }
}

function defaultCodexSessionsDir(settings, options = {}) {
  if (options.codexSessionsDir !== undefined) return options.codexSessionsDir || null;
  if (settings?.codex_sessions_dir !== undefined) return settings.codex_sessions_dir || null;
  if (process.env.CODEX_EXECUTOR_TEST_ROOT) return null;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'sessions');
}

function listRecentRolloutFiles(sessionsDir, maxFiles = 6) {
  if (!sessionsDir || !fs.existsSync(sessionsDir)) return [];
  const results = [];
  const descDirs = dir => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a));
    } catch { return []; }
  };
  // Handle both YYYY/MM/DD nested layout and flat rollout-*.jsonl layout (for tests).
  try {
    const direct = fs.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
      .map(e => { const p = path.join(sessionsDir, e.name); return { p, st: fs.statSync(p) }; });
    if (direct.length) {
      return direct.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, maxFiles);
    }
  } catch {}
  let visitedDays = 0;
  for (const yr of descDirs(sessionsDir).slice(0, 2)) {
    for (const mo of descDirs(path.join(sessionsDir, yr)).slice(0, 2)) {
      for (const dy of descDirs(path.join(sessionsDir, yr, mo)).slice(0, 3)) {
        const dayDir = path.join(sessionsDir, yr, mo, dy);
        try {
          for (const e of fs.readdirSync(dayDir, { withFileTypes: true })) {
            if (!e.isFile() || !e.name.startsWith('rollout-') || !e.name.endsWith('.jsonl')) continue;
            const p = path.join(dayDir, e.name);
            results.push({ p, st: fs.statSync(p) });
          }
        } catch {}
        visitedDays += 1;
        if (visitedDays >= 2 && results.length >= maxFiles) break;
      }
      if (visitedDays >= 2 && results.length >= maxFiles) break;
    }
    if (visitedDays >= 2 && results.length >= maxFiles) break;
  }
  return results.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, maxFiles);
}

function readLatestCodexRolloutRateLimits(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? (12 * 3600 * 1000);
  const files = listRecentRolloutFiles(options.codexSessionsDir, options.maxFiles ?? 6);
  let best = null;
  for (const item of files) {
    if (nowMs - item.st.mtimeMs > maxAgeMs + 60000) continue;
    let text;
    try { ({ text } = readTailUtf8(item.p, 262144)); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !line.includes('rate_limits')) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      const rl = parsed?.payload?.rate_limits || parsed?.rate_limits || null;
      const primary = rl?.primary || null;
      const resetsAt = primary?.resets_at ?? primary?.resetsAt;
      const usedPct = primary?.used_percent ?? primary?.usedPercent;
      if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) continue;
      const isUnusedPendingWindow = usedPct === 0 && (resetsAt === null || resetsAt === undefined || resetsAt === 0);
      const isActiveFutureWindow = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt * 1000 > nowMs;
      if (!isUnusedPendingWindow && !isActiveFutureWindow) continue;
      const tsMs = Date.parse(parsed.timestamp) || item.st.mtimeMs;
      if (nowMs - tsMs > maxAgeMs) continue;
      if (!best || tsMs > best.tsMs) {
        best = { tsMs, rateLimits: rl, observed_at: new Date(tsMs).toISOString() };
      }
      break; // Latest rate_limits in this file found.
    }
  }
  return best;
}

const NATIVE_CODEX_REQUIRED_RE = /native_luna|spawn_agent|waiting_background|原生\s*luna|原生子\s*agent|后台托管/i;
const ALLOW_EXTRA_CREDITS_RE = /CODEX_ALLOW_EXTRA_CREDITS/i;
const HEAVY_AGY_EXEC_RE = /(?:^|[_/.:-])(?:invoke_subagent|send_message|run_workflow|run_command|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|apply_patch)$/i;
const SAFE_HANDOFF_CMD_RE = /^\s*git\s+(?:status|diff|log)\b(?![^|;&]*[|;&>])|\bMode\.ps1\b|\bmode\.cjs\b/i;

function evaluateCodexConcurrencyGate({ args = {}, projectPolicy, codexPacing, agyPacing, totalActiveCodexTasks = 0 }) {
  if (!projectPolicy || projectPolicy.mode !== 'auto') return { blocked: false };
  if (!codexPacing?.available) return { blocked: false };

  const cfg = { ...DEFAULT_PACING, ...(projectPolicy.pacing || {}) };
  const used = codexPacing.used_percent;
  const isContinuation = Boolean(args.topic_id || args.session_id || args.parent_job_id);
  const text = `${args.topic || ''}\n${args.prompt || ''}`;

  // Hard 100% exhaustion: unstick continuations, review_only, and native subagent tasks so they don't hit 429 or silently burn paid credits!
  if (codexIsExhausted(codexPacing)) {
    if (ALLOW_EXTRA_CREDITS_RE.test(text)) return { blocked: false };
    if (agyPacing?.exhausted) {
      const resetHint = [codexPacing.hours_until_reset, agyPacing.window_5h?.hours_until_reset, agyPacing.window_7d?.hours_until_reset]
        .filter(v => typeof v === 'number' && v > 0);
      const minH = resetHint.length ? round2(Math.min(...resetHint)) : null;
      return {
        blocked: true,
        kind: 'dual_quota_exhausted',
        reason: `[DUAL_QUOTA_EXHAUSTED] Codex（已用 ${used}%）与 AGY 当前均已耗尽可用额度${minH !== null ? `（最快约 ${minH}h 后窗口重置）` : ''}，已熔断停止派发。请向用户汇报并等待决定：① 等待最快窗口重置；② 在 CC Switch 切换到备用账号；③ 若明确授权动用额外 Credits，可在 prompt 附带 CODEX_ALLOW_EXTRA_CREDITS。`
      };
    }
    const creditHint = (codexPacing.has_extra_credits || codexPacing.has_reset_credits)
      ? '（检测到账号有额外 Credits 或重置券，未经用户明确授权禁止静默消耗；如用户明确批准动用，可在 prompt 写入 CODEX_ALLOW_EXTRA_CREDITS）'
      : '';
    const resetLabel = typeof codexPacing.hours_until_reset === 'number' ? `距重置 ${codexPacing.hours_until_reset}h` : '重置时间待定';
    return {
      blocked: true,
      kind: 'codex_exhausted_handover',
      reason: `[CODEX_EXHAUSTED_HANDOVER] Codex 当前周额度已 100% 耗尽（已用 ${used}%，${resetLabel}），已自动解除原事项粘性锁定并触发跨端交接：请勿继续调用 codex_run（含续接、review_only 审核与原生子代理），改为先只读读取原任务 codex_result / job.json 与当前 Git 工作区差异，在 AGY 侧无缝接力完成剩余步骤（原审核改用 AGY research 只读子代理，批量扇出改用 flash_lite + run_workflow）。${creditHint}`
    };
  }

  if (args.review_only === true) return { blocked: false };
  if (agyPacing?.limited) return { blocked: false }; // AGY is limited & Codex < 100% => Codex acts as fallback.

  if (codexPacing.hard_limited || codexPacing.band === 'codex_protected') {
    if (cfg.protect_max_concurrent !== null && totalActiveCodexTasks >= cfg.protect_max_concurrent) {
      return {
        blocked: true,
        kind: 'codex_protect_concurrency',
        reason: `[CODEX_CONCURRENCY_THROTTLED] Codex 当前已用 ${used}%（触及 ≥${cfg.codex_protect_used_percent}% 保护线），全局在途 Codex 任务 ${totalActiveCodexTasks} 个已达保护期并发上限 ${cfg.protect_max_concurrent}；请先等在途任务收口，或将不依赖 Codex 原生子代理的工作改由 AGY 执行。`
      };
    }
    if (!isContinuation && !NATIVE_CODEX_REQUIRED_RE.test(text)) {
      return {
        blocked: true,
        kind: 'codex_protect_new_task',
        reason: `[CODEX_QUOTA_PROTECTED] Codex 当前已用 ${used}%（触及 ≥${cfg.codex_protect_used_percent}% 保护线）且 AGY 可用，普通新事项请直接改由 AGY 执行；如确属必须留 Codex 的原生 luna / spawn_agent 或长后台流水线，请在 prompt 中写明或临时切换为 codex 模式。`
      };
    }
    return { blocked: false };
  }

  if (used >= cfg.agy_priority_used_percent && cfg.high_max_concurrent !== null && totalActiveCodexTasks >= cfg.high_max_concurrent) {
    return {
      blocked: true,
      kind: 'codex_high_concurrency',
      reason: `[CODEX_CONCURRENCY_THROTTLED] Codex 当前已用 ${used}%（≥${cfg.agy_priority_used_percent}% 高水位），全局在途 Codex 任务 ${totalActiveCodexTasks} 个已达高水位并发上限 ${cfg.high_max_concurrent}；避免粘性续接打穿剩余额度，请等在途任务收口后再派发，或将通用任务分流给 AGY 执行。`
    };
  }

  if ((codexPacing.band === 'agy_priority' || used >= 85) && cfg.ahead_max_concurrent !== null && totalActiveCodexTasks >= cfg.ahead_max_concurrent) {
    const deltaPart = typeof codexPacing.pacing_delta === 'number'
      ? `，相对线性目标偏差 ${codexPacing.pacing_delta >= 0 ? '+' : ''}${codexPacing.pacing_delta}%`
      : '';
    return {
      blocked: true,
      kind: 'codex_ahead_concurrency',
      reason: `[CODEX_CONCURRENCY_THROTTLED] Codex 消耗超前（已用 ${used}%${deltaPart}），全局在途 Codex 任务 ${totalActiveCodexTasks} 个已达超前并发上限 ${cfg.ahead_max_concurrent}；请等在途任务收口后再续派，或将通用任务交由 AGY 执行。`
    };
  }

  return { blocked: false };
}

function evaluateAgyQuotaGate({ toolName = '', args = {}, projectPolicy, codexPacing, agyPacing, nowMs = Date.now() }) {
  if (!projectPolicy || projectPolicy.mode !== 'auto') return { blocked: false };
  if (!HEAVY_AGY_EXEC_RE.test(toolName)) return { blocked: false };

  const isInvokeSubagent = /(?:^|[_/.:-])invoke_subagent$/i.test(toolName);
  const isSendMessage = /(?:^|[_/.:-])send_message$/i.test(toolName);
  const isWorkflow = /(?:^|[_/.:-])run_workflow$/i.test(toolName);
  const isRunCommand = /(?:^|[_/.:-])run_command$/i.test(toolName);
  const subType = String(args.TypeName || args.typeName || args.type_name || 'self').trim().toLowerCase();
  const isReadOnlyResearch = isInvokeSubagent && subType === 'research';
  const cmdText = String(args.CommandLine || args.command || '');
  if (isRunCommand && SAFE_HANDOFF_CMD_RE.test(cmdText)) return { blocked: false };
  const msgText = String(args.Message || args.message || '');
  const isHandoffReceiptMsg = isSendMessage && /AGY_QUOTA_PROTECTED|AGY_PACING_OVERBURN|codex_run|暂停[^\r\n]{0,30}交接/i.test(msgText);

  const codexCooling = cooldownActive(projectPolicy.cooldowns?.codex, nowMs);
  const codexDead = codexIsExhausted(codexPacing);
  const codexHasRoom = Boolean(codexPacing?.available && !codexDead && !codexCooling);

  // 1. Both engines 100% exhausted => stop all LLM subagents/workflows/writes and return actionable recovery options
  if (codexDead && agyPacing?.exhausted) {
    const resetHint = [codexPacing.hours_until_reset, agyPacing.window_5h?.hours_until_reset, agyPacing.window_7d?.hours_until_reset]
      .filter(v => typeof v === 'number' && v > 0);
    const minH = resetHint.length ? round2(Math.min(...resetHint)) : null;
    return {
      blocked: true,
      kind: 'dual_quota_exhausted',
      reason: `[DUAL_QUOTA_EXHAUSTED] AGY 与 Codex 当前均已耗尽可用额度${minH !== null ? `（最快约 ${minH}h 后窗口重置）` : ''}，已暂停执行防空转报错。请向用户汇报三个选择：① 等待最快窗口重置；② 在 CC Switch 切换到备用账号（自动共用生效）；③ 是否授权启用额外 Credits / 重置券。`
    };
  }

  // 2. AGY hit protection line (7d >= 90% when >6h before reset, or 5h >= 88%, or 429) while Codex still has quota => protect AGY's 10% main-chat buffer!
  if (agyPacing?.limited && codexHasRoom) {
    if ((isReadOnlyResearch && !agyPacing.exhausted) || isHandoffReceiptMsg) return { blocked: false };
    const agyResetNote = typeof agyPacing.window_7d?.hours_until_reset === 'number'
      ? `距周重置 ${agyPacing.window_7d.hours_until_reset}h；剩余 ≤${agyPacing.window_7d.buffer_unlock_window_hours}h 时将自动解锁`
      : `待周重置窗口激活且剩余 ≤${agyPacing.window_7d?.buffer_unlock_window_hours ?? 6}h 时自动解锁`;
    const agyDetail = agyPacing.window_7d?.band === 'agy_protected'
      ? `7天已用 ${agyPacing.window_7d.used_percent}%（已达 ${agyPacing.window_7d.protect_used_percent}% 保护线，保留 ${agyPacing.window_7d.buffer_percent}% 主窗口救命缓冲，${agyResetNote}）`
      : `5h窗口受限（${agyPacing.window_5h?.reason || 'limited'}${agyPacing.window_5h?.used_percent !== null ? `，已用 ${agyPacing.window_5h.used_percent}%` : ''}）`;
    return {
      blocked: true,
      kind: 'agy_quota_protected',
      reason: `[AGY_QUOTA_PROTECTED] AGY 当前${agyDetail}，且 Codex 仍有可用额度（已用 ${codexPacing.used_percent}%）：为保证主聊天窗口不断粮，AGY 写操作、命令执行与子代理派发已硬性保护，请立即停止 AGY 子代理循环并将任务（含已完成上下文与文件差异）跨端交接给 codex_run 执行。`
    };
  }

  // 2b. Linear pacing >+10% advisory reminder (NO blocking during linear phase — only remind and guide towards Codex!):
  const w7 = agyPacing?.window_7d;
  const agyAheadLinear10 = Boolean(
    w7?.available
    && typeof w7.pacing_delta === 'number'
    && w7.pacing_delta > 10
  );
  const codexPlenty = Boolean(
    codexHasRoom
    && (codexPacing.used_percent ?? 0) < 85
    && (codexPacing.pacing_delta === null || codexPacing.pacing_delta === undefined || codexPacing.pacing_delta <= 5)
  );
  if (agyAheadLinear10 && codexPlenty) {
    const isBatchDelegation = (isInvokeSubagent && !isReadOnlyResearch && !['browser', 'image-generator'].includes(subType))
      || isWorkflow
      || (isSendMessage && !isHandoffReceiptMsg);
    if (isBatchDelegation) {
      return {
        blocked: false,
        note: `[线性额度提醒] AGY 7天额度已用 ${w7.used_percent}%（超出线性目标 +${w7.pacing_delta}% > 10%），而 Codex 当前仅用 ${codexPacing.used_percent}%；本次操作放行不拦截，建议后续新批次优先改用 codex_run 执行。`
      };
    }
  }

  // 3. Codex is 100% exhausted AND AGY is in its soft buffer (e.g. 90%~99% with >6h to reset) => Emergency Rationing Mode!
  if (codexDead && agyPacing?.soft_buffered) {
    if (isWorkflow) {
      return {
        blocked: true,
        kind: 'agy_emergency_rationing_no_workflow',
        reason: '[AGY_EMERGENCY_RATIONING] Codex 已 100% 耗尽且 AGY 处于最后 10% 应急缓冲省流模式：已拦截 run_workflow 批量扇出，请仅对用户明确要求的紧急任务使用单个 flash_lite 子代理或最小化直接修改。'
      };
    }
    if (isInvokeSubagent && !['browser', 'image-generator'].includes(subType)) {
      const modelKey = Object.hasOwn(args, 'Model') ? 'Model' : Object.hasOwn(args, 'model') ? 'model' : 'Model';
      const minTier = projectPolicy.agy_tiers?.simple || 'flash_lite';
      return {
        blocked: false,
        overwrite: { [modelKey]: minTier },
        note: `[应急省流模式] Codex 已 100% 耗尽且 AGY 进入应急缓冲（距周重置 ${agyPacing.window_7d?.hours_until_reset ?? '?'}h），子代理已强制降为最低成本 ${minTier} 省流执行。`
      };
    }
  }

  return { blocked: false };
}

function shouldPreferRolloutOverStale(fromRollout, rolloutTsMs, stalePacing, staleRefMs) {
  if (!fromRollout?.available) return false;
  if (!stalePacing?.available) return true;
  // When a newer session rollout is observed (e.g. weekly reset rolled over to 0% or user switched account in CC Switch),
  // prefer the fresh 0% reading instead of letting the old 100% cache stick!
  if (Number.isFinite(rolloutTsMs) && Number.isFinite(staleRefMs) && rolloutTsMs > staleRefMs + 1000) {
    return true;
  }
  if ((fromRollout.resets_at || null) !== (stalePacing.resets_at || null) && Number.isFinite(rolloutTsMs) && (!Number.isFinite(staleRefMs) || rolloutTsMs >= staleRefMs)) {
    return true;
  }
  return fromRollout.used_percent >= stalePacing.used_percent;
}

function writeQuotaCache(cachePath, payload) {
  if (!cachePath) return;
  try { saveAtomic(cachePath, { ...payload, fetched_at: payload?.fetched_at || new Date().toISOString() }); } catch {}
}

function resolveSharedQuotaSnapshot(scope, projectPolicy, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const policyPath = options.policyPath || defaultPolicyPath(scope);
  const cachePath = options.cachePath || defaultQuotaCachePath(policyPath, scope);
  const indexPath = options.indexPath || defaultTranscriptIndexPath(policyPath, scope);
  const sharedWindowSec = Math.max(projectPolicy?.cache_ttl_seconds || 300, 900);
  const fresh = readQuotaCache(cachePath, sharedWindowSec, nowMs);

  // Fast path across all Antigravity windows: reuse shared quota-cache.json with zero scans/subprocesses.
  if (fresh && (fresh.codex_pacing?.available || !options.codexSessionsDir) && fresh.agy_usage) {
    return {
      codexPacing: fresh.codex_pacing || { available: false },
      agyUsage: fresh.agy_usage,
      agyExternal: fresh.agy_external || null,
      agyHealth: fresh.agy_health || null,
      reused_shared_cache: true
    };
  }

  const stale = readStaleQuotaCache(cachePath, nowMs, 86400);
  const release = takeQuotaRefreshClaim(cachePath, 30000, nowMs);
  if (!release) {
    // Another process/window is already refreshing: reuse existing snapshot immediately without duplicate work.
    return {
      codexPacing: stale?.codex_pacing ? { ...stale.codex_pacing, ...(fresh ? {} : { stale: true }) } : { available: false },
      agyUsage: stale?.agy_usage || { available: false },
      agyExternal: stale?.agy_external || null,
      agyHealth: stale?.agy_health || null,
      reused_shared_cache: true
    };
  }
  try {
    const sessionsDir = defaultCodexSessionsDir(scope, options);
    const rollout = sessionsDir ? readLatestCodexRolloutRateLimits({ codexSessionsDir: sessionsDir, nowMs }) : null;
    const fromRollout = rollout ? evaluateCodexPacing(rollout, projectPolicy?.pacing, nowMs) : null;
    const staleRefMs = Date.parse(stale?.codex_probed_at || stale?.codex_pacing?.observed_at || stale?.fetched_at || '');
    let codexPacing;
    if (shouldPreferRolloutOverStale(fromRollout, rollout?.tsMs, stale?.codex_pacing, staleRefMs)) {
      codexPacing = { ...fromRollout, source: 'codex_rollout_log', observed_at: rollout.observed_at };
    } else if (stale?.codex_pacing?.available) {
      codexPacing = { ...stale.codex_pacing, source: stale.codex_pacing.source || 'shared_cache' };
    } else {
      codexPacing = { available: false };
    }
    const agyUsage = scanAgyTranscriptUsage({
      transcriptPath: options.transcriptPath,
      brainDir: options.brainDir,
      indexPath,
      nowMs
    });
    const agyExternal = stale?.agy_external || null;
    const agyHealth = stale?.agy_health || null;
    writeQuotaCache(cachePath, {
      ...(stale || {}),
      codex_pacing: codexPacing,
      agy_usage: agyUsage,
      agy_external: agyExternal,
      agy_health: agyHealth,
      fetched_at: new Date(nowMs).toISOString()
    });
    return { codexPacing, agyUsage, agyExternal, agyHealth, reused_shared_cache: false };
  } finally {
    release();
  }
}

const SAFE_PRUNE_TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
const DELIVERED_NOTICE_STATES = new Set(['accepted', 'sent', 'superseded', 'suppressed']);

function pruneBridgeRuntimeCache(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const apply = options.apply === true;
  const olderThanDays = typeof options.olderThanDays === 'number' && Number.isFinite(options.olderThanDays) && options.olderThanDays >= 0
    ? options.olderThanDays
    : 7;
  const keepProbeLogs = Number.isInteger(options.keepProbeLogs) && options.keepProbeLogs >= 1 ? options.keepProbeLogs : 10;
  const cutoffMs = nowMs - olderThanDays * 24 * 3600 * 1000;
  const dataRoots = [...new Set((options.dataRoots || []).filter(d => typeof d === 'string' && d.trim()).map(d => path.resolve(d)))];

  let scannedJobs = 0;
  let eligibleJobs = 0;
  let skippedActiveOrRecent = 0;
  let candidateFiles = 0;
  let freedBytes = 0;
  const byCategory = {
    events_jsonl: { files: 0, bytes: 0 },
    attempt_results: { files: 0, bytes: 0 },
    delivered_notifications: { files: 0, bytes: 0 },
    finished_background_logs: { files: 0, bytes: 0 },
    probe_logs: { files: 0, bytes: 0 }
  };

  const recordCandidate = (category, filePath, size) => {
    candidateFiles += 1;
    freedBytes += size;
    byCategory[category].files += 1;
    byCategory[category].bytes += size;
    if (apply) {
      try { fs.unlinkSync(filePath); } catch {}
    }
  };

  for (const dataRoot of dataRoots) {
    const jobsDir = path.join(dataRoot, 'jobs');
    const activeDir = path.join(dataRoot, 'active-tasks');
    if (!fs.existsSync(jobsDir)) continue;
    let jobIds = [];
    try { jobIds = fs.readdirSync(jobsDir).filter(n => /^[a-f0-9]{24}$/.test(n)); } catch { continue; }
    for (const id of jobIds) {
      scannedJobs += 1;
      const jobDir = path.join(jobsDir, id);
      const jobFile = path.join(jobDir, 'job.json');
      if (!fs.existsSync(jobFile)) { skippedActiveOrRecent += 1; continue; }
      if (fs.existsSync(path.join(activeDir, `${id}.json`))) { skippedActiveOrRecent += 1; continue; }
      let job;
      let jobStat;
      try {
        jobStat = fs.statSync(jobFile);
        job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
      } catch {
        skippedActiveOrRecent += 1;
        continue;
      }
      const refMs = Date.parse(job.ended_at || job.updated_at || '') || jobStat.mtimeMs;
      if (
        !SAFE_PRUNE_TERMINAL_STATUSES.has(job.status)
        || job.background_wait
        || job.handoff?.requires_user_decision
        || job.execution_block
        || refMs > cutoffMs
      ) {
        skippedActiveOrRecent += 1;
        continue;
      }

      eligibleJobs += 1;
      const hasFinalSummary = fs.existsSync(path.join(jobDir, 'receipt.json')) || fs.existsSync(path.join(jobDir, 'result.txt'));

      // 1. Verbose raw stream events.jsonl (only if final receipt/result exists; job.json/receipt.json/result.txt stay intact!)
      if (hasFinalSummary) {
        const eventsFile = path.join(jobDir, 'events.jsonl');
        try {
          if (fs.existsSync(eventsFile)) {
            const st = fs.statSync(eventsFile);
            if (st.isFile()) recordCandidate('events_jsonl', eventsFile, st.size);
          }
        } catch {}
      }

      // 2. Intermediate attempt-*.result.txt / review-attempt-*.result.txt when final result.txt exists
      if (fs.existsSync(path.join(jobDir, 'result.txt'))) {
        try {
          for (const e of fs.readdirSync(jobDir, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            if (!/^(?:review-)?attempt-\d+\.result\.txt$/i.test(e.name)) continue;
            const fp = path.join(jobDir, e.name);
            recordCandidate('attempt_results', fp, fs.statSync(fp).size);
          }
        } catch {}
      }

      // 3. Already delivered/superseded/suppressed notification outbox files (never touch pending/sending/uncertain/not_sent!)
      const notifDir = path.join(jobDir, 'notifications');
      if (fs.existsSync(notifDir)) {
        try {
          const notifEntries = fs.readdirSync(notifDir, { withFileTypes: true }).filter(e => e.isFile());
          for (const e of notifEntries) {
            if (!/^\d{8}\.delivery\.json$/.test(e.name)) continue;
            const dFile = path.join(notifDir, e.name);
            let dDoc;
            try { dDoc = JSON.parse(fs.readFileSync(dFile, 'utf8')); } catch { continue; }
            if (!DELIVERED_NOTICE_STATES.has(dDoc?.state)) continue;
            const evtFile = path.join(notifDir, e.name.replace(/\.delivery\.json$/, '.json'));
            if (fs.existsSync(evtFile)) {
              recordCandidate('delivered_notifications', evtFile, fs.statSync(evtFile).size);
            }
            recordCandidate('delivered_notifications', dFile, fs.statSync(dFile).size);
          }
        } catch {}
      }

      // 4. Finished background command logs (job.background_wait already verified null above)
      const bgDir = path.join(jobDir, 'background');
      if (fs.existsSync(bgDir)) {
        try {
          for (const e of fs.readdirSync(bgDir, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            const fp = path.join(bgDir, e.name);
            recordCandidate('finished_background_logs', fp, fs.statSync(fp).size);
          }
        } catch {}
      }
    }
  }

  // 5. Probe-home CLI logs rotation
  const probeHome = options.probeHomeDir || defaultAgyProbeHome({ projectPolicy: options.projectPolicy, policy: options.policy });
  const rot = rotateAgyProbeLogs(probeHome, { maxLogs: keepProbeLogs, nowMs, dryRun: !apply });
  if (rot.pruned > 0) {
    candidateFiles += rot.pruned;
    freedBytes += rot.freed_bytes;
    byCategory.probe_logs.files += rot.pruned;
    byCategory.probe_logs.bytes += rot.freed_bytes;
  }

  return {
    dry_run: !apply,
    older_than_days: olderThanDays,
    keep_probe_logs: keepProbeLogs,
    probe_home: probeHome || null,
    data_roots: dataRoots,
    scanned_jobs: scannedJobs,
    eligible_jobs: eligibleJobs,
    skipped_active_or_recent: skippedActiveOrRecent,
    candidate_files: candidateFiles,
    freed_bytes: freedBytes,
    freed_mb: round2(freedBytes / 1048576),
    by_category: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, { files: v.files, mb: round2(v.bytes / 1048576) }]))
  };
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
  defaultTranscriptIndexPath,
  defaultCodexSessionsDir,
  defaultAgyProbeHome,
  rotateAgyProbeLogs,
  pruneBridgeRuntimeCache,
  takeQuotaRefreshClaim,
  loadRoutingPolicy,
  saveRoutingPolicy,
  resolveProjectPolicy,
  evaluateCodexPacing,
  evaluateAgyPacing,
  evaluateAgyModelPools,
  evaluateAgyUsageAlert,
  evaluateCodexConcurrencyGate,
  evaluateAgyQuotaGate,
  codexIsExhausted,
  normalizeOptionalResetIso,
  shouldPreferRolloutOverStale,
  scanAgyTranscriptUsage,
  resolveRealAgyBin,
  inspectAgyCliLog,
  detectCcSwitchAccountsMtimeMs,
  detectAgyKeyringLastWrittenMs,
  detectAgyKeyringLastWrittenMsAsync,
  advanceResetAnchor,
  parseAgyProbePayload,
  runExternalAgyProbe,
  runExternalAgyProbeAsync,
  probeAgyQuotaAsync,
  runAgyInteractiveLoginAsync,
  evaluateAgyProbeHealth,
  runAgyPoolTaskAsync,
  checkExternalPoolCliMisuse,
  resolveSharedQuotaSnapshot,
  activeCodexTasks,
  cooldownActive,
  decideRoute,
  evaluateSubagentCall,
  readQuotaCache,
  readStaleQuotaCache,
  readLatestCodexRolloutRateLimits,
  writeQuotaCache,
  isAgyQuotaError,
  saveAtomic
};
