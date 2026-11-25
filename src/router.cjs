'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Broker, inside, terminal, executionSandbox } = require('./server.cjs');
const {
  defaultPolicyPath,
  defaultQuotaCachePath,
  defaultCodexSessionsDir,
  loadRoutingPolicy,
  resolveProjectPolicy,
  evaluateCodexPacing,
  evaluateAgyPacing,
  evaluateCodexConcurrencyGate,
  evaluateSubagentCall,
  activeCodexTasks,
  decideRoute,
  readQuotaCache,
  readStaleQuotaCache,
  readLatestCodexRolloutRateLimits,
  scanAgyTranscriptUsage,
  saveAtomic
} = require('./routing-policy.cjs');
const {
  defaultGuardStatePath,
  checkAgyExecutionGate,
  recordToolOutcome,
  readGuardQuotaCooldown
} = require('./agy-guard.cjs');

const real = p => fs.realpathSync(p);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const executionTools = ['run_command', 'manage_task', 'send_command_input', 'command_status', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'apply_patch', 'edit_file', 'write_file', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'spawn_agent', 'spawn_subagent', 'delegate_task', 'send_message', 'schedule', 'run_workflow'];
const executionPattern = new RegExp('(?:^|[_/.:-])(?:' + executionTools.join('|') + ')$|subagent|sub_agent', 'i');
const hookMatcher = '(?:^|[_/.:-])(?:codex_(run|sessions|list|wait|result|cancel|quota)|call_mcp_tool|' + executionTools.join('|') + ')$|subagent|sub_agent';
const subagentInvokePattern = /(?:^|[_/.:-])invoke_subagent$/i;
const readOnlySubagentType = args => String(args?.TypeName || args?.typeName || args?.type_name || '').trim().toLowerCase() === 'research';
const isolatedWorkspace = args => ['share', 'branch'].includes(String(args?.Workspace || args?.workspace || '').trim().toLowerCase());

function scopesFor(workspaces, projects) {
  return projects.filter(p => workspaces.some(w => {
    try { const root = real(w); return same(root, p.project) || inside(root, p.project) || inside(p.project, root); } catch { return false; }
  }));
}

function effectiveScopePolicy(scopes, options = {}) {
  const first = scopes[0];
  const policyPath = options.policyPath || defaultPolicyPath(first);
  const policy = options.policy || loadRoutingPolicy(policyPath, { defaultMode: options.defaultMode || 'auto' });
  const resolved = scopes.map(scope => ({ scope, policy: resolveProjectPolicy(policy, scope) }));
  // If any matched workspace is locked to codex-only, keep the stricter lock.
  const locked = resolved.find(item => item.policy.mode === 'codex');
  return { rawPolicy: policy, policyPath, selected: locked || resolved[0] };
}

function isReadOnlyTaskStatusCall(name, args = {}) {
  if (/(?:^|[_/.:-])command_status$/i.test(name)) return true;
  const action = String(args.Action || args.action || '').trim().toLowerCase();
  if (/(?:^|[_/.:-])manage_task$/i.test(name) && ['list', 'status'].includes(action)) return true;
  if (/(?:^|[_/.:-])manage_subagents$/i.test(name) && action === 'list') return true;
  return false;
}

function resolveFastCodexPacing(scope, projectPolicy, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const policyPath = options.policyPath || defaultPolicyPath(scope);
  const cachePath = options.cachePath || defaultQuotaCachePath(policyPath, scope);
  const fresh = readQuotaCache(cachePath, Math.max(projectPolicy.cache_ttl_seconds || 60, 300), nowMs);
  if (fresh?.codex_pacing?.available) return { codexPacing: fresh.codex_pacing, cached: fresh };
  const sessionsDir = defaultCodexSessionsDir(scope, options);
  const rollout = sessionsDir ? readLatestCodexRolloutRateLimits({ codexSessionsDir: sessionsDir, nowMs }) : null;
  const fromRollout = rollout ? evaluateCodexPacing(rollout, projectPolicy.pacing, nowMs) : null;
  const stale = readStaleQuotaCache(cachePath, nowMs);
  if (fromRollout?.available && (!stale?.codex_pacing?.available || fromRollout.used_percent >= stale.codex_pacing.used_percent)) {
    return { codexPacing: { ...fromRollout, source: 'codex_rollout_log', observed_at: rollout.observed_at }, cached: stale };
  }
  if (stale?.codex_pacing?.available) {
    return { codexPacing: { ...stale.codex_pacing, stale: true, source: 'stale_cache' }, cached: stale };
  }
  return { codexPacing: { available: false }, cached: fresh || stale || null };
}

function bindOrigin(payload, projects, options = {}) {
  const name = payload?.toolCall?.name || '';
  if (/(?:^|[_/.:-])call_mcp_tool$/.test(name)) {
    const outer = payload.toolCall.args || {}, key = Object.hasOwn(outer, 'Arguments') ? 'Arguments' : 'arguments';
    const innerName = outer.ToolName || outer.toolName || outer.tool_name || '';
    const args = outer[key] || {};
    if (typeof args !== 'object' || Array.isArray(args)) return { decision: 'deny', reason: 'MCP Arguments 必须是对象，未执行。' };
    const result = bindOrigin({ ...payload, toolCall: { name: innerName, args } }, projects, options);
    return result.overwrite ? { ...result, overwrite: { [key]: { ...args, ...result.overwrite } } } : result;
  }
  const match = name.match(/(?:^|[_/.:-])(codex_run|codex_sessions|codex_list|codex_wait|codex_result|codex_cancel|codex_quota)$/);
  if (!match) {
    const scopes = scopesFor(payload.workspacePaths || [], projects);
    if (!executionPattern.test(name)) return { decision: 'allow' };
    if (!scopes.length) return { decision: 'allow' };
    const { policyPath, selected } = effectiveScopePolicy(scopes, options);
    const projectPolicy = selected.policy;
    if (projectPolicy.mode === 'codex') {
      return { decision: 'deny', reason: '本项目当前处于 codex 锁定模式：由 Antigravity 规划和验收，执行必须交给 codex_run；需要子 agent 时由 Codex 会话启动原生子 agent。如需同时启用 AGY 低成本多子代理，请将模式切回 auto 或 agy。' };
    }
    const args = payload.toolCall?.args || {};
    if (isReadOnlyTaskStatusCall(name, args)) return { decision: 'allow' };
    const gate = checkAgyExecutionGate(payload, selected.scope, projectPolicy, {
      policyPath,
      guardStateFile: options.guardStateFile,
      nowMs: options.nowMs
    });
    if (gate.blocked) return { decision: 'deny', reason: gate.reason };
    const active = activeCodexTasks(selected.scope);
    const notes = [];
    if (gate.advisory) notes.push(gate.advisory);
    if (gate.review) notes.push(`已关联 Codex 只读审核(${gate.review.job_id.slice(0, 8)})。`);
    let overwrite;
    if (subagentInvokePattern.test(name)) {
      const sub = evaluateSubagentCall(args, projectPolicy);
      if (sub.overwrite) overwrite = sub.overwrite;
      if (sub.note) notes.push(sub.note);
      if (active.count > 0 && !readOnlySubagentType(args) && !isolatedWorkspace(args)) {
        notes.push(`注意：当前项目有 ${active.count} 个活跃 Codex 任务；并行写同一仓库时请切分非重叠目录或为子代理指定 Workspace="share"，并由主会话串行做 Git 提交。`);
      }
    } else if (active.count > 0 && !/(?:^|[_/.:-])(?:manage_subagents|define_subagent)$/i.test(name)) {
      notes.push(`注意：当前项目有 ${active.count} 个活跃 Codex 任务，注意文件边界不重叠，Git 暂存与提交须串行协调。`);
    }
    return { decision: 'allow', ...(overwrite ? { overwrite } : {}), ...(notes.length ? { reason: notes.join(' ') } : {}) };
  }
  const tool = match[1], args = payload.toolCall.args || {};
  const scopes = scopesFor(payload.workspacePaths || [], projects);
  if (!scopes.length) return { decision: 'deny', reason: '当前 Antigravity 项目没有已登记的 Codex 执行根；不能误用其他项目。' };
  if (['codex_wait', 'codex_result', 'codex_cancel'].includes(tool)) {
    if (!/^[a-f0-9]{24}$/.test(args.job_id || '')) return { decision: 'deny', reason: '需要真实 job_id。' };
    const owner = projects.find(p => p.data && fs.existsSync(path.join(p.data, 'jobs', args.job_id, 'job.json')));
    return owner && scopes.includes(owner) ? { decision: 'allow' } : { decision: 'deny', reason: '任务不属于当前 Antigravity 项目，禁止串项目领取或取消。' };
  }
  let cwd;
  try { if (args.cwd) cwd = real(args.cwd); } catch { return { decision: 'deny', reason: 'cwd 不存在。' }; }
  if (cwd && !scopes.some(p => inside(p.project, cwd))) return { decision: 'deny', reason: 'cwd 不属于当前项目登记的执行根。' };
  if (tool === 'codex_quota') {
    if (!cwd && scopes.length === 1) return { decision: 'allow', overwrite: { cwd: scopes[0].project } };
    return { decision: 'allow', ...(cwd ? { overwrite: { cwd } } : {}) };
  }
  if (!cwd && scopes.length !== 1) return { decision: 'deny', reason: '本项目有多个代码根；请按事项明确 cwd，不猜最近目录。' };
  cwd ||= scopes[0].project;
  const overwrite = { cwd };
  if (tool === 'codex_run') {
    const ownerScope = scopes.find(p => inside(p.project, cwd)) || scopes[0];
    try { executionSandbox(args, ownerScope); }
    catch (error) { return { decision: 'deny', reason: error.message }; }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.conversationId || '')) return { decision: 'deny', reason: '缺少真实发起会话 ID。' };
    const { policyPath, selected } = effectiveScopePolicy([ownerScope], options);
    const guardFile = options.guardStateFile || defaultGuardStatePath(policyPath, selected.scope);
    const guardCooldown = readGuardQuotaCooldown(guardFile, options.nowMs);
    const effPolicy = { ...selected.policy, ...(guardCooldown ? { guard_quota_cooldown: guardCooldown } : {}) };
    if (effPolicy.mode === 'auto' && args.review_only !== true) {
      const { codexPacing, cached } = resolveFastCodexPacing(selected.scope, effPolicy, { ...options, policyPath });
      if (codexPacing.available) {
        const agyUsage = cached?.agy_usage || { available: false };
        const agyPacing = evaluateAgyPacing({ agyUsage, agyExternal: cached?.agy_external || null, projectPolicy: effPolicy, codexPacing, nowMs: options.nowMs });
        const totalActive = projects.reduce((sum, p) => sum + activeCodexTasks(p).count, 0);
        const concGate = evaluateCodexConcurrencyGate({ args, projectPolicy: effPolicy, codexPacing, agyPacing, totalActiveCodexTasks: totalActive });
        if (concGate.blocked) return { decision: 'deny', reason: concGate.reason };
      }
    }
    overwrite.conversation_id = payload.conversationId;
  }
  return { decision: 'allow', overwrite };
}

function readContextMarker(file) {
  if (!file || !fs.existsSync(file)) return {};
  try { const doc = JSON.parse(fs.readFileSync(file, 'utf8')); return doc && typeof doc === 'object' ? doc : {}; } catch { return {}; }
}

function contextHook(payload, projects, options = {}) {
  const scopes = scopesFor(payload?.workspacePaths || [], projects);
  if (!scopes.length) return {};
  const { rawPolicy, policyPath, selected } = effectiveScopePolicy(scopes, options);
  const guardFile = options.guardStateFile || defaultGuardStatePath(policyPath, selected.scope);
  const guardCooldown = readGuardQuotaCooldown(guardFile, options.nowMs);
  const projectPolicy = { ...selected.policy, ...(guardCooldown ? { guard_quota_cooldown: guardCooldown } : {}) };
  const { codexPacing, cached } = resolveFastCodexPacing(selected.scope, projectPolicy, { ...options, policyPath });
  const agyUsage = cached?.agy_usage || scanAgyTranscriptUsage({ transcriptPath: payload?.transcriptPath, brainDir: options.brainDir, nowMs: options.nowMs });
  const active = activeCodexTasks(selected.scope);
  const route = decideRoute({
    policy: rawPolicy,
    projectPolicy,
    projectScope: selected.scope,
    codexPacing,
    agyUsage,
    agyExternal: cached?.agy_external || null,
    activeCodexTasks: active,
    modelName: payload?.modelName || '',
    nowMs: options.nowMs
  });

  const eventName = payload?.hookEventName || 'SessionStart';
  const conversationId = payload?.conversationId || '';
  const fingerprint = JSON.stringify({
    mode: route.mode,
    preferred: route.preferred_engine,
    reason: route.reason,
    updated_at: rawPolicy.updated_at || null,
    quant_reminder: route.thinking_guidance?.matches_required === false ? route.thinking_guidance.required_thinking_model : null,
    pool_stopped: Boolean(route.thinking_guidance?.current_model_pool_stopped)
  });
  const markerFile = options.markerFile || (policyPath ? path.join(path.dirname(policyPath), 'context-hook-state.json') : null);
  if (eventName === 'PreInvocation' && conversationId && markerFile) {
    const markers = readContextMarker(markerFile);
    if (markers[conversationId]?.fingerprint === fingerprint) return {};
  }
  if (conversationId && markerFile) {
    try {
      const markers = readContextMarker(markerFile);
      const entries = Object.entries(markers).slice(-40);
      const next = Object.fromEntries(entries);
      next[conversationId] = { fingerprint, at: new Date(options.nowMs ?? Date.now()).toISOString() };
      saveAtomic(markerFile, next);
    } catch {}
  }

  const hostModels = projectPolicy.agy_host_models || {};
  const hostMapParts = [
    hostModels.standard ? `standard(常规)→${hostModels.standard}` : null,
    hostModels.complex ? `complex(复杂)→${hostModels.complex}` : null,
    hostModels.expert ? `expert(顶配思考)→${hostModels.expert}` : null
  ].filter(Boolean);
  const poolLines = Object.entries(route.agy_model_pools || {}).map(([name, st]) => {
    const pctText = st.weekly_used_percent !== null
      ? (st.target_used_percent !== null
        ? `7天线性目标 ${st.target_used_percent}% / 已用 ${st.weekly_used_percent}%（偏差 ${st.pacing_delta >= 0 ? '+' : ''}${st.pacing_delta}%）`
        : `7天已用 ${st.weekly_used_percent}%`)
      : `7天线性(上限${st.weekly_protect_used_percent}%未标定)`;
    const h5Text = st.five_hour_used_percent !== null ? `5h已用 ${st.five_hour_used_percent}%` : (st.tokens_5h ? `5h=${st.tokens_5h} tokens` : '5h正常');
    const stateLabel = st.stopped ? '已硬停' : st.caution ? '5h警戒' : st.band === 'ahead_of_pace' ? '超前建议控速' : '可用';
    return `${name}池(${pctText}，≥${st.weekly_protect_used_percent}%硬停留${st.buffer_percent}%缓冲，${h5Text}，状态=${stateLabel})`;
  });
  const agyTargetPct = projectPolicy.agy_pacing?.target_utilization ?? 90;
  const agyBufferPct = Math.max(0, Math.round((100 - (projectPolicy.agy_pacing?.weekly_protect_used_percent ?? 90)) * 100) / 100);
  const lines = [
    `[双引擎路由状态] ${route.summary_line}`,
    `执行模式：${route.mode}（支持缩写 agy/AGY/Agy 与 codex；用户显式点名优先；同事项粘性锁定单执行端；Codex 按 ${projectPolicy.pacing?.plan_days ?? 5} 天 100% 等比例消化、AGY 默认只用 ${agyTargetPct}% 额度并预留 ${agyBufferPct}% 应急缓冲且叠加 5 小时窗口限制，AGY 触及缓冲线/5h受限时由 Codex 兜底；凡需 Codex 原生子代理协作或依赖 Codex 原生子会话契约的任务固定留 Codex 执行）。`,
    `AGY 低成本多子代理分层与保缓存：simple/research→${projectPolicy.agy_tiers.simple}，standard(默认)→${projectPolicy.agy_tiers.standard}，complex→${projectPolicy.agy_tiers.complex}，expert→${projectPolicy.agy_tiers.expert}；同模块内通过 send_message 长期复用同一个低成本子代理以维持高缓存命中率，避免高配主会话亲自跑长循环或每次小改冷启动新子代理；Codex 未达保护线时，极轻量机械任务优先 Codex simple；批量扇出用 run_workflow，并行写用 Workspace="share"，Git 串行收口。`,
    ...(hostMapParts.length ? [`AGY 本机主对话档位对照：${hostMapParts.join('，')}${projectPolicy.thinking_backups?.length ? `；顶配备用顺序：${projectPolicy.thinking_backups.join(' → ')}` : ''}（整段常规开发留 AGY 主对话执行时优先切 standard 档位）。`] : []),
    ...(poolLines.length ? [`AGY 独立模型池保护：${poolLines.join('；')}。`] : []),
    `AGY 安全门禁：先审后做=${projectPolicy.agy_guard.review_gate}（重要/量化改动建议先 codex_run(review_only=true) 再交 AGY 实施）；防死循环=同一错误连错 ${projectPolicy.agy_guard.max_same_error_failures} 次或无进展连错 ${projectPolicy.agy_guard.max_consecutive_failures} 次自动熔断（不同错误允许自行修复，成功即清零）。`
  ];
  if (route.thinking_guidance?.reminder) lines.push(`${route.thinking_guidance.current_model_pool_stopped ? '[模型池硬停告警]' : '[思考模型提示]'} ${route.thinking_guidance.reminder}`);
  if (active.count > 0) lines.push(`[并发防撞] 当前项目有 ${active.count} 个活跃 Codex 任务；AGY 写操作请避开重叠文件或使用 Workspace="share"。`);

  return {
    injectSteps: [{ systemMessage: { systemMessage: lines.join('\n') } }]
  };
}

function postToolHook(payload, projects, options = {}) {
  const scopes = scopesFor(payload?.workspacePaths || [], projects);
  if (!scopes.length) return {};
  const { policyPath, selected } = effectiveScopePolicy(scopes, options);
  if (selected.policy.mode === 'codex') return {};
  recordToolOutcome(payload, selected.scope, selected.policy, {
    policyPath,
    guardStateFile: options.guardStateFile,
    nowMs: options.nowMs
  });
  return {};
}

class ProjectRouter {
  constructor(settings) {
    this.settings = settings;
    this.brokers = settings.projects.map(p => new Broker(p));
  }
  forCwd(cwd) {
    const target = real(cwd || this.settings.project);
    const matches = this.brokers.filter(b => inside(b.settings.project, target));
    matches.sort((a, b) => b.settings.project.length - a.settings.project.length);
    if (!matches.length) throw new Error('cwd is outside registered projects');
    return matches[0];
  }
  forJob(id) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid job_id');
    const matches = this.brokers.filter(b => fs.existsSync(b.jobPath(id)));
    if (matches.length !== 1) throw new Error('Unknown or ambiguous project job_id');
    return matches[0];
  }
  forInput(input) {
    let matches = [];
    if (input.topic_id) matches = this.brokers.filter(b => b.list(Number.MAX_SAFE_INTEGER).some(j => j.topic_id === input.topic_id));
    else if (input.session_id && !input.cwd) matches = this.brokers.filter(b => b.knownSessions().some(s => s.session_id === input.session_id));
    if (matches.length > 1) throw new Error('Ambiguous cross-project matter/session');
    const owner = matches[0];
    if (owner && input.cwd && !inside(owner.settings.project, real(input.cwd))) throw new Error('Selected matter belongs to a different project');
    return owner || this.forCwd(input.cwd);
  }
  async run(input, signal) { return this.forInput(input).run(input, signal); }
  start(input) { return this.forInput(input).start(input); }
  get(id) { return this.forJob(id).get(id); }
  status(id) { return this.forJob(id).status(id); }
  syncTitle(id, diagnostics) { return this.forJob(id).syncTitle(id, diagnostics); }
  result(id, diagnostics) { return this.forJob(id).result(id, diagnostics); }
  wait(id, signal) { return this.forJob(id).wait(id, signal); }
  cancel(id) { return this.forJob(id).cancel(id); }
  async sessions(input = {}) { return this.forCwd(input.cwd).sessions(input); }
  async quota(input = {}) {
    const broker = input.cwd ? this.forCwd(input.cwd) : this.brokers[0];
    const report = await broker.quota(input);
    return {
      ...report,
      projects: this.brokers.map(b => ({
        project: b.settings.project,
        review_category: b.settings.review_category || 'general',
        active_codex_tasks: activeCodexTasks(b.settings).count
      }))
    };
  }
  list(limit = 20, cwd, activeOnly = false) {
    if (cwd) return this.forCwd(cwd).list(limit, undefined, activeOnly);
    return this.brokers.flatMap(b => b.list(limit, undefined, activeOnly)).filter(j => !activeOnly || !terminal.has(j.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, activeOnly ? Number.MAX_SAFE_INTEGER : limit);
  }
}

module.exports = { ProjectRouter, bindOrigin, contextHook, postToolHook, hookMatcher };
