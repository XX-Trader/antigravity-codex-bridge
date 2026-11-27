'use strict';
const { spawn } = require('node:child_process');

// A private, bounded JSONL channel. A failed request invalidates the whole
// process so a late reply can never be mistaken for a later observation.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
while ($null -ne ($line = [Console]::ReadLine())) {
  try {
    $q = $line | ConvertFrom-Json
    if ($q.op -eq 'inspect') {
      $items = @(); foreach ($processId in $q.pids) {
        $p = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
        if (!$p) { $items += @{ pid=$processId; identity=$null }; continue }
        try { $identity = $p.StartTime.ToUniversalTime().Ticks.ToString() } catch {
          if (Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue) { throw }; $items += @{ pid=$processId; identity=$null }; continue
        }
        $c = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$processId)"
        if (!$c) { throw 'Process details temporarily unavailable' }
        if ($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks.ToString() -ne $identity) { throw 'Process changed during observation' }
        $items += @{ pid=$processId; identity=$identity; executable=$c.ExecutablePath; command=$c.CommandLine; parent=$c.ParentProcessId }
      }
      $reply = @{ id=$q.id; items=$items }
    } elseif ($q.op -eq 'kill') {
      $p = Get-Process -Id ([int]$q.pid) -ErrorAction SilentlyContinue
      $requested = $false
      if ($p) {
        $startTicks = $null
        try { $startTicks = $p.StartTime.ToUniversalTime().Ticks.ToString() } catch {
          if (Get-Process -Id ([int]$q.pid) -ErrorAction SilentlyContinue) { throw }
        }
        if ($startTicks -eq $q.identity) {
          try { $p.Kill($true); $p.WaitForExit(10000) | Out-Null; $requested = $true } catch {
            if (Get-Process -Id ([int]$q.pid) -ErrorAction SilentlyContinue) { throw }
          }
        }
      }
      $reply = @{ id=$q.id; requested=$requested }
    } else { throw 'Unknown operation' }
    [Console]::WriteLine(($reply | ConvertTo-Json -Compress -Depth 5))
  } catch { [Console]::WriteLine((@{ id=$q.id; error=$_.Exception.Message } | ConvertTo-Json -Compress)) }
}`;

class ProcessQuery {
  constructor(pwsh) { this.pwsh = pwsh; this.child = null; this.pending = null; this.buffer = ''; this.serial = 0; }
  close(error = new Error('Process observation helper closed')) {
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); }
    const child = this.child; this.child = null; this.buffer = '';
    if (child) { child.stdin.destroy(); child.kill(); }
  }
  request(data) {
    if (this.pending) return Promise.reject(new Error('Concurrent process observation'));
    if (!this.child) {
      const child = spawn(this.pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        if (this.child !== child) return;
        this.buffer += chunk;
        if (this.buffer.length > 65536) return this.fail(new Error('Oversized process observation'));
        const end = this.buffer.indexOf('\n'); if (end < 0) return;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try {
          const reply = JSON.parse(line); if (!this.pending || reply.id !== this.pending.id) throw new Error('Invalid process observation response');
          const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
          if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply);
        } catch (e) { this.fail(e); }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
      child.on('error', e => { if (this.child === child) this.fail(e); });
      child.on('close', () => { if (this.child === child) this.fail(new Error('Process observation helper exited' + (stderr ? ': ' + stderr : ''))); });
      // EPIPE commonly arrives before stderr/close when PowerShell refuses to
      // start. Wait for close so the policy reason is not lost.
      child.stdin.on('error', e => { if (this.child === child && e.code !== 'EPIPE') this.fail(e); });
    }
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => this.fail(new Error('Process observation timed out')), 30000);
      this.pending = { id, resolve, reject, timer };
      this.child.stdin.write(JSON.stringify({ ...data, id }) + '\n');
    });
  }
  fail(error) { this.close(error); }
}
module.exports = { ProcessQuery };
