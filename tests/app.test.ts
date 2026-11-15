import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { checkLogin, parseClaudeStatus, parseCodexStatus } from '../src/auth.ts';
import { DEFAULT_CONFIG, resolveConfig } from '../src/config.ts';
import { createLimiter } from '../src/limiter.ts';

test('the limiter never runs more than the cap, and runs everything in order', async () => {
  const limit = createLimiter(2);
  let running = 0, peak = 0;
  const finished: number[] = [];
  await Promise.all(Array.from({ length: 7 }, (_, index) => limit(async () => {
    peak = Math.max(peak, ++running);
    await new Promise(resolve => setTimeout(resolve, 15));
    running--;
    finished.push(index);
  })));
  assert.equal(peak, 2);
  assert.deepEqual(finished, [0, 1, 2, 3, 4, 5, 6]);
  // A failing task releases its slot.
  await assert.rejects(limit(async () => { throw new Error('boom'); }));
  assert.equal(await limit(async () => 'still works'), 'still works');
  assert.throws(() => createLimiter(0));
});

test('Claude login: only a claude.ai subscription counts', () => {
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'pro' })).kind, 'subscription');
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'console', apiProvider: 'firstParty' })).kind, 'api-key');
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: false })).kind, 'not-logged-in');
  assert.equal(parseClaudeStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' })).kind, 'unknown');
  assert.equal(parseClaudeStatus('not json').kind, 'unknown');
});

test('Codex login: ChatGPT counts, an API key does not, anything else is unknown', () => {
  assert.equal(parseCodexStatus('Logged in using ChatGPT').kind, 'subscription');
  assert.equal(parseCodexStatus('Logged in using an API key - sk-***').kind, 'api-key');
  assert.equal(parseCodexStatus('Not logged in').kind, 'not-logged-in');
  assert.equal(parseCodexStatus('').kind, 'unknown');
});

test('the login check reads Codex status from stderr and turns a failed query into unknown', async () => {
  const calls: string[] = [];
  const run = async (executable: string, args: string[]) => { calls.push([executable, ...args].join(' ')); return executable === 'codex' ? { stdout: '', stderr: 'Logged in using ChatGPT\n' } : { stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}', stderr: '' }; };
  assert.equal((await checkLogin('codex', run)).kind, 'subscription');
  assert.equal((await checkLogin('claude', run)).kind, 'subscription');
  assert.deepEqual(calls, ['codex login status', 'claude auth status --json']);
  assert.equal((await checkLogin('claude', async () => { throw new Error('not installed'); })).kind, 'unknown');
});

test('config: defaults without a file, overrides merge, and mistakes are rejected by name', () => {
  assert.deepEqual(resolveConfig(undefined), DEFAULT_CONFIG);
  const config = resolveConfig({ port: 5000, bots: { claude: { provider: 'claude', model: 'sonnet', effort: 'low' } } });
  assert.equal(config.port, 5000);
  assert.deepEqual(Object.keys(config.bots), ['claude']);
  assert.equal(config.maxParallelCli, DEFAULT_CONFIG.maxParallelCli);
  assert.throws(() => resolveConfig({ prot: 5000 }), /不认识的配置项：prot/);
  assert.throws(() => resolveConfig({ maxParallelCli: 0 }), /maxParallelCli 必须是正整数/);
  assert.throws(() => resolveConfig({ bots: { '../x': { provider: 'claude' } } }), /名字/);
  assert.throws(() => resolveConfig({ bots: { all: { provider: 'claude' } }, defaultWriter: 'all' }), /名字/);
  assert.throws(() => resolveConfig({ bots: { gemini: { provider: 'gemini' } }, defaultWriter: 'gemini' }), /provider/);
  assert.throws(() => resolveConfig({ bots: { chatgpt: { provider: 'codex', effort: 'low' } }, defaultWriter: 'chatgpt' }), /effort/);
  assert.throws(() => resolveConfig({ bots: { chatgpt: { provider: 'codex' } } }), /defaultWriter/);
  assert.throws(() => resolveConfig({ requireSubscription: 'no' }), /requireSubscription/);
});

test('config.example.yaml is valid and spells out exactly the defaults', async () => {
  assert.deepEqual(resolveConfig(parse(await readFile('config.example.yaml', 'utf8'))), DEFAULT_CONFIG);
});
