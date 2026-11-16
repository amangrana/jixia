import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'results', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const versions = {};
const command = provider => provider === 'claude' ? 'claude' : 'codex';
for (const provider of ['claude', 'codex']) versions[provider] = spawnSync(command(provider), ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout?.trim();
const ps = process.env.PSHOME ? join(process.env.PSHOME, 'pwsh.exe') : 'powershell.exe';
function processInfo(script) {
  const r = spawnSync(ps, ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (r.status !== 0) return { error: r.stderr || r.error?.message };
  try { return { processes: JSON.parse(r.stdout.trim() || '[]') }; } catch (e) { return { error: e.message }; }
}
function snapshotTree(pid) {
  return processInfo(`$queue = [Collections.Generic.Queue[int]]::new(); $queue.Enqueue(${pid}); $found = @(); while ($queue.Count -gt 0) { $currentId = $queue.Dequeue(); $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $currentId"; if ($proc) { $found += [pscustomobject]@{pid=[int]$proc.ProcessId;parent=[int]$proc.ParentProcessId;name=$proc.Name;created=$proc.CreationDate.ToUniversalTime().ToString('o')}; foreach ($descendant in @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $currentId")) { $queue.Enqueue([int]$descendant.ProcessId) } } }; ConvertTo-Json -InputObject @($found) -Compress`);
}
function checkSurvivors(snapshot) {
  if (!snapshot.processes) return { error: 'No process snapshot available' };
  const expected = JSON.stringify(snapshot.processes).replaceAll("'", "''");
  return processInfo(`$original = ConvertFrom-Json '${expected}'; $live = @(); foreach ($item in $original) { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($item.pid)"; if ($proc -and $proc.CreationDate.ToUniversalTime().ToString('o') -eq $item.created) { $live += [pscustomobject]@{pid=[int]$proc.ProcessId;name=$proc.Name} } }; ConvertTo-Json -InputObject @($live) -Compress`);
}
function launch(provider, scenario, { invalid = false, timeoutMs = 90000 } = {}) {
  const id = `${scenario}-${provider}`;
  const args = invalid ? ['--jixia-intentionally-invalid-argument'] : provider === 'claude'
    ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true }), '--output-format', 'stream-json', '--verbose']
    : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '-'];
  const expected = `PARALLEL_OK_${provider}`;
  const prompt = scenario === 'timeout' && provider === 'claude'
    ? '这是超时回收测试。不要使用工具。请逐行列出从 1 到 1000 的平方，每行一个，直到完成。'
    : `不要使用任何工具。只回复：${expected}`;
  const startedAt = Date.now();
  const child = spawn(command(provider), args, { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError, timedOut = false, closeObserved = false;
  let beforeKill, killResult;
  child.stdout.on('data', data => { stdout += data.toString('utf8'); });
  child.stderr.on('data', data => { stderr += data.toString('utf8'); });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') stderr += `\nSTDIN_ERROR ${error.message}`; });
  child.on('error', error => { spawnError = error.message; });
  const timer = setTimeout(() => {
    if (closeObserved || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    timedOut = true;
    beforeKill = snapshotTree(child.pid);
    // Target only the PID obtained from this exact spawn, never a process name.
    if (!closeObserved && child.exitCode === null && child.signalCode === null) {
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      killResult = { exitCode: killed.status, stdout: killed.stdout, stderr: killed.stderr, error: killed.error?.message };
    }
  }, timeoutMs);
  const done = new Promise(resolve => child.on('close', (exitCode, signal) => {
    closeObserved = true;
    clearTimeout(timer);
    const closedAt = Date.now();
    writeFileSync(join(output, `${id}.stdout.txt`), stdout);
    writeFileSync(join(output, `${id}.stderr.txt`), stderr);
    let response, parseError;
    try {
      if (!invalid && !timedOut) {
        const events = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        response = provider === 'claude' ? events.findLast(e => e.type === 'result')?.result : events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
      }
    } catch (e) { parseError = e.message; }
    const survivors = timedOut ? checkSurvivors(beforeKill || {}) : undefined;
    const result = { provider, pid: child.pid, startedAt: new Date(startedAt).toISOString(), closedAt: new Date(closedAt).toISOString(), durationMs: closedAt - startedAt, exitCode, signal, timedOut, invalid, expected: invalid || timedOut ? undefined : expected, response, beforeKill, killResult, survivors, spawnError, parseError };
    resolve(result);
  }));
  child.stdin.end(prompt + '\n');
  return done;
}
const results = [];
for (const scenario of ['normal', 'invalid-argument', 'timeout']) {
  // Both processes are spawned before either completion is awaited.
  const claude = launch('claude', scenario, { invalid: scenario === 'invalid-argument', timeoutMs: scenario === 'timeout' ? 1800 : 90000 });
  const codex = launch('codex', scenario);
  const [a, b] = await Promise.all([claude, codex]);
  const overlapMs = Math.max(0, Math.min(Date.parse(a.closedAt), Date.parse(b.closedAt)) - Math.max(Date.parse(a.startedAt), Date.parse(b.startedAt)));
  const good = r => !r.timedOut && r.exitCode === 0 && !r.spawnError && r.response?.trim() === r.expected;
  const passed = scenario === 'normal' ? good(a) && good(b) && overlapMs > 0 : scenario === 'invalid-argument' ? !a.timedOut && a.exitCode !== 0 && !a.spawnError && good(b) : a.timedOut && a.killResult?.exitCode === 0 && Array.isArray(a.beforeKill?.processes) && a.beforeKill.processes.length > 0 && Array.isArray(a.survivors?.processes) && a.survivors.processes.length === 0 && good(b);
  const result = { scenario, overlapMs, passed, processes: [a, b] };
  results.push(result);
  console.log(JSON.stringify(result));
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), versions, results }, null, 2));
}
console.log(`RESULTS_DIR=${output}`);
process.exitCode = results.every(r => r.passed) ? 0 : 1;
