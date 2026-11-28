'use strict';

// Single source of truth for all user-tunable runtime parameters in routing-policy.json.
// Standardized naming convention:
//   *_percent  : percentage (0..100)
//   *_hours    : duration in hours
//   *_minutes  : duration in minutes
//   *_seconds  : duration in seconds
//   *_ms       : duration in milliseconds
//   *_days     : duration in days
//   *_tokens   : token budget count
//   *_kb       : size in kibibytes

const DEFAULT_PACING = Object.freeze({
  plan_days: 5,
  target_utilization: 100,
  codex_priority_margin: -3,
  balanced_upper_margin: 5,
  ahead_used_percent: 85,
  agy_priority_used_percent: 92,
  codex_protect_used_percent: 97,
  drain_window_hours: 12,
  drain_min_remaining_percent: 10,
  ahead_max_concurrent: 3,
  high_max_concurrent: 2,
  protect_max_concurrent: 1
});

const DEFAULT_AGY_PACING = Object.freeze({
  target_utilization: 90,
  window_minutes: 10080,
  window_5h_minutes: 300,
  dual_compare_margin: 5,
  linear_advisory_delta_percent: 10,
  window_5h_caution_percent: 75,
  window_5h_protect_percent: 88,
  weekly_protect_used_percent: 90,
  buffer_unlock_window_hours: 12,
  drain_window_hours: 12,
  drain_min_remaining_percent: 10,
  emergency_downgrade_enabled: false,
  window_5h_tokens: null,
  window_7d_tokens: null,
  weekly_resets_at: null
});

const DEFAULT_AGY_GUARD = Object.freeze({
  max_same_error_failures: 3,
  max_consecutive_failures: 8,
  review_gate: 'advisory',
  review_valid_hours: 12,
  quota_error_cooldown_minutes: 15
});

const DEFAULT_AGY_TIERS = Object.freeze({
  simple: 'flash_lite',
  standard: 'flash',
  complex: 'pro',
  expert: 'inherit'
});

const DEFAULT_AGY_PROBE = Object.freeze({
  timeout_ms: 65000,
  slow_oauth_threshold_ms: 8000,
  slow_oauth_grace_ms: 25000,
  fast_oauth_grace_ms: 600,
  probe_interval_minutes: 10,
  auth_retry_interval_minutes: 30,
  codex_probe_refresh_minutes: 60,
  retry_delays_ms: Object.freeze([1500, 3000, 5000])
});

const DEFAULT_MAINTENANCE = Object.freeze({
  prune_older_than_days: 7,
  keep_probe_logs: 10,
  index_wal_compact_kb: 64
});

const PARAM_CATALOG = Object.freeze([
  // 1. Global routing
  { key: 'default_mode', group: 'routing', type: 'enum', values: ['auto', 'agy', 'codex'], default: 'auto', unit: '', desc: '默认全局执行模式（auto 双引擎均衡 / agy 仅本地 / codex 仅 Codex）' },
  { key: 'apply_to_unregistered_projects', group: 'routing', type: 'boolean', default: false, unit: '', desc: '是否对未登记 Codex 执行根的项目启用本机 AGY 灵活护栏（桥接仓库自身始终豁免）' },
  { key: 'enforce_subagent_low_cost', group: 'routing', type: 'boolean', default: true, unit: '', desc: '未显式指定子代理档位时是否自动应用低成本默认档' },
  { key: 'cache_ttl_seconds', group: 'routing', type: 'integer', min: 0, max: 3600, default: 300, unit: 's', desc: '共享配额快照缓存有效期（秒）' },
  { key: 'agy_quota_hint', group: 'routing', type: 'enum', values: ['plenty', 'normal', 'low'], default: 'normal', unit: '', desc: '无官方探针时的 AGY 额度人工水位提示' },

  // 2. Codex pacing & concurrency
  { key: 'pacing.plan_days', group: 'pacing', type: 'number', nullable: true, min: 1, max: 30, default: DEFAULT_PACING.plan_days, unit: 'days', desc: 'Codex 周额度计划消化天数（null 表示按整周 7 天线性）' },
  { key: 'pacing.target_utilization', group: 'pacing', type: 'number', min: 10, max: 100, default: DEFAULT_PACING.target_utilization, unit: '%', desc: 'Codex 周期目标利用率上限（%）' },
  { key: 'pacing.codex_priority_margin', group: 'pacing', type: 'number', min: -50, max: 20, default: DEFAULT_PACING.codex_priority_margin, unit: '%', desc: 'Codex 落后线性目标达到该偏差时优先路由 Codex（%）' },
  { key: 'pacing.balanced_upper_margin', group: 'pacing', type: 'number', min: -10, max: 50, default: DEFAULT_PACING.balanced_upper_margin, unit: '%', desc: 'Codex 超前线性目标超过该偏差时进入超前控速（%）' },
  { key: 'pacing.ahead_used_percent', group: 'pacing', type: 'number', min: 50, max: 100, default: DEFAULT_PACING.ahead_used_percent, unit: '%', desc: 'Codex 达到该已用比例时同样启用超前并发上限（%）' },
  { key: 'pacing.agy_priority_used_percent', group: 'pacing', type: 'number', min: 50, max: 100, default: DEFAULT_PACING.agy_priority_used_percent, unit: '%', desc: 'Codex 高水位阈值：优先分流 AGY 并收紧并发（%）' },
  { key: 'pacing.codex_protect_used_percent', group: 'pacing', type: 'number', min: 60, max: 100, default: DEFAULT_PACING.codex_protect_used_percent, unit: '%', desc: 'Codex 保护线阈值：保护最后余量（%）' },
  { key: 'pacing.drain_window_hours', group: 'pacing', type: 'number', min: 0, max: 72, default: DEFAULT_PACING.drain_window_hours, unit: 'h', desc: 'Codex 重置前最后 N 小时进入清仓优先消化窗口（小时）' },
  { key: 'pacing.drain_min_remaining_percent', group: 'pacing', type: 'number', min: 1, max: 80, default: DEFAULT_PACING.drain_min_remaining_percent, unit: '%', desc: 'Codex 触发重置前清仓所需的最小剩余比例（%）' },
  { key: 'pacing.ahead_max_concurrent', group: 'pacing', type: 'integer', nullable: true, min: 1, max: 50, default: DEFAULT_PACING.ahead_max_concurrent, unit: 'tasks', desc: 'Codex 超前进度时的全局在途并发上限（null 为不限）' },
  { key: 'pacing.high_max_concurrent', group: 'pacing', type: 'integer', nullable: true, min: 1, max: 50, default: DEFAULT_PACING.high_max_concurrent, unit: 'tasks', desc: 'Codex 高水位（>=92%）时的全局在途并发上限（null 为不限）' },
  { key: 'pacing.protect_max_concurrent', group: 'pacing', type: 'integer', nullable: true, min: 1, max: 50, default: DEFAULT_PACING.protect_max_concurrent, unit: 'tasks', desc: 'Codex 保护线（>=97%）时的全局在途并发上限（null 为不限）' },

  // 3. AGY pacing & buffer
  { key: 'agy_pacing.target_utilization', group: 'agy_pacing', type: 'number', min: 10, max: 100, default: DEFAULT_AGY_PACING.target_utilization, unit: '%', desc: 'AGY 平时 7 天线性消耗上限（默认 90%，留 10% 缓冲）' },
  { key: 'agy_pacing.window_minutes', group: 'agy_pacing', type: 'integer', min: 60, max: 43200, default: DEFAULT_AGY_PACING.window_minutes, unit: 'min', desc: 'AGY 周额度窗口长度（分钟，默认 10080 = 7 天）' },
  { key: 'agy_pacing.window_5h_minutes', group: 'agy_pacing', type: 'integer', min: 30, max: 1440, default: DEFAULT_AGY_PACING.window_5h_minutes, unit: 'min', desc: 'AGY 5 小时滚动窗口长度（分钟）' },
  { key: 'agy_pacing.dual_compare_margin', group: 'agy_pacing', type: 'number', min: 0, max: 40, default: DEFAULT_AGY_PACING.dual_compare_margin, unit: '%', desc: '双引擎线性偏差差值在该范围内视为均衡（%）' },
  { key: 'agy_pacing.linear_advisory_delta_percent', group: 'agy_pacing', type: 'number', min: 0, max: 50, default: DEFAULT_AGY_PACING.linear_advisory_delta_percent, unit: '%', desc: 'AGY 线性超前超过该百分比时附带引导提醒（不硬拦截）' },
  { key: 'agy_pacing.window_5h_caution_percent', group: 'agy_pacing', type: 'number', min: 30, max: 99, default: DEFAULT_AGY_PACING.window_5h_caution_percent, unit: '%', desc: 'AGY 5h 窗口警戒线（%）' },
  { key: 'agy_pacing.window_5h_protect_percent', group: 'agy_pacing', type: 'number', min: 40, max: 100, default: DEFAULT_AGY_PACING.window_5h_protect_percent, unit: '%', desc: 'AGY 5h 窗口保护线（达到且 Codex 可用时切 Codex 兜底）' },
  { key: 'agy_pacing.weekly_protect_used_percent', group: 'agy_pacing', type: 'number', min: 60, max: 100, default: DEFAULT_AGY_PACING.weekly_protect_used_percent, unit: '%', desc: 'AGY 7 天缓冲保护线（默认 90%，保留最后 10% 缓冲）' },
  { key: 'agy_pacing.buffer_unlock_window_hours', group: 'agy_pacing', type: 'number', min: 0, max: 72, default: DEFAULT_AGY_PACING.buffer_unlock_window_hours, unit: 'h', desc: '距周重置 <= N 小时时自动解锁最后 10% 缓冲优先消化（默认 12h）' },
  { key: 'agy_pacing.drain_window_hours', group: 'agy_pacing', type: 'number', min: 0, max: 72, default: DEFAULT_AGY_PACING.drain_window_hours, unit: 'h', desc: 'AGY 重置前优先清仓窗口（小时）' },
  { key: 'agy_pacing.drain_min_remaining_percent', group: 'agy_pacing', type: 'number', min: 1, max: 80, default: DEFAULT_AGY_PACING.drain_min_remaining_percent, unit: '%', desc: 'AGY 触发重置前清仓所需的最小可用余量（%）' },
  { key: 'agy_pacing.emergency_downgrade_enabled', group: 'agy_pacing', type: 'boolean', default: DEFAULT_AGY_PACING.emergency_downgrade_enabled, unit: '', desc: 'Codex 耗尽且使用 AGY 最后 10% 缓冲时是否强制降档 flash_lite/拦扇出（默认 false 保质量）' },
  { key: 'agy_pacing.window_5h_tokens', group: 'agy_pacing', type: 'integer', nullable: true, min: 1, max: 1e12, default: null, unit: 'tokens', desc: '本地转录 5h token 标定上限（可选）' },
  { key: 'agy_pacing.window_7d_tokens', group: 'agy_pacing', type: 'integer', nullable: true, min: 1, max: 1e13, default: null, unit: 'tokens', desc: '本地转录 7d token 标定上限（可选）' },

  // 4. AGY guard
  { key: 'agy_guard.review_gate', group: 'agy_guard', type: 'enum', values: ['off', 'advisory', 'strict'], default: DEFAULT_AGY_GUARD.review_gate, unit: '', desc: 'AGY 先审后做门禁级别（off / advisory / strict）' },
  { key: 'agy_guard.review_valid_hours', group: 'agy_guard', type: 'number', min: 1, max: 168, default: DEFAULT_AGY_GUARD.review_valid_hours, unit: 'h', desc: 'Codex review_only 审核回执有效时长（小时）' },
  { key: 'agy_guard.max_same_error_failures', group: 'agy_guard', type: 'integer', min: 0, max: 20, default: DEFAULT_AGY_GUARD.max_same_error_failures, unit: 'times', desc: '同一归一化错误连续失败 N 次触发防死循环熔断（0 关闭）' },
  { key: 'agy_guard.max_consecutive_failures', group: 'agy_guard', type: 'integer', min: 0, max: 50, default: DEFAULT_AGY_GUARD.max_consecutive_failures, unit: 'times', desc: '无成功进展连续失败 N 次触发防死循环熔断（0 关闭）' },
  { key: 'agy_guard.quota_error_cooldown_minutes', group: 'agy_guard', type: 'integer', min: 1, max: 300, default: DEFAULT_AGY_GUARD.quota_error_cooldown_minutes, unit: 'min', desc: '捕获 AGY 429 限流错误后的自动冷却时长（分钟）' },

  // 5. AGY subagent tiers
  { key: 'agy_tiers.simple', group: 'agy_tiers', type: 'enum', values: ['flash_lite', 'flash', 'pro', 'inherit'], default: DEFAULT_AGY_TIERS.simple, unit: '', desc: 'AGY simple/research 子代理默认档位' },
  { key: 'agy_tiers.standard', group: 'agy_tiers', type: 'enum', values: ['flash_lite', 'flash', 'pro', 'inherit'], default: DEFAULT_AGY_TIERS.standard, unit: '', desc: 'AGY standard 子代理默认档位' },
  { key: 'agy_tiers.complex', group: 'agy_tiers', type: 'enum', values: ['flash_lite', 'flash', 'pro', 'inherit'], default: DEFAULT_AGY_TIERS.complex, unit: '', desc: 'AGY complex 子代理默认档位' },
  { key: 'agy_tiers.expert', group: 'agy_tiers', type: 'enum', values: ['flash_lite', 'flash', 'pro', 'inherit'], default: DEFAULT_AGY_TIERS.expert, unit: '', desc: 'AGY expert 审核/复杂决策子代理默认档位' },

  // 6. AGY host models
  { key: 'agy_host_models.standard', group: 'agy_host_models', type: 'string', nullable: true, default: null, unit: '', desc: 'AGY 本机主窗口常规档位模型名' },
  { key: 'agy_host_models.complex', group: 'agy_host_models', type: 'string', nullable: true, default: null, unit: '', desc: 'AGY 本机主窗口复杂档位模型名' },
  { key: 'agy_host_models.expert', group: 'agy_host_models', type: 'string', nullable: true, default: null, unit: '', desc: 'AGY 本机主窗口顶配思考模型名' },

  // 7. Official AGY probe & silent OAuth refresh
  { key: 'agy_probe.timeout_ms', group: 'agy_probe', type: 'integer', min: 5000, max: 180000, default: DEFAULT_AGY_PROBE.timeout_ms, unit: 'ms', desc: '单次官方 agy /usage 探针总超时上限（毫秒）' },
  { key: 'agy_probe.slow_oauth_threshold_ms', group: 'agy_probe', type: 'integer', min: 1000, max: 60000, default: DEFAULT_AGY_PROBE.slow_oauth_threshold_ms, unit: 'ms', desc: '判定为“慢速静默 OAuth 刷新”而非立即掉线的耗时门槛（毫秒）' },
  { key: 'agy_probe.slow_oauth_grace_ms', group: 'agy_probe', type: 'integer', min: 1000, max: 90000, default: DEFAULT_AGY_PROBE.slow_oauth_grace_ms, unit: 'ms', desc: '慢刷新拦截弹窗后等待后台写回新令牌的无弹窗宽限窗（毫秒，默认 25000）' },
  { key: 'agy_probe.fast_oauth_grace_ms', group: 'agy_probe', type: 'integer', min: 100, max: 10000, default: DEFAULT_AGY_PROBE.fast_oauth_grace_ms, unit: 'ms', desc: '快速掉线拦截弹窗后的快停等待窗（毫秒，默认 600）' },
  { key: 'agy_probe.probe_interval_minutes', group: 'agy_probe', type: 'number', min: 1, max: 120, default: DEFAULT_AGY_PROBE.probe_interval_minutes, unit: 'min', desc: '正常状态下官方 AGY 额度探针轮询间隔（分钟）' },
  { key: 'agy_probe.auth_retry_interval_minutes', group: 'agy_probe', type: 'number', min: 5, max: 240, default: DEFAULT_AGY_PROBE.auth_retry_interval_minutes, unit: 'min', desc: 'AGY 确认为 auth_required 掉线后的低频重试间隔（分钟）' },
  { key: 'agy_probe.codex_probe_refresh_minutes', group: 'agy_probe', type: 'number', min: 5, max: 360, default: DEFAULT_AGY_PROBE.codex_probe_refresh_minutes, unit: 'min', desc: 'Codex 实时配额缓存每 N 分钟强制刷新一次（分钟）' },
  { key: 'agy_probe.retry_delays_ms', group: 'agy_probe', type: 'int_array', min: 0, max: 60000, maxLength: 6, default: DEFAULT_AGY_PROBE.retry_delays_ms, unit: 'ms', desc: '探针遇到可重试瞬时错误/慢刷新时的退避延迟数组（毫秒，逗号分隔）' },

  // 8. Maintenance & storage
  { key: 'maintenance.prune_older_than_days', group: 'maintenance', type: 'number', min: 1, max: 365, default: DEFAULT_MAINTENANCE.prune_older_than_days, unit: 'days', desc: 'prune-cache 默认清理多少天前的终态冗余日志（天）' },
  { key: 'maintenance.keep_probe_logs', group: 'maintenance', type: 'integer', min: 1, max: 100, default: DEFAULT_MAINTENANCE.keep_probe_logs, unit: 'files', desc: '探针 CLI 日志轮转保留最新文件数' },
  { key: 'maintenance.index_wal_compact_kb', group: 'maintenance', type: 'integer', min: 8, max: 4096, default: DEFAULT_MAINTENANCE.index_wal_compact_kb, unit: 'KB', desc: '任务增量索引 WAL 触发压缩合并到快照的体积阈值（KB）' }
]);

const PARAM_BY_KEY = Object.freeze(Object.fromEntries(PARAM_CATALOG.map(spec => [spec.key, spec])));
const PARAM_GROUPS = Object.freeze([...new Set(PARAM_CATALOG.map(spec => spec.group))]);

function getParamValue(policy, key) {
  const parts = String(key || '').split('.');
  let cur = policy;
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function coerceParamValue(spec, rawInput) {
  if (rawInput === null || rawInput === undefined || (typeof rawInput === 'string' && rawInput.trim().toLowerCase() === 'null')) {
    if (spec.nullable) return null;
    throw new Error(`Parameter "${spec.key}" does not accept null`);
  }
  if (spec.type === 'boolean') {
    if (typeof rawInput === 'boolean') return rawInput;
    const s = String(rawInput).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(s)) return true;
    if (['false', '0', 'no', 'off'].includes(s)) return false;
    throw new Error(`Parameter "${spec.key}" must be boolean (true/false)`);
  }
  if (spec.type === 'enum') {
    const s = String(rawInput).trim().toLowerCase();
    const matched = spec.values.find(v => v.toLowerCase() === s);
    if (!matched) throw new Error(`Parameter "${spec.key}" must be one of: ${spec.values.join(', ')}`);
    return matched;
  }
  if (spec.type === 'number' || spec.type === 'integer') {
    const num = typeof rawInput === 'number' ? rawInput : Number(String(rawInput).trim());
    if (!Number.isFinite(num)) throw new Error(`Parameter "${spec.key}" must be a valid number`);
    const val = spec.type === 'integer' ? Math.floor(num) : Math.round(num * 100) / 100;
    if (spec.type === 'integer' && num !== val) throw new Error(`Parameter "${spec.key}" must be an integer`);
    if (spec.min !== undefined && val < spec.min) throw new Error(`Parameter "${spec.key}" must be >= ${spec.min}`);
    if (spec.max !== undefined && val > spec.max) throw new Error(`Parameter "${spec.key}" must be <= ${spec.max}`);
    return val;
  }
  if (spec.type === 'string') {
    const s = String(rawInput).trim();
    if (!s) {
      if (spec.nullable) return null;
      throw new Error(`Parameter "${spec.key}" must be a non-empty string`);
    }
    return s.slice(0, 120);
  }
  if (spec.type === 'int_array') {
    let arr;
    if (Array.isArray(rawInput)) {
      arr = rawInput;
    } else {
      const s = String(rawInput).trim();
      if (s.startsWith('[')) {
        try { arr = JSON.parse(s); } catch { throw new Error(`Parameter "${spec.key}" must be a JSON array or comma-separated integers`); }
      } else {
        arr = s ? s.split(',').map(v => Number(v.trim())) : [];
      }
    }
    if (!Array.isArray(arr) || arr.length > (spec.maxLength || 8)) {
      throw new Error(`Parameter "${spec.key}" must be an integer array of length 0..${spec.maxLength || 8}`);
    }
    const out = [];
    for (const item of arr) {
      const n = Number(item);
      if (!Number.isInteger(n) || (spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) {
        throw new Error(`Parameter "${spec.key}" items must be integers in ${spec.min}..${spec.max}`);
      }
      out.push(n);
    }
    return out;
  }
  throw new Error(`Unsupported parameter type "${spec.type}" for "${spec.key}"`);
}

function setParamValue(policy, key, rawInput) {
  const spec = PARAM_BY_KEY[key];
  if (!spec) throw new Error(`Unknown parameter "${key}". Run "Mode.ps1 params list" to inspect valid keys.`);
  const value = coerceParamValue(spec, rawInput);
  const next = structuredClone(policy);
  const parts = key.split('.');
  let cur = next;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  // Keep legacy mirror fields in sync when agy_tiers.standard/simple is updated
  if (key === 'agy_tiers.standard') next.subagent_default_model = value;
  if (key === 'agy_tiers.simple') next.subagent_research_model = value;
  return { policy: next, spec, value };
}

function resetParamValue(policy, key) {
  const spec = PARAM_BY_KEY[key];
  if (!spec) throw new Error(`Unknown parameter "${key}". Run "Mode.ps1 params list" to inspect valid keys.`);
  const defaultVal = Array.isArray(spec.default) ? [...spec.default] : spec.default;
  return setParamValue(policy, key, defaultVal);
}

function listParams(policy, group = null) {
  if (group && !PARAM_GROUPS.includes(group)) {
    throw new Error(`Unknown parameter group "${group}". Valid groups: ${PARAM_GROUPS.join(', ')}`);
  }
  return PARAM_CATALOG
    .filter(spec => !group || spec.group === group)
    .map(spec => {
      const currentVal = getParamValue(policy, spec.key);
      const defaultVal = Array.isArray(spec.default) ? [...spec.default] : spec.default;
      const modified = JSON.stringify(currentVal) !== JSON.stringify(defaultVal);
      return {
        key: spec.key,
        group: spec.group,
        value: currentVal,
        default: defaultVal,
        modified,
        type: spec.type,
        ...(spec.values ? { values: spec.values } : {}),
        ...(spec.min !== undefined ? { min: spec.min } : {}),
        ...(spec.max !== undefined ? { max: spec.max } : {}),
        ...(spec.nullable ? { nullable: true } : {}),
        unit: spec.unit,
        desc: spec.desc
      };
    });
}

function buildDefaultTemplate() {
  return {
    schema: 1,
    default_mode: 'auto',
    apply_to_unregistered_projects: false,
    enforce_subagent_low_cost: true,
    cache_ttl_seconds: 300,
    agy_quota_hint: 'normal',
    pacing: { ...DEFAULT_PACING },
    agy_pacing: { ...DEFAULT_AGY_PACING },
    agy_guard: { ...DEFAULT_AGY_GUARD },
    agy_tiers: { ...DEFAULT_AGY_TIERS },
    agy_host_models: { standard: null, complex: null, expert: null },
    agy_probe: { ...DEFAULT_AGY_PROBE, retry_delays_ms: [...DEFAULT_AGY_PROBE.retry_delays_ms] },
    maintenance: { ...DEFAULT_MAINTENANCE },
    agy_model_pools: {},
    thinking_models: { general: null, quant: null, backups: [] },
    projects: {}
  };
}

module.exports = {
  DEFAULT_PACING,
  DEFAULT_AGY_PACING,
  DEFAULT_AGY_GUARD,
  DEFAULT_AGY_TIERS,
  DEFAULT_AGY_PROBE,
  DEFAULT_MAINTENANCE,
  PARAM_CATALOG,
  PARAM_BY_KEY,
  PARAM_GROUPS,
  getParamValue,
  coerceParamValue,
  setParamValue,
  resetParamValue,
  listParams,
  buildDefaultTemplate
};
