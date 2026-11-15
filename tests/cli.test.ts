import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, CliError, parseOutput, runProcess, subscriptionEnv, usedModel, validateOutput } from '../src/cli.ts';
import type { CliConfig } from '../src/cli.ts';

// None of these call a model. The live check is tests/cli-live.mjs.

const config = (provider: 'claude' | 'codex', extra: Partial<CliConfig> = {}): CliConfig => ({ provider, workDir: 'W', readDir: 'R', timeoutMs: 1000, ...extra });
const files = { schema: 'S.json', final: 'F.json' };
const good = { reply: '你好', memoryRequests: [{ target: 'common', op: 'append', content: '偏好简短回答' }] };
const invalid = (action: () => unknown) => assert.throws(action, (error: unknown) => error instanceof CliError && error.kind === 'invalid-output');

test('output validation accepts the agreed shape and rejects everything else', () => {
  assert.deepEqual(validateOutput(good), good);
  assert.deepEqual(validateOutput({ reply: '', memoryRequests: [] }), { reply: '', memoryRequests: [] });
  for (const bad of [
    null, 'text', [], { reply: 'x' }, { reply: 1, memoryRequests: [] }, { reply: 'x', memoryRequests: {} },
    { reply: 'x', memoryRequests: [], extra: 1 },
    { reply: 'x', memoryRequests: [{ target: 'claude', op: 'append', content: 'c' }] },
    { reply: 'x', memoryRequests: [{ target: 'self', op: 'replace', content: 'c' }] },
    { reply: 'x', memoryRequests: [{ target: 'self', op: 'append' }] },
    { reply: 'x', memoryRequests: [{ target: 'self', op: 'append', content: 'c', path: '../x' }] },
  ]) invalid(() => validateOutput(bad));
});

test('Claude arguments open only Read, isolate local config and keep the empty setting source', () => {
  const args = buildArgs(config('claude', { model: 'sonnet', effort: 'low' }), files);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], '-p');
  assert.equal(after('--tools'), 'Read');
  assert.equal(after('--add-dir'), 'R');
  assert.equal(after('--setting-sources'), '');
  assert.deepEqual(JSON.parse(after('--settings')), { claudeMdExcludes: ['**'], autoMemoryEnabled: false, disableAllHooks: true });
  assert.equal(after('--model'), 'sonnet');
  assert.equal(after('--effort'), 'low');
  assert.equal(after('--output-format'), 'json');
  assert.deepEqual(JSON.parse(after('--json-schema')).required, ['reply', 'memoryRequests']);
  assert(!args.includes('--bare'));
  assert(!buildArgs(config('claude'), files).includes('--model'));
});

test('Codex arguments use the read-only sandbox, ignore user config and read the prompt from stdin', () => {
  const args = buildArgs(config('codex', { model: 'm' }), files);
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], 'exec');
  assert.equal(args.at(-1), '-');
  assert(args.includes('--ignore-user-config') && args.includes('--skip-git-repo-check'));
  assert.equal(after('--sandbox'), 'read-only');
  assert.equal(after('--output-schema'), 'S.json');
  assert.equal(after('--output-last-message'), 'F.json');
  assert.equal(after('--model'), 'm');
  assert(!args.some(arg => arg.startsWith('model_reasoning_effort')));
  const withEffort = buildArgs(config('codex', { effort: 'low' }), files);
  assert.equal(withEffort[withEffort.indexOf('model_reasoning_effort="low"') - 1], '-c');
  assert(!withEffort.includes('--model'));
  assert(args.includes('project_doc_max_bytes=0'));
  assert.equal(args.includes('windows.sandbox="elevated"'), process.platform === 'win32');
});

test('output is taken from the structured field or the final-message file, never from free text', () => {
  assert.deepEqual(parseOutput('claude', JSON.stringify({ result: 'ignored prose', structured_output: good }), undefined), good);
  assert.deepEqual(parseOutput('codex', 'startup noise, echoed prompt, token counts', JSON.stringify(good)), good);
  invalid(() => parseOutput('claude', JSON.stringify({ result: JSON.stringify(good) }), undefined));
  invalid(() => parseOutput('claude', JSON.stringify({ is_error: true, result: 'rate limited', structured_output: good }), undefined));
  invalid(() => parseOutput('claude', 'not json', undefined));
  invalid(() => parseOutput('codex', JSON.stringify(good), undefined));
  invalid(() => parseOutput('codex', '', '{"reply":'));
});

test('the model that answered comes from what Claude Code reports; Codex falls back to the configured one', () => {
  const stdout = JSON.stringify({ structured_output: good, modelUsage: { 'claude-haiku-5-5': { outputTokens: 12 }, 'claude-fable-5-2': { outputTokens: 269 } } });
  assert.equal(usedModel('claude', stdout, 'sonnet'), 'claude-fable-5-2');
  assert.equal(usedModel('claude', JSON.stringify({ structured_output: good }), 'sonnet'), 'sonnet');
  assert.equal(usedModel('claude', 'not json', undefined), '默认模型');
  assert.equal(usedModel('codex', stdout, 'gpt-x'), 'gpt-x');
  assert.equal(usedModel('codex', '', undefined), '默认模型');
});

test('billing overrides are removed from the child environment only', () => {
  const env = { PATH: 'p', ANTHROPIC_API_KEY: 'a', anthropic_base_url: 'b', OPENAI_API_KEY: 'c', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'kept' };
  assert.deepEqual(subscriptionEnv(env), { PATH: 'p', ANTHROPIC_MODEL: 'kept' });
  assert.equal(env.ANTHROPIC_API_KEY, 'a');
});

const node = (script: string, timeoutMs = 10000, input = '') => runProcess(process.execPath, ['-e', script], { cwd: process.cwd(), input, timeoutMs });

test('the prompt arrives on stdin as UTF-8 and long output is collected intact', async () => {
  const input = '中文长输入🙂'.repeat(20000);
  const result = await node(`let s='';process.stdin.setEncoding('utf8').on('data',c=>s+=c).on('end',()=>process.stdout.write(s))`, 10000, input);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, input);
});

test('a failing process reports its exit code and stderr', async () => {
  const result = await node(`console.error('unknown option');process.exit(3)`);
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /unknown option/);
});

test('a process that ignores stdin and never exits is killed at the timeout, and we wait for it to close', async () => {
  const started = Date.now();
  const result = await node(`setInterval(()=>{},1000)`, 400);
  assert.equal(result.timedOut, true);
  assert.equal(result.reaped, true);
  assert(Date.now() - started < 4000);
});

test('a descendant that keeps the pipes open after the main process exits cannot hold the call', async () => {
  // Main prints its answer and exits at once; the descendant inherits stdout and lives on.
  const script = `require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},4000)'],{stdio:'inherit',detached:true}).unref();process.stdout.write('answer');process.exit(0)`;
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', script], { cwd: process.cwd(), input: '', timeoutMs: 60000, graceMs: 300 });
  assert(Date.now() - started < 3000);
  assert.deepEqual([result.exitCode, result.timedOut, result.reaped, result.stdout], [0, false, false, 'answer']);
});

test('when the kill does not take effect, the call still returns and says the process was not reaped', async () => {
  const started = Date.now();
  // The process exits by itself after 3s, so the test leaves nothing behind.
  const result = await runProcess(process.execPath, ['-e', `setTimeout(()=>{},3000)`], { cwd: process.cwd(), input: '', timeoutMs: 200, graceMs: 200, kill: () => {} });
  assert(Date.now() - started < 2000);
  assert.deepEqual([result.timedOut, result.reaped], [true, false]);
  assert.equal(typeof result.pid, 'number');
});

test('a missing executable is a spawn failure', async () => {
  await assert.rejects(
    runProcess('jixia-no-such-executable', [], { cwd: process.cwd(), input: '', timeoutMs: 1000 }),
    (error: unknown) => error instanceof CliError && error.kind === 'spawn',
  );
});
