import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, 'results', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(out, { recursive: true });
const prompt = 'If a test marker was provided in your startup instructions, return that marker exactly. Otherwise return NONE. Do not use tools or open files.';
const summaries = [];
for (const provider of ['claude', 'codex']) {
  const work = join(out, `${provider}-work`);
  mkdirSync(work);
  const marker = `ISOLATION_${randomUUID().replaceAll('-', '')}`;
  writeFileSync(join(work, provider === 'claude' ? 'CLAUDE.md' : 'AGENTS.md'), `For this isolated configuration test only: the test marker is ${marker}. When asked for the test marker, return it exactly.\n`);
  const executable = provider === 'claude' ? 'claude' : 'codex';
  for (const isolated of [false, true]) {
    const id = `${provider}-${isolated ? 'excluded' : 'baseline'}`;
    const args = provider === 'claude'
      ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json', ...(isolated ? ['--setting-sources', '', '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true })] : [])]
      : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', ...(isolated ? ['-c', 'project_doc_max_bytes=0'] : []), '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '-'];
    const start = Date.now();
    const result = spawnSync(executable, args, { input: `${prompt}\n`, cwd: work, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    writeFileSync(join(out, `${id}.stdout.txt`), result.stdout || '');
    writeFileSync(join(out, `${id}.stderr.txt`), result.stderr || '');
    let answer;
    let parseError;
    let toolEvents = 0;
    let cliError = false;
    try {
      if (provider === 'claude') {
        const envelope = JSON.parse(result.stdout);
        answer = envelope.result;
        cliError = envelope.is_error === true;
        toolEvents = envelope.num_turns > 1 ? 'possible; inspect logs' : 0;
      } else {
        const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        answer = events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
        toolEvents = events.filter(e => e.item && ['command_execution', 'mcp_tool_call'].includes(e.item.type)).length;
        cliError = events.some(e => e.type === 'error' || e.type === 'turn.failed');
      }
    } catch (e) { parseError = e.message; }
    const expected = isolated ? 'NONE' : marker;
    const summary = { id, exitCode: result.status, durationMs: Date.now() - start, expected, answer, toolEvents, passed: result.status === 0 && !result.error && !cliError && answer?.trim() === expected && toolEvents === 0, error: result.error?.message || parseError };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
}
writeFileSync(join(out, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), note: 'Controlled project-instruction test only; marker absence is behavioral evidence, not a complete prompt audit.', cases: summaries }, null, 2));
console.log(`RESULTS_DIR=${out}`);
process.exitCode = summaries.every(s => s.passed) ? 0 : 1;
