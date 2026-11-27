'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { saveAtomic, isAgyQuotaError } = require('./routing-policy.cjs');

const WRITE_TOOL_RE = /(?:^|[_/.:-])(?:write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|apply_patch)$/i;
const EXEC_TOOL_RE = /(?:^|[_/.:-])(?:run_command|invoke_subagent|run_workflow|write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content|apply_patch)$/i;
const AUTH_OR_POLICY_ERR_RE = /\b(?:401|403)\b|unauthenticated|invalid.*(?:api[_ -]?key|token|credential)|permission_denied|blocked by policy|\[AGY_LOOP_GUARD\]|\[AGY_REVIEW_REQUIRED\]/i;

function defaultGuardStatePath(policyPath, scope) {
  if (policyPath) return path.join(path.dirname(policyPath), 'agy-guard-state.json');
  const dataRoot = typeof scope === 'string' ? scope : scope?.data;
  return dataRoot ? path.join(path.resolve(dataRoot), 'agy-guard-state.json') : null;
}

function loadGuardState(file) {
  if (!file || !fs.existsSync(file)) return { schema: 1, conversations: {}, agy_quota_cooldown_until: null, agy_quota_cooldown_reason: null, updated_at: null };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object') throw new Error('invalid');
    return {
      schema: 1,
      conversations: doc.conversations && typeof doc.conversations === 'object' && !Array.isArray(doc.conversations) ? doc.conversations : {},
      agy_quota_cooldown_until: typeof doc.agy_quota_cooldown_until === 'string' ? doc.agy_quota_cooldown_until : null,
      agy_quota_cooldown_reason: typeof doc.agy_quota_cooldown_reason === 'string' ? doc.agy_quota_cooldown_reason : null,
      updated_at: typeof doc.updated_at === 'string' ? doc.updated_at : null
    };
  } catch {
    return { schema: 1, conversations: {}, agy_quota_cooldown_until: null, agy_quota_cooldown_reason: null, updated_at: null };
  }
}

function persistGuardState(file, state) {
  if (!file) return;
  const entries = Object.entries(state.conversations || {}).slice(-40);
  saveAtomic(file, {
    schema: 1,
    conversations: Object.fromEntries(entries),
    agy_quota_cooldown_until: state.agy_quota_cooldown_until || null,
    agy_quota_cooldown_reason: state.agy_quota_cooldown_reason || null,
    updated_at: new Date().toISOString()
  });
}

function hashInput(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return crypto.createHash('sha256').update(text.trim(), 'utf8').digest('hex').slice(0, 16);
}

// Normalize transient noise (timestamps, hex IDs, line/ms numbers) so genuine
// same-place loops match while distinct bugs in different places never trip early.
function failureSignature(toolName, args, errorText) {
  const target = String(args?.Path || args?.path || args?.TargetFile || args?.Role || '').trim().toLowerCase();
  const cmdHead = typeof args?.CommandLine === 'string' ? args.CommandLine.trim().slice(0, 80).toLowerCase() : '';
  const cleanedErr = String(errorText || '')
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, '<ts>')
    .replace(/\b[0-9a-f]{8,}\b/g, '<hex>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|bytes?)\b/g, '<dur>')
    .replace(/:\d+(?::\d+)?\b/g, ':<line>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const raw = `${String(toolName || '').toLowerCase()}|${target || cmdHead}|${cleanedErr}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function isReadOnlySubagentCall(toolName, args) {
  if (!/(?:^|[_/.:-])invoke_subagent$/i.test(toolName || '')) return false;
  return String(args?.TypeName || args?.typeName || args?.type_name || '').trim().toLowerCase() === 'research';
}

function findRecentCodexReview(scope, validHours = 12, conversationId = null, nowMs = Date.now()) {
  const dataRoot = typeof scope === 'string' ? scope : scope?.data;
  if (!dataRoot || validHours <= 0) return null;
  const jobsDir = path.join(dataRoot, 'jobs');
  if (!fs.existsSync(jobsDir)) return null;
  const cutoffMs = nowMs - validHours * 3600 * 1000;
  let dirs = [];
  try {
    dirs = fs.readdirSync(jobsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-f0-9]{24}$/.test(d.name))
      .map(d => {
        const jobFile = path.join(jobsDir, d.name, 'job.json');
        try {
          const st = fs.statSync(jobFile);
          return st.isFile() && st.mtimeMs >= cutoffMs ? { id: d.name, jobFile, mtimeMs: st.mtimeMs } : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 30);
  } catch { return null; }

  let bestOther = null;
  for (const item of dirs) {
    let job;
    try { job = JSON.parse(fs.readFileSync(item.jobFile, 'utf8')); } catch { continue; }
    if (job?.plan_review?.status !== 'approved') continue;
    const reviewedAtMs = Date.parse(job.plan_review.reviewed_at || job.ended_at || job.created_at);
    if (!Number.isFinite(reviewedAtMs) || reviewedAtMs < cutoffMs) continue;
    const record = {
      job_id: job.job_id || item.id,
      review_only: job.review_only === true,
      stage: job.stage || null,
      reviewed_at: new Date(reviewedAtMs).toISOString(),
      conversation_id: job.conversation_id || null,
      allowed_scope: Array.isArray(job.plan_review.allowed_scope) ? job.plan_review.allowed_scope.slice(0, 6) : [],
      reason: String(job.plan_review.reason || '').slice(0, 240)
    };
    if (conversationId && job.conversation_id === conversationId) return record;
    if (!bestOther && (job.review_only === true || job.stage === 'review_complete')) bestOther = record;
    else if (!bestOther) bestOther = record;
  }
  return bestOther;
}

function recordToolOutcome(payload, scope, projectPolicy, options = {}) {
  const name = payload?.toolCall?.name || '';
  const args = payload?.toolCall?.args || {};
  if (!EXEC_TOOL_RE.test(name) || isReadOnlySubagentCall(name, args)) return { recorded: false };

  const nowMs = options.nowMs ?? Date.now();
  const stateFile = options.guardStateFile || defaultGuardStatePath(options.policyPath, scope);
  if (!stateFile) return { recorded: false };
  const guardCfg = projectPolicy?.agy_guard || {};
  const maxSameFailures = guardCfg.max_same_error_failures ?? 3;
  const maxTotalFailures = guardCfg.max_consecutive_failures ?? 8;
  const cooldownMins = guardCfg.quota_error_cooldown_minutes ?? 15;
  const convId = payload?.conversationId || 'default';
  const inputHash = hashInput(payload?.lastUserInput);
  const errorText = typeof payload?.error === 'string' ? payload.error.trim() : '';

  const state = loadGuardState(stateFile);
  let entry = state.conversations[convId] || {
    consecutive_failures: 0,
    same_error_streak: 0,
    last_error_sig: null,
    tripped: false,
    trip_reason: null,
    last_user_input_hash: inputHash,
    recent_failures: []
  };

  // A new human turn resets prior loop-guard counters cleanly.
  if (inputHash && entry.last_user_input_hash && inputHash !== entry.last_user_input_hash) {
    entry = {
      consecutive_failures: 0,
      same_error_streak: 0,
      last_error_sig: null,
      tripped: false,
      trip_reason: null,
      last_user_input_hash: inputHash,
      recent_failures: []
    };
  } else if (inputHash) {
    entry.last_user_input_hash = inputHash;
  }

  if (!errorText) {
    entry.consecutive_failures = 0;
    entry.same_error_streak = 0;
    entry.last_error_sig = null;
    entry.tripped = false;
    entry.trip_reason = null;
    entry.last_success_tool = name;
    entry.last_success_at = new Date(nowMs).toISOString();
    state.conversations[convId] = entry;
    persistGuardState(stateFile, state);
    return { recorded: true, outcome: 'success_reset', entry };
  }

  if (isAgyQuotaError(errorText)) {
    const until = new Date(nowMs + cooldownMins * 60000).toISOString();
    state.agy_quota_cooldown_until = until;
    state.agy_quota_cooldown_reason = errorText.slice(0, 240);
    state.conversations[convId] = entry;
    persistGuardState(stateFile, state);
    return { recorded: true, outcome: 'quota_cooldown', until, entry };
  }

  if (AUTH_OR_POLICY_ERR_RE.test(errorText)) {
    entry.last_non_business_error = { tool: name, error: errorText.slice(0, 240), at: new Date(nowMs).toISOString() };
    state.conversations[convId] = entry;
    persistGuardState(stateFile, state);
    return { recorded: true, outcome: 'auth_or_policy_ignored', entry };
  }

  const sig = failureSignature(name, args, errorText);
  entry.consecutive_failures = (entry.consecutive_failures || 0) + 1;
  entry.same_error_streak = entry.last_error_sig === sig ? (entry.same_error_streak || 0) + 1 : 1;
  entry.last_error_sig = sig;
  entry.recent_failures = [...(entry.recent_failures || []), { tool: name, sig, error: errorText.slice(0, 240), at: new Date(nowMs).toISOString() }].slice(-5);

  const sameTripped = maxSameFailures > 0 && entry.same_error_streak >= maxSameFailures;
  const totalTripped = maxTotalFailures > 0 && entry.consecutive_failures >= maxTotalFailures;
  entry.tripped = sameTripped || totalTripped;
  entry.trip_reason = sameTripped ? 'same_error_loop' : totalTripped ? 'no_progress_cap' : null;

  state.conversations[convId] = entry;
  persistGuardState(stateFile, state);
  return { recorded: true, outcome: entry.tripped ? 'tripped' : 'failure_counted', entry };
}

function checkAgyExecutionGate(payload, scope, projectPolicy, options = {}) {
  const name = payload?.toolCall?.name || '';
  const args = payload?.toolCall?.args || {};
  if (!EXEC_TOOL_RE.test(name) || isReadOnlySubagentCall(name, args)) {
    return { blocked: false };
  }

  const nowMs = options.nowMs ?? Date.now();
  const stateFile = options.guardStateFile || defaultGuardStatePath(options.policyPath, scope);
  const guardCfg = projectPolicy?.agy_guard || { max_same_error_failures: 3, max_consecutive_failures: 8, review_gate: 'advisory', review_valid_hours: 12 };
  const guardEnabled = (guardCfg.max_same_error_failures ?? 3) > 0 || (guardCfg.max_consecutive_failures ?? 8) > 0;
  const convId = payload?.conversationId || 'default';
  const inputHash = hashInput(payload?.lastUserInput);

  // 1. Smart Loop Guard: trips on 3 identical same-error retries OR 8 consecutive failures without any success.
  // Different errors while making normal debugging progress are NOT interrupted at 3.
  if (stateFile && guardEnabled) {
    const state = loadGuardState(stateFile);
    const entry = state.conversations[convId];
    if (entry?.tripped) {
      if (inputHash && entry.last_user_input_hash && inputHash !== entry.last_user_input_hash) {
        entry.consecutive_failures = 0;
        entry.same_error_streak = 0;
        entry.last_error_sig = null;
        entry.tripped = false;
        entry.trip_reason = null;
        entry.last_user_input_hash = inputHash;
        entry.reset_by = 'new_user_input';
        state.conversations[convId] = entry;
        persistGuardState(stateFile, state);
      } else {
        const latest = entry.recent_failures?.at(-1);
        const excerpt = latest ? `${latest.tool}: ${latest.error}` : '连续工具执行失败';
        const detail = entry.trip_reason === 'same_error_loop'
          ? `同一错误已连续重复失败 ${entry.same_error_streak} 次`
          : `已连续失败 ${entry.consecutive_failures} 次且中间无成功进展`;
        return {
          blocked: true,
          kind: 'loop_guard',
          reason: `[AGY_LOOP_GUARD] 当前会话 AGY 执行${detail}（最近：${excerpt}），已自动熔断暂停写入/执行，避免原地空转消耗额度。请先只读排查根因，向用户说明“失败原因、已核实证据与最合适方案”；待用户回复新指令后自动解锁（也可交 Codex 兜底，或运行 scripts/Mode.ps1 reset-agy-guard 手动解锁）。`
        };
      }
    }
  }

  // 2. Hybrid Review-Before-AGY Gate (off | advisory | strict)
  const gateLevel = guardCfg.review_gate || 'advisory';
  const requiresWriteReview = WRITE_TOOL_RE.test(name) || /(?:^|[_/.:-])(?:invoke_subagent|run_workflow)$/i.test(name);
  if (gateLevel !== 'off' && requiresWriteReview) {
    const validHours = guardCfg.review_valid_hours ?? 12;
    const review = findRecentCodexReview(scope, validHours, payload?.conversationId || null, nowMs);
    if (!review) {
      if (options.codexExhausted === true) {
        if (gateLevel === 'strict' || projectPolicy?.review_category === 'quant') {
          return {
            blocked: false,
            advisory: '提示：当前 Codex 周额度已 100% 耗尽，先审后做门禁已自动免除 codex_run(review_only=true) 以防死锁；重要改动前请先派 AGY 只读 research 子代理完成独立核查。'
          };
        }
        return { blocked: false };
      }
      if (gateLevel === 'strict') {
        return {
          blocked: true,
          kind: 'review_required',
          reason: `[AGY_REVIEW_REQUIRED] 当前项目启用了“先审后做”硬门禁（strict）：最近 ${validHours} 小时内未找到已通过的 Codex 独立只读审核回执。请先调用一次 codex_run(review_only=true) 获取独立审核通过，再由 AGY 低成本子代理实施（只读 read_file / research 子代理不受阻；如需放宽可运行 scripts/Mode.ps1 agy-review-gate --level advisory）。`
        };
      }
      if (gateLevel === 'advisory' && projectPolicy?.review_category === 'quant') {
        return {
          blocked: false,
          advisory: '提示：当前量化项目近期尚无 Codex review_only 审核记录；若涉及核心策略/数据/PIT 改动，建议先跑一次 codex_run(review_only=true) 独立审核后再交 AGY 实施。'
        };
      }
    } else {
      return { blocked: false, review };
    }
  }

  return { blocked: false };
}

function resetAgyGuard(stateFile, conversationId = null) {
  const state = loadGuardState(stateFile);
  if (conversationId) {
    delete state.conversations[conversationId];
  } else {
    state.conversations = {};
    state.agy_quota_cooldown_until = null;
    state.agy_quota_cooldown_reason = null;
  }
  persistGuardState(stateFile, state);
  return state;
}

function readGuardQuotaCooldown(stateFile, nowMs = Date.now()) {
  if (!stateFile) return null;
  const state = loadGuardState(stateFile);
  if (!state.agy_quota_cooldown_until) return null;
  const ms = Date.parse(state.agy_quota_cooldown_until);
  if (!Number.isFinite(ms) || ms <= nowMs) return null;
  return {
    until: state.agy_quota_cooldown_until,
    reason: state.agy_quota_cooldown_reason || 'PostToolUse 429 cooldown',
    updated_at: state.updated_at || null
  };
}

function clearGuardQuotaCooldown(stateFile) {
  if (!stateFile || !fs.existsSync(stateFile)) return;
  const state = loadGuardState(stateFile);
  if (!state.agy_quota_cooldown_until) return;
  state.agy_quota_cooldown_until = null;
  state.agy_quota_cooldown_reason = null;
  persistGuardState(stateFile, state);
}

module.exports = {
  defaultGuardStatePath,
  loadGuardState,
  failureSignature,
  findRecentCodexReview,
  recordToolOutcome,
  checkAgyExecutionGate,
  resetAgyGuard,
  readGuardQuotaCooldown,
  clearGuardQuotaCooldown
};
