'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Broker, inside, terminal, executionSandbox } = require('./server.cjs');
const real = p => fs.realpathSync(p);
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const executionTools = ['run_command', 'manage_task', 'send_command_input', 'command_status', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'apply_patch', 'edit_file', 'write_file', 'invoke_subagent', 'define_subagent', 'manage_subagents', 'spawn_agent', 'spawn_subagent', 'delegate_task', 'send_message', 'schedule'];
const executionPattern = new RegExp('(?:^|[_/.:-])(?:' + executionTools.join('|') + ')$|subagent|sub_agent', 'i');
const hookMatcher = '(?:^|[_/.:-])(?:codex_(run|sessions|list|wait|result|cancel)|call_mcp_tool|' + executionTools.join('|') + ')$|subagent|sub_agent';
function scopesFor(workspaces, projects) {
  return projects.filter(p => workspaces.some(w => {
    try { const root = real(w); return same(root, p.project) || inside(root, p.project) || inside(p.project, root); } catch { return false; }
  }));
}
function bindOrigin(payload, projects) {
  const name = payload?.toolCall?.name || '';
  if (/(?:^|[_/.:-])call_mcp_tool$/.test(name)) {
    const outer = payload.toolCall.args || {}, key = Object.hasOwn(outer, 'Arguments') ? 'Arguments' : 'arguments';
    const innerName = outer.ToolName || outer.toolName || outer.tool_name || '';
    const args = outer[key] || {};
    if (typeof args !== 'object' || Array.isArray(args)) return { decision: 'deny', reason: 'MCP Arguments 必须是对象，未执行。' };
    const result = bindOrigin({ ...payload, toolCall: { name: innerName, args } }, projects);
    return result.overwrite ? { ...result, overwrite: { [key]: { ...args, ...result.overwrite } } } : result;
  }
  const match = name.match(/(?:^|[_/.:-])(codex_run|codex_sessions|codex_list|codex_wait|codex_result|codex_cancel)$/);
  if (!match) {
    if (executionPattern.test(name) && scopesFor(payload.workspacePaths || [], projects).length) return { decision: 'deny', reason: '本项目由 Antigravity 规划和验收，执行必须交给 codex_run；需要子 agent 时由 Codex 会话启动自己的原生子 agent，禁止 Antigravity 原生执行或子 agent 代做。' };
    return { decision: 'allow' };
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
  if (!cwd && scopes.length !== 1) return { decision: 'deny', reason: '本项目有多个代码根；请按事项明确 cwd，不猜最近目录。' };
  cwd ||= scopes[0].project;
  const overwrite = { cwd };
  if (tool === 'codex_run') {
    try { executionSandbox(args, scopes.find(p => inside(p.project, cwd))); }
    catch (error) { return { decision: 'deny', reason: error.message }; }
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(payload.conversationId || '')) return { decision: 'deny', reason: '缺少真实发起会话 ID。' };
    overwrite.conversation_id = payload.conversationId;
  }
  return { decision: 'allow', overwrite };
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
  list(limit = 20, cwd, activeOnly = false) {
    if (cwd) return this.forCwd(cwd).list(limit, undefined, activeOnly);
    return this.brokers.flatMap(b => b.list(limit, undefined, activeOnly)).filter(j => !activeOnly || !terminal.has(j.status)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, activeOnly ? Number.MAX_SAFE_INTEGER : limit);
  }
}
module.exports = { ProjectRouter, bindOrigin, hookMatcher };
