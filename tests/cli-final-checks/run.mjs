import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(root, 'results', new Date().toISOString().replaceAll(':', '-'));
mkdirSync(output, { recursive: true });
const env = { ...process.env };
const removedNames = [];
// Remove credentials/routing for API and cloud providers only in these children.
// Preserve subscription OAuth and the original CLI auth/config directory locations.
const override = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|MODEL|DEFAULT_.*|.*FOUNDRY.*|.*BEDROCK.*|.*VERTEX.*)|OPENAI_(?:API_KEY|BASE_URL|API_BASE|ORGANIZATION|ORG_ID|PROJECT|PROJECT_ID)|CODEX_(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN)|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|AWS_.*|GOOGLE_(?:API_KEY|APPLICATION_CREDENTIALS|CLOUD_PROJECT)|CLOUD_ML_REGION|AZURE_.*)$/i;
for (const key of Object.keys(env)) if (override.test(key)) { removedNames.push(key); delete env[key]; }
const schema = JSON.stringify({ type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false });
const schemaPath = join(output, 'schema.json');
writeFileSync(schemaPath, schema);
const results = [];
for (const provider of ['claude', 'codex']) {
  const executable = provider === 'claude' ? 'claude' : 'codex';
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', env, timeout: 10000 }).stdout?.trim();
  const auth = spawnSync(executable, provider === 'claude' ? ['auth', 'status', '--json'] : ['login', 'status'], { env, encoding: 'utf8', timeout: 15000 });
  let authLabel;
  if (provider === 'claude') {
    try {
      const status = JSON.parse(auth.stdout);
      authLabel = { loggedIn: status.loggedIn, authMethod: status.authMethod, apiProvider: status.apiProvider, subscriptionType: status.subscriptionType };
    } catch { authLabel = { parseFailed: true }; }
  } else authLabel = { chatgptLogin: /Logged in using ChatGPT/i.test(`${auth.stdout}\n${auth.stderr}`) };
  const work = join(output, `${provider}-work`);
  const fixture = join(output, `${provider}-sample.txt`);
  mkdirSync(work);
  const marker = `中文读取-${randomUUID()}`;
  writeFileSync(fixture, marker, 'utf8');
  for (const read of [false, true]) {
    const id = `${provider}-${read ? 'read-outside-workdir' : 'subscription-call'}`;
    const final = join(output, `${id}.final.json`);
    const expected = read ? marker : 'SUBSCRIPTION_TEST_OK';
    const prompt = read ? `请实际读取指定文件，以 UTF-8 读取 ${fixture}，将完整原文作为 reply 返回。不要修改文件，不要使用其他文件。` : '不要使用任何工具，只返回 reply 为 SUBSCRIPTION_TEST_OK。';
    const args = provider === 'claude'
      ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--add-dir', output, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--no-session-persistence', '--setting-sources', '', '--settings', JSON.stringify({ claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true }), '--output-format', 'stream-json', '--verbose', '--json-schema', schema]
      : ['exec', '--ignore-user-config', '-c', 'windows.sandbox="elevated"', '-c', 'project_doc_max_bytes=0', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--json', '--output-schema', schemaPath, '--output-last-message', final, '-'];
    const start = Date.now();
    const result = spawnSync(executable, args, { input: `${prompt}\n`, cwd: work, env, encoding: 'utf8', timeout: 90000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    writeFileSync(join(output, `${id}.stdout.txt`), result.stdout || '');
    writeFileSync(join(output, `${id}.stderr.txt`), result.stderr || '');
    let data, error, authProvider;
    let readEvents = 0, cliError = false;
    try {
      const events = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
      if (provider === 'claude') {
        const envelope = events.findLast(e => e.type === 'result');
        data = envelope.structured_output;
        cliError = envelope.is_error === true;
        authProvider = events.find(e => e.type === 'system' && e.subtype === 'init')?.apiKeySource;
        readEvents = events.filter(e => e.type === 'assistant').flatMap(e => e.message?.content || []).filter(b => b.type === 'tool_use' && b.name === 'Read').length;
      } else {
        data = JSON.parse(readFileSync(final, 'utf8'));
        cliError = events.some(e => e.type === 'error' || e.type === 'turn.failed');
        readEvents = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution' && e.item.exit_code === 0).length;
      }
      writeFileSync(final, JSON.stringify(data, null, 2));
    } catch (e) { error = e.message; }
    const passed = result.status === 0 && !result.error && !cliError && data?.reply === expected && (!read || readEvents > 0);
    const entry = { provider, version, id, durationMs: Date.now() - start, exitCode: result.status, authStatusExitCode: auth.status, authLabel, authProvider, removedEnvironmentVariableNames: removedNames.sort(), readEvents, passed, response: data, error: result.error?.message || error };
    results.push(entry);
    console.log(JSON.stringify(entry));
    writeFileSync(join(output, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
  }
}
console.log(`RESULTS_DIR=${output}`);
process.exitCode = results.every(r => r.passed) ? 0 : 1;
