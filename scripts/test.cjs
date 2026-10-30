'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required');
if (process.platform !== 'win32') throw new Error('The execution integration tests currently require native Windows and PowerShell 7');
const base = path.resolve(process.env.CODEX_EXECUTOR_TEST_ROOT || path.join(os.tmpdir(), 'antigravity-codex-tests'));
fs.mkdirSync(base, { recursive: true });
const root = fs.mkdtempSync(path.join(base, 'run-'));
const result = spawnSync(process.execPath, ['--test', 'test/server.test.cjs', 'test/setup.test.cjs'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, CODEX_EXECUTOR_TEST_ROOT: root, CODEX_EXECUTOR_PWSH: process.env.CODEX_EXECUTOR_PWSH || 'pwsh.exe' }, encoding: 'utf8', timeout: 600000 });
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
if (result.error) process.stderr.write(result.error.stack + '\n');
if (result.status === 0) {
  const resolved = fs.realpathSync(root), parent = fs.realpathSync(base);
  if (!resolved.startsWith(parent + path.sep)) throw new Error('Refusing cleanup outside test root');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
} else process.stderr.write('Failed test fixture retained for inspection: ' + root + '\n');
process.exitCode = result.status === 0 ? 0 : 1;
