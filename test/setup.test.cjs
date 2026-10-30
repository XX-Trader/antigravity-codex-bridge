'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildPlan, apply, restore, target } = require('../scripts/setup.cjs');
const { config } = require('../src/server.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.CODEX_EXECUTOR_TEST_ROOT, 'setup-'));
  for (const p of ['home', 'project', 'runtime']) fs.mkdirSync(path.join(root, p));
  const options = { home: path.join(root, 'home'), project: path.join(root, 'project'), data: path.join(root, 'runtime'), codex: process.execPath, pwsh: process.execPath, agentapi: process.execPath };
  return { root, options, done: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}
test('quote-free hook survives normal argv escaping, raw CMD and shell transport; Node resolves from config', () => {
  const f = fixture();
  try {
    let pwsh = process.env.CODEX_EXECUTOR_PWSH || 'pwsh.exe';
    if (!path.isAbsolute(pwsh)) pwsh = spawnSync('where.exe', [pwsh], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0];
    pwsh = fs.realpathSync(pwsh);
    const home = f.options.home, project = path.join(f.root, 'project space & 中文'); fs.mkdirSync(project);
    const plan = buildPlan({ ...f.options, home, project, pwsh }); apply(plan);
    const hooks = JSON.parse(fs.readFileSync(path.join(home, '.gemini/config/hooks.json'), 'utf8'));
    const command = hooks['codex-executor-origin'].PreToolUse[0].hooks[0].command;
    assert.doesNotMatch(command, /["']/); assert.doesNotMatch(command, /-NodeEntry|^&|^call /);
    assert.equal(plan.entry.command, process.execPath);
    const conversationId = '11111111-1111-1111-1111-111111111111';
    const payload = { conversationId, workspacePaths: [project], toolCall: { name: 'call_mcp_tool', args: { ServerName: 'codex-executor', ToolName: 'codex_run', Arguments: { prompt: '中文 transport only' } } } };
    for (const mode of ['argv', 'raw', 'shell']) {
      const options = { input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true, timeout: 30000 };
      const r = mode === 'argv' ? spawnSync('cmd.exe', ['/c', command], { ...options, windowsVerbatimArguments: false }) : mode === 'raw' ? spawnSync('cmd.exe', ['/d', '/s', '/c', command], { ...options, windowsVerbatimArguments: true }) : spawnSync(command, { ...options, shell: 'cmd.exe' });
      assert.equal(r.status, 0, r.stderr); assert.equal(r.stderr, '');
      const reply = JSON.parse(r.stdout); assert.equal(reply.decision, 'allow');
      assert.equal(reply.overwrite.Arguments.conversation_id, conversationId); assert.equal(reply.overwrite.Arguments.prompt, payload.toolCall.args.Arguments.prompt);
      assert.equal(reply.overwrite.Arguments.cwd, fs.realpathSync(project));
    }
  } finally { f.done(); }
});

test('unsafe hook paths fail preflight without writing config', () => {
  const f = fixture(); try {
    const home = path.join(f.root, "home'unsafe"); fs.mkdirSync(home);
    assert.throws(() => buildPlan({ ...f.options, home }), /quote-free Windows hook path/);
    assert.equal(fs.existsSync(path.join(home, '.gemini/config/mcp_config.json')), false);
  } finally { f.done(); }
});

test('spaced install paths use quote-free 8.3 names or fail before writing', () => {
  const f = fixture(); try {
    const home = path.join(f.root, 'home space & 中文'); fs.mkdirSync(home);
    let plan;
    try { plan = buildPlan({ ...f.options, home }); }
    catch (error) {
      assert.match(error.message, /quote-free Windows hook path/);
      assert.equal(fs.existsSync(path.join(home, '.gemini/config/mcp_config.json')), false);
      return;
    }
    const command = plan.changes.find(c => c.parts[0] === 'codex-executor-origin').after.value.PreToolUse[0].hooks[0].command;
    assert.doesNotMatch(command, /["'&]/);
    apply(plan);
    const configPath = command.split(' -McpConfigPath ')[1];
    assert.deepEqual(fs.readFileSync(configPath), fs.readFileSync(plan.mcp));
    assert.equal(fs.statSync(configPath).ino, fs.statSync(plan.mcp).ino);
  } finally { f.done(); }
});
test('setup preview does not write configuration and arbitrary absolute storage is accepted', () => {
  const f = fixture(); try {
    const plan = buildPlan(f.options);
    assert.ok(plan.changes.length >= 5);
    assert.equal(fs.existsSync(plan.mcp), false);
    const settings = config({ ...plan.entry.env });
    assert.equal(settings.model, null); assert.equal(settings.service_tier, null);
    assert.equal(settings.data, fs.realpathSync(f.options.data));
    assert.equal(plan.entry.env.CODEX_EXECUTOR_MODEL, undefined);
  } finally { f.done(); }
});
test('installer merges only owned fields, preserves other MCP/hooks/rules and is idempotent', () => {
  const f = fixture(); try {
    const dir = path.join(f.options.home, '.gemini', 'config'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp_config.json'), JSON.stringify({ mcpServers: { unrelated: { command: 'keep-me' } } }));
    fs.writeFileSync(path.join(dir, 'hooks.json'), JSON.stringify({ unrelated: { Stop: [{ command: 'keep-me' }] } }));
    fs.mkdirSync(path.join(f.options.project, '.agents'));
    fs.writeFileSync(path.join(f.options.project, '.agents', 'rules.json'), JSON.stringify({ entries: [{ path: 'existing-rules' }] }));
    const result = apply(buildPlan(f.options)); assert.equal(result.state, 'applied');
    const installed = JSON.parse(fs.readFileSync(path.join(dir, 'mcp_config.json')));
    assert.equal(installed.mcpServers.unrelated.command, 'keep-me');
    assert.ok(installed.mcpServers['codex-executor'].args[0].endsWith(path.join('src', 'server.cjs')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'hooks.json'))).unrelated.Stop[0].command, 'keep-me');
    const rules = JSON.parse(fs.readFileSync(path.join(f.options.project, '.agents', 'rules.json')));
    assert.equal(rules.entries.length, 2); assert.equal(rules.entries[0].path, 'existing-rules');
    const before = fs.readFileSync(path.join(dir, 'mcp_config.json'));
    assert.equal(apply(buildPlan(f.options)).state, 'unchanged');
    assert.ok(before.equals(fs.readFileSync(path.join(dir, 'mcp_config.json'))));
    restore(result.journal);
    const restored = JSON.parse(fs.readFileSync(path.join(dir, 'mcp_config.json')));
    assert.equal(restored.mcpServers.unrelated.command, 'keep-me'); assert.equal(restored.mcpServers['codex-executor'], undefined);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.options.project, '.agents', 'rules.json'))).entries.length, 1);
    assert.equal(fs.existsSync(path.join(dir, 'sidecars', 'codex-executor', 'sidecar.json')), false);
  } finally { f.done(); }
});
test('installer refuses conflicting runtime roots and rollback refuses edited managed fields', () => {
  const f = fixture(); try {
    const installed = apply(buildPlan(f.options));
    const other = path.join(f.root, 'different-runtime'); fs.mkdirSync(other);
    assert.throws(() => buildPlan({ ...f.options, data: other }), /different runtime/);
    const file = path.join(f.options.home, '.gemini/config/mcp_config.json');
    const doc = JSON.parse(fs.readFileSync(file)); doc.mcpServers['codex-executor'].env.USER_EDIT = 'keep'; fs.writeFileSync(file, JSON.stringify(doc));
    assert.throws(() => restore(installed.journal), /changed after installation/);
    assert.equal(JSON.parse(fs.readFileSync(file)).mcpServers['codex-executor'].env.USER_EDIT, 'keep');
  } finally { f.done(); }
});
test('installer follows an existing config file symlink without replacing the link', t => {
  const f = fixture(); try {
    const real = path.join(f.root, 'actual.json'); fs.writeFileSync(real, '{"mcpServers":{}}');
    const link = path.join(f.root, 'linked.json');
    try { fs.symlinkSync(real, link, 'file'); } catch (error) { if (error.code === 'EPERM') { t.skip('Host does not permit creating file symlinks'); return; } throw error; }
    assert.equal(target(link), fs.realpathSync(real));
    const installed = apply(buildPlan({ ...f.options, config: link }));
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    restore(installed.journal); assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  } finally { f.done(); }
});
test('model IDs and optional account-local aliases are not hard coded', () => {
  const f = fixture(); try {
    const env = { CODEX_EXECUTOR_PROJECT: f.options.project, CODEX_EXECUTOR_DATA: f.options.data, CODEX_EXECUTOR_ENTRY: process.execPath };
    assert.equal(config(env).model, null);
    assert.equal(config({ ...env, CODEX_EXECUTOR_MODEL: 'provider/model-v1' }).model, 'provider/model-v1');
    assert.equal(config({ ...env, CODEX_EXECUTOR_MODEL: 'quick', CODEX_EXECUTOR_MODEL_ALIASES: '{"quick":"account-model"}' }).model, 'account-model');
    assert.throws(() => config({ ...env, CODEX_EXECUTOR_MODEL_ALIASES: '[]' }), /aliases/);
    assert.throws(() => config({ ...env, CODEX_EXECUTOR_SERVICE_TIER: 'unknown' }), /tier/);
  } finally { f.done(); }
});

test('existing sidecar is replaced and restored without mutating its baseline snapshot', () => {
  const f = fixture(); try {
    const dir = path.join(f.options.home, '.gemini/config/sidecars/codex-executor'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sidecar.json'), original = { command: 'old-command', args: ['old-file'] }; fs.writeFileSync(file, JSON.stringify(original));
    const result = apply(buildPlan(f.options));
    assert.notEqual(JSON.parse(fs.readFileSync(file)).command, 'old-command');
    restore(result.journal); assert.deepEqual(JSON.parse(fs.readFileSync(file)), original);
  } finally { f.done(); }
});
