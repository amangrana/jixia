import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'results', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const schema = JSON.stringify({ type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false });
const schemaPath = join(output, 'schema.json');
writeFileSync(schemaPath, schema);
const summaries = [];
const versions = {};
const prefix = '这是临时会话传输测试。不要写入长期记忆，不要调用任何工具、读取文件或猜测答案。按 schema 返回 reply；只根据本次输入及显式提供的历史回答。';
const providers = process.argv[2] ? [process.argv[2]] : ['claude', 'codex'];
if (providers.some(p => !['claude', 'codex'].includes(p))) throw new Error('Expected claude or codex');
for (const provider of providers) {
  const executable = provider === 'claude' ? 'claude' : 'codex';
  versions[provider] = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout?.trim();
  const work = join(output, `${provider}-work`);
  mkdirSync(work);
  const token = randomUUID().replaceAll('-', '');
  const firstMessage = `本轮暗号是 ${token}。请只返回这个暗号，不要永久记住。`;
  const cases = [
    { id: 'given', prompt: `${prefix}\n当前用户消息：${firstMessage}`, expected: token },
    { id: 'fresh-no-history', prompt: `${prefix}\n当前用户消息：上次调用的暗号是什么？若本次没有提供暗号或相关历史，只返回 UNKNOWN。`, expected: 'UNKNOWN' },
    { id: 'explicit-history', prompt: `${prefix}\n以下是 app 显式传入的历史：\n<conversation>\n用户：${firstMessage}\n助手：${token}\n</conversation>\n当前用户消息：历史里用户给出的暗号是什么？只返回暗号。`, expected: token },
  ];
  for (const test of cases) {
    const name = `${provider}-${test.id}`;
    const final = join(output, `${name}.final.json`);
    const args = provider === 'claude'
      ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true }), '--output-format', 'stream-json', '--verbose', '--json-schema', schema]
      : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '--output-schema', schemaPath, '--output-last-message', final, '-'];
    const start = Date.now();
    const result = spawnSync(executable, args, { input: `${test.prompt}\n`, cwd: work, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    writeFileSync(join(output, `${name}.prompt.txt`), test.prompt);
    writeFileSync(join(output, `${name}.stdout.txt`), result.stdout || '');
    writeFileSync(join(output, `${name}.stderr.txt`), result.stderr || '');
    let data, sessionId, parseError;
    let cliError = false;
    let toolEvidence = 0;
    try {
      if (provider === 'claude') {
        const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        const envelope = events.findLast(e => e.type === 'result');
        data = envelope.structured_output;
        sessionId = envelope.session_id;
        cliError = envelope.is_error === true;
        toolEvidence = events.filter(e => e.type === 'assistant').flatMap(e => e.message?.content || []).filter(block => block.type === 'tool_use' && block.name !== 'StructuredOutput').length;
      } else {
        data = JSON.parse(readFileSync(final, 'utf8'));
        const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        sessionId = events.find(e => e.type === 'thread.started')?.thread_id;
        toolEvidence = events.filter(e => e.item && !['agent_message', 'reasoning'].includes(e.item.type)).length;
        cliError = events.some(e => e.type === 'error' || e.type === 'turn.failed');
      }
      writeFileSync(final, JSON.stringify(data, null, 2));
    } catch (e) { parseError = e.message; }
    const schemaValid = !!(data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).join(',') === 'reply' && typeof data.reply === 'string');
    const summary = { provider, id: test.id, sessionId, exitCode: result.status, durationMs: Date.now() - start, schemaValid, toolEvidence, expected: test.expected, response: data, passed: result.status === 0 && !result.error && !cliError && schemaValid && data.reply.trim() === test.expected && toolEvidence === 0, error: result.error?.message || parseError };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
}
const sessionsUnique = summaries.every(s => s.sessionId) && new Set(summaries.map(s => s.sessionId)).size === summaries.length;
writeFileSync(join(output, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), versions, sessionsUnique, cases: summaries }, null, 2));
console.log(`SESSIONS_UNIQUE=${sessionsUnique}`);
console.log(`RESULTS_DIR=${output}`);
process.exitCode = sessionsUnique && summaries.every(s => s.passed) ? 0 : 1;
