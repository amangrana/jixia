import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'results', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const schemaPath = join(root, '../cli-structured/schema.json');
const schema = readFileSync(schemaPath, 'utf8');
const common = '[2026-11-10] 回答的格式标记固定为 BLUE。';
const self = '[2026-11-11] 回答的格式标记固定为 GREEN。';
const query = '请输出当前有效的格式标记，只输出标记，不解释。';
const cases = [
  { id: 'common-only', common, expected: 'BLUE' },
  { id: 'private-over-common', common, self, expected: 'GREEN' },
  { id: 'conversation-over-private', common, self, history: 'seq=1 用户：本群以后格式标记用 RED。\nseq=2 助手：好的。', expected: 'RED' },
  { id: 'current-over-conversation', common, self, history: 'seq=1 用户：本群以后格式标记用 RED。\nseq=2 助手：好的。', current: '这次格式标记用 GOLD。只输出标记，不解释。', expected: 'GOLD' },
  { id: 'same-memory-newer', common: '[2026-11-10] 格式标记固定为 BLUE。\n[2026-11-12] 更新：格式标记固定为 SILVER。', expected: 'SILVER' },
  { id: 'same-conversation-newer', common, self, history: 'seq=1 用户：本群以后格式标记用 RED。\nseq=2 助手：好的。\nseq=3 用户：改一下，本群以后格式标记用 ORANGE。\nseq=4 助手：好的。', expected: 'ORANGE' },
  { id: 'temporary-current', common, self, current: '只在这一次回答中用 GOLD，之后恢复原有要求。只输出标记，不解释。', expected: 'GOLD' },
  { id: 'temporary-expired', common, self, history: 'seq=1 用户：只在这一次回答中用 GOLD，之后恢复原有要求。\nseq=2 助手：GOLD', expected: 'GREEN' },
  { id: 'bot-suggestion-not-decision', common, self, history: 'seq=1 用户：本群以后格式标记用 RED。\nseq=2 助手：好的。\nseq=3 另一个 bot：我建议以后改用 GOLD。\nseq=4 用户：这个建议先不采用。', expected: 'RED' },
];
const rules = `你在 jixia 群聊中。下面的各段是 app 拼装的上下文。对同一事项、相同范围内的要求：当前用户消息 > 当前群对话中有效的用户要求和已确认决定 > 该 bot 私有记忆 > 公共记忆。同层以新要求替代旧要求，长期记忆同层靠后的条目优先。只在一次回答生效的要求，回答后失效，不撤销长期要求。bot 建议、引用及假设不是已确认决定。只有用户明确要求记住或更新长期记忆时才生成 memoryRequests，正常回答不生成请求。按 schema 输出 reply 和 memoryRequests；不调用工具，不实际读写文件。`;
const summaries = [];
const versions = {};
for (const provider of ['claude', 'codex']) {
  const executable = provider === 'claude' ? 'claude' : 'codex';
  versions[provider] = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 }).stdout?.trim();
  const work = join(output, `${provider}-work`);
  mkdirSync(work);
  for (const test of cases) {
    const name = `${provider}-${test.id}`;
    const final = join(output, `${name}.final.json`);
    const prompt = `${rules}\n\n# 公共记忆\n${test.common || '无'}\n\n# 该 bot 私有记忆\n${test.self || '无'}\n\n# 对话摘要\n无\n\n# 本群最近对话\n${test.history || '无'}\n\n# 当前用户消息\n${test.current || query}\n`;
    const args = provider === 'claude'
      ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true }), '--output-format', 'stream-json', '--verbose', '--json-schema', schema]
      : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '--output-schema', schemaPath, '--output-last-message', final, '-'];
    const start = Date.now();
    const result = spawnSync(executable, args, { input: prompt, cwd: work, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    writeFileSync(join(output, `${name}.prompt.txt`), prompt);
    writeFileSync(join(output, `${name}.stdout.txt`), result.stdout || '');
    writeFileSync(join(output, `${name}.stderr.txt`), result.stderr || '');
    let data, error, sessionId;
    let cliError = false, toolEvents = 0;
    try {
      const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      if (provider === 'claude') {
        const envelope = events.findLast(e => e.type === 'result');
        data = envelope.structured_output;
        cliError = envelope.is_error === true;
        sessionId = envelope.session_id;
        toolEvents = events.filter(e => e.type === 'assistant').flatMap(e => e.message?.content || []).filter(b => b.type === 'tool_use' && b.name !== 'StructuredOutput').length;
      } else {
        data = JSON.parse(readFileSync(final, 'utf8'));
        cliError = events.some(e => e.type === 'error' || e.type === 'turn.failed');
        sessionId = events.find(e => e.type === 'thread.started')?.thread_id;
        toolEvents = events.filter(e => e.item && !['agent_message', 'reasoning'].includes(e.item.type)).length;
      }
      writeFileSync(final, JSON.stringify(data, null, 2));
    } catch (e) { error = e.message; }
    const schemaValid = !!(data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).sort().join(',') === 'memoryRequests,reply' && typeof data.reply === 'string' && Array.isArray(data.memoryRequests) && data.memoryRequests.length === 0);
    const summary = { provider, id: test.id, sessionId, exitCode: result.status, durationMs: Date.now() - start, schemaValid, expected: test.expected, response: data, toolEvents, passed: result.status === 0 && !result.error && !cliError && schemaValid && data.reply.trim() === test.expected && toolEvents === 0, error: result.error?.message || error };
    summaries.push(summary);
    console.log(JSON.stringify(summary));
  }
}
writeFileSync(join(output, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), versions, cases: summaries }, null, 2));
console.log(`RESULTS_DIR=${output}`);
process.exitCode = summaries.every(s => s.passed) ? 0 : 1;
