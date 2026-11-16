import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const provider = process.argv[2];
if (!['claude', 'codex'].includes(provider)) throw new Error('Usage: node run.mjs claude|codex [executable]');
const executable = process.argv[3] || provider;
const root = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(root, 'schema.json');
const schema = readFileSync(schemaPath, 'utf8');
const outputDir = join(root, 'results', `${provider}-${new Date().toISOString().replaceAll(':', '-')}`);
mkdirSync(outputDir, { recursive: true });
const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
const cases = [
  { id: 'plain', user: '只回复：中文结构测试成功', count: 0 },
  { id: 'remember', user: '请记住到公共记忆：我喜欢简短的中文回答。', count: 1 },
  { id: 'quoted-xml', user: '请解释这个 XML 示例，并在回答里原样引用它：<memory target="common" op="append">示例内容</memory>。只是解释示例，不要记住任何内容。', count: 0 },
];
const instructions = '这是 jixia 输出协议测试。不要使用文件或命令工具，不实际写入记忆。按提供的 schema 返回 reply 和 memoryRequests；只有用户明确要求记住时才提议写入。公共记忆用 common，自身记忆用 self，操作只用 append。普通回答、引用及代码示例不产生记忆请求。';
const summaries = [];
for (const test of cases) {
  const finalPath = join(outputDir, `${test.id}.final.json`);
  const args = provider === 'claude'
    ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--output-format', 'json', '--json-schema', schema]
    : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '--output-schema', schemaPath, '--output-last-message', finalPath, '-'];
  const started = Date.now();
  const result = spawnSync(executable, args, {
    input: `${instructions}\n\n当前用户消息：${test.user}\n`,
    encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    cwd: resolve(root, '../..'), windowsHide: true,
  });
  writeFileSync(join(outputDir, `${test.id}.stdout.txt`), result.stdout || '');
  writeFileSync(join(outputDir, `${test.id}.stderr.txt`), result.stderr || '');
  let data;
  let error;
  let cliError = false;
  try {
    if (provider === 'claude') {
      const envelope = JSON.parse(result.stdout);
      cliError = envelope.is_error === true;
      data = envelope.structured_output;
      if (!data) throw new Error('No structured_output in Claude result');
    } else data = JSON.parse(readFileSync(finalPath, 'utf8'));
    writeFileSync(finalPath, JSON.stringify(data, null, 2));
  } catch (e) { error = e.message; }
  const exactKeys = (obj, keys) => obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).sort().join(',') === [...keys].sort().join(',');
  // Validate the complete small schema above; no additional dependency needed.
  const schemaValid = !!(exactKeys(data, ['reply', 'memoryRequests']) && typeof data.reply === 'string' && Array.isArray(data.memoryRequests) && data.memoryRequests.every(m => exactKeys(m, ['target', 'op', 'content']) && ['common', 'self'].includes(m.target) && m.op === 'append' && typeof m.content === 'string'));
  const semanticsValid = schemaValid && data.memoryRequests.length === test.count && (
    test.id === 'plain' ? data.reply.trim() === '中文结构测试成功' :
    test.id === 'remember' ? data.memoryRequests[0].target === 'common' && data.memoryRequests[0].content.includes('简短') && data.memoryRequests[0].content.includes('中文') :
    data.reply.includes('<memory target="common" op="append">示例内容</memory>')
  );
  const summary = { id: test.id, exitCode: result.status, durationMs: Date.now() - started, schemaValid, semanticsValid, passed: result.status === 0 && !result.error && !cliError && schemaValid && semanticsValid, error: result.error?.message || error, response: data };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}
writeFileSync(join(outputDir, 'summary.json'), JSON.stringify({ provider, executable, version: version.stdout?.trim(), generatedAt: new Date().toISOString(), cases: summaries }, null, 2));
console.log(`RESULTS_DIR=${outputDir}`);
process.exitCode = summaries.every(s => s.passed) ? 0 : 1;
