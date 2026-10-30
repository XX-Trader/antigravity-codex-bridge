'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { config, save, inside } = require('../src/server.cjs');
const { hookMatcher } = require('../src/router.cjs');
const root = path.resolve(__dirname, '..');
const key = 'codex-executor';
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
function barePath(value) {
  const text = String(value), safe = /^[^\s"'&|<>^%!()]+$/u;
  if (safe.test(text)) return text;
  // Quotes in the final command are re-escaped by the native Windows host.
  // Resolve an existing ancestor to its 8.3 name; never silently pick another exe.
  if (/["'%!^|<>\r\n]/.test(text)) throw new Error('Cannot create quote-free Windows hook path: ' + text);
  let existing = text; const suffix = [];
  while (!fs.existsSync(existing)) { suffix.unshift(path.basename(existing)); const parent = path.dirname(existing); if (parent === existing) break; existing = parent; }
  const r = spawnSync('cmd.exe', ['/d', '/u', '/s', '/c', 'for %I in ("' + existing + '") do @echo %~sI'], { encoding: 'utf16le', windowsHide: true, windowsVerbatimArguments: true });
  const short = path.join((r.stdout || '').trim(), ...suffix);
  if (r.status !== 0 || !safe.test(short) || !fs.existsSync(existing)) throw new Error('Cannot create quote-free Windows hook path; use a path without spaces/metacharacters or enable 8.3 names: ' + text);
  return short;
}
function target(file) {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  let parent = path.dirname(absolute), suffix = path.basename(absolute);
  while (!fs.existsSync(parent)) { suffix = path.join(path.basename(parent), suffix); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), suffix);
}
function getAt(doc, parts) {
  let value = doc;
  for (const part of parts) { if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return { present: false }; value = value[part]; }
  return { present: true, value };
}
function stateAt(file, parts) { return !parts.length && !fs.existsSync(file) ? { present: false } : getAt(readJson(file), parts); }
function setAt(doc, parts, snapshot) {
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (!Object.hasOwn(node, part)) node[part] = {};
    if (!node[part] || Array.isArray(node[part]) || typeof node[part] !== 'object') throw new Error('Configuration field is not an object: ' + part);
    node = node[part];
  }
  if (snapshot.present) node[parts.at(-1)] = snapshot.value;
  else delete node[parts.at(-1)];
}
function executable(value, fallback) {
  if (value) { if (!path.isAbsolute(value) || !fs.existsSync(value)) throw new Error('Executable path must exist and be absolute: ' + value); return fs.realpathSync(value); }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) for (const name of fallback) {
    const file = path.join(dir, name); if (fs.existsSync(file) && fs.statSync(file).isFile()) return fs.realpathSync(file);
  }
  throw new Error('Executable not found; supply an explicit path for ' + fallback[0]);
}
function buildPlan(options) {
  if (!options.project || !path.isAbsolute(options.project) || !fs.existsSync(options.project)) throw new Error('project must be an existing absolute directory');
  if (!options.data || !path.isAbsolute(options.data)) throw new Error('data must be an external absolute runtime directory');
  const project = fs.realpathSync(options.project), data = target(options.data);
  const home = options.home || os.homedir();
  const configDir = path.join(home, '.gemini', 'config');
  const mcp = target(options.config || path.join(configDir, 'mcp_config.json'));
  const documents = new Map();
  const document = file => { if (!documents.has(file)) documents.set(file, readJson(file)); return documents.get(file); };
  const previous = document(mcp).mcpServers?.[key] || {};
  const env = { ...(previous.env || {}) };
  const codex = executable(options.codex || env.CODEX_EXECUTOR_ENTRY, ['codex.exe', 'codex.ps1', 'codex.cmd']);
  const pwsh = executable(options.pwsh || env.CODEX_EXECUTOR_PWSH, ['pwsh.exe']);
  const projects = env.CODEX_EXECUTOR_PROJECTS ? JSON.parse(env.CODEX_EXECUTOR_PROJECTS) : env.CODEX_EXECUTOR_PROJECT && env.CODEX_EXECUTOR_DATA ? [{ project: env.CODEX_EXECUTOR_PROJECT, data: env.CODEX_EXECUTOR_DATA }] : [];
  const same = p => process.platform === 'win32' ? p.toLowerCase() : p;
  const found = projects.find(p => same(fs.realpathSync(p.project)) === same(project));
  if (found && same(fs.realpathSync(found.data)) !== same(data)) throw new Error('Project already has a different runtime directory; migrate the complete unit before changing it');
  if (!found) projects.push({ project, data });
  Object.assign(env, { CODEX_EXECUTOR_PROJECT: env.CODEX_EXECUTOR_PROJECT || project, CODEX_EXECUTOR_DATA: env.CODEX_EXECUTOR_DATA || data, CODEX_EXECUTOR_PROJECTS: JSON.stringify(projects), CODEX_EXECUTOR_ENTRY: codex, CODEX_EXECUTOR_PWSH: pwsh, CODEX_EXECUTOR_REASONING_EFFORT: env.CODEX_EXECUTOR_REASONING_EFFORT || 'medium', CODEX_EXECUTOR_BUILD: digest(['server.cjs', 'router.cjs', 'notifier.cjs', 'invoke-codex.ps1'].map(n => fs.readFileSync(path.join(root, 'src', n), 'utf8'))) });
  if (options.model) env.CODEX_EXECUTOR_MODEL = options.model;
  if (options.aliases) env.CODEX_EXECUTOR_MODEL_ALIASES = options.aliases;
  if (options.tier) env.CODEX_EXECUTOR_SERVICE_TIER = options.tier;
  const entry = { ...previous, command: process.execPath, args: [path.join(root, 'src', 'server.cjs')], env, timeoutSeconds: 14460, disabled: false, enabledTools: ['codex_run', 'codex_wait', 'codex_sessions', 'codex_result', 'codex_cancel', 'codex_list'] };
  const changes = [];
  const change = (file, parts, value) => {
    const doc = document(file), before = !parts.length && !fs.existsSync(file) ? { present: false } : getAt(doc, parts), after = { present: true, value };
    if (digest(before) !== digest(after)) { changes.push({ file, parts, before: structuredClone(before), after }); if (!parts.length) documents.set(file, value); else setAt(doc, parts, after); }
  };
  change(mcp, ['mcpServers', key], entry);
  const hooksFile = target(path.join(configDir, 'hooks.json'));
  // No quotes anywhere: the Go host escapes embedded quotes incompatibly with CMD.
  // Node's (possibly spaced) executable is read inside PowerShell from MCP config.
  const command = barePath(pwsh) + ' -NoProfile -NonInteractive -File ' + barePath(path.join(root, 'src', 'invoke-codex.ps1')) + ' -OriginHook -McpConfigPath ' + barePath(mcp);
  change(hooksFile, ['codex-executor-origin'], { PreToolUse: [{ matcher: hookMatcher, hooks: [{ type: 'command', command, timeout: 10 }] }] });
  const sidecarFile = target(path.join(configDir, 'sidecars', key, 'sidecar.json'));
  const oldSidecar = document(sidecarFile);
  const agentapi = options.agentapi || oldSidecar.env?.CODEX_EXECUTOR_AGENTAPI;
  if (agentapi) {
    const native = executable(agentapi, []);
    change(sidecarFile, [], { command: pwsh, args: ['-NoProfile', '-NonInteractive', '-File', path.join(root, 'src', 'invoke-codex.ps1'), '-Notify', '-NodeEntry', process.execPath], restart_policy: 'on-failure', description: 'Durable Codex progress and result events; host ownership, delivery recovery and no model polling', display_name: 'Codex task progress', env: { ...Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('CODEX_EXECUTOR_'))), CODEX_EXECUTOR_AGENTAPI: native } });
    const globalFile = target(path.join(configDir, 'config.json'));
    const old = document(globalFile).sidecars?.[key] || {};
    change(globalFile, ['sidecars', key], { ...old, enabled: true });
  }
  if (same(project) !== same(root)) {
    const rulesFile = target(path.join(project, '.agents', 'rules.json'));
    const doc = document(rulesFile), rulesDir = path.join(root, '.agents', 'rules');
    if (doc.entries !== undefined && !Array.isArray(doc.entries)) throw new Error('rules.json entries must be an array');
    const entries = [...(doc.entries || [])];
    if (!entries.some(e => e.path && same(path.resolve(e.path)) === same(rulesDir))) entries.push({ path: rulesDir.replace(/\\/g, '/'), include_only: ['antigravity-codex.md'] });
    change(rulesFile, ['entries'], entries);
  }
  return { project, data, mcp, entry, documents, changes, sidecar: !!agentapi };
}
function writeDocument(file, doc) { fs.mkdirSync(path.dirname(file), { recursive: true }); save(file, doc); }
function restore(journalFile) {
  const journal = readJson(journalFile);
  if (journal.schema !== 1 || !Array.isArray(journal.entries)) throw new Error('Invalid installer journal');
  for (const e of journal.entries) if (digest(stateAt(e.file, e.parts)) !== e.afterHash) throw new Error('Managed configuration changed after installation; not overwriting: ' + e.file);
  for (const e of journal.entries.slice().reverse()) {
    const doc = readJson(e.file);
    if (!e.parts.length) { if (e.before.present) writeDocument(e.file, e.before.value); else fs.unlinkSync(e.file); continue; }
    setAt(doc, e.parts, e.before); writeDocument(e.file, doc);
  }
  save(journalFile, { ...journal, state: 'restored' });
  return { restored: journal.entries.length, journal: journalFile };
}
function apply(plan) {
  fs.mkdirSync(plan.data, { recursive: true });
  config({ ...plan.entry.env });
  if (!plan.changes.length) return { state: 'unchanged', changes: 0, project: plan.project, data: plan.data };
  const journalFile = path.join(plan.data, 'install-state.json');
  const prior = fs.existsSync(journalFile) ? readJson(journalFile) : null;
  if (prior?.state === 'applied') for (const e of prior.entries) if (digest(stateAt(e.file, e.parts)) !== e.afterHash) throw new Error('Managed field changed outside installer; inspect before reinstalling: ' + e.file);
  const entries = prior?.state === 'applied' ? prior.entries.slice() : [];
  for (const c of plan.changes) {
    const old = entries.find(e => e.file === c.file && JSON.stringify(e.parts) === JSON.stringify(c.parts));
    if (old) old.afterHash = digest(c.after);
    else entries.push({ file: c.file, parts: c.parts, before: c.before, afterHash: digest(c.after) });
  }
  save(journalFile, { schema: 1, state: 'applying', entries });
  const completed = [];
  try {
    for (const c of plan.changes) {
      if (digest(stateAt(c.file, c.parts)) !== digest(c.before)) throw new Error('Configuration changed during installation: ' + c.file);
      const doc = readJson(c.file);
      if (!c.parts.length) writeDocument(c.file, c.after.value);
      else { setAt(doc, c.parts, c.after); writeDocument(c.file, doc); }
      completed.push(c);
    }
    save(journalFile, { schema: 1, state: 'applied', entries });
  } catch (error) {
    for (const c of completed.reverse()) {
      const doc = readJson(c.file);
      if (!c.parts.length) { if (c.before.present) writeDocument(c.file, c.before.value); else fs.unlinkSync(c.file); }
      else { setAt(doc, c.parts, c.before); writeDocument(c.file, doc); }
    }
    save(journalFile, { schema: 1, state: 'failed', entries, error: error.message }); throw error;
  }
  return { state: 'applied', project: plan.project, data: plan.data, changes: plan.changes.length, sidecar: plan.sidecar, journal: journalFile, next: 'Refresh codex-executor in Antigravity and reload workspace rules. Running Codex jobs are not restarted.' };
}
function parse(argv) {
  const result = {};
  const keys = { '--project': 'project', '--data': 'data', '--codex': 'codex', '--pwsh': 'pwsh', '--config': 'config', '--agentapi': 'agentapi', '--model': 'model', '--model-aliases': 'aliases', '--service-tier': 'tier', '--home': 'home', '--restore': 'restore' };
  for (let i = 0; i < argv.length; i++) {
    if (['--apply', '--trust-full-access', '--help'].includes(argv[i])) { result[argv[i].slice(2)] = true; continue; }
    if (!keys[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Unknown option or missing value: ' + argv[i]);
    result[keys[argv[i]]] = argv[++i];
  }
  return result;
}
module.exports = { buildPlan, apply, restore, getAt, digest, target, parse };
if (require.main === module) {
  try {
    const options = parse(process.argv.slice(2));
    if (options.help) console.log('pwsh -NoProfile -File scripts/Setup.ps1 --project ABS_PROJECT --data ABS_RUNTIME --codex ABS_CODEX [--pwsh ABS_PWSH] [--agentapi ABS_LANGUAGE_SERVER] [--model MODEL] [--model-aliases JSON] [--service-tier fast] [--apply --trust-full-access]\nRestore: pwsh -NoProfile -File scripts/Setup.ps1 --restore INSTALL_STATE_JSON');
    else if (options.restore) console.log(JSON.stringify(restore(path.resolve(options.restore)), null, 2));
    else {
      const plan = buildPlan(options);
      if (!options.apply) console.log(JSON.stringify({ state: 'preview', project: plan.project, data: plan.data, files: [...new Set(plan.changes.map(c => c.file))], sidecar: plan.sidecar, next: 'Review paths, then rerun with --apply --trust-full-access. No configuration was written.' }, null, 2));
      else {
        if (!options['trust-full-access']) throw new Error('This bridge defaults to full filesystem/network access with no approval prompts; pass --trust-full-access only for trusted local projects');
        if (process.platform !== 'win32') throw new Error('Automatic installation is currently tested on native Windows only');
        console.log(JSON.stringify(apply(plan), null, 2));
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
