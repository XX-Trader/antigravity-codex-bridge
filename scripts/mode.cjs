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
const { defaultGuardStatePath, resetAgyGuard } = require('../src/agy-guard.cjs');

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
    '  agy-quota [--weekly-used PCT] [--weekly-reset ISO] [--5h-used PCT] [--5h-reset ISO] [--clear]',
    '  agy-budget [--tokens-5h N] [--tokens-7d N] [--weekly-reset ISO] [--5h-caution PCT] [--5h-protect PCT] [--clear]',
    '  codex-pacing [--days N] [--target PCT] [--policy POLICY_JSON]',
    '  agy-review-gate --level off|advisory|strict [--project ABS_PATH] [--valid-hours N] [--max-same N] [--max-total N]',
    '  reset-agy-guard [--conversation UUID] [--policy POLICY_JSON]',
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

  if (opts.command === 'agy-quota') {
    if (opts.clear) {
      current.agy_manual_snapshot = null;
      const saved = saveRoutingPolicy(policyFile, current);
      return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_manual_snapshot: null }, null, 2);
    }
    const parsePct = (name, val) => {
      if (val === undefined) return undefined;
      const n = Number(val);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error(`--${name} must be a number in 0..100`);
      return n;
    };
    const parseIso = (name, val) => {
      if (val === undefined) return undefined;
      const ms = Date.parse(val);
      if (!Number.isFinite(ms)) throw new Error(`--${name} must be a valid ISO timestamp`);
      return new Date(ms).toISOString();
    };
    const weeklyUsed = parsePct('weekly-used', opts['weekly-used']);
    const fiveHourUsed = parsePct('5h-used', opts['5h-used']);
    const weeklyReset = parseIso('weekly-reset', opts['weekly-reset']);
    const fiveHourReset = parseIso('5h-reset', opts['5h-reset']);
    if (weeklyUsed === undefined && fiveHourUsed === undefined && weeklyReset === undefined && fiveHourReset === undefined) {
      throw new Error('Provide at least one of --weekly-used, --weekly-reset, --5h-used, --5h-reset, or --clear');
    }
    const prev = current.agy_manual_snapshot || {};
    current.agy_manual_snapshot = {
      recorded_at: new Date().toISOString(),
      weekly_used_percent: weeklyUsed ?? prev.weekly_used_percent ?? null,
      weekly_resets_at: weeklyReset ?? prev.weekly_resets_at ?? null,
      five_hour_used_percent: fiveHourUsed ?? prev.five_hour_used_percent ?? null,
      five_hour_resets_at: fiveHourReset ?? prev.five_hour_resets_at ?? null
    };
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_manual_snapshot: saved.agy_manual_snapshot }, null, 2);
  }

  if (opts.command === 'agy-budget') {
    if (opts.clear) {
      current.agy_pacing = { ...(current.agy_pacing || {}), window_5h_tokens: null, window_7d_tokens: null, weekly_resets_at: null };
      const saved = saveRoutingPolicy(policyFile, current);
      return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_pacing: saved.agy_pacing }, null, 2);
    }
    const ap = { ...(current.agy_pacing || {}) };
    if (opts['tokens-5h'] !== undefined) {
      const n = Number(opts['tokens-5h']);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--tokens-5h must be a positive number');
      ap.window_5h_tokens = Math.floor(n);
    }
    if (opts['tokens-7d'] !== undefined) {
      const n = Number(opts['tokens-7d']);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--tokens-7d must be a positive number');
      ap.window_7d_tokens = Math.floor(n);
    }
    if (opts['weekly-reset'] !== undefined) {
      const ms = Date.parse(opts['weekly-reset']);
      if (!Number.isFinite(ms)) throw new Error('--weekly-reset must be a valid ISO timestamp');
      ap.weekly_resets_at = new Date(ms).toISOString();
    }
    if (opts['5h-caution'] !== undefined) {
      const n = Number(opts['5h-caution']);
      if (!Number.isFinite(n) || n < 30 || n > 99) throw new Error('--5h-caution must be in 30..99');
      ap.window_5h_caution_percent = n;
    }
    if (opts['5h-protect'] !== undefined) {
      const n = Number(opts['5h-protect']);
      if (!Number.isFinite(n) || n < 40 || n > 100) throw new Error('--5h-protect must be in 40..100');
      ap.window_5h_protect_percent = n;
    }
    current.agy_pacing = ap;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_pacing: saved.agy_pacing }, null, 2);
  }

  if (opts.command === 'codex-pacing') {
    const p = { ...(current.pacing || {}) };
    if (opts.days !== undefined) {
      const n = Number(opts.days);
      if (!Number.isFinite(n) || n < 1 || n > 30) throw new Error('--days must be a number in 1..30');
      p.plan_days = n;
    }
    if (opts.target !== undefined) {
      const n = Number(opts.target);
      if (!Number.isFinite(n) || n < 10 || n > 100) throw new Error('--target must be a number in 10..100');
      p.target_utilization = n;
    }
    if (opts.days === undefined && opts.target === undefined) throw new Error('Specify --days N and/or --target PCT');
    current.pacing = p;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, pacing: saved.pacing }, null, 2);
  }

  if (opts.command === 'agy-review-gate') {
    const level = opts.level !== undefined ? String(opts.level).trim().toLowerCase() : undefined;
    if (level !== undefined && !['off', 'advisory', 'strict'].includes(level)) throw new Error('--level must be off, advisory, or strict');
    if (opts.project) {
      if (!level) throw new Error('--level is required when setting a project override');
      const target = fs.existsSync(opts.project) ? fs.realpathSync(opts.project) : path.resolve(opts.project);
      current.projects[target] = { ...(current.projects[target] || {}), agy_review_gate: level };
    } else {
      current.agy_guard = { ...(current.agy_guard || {}) };
      if (level !== undefined) current.agy_guard.review_gate = level;
    }
    if (opts['valid-hours'] !== undefined) {
      const n = Number(opts['valid-hours']);
      if (!Number.isFinite(n) || n < 1 || n > 168) throw new Error('--valid-hours must be in 1..168');
      current.agy_guard = { ...(current.agy_guard || {}), review_valid_hours: n };
    }
    if (opts['max-same'] !== undefined) {
      const n = Number(opts['max-same']);
      if (!Number.isFinite(n) || n < 0 || n > 20) throw new Error('--max-same must be in 0..20');
      current.agy_guard = { ...(current.agy_guard || {}), max_same_error_failures: Math.floor(n) };
    }
    if (opts['max-total'] !== undefined) {
      const n = Number(opts['max-total']);
      if (!Number.isFinite(n) || n < 0 || n > 50) throw new Error('--max-total must be in 0..50');
      current.agy_guard = { ...(current.agy_guard || {}), max_consecutive_failures: Math.floor(n) };
    }
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_guard: saved.agy_guard, projects: saved.projects }, null, 2);
  }

  if (opts.command === 'reset-agy-guard') {
    const stateFile = defaultGuardStatePath(policyFile, settings);
    const next = resetAgyGuard(stateFile, opts.conversation || null);
    return JSON.stringify({ state: 'reset', guard_state_path: stateFile, conversation: opts.conversation || 'all', remaining_conversations: Object.keys(next.conversations).length }, null, 2);
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
