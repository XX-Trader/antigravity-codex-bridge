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
  defaultQuotaCachePath,
  loadRoutingPolicy,
  saveRoutingPolicy,
  resolveProjectPolicy,
  resolveSharedQuotaSnapshot,
  detectCcSwitchAccountsMtimeMs,
  detectAgyKeyringLastWrittenMs,
  defaultAgyProbeHome,
  pruneBridgeRuntimeCache,
  evaluateAgyProbeHealth,
  runAgyInteractiveLoginAsync,
  runAgyPoolTaskAsync,
  readStaleQuotaCache,
  writeQuotaCache,
  activeCodexTasks
} = require('../src/routing-policy.cjs');
const { defaultGuardStatePath, resetAgyGuard, readGuardQuotaCooldown } = require('../src/agy-guard.cjs');

function usage() {
  return [
    'Usage: pwsh -NoProfile -File scripts/Mode.ps1 <command> [options]',
    '',
    'Commands:',
    '  status [--refresh] [--project ABS_PATH] [--config MCP_JSON]',
    '  agy-login [--timeout-ms N] [--config MCP_JSON] [--policy POLICY_JSON]',
    '  probe-home [--path ABS_ASCII_DIR | --clear] [--policy POLICY_JSON]',
    '  prune-cache [--older-than-days N] [--keep-probe-logs N] [--apply] [--config MCP_JSON] [--policy POLICY_JSON]',
    '  set --mode auto|agy|codex [--project ABS_PATH] [--config MCP_JSON] [--policy POLICY_JSON]',
    '      (aliases: agy/AGY/Agy/antigravity -> agy; auto/hybrid/balanced -> auto)',
    '  reset-project --project ABS_PATH [--config MCP_JSON] [--policy POLICY_JSON]',
    '  agy-hint --level plenty|normal|low [--config MCP_JSON] [--policy POLICY_JSON]',
    '  agy-quota [--weekly-used PCT] [--weekly-reset ISO] [--5h-used PCT] [--5h-reset ISO] [--clear]',
    '  agy-budget [--tokens-5h N] [--tokens-7d N] [--weekly-reset ISO] [--target PCT] [--weekly-protect PCT] [--5h-caution PCT] [--5h-protect PCT] [--clear]',
    '  codex-pacing [--days N] [--target PCT] [--ahead-max N] [--high-max N] [--protect-max N] [--policy POLICY_JSON]',
    '  agy-review-gate --level off|advisory|strict [--project ABS_PATH] [--valid-hours N] [--max-same N] [--max-total N]',
    '  reset-agy-guard [--conversation UUID] [--policy POLICY_JSON]',
    '  quant-thinking [--model NAME] [--general NAME] [--backups A,B] [--clear] [--config MCP_JSON] [--policy POLICY_JSON]',
    '  agy-models [--standard NAME] [--complex NAME] [--expert NAME] [--clear] [--policy POLICY_JSON]',
    '  pool --name POOL [--match TEXT] [--review-model MODEL] [--default-model MODEL] [--weekly-protect PCT] [--unlock-hours N] [--5h-caution PCT] [--5h-protect PCT] [--tokens-5h N] [--tokens-7d N] [--weekly-used PCT] [--weekly-reset ISO] [--5h-used PCT] [--5h-reset ISO] [--clear-snapshot] [--remove]',
    '  pool-run --pool POOL [--model MODEL] [--exec-mode plan|auto|accept-edits] [--cwd ABS_PATH] [--conversation UUID] [--prompt TEXT | --prompt-file UTF8_FILE] [--force]',
    '  tier [--simple MODEL] [--standard MODEL] [--complex MODEL] [--expert MODEL] [--enforce-low-cost true|false]',
    '  cooldown --engine codex|agy --minutes N [--reason TEXT]',
    '  clear-cooldown --engine codex|agy',
    '  global-guard --enabled true|false [--policy POLICY_JSON]'
  ].join('\n');
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  const opts = { command };
  const flags = new Set(['--refresh', '--clear', '--clear-snapshot', '--remove', '--force', '--apply', '--help', '-h']);
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

  if (opts.command === 'agy-login') {
    const policyDoc = loadRoutingPolicy(policyFile);
    const loginRes = await runAgyInteractiveLoginAsync({
      policy: policyDoc,
      agyBin: opts['agy-bin'],
      timeoutMs: opts['timeout-ms'] ? Number(opts['timeout-ms']) : 180000
    });
    if (!loginRes.ok) {
      process.exitCode = 1;
      return JSON.stringify(loginRes, null, 2);
    }
    const scope = settings?.projects?.[0] || settings || null;
    const cachePath = defaultQuotaCachePath(policyFile, scope);
    if (cachePath) {
      const nowMs = Date.now();
      const prev = readStaleQuotaCache(cachePath, nowMs, 86400);
      const ccSwitchMtimeMs = detectCcSwitchAccountsMtimeMs();
      const keyringLastWrittenMs = detectAgyKeyringLastWrittenMs({ probeHomeDir: policyDoc.agy_probe_home || undefined });
      const agyHealth = evaluateAgyProbeHealth({
        probed: loginRes.agy_external,
        prevHealth: prev?.agy_health || null,
        prevExternal: prev?.agy_external || null,
        ccSwitchMtimeMs,
        keyringLastWrittenMs,
        nowMs,
        modeScriptPath: path.resolve(__dirname, 'Mode.ps1')
      });
      writeQuotaCache(cachePath, {
        ...(prev || {}),
        agy_external: loginRes.agy_external,
        agy_health: agyHealth,
        agy_probed_at: new Date(nowMs).toISOString(),
        fetched_at: new Date(nowMs).toISOString()
      });
    }
    return JSON.stringify({
      state: 'authenticated',
      account_email: loginRes.account_email,
      agy_external: loginRes.agy_external
    }, null, 2);
  }

  if (opts.command === 'probe-home') {
    const current = loadRoutingPolicy(policyFile);
    if (opts.clear) {
      current.agy_probe_home = null;
      const saved = saveRoutingPolicy(policyFile, current);
      return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_probe_home: saved.agy_probe_home, effective_probe_home: defaultAgyProbeHome({ policy: saved }) }, null, 2);
    }
    if (!opts.path) {
      return JSON.stringify({ policy_path: policyFile, agy_probe_home: current.agy_probe_home, effective_probe_home: defaultAgyProbeHome({ policy: current }) }, null, 2);
    }
    const resolved = path.resolve(String(opts.path).trim());
    if (!path.isAbsolute(resolved) || !/^[\x20-\x7e]+$/.test(resolved)) {
      throw new Error('--path must be an absolute pure-ASCII directory path (required by agy CLI)');
    }
    current.agy_probe_home = resolved;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_probe_home: saved.agy_probe_home, effective_probe_home: defaultAgyProbeHome({ policy: saved }) }, null, 2);
  }

  if (opts.command === 'prune-cache') {
    const current = loadRoutingPolicy(policyFile);
    const dataRoots = [];
    if (opts['data-root']) {
      dataRoots.push(path.resolve(opts['data-root']));
    } else if (settings) {
      for (const p of (settings.projects || [settings])) {
        if (p?.data) dataRoots.push(p.data);
      }
    }
    const olderThanDays = opts['older-than-days'] !== undefined ? Number(opts['older-than-days']) : 7;
    if (!Number.isFinite(olderThanDays) || olderThanDays < 0 || olderThanDays > 3650) {
      throw new Error('--older-than-days must be a number in 0..3650');
    }
    const keepProbeLogs = opts['keep-probe-logs'] !== undefined ? Math.floor(Number(opts['keep-probe-logs'])) : 10;
    if (!Number.isFinite(keepProbeLogs) || keepProbeLogs < 1 || keepProbeLogs > 500) {
      throw new Error('--keep-probe-logs must be an integer in 1..500');
    }
    const report = pruneBridgeRuntimeCache({
      dataRoots,
      policy: current,
      probeHomeDir: opts['probe-home'] ? path.resolve(opts['probe-home']) : undefined,
      olderThanDays,
      keepProbeLogs,
      apply: opts.apply === true
    });
    return JSON.stringify(report, null, 2);
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
    if (opts.target !== undefined) {
      const n = Number(opts.target);
      if (!Number.isFinite(n) || n < 10 || n > 100) throw new Error('--target must be in 10..100');
      ap.target_utilization = n;
    }
    if (opts['weekly-protect'] !== undefined) {
      const n = Number(opts['weekly-protect']);
      if (!Number.isFinite(n) || n < 60 || n > 100) throw new Error('--weekly-protect must be in 60..100');
      ap.weekly_protect_used_percent = n;
    }
    if (opts['unlock-hours'] !== undefined) {
      const n = Number(opts['unlock-hours']);
      if (!Number.isFinite(n) || n < 0 || n > 72) throw new Error('--unlock-hours must be in 0..72');
      ap.buffer_unlock_window_hours = n;
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
    for (const [flag, key] of [['ahead-max', 'ahead_max_concurrent'], ['high-max', 'high_max_concurrent'], ['protect-max', 'protect_max_concurrent']]) {
      if (opts[flag] !== undefined) {
        if (String(opts[flag]).toLowerCase() === 'none') { p[key] = null; continue; }
        const n = Number(opts[flag]);
        if (!Number.isFinite(n) || n < 1 || n > 50) throw new Error(`--${flag} must be 1..50 or none`);
        p[key] = Math.floor(n);
      }
    }
    if (opts.days === undefined && opts.target === undefined && opts['ahead-max'] === undefined && opts['high-max'] === undefined && opts['protect-max'] === undefined) {
      throw new Error('Specify --days, --target, --ahead-max, --high-max, or --protect-max');
    }
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
    if (!opts.clear && !opts.model && opts.general === undefined && opts.backups === undefined) {
      throw new Error('Specify --model NAME, --general NAME, --backups A,B, or --clear');
    }
    const next = { ...(current.thinking_models || { general: null, quant: null, backups: [] }) };
    if (opts.clear) {
      next.quant = null;
      next.general = null;
      next.backups = [];
    } else {
      if (opts.model !== undefined) next.quant = String(opts.model).trim() || null;
      if (opts.general !== undefined) next.general = String(opts.general).trim() || null;
      if (opts.backups !== undefined) {
        next.backups = String(opts.backups).split(',').map(s => s.trim()).filter(Boolean);
      }
    }
    current.thinking_models = next;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, thinking_models: saved.thinking_models }, null, 2);
  }

  if (opts.command === 'pool') {
    const name = String(opts.name || '').trim().toLowerCase();
    if (!name) throw new Error('--name is required');
    current.agy_model_pools = { ...(current.agy_model_pools || {}) };
    if (opts.remove) {
      delete current.agy_model_pools[name];
      const saved = saveRoutingPolicy(policyFile, current);
      return JSON.stringify({ state: 'updated', policy_path: saved.path, removed: name, agy_model_pools: saved.agy_model_pools }, null, 2);
    }
    const prev = current.agy_model_pools[name] || { match: name, weekly_protect_used_percent: 90, window_5h_caution_percent: 75, window_5h_protect_percent: 88, manual_snapshot: null, cooldown: null };
    const next = { ...prev };
    if (opts.match !== undefined) next.match = String(opts.match).trim().toLowerCase() || name;
    const parseRange = (k, min, max) => {
      const n = Number(opts[k]);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${k} must be in ${min}..${max}`);
      return n;
    };
    if (opts['weekly-protect'] !== undefined) next.weekly_protect_used_percent = parseRange('weekly-protect', 50, 100);
    if (opts['unlock-hours'] !== undefined) next.buffer_unlock_window_hours = parseRange('unlock-hours', 0, 72);
    if (opts['5h-caution'] !== undefined) next.window_5h_caution_percent = parseRange('5h-caution', 30, 99);
    if (opts['5h-protect'] !== undefined) next.window_5h_protect_percent = parseRange('5h-protect', 40, 100);
    if (opts['tokens-5h'] !== undefined) {
      const n = Number(opts['tokens-5h']);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--tokens-5h must be positive');
      next.window_5h_tokens = Math.floor(n);
    }
    if (opts['tokens-7d'] !== undefined) {
      const n = Number(opts['tokens-7d']);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--tokens-7d must be positive');
      next.window_7d_tokens = Math.floor(n);
    }
    if (opts['bucket-5h'] !== undefined) next.bucket_5h = String(opts['bucket-5h']).trim() || null;
    if (opts['bucket-7d'] !== undefined) next.bucket_7d = String(opts['bucket-7d']).trim() || null;
    if (opts['default-model'] !== undefined) next.default_model = String(opts['default-model']).trim() || null;
    if (opts['review-model'] !== undefined) next.review_model = String(opts['review-model']).trim() || null;
    if (opts['clear-snapshot']) {
      next.manual_snapshot = null;
    } else if (opts['weekly-used'] !== undefined || opts['5h-used'] !== undefined || opts['weekly-reset'] !== undefined || opts['5h-reset'] !== undefined) {
      const snap = next.manual_snapshot || {};
      const parseIso = k => {
        if (opts[k] === undefined) return undefined;
        const ms = Date.parse(opts[k]);
        if (!Number.isFinite(ms)) throw new Error(`--${k} must be a valid ISO timestamp`);
        return new Date(ms).toISOString();
      };
      next.manual_snapshot = {
        recorded_at: new Date().toISOString(),
        weekly_used_percent: opts['weekly-used'] !== undefined ? parseRange('weekly-used', 0, 100) : (snap.weekly_used_percent ?? null),
        weekly_resets_at: parseIso('weekly-reset') ?? snap.weekly_resets_at ?? null,
        five_hour_used_percent: opts['5h-used'] !== undefined ? parseRange('5h-used', 0, 100) : (snap.five_hour_used_percent ?? null),
        five_hour_resets_at: parseIso('5h-reset') ?? snap.five_hour_resets_at ?? null
      };
    }
    current.agy_model_pools[name] = next;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, pool: saved.agy_model_pools[name] }, null, 2);
  }

  if (opts.command === 'pool-run') {
    const poolName = String(opts.pool || '').trim().toLowerCase();
    if (!poolName) throw new Error('--pool is required for pool-run');
    const cwd = opts.cwd ? path.resolve(opts.cwd) : (settings?.project || process.cwd());
    const promptText = opts['prompt-file']
      ? fs.readFileSync(path.resolve(opts['prompt-file']), 'utf8')
      : (opts.prompt || '');
    const scope = (settings?.projects || (settings ? [settings] : [])).find(p => p?.project && cwd.toLowerCase().startsWith(String(p.project).toLowerCase()))
      || settings?.projects?.[0]
      || settings
      || { project: cwd };
    const guardCooldown = readGuardQuotaCooldown(defaultGuardStatePath(policyFile, scope));
    const projectPolicy = { ...resolveProjectPolicy(current, scope), ...(guardCooldown ? { guard_quota_cooldown: guardCooldown } : {}) };
    const snap = resolveSharedQuotaSnapshot(scope, projectPolicy, { policyPath: policyFile });
    const res = await runAgyPoolTaskAsync({
      poolName,
      model: opts.model,
      execMode: opts['exec-mode'] || 'plan',
      cwd,
      prompt: promptText,
      conversationId: opts.conversation,
      force: opts.force === true,
      timeoutMs: opts['timeout-ms'] ? Number(opts['timeout-ms']) : 600000,
      projectPolicy,
      codexPacing: snap.codexPacing,
      agyUsage: snap.agyUsage,
      agyExternal: snap.agyExternal,
      agyBin: opts['agy-bin']
    });
    if (!res.ok) {
      process.exitCode = res.blocked ? 2 : 1;
    }
    return JSON.stringify(res, null, 2);
  }

  if (opts.command === 'agy-models') {
    if (opts.clear) {
      current.agy_host_models = { standard: null, complex: null, expert: null };
      const saved = saveRoutingPolicy(policyFile, current);
      return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_host_models: saved.agy_host_models }, null, 2);
    }
    const nextModels = { ...(current.agy_host_models || { standard: null, complex: null, expert: null }) };
    let changed = false;
    for (const key of ['standard', 'complex', 'expert']) {
      if (opts[key] !== undefined) {
        nextModels[key] = String(opts[key]).trim() || null;
        changed = true;
      }
    }
    if (!changed) throw new Error('Specify at least one of --standard, --complex, --expert, or --clear');
    current.agy_host_models = nextModels;
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({ state: 'updated', policy_path: saved.path, agy_host_models: saved.agy_host_models }, null, 2);
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

  if (opts.command === 'global-guard') {
    if (opts.enabled === undefined) {
      return JSON.stringify({
        state: 'current',
        policy_path: policyFile,
        apply_to_unregistered_projects: Boolean(current.apply_to_unregistered_projects)
      }, null, 2);
    }
    const rawVal = String(opts.enabled).trim().toLowerCase();
    if (!['true', 'false', '1', '0', 'on', 'off'].includes(rawVal)) {
      throw new Error('--enabled must be true or false');
    }
    current.apply_to_unregistered_projects = ['true', '1', 'on'].includes(rawVal);
    const saved = saveRoutingPolicy(policyFile, current);
    return JSON.stringify({
      state: 'updated',
      policy_path: saved.path,
      apply_to_unregistered_projects: saved.apply_to_unregistered_projects
    }, null, 2);
  }

  throw new Error('Unknown command: ' + opts.command);
}

module.exports = { run, parseArgs };
if (require.main === module) {
  run(process.argv.slice(2)).then(out => console.log(out)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
