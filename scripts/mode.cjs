'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { config, Broker } = require('../src/server.cjs');
const { ProjectRouter } = require('../src/router.cjs');
const {
  normalizeMode,
  normalizeSubagentModel,
  defaultPolicyPath,
  loadRoutingPolicy,
  saveRoutingPolicy,
  resolveProjectPolicy,
  activeCodexTasks
} = require('../src/routing-policy.cjs');

function usage() {
  return [
    'Usage: pwsh -NoProfile -File scripts/Mode.ps1 <command> [options]',
    '',
    'Commands:',
    '  status [--refresh] [--project ABS_PATH] [--config MCP_JSON]',
    '  set --mode auto|agy|codex [--project ABS_PATH] [--config MCP_JSON] [--policy POLICY_JSON]',
    '      (aliases: agy/AGY/Agy/antigravity -> agy; auto/hybrid/balanced -> auto)',
    '  reset-project --project ABS_PATH [--config MCP_JSON] [--policy POLICY_JSON]',
    '  agy-hint --level plenty|normal|low [--config MCP_JSON] [--policy POLICY_JSON]',
    '  quant-thinking (--model NAME | --clear) [--config MCP_JSON] [--policy POLICY_JSON]',
    '  tier [--simple MODEL] [--standard MODEL] [--complex MODEL] [--expert MODEL] [--enforce-low-cost true|false]',
    '  cooldown --engine codex|agy --minutes N [--reason TEXT]',
    '  clear-cooldown --engine codex|agy'
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  const opts = { command };
  const flags = new Set(['--refresh', '--clear', '--help', '-h']);
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (flags.has(token)) { opts[token.replace(/^-+/, '')] = true; continue; }
    if (!token.startsWith('--') || i + 1 >= rest.length) throw new Error('Invalid option or missing value: ' + token);
    opts[token.slice(2)] = rest[++i];
  }
  return opts;
}

function loadSettings(opts) {
  const mcpPath = path.resolve(opts.config || path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json'));
  if (!fs.existsSync(mcpPath)) return { settings: null, mcpPath };
  const doc = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
  const entry = doc.mcpServers?.['codex-executor'];
  if (!entry?.env) return { settings: null, mcpPath };
  return { settings: config({ ...process.env, ...entry.env }), mcpPath };
}

function resolvePolicyFile(opts, settings) {
  if (opts.policy) return path.resolve(opts.policy);
  const found = defaultPolicyPath(settings);
  if (!found) throw new Error('Cannot resolve routing policy path; pass --policy ABS_PATH or --config MCP_JSON');
  return found;
}

async function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help || opts.h || opts.command === 'help') return usage();
  const { settings } = loadSettings(opts);
  const policyFile = resolvePolicyFile(opts, settings);

  if (opts.command === 'status') {
    if (!settings) {
      const policy = loadRoutingPolicy(policyFile);
      return JSON.stringify({ policy_path: policyFile, policy }, null, 2);
    }
    const runtime = settings.projects ? new ProjectRouter(settings) : new Broker(settings);
    const report = await runtime.quota({
      ...(opts.project ? { cwd: path.resolve(opts.project) } : {}),
      refresh: opts.refresh === true
    });
    const policy = loadRoutingPolicy(policyFile);
    const projects = (settings.projects || [settings]).map(p => {
      const eff = resolveProjectPolicy(policy, p);
      return {
        project: p.project,
        mode: eff.mode,
        mode_source: eff.mode_source,
        review_category: eff.review_category,
        thinking_model: eff.thinking_model,
        active_codex_tasks: activeCodexTasks(p).count
      };
    });
    return JSON.stringify({ ...report, projects }, null, 2);
  }

  const current = loadRoutingPolicy(policyFile);
  if (opts.command === 'set') {
    if (!opts.mode) throw new Error('--mode is required (auto, agy, or codex)');
    const mode = normalizeMode(opts.mode);
    if (opts.project) {
      const target = fs.existsSync(opts.project) ? fs.realpathSync(opts.project) : path.resolve(opts.project);
      current.projects[target] = { ...(current.projects[target] || {}), mode };
    } else {
      current.default_mode = mode;
    }
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, default_mode: saved.default_mode, projects: saved.projects, updated_at: saved.updated_at }, null, 2);
  }

  if (opts.command === 'reset-project') {
    if (!opts.project) throw new Error('--project is required');
    const target = fs.existsSync(opts.project) ? fs.realpathSync(opts.project) : path.resolve(opts.project);
    const key = Object.keys(current.projects).find(k => (process.platform === 'win32' ? k.toLowerCase() === target.toLowerCase() : k === target));
    if (key) delete current.projects[key];
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, removed: key || null, default_mode: saved.default_mode, projects: saved.projects }, null, 2);
  }

  if (opts.command === 'agy-hint') {
    const level = String(opts.level || '').trim().toLowerCase();
    if (!['plenty', 'normal', 'low'].includes(level)) throw new Error('--level must be plenty, normal, or low');
    current.agy_quota_hint = level;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_quota_hint: saved.agy_quota_hint }, null, 2);
  }

  if (opts.command === 'quant-thinking') {
    if (!opts.clear && !opts.model) throw new Error('Specify --model NAME or --clear');
    current.thinking_models = { ...(current.thinking_models || {}), quant: opts.clear ? null : String(opts.model).trim() };
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, thinking_models: saved.thinking_models }, null, 2);
  }

  if (opts.command === 'tier') {
    const nextTiers = { ...current.agy_tiers };
    for (const key of ['simple', 'standard', 'complex', 'expert']) {
      if (opts[key] !== undefined) nextTiers[key] = normalizeSubagentModel(opts[key]);
    }
    current.agy_tiers = nextTiers;
    if (opts.standard !== undefined) current.subagent_default_model = nextTiers.standard;
    if (opts.simple !== undefined) current.subagent_research_model = nextTiers.simple;
    if (opts['enforce-low-cost'] !== undefined) {
      if (!['true', 'false'].includes(String(opts['enforce-low-cost']).toLowerCase())) throw new Error('--enforce-low-cost must be true or false');
      current.enforce_subagent_low_cost = String(opts['enforce-low-cost']).toLowerCase() === 'true';
    }
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_tiers: saved.agy_tiers, subagent_default_model: saved.subagent_default_model, subagent_research_model: saved.subagent_research_model, enforce_subagent_low_cost: saved.enforce_subagent_low_cost }, null, 2);
  }

  if (opts.command === 'cooldown') {
    const engine = String(opts.engine || '').trim().toLowerCase();
    const mapped = engine === 'antigravity' ? 'agy' : engine;
    if (!['codex', 'agy'].includes(mapped)) throw new Error('--engine must be codex or agy');
    const minutes = Number(opts.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080) throw new Error('--minutes must be in 1..10080');
    current.cooldowns = { ...(current.cooldowns || {}), [mapped]: { until: new Date(Date.now() + minutes * 60000).toISOString(), reason: opts.reason || 'manual cooldown' } };
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, cooldowns: saved.cooldowns }, null, 2);
  }

  if (opts.command === 'clear-cooldown') {
    const engine = String(opts.engine || '').trim().toLowerCase();
    const mapped = engine === 'antigravity' ? 'agy' : engine;
    if (!['codex', 'agy'].includes(mapped)) throw new Error('--engine must be codex or agy');
    current.cooldowns = { ...(current.cooldowns || {}), [mapped]: null };
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, cooldowns: saved.cooldowns }, null, 2);
  }

  throw new Error('Unknown command: ' + opts.command);
}

module.exports = { run, parseArgs };
if (require.main === module) {
  run(process.argv.slice(2)).then(out => console.log(out)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
